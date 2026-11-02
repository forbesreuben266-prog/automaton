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
 */

import fs from "node:fs";
import net from "node:net";
import {
  PROC_VERSION_MAX, parseCgroupMax, parseMountinfo, parseHasRoute, parseIdList, parseIpv6RouteDevices, parseLimits, parseNetDev, parseProcStatus,
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

export async function probe(hostCanaryPath: string): Promise<CanaryReport> {
  const status = parseProcStatus(readText("/proc/self/status"));
  let hostCanaryRead: CanaryReport["hostCanaryRead"] = "absent";
  try { fs.readFileSync(hostCanaryPath); hostCanaryRead = "readable"; } catch (err) {
    hostCanaryRead = (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "denied";
  }
  return {
    version: 4,
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
    etcMounts: parseMountinfo(readText("/proc/self/mountinfo")),
  };
}

/** Entry point guard: never runs outside a container started for the canary. */
export function insideCanaryContainer(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--canary") && (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"));
}
