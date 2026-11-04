/**
 * V2: deploy/research-sandbox/host-setup.sh, offline only. Static checks on
 * the script's commands, and runs of its DRY-RUN mode and of its refusals
 * (usage errors, missing build output, wrong Node version, not root). Execute
 * mode is only ever started with a fake `id` reporting a non-root user, so it
 * stops before any Docker call or write; no test reaches Docker.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SANDBOX_SPEC } from "../../research-sandbox/index.js";

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "deploy/research-sandbox/host-setup.sh");
const TEXT = fs.readFileSync(SCRIPT, "utf8");
/** Shell lines with backslash continuations joined, comments removed. */
const LINES = TEXT.replace(/\\\n\s*/g, " ").split("\n").filter((l) => !/^\s*#/.test(l));

let dir: string;
let bin: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-"));
  bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin);
  // A minimal "repository": the files the script requires (contents irrelevant to these tests).
  for (const f of ["deploy/research-sandbox/Dockerfile.canary", "deploy/research-sandbox/package.json", "dist/research-sandbox/preflight-main.js",
    "dist/research-sandbox/canary-probe.js", "dist/research-sandbox/canary.js"]) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "x\n");
  }
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const fake = (name: string, body: string) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); };
const run = (args: string[], opts: { trace?: boolean } = {}) => childProcess.spawnSync("bash", [...(opts.trace ? ["-x"] : []), SCRIPT, ...args], {
  cwd: dir, encoding: "utf8", timeout: 30_000, env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir },
});
const listing = () => fs.readdirSync(dir, { recursive: true }).map(String).sort();

describe("host-setup.sh: static checks", () => {
  it("is valid bash", () => {
    expect(childProcess.spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("uses exactly the sandbox specification's base image", () => {
    expect(TEXT).toContain(`BASE_REF="${SANDBOX_SPEC.image.repository}:${SANDBOX_SPEC.image.tag}"`);
  });

  it("every container it creates or runs has no network, no download, no capabilities, a read-only root and an unprivileged user", () => {
    const containerLines = LINES.filter((l) => /"\$DOCKER" (create|run)\b/.test(l));
    expect(containerLines.length).toBe(2); // manifest_of (create) and the gVisor reference (run)
    for (const l of containerLines) {
      for (const flag of ["--pull never", "--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges:true", '--user "$SANDBOX_UID:$SANDBOX_UID"']) {
        expect(l, l).toContain(flag);
      }
    }
    const gvisorRun = containerLines.find((l) => /"\$DOCKER" run\b/.test(l))!;
    for (const flag of ["--rm", "--runtime runsc", "--memory 256m", "--memory-swap 256m", "--pids-limit 64"]) expect(gvisorRun).toContain(flag);
    const build = LINES.find((l) => /"\$DOCKER" build\b/.test(l))!;
    for (const flag of ["--pull=false", "--network none", "--provenance=false", "--sbom=false", "--iidfile", "--build-arg \"NODE_BASE_DIGEST=$BASE_DIGEST\""]) expect(build).toContain(flag);
    expect(build).not.toMatch(/\s-t\s|--tag/);
  });

  it("never mounts, publishes, escalates, prunes or reconfigures anything", () => {
    const code = LINES.join("\n");
    for (const banned of [/--privileged/, /"\$DOCKER"[^\n]*\s-v\s/, /--volume/, /--mount/, /"\$DOCKER"[^\n]*\s-p\s/, /--publish/, /docker\.sock/, /\bprune\b/, /systemctl/, /\bapt(-get)?\b/,
      /\bufw\b/, /aa-|apparmor_parser/, /sysctl\s+-w/, /\/etc\/docker/, /--runtime(?!\s+runsc)/, /useradd|usermod/, /\bcurl\b|\bwget\b/]) {
      expect(banned.test(code), String(banned)).toBe(false);
    }
  });

  it("V2.1: requires dpkg --verify runsc to report nothing, and records /etc/containerd/*.toml instead of ignoring it", () => {
    const joined = TEXT.replace(/\\\n\s*/g, " ");
    expect(joined).toMatch(/VERIFY="\$\(dpkg --verify runsc 2>&1\)" && \[ -z "\$VERIFY" \]\s+\|\| die /);
    expect(TEXT).toContain("RUNTIME_CONFIG_DIR=/etc/containerd");
    expect(joined).toMatch(/"\$RUNTIME_CONFIG_DIR"\/\*\.toml\)\s+\[ "\$\(dirname "\$f"\)" = "\$RUNTIME_CONFIG_DIR" \] \|\| die/);
    expect(TEXT).toContain('*) die "runsc package file $f is outside the recordable folders');
  });

  it("deletes only its own temporary build folder, behind a path guard", () => {
    const removals = LINES.filter((l) => /\brm\s+-[a-z]*r/.test(l));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain('case "$BUILD_CTX" in "$OUT"/build.*)');
    expect(TEXT).toContain('BUILD_CTX="$(mktemp -d "$OUT/build.XXXXXX")"');
  });

  it("fails closed: pipefail is on and every evidence-gathering helper call stops on failure", () => {
    expect(TEXT).toContain("set -o pipefail");
    // Each `VAR="$(j '...' args)"` statement (possibly spanning lines) must end with `|| die`.
    const joined = TEXT.replace(/\\\n\s*/g, " ");
    const starts = [...joined.matchAll(/^\s*([A-Z_]+)="\$\((?:j|jin "\$[A-Z_]+") '/gm)];
    expect(starts.length).toBeGreaterThan(5);
    for (const m of starts) {
      const codeEnd = joined.indexOf("'", m.index! + m[0].length); // end of the single-quoted JS code
      const lineEnd = joined.indexOf("\n", codeEnd);
      expect(joined.slice(codeEnd, lineEnd), m[1]).toMatch(/\)"\s+\|\| die /);
    }
  });
});

describe("host-setup.sh: no secrets on command lines", () => {
  it("docker info and image/container JSON reach node only through the environment (jin), never as arguments", () => {
    for (const v of ["INFO", "BASE_JSON", "json"]) {
      const uses = LINES.filter((l) => l.includes(`"$${v}"`) && !l.trim().startsWith(`${v}=`) && !l.trim().startsWith(`local `));
      expect(uses.length, v).toBeGreaterThan(0);
      for (const l of uses) expect(l.includes(`jin "$${v}"`), l).toBe(true);
    }
  });
});

describe("host-setup.sh: dry run", () => {
  it("prints the plan and makes no Docker call and no write", () => {
    const before = listing();
    const r = run([], { trace: true });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("DRY RUN: nothing below has been done (no Docker call, no file written)");
    expect(r.stdout).toContain("download it ONLY with --allow-base-pull");
    const executed = r.stderr.split("\n").filter((l) => /^\++ /.test(l)).map((l) => l.replace(/^\++ /, ""));
    expect(executed.some((l) => /^(\/usr\/bin\/)?docker$/.test(l.split(" ")[0]))).toBe(false);
    for (const cmd of ["mkdir", "chown", "chmod", "cp", "mv", "rm", "tee", "mktemp", "timeout"]) {
      expect(executed.some((l) => l.split(" ")[0] === cmd), cmd).toBe(false);
    }
    expect(listing()).toEqual(before);
    expect(fs.existsSync("/var/lib/research-sandbox-setup")).toBe(false);
  });

  it("stops when the build output is missing", () => {
    fs.rmSync(path.join(dir, "dist"), { recursive: true });
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("STOP  missing dist/research-sandbox/preflight-main.js");
  });

  it("stops when Node is not version 22", () => {
    fake("node", 'echo 18');
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("STOP  Node 22 is required (found '18'");
  });
});

describe("host-setup.sh: refusals before anything happens", () => {
  it.each([[["--force"], "unknown argument '--force'"], [["--allow-base-pull"], "--allow-base-pull needs --execute"], [["--execute", "--skip-checks"], "unknown argument '--skip-checks'"],
    [["--expect-base-digest=sha256:abc"], "--expect-base-digest must be sha256:<64 lowercase hex>"], [["--expect-base-digest=latest"], "--expect-base-digest must be sha256"]])(
    "usage %j", (args, message) => {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain(message);
    });

  it("--execute refuses to run as a non-root user, before any Docker call or write", () => {
    fake("id", 'if [ "$1" = -u ]; then echo 1000; else /usr/bin/id "$@"; fi');
    const before = listing();
    const r = run(["--execute"], { trace: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("STOP  --execute must run as root (sudo)");
    const executed = r.stderr.split("\n").filter((l) => /^\++ /.test(l)).map((l) => l.replace(/^\++ /, "").split(" ")[0]);
    expect(executed.some((c) => /^(\/usr\/bin\/)?docker$/.test(c) || ["mkdir", "chown", "cp", "rm", "mktemp"].includes(c))).toBe(false);
    expect(listing()).toEqual(before);
  });
});
