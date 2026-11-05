/**
 * E1b: the sample job and deploy/research-sandbox/e1b-verify.sh, offline. The script is run as a copy with only its
 * four path constants pointed at a temporary folder, with fake node mains, docker and id. No real Docker or host path.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEETS_SPEC_BLOCKERS } from "../../research-sandbox/index.js";
import { parseResearchJob } from "../../research-sandbox/executor.js";
import { EVIDENCE_LIMITS, evidenceDigest } from "../../research-sandbox/trust-evidence.js";
import { runResearchCli } from "../../research-cli/cli.js";
import { DEMO_RUNS, usTrendDataset } from "../research-cli/demo.js";

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "deploy/research-sandbox/e1b-verify.sh");
const TEXT = fs.readFileSync(SCRIPT, "utf8");
const CODE = TEXT.replace(/\\\n\s*/g, " ").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const SAMPLE = path.join(REPO, "deploy/research-sandbox/e1b-sample");

describe("E1b: the synthetic sample job", () => {
  it("is exactly the documented demo data (fictional), and a valid job", () => {
    expect(fs.readFileSync(path.join(SAMPLE, "fict-us-trend.json"), "utf8")).toBe(`${JSON.stringify(usTrendDataset(), null, 2)}\n`);
    expect(fs.readFileSync(path.join(SAMPLE, "run-us-ma.json"), "utf8")).toBe(`${JSON.stringify(DEMO_RUNS["run-us-ma.json"], null, 2)}\n`);
    expect(parseResearchJob(fs.readFileSync(path.join(SAMPLE, "job.json"), "utf8"))).toEqual({ command: "trading-backtest", dataset: "fict-us-trend.json", config: "run-us-ma.json" });
    expect(fs.readdirSync(SAMPLE).sort()).toEqual(["fict-us-trend.json", "job.json", "run-us-ma.json"]);
  });
  it("the research CLI completes the sample backtest offline (exit 0, fictional-data banner)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "e1b-data-"));
    try {
      fs.chmodSync(d, 0o755);
      for (const f of ["fict-us-trend.json", "run-us-ma.json"]) fs.copyFileSync(path.join(SAMPLE, f), path.join(d, f));
      const out: string[] = [];
      const code = runResearchCli(["trading", "backtest", "--data-root", d, "--repo-root", REPO, "--dataset", "fict-us-trend.json", "--config", "run-us-ma.json"], { out: (t) => out.push(t), err: () => {} });
      expect(code).toBe(0);
      expect(out.join("")).toContain("FICTIONAL data only");
      expect(out.join("")).toContain("Status: **ok**");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe("E1b: e1b-verify.sh static checks", () => {
  it("is valid bash, needs --execute and root, and changes no Docker or host configuration", () => {
    expect(childProcess.spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    expect(TEXT).toContain('[ "$#" = 1 ] && [ "$1" = --execute ] ||');
    expect(TEXT).toContain('[ "$(id -u)" = 0 ] ||');
    for (const banned of [/systemctl/, /\/etc\/docker/, /daemon\.json/, /\bapt(-get)?\b/, /\bcurl\b|\bwget\b/, /--privileged/, /\brm\s+-/, /"\$DOCKER"(?: --host \S+)? (run|create|start|exec|rmi|pull|build|rm|kill|image|system|volume|network)\b/, /--allow-base-pull/]) {
      expect(banned.test(CODE), String(banned)).toBe(false);
    }
    expect(CODE.match(/"\$DOCKER"[^\n]*/g)).toEqual(['"$DOCKER" --host unix:///var/run/docker.sock ps -aq --filter "name=^/research-sandbox-$RUNID-run\\$" 2>/dev/null)"; PRC=$?']);
  });
  it("runs only the three reviewed entry points, and the executor only with the committed sample job", () => {
    const mains = [...CODE.matchAll(/"\$NODE" (dist\/[^ ]+)/g)].map((m) => m[1]);
    expect(mains).toEqual(["dist/research-sandbox/trust-evidence-main.js", "dist/research-sandbox/negative-controls-main.js", "dist/research-sandbox/executor-main.js"]);
    expect(TEXT).toContain('--job "$EV/job.json" --confirm-sandboxed-research');
    expect(TEXT).toContain('cp -- "$SAMPLE/job.json" "$EV/job.json"');
  });
});

// ---------------------------------------------------------------- simulation

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "e1b-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const preflightReport = { runner: "research-sandbox-preflight", runId: "setup-x", rating: "refused", allowsUntrustedInput: false, blockedOnlyByMeetsSpecBlockers: true, runtime: "runsc",
  steps: ["host-process-evidence", "gvisor-verified", "meets-spec-blocked"], cleanup: { verifiedRemoved: true }, blockers: [...MEETS_SPEC_BLOCKERS],
  hostProcessEvidence: { polls: 80, sandboxProcesses: 2, canaryOnHost: 0, replacedExecutables: 0, overflow: false, executables: ["/usr/bin/runsc"] } };
const trustDoc = (o: { blocking?: boolean; tamper?: boolean; kernel?: boolean } = {}) => {
  const findings = [{ severity: "review", kind: "signature", message: "gVisor signing key fingerprint(s) 6F1DF85E3A71C24918E727D56FC6D554E32BD943: compare" },
    ...(o.blocking ? [{ severity: "blocking", kind: "daemon", message: "docker info: x" }] : [])];
  const blocking = o.blocking ? 1 : 0;
  const body = { kind: "research-sandbox-trust-evidence", verdict: blocking ? "blocking" : "needs-review", evidence: { dockerInfo: { ServerVersion: "29.9.3", ...(o.kernel ? { KernelVersion: "6.8.0" } : {}) } }, findings, blocking, review: 1, limits: EVIDENCE_LIMITS };
  const doc = { ...body, digest: evidenceDigest(body) };
  return JSON.stringify(o.tamper ? { ...doc, review: 0 } : doc);
};
const negDoc = (ok = true) => JSON.stringify({ runner: "research-sandbox-negative-controls", allPassed: ok, expected: 2, outcomes: [{ name: "baseline", passed: true, detail: "as expected" }, { name: "runsc-sha256", passed: ok, detail: ok ? "as expected" : "NOT detected" }] });
const dryRun = (refused = true) => JSON.stringify({ runner: "research-sandbox-executor", status: refused ? "refused" : "completed", report: refused ? null : "x", steps: refused ? ["inputs-checked", "preflight"] : ["inputs-checked", "preflight", "gate-passed", "create"],
  violations: refused ? ["gate: untrusted input is not allowed by this preflight result", ...MEETS_SPEC_BLOCKERS] : [], audit: { containerId: refused ? null : "a".repeat(64), researchExitCode: refused ? null : 0 } });

function setup(o: { trust?: string; trc?: number; neg?: string; nrc?: number; exec?: string; erc?: number; leftover?: boolean; noSetup?: boolean; badReport?: boolean; inputBusy?: boolean } = {}) {
  const state = path.join(dir, "state"), runs = path.join(dir, "runs"), etc = path.join(dir, "etc"), bin = path.join(dir, "bin"), repo = path.join(dir, "repo"), log = path.join(dir, "calls.log");
  for (const d of [state, path.join(runs, "setup-x", "in"), etc, bin, path.join(repo, "dist/research-sandbox"), path.join(repo, "deploy/research-sandbox/e1b-sample")]) fs.mkdirSync(d, { recursive: true });
  const conf = path.join(etc, "preflight.json");
  fs.writeFileSync(conf, JSON.stringify({ version: 1, runId: "setup-x" }));
  if (!o.noSetup) {
    const s = path.join(state, "setup-20261105-000000-1"); fs.mkdirSync(s);
    fs.copyFileSync(conf, path.join(s, "preflight-config.json"));
    fs.writeFileSync(path.join(s, "preflight-report.json"), JSON.stringify(o.badReport ? { ...preflightReport, blockedOnlyByMeetsSpecBlockers: false } : preflightReport));
  }
  if (o.inputBusy) fs.writeFileSync(path.join(runs, "setup-x", "in", "other.json"), "{}");
  for (const f of ["trust-evidence-main.js", "negative-controls-main.js", "executor-main.js"]) fs.writeFileSync(path.join(repo, "dist/research-sandbox", f), "// fake\n");
  for (const f of ["fict-us-trend.json", "run-us-ma.json", "job.json"]) fs.copyFileSync(path.join(SAMPLE, f), path.join(repo, "deploy/research-sandbox/e1b-sample", f));
  const outs = path.join(dir, "outs"); fs.mkdirSync(outs);
  fs.writeFileSync(path.join(outs, "trust"), o.trust ?? trustDoc()); fs.writeFileSync(path.join(outs, "neg"), o.neg ?? negDoc()); fs.writeFileSync(path.join(outs, "exec"), o.exec ?? dryRun());
  const realNode = process.execPath;
  const fake = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  fake("node", `if [ "$1" = -e ]; then exec "${realNode}" "$@"; fi
echo "node $*" >> "${log}"
case "$1" in
  dist/research-sandbox/trust-evidence-main.js) cat "${outs}/trust"; exit ${o.trc ?? 4};;
  dist/research-sandbox/negative-controls-main.js) cat "${outs}/neg"; exit ${o.nrc ?? 0};;
  dist/research-sandbox/executor-main.js) ls "${path.join(runs, "setup-x", "in")}" >> "${log}"; cat "${outs}/exec"; exit ${o.erc ?? 1};;
esac; exit 9`);
  fake("id", 'if [ "$1" = -u ]; then echo 0; else exit 1; fi');
  fake("chown", "exit 0");
  fake("docker", `echo "docker $*" >> "${log}"; ${o.leftover ? 'echo "abc123"' : "true"}`);
  let text = TEXT;
  for (const [a, b] of [["CONF=/etc/research-sandbox/preflight.json", `CONF=${conf}`], ["STATE_ROOT=/var/lib/research-sandbox-setup", `STATE_ROOT=${state}`], ["RUNS_ROOT=/srv/research-runs", `RUNS_ROOT=${runs}`], ["DOCKER=/usr/bin/docker", `DOCKER=${path.join(bin, "docker")}`]]) {
    expect(text.split(a).length - 1, a).toBe(1); text = text.replace(a, b);
  }
  const script = path.join(dir, "e1b.sh"); fs.writeFileSync(script, text);
  const go = () => childProcess.spawnSync("bash", [script, "--execute"], { cwd: repo, encoding: "utf8", timeout: 60_000, env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir } });
  return { go, log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""), input: () => fs.readdirSync(path.join(runs, "setup-x", "in")).sort(), state };
}

describe("E1b: e1b-verify.sh simulated end to end", () => {
  it("normal run: REVIEW (exit 4), stages in order, sample staged before the executor, four evidence files and decodable pieces", () => {
    const h = setup();
    const r = h.go();
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stdout).toContain("REVIEW: preflight, negative controls and the gated executor dry run as expected");
    expect(r.stdout.indexOf("== 1/5")).toBeLessThan(r.stdout.indexOf("== 5/5"));
    expect(h.log()).toMatch(/executor-main\.js[\s\S]*fict-us-trend\.json\nrun-us-ma\.json/);
    expect(h.input()).toEqual(["fict-us-trend.json", "run-us-ma.json"]);
    const ev = fs.readdirSync(h.state).find((d) => d.startsWith("e1b-"))!;
    expect(fs.readdirSync(path.join(h.state, ev)).sort()).toEqual(["SHA256SUMS", "executor-dryrun.json", "executor-dryrun.log", "job.json", "negative-controls.json", "negative-controls.log", "preflight-report.json", "trust-evidence.json", "trust-evidence.log"]);
    const pieces = r.stdout.split("\n").filter((l) => /^\d+ [0-9a-f]{8} [A-Za-z0-9+/=]+$/.test(l));
    expect(pieces.length).toBeGreaterThan(0);
    const blob = Buffer.from(pieces.map((l) => l.split(" ")[2]).join(""), "base64");
    const t = path.join(dir, "x.tgz"); fs.writeFileSync(t, blob);
    expect(childProcess.execFileSync("tar", ["-tzf", t], { encoding: "utf8" }).split("\n").filter(Boolean).sort()).toEqual(["executor-dryrun.json", "negative-controls.json", "preflight-report.json", "trust-evidence.json"]);
  });
  it.each([
    ["no host-setup run", { noSetup: true }, "no host-setup run with the current configuration", "trust"],
    ["a preflight report that is not a pass", { badReport: true }, "does not show a pass refused only by M1/M3", "trust"],
    ["a trust tool failure", { trc: 3 }, "trust evidence collection failed (exit 3", "negative"],
    ["tampered trust evidence", { trust: trustDoc({ tamper: true }) }, "inconsistent: digest, review count", "negative"],
    ["host kernel versions in the trust evidence", { trust: trustDoc({ kernel: true }) }, "host kernel/OS versions present", "negative"],
    ["blocking trust findings", { trust: trustDoc({ blocking: true }), trc: 1 }, "trust evidence has blocking findings", "negative"],
    ["a failed negative control", { neg: negDoc(false), nrc: 1 }, "negative controls did not all behave as expected", "executor"],
    ["an executor that was NOT refused by the gate", { exec: dryRun(false), erc: 0 }, "was not refused by the gate as expected", "docker"],
    ["a research container left behind", { leftover: true }, "a research container exists", "5/5"],
  ])("%s: STOP (exit 1), later stages do not run", (_l, o, message, notReached) => {
    const h = setup(o);
    const r = h.go();
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout.split("\n").find((l) => l.startsWith("STOP: ")), r.stdout).toContain(message);
    if (notReached === "5/5") expect(r.stdout).not.toContain("== 5/5");
    else expect(h.log()).not.toContain(notReached === "docker" ? "docker " : `${notReached === "trust" ? "trust-evidence" : notReached === "negative" ? "negative-controls" : "executor"}-main.js`);
  });
  it("a non-empty input folder: STOP before staging, nothing in it changed, the executor never runs", () => {
    const h = setup({ inputBusy: true });
    const r = h.go();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("is not empty (nothing was changed");
    expect(h.input()).toEqual(["other.json"]);
    expect(h.log()).not.toContain("executor-main.js");
  });
  it("usage: anything but exactly --execute is refused (exit 2)", () => {
    for (const args of [[], ["--force"], ["--execute", "x"]]) expect(childProcess.spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" }).status).toBe(2);
  });
});
