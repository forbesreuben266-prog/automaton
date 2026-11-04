/**
 * Preflight lifecycle, ratings, binding and cleanup with a fake engine and a
 * fake host filesystem. Nothing is executed and no container exists.
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLEANUP_ATTEMPTS, IsolationRefusedError, MEETS_SPEC_BLOCKERS, createArgvProblem, SANDBOX_SPEC, assertUntrustedInputAllowed, chooseRuntime, expectedRunPaths, rate,
  buildCreateArgs, imageReference, resolveSpec, runPreflight, securityArgsHash, serverVersionProblems, type ContainerEngine, type EngineInfo, type PreflightResult, type ProcessResult,
} from "../../research-sandbox/index.js";
import {
  CONTAINER_ID, DOCKER_CONFIG_DIR, DOCKER_INFO, ENGINE_TARGET, FAKE_DOCKER_SERVER_VERSION, FAKE_IMAGE_ID, FAKE_DATA_ROOT, FAKE_IMAGE_ENV, FAKE_MANIFEST_DIGEST, FAKE_RUNSC, FAKE_DIGEST, FAKE_ENTRYPOINT, HOST_CANARY, HOST_PROC_VERSION, POLICY, RUN, SPEC,
  compliantHostLayout, compliantInspect, compliantReport, fakeHostFs, finishedInspect, docker29Inspect, CONTAINER_HOST_FILES, gvisorReport,
} from "./fixtures.js";

const NAME = "research-sandbox-r1-canary";

// The preflight reads the host's /proc/version itself (never from the caller). Tests stub that one read.
let hostProcVersion: () => string = () => HOST_PROC_VERSION;
beforeEach(() => {
  hostProcVersion = () => HOST_PROC_VERSION;
  const real = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) =>
    (p === "/proc/version" ? hostProcVersion() : (real as any)(p, ...rest))) as any);
});
afterEach(() => { vi.restoreAllMocks(); });

/** A result shaped exactly like a passing meets-spec result (built by hand; preflight can't produce one while blocked). */
const wouldBePassing = (): PreflightResult => ({
  rating: "meets-spec", allowsUntrustedInput: true, runtime: "runsc", engine: DOCKER_INFO, violations: [], hostTrust: "operator-attested-only",
  steps: ["spec", "paths", "host-paths", "engine-target", "engine-info", "engine-version", "runtime-binary-verified", "create", "runtime-config-rechecked-after-create", "inspect",
    "host-paths-recheck", "container-host-files", "canary", "inspect-after-canary", "container-host-files-after-canary", "removed-verified", "runtime-config-rechecked-after-canary", "runtime-binary-rechecked", "gvisor-verified"],
  cleanup: { containerName: NAME, containerId: CONTAINER_ID, attempts: 1, verifiedRemoved: true, detail: "removed and verified" },
  binding: { runId: RUN.runId, inputDir: RUN.inputDir, outputDir: RUN.outputDir, imageRef: imageReference(SPEC), runtime: "runsc",
    securityArgsSha256: securityArgsHash(buildCreateArgs(SPEC, RUN, "runsc", ["node"], "run"), SPEC), gvisorProcVersion: SPEC.gvisorProcVersion!,
    runtimeBinarySha256: SPEC.runscBinary!.sha256, dockerServerVersion: FAKE_DOCKER_SERVER_VERSION },
});
const refusalReasons = (r: PreflightResult, spec = SPEC, run_ = RUN): string[] => {
  try { assertUntrustedInputAllowed(r, { spec, run: run_ }); return []; } catch (err) { return [...(err as IsolationRefusedError).reasons]; }
};
const okStart: ProcessResult = { exitCode: 0, signal: null, stdout: JSON.stringify(compliantReport()), stderr: "", timedOut: false, truncated: false };

interface FakeOptions {
  info?: EngineInfo | Error;
  /** Answers for successive info() calls (first = before create); falls back to `info` when exhausted. */
  infoSequence?: Array<EngineInfo | Error>;
  inspect?: unknown | Error;
  /** V2.2: the re-inspect after the canary (default: finishedInspect of the created report). */
  inspectAfterStart?: unknown;
  /** V2.2: called when the container starts (e.g. Docker 29 writing the host files). */
  onStart?: () => void;
  start?: ProcessResult | Error;
  create?: "ok" | Error | "error-after-creating";
  removeFailures?: number; // remove() throws this many times
  removeLeavesContainer?: boolean; // remove() "succeeds" but the container remains
  existsThrows?: boolean;
  leftover?: boolean;
}

function fakeEngine(o: FakeOptions = {}) {
  const calls: string[] = [];
  const existing = new Set<string>(o.leftover ? [NAME] : []);
  let removeFailures = o.removeFailures ?? 0;
  let lastStart: { id: string; timeoutMs: number; maxOutputBytes: number } | null = null;
  let started = false;
  const engine: ContainerEngine = {
    target: ENGINE_TARGET,
    async info() {
      calls.push("info");
      const next = o.infoSequence?.shift();
      if (next !== undefined) { if (next instanceof Error) throw next; return next; }
      if (o.info instanceof Error) throw o.info;
      return o.info ?? DOCKER_INFO;
    },
    async create(args, imageRef) {
      calls.push("create");
      if (o.create instanceof Error) throw o.create;
      existing.add(NAME); existing.add(CONTAINER_ID);
      if (o.create === "error-after-creating") throw new Error("create timed out"); // daemon made it, CLI never returned the id
      expect(args[0]).toBe("create");
      expect(createArgvProblem(args, imageRef)).toBeNull();
      return CONTAINER_ID;
    },
    async inspect(id) {
      calls.push(`inspect:${id === CONTAINER_ID ? "id" : id}`);
      if (o.inspect instanceof Error) throw o.inspect;
      const created = o.inspect ?? compliantInspect();
      return started ? (o.inspectAfterStart ?? finishedInspect(created)) : created;
    },
    async start(id, timeoutMs, maxOutputBytes) {
      calls.push(`start:${id === CONTAINER_ID ? "id" : id}`);
      started = true;
      o.onStart?.();
      lastStart = { id, timeoutMs, maxOutputBytes };
      if (o.start instanceof Error) throw o.start;
      return o.start ?? okStart;
    },
    async remove(ref) {
      calls.push(`remove:${ref === CONTAINER_ID ? "id" : ref}`);
      if (removeFailures > 0) { removeFailures -= 1; throw new Error("daemon busy"); }
      if (!o.removeLeavesContainer) { existing.delete(NAME); existing.delete(CONTAINER_ID); }
    },
    async exists(ref) {
      calls.push(`exists:${ref === CONTAINER_ID ? "id" : ref}`);
      if (o.existsThrows) throw new Error("ps failed");
      return existing.has(ref);
    },
  };
  return { engine, calls, existing, lastStart: () => lastStart };
}

const run = (engine: ContainerEngine, extra: Record<string, unknown> = {}) =>
  runPreflight({ engine, spec: SPEC, run: RUN, hostCanaryPath: HOST_CANARY, hostFs: fakeHostFs(compliantHostLayout()), hostPolicy: POLICY, ...extra } as any);

const expectRefused = (r: PreflightResult, message: string) => {
  expect(r.rating).toBe("refused");
  expect(r.allowsUntrustedInput).toBe(false);
  expect(r.binding).toBeNull();
  expect(r.violations.join("\n")).toContain(message);
  expect(() => assertUntrustedInputAllowed(r, { spec: SPEC, run: RUN })).toThrow(IsolationRefusedError);
};

describe("success paths and ratings", () => {
  it("Docker + runsc with every check passing: still refused, because meets-spec is blocked (M1, M3)", async () => {
    const f = fakeEngine();
    const r = await run(f.engine);
    expect(r).toMatchObject({ rating: "refused", allowsUntrustedInput: false, runtime: "runsc", binding: null, hostTrust: "operator-attested-only" });
    expect(r.violations).toEqual(MEETS_SPEC_BLOCKERS);
    expect(f.calls).toEqual(["info", `exists:${NAME}`, "create", "info", "inspect:id", "start:id", "inspect:id", "remove:id", `exists:${NAME}`, "exists:id", "info"]);
    expect(r.steps).toEqual(["spec", "paths", "host-paths", "engine-target", "engine-info", "engine-version", "runtime-binary-verified", "create", "runtime-config-rechecked-after-create",
      "inspect", "host-paths-recheck", "container-host-files", "canary", "inspect-after-canary", "container-host-files-after-canary", "removed-verified", "runtime-config-rechecked-after-canary", "runtime-binary-rechecked", "gvisor-verified", "meets-spec-blocked"]);
    expect(r.cleanup).toEqual({ containerName: NAME, containerId: CONTAINER_ID, attempts: 1, verifiedRemoved: true, detail: "removed and verified" });
    expect(f.lastStart()).toEqual({ id: CONTAINER_ID, timeoutMs: 60_000, maxOutputBytes: 65_536 });
    expect(f.existing.size).toBe(0);
    expect(() => assertUntrustedInputAllowed(r, { spec: SPEC, run: RUN })).toThrow(IsolationRefusedError);
  });

  it("the blockers are frozen and name M1 and M3; even a perfectly shaped result is refused while they exist", () => {
    expect(Object.isFrozen(MEETS_SPEC_BLOCKERS)).toBe(true);
    expect(() => (MEETS_SPEC_BLOCKERS as string[]).pop()).toThrow();
    expect(MEETS_SPEC_BLOCKERS.map((b) => b.slice(0, 3))).toEqual(["M1:", "M3:"]);
    expect(refusalReasons(wouldBePassing())).toEqual(MEETS_SPEC_BLOCKERS);
  });

  it("the canary timeout never exceeds the spec timeout", async () => {
    const f = fakeEngine();
    await runPreflight({ engine: f.engine, spec: resolveSpec({ timeoutMs: 5_000 }, SPEC), run: RUN, hostCanaryPath: HOST_CANARY, hostFs: fakeHostFs(compliantHostLayout()), hostPolicy: POLICY });
    expect(f.lastStart()!.timeoutMs).toBe(5_000);
  });

  it.each([
    ["rootful Docker + runc", { ...DOCKER_INFO, runtimes: ["runc"] }, "runc"],
    ["rootless Docker + runc (not approved as meets-spec)", { ...DOCKER_INFO, rootless: true, runtimes: ["runc"] }, "runc"],
    ["Docker + crun", { ...DOCKER_INFO, runtimes: ["crun"] }, "crun"],
  ])("%s: development-only, untrusted input refused", async (_label, info, runtime) => {
    const f = fakeEngine({ info: info as EngineInfo, inspect: compliantInspect(runtime) });
    const r = await run(f.engine);
    expect(r).toMatchObject({ rating: "development-only", allowsUntrustedInput: false, runtime });
    expect(() => assertUntrustedInputAllowed(r, { spec: SPEC, run: RUN })).toThrow("rating is development-only");
  });

  it("rate(): the approved configuration is refused while blocked; everything else is development-only", () => {
    // v4 review: a direct call fails closed while M1/M3 are unresolved; it can never return meets-spec.
    expect(rate(DOCKER_INFO, "runsc", SPEC, true)).toBe("refused");
    expect(rate(DOCKER_INFO, "runsc", SPEC, true)).not.toBe("meets-spec");
    expect(rate(DOCKER_INFO, "runsc", SPEC, false)).toBe("development-only"); // the name alone is not enough
    expect(rate({ ...DOCKER_INFO, seccompProfile: "/etc/docker/permissive.json" }, "runsc", SPEC, true)).toBe("development-only");
    expect(rate({ ...DOCKER_INFO, seccompProfile: null }, "runsc", SPEC, true)).toBe("development-only");
    expect(rate({ ...DOCKER_INFO, rootless: true }, "runc", SPEC, true)).toBe("development-only");
    expect(rate({ ...DOCKER_INFO, engine: "podman" }, "runsc", SPEC, true)).toBe("development-only");
    expect(chooseRuntime(DOCKER_INFO, SPEC)).toBe("runsc");
    expect(chooseRuntime({ ...DOCKER_INFO, runtimes: ["kata"] }, SPEC)).toBeNull();
  });
});

describe("refusals before any container exists", () => {
  it("H1: an unpinned or unsafe engine target refuses before ANY engine call", async () => {
    const noTarget = fakeEngine();
    (noTarget.engine as any).target = null;
    expectRefused(await run(noTarget.engine), "engine target: not pinned");
    expect(noTarget.calls).toEqual([]);
    const otherDaemon = fakeEngine();
    (otherDaemon.engine as any).target = { ...ENGINE_TARGET, host: "unix:///run/user/1000/docker.sock" };
    expectRefused(await run(otherDaemon.engine), "host must be unix:///var/run/docker.sock");
    expect(otherDaemon.calls).toEqual([]);
    const layout = compliantHostLayout();
    layout[DOCKER_CONFIG_DIR].entries = ["config.json"]; // e.g. a saved context
    const dirty = fakeEngine();
    const r = await run(dirty.engine, { hostFs: fakeHostFs(layout) });
    expectRefused(r, "must be empty");
    expect(r.steps).toContain("engine-target");
    expect(dirty.calls).toEqual([]);
  });

  it("unpinned digest/entrypoint (D3): no host or engine access", async () => {
    const f = fakeEngine();
    const hostFs = fakeHostFs(compliantHostLayout());
    expectRefused(await runPreflight({ engine: f.engine, spec: SANDBOX_SPEC, run: RUN, hostCanaryPath: HOST_CANARY, hostFs, hostPolicy: POLICY }), "not pinned");
    expect(f.calls).toEqual([]);
    expect(hostFs.calls).toEqual({});
  });

  it("paths outside the exact layout, or a canary path inside the runs root: no engine access", async () => {
    const f = fakeEngine();
    expectRefused(await run(f.engine, { run: { ...RUN, inputDir: "/home/user" } }), "must be exactly");
    expectRefused(await run(f.engine, { hostCanaryPath: "/srv/research-runs/r1/in/canary" }), "outside the runs root");
    expectRefused(await run(f.engine, { hostCanaryPath: "relative" }), "hostCanaryPath");
    expect(f.calls).toEqual([]);
  });

  it("unsafe host folders (e.g. a symlink): no engine access", async () => {
    const f = fakeEngine();
    const layout = compliantHostLayout();
    layout["/srv/research-runs/r1/out"].kind = "symlink";
    expectRefused(await run(f.engine, { hostFs: fakeHostFs(layout) }), "symbolic link");
    expect(f.calls).toEqual([]);
  });

  it("Podman of any kind is refused (formats not verified), nothing created", async () => {
    for (const info of [{ engine: "podman", rootless: true, runtimes: ["crun"], seccompProfile: null }, { engine: "podman", rootless: true, runtimes: ["runsc"], seccompProfile: null }]) {
      const f = fakeEngine({ info: info as EngineInfo });
      expectRefused(await run(f.engine), "Podman is not supported yet");
      expect(f.calls).toEqual(["info"]);
    }
  });

  it("engine unavailable, no allowed runtime, a leftover container, or an unverifiable leftover check: nothing created", async () => {
    const cases: Array<[FakeOptions, string]> = [
      [{ info: new Error("daemon not running") }, "engine info failed"],
      [{ info: { ...DOCKER_INFO, runtimes: ["kata"] } }, "no runtime"],
      [{ leftover: true }, "already exists"],
      [{ existsThrows: true }, "could not check for a leftover container"],
    ];
    for (const [o, message] of cases) {
      const f = fakeEngine(o);
      expectRefused(await run(f.engine), message);
      expect(f.calls).not.toContain("create");
    }
  });
});

describe("refusals after create: never started when inspection fails; cleanup always verified", () => {
  it("an inspect violation: removed WITHOUT being started", async () => {
    const bad = compliantInspect();
    bad[0].HostConfig.NetworkMode = "bridge";
    const f = fakeEngine({ inspect: bad });
    const r = await run(f.engine);
    expectRefused(r, "NetworkMode");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
    expect(r.cleanup?.verifiedRemoved).toBe(true);
  });

  it("inspect throwing: removed, not started", async () => {
    const f = fakeEngine({ inspect: new Error("inspect failed") });
    expectRefused(await run(f.engine), "preflight error: inspect failed");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
    expect(f.calls).toContain("remove:id");
  });

  it("inspect reporting a different container id or runtime: refused, not started", async () => {
    const otherId = compliantInspect();
    otherId[0].Id = "f".repeat(64);
    for (const [k, f] of [["HostsPath", "hosts"], ["HostnamePath", "hostname"], ["ResolvConfPath", "resolv.conf"]]) otherId[0][k] = `/var/lib/docker/containers/${"f".repeat(64)}/${f}`;
    expectRefused(await run(fakeEngine({ inspect: otherId }).engine), "container id differs");
    const f = fakeEngine({ inspect: compliantInspect("runc") }); // requested runsc
    expectRefused(await run(f.engine), "differs from requested runsc");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
  });

  it("a host folder swapped between the checks and creation: refused, not started", async () => {
    const layout = compliantHostLayout();
    const hostFs = fakeHostFs(layout);
    const original = hostFs.lstat.bind(hostFs);
    hostFs.lstat = (p: string) => {
      const st = original(p);
      return p === RUN.inputDir && hostFs.calls[p] > 1 ? { ...st, ino: 999, isSymbolicLink: st.isSymbolicLink, isDirectory: st.isDirectory } : st;
    };
    const f = fakeEngine();
    expectRefused(await run(f.engine, { hostFs }), "changed identity");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
  });

  it.each([
    ["timeout", { exitCode: -1, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true, truncated: false }, "timed out"],
    ["oversized output", { exitCode: -1, signal: "SIGKILL", stdout: "x", stderr: "", timedOut: false, truncated: true }, "exceeded the cap"],
    ["non-zero exit", { exitCode: 137, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false }, "exited with 137"],
    ["killed by a signal", { exitCode: -1, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, truncated: false }, "(SIGTERM)"],
    ["non-JSON output", { exitCode: 0, signal: null, stdout: "not json", stderr: "", timedOut: false, truncated: false }, "not JSON"],
    // V2.3: the VPS failure (the probe printed nothing and exited 0) is reported with byte counts, never content.
    ["empty output (the V2.2 VPS failure)", { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false }, "canary: output is not JSON (stdout 0 bytes, stderr 0 bytes)"],
    ["non-JSON output with stderr", { exitCode: 0, signal: null, stdout: "x", stderr: "secret-ish text", timedOut: false, truncated: false }, "canary: output is not JSON (stdout 1 bytes, stderr 15 bytes)"],
    ["a failing canary", { ...okStart, stdout: JSON.stringify({ ...compliantReport(), interfaces: ["lo", "eth0"] }) }, "exactly one interface"],
  ])("canary %s: refused, container force-removed and removal verified", async (_label, start, message) => {
    const f = fakeEngine({ start: start as ProcessResult });
    const r = await run(f.engine);
    expectRefused(r, message);
    expect(r.cleanup).toMatchObject({ verifiedRemoved: true, containerId: CONTAINER_ID });
    expect(f.existing.size).toBe(0);
  });

  it("start throwing: refused, removed", async () => {
    const f = fakeEngine({ start: new Error("attach failed") });
    expectRefused(await run(f.engine), "attach failed");
    expect(f.calls).toContain("remove:id");
  });

  it("create failing after the daemon made the container (id never returned): cleaned up by name and verified", async () => {
    const f = fakeEngine({ create: "error-after-creating" });
    const r = await run(f.engine);
    expectRefused(r, "create timed out");
    expect(f.calls).toContain(`remove:${NAME}`);
    expect(r.cleanup).toMatchObject({ containerId: null, containerName: NAME, verifiedRemoved: true });
    expect(f.existing.size).toBe(0);
  });

  it("create failing with nothing created: cleanup confirms there is nothing to remove", async () => {
    const f = fakeEngine({ create: new Error("no such image") });
    const r = await run(f.engine);
    expectRefused(r, "no such image");
    expect(f.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    expect(r.cleanup?.verifiedRemoved).toBe(true);
  });

  it("transient removal failures are retried within the bound", async () => {
    const f = fakeEngine({ removeFailures: CLEANUP_ATTEMPTS - 1 });
    const r = await run(f.engine);
    expect(r.steps).toContain("removed-verified");
    expect(r.cleanup).toMatchObject({ attempts: CLEANUP_ATTEMPTS, verifiedRemoved: true });
  });

  it.each([
    ["removal always failing", { removeFailures: 99 }, "daemon busy"],
    ["removal reporting success but the container remaining", { removeLeavesContainer: true }, "still exists"],
  ])("%s: a passing preflight becomes a refusal naming the container", async (_label, o, message) => {
    const f = fakeEngine(o);
    const r = await run(f.engine);
    expectRefused(r, message);
    expect(r.violations.join()).toContain(`container ${CONTAINER_ID}; manual cleanup required`);
    expect(r.cleanup).toMatchObject({ verifiedRemoved: false, attempts: CLEANUP_ATTEMPTS });
    expect(r.steps).toContain("remove-unverified");
  });
});

describe("binding: results can't be reused for another run or configuration (checked in addition to the blockers)", () => {
  const extra = (r: PreflightResult, spec = SPEC, run_ = RUN) => refusalReasons(r, spec, run_).filter((x) => !MEETS_SPEC_BLOCKERS.includes(x)).join("\n");

  it("matches only the intended run, folders, image, runtime and security arguments", () => {
    const r = wouldBePassing();
    expect(extra(r)).toBe("");
    expect(extra(r, SPEC, { runId: "r2", ...expectedRunPaths(SPEC, "r2") })).toContain("different run or folders");
    const otherImage = resolveSpec({ dockerServerVersion: FAKE_DOCKER_SERVER_VERSION, imageId: `sha256:${"9f".repeat(32)}`, imageDigest: `sha256:${"cd".repeat(32)}`, imageEntrypoint: ["docker-entrypoint.sh"], gvisorProcVersion: SPEC.gvisorProcVersion! });
    expect(extra(r, otherImage)).toContain("different image");
    expect(extra(r, resolveSpec({ pidsLimit: 32 }, SPEC))).toContain("different security arguments");
  });

  it("rejects tampered or hand-built results", () => {
    const r = wouldBePassing();
    const tamper = (patch: Record<string, unknown>) => ({ ...r, ...patch }) as PreflightResult;
    expect(extra(tamper({ binding: { ...r.binding!, securityArgsSha256: "0".repeat(64) } }))).toContain("different security arguments");
    expect(extra(tamper({ binding: { ...r.binding!, runtime: "runc" }, runtime: "runc" }))).toContain("not an approved isolating runtime");
    expect(extra(tamper({ binding: { ...r.binding!, runId: "r2" } }))).toContain("different run or folders");
    expect(extra(tamper({ binding: { ...r.binding!, dockerServerVersion: "0.0.1-fake.test" } }))).toContain("not verified against the recorded Docker server version");
    expect(extra(tamper({ steps: r.steps.filter((x) => x !== "engine-version") }))).toContain("Docker server version was not verified");
    expect(extra(tamper({ binding: { ...r.binding!, outputDir: "/srv/research-runs/r2/out" } }))).toContain("different run or folders");
    expect(extra(tamper({ cleanup: { ...r.cleanup!, verifiedRemoved: false } }))).toContain("cleanup was not verified");
    expect(extra(tamper({ binding: null }))).toContain("not bound to a run");
    expect(extra(tamper({ rating: "development-only", allowsUntrustedInput: false }))).toContain("rating is development-only");
    expect(() => assertUntrustedInputAllowed(null as any, { spec: SPEC, run: RUN })).toThrow("no preflight result");
  });
});

describe("v4 review: rate() never returns meets-spec while M1/M3 are unresolved", () => {
  it("no combination of inputs to a direct call yields meets-spec", () => {
    const infos = [DOCKER_INFO, { ...DOCKER_INFO, rootless: true }, { ...DOCKER_INFO, seccompProfile: null }, { ...DOCKER_INFO, engine: "podman" as const }];
    for (const info of infos) for (const runtime of ["runsc", "runc", "crun", "kata"]) for (const verified of [true, false]) {
      expect(rate(info as EngineInfo, runtime, SPEC, verified), `${info.engine}/${runtime}/${verified}`).not.toBe("meets-spec");
    }
  });
});

describe("acceptance finding 1: a runtime NAMED runsc is not evidence of gVisor", () => {
  const withReport = (patch: Record<string, unknown>) =>
    fakeEngine({ start: { ...okStart, stdout: JSON.stringify({ ...compliantReport(), ...patch }) } });
  const expectGvisorRefused = (r: PreflightResult, message: string) => {
    expectRefused(r, message);
    expect(r.rating).toBe("refused"); // not development-only: a misnamed runtime is a misconfiguration
    expect(r.steps).toContain("gvisor-unverified");
    expect(r.cleanup?.verifiedRemoved).toBe(true);
  };

  it("runsc that is really a shared-kernel runtime (container sees the host kernel): refused", async () => {
    expectGvisorRefused(await run(withReport({ procVersion: HOST_PROC_VERSION }).engine), "sees the host kernel");
  });

  it("a non-host kernel that doesn't match the recorded gVisor reference: refused", async () => {
    expectGvisorRefused(await run(withReport({ procVersion: "Linux version 5.15.0-other #1 SMP" }).engine), "does not match the recorded gVisor reference");
  });

  it("no recorded gVisor reference: refused even when every other check passes", async () => {
    const unrecorded = resolveSpec({ dockerServerVersion: FAKE_DOCKER_SERVER_VERSION, imageId: FAKE_IMAGE_ID, imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST, dockerDataRoot: FAKE_DATA_ROOT, runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"] } });
    expect(unrecorded.gvisorProcVersion).toBeNull();
    const r = await run(fakeEngine().engine, { spec: unrecorded });
    expectGvisorRefused(r, "no reference /proc/version has been recorded");
    expect(() => assertUntrustedInputAllowed(r, { spec: unrecorded, run: RUN })).toThrow(IsolationRefusedError);
  });

  it("a recorded reference equal to the host's own kernel still refuses (host kernel is never gVisor)", async () => {
    const wrongReference = resolveSpec({ dockerServerVersion: FAKE_DOCKER_SERVER_VERSION, imageId: FAKE_IMAGE_ID, imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, gvisorProcVersion: HOST_PROC_VERSION, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST, dockerDataRoot: FAKE_DATA_ROOT, runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"] } });
    const r = await run(withReport({ procVersion: HOST_PROC_VERSION }).engine, { spec: wrongReference });
    expectGvisorRefused(r, "sees the host kernel");
  });

  it.each([
    ["unreadable", () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }],
    ["empty", () => ""],
    ["malformed", () => "not a kernel version"],
  ])("host /proc/version %s (read by the preflight itself): refused", async (_label, read) => {
    hostProcVersion = read as () => string;
    expectGvisorRefused(await run(fakeEngine().engine), "host /proc/version is missing or malformed");
  });

  it("caller-supplied host kernel evidence is ignored: the preflight reads /proc/version itself", async () => {
    const spy = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;
    // A caller claiming a different host kernel can't make the host-kernel container pass.
    const r = await run(withReport({ procVersion: HOST_PROC_VERSION }).engine, { hostProcVersion: "Linux version 1.0 forged" });
    expect(r.violations.join()).toContain("sees the host kernel");
    expect(spy.mock.calls.some((c: unknown[]) => c[0] === "/proc/version")).toBe(true);
  });

  it("the canary's /proc/version observation missing or overlong: refused by the canary evaluation", async () => {
    expectRefused(await run(withReport({ procVersion: undefined }).engine), "kernel: /proc/version must be observed");
    expectRefused(await run(withReport({ procVersion: `Linux version ${"x".repeat(600)}` }).engine), "kernel: /proc/version must be observed");
  });

  it("the untrusted-input gate requires the gvisor-verified step and the same recorded reference", () => {
    const r = wouldBePassing();
    const noStep = { ...r, steps: r.steps.filter((x) => x !== "gvisor-verified") } as PreflightResult;
    expect(refusalReasons(noStep)).toContain("gVisor was not positively verified");
    const otherReference = resolveSpec({ dockerServerVersion: FAKE_DOCKER_SERVER_VERSION, imageId: FAKE_IMAGE_ID, imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, gvisorProcVersion: "Linux version 4.4.0 #2 other" });
    expect(refusalReasons(r, otherReference)).toContain("result was not verified against the recorded gVisor reference");
    const unrecorded = resolveSpec({ dockerServerVersion: FAKE_DOCKER_SERVER_VERSION, imageId: FAKE_IMAGE_ID, imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST, dockerDataRoot: FAKE_DATA_ROOT, runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"] } });
    expect(refusalReasons(r, unrecorded)).toContain("result was not verified against the recorded gVisor reference");
  });

  it("development runtimes skip the gVisor check and stay development-only", async () => {
    const r = await run(fakeEngine({ info: { ...DOCKER_INFO, runtimes: ["runc"] }, inspect: compliantInspect("runc"),
      start: { ...okStart, stdout: JSON.stringify({ ...compliantReport(), procVersion: HOST_PROC_VERSION }) } }).engine);
    expect(r).toMatchObject({ rating: "development-only", allowsUntrustedInput: false });
    expect(r.steps).not.toContain("gvisor-verified");
  });
});

describe("acceptance finding 2: only Docker's built-in default seccomp profile is accepted", () => {
  it.each([
    ["not reported", null],
    ["unconfined", "unconfined"],
    ["a custom (possibly permissive) daemon profile", "/etc/docker/seccomp-permissive.json"],
    ["the legacy, unverifiable 'default' label", "default"],
  ])("daemon seccomp profile %s: refused before anything is created", async (_label, seccompProfile) => {
    const f = fakeEngine({ info: { ...DOCKER_INFO, seccompProfile } });
    expectRefused(await run(f.engine), "seccomp: the daemon must report the built-in default profile");
    expect(f.calls).toEqual(["info"]);
  });

  it("seccomp active in the canary but a custom daemon profile: still refused", async () => {
    const f = fakeEngine({ info: { ...DOCKER_INFO, seccompProfile: "/etc/docker/custom.json" } });
    const r = await run(f.engine);
    expectRefused(r, "built-in default profile");
    expect(compliantReport().seccompMode).toBe(2);
  });

  it.each([
    ["seccomp=unconfined", "seccomp=unconfined"],
    ["a per-container custom profile", `seccomp=${JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW" })}`],
  ])("container SecurityOpt with %s: refused, never started", async (_label, opt) => {
    const bad = compliantInspect();
    bad[0].HostConfig.SecurityOpt.push(opt);
    const f = fakeEngine({ inspect: bad });
    expectRefused(await run(f.engine), "HostConfig.SecurityOpt");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
  });

  it("no seccomp filter in the canary (mode 0) with the built-in daemon profile: refused", async () => {
    const f = fakeEngine({ start: { ...okStart, stdout: JSON.stringify({ ...compliantReport(), seccompMode: 0 }) } });
    expectRefused(await run(f.engine), "seccomp: a filter must be active");
  });
});

describe("M1 at the preflight level", () => {
  it("no approved runtime binary recorded: refused before anything is created (not downgraded)", async () => {
    const noBinary = resolveSpec({ dockerServerVersion: FAKE_DOCKER_SERVER_VERSION, imageId: FAKE_IMAGE_ID, imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST,
      dockerDataRoot: FAKE_DATA_ROOT, gvisorProcVersion: SPEC.gvisorProcVersion! });
    const f = fakeEngine();
    const r = await run(f.engine, { spec: noBinary });
    expectRefused(r, "no approved runsc binary");
    expect(r.rating).toBe("refused");
    expect(r.steps).toContain("runtime-binary-unverified");
    expect(f.calls).toEqual(["info"]);
  });

  it("docker info pointing runsc at another binary: refused before create", async () => {
    const f = fakeEngine({ info: { ...DOCKER_INFO, runtimeConfigs: { runc: { path: "runc" }, runsc: { path: "/usr/bin/runc" } } } });
    expectRefused(await run(f.engine), "must configure runsc with path /usr/local/bin/runsc");
    expect(f.calls).not.toContain("create");
  });

  it("a tampered binary (hash mismatch): refused before create", async () => {
    const layout = compliantHostLayout();
    layout["/usr/local/bin/runsc"].sha256 = "00".repeat(32);
    const f = fakeEngine();
    expectRefused(await run(f.engine, { hostFs: fakeHostFs(layout) }), "SHA-256 does not match");
    expect(f.calls).not.toContain("create");
  });

  it("the binary replaced while the canary ran: refused after cleanup, with removal verified", async () => {
    const layout = compliantHostLayout();
    const hostFs = fakeHostFs(layout);
    const f = fakeEngine();
    const start = f.engine.start.bind(f.engine);
    f.engine.start = async (...a) => { layout["/usr/local/bin/runsc"].ino = 777; return start(...a); }; // swapped during the run
    const r = await run(f.engine, { hostFs });
    expectRefused(r, "changed between the check before create and the re-check after the canary");
    expect(r.steps).toContain("runtime-binary-changed");
    expect(r.cleanup?.verifiedRemoved).toBe(true);
  });

  it("development runtimes don't need the gVisor binary and stay development-only", async () => {
    const r = await run(fakeEngine({ info: { ...DOCKER_INFO, runtimes: ["runc"] }, inspect: compliantInspect("runc"),
      start: { ...okStart, stdout: JSON.stringify({ ...compliantReport(), procVersion: HOST_PROC_VERSION }) } }).engine);
    expect(r).toMatchObject({ rating: "development-only", allowsUntrustedInput: false });
    expect(r.steps).not.toContain("runtime-binary-verified");
  });

  it("the untrusted-input gate requires both binary checks and the recorded hash (in addition to the blockers)", () => {
    const r = wouldBePassing();
    expect(refusalReasons({ ...r, steps: r.steps.filter((x) => x !== "runtime-binary-rechecked") } as PreflightResult))
      .toContain("the runtime binary was not verified before create and re-verified after the canary");
    expect(refusalReasons({ ...r, binding: { ...r.binding!, runtimeBinarySha256: "00".repeat(32) } } as PreflightResult))
      .toContain("result was not verified against the recorded runtime binary");
    expect(refusalReasons(r)).toEqual(MEETS_SPEC_BLOCKERS); // blockers still refuse a perfect result
  });
});

describe("C2: docker info re-read after create and after the canary", () => {
  const withRunsc = (runsc: unknown, extra: Record<string, unknown> = {}) => ({ ...DOCKER_INFO, ...extra, runtimeConfigs: { runc: { path: "runc" }, runsc } }) as EngineInfo;

  it.each([
    ["runsc repointed to another binary", withRunsc({ path: "/usr/bin/runc" }), "must configure runsc with path"],
    ["a runtime flag added", withRunsc({ path: "/usr/local/bin/runsc", runtimeArgs: ["--network=host"] }), "runtimeArgs must be exactly"],
    ["switched to the shim form", withRunsc({ runtimeType: "io.containerd.runsc.v1" }), "unsupported runtime configuration key(s) runtimeType"],
    ["status changed", withRunsc({ path: "/usr/local/bin/runsc", runtimeArgs: ["--oci-seccomp"], status: { note: "reloaded" } }), "changed since it was verified before create"],
    ["runsc no longer offered", { ...DOCKER_INFO, runtimes: ["runc"] } as EngineInfo, "no longer reports the runsc runtime"],
    ["malformed info", { engine: "docker" } as unknown as EngineInfo, "no longer reports the runsc runtime"],
    ["docker info failing", new Error("daemon restarting"), "docker info failed: daemon restarting"],
  ])("after create, %s: refused; never inspected or started; cleanup verified", async (_label, fresh, message) => {
    const f = fakeEngine({ infoSequence: [DOCKER_INFO, fresh as EngineInfo | Error] });
    const r = await run(f.engine);
    expectRefused(r, `runtime configuration (after create): `);
    expect(r.violations.join()).toContain(message);
    expect(r.steps).not.toContain("runtime-config-rechecked-after-create");
    expect(f.calls.some((c) => c.startsWith("inspect") || c.startsWith("start"))).toBe(false);
    expect(r.cleanup?.verifiedRemoved).toBe(true);
  });

  it.each([
    ["runsc repointed to another binary", withRunsc({ path: "/usr/bin/runc" }), "must configure runsc with path"],
    ["status changed", withRunsc({ path: "/usr/local/bin/runsc", runtimeArgs: ["--oci-seccomp"], status: { note: "reloaded" } }), "changed since it was verified before create"],
    ["docker info failing", new Error("daemon restarting"), "docker info failed"],
  ])("after the canary, %s: refused after cleanup", async (_label, fresh, message) => {
    const f = fakeEngine({ infoSequence: [DOCKER_INFO, DOCKER_INFO, fresh as EngineInfo | Error] });
    const r = await run(f.engine);
    expectRefused(r, "runtime configuration (after the canary): ");
    expect(r.violations.join()).toContain(message);
    expect(r.steps).toContain("runtime-config-changed");
    expect(r.steps).not.toContain("runtime-binary-rechecked");
    expect(r.cleanup?.verifiedRemoved).toBe(true);
  });

  it("an identical configuration with keys in another order is not a change (canonical comparison)", async () => {
    const reordered = withRunsc(JSON.parse('{"status":{"b":"2","a":"1"},"runtimeArgs":["--oci-seccomp"],"path":"/usr/local/bin/runsc"}'));
    const original = withRunsc({ path: "/usr/local/bin/runsc", runtimeArgs: ["--oci-seccomp"], status: { a: "1", b: "2" } });
    const r = await run(fakeEngine({ infoSequence: [original, reordered, reordered] }).engine);
    expect(r.steps).toEqual(expect.arrayContaining(["runtime-config-rechecked-after-create", "runtime-config-rechecked-after-canary"]));
    expect(r.violations).toEqual(MEETS_SPEC_BLOCKERS); // still blocked
  });

  it("development runtimes are not re-read (no isolating runtime configuration to protect)", async () => {
    const f = fakeEngine({ info: { ...DOCKER_INFO, runtimes: ["runc"] }, inspect: compliantInspect("runc"),
      start: { ...okStart, stdout: JSON.stringify({ ...compliantReport(), procVersion: HOST_PROC_VERSION }) } });
    const r = await run(f.engine);
    expect(r.rating).toBe("development-only");
    expect(f.calls.filter((c) => c === "info")).toHaveLength(1);
  });

  it("the untrusted-input gate requires both configuration re-reads (in addition to the blockers)", () => {
    const r = wouldBePassing();
    for (const step of ["runtime-config-rechecked-after-create", "runtime-config-rechecked-after-canary"]) {
      expect(refusalReasons({ ...r, steps: r.steps.filter((x) => x !== step) } as PreflightResult))
        .toContain("the runtime configuration was not re-read after create and after the canary");
    }
    expect(refusalReasons(r)).toEqual(MEETS_SPEC_BLOCKERS);
  });
});

describe("v5 review finding 1 at the preflight level", () => {
  it("unsafe host files behind /etc/hosts: refused after inspect, never started, cleanup verified", async () => {
    const layout = compliantHostLayout();
    layout[`/var/lib/docker/containers/${CONTAINER_ID}/hosts`].kind = "symlink";
    const f = fakeEngine();
    const r = await run(f.engine, { hostFs: fakeHostFs(layout) });
    expectRefused(r, "is a symbolic link");
    expect(r.steps).toContain("container-host-files");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
    expect(r.cleanup?.verifiedRemoved).toBe(true);
  });

  it("no recorded Docker data root: refused at inspect, never started", async () => {
    const noRoot = resolveSpec({ dockerServerVersion: FAKE_DOCKER_SERVER_VERSION, imageId: FAKE_IMAGE_ID, imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST, gvisorProcVersion: SPEC.gvisorProcVersion!, runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"] } });
    const f = fakeEngine();
    expectRefused(await run(f.engine, { spec: noRoot }), "dockerDataRoot is not recorded");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
  });

  it("a canary showing /etc/hosts mounted read-write: refused", async () => {
    const report = compliantReport();
    report.etcMounts["/etc/hosts"] = ["rw,relatime"];
    const f = fakeEngine({ start: { ...okStart, stdout: JSON.stringify(report) } });
    expectRefused(await run(f.engine), "/etc/hosts must be mounted exactly once and read-only");
  });
});

describe("acceptance findings 3 and 4 at the preflight level", () => {
  it("an omitted required inspect field (Init; absent would mean the daemon default): refused, never started", async () => {
    const bad = compliantInspect();
    delete bad[0].HostConfig.Init;
    const f = fakeEngine({ inspect: bad });
    expectRefused(await run(f.engine), "HostConfig.Init: missing");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
  });

  it("create is always called with --pull never (asserted by the fake engine on every create)", async () => {
    const seen: string[][] = [];
    const f = fakeEngine();
    const create = f.engine.create.bind(f.engine);
    f.engine.create = async (args) => { seen.push([...args]); return create(args); };
    await run(f.engine);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("never");
    expect(seen[0][seen[0].indexOf("--pull") + 1]).toBe("never");
  });
});

describe("Docker server version (M3 groundwork): recorded pin, daemon-reported ServerVersion only", () => {
  const unpinned = () => resolveSpec({
    imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, gvisorProcVersion: SPEC.gvisorProcVersion!, imageEnv: FAKE_IMAGE_ENV,
    imageManifestDigest: FAKE_MANIFEST_DIGEST, dockerDataRoot: FAKE_DATA_ROOT, runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"] }, imageId: FAKE_IMAGE_ID,
  });

  it("the shipped specification records no version, so every preflight refuses (no version is chosen in code)", async () => {
    expect(SANDBOX_SPEC.dockerServerVersion).toBeNull();
    const f = fakeEngine();
    const r = await run(f.engine, { spec: unpinned() });
    expectRefused(r, "Docker server version: no approved version has been recorded for this host");
    expect(r.steps[r.steps.length - 1]).toBe("engine-version");
    expect(f.calls).toEqual(["info"]); // refused before any container is created
  });

  it("refuses a missing or malformed daemon-reported version before anything is created", async () => {
    for (const serverVersion of [null, undefined, 27, "", "27.3", "v27.3.1", "27.3.1\n", "27.3.1; rm -rf /", "27.3.1 ", "x".repeat(80)]) {
      const f = fakeEngine({ info: { ...DOCKER_INFO, serverVersion } as any });
      const r = await run(f.engine);
      expectRefused(r, "Docker server version: the daemon did not report a well-formed ServerVersion");
      expect(f.calls).toEqual(["info"]);
      expect(r.violations.join("").length).toBeLessThan(200); // the reported value is bounded in the message
    }
  });

  it("refuses a version that differs from the recorded pin", async () => {
    for (const serverVersion of ["0.0.1-fake.test", "0.0.0", "0.0.0-fake.other"]) {
      const f = fakeEngine({ info: { ...DOCKER_INFO, serverVersion } });
      const r = await run(f.engine);
      expectRefused(r, `Docker server version: the daemon reports ${serverVersion}; the approved version is ${FAKE_DOCKER_SERVER_VERSION}`);
      expect(f.calls).toEqual(["info"]);
    }
  });

  it("a matching version passes this step (the run then continues to the other checks)", async () => {
    const r = await run(fakeEngine().engine);
    expect(r.steps).toContain("engine-version");
    expect(r.steps.indexOf("engine-version")).toBe(r.steps.indexOf("engine-info") + 1);
    expect(serverVersionProblems(DOCKER_INFO, SPEC)).toEqual([]);
  });

  it("a daemon whose version changes after create (e.g. restarted or upgraded) refuses, and the canary is removed unstarted", async () => {
    const f = fakeEngine({ infoSequence: [DOCKER_INFO, { ...DOCKER_INFO, serverVersion: "0.0.1-fake.test" }] });
    const r = await run(f.engine);
    expectRefused(r, "runtime configuration (after create): Docker server version: the daemon reports 0.0.1-fake.test");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
    expect(r.cleanup?.verifiedRemoved).toBe(true);
  });

  it("rate() never treats a configuration with an unrecorded or different version as approved", () => {
    expect(rate({ ...DOCKER_INFO, serverVersion: "0.0.1-fake.test" }, "runsc", SPEC, true)).toBe("development-only");
    expect(rate(DOCKER_INFO, "runsc", unpinned(), true)).toBe("development-only");
  });
});

describe("V2.2: Docker 29.9.3 (containerd image store) at the preflight level", () => {
  /** Before the first start Docker 29 has not written the three host files; it writes them at start. */
  const docker29Host = () => {
    const layout = compliantHostLayout();
    const files = Object.fromEntries(CONTAINER_HOST_FILES.map((p) => [p, layout[p]]));
    for (const p of CONTAINER_HOST_FILES) delete layout[p];
    return { layout, hostFs: fakeHostFs(layout), writeFiles: () => Object.assign(layout, files) };
  };

  it("the Docker 29 format passes every check and is still refused only by M1/M3; host files verified after the canary", async () => {
    const h = docker29Host();
    const f = fakeEngine({ inspect: docker29Inspect(), onStart: h.writeFiles });
    const r = await run(f.engine, { hostFs: h.hostFs });
    expect(r.violations).toEqual(MEETS_SPEC_BLOCKERS);
    expect(r.rating).toBe("refused");
    expect(r.allowsUntrustedInput).toBe(false);
    expect(f.calls).toEqual(["info", `exists:${NAME}`, "create", "info", "inspect:id", "start:id", "inspect:id", "remove:id", `exists:${NAME}`, "exists:id", "info"]);
    expect(r.steps).toEqual(expect.arrayContaining(["container-host-files-pending", "canary", "inspect-after-canary", "container-host-files-after-canary", "removed-verified", "gvisor-verified", "meets-spec-blocked"]));
    expect(r.steps).not.toContain("container-host-files");
    expect(() => assertUntrustedInputAllowed(r, { spec: SPEC, run: RUN })).toThrow(IsolationRefusedError);
  });

  it("a host file that already exists before the first start: refused, never started, cleanup verified", async () => {
    const h = docker29Host();
    h.writeFiles();
    const f = fakeEngine({ inspect: docker29Inspect() });
    const r = await run(f.engine, { hostFs: h.hostFs });
    expectRefused(r, "already exists before the container's first start");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
    expect(r.steps).toContain("removed-verified");
  });

  it("the container folder unsafe before start (group-writable): refused, never started", async () => {
    const h = docker29Host();
    h.layout[`${FAKE_DATA_ROOT}/containers/${CONTAINER_ID}`] = { kind: "dir", uid: 0, mode: 0o40770, ino: 43 };
    const f = fakeEngine({ inspect: docker29Inspect() });
    expectRefused(await run(f.engine, { hostFs: h.hostFs }), "writable by group or others");
    expect(f.calls.some((c) => c.startsWith("start"))).toBe(false);
  });

  it.each([
    ["the paths still empty after the start", (c: any) => { c[0].HostsPath = ""; c[0].HostnamePath = ""; c[0].ResolvConfPath = ""; }, "inspect after the canary: HostsPath: must be"],
    ["a host-file path elsewhere", (c: any) => { c[0].ResolvConfPath = "/etc/resolv.conf"; }, "inspect after the canary: ResolvConfPath: must be"],
    ["another container id", (c: any) => { c[0].Id = "e".repeat(64); }, "inspect after the canary: Id: differs"],
    ["another runtime", (c: any) => { c[0].HostConfig.Runtime = "runc"; }, "inspect after the canary: HostConfig.Runtime: must be runsc"],
    ["another image", (c: any) => { c[0].Image = `sha256:${"d".repeat(64)}`; }, "inspect after the canary: Image: must be the recorded image ID"],
    ["still running", (c: any) => { c[0].State.Status = "running"; c[0].State.Running = true; c[0].State.Pid = 99; }, "inspect after the canary: State: must be exited with code 0"],
    ["OOM-killed", (c: any) => { c[0].State.OOMKilled = true; }, "inspect after the canary: State: must be exited"],
    ["restarted", (c: any) => { c[0].RestartCount = 1; }, "inspect after the canary: RestartCount: must be 0"],
    ["an exec session", (c: any) => { c[0].ExecIDs = ["x"]; }, "inspect after the canary: ExecIDs"],
  ])("after the canary, %s: refused after the canary, cleanup verified", async (_label, mutate, message) => {
    const h = docker29Host();
    const after = finishedInspect(docker29Inspect());
    mutate(after);
    const f = fakeEngine({ inspect: docker29Inspect(), onStart: h.writeFiles, inspectAfterStart: after });
    const r = await run(f.engine, { hostFs: h.hostFs });
    expectRefused(r, message);
    expect(r.steps).toContain("inspect-after-canary");
    expect(r.steps).toContain("removed-verified");
  });

  it.each([
    ["never written", (_l: Record<string, any>) => {}, "cannot be checked (ENOENT)"],
    ["a symbolic link", (l: Record<string, any>) => { l[CONTAINER_HOST_FILES[0]] = { kind: "symlink", uid: 0, mode: 0o120777, ino: 90 }; }, "is a symbolic link"],
    ["not root-owned", (l: Record<string, any>) => { l[CONTAINER_HOST_FILES[2]] = { kind: "file", uid: 1000, mode: 0o100644, ino: 91 }; }, "not root"],
    ["world-writable", (l: Record<string, any>) => { l[CONTAINER_HOST_FILES[1]] = { kind: "file", uid: 0, mode: 0o100666, ino: 92 }; }, "writable by group or others"],
  ])("host files after the canary %s: refused, cleanup verified", async (_label, mutate, message) => {
    const h = docker29Host();
    const onStart = () => { if (_label !== "never written") h.writeFiles(); mutate(h.layout); };
    const f = fakeEngine({ inspect: docker29Inspect(), onStart });
    const r = await run(f.engine, { hostFs: h.hostFs });
    expectRefused(r, message);
    expect(r.steps).toContain("container-host-files-after-canary");
    expect(r.steps).toContain("removed-verified");
  });

  it("the classic format (paths set before start) is still verified before start AND re-verified after the canary", async () => {
    const f = fakeEngine({});
    const r = await run(f.engine);
    expect(r.violations).toEqual(MEETS_SPEC_BLOCKERS);
    expect(r.steps).toEqual(expect.arrayContaining(["container-host-files", "inspect-after-canary", "container-host-files-after-canary"]));
  });

  it("the create argv passes --init=false exactly once (so HostConfig.Init is reported, never left to the daemon default)", () => {
    const args = buildCreateArgs(SPEC, RUN, "runsc", ["node"], "canary");
    expect(args.filter((a) => a === "--init=false")).toHaveLength(1);
    expect(args.some((a) => a === "--init" || a === "--init=true")).toBe(false);
    expect(args.indexOf("--init=false")).toBeLessThan(args.indexOf(imageReference(SPEC)));
  });
});

describe("V2.4: the gVisor canary report at the preflight level", () => {
  const gStart = (report: unknown): ProcessResult => ({ exitCode: 0, signal: null, stdout: JSON.stringify(report), stderr: "", timedOut: false, truncated: false });

  it("runsc with the gVisor-shaped report (after --oci-seccomp): refused only by M1/M3", async () => {
    const f = fakeEngine({ start: gStart(gvisorReport()) });
    const r = await run(f.engine);
    expect(r.violations).toEqual(MEETS_SPEC_BLOCKERS);
    expect(r.steps).toContain("gvisor-verified");
    expect(r.allowsUntrustedInput).toBe(false);
  });

  it("runsc with the report as observed on the VPS (seccomp 0): refused for seccomp", async () => {
    const r = await run(fakeEngine({ start: gStart({ ...gvisorReport(), seccompMode: 0 }) }).engine);
    expectRefused(r, "seccomp: a filter must be active (mode 2) (got 0)");
  });

  it("runc with the gVisor-shaped cgroup layout: refused (v1 and pids \"max\" are accepted only under the isolating runtime)", async () => {
    const r = await run(fakeEngine({ info: { ...DOCKER_INFO, runtimes: ["runc"] }, inspect: compliantInspect("runc"), start: gStart(gvisorReport()) }).engine);
    expectRefused(r, "limits: cgroup pids.max (v2) must be at most 64");
  });

  it("runsc registered without --oci-seccomp: refused before anything is created", async () => {
    const f = fakeEngine({ info: { ...DOCKER_INFO, runtimeConfigs: { runc: { path: "runc" }, runsc: { path: "/usr/local/bin/runsc" } } } });
    const r = await run(f.engine);
    expectRefused(r, 'runtimeArgs must be exactly ["--oci-seccomp"]');
    expect(f.calls).not.toContain("create");
  });
});
