import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { anthropicEnvVars, checkClaudeAccess, claudeModel, describeApiFailure, maxCostGbp, type CreateMessage } from "../../venture-engine/claude.js";
import { main } from "../../venture-engine/cli.js";
import { DEFAULT_CONFIG, parseConfig } from "../../venture-engine/control.js";
import { HARD_CAP_GBP, Ledger, LedgerRefused, PRICES_USD_PER_MTOK } from "../../venture-engine/ledger.js";
import { askJson, ModelBudget } from "../../venture-engine/model.js";

const NOW = new Date("2026-11-08T09:00:00Z");
const KEY = "sk-ant-TESTONLY-not-a-real-key-000000000000";
let DIR = "";
let realFetch: typeof fetch;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vl-"));
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access in a test"); }) as typeof fetch; // proves no request leaves the process
});
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

type Res = Awaited<ReturnType<CreateMessage>>;
const ok = (text: string, usage = { input_tokens: 500, output_tokens: 300 }, stop = "end_turn"): Res => ({ content: [{ type: "thinking" }, { type: "text", text }], stop_reason: stop, usage });
const fake = (answer: Res | Error | (() => Res | Error)) => {
  const calls: { params: Parameters<CreateMessage>[0]; opts: Parameters<CreateMessage>[1] }[] = [];
  const fn: CreateMessage = async (params, opts) => { calls.push({ params, opts }); const a = typeof answer === "function" ? answer() : answer; if (a instanceof Error) throw a; return a; };
  return { fn, calls };
};
const client = (ledger: Ledger, create: CreateMessage, extra: Partial<Parameters<typeof claudeModel>[0]> = {}) =>
  claudeModel({ model: "claude-opus-5-5", apiKey: KEY, ledger, maxOutputTokens: 4000, timeoutMs: 60_000, now: () => NOW, createMessage: create, ...extra });
const REQ = { system: "Answer with JSON only.", prompt: "Propose 3 opportunities.", maxTokens: 1500 };

describe("local spending ledger (not provider-enforced)", () => {
  it("total cap is at most £10, fixed at creation, can be lowered and never raised", () => {
    expect(HARD_CAP_GBP).toBe(10);
    for (const bad of [0, -1, 10.01, 11, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new Ledger(DIR, bad, NOW)).toThrow(LedgerRefused);
    expect(new Ledger(DIR, 10, NOW).totals()).toMatchObject({ capGbp: 10, committedGbp: 0, remainingGbp: 10 });
    expect(new Ledger(DIR, 5, NOW).totals().capGbp).toBe(5);
    expect(() => new Ledger(DIR, 10, NOW)).toThrow(/never raised/);
    expect(fs.statSync(path.join(DIR, "ledger.json")).mode & 0o777).toBe(0o600);
  });

  it("reserves before use, refuses beyond the cap and unbounded costs, settles to actual, keeps unknown outcomes counted", () => {
    const l = new Ledger(DIR, 1, NOW);
    for (const bad of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => l.reserve(bad, { model: "m", purpose: "p" }, NOW)).toThrow(/cannot be bounded/);
    const a = l.reserve(0.6, { model: "m", purpose: "p" }, NOW);
    expect(() => l.reserve(0.5, { model: "m", purpose: "p" }, NOW)).toThrow(/budget/);
    l.settle(a, 0.1, { inputTokens: 1, outputTokens: 1 });
    expect(l.totals().committedGbp).toBe(0.1);
    const b = l.reserve(0.5, { model: "m", purpose: "p" }, NOW);
    l.unknown(b, "timeout");
    expect(l.totals()).toMatchObject({ committedGbp: 0.6, unknownGbp: 0.5, settledGbp: 0.1 });
    expect(() => l.settle(b, 0, { inputTokens: 0, outputTokens: 0 })).toThrow(/already unknown/);
    const c = l.reserve(0.3, { model: "m", purpose: "p" }, NOW);
    l.release(c, "not sent");
    expect(l.totals().committedGbp).toBe(0.6);
    expect(() => l.reserve(0.41, { model: "m", purpose: "p" }, NOW)).toThrow(/budget/);
    // a settled cost above its reservation is recorded as such (and counted in full)
    const d = l.reserve(0.1, { model: "m", purpose: "p" }, NOW);
    l.settle(d, 0.2, { inputTokens: 1, outputTokens: 1 });
    expect(l.entries().at(-1)!.note).toMatch(/EXCEEDED/);
    expect(l.totals().committedGbp).toBe(0.8);
  });

  it("session cap limits one run within the total", () => {
    const l = new Ledger(DIR, 10, NOW);
    l.settle(l.reserve(2, { model: "m", purpose: "p" }, NOW), 2, { inputTokens: 1, outputTokens: 1 });
    const s = { sessionStartCommittedGbp: 2, sessionCapGbp: 0.5 };
    l.reserve(0.4, { model: "m", purpose: "p", ...s }, NOW);
    expect(() => l.reserve(0.2, { model: "m", purpose: "p", ...s }, NOW)).toThrow(/session budget/);
  });

  it("is crash-safe: a reservation is on disk before the request and survives a restart; bad files fail closed", () => {
    const l = new Ledger(DIR, 10, NOW);
    l.reserve(3, { model: "m", purpose: "p" }, NOW); // process "crashes" here: never settled
    expect(new Ledger(DIR, 10, NOW).totals()).toMatchObject({ committedGbp: 3, unknownGbp: 3 });
    expect(fs.readdirSync(DIR).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    fs.writeFileSync(path.join(DIR, "ledger.json"), "{broken");
    expect(() => new Ledger(DIR, 10, NOW)).toThrow();
    fs.writeFileSync(path.join(DIR, "ledger.json"), JSON.stringify({ version: 1, currency: "GBP", capGbp: 50, createdAt: "", entries: [] }));
    expect(() => new Ledger(DIR, 10, NOW)).toThrow(/not a valid ledger/);
    fs.rmSync(path.join(DIR, "ledger.json"));
    fs.writeFileSync(path.join(DIR, "elsewhere.json"), "{}");
    fs.symlinkSync(path.join(DIR, "elsewhere.json"), path.join(DIR, "ledger.json"));
    expect(() => new Ledger(DIR, 10, NOW)).toThrow();
  });
});

describe("Claude adapter (no network: the SDK call is injected)", () => {
  it("maximum cost is an upper bound and refuses what it cannot bound", () => {
    expect(() => maxCostGbp("claude-unknown", "s", "p", 100)).toThrow(/cannot be bounded/);
    expect(() => maxCostGbp("claude-opus-5-5", "s", "p", 999_999)).toThrow(/cannot be bounded/);
    const max = maxCostGbp("claude-opus-5-5", REQ.system, REQ.prompt, 4000);
    // Opus: (bytes+1024) x $4/M + 4000 x $20/M, x £1/$ x 1.2 VAT
    expect(max).toBeCloseTo((((Buffer.byteLength(REQ.system) + Buffer.byteLength(REQ.prompt) + 1024) * 4 + 4000 * 20) / 1e6) * 1.2, 10);
    expect(Object.keys(PRICES_USD_PER_MTOK).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  it("refuses unknown models, bad keys and out-of-range limits at construction", () => {
    const l = new Ledger(DIR, 10, NOW); const f = fake(ok("{}"));
    expect(() => client(l, f.fn, { model: "claude-x" })).toThrow(/cannot be bounded/);
    expect(() => client(l, f.fn, { apiKey: "" })).toThrow(/API key/);
    expect(() => client(l, f.fn, { maxOutputTokens: 64_000 })).toThrow(/maxOutputTokens/);
    expect(() => client(l, f.fn, { timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it("sends one plain bounded request (no retries, timeout, no tools/temperature) and settles from usage", async () => {
    const l = new Ledger(DIR, 10, NOW); const f = fake(ok('{"a":1}'));
    expect(await client(l, f.fn).complete(REQ)).toBe('{"a":1}');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].opts).toEqual({ timeout: 60_000, maxRetries: 0 });
    expect(Object.keys(f.calls[0].params).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(f.calls[0].params).toMatchObject({ model: "claude-opus-5-5", max_tokens: 4000, output_config: { effort: "low" } });
    const e = l.entries()[0];
    expect(e.status).toBe("settled");
    expect(e.actualGbp).toBeCloseTo(((500 * 4 + 300 * 20) / 1e6) * 1.2, 4);
    expect(e.actualGbp!).toBeLessThan(e.reservedGbp);
    expect(JSON.stringify(l.entries())).not.toContain(KEY);
  });

  it("fails closed: timeout/network error keeps the full reservation; refusal, truncation, missing usage or empty answer are errors", async () => {
    const cases: [Res | Error, RegExp, string][] = [
      [Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }), /maximum cost stays counted/, "unknown"],
      [{ content: [], stop_reason: "end_turn" } as unknown as Res, /without usage/, "unknown"],
      [ok("no", undefined, "refusal"), /declined/, "settled"],
      [ok('{"a":', undefined, "max_tokens"), /not complete/, "settled"],
      [ok("   "), /empty/, "settled"],
      [{ content: null, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Res, /no content/, "settled"],
    ];
    for (const [answer, err, status] of cases) {
      const d = fs.mkdtempSync(path.join(DIR, "c-")); const l = new Ledger(d, 10, NOW);
      await expect(client(l, fake(answer).fn).complete(REQ)).rejects.toThrow(err);
      expect(l.entries()[0].status).toBe(status);
      if (status === "unknown") expect(l.totals().committedGbp).toBe(l.entries()[0].reservedGbp);
    }
  });

  it("never sends a request the budget cannot cover", async () => {
    const l = new Ledger(DIR, 0.05, NOW); const f = fake(ok("{}"));
    await expect(client(l, f.fn).complete(REQ)).rejects.toThrow(LedgerRefused);
    expect(f.calls).toHaveLength(0);
    expect(l.entries()).toHaveLength(0);
  });

  it("askJson uses a paid client only when the run approved paid usage, and stops after a paid failure", async () => {
    const l = new Ledger(DIR, 10, NOW); const log: Record<string, unknown>[] = [];
    let n = 0; const f = fake(() => (++n === 1 ? new Error("boom") : ok('{"x":1}')));
    const c = client(l, f.fn);
    const v = (x: unknown) => x as { x: number };
    expect(await askJson({ client: c, budget: new ModelBudget(5), log: (e) => log.push(e) }, "p", "q", v)).toBeNull();
    expect(f.calls).toHaveLength(0);
    expect(log.at(-1)).toMatchObject({ kind: "model-refused" });
    const use = { client: c, budget: new ModelBudget(5), log: (e: Record<string, unknown>) => log.push(e), paidApproved: true };
    expect(await askJson(use, "p", "q", v)).toBeNull(); // first paid call fails...
    expect(await askJson(use, "p", "q", v)).toBeNull(); // ...so no more paid calls this cycle
    expect(f.calls).toHaveLength(1);
  });
});

describe("hardening", () => {
  it("one paid request at a time; after a failed or ambiguous request, every later request in the run is refused", async () => {
    const l = new Ledger(DIR, 10, NOW);
    let n = 0; let inFlight = 0; let maxInFlight = 0;
    const create: CreateMessage = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; n++; if (n === 1) throw Object.assign(new Error("t"), { name: "APIConnectionTimeoutError" }); return ok("{}"); };
    const c = client(l, create);
    const rs = await Promise.allSettled([c.complete(REQ), c.complete(REQ), c.complete(REQ)]);
    expect(rs.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect((rs[1] as PromiseRejectedResult).reason.message).toMatch(/no further paid requests/);
    expect(n).toBe(1); expect(maxInFlight).toBe(1);
    expect(l.entries()).toHaveLength(1);
    expect(l.entries()[0].status).toBe("unknown");
  });

  it("the real SDK client refuses to start while any ANTHROPIC_* variable is set (base URL, headers, profiles)", () => {
    const l = new Ledger(DIR, 10, NOW);
    expect(anthropicEnvVars({ PATH: "x", ANTHROPIC_BASE_URL: "https://evil.example", anthropic_custom_headers: "a: b" })).toEqual(["ANTHROPIC_BASE_URL", "anthropic_custom_headers"]);
    const before = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://evil.example";
    try { expect(() => claudeModel({ model: "claude-haiku-5-5", apiKey: KEY, ledger: l, maxOutputTokens: 1000, timeoutMs: 60_000, now: () => NOW })).toThrow(/refusing a paid client while ANTHROPIC_BASE_URL/); }
    finally { if (before === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = before; }
    expect(l.entries()).toHaveLength(0);
  });

  it("ledger: a live lock holder blocks changes, a stale lock is replaced, and deleting ledger.json does not reset spending", () => {
    const l = new Ledger(DIR, 10, NOW);
    fs.writeFileSync(path.join(DIR, "ledger.lock"), String(process.pid)); // another live process holds it
    expect(() => l.reserve(1, { model: "m", purpose: "p" }, NOW)).toThrow(/in use by process/);
    fs.writeFileSync(path.join(DIR, "ledger.lock"), "999999999"); // dead process
    l.reserve(1, { model: "m", purpose: "p" }, NOW);
    expect(fs.existsSync(path.join(DIR, "ledger.lock"))).toBe(false);
    expect(fs.statSync(path.join(DIR, "ledger.journal")).mode & 0o777).toBe(0o600);
    fs.rmSync(path.join(DIR, "ledger.json"));
    expect(() => new Ledger(DIR, 10, NOW)).toThrow(/never resets itself/);
  });
});

// --- Real SDK, fake network: the exact request and the API's error responses (no request leaves the process) ---
const withoutAnthropicEnv = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(anthropicEnvVars().map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  try { return await fn(); } finally { Object.assign(process.env, saved); }
};
interface Seen { url: string; method: string; headers: Record<string, string>; body: string }
const apiFetch = (status: number, body: unknown, seen: Seen[] = []): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
  seen.push({ url: String(url), method: String(init?.method), headers: (() => { const h: Record<string, string> = {}; new Headers(init?.headers).forEach((v, k) => { h[k] = v; }); return h; })(), body: String(init?.body ?? "") });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test_0001" } });
}) as typeof fetch;
const errBody = (type: string, message: string, extra: Record<string, unknown> = {}) => ({ type: "error", error: { type, message, ...extra }, request_id: "req_test_0001" });
const OK_MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: '{"ok":1}' }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 40, output_tokens: 10 } };
const sdkClientFor = (l: Ledger, f: typeof fetch) => claudeModel({ model: "claude-haiku-5-5", apiKey: KEY, ledger: l, maxOutputTokens: 4000, timeoutMs: 60_000, now: () => NOW, fetchForTests: f });

describe("API failures are reported safely (real SDK, fake network)", () => {
  it("sends exactly the expected request: endpoint, model ID, parameters, auth header", async () => {
    const seen: Seen[] = [];
    const l = new Ledger(DIR, 10, NOW);
    expect(await withoutAnthropicEnv(() => sdkClientFor(l, apiFetch(200, OK_MESSAGE, seen)).complete(REQ))).toBe('{"ok":1}');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0].method).toBe("POST");
    expect(JSON.parse(seen[0].body)).toEqual({ model: "claude-haiku-5-5", max_tokens: 4000, system: REQ.system, messages: [{ role: "user", content: REQ.prompt }], output_config: { effort: "low" } });
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`); // SDK 1.x sends API keys as Authorization: Bearer
    expect(seen[0].headers["anthropic-version"]).toBe("2026-10-21");
    expect(l.entries()[0].status).toBe("settled");
  });

  const cases: [string, number, unknown, RegExp[]][] = [
    ["failed authentication", 401, errBody("authentication_error", "invalid x-api-key"), [/HTTP 401/, /authentication_error/, /API key was rejected/, /request req_test_0001/]],
    ["invalid model", 404, errBody("not_found_error", "model: claude-haiku-5-5"), [/HTTP 404/, /not_found_error/, /model "claude-haiku-5-5" is not available to this account/]],
    ["rate limit", 429, errBody("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"), [/HTTP 429/, /rate_limit_error/, /rate limited/]],
    ["monthly spend cap", 429, errBody("rate_limit_error", "spend cap reached", { details: { error_code: "enforced_spend_limit_reached" } }), [/HTTP 429/, /monthly spend cap/]],
    ["insufficient credits", 400, errBody("invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."), [/HTTP 400/, /invalid_request_error/, /insufficient credit/]],
    ["workspace spend limit", 400, errBody("invalid_request_error", "You have reached your specified workspace API usage limits."), [/HTTP 400/, /spend limit has been reached/]],
    ["overloaded", 529, errBody("overloaded_error", "Overloaded"), [/HTTP 529/, /overloaded/]],
  ];
  for (const [name, status, body, expected] of cases) {
    it(`${name}: HTTP status, error type and explanation; key never shown; reservation stays counted`, async () => {
      const l = new Ledger(DIR, 10, NOW);
      const err = await withoutAnthropicEnv(() => sdkClientFor(l, apiFetch(status, body)).complete(REQ).then(() => null, (e: Error) => e));
      expect(err).toBeInstanceOf(Error);
      for (const re of expected) expect(err!.message).toMatch(re);
      expect(err!.message).not.toContain(KEY);
      expect(err!.message).not.toMatch(/Bearer|x-api-key:|Propose 3 opportunities/); // no headers, no request contents
      const e = l.entries()[0];
      expect(e.status).toBe("unknown");
      expect(e.note).toMatch(new RegExp(`^${status < 500 ? "rejected by the API" : "outcome unknown"}: HTTP ${status} `));
      expect(l.totals().committedGbp).toBe(e.reservedGbp);
      expect(JSON.stringify(l.entries())).not.toContain(KEY);
    });
  }

  it("network errors name the cause; timeouts are reported as possibly processed", async () => {
    const l = new Ledger(DIR, 10, NOW);
    const down = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), { code: "ENOTFOUND" }) }); }) as typeof fetch;
    const err = await withoutAnthropicEnv(() => sdkClientFor(l, down).complete(REQ).then(() => null, (e: Error) => e));
    expect(err!.message).toMatch(/network_error/);
    expect(err!.message).toMatch(/ENOTFOUND/);
    expect(err!.message).toMatch(/outbound HTTPS/);
    expect(l.entries()[0].note).toMatch(/^outcome unknown: network_error/);
    const t = describeApiFailure(new APIConnectionTimeoutError(), { model: "claude-haiku-5-5", timeoutMs: 120_000 });
    expect(t).toMatchObject({ status: null, type: "timeout", rejected: false });
    expect(t.hint).toMatch(/120 s; the request may still have been processed/);
  });

  it("anything shaped like a key in an API message is redacted", async () => {
    const l = new Ledger(DIR, 10, NOW);
    const body = errBody("authentication_error", `invalid key ${KEY} and sk-ant-other-key-1234567890abcdefgh, Bearer abc.def`);
    const err = await withoutAnthropicEnv(() => sdkClientFor(l, apiFetch(401, body)).complete(REQ).then(() => null, (e: Error) => e));
    expect(err!.message).not.toContain(KEY);
    expect(err!.message).not.toContain("sk-ant-other");
    expect(err!.message).not.toContain("abc.def");
    expect(err!.message).toContain("[redacted]");
  });

  it("checkClaudeAccess: free model lookup; reports success, wrong key and unknown model without spending", async () => {
    const seen: Seen[] = [];
    const ok = await withoutAnthropicEnv(() => checkClaudeAccess({ apiKey: KEY, model: "claude-haiku-5-5", fetchForTests: apiFetch(200, { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-10-01T00:00:00Z" }, seen) }));
    expect(ok.ok).toBe(true); expect(ok.text).toMatch(/model claude-haiku-5-5 \(Claude Haiku 5.5\) is available/);
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/models/claude-haiku-5-5"); expect(seen[0].method).toBe("GET");
    const bad = await withoutAnthropicEnv(() => checkClaudeAccess({ apiKey: KEY, model: "claude-haiku-5-5", fetchForTests: apiFetch(401, errBody("authentication_error", "invalid x-api-key")) }));
    expect(bad).toMatchObject({ ok: false }); expect(bad.text).toMatch(/HTTP 401; authentication_error; the API key was rejected/); expect(bad.text).not.toContain(KEY);
    const missing = await withoutAnthropicEnv(() => checkClaudeAccess({ apiKey: KEY, model: "claude-haiku-5-5", fetchForTests: apiFetch(404, errBody("not_found_error", "model: claude-haiku-5-5")) }));
    expect(missing.text).toMatch(/HTTP 404; not_found_error/);
    expect((await checkClaudeAccess({ apiKey: KEY, model: "claude-haiku-5" })).text).toMatch(/not one of/);
  });

  it("CLI: the failure reason reaches the audit log and claude-check, never the key", async () => {
    const data = path.join(DIR, ".automaton-ventures");
    let out = "";
    const fetch401 = apiFetch(401, errBody("authentication_error", "invalid x-api-key"));
    const cli = (...a: string[]) => withoutAnthropicEnv(async () => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, sdkFetchForTests: fetch401 }); });
    expect(await cli("config")).toBe(0);
    const c = JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf8"));
    fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ ...c, model: { ...c.model, provider: "claude", name: "claude-haiku-5-5", maxCallsPerCycle: 3, paidUsageApproved: true, maxGbpPerRun: 0.5 } }));
    fs.writeFileSync(path.join(data, "anthropic.key"), KEY + "\n", { mode: 0o600 });
    expect(await cli("claude-check")).toBe(1); expect(out).toMatch(/claude-check FAILED: HTTP 401; authentication_error/);
    expect(await cli("run", "--paid")).toBe(0);
    const audit = fs.readFileSync(path.join(data, "audit.jsonl"), "utf8");
    expect(audit).toMatch(/"kind":"model-failed"[^\n]*HTTP 401; authentication_error; the API key was rejected/);
    expect(audit.match(/"kind":"model-failed"/g)).toHaveLength(1); // the first failure stops all further paid calls
    for (const f of fs.readdirSync(data).filter((x) => x !== "anthropic.key")) {
      const p = path.join(data, f);
      if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, "utf8"), f).not.toContain(KEY);
    }
    expect(out).not.toContain(KEY);
  });
});

describe("configuration and CLI gates", () => {
  const cfgWith = (model: Record<string, unknown>) => JSON.stringify({ ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, ...model } });
  it("config: claude needs a priced model; paid usage is off by default; limits are bounded", () => {
    expect(DEFAULT_CONFIG.model.provider).toBe("none");
    expect(DEFAULT_CONFIG.model.paidUsageApproved).toBe(false);
    expect(parseConfig(cfgWith({ provider: "claude", name: "claude-opus-5-5" })).model.provider).toBe("claude");
    expect(() => parseConfig(cfgWith({ provider: "claude", name: "qwen2.5:7b" }))).toThrow(/no known price/);
    expect(() => parseConfig(cfgWith({ maxGbpPerRun: 11 }))).toThrow(/maxGbpPerRun/);
    expect(() => parseConfig(cfgWith({ maxOutputTokens: 100_000 }))).toThrow(/maxOutputTokens/);
    expect(() => parseConfig(cfgWith({ provider: "openai" }))).toThrow(/provider/);
  });

  it("CLI: paid runs need --paid, owner approval in config and a private key file; scheduled runs never pay", async () => {
    const data = path.join(DIR, ".automaton-ventures");
    let out = "";
    const f = fake(() => new Error("no answer in this test"));
    const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, createMessage: f.fn }); };
    expect(await cli("config")).toBe(0);
    const write = (m: Record<string, unknown>, schedule = false) => fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ ...JSON.parse(cfgWith(m)), schedule: { enabled: schedule, maxCyclesPerDay: 6 } }));
    write({ provider: "claude", name: "claude-haiku-5-5", maxCallsPerCycle: 2 });
    expect(await cli("run")).toBe(1); expect(out).toMatch(/use 'run --paid'/);
    expect(await cli("run", "--paid")).toBe(1); expect(out).toMatch(/not approved/);
    write({ provider: "claude", name: "claude-haiku-5-5", maxCallsPerCycle: 2, paidUsageApproved: true }, true);
    expect(await cli("scheduled-run")).toBe(1); expect(out).toMatch(/scheduled runs never use a paid model/);
    expect(await cli("run", "--paid")).toBe(1); expect(out).toMatch(/no API key/);
    fs.writeFileSync(path.join(data, "anthropic.key"), KEY + "\n", { mode: 0o644 });
    fs.chmodSync(path.join(data, "anthropic.key"), 0o644);
    expect(await cli("run", "--paid")).toBe(1); expect(out).toMatch(/mode 600/);
    fs.chmodSync(path.join(data, "anthropic.key"), 0o600);
    expect(await cli("run", "--paid")).toBe(0);
    expect(f.calls).toHaveLength(1); // first call failed -> no further paid calls; the engine fell back
    expect(out).toMatch(/local ledger \(estimate; NOT a provider-enforced cap\)/);
    expect(out).not.toContain(KEY);
    expect(await cli("ledger")).toBe(0); expect(out).toMatch(/1 request/);
    expect(fs.readFileSync(path.join(data, "audit.jsonl"), "utf8")).not.toContain(KEY);
  });
});

vi.setConfig({ testTimeout: 20_000 });
