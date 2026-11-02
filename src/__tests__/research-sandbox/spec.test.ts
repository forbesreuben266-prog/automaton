/** Sandbox specification: baseline, tighten-only overrides, exact run paths, exact argv, security-args hash. Offline. */

import { describe, expect, it } from "vitest";
import {
  SANDBOX_SPEC, SandboxSpecError, buildCreateArgs, containerName, expectedRunPaths, imageReference, resolveSpec,
  expectedContainerHostFiles, expectedEnv, securityArgsHash, validateRunPaths,
} from "../../research-sandbox/index.js";
import { FAKE_DIGEST, FAKE_ENTRYPOINT, FAKE_RUNSC, IMAGE_REF, PROBE_COMMAND, RUN, SPEC } from "./fixtures.js";

const MiB = 1024 * 1024;

describe("baseline specification", () => {
  it("encodes the required isolation values and is frozen", () => {
    expect(SANDBOX_SPEC).toMatchObject({
      network: "none", readOnlyRootfs: true, user: "10001:10001", ipcMode: "none", runsRoot: "/srv/research-runs",
      memoryBytes: 512 * MiB, memorySwapBytes: 512 * MiB, nanoCpus: 500_000_000, pidsLimit: 64,
      ulimits: { fsize: 50 * MiB, nofile: 256, core: 0 }, tmpfsBytes: 64 * MiB, timeoutMs: 300_000,
      isolatingRuntimes: ["runsc"], developmentRuntimes: ["runc", "crun"],
    });
    expect(Object.isFrozen(SANDBOX_SPEC) && Object.isFrozen(SANDBOX_SPEC.ulimits) && Object.isFrozen(SANDBOX_SPEC.image)).toBe(true);
  });

  it("D3: digest and entrypoint are unpinned until an approved pull; the image reference is refused", () => {
    expect(SANDBOX_SPEC.image).toEqual({ repository: "docker.io/library/node", tag: "22.22.0-bookworm-slim", digest: null, entrypoint: null, env: null, manifestDigest: null });
    const msg = (() => { try { imageReference(SANDBOX_SPEC); return ""; } catch (e) { return (e as Error).message; } })();
    expect(msg).toContain("image digest is not pinned");
    expect(msg).toContain("image entrypoint is not pinned");
    expect(() => imageReference(resolveSpec({ imageDigest: FAKE_DIGEST }))).toThrow("entrypoint is not pinned");
    expect(() => imageReference(resolveSpec({ imageEntrypoint: FAKE_ENTRYPOINT }))).toThrow("digest is not pinned");
    expect(imageReference(SPEC)).toBe(IMAGE_REF);
  });

  it("acceptance findings 1-2: the built-in seccomp profile is required and no gVisor reference is recorded by default", () => {
    expect(SANDBOX_SPEC.seccompProfile).toBe("builtin");
    expect(SANDBOX_SPEC.gvisorProcVersion).toBeNull();
  });

  it("gvisorProcVersion can be recorded once, must look like /proc/version, and can't be re-pinned to another value", () => {
    const pinned = resolveSpec({ gvisorProcVersion: "Linux version 4.4.0 #1 SMP" });
    expect(pinned.gvisorProcVersion).toBe("Linux version 4.4.0 #1 SMP");
    expect(resolveSpec({ gvisorProcVersion: "Linux version 4.4.0 #1 SMP" }, pinned).gvisorProcVersion).toBe("Linux version 4.4.0 #1 SMP");
    expect(() => resolveSpec({ gvisorProcVersion: "Linux version 6.0 other" }, pinned)).toThrow("differs from the already recorded value");
    for (const bad of ["", "4.4.0", "Linux version ", "Linux version 4.4.0\nextra", `Linux version ${"x".repeat(501)}`, 42, null]) {
      expect(() => resolveSpec({ gvisorProcVersion: bad })).toThrow("gvisorProcVersion");
    }
    expect(() => resolveSpec({ seccompProfile: "unconfined" })).toThrow("cannot be overridden");
  });
});

describe("overrides can only tighten", () => {
  it("lower limits are accepted and swap follows memory (no swap)", () => {
    const s = resolveSpec({ memoryBytes: 256 * MiB, pidsLimit: 32 });
    expect(s).toMatchObject({ memoryBytes: 256 * MiB, memorySwapBytes: 256 * MiB, pidsLimit: 32 });
  });

  it.each(["memoryBytes", "nanoCpus", "pidsLimit", "tmpfsBytes", "timeoutMs", "maxOutputBytes", "maxInputFileBytes", "maxInputTotalBytes"])(
    "raising %s is refused", (key) => {
      expect(() => resolveSpec({ [key]: (SANDBOX_SPEC as any)[key] + 1 })).toThrow("would loosen");
    });

  it.each(["network", "user", "readOnlyRootfs", "isolatingRuntimes", "developmentRuntimes", "envAllowlist", "ulimits", "memorySwapBytes", "image", "runsRoot", "mountPoints"])(
    "%s can't be overridden", (key) => {
      expect(() => resolveSpec({ [key]: "anything" })).toThrow("cannot be overridden");
    });

  it("refuses getters (unread), non-objects, malformed digests/entrypoints and re-pinning to a different value", () => {
    let reads = 0;
    const o = {};
    Object.defineProperty(o, "pidsLimit", { enumerable: true, get: () => { reads += 1; return 1; } });
    expect(() => resolveSpec(o)).toThrow("getters/setters");
    expect(reads).toBe(0);
    for (const bad of [null, [], "x", 5]) expect(() => resolveSpec(bad)).toThrow(SandboxSpecError);
    for (const d of ["sha256:short", "md5:" + "a".repeat(64), "sha256:" + "A".repeat(64)]) expect(() => resolveSpec({ imageDigest: d })).toThrow("imageDigest");
    for (const ep of ["sh", [], [""], ["a\0b"], Array(9).fill("x")]) {
      if (Array.isArray(ep) && ep.length === 0) continue; // an empty entrypoint is a valid pinned value
      expect(() => resolveSpec({ imageEntrypoint: ep })).toThrow("imageEntrypoint");
    }
    expect(() => resolveSpec({ imageDigest: `sha256:${"cd".repeat(32)}` }, SPEC)).toThrow("differs from the already pinned digest");
    expect(() => resolveSpec({ imageEntrypoint: ["/bin/sh"] }, SPEC)).toThrow("differs from the already pinned entrypoint");
  });
});

describe("run paths are exactly <runsRoot>/<runId>/{in,out}", () => {
  it("accepts the exact folders", () => {
    expect(expectedRunPaths(SPEC, "r1")).toEqual({ inputDir: RUN.inputDir, outputDir: RUN.outputDir });
    expect(validateRunPaths(RUN, SPEC)).toEqual([]);
  });

  it.each([
    ["/home", "/home/user"], ["a home folder", "/home/user/research/in"], ["/tmp", "/tmp"], ["/mnt/data", "/mnt/data"],
    ["/opt", "/opt"], ["the runs root itself", "/srv/research-runs"], ["the run folder", "/srv/research-runs/r1"],
    ["another run", "/srv/research-runs/r2/in"], ["a sibling", "/srv/research-runs/r1/in2"], ["dot-dot", "/srv/research-runs/r1/../r2/in"],
    ["trailing slash", "/srv/research-runs/r1/in/"], ["relative", "srv/research-runs/r1/in"], ["mount option injection", "/srv/research-runs/r1/in,dst=/etc"],
  ])("refuses %s as the input folder", (_label, inputDir) => {
    expect(validateRunPaths({ ...RUN, inputDir }, SPEC).join()).toContain("run.inputDir: must be exactly");
  });

  it("refuses unsafe output folders, bad run ids, extra fields and getters", () => {
    for (const outputDir of ["/tmp", "/home/user", RUN.inputDir, "/srv/research-runs/r1"]) {
      expect(validateRunPaths({ ...RUN, outputDir }, SPEC).join()).toContain("run.outputDir: must be exactly");
    }
    for (const runId of ["R1", "-r1", "r1/../x", "", "a".repeat(65), "r1,x"]) expect(validateRunPaths({ ...RUN, runId }, SPEC).join()).toContain("run.runId");
    expect(validateRunPaths({ ...RUN, privileged: true }, SPEC).join()).toContain("not an allowed field");
    let reads = 0;
    const run = { ...RUN };
    Object.defineProperty(run, "inputDir", { enumerable: true, get: () => { reads += 1; return RUN.inputDir; } });
    expect(validateRunPaths(run, SPEC).join()).toContain("getters/setters");
    expect(reads).toBe(0);
  });
});

describe("create argv and binding hash", () => {
  it("is exactly the specified flags, as an argv array", () => {
    expect(buildCreateArgs(SPEC, RUN, "runsc", PROBE_COMMAND, "canary")).toEqual([
      "create", "--name", "research-sandbox-r1-canary", "--pull", "never", "--hostname", "sandbox", "--runtime", "runsc", "--network", "none", "--read-only", "--user", "10001:10001",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--ipc", "none", "--cgroupns", "private",
      "--pids-limit", "64", "--memory", "536870912", "--memory-swap", "536870912", "--cpus", "0.5",
      "--ulimit", "fsize=52428800:52428800", "--ulimit", "nofile=256:256", "--ulimit", "core=0:0",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864",
      "--mount", "type=bind,src=/srv/research-runs/r1/in,dst=/in,readonly,bind-propagation=rprivate",
      "--mount", "type=bind,src=/srv/research-runs/r1/out,dst=/out,bind-propagation=rprivate",
      "--env", "NODE_ENV=production", "--env", "RESEARCH_RUN_ID=r1", "--log-driver", "none", "--workdir", "/app", "--no-healthcheck",
      IMAGE_REF, ...PROBE_COMMAND,
    ]);
  });

  it("acceptance finding 4: --pull never is always present and covered by the security-args hash", () => {
    for (const purpose of ["canary", "run"] as const) {
      const args = buildCreateArgs(SPEC, RUN, "runsc", ["node"], purpose);
      expect(args.filter((a) => a === "--pull")).toHaveLength(1);
      expect(args[args.indexOf("--pull") + 1]).toBe("never");
      expect(args.indexOf("--pull")).toBeLessThan(args.indexOf(IMAGE_REF));
      const i = args.indexOf("--pull");
      const withoutPull = [...args.slice(0, i), ...args.slice(i + 2)];
      expect(securityArgsHash(withoutPull, SPEC)).not.toBe(securityArgsHash(args, SPEC));
    }
  });

  it("refuses an unpinned image, unknown runtime, bad paths and bad commands", () => {
    expect(() => buildCreateArgs(SANDBOX_SPEC, RUN, "runsc", ["node"], "canary")).toThrow("not pinned");
    expect(() => buildCreateArgs(SPEC, RUN, "kata", ["node"], "canary")).toThrow('runtime "kata"');
    expect(() => buildCreateArgs(SPEC, { ...RUN, inputDir: "/home/user" }, "runsc", ["node"], "canary")).toThrow("must be exactly");
    for (const bad of [[], [""], ["node", "a\0b"]]) expect(() => buildCreateArgs(SPEC, RUN, "runsc", bad, "canary")).toThrow("command");
  });

  it("container names are deterministic and validated", () => {
    expect(containerName("r1", "canary")).toBe("research-sandbox-r1-canary");
    expect(containerName("r1", "run")).toBe("research-sandbox-r1-run");
    expect(() => containerName("R1", "run")).toThrow(SandboxSpecError);
  });

  it("the security hash ignores the container name and command but changes with any security flag", () => {
    const canary = securityArgsHash(buildCreateArgs(SPEC, RUN, "runsc", PROBE_COMMAND, "canary"), SPEC);
    const realRun = securityArgsHash(buildCreateArgs(SPEC, RUN, "runsc", ["node", "/app/worker.js"], "run"), SPEC);
    expect(canary).toBe(realRun);
    expect(canary).toMatch(/^[0-9a-f]{64}$/);
    expect(securityArgsHash(buildCreateArgs(SPEC, RUN, "runc", PROBE_COMMAND, "canary"), SPEC)).not.toBe(canary);
    expect(securityArgsHash(buildCreateArgs(resolveSpec({ pidsLimit: 32 }, SPEC), RUN, "runsc", PROBE_COMMAND, "canary"), SPEC)).not.toBe(canary);
    const otherRun = { runId: "r2", ...expectedRunPaths(SPEC, "r2") };
    expect(securityArgsHash(buildCreateArgs(SPEC, otherRun, "runsc", PROBE_COMMAND, "canary"), SPEC)).not.toBe(canary);
    expect(() => securityArgsHash(["create", "--network", "none"], SPEC)).toThrow("pinned image reference");
  });
});

describe("v5 review: recorded image environment, manifest digest and Docker data root", () => {
  it("nothing is recorded by default, so the derived expectations are null (preflight refuses)", () => {
    expect(SANDBOX_SPEC.image.env).toBeNull();
    expect(SANDBOX_SPEC.image.manifestDigest).toBeNull();
    expect(SANDBOX_SPEC.dockerDataRoot).toBeNull();
    expect(expectedEnv(SANDBOX_SPEC, RUN)).toBeNull();
    expect(expectedContainerHostFiles(SANDBOX_SPEC, "a".repeat(64))).toBeNull();
    expect(SANDBOX_SPEC.hostname).toBe("sandbox");
  });

  it("expected values once recorded", () => {
    expect(expectedEnv(SPEC, RUN)).toEqual([...SPEC.image.env!, "NODE_ENV=production", "RESEARCH_RUN_ID=r1"]);
    expect(expectedContainerHostFiles(SPEC, "a".repeat(64))).toEqual({
      HostsPath: `/var/lib/docker/containers/${"a".repeat(64)}/hosts`,
      HostnamePath: `/var/lib/docker/containers/${"a".repeat(64)}/hostname`,
      ResolvConfPath: `/var/lib/docker/containers/${"a".repeat(64)}/resolv.conf`,
    });
    expect(expectedContainerHostFiles(SPEC, "not-an-id")).toBeNull();
  });

  it.each([
    ["imageEnv with a non-allowlisted name", { imageEnv: ["NODE_OPTIONS=--require x"] }, "imageEnv: must be printable NAME=value"],
    ["imageEnv with a bare name", { imageEnv: ["PATH"] }, "imageEnv: must be printable NAME=value"],
    ["imageEnv with duplicates", { imageEnv: ["PATH=/a", "PATH=/b"] }, "imageEnv: duplicate names"],
    ["imageEnv not an array", { imageEnv: "PATH=/bin" }, "imageEnv: must be"],
    ["imageEnv with our own variable", { imageEnv: ["NODE_ENV=development"] }, "imageEnv: must be printable NAME=value"],
    ["imageManifestDigest malformed", { imageManifestDigest: "sha256:xyz" }, "imageManifestDigest: must be sha256"],
    ["dockerDataRoot relative", { dockerDataRoot: "var/lib/docker" }, "dockerDataRoot: must be a normalized absolute path"],
    ["dockerDataRoot inside the runs root", { dockerDataRoot: "/srv/research-runs/docker" }, "neither contains nor is inside the runs root"],
    ["dockerDataRoot containing the runs root", { dockerDataRoot: "/srv" }, "neither contains nor is inside the runs root"],
    ["dockerDataRoot with ..", { dockerDataRoot: "/var/lib/../docker" }, "dockerDataRoot: must be a normalized absolute path"],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => resolveSpec(overrides)).toThrow(message);
  });

  it("recorded values can't be re-pinned to different ones", () => {
    expect(() => resolveSpec({ imageEnv: ["PATH=/other"] }, SPEC)).toThrow("differs from the already recorded environment");
    expect(() => resolveSpec({ imageManifestDigest: `sha256:${"00".repeat(32)}` }, SPEC)).toThrow("differs from the already recorded digest");
    expect(() => resolveSpec({ dockerDataRoot: "/data/docker" }, SPEC)).toThrow("differs from the already recorded value");
    expect(resolveSpec({ imageEnv: [...SPEC.image.env!].reverse() }, SPEC).image.env).toEqual([...SPEC.image.env!].reverse());
  });
});

describe("M1: recording the approved runtime binary", () => {
  const rb = (patch: Record<string, unknown>) => ({ runscBinary: { ...FAKE_RUNSC, args: [], ...patch } });

  it("nothing is recorded by default; a valid record (empty args) is frozen", () => {
    expect(SANDBOX_SPEC.runscBinary).toBeNull();
    const s1 = resolveSpec(rb({}));
    expect(s1.runscBinary).toEqual({ path: "/usr/local/bin/runsc", sha256: FAKE_RUNSC.sha256, args: [] });
    expect(Object.isFrozen(s1.runscBinary)).toBe(true);
    expect(Object.isFrozen(s1.runscBinary!.args)).toBe(true);
  });

  it.each([
    ["a path outside the system binary directories", rb({ path: "/tmp/runsc" }), "runscBinary.path: must be a file directly inside"],
    ["a path in a home directory", rb({ path: "/home/user/bin/runsc" }), "runscBinary.path"],
    ["a nested or traversing path", rb({ path: "/usr/local/bin/../../tmp/runsc" }), "runscBinary.path"],
    ["a relative path", rb({ path: "runsc" }), "runscBinary.path"],
    ["a malformed hash", rb({ sha256: "ABC" }), "runscBinary.sha256"],
    ["--network=host", rb({ args: ["--network=host"] }), "runscBinary.args: must be an empty array"],
    ["--net-raw", rb({ args: ["--net-raw"] }), "runscBinary.args: must be an empty array"],
    ["--allow-flag-override", rb({ args: ["--allow-flag-override=true"] }), "runscBinary.args: must be an empty array"],
    ["--ignore-cgroups", rb({ args: ["--ignore-cgroups"] }), "runscBinary.args: must be an empty array"],
    ["a test-only flag", rb({ args: ["--TESTONLY-unsafe-nonroot"] }), "runscBinary.args"],
    ["duplicate flags", rb({ args: ["--debug", "--debug"] }), "runscBinary.args: must be an empty array"],
    ["a malformed flag", rb({ args: ["network=host"] }), "runscBinary.args: must be an empty array"],
    ["args not an array", rb({ args: "--debug" }), "runscBinary.args"],
    ["an extra key", rb({ shim: "/usr/bin/containerd-shim" }), "runscBinary: must be { path, sha256, args }"],
    ["null", { runscBinary: null }, "runscBinary: must be { path, sha256, args }"],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => resolveSpec(overrides)).toThrow(message);
  });

  it("refuses a getter and a re-pin to a different binary", () => {
    let reads = 0;
    const getter = { path: "/usr/local/bin/runsc", args: [] } as any;
    Object.defineProperty(getter, "sha256", { enumerable: true, get: () => { reads += 1; return FAKE_RUNSC.sha256; } });
    expect(() => resolveSpec({ runscBinary: getter })).toThrow("plain values");
    expect(reads).toBe(0);
    expect(() => resolveSpec(rb({ sha256: "00".repeat(32) }), SPEC)).toThrow("differs from the already recorded binary");
    expect(resolveSpec(rb({}), SPEC).runscBinary).toEqual(SPEC.runscBinary);
  });
});

describe("C1 and C4: recording requires empty runtime args and a plain binary name", () => {
  const rec = (patch: Record<string, unknown>) => () => resolveSpec({ runscBinary: { ...FAKE_RUNSC, args: [], ...patch } });

  it.each([
    [["--platform=systrap"]], [["--debug-log=/etc/cron.d/x"]], [["--log=/root/.bashrc"]], [["--fsgofer-host-uds"]], [["--rootless"]],
    [["--network=HOST"]], [["--watchdog-action=log"]], [[""]], [[42]], ["--debug"], [null], [{}],
  ])("C1: args %j refused", (args) => {
    expect(rec({ args })).toThrow("runscBinary.args: must be an empty array (no runsc runtime flags are approved)");
  });

  it.each([["/usr/local/bin/.."], ["/usr/bin/."], ["/usr/local/bin/..."], ["/usr/local/bin/.runsc"], ["/usr/sbin/."]])("C4: %s refused", (p) => {
    expect(rec({ path: p })).toThrow("runscBinary.path: must be a file directly inside");
  });

  it("C4: ordinary names are still accepted, and the directory restriction still applies", () => {
    expect(resolveSpec({ runscBinary: { ...FAKE_RUNSC, args: [], path: "/usr/bin/runsc-2026.1" } }).runscBinary!.path).toBe("/usr/bin/runsc-2026.1");
    expect(resolveSpec({ runscBinary: { ...FAKE_RUNSC, args: [], path: "/usr/local/sbin/runsc_x" } }).runscBinary!.path).toBe("/usr/local/sbin/runsc_x");
    expect(rec({ path: "/opt/runsc" })).toThrow("runscBinary.path");
    expect(rec({ path: "/usr/local/bin/sub/runsc" })).toThrow("runscBinary.path");
  });
});
