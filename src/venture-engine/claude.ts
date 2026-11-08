/**
 * Claude adapter (official Anthropic SDK, pinned). Paid: every request is bounded and reserved in the local ledger
 * BEFORE it is sent, and the adapter refuses whatever it cannot bound.
 *
 *  - Models: only those in PRICES_USD_PER_MTOK (unknown model -> refused: its cost cannot be bounded).
 *  - Maximum cost = (input bound x input price + max_tokens x output price), converted with a conservative
 *    USD->GBP rate and a tax multiplier. The input bound is the request's UTF-8 byte count plus overhead: a token is
 *    never shorter than one byte, so this over-estimates. max_tokens bounds all output, including thinking.
 *  - No retries (each retry could be billed), a hard timeout, no tools, no prompt caching, no fallbacks, no
 *    server-side features: one plain message per request.
 *  - Errors after sending keep the full reservation counted (the provider may have billed it).
 *  - Only a final, complete answer is accepted (stop_reason "end_turn"); refusals, truncation and anything else fail.
 *  - One request at a time; after any failed or ambiguous request the client refuses every further request (the
 *    whole run, not only the cycle).
 *  - The SDK client is pinned to api.anthropic.com, logging off, and refuses to start while ANTHROPIC_* variables are set.
 *  - The API key comes from a private key file; it is never logged or written anywhere else.
 *  - Failures are reported as HTTP status, Anthropic error type, request id and a sanitised explanation; headers,
 *    request contents and anything shaped like a key are never included.
 */

import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { Ledger, LedgerRefused, PRICES_USD_PER_MTOK, TAX_MULTIPLIER, USD_TO_GBP } from "./ledger.js";
import type { ModelClient } from "./model.js";

export const MAX_OUTPUT_TOKENS = 4000;
/** Generous allowance for tokens the API adds around the text (formatting, thinking set-up); costs < $0.005 per request on Opus. */
export const REQUEST_OVERHEAD_TOKENS = 1024;
export const API_BASE_URL = "https://api.anthropic.com";

/** The SDK reads ANTHROPIC_* variables (base URL, extra headers, profiles, telemetry). Any of them could redirect the key or change billing, so a paid client refuses to start while one is set. */
export function anthropicEnvVars(env: NodeJS.ProcessEnv = process.env): string[] { return Object.keys(env).filter((k) => k.toUpperCase().startsWith("ANTHROPIC_")).sort(); }

export interface CreateMessage {
  (params: { model: string; max_tokens: number; system: string; messages: { role: "user"; content: string }[]; output_config: { effort: "low" } }, opts: { timeout: number; maxRetries: number }): Promise<{
    content: { type: string; text?: string }[]; stop_reason: string | null; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
  }>;
}

export interface ClaudeOptions {
  readonly model: string; readonly apiKey: string; readonly ledger: Ledger; readonly maxOutputTokens: number; readonly timeoutMs: number;
  readonly now: () => Date;
  readonly session?: { readonly startCommittedGbp: number; readonly capGbp: number };
  /** Tests inject a fake; the default is the SDK. */
  readonly createMessage?: CreateMessage;
  /** Tests only: the real SDK client with this fetch instead of the network. */
  readonly fetchForTests?: typeof fetch;
}

/** The one place the SDK client is built: pinned host, no retries, logging off, no ANTHROPIC_* overrides. */
function sdkClient(apiKey: string, timeoutMs: number, fetchForTests?: typeof fetch): Anthropic {
  const vars = anthropicEnvVars();
  if (vars.length) throw new Error(`refusing a paid client while ${vars.join(", ")} is set (it could redirect the key or change billing); unset it`);
  return new Anthropic({ apiKey, baseURL: API_BASE_URL, maxRetries: 0, timeout: timeoutMs, logLevel: "off", ...(fetchForTests ? { fetch: fetchForTests } : {}) });
}

export interface ApiFailure { readonly status: number | null; readonly type: string; readonly requestId: string | null; readonly detail: string; readonly hint: string; readonly rejected: boolean }

const scrub = (s: string, apiKey?: string) => {
  let t = s;
  if (apiKey && apiKey.length >= 8) t = t.split(apiKey).join("[redacted]");
  return t.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
};

/**
 * Turns an SDK (or other) error into a safe description. Note: the SDK's error classes do not set Error.name, so
 * every API failure used to be logged as just "Error". `rejected` means the API answered with an error status
 * (normally not billed); the local ledger still keeps the full reservation counted.
 */
export function describeApiFailure(e: unknown, ctx: { model: string; timeoutMs: number; apiKey?: string }): ApiFailure {
  if (e instanceof APIConnectionTimeoutError) return { status: null, type: "timeout", requestId: null, detail: "", hint: `no answer within ${Math.round(ctx.timeoutMs / 1000)} s; the request may still have been processed`, rejected: false };
  if (e instanceof APIUserAbortError) return { status: null, type: "aborted", requestId: null, detail: "", hint: "the request was aborted", rejected: false };
  if (e instanceof APIConnectionError) {
    const c = (e as { cause?: { code?: unknown; cause?: { code?: unknown } } }).cause;
    const code = [c?.code, c?.cause?.code].find((x): x is string => typeof x === "string" && /^[A-Z0-9_]{2,40}$/.test(x)) ?? "unknown";
    return { status: null, type: "network_error", requestId: null, detail: code, hint: `could not reach ${API_BASE_URL} (${code}): check the VPS's outbound HTTPS, DNS and firewall`, rejected: false };
  }
  if (e instanceof APIError) {
    const status = typeof e.status === "number" ? e.status : null;
    const body = (e.error ?? {}) as { error?: { type?: unknown; message?: unknown; details?: { error_code?: unknown } } };
    const type = typeof e.type === "string" ? e.type : typeof body.error?.type === "string" ? body.error.type : "unknown";
    const detail = typeof body.error?.message === "string" ? scrub(body.error.message, ctx.apiKey) : "";
    const requestId = typeof e.requestID === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(e.requestID) ? e.requestID : null;
    const code = typeof body.error?.details?.error_code === "string" ? body.error.details.error_code : "";
    const hint =
      status === 401 ? "the API key was rejected: check anthropic.key holds the whole key, that the key is active, and that it belongs to the workspace with the spend limit"
      : status === 403 ? "this key's organisation or workspace may not use this model or operation (see the message)"
      : status === 404 ? `model "${ctx.model}" is not available to this account, or the ID is wrong`
      : status === 400 && /credit balance/i.test(detail) ? "insufficient credit: add prepaid credit in Console > Billing"
      : status === 400 && /usage limits/i.test(detail) ? "a Console spend limit has been reached"
      : status === 400 ? "the API rejected the request as invalid (see the message)"
      : status === 413 ? "the request was too large"
      : status === 429 && code === "enforced_spend_limit_reached" ? "the organisation's monthly spend cap has been reached"
      : status === 429 ? "rate limited: wait and try again later"
      : status === 529 || type === "overloaded_error" ? "Anthropic is temporarily overloaded: try again later"
      : status !== null && status >= 500 ? "Anthropic server error: try again later"
      : "unexpected API response";
    return { status, type, requestId, detail, hint, rejected: status !== null && status < 500 };
  }
  const name = e instanceof Error ? e.constructor.name : typeof e;
  return { status: null, type: "client_error", requestId: null, detail: e instanceof Error ? scrub(e.message, ctx.apiKey) : "", hint: `unexpected ${name} before or while sending`, rejected: false };
}

export function formatApiFailure(f: ApiFailure): string {
  return [f.status !== null ? `HTTP ${f.status}` : null, f.type, f.hint, f.detail ? `message: "${f.detail}"` : null, f.requestId ? `request ${f.requestId}` : null].filter(Boolean).join("; ");
}

/** Free check (no tokens, no ledger): is the key accepted and is the model available to it? Uses GET /v1/models/{id}. */
export async function checkClaudeAccess(o: { apiKey: string; model: string; timeoutMs?: number; fetchForTests?: typeof fetch }): Promise<{ ok: boolean; text: string }> {
  if (!PRICES_USD_PER_MTOK[o.model]) return { ok: false, text: `model ${o.model}: not one of ${Object.keys(PRICES_USD_PER_MTOK).join(", ")}` };
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(o.apiKey)) return { ok: false, text: "the API key is missing or not in the expected format" };
  const timeoutMs = o.timeoutMs ?? 30_000;
  try {
    const m = await sdkClient(o.apiKey, timeoutMs, o.fetchForTests).models.retrieve(o.model, null, { timeout: timeoutMs, maxRetries: 0 });
    const id = typeof m?.id === "string" ? scrub(m.id) : "?";
    if (id !== o.model) return { ok: false, text: `the API answered for model "${id}", not "${o.model}"` };
    return { ok: true, text: `key accepted; model ${id}${typeof m.display_name === "string" ? ` (${scrub(m.display_name)})` : ""} is available to it. This check does not show the credit balance: see Console > Billing.` };
  } catch (e) {
    if (e instanceof Error && /refusing a paid client/.test(e.message)) return { ok: false, text: e.message };
    return { ok: false, text: formatApiFailure(describeApiFailure(e, { model: o.model, timeoutMs, apiKey: o.apiKey })) };
  }
}

export const toGbp = (usd: number) => usd * USD_TO_GBP * TAX_MULTIPLIER;

export function maxCostGbp(model: string, system: string, prompt: string, maxTokens: number): number {
  const p = PRICES_USD_PER_MTOK[model];
  if (!p) throw new LedgerRefused(`model ${model}: no known price, so its cost cannot be bounded`);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS) throw new LedgerRefused("max_tokens out of range: the output cost cannot be bounded");
  const inputBound = Buffer.byteLength(system, "utf8") + Buffer.byteLength(prompt, "utf8") + REQUEST_OVERHEAD_TOKENS;
  return toGbp((inputBound * p.input + maxTokens * p.output) / 1e6);
}

export function claudeModel(o: ClaudeOptions): ModelClient {
  if (!PRICES_USD_PER_MTOK[o.model]) throw new LedgerRefused(`model ${o.model}: no known price, so its cost cannot be bounded`);
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(o.apiKey)) throw new Error("the API key is missing or not in the expected format");
  if (!(o.maxOutputTokens >= 256 && o.maxOutputTokens <= MAX_OUTPUT_TOKENS)) throw new Error(`maxOutputTokens: 256 to ${MAX_OUTPUT_TOKENS}`);
  if (!(o.timeoutMs >= 10_000 && o.timeoutMs <= 300_000)) throw new Error("timeoutMs: 10000 to 300000");
  const create: CreateMessage = o.createMessage ?? (() => {
    const client = sdkClient(o.apiKey, o.timeoutMs, o.fetchForTests);
    return (params, opts) => client.messages.create(params, opts) as unknown as ReturnType<CreateMessage>;
  })();
  const price = PRICES_USD_PER_MTOK[o.model];
  let tripped: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const once = async (req: { system: string; prompt: string; maxTokens: number }): Promise<string> => {
    if (tripped) throw new Error(`no further paid requests in this run: an earlier request failed (${tripped})`);
    try { return await send(req); } catch (e) { tripped = (e as Error).message.slice(0, 80); throw e; }
  };
  const send = async (req: { system: string; prompt: string; maxTokens: number }): Promise<string> => {
    // The configured ceiling is used for every request: thinking counts towards max_tokens, and a truncated answer is wasted money.
    const maxTokens = o.maxOutputTokens;
    const id = o.ledger.reserve(maxCostGbp(o.model, req.system, req.prompt, maxTokens), { model: o.model, purpose: req.prompt.slice(0, 40), sessionStartCommittedGbp: o.session?.startCommittedGbp, sessionCapGbp: o.session?.capGbp }, o.now());
    let res: Awaited<ReturnType<CreateMessage>>;
    try {
      res = await create({ model: o.model, max_tokens: maxTokens, system: req.system, messages: [{ role: "user", content: req.prompt }], output_config: { effort: "low" } }, { timeout: o.timeoutMs, maxRetries: 0 });
    } catch (e) {
      const f = describeApiFailure(e, { model: o.model, timeoutMs: o.timeoutMs, apiKey: o.apiKey });
      const note = [f.status !== null ? `HTTP ${f.status}` : null, f.type, f.requestId].filter(Boolean).join(" ");
      // The full reservation stays counted, also when the API rejected the request (normally not billed): fail closed.
      o.ledger.unknown(id, `${f.rejected ? "rejected by the API" : "outcome unknown"}: ${note}`);
      throw new Error(`Claude request failed: ${formatApiFailure(f)}. Its maximum cost stays counted in the local ledger${f.rejected ? " (an API error response is normally not billed; check Console > Usage)" : ""}`);
    }
    const u = res?.usage;
    if (!u || !Number.isInteger(u.input_tokens) || !Number.isInteger(u.output_tokens)) { o.ledger.unknown(id, "no usage in the response"); throw new Error("Claude response without usage; maximum cost counted"); }
    const inTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0);
    o.ledger.settle(id, toGbp((inTokens * price.input + u.output_tokens * price.output) / 1e6), { inputTokens: u.input_tokens, outputTokens: u.output_tokens });
    if (res.stop_reason === "refusal") throw new Error("Claude declined the request");
    if (res.stop_reason !== "end_turn") throw new Error(`Claude answer not complete (stop_reason ${String(res.stop_reason).slice(0, 20)})`);
    if (!Array.isArray(res.content)) throw new Error("Claude response has no content");
    const out = res.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
    if (!out.trim()) throw new Error("Claude answer is empty");
    return out;
  };
  return {
    id: `claude:${o.model}`, paid: true,
    // Serialised: a second request waits until the first has finished and is refused if the first failed.
    complete(req) { const r = queue.then(() => once(req)); queue = r.catch(() => undefined); return r; },
  };
}
