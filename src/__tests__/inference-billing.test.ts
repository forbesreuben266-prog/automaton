/**
 * Inference billing safety: conservative pre-call cost estimates, and no
 * automatic retries that could bill the same request twice.
 */

import { randomBytes } from "crypto";
import { getEncoding } from "js-tiktoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResilientHttpClient } from "../conway/http-client.js";
import { createInferenceClient, InferenceHttpError, InferenceRoutingError } from "../conway/inference.js";
import { estimateCostCentsUpperBound, InferenceRouter, mayHaveBeenBilled } from "../inference/router.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { SafeModeBlockedError } from "../safety/safe-mode.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import { createTestDb } from "./mocks.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const encoder = getEncoding("cl100k_base");
// With this price, the estimate in cents equals the estimated input tokens.
const ONE_CENT_PER_TOKEN = { costPer1kInput: 100_000, costPer1kOutput: 0 };
const cjk = "人工智能正在改变世界我们需要确保它安全可靠并且对人类有益";

describe("estimateCostCentsUpperBound", () => {
  it.each([
    ["base64", randomBytes(3_000).toString("base64")],
    ["chinese", cjk.repeat(40)],
    ["emoji", "🚀🔥💰🤖".repeat(200)],
    ["minified js", 'function(a,b){return a.map(function(c){return c*b+1})};'.repeat(40)],
    ["english", "The quick brown fox jumps over the lazy dog. ".repeat(60)],
  ])("never under-counts %s input (and beats chars/4)", (_label, text) => {
    const messages = [{ role: "user", content: text }];
    const estimate = estimateCostCentsUpperBound(messages, [], 0, ONE_CENT_PER_TOKEN);
    expect(estimate).toBeGreaterThanOrEqual(encoder.encode(text).length);
    expect(estimate).toBeGreaterThanOrEqual(Math.ceil(text.length / 4));
  });

  it("counts tool schemas and tool-call arguments, not just message content", () => {
    const toolCallMessage = [{ role: "assistant", content: null, tool_calls: [{ function: { name: "x", arguments: "a".repeat(5_000) } }] }];
    const tools = [{ type: "function", function: { name: "big", description: "d".repeat(8_000), parameters: {} } }];
    expect(estimateCostCentsUpperBound(toolCallMessage, [], 0, ONE_CENT_PER_TOKEN)).toBeGreaterThan(5_000);
    expect(estimateCostCentsUpperBound([], tools, 0, ONE_CENT_PER_TOKEN)).toBeGreaterThan(8_000);
  });

  it("prices output at the full max_tokens", () => {
    const model = { costPer1kInput: 0, costPer1kOutput: 100 };
    expect(estimateCostCentsUpperBound([], [], 8_192, model)).toBe(Math.ceil(8.192 * 100 / 100));
  });
});

describe("router budget checks use the upper bound", () => {
  function setup(overrides: Partial<typeof DEFAULT_MODEL_STRATEGY_CONFIG> = {}) {
    const db = createTestDb();
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const budget = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...overrides });
    const router = new InferenceRouter(db.raw, registry, budget);
    return { db, registry, budget, router };
  }

  it("blocks a CJK request that a chars/4 estimate would have let through", async () => {
    const { db, registry } = setup();
    const messages = [{ role: "user" as const, content: cjk.repeat(400) }];
    const model = registry.get("gpt-5.2")!;
    const maxTokens = 64;
    const oldEstimate = Math.ceil((messages[0].content.length / 4 / 1000) * model.costPer1kInput / 100 + (maxTokens / 1000) * model.costPer1kOutput / 100);
    const newEstimate = estimateCostCentsUpperBound(messages, [], maxTokens, model);
    expect(newEstimate).toBeGreaterThan(oldEstimate);
    db.close();

    const { db: db2, router } = setup({ perCallCeilingCents: newEstimate - 1 });
    const chat = vi.fn();
    const result = await router.route({ messages, taskType: "agent_turn", tier: "normal", sessionId: "s", maxTokens }, chat);
    expect(result.finishReason).toBe("budget_exceeded");
    expect(chat).not.toHaveBeenCalled();
    db2.close();
  });

  it("uses the real max_tokens, not a fixed 1000, for the output side", async () => {
    const { db, router } = setup({ perCallCeilingCents: 50 });
    const chat = vi.fn();
    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s", maxTokens: 1_000_000 },
      chat,
    );
    expect(result.finishReason).toBe("budget_exceeded");
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });
});

describe("failed calls that may have been billed", () => {
  function setup() {
    const db = createTestDb();
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const budget = new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG);
    const router = new InferenceRouter(db.raw, registry, budget);
    const request = { messages: [{ role: "user" as const, content: "hello" }], taskType: "agent_turn" as const, tier: "normal" as const, sessionId: "s" };
    return { db, budget, router, request };
  }

  it.each([
    ["HTTP 503", new InferenceHttpError("x", 503)],
    ["HTTP 429 (billing undocumented)", new InferenceHttpError("x", 429)],
    ["HTTP 400 (billing undocumented)", new InferenceHttpError("x", 400)],
    ["network error", new TypeError("fetch failed")],
    ["unknown error", new Error("???")],
  ])("records the worst-case estimate after %s", async (_label, error) => {
    const { db, budget, router, request } = setup();
    await expect(router.route(request, async () => { throw error; })).rejects.toBe(error);
    expect(budget.getDailyCost()).toBeGreaterThan(0);
    db.close();
  });

  it("records the worst-case estimate after a timeout", async () => {
    const { db, budget, router, request } = setup();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const result = await router.route(request, async () => { throw abort; });
    expect(result.finishReason).toBe("timeout");
    expect(budget.getDailyCost()).toBeGreaterThan(0);
    db.close();
  });

  it.each([
    ["routing refusal", new InferenceRoutingError("x")],
    ["safe-mode block", new SafeModeBlockedError("x")],
  ])("does not record cost after %s (never sent)", async (_label, error) => {
    const { db, budget, router, request } = setup();
    await expect(router.route(request, async () => { throw error; })).rejects.toBe(error);
    expect(budget.getDailyCost()).toBe(0);
    db.close();
  });

  it("classifies errors conservatively", () => {
    expect(mayHaveBeenBilled({ status: 500 })).toBe(true);
    expect(mayHaveBeenBilled({ status: 429 })).toBe(true);
    expect(mayHaveBeenBilled({ status: 404 })).toBe(true);
    expect(mayHaveBeenBilled({ name: "CircuitOpenError" })).toBe(false);
    expect(mayHaveBeenBilled(undefined)).toBe(true);
  });
});

describe("ResilientHttpClient retries", () => {
  const fast = { backoffBase: 1, backoffMax: 2, circuitBreakerThreshold: 100 };
  const respond = (...statuses: number[]) => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const status of statuses) spy.mockResolvedValueOnce(new Response("{}", { status }));
    return spy;
  };

  it.each([500, 502, 503, 504])("never retries a non-idempotent request after HTTP %i", async (status) => {
    const spy = respond(status, 200);
    const res = await new ResilientHttpClient(fast).request("https://api.example.com/x", { method: "POST", nonIdempotent: true });
    expect(res.status).toBe(status);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never retries a non-idempotent request after a network error or timeout", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(new ResilientHttpClient(fast).request("https://api.example.com/x", { method: "POST", nonIdempotent: true }))
      .rejects.toThrow("fetch failed");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([429, 400])("never retries a non-idempotent request after HTTP %i, even with retries allowed", async (status) => {
    const spy = respond(status, 200);
    const res = await new ResilientHttpClient(fast).request("https://api.example.com/x", { method: "POST", nonIdempotent: true, retries: 5 });
    expect(res.status).toBe(status);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying idempotent requests on 5xx (unchanged behaviour)", async () => {
    const spy = respond(503, 200);
    const res = await new ResilientHttpClient(fast).request("https://api.example.com/x");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("inference client sends each billable request once", () => {
  const client = () =>
    createInferenceClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "",
      defaultModel: "gpt-5-mini",
      maxTokens: 100,
      openaiApiKey: "test-key-not-real",
      getModelProvider: () => "openai",
    });

  it.each([429, 500, 503])("does not resend after HTTP %i and surfaces the status", async (status) => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status }));
    const error = await client().chat([{ role: "user", content: "hi" }]).catch((e) => e);
    expect(error).toBeInstanceOf(InferenceHttpError);
    expect(error.status).toBe(status);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not resend after a network error", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("socket hang up"));
    await expect(client().chat([{ role: "user", content: "hi" }])).rejects.toThrow("socket hang up");
    expect(spy).toHaveBeenCalledTimes(1);
  });

});

describe("aggregate daily cap across a whole run", () => {
  it("repeated attempts (failures and successes) never push recorded spend past the cap", async () => {
    const db = createTestDb();
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const cap = 40;
    const budget = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, dailyBudgetCents: cap });
    const router = new InferenceRouter(db.raw, registry, budget);
    const request = { messages: [{ role: "user" as const, content: "x".repeat(2_000) }], taskType: "agent_turn" as const, tier: "normal" as const, sessionId: "run" };
    let sent = 0;
    const chat = vi.fn(async () => {
      sent += 1;
      if (sent % 2 === 0) throw new InferenceHttpError("server error", 503); // ambiguous: counts as billed
      // Successful call reports usage up to its upper bound.
      return { message: { content: "ok" }, usage: { promptTokens: 2_100, completionTokens: 4_096 } };
    });

    let blocked = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await router.route(request, chat).catch(() => null);
      if (result?.finishReason === "budget_exceeded") blocked += 1;
    }

    expect(budget.getDailyCost()).toBeLessThanOrEqual(cap);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(200);
    expect(blocked).toBe(200 - sent);
    db.close();
  });
});
