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
 *   read-only evidence                            write attempts; must fail with EROFS
 *   writable mounts                               write+delete of a marker file
 *   host canary                                   read of an unmounted host path
 *   sockets                                       directory scan for socket files
 *   rlimits (soft and hard)                       /proc/self/limits
 *   cgroup memory / pids                          /sys/fs/cgroup/memory.max, pids.max
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

export interface CanaryReport {
  readonly version: 4;
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
}

export const ETC_MOUNT_TARGETS = ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"] as const;
export type EtcMountTarget = (typeof ETC_MOUNT_TARGETS)[number];

/** Per-mount options (field 6) of each /proc/self/mountinfo entry whose mount point (field 5) is a target. */
export function parseMountinfo(text: string): Record<EtcMountTarget, string[]> {
  if (typeof text !== "string") throw new TypeError("mountinfo text must be a string");
  const out = Object.fromEntries(ETC_MOUNT_TARGETS.map((t) => [t, [] as string[]])) as Record<EtcMountTarget, string[]>;
  const unescape = (x: string) => x.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
  for (const line of text.split("\n")) {
    const fields = line.trim().split(" ");
    if (fields.length < 6) continue;
    const mountPoint = unescape(fields[4]);
    if ((ETC_MOUNT_TARGETS as readonly string[]).includes(mountPoint)) out[mountPoint as EtcMountTarget].push(fields[5]);
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
export function evaluateCanary(raw: unknown, spec: SandboxSpec): string[] {
  const v: string[] = [];
  if (!isObj(raw)) return ["canary report: must be an object"];
  const r = raw;
  const expect = (cond: boolean, msg: string) => { if (!cond) v.push(msg); };
  expect(r.version === 4, "canary report: unsupported version");
  expect(procVersionOk(r.procVersion), "kernel: /proc/version must be observed (printable, starting \"Linux version \")");

  const [uid, gid] = spec.user.split(":").map(Number);
  expect(intList(r.uids, 4) && r.uids.every((x) => x === uid), `identity: real/effective/saved/fs uid must all be ${uid} (got ${JSON.stringify(r.uids)})`);
  expect(intList(r.gids, 4) && r.gids.every((x) => x === gid), `identity: real/effective/saved/fs gid must all be ${gid} (got ${JSON.stringify(r.gids)})`);
  expect(intList(r.groups) && r.groups.every((x) => x === gid), `identity: no supplementary groups other than ${gid} (got ${JSON.stringify(r.groups)})`);
  expect(zeroHex(r.capEff) && zeroHex(r.capPrm) && zeroHex(r.capBnd), "capabilities: effective, permitted and bounding sets must all be empty");
  expect(r.noNewPrivs === 1, "no_new_privs: must be set");
  expect(r.seccompMode === 2, "seccomp: a filter must be active (mode 2)");

  // Network denial evidence: interfaces and routes. The TCP attempt is supplementary only.
  expect(Array.isArray(r.interfaces) && r.interfaces.length === 1 && r.interfaces[0] === "lo", `network: exactly one interface, lo, must exist (got ${JSON.stringify(r.interfaces)})`);
  expect(r.ipv4Routes === false, "network: no IPv4 routes may exist");
  expect(Array.isArray(r.ipv6RouteDevices) && r.ipv6RouteDevices.every((d) => d === "lo"), "network: IPv6 routes may only use lo");
  expect(r.testNetConnect === "unreachable" || r.testNetConnect === "refused" || r.testNetConnect === "timeout",
    `network: the supplementary outbound attempt must fail (got ${String(r.testNetConnect)})`);

  const allowed = new Set([...spec.envAllowlist, ...spec.imageEnvAllowlist]);
  expect(Array.isArray(r.envNames) && r.envNames.every((n) => typeof n === "string" && allowed.has(n)), "environment: only allowlisted variable names may be present");

  // Read-only evidence must be EROFS: EACCES only shows lack of permission, not a read-only mount.
  const w = isObj(r.writes) ? r.writes : {};
  expect(w.root === "EROFS", `filesystem: writing to / must fail with EROFS (got ${String(w.root)})`);
  expect(w.app === "EROFS", `filesystem: writing to /app must fail with EROFS (got ${String(w.app)})`);
  expect(w.input === "EROFS", `filesystem: writing to the input mount must fail with EROFS (got ${String(w.input)})`);
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
  expect(typeof r.cgroupMemoryMax === "number" && Number.isSafeInteger(r.cgroupMemoryMax) && r.cgroupMemoryMax > 0 && r.cgroupMemoryMax <= spec.memoryBytes,
    `limits: cgroup memory.max must be at most ${spec.memoryBytes}`);
  expect(typeof r.cgroupPidsMax === "number" && Number.isSafeInteger(r.cgroupPidsMax) && r.cgroupPidsMax > 0 && r.cgroupPidsMax <= spec.pidsLimit,
    `limits: cgroup pids.max must be at most ${spec.pidsLimit}`);
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
