/**
 * Operating controls: configuration within hard caps, the STOP switch, a single-run lock, and a daily cycle budget.
 * Scheduled execution is only possible when the owner sets schedule.enabled; the engine never installs a schedule.
 */

import fs from "node:fs";
import path from "node:path";
import type { Limits } from "./types.js";

/** Absolute ceilings: configuration can lower these, never raise them. */
export const HARD_LIMITS: Readonly<Limits & { maxModelCallsPerCycle: number; maxCyclesPerDay: number }> = Object.freeze({
  maxActiveVentures: 20, maxNewVenturesPerCycle: 5, maxIterationsPerVenture: 5, maxCyclesPerRun: 10, spendLimitUsd: 0, maxModelCallsPerCycle: 40, maxCyclesPerDay: 48,
});

export interface EngineConfig {
  readonly version: 1;
  readonly limits: Limits;
  readonly model: { readonly provider: "none" | "ollama"; readonly baseUrl: string; readonly name: string; readonly maxCallsPerCycle: number };
  readonly schedule: { readonly enabled: boolean; readonly maxCyclesPerDay: number };
}

export const DEFAULT_CONFIG: EngineConfig = Object.freeze(<EngineConfig>{
  version: 1,
  limits: { maxActiveVentures: 5, maxNewVenturesPerCycle: 2, maxIterationsPerVenture: 3, maxCyclesPerRun: 10, spendLimitUsd: 0 },
  model: { provider: "none", baseUrl: "http://127.0.0.1:11434", name: "qwen2.5:7b", maxCallsPerCycle: 12 },
  schedule: { enabled: false, maxCyclesPerDay: 6 },
});

export function parseConfig(raw: string): EngineConfig {
  let c: any; try { c = JSON.parse(raw); } catch { throw new Error("config.json: not valid JSON"); }
  const p: string[] = [];
  const int = (v: unknown, lo: number, hi: number, name: string) => { if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) p.push(`${name} must be a whole number from ${lo} to ${hi}`); };
  const keys = (o: any, allowed: string[], name: string) => { if (!o || typeof o !== "object" || Array.isArray(o)) { p.push(`${name} must be an object`); return false; } for (const k of Object.keys(o)) if (!allowed.includes(k)) p.push(`${name}: unknown key ${k}`); return true; };
  if (keys(c, ["version", "limits", "model", "schedule"], "config") && c.version !== 1) p.push("version must be 1");
  if (keys(c?.limits, ["maxActiveVentures", "maxNewVenturesPerCycle", "maxIterationsPerVenture", "maxCyclesPerRun", "spendLimitUsd"], "limits")) {
    int(c.limits.maxActiveVentures, 1, HARD_LIMITS.maxActiveVentures, "limits.maxActiveVentures");
    int(c.limits.maxNewVenturesPerCycle, 0, HARD_LIMITS.maxNewVenturesPerCycle, "limits.maxNewVenturesPerCycle");
    int(c.limits.maxIterationsPerVenture, 1, HARD_LIMITS.maxIterationsPerVenture, "limits.maxIterationsPerVenture");
    int(c.limits.maxCyclesPerRun, 1, HARD_LIMITS.maxCyclesPerRun, "limits.maxCyclesPerRun");
    if (c.limits.spendLimitUsd !== 0) p.push("limits.spendLimitUsd must be 0 (spending is not supported)");
  }
  if (keys(c?.model, ["provider", "baseUrl", "name", "maxCallsPerCycle"], "model")) {
    if (!["none", "ollama"].includes(c.model.provider)) p.push('model.provider must be "none" or "ollama" (a paid provider needs separate approval)');
    if (typeof c.model.baseUrl !== "string" || typeof c.model.name !== "string") p.push("model.baseUrl and model.name must be text");
    int(c.model.maxCallsPerCycle, 0, HARD_LIMITS.maxModelCallsPerCycle, "model.maxCallsPerCycle");
  }
  if (keys(c?.schedule, ["enabled", "maxCyclesPerDay"], "schedule")) {
    if (typeof c.schedule.enabled !== "boolean") p.push("schedule.enabled must be true or false");
    int(c.schedule.maxCyclesPerDay, 1, HARD_LIMITS.maxCyclesPerDay, "schedule.maxCyclesPerDay");
  }
  if (p.length) throw new Error(`config.json: ${p.join("; ")}`);
  return c as EngineConfig;
}

export const stopFile = (dir: string) => path.join(dir, "STOP");
export function stopReason(dir: string): string | null { try { return fs.readFileSync(stopFile(dir), "utf8").trim() || "stopped"; } catch { return null; } }
export function stop(dir: string, reason: string, now: Date): void {
  fs.writeFileSync(stopFile(dir), `${now.toISOString()} ${reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 200)}\n`, { mode: 0o600 });
}
export function resume(dir: string): boolean { try { fs.unlinkSync(stopFile(dir)); return true; } catch { return false; } }

/** One run at a time: an exclusive lock file holding the pid; a lock left by a dead process is replaced. */
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const file = path.join(dir, "run.lock");
  const take = () => { const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); };
  try { take(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(fs.readFileSync(file, "utf8"));
    let alive = false; try { if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
    if (alive) throw new Error(`another run is in progress (pid ${pid})`);
    fs.unlinkSync(file); take();
  }
  try { return await fn(); } finally { try { fs.unlinkSync(file); } catch { /* already gone */ } }
}
