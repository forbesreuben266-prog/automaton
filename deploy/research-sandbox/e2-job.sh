#!/usr/bin/env bash
# E2a: operator-approved offline research jobs on the approved VPS (one job per approval).
#   Put the files in ~/research-inputs/<job-name>/ : job.json plus the dataset (and config) it names, e.g.
#     {"version":1,"command":"trading-backtest","dataset":"prices.json","config":"run.json"}
#   prepare <job-name>                  checks the files, writes a root-only single-use approval; runs NO research
#   run <job-name> <approval-hash>      re-verifies everything the approval binds and runs exactly that job once
( set -u
MODE=${1:-}; JOB=${2:-}; HASH=${3:-}
case "$MODE" in prepare) [ "$#" -eq 2 ] ;; run) [ "$#" -eq 3 ] && [[ "$HASH" =~ ^[0-9a-f]{64}$ ]] ;; *) false ;; esac && [[ "$JOB" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] \
  || { echo "Usage: prepare <job-name> | run <job-name> <approval-hash>"; exit 2; }
SRC="$HOME/research-inputs/$JOB"
cd ~/automaton || exit 1
C=f7be90bfff9a9b030513e92611e771fb6dc2194e
stop() { echo "STOP: $* (nothing was run)"; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || stop "tracked files are modified in ~/automaton"
git fetch -q origin custom && git checkout -q --detach "$C" || stop "cannot check out $C"
[ "$(git rev-parse HEAD)" = "$C" ] || stop "HEAD is not $C"
[ -z "$(git status --porcelain --untracked-files=no)" ] && git diff --quiet "$C" -- && git diff --cached --quiet "$C" -- || stop "tracked files differ from $C"
echo "ok    commit $C checked out; tracked files match it"
B=$(mktemp -d /tmp/e2-build.XXXXXX) || stop "cannot create a build folder"
echo "..    building with $(./node_modules/.bin/tsc --version) into $B (fresh, empty)"
./node_modules/.bin/tsc --outDir "$B/dist" || stop "build failed"
echo "ok    build exit 0"
sudo node - "$B" "$MODE" "$JOB" "$SRC" ${HASH:+"$HASH"} <<'JS'
// E2a: operator-approved offline research jobs. Root, from ~/automaton at the pinned commit; argv: build mode job srcdir [hash].
//   prepare: checks the job folder and writes an immutable, root-only approval manifest. Runs NO research and no container.
//   run:     re-verifies everything the manifest binds, consumes the approval (single use), runs exactly one job.
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

(async () => {
  const [BUILD, MODE, JOB, SRC, GIVEN] = process.argv.slice(2);
  const opUid = Number(process.env.SUDO_UID);
  if (!["prepare", "run"].includes(MODE) || !JOB_NAME.test(String(JOB)) || typeof SRC !== "string" || (MODE === "run" && !HASH.test(String(GIVEN)))) {
    console.log("Usage: prepare <job-name> | run <job-name> <approval-hash>  (job name: lower-case letters, digits, '-'; at most 40)"); process.exitCode = 2; return;
  }
  if (!Number.isInteger(opUid) || opUid <= 0) { console.log("STOP: run through sudo from the operator's account (SUDO_UID is missing or root)"); process.exitCode = 1; return; }
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
  const ev = `${STATE}/e2-${MODE === "run" ? "" : "prepare-"}${JOB}-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
  fs.mkdirSync(APPROVALS, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(APPROVALS).uid !== 0 || (fs.lstatSync(APPROVALS).mode & 0o077) !== 0 || !fs.lstatSync(APPROVALS).isDirectory()) { bad(`approvals folder is not root-only (${st(APPROVALS)})`); return stopNow(); }

  // Run: the approval is loaded and checked first, before anything else is read or staged.
  let manifest = null, manifestBytes = null;
  if (MODE === "run") {
    console.log(`== A. approval ${GIVEN.slice(0, 16)}...`);
    step("approval", () => {
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

  console.log("== 2. job folder (operator's files, read once without following links)");
  let files = null, jobText = null, job = null;
  step("job folder", () => {
    // Pass 1: job.json alone decides which other names are allowed.
    const anyJson = (n) => (n === "job.json" ? ex.MAX_JOB_FILE_BYTES : /^[a-z0-9][a-z0-9._-]{0,63}\.json$/.test(n) ? Math.max(ex.MAX_DATASET_BYTES, ex.MAX_CONFIG_BYTES) : null);
    const first = readJobFolder(SRC, opUid, anyJson);
    if (!first["job.json"]) throw new Error("job.json: MISSING");
    jobText = checkJsonText("job.json", first["job.json"]);
    job = ex.parseResearchJob(jobText);
    if (job.dataset === "job.json" || job.config === "job.json") throw new Error("job.json: the dataset and config must not be named job.json");
    const caps = { "job.json": ex.MAX_JOB_FILE_BYTES, [job.dataset]: Math.min(SANDBOX_SPEC.maxInputFileBytes, ex.MAX_DATASET_BYTES), ...(job.config ? { [job.config]: ex.MAX_CONFIG_BYTES } : {}) };
    // Pass 2: the definitive read with the exact caps and the exact name set.
    files = readJobFolder(SRC, opUid, (n) => (Object.prototype.hasOwnProperty.call(caps, n) ? caps[n] : null));
    chk("job folder holds exactly job.json and the files it names", Object.keys(files).sort(), Object.keys(caps).sort());
    if (sha(files["job.json"]) !== sha(first["job.json"])) bad("job.json changed while being read");
    jobText = checkJsonText("job.json", files["job.json"]); job = ex.parseResearchJob(jobText);
    for (const n of Object.keys(files).filter((n) => n !== "job.json")) checkJsonText(n, files[n]);
    const total = Object.entries(files).filter(([n]) => n !== "job.json").reduce((a, [, b]) => a + b.length, 0);
    if (total > SANDBOX_SPEC.maxInputTotalBytes) bad(`inputs: ${total} bytes in total; the limit is ${SANDBOX_SPEC.maxInputTotalBytes}`);
    ok(`job: ${job.command} on ${job.dataset}${job.config ? " with " + job.config : ""}; files are UTF-8 JSON within their limits (content not interpreted)`);
  });
  if (fails > 0 || !files) return stopNow();
  const inputs = Object.fromEntries(Object.entries(files).filter(([n]) => n !== "job.json").map(([n, b]) => [n, { sha256: sha(b), bytes: b.length }]));

  if (MODE === "prepare") {
    const m = canon({
      kind: "e2-job-approval", version: 1, job: JOB, jobId: crypto.randomBytes(16).toString("hex"), createdAt: new Date().toISOString(),
      operatorUid: opUid, sourceDir: SRC, command: job.command, researchCommand: ex.researchCommand(job, SANDBOX_SPEC),
      jobFile: { sha256: sha(files["job.json"]), text: jobText }, inputs,
      code: { commit: COMMIT, manifestSha256: codeSha }, runnerConfigSha256: sha(confBytes), runId: conf.runId, imageId: scope.imageId,
      limits: { network: SANDBOX_SPEC.network, memoryBytes: SANDBOX_SPEC.memoryBytes, nanoCpus: SANDBOX_SPEC.nanoCpus, pidsLimit: SANDBOX_SPEC.pidsLimit, timeoutMs: SANDBOX_SPEC.timeoutMs },
    });
    const bytes = Buffer.from(JSON.stringify(m, null, 2) + "\n", "utf8"), h = sha(bytes);
    fs.writeFileSync(`${APPROVALS}/${h}.json`, bytes, { mode: 0o600, flag: "wx" });
    fs.rmSync(ev, { recursive: true, force: true });
    console.log(`\n  Job ${JOB}: ${job.command} (fixed command: ${clean(m.researchCommand.join(" "), 200)})`);
    for (const [n, i] of Object.entries(inputs)) console.log(`    ${n}  ${i.bytes} bytes  sha256 ${i.sha256}`);
    console.log(`    commit ${COMMIT.slice(0, 12)}, runner configuration ${m.runnerConfigSha256.slice(0, 16)}..., network none, single use, valid 24 h`);
    console.log(`\nAPPROVAL HASH: ${h}\nRESULT: PREPARED (no research was run). To run exactly this job once: run ${JOB} ${h}`);
    return;
  }

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
  fs.appendFileSync(RUNLOG, `${new Date().toISOString()} ${JOB} ${GIVEN} ${outcome.split(":")[0]} report=${reportSha || "none"} ${path.basename(ev)}\n`, { mode: 0o600 });
  if (report !== null) {
    const lines = report.split("\n");
    console.log(`\n---- report (untrusted text, ${Buffer.byteLength(report)} bytes, sha256 ${reportSha}; first ${Math.min(lines.length, 60)} of ${lines.length} lines) ----`);
    console.log(lines.slice(0, 60).join("\n")); console.log("---- end of report excerpt ----");
  }
  console.log(`\n  Evidence (root-only): ${ev}\n  Full report: sudo less ${ev}/report.txt`);
  console.log(outcome === "STOP" ? `\nRESULT: STOP (${fails} problem(s) above). The approval is consumed; do not retry, send this output.` : `\nRESULT: ${outcome}. The approval is consumed (single use).`);
  process.exitCode = outcome === "COMPLETED" ? 0 : outcome === "STOP" ? 1 : 3;
})().catch((e) => { console.log(`\nRESULT: STOP (internal error: ${clean(e.message, 200)}). Check for leftover containers. Send this output.`); process.exitCode = 1; });
JS
)
