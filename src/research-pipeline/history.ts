/**
 * Research history: comparison of two runs of one opportunity (Phase 1A
 * step 5). Pure and deterministic: no filesystem, network, process,
 * environment, clock, randomness, model or Docker access. Everything is
 * built in memory and returned; nothing is written, scheduled, researched,
 * approved or sent.
 *
 * Input: two runs in the step 3 loader's shape (RunData). Assembled results
 * are never accepted as they are, because nothing in such an object proves
 * that assembleRun produced it: compareRuns assembles each run itself
 * (assembleRun re-validates every part and requires Phase 0's validation to
 * pass). Each run is assembled from the caller's object and from a private
 * structured copy, and both results must be identical; all later reads use
 * the copy, so a value can't change between validation and comparison. As
 * with the step 2 parsers this is not a sandbox for hostile JavaScript
 * objects (Proxy traps run during inspection); JSON-derived data is the
 * intended input.
 *
 * Rules:
 * - Both runs must be for the same opportunity, and the current run's date
 *   must be strictly after the previous run's date.
 * - Records are matched by stable identifiers (source, claim, assumption,
 *   scenario name, criterion, gate, negative finding by gate, contradiction
 *   and question ids). Field changes are reported as recorded.
 * - Each change has one category, chosen by a fixed rule from recorded data
 *   only (see ChangeCategory). The direction of evidence is never inferred
 *   from claim text: a new source or claim is "direction not recorded".
 *   Evidence "for" is only a hard gate newly passing under Phase 0's rules;
 *   evidence "against" is only an operator-recorded negative finding that
 *   applies.
 * - Reasons for changes are unknown unless an operator judgment records a
 *   rationale; nothing here explains why something changed.
 * - A removed negative finding, contradiction or evidence gap does not show
 *   that an issue was resolved.
 * - A changed source hash shows that the text differs, not which version is
 *   true. Financial figures are projections from assumptions.
 * - Revisit triggers are suggestions to reassess; they authorize nothing.
 * - The opportunity is always retained: no score, assessment status or
 *   change deletes, rejects or hides it.
 * Text in the result is untrusted data; renderComparison escapes it.
 */

import { assembleRun, AssemblyError, type AssembledReport, type RunData } from "./assemble.js";
import { escapeInline, formatMoney, type Currency, type EvidenceGrade } from "./division.js";
import type { EvidenceLedger, LedgerGate } from "./ledger.js";

export const COMPARISON_VERSION = 1;

export type ChangeArea =
  | "source" | "claim" | "assumption" | "scenario" | "score" | "criterion" | "gate" | "assessment" | "negative_finding" | "contradiction";

/**
 * evidence_supporting: a hard gate newly shows PASS under Phase 0's rules.
 * evidence_against: an operator-recorded negative finding newly applies (a confirmed failed gate).
 * evidence_quality_improved / evidence_quality_declined: a grade, confidence or checked independence changed.
 * evidence_missing_or_withdrawn: a source or sourced claim was removed, or evidence dropped to grade D.
 * new_evidence_direction_unrecorded: a source or sourced claim was added or its content changed; whether it
 *   supports or weakens the opportunity is not recorded and is not inferred.
 * assumptions_changed: an assumption, an assumption-type claim or a scenario changed.
 * operator_judgment_changed: scores, gate marks, speculation, negative findings or contradictions changed.
 * assessment_changed: the step 4 research assessment changed.
 * metadata_changed: other recorded fields (titles, dates, addresses) changed.
 */
export type ChangeCategory =
  | "evidence_supporting" | "evidence_against" | "evidence_quality_improved" | "evidence_quality_declined"
  | "evidence_missing_or_withdrawn" | "new_evidence_direction_unrecorded" | "assumptions_changed" | "operator_judgment_changed"
  | "assessment_changed" | "metadata_changed";

export interface ChangeItem {
  /** Stable: area, subject and (for split changes) aspect. */
  readonly changeId: string;
  readonly area: ChangeArea;
  readonly subjectId: string;
  readonly kind: "added" | "removed" | "changed";
  readonly category: ChangeCategory;
  /** Changed fields (empty for added/removed). */
  readonly fields: readonly string[];
  /** Plain description of what the data shows (untrusted text included as recorded). */
  readonly detail: string;
}

export interface RevisitTrigger {
  readonly triggerId: string;
  readonly reason: string;
  readonly relatedChangeIds: readonly string[];
  /** Always "nothing": a trigger is a suggestion to reassess. */
  readonly authorizes: "nothing";
}

export interface RunSummary {
  readonly reportId: string;
  readonly asOf: string;
  readonly assessmentStatus: string;
  readonly phase0Verdict: string;
  readonly phase0Total: number;
  readonly phase0Confidence: string;
}

export interface RunComparison {
  readonly version: 1;
  readonly opportunityId: string;
  readonly previous: RunSummary;
  readonly current: RunSummary;
  readonly identical: boolean;
  /** In a fixed order: by area (the order the sections below are built, as listed in ChangeArea), then added, removed, changed records. */
  readonly changes: readonly ChangeItem[];
  /** Unresolved questions and evidence gaps listed now but not before, and no longer listed (not "resolved"). */
  readonly questionsAdded: readonly string[];
  readonly questionsNoLongerListed: readonly string[];
  readonly revisitTriggers: readonly RevisitTrigger[];
  readonly retention: "retained";
  readonly notes: readonly string[];
}

export const COMPARISON_NOTES: readonly string[] = Object.freeze([
  "Reasons for changes are unknown: the runs record what changed, not why, except where an operator judgment states a rationale.",
  "A changed source hash shows that the text differs; it does not show which version is true.",
  "Financial figures are projections from operator assumptions, not established results.",
  "A negative finding, contradiction or evidence gap that is no longer recorded is not shown to be resolved.",
  "Revisit triggers are suggestions to reassess. They authorize nothing: no launch, spending, contact with outsiders, trading or other action.",
  "The opportunity is retained whatever its score or assessment; nothing here deletes, rejects or hides it.",
]);

export class HistoryError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Run comparison refused:\n- ${reasons.join("\n- ")}`);
    this.name = "HistoryError";
  }
}

const GRADE_RANK: Record<EvidenceGrade, number> = { A: 4, B: 3, C: 2, D: 1 };
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Assembles one run from the caller's object and from a private copy; both must give the same result. */
function assembleChecked(label: string, raw: unknown): { assembled: AssembledReport; opportunityId: string } {
  let first: AssembledReport;
  try {
    first = assembleRun(raw);
  } catch (err) {
    if (err instanceof AssemblyError) throw new HistoryError([`${label}: ${err.reasons[0] ?? "invalid"}`, ...err.reasons.slice(1)]);
    throw err;
  }
  let copy: RunData;
  try {
    copy = structuredClone(raw) as RunData;
  } catch {
    throw new HistoryError([`${label}: could not be copied as plain data`]);
  }
  let assembled: AssembledReport;
  try {
    assembled = assembleRun(copy);
  } catch (err) {
    if (err instanceof AssemblyError) throw new HistoryError([`${label}: changed while being read (values must be stable plain data)`]);
    throw err;
  }
  if (assembled.markdown !== first.markdown || JSON.stringify(assembled.ledger) !== JSON.stringify(first.ledger)) {
    throw new HistoryError([`${label}: changed while being read (values must be stable plain data)`]);
  }
  return { assembled, opportunityId: copy.opportunity.id };
}

const summary = (l: EvidenceLedger): RunSummary => ({
  reportId: l.reportId, asOf: l.asOf, assessmentStatus: l.assessment.status, phase0Verdict: l.assessment.phase0Verdict,
  phase0Total: l.assessment.phase0Total, phase0Confidence: l.assessment.phase0Confidence,
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function changedFields<T extends object>(a: T, b: T, fields: readonly (keyof T & string)[]): string[] {
  return fields.filter((f) => !same(a[f], b[f]));
}
/** Matches records by id: added (current order), removed (previous order), and pairs present in both (current order). */
function match<T>(before: readonly T[], after: readonly T[], key: (x: T) => string) {
  const b = new Map(before.map((x) => [key(x), x]));
  const a = new Map(after.map((x) => [key(x), x]));
  return {
    added: after.filter((x) => !b.has(key(x))),
    removed: before.filter((x) => !a.has(key(x))),
    both: after.filter((x) => b.has(key(x))).map((x) => [b.get(key(x))!, x] as const),
  };
}
const gradeMove = (before: EvidenceGrade, after: EvidenceGrade): ChangeCategory | null =>
  before === after ? null
    : GRADE_RANK[after] > GRADE_RANK[before] ? "evidence_quality_improved"
    : after === "D" ? "evidence_missing_or_withdrawn" : "evidence_quality_declined";

/**
 * Compares two runs of one opportunity. Refuses (HistoryError) unless both
 * runs assemble and validate, are for the same opportunity, and the current
 * run is strictly later. Returns the structured comparison and its Markdown.
 */
export function compareRuns(previousRun: unknown, currentRun: unknown): { readonly comparison: RunComparison; readonly markdown: string } {
  const prev = assembleChecked("previous run", previousRun);
  const curr = assembleChecked("current run", currentRun);
  const problems: string[] = [];
  if (prev.opportunityId !== curr.opportunityId) problems.push(`the runs are for different opportunities ("${prev.opportunityId}" and "${curr.opportunityId}")`);
  const P = prev.assembled.ledger;
  const C = curr.assembled.ledger;
  if (C.asOf === P.asOf) problems.push(`both runs are dated ${C.asOf} (dates must be strictly increasing)`);
  else if (C.asOf < P.asOf) problems.push(`the current run (${C.asOf}) is dated before the previous run (${P.asOf})`);
  if (problems.length > 0) throw new HistoryError(problems);

  const changes: ChangeItem[] = [];
  const add = (area: ChangeArea, subjectId: string, kind: ChangeItem["kind"], category: ChangeCategory, fields: string[], detail: string, aspect = "") =>
    changes.push({ changeId: `${area}:${subjectId}${aspect ? `:${aspect}` : ""}`, area, subjectId, kind, category, fields, detail });

  // Sources (by id; content compared by SHA-256 of the exact text).
  const src = match(P.sources, C.sources, (s) => s.sourceId);
  for (const s of src.added) add("source", s.sourceId, "added", "new_evidence_direction_unrecorded", [], `Source added: ${s.title} (${s.publisher}); whether it supports or weakens the opportunity is not recorded.`);
  for (const s of src.removed) add("source", s.sourceId, "removed", "evidence_missing_or_withdrawn", [], `Source no longer included: ${s.title} (${s.publisher}); the reason is unknown.`);
  for (const [b, a] of src.both) {
    if (b.contentSha256 !== a.contentSha256) {
      add("source", a.sourceId, "changed", "new_evidence_direction_unrecorded", ["contentSha256"],
        `Source text changed (SHA-256 ${b.contentSha256.slice(0, 12)} to ${a.contentSha256.slice(0, 12)}); this shows the text differs, not which version is true.`, "content");
    }
    if (b.independenceVerified !== a.independenceVerified) {
      add("source", a.sourceId, "changed", a.independenceVerified ? "evidence_quality_improved" : "evidence_quality_declined", ["independenceVerified"],
        `Independence ${a.independenceVerified ? "now checked" : "no longer checked"}.`, "independence");
    }
    const meta = changedFields(b, a, ["title", "publisher", "url", "publishedAt", "retrievedAt", "originId", "derivedFrom"]);
    if (meta.length > 0) add("source", a.sourceId, "changed", "metadata_changed", meta, `Recorded source details changed: ${meta.join(", ")}.`, "metadata");
  }

  // Claims (by id).
  const sourcedKinds = new Set(["sourced_fact", "derived_estimate"]);
  const claimCategory = (kind: string, fallback: ChangeCategory): ChangeCategory =>
    sourcedKinds.has(kind) ? fallback : kind === "assumption" ? "assumptions_changed" : "operator_judgment_changed";
  const cl = match(P.claims, C.claims, (c) => c.claimId);
  for (const c of cl.added) {
    add("claim", c.claimId, "added", claimCategory(c.kind, "new_evidence_direction_unrecorded"), [],
      `Claim added (${c.kind}, evidence grade ${c.evidenceGrade}): ${c.statement}`);
  }
  for (const c of cl.removed) {
    add("claim", c.claimId, "removed", claimCategory(c.kind, "evidence_missing_or_withdrawn"), [], `Claim withdrawn (${c.kind}): ${c.statement}. The reason is unknown.`);
  }
  for (const [b, a] of cl.both) {
    const move = gradeMove(b.evidenceGrade, a.evidenceGrade);
    if (move) add("claim", a.claimId, "changed", move, ["evidenceGrade"], `Evidence grade ${b.evidenceGrade} to ${a.evidenceGrade}.`, "grade");
    const citationsOf = (x: typeof a) => x.citations.map((cit) => ({ sourceId: cit.sourceId, quote: cit.quote }));
    const fields = changedFields(b, a, ["statement", "kind", "method", "verification"]).concat(same(citationsOf(b), citationsOf(a)) ? [] : ["citations"]);
    if (fields.length > 0) {
      const sources = (x: typeof a) => [...new Set(x.citations.map((cit) => cit.sourceId))].join(", ") || "none";
      add("claim", a.claimId, "changed", claimCategory(a.kind, "new_evidence_direction_unrecorded"), fields,
        `Claim record changed (${fields.join(", ")}); cited sources ${sources(b)} to ${sources(a)}.`, "record");
    }
  }

  // Assumptions and scenarios (projections).
  const as = match(P.assumptions, C.assumptions, (x) => x.assumptionId);
  for (const x of as.added) add("assumption", x.assumptionId, "added", "assumptions_changed", [], `Assumption added: ${x.label} = ${x.value} ${x.unit} (${x.support}).`);
  for (const x of as.removed) add("assumption", x.assumptionId, "removed", "assumptions_changed", [], `Assumption removed: ${x.label}.`);
  for (const [b, a] of as.both) {
    const fields = changedFields(b, a, ["label", "value", "unit", "support", "claimId", "rationale", "usedInScenarios"]);
    if (fields.length > 0) {
      add("assumption", a.assumptionId, "changed", "assumptions_changed", fields,
        `Assumption changed (${fields.join(", ")}): value ${b.value} to ${a.value} ${a.unit}; support ${b.support} to ${a.support}.`);
    }
  }
  const money = (minor: number, currency: Currency) => formatMoney(minor, currency);
  for (const [b, a] of match(P.scenarios, C.scenarios, (s) => s.name).both) {
    const fields = changedFields(b, a, ["role", "currency", "startupCostMinor", "monthlyProfitMinor", "cumulativeProfitMinor", "horizonMonths", "breakEvenMonth", "inputs"]);
    if (fields.length > 0) {
      add("scenario", a.name, "changed", "assumptions_changed", fields,
        `Projected ${a.name} scenario (${a.role === "base_case" ? "base case" : a.role.replace("_", " ")}${b.role !== a.role ? `, was ${b.role.replace("_", " ")}` : ""}) changed: ` +
        `monthly profit ${money(b.monthlyProfitMinor, b.currency)} to ${money(a.monthlyProfitMinor, a.currency)}, ` +
        `cumulative ${money(b.cumulativeProfitMinor, b.currency)} to ${money(a.cumulativeProfitMinor, a.currency)}. Projections from assumptions, not results.`);
    }
  }

  // Scores, criteria and confidence (Phase 0 results).
  const pa = P.assessment;
  const ca = C.assessment;
  if (pa.phase0Total !== ca.phase0Total || pa.phase0Verdict !== ca.phase0Verdict) {
    const fields = [...(pa.phase0Total !== ca.phase0Total ? ["phase0Total"] : []), ...(pa.phase0Verdict !== ca.phase0Verdict ? ["phase0Verdict"] : [])];
    add("score", "total", "changed", "operator_judgment_changed", fields,
      `Phase 0 score ${pa.phase0Total} to ${ca.phase0Total}; verdict ${pa.phase0Verdict} to ${ca.phase0Verdict} (from the operator's criterion scores and gate marks).`);
  }
  if (pa.phase0Confidence !== ca.phase0Confidence) {
    const up = (CONFIDENCE_RANK[ca.phase0Confidence] ?? 0) > (CONFIDENCE_RANK[pa.phase0Confidence] ?? 0);
    add("score", "confidence", "changed", up ? "evidence_quality_improved" : "evidence_quality_declined", ["phase0Confidence"],
      `Overall evidence confidence ${pa.phase0Confidence} to ${ca.phase0Confidence}.`);
  }
  for (const [b, a] of match(P.criteria, C.criteria, (c) => c.criterionId).both) {
    if (b.score !== a.score) add("criterion", a.criterionId, "changed", "operator_judgment_changed", ["score"], `${a.label}: operator score ${b.score} to ${a.score}.`, "score");
    const move = gradeMove(b.evidenceGrade, a.evidenceGrade);
    if (move) add("criterion", a.criterionId, "changed", move, ["evidenceGrade"], `${a.label}: evidence grade ${b.evidenceGrade} to ${a.evidenceGrade}.`, "grade");
  }

  // Hard gates.
  const gateCategory = (b: LedgerGate, a: LedgerGate): ChangeCategory => {
    if (a.finding === "passed") return "evidence_supporting";
    if (a.finding === "confirmed_failure") return "evidence_against";
    if (b.finding === "passed" && a.finding === "insufficient_evidence") return "evidence_quality_declined";
    return "operator_judgment_changed";
  };
  for (const [b, a] of match(P.gates, C.gates, (g) => g.gateId).both) {
    if (b.status !== a.status || b.finding !== a.finding) {
      add("gate", a.gateId, "changed", gateCategory(b, a), changedFields(b, a, ["status", "finding"]),
        `${a.label}: ${b.status} (${b.finding}) to ${a.status} (${a.finding}).${a.finding === "passed" ? " Passes under Phase 0's rules (grade A/B evidence and an operator relevance assessment)." : ""}`, "outcome");
    }
    const move = gradeMove(b.evidenceGrade, a.evidenceGrade);
    if (move) add("gate", a.gateId, "changed", move, ["evidenceGrade"], `${a.label}: evidence grade ${b.evidenceGrade} to ${a.evidenceGrade}.`, "grade");
  }

  // Research assessment.
  if (pa.status !== ca.status) {
    add("assessment", "status", "changed", "assessment_changed", ["status"],
      `Research assessment ${pa.status} to ${ca.status}. The opportunity is retained either way.`);
  }

  // Operator judgments (by gate for negative findings, by id for contradictions).
  const nf = match(P.negativeFindings, C.negativeFindings, (f) => f.gateId);
  for (const f of nf.added) {
    add("negative_finding", f.gateId, "added", f.applied ? "evidence_against" : "operator_judgment_changed", [],
      `Negative finding recorded for gate ${f.gateId} by ${f.assessedBy} (${f.applied ? "applies" : `does not apply: ${f.problems.join("; ")}`}). Operator rationale: ${f.rationale}`);
  }
  for (const f of nf.removed) {
    add("negative_finding", f.gateId, "removed", "operator_judgment_changed", [],
      `Negative finding for gate ${f.gateId} is no longer recorded. This does not show the issue was resolved; the reason is unknown.`);
  }
  for (const [b, a] of nf.both) {
    const fields = changedFields(b, a, ["claimIds", "assessedBy", "assessedAt", "rationale", "applied", "problems"]);
    if (fields.length > 0) {
      add("negative_finding", a.gateId, "changed", !b.applied && a.applied ? "evidence_against" : "operator_judgment_changed", fields,
        `Negative finding for gate ${a.gateId} changed (${fields.join(", ")}): ${b.applied ? "applied" : "not applied"} to ${a.applied ? "applied" : "not applied"}.`);
    }
  }
  const ct = match(P.contradictions, C.contradictions, (c) => c.contradictionId);
  const claimsOf = (c: (typeof C.contradictions)[number]) => c.claims.map((x) => x.claimId).join(", ");
  for (const c of ct.added) add("contradiction", c.contradictionId, "added", "operator_judgment_changed", [], `Contradiction recorded between claims ${claimsOf(c)} by ${c.assessedBy}: ${c.description}`);
  for (const c of ct.removed) {
    add("contradiction", c.contradictionId, "removed", "operator_judgment_changed", [],
      `Contradiction between claims ${claimsOf(c)} is no longer recorded. This does not show it was resolved; the reason is unknown.`);
  }
  for (const [b, a] of ct.both) {
    const fields = changedFields(b, a, ["claims", "description", "assessedBy", "assessedAt", "status"]);
    if (fields.length > 0) add("contradiction", a.contradictionId, "changed", "operator_judgment_changed", fields, `Contradiction record changed (${fields.join(", ")}).`);
  }

  const q = match(P.unresolvedQuestions, C.unresolvedQuestions, (x) => x.questionId);
  const comparison: RunComparison = {
    version: COMPARISON_VERSION,
    opportunityId: curr.opportunityId,
    previous: summary(P),
    current: summary(C),
    identical: changes.length === 0 && q.added.length === 0 && q.removed.length === 0,
    changes,
    questionsAdded: q.added.map((x) => x.questionId),
    questionsNoLongerListed: q.removed.map((x) => x.questionId),
    revisitTriggers: revisitTriggers(changes),
    retention: "retained",
    notes: COMPARISON_NOTES,
  };
  freezeDeep(comparison);
  return Object.freeze({ comparison, markdown: renderComparison(comparison) });
}

/** Conservative revisit triggers, in a fixed order; each is a suggestion to reassess and authorizes nothing. */
function revisitTriggers(changes: readonly ChangeItem[]): RevisitTrigger[] {
  const triggers: RevisitTrigger[] = [];
  const push = (triggerId: string, reason: string, related: readonly ChangeItem[]) => {
    if (related.length > 0) triggers.push({ triggerId, reason, relatedChangeIds: related.map((c) => c.changeId), authorizes: "nothing" });
  };
  const of = (pred: (c: ChangeItem) => boolean) => changes.filter(pred);
  push("revisit-new-evidence", "New or changed sources or sourced claims (direction not recorded): review them.",
    of((c) => c.category === "new_evidence_direction_unrecorded"));
  push("revisit-evidence-quality-improved", "Evidence quality improved: reassess the affected scores and gates.", of((c) => c.category === "evidence_quality_improved"));
  push("revisit-evidence-weakened-or-withdrawn", "Evidence was withdrawn or its quality declined: check whether conclusions still hold.",
    of((c) => c.category === "evidence_quality_declined" || c.category === "evidence_missing_or_withdrawn"));
  push("revisit-financial-assumptions", "Financial assumptions or projections changed: review the inputs and their support.",
    of((c) => c.area === "assumption" || c.area === "scenario" || (c.area === "claim" && c.category === "assumptions_changed")));
  for (const c of of((x) => x.area === "gate" && x.changeId.endsWith(":outcome"))) {
    push(`revisit-gate-${c.subjectId}`, `Hard gate ${c.subjectId} changed outcome: review its evidence and the operator's marks.`, [c]);
  }
  for (const c of of((x) => x.area === "negative_finding")) {
    push(`revisit-negative-finding-${c.subjectId}`, `Negative finding for gate ${c.subjectId} was ${c.kind}: review it (a removal does not show resolution).`, [c]);
  }
  for (const c of of((x) => x.area === "contradiction")) {
    push(`revisit-contradiction-${c.subjectId}`, `Contradiction ${c.subjectId} was ${c.kind}: review both claims (a removal does not show resolution).`, [c]);
  }
  push("revisit-assessment", "The research assessment changed: review the reasons in the current report.", of((c) => c.area === "assessment"));
  return triggers;
}

const CATEGORY_LABEL: Record<ChangeCategory, string> = {
  evidence_supporting: "Evidence supporting the opportunity (a hard gate newly passes under Phase 0's rules)",
  evidence_against: "Evidence against the opportunity (an operator-recorded negative finding applies)",
  evidence_quality_improved: "Improved evidence quality",
  evidence_quality_declined: "Declined evidence quality",
  evidence_missing_or_withdrawn: "Missing or withdrawn evidence",
  new_evidence_direction_unrecorded: "New or changed evidence (direction not recorded)",
  assumptions_changed: "Changed assumptions and projections",
  operator_judgment_changed: "Operator judgment changes",
  assessment_changed: "Research assessment changes",
  metadata_changed: "Other recorded details",
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL) as ChangeCategory[];

/** Markdown summary of a comparison. Every piece of text is escaped with Phase 0's escapeInline. */
export function renderComparison(c: RunComparison): string {
  const e = escapeInline;
  const out: string[] = [];
  out.push(`# Research history: ${e(c.opportunityId)}`, "");
  out.push("| Run | Date | Report | Research assessment | Phase 0 score | Phase 0 verdict | Confidence |", "|---|---|---|---|---|---|---|");
  for (const [label, r] of [["Previous", c.previous], ["Current", c.current]] as const) {
    out.push(`| ${label} | ${e(r.asOf)} | ${e(r.reportId)} | ${e(r.assessmentStatus)} | ${r.phase0Total} | ${e(r.phase0Verdict)} | ${e(r.phase0Confidence)} |`);
  }
  out.push("", "**Opportunity retained.** " + e(c.notes[5]), "");
  out.push(...c.notes.slice(0, 5).map((n) => `- ${e(n)}`), "");
  if (c.identical) out.push("**No changes found between the two runs.**", "");
  for (const category of CATEGORY_ORDER) {
    const items = c.changes.filter((x) => x.category === category);
    if (items.length === 0) continue;
    out.push(`## ${CATEGORY_LABEL[category]}`, "");
    for (const x of items) out.push(`- ${e(x.changeId)} (${x.kind}): ${e(x.detail)}`);
    out.push("");
  }
  if (c.questionsAdded.length > 0 || c.questionsNoLongerListed.length > 0) {
    out.push("## Unresolved questions and evidence gaps", "");
    if (c.questionsAdded.length > 0) out.push(`- Now listed: ${c.questionsAdded.map((x) => e(x)).join(", ")}`);
    if (c.questionsNoLongerListed.length > 0) out.push(`- No longer listed (not shown to be resolved): ${c.questionsNoLongerListed.map((x) => e(x)).join(", ")}`);
    out.push("");
  }
  out.push("## Revisit triggers (suggestions to reassess; they authorize no action)", "");
  if (c.revisitTriggers.length === 0) out.push("- none");
  for (const t of c.revisitTriggers) out.push(`- ${e(t.triggerId)}: ${e(t.reason)} (changes: ${t.relatedChangeIds.map((x) => e(x)).join(", ")})`);
  out.push("", "_Phase 1A offline comparison, approved for fictional inputs only: not a basis for real decisions._", "");
  return out.join("\n");
}
