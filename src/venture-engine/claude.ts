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
 */

import Anthropic from "@anthropic-ai/sdk";
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
    const vars = anthropicEnvVars();
    if (vars.length) throw new Error(`refusing a paid client while ${vars.join(", ")} is set (it could redirect the key or change billing); unset it`);
    const client = new Anthropic({ apiKey: o.apiKey, baseURL: API_BASE_URL, maxRetries: 0, timeout: o.timeoutMs, logLevel: "off" });
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
      o.ledger.unknown(id, `request failed after it may have been sent: ${(e as Error).name}`); // full reservation stays counted
      throw new Error(`Claude request failed (${(e as Error).name}); its maximum cost stays counted in the ledger`);
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
