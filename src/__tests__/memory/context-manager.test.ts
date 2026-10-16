import { randomBytes } from "crypto";
import { getEncoding } from "js-tiktoken";
import { describe, expect, it } from "vitest";
import {
  ContextManager,
  createTokenCounter,
  type StreamEvent,
  type TokenCounter,
} from "../../memory/context-manager.js";

function fixedTokenCounter(tokensPerMessage: number): TokenCounter {
  const cache = new Map<string, number>();

  const countTokens = (text: string): number => {
    const key = `k::${text}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    cache.set(key, tokensPerMessage);
    return tokensPerMessage;
  };

  return {
    countTokens,
    cache,
    countBatch: (texts: string[]) => texts.map((text) => countTokens(text)),
  };
}

function makeTurn(index: number): any {
  return {
    input: `turn-${index}`,
    inputSource: "user",
  };
}

function makeEvent(index: number, overrides?: Partial<StreamEvent>): StreamEvent {
  return {
    id: `evt-${index}`,
    type: "observation",
    agentAddress: "agent-a",
    goalId: `goal-${index}`,
    taskId: `task-${index}`,
    content: `event-content-${index}`,
    tokenCount: 15,
    compactedTo: null,
    createdAt: `2026-01-01T00:00:0${index}.000Z`,
    ...overrides,
  };
}

describe("createTokenCounter", () => {
  it("createTokenCounter returns a working counter", () => {
    const counter = createTokenCounter();

    expect(counter).toHaveProperty("countTokens");
    expect(counter).toHaveProperty("countBatch");
    expect(counter.countTokens("hello")).toBeGreaterThan(0);
    expect(counter.countBatch(["a", "b"])).toHaveLength(2);
  });

  it("countTokens uses cache for repeated input", () => {
    const counter = createTokenCounter();

    const first = counter.countTokens("repeat");
    const sizeAfterFirst = counter.cache.size;
    const second = counter.countTokens("repeat");

    expect(first).toBe(second);
    expect(counter.cache.size).toBe(sizeAfterFirst);
  });

  it("LRU cache limits to 10000 entries", () => {
    const counter = createTokenCounter();

    for (let i = 0; i < 10_050; i += 1) {
      counter.countTokens(`msg-${i}`);
    }

    expect(counter.cache.size).toBeLessThanOrEqual(10_000);
  });

  it("LRU behavior evicts oldest keys first", () => {
    const counter = createTokenCounter();

    for (let i = 0; i < 10_005; i += 1) {
      counter.countTokens(`evict-${i}`);
    }

    expect(counter.cache.has("default::evict-0")).toBe(false);
    expect(counter.cache.has("default::evict-10004")).toBe(true);
  });

});

describe("createTokenCounter bounded BPE", () => {
  const encoder = getEncoding("cl100k_base");
  const exact = (text: string) => encoder.encode(text).length;
  const cjk = "人工智能正在改变世界我们需要确保它安全可靠并且对人类有益";

  it("encodes ordinary prose exactly", () => {
    const counter = createTokenCounter();
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    expect(counter.countTokens("hello world")).toBe(2);
    expect(counter.countTokens(prose)).toBe(exact(prose));
  });

  it.each([
    ["base64", randomBytes(3_000).toString("base64")],
    ["hex", randomBytes(1_500).toString("hex")],
    ["chinese", cjk.repeat(50)],
    ["emoji", "🚀🔥💰🤖".repeat(200)],
    ["minified js", 'function(a,b){return a.map(function(c){return c*b+1})};var x={k:"v"};'.repeat(30)],
  ])("never under-counts long %s runs and stays close to exact", (_label, text) => {
    const counter = createTokenCounter();
    const count = counter.countTokens(text);
    expect(count).toBeGreaterThanOrEqual(exact(text));
    expect(count).toBeLessThanOrEqual(Math.ceil(exact(text) * 1.25));
  });

  it("is exact on both sides of the long-run threshold", () => {
    const counter = createTokenCounter();
    for (const length of [63, 64, 65]) {
      const run = "z".repeat(length);
      expect(counter.countTokens(run)).toBe(exact(run));
    }
  });

  it("does not split surrogate pairs across chunk boundaries", () => {
    const counter = createTokenCounter();
    const text = "a" + "🤖".repeat(100);
    expect(counter.countTokens(text)).toBe(exact(text));
  });

  it("never under-counts text beyond the encoded prefix", () => {
    const counter = createTokenCounter();
    const text = "a ".repeat(30_000) + randomBytes(5_000).toString("base64");
    const count = counter.countTokens(text);
    expect(count).toBeGreaterThanOrEqual(exact(text));
    expect(count).toBeLessThanOrEqual(Buffer.byteLength(text, "utf8"));
  });

  it.each([
    ["repeated ascii", "x".repeat(500_000)],
    ["chinese", cjk.repeat(18_000).slice(0, 500_000)],
    ["63-char chunks", ("y".repeat(63) + " ").repeat(7_800)],
  ])("counts 500k chars of %s without hanging", (_label, text) => {
    const counter = createTokenCounter();
    const start = Date.now();
    const count = counter.countTokens(text);
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(count).toBeGreaterThanOrEqual(text.length / 4);
  });
});

describe("ContextManager.assembleContext", () => {
  it("assembleContext includes system prompt and never cuts it", () => {
    const manager = new ContextManager(fixedTokenCounter(10));

    const assembled = manager.assembleContext({
      systemPrompt: "SYSTEM ALWAYS",
      recentTurns: [],
      modelContextWindow: 10,
      reserveTokens: 9,
    });

    expect(assembled.messages[0]).toMatchObject({ role: "system", content: "SYSTEM ALWAYS" });
  });

  it("assembleContext includes todo.md and never cuts it", () => {
    const manager = new ContextManager(fixedTokenCounter(10));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      todoMd: "- keep this todo",
      recentTurns: [],
      modelContextWindow: 10,
      reserveTokens: 9,
    });

    expect(assembled.messages.map((message) => message.content).join("\n")).toContain("## todo.md attention");
    expect(assembled.messages.map((message) => message.content).join("\n")).toContain("keep this todo");
  });

  it("recent 3 turns are preserved", () => {
    const manager = new ContextManager(fixedTokenCounter(10));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3), makeTurn(4), makeTurn(5)],
      modelContextWindow: 40,
      reserveTokens: 0,
    });

    const text = assembled.messages.map((message) => message.content).join("\n");
    expect(text).toContain("turn-3");
    expect(text).toContain("turn-4");
    expect(text).toContain("turn-5");
  });

  it("older turns are cut first when over budget", () => {
    const manager = new ContextManager(fixedTokenCounter(10));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3), makeTurn(4), makeTurn(5), makeTurn(6)],
      modelContextWindow: 55,
      reserveTokens: 0,
    });

    const text = assembled.messages.map((message) => message.content).join("\n");

    // recent 3 always present
    expect(text).toContain("turn-4");
    expect(text).toContain("turn-5");
    expect(text).toContain("turn-6");

    // only newest "older" turn can fit
    expect(text).toContain("turn-3");
    expect(text).not.toContain("turn-1");
    expect(text).not.toContain("turn-2");
  });

  it("includes task spec when budget allows", () => {
    const manager = new ContextManager(fixedTokenCounter(5));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      taskSpec: "do the thing",
      recentTurns: [],
      modelContextWindow: 100,
      reserveTokens: 0,
    });

    expect(assembled.messages.some((message) => message.content.includes("Current task specification"))).toBe(true);
  });

  it("drops task spec when budget is exhausted", () => {
    const manager = new ContextManager(fixedTokenCounter(20));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      taskSpec: "do the thing",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      modelContextWindow: 60,
      reserveTokens: 20,
    });

    expect(assembled.messages.some((message) => message.content.includes("Current task specification"))).toBe(false);
  });

  it("includes retrieved memories when budget allows", () => {
    const manager = new ContextManager(fixedTokenCounter(5));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      memories: "memory line",
      recentTurns: [],
      modelContextWindow: 100,
      reserveTokens: 0,
    });

    expect(assembled.messages.some((message) => message.content.includes("Retrieved memories"))).toBe(true);
  });

  it("drops retrieved memories when no budget remains", () => {
    const manager = new ContextManager(fixedTokenCounter(20));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      memories: "memory line",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      modelContextWindow: 60,
      reserveTokens: 20,
    });

    expect(assembled.messages.some((message) => message.content.includes("Retrieved memories"))).toBe(false);
  });

  it("event messages are added after turns", () => {
    const manager = new ContextManager(fixedTokenCounter(5));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      events: [makeEvent(1), makeEvent(2)],
      modelContextWindow: 200,
      reserveTokens: 0,
    });

    const contents = assembled.messages.map((message) => message.content);
    const eventIndex = contents.findIndex((content) => content.includes("[event]"));
    const turnIndex = contents.findIndex((content) => content.includes("turn-1"));

    expect(eventIndex).toBeGreaterThan(turnIndex);
  });

  it("event selection keeps newest events under budget", () => {
    const manager = new ContextManager(fixedTokenCounter(10));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      events: [makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4)],
      modelContextWindow: 70,
      reserveTokens: 0,
    });

    const text = assembled.messages.map((message) => message.content).join("\n");
    expect(text).toContain("id=evt-4");
    expect(text).toContain("id=evt-3");
    expect(text).not.toContain("id=evt-1");
  });

  it("getUtilization returns last utilization snapshot", () => {
    const manager = new ContextManager(fixedTokenCounter(10));
    manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      modelContextWindow: 100,
      reserveTokens: 20,
    });

    const utilization = manager.getUtilization();
    expect(utilization.totalTokens).toBe(100);
    expect(utilization.usedTokens).toBeGreaterThan(0);
  });

  it("getUtilization computes percentages correctly", () => {
    const manager = new ContextManager(fixedTokenCounter(10));
    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      modelContextWindow: 100,
      reserveTokens: 20,
    });

    expect(assembled.utilization.utilizationPercent).toBeCloseTo(50, 0);
  });

  it("recommendation is 'ok' under compression trigger", () => {
    const manager = new ContextManager(fixedTokenCounter(5));
    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      modelContextWindow: 200,
      reserveTokens: 20,
    });

    expect(assembled.utilization.recommendation).toBe("ok");
  });

  it("recommendation is 'compress' near high utilization", () => {
    const manager = new ContextManager(fixedTokenCounter(15));
    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3), makeTurn(4), makeTurn(5), makeTurn(6)],
      modelContextWindow: 100,
      reserveTokens: 10,
    });

    expect(assembled.utilization.recommendation).toBe("compress");
  });

  it("recommendation is 'emergency' when used exceeds prompt capacity", () => {
    const manager = new ContextManager(fixedTokenCounter(15));
    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      todoMd: "todo",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      modelContextWindow: 80,
      reserveTokens: 40,
    });

    expect(assembled.utilization.recommendation).toBe("emergency");
  });

  it("budget fields include expected sections", () => {
    const manager = new ContextManager(fixedTokenCounter(10));
    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      todoMd: "todo",
      memories: "mem",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      events: [makeEvent(1)],
      modelContextWindow: 200,
      reserveTokens: 20,
    });

    expect(assembled.budget.totalTokens).toBe(200);
    expect(assembled.budget.reserveTokens).toBe(20);
    expect(assembled.budget.systemPromptTokens).toBeGreaterThan(0);
    expect(assembled.budget.todoTokens).toBeGreaterThan(0);
    expect(assembled.budget.turnTokens).toBeGreaterThan(0);
  });

  it("passes through chat-message shaped turns", () => {
    const manager = new ContextManager(fixedTokenCounter(5));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [{ role: "assistant", content: "direct-message" }],
      modelContextWindow: 100,
      reserveTokens: 0,
    });

    expect(assembled.messages.some((message) => message.content === "direct-message")).toBe(true);
  });

  it("truncates oversized tool results in rendered turns", () => {
    const manager = new ContextManager(fixedTokenCounter(5));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [
        {
          thinking: "plan",
          toolCalls: [
            {
              id: "tc-1",
              name: "search",
              arguments: {},
              result: "x".repeat(10_500),
            },
          ],
        },
      ],
      modelContextWindow: 200,
      reserveTokens: 0,
    });

    const toolMessage = assembled.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("[TRUNCATED:");
  });
});

describe("ContextManager.compact", () => {
  it("compact produces references with IDs", () => {
    const manager = new ContextManager(fixedTokenCounter(5));
    const compacted = manager.compact([
      makeEvent(1, { tokenCount: 50, content: "A long event body" }),
      makeEvent(2, { tokenCount: 40, content: "Another event body" }),
    ]);

    expect(compacted.events).toHaveLength(2);
    expect(compacted.events[0].reference).toContain("id=evt-1");
    expect(compacted.events[1].reference).toContain("id=evt-2");
  });

  it("compact returns aggregate token metrics", () => {
    const manager = new ContextManager(fixedTokenCounter(5));
    const compacted = manager.compact([
      makeEvent(1, { tokenCount: 50, content: "foo" }),
      makeEvent(2, { tokenCount: 30, content: "bar" }),
    ]);

    expect(compacted.originalTokens).toBe(80);
    expect(compacted.compactedTokens).toBeGreaterThan(0);
    expect(compacted.compressionRatio).toBeGreaterThan(0);
  });

  it("compact falls back to token counter when tokenCount is 0", () => {
    const counter: TokenCounter = {
      cache: new Map<string, number>(),
      countTokens: () => 7,
      countBatch: (texts: string[]) => texts.map(() => 7),
    };

    const manager = new ContextManager(counter);
    const compacted = manager.compact([
      makeEvent(1, { tokenCount: 0, content: "abc" }),
    ]);

    expect(compacted.events[0].originalTokens).toBe(7);
  });
});
