/**
 * Model providers. Ollama runs on this machine and is reached only through a loopback address (free, local). The fake
 * provider replays scripted replies for tests. A paid provider (e.g. Claude) is added only after the owner approves
 * paid usage; the agent loop refuses any provider marked paid unless the configuration enables it with a budget.
 */

import type { ChatMessage, ModelProvider, ModelReply, ModelRequest, ToolCall } from "./types.js";

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Only loopback hosts are accepted: the local model must never be reached over the network. */
export function loopbackUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`ollama.baseUrl: not a URL (${raw.slice(0, 60)})`); }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.username || u.password) {
    throw new Error("ollama.baseUrl: must be http://127.0.0.1:<port>, http://localhost:<port> or http://[::1]:<port> (the local model only)");
  }
  return u;
}

export function ollamaProvider(opts: { baseUrl: string; model: string; timeoutMs?: number; fetchFn?: FetchFn }): ModelProvider {
  const base = loopbackUrl(opts.baseUrl);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(opts.model)) throw new Error("ollama.model: not a model name");
  const fetchFn: FetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchFn>);
  const toOllama = (m: ChatMessage) =>
    m.role === "tool" ? { role: "tool", content: m.content, tool_name: m.name }
      : m.role === "assistant" ? { role: "assistant", content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}) }
        : { role: "user", content: m.content };
  return {
    id: `ollama:${opts.model}`,
    paid: false,
    async chat(req: ModelRequest): Promise<ModelReply> {
      const body = {
        model: opts.model, stream: false, options: { num_predict: req.maxTokens },
        messages: [{ role: "system", content: req.system }, ...req.messages.map(toOllama)],
        tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      };
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 180_000);
      let res;
      try { res = await fetchFn(new URL("/api/chat", base).toString(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }); }
      catch (e) { throw new Error(`the local model did not answer (${(e as Error).name === "AbortError" ? "timeout" : (e as Error).message.slice(0, 80)}); is Ollama running?`); }
      finally { clearTimeout(timer); }
      const text = await res.text();
      if (!res.ok) throw new Error(`the local model returned HTTP ${res.status}: ${text.slice(0, 200)}`);
      let j: any; try { j = JSON.parse(text); } catch { throw new Error("the local model returned non-JSON"); }
      const msg = j && j.message ? j.message : {};
      const calls: ToolCall[] = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).slice(0, 8).map((c: any, i: number) => ({
        id: `call_${i}`, name: String(c?.function?.name ?? ""),
        args: typeof c?.function?.arguments === "string" ? safeJson(c.function.arguments) : (c?.function?.arguments && typeof c.function.arguments === "object" ? c.function.arguments : {}),
      }));
      return { text: typeof msg.content === "string" ? msg.content : "", toolCalls: calls, usage: { inputTokens: Number(j.prompt_eval_count) || 0, outputTokens: Number(j.eval_count) || 0 } };
    },
  };
}
const safeJson = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };

/** Test double: returns the scripted replies in order and records every request. */
export function fakeProvider(replies: readonly ModelReply[], opts: { paid?: boolean } = {}): ModelProvider & { requests: ModelRequest[] } {
  let i = 0;
  const requests: ModelRequest[] = [];
  return {
    id: "fake", paid: opts.paid ?? false, requests,
    async chat(req) { requests.push(req); if (i >= replies.length) throw new Error("fake provider: no more scripted replies"); return replies[i++]; },
  };
}
