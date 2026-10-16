/**
 * Model selection: the router uses exactly the configured model, never
 * substitutes another, and fails closed (before any network request) when
 * the model, its credentials or the budget don't allow the call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InferenceRouter } from "../inference/router.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { createInferenceClient, InferenceRoutingError } from "../conway/inference.js";
import { runAgentLoop } from "../agent/loop.js";
import { __resetSafeModeForTests, activateSafeMode } from "../safety/safe-mode.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { ModelEntry, ModelStrategyConfig } from "../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
} from "./mocks.js";

const request = (overrides: Record<string, unknown> = {}) => ({
  messages: [{ role: "user" as const, content: "hello" }],
  taskType: "agent_turn" as const,
  tier: "normal" as const,
  sessionId: "s",
  ...overrides,
});

function setup(strategy: Partial<ModelStrategyConfig> = {}) {
  const db = createTestDb();
  const registry = new ModelRegistry(db.raw);
  registry.initialize();
  const budget = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...strategy });
  const router = new InferenceRouter(db.raw, registry, budget);
  return { db, registry, budget, router };
}

function inferenceClient(keys: { openaiApiKey?: string; anthropicApiKey?: string; apiKey?: string }, registry: ModelRegistry) {
  return createInferenceClient({
    apiUrl: "https://api.conway.tech",
    apiKey: keys.apiKey ?? "",
    defaultModel: "unused",
    maxTokens: 100,
    openaiApiKey: keys.openaiApiKey,
    anthropicApiKey: keys.anthropicApiKey,
    getModelProvider: (id) => registry.get(id)?.provider,
  });
}

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

describe("configured model selection", () => {
  it("uses the configured model, not the routing matrix's preferred one", async () => {
    const { db, router } = setup({ inferenceModel: "gpt-5-mini" });
    const chat = vi.fn(async () => ({ message: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } }));
    const result = await router.route(request(), chat);
    expect(result.model).toBe("gpt-5-mini");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].model).toBe("gpt-5-mini");
    db.close();
  });

  it.each([
    ["normal", "inferenceModel"],
    ["high", "inferenceModel"],
    ["low_compute", "lowComputeModel"],
    ["critical", "criticalModel"],
  ] as const)("tier %s uses %s", (tier, field) => {
    const { db, router } = setup({ inferenceModel: "gpt-4.1", lowComputeModel: "gpt-4.1-mini", criticalModel: "gpt-4.1-nano" });
    const expected = { inferenceModel: "gpt-4.1", lowComputeModel: "gpt-4.1-mini", criticalModel: "gpt-4.1-nano" }[field];
    expect(router.selectModel(tier, "agent_turn")?.modelId).toBe(expected);
    db.close();
  });

  it("refuses conflicting inferenceModel vs modelStrategy.inferenceModel (no guessing)", async () => {
    const db = createTestDb();
    const inference = new MockInferenceClient([noToolResponse("should not be called")]);
    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig({ inferenceModel: "gpt-5-mini", modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG, inferenceModel: "gpt-5.2" } }),
      db,
      conway: new MockConwayClient(),
      inference,
    });
    expect(inference.calls.length).toBe(0);
    const thoughts = db.getRecentTurns(5).map((t) => t.thinking).join(" ");
    expect(thoughts).toMatch(/Conflicting model configuration/);
    db.close();
  });
});

describe("unknown, unsupported or unavailable models fail closed", () => {
  it.each(["made-up-model", "", "gpt-5.2 ", "GPT-5.2"])("refuses unknown model %j without substituting", async (modelId) => {
    const { db, router } = setup({ inferenceModel: modelId });
    const chat = vi.fn();
    const result = await router.route(request(), chat);
    expect(result.finishReason).toBe("error");
    expect(result.content).toMatch(/Model selection refused/);
    expect(result.model).toBe("none");
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it("refuses a disabled configured model", async () => {
    const { db, registry, router } = setup({ inferenceModel: "gpt-5-mini" });
    registry.setEnabled("gpt-5-mini", false);
    const chat = vi.fn();
    const result = await router.route(request(), chat);
    expect(result.content).toMatch(/disabled; refusing to substitute/);
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it("refuses tasks the routing matrix disallows at a tier", () => {
    const { db, router } = setup();
    const selection = router.selectModelWithReason("dead", "agent_turn");
    expect(selection.model).toBeNull();
    expect(selection.reason).toMatch(/not allowed at survival tier "dead"/);
    db.close();
  });
});

describe("missing or unavailable credentials", () => {
  it("refuses before any network request when no key is configured at all (no Conway fallback)", async () => {
    const { db, registry, budget, router } = setup({ inferenceModel: "gpt-5-mini" });
    const client = inferenceClient({}, registry);
    await expect(router.route(request(), (m, o) => client.chat(m, o))).rejects.toBeInstanceOf(InferenceRoutingError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(budget.getDailyCost()).toBe(0);
    db.close();
  });

  it("does not use another provider's key for an OpenAI model", async () => {
    const { db, registry, router } = setup({ inferenceModel: "gpt-5-mini" });
    const client = inferenceClient({ anthropicApiKey: "test-not-real" }, registry);
    await expect(router.route(request(), (m, o) => client.chat(m, o))).rejects.toBeInstanceOf(InferenceRoutingError);
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });
});

describe("per-call budget rejection happens before any network request", () => {
  it("blocks an over-ceiling call with a valid key configured, without calling fetch", async () => {
    const { db, registry, router } = setup({ inferenceModel: "gpt-5.2", perCallCeilingCents: 5 });
    const client = inferenceClient({ openaiApiKey: "test-not-real" }, registry);
    const result = await router.route(request({ messages: [{ role: "user", content: "x".repeat(60_000) }] }), (m, o) => client.chat(m, o));
    expect(result.finishReason).toBe("budget_exceeded");
    expect(result.content).toMatch(/exceeds ceiling of 5c/);
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });
});

describe("safe mode never falls back to Conway", () => {
  beforeEach(() => activateSafeMode("test"));

  it("refuses an OpenAI-registered model with only a Conway key", async () => {
    const { db, registry, router } = setup({ inferenceModel: "gpt-5-mini" });
    const client = inferenceClient({ apiKey: "conway-key-not-real" }, registry);
    await expect(router.route(request(), (m, o) => client.chat(m, o))).rejects.toThrow(/needs an OpenAI API key/);
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });

  it("refuses a Conway-registered model even with a Conway key", async () => {
    const { db, registry, router } = setup({ inferenceModel: "conway-only-model" });
    const now = new Date().toISOString();
    registry.upsert({
      modelId: "conway-only-model", provider: "conway" as any, displayName: "c", tierMinimum: "normal",
      costPer1kInput: 10, costPer1kOutput: 10, maxTokens: 1000, contextWindow: 8000, supportsTools: true,
      supportsVision: false, parameterStyle: "max_tokens", enabled: true, lastSeen: null, createdAt: now, updatedAt: now,
    } as ModelEntry);
    const client = inferenceClient({ apiKey: "conway-key-not-real" }, registry);
    await expect(router.route(request(), (m, o) => client.chat(m, o))).rejects.toThrow(/Conway inference is disabled in safe mode/);
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });
});
