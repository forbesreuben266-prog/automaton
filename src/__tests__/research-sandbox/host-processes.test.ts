/**
 * Step A3 (M1 evidence): host-side process observation while the canary runs,
 * with a fake /proc. Under gVisor no host process may run the canary script,
 * and a process naming the container must run from the recorded runsc files.
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANARY_SCRIPT, MIN_HOST_PROCESS_POLLS, hostProcessViolations, procHostProcessObserver, sampleOnce, summarizeHostProcesses, type ProcFs,
} from "../../research-sandbox/host-processes.js";
import { PROBE_HOLD_MS, runProbeMain } from "../../research-sandbox/canary-probe.js";
import { MEETS_SPEC_BLOCKERS, runPreflight, type ContainerEngine, type ProcessResult } from "../../research-sandbox/index.js";
import { renderRunnerReport, toReport } from "../../research-sandbox/runner.js";
import {
  CONTAINER_ID, DOCKER_INFO, ENGINE_TARGET, FAKE_RUNSC_PATH, HOST_CANARY, HOST_PROC_VERSION, POLICY, RUN, SPEC, compliantHostLayout, compliantInspect, compliantReport,
  fakeHostFs, fakeHostProcesses, finishedInspect,
} from "./fixtures.js";

const SECRET = "--password=hunter2";
function fakeProc(procs: Record<number, { argv: string[]; exe?: string | Error }>): ProcFs {
  return {
    listPids: () => Object.keys(procs).map(Number),
    cmdline: (pid) => { const p = procs[pid]; if (!p) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return Buffer.from(`${p.argv.join("\0")}\0`); },
    exe: (pid) => { const e = procs[pid]?.exe; if (e instanceof Error || e === undefined) throw e ?? new Error("EACCES"); return e; },
  };
}
const GVISOR_HOST = {
  1: { argv: ["/sbin/init"], exe: "/usr/lib/systemd/systemd" },
  50: { argv: ["/usr/bin/mysqld", SECRET], exe: "/usr/sbin/mysqld" },
  100: { argv: ["/usr/bin/containerd-shim-runc-v2", "-namespace", "moby", "-id", CONTAINER_ID], exe: "/usr/bin/containerd-shim-runc-v2" },
  101: { argv: ["runsc-gofer", "--root=/var/run/docker/runtime-runc/moby", "gofer", "--bundle", `/run/containerd/io.containerd.runtime.v2.task/moby/${CONTAINER_ID}`], exe: FAKE_RUNSC_PATH },
  102: { argv: ["runsc-sandbox", "boot", `--bundle=/run/containerd/io.containerd.runtime.v2.task/moby/${CONTAINER_ID}`], exe: "/usr/local/bin/gvisor-bin/runsc-sentry" },
  103: { argv: ["runsc", "--root=/var/run/docker/runtime-runc/moby", "state", CONTAINER_ID], exe: FAKE_RUNSC_PATH },
};
const RUNC_HOST = {
  100: { argv: ["/usr/bin/containerd-shim-runc-v2", "-id", CONTAINER_ID], exe: "/usr/bin/containerd-shim-runc-v2" },
  200: { argv: ["node", CANARY_SCRIPT, "--canary", HOST_CANARY], exe: "/usr/local/bin/node" },
};
const EXES = [FAKE_RUNSC_PATH, "/usr/local/bin/gvisor-bin/runsc-sentry"];

describe("A3: sampling host /proc", () => {
  it("keeps only processes naming the container or running the canary script; records no argument values", () => {
    const r = sampleOnce(fakeProc(GVISOR_HOST), CONTAINER_ID);
    expect(r.samples.map((s) => s.pid).sort()).toEqual([100, 101, 102, 103]);
    const text = JSON.stringify(r);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("--bundle");
    expect(r.samples.find((s) => s.pid === 102)).toEqual({ pid: 102, exe: "/usr/local/bin/gvisor-bin/runsc-sentry", argv0: "runsc-sandbox", mentionsContainer: true, runsCanaryScript: false, role: "boot" });
    expect(r.samples.find((s) => s.pid === 101)?.role).toBe("gofer");
    expect(r.samples.find((s) => s.pid === 103)?.role).toBe("other");
  });

  it("vanished processes and unreadable executables are counted, not fatal", () => {
    const proc = fakeProc({ 7: { argv: ["x", CONTAINER_ID], exe: new Error("EACCES") } });
    const listing = { ...proc, listPids: () => [7, 8] };
    const r = sampleOnce(listing, CONTAINER_ID);
    expect(r.unreadable).toBe(1);
    expect(r.samples).toEqual([{ pid: 7, exe: null, argv0: "x", mentionsContainer: true, runsCanaryScript: false, role: "other" }]);
  });

  it("the observer samples repeatedly until stopped", () => {
    vi.useFakeTimers();
    try {
      const watch = procHostProcessObserver(fakeProc(GVISOR_HOST)).start(CONTAINER_ID);
      vi.advanceTimersByTime(400);
      const obs = watch.stop();
      expect(obs.polls).toBeGreaterThanOrEqual(20);
      expect(obs.samples.length).toBe(4);
      expect(obs.overflow).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe("A3: evaluation", () => {
  const obs = (procs: Record<number, { argv: string[]; exe?: string | Error }>, polls = 25) => ({ polls, samples: sampleOnce(fakeProc(procs), CONTAINER_ID).samples, unreadable: 0, overflow: false });

  it("gVisor: runsc processes name the container; the canary never appears on the host", () => {
    const e = summarizeHostProcesses(obs(GVISOR_HOST), EXES);
    expect(e).toEqual({ polls: 25, sandboxProcesses: 2, canaryOnHost: 0, replacedExecutables: 0, overflow: false,
      executables: ["/usr/bin/containerd-shim-runc-v2", "/usr/local/bin/gvisor-bin/runsc-sentry", FAKE_RUNSC_PATH].sort() });
    expect(hostProcessViolations(e)).toEqual([]);
  });

  it("runc: the canary is an ordinary host process: refused", () => {
    const v = hostProcessViolations(summarizeHostProcesses(obs(RUNC_HOST), EXES)).join("\n");
    expect(v).toContain("the canary script ran as 1 ordinary host process(es)");
    expect(v).toContain("no gVisor sandbox or gofer process naming the container ran from the recorded runsc binary");
  });

  it("short-lived runsc commands for the container (state, create, start) do not count: the sandbox or gofer must be seen", () => {
    const onlyState = { 103: GVISOR_HOST[103] };
    expect(hostProcessViolations(summarizeHostProcesses(obs(onlyState), EXES)).join("\n")).toContain("no gVisor sandbox or gofer process naming the container");
  });

  it("a runsc process for ANOTHER container does not count", () => {
    const other = { 101: { argv: ["runsc-gofer", "gofer", `--bundle=/run/containerd/io.containerd.runtime.v2.task/moby/${"e".repeat(64)}`], exe: FAKE_RUNSC_PATH } };
    expect(sampleOnce(fakeProc(other), CONTAINER_ID).samples).toEqual([]);
  });

  it("an executable deleted or replaced while running: never counted, and refused", () => {
    const replaced = { ...GVISOR_HOST, 102: { ...GVISOR_HOST[102], exe: "/usr/local/bin/gvisor-bin/runsc-sentry (deleted)" }, 101: { ...GVISOR_HOST[101], exe: `${FAKE_RUNSC_PATH} (deleted)` } };
    const e = summarizeHostProcesses(obs(replaced), EXES);
    expect(e.sandboxProcesses).toBe(0);
    expect(e.replacedExecutables).toBe(2);
    expect(hostProcessViolations(e).join("\n")).toContain("2 matching process(es) ran an executable that was deleted or replaced while running");
  });

  it("more matching processes than can be recorded: the observation is incomplete and refused", () => {
    const many: Record<number, { argv: string[]; exe: string }> = { ...GVISOR_HOST };
    for (let i = 0; i < 70; i++) many[1000 + i] = { argv: ["x", CONTAINER_ID, String(i)], exe: "/usr/bin/x" };
    vi.useFakeTimers();
    try {
      const o = procHostProcessObserver(fakeProc(many)).start(CONTAINER_ID).stop();
      expect(o.overflow).toBe(true);
      expect(hostProcessViolations(summarizeHostProcesses(o, EXES)).join("\n")).toContain("incomplete observation");
    } finally { vi.useRealTimers(); }
  });

  it("a process naming the container from an UNRECORDED binary does not count (an impostor named runsc)", () => {
    const fake = { 101: { argv: ["runsc-sandbox", `--bundle=/x/${CONTAINER_ID}`], exe: "/tmp/runsc" } };
    expect(hostProcessViolations(summarizeHostProcesses(obs(fake as never), EXES)).join("\n")).toContain("no gVisor sandbox or gofer process naming the container ran from the recorded runsc binary");
  });

  it("too few samples: refused (absence is only meaningful if /proc was actually watched)", () => {
    expect(hostProcessViolations(summarizeHostProcesses(obs(GVISOR_HOST, MIN_HOST_PROCESS_POLLS - 1), EXES)).join("\n")).toContain(`at least ${MIN_HOST_PROCESS_POLLS} required`);
  });
});

describe("A3: in the preflight", () => {
  beforeEach(() => {
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) => (p === "/proc/version" ? HOST_PROC_VERSION : (real as any)(p, ...rest))) as any);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function engine(opts: { startThrows?: boolean } = {}) {
    const calls: string[] = [];
    let started = false;
    let runtime = "runsc";
    const ok: ProcessResult = { exitCode: 0, signal: null, stdout: JSON.stringify(compliantReport()), stderr: "", timedOut: false, truncated: false };
    const existing = new Set<string>();
    const e: ContainerEngine = {
      target: ENGINE_TARGET,
      async info() { calls.push("info"); return DOCKER_INFO; },
      async create(args) { calls.push("create"); runtime = args[args.indexOf("--runtime") + 1]; existing.add(CONTAINER_ID); existing.add("research-sandbox-r1-canary"); return CONTAINER_ID; },
      async inspect() { calls.push("inspect"); const raw = compliantInspect(runtime); return started ? finishedInspect(raw) : raw; },
      async start() { calls.push("start"); started = true; if (opts.startThrows) throw new Error("start broke"); return ok; },
      async remove() { calls.push("remove"); existing.clear(); },
      async exists(ref) { return existing.has(ref); },
    };
    return { e, calls };
  }
  const go = (e: ContainerEngine, extra: Record<string, unknown>) => runPreflight({ engine: e, spec: SPEC, run: RUN, hostCanaryPath: HOST_CANARY, hostFs: fakeHostFs(compliantHostLayout()), hostPolicy: POLICY, ...extra } as any);

  it("gVisor evidence present: refused only by M1/M3, with the evidence in the result and the runner report", async () => {
    const watch = fakeHostProcesses("gvisor");
    const r = await go(engine().e, { hostProcesses: watch });
    expect(r.violations).toEqual(MEETS_SPEC_BLOCKERS);
    expect(watch.started).toEqual([CONTAINER_ID]);
    expect(r.steps).toContain("host-process-evidence");
    expect(r.hostProcessEvidence).toEqual({ polls: 20, sandboxProcesses: 1, canaryOnHost: 0, replacedExecutables: 0, overflow: false, executables: [FAKE_RUNSC_PATH] });
    const rep = toReport(r, "r1");
    expect(rep.hostProcessEvidence).toEqual(r.hostProcessEvidence);
    expect(renderRunnerReport(rep)).toContain("Host processes while the canary ran: 20 samples; 1 gVisor process(es) naming the container; 0 canary process(es) on the host");
  });

  it("no observer for runsc: refused before anything is created", async () => {
    const f = engine();
    const r = await go(f.e, {});
    expect(r.violations.join("\n")).toContain("host processes: no host process observer was provided");
    expect(f.calls).not.toContain("create");
  });

  it.each([
    ["the canary visible on the host (a runtime named runsc that is really runc)", fakeHostProcesses("runc"), "the canary script ran as 1 ordinary host process(es)"],
    ["no gVisor process seen", fakeHostProcesses("none"), "no gVisor sandbox or gofer process naming the container ran from the recorded runsc binary"],
    ["too few samples", fakeHostProcesses("gvisor", 3), "only 3 samples while the canary ran"],
  ])("%s: refused after the canary, cleanup verified", async (_l, watch, message) => {
    const r = await go(engine().e, { hostProcesses: watch });
    expect(r.rating).toBe("refused");
    expect(r.violations.join("\n")).toContain(message);
    expect(r.steps).toContain("removed-verified");
    expect(r.steps).not.toContain("gvisor-verified");
  });

  it("the observer is stopped even when start throws", async () => {
    let stopped = 0;
    const watch = { start: () => ({ stop: () => { stopped += 1; return { polls: 20, samples: [], unreadable: 0, overflow: false }; } }) };
    const r = await go(engine({ startThrows: true }).e, { hostProcesses: watch });
    expect(stopped).toBe(1);
    expect(r.violations.join("\n")).toContain("start broke");
  });

  it("a development runtime records the observation but does not require gVisor evidence", async () => {
    const r = await go(engine().e, { hostProcesses: fakeHostProcesses("runc"), spec: { ...SPEC, isolatingRuntimes: [] } });
    expect(r.rating).toBe("development-only");
    expect(r.hostProcessEvidence?.canaryOnHost).toBe(1);
    expect(r.steps).not.toContain("host-process-evidence");
  });
});

describe("A3: the probe stays alive after writing its report", () => {
  it("holds after stdout (never before, never on refusal)", async () => {
    const order: string[] = [];
    const deps = { inside: () => true, probe: async () => compliantReport(), stdout: () => { order.push("stdout"); }, stderr: () => {}, hold: async () => { order.push("hold"); } };
    expect(await runProbeMain(["node", "p", "--canary", HOST_CANARY], deps)).toBe(0);
    expect(order).toEqual(["stdout", "hold"]);
    order.length = 0;
    expect(await runProbeMain(["node", "p"], { ...deps, inside: () => false })).toBe(2);
    expect(order).toEqual([]);
    expect(PROBE_HOLD_MS).toBe(1500);
  });

  it("the entry point passes a hold of PROBE_HOLD_MS", () => {
    const src = fs.readFileSync(`${__dirname}/../../research-sandbox/canary-probe.ts`, "utf8");
    expect(src).toContain("hold: () => new Promise((resolve) => { setTimeout(resolve, PROBE_HOLD_MS); }),");
  });
});
