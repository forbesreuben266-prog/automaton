/**
 * H1: safe mode requires bounded per-call, hourly and daily spending caps.
 * H2: every Conway client method that can reach the network is refused in
 * safe mode before any request; only local file access is allowed, and a
 * Conway sandboxId is rejected.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAFE_MODE_SPEND_MAXIMA, spendCapsFromConfig, validateSafeModeSpendCaps } from "../safety/spend-caps.js";
import { __resetSafeModeForTests, activateSafeMode, SafeModeBlockedError } from "../safety/safe-mode.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { createConwayClient } from "../conway/client.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_TREASURY_POLICY } from "../types.js";
import { createTestDb } from "./mocks.js";

const VALID = { perCallCents: 5, hourlyCents: 25, dailyCents: 200 }; // deploy template values

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetSafeModeForTests();
  // Never touch the network, even if a guard regressed.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));
});

afterEach(() => {
  __resetSafeModeForTests();
  vi.restoreAllMocks();
});

// ─── H1: caps validation ───────────────────────────────────────

describe("validateSafeModeSpendCaps", () => {
  it("accepts the deploy template's caps and caps at the hard maxima", () => {
    expect(validateSafeModeSpendCaps(VALID)).toEqual([]);
    expect(validateSafeModeSpendCaps({
      perCallCents: SAFE_MODE_SPEND_MAXIMA.perCallCents,
      hourlyCents: SAFE_MODE_SPEND_MAXIMA.hourlyCents,
      dailyCents: SAFE_MODE_SPEND_MAXIMA.dailyCents,
    })).toEqual([]);
  });

  it("keeps conservative, frozen hard maxima", () => {
    expect(SAFE_MODE_SPEND_MAXIMA).toEqual({ perCallCents: 10, hourlyCents: 50, dailyCents: 500 });
    expect(Object.isFrozen(SAFE_MODE_SPEND_MAXIMA)).toBe(true);
  });

  it("the deploy template's caps are within the maxima", () => {
    const template = JSON.parse(fs.readFileSync(path.join(process.cwd(), "deploy/config/automaton.json.template"), "utf8"));
    expect(validateSafeModeSpendCaps(spendCapsFromConfig(template))).toEqual([]);
  });

  it.each(["perCallCents", "hourlyCents", "dailyCents"] as const)("rejects missing %s", (field) => {
    expect(validateSafeModeSpendCaps({ ...VALID, [field]: undefined }).length).toBeGreaterThan(0);
  });

  it.each([
    ["zero", 0], ["negative", -5], ["fractional", 2.5], ["string", "5"], ["NaN", Number.NaN],
    ["Infinity", Infinity], ["null", null], ["object", {}],
  ])("rejects %s values for every cap", (_label, value) => {
    for (const field of ["perCallCents", "hourlyCents", "dailyCents"] as const) {
      expect(validateSafeModeSpendCaps({ ...VALID, [field]: value }).length, field).toBeGreaterThan(0);
    }
  });

  it.each([
    ["perCallCents", 11], ["hourlyCents", 51], ["dailyCents", 501], ["dailyCents", 50_000],
  ] as const)("rejects excessive %s = %i", (field, value) => {
    const problems = validateSafeModeSpendCaps({ ...VALID, [field]: value });
    expect(problems.join(" ")).toMatch(/at most/);
  });

  it("rejects inconsistent caps (per-call > hourly, hourly > daily)", () => {
    expect(validateSafeModeSpendCaps({ perCallCents: 10, hourlyCents: 5, dailyCents: 200 }).join(" ")).toMatch(/must not exceed hourlyBudgetCents/);
    expect(validateSafeModeSpendCaps({ perCallCents: 5, hourlyCents: 50, dailyCents: 20 }).join(" ")).toMatch(/must not exceed maxInferenceDailyCents/);
  });

  it("a config relying on defaults is rejected (no per-call/hourly limit, $500/day)", () => {
    const merged = { modelStrategy: DEFAULT_MODEL_STRATEGY_CONFIG, treasuryPolicy: DEFAULT_TREASURY_POLICY };
    const problems = validateSafeModeSpendCaps(spendCapsFromConfig(merged)).join(" ");
    expect(problems).toMatch(/perCallCeilingCents must be greater than 0/);
    expect(problems).toMatch(/hourlyBudgetCents must be greater than 0/);
    expect(problems).toMatch(/maxInferenceDailyCents must be at most 500/);
  });
});

describe("budget check enforces caps in safe mode", () => {
  const budget = (overrides: Record<string, unknown>) =>
    new InferenceBudgetTracker(createTestDb().raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...overrides } as any);

  it("refuses every call when caps are default/missing", () => {
    activateSafeMode("test");
    const result = budget({}).checkBudget(1, "gpt-5-mini");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Safe mode spending caps invalid/);
  });

  it("refuses every call when a cap exceeds the maximum", () => {
    activateSafeMode("test");
    const result = budget({ perCallCeilingCents: 5, hourlyBudgetCents: 25, dailyBudgetCents: 50_000 }).checkBudget(1, "gpt-5-mini");
    expect(result.allowed).toBe(false);
  });

  it("allows a call within valid caps", () => {
    activateSafeMode("test");
    expect(budget({ perCallCeilingCents: 5, hourlyBudgetCents: 25, dailyBudgetCents: 200 }).checkBudget(1, "gpt-5-mini").allowed).toBe(true);
  });

  it("is unchanged outside safe mode", () => {
    expect(budget({}).checkBudget(1, "gpt-5-mini").allowed).toBe(true);
  });
});

// ─── H1 + H2: startup refusal (real run(), risky modules mocked) ─

describe("startup refuses invalid caps or a sandboxId in safe mode", () => {
  let home: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const lockSpy = vi.fn(() => { throw Object.assign(new Error("lock reached"), { name: "InstanceLockError" }); });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-caps-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("AUTOMATON_SAFE_MODE", "1");
    lockSpy.mockClear();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function runWith(overrides: Record<string, unknown>) {
    const base = JSON.parse(fs.readFileSync(path.join(process.cwd(), "deploy/config/automaton.json.template"), "utf8"));
    const config = {
      ...base, name: "t", creatorAddress: "x", conwayApiUrl: "http://127.0.0.1:9", maxTurnsPerCycle: 1,
      dbPath: path.join(home, ".automaton", "state.db"), heartbeatConfigPath: path.join(home, ".automaton", "heartbeat.yml"),
      skillsDir: path.join(home, ".automaton", "skills"),
      ...overrides,
    };
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete (config as any)[k];
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    fs.writeFileSync(path.join(home, ".automaton", "automaton.json"), JSON.stringify(config));
    vi.resetModules();
    vi.doMock("../safety/instance-lock.js", () => ({ acquireInstanceLock: lockSpy, InstanceLockError: Error }));
    const { run } = await import("../index.js");
    await expect(run(1)).rejects.toThrow("process.exit(1)");
    expect(fs.existsSync(path.join(home, ".automaton", "wallet.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".automaton", "state.db"))).toBe(false);
  }

  const strategy = (perCall: unknown, hourly: unknown) => ({
    ...DEFAULT_MODEL_STRATEGY_CONFIG, inferenceModel: "gpt-5-mini", lowComputeModel: "gpt-5-mini", criticalModel: "gpt-5-mini",
    perCallCeilingCents: perCall, hourlyBudgetCents: hourly,
  });
  const treasury = (daily: unknown) => ({ ...DEFAULT_TREASURY_POLICY, maxInferenceDailyCents: daily });

  it.each([
    ["missing caps (defaults would apply)", { modelStrategy: undefined, treasuryPolicy: undefined }],
    ["zero per-call cap", { modelStrategy: strategy(0, 25) }],
    ["negative hourly cap", { modelStrategy: strategy(5, -1) }],
    ["malformed per-call cap", { modelStrategy: strategy("5", 25) }],
    ["excessive daily cap", { treasuryPolicy: treasury(5_000) }],
    ["excessive per-call cap", { modelStrategy: strategy(50, 50) }],
  ])("refuses before the lock: %s", async (_label, overrides) => {
    await runWith(overrides as Record<string, unknown>);
    expect(lockSpy).not.toHaveBeenCalled();
  });

  it("refuses a Conway sandboxId before the lock", async () => {
    await runWith({ sandboxId: "sbx-123" });
    expect(lockSpy).not.toHaveBeenCalled();
  });

  it("valid template caps pass the checks and reach the instance lock", async () => {
    await runWith({});
    expect(lockSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── H2: Conway client network guards ──────────────────────────

describe("Conway client in safe mode", () => {
  beforeEach(() => activateSafeMode("test"));

  const LOCAL_ONLY = new Set(["readFile", "writeFile"]);
  const DUMMY_ARGS: Record<string, unknown[]> = {
    transferCredits: ["0xabc", 1],
    createSandbox: [{ name: "x" }],
    registerAutomaton: [{}],
    addDnsRecord: ["x.com", "A", "@", "1.2.3.4"],
  };

  it("refuses every method except local file access, before any request", async () => {
    const client = createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "k", sandboxId: "" });
    const methods = Object.keys(client).filter((m) => typeof (client as any)[m] === "function");
    expect(methods.length).toBeGreaterThanOrEqual(19);
    for (const method of methods) {
      if (LOCAL_ONLY.has(method)) continue;
      const args = DUMMY_ARGS[method] ?? ["x", "y"];
      await expect(
        Promise.resolve().then(() => (client as any)[method](...args)),
        `${method} must be refused`,
      ).rejects.toBeInstanceOf(SafeModeBlockedError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    "getCreditsBalance", "getCreditsPricing", "listSandboxes", "searchDomains", "listDnsRecords",
    "listModels", "transferCredits", "createSandbox", "deleteSandbox", "registerAutomaton",
    "registerDomain", "addDnsRecord", "deleteDnsRecord", "exec", "exposePort", "removePort",
  ])("%s is refused", async (method) => {
    const client = createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "k", sandboxId: "" });
    const args = DUMMY_ARGS[method] ?? ["x", "y"];
    await expect(Promise.resolve().then(() => (client as any)[method](...args))).rejects.toBeInstanceOf(SafeModeBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows local file read/write without any request", async () => {
    const client = createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "k", sandboxId: "" });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "safe-local-")), "note.txt");
    await client.writeFile(file, "hello");
    expect(await client.readFile(file)).toBe("hello");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["sbx-1", " sbx-2 "])("rejects sandboxId %j at construction", (sandboxId) => {
    expect(() => createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "k", sandboxId })).toThrow(SafeModeBlockedError);
  });

  it("treats blank or placeholder sandbox IDs as local mode", () => {
    for (const sandboxId of ["", "  ", "undefined", "null"]) {
      expect(() => createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "k", sandboxId })).not.toThrow();
    }
  });

  it("a child-scoped client cannot be created", () => {
    const client = createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "k", sandboxId: "" });
    expect(() => client.createScopedClient("sbx-child")).toThrow(SafeModeBlockedError);
  });
});
