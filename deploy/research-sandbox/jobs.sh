#!/usr/bin/env bash
# Automaton research jobs on the approved VPS (E3). Offline, fictional data only; one job per approval.
#   template <job> [backtest|validate|buy-and-hold]   create ~/research-inputs/<job>/ from the committed fictional sample
#   check <job> [<job>...]                            format check of the files (advisory; runs no research)
#   prepare <job> [<job>...]                          root-only, single-use approval per job (runs no research)
#   run <job> <approval-hash>                         exactly one approved job under gVisor (hash or unique 16+ prefix)
#   results [<n> | <evidence>]                        recent runs, or one run's summary
#   export <evidence>                                 copy report + summary to ~/research-results/<evidence>/
( set -u
CMD=${1:-}; [ "$#" -gt 0 ] && shift
C=f7be90bfff9a9b030513e92611e771fb6dc2194e
IN="$HOME/research-inputs"
usage() { sed -n '3,8p' "$0" 2>/dev/null | sed 's/^# *//'; [ -s "$0" ] || echo "Usage: template|check|prepare|run|results|export (see docs/E3-OPERATOR-GUIDE.md)"; exit 2; }
okjob() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; }
stop() { echo "STOP: $* (nothing was run)"; exit 1; }
js() { "$@" <<'JS'
// E3 research jobs (shared by every step). Modes: template, check, export-write (as the operator); prepare, run,
// results, export-read (as root through sudo). Datasets and reports are untrusted: nothing here interprets them
// beyond JSON shape checks, and reports are only ever shown or written as sanitised plain text.
const fs = require("fs"), cp = require("child_process"), crypto = require("crypto"), path = require("path");
const ROOT = "";
const DOCKER = "/usr/bin/docker";
const COMMIT = "f7be90bfff9a9b030513e92611e771fb6dc2194e";
const CONF = ROOT + "/etc/research-sandbox/preflight.json", STATE = ROOT + "/var/lib/research-sandbox-setup";
const APPROVALS = `${STATE}/e2-approvals`, RUNLOG = `${STATE}/e2-runs.log`;
const E1B_REPORT = "f9640ccea26832e65a008333b267c35bfca0fcd7398019593620350370ff8225";
const APPROVAL_TTL_MS = 24 * 3600 * 1000;
/** SHA-256 of every compiled dist/research-sandbox/*.js at the pinned commit (tsc 5.9.3; reproducible). */
const CODE = Object.freeze({
  "canary-probe.js": "be74f78a8c0341d19be08810ead19e5b7a980c34efa181461564f929bd215bc7",
  "canary.js": "11c90b1eb58b4bf0cbecd5da6c2cbf4ce65c055faf0e73be45aa18de94c7c36f",
  "decision-scope.js": "11f2de31ab56cbf7960ccda01520dcb2db41ea96aeb0a052269b0f841ae6b7a3",
  "engine.js": "37c2b6a510ba15867318cfb4b67d2e750abb74743ec5c97aed2f1333ad0c3d95",
  "executor-main.js": "238d5c0be44c79b443dcff736ece928bbfd75c6c290b180c8aa05dd5cdc4c7df",
  "executor.js": "042dc7b66d626d2f2140a0459a5095a00128d44ea9d951e94512ee625033a6e1",
  "host-paths.js": "722eb51b807568ce8c15eb3db79f02f4ee3385304809e6fe69398f7332c6ef29",
  "host-processes.js": "2785229a26b672b27df1fe62473abb0d8835a82871fb94f53673188cf11b9600",
  "index.js": "35f05ad908b1bcb2834f5a427f8869ec4832ed7d18d3d3cfea0349ef589bdebf",
  "inspect.js": "86309cfa91d5d11adb020c5fb4bc2c7211b5de598e76169111f0f5c51b2a06f2",
  "negative-controls-main.js": "0c8c5cfad567cda6f859ed22c4d7f60bfdf8c7ddab345b00164bd07622e1d24c",
  "negative-controls.js": "c52a7e144b83967524da6c55649c206b41ba34b1cb4fe2c59b59f6814c8c5257",
  "preflight-main.js": "053f99fd97340f583e5d0685f92e31ea7376bf9203ded860b16f2d969e8725c5",
  "preflight.js": "67833e46ce2d88c8360eab2f1b7c82a02cacd24c00cfd6768b441e97e92d0c55",
  "research-image.js": "6be5b346e3d985c3eeac360c2b2facee2ba95d1005d917292497255d7e511443",
  "runner.js": "34ca5b69e9d48e7027784a76db44b4f4c59036fa08a8c1b3ad287f4fb6b7b1a7",
  "spec.js": "161e4b699c3ebedba8fbb67b763e43f73ed54ed25803539b5fbdec9fbc81d84d",
  "trust-evidence-main.js": "b12c637daf98f5f904165d62886b85dd94accfc1859135e1eb66d7bc78f6876f",
  "trust-evidence.js": "885a42cde8318a866bb5ce44d28213266762fb79c51ee8b30c98fa0b2ab38c1e"
});
const STEPS = ["inputs-checked", "preflight", "gate-passed", "rechecked", "create", "inspect", "run", "inspect-after-run", "report", "removed-verified", "runtime-rechecked"];
const E = { daemonJson: "2a35d833a5f8b7712711f26aae439d668fd5ca7620b99a4f8455a50a8c911da3", argv: ["/usr/bin/dockerd", "-H", "fd://", "--containerd=/run/containerd/containerd.sock"],
  pkgs: { "docker-ce": "5:29.9.3-1~ubuntu.24.04~noble", "docker-ce-cli": "5:29.9.3-1~ubuntu.24.04~noble", "containerd.io": "2.4.2-3~ubuntu.24.04~noble", runsc: "20261102.0" },
  secopts: ["name=apparmor,profile=default", "name=seccomp,profile=builtin", "name=cgroupns"],
  keyrings: { "9DC858229FC7DD38854AE2D88D81803C0EBFCD88": "1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570", "6F1DF85E3A71C24918E727D56FC6D554E32BD943": "6980344d5d10b0fe4dea6b0a8a3f12a50ff1b2f3f81c40fed43dd942eace0184" } };
const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/, HASH = /^[0-9a-f]{64}$/;
let fails = 0;
const ok = (m) => console.log("  ok    " + m);
const bad = (m) => { fails += 1; console.log("  FAIL  " + m); };
const info = (m) => console.log("  info  " + m);
const clean = (s, n = 300) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);
const canon = (x) => Array.isArray(x) ? x.map(canon) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));   // key order never matters
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const chk = (name, got, want) => (same(got, want) ? ok : bad)(`${name}${same(got, want) ? "" : `: got ${clean(JSON.stringify(got === undefined ? null : got), 200)}`}`);
function step(name, fn) { try { return fn(); } catch (e) { bad(`${name}: ${clean(e.message, 220)}`); } }
let PREP_EV = null;
const stopNow = (msg) => { if (PREP_EV) { try { fs.rmSync(PREP_EV, { recursive: true, force: true }); } catch {} }
  console.log(`\nRESULT: STOP${msg ? " " + msg : ""} (${fails} problem(s) above). No research container was created; the approval (if any) was not consumed. Send this output.`); process.exitCode = 1; };
const docker = (args, timeout = 30000) => cp.spawnSync(DOCKER, ["--host", "unix:///var/run/docker.sock", ...args], { encoding: "utf8", timeout });
const st = (p) => { try { const s = fs.lstatSync(p); return `${s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other"} uid ${s.uid} gid ${s.gid} mode ${(s.mode & 0o777).toString(8)}`; } catch { return "MISSING"; } };
function leftovers(label) {
  const r = docker(["ps", "-aq", "--filter", "name=research-sandbox-"]);
  if (r.error || r.status !== 0) return bad(`${label}: docker ps failed (exit ${r.status}): ${clean(r.stderr, 200)}`);
  const ids = r.stdout.split("\n").filter(Boolean);
  (ids.length === 0 ? ok : bad)(`${label}: ${ids.length} research-sandbox container(s)${ids.length ? " " + clean(ids.join(" "), 200) + " (inspect and remove manually)" : ""}`);
}
/** Reads a root-only file (regular, root:root, no group/other access) without following links. */
function readRootFile(p, maxBytes) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { const s = fs.fstatSync(fd); if (!s.isFile() || s.uid !== 0 || (s.mode & 0o077) !== 0 || s.size > maxBytes) throw new Error(`not a root-only regular file of at most ${maxBytes} bytes (${st(p)})`); return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
/**
 * The operator's job folder, opened component by component without following any link (via /proc/self/fd, an
 * openat equivalent), so a path swapped after checking can't redirect the reads. Returns the folder's fd.
 */
function openDirNoFollow(abs) {
  if (!path.isAbsolute(abs) || abs.split("/").some((c) => c === ".." || c === ".")) throw new Error("job folder: not a plain absolute path");
  let fd = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  for (const c of abs.split("/").filter(Boolean)) {
    let next; try { next = fs.openSync(`/proc/self/fd/${fd}/${c}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
    catch (e) { throw new Error(`job folder: path component ${JSON.stringify(clean(c, 60))} is missing, not a directory, or a symbolic link (${clean(e.code, 12)})`); }
    finally { fs.closeSync(fd); }
    fd = next;
  }
  return fd;
}
/**
 * Reads the operator's job folder: exactly the expected regular files, each owned by the operator, one link,
 * not group/other writable, within its cap, read through the opened folder fd with O_NOFOLLOW. The bytes read here
 * are the only bytes ever used (hashed, staged and approved); the folder is never re-read by path.
 */
function readJobFolder(dir, operatorUid, capFor) {
  const dfd = openDirNoFollow(dir);
  try {
    const ds = fs.fstatSync(dfd);
    if (ds.uid !== operatorUid || (ds.mode & 0o022) !== 0) throw new Error(`job folder must be owned by the operator (uid ${operatorUid}) and not writable by group or others (uid ${ds.uid} mode ${(ds.mode & 0o777).toString(8)})`);
    const names = fs.readdirSync(`/proc/self/fd/${dfd}`).sort();
    const files = {};
    for (const n of names) {
      const cap = capFor(n);
      if (!Number.isInteger(cap)) throw new Error(`job folder holds an unexpected entry ${JSON.stringify(clean(n, 60))} (it must hold exactly job.json and the files job.json names)`);
      const fd = fs.openSync(`/proc/self/fd/${dfd}/${n}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const s = fs.fstatSync(fd);
        if (!s.isFile()) throw new Error(`${n}: not a regular file`);
        if (s.uid !== operatorUid) throw new Error(`${n}: must be owned by the operator (uid ${operatorUid}), not uid ${s.uid}`);
        if (s.nlink !== 1) throw new Error(`${n}: has ${s.nlink} hard links (exactly 1 required)`);
        if ((s.mode & 0o022) !== 0) throw new Error(`${n}: writable by group or others`);
        if (s.size > cap) throw new Error(`${n}: ${s.size} bytes; the limit is ${cap}`);
        const b = Buffer.alloc(cap + 1); let total = 0, k;
        while ((k = fs.readSync(fd, b, total, b.length - total, null)) > 0) { total += k; if (total > cap) throw new Error(`${n}: grew beyond ${cap} bytes while being read`); }
        files[n] = Buffer.from(b.subarray(0, total));
      } finally { fs.closeSync(fd); }
    }
    return files;
  } finally { fs.closeSync(dfd); }
}
/** Untrusted file content: only checked to be UTF-8 JSON (never interpreted, executed or rendered here). */
function checkJsonText(name, b) {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) throw new Error(`${name}: starts with a byte-order mark`);
  let t; try { t = new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { throw new Error(`${name}: not valid UTF-8`); }
  try { JSON.parse(t); } catch { throw new Error(`${name}: not valid JSON`); }
  return t;
}

// ---------- advisory format check (no research code runs here; the research CLI inside gVisor is authoritative) ----------
const SAMPLE = { "fict-us-trend.json": "2972fd453c39196eaee5a9fb6b662cb92e63ae9160e48dcdea2b9fe6d6961837", "run-us-ma.json": "2608ded501ca25be891b9aa4e1735721f34a4be6fcedc91f1b3cf1275592da1c" };
const DEC = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,8})?$/, TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/, ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FX = ["USD", "GBP", "EUR", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK"], MAX_BARS = 50000, MAX_ISSUES = 25;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const decimal = (v) => (typeof v === "string" && DEC.test(v) ? Number(v) : null);
/** Lints job.json, returning the issues (each "path: message") and the file names it names. */
function lintJob(text) {
  const out = [];
  let o; try { o = JSON.parse(text); } catch { return { issues: ["job.json: not valid JSON"], names: [] }; }
  if (!isObj(o)) return { issues: ["job.json: must be a JSON object"], names: [] };
  const name = /^[a-z0-9][a-z0-9._-]{0,63}\.json$/;
  if (o.version !== 1) out.push("job.version: must be 1");
  if (o.command !== "trading-backtest" && o.command !== "trading-validate") out.push('job.command: must be "trading-backtest" or "trading-validate"');
  const allowed = o.command === "trading-backtest" ? ["version", "command", "dataset", "config"] : ["version", "command", "dataset"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push(`job.${clean(k, 30)}: not allowed for ${clean(o.command, 30)}`);
  if (typeof o.dataset !== "string" || !name.test(o.dataset) || o.dataset === "job.json") out.push('job.dataset: must be a plain lower-case file name ending in .json, e.g. "prices.json"');
  if (o.command === "trading-backtest" && (typeof o.config !== "string" || !name.test(o.config) || o.config === "job.json" || o.config === o.dataset)) out.push('job.config: must be a different plain lower-case .json file name, e.g. "run.json"');
  return { issues: out, names: [o.dataset, ...(o.command === "trading-backtest" ? [o.config] : [])].filter((n) => typeof n === "string") };
}
function lintDataset(text) {
  const out = [], add = (p, m) => { if (out.length < MAX_ISSUES) out.push(`${p}: ${m}`); };
  let d; try { d = JSON.parse(text); } catch (e) { return [`dataset: not valid JSON (${clean(e.message, 80)})`]; }
  if (!isObj(d)) return ["dataset: must be a JSON object"];
  const keys = ["version", "id", "title", "source", "adjustment", "interval", "annualization", "limitations", "instrument", "costs", "bars"];
  for (const k of Object.keys(d)) if (!keys.includes(k)) add(`dataset.${clean(k, 30)}`, "unknown key");
  for (const k of keys) if (!(k in d)) add(`dataset.${k}`, "is required");
  if (d.version !== 1) add("dataset.version", "must be 1");
  if (typeof d.id !== "string" || !ID.test(d.id)) add("dataset.id", "must be lower-case letters, digits, '_' or '-' (at most 64)");
  if (typeof d.title !== "string" || d.title.trim() === "") add("dataset.title", "must be a non-empty text");
  const s = d.source;
  if (!isObj(s)) add("dataset.source", "must be an object { kind, label, recordedBy, recordedAt }");
  else {
    if (s.kind !== "fictional") add("dataset.source.kind", 'must be "fictional": only fictional, operator-authored data is accepted in this phase');
    for (const k of ["label", "recordedBy"]) if (typeof s[k] !== "string" || s[k].trim() === "") add(`dataset.source.${k}`, "must be a non-empty text");
    if (typeof s.recordedAt !== "string" || !TS.test(s.recordedAt)) add("dataset.source.recordedAt", 'must be a UTC time like "2026-04-01T00:00:00Z"');
  }
  if (!["none", "splits", "splits_and_dividends", "not_applicable"].includes(d.adjustment)) add("dataset.adjustment", "must be none, splits, splits_and_dividends (stocks) or not_applicable (forex)");
  if (d.interval !== "1d") add("dataset.interval", 'must be "1d" (daily bars)');
  if (!isObj(d.annualization) || !Number.isInteger(d.annualization.periodsPerYear) || d.annualization.periodsPerYear < 1 || typeof d.annualization.basis !== "string") add("dataset.annualization", 'must be { "periodsPerYear": <whole number, e.g. 252>, "basis": "<why>" }');
  if (!Array.isArray(d.limitations) || d.limitations.some((x) => typeof x !== "string")) add("dataset.limitations", "must be a list of texts (may be empty)");
  const i = d.instrument;
  if (!isObj(i)) add("dataset.instrument", "must be an object");
  else {
    if (!["us_equity", "uk_equity", "fx"].includes(i.assetClass)) add("dataset.instrument.assetClass", "must be us_equity, uk_equity or fx");
    if (i.assetClass === "us_equity" && (typeof i.symbol !== "string" || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(i.symbol))) add("dataset.instrument.symbol", 'must be 1-5 capital letters, e.g. "FICT"');
    if (i.assetClass === "uk_equity" && (typeof i.symbol !== "string" || !/^[A-Z0-9]{2,5}(\.[A-Z])?$/.test(i.symbol))) add("dataset.instrument.symbol", "must be 2-5 capital letters or digits");
    if (i.assetClass === "us_equity" && i.priceUnit !== "USD") add("dataset.instrument.priceUnit", 'must be "USD" for us_equity');
    if (i.assetClass === "uk_equity" && !["GBP", "GBX"].includes(i.priceUnit)) add("dataset.instrument.priceUnit", 'must be "GBP" or "GBX" for uk_equity');
    if (i.assetClass === "fx" && (!FX.includes(i.base) || !FX.includes(i.quote) || i.base === i.quote)) add("dataset.instrument", `fx needs different base and quote from ${FX.join(", ")}`);
    if (i.assetClass !== "fx" && decimal(i.tickSize) === null) add("dataset.instrument.tickSize", 'must be a decimal text, e.g. "0.01"');
    if (typeof i.name !== "string" || i.name.trim() === "") add("dataset.instrument.name", "must be a non-empty text");
    if (i.assetClass === "us_equity" && d.adjustment === "not_applicable") add("dataset.adjustment", "must be none, splits or splits_and_dividends for stocks");
    if (i.assetClass === "fx" && d.adjustment !== "not_applicable") add("dataset.adjustment", "must be not_applicable for forex");
  }
  const c = d.costs;
  let perBar = false;
  if (!isObj(c) || !isObj(c.spread) || !isObj(c.fees)) add("dataset.costs", 'must be { "spread": {...}, "fees": {...} }');
  else {
    perBar = c.spread.mode === "per_bar";
    if (!["fixed", "per_bar"].includes(c.spread.mode)) add("dataset.costs.spread.mode", "must be fixed or per_bar");
    if (c.spread.mode === "fixed" && decimal(c.spread.value) === null) add("dataset.costs.spread.value", 'must be a decimal text, e.g. "0.02"');
    if (decimal(c.fees.perOrder) === null) add("dataset.costs.fees.perOrder", 'must be a decimal text, e.g. "1.00"');
    if (decimal(c.fees.proportionalBps) === null) add("dataset.costs.fees.proportionalBps", 'must be a decimal text, e.g. "0"');
  }
  const b = d.bars;
  if (!Array.isArray(b) || b.length < 1 || b.length > MAX_BARS) add("dataset.bars", `must be a list of 1 to ${MAX_BARS} daily bars`);
  else {
    let prev = null;
    b.forEach((x, n) => {
      const p = `dataset.bars[${n}]`;
      if (!isObj(x)) return add(p, 'must be { "t", "open", "high", "low", "close", "volume" }');
      const ok = ["t", "open", "high", "low", "close", "volume", ...(perBar ? ["spread"] : [])];
      for (const k of Object.keys(x)) if (!ok.includes(k)) add(`${p}.${clean(k, 20)}`, "unknown key");
      if (typeof x.t !== "string" || !TS.test(x.t)) add(`${p}.t`, 'must be a UTC time like "2026-03-02T21:00:00Z"');
      else { if (prev !== null && x.t <= prev) add(`${p}.t`, "must be later than the previous bar"); prev = x.t; }
      const v = Object.fromEntries(["open", "high", "low", "close"].map((k) => [k, decimal(x[k])]));
      for (const [k, val] of Object.entries(v)) if (val === null) add(`${p}.${k}`, 'must be a decimal text, e.g. "101.25"');
      if (Object.values(v).every((y) => y !== null) && (v.high < Math.max(v.open, v.close, v.low) || v.low > Math.min(v.open, v.close))) add(p, "high must be the highest and low the lowest of open, high, low and close");
      if ("volume" in x && (typeof x.volume !== "string" || !/^(0|[1-9][0-9]{0,14})$/.test(x.volume))) add(`${p}.volume`, 'must be a whole number text, e.g. "1000"');
      if (perBar && decimal(x.spread) === null) add(`${p}.spread`, "is required (decimal text) when costs.spread.mode is per_bar");
    });
    if (isObj(s) && typeof s.recordedAt === "string" && prev !== null && s.recordedAt < prev) add("dataset.source.recordedAt", "must not be earlier than the last bar");
  }
  return out;
}
function lintConfig(text) {
  const out = [], add = (p, m) => out.push(`${p}: ${m}`);
  let c; try { c = JSON.parse(text); } catch (e) { return [`config: not valid JSON (${clean(e.message, 80)})`]; }
  if (!isObj(c)) return ["config: must be a JSON object"];
  for (const k of Object.keys(c)) if (!["version", "strategy", "execution", "initialCash", "sizing", "slippageBps"].includes(k)) add(`config.${clean(k, 30)}`, "unknown key");
  if (c.version !== 1) add("config.version", "must be 1");
  const s = c.strategy;
  if (!isObj(s) || !["buy_and_hold", "ma_crossover"].includes(s.kind)) add("config.strategy.kind", "must be buy_and_hold or ma_crossover");
  else if (s.kind === "ma_crossover") {
    if (!Number.isInteger(s.fast) || !Number.isInteger(s.slow) || s.fast < 1 || s.slow < 2 || s.fast >= s.slow) add("config.strategy", 'ma_crossover needs whole numbers "fast" < "slow", e.g. 3 and 8');
    for (const k of Object.keys(s)) if (!["kind", "fast", "slow"].includes(k)) add(`config.strategy.${clean(k, 20)}`, "unknown key");
  } else for (const k of Object.keys(s)) if (k !== "kind") add(`config.strategy.${clean(k, 20)}`, "unknown key for buy_and_hold");
  if (c.execution !== "next_bar_open") add("config.execution", 'must be "next_bar_open"');
  const cash = c.initialCash;
  if (!isObj(cash) || typeof cash.currency !== "string" || decimal(cash.amount) === null || Number(cash.amount) <= 0 || /\.[0-9]{3,}$/.test(cash.amount)) add("config.initialCash", 'must be { "currency": "USD", "amount": "10000.00" } (greater than 0, at most 2 decimals; currency of the instrument)');
  const z = c.sizing;
  if (!isObj(z) || !["fixed_units", "all_cash"].includes(z.mode)) add("config.sizing.mode", "must be fixed_units or all_cash");
  else if (z.mode === "fixed_units" && (!Number.isInteger(z.units) || z.units < 1)) add("config.sizing.units", "must be a whole number of at least 1 for fixed_units");
  else if (z.mode === "all_cash" && "units" in z) add("config.sizing.units", "must not be given for all_cash");
  if (decimal(c.slippageBps) === null || Number(c.slippageBps) > 1000 || /\.[0-9]{3,}$/.test(c.slippageBps)) add("config.slippageBps", 'must be a decimal text of at most 1000 with at most 2 decimals (write "0" for none)');
  return out;
}
/** Advisory checks for one job folder's files (already read); returns issues. */
function lintFiles(files) {
  const j = lintJob(new TextDecoder().decode(files["job.json"]));
  const issues = [...j.issues];
  const [ds, cfg] = j.names;
  if (ds && files[ds]) issues.push(...lintDataset(new TextDecoder().decode(files[ds])));
  if (cfg && files[cfg]) issues.push(...lintConfig(new TextDecoder().decode(files[cfg])));
  return issues;
}
/** Reads a job folder for the format check: job.json first, then exactly the files it names. */
function readForCheck(dir, uid) {
  const any = (n) => (n === "job.json" ? 4096 : /^[a-z0-9][a-z0-9._-]{0,63}\.json$/.test(n) ? 10_000_000 : null);
  const first = readJobFolder(dir, uid, any);
  if (!first["job.json"]) throw new Error("job.json: MISSING (start from: template <job-name>)");
  const j = lintJob(checkJsonText("job.json", first["job.json"]));
  const want = ["job.json", ...j.names];
  const missing = want.filter((n) => !first[n]), extra = Object.keys(first).filter((n) => !want.includes(n));
  if (missing.length) throw new Error(`missing file(s) named by job.json: ${missing.map((n) => clean(n, 60)).join(", ")}`);
  if (extra.length) throw new Error(`unexpected file(s) in the job folder: ${extra.map((n) => clean(n, 60)).join(", ")} (it must hold exactly job.json and the files it names)`);
  for (const n of Object.keys(first)) checkJsonText(n, first[n]);
  return first;
}

// ---------- results and export (read root-only evidence; never execute or render reports) ----------
const EVNAME = /^e2-[a-z0-9][a-z0-9-]{0,39}-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
function summarize(dir) {
  const r = (f) => { try { return fs.readFileSync(path.join(dir, f)); } catch { return null; } };
  const j = (f) => { try { return JSON.parse(r(f).toString("utf8")); } catch { return null; } };
  const ex = j("executor-run.json"), ap = j("approval.json"), a = (ex && ex.audit) || {};
  const sums = r("SHA256SUMS"); let intact = sums !== null;
  if (sums) for (const line of sums.toString("utf8").split("\n").filter(Boolean)) { const [h, f] = line.split(/  /); const b = r(f); if (!b || sha(b) !== h) intact = false; }
  const rep = r("report.txt");
  const t0 = Date.parse(a.startedAt), t1 = Date.parse(a.finishedAt);
  const h = a.hostProcessEvidence || null;
  return {
    evidence: path.basename(dir), job: ap ? ap.job : null, approval: ap ? sha(r("approval.json")) : null, command: ap ? ap.command : null,
    status: ex ? ex.status : "no executor result", researchExitCode: a.researchExitCode ?? null,
    outcome: ex && ex.status === "completed" && a.researchExitCode === 0 ? "COMPLETED" : ex && ex.status === "completed" && a.researchExitCode === 1 ? "INPUT REFUSED BY THE RESEARCH CLI" : "STOP",
    startedAt: a.startedAt || null, runtimeSeconds: Number.isFinite(t1 - t0) ? Math.round((t1 - t0) / 100) / 10 : null,
    inputs: ap ? Object.fromEntries(Object.entries(ap.inputs).map(([n, i]) => [n, i.sha256])) : null, jobFileSha256: ap ? ap.jobFile.sha256 : null,
    reportSha256: rep ? sha(rep) : null, reportBytes: rep ? rep.length : null,
    gvisor: h ? { samples: h.polls, sandboxProcesses: h.sandboxProcesses, researchScriptOnHost: h.canaryOnHost, replacedExecutables: h.replacedExecutables } : null,
    cleanupVerified: !!(a.cleanup && a.cleanup.verifiedRemoved), runtime: a.runtime || null, image: a.imageRef || null,
    commit: ap ? ap.code.commit : null, evidenceIntact: intact,
  };
}

(async () => {
  const argv = process.argv.slice(2), MODE = argv[0];
  const ROOT_MODES = ["prepare", "run", "results", "export-read"], USER_MODES = ["template", "check", "export-write"];
  const euid = process.geteuid();
  if (ROOT_MODES.includes(MODE) && euid !== 0) { console.log("STOP: this step needs sudo"); process.exitCode = 1; return; }
  if (USER_MODES.includes(MODE) && euid === 0) { console.log("STOP: run this step as yourself, not as root"); process.exitCode = 1; return; }
  const opUid = ROOT_MODES.includes(MODE) ? Number(process.env.SUDO_UID) : euid;
  if (!Number.isInteger(opUid) || opUid <= 0) { console.log("STOP: run through sudo from the operator's account (SUDO_UID is missing or root)"); process.exitCode = 1; return; }

  if (MODE === "template") {
    const [, JOB, KIND, BASE, SAMPLES] = argv;
    if (!JOB_NAME.test(String(JOB)) || !["backtest", "validate", "buy-and-hold"].includes(KIND)) { console.log("Usage: template <job-name> [backtest|validate|buy-and-hold]"); process.exitCode = 2; return; }
    const ds = fs.readFileSync(path.join(SAMPLES, "fict-us-trend.json")), cf = fs.readFileSync(path.join(SAMPLES, "run-us-ma.json"));
    if (sha(ds) !== SAMPLE["fict-us-trend.json"] || sha(cf) !== SAMPLE["run-us-ma.json"]) { console.log("STOP: the committed fictional sample in ~/automaton is not the expected one (run prepare once, or check the checkout)"); process.exitCode = 1; return; }
    fs.mkdirSync(BASE, { recursive: true, mode: 0o755 });
    const dir = path.join(BASE, JOB);
    try { fs.mkdirSync(dir, { mode: 0o755 }); } catch (e) { console.log(`STOP: ${dir} already exists (${clean(e.code, 12)}); choose another job name`); process.exitCode = 1; return; }
    const d = JSON.parse(ds.toString("utf8")); d.id = JOB.slice(0, 64); d.title = `Fictional dataset for ${JOB} (edit me)`;
    const files = { "prices.json": JSON.stringify(d, null, 2) + "\n" };
    if (KIND === "validate") files["job.json"] = JSON.stringify({ version: 1, command: "trading-validate", dataset: "prices.json" }, null, 2) + "\n";
    else {
      const c = JSON.parse(cf.toString("utf8")); if (KIND === "buy-and-hold") c.strategy = { kind: "buy_and_hold" };
      files["run.json"] = JSON.stringify(c, null, 2) + "\n";
      files["job.json"] = JSON.stringify({ version: 1, command: "trading-backtest", dataset: "prices.json", config: "run.json" }, null, 2) + "\n";
    }
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t, { mode: 0o644, flag: "wx" });
    for (const n of Object.keys(files)) fs.chmodSync(path.join(dir, n), 0o644);
    fs.chmodSync(dir, 0o755);
    console.log(`Created ${dir} (${KIND}): ${Object.keys(files).join(", ")}\nFictional example data from the committed sample. Edit prices.json${KIND === "validate" ? "" : " and run.json"}, then: check ${JOB}`);
    return;
  }

  if (MODE === "check") {
    const [, BASE, ...JOBS] = argv;
    let bad = 0;
    for (const JOB of JOBS) {
      try {
        const files = readForCheck(path.join(BASE, JOB), opUid);
        const issues = lintFiles(files);
        if (issues.length === 0) console.log(`${JOB}: OK  (format looks valid; the research CLI inside the sandbox has the final say)`);
        else { bad += 1; console.log(`${JOB}: ${issues.length} problem(s)${issues.length >= MAX_ISSUES ? " (first " + MAX_ISSUES + ")" : ""}`); for (const x of issues) console.log(`   - ${clean(x, 200)}`); }
      } catch (e) { bad += 1; console.log(`${JOB}: REFUSED  ${clean(e.message, 220)}`); }
    }
    process.exitCode = bad === 0 ? 0 : 1;
    return;
  }

  if (MODE === "export-write") {
    const [, NAME, BASE, BUNDLE] = argv;
    if (!EVNAME.test(String(NAME))) { console.log("STOP: not an evidence name"); process.exitCode = 2; return; }
    let b; try { b = JSON.parse(fs.readFileSync(BUNDLE, "utf8")); } catch { console.log("STOP: no export data (see the message above)"); process.exitCode = 1; return; }
    if (!b || b.kind !== "e3-export" || b.summary.evidence !== NAME || typeof b.report !== "string") { console.log("STOP: export data is not for this evidence folder"); process.exitCode = 1; return; }
    fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
    const dfd = openDirNoFollow(BASE);
    try {
      const s = fs.fstatSync(dfd); if (s.uid !== opUid) throw new Error(`${BASE} is not owned by you`);
      fs.mkdirSync(`/proc/self/fd/${dfd}/${NAME}`, { mode: 0o700 });
      const out = { "report.txt": b.report, "summary.json": JSON.stringify(b.summary, null, 2) + "\n" };
      const sums = Object.entries(out).map(([n, t]) => `${sha(Buffer.from(t, "utf8"))}  ${n}`).join("\n") + "\n";
      out["SHA256SUMS"] = sums;
      for (const [n, t] of Object.entries(out)) fs.writeFileSync(`/proc/self/fd/${dfd}/${NAME}/${n}`, t, { mode: 0o600, flag: "wx" });
    } catch (e) { console.log(`STOP: ${clean(e.message, 200)}`); process.exitCode = 1; return; } finally { fs.closeSync(dfd); }
    const s = b.summary;
    console.log(`Exported to ${BASE}/${NAME}/ (report.txt, summary.json, SHA256SUMS; readable only by you)\n  ${s.job}: ${s.outcome}, report sha256 ${s.reportSha256}, evidence intact: ${s.evidenceIntact ? "yes" : "NO"}`);
    console.log("  report.txt is untrusted text produced from your input: open it as plain text only.");
    return;
  }

  if (MODE === "results") {
    const want = argv[1] || "10";
    const dirs = fs.readdirSync(STATE).filter((n) => EVNAME.test(n) && fs.lstatSync(path.join(STATE, n)).isDirectory()).sort();
    if (EVNAME.test(want)) {
      if (!dirs.includes(want)) { console.log("STOP: no such evidence folder"); process.exitCode = 1; return; }
      console.log(JSON.stringify(summarize(path.join(STATE, want)), null, 2)); return;
    }
    const n = Math.max(1, Math.min(100, Number.parseInt(want, 10) || 10));
    console.log("started (UTC)        job                  outcome     runtime  gVisor procs  on host  cleanup  report sha256      evidence");
    for (const d of dirs.slice(-n)) {
      const s = summarize(path.join(STATE, d));
      console.log(`${String(s.startedAt || "-").slice(0, 19).padEnd(20)} ${String(s.job || "-").slice(0, 20).padEnd(20)} ${s.outcome.split(" ")[0].padEnd(11)} ${String(s.runtimeSeconds ?? "-").padStart(6)} s ${String(s.gvisor ? s.gvisor.sandboxProcesses : "-").padStart(12)} ${String(s.gvisor ? s.gvisor.researchScriptOnHost : "-").padStart(8)}  ${(s.cleanupVerified ? "yes" : "NO").padEnd(7)}  ${String(s.reportSha256 || "-").slice(0, 16).padEnd(17)}  ${d}${s.evidenceIntact ? "" : "  (EVIDENCE CHANGED)"}`);
    }
    if (dirs.length === 0) console.log("(no runs yet)");
    console.log("\nDetails: results <evidence>    Copy report and summary to ~/research-results: export <evidence>");
    return;
  }

  if (MODE === "export-read") {
    const NAME = argv[1];
    if (!EVNAME.test(String(NAME))) { console.error("STOP: not an evidence name"); process.exitCode = 2; return; }
    const dir = path.join(STATE, NAME), s0 = fs.lstatSync(dir);
    if (!s0.isDirectory() || s0.isSymbolicLink() || s0.uid !== 0) { console.error("STOP: not a root-owned evidence folder"); process.exitCode = 1; return; }
    const s = summarize(dir);
    let report = ""; try { report = readRootFile(path.join(dir, "report.txt"), 2 * 1024 * 1024).toString("utf8").replace(/[^\x20-\x7e\n\t]/g, "?"); } catch {}
    process.stdout.write(JSON.stringify({ kind: "e3-export", summary: s, report }));
    return;
  }

  // ---------- prepare (one or more jobs, independent approvals) and run (exactly one job) ----------
  const BUILD = argv[1], BASE = argv[2];
  const jobs = MODE === "prepare" ? argv.slice(3) : [argv[3]];
  let GIVEN = MODE === "run" ? argv[4] : null;
  if (!["prepare", "run"].includes(MODE) || jobs.length === 0 || jobs.length > 20 || !jobs.every((j) => JOB_NAME.test(String(j))) || (MODE === "run" && !/^[0-9a-f]{16,64}$/.test(String(GIVEN)))) {
    console.log("Usage: prepare <job> [<job>...] | run <job> <approval-hash (or a unique prefix of at least 16)>"); process.exitCode = 2; return;
  }
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
  fs.mkdirSync(APPROVALS, { recursive: true, mode: 0o700 });
  { const a = fs.lstatSync(APPROVALS); if (!a.isDirectory() || a.uid !== 0 || (a.mode & 0o077) !== 0) { bad(`approvals folder is not root-only (${st(APPROVALS)})`); return stopNow(); } }

  let manifest = null, manifestBytes = null;
  const JOB = jobs[0], SRC = path.join(BASE, JOB);
  if (MODE === "run") {
    console.log(`== A. approval ${GIVEN.slice(0, 16)}...`);
    step("approval", () => {
      if (GIVEN.length < 64) {
        const m = fs.readdirSync(APPROVALS).filter((n) => n.endsWith(".json") && n.startsWith(GIVEN)).map((n) => n.slice(0, -5)).filter((n) => HASH.test(n));
        if (m.length !== 1) throw new Error(`${m.length === 0 ? "no approval starts with" : "more than one approval starts with"} ${GIVEN} (use more characters or the full hash)`);
        GIVEN = m[0]; info(`full approval hash: ${GIVEN}`);
      }
      if (!fs.existsSync(`${APPROVALS}/${GIVEN}.json`)) throw new Error("no approval with this hash (run prepare first; approvals are root-only and single-use)");
      manifestBytes = readRootFile(`${APPROVALS}/${GIVEN}.json`, 64 * 1024);
      (sha(manifestBytes) === GIVEN ? ok : bad)("approval manifest hashes to the given approval hash (root-only, unchanged)");
      manifest = JSON.parse(manifestBytes.toString("utf8"));
      chk("manifest kind / job / operator / commit", [manifest.kind, manifest.version, manifest.job, manifest.operatorUid, manifest.code && manifest.code.commit], ["e2-job-approval", 1, JOB, opUid, COMMIT]);
      chk("manifest source folder", manifest.sourceDir, SRC);
      if (fs.existsSync(`${APPROVALS}/${GIVEN}.used`)) bad("this approval was already used (approvals are single-use; prepare the job again)"); else ok("approval not used before");
      const age = Date.now() - Date.parse(manifest.createdAt);
      (Number.isFinite(age) && age >= 0 && age <= APPROVAL_TTL_MS ? ok : bad)(`approval age ${Math.round(age / 60000)} min (at most ${APPROVAL_TTL_MS / 3600000} h)`);
    });
    if (fails > 0) return stopNow("before anything was staged");
  }

  const ev = `${STATE}/e2-${MODE === "run" ? "" : "prepare-"}${JOB}-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
  console.log("== 0. compiled code: fresh build verified and copied to a root-only folder");
  fs.mkdirSync(ev, { mode: 0o700 });
  if (MODE === "prepare") PREP_EV = ev;
  let CODEDIR = null;
  step("code", () => {
    const src = path.join(BUILD, "dist/research-sandbox");
    const names = fs.readdirSync(src).filter((n) => n.endsWith(".js")).sort();
    chk("compiled file set (exact)", names, Object.keys(CODE).sort());
    const dst = path.join(ev, "code/dist/research-sandbox");
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ev, "code/package.json"), '{"type":"module"}\n', { mode: 0o600, flag: "wx" });
    let good = 0;
    for (const [n, h] of Object.entries(CODE)) {
      let b; try { const s = fs.lstatSync(path.join(src, n)); if (!s.isFile()) throw new Error("x"); b = fs.readFileSync(path.join(src, n)); } catch { bad(`compiled ${n}: MISSING or not a regular file`); continue; }
      if (sha(b) !== h) { bad(`compiled ${n}: does not match the pinned commit's build`); continue; }
      fs.writeFileSync(path.join(dst, n), b, { mode: 0o400, flag: "wx" }); good += 1;
    }
    if (good === Object.keys(CODE).length && names.length === good) { CODEDIR = dst; ok(`${good} compiled files match the pinned commit's build; executing only the root-only copy`); }
  });
  const codeSha = sha(JSON.stringify(canon(CODE)));
  if (MODE === "run" && manifest) chk("code version bound by the approval", manifest.code.manifestSha256, codeSha);
  if (!CODEDIR || fails > 0) return stopNow();
  const ex = await import(path.join(CODEDIR, "executor.js"));
  const { readRunnerConfigFile } = await import(path.join(CODEDIR, "preflight-main.js"));
  const scope = (await import(path.join(CODEDIR, "decision-scope.js"))).ACCEPTED_DECISION_SCOPE;
  const { SANDBOX_SPEC } = await import(path.join(CODEDIR, "spec.js"));
  const tryRead = (p) => { try { readRunnerConfigFile(p, 0); return null; } catch (e) { return clean((e.problems || [String(e.message)]).join("; "), 240); } };

  console.log("== 1. runner configuration and pins");
  let confBytes = null, conf = null, run = null;
  step("config", () => {
    const why = tryRead(CONF); (why === null ? ok : bad)(`runner configuration ${why === null ? "accepted by the executor's file reader" : "refused: " + why}`);
    confBytes = readRootFile(CONF, 1024 * 1024); conf = JSON.parse(confBytes.toString("utf8"));
    let setup = null;
    for (const d of fs.readdirSync(STATE).filter((n) => /^setup-/.test(n)).sort()) { try { const r = path.join(STATE, d, "preflight-report.json"); if (fs.lstatSync(r).isFile() && sha(fs.readFileSync(r)) === E1B_REPORT) setup = path.join(STATE, d); } catch {} }
    if (!setup) bad("E1b setup run: NOT FOUND");
    else (Buffer.compare(fs.readFileSync(path.join(setup, "preflight-config.json")), confBytes) === 0 ? ok : bad)("runner configuration is byte-identical to the E1b run's copy");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(conf.runId))) bad("runner configuration: runId");
    run = { in: `${ROOT}/srv/research-runs/${conf.runId}/in`, out: `${ROOT}/srv/research-runs/${conf.runId}/out` };
    const pins = conf.pins || {}, r = pins.runscBinary || {};
    chk("runsc path, args and sha256 (accepted pins)", [r.path, r.args, r.sha256], [scope.runscPath, [...scope.runscArgs], scope.runscSha256]);
    const key = (xs) => (Array.isArray(xs) ? xs.map((x) => `${x && x.path} ${x && x.sha256}`).sort() : null);
    chk("sidecars (exact accepted set)", key(r.sidecars), key(scope.sidecars));
    chk("gVisor reference / image / Docker version / data root", [pins.gvisorProcVersion, pins.imageId, pins.dockerServerVersion, pins.dockerDataRoot], [scope.gvisorProcVersion, scope.imageId, scope.dockerServerVersion, scope.dockerDataRoot]);
    let fileFails = 0;
    for (const f of [{ path: r.path, sha256: r.sha256 }, ...(Array.isArray(r.sidecars) ? r.sidecars : [])]) {
      try { const s = fs.lstatSync(ROOT + f.path); if (!s.isFile() || s.uid !== 0 || (s.mode & 0o022) !== 0 || sha(fs.readFileSync(ROOT + f.path)) !== f.sha256) { fileFails += 1; bad(`${clean(f.path, 100)}: missing, not root-owned, writable or hash MISMATCH`); } } catch { fileFails += 1; bad(`${clean(f.path, 100)}: MISSING`); }
    }
    if (fileFails === 0) ok(`runsc and ${(r.sidecars || []).length} sidecars on disk match their pins`);
    const im = docker(["image", "inspect", "--format", "{{.Id}}", String(pins.imageId)]);
    (im.status === 0 && im.stdout.trim() === scope.imageId ? ok : bad)(`research image present (${clean(im.status === 0 ? im.stdout.trim() : im.stderr, 100)})`);
  });
  if (MODE === "run" && manifest && confBytes) chk("runner configuration bound by the approval", manifest.runnerConfigSha256, sha(confBytes));
  if (fails > 0) return stopNow();

  /** Definitive read of one job folder (exact names and caps from job.json) plus the format check. */
  const readJob = (src) => {
    const anyJson = (n) => (n === "job.json" ? ex.MAX_JOB_FILE_BYTES : /^[a-z0-9][a-z0-9._-]{0,63}\.json$/.test(n) ? Math.max(ex.MAX_DATASET_BYTES, ex.MAX_CONFIG_BYTES) : null);
    const first = readJobFolder(src, opUid, anyJson);
    if (!first["job.json"]) throw new Error("job.json: MISSING");
    let job = ex.parseResearchJob(checkJsonText("job.json", first["job.json"]));
    if (job.dataset === "job.json" || job.config === "job.json") throw new Error("job.json: the dataset and config must not be named job.json");
    const caps = { "job.json": ex.MAX_JOB_FILE_BYTES, [job.dataset]: Math.min(SANDBOX_SPEC.maxInputFileBytes, ex.MAX_DATASET_BYTES), ...(job.config ? { [job.config]: ex.MAX_CONFIG_BYTES } : {}) };
    const files = readJobFolder(src, opUid, (n) => (Object.prototype.hasOwnProperty.call(caps, n) ? caps[n] : null));
    if (!same(Object.keys(files).sort(), Object.keys(caps).sort())) throw new Error(`the job folder must hold exactly ${Object.keys(caps).sort().join(", ")} (has ${Object.keys(files).sort().join(", ")})`);
    if (sha(files["job.json"]) !== sha(first["job.json"])) throw new Error("job.json changed while being read");
    const jobText = checkJsonText("job.json", files["job.json"]); job = ex.parseResearchJob(jobText);
    for (const n of Object.keys(files).filter((n) => n !== "job.json")) checkJsonText(n, files[n]);
    const total = Object.entries(files).filter(([n]) => n !== "job.json").reduce((a, [, b]) => a + b.length, 0);
    if (total > SANDBOX_SPEC.maxInputTotalBytes) throw new Error(`inputs: ${total} bytes in total; the limit is ${SANDBOX_SPEC.maxInputTotalBytes}`);
    const issues = lintFiles(files);
    if (issues.length) throw new Error(`format check found ${issues.length} problem(s): ${issues.slice(0, 5).join(" | ")}${issues.length > 5 ? " | ... (run check for all)" : ""}`);
    return { files, jobText, job, inputs: Object.fromEntries(Object.entries(files).filter(([n]) => n !== "job.json").map(([n, b]) => [n, { sha256: sha(b), bytes: b.length }])) };
  };

  if (MODE === "prepare") {
    console.log(`== 2. job folders (${jobs.length}): read once without following links; each job gets its own approval`);
    const results = [];
    for (const name of jobs) {
      const src = path.join(BASE, name);
      try {
        const { files, jobText, job, inputs } = readJob(src);
        const m = canon({
          kind: "e2-job-approval", version: 1, job: name, jobId: crypto.randomBytes(16).toString("hex"), createdAt: new Date().toISOString(),
          operatorUid: opUid, sourceDir: src, command: job.command, researchCommand: ex.researchCommand(job, SANDBOX_SPEC),
          jobFile: { sha256: sha(files["job.json"]), text: jobText }, inputs,
          code: { commit: COMMIT, manifestSha256: codeSha }, runnerConfigSha256: sha(confBytes), runId: conf.runId, imageId: scope.imageId,
          limits: { network: SANDBOX_SPEC.network, memoryBytes: SANDBOX_SPEC.memoryBytes, nanoCpus: SANDBOX_SPEC.nanoCpus, pidsLimit: SANDBOX_SPEC.pidsLimit, timeoutMs: SANDBOX_SPEC.timeoutMs },
        });
        const bytes = Buffer.from(JSON.stringify(m, null, 2) + "\n", "utf8"), h = sha(bytes);
        fs.writeFileSync(`${APPROVALS}/${h}.json`, bytes, { mode: 0o600, flag: "wx" });
        ok(`${name}: ${job.command} on ${job.dataset}${job.config ? " with " + job.config : ""}`);
        for (const [n, i] of Object.entries(inputs)) console.log(`          ${n}  ${i.bytes} bytes  sha256 ${i.sha256}`);
        results.push([name, h]);
      } catch (e) { bad(`${name}: ${clean(e.message, 400)}`); results.push([name, null]); }
    }
    fs.rmSync(ev, { recursive: true, force: true }); PREP_EV = null;
    console.log(`\n  commit ${COMMIT.slice(0, 12)}, network none, each approval single use and valid 24 h; no research was run`);
    for (const [name, h] of results) console.log(h ? `APPROVAL ${name} ${h}` : `REFUSED  ${name}`);
    const okCount = results.filter(([, h]) => h).length;
    console.log(`RESULT: PREPARED ${okCount} of ${results.length}. Each job runs only with its own command: run <job> <approval-hash>`);
    process.exitCode = okCount === results.length ? 0 : 1;
    return;
  }

  console.log("== 2. job folder (operator's files, read once without following links)");
  let files = null, jobText = null, job = null, inputs = null;
  step("job folder", () => { ({ files, jobText, job, inputs } = readJob(SRC)); ok(`job: ${job.command} on ${job.dataset}${job.config ? " with " + job.config : ""}; format check passed`); });
  if (fails > 0 || !files) return stopNow();

  console.log("== 3. job bound by the approval");
  chk("job file (exact bytes)", [sha(files["job.json"]), jobText], [manifest.jobFile.sha256, manifest.jobFile.text]);
  chk("inputs (names, sizes, sha256)", inputs, manifest.inputs);
  chk("fixed research command", ex.researchCommand(job, SANDBOX_SPEC), manifest.researchCommand);
  chk("run id / image", [conf.runId, scope.imageId], [manifest.runId, manifest.imageId]);

  console.log("== 4. Docker configuration (read-only trust evidence) vs E1b");
  step("trust evidence", () => {
    const r = cp.spawnSync(process.execPath, [path.join(CODEDIR, "trust-evidence-main.js"), "--config", CONF, "--confirm-read-only-host-queries"], { encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status !== 4) return bad(`collection exit ${r.status} (4 expected); stderr: ${clean(r.stderr, 300) || "(empty)"}`);
    const t = JSON.parse(r.stdout), { digest, ...body } = t, e = t.evidence || {};
    (t.kind === "research-sandbox-trust-evidence" && digest === "sha256:" + sha(JSON.stringify(canon(body))) ? ok : bad)("report kind and digest");
    chk("verdict / blocking / review", [t.verdict, t.blocking, t.review], ["needs-review", 0, 1]);
    chk("daemon.json / dockerd / drop-ins", [e.daemonJson && e.daemonJson.sha256, e.daemonJson && e.daemonJson.keys, e.dockerd && e.dockerd.argv, e.dockerd && e.dockerd.dropIns], [E.daemonJson, ["runtimes"], E.argv, []]);
    chk("packages and dpkg --verify", Object.keys(E.pkgs).map((k) => e.packages && e.packages[k] && [e.packages[k].installed, e.packages[k].status, e.packages[k].verify]), Object.values(E.pkgs).map((v) => [v, "ii", []]));
    chk("daemon version / security options / data root", e.dockerInfo && [e.dockerInfo.ServerVersion, e.dockerInfo.SecurityOptions, e.dockerInfo.DockerRootDir], ["29.9.3", E.secopts, "/var/lib/docker"]);
    const kr = Array.isArray(e.aptSources) ? Object.fromEntries(e.aptSources.flatMap((s) => (s.fingerprints || []).map((f) => [f, s.keyringSha256]))) : {};
    chk("apt keyrings", Object.keys(E.keyrings).map((f) => kr[f]), Object.values(E.keyrings));
  });

  console.log("== 5. run folders and staging (root-owned copies of the approved bytes)");
  step("run folders", () => {
    const ins = fs.lstatSync(run.in), outs = fs.lstatSync(run.out);
    if (!ins.isDirectory() || ins.isSymbolicLink() || ins.uid !== 0 || (ins.mode & 0o022) !== 0) bad(`input folder must be a root-owned directory not writable by group or others (${st(run.in)})`);
    if (!outs.isDirectory() || outs.isSymbolicLink()) bad(`output folder is not a directory (${st(run.out)})`);
    const out = fs.readdirSync(run.out); (out.length === 0 ? ok : bad)(`output folder empty (${out.length} entries)`);
  });
  leftovers("before the run");
  if (fails > 0) return stopNow("before staging");
  fs.mkdirSync(`${ev}/previous-inputs`, { mode: 0o700 }); fs.mkdirSync(`${ev}/inputs`, { mode: 0o700 });
  step("archive previous inputs", () => {
    for (const n of fs.readdirSync(run.in)) {
      const p = path.join(run.in, n), s = fs.lstatSync(p);
      if (!s.isFile()) { bad(`input folder holds a non-regular entry ${clean(n, 60)} (${st(p)}): not touched`); continue; }
      fs.writeFileSync(path.join(`${ev}/previous-inputs`, n), fs.readFileSync(p), { mode: 0o600, flag: "wx" }); fs.unlinkSync(p);
    }
    const left = fs.readdirSync(run.in); (left.length === 0 ? ok : bad)(`input folder emptied (previous files archived to the evidence folder; ${left.length} left)`);
  });
  if (fails > 0) return stopNow("before staging");
  step("stage", () => {
    for (const [n, i] of Object.entries(inputs)) {
      fs.writeFileSync(path.join(run.in, n), files[n], { mode: 0o644, flag: "wx" });
      const s = fs.lstatSync(path.join(run.in, n));
      if (!s.isFile() || s.uid !== 0 || (s.mode & 0o777) !== 0o644 || sha(fs.readFileSync(path.join(run.in, n))) !== i.sha256) bad(`staged ${n} is not a root:root 644 copy of the approved bytes`);
    }
    fs.writeFileSync(`${ev}/job.json`, Buffer.from(manifest.jobFile.text, "utf8"), { mode: 0o600, flag: "wx" });
    fs.writeFileSync(`${ev}/approval.json`, manifestBytes, { mode: 0o600, flag: "wx" });
    const js = fs.lstatSync(`${ev}/job.json`);
    if (js.uid !== 0 || (js.mode & 0o777) !== 0o600 || sha(fs.readFileSync(`${ev}/job.json`)) !== manifest.jobFile.sha256) bad("job file is not a root:root 600 copy of the approved job");
    for (const [label, p] of [["runner configuration", CONF], ["job file", `${ev}/job.json`]]) { const why = tryRead(p); (why === null ? ok : bad)(`${label} ${why === null ? "accepted" : "refused"} by the executor's file reader${why ? ": " + why : ""}`); }
    ok(`staged ${Object.keys(inputs).length} input(s) as root:root 644 copies of the approved bytes`);
  });
  if (fails > 0) {
    for (const n of Object.keys(inputs)) { try { const p = path.join(run.in, n); fs.writeFileSync(path.join(`${ev}/inputs`, n), fs.readFileSync(p), { mode: 0o600, flag: "wx" }); fs.unlinkSync(p); } catch {} }
    return stopNow("before the job (staged inputs moved to the evidence folder)");
  }

  console.log("== 6. one job under gVisor (approval consumed now)");
  fs.writeFileSync(`${APPROVALS}/${GIVEN}.used`, `${new Date().toISOString()} ${path.basename(ev)}\n`, { mode: 0o600, flag: "wx" });
  const t0 = Date.now();
  const x = cp.spawnSync(process.execPath, [path.join(CODEDIR, "executor-main.js"), "--config", CONF, "--job", `${ev}/job.json`, "--confirm-sandboxed-research"], { encoding: "utf8", timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(`${ev}/executor-run.json`, x.stdout || "", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(`${ev}/executor-run.log`, x.stderr || "", { mode: 0o600, flag: "wx" });
  console.log(`  ..    executor finished in ${Math.round((Date.now() - t0) / 1000)} s, exit ${x.status}${x.error ? " (" + clean(x.error.code, 20) + ")" : ""}`);
  let outcome = "STOP", report = null, reportSha = null;
  step("executor result", () => {
    if (x.error) return bad(`executor did not complete (${clean(x.error.code || x.error.message, 60)}); check for leftover containers`);
    const r = JSON.parse(x.stdout), a = r.audit || {};
    chk("status", [r.runner, r.status], ["research-sandbox-executor", "completed"]);
    if (Array.isArray(r.violations) && r.violations.length) bad(`violations: ${clean(r.violations.join(" | "), 400)}`);
    chk("steps (preflight, gate, re-checks, create, inspect, run, report, cleanup, runtime re-check)", r.steps, STEPS);
    chk("fresh preflight / runtime / image", [a.preflight && a.preflight.rating, a.preflight && a.preflight.violations, a.runtime, a.imageRef], ["meets-spec", 0, "runsc", scope.imageId]);
    chk("job and inputs the executor ran (sha256)", [a.jobSha256, Array.isArray(a.inputs) && Object.fromEntries(a.inputs.map((i) => [i.name, i.sha256]))], [manifest.jobFile.sha256, Object.fromEntries(Object.entries(inputs).map(([n, i]) => [n, i.sha256]))]);
    const h = a.hostProcessEvidence;
    chk("gVisor host-process evidence", h && [h.polls >= 10, h.sandboxProcesses >= 1, h.canaryOnHost, h.replacedExecutables, h.overflow], [true, true, 0, 0, false]);
    if (h) info(`host processes: ${h.polls} samples, ${h.sandboxProcesses} gVisor process(es), research script on host ${h.canaryOnHost}`);
    chk("cleanup verified", a.cleanup && a.cleanup.verifiedRemoved, true);
    if (a.researchExitCode === 0 || a.researchExitCode === 1) ok(`research CLI exit ${a.researchExitCode}${a.researchExitCode === 1 ? " (the CLI refused the input; see the report)" : ""}`); else bad(`research CLI exit ${a.researchExitCode}`);
    if (typeof r.report === "string") { report = ex.sanitizeReport(r.report); reportSha = sha(Buffer.from(report, "utf8")); }
    if (fails === 0) outcome = a.researchExitCode === 0 ? "COMPLETED" : "COMPLETED: INPUT REFUSED BY THE RESEARCH CLI";
  });
  leftovers("after the run");
  step("output folder", () => { const o = fs.readdirSync(run.out); (o.length === 0 ? ok : bad)(`output folder still empty (${o.length} entries)`); });
  for (const n of Object.keys(inputs)) { try { const p = path.join(run.in, n); fs.writeFileSync(path.join(`${ev}/inputs`, n), fs.readFileSync(p), { mode: 0o600, flag: "wx" }); fs.unlinkSync(p); } catch (e) { bad(`moving staged ${n} to the evidence folder failed (${clean(e.code, 20)})`); } }
  if (report !== null) fs.writeFileSync(`${ev}/report.txt`, report, { mode: 0o600, flag: "wx" });
  const sums = fs.readdirSync(ev).filter((f) => fs.lstatSync(`${ev}/${f}`).isFile()).sort().map((f) => `${sha(fs.readFileSync(`${ev}/${f}`))}  ${f}`).join("\n") + "\n";
  fs.writeFileSync(`${ev}/SHA256SUMS`, sums, { mode: 0o600, flag: "wx" });
  if (fails > 0) outcome = "STOP";
  const runtime = Math.round((Date.now() - t0) / 100) / 10;
  fs.appendFileSync(RUNLOG, `${new Date().toISOString()} ${JOB} ${GIVEN} ${outcome.split(":")[0]} runtime=${runtime}s report=${reportSha || "none"} ${path.basename(ev)}\n`, { mode: 0o600 });
  if (report !== null) {
    const lines = report.split("\n");
    console.log(`\n---- report (untrusted text, ${Buffer.byteLength(report)} bytes, sha256 ${reportSha}; first ${Math.min(lines.length, 60)} of ${lines.length} lines) ----`);
    console.log(lines.slice(0, 60).join("\n")); console.log("---- end of report excerpt ----");
  }
  console.log(`\n  Evidence (root-only): ${path.basename(ev)}\n  Summary: results ${path.basename(ev)}    Copy to ~/research-results: export ${path.basename(ev)}`);
  console.log(outcome === "STOP" ? `\nRESULT: STOP (${fails} problem(s) above). The approval is consumed; do not retry, send this output.` : `\nRESULT: ${outcome}. The approval is consumed (single use).`);
  process.exitCode = outcome === "COMPLETED" ? 0 : outcome === "STOP" ? 1 : 3;
})().catch((e) => { console.log(`\nRESULT: STOP (internal error: ${clean(e.message, 200)}). Check for leftover containers. Send this output.`); process.exitCode = 1; });
JS
}
checkout_and_build() {
  cd ~/automaton || stop "~/automaton is missing"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || stop "tracked files are modified in ~/automaton"
  git fetch -q origin custom && git checkout -q --detach "$C" || stop "cannot check out $C"
  [ "$(git rev-parse HEAD)" = "$C" ] || stop "HEAD is not $C"
  [ -z "$(git status --porcelain --untracked-files=no)" ] && git diff --quiet "$C" -- && git diff --cached --quiet "$C" -- || stop "tracked files differ from $C"
  echo "ok    commit $C checked out; tracked files match it"
  B=$(mktemp -d /tmp/e3-build.XXXXXX) || stop "cannot create a build folder"
  ./node_modules/.bin/tsc --outDir "$B/dist" || stop "build failed"
  echo "ok    build exit 0 ($(./node_modules/.bin/tsc --version))"
}
case "$CMD" in
  template) { [ "$#" -ge 1 ] && [ "$#" -le 2 ] && okjob "$1"; } || usage
    js node - template "$1" "${2:-backtest}" "$IN" "$HOME/automaton/deploy/research-sandbox/e1b-sample" ;;
  check) [ "$#" -ge 1 ] || usage; for j in "$@"; do okjob "$j" || usage; done
    js node - check "$IN" "$@" ;;
  prepare) { [ "$#" -ge 1 ] && [ "$#" -le 20 ]; } || usage; for j in "$@"; do okjob "$j" || usage; done
    checkout_and_build; js sudo node - prepare "$B" "$IN" "$@" ;;
  run) { [ "$#" -eq 2 ] && okjob "$1" && [[ "$2" =~ ^[0-9a-f]{16,64}$ ]]; } || usage
    checkout_and_build; js sudo node - run "$B" "$IN" "$1" "$2" ;;
  results) [ "$#" -le 1 ] || usage; js sudo node - results "${1:-10}" ;;
  export) { [ "$#" -eq 1 ] && [[ "$1" =~ ^e2-[a-z0-9][a-z0-9-]{0,39}-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$ ]]; } || usage
    T=$(mktemp) || stop "cannot create a temporary file"
    js sudo node - export-read "$1" > "$T" && js node - export-write "$1" "$HOME/research-results" "$T"; r=$?; rm -f -- "$T"; exit $r ;;
  *) usage ;;
esac
)
