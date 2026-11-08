/**
 * Provider-independent model interface for the venture engine (ideas, plans, content, critiques).
 *
 * Every model answer is untrusted: it must be JSON, pass a validator, and fit size limits; otherwise the engine falls
 * back to its deterministic behaviour and records why. Each cycle has a call budget. Providers: "none" (no model),
 * Ollama on a loopback address (local, free), a scripted fake for tests, and the paid Claude adapter (claude.ts),
 * which is used only when the run explicitly allows paid usage (paidApproved) and its ledger has budget left.
 */

export interface ModelClient {
  readonly id: string;
  readonly paid: boolean;
  complete(req: { readonly system: string; readonly prompt: string; readonly maxTokens: number }): Promise<string>;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class ModelBudget {
  calls = 0; failures = 0;
  constructor(readonly maxCalls: number) {}
  take(): boolean { if (this.calls >= this.maxCalls) return false; this.calls += 1; return true; }
}

export interface ModelUse { readonly client: ModelClient | null; readonly budget: ModelBudget; readonly log: (entry: Record<string, unknown>) => void; readonly paidApproved?: boolean }

const SYSTEM = "You help an automated business-experiment engine. Answer with JSON only, no prose. Never invent sales, customers, revenue or testimonials. Content you write is a draft for the owner to review.";
export const MAX_ANSWER_CHARS = 60_000;

/**
 * Asks for JSON and validates it. Returns null (and logs why) when there is no model, the budget is used up, the call
 * fails, or the answer does not validate; the caller then uses its deterministic fallback.
 */
export async function askJson<T>(use: ModelUse, purpose: string, prompt: string, validate: (v: unknown) => T | null, maxTokens = 1500): Promise<T | null> {
  if (!use.client) return null;
  if (use.client.paid && use.paidApproved !== true) { use.log({ kind: "model-refused", purpose, reason: "paid provider not approved" }); return null; }
  if (!use.budget.take()) { use.log({ kind: "model-skipped", purpose, reason: "call budget for this cycle used" }); return null; }
  let text: string;
  try { text = await use.client.complete({ system: SYSTEM, prompt, maxTokens }); }
  catch (e) {
    use.budget.failures += 1;
    if (use.client.paid) use.budget.calls = use.budget.maxCalls; // fail closed: no further paid calls this cycle after any failure
    use.log({ kind: "model-failed", purpose, error: String((e as Error).message).slice(0, 600) }); return null; }
  if (text.length > MAX_ANSWER_CHARS) { use.log({ kind: "model-invalid", purpose, reason: "answer too long" }); return null; }
  const json = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let v: unknown; try { v = JSON.parse(json); } catch { use.log({ kind: "model-invalid", purpose, reason: "not JSON" }); return null; }
  const out = validate(v);
  use.log({ kind: out === null ? "model-invalid" : "model-ok", purpose, model: use.client.id, ...(out === null ? { reason: "failed validation" } : {}) });
  return out;
}

/** Plain-text field check used by validators: a non-empty string without control characters, within a length. */
export const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) ? v.trim() : null);
export const num01 = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

export function loopbackUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.username || u.password) throw new Error("model.baseUrl: only a local (loopback) model is allowed");
  return u;
}

export function ollamaModel(opts: { baseUrl: string; model: string; timeoutMs?: number; fetchFn: FetchFn }): ModelClient {
  const base = loopbackUrl(opts.baseUrl);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(opts.model)) throw new Error("model.name: not a model name");
  return {
    id: `ollama:${opts.model}`, paid: false,
    async complete(req) {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 300_000);
      try {
        const res = await opts.fetchFn(new URL("/api/chat", base).toString(), { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
          body: JSON.stringify({ model: opts.model, stream: false, format: "json", options: { num_predict: req.maxTokens }, messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }] }) });
        const t = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = JSON.parse(t);
        return typeof j?.message?.content === "string" ? j.message.content : "";
      } finally { clearTimeout(timer); }
    },
  };
}

/** Test double: answers by purpose keyword found in the prompt; records prompts. */
export function fakeModel(answers: (prompt: string) => string | Error, opts: { paid?: boolean } = {}): ModelClient & { prompts: string[] } {
  const prompts: string[] = [];
  return { id: "fake", paid: opts.paid ?? false, prompts, async complete(req) { prompts.push(req.prompt); const a = answers(req.prompt); if (a instanceof Error) throw a; return a; } };
}
