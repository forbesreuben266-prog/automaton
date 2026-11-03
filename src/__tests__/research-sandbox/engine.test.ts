/**
 * Engine adapter with a fake runner (argv, parsing, validation), and the real
 * process runner exercised ONLY with harmless local `node` child processes:
 * no container engine, no network.
 */

import fs from "fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_ENGINE_BINARIES, EngineError, createArgvProblem, createCliEngine, nodeProcessRunner, seccompProfileOf, type ProcessResult,
} from "../../research-sandbox/index.js";
import { DOCKER_CONFIG_DIR, IMAGE_REF } from "./fixtures.js";

const ID = "0123456789ab0123456789ab0123456789ab0123456789ab0123456789abcdef";
/** Global flags on every Docker call: pinned local socket and isolated client config folder. */
const G = ["--host", "unix:///var/run/docker.sock", "--config", DOCKER_CONFIG_DIR];
const docker = (runner: any) => createCliEngine("/usr/bin/docker", DOCKER_CONFIG_DIR, runner);
const okResult = (stdout = ""): ProcessResult => ({ exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, truncated: false });

function fakeRunner(responses: ProcessResult[]) {
  const calls: Array<{ file: string; args: readonly string[]; options: { timeoutMs: number; maxOutputBytes: number } }> = [];
  const runner = async (file: string, args: readonly string[], options: { timeoutMs: number; maxOutputBytes: number }) => {
    calls.push({ file, args, options });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  };
  return { runner, calls };
}

describe("engine adapter (fake runner)", () => {
  it("only allowlisted absolute binaries are accepted", () => {
    for (const bad of ["docker", "./docker", "/tmp/docker", "/usr/bin/docker; rm -rf /", "/usr/bin/kubectl"]) {
      expect(() => createCliEngine(bad, DOCKER_CONFIG_DIR, fakeRunner([]).runner)).toThrow(EngineError);
    }
    expect(ALLOWED_ENGINE_BINARIES).toEqual(["/usr/bin/docker", "/usr/bin/podman", "/usr/local/bin/docker", "/usr/local/bin/podman"]);
  });

  it("docker info: parses rootless, runtimes and the seccomp profile only (no other fields leak)", async () => {
    const f = fakeRunner([okResult(JSON.stringify({ SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"], Runtimes: { runc: {}, runsc: {} }, HttpsProxy: "http://user:pw@proxy" }))]);
    const info = await docker(f.runner).info();
    expect(info).toEqual({ engine: "docker", rootless: true, runtimes: ["runc", "runsc"], seccompProfile: "builtin", runtimeConfigs: { runc: {}, runsc: {} }, serverVersion: null });
    expect(f.calls[0]).toMatchObject({ file: "/usr/bin/docker", args: [...G, "info", "--format", "{{json .}}"] });
  });

  it("docker info: the server version is the daemon's ServerVersion, never the client version", async () => {
    const parse = async (body: unknown) => (await createCliEngine("/usr/bin/docker", DOCKER_CONFIG_DIR, fakeRunner([okResult(JSON.stringify(body))]).runner).info()).serverVersion;
    expect(await parse({ ServerVersion: "0.0.0-fake.test", ClientInfo: { Version: "9.9.9" } })).toBe("0.0.0-fake.test");
    expect(await parse({ ClientInfo: { Version: "9.9.9" } })).toBeNull(); // a client version is not evidence
    expect(await parse({ ServerVersion: 27 })).toBeNull();
    expect(await parse({ ServerVersion: ["27.3.1"] })).toBeNull();
  });

  it("podman info is parsed (the preflight then refuses Podman)", async () => {
    const f = fakeRunner([okResult(JSON.stringify({ host: { security: { rootless: true }, ociRuntime: { name: "crun" } } }))]);
    expect(await createCliEngine("/usr/bin/podman", DOCKER_CONFIG_DIR, f.runner).info()).toEqual({ engine: "podman", rootless: true, runtimes: ["crun"], seccompProfile: null, runtimeConfigs: {}, serverVersion: null });
  });

  it("seccomp profile identity: exactly one well-formed seccomp entry, otherwise null (refused by the preflight)", () => {
    expect(seccompProfileOf(["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"])).toBe("builtin");
    expect(seccompProfileOf(["name=seccomp,profile=/etc/docker/custom.json"])).toBe("/etc/docker/custom.json");
    expect(seccompProfileOf(["name=seccomp,profile=unconfined"])).toBe("unconfined");
    expect(seccompProfileOf([])).toBeNull(); //                                                      not reported
    expect(seccompProfileOf(["name=seccomp"])).toBeNull(); //                                         no profile
    expect(seccompProfileOf(["name=seccomp,profile="])).toBeNull(); //                                empty
    expect(seccompProfileOf(["name=seccomp,profile=builtin,profile=x"])).toBeNull(); //               ambiguous
    expect(seccompProfileOf(["name=seccomp,profile=builtin", "name=seccomp,profile=x"])).toBeNull(); // ambiguous
    expect(seccompProfileOf([42, null, "name=seccompx,profile=builtin"])).toBeNull(); //              malformed
  });

  it("H1: every Docker call is pinned to the local socket and the isolated config folder (global flags first); Podman has no target", () => {
    expect(docker(fakeRunner([]).runner).target).toEqual({ host: "unix:///var/run/docker.sock", configDir: DOCKER_CONFIG_DIR });
    expect(createCliEngine("/usr/bin/podman", DOCKER_CONFIG_DIR, fakeRunner([]).runner).target).toBeNull();
    for (const bad of ["", "relative/dir", "/srv/cfg; rm -rf /", 42 as any]) expect(() => createCliEngine("/usr/bin/docker", bad, fakeRunner([]).runner)).toThrow("configDir");
  });

  it("create passes argv unchanged after the global flags and validates the returned id", async () => {
    const f = fakeRunner([okResult(`${ID}\n`)]);
    const engine = docker(f.runner);
    const args = ["create", "--pull", "never", "--network", "none", IMAGE_REF, "node"];
    expect(await engine.create(args, IMAGE_REF)).toBe(ID);
    expect(f.calls[0].args).toEqual([...G, ...args]);
    await expect(engine.create(["run", "--pull", "never", IMAGE_REF], IMAGE_REF)).rejects.toThrow("must start with create");
    await expect(docker(fakeRunner([okResult("not-an-id; rm -rf /")]).runner).create(args, IMAGE_REF)).rejects.toThrow("invalid container id");
  });

  it("M4: the exact review bypasses and other ambiguous pull arguments are refused before anything runs", async () => {
    const cases: Array<[string[], string]> = [
      [["create", IMAGE_REF, "--pull", "never"], "before the image reference"], //                       review bypass: flag after the image
      [["create", "--pull", "never", "--pull", "always", IMAGE_REF], "exactly one --pull flag"], //      review bypass: later override
      [["create", "--pull", "never", "--pull=always", IMAGE_REF], "--pull=... form"], //                review bypass: = form override
      [["create", "--pull=never", IMAGE_REF], "--pull=... form"],
      [["create", IMAGE_REF], "exactly one --pull flag"],
      [["create", "--pull", "missing", IMAGE_REF], "--pull must be never"],
      [["create", "--pull", "always", IMAGE_REF], "--pull must be never"],
      [["create", "--pull", IMAGE_REF], "--pull must be never"],
      [["create", "--pull", "never", IMAGE_REF, "--pull"], "exactly one --pull flag"], //                 --pull among the command args
      [["create", "--pull", "never", IMAGE_REF, IMAGE_REF], "exactly once"],
      [["create", "--pull", "never", "img:latest"], "exactly once"],
    ];
    for (const [args, message] of cases) {
      const f = fakeRunner([okResult(`${ID}\n`)]);
      await expect(docker(f.runner).create(args, IMAGE_REF), JSON.stringify(args)).rejects.toThrow(message);
      expect(f.calls).toEqual([]);
    }
    for (const ref of ["img:latest", "img@sha256:short", "", "IMG@sha256:" + "a".repeat(64)]) {
      expect(createArgvProblem(["create", "--pull", "never", ref], ref)).toContain("pinned by digest");
    }
    expect(createArgvProblem(["create", "--pull", "never", IMAGE_REF, "node"], IMAGE_REF)).toBeNull();
  });

  it("inspect/start/remove/exists use exact argv; start passes timeout and cap; refs are validated", async () => {
    const f = fakeRunner([okResult("[{}]"), okResult("{}"), okResult(""), okResult(""), okResult(`${ID}\n`), okResult("")]);
    const engine = docker(f.runner);
    expect(await engine.inspect(ID)).toEqual([{}]);
    await engine.start(ID, 60_000, 65_536);
    await engine.remove(ID);
    await engine.remove("research-sandbox-r1-canary");
    expect(await engine.exists(ID)).toBe(true);
    expect(await engine.exists("research-sandbox-r1-canary")).toBe(false);
    expect(f.calls.map((c) => c.args)).toEqual([
      [...G, "inspect", "--type", "container", ID],
      [...G, "start", "--attach", ID],
      [...G, "rm", "--force", ID],
      [...G, "rm", "--force", "research-sandbox-r1-canary"],
      [...G, "ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${ID}`],
      [...G, "ps", "--all", "--quiet", "--no-trunc", "--filter", "name=^/research-sandbox-r1-canary$"],
    ]);
    expect(f.calls[1].options).toEqual({ timeoutMs: 60_000, maxOutputBytes: 65_536 });
    for (const bad of ["../../etc", "other-container", "research-sandbox-r1-canary; ls", ""]) {
      await expect(engine.remove(bad)).rejects.toThrow(EngineError);
      await expect(engine.exists(bad)).rejects.toThrow(EngineError);
    }
    await expect(engine.inspect("research-sandbox-r1-canary")).rejects.toThrow("invalid container id");
  });

  it("timeouts, truncated output, signals, non-zero exits and non-JSON fail", async () => {
    const cases: Array<[ProcessResult, string]> = [
      [{ ...okResult(), timedOut: true }, "timed out"],
      [{ ...okResult(), truncated: true }, "exceeded the cap"],
      [{ ...okResult(), exitCode: -1, signal: "SIGKILL" }, "exited with -1 (SIGKILL)"],
      [{ ...okResult(), exitCode: 1 }, "exited with 1"],
      [okResult("not json"), "not JSON"],
    ];
    for (const [result, message] of cases) {
      await expect(docker(fakeRunner([result]).runner).info()).rejects.toThrow(message);
    }
  });

  it("every engine call has a bounded timeout and output cap", async () => {
    const f = fakeRunner([okResult("{}")]);
    await docker(f.runner).info();
    expect(f.calls[0].options.timeoutMs).toBeGreaterThan(0);
    expect(f.calls[0].options.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(f.calls[0].options.maxOutputBytes).toBeLessThanOrEqual(1024 * 1024);
  });
});

/** A process counts as gone if it no longer exists or is a zombie awaiting reaping. */
function alive(pid: number): boolean {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    return !/^State:\s+Z/m.test(status);
  } catch {
    return false;
  }
}
async function waitGone(pids: number[], ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every((p) => !alive(p))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pids.every((p) => !alive(p));
}
const NODE = process.execPath;
const script = (code: string) => ["-e", code];

describe("real process runner (harmless local node processes only)", () => {
  it("normal exit: stdout captured, exit code 0", async () => {
    const r = await nodeProcessRunner(NODE, script("process.stdout.write('hello')"), { timeoutMs: 10_000, maxOutputBytes: 1024 });
    expect(r).toMatchObject({ exitCode: 0, signal: null, stdout: "hello", timedOut: false, truncated: false });
  });

  it("non-zero exit code is reported", async () => {
    expect((await nodeProcessRunner(NODE, script("process.exit(3)"), { timeoutMs: 10_000, maxOutputBytes: 1024 })).exitCode).toBe(3);
  });

  it("death by signal is reported (-1 plus the signal)", async () => {
    const r = await nodeProcessRunner(NODE, script("process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"), { timeoutMs: 10_000, maxOutputBytes: 1024 });
    expect(r).toMatchObject({ exitCode: -1, signal: "SIGTERM", timedOut: false });
  });

  it("timeout kills the whole process group, including a grandchild", async () => {
    const code = [
      "const { spawn } = require('child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(JSON.stringify({ child: process.pid, grandchild: g.pid }) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const r = await nodeProcessRunner(NODE, script(code), { timeoutMs: 1_500, maxOutputBytes: 4096 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    const pids = JSON.parse(r.stdout.trim().split("\n")[0]);
    expect(await waitGone([pids.child, pids.grandchild])).toBe(true);
  });

  it("output over the cap kills the process group and is reported as truncated", async () => {
    const code = "process.stdout.write(String(process.pid) + '\\n'); const big = 'x'.repeat(65536); setInterval(() => process.stdout.write(big), 1);";
    const r = await nodeProcessRunner(NODE, script(code), { timeoutMs: 10_000, maxOutputBytes: 4096 });
    expect(r.truncated).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(4096 + 65536);
    const pid = Number(r.stdout.split("\n")[0]);
    expect(await waitGone([pid])).toBe(true);
  });

  it("the child sees only PATH: no HOME, proxy or credential variables are inherited", async () => {
    const r = await nodeProcessRunner(NODE, script("process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"), { timeoutMs: 10_000, maxOutputBytes: 4096 });
    expect(JSON.parse(r.stdout)).toEqual(["PATH"]);
  });

  it("a missing binary resolves with an error result instead of throwing", async () => {
    const r = await nodeProcessRunner("/nonexistent/binary", [], { timeoutMs: 2_000, maxOutputBytes: 1024 });
    expect(r.exitCode).not.toBe(0);
  });
});
