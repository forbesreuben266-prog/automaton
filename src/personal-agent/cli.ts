/**
 * Command line for the personal agent (run over SSH, e.g. Termius):
 *   chat                interactive conversation (/exit, /clear, /tools)
 *   ask <text...>       one question; changes are refused because nobody can confirm them
 *   notes | tasks       list without calling the model
 *   doctor              check the configuration, folders and the local model (no model call)
 */

import fs from "node:fs";
import os from "node:os";

import readline from "node:readline";
import { runTurn } from "./agent.js";
import { dataDir, loadConfig, type AgentConfig } from "./config.js";
import { ensurePrivateDir } from "./files.js";
import { loopbackUrl, ollamaProvider, type FetchFn } from "./providers.js";
import { clearHistory, listNotes, listTasks, loadHistory, saveHistory } from "./store.js";
import { TOOLS, describeTool } from "./tools.js";
import type { ModelProvider, ToolContext } from "./types.js";

export interface CliDeps {
  readonly home?: string;
  readonly out: (s: string) => void;
  readonly provider?: ModelProvider;
  readonly fetchFn?: FetchFn;
  readonly input?: NodeJS.ReadableStream;
  readonly now?: () => Date;
}

const USAGE = "Usage: pa chat | pa ask <question> | pa notes | pa tasks | pa doctor";

function setup(d: CliDeps): { cfg: AgentConfig; ctx: ToolContext; provider: ModelProvider } {
  const home = d.home ?? os.homedir();
  const cfg = loadConfig(home);
  ensurePrivateDir(cfg.workspaceDir);
  const ctx: ToolContext = { dataDir: dataDir(home), workspaceDir: cfg.workspaceDir, researchResultsDir: cfg.researchResultsDir, now: d.now ?? (() => new Date()) };
  const provider = d.provider ?? ollamaProvider({ baseUrl: cfg.ollama.baseUrl, model: cfg.ollama.model, ...(d.fetchFn ? { fetchFn: d.fetchFn } : {}) });
  return { cfg, ctx, provider };
}

export async function main(argv: readonly string[], d: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "notes" || cmd === "tasks") {
      const { ctx } = setup(d);
      if (cmd === "notes") { const n = listNotes(ctx.dataDir); d.out(n.length ? n.map((x) => `${x.id} [${x.createdAt.slice(0, 10)}] ${x.text}`).join("\n") + "\n" : "No notes yet.\n"); }
      else { const t = listTasks(ctx.dataDir).filter((x) => !x.done); d.out(t.length ? t.map((x) => `${x.id} ${x.due ?? "no date"}  ${x.title}`).join("\n") + "\n" : "No open tasks.\n"); }
      return 0;
    }
    if (cmd === "doctor") {
      const { cfg, ctx } = setup(d);
      const s = fs.lstatSync(ctx.dataDir);
      d.out(`data folder ${ctx.dataDir}: mode ${(s.mode & 0o777).toString(8)} (private)\nworkspace ${cfg.workspaceDir}\nresearch results (read-only) ${cfg.researchResultsDir}${fs.existsSync(cfg.researchResultsDir) ? "" : " (none yet)"}\n`);
      d.out(`provider ollama at ${loopbackUrl(cfg.ollama.baseUrl).origin}, model ${cfg.ollama.model}; write confirmations ${cfg.autoApproveLocalWrites ? "auto for notes and tasks" : "always asked"}\n`);
      d.out(`tools:\n${TOOLS.map((t) => `  ${describeTool(t)}`).join("\n")}\n`);
      const f = d.fetchFn ?? ((url: string, init: any) => fetch(url, init) as any);
      try { const r = await f(new URL("/api/tags", loopbackUrl(cfg.ollama.baseUrl)).toString(), { method: "GET", headers: {}, body: undefined as unknown as string });
        const j = JSON.parse(await r.text()); const names = (j.models ?? []).map((m: any) => m.name);
        d.out(names.includes(cfg.ollama.model) ? `ok: the local model ${cfg.ollama.model} is installed\n` : `NOT READY: Ollama answers, but ${cfg.ollama.model} is not installed (have: ${names.join(", ") || "none"})\n`);
        return names.includes(cfg.ollama.model) ? 0 : 1;
      } catch { d.out("NOT READY: the local model service (Ollama) does not answer on this machine\n"); return 1; }
    }
    if (cmd === "ask") {
      const q = rest.join(" ").trim();
      if (!q) { d.out(`${USAGE}\n`); return 2; }
      const { cfg, ctx, provider } = setup(d);
      const r = await runTurn(loadHistory(ctx.dataDir), q, { provider, ctx, autoApproveLocalWrites: cfg.autoApproveLocalWrites, confirm: async () => false });
      saveHistory(ctx.dataDir, r.messages);
      d.out(`${r.text}\n`);
      return 0;
    }
    if (cmd === "chat") {
      const { cfg, ctx, provider } = setup(d);
      const rl = readline.createInterface({ input: d.input ?? process.stdin, terminal: false });
      const lines = rl[Symbol.asyncIterator]();
      const prompt = async (q: string): Promise<string | null> => { d.out(q); const n = await lines.next(); return n.done ? null : String(n.value); };
      const confirm = async (what: string) => { const a = await prompt(`  Allow ${what}? [y/N] `); return a !== null && /^y(es)?$/i.test(a.trim()); };
      d.out(`Personal agent (${provider.id}). /exit to leave, /clear to forget the conversation, /tools to list tools.\n`);
      let history = loadHistory(ctx.dataDir);
      for (;;) {
        const line = await prompt("you> ");
        if (line === null || line.trim() === "/exit") break;
        const text = line.trim();
        if (!text) continue;
        if (text === "/clear") { clearHistory(ctx.dataDir); history = []; d.out("(conversation cleared; notes and tasks are kept)\n"); continue; }
        if (text === "/tools") { d.out(TOOLS.map((t) => `  ${describeTool(t)}`).join("\n") + "\n"); continue; }
        try {
          const r = await runTurn(history, text, { provider, ctx, autoApproveLocalWrites: cfg.autoApproveLocalWrites, confirm });
          history = r.messages.filter((m) => m.role !== "tool" && !(m.role === "assistant" && m.toolCalls?.length));
          saveHistory(ctx.dataDir, history);
          d.out(`agent> ${r.text}\n`);
        } catch (e) { d.out(`agent> (error) ${(e as Error).message}\n`); }
      }
      rl.close();
      return 0;
    }
    d.out(`${USAGE}\n`);
    return 2;
  } catch (e) {
    d.out(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

