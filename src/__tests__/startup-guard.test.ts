/**
 * Startup must refuse safely: missing or unreadable configuration, an
 * unbounded safe-mode run, or a second runtime on the same database must
 * never reach setup, wallet creation, account creation or the agent loop.
 * The real run() is exercised with the risky modules mocked.
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wizard = vi.fn(async () => { throw new Error("setup wizard must not run"); });
const provision = vi.fn(async () => { throw new Error("provisioning must not run"); });
const getWallet = vi.fn(async () => { throw new Error("wallet must not be loaded or created"); });

vi.mock("../setup/wizard.js", () => ({ runSetupWizard: wizard }));
vi.mock("../identity/provision.js", () => ({ provision, loadApiKeyFromConfig: () => null, registerParent: vi.fn() }));

let home: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

async function loadRun() {
  vi.resetModules();
  vi.doMock("../identity/wallet.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../identity/wallet.js")>();
    return { ...original, getWallet };
  });
  const mod = await import("../index.js");
  return mod.run;
}

function writeConfig(content: string) {
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  fs.writeFileSync(path.join(home, ".automaton", "automaton.json"), content);
}

function validConfig(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "t", genesisPrompt: "x", creatorAddress: "0xabc", walletAddress: "no-wallet", sandboxId: "",
    conwayApiUrl: "http://127.0.0.1:9", inferenceModel: "gpt-5-mini", maxTokensPerTurn: 100, maxTurnsPerCycle: 1,
    heartbeatConfigPath: path.join(home, ".automaton", "heartbeat.yml"), dbPath: path.join(home, ".automaton", "state.db"),
    logLevel: "error", version: "0.2.1", skillsDir: path.join(home, ".automaton", "skills"), maxChildren: 0,
    socialRelayUrl: "", ...overrides,
  });
}

function assertNothingCreated() {
  expect(wizard).not.toHaveBeenCalled();
  expect(provision).not.toHaveBeenCalled();
  expect(getWallet).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(home, ".automaton", "wallet.json"))).toBe(false);
  expect(fs.existsSync(path.join(home, ".automaton", "config.json"))).toBe(false);
  expect(fs.existsSync(path.join(home, ".automaton", "state.db"))).toBe(false);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-startup-"));
  vi.stubEnv("HOME", home);
  wizard.mockClear();
  provision.mockClear();
  getWallet.mockClear();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as any);
});

afterEach(() => {
  vi.unstubAllEnvs();
  exitSpy.mockRestore();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("startup refuses safely", () => {
  it.each([
    ["default (safe mode ON)", undefined],
    ["explicit opt-out", "0"],
  ])("unreadable automaton.json refuses without setup, wallet or account (%s)", async (_label, env) => {
    if (env === undefined) vi.stubEnv("AUTOMATON_SAFE_MODE", undefined as any);
    else vi.stubEnv("AUTOMATON_SAFE_MODE", env);
    writeConfig("{ this is not json");
    const run = await loadRun();
    await expect(run(1)).rejects.toThrow("process.exit(1)");
    assertNothingCreated();
  });

  it.each([
    ["default (safe mode ON)", undefined],
    ["explicit opt-out", "0"],
  ])("missing automaton.json refuses and never starts setup (%s)", async (_label, env) => {
    if (env === undefined) vi.stubEnv("AUTOMATON_SAFE_MODE", undefined as any);
    else vi.stubEnv("AUTOMATON_SAFE_MODE", env);
    const run = await loadRun();
    await expect(run(1)).rejects.toThrow("process.exit(1)");
    assertNothingCreated();
    expect(fs.existsSync(path.join(home, ".automaton", "automaton.json"))).toBe(false);
  });

  it("safe mode is ON by default from source: an unbounded run refuses", async () => {
    vi.stubEnv("AUTOMATON_SAFE_MODE", undefined as any);
    writeConfig(validConfig());
    const run = await loadRun();
    await expect(run(null)).rejects.toThrow("process.exit(1)");
    assertNothingCreated();
  });

  it("invalid config.safeMode with an env opt-out still runs in safe mode (unbounded run refuses)", async () => {
    vi.stubEnv("AUTOMATON_SAFE_MODE", "0");
    writeConfig(validConfig({ safeMode: "no" }));
    const run = await loadRun();
    await expect(run(null)).rejects.toThrow("process.exit(1)");
    assertNothingCreated();
  });

  it("refuses when another runtime holds the instance lock", async () => {
    vi.stubEnv("AUTOMATON_SAFE_MODE", undefined as any);
    writeConfig(validConfig());
    const { acquireInstanceLock } = await import("../safety/instance-lock.js");
    const held = acquireInstanceLock(path.join(home, ".automaton", "state.db"));
    try {
      const run = await loadRun();
      await expect(run(1)).rejects.toThrow("process.exit(1)");
      assertNothingCreated();
    } finally {
      held.release();
    }
  });
});

describe("instance lock", () => {
  it("allows one holder per database, and can be re-acquired after release", async () => {
    const { acquireInstanceLock, InstanceLockError } = await import("../safety/instance-lock.js");
    const dbPath = path.join(home, "state.db");
    const first = acquireInstanceLock(dbPath);
    expect(() => acquireInstanceLock(dbPath)).toThrow(InstanceLockError);
    first.release();
    const second = acquireInstanceLock(dbPath);
    second.release();
  });

  it("blocks a second process, and is released by the OS when the holder dies", async () => {
    const { acquireInstanceLock, InstanceLockError } = await import("../safety/instance-lock.js");
    const dbPath = path.join(home, "state.db");
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const D=require("better-sqlite3");const d=new D(process.argv[1]+".lock",{timeout:0});d.pragma("locking_mode = EXCLUSIVE");d.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS instance_lock (pid INTEGER); COMMIT;");console.log("locked");setInterval(()=>{},1000);`,
        dbPath,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.on("data", (d) => String(d).includes("locked") && resolve());
      holder.on("exit", (code) => reject(new Error(`holder exited early (${code})`)));
    });
    try {
      expect(() => acquireInstanceLock(dbPath)).toThrow(InstanceLockError);
    } finally {
      holder.kill("SIGKILL");
      await new Promise((resolve) => holder.on("exit", resolve));
    }
    const lock = acquireInstanceLock(dbPath); // crash left no stale lock
    lock.release();
  }, 20_000);
});
