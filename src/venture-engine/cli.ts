/**
 * Command line (run as the operator over SSH):
 *   run [cycles]                 run 1..N cycles now (offline; no external actions); refused while stopped
 *   scheduled-run                one cycle, only if schedule.enabled is set and the daily cycle budget allows
 *   stop [reason] | resume       the STOP switch: no cycle runs while it is set (a running run ends after its cycle)
 *   status | show <venture> | approvals | approve <id> | deny <id>
 *   record <venture> --source "<where from>" [--visitors N] [--signups N] [--sales N] [--revenue X] [--cost X]
 *   dashboard | config | schedule-unit (prints a systemd user timer for the owner to review and install; installs nothing)
 * Configuration: ~/.automaton-ventures/config.json (created with safe defaults: no model, schedule disabled).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, parseConfig, resume, stop, stopReason, withLock, type EngineConfig } from "./control.js";
import { renderDashboard, totals } from "./dashboard.js";
import { decideApproval, recordActual, runEngine, type EngineOptions } from "./engine.js";
import { digitalProduct } from "./kinds/digital-product.js";
import { loopbackUrl, ollamaModel, type FetchFn, type ModelClient } from "./model.js";
import { Store } from "./store.js";
import type { Evidence, VentureKind } from "./types.js";

export const KINDS: readonly VentureKind[] = [digitalProduct];
export const dataDir = (home = os.homedir()) => path.join(home, ".automaton-ventures");
const USAGE = "Usage: run [cycles] | scheduled-run | stop [reason] | resume | status | show <venture> | approvals | approve <id> | deny <id> | record <venture> --source <text> [--visitors N --signups N --sales N --revenue X --cost X] | dashboard | config | schedule-unit";

export interface CliDeps { readonly home?: string; readonly out: (s: string) => void; readonly now?: () => Date; readonly model?: ModelClient | null; readonly fetchFn?: FetchFn }

function loadConfig(store: Store): EngineConfig {
  const file = path.join(store.dir, "config.json");
  let raw: string | null = null;
  try { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw new Error("config.json must be a regular file"); raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (raw === null) { fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", { mode: 0o600, flag: "wx" }); return DEFAULT_CONFIG; }
  return parseConfig(raw);
}

function modelFor(cfg: EngineConfig, d: CliDeps): ModelClient | null {
  if (d.model !== undefined) return d.model;
  if (cfg.model.provider === "none" || cfg.model.maxCallsPerCycle === 0) return null;
  const fetchFn: FetchFn = d.fetchFn ?? ((url, init) => { loopbackUrl(url); return fetch(url, init) as unknown as ReturnType<FetchFn>; });
  return ollamaModel({ baseUrl: cfg.model.baseUrl, model: cfg.model.name, fetchFn });
}

export async function main(argv: readonly string[], d: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const now = d.now ?? (() => new Date());
  try {
    const store = new Store(dataDir(d.home));
    const cfg = loadConfig(store);
    const opts = (extra: Partial<EngineOptions> = {}): EngineOptions => ({ store, kinds: KINDS, now, limits: cfg.limits, model: modelFor(cfg, d), maxModelCallsPerCycle: cfg.model.maxCallsPerCycle, ...extra });
    const print = (rs: Awaited<ReturnType<typeof runEngine>>) => {
      for (const r of rs) {
        d.out(`cycle ${r.cycle}: ${r.created.length} new venture(s), ${r.iterations} experiment(s), ${r.modelCalls} model call(s), ${r.approvalsRequested.length} approval request(s)\n`);
        for (const x of r.decisions) d.out(`  ${x.venture} ${x.kind} [${x.basis}] ${x.reason}\n`);
      }
    };
    if (cmd === "run") {
      const n = rest[0] === undefined ? 1 : Number(rest[0]);
      const rs = await withLock(store.dir, () => runEngine(opts(), n));
      print(rs);
      if (rs.length < n) d.out(`stopped after ${rs.length} cycle(s): ${stopReason(store.dir)}\n`);
      return 0;
    }
    if (cmd === "scheduled-run") {
      if (!cfg.schedule.enabled) { d.out("schedule is disabled (config.json schedule.enabled); nothing was run\n"); return 0; }
      const why = stopReason(store.dir);
      if (why) { d.out(`stopped (${why}); nothing was run\n`); return 0; }
      print(await withLock(store.dir, () => runEngine(opts({ maxCyclesPerDay: cfg.schedule.maxCyclesPerDay }), 1)));
      return 0;
    }
    if (cmd === "stop") { stop(store.dir, rest.join(" ") || "stopped by the owner", now()); store.audit({ kind: "stop", reason: rest.join(" ") }, now()); d.out("STOP set: no cycle will run until 'resume'\n"); return 0; }
    if (cmd === "resume") { const was = resume(store.dir); store.audit({ kind: "resume" }, now()); d.out(was ? "resumed\n" : "was not stopped\n"); return 0; }
    if (cmd === "config") { d.out(JSON.stringify(cfg, null, 2) + `\nstopped: ${stopReason(store.dir) ?? "no"}\n`); return 0; }
    if (cmd === "schedule-unit") {
      d.out(`# Review, then install yourself as your own user (not root). It does nothing unless config.json has schedule.enabled = true.
# ~/.config/systemd/user/automaton-ventures.service
[Unit]
Description=Automaton venture engine: one cycle
[Service]
Type=oneshot
ExecStart=/usr/bin/env node %h/automaton/dist/venture-engine/main.js scheduled-run
NoNewPrivileges=yes
PrivateTmp=yes
# ~/.config/systemd/user/automaton-ventures.timer
[Unit]
Description=Automaton venture engine schedule
[Timer]
OnCalendar=*-*-* 00/4:17:00
Persistent=true
[Install]
WantedBy=timers.target
`);
      return 0;
    }
    if (cmd === "status") {
      const t = totals(store.ventures(), store.approvals());
      d.out(`${t.ventures} ventures (${t.active} active, ${t.launched} launched); ${t.pendingApprovals} pending approval(s); stopped: ${stopReason(store.dir) ?? "no"}\nactual results (owner-recorded): revenue $${t.actualRevenueUsd}, cost $${t.actualCostUsd}\n`);
      for (const v of store.ventures()) d.out(`  ${v.id} ${v.status.padEnd(26)} ${v.experiments.length} it.  q=${v.experiments.at(-1)?.evidence.find((e) => e.kind === "simulated")?.metrics.qualityScore ?? "-"}  ${v.decisions.at(-1)?.kind ?? "-"} [${v.decisions.at(-1)?.basis ?? "-"}]  ${v.opportunity.title}\n`);
      return 0;
    }
    if (cmd === "show") {
      const v = store.ventures().find((x) => x.id === rest[0]);
      if (!v) { d.out("no such venture\n"); return 1; }
      d.out(JSON.stringify(v, null, 2) + `\nassets: ${path.join(store.dir, "ventures", v.id)}\n`);
      return 0;
    }
    if (cmd === "approvals") {
      const p = store.approvals().filter((a) => a.status === "pending");
      d.out(p.length ? p.map((a) => `${a.id} ${a.action}: ${a.summary}`).join("\n") + "\n" : "No pending approval requests.\n");
      return 0;
    }
    if (cmd === "approve" || cmd === "deny") {
      const a = decideApproval(store, String(rest[0]), cmd === "approve", now());
      d.out(`${a.id} ${a.status}. ${a.action === "launch-public" && a.status === "approved" ? "The engine does not publish anything itself: publish the assets yourself, then record real results with 'record'." : ""}\n`);
      return 0;
    }
    if (cmd === "record") {
      const [id, ...flags] = rest;
      const m: Record<string, number> = {}; let source = "";
      const keys: Record<string, keyof Evidence["metrics"]> = { "--visitors": "visitors", "--signups": "signups", "--sales": "sales", "--revenue": "revenueUsd", "--cost": "costUsd" };
      for (let i = 0; i < flags.length; i += 2) {
        const f = flags[i], val = flags[i + 1];
        if (val === undefined) throw new Error(`${f} needs a value`);
        if (f === "--source") source = val; else if (keys[f]) m[keys[f]] = Number(val); else throw new Error(`unknown option ${f}`);
      }
      const ev = recordActual(store, String(id), m, source, now());
      d.out(`recorded actual evidence ${ev.id} for ${id}; it is used at the next cycle\n`);
      return 0;
    }
    if (cmd === "dashboard") {
      const file = path.join(store.dir, "dashboard.html");
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, renderDashboard(store.ventures(), store.approvals(), now()), { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
      d.out(`${file}\n`);
      return 0;
    }
    d.out(`${USAGE}\n`);
    return 2;
  } catch (e) {
    d.out(`error: ${(e as Error).message}\n`);
    return 1;
  }
}
