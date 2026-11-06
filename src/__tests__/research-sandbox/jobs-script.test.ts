/**
 * E3: deploy/research-sandbox/jobs.sh (template, check, prepare, run, results, export).
 *
 * Static checks always run. The end-to-end checks drive the real script (its embedded JS, with only the three
 * documented constants pointed at a simulated host) against the REAL compiled research-sandbox modules, with Docker,
 * the executor and trust evidence replaced by fakes. They need root on Linux, a built dist/ and a uid-1000 account
 * (operator steps run as that user); otherwise they are skipped.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = fs.readFileSync(path.join(REPO, "deploy/research-sandbox/jobs.sh"), "utf8");
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const PINNED = "f7be90bfff9a9b030513e92611e771fb6dc2194e";

/** The JS embedded in the script's single heredoc. */
function embeddedJs(): string {
  const start = SCRIPT.indexOf("js() { \"$@\" <<'JS'\n");
  const end = SCRIPT.indexOf("\nJS\n}", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return SCRIPT.slice(start + "js() { \"$@\" <<'JS'\n".length, end);
}
const JS = embeddedJs();
/** The three documented constants, pointed at the simulated host (each must occur exactly once). */
function testJs(): string {
  let s = JS;
  for (const [a, b] of [
    ['const ROOT = "";', "const ROOT = process.env.T_ROOT;"],
    ['const DOCKER = "/usr/bin/docker";', "const DOCKER = process.env.T_DOCKER;"],
    ["const CODE = Object.freeze({", "const CODE = JSON.parse(process.env.T_MANIFEST); void Object.freeze({"],
  ]) {
    expect(s.split(a).length - 1).toBe(1);
    s = s.replace(a, b);
  }
  return s;
}

describe("E3 jobs.sh: static properties", () => {
  it("one heredoc; the shipped JS reads no environment except SUDO_UID and pins the same commit as the wrapper", () => {
    expect(SCRIPT.split("\nJS\n").length - 1).toBe(1);
    expect(JS.match(/process\.env\.[A-Z_]+/g)).toEqual(["process.env.SUDO_UID"]);
    expect(JS).toContain(`const COMMIT = "${PINNED}";`);
    expect(SCRIPT).toContain(`C=${PINNED}`);
    expect(JS).toContain('const ROOT = "";');
    expect(JS).toContain('const DOCKER = "/usr/bin/docker";');
  });

  it("the code manifest covers exactly the research-sandbox modules", () => {
    const m = /const CODE = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(JS)![1];
    const names = [...m.matchAll(/"([a-z-]+\.js)": "([0-9a-f]{64})"/g)].map((x) => x[1]).sort();
    const modules = fs.readdirSync(path.join(REPO, "src/research-sandbox")).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, ".js")).sort();
    expect(names).toEqual(modules);
  });

  it("no override, network, privileged or untrusted-execution paths; every evidence write is exclusive", () => {
    for (const bad of ["--network", "--privileged", "eval(", "new Function", "--no-verify", "skip", "override"]) expect(JS.includes(bad), bad).toBe(false);
    // Deletion appears only in: the prepare temp folder, the run folder's staged inputs (moved to evidence first) and the cleanup plan.
    expect((JS.match(/fs\.(rmSync|unlinkSync|rmdirSync)\(/g) ?? []).length).toBe(7);
    const writes = [...JS.matchAll(/fs\.writeFileSync\(([^\n]*)/g)].map((x) => x[1]);
    expect(writes.length).toBeGreaterThan(10);
    for (const w of writes) expect(w, w).toMatch(/flag: "wx"/);
    expect(SCRIPT).toContain("js sudo node - run");
    expect(SCRIPT).not.toMatch(/sudo node - (template|check|export-write)/);
  });
});

describe("E3 jobs.sh: format check (advisory) on its own", () => {
  // The lint section is pure functions of text; evaluate it alone with the one helper it uses.
  const sec = JS.slice(JS.indexOf("// ---------- advisory format check"), JS.indexOf("/** Advisory checks for one job folder's files"));
  const mod = new Function("clean", `${sec}; return { lintJob, lintDataset, lintConfig };`)((s: unknown, n = 300) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n));
  const sample = JSON.parse(fs.readFileSync(path.join(REPO, "deploy/research-sandbox/e1b-sample/fict-us-trend.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(REPO, "deploy/research-sandbox/e1b-sample/run-us-ma.json"), "utf8"));
  const ds = (edit: (d: any) => void) => { const d = structuredClone(sample); edit(d); return mod.lintDataset(JSON.stringify(d)).join("\n"); };
  const cf = (edit: (c: any) => void) => { const c = structuredClone(config); edit(c); return mod.lintConfig(JSON.stringify(c)).join("\n"); };

  it("the committed fictional sample and config pass", () => {
    expect(mod.lintDataset(JSON.stringify(sample))).toEqual([]);
    expect(mod.lintConfig(JSON.stringify(config))).toEqual([]);
    expect(mod.lintJob('{"version":1,"command":"trading-backtest","dataset":"prices.json","config":"run.json"}').issues).toEqual([]);
  });

  it.each([
    ["real-world source", (d: any) => { d.source.kind = "historical"; }, 'must be "fictional"'],
    ["high below low", (d: any) => { d.bars[3].high = "1.00"; }, "high must be the highest"],
    ["bars out of order", (d: any) => { d.bars[5].t = d.bars[2].t; }, "must be later than the previous bar"],
    ["a number instead of decimal text", (d: any) => { d.bars[0].close = 100; }, 'must be a decimal text, e.g. "101.25"'],
    ["a local time", (d: any) => { d.bars[0].t = "2026-03-01 21:00"; }, "must be a UTC time"],
    ["recorded before the last bar", (d: any) => { d.source.recordedAt = "2026-01-01T00:00:00Z"; }, "must not be earlier than the last bar"],
    ["intraday interval", (d: any) => { d.interval = "1h"; }, 'must be "1d"'],
    ["unknown key", (d: any) => { d.extra = 1; }, "dataset.extra: unknown key"],
    ["no bars", (d: any) => { d.bars = []; }, "must be a list of 1 to 50000"],
    ["lower-case symbol", (d: any) => { d.instrument.symbol = "fict"; }, "capital letters"],
  ])("dataset with %s: explained", (_l, edit, message) => {
    expect(ds(edit)).toContain(message);
  });

  it.each([
    ["fast >= slow", (c: any) => { c.strategy.fast = 9; }, '"fast" < "slow"'],
    ["unknown strategy", (c: any) => { c.strategy = { kind: "neural" }; }, "buy_and_hold or ma_crossover"],
    ["three decimals of cash", (c: any) => { c.initialCash.amount = "1.005"; }, "at most 2 decimals"],
    ["units with all_cash", (c: any) => { c.sizing = { mode: "all_cash", units: 3 }; }, "must not be given for all_cash"],
    ["huge slippage", (c: any) => { c.slippageBps = "5000"; }, "at most 1000"],
  ])("config with %s: explained", (_l, edit, message) => {
    expect(cf(edit)).toContain(message);
  });

  it("job.json problems are explained, and the issue list is capped", () => {
    expect(mod.lintJob('{"version":1,"command":"trading-live","dataset":"a.json"}').issues.join("\n")).toContain("trading-backtest");
    expect(mod.lintJob('{"version":1,"command":"trading-validate","dataset":"../x.json"}').issues.join("\n")).toContain("plain lower-case file name");
    expect(mod.lintJob("{").issues).toEqual(["job.json: not valid JSON"]);
    expect(mod.lintDataset(JSON.stringify({ ...sample, bars: sample.bars.map((b: any) => ({ ...b, open: 1 })) })).length).toBe(25);
  });
});

const CAN_RUN = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0 &&
  fs.existsSync(path.join(REPO, "dist/research-sandbox/executor.js")) && spawnSync("getent", ["passwd", "1000"]).status === 0 && fs.existsSync("/usr/bin/setpriv");

describe.skipIf(!CAN_RUN)("E3 jobs.sh end to end (simulated host, real compiled modules)", () => {
  let T = "", B = "", MAN = "", OPHOME = "", IN = "", OUT = "", APPROVALS = "", STATE = "";
  const JSRUN = testJs();
  const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", T_ROOT: `${T}/root`, T_DOCKER: `${T}/docker`, T_MANIFEST: MAN, T_IN: IN, ...extra });
  /** Root steps (as through sudo: SUDO_UID=1000). */
  const root = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ["-", ...args], { input: JSRUN, encoding: "utf8", env: { ...env(extra), SUDO_UID: "1000" }, cwd: T });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  /** Operator steps, as uid 1000. */
  const user = (args: string[]) => {
    const r = spawnSync("/usr/bin/setpriv", ["--reuid=1000", "--regid=1000", "--clear-groups", process.execPath, "-", ...args], { input: JSRUN, encoding: "utf8", env: { ...env(), HOME: OPHOME }, cwd: "/" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const prepare = (...jobs: string[]) => root(["prepare", B, `${OPHOME}/research-inputs`, ...jobs]);
  const run = (job: string, hash: string, extra: Record<string, string> = {}) => root(["run", B, `${OPHOME}/research-inputs`, job, hash], extra);
  const hashOf = (out: string, job: string) => new RegExp(`^APPROVAL ${job} ([0-9a-f]{64})$`, "m").exec(out)?.[1] ?? "";
  const template = (job: string, kind = "backtest") => user(["template", job, kind, `${OPHOME}/research-inputs`, path.join(REPO, "deploy/research-sandbox/e1b-sample")]);
  const jobDir = (job: string) => `${OPHOME}/research-inputs/${job}`;
  const asOp = (p: string) => fs.chownSync(p, 1000, 1000);
  const writeOp = (p: string, text: string) => { fs.writeFileSync(p, text, { mode: 0o644 }); fs.chmodSync(p, 0o644); asOp(p); };
  const editJson = (p: string, edit: (o: any) => void) => { const o = JSON.parse(fs.readFileSync(p, "utf8")); edit(o); writeOp(p, JSON.stringify(o, null, 2) + "\n"); };
  const used = () => fs.readdirSync(APPROVALS).filter((n) => n.endsWith(".used")).length;

  beforeAll(() => {
    T = fs.mkdtempSync("/tmp/automaton-jobs-test-");
    fs.chmodSync(T, 0o755);
    STATE = `${T}/root/var/lib/research-sandbox-setup`;
    APPROVALS = `${STATE}/e2-approvals`;
    for (const d of [`${T}/root/etc/research-sandbox`, `${STATE}/setup-x`, `${T}/root/srv/research-runs/setup-x/in`, `${T}/root/srv/research-runs/setup-x/out`, `${T}/root/usr/bin/gvisor-bin`]) fs.mkdirSync(d, { recursive: true, mode: 0o755 });
    fs.chmodSync(STATE, 0o700);
    IN = `${T}/root/srv/research-runs/setup-x/in`; OUT = `${T}/root/srv/research-runs/setup-x/out`;
    fs.writeFileSync(`${T}/root/usr/bin/runsc`, "fake runsc\n", { mode: 0o755 });
    fs.writeFileSync(`${T}/root/usr/bin/gvisor-bin/gvisor_sentry`, "fake sentry\n", { mode: 0o755 });
    const runscSha = sha(fs.readFileSync(`${T}/root/usr/bin/runsc`)), sentrySha = sha(fs.readFileSync(`${T}/root/usr/bin/gvisor-bin/gvisor_sentry`));
    const imageId = "sha256:3e8a7371ba841599f91a259089fd4bad1e0e5e0bda7feba0518a555b5e6d46c5";
    const gv = "Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016";
    const conf = JSON.stringify({ version: 1, runId: "setup-x", pins: { runscBinary: { path: "/usr/bin/runsc", sha256: runscSha, args: ["--oci-seccomp"], sidecars: [{ path: "/usr/bin/gvisor-bin/gvisor_sentry", sha256: sentrySha }] },
      dockerServerVersion: "29.9.3", dockerDataRoot: "/var/lib/docker", imageId, gvisorProcVersion: gv } });
    fs.writeFileSync(`${T}/root/etc/research-sandbox/preflight.json`, conf, { mode: 0o600 });
    fs.writeFileSync(`${STATE}/setup-x/preflight-config.json`, conf, { mode: 0o600 });
    fs.copyFileSync(path.join(REPO, "docs/evidence/e1b-preflight-report.json"), `${STATE}/setup-x/preflight-report.json`);
    for (const n of ["fict-us-trend.json", "run-us-ma.json"]) fs.copyFileSync(path.join(REPO, "deploy/research-sandbox/e1b-sample", n), path.join(IN, n));
    fs.writeFileSync(`${T}/docker`, `#!/bin/sh\ncase "$3 $4" in "image inspect") echo ${imageId};; "ps -aq") [ -f ${T}/leftover ] && echo deadbeef;; esac; exit 0\n`, { mode: 0o755 });
    // Build: the real compiled modules, with the executor, trust evidence and the scope's host pins replaced.
    B = `${T}/build`; const D = `${B}/dist/research-sandbox`; fs.mkdirSync(D, { recursive: true });
    for (const f of fs.readdirSync(path.join(REPO, "dist/research-sandbox")).filter((f) => f.endsWith(".js"))) fs.copyFileSync(path.join(REPO, "dist/research-sandbox", f), path.join(D, f));
    let scope = fs.readFileSync(path.join(D, "decision-scope.js"), "utf8");
    scope = scope.replace(/runscSha256: "[0-9a-f]{64}"/, `runscSha256: "${runscSha}"`).replace(/sidecars: Object\.freeze\(\[[\s\S]*?\]\),/, `sidecars: Object.freeze([Object.freeze({ path: "/usr/bin/gvisor-bin/gvisor_sentry", sha256: "${sentrySha}" })]),`);
    fs.writeFileSync(path.join(D, "decision-scope.js"), scope);
    fs.writeFileSync(path.join(D, "trust-evidence-main.js"), `import fs from "fs"; process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(REPO, "docs/evidence/e1b-trust-evidence.json"))}, "utf8")); process.exitCode = 4;\n`);
    fs.writeFileSync(path.join(D, "executor-main.js"), `import fs from "fs"; import crypto from "crypto"; import path from "path";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const m = process.env.X_MODE || "ok", a = process.argv, job = a[a.indexOf("--job") + 1], IN = process.env.T_IN;
const jt = fs.readFileSync(job), j = JSON.parse(jt.toString());
const inputs = [j.dataset, ...(j.config ? [j.config] : [])].map((n) => ({ name: n, sha256: sha(fs.readFileSync(path.join(IN, n))) }));
const r = { runner: "research-sandbox-executor", status: m === "refused" ? "refused" : "completed", violations: m === "refused" ? ["gate: refused"] : [],
  steps: m === "refused" ? ["inputs-checked", "preflight"] : ["inputs-checked","preflight","gate-passed","rechecked","create","inspect","run","inspect-after-run","report","removed-verified","runtime-rechecked"],
  report: m === "refused" ? null : "Backtest report for " + j.dataset + "\\n\\u001b[31mred\\u001b[0m\\n",
  audit: { startedAt: "2026-11-06T10:00:00.000Z", finishedAt: "2026-11-06T10:00:12.300Z", jobSha256: m === "swapjob" ? "0".repeat(64) : sha(jt), inputs, imageRef: "${imageId}", runtime: "runsc",
    preflight: { rating: m === "refused" ? "refused" : "meets-spec", violations: m === "refused" ? 2 : 0 }, researchExitCode: m === "refused" ? null : m === "cli1" ? 1 : 0,
    hostProcessEvidence: { polls: 18, sandboxProcesses: 2, canaryOnHost: 0, replacedExecutables: 0, overflow: false }, cleanup: { verifiedRemoved: true } } };
process.stdout.write(JSON.stringify(r)); process.exitCode = m === "refused" ? 1 : 0;\n`);
    const man: Record<string, string> = {};
    for (const f of fs.readdirSync(D).sort()) man[f] = sha(fs.readFileSync(path.join(D, f)));
    MAN = JSON.stringify(man);
    OPHOME = `${T}/home/op`; fs.mkdirSync(OPHOME, { recursive: true }); fs.chmodSync(`${T}/home`, 0o755); fs.chmodSync(OPHOME, 0o755); asOp(OPHOME);
  });
  afterAll(() => { if (T.startsWith("/tmp/automaton-jobs-test-")) fs.rmSync(T, { recursive: true, force: true }); });

  it("template creates operator-owned example jobs that pass check; an existing folder is never overwritten", () => {
    for (const [job, kind] of [["demo", "backtest"], ["val", "validate"], ["hold", "buy-and-hold"], ["second", "backtest"]]) {
      const r = template(job, kind);
      expect(r.code, r.out).toBe(0);
      for (const f of fs.readdirSync(jobDir(job))) { const s = fs.statSync(path.join(jobDir(job), f)); expect([s.uid, s.mode & 0o777]).toEqual([1000, 0o644]); }
    }
    const c = user(["check", `${OPHOME}/research-inputs`, "demo", "val", "hold"]);
    expect(c.code, c.out).toBe(0);
    expect(c.out.match(/: OK/g)?.length).toBe(3);
    expect(template("demo").out).toContain("already exists");
  });

  it("check explains malformed files and refuses unsafe folders (all as the operator; nothing runs)", () => {
    template("bad1"); editJson(`${jobDir("bad1")}/prices.json`, (d) => { d.source.kind = "historical"; d.bars[2].high = "1.00"; });
    template("bad2"); editJson(`${jobDir("bad2")}/run.json`, (c) => { c.strategy.fast = 20; });
    template("bad3"); fs.symlinkSync("/etc/hostname", `${jobDir("bad3")}/extra.json`);
    template("bad4"); writeOp(`${jobDir("bad4")}/notes.json`, "{}\n");
    template("bad5"); fs.chmodSync(jobDir("bad5"), 0o775);
    template("bad6"); writeOp(`${jobDir("bad6")}/prices.json`, "\ufeff{}");
    const r = user(["check", `${OPHOME}/research-inputs`, "bad1", "bad2", "bad3", "bad4", "bad5", "bad6", "missing"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('must be "fictional"');
    expect(r.out).toContain("high must be the highest");
    expect(r.out).toContain('"fast" < "slow"');
    expect(r.out).toMatch(/bad3: REFUSED .*ELOOP|bad3: REFUSED .*symbolic/);
    expect(r.out).toContain("bad4: REFUSED");
    expect(r.out).toContain("not writable by group or others");
    expect(r.out).toContain("byte-order mark");
    expect(r.out).toContain("missing: REFUSED");
  });

  it("operator and root steps refuse the wrong identity", () => {
    expect(root(["check", `${OPHOME}/research-inputs`, "demo"]).out).toContain("as yourself, not as root");
    expect(user(["results"]).out).toContain("needs sudo");
  });

  let h1 = "", h2 = "";
  it("prepare gives each job its own approval, rejects bad jobs individually, runs nothing and leaves nothing behind", () => {
    const before = fs.readdirSync(IN).sort();
    const r = prepare("demo", "hold", "bad1", "bad4");
    expect(r.code, r.out).toBe(1);
    h1 = hashOf(r.out, "demo"); h2 = hashOf(r.out, "hold");
    expect(h1).toMatch(/^[0-9a-f]{64}$/); expect(h2).toMatch(/^[0-9a-f]{64}$/); expect(h1).not.toBe(h2);
    expect(r.out).toContain("REFUSED  bad1"); expect(r.out).toContain("REFUSED  bad4");
    expect(r.out).toContain("format check found");
    expect(r.out).toContain("PREPARED 2 of 4");
    for (const h of [h1, h2]) { const s = fs.statSync(`${APPROVALS}/${h}.json`); expect([s.uid, s.mode & 0o777]).toEqual([0, 0o600]); expect(sha(fs.readFileSync(`${APPROVALS}/${h}.json`))).toBe(h); }
    expect(fs.readdirSync(STATE).filter((n) => n.startsWith("e2-prepare-"))).toEqual([]);
    expect(fs.readdirSync(IN).sort()).toEqual(before);
    expect(used()).toBe(0);
  });

  let ev1 = "";
  it("run executes exactly the approved job once (full hash), then the approval is consumed", () => {
    const r = run("demo", h1);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("RESULT: COMPLETED. The approval is consumed");
    expect(r.out).toContain("?[31mred?[0m"); // the untrusted report is shown sanitised
    ev1 = /Evidence \(root-only\): (e2-demo-\S+)/.exec(r.out)![1];
    expect(fs.readdirSync(IN)).toEqual([]);
    expect(fs.readdirSync(`${STATE}/${ev1}/previous-inputs`).sort()).toEqual(["fict-us-trend.json", "run-us-ma.json"]);
    expect(fs.readdirSync(`${STATE}/${ev1}/inputs`).sort()).toEqual(["prices.json", "run.json"]);
    expect(fs.existsSync(`${APPROVALS}/${h1}.used`)).toBe(true);
    expect(fs.readFileSync(`${STATE}/e2-runs.log`, "utf8")).toMatch(new RegExp(`demo ${h1} COMPLETED runtime=[0-9.]+s report=[0-9a-f]{64} ${ev1}`));
    const again = run("demo", h1);
    expect(again.out).toContain("already used");
    expect(again.out).toContain("STOP before anything was staged");
  });

  it("run accepts a unique 16-character prefix of the approval hash; unknown and too-short prefixes are refused", () => {
    expect(run("hold", "0123456789abcdef").out).toContain("no approval starts with");
    expect(root(["run", B, `${OPHOME}/research-inputs`, "hold", "abc"]).code).toBe(2);
    const r = run("hold", h2.slice(0, 16));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`full approval hash: ${h2}`);
  });

  it("results lists runs with runtime, gVisor evidence, cleanup and report hash; details include input hashes", () => {
    const r = root(["results", "10"]);
    expect(r.out).toMatch(new RegExp(`demo\\s+COMPLETED\\s+12\\.3 s\\s+2\\s+0\\s+yes`));
    expect(r.out).toContain(ev1);
    const d = JSON.parse(root(["results", ev1]).out);
    expect(d).toMatchObject({ job: "demo", approval: h1, outcome: "COMPLETED", runtimeSeconds: 12.3, cleanupVerified: true, evidenceIntact: true, commit: PINNED,
      gvisor: { samples: 18, sandboxProcesses: 2, researchScriptOnHost: 0, replacedExecutables: 0 } });
    expect(Object.keys(d.inputs).sort()).toEqual(["prices.json", "run.json"]);
    expect(d.reportSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("export writes report, summary and checksums as the operator, owner-only; never overwrites; flags changed evidence", () => {
    const bundle = `${T}/bundle.json`;
    const read = root(["export-read", ev1]);
    fs.writeFileSync(bundle, read.out); fs.chmodSync(bundle, 0o644);
    const w = user(["export-write", ev1, `${OPHOME}/research-results`, bundle]);
    expect(w.code, w.out).toBe(0);
    const dir = `${OPHOME}/research-results/${ev1}`;
    for (const f of ["report.txt", "summary.json", "SHA256SUMS"]) { const s = fs.statSync(`${dir}/${f}`); expect([s.uid, s.mode & 0o777]).toEqual([1000, 0o600]); }
    for (const line of fs.readFileSync(`${dir}/SHA256SUMS`, "utf8").trim().split("\n")) { const [h, f] = line.split("  "); expect(sha(fs.readFileSync(`${dir}/${f}`))).toBe(h); }
    expect(fs.readFileSync(`${dir}/report.txt`, "utf8")).not.toMatch(/[^\x20-\x7e\n\t]/);
    expect(user(["export-write", ev1, `${OPHOME}/research-results`, bundle]).out).toContain("STOP");
    fs.appendFileSync(`${STATE}/${ev1}/report.txt`, "tampered\n");
    expect(root(["results", "10"]).out).toContain("(EVIDENCE CHANGED)");
    expect(JSON.parse(root(["export-read", ev1]).out).summary.evidenceIntact).toBe(false);
  });

  it("integrity labels: stopped-before-the-job is not reported as changed; a run without checksums is NOT SEALED", () => {
    template("lbl"); const h = hashOf(prepare("lbl").out, "lbl");
    fs.writeFileSync(`${T}/leftover`, ""); run("lbl", h); fs.unlinkSync(`${T}/leftover`); // stops before the job
    const stopped = fs.readdirSync(STATE).filter((n) => n.startsWith("e2-lbl-")).sort().pop()!;
    const d = JSON.parse(root(["results", stopped]).out);
    expect([d.outcome, d.integrity, d.evidenceIntact]).toEqual(["STOPPED BEFORE THE JOB", "not applicable", null]);
    const table = root(["results", "100"]).out.split("\n").find((l) => l.includes(stopped))!;
    expect(table).not.toContain("EVIDENCE CHANGED");
    expect(table).not.toContain("NOT SEALED");
    template("seal"); const h2 = hashOf(prepare("seal").out, "seal");
    const r = run("seal", h2); const ev = /Evidence \(root-only\): (e2-seal-\S+)/.exec(r.out)![1];
    fs.unlinkSync(`${STATE}/${ev}/SHA256SUMS`);
    expect(root(["results", "100"]).out.split("\n").find((l) => l.includes(ev))).toContain("NOT SEALED");
    expect(JSON.parse(root(["results", ev]).out)).toMatchObject({ integrity: "NOT SEALED", evidenceIntact: false });
  });

  it("cleanup is list-only by default and never lists evidence, reports, logs or used approvals", () => {
    // Candidates: one expired unused approval, an interrupted-prepare folder, the operator's build folders.
    template("exp"); const h = hashOf(prepare("exp").out, "exp");
    const m = JSON.parse(fs.readFileSync(`${APPROVALS}/${h}.json`, "utf8")); m.createdAt = new Date(Date.now() - 30 * 3600e3).toISOString();
    const b = Buffer.from(JSON.stringify(m, null, 2) + "\n"); const old = sha(b); fs.writeFileSync(`${APPROVALS}/${old}.json`, b, { mode: 0o600 });
    const usedOld = sha(Buffer.from("used-and-old")); fs.writeFileSync(`${APPROVALS}/${usedOld}.json`, b, { mode: 0o600 }); fs.writeFileSync(`${APPROVALS}/${usedOld}.used`, "x", { mode: 0o600 });
    fs.mkdirSync(`${STATE}/e2-prepare-exp-20261101-000000-aaaaaa`, { mode: 0o700 });
    fs.mkdirSync(`${T}/root/tmp`, { recursive: true }); fs.chmodSync(`${T}/root/tmp`, 0o1777); // like the real /tmp
    fs.mkdirSync(`${T}/root/tmp/e3-build.AbC123`); asOp(`${T}/root/tmp/e3-build.AbC123`); fs.writeFileSync(`${T}/root/tmp/e3-build.AbC123/x.js`, "x");
    fs.mkdirSync(`${T}/root/tmp/e2-build.root01`); // owned by root, not the operator: never listed
    fs.symlinkSync("/etc", `${T}/root/tmp/e3-build.LiNk01`); // a link: never listed
    const before = (d: string) => fs.readdirSync(d).sort();
    const keep = { state: before(STATE), approvals: before(APPROVALS) };
    const dry = root(["cleanup"]);
    expect(dry.code, dry.out).toBe(0);
    const listed = [...dry.out.matchAll(/^  (\S+)\s+(\/\S+)$/gm)].map((x) => `${x[1]} ${x[2]}`).sort();
    expect(listed).toEqual([
      `expired-unused-approval /var/lib/research-sandbox-setup/e2-approvals/${old}.json`,
      "interrupted-prepare-folder /var/lib/research-sandbox-setup/e2-prepare-exp-20261101-000000-aaaaaa",
      "temporary-build-folder /tmp/e3-build.AbC123",
    ]);
    expect(dry.out).toContain("DRY RUN: nothing was deleted");
    expect([before(STATE), before(APPROVALS)]).toEqual([keep.state, keep.approvals]);
    const plan = /cleanup --delete ([0-9a-f]{64})/.exec(dry.out)![1];
    // A wrong hash, or a list that changed after the dry run: nothing is deleted.
    expect(root(["cleanup", "--delete", "0".repeat(64)]).out).toContain("Nothing was deleted");
    fs.mkdirSync(`${T}/root/tmp/e2-build.NeW999`); asOp(`${T}/root/tmp/e2-build.NeW999`);
    const changed = root(["cleanup", "--delete", plan]);
    expect(changed.code).toBe(1); expect(changed.out).toContain("the plan hash does not match");
    expect([before(STATE), before(APPROVALS)]).toEqual([keep.state, keep.approvals]);
    fs.rmdirSync(`${T}/root/tmp/e2-build.NeW999`);
    // The exact plan deletes exactly the listed paths and records it; evidence, logs and used approvals stay.
    const del = root(["cleanup", "--delete", plan]);
    expect(del.code, del.out).toBe(0);
    expect(del.out).toContain("deleted 3 of 3 listed path(s)");
    expect(fs.existsSync(`${APPROVALS}/${old}.json`)).toBe(false);
    expect(fs.existsSync(`${T}/root/tmp/e3-build.AbC123`)).toBe(false); // removed with the operator's privileges
    expect(fs.existsSync(`${APPROVALS}/${h}.json`)).toBe(true);
    expect(fs.existsSync(`${APPROVALS}/${usedOld}.json`) && fs.existsSync(`${APPROVALS}/${usedOld}.used`)).toBe(true);
    expect(fs.existsSync(`${T}/root/tmp/e2-build.root01`) && fs.lstatSync(`${T}/root/tmp/e3-build.LiNk01`).isSymbolicLink() && fs.existsSync("/etc/hostname")).toBe(true);
    expect(before(STATE).filter((n) => !n.startsWith("e2-prepare-") && n !== "e4-cleanup.log")).toEqual(keep.state.filter((n) => !n.startsWith("e2-prepare-")));
    expect(fs.existsSync(`${STATE}/e2-runs.log`)).toBe(true);
    expect(fs.readFileSync(`${STATE}/e4-cleanup.log`, "utf8")).toContain(`plan=${plan} deleted=3/3`);
    expect(root(["cleanup"]).out).toContain("Nothing to clean up");
    expect(user(["cleanup"]).out).toContain("needs sudo");
  });

  it("tampering after approval stops before staging and leaves the approval unused", () => {
    template("t1"); let h = hashOf(prepare("t1").out, "t1");
    editJson(`${jobDir("t1")}/run.json`, (c) => { c.slippageBps = "3"; });
    let r = run("t1", h);
    expect(r.out).toContain("FAIL  inputs (names, sizes, sha256)");
    expect(r.out).toContain("STOP before staging");
    expect(fs.existsSync(`${APPROVALS}/${h}.used`)).toBe(false);
    template("t2"); h = hashOf(prepare("t2").out, "t2");
    fs.appendFileSync(`${APPROVALS}/${h}.json`, " ");
    expect(run("t2", h).out).toContain("FAIL  approval manifest hashes to the given approval hash");
    template("t3"); h = hashOf(prepare("t3").out, "t3");
    r = run("t2", h);
    expect(r.out).toContain("FAIL  manifest kind / job / operator / commit");
    expect(fs.existsSync(`${APPROVALS}/${h}.used`)).toBe(false);
  });

  it("an expired approval is refused", () => {
    template("old"); const h = hashOf(prepare("old").out, "old");
    const m = JSON.parse(fs.readFileSync(`${APPROVALS}/${h}.json`, "utf8")); m.createdAt = new Date(Date.now() - 25 * 3600e3).toISOString();
    const b = Buffer.from(JSON.stringify(m, null, 2) + "\n"); const h2x = sha(b); fs.writeFileSync(`${APPROVALS}/${h2x}.json`, b, { mode: 0o600 });
    expect(run("old", h2x).out).toContain("approval age 1500 min (at most 24 h)");
  });

  it("fail closed: leftover container, changed compiled code, refused gate, a different job executed", () => {
    template("f1"); let h = hashOf(prepare("f1").out, "f1");
    fs.writeFileSync(`${T}/leftover`, "");
    let r = run("f1", h);
    fs.unlinkSync(`${T}/leftover`);
    expect(r.out).toContain("1 research-sandbox container(s)");
    expect(fs.existsSync(`${APPROVALS}/${h}.used`)).toBe(false);
    const ex = `${B}/dist/research-sandbox/executor.js`, orig = fs.readFileSync(ex);
    fs.appendFileSync(ex, "\n// changed\n");
    r = run("f1", h);
    fs.writeFileSync(ex, orig);
    expect(r.out).toContain("compiled executor.js: does not match");
    expect(fs.existsSync(`${APPROVALS}/${h}.used`)).toBe(false);
    r = run("f1", h, { X_MODE: "refused" });
    expect(r.out).toContain('FAIL  status: got ["research-sandbox-executor","refused"]');
    expect(r.out).toContain("The approval is consumed; do not retry");
    expect(fs.readdirSync(IN)).toEqual([]);
    template("f2"); h = hashOf(prepare("f2").out, "f2");
    r = run("f2", h, { X_MODE: "swapjob" });
    expect(r.out).toContain("FAIL  job and inputs the executor ran");
    template("f3"); h = hashOf(prepare("f3").out, "f3");
    r = run("f3", h, { X_MODE: "cli1" });
    expect(r.code).toBe(3);
    expect(r.out).toContain("RESULT: COMPLETED: INPUT REFUSED BY THE RESEARCH CLI");
  });
});
