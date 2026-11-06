( set -u
cd ~/automaton || exit 1
C=8e7e49771c5d26ea6adaf01b58cba670a4122b6e
stop() { echo "STOP: $* (nothing was run)"; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || stop "tracked files are modified in ~/automaton"
git fetch -q origin custom && git checkout -q --detach "$C" || stop "cannot check out $C"
[ "$(git rev-parse HEAD)" = "$C" ] || stop "HEAD is not $C"
[ -z "$(git status --porcelain --untracked-files=no)" ] && git diff --quiet "$C" -- && git diff --cached --quiet "$C" -- || stop "tracked files differ from $C"
for f in job fict-us-trend run-us-ma; do p=deploy/research-sandbox/e1b-sample/$f.json; [ "$(git hash-object "$p")" = "$(git rev-parse "$C:$p")" ] || stop "$p differs from $C"; done
echo "ok    commit $C checked out; tracked files and the fictional sample match it"
B=$(mktemp -d /tmp/e1c-build.XXXXXX) || stop "cannot create a build folder"
echo "..    building with $(./node_modules/.bin/tsc --version) into $B (fresh, empty)"
./node_modules/.bin/tsc --outDir "$B/dist" || stop "build failed"
for f in executor-main decision-scope trust-evidence-main preflight; do [ -f "$B/dist/research-sandbox/$f.js" ] || stop "build output lacks $f.js"; done
echo "ok    build exit 0; executor, decision scope, trust evidence and preflight compiled"
sudo node - "$B" <<'JS'
// E1c: first supervised synthetic-only validation (one executor job under gVisor). Run as root from ~/automaton at
// commit 8e7e49771c5d26ea6adaf01b58cba670a4122b6e with the fresh build folder as argument. Checks first; the job runs
// only if all pass, from a root-only copy of the hash-verified compiled code.
const fs = require("fs"), cp = require("child_process"), crypto = require("crypto"), path = require("path");
const ROOT = "";
const DOCKER = "/usr/bin/docker";
const CONF = ROOT + "/etc/research-sandbox/preflight.json", STATE = ROOT + "/var/lib/research-sandbox-setup";
const E1B_REPORT = "f9640ccea26832e65a008333b267c35bfca0fcd7398019593620350370ff8225";
const JOB_SHA = "c93a7fdf03a2552c5952371ff325de5b3b63823690d3d08d510c682eae5b8ecb";
const SAMPLES = { "fict-us-trend.json": "2972fd453c39196eaee5a9fb6b662cb92e63ae9160e48dcdea2b9fe6d6961837", "run-us-ma.json": "2608ded501ca25be891b9aa4e1735721f34a4be6fcedc91f1b3cf1275592da1c" };
/** SHA-256 of every compiled dist/research-sandbox/*.js at commit 8e7e4977 (tsc 5.9.3; two clean builds byte-identical). */
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
const PRIVATE_A2 = ["204501bdc37d656b934e0ef6a49f6bd3971915804713e6389fc7e3c72ffb55ef", "d8f3901bd8c3ced8d07e06413abb8cad69462b023fc4ff9d91462f3370c082dd", "b80fc575b08466678046961ea8961d0fb1c37ab485be4b09fea67c74d285fe35"];
const REPORT = { sha256: "6e1c989f1d313655a71233c7162c7d720cc536143403348f4e4fb2108295717a", bytes: 3560 };
const STEPS = ["inputs-checked", "preflight", "gate-passed", "rechecked", "create", "inspect", "run", "inspect-after-run", "report", "removed-verified", "runtime-rechecked"];
const E = { daemonJson: "2a35d833a5f8b7712711f26aae439d668fd5ca7620b99a4f8455a50a8c911da3", argv: ["/usr/bin/dockerd", "-H", "fd://", "--containerd=/run/containerd/containerd.sock"],
  pkgs: { "docker-ce": "5:29.9.3-1~ubuntu.24.04~noble", "docker-ce-cli": "5:29.9.3-1~ubuntu.24.04~noble", "containerd.io": "2.4.2-3~ubuntu.24.04~noble", runsc: "20261102.0" },
  secopts: ["name=apparmor,profile=default", "name=seccomp,profile=builtin", "name=cgroupns"],
  keyrings: { "9DC858229FC7DD38854AE2D88D81803C0EBFCD88": "1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570", "6F1DF85E3A71C24918E727D56FC6D554E32BD943": "6980344d5d10b0fe4dea6b0a8a3f12a50ff1b2f3f81c40fed43dd942eace0184" } };
let fails = 0;
const ok = (m) => console.log("  ok    " + m);
const bad = (m) => { fails += 1; console.log("  FAIL  " + m); };
const clean = (s, n = 300) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const chk = (name, got, want) => (same(got, want) ? ok : bad)(`${name}${same(got, want) ? "" : `: got ${clean(JSON.stringify(got === undefined ? null : got), 200)}`}`);
function readFile(p, label) { try { const st = fs.lstatSync(p); if (!st.isFile()) { bad(`${label}: not a regular file`); return null; } return fs.readFileSync(p); } catch (e) { bad(`${label}: MISSING or unreadable (${clean(e.code || e.message, 40)})`); return null; } }
function step(name, fn) { try { fn(); } catch (e) { bad(`${name}: check crashed (${clean(e.message, 160)})`); } }
const docker = (args, timeout = 30000) => cp.spawnSync(DOCKER, ["--host", "unix:///var/run/docker.sock", ...args], { encoding: "utf8", timeout });
function leftovers(label) {
  const r = docker(["ps", "-aq", "--filter", "name=research-sandbox-"]);
  if (r.error || r.status !== 0) return bad(`${label}: docker ps failed (exit ${r.status}): ${clean(r.stderr, 200)}`);
  const ids = r.stdout.split("\n").filter(Boolean);
  (ids.length === 0 ? ok : bad)(`${label}: ${ids.length} research-sandbox container(s)${ids.length ? " " + clean(ids.join(" "), 200) + " (inspect and remove manually)" : ""}`);
}

(async () => {
  const BUILD = process.argv[2];
  const ev = `${STATE}/e1c-${new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15)}`;
  let CODEDIR = null;
  console.log("== 0. compiled code: fresh build verified and copied to a root-only folder");
  step("code", () => {
    if (typeof BUILD !== "string" || !path.isAbsolute(BUILD)) return bad("no build folder given");
    const src = path.join(BUILD, "dist/research-sandbox");
    let names; try { names = fs.readdirSync(src).filter((n) => n.endsWith(".js")).sort(); } catch (e) { return bad(`build output ${clean(src, 120)}: MISSING (${clean(e.code, 20)})`); }
    chk("compiled file set (exact)", names, Object.keys(CODE).sort());
    fs.mkdirSync(ev, { mode: 0o700 });
    const dst = path.join(ev, "code/dist/research-sandbox");
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ev, "code/package.json"), '{"type":"module"}\n', { mode: 0o600 });
    let good = 0;
    for (const [n, h] of Object.entries(CODE)) {
      let b; try { const st = fs.lstatSync(path.join(src, n)); if (!st.isFile()) throw new Error("not a regular file"); b = fs.readFileSync(path.join(src, n)); } catch (e) { bad(`compiled ${n}: MISSING or not a regular file`); continue; }
      if (sha(b) !== h) { bad(`compiled ${n}: ${sha(b)} does not match commit 8e7e4977's build ${h.slice(0, 16)}...`); continue; }
      fs.writeFileSync(path.join(dst, n), b, { mode: 0o400 }); good += 1;   // the exact verified bytes; only this copy is executed
    }
    if (good === Object.keys(CODE).length && names.length === good) { CODEDIR = dst; ok(`${good} compiled files match commit 8e7e4977's build; executing only the root-only copy`); }
    for (const k of ["executor-main.js", "decision-scope.js", "trust-evidence-main.js", "preflight.js"]) if (!CODE[k]) bad(`manifest lacks ${k}`);
  });
  console.log("== 0b. private Step A2 evidence on this host (informational; does not block)");
  try {
    const found = new Map();
    const scan = (dir, depth) => { let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of es) { const p = path.join(dir, e.name);
        if (e.isDirectory() && !e.isSymbolicLink() && depth < 3) scan(p, depth + 1);
        else if (e.isFile() && e.name.endsWith(".json")) { try { if (fs.statSync(p).size <= 10 * 1024 * 1024) { const h = sha(fs.readFileSync(p)); if (PRIVATE_A2.includes(h) && !found.has(h)) found.set(h, p); } } catch {} } } };
    scan(STATE, 0); for (const d of fs.existsSync(ROOT + "/home") ? fs.readdirSync(ROOT + "/home") : []) scan(path.join(ROOT + "/home", d, "automaton-evidence"), 0);
    for (const h of PRIVATE_A2) console.log(`  info  ${h.slice(0, 16)}... ${found.has(h) ? "FOUND at " + clean(found.get(h).slice(ROOT.length), 160) : "not found on this host"}`);
  } catch (e) { console.log(`  info  search skipped (${clean(e.message, 80)})`); }

  console.log("== 0c. configuration and job files vs the executor's file reader (permissions-only fix if refused)");
  const PREV = `${STATE}/e1c-20261106-130101`;
  let reader = null;
  if (CODEDIR) { try { reader = (await import(path.join(CODEDIR, "preflight-main.js"))).readRunnerConfigFile; } catch (e) { bad(`cannot load the verified file reader (${clean(e.message, 120)})`); } }
  else bad("file reader: no verified code");
  const tryRead = (p) => { try { reader(p, 0); return null; } catch (e) { return clean((e.problems || [String(e.message)]).join("; "), 240); } };
  const st = (p) => { try { const s = fs.lstatSync(p); return `${s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other"} uid ${s.uid} gid ${s.gid} mode ${(s.mode & 0o777).toString(8)}`; } catch { return "MISSING"; } };
  try { const pr = JSON.parse(fs.readFileSync(`${PREV}/executor-run.json`, "utf8")); console.log(`  info  previous run refused: ${clean((pr.violations || []).join(" | "), 300)}`); }
  catch { try { console.log(`  info  previous run log: ${clean(fs.readFileSync(`${PREV}/executor-run.log`, "utf8").trim().split("\n").slice(-3).join(" / "), 300)}`); } catch { console.log("  info  previous run evidence not readable"); } }
  for (const p of [path.dirname(CONF), CONF, PREV, `${PREV}/job.json`]) console.log(`  info  ${clean(p.slice(ROOT.length), 120)}: ${st(p)}`);
  step("configuration permissions", () => {
    if (!reader) return;
    console.log(`  info  previous job.json with the reader: ${tryRead(`${PREV}/job.json`) ?? "accepted"}`);
    let why = tryRead(CONF);
    if (why === null) return ok("runner configuration accepted by the executor's file reader (no change)");
    console.log(`  info  runner configuration refused by the reader: ${why}`);
    const dir = path.dirname(CONF), ds = fs.lstatSync(dir), fst = fs.lstatSync(CONF);
    if (ds.isSymbolicLink() || !ds.isDirectory() || fst.isSymbolicLink() || !fst.isFile()) return bad("configuration or its folder is a symbolic link or not a regular file/folder: not changed");
    const before = sha(fs.readFileSync(CONF));
    if (ds.uid !== 0 || (ds.mode & 0o022) !== 0) { fs.chownSync(dir, 0, 0); fs.chmodSync(dir, ds.mode & 0o755); console.log(`  fix   ${clean(dir.slice(ROOT.length), 80)}: root:root, mode ${(fs.lstatSync(dir).mode & 0o777).toString(8)} (group/other write removed)`); }
    if (fst.uid !== 0 || (fst.mode & 0o077) !== 0) { fs.chownSync(CONF, 0, 0); fs.chmodSync(CONF, 0o600); console.log(`  fix   ${clean(CONF.slice(ROOT.length), 80)}: root:root, mode 600`); }
    const after = sha(fs.readFileSync(CONF));
    (after === before ? ok : bad)(`configuration bytes unchanged by the fix (sha256 ${after.slice(0, 16)}...)`);
    why = tryRead(CONF);
    (why === null ? ok : bad)(`runner configuration ${why === null ? "now accepted by the executor's file reader" : "still refused: " + why}`);
  });

  console.log("== 1. runner configuration and pins");
  let scope = null, conf = null, pins = null, run = null;
  if (CODEDIR) { try { scope = (await import(path.join(CODEDIR, "decision-scope.js"))).ACCEPTED_DECISION_SCOPE; ok("decision scope loaded from the verified copy"); } catch (e) { bad(`cannot load the verified decision-scope.js (${clean(e.message, 120)})`); } }
  else bad("decision scope: no verified code");
  step("config", () => {
    const raw = readFile(CONF, "runner configuration"); if (!raw) return;
    let setup = null;
    for (const d of fs.existsSync(STATE) ? fs.readdirSync(STATE).filter((n) => /^setup-/.test(n)).sort() : []) {
      const r = path.join(STATE, d, "preflight-report.json");
      try { if (fs.lstatSync(r).isFile() && sha(fs.readFileSync(r)) === E1B_REPORT) setup = path.join(STATE, d); } catch {}
    }
    const copy = setup && readFile(path.join(setup, "preflight-config.json"), "E1b configuration copy");
    if (!setup) bad("E1b setup run: NOT FOUND");
    else if (copy) (Buffer.compare(copy, raw) === 0 ? ok : bad)(`runner configuration ${Buffer.compare(copy, raw) === 0 ? "is byte-identical to" : "DIFFERS from"} the E1b run's copy`);
    conf = JSON.parse(raw.toString("utf8")); pins = conf && conf.pins;
    if (!conf || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(conf.runId)) || !pins) { bad("runner configuration: runId or pins missing"); pins = null; }
    else run = { runId: conf.runId, in: `${ROOT}/srv/research-runs/${conf.runId}/in`, out: `${ROOT}/srv/research-runs/${conf.runId}/out` };
  });
  step("pins vs decision scope", () => {
    if (!scope || !pins) return bad("pins vs decision scope: unavailable");
    const r = pins.runscBinary || {};
    chk("runsc path and args", [r.path, r.args], [scope.runscPath, [...scope.runscArgs]]);
    chk("runsc sha256 (accepted pin)", r.sha256, scope.runscSha256);
    const key = (xs) => (Array.isArray(xs) ? xs.map((x) => `${x && x.path} ${x && x.sha256}`).sort() : null);
    chk("sidecars (exact accepted set)", key(r.sidecars), key(scope.sidecars));
    chk("gVisor reference (accepted pin)", pins.gvisorProcVersion, scope.gvisorProcVersion);
    chk("image ID", pins.imageId, scope.imageId);
    chk("Docker server version / data root", [pins.dockerServerVersion, pins.dockerDataRoot], [scope.dockerServerVersion, scope.dockerDataRoot]);
    for (const f of [{ label: "runsc", path: r.path, sha256: r.sha256 }, ...(Array.isArray(r.sidecars) ? r.sidecars.map((s) => ({ label: "sidecar", ...s })) : [])]) {
      let st; try { st = fs.lstatSync(ROOT + f.path); } catch { bad(`${f.label} ${clean(f.path, 100)}: MISSING`); continue; }
      if (!st.isFile()) { bad(`${f.label} ${clean(f.path, 100)}: not a regular file`); continue; }
      if (st.uid !== 0 || (st.mode & 0o022) !== 0) bad(`${f.label} ${clean(f.path, 100)}: not root-owned or writable by group/others`);
      const h = sha(fs.readFileSync(ROOT + f.path));
      (h === f.sha256 ? ok : bad)(`${f.label} ${clean(f.path, 100)}: on disk ${h === f.sha256 ? "MATCHES" : h + " MISMATCHES " + clean(f.sha256, 64)}`);
    }
    const im = docker(["image", "inspect", "--format", "{{.Id}}", String(pins.imageId)]);
    if (im.error || im.status !== 0) bad(`image inspect failed (exit ${im.status}): ${clean(im.stderr, 200)}`);
    else (im.stdout.trim() === scope.imageId ? ok : bad)(`research image present: ${clean(im.stdout.trim(), 80)}`);
  });

  console.log("== 2. Docker configuration (read-only trust evidence) vs E1b");
  step("trust evidence", () => {
    if (!CODEDIR) return bad("trust evidence: no verified code");
    const main = path.join(CODEDIR, "trust-evidence-main.js");
    const r = cp.spawnSync(process.execPath, [main, "--config", CONF, "--confirm-read-only-host-queries"], { encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error) return bad(`collection did not run: ${clean(r.error.code || r.error.message, 80)}`);
    if (r.status !== 4) return bad(`collection exit ${r.status} (4 expected: needs-review); stderr: ${clean(r.stderr, 400) || "(empty)"}`);
    let t; try { t = JSON.parse(r.stdout); } catch { return bad(`output is not JSON; stderr: ${clean(r.stderr, 300) || "(empty)"}`); }
    const canon = (x) => Array.isArray(x) ? x.map(canon) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x;
    const { digest, ...body } = t;
    (t.kind === "research-sandbox-trust-evidence" && digest === "sha256:" + sha(JSON.stringify(canon(body))) ? ok : bad)("report kind and digest");
    chk("verdict / blocking / review", [t.verdict, t.blocking, t.review, Array.isArray(t.findings) && t.findings.length], ["needs-review", 0, 1, 1]);
    const e = t.evidence || {};
    chk("daemon.json sha256", e.daemonJson && e.daemonJson.sha256, E.daemonJson);
    chk("daemon.json valid, only runtimes, no other runtime or default", e.daemonJson && [e.daemonJson.valid, e.daemonJson.duplicateKey, e.daemonJson.keys, e.daemonJson.otherRuntimes, e.daemonJson.defaultRuntime], [true, null, ["runtimes"], [], null]);
    chk("dockerd argv / drop-ins", e.dockerd && [e.dockerd.argv, e.dockerd.dropIns], [E.argv, []]);
    for (const [k, v] of Object.entries(E.pkgs)) { const p = e.packages && e.packages[k]; chk(`${k} version, status, dpkg --verify`, p && [p.installed, p.status, p.verify], [v, "ii", []]); }
    chk("daemon version / security options / data root", e.dockerInfo && [e.dockerInfo.ServerVersion, e.dockerInfo.SecurityOptions, e.dockerInfo.DockerRootDir], ["29.9.3", E.secopts, "/var/lib/docker"]);
    const kr = Array.isArray(e.aptSources) ? Object.fromEntries(e.aptSources.flatMap((s) => (Array.isArray(s.fingerprints) ? s.fingerprints : []).map((f) => [f, s.keyringSha256]))) : {};
    for (const [fp, h] of Object.entries(E.keyrings)) chk(`apt keyring ${fp.slice(-8)}`, kr[fp], h);
  });

  console.log("== 3. committed fictional sample, run folders, no leftovers");
  step("inputs", () => {
    const job = readFile("deploy/research-sandbox/e1b-sample/job.json", "committed sample job");
    if (job) (sha(job) === JOB_SHA ? ok : bad)(`committed sample job sha256 ${sha(job).slice(0, 16)}...`);
    if (!run) return bad("run folders: unknown");
    let names = null; try { names = fs.readdirSync(run.in).sort(); } catch (e) { return bad(`input folder: cannot list (${clean(e.code, 20)})`); }
    chk("input folder holds exactly the two sample files", names, Object.keys(SAMPLES).sort());
    for (const [n, h] of Object.entries(SAMPLES)) {
      const b = readFile(path.join(run.in, n), `input ${n}`); if (!b) continue;
      const c = readFile(`deploy/research-sandbox/e1b-sample/${n}`, `committed ${n}`);
      (sha(b) === h && c && sha(c) === h ? ok : bad)(`input ${n}: ${sha(b) === h ? "equals the committed fictional sample" : "DIFFERS from the committed sample"}`);
    }
    let out = null; try { out = fs.readdirSync(run.out); } catch (e) { return bad(`output folder: cannot list (${clean(e.code, 20)})`); }
    (out.length === 0 ? ok : bad)(`output folder empty (${out.length} entries)`);
  });
  leftovers("before the run");

  console.log("== 4. one executor job under gVisor (only if 1-3 passed)");
  if (fails > 0 || !CODEDIR) { console.log(`\nRESULT: STOP before the job (${fails} problem(s) above). No research container was created. Send this output.`); process.exitCode = 1; return; }
  fs.copyFileSync("deploy/research-sandbox/e1b-sample/job.json", `${ev}/job.json`); fs.chmodSync(`${ev}/job.json`, 0o600);
  for (const [label, p] of [["runner configuration", CONF], ["job file", `${ev}/job.json`]]) {
    const why = reader ? tryRead(p) : "no verified file reader";
    if (why !== null) { bad(`${label} refused by the executor's file reader: ${why}`); console.log(`\nRESULT: STOP before the job (${fails} problem(s) above). No research container was created. Send this output.`); process.exitCode = 1; return; }
    ok(`${label} accepted by the executor's file reader (${st(p)})`);
  }
  const t0 = Date.now();
  const x = cp.spawnSync(process.execPath, [path.join(CODEDIR, "executor-main.js"), "--config", CONF, "--job", `${ev}/job.json`, "--confirm-sandboxed-research"], { encoding: "utf8", timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(`${ev}/executor-run.json`, x.stdout || "", { mode: 0o600 });
  fs.writeFileSync(`${ev}/executor-run.log`, x.stderr || "", { mode: 0o600 });
  console.log(`  ..    executor finished in ${Math.round((Date.now() - t0) / 1000)} s, exit ${x.status}${x.error ? " (" + clean(x.error.code, 20) + ")" : ""}`);
  step("executor result", () => {
    if (x.error) return bad(`executor did not complete (${clean(x.error.code || x.error.message, 60)}); check for leftover containers`);
    (x.status === 0 ? ok : bad)(`executor exit ${x.status} (0 expected); log: ${clean((x.stderr || "").trim().split("\n").pop(), 200)}`);
    let r; try { r = JSON.parse(x.stdout); } catch { return bad("executor output is not JSON (see executor-run.log)"); }
    const a = r.audit || {};
    chk("status / research CLI exit", [r.runner, r.status, a.researchExitCode], ["research-sandbox-executor", "completed", 0]);
    if (Array.isArray(r.violations) && r.violations.length) bad(`violations: ${clean(r.violations.join(" | "), 400)}`);
    chk("steps (preflight, gate, re-checks, create, inspect, run, report, cleanup, runtime re-check)", r.steps, STEPS);
    chk("fresh preflight", a.preflight && [a.preflight.rating, a.preflight.violations], ["meets-spec", 0]);
    chk("runtime / image", [a.runtime, a.imageRef], ["runsc", scope.imageId]);
    chk("job and inputs (hashes)", [a.jobSha256, Array.isArray(a.inputs) && a.inputs.map((i) => [i.name, i.sha256])], [JOB_SHA, Object.entries(SAMPLES).sort()]);
    const h = a.hostProcessEvidence;
    chk("gVisor host-process evidence", h && [h.polls >= 10, h.sandboxProcesses >= 1, h.canaryOnHost, h.replacedExecutables, h.overflow], [true, true, 0, 0, false]);
    if (h) console.log(`  ..    host processes: ${h.polls} samples, ${h.sandboxProcesses} gVisor process(es), research script on host ${h.canaryOnHost}; executables ${clean((h.executables || []).join(", "), 300)}`);
    chk("cleanup verified", a.cleanup && a.cleanup.verifiedRemoved, true);
    chk("report bytes / sha256 (offline prediction)", [a.reportBytes, a.reportSha256], [REPORT.bytes, REPORT.sha256]);
    if (typeof r.report === "string") console.log("  ..    report begins: " + clean(r.report.split("\n").slice(0, 4).join(" / "), 260));
  });
  leftovers("after the run");
  step("output folder", () => { const o = fs.readdirSync(run.out); (o.length === 0 ? ok : bad)(`output folder still empty (${o.length} entries)`); });
  const sums = ["job.json", "executor-run.json", "executor-run.log"].map((f) => `${sha(fs.readFileSync(`${ev}/${f}`))}  ${f}`).join("\n") + "\n";
  fs.writeFileSync(`${ev}/SHA256SUMS`, sums, { mode: 0o600 });
  console.log("\n" + sums.trim().split("\n").map((l) => "  " + l).join("\n") + `\n  Evidence (root-only): ${ev}`);
  console.log(fails === 0 ? "\nRESULT: PASS: one synthetic job completed under gVisor with every check as expected. Send this output." : `\nRESULT: STOP (${fails} problem(s) above). Do not run again; send this output.`);
  process.exitCode = fails === 0 ? 0 : 1;
})().catch((e) => { console.log(`\nRESULT: STOP (internal error: ${clean(e.message, 200)}). Check for leftover containers. Send this output.`); process.exitCode = 1; });
JS
)
