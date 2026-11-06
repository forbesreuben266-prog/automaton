/**
 * Command line (run as the operator over SSH):
 *   run [cycles]                 run 1..10 engine cycles now (offline; no external actions)
 *   status                       portfolio summary
 *   show <venture-id>            one venture: experiments, checks, evidence, decisions, asset folder
 *   approvals                    pending approval requests
 *   approve <id> | deny <id>     record the owner's decision (the owner performs any external action itself)
 *   record <venture-id> --source "<where from>" [--visitors N] [--signups N] [--sales N] [--revenue X] [--cost X]
 *                                actual results of a launched venture (the only source of actual evidence)
 *   dashboard                    write the private HTML dashboard and print its path
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderDashboard, totals } from "./dashboard.js";
import { decideApproval, recordActual, runEngine } from "./engine.js";
import { digitalProduct } from "./kinds/digital-product.js";
import { Store } from "./store.js";
import type { Evidence, VentureKind } from "./types.js";

export const KINDS: readonly VentureKind[] = [digitalProduct];
export const dataDir = (home = os.homedir()) => path.join(home, ".automaton-ventures");
const USAGE = "Usage: run [cycles] | status | show <venture> | approvals | approve <id> | deny <id> | record <venture> --source <text> [--visitors N --signups N --sales N --revenue X --cost X] | dashboard";

export async function main(argv: readonly string[], d: { home?: string; out: (s: string) => void; now?: () => Date }): Promise<number> {
  const [cmd, ...rest] = argv;
  const now = d.now ?? (() => new Date());
  try {
    const store = new Store(dataDir(d.home));
    if (cmd === "run") {
      const n = rest[0] === undefined ? 1 : Number(rest[0]);
      for (const r of runEngine({ store, kinds: KINDS, now }, n)) {
        d.out(`cycle ${r.cycle}: ${r.created.length} new venture(s), ${r.iterations} experiment(s), ${r.approvalsRequested.length} approval request(s)\n`);
        for (const x of r.decisions) d.out(`  ${x.venture} ${x.kind} [${x.basis}] ${x.reason}\n`);
      }
      return 0;
    }
    if (cmd === "status") {
      const t = totals(store.ventures(), store.approvals());
      d.out(`${t.ventures} ventures (${t.active} active, ${t.launched} launched); ${t.pendingApprovals} pending approval(s)\nactual results (owner-recorded): revenue $${t.actualRevenueUsd}, cost $${t.actualCostUsd}\n`);
      for (const v of store.ventures()) d.out(`  ${v.id} ${v.status.padEnd(26)} ${v.experiments.length} it.  ${v.decisions.at(-1)?.kind ?? "-"} [${v.decisions.at(-1)?.basis ?? "-"}]  ${v.opportunity.title}\n`);
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
