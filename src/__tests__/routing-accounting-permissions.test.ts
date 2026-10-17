/**
 * Provider routing (no silent fallback), cost accounting (every attempt
 * recorded and reserved, output limits always bounded), free-model limits,
 * and secret-file ownership/platform checks. Offline: the OpenAI SDK and
 * fetch are mocked; the production gate, budget, router and clients run.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import { ProviderRegistry, type ProviderConfig } from "../inference/provider-registry.js";
import { BudgetSpendGate, effectiveFreeModels, SpendRefusedError, type InferenceSpendGate } from "../inference/spend-gate.js";
import { InvalidFallbackPolicyError } from "../inference/fallback-policy.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { InferenceRouter } from "../inference/router.js";
import { createInferenceClient, InferenceRoutingError } from "../conway/inference.js";
import { checkSecretFilePermissions, WINDOWS_ACK_ENV } from "../safety/file-permissions.js";
import { __resetSafeModeForTests, activateSafeMode } from "../safety/safe-mode.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { ModelEntry, ModelStrategyConfig } from "../types.js";
import { createTestDb } from "./mocks.js";

const sdk = vi.hoisted(() => {
  const queue: Array<() => unknown> = [];
  const events: string[] = [];
  const calls: any[] = [];
  const create = vi.fn(async (payload: any) => {
    calls.push(payload);
    events.push(`send:${payload.model}`);
    const next = queue.shift();
    if (!next) throw new Error("No OpenAI mock response queued");
    return next();
  });
  const ctor = vi.fn().mockImplementation(function MockOpenAI(this: any, opts: any) {
    this.opts = opts;
    this.chat = { completions: { create } };
  });
  return { queue, events, calls, create, ctor };
});
vi.mock("openai", () => ({ default: sdk.ctor }));

const MESSAGES = [{ role: "user" as const, content: "hello" }];
const ok = () => sdk.queue.push(() => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
const fail = (status: number) => sdk.queue.push(() => { throw Object.assign(new Error(`HTTP ${status}`), { status }); });
const OPENAI_TO_GROQ = [{ fromProvider: "openai", fromModel: "gpt-4.1", toProvider: "groq", toModel: "llama-3.3-70b-versatile" }];

function setup(strategy: Partial<ModelStrategyConfig> = {}) {
  const db = createTestDb();
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();
  const budget = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...strategy });
  const gate = new BudgetSpendGate(budget, modelRegistry, { sessionId: "s", taskType: "planning", tier: "normal" });
  const providers = ProviderRegistry.fromConfig("/tmp/definitely-missing-provider-config.json");
  return { db, modelRegistry, budget, gate, providers };
}

/** Wraps the real gate to log the order of authorize/record events. */
function tracingGate(inner: InferenceSpendGate): InferenceSpendGate {
  return {
    authorize: (r) => { sdk.events.push(`authorize:${r.modelId}`); return inner.authorize(r); },
    record: (r, a, o) => { sdk.events.push(`record:${r.modelId}:${o.kind}`); inner.record(r, a, o); },
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetSafeModeForTests();
  sdk.queue.splice(0);
  sdk.events.splice(0);
  sdk.calls.splice(0);
  sdk.create.mockClear();
  sdk.ctor.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));
});

afterEach(() => {
  __resetSafeModeForTests();
  fetchSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

// ─── 1. Provider routing ───────────────────────────────────────

describe("orchestrator routing: no silent fallback", () => {
  it("without a policy, retries only the configured model and never moves to another provider", async () => {
    vi.useFakeTimers();
    const { db, gate, providers } = setup();
    for (let i = 0; i < 8; i++) fail(503);
    const error = await settle(new UnifiedInferenceClient(providers, gate).chat({ tier: "reasoning", messages: MESSAGES }).catch((e) => e));
    expect(error).toBeInstanceOf(Error);
    expect(sdk.calls.length).toBeGreaterThan(1); // same-model retries happened
    expect(new Set(sdk.calls.map((c) => c.model))).toEqual(new Set(["gpt-4.1"]));
    db.close();
  });

  it("refuses when the configured provider is disabled, instead of using another", async () => {
    const { db, gate, providers } = setup();
    providers.disableProvider("openai", "test", 60_000);
    ok();
    await expect(new UnifiedInferenceClient(providers, gate).chat({ tier: "reasoning", messages: MESSAGES })).rejects.toThrow(/Configured provider 'openai'.*disabled/);
    expect(sdk.create).not.toHaveBeenCalled();
    db.close();
  });

  it("survival mode cannot switch the configured model", async () => {
    vi.stubEnv("AUTOMATON_CREDITS_BALANCE", "500");
    const { db, gate, providers } = setup();
    ok();
    const result = await new UnifiedInferenceClient(providers, gate).chat({ tier: "reasoning", messages: MESSAGES });
    expect(result.metadata.modelId).toBe("gpt-4.1");
    db.close();
  });

  it("an authorized fallback is attempted but still goes through the spend gate (unpriced Groq is refused, never sent)", async () => {
    vi.useFakeTimers();
    const { db, gate, providers } = setup();
    for (let i = 0; i < 4; i++) fail(503);
    ok();
    const error = await settle(
      new UnifiedInferenceClient(providers, tracingGate(gate), { fallbackPolicy: OPENAI_TO_GROQ })
        .chat({ tier: "reasoning", messages: MESSAGES }).catch((e) => e),
    );
    expect(error).toBeInstanceOf(SpendRefusedError);
    expect(sdk.events).toContain("authorize:llama-3.3-70b-versatile");
    expect(sdk.events).not.toContain("send:llama-3.3-70b-versatile");
    db.close();
  });

  it("safe mode ignores the fallback policy entirely", async () => {
    vi.useFakeTimers();
    activateSafeMode("test");
    const { db, gate, providers } = setup({ perCallCeilingCents: 10, hourlyBudgetCents: 50, dailyBudgetCents: 500 });
    for (let i = 0; i < 8; i++) fail(503);
    // Small output limit so the configured model's attempts pass the safe-mode
    // caps and actually fail; the fallback decision is then exercised.
    await settle(
      new UnifiedInferenceClient(providers, tracingGate(gate), { fallbackPolicy: OPENAI_TO_GROQ })
        .chat({ tier: "reasoning", messages: MESSAGES, maxTokens: 50 }).catch((e) => e),
    );
    expect(sdk.events.filter((e) => e === "send:gpt-4.1").length).toBeGreaterThan(1);
    expect(sdk.events.some((e) => e.includes("llama"))).toBe(false);
    db.close();
  });

  it.each([
    ["not an array", { fromProvider: "openai" }],
    ["missing field", [{ fromProvider: "openai", fromModel: "gpt-4.1", toProvider: "groq" }]],
    ["blank field", [{ ...OPENAI_TO_GROQ[0], toModel: " " }]],
    ["self mapping", [{ fromProvider: "openai", fromModel: "gpt-4.1", toProvider: "openai", toModel: "gpt-4.1" }]],
    ["unregistered target", [{ ...OPENAI_TO_GROQ[0], toModel: "made-up" }]],
    ["unregistered source", [{ ...OPENAI_TO_GROQ[0], fromModel: "made-up" }]],
  ])("an invalid policy refuses at construction: %s", (_label, policy) => {
    const { db, gate, providers } = setup();
    expect(() => new UnifiedInferenceClient(providers, gate, { fallbackPolicy: policy })).toThrow(InvalidFallbackPolicyError);
    db.close();
  });

  it("a mapping from a different source model does not authorize fallback", async () => {
    vi.useFakeTimers();
    const { db, gate, providers } = setup();
    for (let i = 0; i < 8; i++) fail(503);
    const policy = [{ fromProvider: "openai", fromModel: "gpt-4.1-mini", toProvider: "groq", toModel: "llama-3.3-70b-versatile" }];
    await settle(new UnifiedInferenceClient(providers, tracingGate(gate), { fallbackPolicy: policy }).chat({ tier: "reasoning", messages: MESSAGES }).catch((e) => e));
    expect(sdk.events.some((e) => e.includes("llama"))).toBe(false);
    db.close();
  });
});

// ─── 3. Cost accounting ────────────────────────────────────────

describe("cost accounting", () => {
  it("every attempt is authorized, sent and recorded before the next attempt starts", async () => {
    vi.useFakeTimers();
    const { db, gate, providers } = setup();
    fail(503); fail(503); ok();
    await settle(new UnifiedInferenceClient(providers, tracingGate(gate)).chat({ tier: "reasoning", messages: MESSAGES }));
    expect(sdk.events).toEqual([
      "authorize:gpt-4.1", "send:gpt-4.1", "record:gpt-4.1:failure",
      "authorize:gpt-4.1", "send:gpt-4.1", "record:gpt-4.1:failure",
      "authorize:gpt-4.1", "send:gpt-4.1", "record:gpt-4.1:success",
    ]);
    db.close();
  });

  it("concurrent gate authorizations can't both pass the aggregate cap (reservation)", () => {
    const { db, gate } = setup();
    const req = { providerId: "openai", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1", messages: MESSAGES, maxTokens: 1_000 };
    const first = gate.authorize(req);
    if (!first.allowed) throw new Error("first should pass");
    const cap = first.estimatedCostCents; // exactly one call fits
    db.close();

    const { db: db2, gate: gate2, budget } = setup({ dailyBudgetCents: cap });
    const a = gate2.authorize(req);
    const b = gate2.authorize(req); // while a is still in flight
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
    if (!a.allowed) throw new Error("unreachable");
    gate2.record(req, a, { kind: "failure", error: new Error("socket hang up"), latencyMs: 1 }); // worst case recorded
    expect(budget.getReservedCost()).toBe(0);
    expect(gate2.authorize(req).allowed).toBe(false); // recorded spend now fills the cap
    db2.close();
  });

  it("a reservation is released even if recording throws", () => {
    const { db, gate, budget } = setup();
    const req = { providerId: "openai", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1", messages: MESSAGES, maxTokens: 100 };
    const auth = gate.authorize(req);
    if (!auth.allowed) throw new Error("expected allowed");
    expect(budget.getReservedCost()).toBeGreaterThan(0);
    vi.spyOn(budget, "recordCost").mockImplementation(() => { throw new Error("db down"); });
    expect(() => gate.record(req, auth, { kind: "success", inputTokens: 1, outputTokens: 1, latencyMs: 1 })).toThrow("db down");
    expect(budget.getReservedCost()).toBe(0);
    db.close();
  });

  it("concurrent router calls can't both pass the daily cap while the first is in flight", async () => {
    const { db, modelRegistry, budget } = setup({ inferenceModel: "gpt-5-mini" });
    const router0 = new InferenceRouter(db.raw, modelRegistry, budget);
    let estimate = 0;
    const probe = vi.fn(async () => { estimate = budget.getReservedCost(); return { message: { content: "x" }, usage: { promptTokens: 0, completionTokens: 0 } }; });
    await router0.route({ messages: MESSAGES, taskType: "agent_turn", tier: "normal", sessionId: "s" }, probe);
    db.close();

    const { db: db2, modelRegistry: reg2, budget: budget2 } = setup({ inferenceModel: "gpt-5-mini", dailyBudgetCents: estimate });
    const router = new InferenceRouter(db2.raw, reg2, budget2);
    let releaseFirst!: () => void;
    const slowChat = vi.fn(() => new Promise<any>((resolve) => { releaseFirst = () => resolve({ message: { content: "a" }, usage: { promptTokens: 1, completionTokens: 1 } }); }));
    const first = router.route({ messages: MESSAGES, taskType: "agent_turn", tier: "normal", sessionId: "s" }, slowChat);
    const secondChat = vi.fn();
    const second = await router.route({ messages: MESSAGES, taskType: "agent_turn", tier: "normal", sessionId: "s" }, secondChat);
    expect(second.finishReason).toBe("budget_exceeded");
    expect(secondChat).not.toHaveBeenCalled();
    releaseFirst();
    await first;
    expect(budget2.getReservedCost()).toBe(0);
    db2.close();
  });

  it.each([-5, 1.5, Infinity])("router refuses an invalid output token limit (%s) before sending", async (maxTokens) => {
    const { db, modelRegistry, budget } = setup({ inferenceModel: "gpt-5-mini" });
    const chat = vi.fn();
    const result = await new InferenceRouter(db.raw, modelRegistry, budget).route(
      { messages: MESSAGES, taskType: "agent_turn", tier: "normal", sessionId: "s", maxTokens }, chat,
    );
    expect(result.finishReason).toBe("budget_exceeded");
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it("router passes the estimated output limit through to the client", async () => {
    const { db, modelRegistry, budget } = setup({ inferenceModel: "gpt-5-mini" });
    const chat = vi.fn(async () => ({ message: { content: "x" }, usage: { promptTokens: 1, completionTokens: 1 } }));
    await new InferenceRouter(db.raw, modelRegistry, budget).route(
      { messages: MESSAGES, taskType: "agent_turn", tier: "normal", sessionId: "s", maxTokens: 321 }, chat,
    );
    expect(chat.mock.calls[0][1].maxTokens).toBe(321);
    db.close();
  });

  it.each([
    ["openai gpt-5 (max_completion_tokens)", "gpt-5-mini", { openaiApiKey: "test-not-real" }, "openai", "max_completion_tokens"],
    ["openai gpt-4o-style (max_tokens)", "gpt-4o-x", { openaiApiKey: "test-not-real" }, "openai", "max_tokens"],
    ["anthropic (max_tokens)", "claude-test", { anthropicApiKey: "test-not-real" }, "anthropic", "max_tokens"],
    ["ollama (max_tokens)", "llama3", { ollamaBaseUrl: "http://localhost:11434" }, "ollama", "max_tokens"],
  ])("main client sends the router's limit for %s", async (_label, model, keys, provider, field) => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(
      provider === "anthropic"
        ? { content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }
        : { choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ), { status: 200 }));
    const client = createInferenceClient({ apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "x", maxTokens: 9_999, ...keys, getModelProvider: () => provider });
    await client.chat(MESSAGES, { model, maxTokens: 321 });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body[field]).toBe(321);
  });

  it("orchestrator client refuses a model whose configured output limit is missing", async () => {
    const custom: ProviderConfig = {
      id: "openai", name: "openai", baseUrl: "https://api.openai.com/v1", apiKeyEnvVar: "OPENAI_API_KEY",
      models: [{ id: "gpt-4.1", tier: "reasoning", contextWindow: 1000, maxOutputTokens: 0, costPerInputToken: 1, costPerOutputToken: 1, supportsTools: true, supportsVision: false, supportsStreaming: false }],
      maxRequestsPerMinute: 10, maxTokensPerMinute: 1000, priority: 1, enabled: true,
    };
    const providers = new ProviderRegistry([custom], {
      reasoning: { preferredProvider: "openai", fallbackOrder: [] },
      fast: { preferredProvider: "openai", fallbackOrder: [] },
      cheap: { preferredProvider: "openai", fallbackOrder: [] },
    });
    const { db, gate } = setup();
    ok();
    await expect(new UnifiedInferenceClient(providers, gate).chat({ tier: "reasoning", messages: MESSAGES })).rejects.toBeInstanceOf(SpendRefusedError);
    expect(sdk.create).not.toHaveBeenCalled();
    db.close();
  });
});

// ─── 3b. Free Ollama models ────────────────────────────────────

describe("explicit free Ollama models get no special routing or retry exemptions", () => {
  const localModel = (): ModelEntry => {
    const now = new Date().toISOString();
    return { modelId: "llama3", provider: "ollama", displayName: "llama3", tierMinimum: "normal", costPer1kInput: 0, costPer1kOutput: 0, maxTokens: 2048, contextWindow: 8192, supportsTools: true, supportsVision: false, parameterStyle: "max_tokens", enabled: true, lastSeen: null, createdAt: now, updatedAt: now } as ModelEntry;
  };

  it.each([
    [undefined, []],
    ["http://localhost:11434", ["llama3"]],
    ["http://127.0.0.1:11434/v1", ["llama3"]],
    ["http://10.0.0.5:11434", []],
    ["https://ollama.example.com", []],
    ["not a url", []],
  ])("free-model policy with Ollama endpoint %j -> %j", (url, expected) => {
    expect(effectiveFreeModels(["llama3"], url as string | undefined)).toEqual(expected);
  });

  it("are refused when the Ollama endpoint is missing (routing still applies)", async () => {
    const { db, modelRegistry, budget } = setup({ inferenceModel: "llama3", freeModels: ["llama3"] });
    modelRegistry.upsert(localModel());
    const client = createInferenceClient({ apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "llama3", maxTokens: 100, getModelProvider: (id) => modelRegistry.get(id)?.provider });
    await expect(new InferenceRouter(db.raw, modelRegistry, budget).route(
      { messages: MESSAGES, taskType: "agent_turn", tier: "normal", sessionId: "s" }, (m, o) => client.chat(m, o),
    )).rejects.toBeInstanceOf(InferenceRoutingError);
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });

  it("are not retried on failure (sent once)", async () => {
    fetchSpy.mockResolvedValue(new Response("busy", { status: 503 }));
    const client = createInferenceClient({ apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "llama3", maxTokens: 100, ollamaBaseUrl: "http://localhost:11434", getModelProvider: () => "ollama" });
    await expect(client.chat(MESSAGES, { model: "llama3", maxTokens: 100 })).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("can't be used by the orchestrator client (local provider pricing is not trusted)", async () => {
    const { db, budget, modelRegistry } = setup({ freeModels: ["llama3.3:70b"] });
    modelRegistry.upsert({ ...localModel(), modelId: "llama3.3:70b" });
    const gate = new BudgetSpendGate(budget, modelRegistry, { sessionId: "s", taskType: "planning", tier: "normal" });
    ok();
    // The gate itself refuses local-provider pricing, even with the model listed as free...
    const decision = gate.authorize({ providerId: "local", baseUrl: "http://localhost:11434/v1", modelId: "llama3.3:70b", messages: MESSAGES, maxTokens: 100 });
    expect(decision.allowed).toBe(false);
    // ...and the client can't reach it either.
    const providers = ProviderRegistry.fromConfig("/tmp/definitely-missing-provider-config.json");
    await expect(new UnifiedInferenceClient(providers, gate).chatDirect({ providerId: "local", modelId: "llama3.3:70b", messages: MESSAGES })).rejects.toThrow();
    expect(sdk.create).not.toHaveBeenCalled();
    db.close();
  });
});

// ─── 2. Secret-file ownership and platform handling ────────────

describe("secret-file ownership and platform handling", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-owner-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (name: string, mode = 0o600) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "{}");
    fs.chmodSync(file, mode);
    return file;
  };
  const uid = process.getuid!();

  it("accepts files owned by the current user", () => {
    expect(checkSecretFilePermissions([make("automaton.json")], { platform: "linux" }).problems).toEqual([]);
  });

  it.runIf(uid === 0)("refuses a secret file owned by another user", () => {
    const file = make("config.json");
    fs.chownSync(file, 12345, 12345);
    const result = checkSecretFilePermissions([file], { platform: "linux" });
    expect(result.problems.join(" ")).toMatch(/owned by uid 12345/);
  });

  it.runIf(uid === 0)("refuses a directory owned by another user", () => {
    const file = make("wallet.json");
    fs.chownSync(dir, 12345, 12345);
    const result = checkSecretFilePermissions([file], { platform: "linux" });
    expect(result.problems.join(" ")).toMatch(new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is owned by uid 12345`));
  });

  it("accepts root-owned files for a non-root process (only root could change them)", () => {
    const file = make("automaton.json");
    const owner = fs.statSync(file).uid;
    const result = checkSecretFilePermissions([file], { platform: "linux", getuid: () => (owner === 0 ? 4242 : owner) });
    expect(result.problems).toEqual([]);
  });

  it("refuses files owned by a different non-root user (simulated uid)", () => {
    const file = make("automaton.json");
    const owner = fs.statSync(file).uid;
    if (owner === 0) {
      fs.chownSync(file, 5555, 5555);
    }
    const result = checkSecretFilePermissions([file], { platform: "linux", getuid: () => 7777 });
    expect(result.problems.join(" ")).toMatch(/not the current user \(uid 7777\)/);
  });

  it.each([0o777, 0o775, 0o757, 0o733])("refuses a directory writable by group/other (mode %s)", (mode) => {
    const file = make("automaton.json");
    fs.chmodSync(dir, mode);
    expect(checkSecretFilePermissions([file], { platform: "darwin" }).problems.join(" ")).toMatch(/could replace secret files/);
  });

  it("accepts a 0755 or 0700 directory", () => {
    const file = make("automaton.json");
    for (const mode of [0o755, 0o700]) {
      fs.chmodSync(dir, mode);
      expect(checkSecretFilePermissions([file], { platform: "linux" }).problems).toEqual([]);
    }
  });

  it("refuses when the current user can't be determined (fail closed)", () => {
    const result = checkSecretFilePermissions([make("automaton.json")], { platform: "linux", getuid: null });
    expect(result.supported).toBe(false);
    expect(result.problems[0]).toMatch(/Cannot determine the current user id/);
  });

  it("Windows refuses by default and never claims ACL protection", () => {
    const result = checkSecretFilePermissions([make("automaton.json", 0o600)], { platform: "win32", env: {} });
    expect(result.supported).toBe(false);
    expect(result.problems[0]).toMatch(/NOT verified on Windows/);
    expect(result.problems[0]).toMatch(new RegExp(WINDOWS_ACK_ENV));
  });

  it("Windows continues only with explicit acknowledgement, still warning", () => {
    for (const value of ["0", "true", "yes", ""]) {
      expect(checkSecretFilePermissions([make("automaton.json")], { platform: "win32", env: { [WINDOWS_ACK_ENV]: value } }).problems.length).toBe(1);
    }
    const acked = checkSecretFilePermissions([make("automaton.json")], { platform: "win32", env: { [WINDOWS_ACK_ENV]: "1" } });
    expect(acked).toMatchObject({ supported: false, problems: [] });
    expect(acked.warnings[0]).toMatch(/NOT verified on Windows/);
  });
});
