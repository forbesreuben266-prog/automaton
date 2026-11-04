/**
 * V2.3: the canary probe's entry point. Root cause of the V2.2 VPS failure
 * ("canary: output is not JSON"): canary-probe.ts only exported functions, so
 * `node /app/canary-probe.js --canary <path>` printed nothing and exited 0.
 * Tests inject the probe (no /proc scan, no network attempt) except one that
 * runs the real file outside a container, where it must refuse before probing.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCanary } from "../../research-sandbox/index.js";
import { isEntryPoint, runProbeMain, type ProbeMainDeps } from "../../research-sandbox/canary-probe.js";
import { HOST_CANARY, SPEC, compliantReport } from "./fixtures.js";

const REPO = path.resolve(__dirname, "../../..");
const SOURCE = path.join(REPO, "src/research-sandbox/canary-probe.ts");

function harness(over: Partial<ProbeMainDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const probed: string[] = [];
  const deps: ProbeMainDeps = {
    inside: () => true,
    probe: async (p) => { probed.push(p); return compliantReport(); },
    stdout: (t) => { out.push(t); }, stderr: (t) => { err.push(t); },
    ...over,
  };
  return { deps, out, err, probed };
}
const ARGV = ["node", "/app/canary-probe.js", "--canary", HOST_CANARY];

describe("V2.3: runProbeMain", () => {
  it("writes exactly one JSON report line to stdout and exits 0; the preflight's evaluation accepts it", async () => {
    const h = harness();
    expect(await runProbeMain(ARGV, h.deps)).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(h.out[0].endsWith("\n")).toBe(true);
    expect(h.out[0].indexOf("\n")).toBe(h.out[0].length - 1);
    expect(JSON.parse(h.out[0])).toEqual(compliantReport());
    expect(evaluateCanary(JSON.parse(h.out[0]), SPEC)).toEqual([]);
    expect(h.probed).toEqual([HOST_CANARY]);
    expect(h.err).toEqual([]);
  });

  it("outside the canary container: refuses with exit 2, never probes, prints nothing on stdout", async () => {
    const h = harness({ inside: () => false });
    expect(await runProbeMain(ARGV, h.deps)).toBe(2);
    expect(h.probed).toEqual([]);
    expect(h.out).toEqual([]);
    expect(h.err.join("")).toContain("refused");
  });

  it.each([
    ["no path after --canary", ["node", "p.js", "--canary"]],
    ["a relative path", ["node", "p.js", "--canary", "srv/x"]],
    ["a path with spaces", ["node", "p.js", "--canary", "/srv/a b"]],
    ["a path with ..", ["node", "p.js", "--canary", "/srv/../etc/shadow"]],
    ["a flag instead of a path", ["node", "p.js", "--canary", "--other"]],
  ])("%s: refuses with exit 2, never probes", async (_label, argv) => {
    const h = harness();
    expect(await runProbeMain(argv, h.deps)).toBe(2);
    expect(h.probed).toEqual([]);
    expect(h.out).toEqual([]);
  });

  it("a probe failure exits 1 with a bounded message on stderr and nothing on stdout", async () => {
    const h = harness({ probe: async () => { throw new Error("x".repeat(5000)); } });
    expect(await runProbeMain(ARGV, h.deps)).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err.join("").length).toBeLessThan(300);
  });
});

describe("V2.3: the preflight refuses a canary path the probe would refuse, before any engine call", () => {
  it.each(["/srv/../etc/canary", "/srv/./canary"])("%s", async (p) => {
    const { runPreflight } = await import("../../research-sandbox/index.js");
    const calls: string[] = [];
    const engine: any = new Proxy({}, { get: (_t, k) => (k === "target" ? null : () => { calls.push(String(k)); throw new Error("must not be called"); }) });
    const { RUN, POLICY, fakeHostFs, compliantHostLayout } = await import("./fixtures.js");
    const r = await runPreflight({ engine, spec: SPEC, run: RUN, hostCanaryPath: p, hostFs: fakeHostFs(compliantHostLayout()), hostPolicy: POLICY });
    expect(r.violations.join("\n")).toContain("hostCanaryPath: must be an absolute path outside the runs root (no . or .. segments");
    expect(calls).toEqual([]);
  });
});

describe("V2.3: the entry point runs only when the file is executed", () => {
  it("isEntryPoint is true only for this module's own file", () => {
    const url = new URL(`file://${SOURCE}`).href;
    expect(isEntryPoint(SOURCE, url)).toBe(true);
    expect(isEntryPoint(undefined, url)).toBe(false);
    expect(isEntryPoint("", url)).toBe(false);
    expect(isEntryPoint(path.join(REPO, "src/research-sandbox/canary.ts"), url)).toBe(false);
    expect(isEntryPoint("/nonexistent/canary-probe.js", url)).toBe(false);
  });

  it("importing the module (as these tests do) does not start a probe", () => {
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  it("executing the real file outside a container: exit 2, empty stdout, reason on stderr (no probe, no network)", () => {
    const tsx = path.join(REPO, "node_modules/.bin/tsx");
    const r = childProcess.spawnSync(tsx, [SOURCE, "--canary", HOST_CANARY], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" } });
    // This test host is not a container; if it were, the guard (not this test) decides, so only assert the refusal when it applies.
    const inContainer = fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
    if (inContainer) return;
    expect(r.status, r.stderr).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("canary-probe: refused: not started with --canary inside a container");
  });
});

describe("V2.3: canary violations carry the observed value (diagnostics only; the rules are unchanged)", () => {
  it.each([
    ["seccompMode", 0, "seccomp: a filter must be active (mode 2) (got 0)"],
    ["noNewPrivs", 0, "no_new_privs: must be set (got 0)"],
    ["cgroupMemoryMax", Number.NaN, "limits: cgroup memory.max must be at most 536870912 (got null)"],
    ["cgroupPidsMax", 4096, "limits: cgroup pids.max must be at most 64 (got 4096)"],
  ])("%s", (key, value, message) => {
    const report = { ...compliantReport(), [key]: value };
    expect(evaluateCanary(report, SPEC)).toContain(message);
    expect(evaluateCanary(compliantReport(), SPEC)).toEqual([]);
  });
});
