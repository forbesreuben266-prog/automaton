/** Configuration: ~/.personal-agent/config.json (private). Strict: unknown keys and wrong types are refused. */

import os from "node:os";
import path from "node:path";
import { ensurePrivateDir, readPrivate, writePrivate } from "./files.js";

export interface AgentConfig {
  readonly version: 1;
  readonly provider: "ollama";
  readonly ollama: { readonly baseUrl: string; readonly model: string };
  readonly autoApproveLocalWrites: boolean;
  readonly workspaceDir: string;
  readonly researchResultsDir: string;
}

export const dataDir = (home = os.homedir()) => path.join(home, ".personal-agent");
export const defaultConfig = (home = os.homedir()): AgentConfig => ({
  version: 1, provider: "ollama", ollama: { baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:3b" },
  autoApproveLocalWrites: false, workspaceDir: path.join(home, "agent-workspace"), researchResultsDir: path.join(home, "research-results"),
});

export function parseConfig(text: string, home = os.homedir()): AgentConfig {
  let c: any; try { c = JSON.parse(text); } catch { throw new Error("config.json: not valid JSON"); }
  const p: string[] = [];
  const allowed = ["version", "provider", "ollama", "autoApproveLocalWrites", "workspaceDir", "researchResultsDir"];
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("config.json: must be an object");
  for (const k of Object.keys(c)) if (!allowed.includes(k)) p.push(`unknown key ${k}`);
  if (c.version !== 1) p.push("version must be 1");
  if (c.provider !== "ollama") p.push('provider must be "ollama" (a paid provider is added only after it is approved)');
  if (!c.ollama || typeof c.ollama.baseUrl !== "string" || typeof c.ollama.model !== "string" || Object.keys(c.ollama).some((k) => !["baseUrl", "model"].includes(k))) p.push("ollama must be { baseUrl, model }");
  if (typeof c.autoApproveLocalWrites !== "boolean") p.push("autoApproveLocalWrites must be true or false");
  for (const k of ["workspaceDir", "researchResultsDir"]) if (typeof c[k] !== "string" || !path.isAbsolute(c[k]) || !c[k].startsWith(home + path.sep)) p.push(`${k} must be an absolute path inside your home folder`);
  if (p.length) throw new Error(`config.json: ${p.join("; ")}`);
  return c as AgentConfig;
}

/** Loads the configuration, creating the private data folder and a default config on first use. */
export function loadConfig(home = os.homedir()): AgentConfig {
  const dir = dataDir(home);
  ensurePrivateDir(dir);
  const file = path.join(dir, "config.json");
  const t = readPrivate(file, 64 * 1024);
  if (t === null) { const c = defaultConfig(home); writePrivate(file, JSON.stringify(c, null, 2) + "\n"); return c; }
  return parseConfig(t, home);
}
