/**
 * V1A preflight runner, offline: the real engine adapter (createCliEngine)
 * driven by a FAKE process runner, the existing fake host filesystem, and
 * fake pins from fixtures.ts. No Docker binary, socket, container or network
 * is touched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRunnerConfigFile } from "../../research-sandbox/preflight-main.js";
import {
  CONFIRM_FLAG, MEETS_SPEC_BLOCKERS, RUNNER_EXIT, createCliEngine, parseRunnerConfig, runPreflightCommand,
  type PreflightResult, type ProcessResult, type ProcessRunner, type RunnerDeps,
} from "../../research-sandbox/index.js";
import {
  CONTAINER_ID, DOCKER_CONFIG_DIR, FAKE_DATA_ROOT, FAKE_DIGEST, FAKE_DOCKER_SERVER_VERSION, FAKE_ENTRYPOINT, FAKE_GVISOR_PROC_VERSION, FAKE_IMAGE_ENV,
  FAKE_MANIFEST_DIGEST, FAKE_RUNSC, FAKE_RUNSC_PATH, HOST_CANARY, HOST_PROC_VERSION, OPERATOR_UID, OUTPUT_UID, compliantHostLayout, compliantInspect, compliantReport, fakeHostFs,
} from "./fixtures.js";

const NAME = "research-sandbox-r1-canary";
beforeEach(() => {
  const real = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) => (p === "/proc/version" ? HOST_PROC_VERSION : (real as any)(p, ...rest))) as any);
});
afterEach(() => { vi.restoreAllMocks(); });

const config = (edit: (c: any) => void = () => {}) => {
  const c: any = {
    version: 1, engineBinary: "/usr/bin/docker", engineConfigDir: DOCKER_CONFIG_DIR, runId: "r1", hostCanaryPath: HOST_CANARY,
    operatorUid: OPERATOR_UID, outputOwnerUid: OUTPUT_UID,
    pins: {
      imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST,
      gvisorProcVersion: FAKE_GVISOR_PROC_VERSION, dockerDataRoot: FAKE_DATA_ROOT, runscBinary: { ...FAKE_RUNSC, args: [] }, dockerServerVersion: FAKE_DOCKER_SERVER_VERSION,
    },
  };
  edit(c);
  return JSON.stringify(c, null, 2);
};

const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, truncated: false });
/** A fake Docker CLI: answers each subcommand the adapter sends, and records every argv. */
function fakeDocker(o: { info?: Record<string, unknown>; removeLeaves?: boolean } = {}) {
  const calls: string[][] = [];
  let exists = false;
  const info = {
    ServerVersion: FAKE_DOCKER_SERVER_VERSION, SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"],
    Runtimes: { runc: { path: "runc" }, runsc: { path: FAKE_RUNSC_PATH } }, ...o.info,
  };
  const runner: ProcessRunner = async (file, args) => {
    calls.push([file, ...args]);
    const sub = args[4];
    if (sub === "info") return ok(JSON.stringify(info));
    if (sub === "ps") return ok(exists ? `${CONTAINER_ID}\n` : "");
    if (sub === "create") { exists = true; return ok(`${CONTAINER_ID}\n`); }
    if (sub === "inspect") return ok(JSON.stringify(compliantInspect(info.Runtimes && "runsc" in (info.Runtimes as object) ? "runsc" : "runc")));
    if (sub === "start") return ok(JSON.stringify(compliantReport()));
    if (sub === "rm") { if (!o.removeLeaves) exists = false; return ok(); }
    return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected", timedOut: false, truncated: false };
  };
  return { runner, calls };
}

function harness(text: string | Error = config(), docker = fakeDocker(), extra: Partial<RunnerDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const created: string[][] = [];
  const deps: RunnerDeps = {
    readConfig: () => { if (text instanceof Error) throw text; return text; },
    createEngine: (b, c) => { created.push([b, c]); return createCliEngine(b, c, docker.runner); },
    hostFs: fakeHostFs(compliantHostLayout()),
    out: (t) => out.push(t), err: (t) => err.push(t), ...extra,
  };
  const go = (...argv: string[]) => runPreflightCommand(argv.length > 0 ? argv : ["--config", "/etc/research/preflight.json", CONFIRM_FLAG], deps);
  return { go, out: () => out.join(""), err: () => err.join(""), created, docker };
}

describe("a complete fake host: every check passes, still refused by M1/M3", () => {
  it("reports REFUSED, blocked only by the M1/M3 blockers, exit 1, and the canary is removed", async () => {
    const h = harness();
    expect(await h.go()).toBe(RUNNER_EXIT.refused);
    expect(h.err()).toBe("");
    const text = h.out();
    expect(text).toContain("Rating: REFUSED    Untrusted input allowed: no");
    expect(text).toContain("Every check passed; refused only because of the M1/M3 blockers (removing one is a reviewed code change).");
    for (const b of MEETS_SPEC_BLOCKERS) expect(text).toContain(`  - ${b}`);
    expect(text).toContain(`Cleanup: canary container removed and removal verified (${NAME}).`);
    expect(text).toContain("-> gvisor-verified -> meets-spec-blocked");
  });

  it("every Docker call goes through the pinned adapter: socket and client config on every call, --pull never, no pull or run", async () => {
    const h = harness();
    await h.go();
    expect(h.created).toEqual([["/usr/bin/docker", DOCKER_CONFIG_DIR]]);
    const subcommands = h.docker.calls.map((c) => c[5]);
    expect(subcommands).toEqual(["info", "ps", "create", "info", "inspect", "start", "rm", "ps", "ps", "info"]);
    for (const c of h.docker.calls) expect(c.slice(0, 5)).toEqual(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "--config", DOCKER_CONFIG_DIR]);
    const create = h.docker.calls.find((c) => c[5] === "create")!;
    expect(create.filter((a) => a === "--pull")).toHaveLength(1);
    expect(create[create.indexOf("--pull") + 1]).toBe("never");
    expect(h.docker.calls.some((c) => c.includes("pull") || c.includes("run") || c.includes("build"))).toBe(false);
  });

  it("--output json gives the same result as structured data", async () => {
    const h = harness();
    expect(await h.go("--output", "json", "--config", "/etc/research/preflight.json", CONFIRM_FLAG)).toBe(RUNNER_EXIT.refused);
    const rep = JSON.parse(h.out());
    expect(rep).toMatchObject({
      runner: "research-sandbox-preflight", runId: "r1", rating: "refused", allowsUntrustedInput: false, blockedOnlyByMeetsSpecBlockers: true,
      blockers: [...MEETS_SPEC_BLOCKERS], violations: [...MEETS_SPEC_BLOCKERS], runtime: "runsc", hostTrust: "operator-attested-only",
      engine: { serverVersion: FAKE_DOCKER_SERVER_VERSION, seccompProfile: "builtin", rootless: false, runtimes: ["runc", "runsc"] },
      cleanup: { containerName: NAME, verifiedRemoved: true },
    });
  });
});

describe("failing checks are reported and refused", () => {
  it("an unconfined daemon seccomp profile refuses before anything is created", async () => {
    const h = harness(config(), fakeDocker({ info: { SecurityOptions: ["name=seccomp,profile=unconfined"] } }));
    expect(await h.go()).toBe(RUNNER_EXIT.refused);
    expect(h.out()).toContain("Problems found:\n  - seccomp: the daemon must report the built-in default profile");
    expect(h.out()).not.toContain("Every check passed");
    expect(h.docker.calls.some((c) => c[5] === "create")).toBe(false);
  });

  it("a different Docker server version refuses", async () => {
    const h = harness(config(), fakeDocker({ info: { ServerVersion: "99.0.0" } }));
    expect(await h.go()).toBe(RUNNER_EXIT.refused);
    expect(h.out()).toContain(`Docker server version: the daemon reports 99.0.0; the approved version is ${FAKE_DOCKER_SERVER_VERSION}`);
  });

  it("runc only: development-only, still exit 1 and never allows untrusted input", async () => {
    const h = harness(config(), fakeDocker({ info: { Runtimes: { runc: { path: "runc" } } } }));
    expect(await h.go()).toBe(RUNNER_EXIT.refused);
    expect(h.out()).toContain("Rating: DEVELOPMENT-ONLY    Untrusted input allowed: no");
    expect(h.out()).toContain("never allows untrusted input");
  });

  it("an unverified cleanup says manual cleanup is required", async () => {
    const h = harness(config(), fakeDocker({ removeLeaves: true }));
    expect(await h.go()).toBe(RUNNER_EXIT.refused);
    expect(h.out()).toContain("Cleanup: MANUAL CLEANUP REQUIRED:");
  });

  it("daemon-sourced text can't control the terminal", async () => {
    const h = harness(config(), fakeDocker({ info: { ServerVersion: "1.2.3\u001b[31m" } }));
    await h.go();
    expect(h.out()).not.toContain("\u001b");
  });
});

describe("fail closed before any engine call", () => {
  it.each([
    [[], "missing --config"],
    [["--config", "/etc/x.json"], `missing ${CONFIRM_FLAG} (the run contacts the Docker daemon and creates one canary container)`],
    [["--config", "relative.json", CONFIRM_FLAG], "--config must be an absolute path"],
    [["--config", "/a.json", "--config", "/b.json", CONFIRM_FLAG], "--config is given more than once"],
    [["--config", "/a.json", CONFIRM_FLAG, "--output", "yaml"], "--output must be text or json"],
    [["--config", "/a.json", CONFIRM_FLAG, "--skip-blockers"], "unrecognised argument \"--skip-blockers\""],
    [["--config", "/a.json", CONFIRM_FLAG, "--meets-spec"], "unrecognised argument \"--meets-spec\""],
  ])("usage %j", async (argv, message) => {
    const h = harness();
    const deps = (h as any);
    const code = await runPreflightCommand(argv, {
      readConfig: () => config(), createEngine: () => { throw new Error("must not be called"); }, hostFs: fakeHostFs(compliantHostLayout()),
      out: () => {}, err: (t) => { deps.e = (deps.e ?? "") + t; },
    });
    expect(code).toBe(RUNNER_EXIT.usage);
    expect(deps.e.split("\n")[0]).toBe(`Usage error: ${message}`);
  });

  const bad: Array<[string, string, string]> = [
    ["invalid JSON", "{", "configuration: is not valid JSON"],
    ["a duplicate key", config().replace("\"version\": 1,", "\"version\": 1, \"version\": 1,"), "configuration: duplicate key \"version\" (ambiguous)"],
    ["an unknown field", config((c) => { c.trustHost = true; }), "trustHost: is not a recognised field"],
    ["a missing pin", config((c) => { delete c.pins.runscBinary; }), "pins.runscBinary: is required (recorded at an approved host-setup step; nothing is defaulted)"],
    ["an unrecorded pin", config((c) => { c.pins.gvisorProcVersion = null; }), "pins.gvisorProcVersion: is not recorded (null); the preflight can't run without it"],
    ["an unknown pin", config((c) => { c.pins.seccompProfile = "unconfined"; }), "pins.seccompProfile: is not a recognised pin"],
    ["a malformed digest (refused by resolveSpec)", config((c) => { c.pins.imageDigest = "sha256:abc"; }), "imageDigest: must be sha256:<64 lowercase hex>"],
    ["runtime flags on runsc (refused by resolveSpec)", config((c) => { c.pins.runscBinary.args = ["--platform=ptrace"]; }), "runscBinary.args: must be an empty array (no runsc runtime flags are approved)"],
    ["a non-allowlisted engine binary (refused by createCliEngine)", config((c) => { c.engineBinary = "/tmp/docker"; }), "engine binary must be one of /usr/bin/docker"],
    ["a bad run id", config((c) => { c.runId = "../x"; }), "runId: must be lower-case letters, digits and hyphens"],
    ["another version", config((c) => { c.version = 2; }), "version: must be 1"],
  ];
  it.each(bad)("%s", async (_name, text, message) => {
    const docker = fakeDocker();
    const h = harness(text, docker);
    expect(await h.go()).toBe(RUNNER_EXIT.usage);
    expect(h.err()).toContain("Refused before any engine call (configuration):");
    expect(h.err()).toContain(message);
    expect(docker.calls).toEqual([]);
    expect(h.out()).toBe("");
  });

  it("an explicitly null platform manifest digest is accepted as 'not reported' (classic image store)", async () => {
    const h = harness(config((c) => { c.pins.imageManifestDigest = null; }));
    await h.go();
    expect(h.docker.calls.length).toBeGreaterThan(0); // reached the preflight; its own inspect rules decide from there
  });
});

describe("internal errors and inconsistencies (exit 3)", () => {
  it("a thrown preflight error names the canary container to check", async () => {
    const h = harness(config(), fakeDocker(), { preflight: async () => { throw new Error("boom"); } });
    expect(await h.go()).toBe(RUNNER_EXIT.internal);
    expect(h.err()).toContain(`Check for a leftover container named ${NAME} and remove it manually.`);
  });

  it("a result claiming meets-spec (or untrusted input) while M1/M3 exist is never reported as success", async () => {
    const fake = (over: Partial<PreflightResult>) => async (): Promise<PreflightResult> => ({
      rating: "refused", allowsUntrustedInput: false, runtime: "runsc", engine: null, violations: [], hostTrust: "operator-attested-only", steps: [], binding: null, cleanup: null, ...over,
    });
    for (const over of [{ rating: "meets-spec" as const, allowsUntrustedInput: true }, { allowsUntrustedInput: true }, { rating: "meets-spec" as const }]) {
      const h = harness(config(), fakeDocker(), { preflight: fake(over) });
      expect(await h.go()).toBe(RUNNER_EXIT.internal);
      expect(h.err()).toContain("Internal inconsistency");
      expect(h.out()).toBe("");
    }
  });
});

describe("parseRunnerConfig", () => {
  it("returns the validated configuration", () => {
    expect(parseRunnerConfig(config())).toMatchObject({ engineBinary: "/usr/bin/docker", runId: "r1", operatorUid: OPERATOR_UID });
  });
});

describe("the entry point's configuration file reader", () => {
  let dir: string;
  const euid = process.geteuid!();
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rp-runner-"))); fs.chmodSync(dir, 0o755); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const write = (name: string, data: string | Uint8Array, mode = 0o600) => { const p = path.join(dir, name); fs.writeFileSync(p, data); fs.chmodSync(p, mode); return p; };

  it("reads a private regular file", () => {
    expect(readRunnerConfigFile(write("c.json", config()), euid)).toBe(config());
  });

  it.each([
    ["a symbolic link", () => { const t = write("t.json", "{}"); fs.symlinkSync(t, path.join(dir, "l.json")); return path.join(dir, "l.json"); }, "must be a regular file (no symbolic link)"],
    ["a group-writable file", () => write("g.json", "{}", 0o620), "must be owned by root or you and not writable by group or others"],
    ["a world-writable folder", () => { const p = write("w.json", "{}"); fs.chmodSync(dir, 0o777); return p; }, "its folder must be owned by root or you and not writable by group or others"],
    ["an oversized file", () => write("big.json", " ".repeat(64 * 1024 + 1)), "is 65537 bytes; the limit is 65536"],
    ["invalid UTF-8", () => write("u.json", new Uint8Array([0x7b, 0xff, 0x7d])), "is not valid UTF-8"],
    ["a byte-order mark", () => write("b.json", new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), "must not start with a byte-order mark"],
    ["a missing file", () => path.join(dir, "none.json"), "cannot be inspected (ENOENT)"],
  ])("refuses %s", (_name, make, message) => {
    expect(() => readRunnerConfigFile(make(), euid)).toThrow(message);
  });

  it.runIf(euid === 0)("refuses a file owned by another (non-root) user", () => {
    const p = write("o.json", "{}");
    fs.chownSync(p, 4242, 4242);
    expect(() => readRunnerConfigFile(p, euid)).toThrow("must be owned by root or you and not writable by group or others");
  });
});
