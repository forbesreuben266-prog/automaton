/** Canary report parsing and evaluation (version 3). Fixture text only; the probe is never executed. */

import { describe, expect, it } from "vitest";
import {
  evaluateCanary, parseCgroupMax, parseMountinfo, resolveSpec, verifyGvisorEvidence, parseHasRoute, parseIdList, parseIpv6RouteDevices, parseLimits, parseNetDev, parseProcStatus,
} from "../../research-sandbox/index.js";
import { insideCanaryContainer } from "../../research-sandbox/canary-probe.js";
import { FAKE_DIGEST, FAKE_ENTRYPOINT, FAKE_GVISOR_PROC_VERSION, HOST_PROC_VERSION, SPEC, compliantReport } from "./fixtures.js";

const LIMITS_TEXT = [
  "Limit                     Soft Limit           Hard Limit           Units",
  "Max file size             52428800             52428800             bytes",
  "Max core file size        0                    0                    bytes",
  "Max open files            256                  1048576              files",
].join("\n");

describe("/proc parsers", () => {
  it("status fields and id lists", () => {
    const status = parseProcStatus("Uid:\t10001\t10001\t10001\t10001\nGid:\t10001\t10001\t10001\t10001\nGroups:\t\nCapEff:\t0000000000000000\n");
    expect(parseIdList(status.Uid)).toEqual([10001, 10001, 10001, 10001]);
    expect(parseIdList(status.Groups)).toEqual([]);
    expect(parseIdList("10001 x")).toEqual([10001, Number.NaN]);
    expect(parseIdList(undefined)).toEqual([]);
  });

  it("interfaces, IPv4 routes and IPv6 route devices", () => {
    expect(parseNetDev("Inter-|   Receive\n face |bytes\n    lo:    0 0\n  eth0: 1 2\n")).toEqual(["lo", "eth0"]);
    expect(parseHasRoute("Iface\tDestination\tGateway\n")).toBe(false);
    expect(parseHasRoute("Iface\tDestination\tGateway\neth0\t00000000\t010011AC\n")).toBe(true);
    expect(parseIpv6RouteDevices("00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000001 00000000 00000001       lo\n")).toEqual(["lo"]);
    expect(parseIpv6RouteDevices("fe800000000000000000000000000000 40 0 0 0 00000100 00000001 00000000 00000001 eth0\n")).toEqual(["eth0"]);
  });

  it("soft AND hard limits; unlimited -> null; missing -> NaN", () => {
    expect(parseLimits(LIMITS_TEXT)).toEqual({ fsize: { soft: 52428800, hard: 52428800 }, nofile: { soft: 256, hard: 1048576 }, core: { soft: 0, hard: 0 } });
    expect(parseLimits("Max file size             unlimited            unlimited            bytes\n").fsize).toEqual({ soft: null, hard: null });
    expect(parseLimits("").nofile.soft).toBeNaN();
  });

  it("cgroup values and type checks", () => {
    expect(parseCgroupMax("max\n")).toBeNull();
    expect(parseCgroupMax("536870912\n")).toBe(536870912);
    expect(parseCgroupMax("garbage")).toBeNaN();
    for (const fn of [parseProcStatus, parseNetDev, parseHasRoute, parseIpv6RouteDevices, parseLimits, parseCgroupMax]) expect(() => (fn as any)(5)).toThrow(TypeError);
  });
});

describe("canary evaluation", () => {
  const check = (mutate: (r: any) => void) => {
    const r = compliantReport();
    mutate(r);
    return evaluateCanary(r, SPEC).join("\n");
  };

  it("a compliant report passes", () => {
    expect(evaluateCanary(compliantReport(), SPEC)).toEqual([]);
  });

  it.each([
    // identity
    ["root", (r: any) => { r.uids = [0, 0, 0, 0]; }, "uid must all be 10001"],
    ["a different effective uid (setuid)", (r: any) => { r.uids = [10001, 0, 10001, 10001]; }, "uid must all be 10001"],
    ["a different saved gid", (r: any) => { r.gids = [10001, 10001, 0, 10001]; }, "gid must all be 10001"],
    ["only three uid fields", (r: any) => { r.uids = [10001, 10001, 10001]; }, "uid must all be 10001"],
    ["non-numeric uid", (r: any) => { r.uids = [10001, Number.NaN, 10001, 10001]; }, "uid must all be 10001"],
    ["a supplementary group (docker group)", (r: any) => { r.groups = [999]; }, "supplementary groups"],
    ["effective capabilities", (r: any) => { r.capEff = "00000000a80425fb"; }, "capabilities"],
    ["permitted capabilities", (r: any) => { r.capPrm = "0000000000000400"; }, "capabilities"],
    ["bounding set not empty", (r: any) => { r.capBnd = "000001ffffffffff"; }, "capabilities"],
    ["capability field missing", (r: any) => { r.capBnd = ""; }, "capabilities"],
    ["no_new_privs unset", (r: any) => { r.noNewPrivs = 0; }, "no_new_privs"],
    ["seccomp off", (r: any) => { r.seccompMode = 0; }, "seccomp"],
    ["seccomp unreadable (NaN)", (r: any) => { r.seccompMode = Number.NaN; }, "seccomp"],
    // network evidence
    ["a network interface", (r: any) => { r.interfaces = ["lo", "eth0"]; }, "exactly one interface, lo"],
    ["no interfaces observed (ambiguous)", (r: any) => { r.interfaces = []; }, "exactly one interface, lo"],
    ["an IPv4 route", (r: any) => { r.ipv4Routes = true; }, "IPv4 routes"],
    ["an IPv6 route on eth0", (r: any) => { r.ipv6RouteDevices = ["lo", "eth0"]; }, "IPv6 routes"],
    ["outbound connect succeeded", (r: any) => { r.testNetConnect = "connected"; }, "supplementary outbound attempt must fail"],
    ["outbound connect ambiguous error", (r: any) => { r.testNetConnect = "error"; }, "supplementary outbound attempt must fail"],
    // environment and filesystem
    ["proxy variable visible", (r: any) => { r.envNames.push("HTTPS_PROXY"); }, "environment"],
    ["root writable", (r: any) => { r.writes.root = "allowed"; }, "writing to / must fail with EROFS"],
    ["root denied only by permission on a mount not reported ro (EACCES alone is not read-only evidence)", (r: any) => { r.writes.root = "EACCES"; r.fsMounts["/"] = ["rw,relatime"]; }, "writing to / must fail with EROFS, or EACCES on a mount reported \"ro\" (got EACCES"],
    ["app denied only by permission", (r: any) => { r.writes.app = "EPERM"; }, "/app must fail with EROFS"],
    ["input mount writable", (r: any) => { r.writes.input = "allowed"; }, "input mount must fail with EROFS"],
    ["input mount denied only by permission on a mount not reported ro", (r: any) => { r.writes.input = "EACCES"; r.fsMounts["/in"] = ["rw"]; }, "input mount must fail with EROFS, or EACCES on a mount reported \"ro\" (got EACCES"],
    ["output not writable", (r: any) => { r.writes.output = "EROFS"; }, "output mount must be writable"],
    ["tmp not writable", (r: any) => { r.writes.tmp = "ENOSPC"; }, "/tmp must be writable"],
    ["host canary readable", (r: any) => { r.hostCanaryRead = "readable"; }, "host canary"],
    ["a socket file visible", (r: any) => { r.sockets.found = ["/run/user/1000/docker.sock"]; }, "no socket files"],
    ["an unreadable scanned directory (ambiguous)", (r: any) => { r.sockets.unreadable = ["/run"]; }, "every scanned directory must be readable"],
    ["socket scan missing", (r: any) => { delete r.sockets; }, "no socket files"],
    // limits
    ["fsize soft unlimited", (r: any) => { r.limits.fsize.soft = null; }, "fsize soft limit"],
    ["nofile hard above the spec (soft could be raised)", (r: any) => { r.limits.nofile.hard = 1_048_576; }, "nofile hard limit"],
    ["core hard limit", (r: any) => { r.limits.core.hard = 1; }, "core hard limit"],
    ["limits missing", (r: any) => { delete r.limits; }, "fsize soft limit"],
    ["limits NaN (unparseable)", (r: any) => { r.limits.fsize = { soft: Number.NaN, hard: Number.NaN }; }, "fsize soft limit"],
    ["memory unlimited", (r: any) => { r.cgroupMemoryMax = null; }, "memory.max"],
    ["memory too high", (r: any) => { r.cgroupMemoryMax = 4 * 1024 ** 3; }, "memory.max"],
    ["pids unlimited", (r: any) => { r.cgroupPidsMax = null; }, "pids.max"],
    ["cgroup file unreadable (NaN, e.g. cgroup v1 or another runtime)", (r: any) => { r.cgroupPidsMax = Number.NaN; }, "pids.max"],
    // format
    ["an old report version", (r: any) => { r.version = 1; }, "unsupported version"],
    ["writes missing", (r: any) => { delete r.writes; }, "writing to / must fail with EROFS"],
  ])("refuses %s", (_label, mutate, message) => {
    expect(check(mutate)).toContain(message);
  });

  it("a network timeout is accepted only as supplementary; it never compensates for an interface or route", () => {
    expect(check((r) => { r.testNetConnect = "timeout"; })).toBe("");
    expect(check((r) => { r.testNetConnect = "timeout"; r.interfaces = ["lo", "eth0"]; })).toContain("exactly one interface");
  });

  it("refuses non-object reports", () => {
    for (const raw of [null, [], "ok", 1]) expect(evaluateCanary(raw, SPEC).length).toBeGreaterThan(0);
  });

  it("the probe's guard refuses to run without the explicit --canary flag (checked before any filesystem access)", () => {
    expect(insideCanaryContainer(["node", "probe.js"])).toBe(false);
  });
});

describe("acceptance finding 1: positive gVisor evidence (verifyGvisorEvidence)", () => {
  const unrecorded = resolveSpec({ imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT });

  it("passes only when the container kernel differs from the host's and equals the recorded gVisor reference", () => {
    expect(verifyGvisorEvidence(compliantReport(), SPEC, HOST_PROC_VERSION)).toEqual([]);
  });

  it.each([
    ["no recorded reference", compliantReport(), unrecorded, HOST_PROC_VERSION, "no reference /proc/version has been recorded"],
    ["container shows the host kernel (runsc name mapped to a shared-kernel runtime)", { ...compliantReport(), procVersion: HOST_PROC_VERSION }, SPEC, HOST_PROC_VERSION, "sees the host kernel"],
    ["reference recorded wrongly as the host kernel", { ...compliantReport(), procVersion: HOST_PROC_VERSION },
      resolveSpec({ imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, gvisorProcVersion: HOST_PROC_VERSION }), HOST_PROC_VERSION, "sees the host kernel"],
    ["a different non-host kernel", { ...compliantReport(), procVersion: "Linux version 5.15.0-kata #1" }, SPEC, HOST_PROC_VERSION, "does not match the recorded gVisor reference"],
    ["container value missing", { ...compliantReport(), procVersion: undefined }, SPEC, HOST_PROC_VERSION, "container /proc/version is missing or malformed"],
    ["container value malformed", { ...compliantReport(), procVersion: 42 }, SPEC, HOST_PROC_VERSION, "container /proc/version is missing or malformed"],
    ["report not an object", null, SPEC, HOST_PROC_VERSION, "container /proc/version is missing or malformed"],
    ["host value missing", compliantReport(), SPEC, undefined, "host /proc/version is missing or malformed"],
    ["host value empty", compliantReport(), SPEC, "", "host /proc/version is missing or malformed"],
    ["host value malformed", compliantReport(), SPEC, "6.8.0", "host /proc/version is missing or malformed"],
  ])("%s: refused", (_label, report, spec, host, message) => {
    const v = verifyGvisorEvidence(report, spec as any, host);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(message);
  });

  it("the evaluation itself requires the /proc/version observation (version 3 report)", () => {
    expect(evaluateCanary({ ...compliantReport(), procVersion: undefined }, SPEC).join()).toContain("kernel: /proc/version must be observed");
    expect(evaluateCanary({ ...compliantReport(), procVersion: "garbage" }, SPEC).join()).toContain("kernel: /proc/version must be observed");
    expect(evaluateCanary({ ...compliantReport(), version: 2 }, SPEC).join()).toContain("unsupported version");
    expect(compliantReport().procVersion).toBe(FAKE_GVISOR_PROC_VERSION);
  });
});

describe("v5 review finding 1: read-only evidence for /etc/hosts, /etc/hostname, /etc/resolv.conf (mountinfo)", () => {
  const MOUNTINFO = [
    "600 500 0:50 / / ro,relatime - overlay overlay rw,lowerdir=x",
    "610 600 8:1 /var/lib/docker/containers/abc/hosts /etc/hosts ro,nosuid,nodev,relatime - ext4 /dev/sda1 rw",
    "611 600 8:1 /var/lib/docker/containers/abc/hostname /etc/hostname ro,relatime - ext4 /dev/sda1 rw",
    "612 600 8:1 /var/lib/docker/containers/abc/resolv.conf /etc/resolv.conf ro,relatime - ext4 /dev/sda1 rw",
    "613 600 8:1 /x /odd\\040name rw - ext4 /dev/sda1 rw",
  ].join("\n");

  it("parses per-mount options for each target (octal escapes decoded)", () => {
    expect(parseMountinfo(MOUNTINFO)).toEqual({ "/etc/hosts": ["ro,nosuid,nodev,relatime"], "/etc/hostname": ["ro,relatime"], "/etc/resolv.conf": ["ro,relatime"] });
    expect(parseMountinfo("")).toEqual({ "/etc/hosts": [], "/etc/hostname": [], "/etc/resolv.conf": [] });
  });

  it.each([
    ["/etc/hosts mounted read-write", (r: any) => { r.etcMounts["/etc/hosts"] = ["rw,relatime"]; }, "/etc/hosts must be mounted exactly once and read-only"],
    ["/etc/resolv.conf not mounted (missing evidence)", (r: any) => { r.etcMounts["/etc/resolv.conf"] = []; }, "/etc/resolv.conf must be mounted exactly once"],
    ["/etc/hostname mounted twice (ambiguous: stacked mounts)", (r: any) => { r.etcMounts["/etc/hostname"] = ["ro", "rw"]; }, "/etc/hostname must be mounted exactly once"],
    ["contradictory options", (r: any) => { r.etcMounts["/etc/hosts"] = ["ro,rw"]; }, "/etc/hosts must be mounted exactly once and read-only"],
    ["options without ro", (r: any) => { r.etcMounts["/etc/hosts"] = ["relatime"]; }, "/etc/hosts must be mounted exactly once and read-only"],
    ["observation missing", (r: any) => { delete r.etcMounts; }, "/etc/hosts must be mounted"],
    ["malformed entry", (r: any) => { r.etcMounts["/etc/hosts"] = [42]; }, "/etc/hosts must be mounted"],
  ])("%s: refused", (_label, mutate, message) => {
    const r = compliantReport();
    mutate(r);
    expect(evaluateCanary(r, SPEC).join("\n")).toContain(message);
  });

  it("an older report version is refused", () => {
    expect(evaluateCanary({ ...compliantReport(), version: 3 }, SPEC).join()).toContain("unsupported version");
  });
});
