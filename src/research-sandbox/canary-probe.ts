/**
 * Canary probe: runs INSIDE a freshly created sandbox container (preflight
 * step 6) and prints one JSON CanaryReport to stdout. NOT executed in stage
 * S1 (no image exists yet; see README).
 *
 * Safety of the probe itself:
 * - refuses to run unless started with the explicit "--canary" argument
 *   inside a container-like environment (/.dockerenv or /run/.containerenv);
 *   it uses no extra environment variable, so the canary container's
 *   configuration is identical to a real run's;
 * - its only network attempt is a TCP connect to 192.0.2.1:9, a reserved
 *   documentation address (TEST-NET-1, RFC 5737) that is never a real host;
 *   it does no DNS lookups;
 * - it reads only /proc (including /proc/version and /proc/self/mountinfo), /sys/fs/cgroup, directory listings of a fixed set of
 *   directories (socket scan) and the host canary path given as an argument
 *   (which must NOT exist inside the sandbox), and writes only small marker
 *   files that it deletes again.
 * - V2.3: the entry point below runs only when this file is executed directly
 *   (never on import), and only inside the canary container with an absolute
 *   host canary path after "--canary"; otherwise it prints nothing on stdout
 *   and exits 2. The report is the ONLY thing written to stdout.
 */

import fs from "node:fs";
import net from "node:net";
import {
  FS_MOUNT_TARGETS, PROC_VERSION_MAX, parseCgroupMax, parseMountinfo, parseHasRoute, parseIdList, parseIpv6RouteDevices, parseLimits, parseNetDev, parseProcStatus,
  type CanaryReport, type ConnectResult, type WriteResult,
} from "./canary.js";

const TEST_NET_HOST = "192.0.2.1";
const TEST_NET_PORT = 9;

function readText(p: string): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

function tryWrite(dir: string): WriteResult {
  const file = `${dir.replace(/\/$/, "")}/.canary-write-${process.pid}`;
  try {
    fs.writeFileSync(file, "x", { flag: "wx" });
    fs.rmSync(file, { force: true });
    return "allowed";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
  }
}

function tryConnect(): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: TEST_NET_HOST, port: TEST_NET_PORT });
    const done = (r: ConnectResult) => { socket.destroy(); resolve(r); };
    socket.setTimeout(2_000, () => done("timeout"));
    socket.once("connect", () => done("connected"));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      done(err.code === "ENETUNREACH" || err.code === "EHOSTUNREACH" ? "unreachable" : err.code === "ECONNREFUSED" ? "refused" : "error");
    });
  });
}

/** Directories scanned (one level, plus one level below /run and /run/user/*) for socket files. */
const SOCKET_SCAN_ROOTS = ["/", "/run", "/var/run", "/tmp", "/app", "/in", "/out"];

function scanSockets(): { found: string[]; unreadable: string[] } {
  const found: string[] = [];
  const unreadable: string[] = [];
  const scan = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(dir);
      return;
    }
    for (const e of entries) {
      const p = `${dir === "/" ? "" : dir}/${e.name}`;
      if (e.isSocket()) found.push(p);
      else if (depth > 0 && e.isDirectory()) scan(p, depth - 1);
    }
  };
  for (const root of SOCKET_SCAN_ROOTS) scan(root, root === "/run" || root === "/var/run" ? 2 : 0);
  return { found: [...new Set(found)].sort(), unreadable: [...new Set(unreadable)].sort() };
}

/** V2.4: a short raw value of a cgroup v1 file ("" when absent or unreadable). */
const cgroupV1Raw = (p: string) => readText(p).trim().slice(0, 32);

export async function probe(hostCanaryPath: string): Promise<CanaryReport> {
  const status = parseProcStatus(readText("/proc/self/status"));
  let hostCanaryRead: CanaryReport["hostCanaryRead"] = "absent";
  try { fs.readFileSync(hostCanaryPath); hostCanaryRead = "readable"; } catch (err) {
    hostCanaryRead = (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "denied";
  }
  const mountinfo = readText("/proc/self/mountinfo");
  return {
    version: 5,
    uids: parseIdList(status.Uid),
    gids: parseIdList(status.Gid),
    groups: parseIdList(status.Groups),
    capEff: status.CapEff ?? "",
    capPrm: status.CapPrm ?? "",
    capBnd: status.CapBnd ?? "",
    noNewPrivs: Number(status.NoNewPrivs),
    seccompMode: Number(status.Seccomp),
    interfaces: parseNetDev(readText("/proc/net/dev")),
    ipv4Routes: parseHasRoute(readText("/proc/net/route")),
    ipv6RouteDevices: parseIpv6RouteDevices(readText("/proc/net/ipv6_route")),
    testNetConnect: await tryConnect(),
    envNames: Object.keys(process.env).sort(),
    writes: { root: tryWrite("/"), app: tryWrite("/app"), input: tryWrite("/in"), output: tryWrite("/out"), tmp: tryWrite("/tmp") },
    hostCanaryRead,
    sockets: scanSockets(),
    limits: parseLimits(readText("/proc/self/limits")),
    cgroupMemoryMax: parseCgroupMax(readText("/sys/fs/cgroup/memory.max") || "NaN"),
    cgroupPidsMax: parseCgroupMax(readText("/sys/fs/cgroup/pids.max") || "NaN"),
    procVersion: readText("/proc/version").trim().slice(0, PROC_VERSION_MAX + 1),
    etcMounts: parseMountinfo(mountinfo),
    fsMounts: parseMountinfo(mountinfo, FS_MOUNT_TARGETS),
    cgroupV1: { memoryLimitInBytes: cgroupV1Raw("/sys/fs/cgroup/memory/memory.limit_in_bytes"), pidsMax: cgroupV1Raw("/sys/fs/cgroup/pids/pids.max") },
    runtimeEnv: { HOSTNAME: process.env.HOSTNAME ?? null, HOME: process.env.HOME ?? null },
  };
}

/** Entry point guard: never runs outside a container started for the canary. */
export function insideCanaryContainer(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--canary") && (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"));
}

/** V2.3: what the entry point uses; injectable so tests never probe the real host. */
export interface ProbeMainDeps {
  readonly inside: (argv: readonly string[]) => boolean;
  readonly probe: (hostCanaryPath: string) => Promise<CanaryReport>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * V2.3: the probe's entry point. Exit codes: 0 = one JSON report written to
 * stdout; 2 = refused (not inside the canary container, or no absolute host
 * canary path after "--canary"); 1 = the probe failed. Nothing but the report
 * is ever written to stdout; diagnostics go to stderr.
 */
export async function runProbeMain(argv: readonly string[], deps: ProbeMainDeps): Promise<number> {
  if (!deps.inside(argv)) { deps.stderr("canary-probe: refused: not started with --canary inside a container\n"); return 2; }
  const at = argv.indexOf("--canary");
  const hostCanaryPath = argv[at + 1];
  if (typeof hostCanaryPath !== "string" || !/^(\/[A-Za-z0-9._-]+)+$/.test(hostCanaryPath) || hostCanaryPath.split("/").some((s) => s === "." || s === "..")) {
    deps.stderr("canary-probe: refused: --canary must be followed by an absolute host canary path (no . or .. segments)\n");
    return 2;
  }
  let report: CanaryReport;
  try { report = await deps.probe(hostCanaryPath); } catch (err) {
    deps.stderr(`canary-probe: failed: ${String((err as Error)?.message ?? err).slice(0, 200)}\n`);
    return 1;
  }
  deps.stdout(`${JSON.stringify(report)}\n`);
  return 0;
}

/** True only when this module is the script node was asked to run (not when it is imported). */
export function isEntryPoint(argv1: string | undefined = process.argv[1], moduleUrl: string = import.meta.url): boolean {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(new URL(moduleUrl)); } catch { return false; }
}

if (isEntryPoint()) {
  void runProbeMain(process.argv, {
    inside: insideCanaryContainer, probe,
    stdout: (t) => { process.stdout.write(t); }, stderr: (t) => { process.stderr.write(t); },
  }).then((code) => { process.exitCode = code; });
}
