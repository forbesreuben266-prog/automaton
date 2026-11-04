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
    expect(executed).toEqual(['systemctl reload docker || die "systemctl reload docker failed. Roll back with: $ROLLBACK"']);
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
    expect(r.stdout).toContain("already enabled");
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
