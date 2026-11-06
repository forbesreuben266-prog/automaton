/**
 * E1: the sandbox executor, offline with fakes. The gate (assertUntrustedInputAllowed) refuses outside the accepted
 * M1/M3 decision scope (the fixtures' fake pins are outside it), so there the default path never creates a research
 * container; inside the scope the real preflight and gate are exercised end to end, and other post-gate paths are
 * reached by replacing the internals in these tests (the entry point never does; see the boundary checks at the end).
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXECUTOR_CONFIRM_FLAG, MAX_CONFIG_BYTES, ResearchJobError, checkJobInputs, parseResearchJob, researchCommand, runResearchJob, runResearchJobCommand, sanitizeReport,
  type ExecutorInternals, type ExecutorOptions, type ResearchJob,
} from "../../research-sandbox/executor.js";
import { RESEARCH_IMAGE_FILES, RESEARCH_IMAGE_LAYOUT, RESEARCH_SCRIPT } from "../../research-sandbox/research-image.js";
import {
  ACCEPTED_DECISION_SCOPE, MEETS_SPEC_BLOCKERS, assertUntrustedInputAllowed, buildCreateArgs, decisionScopeProblems, imageReference, resolveSpec, securityArgsHash,
  type ContainerEngine, type PreflightResult, type ProcessResult,
} from "../../research-sandbox/index.js";
import type { HostProcessObserver } from "../../research-sandbox/host-processes.js";
import {
  CONTAINER_ID, DOCKER_INFO, ENGINE_TARGET, FAKE_DATA_ROOT, FAKE_DIGEST, FAKE_ENTRYPOINT, FAKE_GVISOR_PROC_VERSION, FAKE_IMAGE_ENV, FAKE_IMAGE_ID, FAKE_MANIFEST_DIGEST, FAKE_RUNSC_PATH, FAKE_RUNSC_SHA256, HOST_CANARY, HOST_PROC_VERSION, POLICY, RUN, SPEC, compliantHostLayout, compliantInspect,
  compliantReport, fakeHostFs, finishedInspect, type FakeEntry,
} from "./fixtures.js";

/**
 * The real decision scope's host pins and image are the VPS's (not present in these fakes), so these tests exercise
 * the mechanism with the scope's host pins and image set to the fixtures' fake values. Only this file is affected; the
 * real constant is checked in blocker-governance.test.ts.
 */
vi.mock("../../research-sandbox/decision-scope.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../research-sandbox/decision-scope.js")>();
  return { ...orig, ACCEPTED_DECISION_SCOPE: Object.freeze({ ...orig.ACCEPTED_DECISION_SCOPE, daemonRuntimes: Object.freeze(["runc", "runsc"]), imageId: `sha256:${"cd".repeat(32)}`,
    runscSha256: "5e".repeat(32), sidecars: Object.freeze([]), gvisorProcVersion: "Linux version 4.4.0 #1 SMP (fake gVisor reference for tests)" }) };
});

const REPO = path.resolve(__dirname, "../../..");
beforeEach(() => {
  const real = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) => (p === "/proc/version" ? HOST_PROC_VERSION : (real as any)(p, ...rest))) as any);
});
afterEach(() => { vi.restoreAllMocks(); });

const BACKTEST: ResearchJob = { command: "trading-backtest", dataset: "prices.json", config: "run.json" };
const JOB_TEXT = JSON.stringify({ version: 1, command: "trading-backtest", dataset: "prices.json", config: "run.json" });
const REPORT = "Backtest report (simulated, hypothetical)\nTotal return: 4.2%\n";

function layout(): Record<string, FakeEntry> {
  const l = compliantHostLayout();
  l[RUN.inputDir] = { ...l[RUN.inputDir], entries: ["prices.json", "run.json"] };
  l[`${RUN.inputDir}/prices.json`] = { kind: "file", uid: 1000, mode: 0o100644, ino: 70, size: 5000, sha256: "a".repeat(64) };
  l[`${RUN.inputDir}/run.json`] = { kind: "file", uid: 1000, mode: 0o100644, ino: 71, size: 200, sha256: "b".repeat(64) };
  return l;
}

/** A fake Docker host serving the canary (preflight) and the research container ("-run"). */
function fakeDocker(o: { run?: Partial<ProcessResult>; onRunStart?: () => void; runInspect?: (c: any) => void; leftover?: boolean; removeFails?: boolean; infoAfterCreate?: any; infoAtEnd?: any; info?: any } = {}) {
  const calls: string[] = [];
  const existing = new Set<string>(o.leftover ? ["research-sandbox-r1-run"] : []);
  let cur: { name: string; runtime: string; cmd: string[]; started: boolean; exit: number } | null = null;
  let infos = 0;
  const engine: ContainerEngine = {
    target: ENGINE_TARGET,
    async info() { infos += 1; calls.push("info"); return (cur?.name.endsWith("-run") && o.infoAfterCreate && cur.started === false) ? o.infoAfterCreate : (o.infoAtEnd && calls.includes("remove:run") ? o.infoAtEnd : (o.info ?? DOCKER_INFO)); },
    async create(args, ref) {
      const name = args[args.indexOf("--name") + 1];
      calls.push(`create:${name.endsWith("-run") ? "run" : "canary"}`);
      cur = { name, runtime: args[args.indexOf("--runtime") + 1], cmd: args.slice(args.indexOf(ref) + 1), started: false, exit: 0 };
      existing.add(name); existing.add(CONTAINER_ID);
      return CONTAINER_ID;
    },
    async inspect() {
      const c = compliantInspect(cur!.runtime)[0];
      c.Name = `/${cur!.name}`; c.Config.Cmd = [...cur!.cmd]; c.Args = [...FAKE_ENTRYPOINT.slice(1), ...cur!.cmd];
      if (cur!.name.endsWith("-run")) o.runInspect?.(c);
      if (!cur!.started) return [c];
      const f = finishedInspect([c]); f[0].State.ExitCode = cur!.exit; return f;
    },
    async start() {
      cur!.started = true;
      if (!cur!.name.endsWith("-run")) { calls.push("start:canary"); return { exitCode: 0, signal: null, stdout: JSON.stringify(compliantReport()), stderr: "", timedOut: false, truncated: false }; }
      calls.push("start:run"); o.onRunStart?.();
      const r = { exitCode: 0, signal: null, stdout: REPORT, stderr: "", timedOut: false, truncated: false, ...o.run };
      cur!.exit = r.exitCode; return r;
    },
    async remove() { calls.push(`remove:${cur?.name.endsWith("-run") ? "run" : "canary"}`); if (!o.removeFails) existing.clear(); },
    async exists(ref) { return existing.has(ref); },
  };
  return { engine, calls, infos: () => infos };
}
/** gVisor-like host processes; with runOnHost the research script appears as an ordinary host process. */
function observer(runOnHost = false, runscExe: string = FAKE_RUNSC_PATH): HostProcessObserver & { scripts: (string | undefined)[] } {
  const scripts: (string | undefined)[] = [];
  return {
    scripts,
    start: (_id: string, script?: string) => {
      scripts.push(script);
      return { stop: () => ({ polls: 30, unreadable: 0, overflow: false,
        samples: script === RESEARCH_SCRIPT && runOnHost ? [{ pid: 7, exe: "/usr/local/bin/node", argv0: "node", mentionsContainer: false, runsCanaryScript: true, role: "other" as const }]
          : [{ pid: 9, exe: runscExe, argv0: "runsc-sandbox", mentionsContainer: true, runsCanaryScript: false, role: "boot" as const }] }) };
    },
  };
}
/** What a passing preflight would return if the blockers were ever lifted (built by hand; unreachable today). */
const passing = (): PreflightResult => ({
  rating: "meets-spec", allowsUntrustedInput: true, runtime: "runsc", engine: DOCKER_INFO, violations: [], hostTrust: "operator-attested-only", hostProcessEvidence: null,
  steps: ["engine-version", "runtime-binary-verified", "runtime-config-rechecked-after-create", "canary", "removed-verified", "runtime-config-rechecked-after-canary", "runtime-binary-rechecked", "gvisor-verified"],
  cleanup: { containerName: "research-sandbox-r1-canary", containerId: CONTAINER_ID, attempts: 1, verifiedRemoved: true, detail: "removed and verified" },
  binding: { runId: "r1", inputDir: RUN.inputDir, outputDir: RUN.outputDir, imageRef: imageReference(SPEC), runtime: "runsc", securityArgsSha256: securityArgsHash(buildCreateArgs(SPEC, RUN, "runsc", ["node"], "run"), SPEC),
    gvisorProcVersion: SPEC.gvisorProcVersion!, runtimeBinarySha256: SPEC.runscBinary!.sha256, dockerServerVersion: SPEC.dockerServerVersion! },
});
const OPEN: ExecutorInternals = { preflight: async () => passing(), gate: () => {} };
function opts(over: Partial<ExecutorOptions> & { l?: Record<string, FakeEntry>; d?: ReturnType<typeof fakeDocker>; obs?: HostProcessObserver } = {}) {
  const l = over.l ?? layout();
  const d = over.d ?? fakeDocker();
  return { o: { engine: d.engine, spec: SPEC, run: RUN, hostCanaryPath: HOST_CANARY, hostFs: fakeHostFs(l), hostPolicy: POLICY, hostProcesses: over.obs ?? observer(), job: BACKTEST, jobText: JOB_TEXT,
    now: () => "2026-11-05T10:00:00.000Z", ...over } as ExecutorOptions, d, l };
}

describe("E1: the job file", () => {
  it("accepts exactly the two job shapes and builds a fixed command line", () => {
    expect(parseResearchJob(JOB_TEXT)).toEqual(BACKTEST);
    expect(parseResearchJob('{"version":1,"command":"trading-validate","dataset":"prices.json"}')).toEqual({ command: "trading-validate", dataset: "prices.json", config: null });
    expect(researchCommand(BACKTEST, SPEC)).toEqual(["node", "/app/research-cli/main.js", "trading", "backtest", "--data-root", "/in", "--repo-root", "/app", "--dataset", "prices.json", "--config", "run.json"]);
  });
  it.each([
    ["not JSON", "{"], ["an array", "[]"], ["version 2", '{"version":2,"command":"trading-validate","dataset":"a.json"}'],
    ["an unknown command", '{"version":1,"command":"assess","dataset":"a.json"}'], ["a shell-like command", '{"version":1,"command":"trading-validate; rm -rf /","dataset":"a.json"}'],
    ["a path", '{"version":1,"command":"trading-validate","dataset":"../etc/passwd.json"}'], ["an absolute path", '{"version":1,"command":"trading-validate","dataset":"/in/a.json"}'],
    ["upper case", '{"version":1,"command":"trading-validate","dataset":"A.json"}'], ["no .json", '{"version":1,"command":"trading-validate","dataset":"a.txt"}'],
    ["an option as a name", '{"version":1,"command":"trading-validate","dataset":"--x.json"}'], ["config on validate", '{"version":1,"command":"trading-validate","dataset":"a.json","config":"b.json"}'],
    ["backtest without config", '{"version":1,"command":"trading-backtest","dataset":"a.json"}'], ["the same file twice", '{"version":1,"command":"trading-backtest","dataset":"a.json","config":"a.json"}'],
    ["an extra key", '{"version":1,"command":"trading-validate","dataset":"a.json","args":["--x"]}'], ["a duplicate key", '{"version":1,"command":"trading-validate","dataset":"a.json","dataset":"b.json"}'],
    ["too large", `{"version":1,"command":"trading-validate","dataset":"a.json","x":"${"y".repeat(5000)}"}`],
  ])("%s: refused", (_l, text) => {
    expect(() => parseResearchJob(text)).toThrow(ResearchJobError);
  });
});

describe("E1: the input folder", () => {
  const check = (mutate: (l: Record<string, FakeEntry>) => void) => { const l = layout(); mutate(l); return checkJobInputs(BACKTEST, RUN, SPEC, fakeHostFs(l), POLICY); };
  it("exactly the job's files, hashed", () => {
    const r = check(() => {});
    expect(r.violations).toEqual([]);
    expect(r.inputs.map((i) => [i.name, i.sha256.slice(0, 4), i.size])).toEqual([["prices.json", "aaaa", 5000], ["run.json", "bbbb", 200]]);
  });
  it.each([
    ["an extra file", (l: any) => { l[RUN.inputDir].entries.push("notes.json"); }, "holds files the job does not name"],
    ["a missing file", (l: any) => { l[RUN.inputDir].entries = ["prices.json"]; }, "input run.json: missing"],
    ["a symbolic link", (l: any) => { l[`${RUN.inputDir}/prices.json`].kind = "symlink"; }, "must be a regular file"],
    ["a file owned by someone else", (l: any) => { l[`${RUN.inputDir}/run.json`].uid = 4242; }, "owned by root or the operator"],
    ["a group-writable file", (l: any) => { l[`${RUN.inputDir}/run.json`].mode = 0o100664; }, "writable by group or others"],
    ["an oversized config", (l: any) => { l[`${RUN.inputDir}/run.json`].size = MAX_CONFIG_BYTES + 1; }, "input run.json: cannot be checked"],
    ["an unreadable folder", (l: any) => { l[RUN.inputDir].error = "EACCES"; }, "input folder: cannot be listed"],
  ])("%s: refused", (_l, mutate, message) => {
    expect(check(mutate).violations.join("\n")).toContain(message);
  });
});

describe("E1: the gate (default internals)", () => {
  it("with the real preflight and gate, the job is refused by M1/M3 and NO research container is ever created", async () => {
    const { o, d } = opts();
    const r = await runResearchJob(o);
    expect(r.status).toBe("refused");
    expect(r.violations[0]).toBe("gate: untrusted input is not allowed by this preflight result");
    expect(r.violations).toEqual(expect.arrayContaining([...MEETS_SPEC_BLOCKERS]));
    expect(d.calls).toContain("create:canary");
    expect(d.calls).not.toContain("create:run");
    expect(d.calls).not.toContain("start:run");
    expect(r.report).toBeNull();
    expect(r.audit.preflight).toMatchObject({ rating: "refused", lastStep: "meets-spec-blocked" });
  });
  it("even a perfect preflight result is refused by the real gate while the blockers exist", async () => {
    const { o, d } = opts();
    const r = await runResearchJob(o, { preflight: async () => passing(), gate: (await import("../../research-sandbox/index.js")).assertUntrustedInputAllowed });
    expect(r.status).toBe("refused");
    expect(r.violations.join("\n")).toContain("M1: ");
    expect(d.calls.some((c) => c.startsWith("create"))).toBe(false);
  });
  it("bad inputs are refused before the preflight (no engine call)", async () => {
    const l = layout(); l[RUN.inputDir].entries!.push("extra.json");
    const { o, d } = opts({ l });
    const r = await runResearchJob(o);
    expect(r.status).toBe("refused");
    expect(d.calls).toEqual([]);
  });
});

describe("E1: inside the accepted M1/M3 decision scope (real preflight and real gate)", () => {
  const RUNSC_PATH = ACCEPTED_DECISION_SCOPE.runscPath;
  /** The fixtures' fake pins with the accepted Docker version and runsc path/arguments (docs/M1-M3-DECISION.md). */
  const SCOPED = resolveSpec({
    imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, gvisorProcVersion: FAKE_GVISOR_PROC_VERSION, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST,
    dockerDataRoot: FAKE_DATA_ROOT, runscBinary: { path: RUNSC_PATH, sha256: FAKE_RUNSC_SHA256, args: ["--oci-seccomp"], sidecars: [] }, dockerServerVersion: "29.9.3", imageId: FAKE_IMAGE_ID,
  });
  const INFO = { ...DOCKER_INFO, serverVersion: "29.9.3", runtimeConfigs: { ...DOCKER_INFO.runtimeConfigs, runsc: { path: RUNSC_PATH, runtimeArgs: ["--oci-seccomp"] } } };
  function scopedLayout(): Record<string, FakeEntry> {
    const l = layout();
    l["/usr/bin"] = { kind: "dir", uid: 0, mode: 0o40755, ino: 54 };
    l[RUNSC_PATH] = { ...l[FAKE_RUNSC_PATH] };
    return l;
  }
  const scoped = (over: { info?: any; spec?: any } = {}) => opts({ spec: over.spec ?? SCOPED, l: scopedLayout(), d: fakeDocker({ info: over.info ?? INFO }), obs: observer(false, RUNSC_PATH) });
  /** A passing result bound to the scoped spec and run, built by hand (for binding mismatches). */
  const bound = (): PreflightResult => {
    const p = passing();
    return { ...p, engine: INFO as any, binding: { ...p.binding!, securityArgsSha256: securityArgsHash(buildCreateArgs(SCOPED, RUN, "runsc", ["node"], "run"), SCOPED),
      runtimeBinarySha256: SCOPED.runscBinary!.sha256, dockerServerVersion: "29.9.3" } };
  };

  it("the fixture is inside the scope, and the default internals are the real preflight and gate", () => {
    expect(ACCEPTED_DECISION_SCOPE.runscSha256).toBe(FAKE_RUNSC_SHA256); // the test scope (see vi.mock above)
    expect(decisionScopeProblems(SCOPED, "runsc", INFO, ACCEPTED_DECISION_SCOPE)).toEqual([]);
    expect(decisionScopeProblems(SPEC, "runsc", DOCKER_INFO, ACCEPTED_DECISION_SCOPE).length).toBeGreaterThan(0);
  });

  it("valid evidence and matching configuration: the real preflight meets the spec, the real gate passes and the job completes", async () => {
    const { o, d } = scoped();
    const r = await runResearchJob(o);
    expect(r.status, r.violations.join("\n")).toBe("completed");
    expect(r.audit.preflight).toMatchObject({ rating: "meets-spec", violations: 0 });
    expect(r.steps.slice(0, 4)).toEqual(["inputs-checked", "preflight", "gate-passed", "rechecked"]);
    expect(d.calls).toEqual(expect.arrayContaining(["create:canary", "create:run", "start:run", "remove:run"]));
    expect(r.report).toBe(REPORT);
  });

  it("the daemon reporting another Docker version: refused by the real preflight, no research container", async () => {
    const { o, d } = scoped({ info: { ...INFO, serverVersion: "29.9.4" } });
    const r = await runResearchJob(o);
    expect(r.status).toBe("refused");
    expect(r.audit.preflight).toMatchObject({ rating: "refused" });
    expect(r.audit.preflight!.lastStep).not.toBe("gvisor-verified");
    expect(d.calls).not.toContain("create:canary"); // refused at the version check, before any container
    expect(d.calls).not.toContain("create:run");
  });

  it("a configuration outside the scope (another Docker version pinned): M1/M3 apply, the real gate refuses, no research container", async () => {
    const spec = { ...SCOPED, dockerServerVersion: "29.9.4" };
    const { o, d } = scoped({ spec, info: { ...INFO, serverVersion: "29.9.4" } });
    const r = await runResearchJob(o);
    expect(r.status).toBe("refused");
    expect(r.violations).toEqual(expect.arrayContaining([...MEETS_SPEC_BLOCKERS]));
    expect(d.calls).not.toContain("create:run");
  });

  it("a different runsc binary, consistently pinned and installed (e.g. host-setup re-run after an upgrade): M1/M3 apply, no research container", async () => {
    const other = "6f".repeat(32);
    const spec = { ...SCOPED, runscBinary: { ...SCOPED.runscBinary!, sha256: other } };
    const l = scopedLayout(); l[RUNSC_PATH] = { ...l[RUNSC_PATH], sha256: other };
    const d = fakeDocker({ info: INFO });
    const { o } = opts({ spec, l, d, obs: observer(false, RUNSC_PATH) });
    const r = await runResearchJob(o);
    expect(r.status).toBe("refused");
    expect(r.audit.preflight).toMatchObject({ rating: "refused", lastStep: "meets-spec-blocked" }); // every check passed; only the scope differs
    expect(r.violations).toEqual(expect.arrayContaining([...MEETS_SPEC_BLOCKERS]));
    expect(d.calls).not.toContain("create:run");
  });

  it("an unexpected extra runtime in the daemon's configuration: M1/M3 apply, no research container", async () => {
    const { o, d } = scoped({ info: { ...INFO, runtimes: [...INFO.runtimes, "kata"], runtimeConfigs: { ...INFO.runtimeConfigs, kata: { path: "/usr/bin/kata" } } } });
    const r = await runResearchJob(o);
    expect(r.status).toBe("refused");
    expect(r.violations).toEqual(expect.arrayContaining([...MEETS_SPEC_BLOCKERS]));
    expect(d.calls).not.toContain("create:run");
  });

  it.each([
    ["another run", (b: any) => ({ ...b, runId: "r2" }), "different run or folders"],
    ["another image", (b: any) => ({ ...b, imageRef: `sha256:${"0".repeat(64)}` }), "different image"],
    ["another runsc binary", (b: any) => ({ ...b, runtimeBinarySha256: "0".repeat(64) }), "recorded runtime binary"],
    ["another Docker version", (b: any) => ({ ...b, dockerServerVersion: "29.9.4" }), "recorded Docker server version"],
    ["another gVisor reference", (b: any) => ({ ...b, gvisorProcVersion: "Linux version 9" }), "recorded gVisor reference"],
    ["other security arguments", (b: any) => ({ ...b, securityArgsSha256: "0".repeat(64) }), "different security arguments"],
  ])("a meets-spec result bound to %s: refused by the real gate, no research container", async (_l, change, message) => {
    const { o, d } = scoped();
    const r = await runResearchJob(o, { preflight: async () => ({ ...bound(), binding: change(bound().binding) }), gate: assertUntrustedInputAllowed });
    expect(r.status).toBe("refused");
    expect(r.violations.join("\n")).toContain(message);
    expect(d.calls.some((c) => c.startsWith("create"))).toBe(false);
  });

  it("a result with incomplete preflight evidence (gVisor not verified, cleanup unverified): refused by the real gate", async () => {
    const { o, d } = scoped();
    const noGvisor = { ...bound(), steps: bound().steps.filter((s) => s !== "gvisor-verified") };
    expect((await runResearchJob(o, { preflight: async () => noGvisor, gate: assertUntrustedInputAllowed })).violations.join("\n")).toContain("gVisor was not positively verified");
    const dirty = { ...bound(), cleanup: { ...bound().cleanup!, verifiedRemoved: false } };
    expect((await runResearchJob(o, { preflight: async () => dirty, gate: assertUntrustedInputAllowed })).violations.join("\n")).toContain("cleanup was not verified");
    expect(d.calls.some((c) => c.startsWith("create"))).toBe(false);
  });

  it("the hand-built bound result itself passes the real gate (the mismatch tests change only one field)", async () => {
    const { o, d } = scoped();
    const r = await runResearchJob(o, { preflight: async () => bound(), gate: assertUntrustedInputAllowed });
    expect(r.status, r.violations.join("\n")).toBe("completed");
    expect(d.calls).toContain("create:run");
  });
});

describe("E1: after the gate (reachable only with replaced internals)", () => {
  it("a completed job: fixed command, same flags, observer on the research script, report and audit", async () => {
    const obs = observer();
    const { o, d } = opts({ obs });
    const r = await runResearchJob(o, OPEN);
    expect(r.status, r.violations.join("\n")).toBe("completed");
    expect(r.report).toBe(REPORT);
    expect(r.steps).toEqual(["inputs-checked", "preflight", "gate-passed", "rechecked", "create", "inspect", "run", "inspect-after-run", "report", "removed-verified", "runtime-rechecked"]);
    expect(obs.scripts).toEqual([RESEARCH_SCRIPT]);
    expect(d.calls).toEqual(expect.arrayContaining(["create:run", "start:run", "remove:run"]));
    expect(r.audit).toMatchObject({ runId: "r1", researchExitCode: 0, reportBytes: Buffer.byteLength(REPORT), runtime: "runsc", containerId: CONTAINER_ID, imageRef: imageReference(SPEC) });
    expect(r.audit.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.audit.inputs.map((i) => i.name)).toEqual(["prices.json", "run.json"]);
    expect(r.audit.cleanup?.verifiedRemoved).toBe(true);
  });
  it("the research CLI refusing its input (exit 1) is a completed job with exit 1", async () => {
    const { o } = opts({ d: fakeDocker({ run: { exitCode: 1, stdout: "Refused: dataset invalid\n" } }) });
    const r = await runResearchJob(o, OPEN);
    expect(r.status).toBe("completed");
    expect(r.audit.researchExitCode).toBe(1);
  });
  it.each([
    ["exit 2", { run: { exitCode: 2 } }, "the research CLI exited with 2"],
    ["a crash by signal", { run: { exitCode: -1, signal: "SIGKILL" } }, "exited with -1 (SIGKILL)"],
    ["a timeout", { run: { timedOut: true } }, "run: timed out"],
    ["an oversized report", { run: { truncated: true } }, "report exceeded the output cap"],
    ["an inspect violation (network)", { runInspect: (c: any) => { c.HostConfig.NetworkMode = "bridge"; } }, "NetworkMode"],
    ["a removal that never succeeds", { removeFails: true }, "manual cleanup required"],
    ["the runtime configuration changing after create", { infoAfterCreate: { ...DOCKER_INFO, runtimeConfigs: { ...DOCKER_INFO.runtimeConfigs, runsc: { path: FAKE_RUNSC_PATH, runtimeArgs: ["--oci-seccomp"], status: { x: "y" } } } } }, "runtime configuration changed after create"],
  ])("%s: failed, report withheld, removal attempted", async (_l, d, message) => {
    const docker = fakeDocker(d as any);
    const { o } = opts({ d: docker });
    const r = await runResearchJob(o, OPEN);
    expect(r.status).toBe("failed");
    expect(r.report).toBeNull();
    expect(r.violations.join("\n")).toContain(message);
    if (docker.calls.includes("create:run")) expect(docker.calls).toContain("remove:run");
  });
  it("the research script seen as an ordinary host process: failed", async () => {
    const { o } = opts({ obs: observer(true) });
    const r = await runResearchJob(o, OPEN);
    expect(r.status).toBe("failed");
    expect(r.violations.join("\n")).toContain("ordinary host process");
  });
  it("files left in the output folder: failed, never read", async () => {
    const l = layout();
    const { o } = opts({ l, d: fakeDocker({ onRunStart: () => { l[RUN.outputDir].entries = ["evil.sh"]; } }) });
    const r = await runResearchJob(o, OPEN);
    expect(r.status).toBe("failed");
    expect(r.violations.join("\n")).toContain("output folder: the job left files there");
  });
  it("inputs changed between the first check and the job: refused before create", async () => {
    const l = layout();
    const d = fakeDocker();
    const { o } = opts({ l, d });
    const r = await runResearchJob(o, { preflight: async () => { l[`${RUN.inputDir}/prices.json`].sha256 = "c".repeat(64); return passing(); }, gate: () => {} });
    expect(r.status).toBe("refused");
    expect(r.violations[0]).toContain("inputs: changed");
    expect(d.calls.some((c) => c.startsWith("create"))).toBe(false);
  });
  it.each([
    ["another runtime binary", (p: PreflightResult) => ({ ...p, binding: { ...p.binding!, runtimeBinarySha256: "f".repeat(64) } }), "runtime binary: differs"],
    ["other security arguments", (p: PreflightResult) => ({ ...p, binding: { ...p.binding!, securityArgsSha256: "0".repeat(64) } }), "security arguments: differ"],
    ["another Docker version", (p: PreflightResult) => ({ ...p, binding: { ...p.binding!, dockerServerVersion: "1.0.0" } }), "Docker server version: differs"],
    ["a development runtime", (p: PreflightResult) => ({ ...p, runtime: "runc" }), "names no isolating runtime"],
  ])("a preflight result with %s: refused before create", async (_l, change, message) => {
    const d = fakeDocker();
    const { o } = opts({ d });
    const r = await runResearchJob(o, { preflight: async () => change(passing()), gate: () => {} });
    expect(r.status).toBe("refused");
    expect(r.violations.join("\n")).toContain(message);
    expect(d.calls.some((c) => c.startsWith("create"))).toBe(false);
  });
  it("a leftover research container: refused", async () => {
    const { o } = opts({ d: fakeDocker({ leftover: true }) });
    expect((await runResearchJob(o, OPEN)).violations.join("\n")).toContain("already exists");
  });
  it("the report is untrusted text: control and non-ASCII characters are replaced", async () => {
    const { o } = opts({ d: fakeDocker({ run: { stdout: "ok\u001b[31mred\u0007 caf\u00e9\n" } }) });
    const r = await runResearchJob(o, OPEN);
    expect(r.report).toBe("ok?[31mred? caf?\n");
    expect(sanitizeReport("a\tb\nc")).toBe("a\tb\nc");
  });
});

describe("E1: operator command", () => {
  const cfg = JSON.stringify({ version: 1 });
  const cmd = async (argv: string[], over: Record<string, unknown> = {}) => {
    const out: string[] = []; const err: string[] = []; let engines = 0;
    const d = fakeDocker();
    const code = await runResearchJobCommand(argv, {
      readFile: (p: string) => (p.endsWith("job.json") ? JOB_TEXT : cfg),
      parseConfig: () => ({ engineBinary: "/usr/bin/docker", engineConfigDir: "/srv/research-engine/docker-config", runId: "r1", hostCanaryPath: HOST_CANARY, operatorUid: 1000, outputOwnerUid: 10001, pins: {} }),
      resolveSpec: () => SPEC, runPaths: () => RUN, createEngine: () => { engines += 1; return d.engine; }, hostFs: fakeHostFs(layout()), hostProcesses: observer(),
      out: (t: string) => out.push(t), err: (t: string) => err.push(t), ...over,
    } as any);
    return { code, out: out.join(""), err: err.join(""), engines, calls: d.calls };
  };
  it.each([[[]], [["--config", "/c.json", "--job", "/job.json"]], [["--config", "c.json", "--job", "/job.json", EXECUTOR_CONFIRM_FLAG]], [["--job", "/job.json", "--config", "/c.json", EXECUTOR_CONFIRM_FLAG]]])("usage %j: exit 2, no engine", async (argv) => {
    const r = await cmd(argv);
    expect(r.code).toBe(2);
    expect(r.engines).toBe(0);
  });
  it("a bad job file: exit 2 before any engine call", async () => {
    const r = await cmd(["--config", "/c.json", "--job", "/job.json", EXECUTOR_CONFIRM_FLAG], { readFile: (p: string) => (p.endsWith("job.json") ? '{"version":1,"command":"x"}' : cfg) });
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });
  it("today: refused by the gate (exit 1), JSON result, no research container", async () => {
    const r = await cmd(["--config", "/c.json", "--job", "/job.json", EXECUTOR_CONFIRM_FLAG]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ runner: "research-sandbox-executor", status: "refused", report: null });
    expect(r.calls).not.toContain("create:run");
    expect(r.err).toContain("Research job: REFUSED");
  });
});

describe("E1: the research image and the boundaries", () => {
  /** The relative-import closure of research-cli/main.ts, from the TypeScript sources. */
  function closure(entry: string): { files: string[]; external: string[] } {
    const seen = new Set<string>(); const external = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return; seen.add(file);
      const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
      for (const st of src.statements) {
        if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
          const isTypeOnly = ts.isImportDeclaration(st) ? st.importClause?.isTypeOnly === true : st.isTypeOnly;
          const spec = st.moduleSpecifier.text;
          if (spec.startsWith(".")) { if (!isTypeOnly) walk(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts"))); } else external.add(spec);
        }
      }
    };
    walk(entry);
    return { files: [...seen].map((f) => path.relative(path.join(REPO, "src"), f).replace(/\.ts$/, ".js")).sort(), external: [...external].sort() };
  }
  it("RESEARCH_IMAGE_FILES is exactly the research CLI's import closure; only Node built-ins; no agent, inference, wallet or network code", () => {
    const c = closure(path.join(REPO, "src/research-cli/main.ts"));
    expect([...RESEARCH_IMAGE_FILES].sort()).toEqual(c.files);
    expect(c.external).toEqual(["node:crypto", "node:fs"]);
    for (const f of c.files) expect(/^(agent|inference|conway|identity|survival|social|replication|self-mod|orchestration|ollama|registry|heartbeat|research-sandbox)\//.test(f), f).toBe(false);
    expect(RESEARCH_IMAGE_LAYOUT.slice(0, 2)).toEqual([["canary-probe.js", "research-sandbox/canary-probe.js"], ["canary.js", "research-sandbox/canary.js"]]);
  });
  it("Dockerfile.research: exactly the reviewed instructions (pinned base by digest, WORKDIR /app, one read-only COPY)", () => {
    const text = fs.readFileSync(path.join(REPO, "deploy/research-sandbox/Dockerfile.research"), "utf8");
    const ins = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    expect(ins).toEqual(["ARG NODE_BASE_DIGEST", "FROM docker.io/library/node:22.22.0-bookworm-slim@${NODE_BASE_DIGEST}", "WORKDIR /app", "COPY --chown=0:0 --chmod=0555 app/ /app/"]);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "deploy/research-sandbox/package-research.json"), "utf8"));
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.scripts).toBeUndefined();
  });
  it("the entry point never replaces the preflight or the gate, and the command uses the defaults", () => {
    const main = fs.readFileSync(path.join(REPO, "src/research-sandbox/executor-main.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(main).not.toMatch(/gate|preflight\s*:|ExecutorInternals|runResearchJob\(/);
    const exe = fs.readFileSync(path.join(REPO, "src/research-sandbox/executor.ts"), "utf8");
    expect(exe).toContain("const r = await runResearchJob(options);");
    expect(exe.match(/runResearchJob\(/g)).toHaveLength(2); // the definition and the command's one call
    expect(exe).toContain("const DEFAULT_INTERNALS: ExecutorInternals = Object.freeze({ preflight: runPreflight, gate: assertUntrustedInputAllowed });");
  });
});

describe("E1: supporting changes", () => {
  it("the host-process observer watches the given script (default: the canary)", async () => {
    const { sampleOnce, CANARY_SCRIPT } = await import("../../research-sandbox/host-processes.js");
    const proc = { listPids: () => [1, 2], cmdline: (pid: number) => Buffer.from(pid === 1 ? `node\0${RESEARCH_SCRIPT}\0` : `node\0${CANARY_SCRIPT}\0`), exe: () => "/usr/local/bin/node" };
    expect(sampleOnce(proc, CONTAINER_ID, RESEARCH_SCRIPT).samples.map((s) => s.pid)).toEqual([1]);
    expect(sampleOnce(proc, CONTAINER_ID).samples.map((s) => s.pid)).toEqual([2]);
  });
  it("the after-run re-inspect accepts only the listed exit codes (default 0)", async () => {
    const { validateFinishedInspect } = await import("../../research-sandbox/inspect.js");
    const raw = finishedInspect(compliantInspect()); raw[0].State.ExitCode = 1;
    const base = { run: RUN, purpose: "canary" as const, containerId: CONTAINER_ID, runtime: "runsc" };
    expect(validateFinishedInspect(raw, SPEC, base).join("\n")).toContain("State: must be exited with code 0");
    expect(validateFinishedInspect(raw, SPEC, { ...base, allowedExitCodes: [1] })).toEqual([]);
    raw[0].State.ExitCode = 2;
    expect(validateFinishedInspect(raw, SPEC, { ...base, allowedExitCodes: [1] }).join("\n")).toContain("State: must be exited with code 1");
  });
  it("trust evidence no longer records the host kernel or OS versions", () => {
    const src = fs.readFileSync(path.join(REPO, "src/research-sandbox/trust-evidence.ts"), "utf8");
    const fields = /const INFO_FIELDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src)![1];
    expect(fields).not.toMatch(/KernelVersion|OperatingSystem/);
    expect(fields).toContain('"ServerVersion"');
  });
});
