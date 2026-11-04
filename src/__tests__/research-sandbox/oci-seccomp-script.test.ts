/**
 * V2.4: deploy/research-sandbox/enable-oci-seccomp.sh, offline only. Static
 * checks, plus its DRY RUN (--check-config on temporary copies) and its
 * refusals. --execute is only started with a fake `id` reporting a non-root
 * user, so it stops before any write, reload or Docker call.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPROVED_RUNSC_ARGS } from "../../research-sandbox/index.js";

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "deploy/research-sandbox/enable-oci-seccomp.sh");
const TEXT = fs.readFileSync(SCRIPT, "utf8");
const CODE = TEXT.replace(/\\\n\s*/g, " ").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

let dir: string;
let bin: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "eos-")); bin = path.join(dir, "fakebin"); fs.mkdirSync(bin); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const run = (args: string[]) => childProcess.spawnSync("bash", [SCRIPT, ...args], {
  cwd: dir, encoding: "utf8", timeout: 30_000, env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir },
});
const conf = (content: string) => { const p = path.join(dir, "daemon.json"); fs.writeFileSync(p, content); return p; };

describe("enable-oci-seccomp.sh: static checks", () => {
  it("is valid bash with pipefail", () => {
    expect(childProcess.spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    expect(TEXT).toContain("set -o pipefail");
  });

  it("sets exactly the approved flag, for runsc at /usr/bin/runsc, in /etc/docker/daemon.json", () => {
    expect(TEXT).toContain(`FLAG='${APPROVED_RUNSC_ARGS[0]}'`);
    expect(APPROVED_RUNSC_ARGS).toHaveLength(1);
    expect(TEXT).toContain("CONF=/etc/docker/daemon.json");
    expect(TEXT).toContain("RUNSC=/usr/bin/runsc");
    expect(TEXT).toContain("next.runtimes.runsc = { path: runsc, runtimeArgs: [flag] };");
  });

  it("only reloads Docker (never restarts, stops or reconfigures anything else) and never downloads or installs", () => {
    const executed = CODE.split("\n").filter((l) => /^\s*systemctl\b/.test(l));
    expect(executed).toHaveLength(2); // the change path and the "already in the file, not active yet" path
    for (const l of executed) expect(l.trim().startsWith("systemctl reload docker || die ")).toBe(true);
    expect(CODE.match(/systemctl \w+ \w+/g)!.every((m) => m === "systemctl reload docker")).toBe(true); // also in the rollback text
    for (const banned of [/\brestart\b/, /systemctl (stop|start|daemon-reload|enable|disable)/, /\bcurl\b|\bwget\b/, /\bapt(-get)?\b|\bdpkg -i\b/, /runsc install/, /"\$DOCKER" (run|create|start|pull|build|rm)\b/, /\bprune\b/]) {
      expect(banned.test(CODE), String(banned)).toBe(false);
    }
  });

  it("writes only a backup, a temporary file next to the config, and the config itself", () => {
    const writes = CODE.split("\n").filter((l) => /\b(cp|mv|tee|chmod|chown)\b|>\s*"/.test(l));
    for (const l of writes) expect(/\$CONF|\$BACKUP|\$TMP/.test(l), l).toBe(true);
    expect(TEXT).toContain('BACKUP="$CONF.bak-$(date -u +%Y%m%d-%H%M%S-%N)"');
    expect(TEXT).toContain('TMP="$(mktemp "$CONF.new.XXXXXX")"');
  });
});

describe("enable-oci-seccomp.sh: dry run on a copy", () => {
  it("plans only the runsc change and writes nothing", () => {
    const original = '{"log-level":"warn","runtimes":{"runsc":{"path":"/usr/bin/runsc"},"other":{"path":"/usr/bin/x"}},"features":{"containerd-snapshotter":true}}\n';
    const p = conf(original);
    const before = fs.readdirSync(dir).sort();
    const r = run([`--check-config=${p}`]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("DRY RUN: nothing was written");
    const planned = JSON.parse(r.stdout.split("(only runtimes.runsc changes):\n")[1].split("\n\nDRY RUN")[0]);
    const expected = JSON.parse(original);
    expected.runtimes.runsc = { path: "/usr/bin/runsc", runtimeArgs: ["--oci-seccomp"] };
    expect(planned).toEqual(expected);
    expect(fs.readFileSync(p, "utf8")).toBe(original);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it("an empty runtimeArgs list is replaced too", () => {
    const r = run([`--check-config=${conf('{"runtimes":{"runsc":{"path":"/usr/bin/runsc","runtimeArgs":[]}}}')}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"--oci-seccomp"');
  });

  it("already enabled: reports it and changes nothing", () => {
    const r = run([`--check-config=${conf('{"runtimes":{"runsc":{"path":"/usr/bin/runsc","runtimeArgs":["--oci-seccomp"]}}}')}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already registers runsc with exactly");
    expect(r.stdout).toContain("DRY RUN: nothing was checked against the running daemon");
  });

  it.each([
    ["invalid JSON", "{", "daemon.json is not valid JSON"],
    ["not an object", "[]", "daemon.json is not a JSON object"],
    ["no runsc entry", '{"runtimes":{}}', "no runtimes.runsc entry"],
    ["another path", '{"runtimes":{"runsc":{"path":"/opt/runsc"}}}', 'runtimes.runsc.path is "/opt/runsc"'],
    ["a shim form", '{"runtimes":{"runsc":{"runtimeType":"io.containerd.runsc.v1"}}}', "runtimes.runsc has other keys: runtimeType"],
    ["other flags already set", '{"runtimes":{"runsc":{"path":"/usr/bin/runsc","runtimeArgs":["--debug"]}}}', 'already has other flags: ["--debug"]'],
    ["the flag plus another", '{"runtimes":{"runsc":{"path":"/usr/bin/runsc","runtimeArgs":["--oci-seccomp","--net-raw"]}}}', "already has other flags"],
  ])("%s: refused, file unchanged", (_l, content, message) => {
    const p = conf(content);
    const r = run([`--check-config=${p}`]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain(message);
    expect(r.stdout).toContain("STOP  refusing to change");
    expect(fs.readFileSync(p, "utf8")).toBe(content);
  });

  it("a symbolic link or a missing file is refused", () => {
    const target = conf('{"runtimes":{"runsc":{"path":"/usr/bin/runsc"}}}');
    const link = path.join(dir, "link.json");
    fs.symlinkSync(target, link);
    expect(run([`--check-config=${link}`]).stdout).toContain("is a symbolic link");
    expect(run([`--check-config=${path.join(dir, "none.json")}`]).stdout).toContain("does not exist");
  });
});

describe("enable-oci-seccomp.sh: refusals before anything happens", () => {
  it.each([[["--force"], "unknown argument '--force'"], [["--execute", "--check-config=/tmp/x"], "--check-config is a dry run only"]])("usage %j", (args, message) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(message);
  });

  it("--execute refuses to run as a non-root user, before reading, writing or reloading anything", () => {
    fs.writeFileSync(path.join(bin, "id"), '#!/usr/bin/env bash\nif [ "$1" = -u ]; then echo 1000; else /usr/bin/id "$@"; fi\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "systemctl"), `#!/usr/bin/env bash\necho called > "${dir}/systemctl-called"\n`, { mode: 0o755 });
    const r = run(["--execute"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("STOP  --execute must run as root (sudo)");
    expect(fs.existsSync(path.join(dir, "systemctl-called"))).toBe(false);
  });
});

describe("V2.4.1: duplicate keys, stat failures and mode (dry run on a copy)", () => {
  it.each([
    ["at the top level", '{"runtimes":{"runsc":{"path":"/usr/bin/runsc"}},"runtimes":{}}', '"runtimes"'],
    ["inside runsc", '{"runtimes":{"runsc":{"path":"/usr/bin/runsc","path":"/tmp/evil"}}}', '"path"'],
    ["spelled with an escape", '{"runtimes":{"runsc":{"path":"/usr/bin/runsc","\\u0070ath":"/tmp/evil"}}}', '"path"'],
    ["in an unrelated object", '{"log-opts":{"max-size":"1m","max-size":"2m"},"runtimes":{"runsc":{"path":"/usr/bin/runsc"}}}', '"max-size"'],
    ["in an object inside an array", '{"x":[{"a":1,"a":2}],"runtimes":{"runsc":{"path":"/usr/bin/runsc"}}}', '"a"'],
  ])("a repeated key %s: refused, file unchanged", (_l, content, key) => {
    const p = conf(content);
    const r = run([`--check-config=${p}`]);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain(`daemon.json repeats the key ${key} in one object`);
    expect(fs.readFileSync(p, "utf8")).toBe(content);
  });

  it("the same key in different objects, and keys inside string values, are not duplicates", () => {
    const r = run([`--check-config=${conf('{"a":{"path":1},"b":{"path":"{\\"path\\":2,\\"path\\":3}"},"runtimes":{"runsc":{"path":"/usr/bin/runsc"}}}')}`]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it.each([
    ["stat fails", "exit 1", "cannot read the owner of"],
    ["stat prints nothing", "exit 0", "cannot read the owner of"],
    ["stat prints garbage for the mode", 'case "$*" in *%u*) echo 0;; *) echo rw-r--r--;; esac', "cannot read the mode of"],
  ])("%s: refused (fail closed)", (_l, body, message) => {
    fs.writeFileSync(path.join(bin, "stat"), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    const r = run([`--check-config=${conf('{"runtimes":{"runsc":{"path":"/usr/bin/runsc"}}}')}`]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(message);
  });

  it("a group- or world-writable file is refused", () => {
    const p = conf('{"runtimes":{"runsc":{"path":"/usr/bin/runsc"}}}');
    fs.chmodSync(p, 0o664);
    expect(run([`--check-config=${p}`]).stdout).toContain("is writable by group or others (mode 664)");
  });
});

/**
 * --execute end to end, offline: a copy of the script with ONLY its three path constants pointed at a temporary
 * folder; fake id (root), stat (owner 0), systemctl (a reload copies daemon.json into the fake daemon's state),
 * docker (reports runsc from that state) and sleep. No real Docker, systemd or /etc file is touched.
 */
describe("V2.4.1: --execute end to end with fakes", () => {
  const ORIGINAL = '{"log-level":"warn","runtimes":{"runsc":{"path":"RUNSC"}}}\n';
  const ENABLED = '{"runtimes":{"runsc":{"path":"RUNSC","runtimeArgs":["--oci-seccomp"]}}}\n';
  const real = (c: string) => childProcess.execFileSync("bash", ["-c", `command -v ${c}`], { encoding: "utf8" }).trim();

  function setup(opts: { conf: string; state?: string; reload?: "applies" | "no-effect" | "fails"; mktempHook?: boolean; cpCorrupt?: boolean }) {
    const etc = path.join(dir, "etc");
    fs.mkdirSync(etc);
    const CONF = path.join(etc, "daemon.json");
    const RUNSC = path.join(bin, "runsc");
    const STATE = path.join(dir, "daemon-state.json");
    const LOG = path.join(dir, "calls.log");
    const fill = (t: string) => t.replace(/RUNSC/g, RUNSC);
    fs.writeFileSync(CONF, fill(opts.conf), { mode: 0o644 });
    fs.writeFileSync(STATE, fill(opts.state ?? opts.conf));
    let text = TEXT;
    for (const [a, b] of [["CONF=/etc/docker/daemon.json", `CONF=${CONF}`], ["RUNSC=/usr/bin/runsc", `RUNSC=${RUNSC}`], ["DOCKER=/usr/bin/docker", `DOCKER=${path.join(bin, "docker")}`]]) {
      expect(text.split(a).length - 1, a).toBe(1);
      text = text.replace(a, b);
    }
    const script = path.join(dir, "script.sh");
    fs.writeFileSync(script, text);
    const fake = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    fake("runsc", "exit 0");
    fake("id", 'if [ "$1" = -u ]; then echo 0; else exit 1; fi');
    fake("stat", `case "$*" in *%u*) echo 0;; *) exec ${real("stat")} "$@";; esac`);
    fake("sleep", "exit 0");
    const reload = opts.reload ?? "applies";
    fake("systemctl", `echo "systemctl $*" >> "${LOG}"; [ "$*" = "reload docker" ] || exit 9; ${reload === "fails" ? "exit 1" : reload === "applies" ? `cp "${CONF}" "${STATE}"` : "true"}`);
    fake("docker", `echo "docker $*" >> "${LOG}"; exec node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).runtimes.runsc))' "${STATE}"`);
    if (opts.mktempHook) fake("mktemp", `echo '{"changed":"by someone else"}' > "${CONF}"; exec ${real("mktemp")} "$@"`);
    if (opts.cpCorrupt) fake("cp", `${real("cp")} "$@" && for last; do :; done && echo x >> "$last"`);
    const go = () => childProcess.spawnSync("bash", [script, "--execute"], { cwd: dir, encoding: "utf8", timeout: 30_000, env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir } });
    const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "");
    const backups = () => fs.readdirSync(etc).filter((f) => f.startsWith("daemon.json.bak-"));
    const leftovers = () => fs.readdirSync(etc).filter((f) => f.startsWith("daemon.json.new."));
    return { CONF, etc, go, log, backups, leftovers, original: fill(opts.conf) };
  }

  it("changes only runsc, verifies a byte-identical backup, reloads once and verifies the running daemon", () => {
    const h = setup({ conf: ORIGINAL });
    const r = h.go();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("(verified identical)");
    expect(r.stdout).toContain("PASS: gVisor in-sandbox seccomp is enabled");
    const after = JSON.parse(fs.readFileSync(h.CONF, "utf8"));
    expect(after.runtimes.runsc.runtimeArgs).toEqual(["--oci-seccomp"]);
    expect(after["log-level"]).toBe("warn");
    expect(h.backups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(h.etc, h.backups()[0]), "utf8")).toBe(h.original);
    expect(h.log().match(/systemctl reload docker/g)).toHaveLength(1);
    expect(h.leftovers()).toEqual([]);
  });

  it("gap 1: already in the file AND active: verified via docker info; no reload, no backup, no change", () => {
    const h = setup({ conf: ENABLED });
    const r = h.go();
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("PASS: already enabled and active; nothing was changed.");
    expect(h.log()).toContain("docker --host unix:///var/run/docker.sock info");
    expect(h.log()).not.toContain("systemctl");
    expect(h.backups()).toEqual([]);
    expect(fs.readFileSync(h.CONF, "utf8")).toBe(h.original);
  });

  it("gap 1: already in the file but NOT active (an earlier reload failed): reloads, then verifies; the file is not changed", () => {
    const h = setup({ conf: ENABLED, state: ORIGINAL });
    const r = h.go();
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("the running daemon does not report it yet: reloading Docker");
    expect(r.stdout).toContain("PASS: enabled and active");
    expect(h.log().match(/systemctl reload docker/g)).toHaveLength(1);
    expect(fs.readFileSync(h.CONF, "utf8")).toBe(h.original);
    expect(h.backups()).toEqual([]);
  });

  it("gap 1: already in the file, not active, and the reload has no effect: STOP (never a false PASS)", () => {
    const h = setup({ conf: ENABLED, state: ORIGINAL, reload: "no-effect" });
    const r = h.go();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("still does not show runsc");
    expect(r.stdout).not.toContain("PASS");
  });

  it("the reload has no effect after a change: STOP with the rollback command; the backup holds the original", () => {
    const h = setup({ conf: ORIGINAL, reload: "no-effect" });
    const r = h.go();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("docker info does not show runsc");
    expect(r.stdout).toMatch(/Roll back with: sudo cp -p \S+daemon\.json\.bak-\S+ \S+daemon\.json && sudo systemctl reload docker/);
    expect(fs.readFileSync(path.join(h.etc, h.backups()[0]), "utf8")).toBe(h.original);
  });

  it("systemctl reload failing: STOP with the rollback command", () => {
    const h = setup({ conf: ORIGINAL, reload: "fails" });
    const r = h.go();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("systemctl reload docker failed. Roll back with: sudo cp -p");
  });

  it("gap 3: daemon.json changed between reading and replacing: STOP; the other change is kept, nothing reloaded, no temp file left", () => {
    const h = setup({ conf: ORIGINAL, mktempHook: true });
    const r = h.go();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("changed while this script was running; nothing was modified");
    expect(fs.readFileSync(h.CONF, "utf8")).toBe('{"changed":"by someone else"}\n');
    expect(h.leftovers()).toEqual([]);
    expect(h.log()).not.toContain("systemctl");
  });

  it("backup check: a backup that differs from the original: STOP before anything is modified", () => {
    const h = setup({ conf: ORIGINAL, cpCorrupt: true });
    const r = h.go();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("does not match");
    expect(r.stdout).toContain("nothing was modified");
    expect(fs.readFileSync(h.CONF, "utf8")).toBe(h.original);
    expect(h.log()).not.toContain("systemctl");
  });

  it("gap 2 under --execute: stat failing refuses before any write", () => {
    const h = setup({ conf: ORIGINAL });
    fs.writeFileSync(path.join(bin, "stat"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const r = h.go();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("cannot read the owner of");
    expect(h.backups()).toEqual([]);
    expect(fs.readFileSync(h.CONF, "utf8")).toBe(h.original);
  });

  it("a file not owned by root is refused under --execute", () => {
    const h = setup({ conf: ORIGINAL });
    fs.writeFileSync(path.join(bin, "stat"), `#!/usr/bin/env bash\ncase "$*" in *%u*) echo 1000;; *) exec ${real("stat")} "$@";; esac\n`, { mode: 0o755 });
    expect(h.go().stdout).toContain("is not owned by root");
  });
});
