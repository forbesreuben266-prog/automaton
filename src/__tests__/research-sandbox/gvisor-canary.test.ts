/**
 * V2.4: the six canary findings from the first real gVisor run
 * (setup-20261104-152455-699505611), each grounded in gVisor
 * release-20261102.0 (commit 7a675ac6) or Docker docker-v29.9.3 source:
 *  1. seccomp mode 0: GENUINE. runsc ignores the OCI seccomp profile unless
 *     --oci-seccomp is set (runsc/boot/seccomp.go). Fixed on the host by
 *     registering runsc with exactly ["--oci-seccomp"]; the canary rule (mode 2)
 *     is unchanged, and runtimeArgs other than exactly that flag refuse.
 *  2. extra environment names: REPORTING. Docker adds HOSTNAME
 *     (daemon/container/container.go) and the runtime adds HOME when unset
 *     (gVisor fsimpl/user/user.go, default "/"). Allowed with exact values only.
 *  3/4. EACCES on / and the input mount: REPORTING ORDER. gVisor checks write
 *     permission before the read-only flag (fsimpl/overlay/filesystem.go), so
 *     uid 10001 gets EACCES from root-owned folders. Accepted only with the
 *     mount's own "ro" flag from mountinfo (vfs/mount.go), exactly one entry.
 *  5. memory.max null: REPORTING. gVisor's default in-sandbox cgroup is v1;
 *     runsc reads the host cgroup's memory limit and exposes it as
 *     memory/memory.limit_in_bytes (runsc/sandbox/sandbox.go, cgroupfs/memory.go).
 *  6. pids.max null: NOT OBSERVABLE inside gVisor. runsc applies the pids limit
 *     to the sandbox's host cgroup (runsc/cgroup) and never copies it into its
 *     cgroupfs (fsimpl/cgroupfs/pids.go: "max"). Accepted only under an
 *     isolating runtime, with the v1 memory evidence, and HostConfig.PidsLimit
 *     checked by inspect; a residual covered by M1 (host-side enforcement is
 *     daemon/runtime-attested), which stays blocked.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVED_RUNSC_ARGS, MEETS_SPEC_BLOCKERS, evaluateCanary, parseMountinfo } from "../../research-sandbox/index.js";
import { SPEC, compliantReport, gvisorReport } from "./fixtures.js";

const G = { isolating: true };
const ev = (mutate: (r: any) => void, context = G) => { const r = gvisorReport(); mutate(r); return evaluateCanary(r, SPEC, context).join("\n"); };

describe("V2.4: the gVisor report", () => {
  it("is accepted under an isolating runtime", () => {
    expect(evaluateCanary(gvisorReport(), SPEC, G)).toEqual([]);
  });

  it("the report as observed on the VPS (seccomp mode 0, before --oci-seccomp) is still refused, for seccomp only", () => {
    const v = evaluateCanary({ ...gvisorReport(), seccompMode: 0 }, SPEC, G);
    expect(v).toEqual(["seccomp: a filter must be active (mode 2) (got 0)"]);
  });

  it("the v1 cgroup layout and pids \"max\" are refused for a non-isolating runtime (runc must show v2 limits)", () => {
    const v = evaluateCanary(gvisorReport(), SPEC, { isolating: false }).join("\n");
    expect(v).toContain("limits: cgroup memory.max (v2)");
    expect(v).toContain("limits: cgroup pids.max (v2)");
  });

  it("the classic runc report stays accepted", () => {
    expect(evaluateCanary(compliantReport(), SPEC)).toEqual([]);
    expect(evaluateCanary(compliantReport(), SPEC, G)).toEqual([]);
  });
});

describe("V2.4 finding 1: seccomp stays mode 2; the fix is the approved runsc flag", () => {
  it.each([0, 1, null, "2"])("seccompMode %j refused", (mode) => {
    expect(ev((r) => { r.seccompMode = mode; })).toContain("seccomp: a filter must be active (mode 2)");
  });

  it("exactly one approved runsc flag: --oci-seccomp", () => {
    expect(APPROVED_RUNSC_ARGS).toEqual(["--oci-seccomp"]);
    expect(Object.isFrozen(APPROVED_RUNSC_ARGS)).toBe(true);
  });
});

describe("V2.4 finding 2: runtime-injected HOSTNAME and HOME, exact values only", () => {
  it.each([
    ["HOSTNAME with another value", (r: any) => { r.runtimeEnv.HOSTNAME = "host1"; }, 'HOSTNAME must be "sandbox"'],
    ["HOME pointing elsewhere", (r: any) => { r.runtimeEnv.HOME = "/root"; }, 'HOME, when injected by the runtime, must be "/"'],
    ["HOME listed but its value not reported", (r: any) => { r.runtimeEnv.HOME = null; }, "HOME, when injected"],
    ["a value reported for an unset name", (r: any) => { r.envNames = r.envNames.filter((n: string) => n !== "HOME"); }, "HOME, when injected"],
    ["runtimeEnv missing", (r: any) => { delete r.runtimeEnv; }, "runtimeEnv must report exactly HOSTNAME and HOME"],
    ["runtimeEnv with another variable", (r: any) => { r.runtimeEnv.PWD = "/app"; }, "runtimeEnv must report exactly HOSTNAME and HOME"],
    ["another unexpected name, listed", (r: any) => { r.envNames.push("HTTPS_PROXY", "TERM"); }, 'unexpected: ["HTTPS_PROXY","TERM"]'],
    ["a name with odd characters is sanitised in the message", (r: any) => { r.envNames.push("A=B\n"); }, 'unexpected: ["A?B?"]'],
  ])("%s: refused", (_l, mutate, message) => {
    expect(ev(mutate)).toContain(message);
  });

  it("without HOSTNAME/HOME (a runtime that adds neither) both must be reported as null", () => {
    expect(evaluateCanary(compliantReport(), SPEC)).toEqual([]);
  });
});

describe("V2.4 findings 3 and 4: EACCES counts only with the mount's own ro flag", () => {
  it.each([
    ["/ reported rw", (r: any) => { r.fsMounts["/"] = ["rw"]; }, "writing to / must fail with EROFS, or EACCES"],
    ["/ not in mountinfo", (r: any) => { r.fsMounts["/"] = []; }, "writing to / must fail"],
    ["/ mounted twice", (r: any) => { r.fsMounts["/"] = ["ro", "ro"]; }, "writing to / must fail"],
    ["/ contradictory", (r: any) => { r.fsMounts["/"] = ["ro,rw"]; }, "writing to / must fail"],
    ["/in reported rw", (r: any) => { r.fsMounts["/in"] = ["rw,nosuid"]; }, "input mount must fail with EROFS, or EACCES"],
    ["fsMounts missing", (r: any) => { delete r.fsMounts; }, "input mount must fail"],
    ["/app with EACCES on an rw root", (r: any) => { r.writes.app = "EACCES"; r.fsMounts["/"] = ["rw"]; }, "/app must fail"],
    ["another errno", (r: any) => { r.writes.root = "EPERM"; }, "writing to / must fail"],
    ["root writable", (r: any) => { r.writes.root = "allowed"; }, "writing to / must fail"],
  ])("%s: refused", (_l, mutate, message) => {
    expect(ev(mutate)).toContain(message);
  });

  it("EROFS stays accepted whatever mountinfo says", () => {
    expect(ev((r) => { r.writes.root = "EROFS"; r.writes.input = "EROFS"; r.fsMounts = { "/": [], "/in": [] }; })).toBe("");
  });

  it("parseMountinfo reads gVisor's mountinfo format for / and /in", () => {
    const text = [
      "1 0 0:1 / / ro - 9p none rw,trans=fd",
      "2 1 0:2 / /in ro,nosuid,nodev - 9p none ro",
      "3 1 0:3 / /out rw,nosuid,nodev - 9p none rw",
      "4 1 0:4 / /etc/hosts ro - 9p none ro",
    ].join("\n");
    expect(parseMountinfo(text, ["/", "/in"] as const)).toEqual({ "/": ["ro"], "/in": ["ro,nosuid,nodev"] });
  });
});

describe("V2.4 findings 5 and 6: gVisor cgroup v1 values", () => {
  it.each([
    ["memory limit is the host total (runsc found no cgroup limit)", (r: any) => { r.cgroupV1.memoryLimitInBytes = "4294967296"; }, "memory/memory.limit_in_bytes (v1) must be at most"],
    ["memory limit absent", (r: any) => { r.cgroupV1.memoryLimitInBytes = ""; }, "memory.limit_in_bytes (v1)"],
    ["memory limit unlimited (gVisor default 2^63-1)", (r: any) => { r.cgroupV1.memoryLimitInBytes = "9223372036854775807"; }, "memory.limit_in_bytes (v1)"],
    ["memory limit 0", (r: any) => { r.cgroupV1.memoryLimitInBytes = "0"; }, "memory.limit_in_bytes (v1)"],
    ["memory limit malformed", (r: any) => { r.cgroupV1.memoryLimitInBytes = "512M"; }, "memory.limit_in_bytes (v1)"],
    ["pids max without the memory evidence", (r: any) => { r.cgroupV1.memoryLimitInBytes = ""; }, "pids.max (v2) must be at most 64, or under gVisor"],
    ["pids above the limit", (r: any) => { r.cgroupV1.pidsMax = "100"; }, "pids.max (v2) must be at most 64"],
    ["pids malformed", (r: any) => { r.cgroupV1.pidsMax = "unlimited"; }, "pids.max (v2) must be at most 64"],
    ["pids absent", (r: any) => { r.cgroupV1.pidsMax = ""; }, "pids.max (v2) must be at most 64"],
    ["a v2 value present and too high is not overridden by v1", (r: any) => { r.cgroupPidsMax = 4096; }, "pids.max (v2) must be at most 64"],
    ["a v2 memory value present and too high is not overridden by v1", (r: any) => { r.cgroupMemoryMax = 4 * 1024 ** 3; }, "memory.max (v2)"],
    ["cgroupV1 missing", (r: any) => { delete r.cgroupV1; }, "cgroupV1 must report memoryLimitInBytes and pidsMax as strings"],
    ["cgroupV1 with numbers", (r: any) => { r.cgroupV1 = { memoryLimitInBytes: 536870912, pidsMax: "max" }; }, "cgroupV1 must report"],
    ["cgroupV1 with an extra key", (r: any) => { r.cgroupV1.cpu = "1"; }, "cgroupV1 must report"],
  ])("%s: refused", (_l, mutate, message) => {
    expect(ev(mutate)).toContain(message);
  });

  it("a numeric in-range v1 pids value is accepted too", () => {
    expect(ev((r) => { r.cgroupV1.pidsMax = "64"; })).toBe("");
  });
});

describe("V2.4 keeps M1/M3 blocked and the probe reports the new observations", () => {
  it("blockers unchanged", () => {
    expect(MEETS_SPEC_BLOCKERS.map((b) => b.slice(0, 3))).toEqual(["M1:", "M3:"]);
  });

  it("the probe collects fsMounts, cgroupV1 and runtimeEnv (only HOSTNAME and HOME values) and reports version 5", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../research-sandbox/canary-probe.ts"), "utf8");
    expect(src).toContain("version: 5,");
    expect(src).toContain("fsMounts: parseMountinfo(mountinfo, FS_MOUNT_TARGETS),");
    expect(src).toContain('cgroupV1: { memoryLimitInBytes: cgroupV1Raw("/sys/fs/cgroup/memory/memory.limit_in_bytes"), pidsMax: cgroupV1Raw("/sys/fs/cgroup/pids/pids.max") },');
    expect(src).toContain("runtimeEnv: { HOSTNAME: process.env.HOSTNAME ?? null, HOME: process.env.HOME ?? null },");
    expect(src.match(/process\.env\.[A-Z]/g)).toEqual(["process.env.H", "process.env.H"]); // no other variable's value is read
  });
});
