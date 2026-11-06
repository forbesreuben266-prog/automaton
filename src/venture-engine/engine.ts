/**
 * The engine cycle (one call = one cycle, bounded by Limits):
 *   1. apply the owner's approval decisions;
 *   2. decide SCALE / IMPROVE / HOLD / KILL for every active venture from its latest evidence;
 *   3. run the IMPROVE iterations (plan -> build -> verify -> simulate);
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

import { newId, Store } from "./store.js";
import type { ApprovalAction, ApprovalRequest, Asset, Decision, DecisionKind, Evidence, Experiment, Limits, Venture, VentureKind } from "./types.js";

export const DEFAULT_LIMITS: Limits = Object.freeze({ maxActiveVentures: 5, maxNewVenturesPerCycle: 2, maxIterationsPerVenture: 3, maxCyclesPerRun: 10, spendLimitUsd: 0 });
export const MIN_OPPORTUNITY_SCORE = 0.5;
const ACTIVE: ReadonlySet<Venture["status"]> = new Set(["draft", "built", "awaiting-launch-approval", "launched", "awaiting-shutdown-approval"]);

export interface EngineOptions { readonly store: Store; readonly kinds: readonly VentureKind[]; readonly limits?: Limits; readonly now?: () => Date }
export interface CycleReport { readonly cycle: number; readonly created: string[]; readonly decisions: { venture: string; kind: DecisionKind; basis: string; reason: string }[]; readonly approvalsRequested: string[]; iterations: number }

const latestEvidence = (v: Venture): Evidence | null => { const e = v.experiments.at(-1)?.evidence ?? []; return e.at(-1) ?? null; };
const latestActual = (v: Venture): Evidence | null => { for (const x of [...v.experiments].reverse()) for (const e of [...x.evidence].reverse()) if (e.kind === "actual") return e; return null; };

/** Plans, builds, verifies and evaluates (simulated) one experiment iteration. */
function runExperiment(store: Store, kind: VentureKind, v: Venture, now: Date): Experiment {
  const iteration = v.experiments.length + 1;
  const id = newId("exp");
  const plan = kind.plan(v.opportunity, iteration, v.experiments.at(-1)?.checks ?? []);
  const dir = store.assetDir(v.id, id);
  const assets: Asset[] = [];
  let buildError: string | null = null;
  try { kind.build(v.opportunity, plan, iteration, store.writer(dir, assets)); } catch (e) { buildError = (e as Error).message; }
  const checks = [...kind.verify(store.reader(dir), assets.map((a) => a.name)), ...(buildError ? [{ name: "build", passed: false, detail: buildError.slice(0, 200) }] : [])];
  const verified = checks.every((c) => c.passed);
  const sim: Evidence = { id: newId("ev"), kind: "simulated", source: `engine estimate (${kind.id})`, at: now.toISOString(), metrics: kind.simulate(v.opportunity, checks, iteration), notes: "Simulated: the engine's own quality estimate. Not customer or financial data." };
  return { id, iteration, hypothesis: plan.hypothesis, assets, checks, verified, evidence: [sim], createdAt: now.toISOString() };
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
  const q = latestEvidence(v)?.metrics.qualityScore ?? 0;
  if (last?.verified && q >= 0.75) return { kind: "HOLD", basis: "simulated", reason: `assets verified, simulated quality ${q}; ready for an owner-approved launch`, approval: "launch-public" };
  if (q >= 0.5 && v.experiments.length < limits.maxIterationsPerVenture) return { kind: "IMPROVE", basis: "simulated", reason: `simulated quality ${q} (target 0.75)${last && !last.verified ? "; failed checks: " + last.checks.filter((c) => !c.passed).map((c) => c.name).join(", ") : ""}` };
  return { kind: "KILL", basis: "simulated", reason: q >= 0.5 ? `iteration limit reached at simulated quality ${q}` : `simulated quality ${q} < 0.5` };
}

export function runCycle(o: EngineOptions): CycleReport {
  const limits = o.limits ?? DEFAULT_LIMITS;
  if (limits.spendLimitUsd !== 0) throw new Error("spending is not supported in this phase (spendLimitUsd must be 0)");
  const now = (o.now ?? (() => new Date()))();
  const { store } = o;
  const state = store.state();
  let ventures = store.ventures();
  let approvals = store.approvals();
  const report: CycleReport = { cycle: state.cycles + 1, created: [], decisions: [], approvalsRequested: [], iterations: 0 };
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
    const d = decide(v, limits);
    const decision: Decision = { at: now.toISOString(), kind: d.kind, basis: d.basis, reason: d.reason };
    report.decisions.push({ venture: v.id, kind: d.kind, basis: d.basis, reason: d.reason });
    if (d.approval && !approvals.some((a) => a.ventureId === v.id && a.action === d.approval && a.status === "pending")) {
      const req: ApprovalRequest = { id: newId("apr"), ventureId: v.id, action: d.approval, summary: `${d.approval === "launch-public" ? "Launch publicly" : "Shut down (irreversible)"}: ${v.opportunity.title}. Reason: ${d.reason}.`, status: "pending", createdAt: now.toISOString(), decidedAt: null };
      approvals = [...approvals, req]; report.approvalsRequested.push(req.id);
    }
    set(v.id, (x) => ({ ...x, decisions: [...x.decisions, decision],
      status: d.approval === "launch-public" ? "awaiting-launch-approval" : d.approval === "irreversible-shutdown" ? "awaiting-shutdown-approval" : d.kind === "KILL" && x.status === "built" ? "archived" : x.status }));
    if (d.kind === "IMPROVE") {
      const cur = ventures.find((x) => x.id === v.id)!;
      const exp = runExperiment(store, kindOf(cur.opportunity.kind), cur, now);
      set(v.id, (x) => ({ ...x, experiments: [...x.experiments, exp] }));
      report.iterations += 1;
    }
  }

  // 4. New opportunities, while there is room.
  const active = ventures.filter((v) => ACTIVE.has(v.status)).length;
  const room = Math.min(limits.maxNewVenturesPerCycle, limits.maxActiveVentures - active);
  if (room > 0) {
    const seen = new Set(ventures.map((v) => v.opportunity.title));
    const candidates = o.kinds.flatMap((k, i) => k.generateOpportunities(state.seed * 7919 + i, seen, room * 3))
      .filter((c) => c.score >= MIN_OPPORTUNITY_SCORE).sort((a, b) => b.score - a.score).slice(0, room);
    for (const c of candidates) {
      const opp = { ...c, id: newId("opp"), createdAt: now.toISOString() };
      let v: Venture = { id: newId("ven"), opportunity: opp, status: "draft", experiments: [], decisions: [], createdAt: now.toISOString(), updatedAt: now.toISOString() };
      v = { ...v, experiments: [runExperiment(store, kindOf(opp.kind), v, now)], status: "built" };
      ventures = [...ventures, v]; report.created.push(v.id); report.iterations += 1;
    }
  }

  store.saveVentures(ventures); store.saveApprovals(approvals); store.saveState({ cycles: state.cycles + 1, seed: state.seed + 1 });
  store.audit({ kind: "cycle", cycle: report.cycle, created: report.created, decisions: report.decisions.map((d) => `${d.venture}:${d.kind}:${d.basis}`), approvalsRequested: report.approvalsRequested }, now);
  return report;
}

export function runEngine(o: EngineOptions, cycles: number): CycleReport[] {
  const limits = o.limits ?? DEFAULT_LIMITS;
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > limits.maxCyclesPerRun) throw new Error(`cycles: 1 to ${limits.maxCyclesPerRun}`);
  return Array.from({ length: cycles }, () => runCycle(o));
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
  for (const [k, x] of Object.entries(metrics)) if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || (k !== "revenueUsd" && k !== "costUsd" && !Number.isInteger(x))) throw new Error(`${k}: must be a non-negative ${k.endsWith("Usd") ? "amount" : "whole number"}`);
  if ((metrics.signups ?? 0) > (metrics.visitors ?? Infinity)) throw new Error("signups cannot exceed visitors");
  if ("qualityScore" in metrics) throw new Error("qualityScore is a simulated estimate, not an actual result");
  const ev: Evidence = { id: newId("ev"), kind: "actual", source: source.trim().slice(0, 200), at: now.toISOString(), metrics, notes: "Recorded by the owner." };
  const last = v.experiments.at(-1)!;
  store.saveVentures(ventures.map((x) => (x.id === ventureId ? { ...x, experiments: [...x.experiments.slice(0, -1), { ...last, evidence: [...last.evidence, ev] }], updatedAt: now.toISOString() } : x)));
  store.audit({ kind: "actual-evidence", venture: ventureId, source: ev.source, metrics }, now);
  return ev;
}
