/**
 * M1: orchestrator/worker inference is budget-gated and cost-recorded.
 * M2: secret files with unsafe permissions refuse startup.
 * M3: unknown, invalid, untrusted or unlisted zero pricing is refused.
 *
 * The OpenAI SDK is mocked, so nothing here can reach the network.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFreeModels, resolveTrustedPricing } from "../inference/pricing-policy.js";
import { BudgetSpendGate, isOfficialEndpoint, SpendRefusedError, type SpendRequest } from "../inference/spend-gate.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { InferenceRouter } from "../inference/router.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { checkSecretFilePermissions, secretFilePaths } from "../safety/file-permissions.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { ModelEntry, ModelStrategyConfig } from "../types.js";
import { createTestDb } from "./mocks.js";

const sdk = vi.hoisted(() => {
  const queue: Array<() => unknown> = [];
  const calls: any[] = [];
  const create = vi.fn(async (payload: any) => {
    calls.push(payload);
    const next = queue.shift();
    if (!next) throw new Error("No OpenAI mock response queued");
    return next();
  });
  const ctor = vi.fn().mockImplementation(function MockOpenAI(this: any, opts: any) {
    this.opts = opts;
    this.chat = { completions: { create } };
  });
  return { queue, calls, create, ctor };
});
vi.mock("openai", () => ({ default: sdk.ctor }));

const ok = (promptTokens = 1_000, completionTokens = 100) =>
  sdk.queue.push(() => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }));
const fail = (status: number) =>
  sdk.queue.push(() => { throw Object.assign(new Error(`HTTP ${status}`), { status }); });

const MESSAGES = [{ role: "user" as const, content: "hello" }];

function entry(overrides: Partial<ModelEntry>): ModelEntry {
  const now = new Date().toISOString();
  return {
    modelId: "m", provider: "openai", displayName: "m", tierMinimum: "normal", costPer1kInput: 10, costPer1kOutput: 30,
    maxTokens: 4096, contextWindow: 128_000, supportsTools: true, supportsVision: false, parameterStyle: "max_tokens",
    enabled: true, lastSeen: null, createdAt: now, updatedAt: now, ...overrides,
  } as ModelEntry;
}

function budgetSetup(strategy: Partial<ModelStrategyConfig> = {}) {
  const db = createTestDb();
  const registry = new ModelRegistry(db.raw);
  registry.initialize();
  const budget = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...strategy });
  const gate = new BudgetSpendGate(budget, registry, { sessionId: "s1", taskType: "planning", tier: "normal" });
  return { db, registry, budget, gate };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sdk.queue.splice(0);
  sdk.calls.splice(0);
  sdk.create.mockClear();
  sdk.ctor.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));
});

// Restore only the fetch spy: restoreAllMocks would also reset the SDK mock.
afterEach(() => {
  fetchSpy.mockRestore();
  vi.useRealTimers();
});

// ─── M3: pricing policy ────────────────────────────────────────

describe("resolveTrustedPricing", () => {
  it("accepts a fully priced model", () => {
    expect(resolveTrustedPricing(entry({}))).toMatchObject({ ok: true, free: false });
  });

  it("refuses unknown models (never free)", () => {
    expect(resolveTrustedPricing(undefined).ok).toBe(false);
    expect(resolveTrustedPricing(null).ok).toBe(false);
  });

  it.each([Number.NaN, -1, Infinity, "10", null, undefined])("refuses invalid price %j", (bad) => {
    expect(resolveTrustedPricing(entry({ costPer1kInput: bad as any })).ok).toBe(false);
    expect(resolveTrustedPricing(entry({ costPer1kOutput: bad as any })).ok).toBe(false);
  });

  it("refuses partial pricing", () => {
    expect(resolveTrustedPricing(entry({ costPer1kInput: 0 })).ok).toBe(false);
    expect(resolveTrustedPricing(entry({ costPer1kOutput: 0 })).ok).toBe(false);
  });

  it("refuses zero-priced models that are not on the free-model policy", () => {
    expect(resolveTrustedPricing(entry({ provider: "ollama", costPer1kInput: 0, costPer1kOutput: 0 })).ok).toBe(false);
  });

  it("allows zero price only for a listed local (Ollama) model", () => {
    const local = entry({ modelId: "llama3", provider: "ollama", costPer1kInput: 0, costPer1kOutput: 0 });
    expect(resolveTrustedPricing(local, { freeModels: ["llama3"] })).toMatchObject({ ok: true, free: true });
  });

  it("never treats a remote model as free, even if listed", () => {
    const remote = entry({ modelId: "gpt-x", provider: "openai", costPer1kInput: 0, costPer1kOutput: 0 });
    const decision = resolveTrustedPricing(remote, { freeModels: ["gpt-x"] });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toMatch(/remote and cannot be free/);
  });

  it("refuses a price registered for a different provider than the one serving the call", () => {
    expect(resolveTrustedPricing(entry({ provider: "openai" }), { servingProvider: "groq" }).ok).toBe(false);
  });

  it("validates the free-model policy itself", () => {
    expect(normalizeFreeModels(undefined)).toEqual([]);
    expect(normalizeFreeModels("llama3")).toEqual([]);
    expect(normalizeFreeModels(["llama3", 5, "", " padded ", null])).toEqual(["llama3"]);
  });
});

describe("router enforces the pricing policy in every mode", () => {
  function routerWith(model: ModelEntry, strategy: Partial<ModelStrategyConfig> = {}) {
    const { db, registry, budget } = budgetSetup({ inferenceModel: model.modelId, ...strategy });
    registry.upsert(model);
    return { db, router: new InferenceRouter(db.raw, registry, budget) };
  }
  const request = { messages: MESSAGES, taskType: "agent_turn" as const, tier: "normal" as const, sessionId: "s" };

  it("refuses an unpriced remote model outside safe mode (previously allowed)", async () => {
    const { db, router } = routerWith(entry({ modelId: "free-remote", costPer1kInput: 0, costPer1kOutput: 0 }));
    const chat = vi.fn();
    const result = await router.route(request, chat);
    expect(result.content).toMatch(/Pricing refused/);
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it("refuses partial pricing", async () => {
    const { db, router } = routerWith(entry({ modelId: "half", costPer1kOutput: 0 }));
    const chat = vi.fn();
    expect((await router.route(request, chat)).content).toMatch(/Partial pricing/);
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it("allows a listed free local model", async () => {
    const { db, router } = routerWith(entry({ modelId: "llama3", provider: "ollama", costPer1kInput: 0, costPer1kOutput: 0 }), { freeModels: ["llama3"] });
    const chat = vi.fn(async () => ({ message: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } }));
    await router.route(request, chat);
    expect(chat).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("refuses an unlisted free local model", async () => {
    const { db, router } = routerWith(entry({ modelId: "llama3", provider: "ollama", costPer1kInput: 0, costPer1kOutput: 0 }));
    const chat = vi.fn();
    await router.route(request, chat);
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });
});

// ─── M1: spend gate ────────────────────────────────────────────

describe("BudgetSpendGate", () => {
  const req = (overrides: Partial<SpendRequest> = {}): SpendRequest => ({
    providerId: "openai", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1", messages: MESSAGES, maxTokens: 1_000, ...overrides,
  });

  it("authorizes a priced model on its official endpoint", () => {
    const { db, gate } = budgetSetup();
    expect(gate.authorize(req()).allowed).toBe(true);
    db.close();
  });

  it.each([
    ["unknown model", { modelId: "made-up" }],
    ["provider without registry pricing", { providerId: "groq", baseUrl: "https://api.groq.com/openai/v1", modelId: "llama-3.3-70b-versatile" }],
    ["Conway proxy posing as OpenAI", { baseUrl: "https://api.conway.tech/v1" }],
    ["malformed endpoint", { baseUrl: "not a url" }],
    ["missing output limit", { maxTokens: 0 }],
    ["fractional output limit", { maxTokens: 10.5 }],
  ])("refuses: %s", (_label, overrides) => {
    const { db, gate } = budgetSetup();
    expect(gate.authorize(req(overrides as Partial<SpendRequest>)).allowed).toBe(false);
    db.close();
  });

  it.each([
    ["per-call ceiling", { perCallCeilingCents: 1 }],
    ["hourly budget", { hourlyBudgetCents: 1 }],
    ["daily budget", { dailyBudgetCents: 0 }],
    ["session budget", { sessionBudgetCents: 1 }],
  ])("refuses when the %s would be exceeded", (_label, strategy) => {
    const { db, gate } = budgetSetup(strategy);
    const decision = gate.authorize(req({ maxTokens: 100_000 }));
    expect(decision.allowed).toBe(false);
    db.close();
  });

  it("records actual cost on success and worst case on an ambiguous failure", () => {
    const { db, budget, gate } = budgetSetup();
    const r = req();
    const auth = gate.authorize(r);
    if (!auth.allowed) throw new Error("expected allowed");
    gate.record(r, auth, { kind: "success", inputTokens: 1_000, outputTokens: 1_000, latencyMs: 1 });
    const afterSuccess = budget.getDailyCost();
    expect(afterSuccess).toBeGreaterThan(0);
    gate.record(r, auth, { kind: "failure", error: { status: 503 }, latencyMs: 1 });
    expect(budget.getDailyCost()).toBe(afterSuccess + auth.estimatedCostCents);
    gate.record(r, auth, { kind: "failure", error: { name: "CircuitOpenError" }, latencyMs: 1 });
    expect(budget.getDailyCost()).toBe(afterSuccess + auth.estimatedCostCents);
    db.close();
  });

  it("only trusts official endpoints", () => {
    expect(isOfficialEndpoint("openai", "https://api.openai.com/v1")).toBe(true);
    expect(isOfficialEndpoint("openai", undefined)).toBe(true);
    expect(isOfficialEndpoint("openai", "https://api.openai.com.evil.example/v1")).toBe(false);
    expect(isOfficialEndpoint("ollama", "http://localhost:11434/v1")).toBe(true);
    expect(isOfficialEndpoint("ollama", undefined)).toBe(false);
    expect(isOfficialEndpoint("together", "https://api.together.xyz/v1")).toBe(false);
  });
});

describe("UnifiedInferenceClient (orchestrator/worker path) is gated", () => {
  const registry = () => ProviderRegistry.fromConfig("/tmp/definitely-missing-provider-config.json");

  it("cannot be constructed without a spend gate", () => {
    expect(() => new UnifiedInferenceClient(registry(), undefined as any)).toThrow(/requires a spend gate/);
  });

  it("disables hidden SDK retries", async () => {
    const { db, gate } = budgetSetup();
    ok();
    await new UnifiedInferenceClient(registry(), gate).chat({ tier: "reasoning", messages: MESSAGES });
    expect(sdk.ctor.mock.calls.every(([opts]) => opts.maxRetries === 0)).toBe(true);
    db.close();
  });

  it("sends an explicit output limit and records the actual cost", async () => {
    const { db, budget, gate } = budgetSetup();
    ok(1_000, 100);
    const result = await new UnifiedInferenceClient(registry(), gate).chat({ tier: "reasoning", messages: MESSAGES });
    expect(result.metadata.modelId).toBe("gpt-4.1");
    expect(typeof sdk.calls[0].max_tokens).toBe("number");
    expect(sdk.calls[0].max_tokens).toBeGreaterThan(0);
    expect(budget.getDailyCost()).toBeGreaterThan(0);
    db.close();
  });

  it("refuses over-budget calls before the SDK is called, with no provider fallback", async () => {
    const { db, gate } = budgetSetup({ perCallCeilingCents: 1 });
    ok(); ok(); ok();
    await expect(new UnifiedInferenceClient(registry(), gate).chat({ tier: "reasoning", messages: MESSAGES, maxTokens: 50_000 }))
      .rejects.toBeInstanceOf(SpendRefusedError);
    expect(sdk.create).not.toHaveBeenCalled();
    db.close();
  });

  it("refuses unpriced providers (e.g. Groq) before the SDK is called", async () => {
    const { db, gate } = budgetSetup();
    ok();
    await expect(new UnifiedInferenceClient(registry(), gate).chatDirect({ providerId: "groq", modelId: "llama-3.3-70b-versatile", messages: MESSAGES }))
      .rejects.toBeInstanceOf(SpendRefusedError);
    expect(sdk.create).not.toHaveBeenCalled();
    db.close();
  });

  it("gates and records every retry attempt; the cap stops further retries", async () => {
    vi.useFakeTimers();
    const { db, budget, gate } = budgetSetup({ dailyBudgetCents: 10 });
    for (let i = 0; i < 10; i++) fail(503);
    const pending = new UnifiedInferenceClient(registry(), gate)
      .chat({ tier: "reasoning", messages: MESSAGES, maxTokens: 2_000 })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    // Every sent attempt was recorded (worst case), and the cap was never exceeded.
    const attempts = sdk.create.mock.calls.length;
    const recorded = (db.raw.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_cents), 0) AS cents FROM inference_costs").get() as { n: number; cents: number });
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThan(10);
    expect(recorded.n).toBe(attempts);
    expect(recorded.cents).toBeGreaterThan(0);
    expect(budget.getDailyCost()).toBeLessThanOrEqual(10);
    db.close();
  });
});

// ─── M2: secret-file permissions ───────────────────────────────

describe("checkSecretFilePermissions", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-perms-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (name: string, mode: number) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "{}");
    fs.chmodSync(file, mode);
    return file;
  };

  it.each([0o600, 0o400])("accepts mode %s", (mode) => {
    const result = checkSecretFilePermissions([make("automaton.json", mode)], { platform: "linux" });
    expect(result).toEqual({ supported: true, problems: [], warnings: [] });
  });

  it.each([0o644, 0o640, 0o604, 0o660, 0o606, 0o610, 0o601, 0o777])("refuses mode %s (group/other access)", (mode) => {
    const result = checkSecretFilePermissions([make("config.json", mode)], { platform: "darwin" });
    expect(result.problems.length).toBe(1);
    expect(result.problems[0]).toMatch(/chmod 600/);
  });

  it("refuses symlinks and non-regular files", () => {
    const target = make("real.json", 0o600);
    const link = path.join(dir, "wallet.json");
    fs.symlinkSync(target, link);
    const sub = path.join(dir, "automaton.json");
    fs.mkdirSync(sub);
    const result = checkSecretFilePermissions([link, sub], { platform: "linux" });
    expect(result.problems.length).toBe(2);
  });

  it("ignores files that don't exist", () => {
    expect(checkSecretFilePermissions([path.join(dir, "wallet.json")], { platform: "linux" }).problems).toEqual([]);
  });

  it("refuses on Windows by default: ACLs are not verified", () => {
    const result = checkSecretFilePermissions([make("automaton.json", 0o644)], { platform: "win32", env: {} });
    expect(result.supported).toBe(false);
    expect(result.problems[0]).toMatch(/NOT verified on Windows/);
  });

  it("covers automaton.json, config.json and wallet.json", () => {
    expect(secretFilePaths("/x").map((p) => path.basename(p))).toEqual(["automaton.json", "config.json", "wallet.json"]);
  });
});

describe("startup refuses unsafe secret-file permissions", () => {
  let home: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const lockSpy = vi.fn(() => { throw Object.assign(new Error("lock reached"), { name: "InstanceLockError" }); });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-perms-"));
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

  async function startWith(files: Record<string, number>) {
    const template = JSON.parse(fs.readFileSync(path.join(process.cwd(), "deploy/config/automaton.json.template"), "utf8"));
    const dir = path.join(home, ".automaton");
    fs.mkdirSync(dir, { recursive: true });
    const config = { ...template, name: "t", creatorAddress: "x", conwayApiUrl: "http://127.0.0.1:9", maxTurnsPerCycle: 1, dbPath: path.join(dir, "state.db") };
    for (const [name, mode] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, name === "automaton.json" ? JSON.stringify(config) : "{}");
      fs.chmodSync(file, mode);
    }
    vi.resetModules();
    vi.doMock("../safety/instance-lock.js", () => ({ acquireInstanceLock: lockSpy, InstanceLockError: Error }));
    const { run } = await import("../index.js");
    await expect(run(1)).rejects.toThrow("process.exit(1)");
    expect(fs.existsSync(path.join(dir, "state.db"))).toBe(false);
  }

  it.each([
    ["world-readable automaton.json", { "automaton.json": 0o644 }],
    ["group-readable config.json", { "automaton.json": 0o600, "config.json": 0o640 }],
    ["world-readable wallet.json", { "automaton.json": 0o600, "wallet.json": 0o604 }],
  ])("refuses before the lock: %s", async (_label, files) => {
    await startWith(files);
    expect(lockSpy).not.toHaveBeenCalled();
  });

  it("owner-only files pass and startup reaches the lock", async () => {
    await startWith({ "automaton.json": 0o600, "config.json": 0o600 });
    expect(lockSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── M1: no new ungated inference call sites ───────────────────

describe("inference call sites", () => {
  const srcDir = path.join(process.cwd(), "src");
  const runtimeFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" ? [] : runtimeFiles(full);
      return e.name.endsWith(".ts") ? [full] : [];
    });

  // Each of these reaches a provider only through the router (main loop) or
  // the spend-gated UnifiedInferenceClient (orchestrator, planner, workers).
  const GATED = new Set([
    "agent/loop.ts", // inference.chat passed as the router's callback
    "agent/worker-inference-bridge.ts",
    "agent/harnesses/base-harness.ts",
    "orchestration/local-worker.ts",
    "orchestration/orchestrator.ts",
    "orchestration/planner.ts",
    "orchestration/plan-mode.ts",
  ]);
  // Ungated helpers that must stay unused by runtime code.
  const UNWIRED = new Map([
    ["agent/context.ts", "summarizeTurns"],
    ["memory/compression-engine.ts", "CompressionEngine"],
  ]);

  it("every runtime .chat( call site is known and gated", () => {
    const callers = runtimeFiles(srcDir)
      .filter((f) => /\.chat\(/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(srcDir, f).split(path.sep).join("/"))
      .filter((f) => f !== "inference/inference-client.ts");
    const unexpected = callers.filter((f) => !GATED.has(f) && !UNWIRED.has(f));
    expect(unexpected).toEqual([]);
  });

  it("ungated helpers are not used by runtime code", () => {
    for (const [owner, symbol] of UNWIRED) {
      const users = runtimeFiles(srcDir)
        .filter((f) => !f.endsWith(owner.split("/").join(path.sep)))
        .filter((f) => new RegExp(`\\b${symbol}\\b`).test(fs.readFileSync(f, "utf8")));
      expect(users.map((f) => path.relative(srcDir, f)), symbol).toEqual([]);
    }
  });
});
