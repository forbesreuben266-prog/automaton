/**
 * Canary self-test report: what the probe (canary-probe.ts) OBSERVED from
 * inside a created sandbox. This module only parses and evaluates reports;
 * it never runs anything. Every required observation must be present and
 * unambiguous; anything missing, malformed or unexpected refuses.
 *
 * Observation sources (all read inside the container):
 *   ids/groups/capabilities/no_new_privs/seccomp  /proc/self/status
 *   interfaces                                    /proc/net/dev
 *   IPv4 routes / IPv6 route devices              /proc/net/route, /proc/net/ipv6_route
 *   outbound attempt (supplementary only)         TCP connect to 192.0.2.1:9
 *   environment names                             process.env
 *   read-only evidence                            write attempts: EROFS, or (V2.4) EACCES
 *     together with mountinfo showing that mount "ro" (gVisor checks write
 *     permission before the read-only flag: overlay/filesystem.go)
 *   writable mounts                               write+delete of a marker file
 *   host canary                                   read of an unmounted host path
 *   sockets                                       directory scan for socket files
 *   rlimits (soft and hard)                       /proc/self/limits
 *   cgroup memory / pids                          /sys/fs/cgroup/memory.max, pids.max (v2), or
 *     (V2.4, gVisor's default in-sandbox cgroup v1) /sys/fs/cgroup/memory/
 *     memory.limit_in_bytes and /sys/fs/cgroup/pids/pids.max
 *   runtime-injected environment (V2.4)          HOSTNAME (Docker) and HOME (the runtime)
 *   kernel identity (gVisor evidence)             /proc/version
 *   /etc/hosts, /etc/hostname, /etc/resolv.conf   /proc/self/mountinfo per-mount options: each
 *     mounted exactly once and read-only ("ro"). A write attempt can't show
 *     this: as uid 10001 the root-owned files fail with EACCES before EROFS.
 * A failed TCP connect is NOT proof of network denial (an unroutable test
 * address can time out on a networked host); network denial evidence is
 * "only the loopback interface and no non-loopback routes".
 *
 * gVisor evidence (verifyGvisorEvidence): a runtime NAMED runsc proves
 * nothing, because the daemon maps names to arbitrary binaries. gVisor runs
 * its own emulated kernel, so its /proc/version differs from the host's; a
 * shared-kernel runtime (runc/crun) shows the host kernel's text. Positive
 * evidence = the container's /proc/version differs from the host's AND equals
 * the reference recorded for gVisor on this host at approved setup. This is a
 * fingerprint, not a cryptographic proof; without a recorded reference it
 * always refuses.
 */

import type { SandboxSpec } from "./spec.js";

export type ConnectResult = "unreachable" | "refused" | "timeout" | "connected" | "error";
/** "allowed", or the errno code of the failed write (e.g. "EROFS", "EACCES"). */
export type WriteResult = string;
export interface LimitPair { readonly soft: number | null; readonly hard: number | null }

/** V2.4: raw cgroup v1 values as gVisor reports them (trimmed, at most 32 characters; "" when absent). */
export interface CgroupV1Observation { readonly memoryLimitInBytes: string; readonly pidsMax: string }

export interface CanaryReport {
  readonly version: 6;
  /** [real, effective, saved, filesystem] */
  readonly uids: readonly number[];
  readonly gids: readonly number[];
  readonly groups: readonly number[];
  readonly capEff: string;
  readonly capPrm: string;
  readonly capBnd: string;
  readonly noNewPrivs: number;
  readonly seccompMode: number;
  readonly interfaces: readonly string[];
  readonly ipv4Routes: boolean;
  readonly ipv6RouteDevices: readonly string[];
  readonly testNetConnect: ConnectResult;
  readonly envNames: readonly string[];
  readonly writes: Readonly<Record<"root" | "app" | "input" | "output" | "tmp", WriteResult>>;
  readonly hostCanaryRead: "absent" | "denied" | "readable";
  readonly sockets: Readonly<{ found: readonly string[]; unreadable: readonly string[] }>;
  readonly limits: Readonly<Record<"fsize" | "nofile" | "core", LimitPair>>;
  readonly cgroupMemoryMax: number | null;
  readonly cgroupPidsMax: number | null;
  /** /proc/version text inside the container (trimmed). */
  readonly procVersion: string;
  /** Per-mount options of every mountinfo entry for each Docker-managed /etc file. */
  readonly etcMounts: Readonly<Record<EtcMountTarget, readonly string[]>>;
  /** V2.4: per-mount options of every mountinfo entry for "/" and the input mount. */
  readonly fsMounts: Readonly<Record<FsMountTarget, readonly string[]>>;
  /** V2.4: cgroup v1 observations (gVisor's default in-sandbox layout). */
  readonly cgroupV1: CgroupV1Observation;
  /** V2.4: values of the two variables Docker and the runtime inject (null when unset). Nothing else's value is ever reported. */
  readonly runtimeEnv: Readonly<Record<RuntimeEnvName, string | null>>;
}

/**
 * Variables added outside the image config and the create argv, each allowed ONLY with its exact value:
 * HOSTNAME by Docker (daemon/container/container.go); HOME by the runtime when unset (gVisor fsimpl/user/user.go;
 * runc likewise); V2.4.2: PWD by the pinned image's entrypoint (docker-entrypoint.sh runs under /bin/sh = dash,
 * which exports PWD, the working directory /app, to the program it execs).
 */
export const RUNTIME_ENV_NAMES = ["HOSTNAME", "HOME", "PWD"] as const;
/** V2.4.2: the container's working directory (inspect requires Config.WorkingDir to be exactly this). */
export const SANDBOX_WORKDIR = "/app";
export type RuntimeEnvName = (typeof RUNTIME_ENV_NAMES)[number];
/** V2.4: mounts whose read-only state is evidenced from mountinfo when a write fails with EACCES. */
export const FS_MOUNT_TARGETS = ["/", "/in"] as const;
export type FsMountTarget = (typeof FS_MOUNT_TARGETS)[number];

export const ETC_MOUNT_TARGETS = ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"] as const;
export type EtcMountTarget = (typeof ETC_MOUNT_TARGETS)[number];

/** Per-mount options (field 6) of each /proc/self/mountinfo entry whose mount point (field 5) is a target. */
export function parseMountinfo(text: string): Record<EtcMountTarget, string[]>;
export function parseMountinfo<T extends string>(text: string, targets: readonly T[]): Record<T, string[]>;
export function parseMountinfo(text: string, targets: readonly string[] = ETC_MOUNT_TARGETS): Record<string, string[]> {
  if (typeof text !== "string") throw new TypeError("mountinfo text must be a string");
  const out = Object.fromEntries(targets.map((t) => [t, [] as string[]])) as Record<string, string[]>;
  const unescape = (x: string) => x.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
  for (const line of text.split("\n")) {
    const fields = line.trim().split(" ");
    if (fields.length < 6) continue;
    const mountPoint = unescape(fields[4]);
    if (targets.includes(mountPoint)) out[mountPoint].push(fields[5]);
  }
  return out;
}

/** Upper bound for /proc/version text accepted from either side. */
export const PROC_VERSION_MAX = 512;
const procVersionOk = (v: unknown): v is string => typeof v === "string" && /^Linux version [\x20-\x7e]+$/.test(v) && v.length <= PROC_VERSION_MAX;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intList = (v: unknown, length?: number): v is number[] =>
  Array.isArray(v) && (length === undefined || v.length === length) && v.every((n) => typeof n === "number" && Number.isSafeInteger(n));
const zeroHex = (v: unknown) => typeof v === "string" && /^0{8,16}$/.test(v);

/** Fields of /proc/self/status as raw strings. */
export function parseProcStatus(text: string): Record<string, string> {
  if (typeof text !== "string") throw new TypeError("status text must be a string");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Whitespace-separated integers ("10001\t10001\t10001\t10001" -> [..]); NaN for anything else. */
export function parseIdList(text: string | undefined): number[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  return text.trim().split(/\s+/).map((x) => (/^\d+$/.test(x) ? Number(x) : Number.NaN));
}

/** Interface names from /proc/net/dev text. */
export function parseNetDev(text: string): string[] {
  if (typeof text !== "string") throw new TypeError("net/dev text must be a string");
  return text.split("\n").slice(2).map((l) => l.split(":")[0].trim()).filter((n) => n.length > 0);
}

/** True if /proc/net/route text has any route entries beyond the header. */
export function parseHasRoute(text: string): boolean {
  if (typeof text !== "string") throw new TypeError("net/route text must be a string");
  return text.split("\n").slice(1).some((l) => l.trim().length > 0);
}

/** Device (last column) of every /proc/net/ipv6_route entry. */
export function parseIpv6RouteDevices(text: string): string[] {
  if (typeof text !== "string") throw new TypeError("net/ipv6_route text must be a string");
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/).pop() as string);
}

/** Soft and hard limits from /proc/self/limits; "unlimited" -> null; missing row -> NaN (fails evaluation). */
export function parseLimits(text: string): Record<"fsize" | "nofile" | "core", LimitPair> {
  if (typeof text !== "string") throw new TypeError("limits text must be a string");
  const rows: Record<string, string> = { fsize: "Max file size", nofile: "Max open files", core: "Max core file size" };
  const value = (x: string | undefined) => (x === "unlimited" ? null : x !== undefined && /^\d+$/.test(x) ? Number(x) : Number.NaN);
  const out = {} as Record<"fsize" | "nofile" | "core", LimitPair>;
  for (const [key, label] of Object.entries(rows)) {
    const line = text.split("\n").find((l) => l.startsWith(label));
    const [soft, hard] = line ? line.slice(label.length).trim().split(/\s+/) : [];
    out[key as keyof typeof out] = { soft: value(soft), hard: value(hard) };
  }
  return out;
}

/** "max" -> null (unlimited); a number string -> number; anything else -> NaN (fails evaluation). */
export function parseCgroupMax(text: string): number | null {
  if (typeof text !== "string") throw new TypeError("cgroup text must be a string");
  const t = text.trim();
  return t === "max" ? null : /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

/** Evaluates a report (parsed JSON from the probe). Returns violations; empty means every required observation passed. */
export interface CanaryContext {
  /**
   * V2.4: true when the container ran under an isolating runtime (gVisor). Only then is a cgroup v1 layout accepted,
   * and only then may in-sandbox pids.max read "max": gVisor applies the pids limit to the sandbox's HOST cgroup
   * (runsc/cgroup) and never copies it into its own cgroupfs (fsimpl/cgroupfs/pids.go). The isolating runtime must
   * still be positively identified afterwards (verifyGvisorEvidence), or the result refuses.
   */
  readonly isolating: boolean;
}

/** Exactly one mountinfo entry for the target, and its options say "ro" (and not "rw"). */
const mountedReadOnly = (mounts: unknown, target: string) => {
  const entries = isObj(mounts) ? mounts[target] : undefined;
  const opts = Array.isArray(entries) && entries.length === 1 && typeof entries[0] === "string" ? entries[0].split(",") : null;
  return opts !== null && opts.includes("ro") && !opts.includes("rw");
};

export function evaluateCanary(raw: unknown, spec: SandboxSpec, context: CanaryContext = { isolating: false }): string[] {
  const v: string[] = [];
  if (!isObj(raw)) return ["canary report: must be an object"];
  const r = raw;
  const expect = (cond: boolean, msg: string) => { if (!cond) v.push(msg); };
  expect(r.version === 6, "canary report: unsupported version");
  expect(procVersionOk(r.procVersion), "kernel: /proc/version must be observed (printable, starting \"Linux version \")");

  const [uid, gid] = spec.user.split(":").map(Number);
  expect(intList(r.uids, 4) && r.uids.every((x) => x === uid), `identity: real/effective/saved/fs uid must all be ${uid} (got ${JSON.stringify(r.uids)})`);
  expect(intList(r.gids, 4) && r.gids.every((x) => x === gid), `identity: real/effective/saved/fs gid must all be ${gid} (got ${JSON.stringify(r.gids)})`);
  expect(intList(r.groups) && r.groups.every((x) => x === gid), `identity: no supplementary groups other than ${gid} (got ${JSON.stringify(r.groups)})`);
  expect(zeroHex(r.capEff) && zeroHex(r.capPrm) && zeroHex(r.capBnd), "capabilities: effective, permitted and bounding sets must all be empty");
  expect(r.noNewPrivs === 1, `no_new_privs: must be set (got ${JSON.stringify(r.noNewPrivs) ?? "undefined"})`);
  expect(r.seccompMode === 2, `seccomp: a filter must be active (mode 2) (got ${JSON.stringify(r.seccompMode) ?? "undefined"})`);

  // Network denial evidence: interfaces and routes. The TCP attempt is supplementary only.
  expect(Array.isArray(r.interfaces) && r.interfaces.length === 1 && r.interfaces[0] === "lo", `network: exactly one interface, lo, must exist (got ${JSON.stringify(r.interfaces)})`);
  expect(r.ipv4Routes === false, "network: no IPv4 routes may exist");
  expect(Array.isArray(r.ipv6RouteDevices) && r.ipv6RouteDevices.every((d) => d === "lo"), "network: IPv6 routes may only use lo");
  expect(r.testNetConnect === "unreachable" || r.testNetConnect === "refused" || r.testNetConnect === "timeout",
    `network: the supplementary outbound attempt must fail (got ${String(r.testNetConnect)})`);

  // HOSTNAME, HOME and PWD are injected outside the image config and create argv; allowed only with their exact values.
  const allowed = new Set<string>([...spec.envAllowlist, ...spec.imageEnvAllowlist, ...RUNTIME_ENV_NAMES]);
  const names = Array.isArray(r.envNames) ? r.envNames : null;
  const unexpected = names === null ? [] : names.filter((n) => typeof n !== "string" || !allowed.has(n)).map((n) => String(n).replace(/[^A-Za-z0-9_]/g, "?").slice(0, 64));
  expect(names !== null && unexpected.length === 0, `environment: only allowlisted variable names may be present (unexpected: ${JSON.stringify(unexpected.slice(0, 10))})`);
  const renv = isObj(r.runtimeEnv) ? r.runtimeEnv : {};
  const present = (n: string) => names !== null && names.includes(n);
  expect(Object.keys(renv).length === RUNTIME_ENV_NAMES.length && RUNTIME_ENV_NAMES.every((n) => n in renv), "environment: runtimeEnv must report exactly HOSTNAME, HOME and PWD");
  expect(present("HOSTNAME") ? renv.HOSTNAME === spec.hostname : renv.HOSTNAME === null, `environment: HOSTNAME must be "${spec.hostname}" (set by the create argv)`);
  expect(present("HOME") ? renv.HOME === "/" : renv.HOME === null, 'environment: HOME, when injected by the runtime, must be "/" (uid without a passwd entry)');
  expect(present("PWD") ? renv.PWD === SANDBOX_WORKDIR : renv.PWD === null, `environment: PWD, when exported by the entrypoint shell, must be "${SANDBOX_WORKDIR}" (the working directory)`);

  // Read-only evidence: EROFS, or EACCES PLUS the mount's own "ro" flag. EACCES alone only shows a lack of permission;
  // gVisor checks permission before the read-only flag, so a non-root write to a root-owned folder gives EACCES there.
  const w = isObj(r.writes) ? r.writes : {};
  const readOnly = (got: unknown, target: FsMountTarget) => got === "EROFS" || (got === "EACCES" && mountedReadOnly(r.fsMounts, target));
  const fsm = isObj(r.fsMounts) ? r.fsMounts : {};
  expect(readOnly(w.root, "/"), `filesystem: writing to / must fail with EROFS, or EACCES on a mount reported "ro" (got ${String(w.root)}; mount options ${JSON.stringify(fsm["/"])})`);
  expect(readOnly(w.app, "/"), `filesystem: writing to /app must fail with EROFS, or EACCES on a mount reported "ro" (got ${String(w.app)})`);
  expect(readOnly(w.input, "/in"), `filesystem: writing to the input mount must fail with EROFS, or EACCES on a mount reported "ro" (got ${String(w.input)}; mount options ${JSON.stringify(fsm["/in"])})`);
  expect(w.output === "allowed", "filesystem: the output mount must be writable");
  expect(w.tmp === "allowed", "filesystem: /tmp must be writable");
  expect(r.hostCanaryRead === "absent" || r.hostCanaryRead === "denied", "filesystem: the unmounted host canary file must not be readable");
  const sockets = isObj(r.sockets) ? r.sockets : {};
  expect(Array.isArray(sockets.found) && sockets.found.length === 0, `sockets: no socket files may be visible (got ${JSON.stringify(sockets.found)})`);
  expect(Array.isArray(sockets.unreadable) && sockets.unreadable.length === 0, `sockets: every scanned directory must be readable or absent (unreadable: ${JSON.stringify(sockets.unreadable)})`);

  const etc = isObj(r.etcMounts) ? r.etcMounts : {};
  for (const target of ETC_MOUNT_TARGETS) {
    const entries = etc[target];
    const opts = Array.isArray(entries) && entries.length === 1 && typeof entries[0] === "string" ? entries[0].split(",") : null;
    expect(opts !== null && opts.includes("ro") && !opts.includes("rw"), `filesystem: ${target} must be mounted exactly once and read-only (got ${JSON.stringify(entries)})`);
  }

  const limits = isObj(r.limits) ? r.limits : {};
  for (const [name, max] of Object.entries(spec.ulimits)) {
    const pair = isObj(limits[name]) ? limits[name] as Record<string, unknown> : {};
    for (const kind of ["soft", "hard"] as const) {
      const got = pair[kind];
      expect(typeof got === "number" && Number.isSafeInteger(got) && got <= max, `limits: ${name} ${kind} limit must be at most ${max} (got ${String(got)})`);
    }
  }
  // cgroup v2 values when present; otherwise (gVisor's default in-sandbox cgroup v1, isolating runtime only) the v1 files.
  const bounded = (x: unknown, max: number) => typeof x === "number" && Number.isSafeInteger(x) && x > 0 && x <= max;
  const v1 = isObj(r.cgroupV1) ? r.cgroupV1 : {};
  const v1Ok = Object.keys(v1).length === 2 && typeof v1.memoryLimitInBytes === "string" && typeof v1.pidsMax === "string";
  const v1Num = (x: unknown) => (typeof x === "string" && /^\d{1,19}$/.test(x) ? Number(x) : Number.NaN);
  const v2Absent = (x: unknown) => x === null || x === undefined;
  expect(v1Ok, "limits: cgroupV1 must report memoryLimitInBytes and pidsMax as strings");
  const memV1 = context.isolating && v2Absent(r.cgroupMemoryMax) && v1Ok && bounded(v1Num(v1.memoryLimitInBytes), spec.memoryBytes);
  expect(bounded(r.cgroupMemoryMax, spec.memoryBytes) || memV1,
    `limits: cgroup memory.max (v2) or, under gVisor, memory/memory.limit_in_bytes (v1) must be at most ${spec.memoryBytes} (got v2 ${JSON.stringify(r.cgroupMemoryMax) ?? "undefined"}, v1 ${JSON.stringify(v1.memoryLimitInBytes) ?? "undefined"})`);
  // pids: an in-sandbox v1 "max" is accepted ONLY together with the v1 memory evidence above (the same runsc cgroup
  // setup that applies the host-side pids limit); HostConfig.PidsLimit is checked by inspect. A numeric v1 value must be in range.
  const pidsV1 = context.isolating && v2Absent(r.cgroupPidsMax) && v1Ok && memV1 && (v1.pidsMax === "max" || bounded(v1Num(v1.pidsMax), spec.pidsLimit));
  expect(bounded(r.cgroupPidsMax, spec.pidsLimit) || pidsV1,
    `limits: cgroup pids.max (v2) must be at most ${spec.pidsLimit}, or under gVisor the v1 layout with the memory limit observed (got v2 ${JSON.stringify(r.cgroupPidsMax) ?? "undefined"}, v1 ${JSON.stringify(v1.pidsMax) ?? "undefined"})`);
  return v;
}

/**
 * Positive gVisor evidence for a report that already passed evaluateCanary.
 * hostProcVersion is the host's own /proc/version (read on the host).
 * Returns violations; empty only when gVisor is positively identified.
 */
export function verifyGvisorEvidence(raw: unknown, spec: SandboxSpec, hostProcVersion: unknown): string[] {
  if (spec.gvisorProcVersion === null) {
    return ["gVisor evidence: no reference /proc/version has been recorded for gVisor on this host (approved setup step); a runtime named runsc alone is not evidence"];
  }
  if (!procVersionOk(hostProcVersion)) return ["gVisor evidence: the host /proc/version is missing or malformed"];
  const seen = isObj(raw) ? raw.procVersion : undefined;
  if (!procVersionOk(seen)) return ["gVisor evidence: the container /proc/version is missing or malformed"];
  if (seen === hostProcVersion) return ["gVisor evidence: the container sees the host kernel, so the runtime named runsc is not gVisor"];
  if (seen !== spec.gvisorProcVersion) return ["gVisor evidence: the container /proc/version does not match the recorded gVisor reference"];
  return [];
}
