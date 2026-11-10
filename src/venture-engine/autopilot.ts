/**
 * Autopilot: one bounded, offline daily workflow that prepares work for the owner and stops at review.
 *
 *   operations autopilot   1. recover at most one failed AI run from its SAVED model answers (local, no model call)
 *                          2. prepare at most one new offline product draft (ZIP, listing, marketing) when the review
 *                             backlog is small and nothing was prepared today
 *                          3. run the daily checks and write the report and the owner dashboard
 *
 * It never calls a model (free or paid), never retries, never approves, publishes, schedules, lists, sends or
 * spends, and does nothing but report while STOP is set. Everything it prepares stays in review until the owner
 * signs it off. It is not scheduled: the existing 08:00 timer still runs only 'operations daily'.
 */

import { type EngineConfig } from "./control.js";
import { recoverable, recoverRun, runFactory } from "./factory.js";
import { londonDate, renderReport, runDaily, type DailyReport, type Item } from "./operations.js";
import { stopReason, withLock } from "./control.js";
import type { Store } from "./store.js";

/** New drafts are prepared only while fewer than this many factory products wait for the owner's review. */
export const REVIEW_BACKLOG_LIMIT = 2;

export interface AutopilotResult { readonly completed: string[]; readonly skipped: string[]; readonly unresolved: Item[]; readonly report: DailyReport; readonly files: string[] }

export function runAutopilot(store: Store, cfg: EngineConfig, now: Date): AutopilotResult {
  const completed: string[] = [], skipped: string[] = [], unresolved: Item[] = [];
  const stopped = stopReason(store.dir);
  if (stopped) skipped.push(`all preparation: STOP is set (${stopped})`);
  else {
    // 1. Local recovery of saved AI output (free: no model call).
    const todo = recoverable(store);
    if (!todo.length) skipped.push("recovery: no failed AI run with saved answers");
    else {
      const old = todo[0];
      try { const { run } = recoverRun(store, now, old.id); completed.push(`recovered ${old.id} from its saved answers as ${run.id} (${run.status}, product ${run.productId}); no model call`); }
      catch (e) { unresolved.push({ priority: 2, ref: old.id, text: `could not recover locally: ${(e as Error).message.slice(0, 240)}`, command: `factory show ${old.id}` }); }
      if (todo.length > 1) skipped.push(`recovery: ${todo.length - 1} more run(s) left for tomorrow (one per run)`);
    }
    // 2. At most one offline draft, only when the owner is not already behind on reviews.
    const products = store.products();
    const waiting = store.factoryRuns().filter((r) => r.productId && products.some((p) => p.id === r.productId && p.status === "ready" && !p.signOff)).length;
    const today = londonDate(now);
    if (waiting >= REVIEW_BACKLOG_LIMIT) skipped.push(`new product draft: ${waiting} factory product(s) already wait for your review (limit ${REVIEW_BACKLOG_LIMIT})`);
    else if (store.factoryRuns().some((r) => r.date === today && (r.mode ?? "offline-template") === "offline-template")) skipped.push("new product draft: one was already prepared today");
    else {
      let run: ReturnType<typeof runFactory>["run"] | null = null;
      try { run = runFactory(store, cfg, now, { offline: true }).run; }
      catch (e) { unresolved.push({ priority: 2, ref: "factory", text: `offline product draft failed: ${(e as Error).message.slice(0, 240)}` }); }
      if (!run) { /* reported above */ }
      else if (run.status === "no-eligible-concept") skipped.push("new product draft: no eligible offline concept left (AI ideas need your approval to run)");
      else completed.push(`prepared offline product draft ${run.productId} (${run.concept}) with ZIP, listing and marketing drafts: ${run.status}`);
      if (run?.status === "needs-repair") unresolved.push({ priority: 2, ref: run.id, text: `new draft needs repair: ${run.failedChecks.join(", ")}`, command: `factory show ${run.id}` });
    }
  }
  const { report, files } = runDaily(store, cfg, now, { completed: completed.map((c) => `autopilot: ${c}`), problems: unresolved });
  store.audit({ kind: "operations-autopilot", date: report.date, completed: completed.length, skipped: skipped.length, unresolved: unresolved.length }, now);
  return { completed, skipped, unresolved, report, files };
}

export async function autopilotCli(args: readonly string[], ctx: { store: Store; cfg: EngineConfig; out: (s: string) => void; now: () => Date }): Promise<number> {
  if (args.length) throw new Error("operations autopilot (no options)");
  const r = await withLock(ctx.store.dir, async () => runAutopilot(ctx.store, ctx.cfg, ctx.now()));
  ctx.out(`AUTOPILOT ${r.report.date}\n${r.report.summary}\n\nCompleted by Automaton:\n${r.completed.map((c) => `  - ${c}`).join("\n") || "  - nothing new"}\nSkipped:\n${r.skipped.map((c) => `  - ${c}`).join("\n") || "  - nothing"}\n` +
    `Needs you next: ${r.report.nextAction ? `${r.report.nextAction.text}${r.report.nextAction.command ? ` (${r.report.nextAction.command})` : ""}` : "nothing"}\n\n${renderReport(r.report)}\nSaved: ${r.files.join(", ")}\n`);
  return r.report.status === "ok" && !r.unresolved.length ? 0 : 1;
}
