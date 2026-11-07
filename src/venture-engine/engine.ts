/**
 * The engine cycle (one call = one cycle, bounded by Limits and refused while STOP is set or the daily budget is used):
 *   1. apply the owner's approval decisions;
 *   2. decide SCALE / IMPROVE / HOLD / KILL for every active venture from its latest evidence;
 *   3. run the IMPROVE iterations (plan with the last weaknesses -> build -> verify -> evaluate);
 *   4. generate, score and select new opportunities while there is room, and run their first experiment.
 *
 * Decision rules (evidence-based; simulated evidence can never produce SCALE):
 *   actual:    sales >= 1 and revenue > cost -> SCALE; >= 300 visitors and 0 signups -> KILL (needs approval:
 *              shutting down a launched venture is irreversible); >= 100 visitors and conversion < 2% -> IMPROVE;
 *              otherwise HOLD (collect more data).
 *   simulated: verified and quality >= 0.75 -> HOLD and request approval to launch; quality >= 0.5 with iterations
 *              left -> IMPROVE; otherwise KILL (an unlaunched draft is archived: reversible, no approval needed).
 * The engine never publishes, spends, contacts anyone, uses paid models or trades.
 */

import { stopReason } from "./control.js";
import { evaluate } from "./evaluate.js";
import { ModelBudget, type ModelClient, type ModelUse } from "./model.js";
import { newId, Store } from "./store.js";
import type { ApprovalAction, ApprovalRequest, Asset, Decision, DecisionKind, Evidence, Experiment, Limits, Venture, VentureKind } from "./types.js";

export const DEFAULT_LIMITS: Limits = Object.freeze({ maxActiveVentures: 5, maxNewVenturesPerCycle: 2, maxIterationsPerVenture: 3, maxCyclesPerRun: 10, spendLimitUsd: 0 });
export const MIN_OPPORTUNITY_SCORE = 0.5;
export const LAUNCH_QUALITY = 0.75;
const ACTIVE: ReadonlySet<Venture["status"]> = new Set(["draft", "built", "awaiting-launch-approval", "launched", "awaiting-shutdown-approval"]);

export interface EngineOptions {
  readonly store: Store; readonly kinds: readonly VentureKind[]; readonly limits?: Limits; readonly now?: () => Date;
  readonly model?: ModelClient | null; readonly maxModelCallsPerCycle?: number; readonly maxCyclesPerDay?: number;
}
export interface CycleReport { readonly cycle: number; readonly created: string[]; readonly decisions: { venture: string; kind: DecisionKind; basis: string; reason: string }[]; readonly approvalsRequested: string[]; iterations: number; modelCalls: number }

const latestActual = (v: Venture): Evidence | null => { for (const x of [...v.experiments].reverse()) for (const e of [...x.evidence].reverse()) if (e.kind === "actual") return e; return null; };
const latestSimulated = (v: Venture): Evidence | null => v.experiments.at(-1)?.evidence.filter((e) => e.kind === "simulated").at(-1) ?? null;

async function runExperiment(store: Store, kind: VentureKind, v: Venture, portfolio: readonly Venture[], model: ModelUse, now: Date): Promise<Experiment> {
  const iteration = v.experiments.length + 1;
  const id = newId("exp");
  const lastSim = latestSimulated(v);
  const plan = kind.plan(v.opportunity, iteration, v.experiments.at(-1)?.checks ?? [], lastSim ? (lastSim.notes.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2))) : []);
  const dir = store.assetDir(v.id, id);
  const assets: Asset[] = [];
  let buildError: string | null = null, contentSource = "template";
  try { contentSource = (await kind.build(v.opportunity, plan, iteration, store.writer(dir, assets), model)).contentSource; } catch (e) { buildError = (e as Error).message; }
  const read = store.reader(dir);
  const checks = [...kind.verify(read, assets.map((a) => a.name)), ...(buildError ? [{ name: "build", passed: false, detail: buildError.slice(0, 200) }] : [])];
  const docs = { page: read("index.html") ?? "", markdown: assets.filter((a) => a.name.endsWith(".md") && a.name !== "launch-checklist.md").map((a) => read(a.name) ?? "").join("\n") };
  const ev = await evaluate(v.opportunity, checks, docs, portfolio, model);
  const sim: Evidence = { id: newId("ev"), kind: "simulated", source: `engine evaluation (${kind.id}; content: ${contentSource})`, at: now.toISOString(),
    metrics: { qualityScore: ev.quality, scores: ev.scores }, notes: `Simulated: the engine's own evaluation, not customer or financial data.\n${ev.weaknesses.map((w) => `- ${w}`).join("\n")}` };
  return { id, iteration, hypothesis: plan.hypothesis, assets, checks, verified: checks.every((c) => c.passed), evidence: [sim], createdAt: now.toISOString() };
}

function decide(v: Venture, limits: Limits): { kind: DecisionKind; basis: Decision["basis"]; reason: string; approval?: ApprovalAction } {
  const actual = v.status === "launched" ? latestActual(v) : null;
  if (actual) {
    const m = actual.metrics, visitors = m.visitors ?? 0, signups = m.signups ?? 0, sales = m.sales ?? 0, revenue = m.revenueUsd ?? 0, cost = m.costUsd ?? 0;
    if (sales >= 1 && revenue > cost) return { kind: "SCALE", basis: "actual", reason: `${sales} sale(s), revenue ${revenue} > cost ${cost} (owner-recorded)` };
    if (visitors >= 300 && signups === 0) return { kind: "KILL", basis: "actual", reason: `${visitors} visitors and no signups`, approval: "irreversible-shutdown" };
    if (visitors >= 100 && signups / visitors < 0.02) return v.experiments.length < limits.maxIterationsPerVenture
      ? { kind: "IMPROVE", basis: "actual", reason: `conversion ${(100 * signups / visitors).toFixed(1)}% < 2%` }
      : { kind: "HOLD", basis: "actual", reason: "conversion below 2% but the iteration limit is reached" };
    return { kind: "HOLD", basis: "actual", reason: `not enough data yet (${visitors} visitors)` };
  }
  if (v.status === "launched") return { kind: "HOLD", basis: "none", reason: "launched; waiting for owner-recorded results" };
  const last = v.experiments.at(-1);
  const sim = latestSimulated(v), q = sim?.metrics.qualityScore ?? 0;
  const breakdown = sim?.metrics.scores ? Object.entries(sim.metrics.scores).map(([k, x]) => `${k} ${x}`).join(", ") : "";
  if (last?.verified && q >= LAUNCH_QUALITY) return { kind: "HOLD", basis: "simulated", reason: `assets verified, simulated quality ${q} (${breakdown}); ready for an owner-approved launch`, approval: "launch-public" };
  if (q >= 0.5 && v.experiments.length < limits.maxIterationsPerVenture) return { kind: "IMPROVE", basis: "simulated", reason: `simulated quality ${q} < ${LAUNCH_QUALITY} (${breakdown})` };
  const failed = last && !last.verified ? `; failed checks: ${last.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}` : "";
  return { kind: "KILL", basis: "simulated", reason: q >= 0.5 ? `iteration limit reached (simulated quality ${q}${failed})` : `simulated quality ${q} < 0.5${failed}` };
}

export async function runCycle(o: EngineOptions): Promise<CycleReport> {
  const limits = o.limits ?? DEFAULT_LIMITS;
  if (limits.spendLimitUsd !== 0) throw new Error("spending is not supported in this phase (spendLimitUsd must be 0)");
  const { store } = o;
  const stopped = stopReason(store.dir);
  if (stopped) throw new Error(`the engine is stopped (${stopped}); run 'resume' to continue`);
  const now = (o.now ?? (() => new Date()))();
  const state = store.state();
  const today = now.toISOString().slice(0, 10);
  const cyclesToday = state.day === today ? state.cyclesToday ?? 0 : 0;
  if (o.maxCyclesPerDay !== undefined && cyclesToday >= o.maxCyclesPerDay) throw new Error(`the daily cycle budget is used (${cyclesToday} of ${o.maxCyclesPerDay}); it resets at 00:00 UTC`);
  let ventures = store.ventures();
  let approvals = store.approvals();
  const budget = new ModelBudget(o.maxModelCallsPerCycle ?? 0);
  const model: ModelUse = { client: o.model ?? null, budget, log: (e) => store.audit(e, now) };
  const report: CycleReport = { cycle: state.cycles + 1, created: [], decisions: [], approvalsRequested: [], iterations: 0, modelCalls: 0 };
  const kindOf = (id: string) => { const k = o.kinds.find((x) => x.id === id); if (!k) throw new Error(`no module for venture kind ${id}`); return k; };
  const set = (id: string, change: (v: Venture) => Venture) => { ventures = ventures.map((v) => (v.id === id ? { ...change(v), updatedAt: now.toISOString() } : v)); };

  // 1. The owner's approval decisions. The engine records them; the owner performs the external action itself.
  for (const a of approvals.filter((x) => x.status !== "pending")) {
    const v = ventures.find((x) => x.id === a.ventureId); if (!v) continue;
    if (a.action === "launch-public" && v.status === "awaiting-launch-approval") set(v.id, (x) => ({ ...x, status: a.status === "approved" ? "launched" : "built" }));
    if (a.action === "irreversible-shutdown" && v.status === "awaiting-shutdown-approval") set(v.id, (x) => ({ ...x, status: a.status === "approved" ? "shut-down" : "launched" }));
  }

  // 2-3. Decisions and iterations.
  for (const v of ventures.filter((x) => x.status === "built" || x.status === "launched")) {
    let d = decide(v, limits);
    // Respect the owner's "no": after a denial, the same request is not repeated until something new happens.
    const denied = d.approval && approvals.filter((a) => a.ventureId === v.id && a.action === d.approval && a.status === "denied").map((a) => a.decidedAt ?? "").sort().at(-1);
    if (d.approval && denied) {
      const newest = v.experiments.flatMap((x) => x.evidence).filter((e) => e.kind === (d.basis === "actual" ? "actual" : "simulated")).map((e) => e.at).sort().at(-1) ?? "";
      if (newest <= denied) d = d.approval === "launch-public" && v.experiments.length < limits.maxIterationsPerVenture
        ? { kind: "IMPROVE", basis: d.basis, reason: "the owner declined the launch; improving the draft" }
        : { kind: "HOLD", basis: d.basis, reason: `the owner declined (${d.approval}); waiting for new ${d.basis === "actual" ? "results" : "work"}` };
    }
    report.decisions.push({ venture: v.id, kind: d.kind, basis: d.basis, reason: d.reason });
    if (d.approval && !approvals.some((a) => a.ventureId === v.id && a.action === d.approval && a.status === "pending")) {
      const reqs = d.approval === "launch-public" ? ` Before launching you need: ${kindOf(v.opportunity.kind).launchRequirements().join("; ")}.` : "";
      const req: ApprovalRequest = { id: newId("apr"), ventureId: v.id, action: d.approval, summary: `${d.approval === "launch-public" ? "Launch publicly" : "Shut down (irreversible)"}: ${v.opportunity.title}. Reason: ${d.reason}.${reqs}`, status: "pending", createdAt: now.toISOString(), decidedAt: null };
      approvals = [...approvals, req]; report.approvalsRequested.push(req.id);
    }
    set(v.id, (x) => ({ ...x, decisions: [...x.decisions, { at: now.toISOString(), kind: d.kind, basis: d.basis, reason: d.reason }],
      status: d.approval === "launch-public" ? "awaiting-launch-approval" : d.approval === "irreversible-shutdown" ? "awaiting-shutdown-approval" : d.kind === "KILL" && x.status === "built" ? "archived" : x.status }));
    if (d.kind === "IMPROVE") {
      const cur = ventures.find((x) => x.id === v.id)!;
      const exp = await runExperiment(store, kindOf(cur.opportunity.kind), cur, ventures, model, now);
      set(v.id, (x) => ({ ...x, experiments: [...x.experiments, exp] }));
      report.iterations += 1;
    }
  }

  // 4. New opportunities, while there is room.
  const room = Math.min(limits.maxNewVenturesPerCycle, limits.maxActiveVentures - ventures.filter((v) => ACTIVE.has(v.status)).length);
  if (room > 0) {
    const avoid = new Set(ventures.map((v) => v.opportunity.title));
    const candidates = (await Promise.all(o.kinds.map((k, i) => k.generateOpportunities({ seed: state.seed * 7919 + i, avoid, count: room * 3, model }))))
      .flat().filter((c) => c.score >= MIN_OPPORTUNITY_SCORE).sort((a, b) => b.score - a.score).slice(0, room);
    for (const c of candidates) {
      const opp = { ...c, id: newId("opp"), createdAt: now.toISOString() };
      const v0: Venture = { id: newId("ven"), opportunity: opp, status: "draft", experiments: [], decisions: [], createdAt: now.toISOString(), updatedAt: now.toISOString() };
      const v: Venture = { ...v0, experiments: [await runExperiment(store, kindOf(opp.kind), v0, ventures, model, now)], status: "built" };
      ventures = [...ventures, v]; report.created.push(v.id); report.iterations += 1;
    }
  }
  report.modelCalls = budget.calls;

  store.saveVentures(ventures); store.saveApprovals(approvals);
  store.saveState({ cycles: state.cycles + 1, seed: state.seed + 1, day: today, cyclesToday: cyclesToday + 1 });
  store.audit({ kind: "cycle", cycle: report.cycle, created: report.created, decisions: report.decisions.map((d) => `${d.venture}:${d.kind}:${d.basis}`), approvalsRequested: report.approvalsRequested, modelCalls: report.modelCalls }, now);
  return report;
}

export async function runEngine(o: EngineOptions, cycles: number): Promise<CycleReport[]> {
  const limits = o.limits ?? DEFAULT_LIMITS;
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > limits.maxCyclesPerRun) throw new Error(`cycles: 1 to ${limits.maxCyclesPerRun}`);
  const out: CycleReport[] = [];
  for (let i = 0; i < cycles; i++) {
    if (stopReason(o.store.dir)) break; // a STOP set during a run ends it after the current cycle
    out.push(await runCycle(o));
  }
  return out;
}

export function decideApproval(store: Store, id: string, approve: boolean, now = new Date()): ApprovalRequest {
  const all = store.approvals();
  const a = all.find((x) => x.id === id);
  if (!a) throw new Error(`no approval request ${id}`);
  if (a.status !== "pending") throw new Error(`${id} is already ${a.status}`);
  const done: ApprovalRequest = { ...a, status: approve ? "approved" : "denied", decidedAt: now.toISOString() };
  store.saveApprovals(all.map((x) => (x.id === id ? done : x)));
  store.audit({ kind: "approval", id, action: a.action, venture: a.ventureId, decision: done.status }, now);
  return done;
}

/** Owner-recorded results of a launched venture: the only source of "actual" evidence. */
export function recordActual(store: Store, ventureId: string, metrics: Evidence["metrics"], source: string, now = new Date()): Evidence {
  const ventures = store.ventures();
  const v = ventures.find((x) => x.id === ventureId);
  if (!v) throw new Error(`no venture ${ventureId}`);
  if (v.status !== "launched") throw new Error(`actual results can only be recorded for a launched venture (this one is ${v.status})`);
  if (typeof source !== "string" || source.trim().length < 3) throw new Error("source: say where the numbers come from (e.g. 'payment provider dashboard 2026-11-10')");
  if ("qualityScore" in metrics || "scores" in metrics) throw new Error("quality scores are simulated estimates, not actual results");
  for (const [k, x] of Object.entries(metrics)) if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || (k !== "revenueUsd" && k !== "costUsd" && !Number.isInteger(x))) throw new Error(`${k}: must be a non-negative ${k.endsWith("Usd") ? "amount" : "whole number"}`);
  if ((metrics.signups ?? 0) > (metrics.visitors ?? Infinity)) throw new Error("signups cannot exceed visitors");
  const ev: Evidence = { id: newId("ev"), kind: "actual", source: source.trim().slice(0, 200), at: now.toISOString(), metrics, notes: "Recorded by the owner." };
  const last = v.experiments.at(-1)!;
  store.saveVentures(ventures.map((x) => (x.id === ventureId ? { ...x, experiments: [...x.experiments.slice(0, -1), { ...last, evidence: [...last.evidence, ev] }], updatedAt: now.toISOString() } : x)));
  store.audit({ kind: "actual-evidence", venture: ventureId, source: ev.source, metrics }, now);
  return ev;
}
