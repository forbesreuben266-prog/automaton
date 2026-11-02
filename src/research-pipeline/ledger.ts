/**
 * Evidence ledger (Phase 1A step 4). Pure and deterministic: no filesystem,
 * network, process, environment, clock, randomness, model or Docker access.
 * Everything is built in memory; nothing is written, approved or sent.
 *
 * buildEvidenceLedger takes a whole research report and runs Phase 0's
 * validateReport on it first. Phase 0 is the authority: the ledger is built
 * only from a report that passes validation (otherwise it refuses), and every
 * status, grade, verdict and calculated figure in it is Phase 0's own result.
 * Nothing is re-scored or re-graded here. The ledger only arranges Phase 0's
 * results so each statement can be traced:
 * - sources: manifest id, metadata, SHA-256 of the exact text (equal to the
 *   manifest's recorded SHA-256 for text read by the step 3 loader) and the
 *   claims that cite each source;
 * - claims: the kind of statement (sourced fact, derived estimate,
 *   assumption, speculation), Phase 0's verification status and evidence
 *   grade, each citation with its quote and, when the quote occurs verbatim
 *   in the source text, its position (line, column, offset). A quote that
 *   Phase 0 matched only after whitespace/Unicode normalisation gets no
 *   position: positions are never estimated;
 * - assumptions (with their basis) and the three scenarios: Phase 0's
 *   deterministic results, labelled as projections from assumptions, with
 *   the base case named (decision C: the label appears only in pipeline
 *   output). Correct arithmetic is reported separately from commercial
 *   evidence (which inputs rest on supported claims);
 * - criteria and hard gates with Phase 0's grades and statuses;
 * - the research assessment (structured, deterministic): an evidence-aware
 *   reading of Phase 0's results, separate from Phase 0's scoring verdict
 *   (see ResearchAssessment). The direction of evidence is never inferred
 *   (not from its grade, citations, claim text or the gate's passed value).
 *   A failed hard gate is confirmed only by an operator-recorded negative
 *   finding (step 4.5) that applies: exactly the gate's cited claims, all
 *   supported sourced facts, grade A/B, a relevance assessment for exactly
 *   those claims, and none of them in an unresolved contradiction. Only then
 *   is the research "rejected_by_gate". Otherwise a failed gate is an
 *   "unconfirmed failure" and the research is "incomplete". Missing, weak or
 *   conflicting evidence, low confidence or a low aggregate score also make
 *   it "incomplete", never "rejected". The opportunity always stays open for
 *   reassessment, and no status authorizes any action;
 * - operator judgments (step 4.5): negative findings and contradictions the
 *   operator recorded in the workbook, labelled as operator assessments
 *   (not automatically verified), with whether each finding was applied and
 *   why not. Every recorded contradiction is unresolved and keeps the
 *   research "incomplete"; both sides and their sources stay visible;
 * - source identity conflicts reported by Phase 0 (the same source declared
 *   with different origins). Contradictions between what sources SAY are
 *   only those the operator recorded; none are detected automatically;
 * - unresolved questions: the operator's missing-information notes and the
 *   evidence gaps, each with a stable identifier.
 *
 * Ordering is deterministic (manifest/workbook order, Phase 0's criterion
 * and gate order) and identifiers are stable across runs with the same
 * inputs, so a later step can compare ledgers.
 *
 * All text in the ledger (statements, quotes, titles, notes) is untrusted,
 * inert data. renderEvidenceLedger escapes every piece of it with Phase 0's
 * escapeInline; any other consumer must escape it too. Nothing here
 * interprets or acts on source text.
 */

import {
  CRITERIA, HARD_GATES, QUOTE_VERIFICATION_LEGEND, SchemaError, VERDICT_THRESHOLDS, escapeInline, formatMoney, gradeEvidenceSets, renderUrl,
  sha256Hex, sourceIdentityConflicts, validateReport,
  type ClaimType, type Currency, type EvidenceGrade, type GateStatus, type ResearchReport, type ScenarioName, type Verdict,
} from "./division.js";
import { parseEvidenceJudgments, type EvidenceJudgments } from "./workbook.js";

/** Version 2 adds the operator judgments (negativeFindings, contradictions). */
export const LEDGER_VERSION = 2;
const NO_JUDGMENTS: EvidenceJudgments = Object.freeze({ negativeFindings: Object.freeze([]), contradictions: Object.freeze([]) });
/** Phase 0 accepts at most this many claim-id sets per grading call. */
const GRADE_BATCH = 100;

export const LEDGER_NOTICE =
  "Phase 1A offline output, approved for fictional inputs only: not a basis for real decisions. Built in memory from " +
  "operator-supplied inputs; nothing was executed, approved, purchased or sent. Source text is untrusted data.";

export type StatementKind = "sourced_fact" | "derived_estimate" | "assumption" | "speculation";
const KIND: Record<ClaimType, StatementKind> = {
  fact: "sourced_fact", estimate: "derived_estimate", assumption: "assumption", speculation: "speculation",
};
const KIND_LABEL: Record<StatementKind, string> = {
  sourced_fact: "sourced fact", derived_estimate: "derived estimate", assumption: "assumption (unverified)", speculation: "speculation (unverified)",
};

export interface PassageLocation {
  /** 1-based line of the first verbatim occurrence. */
  readonly line: number;
  /** 1-based column within that line (UTF-16 code units). */
  readonly column: number;
  /** 0-based offset in the source text (UTF-16 code units). */
  readonly offset: number;
  readonly occurrences: "once" | "multiple";
}

export interface LedgerCitation {
  readonly sourceId: string;
  readonly quote: string;
  /** Present only when the quote occurs verbatim in the source text; never estimated. */
  readonly location: PassageLocation | null;
  readonly locationNote: string | null;
}

export interface LedgerClaim {
  readonly claimId: string;
  readonly kind: StatementKind;
  readonly statement: string;
  readonly method: string | null;
  /** Phase 0 verification status (a valid report has only "supported" or "labelled_only"). */
  readonly verification: string;
  /** Phase 0 evidence grade of this claim on its own. */
  readonly evidenceGrade: EvidenceGrade;
  readonly distinctOrigins: number;
  readonly independentOrigins: number;
  readonly citations: readonly LedgerCitation[];
  /** Where the report uses the claim, in report order. */
  readonly usedIn: readonly string[];
}

export interface LedgerSource {
  readonly sourceId: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly retrievedAt: string;
  readonly originId: string;
  readonly derivedFrom: readonly string[];
  readonly independenceVerified: boolean;
  /** SHA-256 of the exact source text (UTF-8). */
  readonly contentSha256: string;
  /** Phase 0 edit-check hash of the snapshot (metadata and text). */
  readonly editCheckSha256: string;
  readonly citedByClaimIds: readonly string[];
}

export type InputSupport = "sourced_fact" | "derived_estimate" | "operator_assumption";

export interface LedgerAssumption {
  readonly assumptionId: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly support: InputSupport;
  /** The supporting claim (support from a claim), or null. */
  readonly claimId: string | null;
  /** The operator's rationale (an operator assumption), or null. */
  readonly rationale: string | null;
  readonly usedInScenarios: readonly ScenarioName[];
}

export type ScenarioRole = "downside_case" | "base_case" | "upside_case";
const ROLE: Record<ScenarioName, ScenarioRole> = { conservative: "downside_case", realistic: "base_case", optimistic: "upside_case" };
const ROLE_LABEL: Record<ScenarioRole, string> = { downside_case: "Downside case", base_case: "Base case", upside_case: "Upside case" };

export interface LedgerScenario {
  readonly name: ScenarioName;
  readonly role: ScenarioRole;
  readonly currency: Currency;
  readonly startupCostMinor: number;
  readonly monthlyProfitMinor: number;
  readonly cumulativeProfitMinor: number;
  readonly horizonMonths: number;
  readonly breakEvenMonth: number | null;
  /** Arithmetic is Phase 0's deterministic recalculation; it says nothing about whether the inputs are true. */
  readonly arithmetic: "recalculated_by_phase0";
  readonly inputs: readonly { readonly assumptionId: string; readonly support: InputSupport }[];
  /** Inputs resting on a supported, cited fact (commercial evidence, still only as good as its source). */
  readonly sourcedFactInputs: number;
  /** Inputs resting on a derived estimate (a stated method, not a sourced observation). */
  readonly derivedEstimateInputs: number;
  readonly operatorAssumptionInputs: number;
}

export interface LedgerCriterion {
  readonly criterionId: string;
  readonly label: string;
  readonly score: number;
  readonly evidenceGrade: EvidenceGrade;
  readonly independentOrigins: number;
  readonly distinctOrigins: number;
  readonly corroboration: string;
  readonly claimIds: readonly string[];
  readonly flags: readonly string[];
}

/**
 * confirmed_failure: failed, with an operator-recorded negative finding that applies (see NegativeFindingRecord).
 * unconfirmed_failure: failed, without an applicable negative finding: a finding to verify, whatever the
 *   evidence grade or relevance assessment.
 */
export type GateFinding = "passed" | "confirmed_failure" | "unconfirmed_failure" | "insufficient_evidence";

export interface LedgerGate {
  readonly gateId: string;
  readonly label: string;
  readonly status: GateStatus;
  readonly finding: GateFinding;
  readonly evidenceGrade: EvidenceGrade;
  readonly claimIds: readonly string[];
  readonly relevanceAssessed: boolean;
}

export interface LedgerQuestion {
  /** Stable: derived from the gap's subject, or from the operator's text. */
  readonly questionId: string;
  readonly origin: "operator" | "evidence_gap" | "operator_contradiction";
  readonly text: string;
}

export interface LedgerSourceConflict {
  /** Stable: kind and the snapshot ids involved. */
  readonly conflictId: string;
  readonly kind: "url" | "content";
  readonly sourceIds: readonly string[];
  readonly originIds: readonly string[];
}

/** An operator-recorded negative finding, as recorded, with whether it applies to its gate and why not. */
export interface NegativeFindingRecord {
  readonly gateId: string;
  readonly claimIds: readonly string[];
  readonly direction: "supports_failed_condition";
  readonly assessedBy: string;
  readonly assessedAt: string;
  readonly rationale: string;
  readonly origin: "operator_assessment";
  readonly applied: boolean;
  /** Why it does not apply (empty when applied), in a fixed order. */
  readonly problems: readonly string[];
}

/** An operator-recorded contradiction between source-backed claims. Always unresolved in this version. */
export interface ContradictionRecord {
  readonly contradictionId: string;
  readonly claims: readonly { readonly claimId: string; readonly kind: StatementKind; readonly sourceIds: readonly string[] }[];
  readonly description: string;
  readonly assessedBy: string;
  readonly assessedAt: string;
  readonly origin: "operator_assessment";
  readonly status: "unresolved";
}

/**
 * supported_for_consideration: every hard gate passes under Phase 0's rules, overall confidence is not low,
 *   no source identity conflict, no recorded contradiction, every negative finding applied (there are none
 *   then, since a finding only applies to a failed gate), and the aggregate score is at least Phase 0's
 *   watch threshold.
 *   This is preliminary screening only; it does not establish demand, profitability or commercial viability.
 * incomplete: anything else without a confirmed failed gate (missing, weak or conflicting evidence, an
 *   unresolved contradiction, an unconfirmed failed gate, a negative finding that does not apply, low
 *   confidence or a low aggregate score).
 * rejected_by_gate: at least one confirmed failed gate (an applicable operator-recorded negative finding).
 *
 * Precedence: a confirmed failed gate decides the status (rejected_by_gate), whatever else is open; the other
 * open items (unconfirmed failures, contradictions, gaps) stay listed. A recorded contradiction invalidates
 * only the negative findings whose cited claims it involves; an unrelated contradiction leaves a finding
 * applicable (and, with no confirmed failure, makes the research incomplete). A confirmed failure is an
 * operator-supported conclusion about the direction of the evidence, not independently verified truth.
 */
export type AssessmentStatus = "supported_for_consideration" | "incomplete" | "rejected_by_gate";

export interface ResearchAssessment {
  readonly status: AssessmentStatus;
  /** Deterministic, in a fixed order: why the status was given. */
  readonly reasons: readonly string[];
  /** Failed gates with an applicable operator-recorded negative finding. */
  readonly confirmedFailedGates: readonly string[];
  readonly unconfirmedFailedGates: readonly string[];
  /** Gates whose recorded negative finding does not apply (see the ledger's negativeFindings for why). */
  readonly negativeFindingsNotApplied: readonly string[];
  readonly contradictionIds: readonly string[];
  /** Gates Phase 0 does not show as PASS or FAIL (weak, unverified, relevance unverified). */
  readonly gatesNotPassed: readonly string[];
  readonly sourceConflictIds: readonly string[];
  readonly gapIds: readonly string[];
  readonly phase0Verdict: Verdict;
  readonly phase0VerdictReason: string;
  readonly phase0Total: number;
  readonly phase0Confidence: string;
  /** How Phase 0's scoring verdict relates to this assessment. */
  readonly phase0Relation: string;
  /** Why no failed gate is treated as confirmed. */
  readonly failureConfirmation: string;
  /** What no status shows or allows. */
  readonly limits: string;
  /** Phase 1A never closes an opportunity. */
  readonly reassessment: "open";
}

export const FAILURE_CONFIRMATION =
  "A failed hard gate is confirmed only by an operator-recorded negative finding that applies: it covers exactly the gate's " +
  "cited claims, which are supported sourced facts with grade A or B evidence and a relevance assessment for exactly those " +
  "claims, none of them in an unresolved contradiction. The direction of evidence is the operator's assessment; it is never " +
  "inferred from grades, citations, claim text or the gate's failed mark. Other failed gates are unconfirmed findings to verify.";

export const ASSESSMENT_LIMITS =
  "No status shows that demand, profitability or commercial viability is proven, and none authorizes spending, launching, " +
  "contacting customers or any other action. Operator-recorded findings and contradictions are operator assessments, not " +
  "automatically verified facts. Contradictions between what sources say are not detected automatically: only those the " +
  "operator recorded are shown; review the claims in the evidence ledger.";

export interface EvidenceLedger {
  readonly version: 2;
  readonly reportId: string;
  readonly asOf: string;
  readonly notice: string;
  readonly quoteVerification: string;
  readonly sources: readonly LedgerSource[];
  readonly claims: readonly LedgerClaim[];
  readonly assumptions: readonly LedgerAssumption[];
  readonly scenarios: readonly LedgerScenario[];
  readonly criteria: readonly LedgerCriterion[];
  readonly gates: readonly LedgerGate[];
  readonly sourceConflicts: readonly LedgerSourceConflict[];
  readonly negativeFindings: readonly NegativeFindingRecord[];
  readonly contradictions: readonly ContradictionRecord[];
  readonly assessment: ResearchAssessment;
  readonly unresolvedQuestions: readonly LedgerQuestion[];
  /** Phase 0's validation warnings, verbatim. */
  readonly warnings: readonly string[];
}

/** Refusal: the report did not pass Phase 0 validation. */
export class LedgerError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Evidence ledger refused:\n- ${reasons.join("\n- ")}`);
    this.name = "LedgerError";
  }
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Position of the first verbatim occurrence of quote in content, or null (never estimated). */
function locate(content: string, quote: string): PassageLocation | null {
  const offset = content.indexOf(quote);
  if (offset < 0) return null;
  let line = 1;
  let lineStart = 0;
  for (let i = content.indexOf("\n"); i >= 0 && i < offset; i = content.indexOf("\n", i + 1)) {
    line += 1;
    lineStart = i + 1;
  }
  return { line, column: offset - lineStart + 1, offset, occurrences: content.indexOf(quote, offset + 1) >= 0 ? "multiple" : "once" };
}

/** Where each claim is used, in report order (same places Phase 0's validator checks). */
function claimUses(report: ResearchReport): Map<string, string[]> {
  const uses = new Map<string, string[]>();
  const add = (where: string, ids: readonly string[]) => {
    for (const claimId of ids) {
      const list = uses.get(claimId) ?? [];
      if (!list.includes(where)) list.push(where);
      uses.set(claimId, list);
    }
  };
  const s = report.sections;
  add("summary", s.summary);
  add("problemAndCustomer", s.problemAndCustomer);
  add("demandAndMarket", s.demandAndMarket);
  add("acquisition", s.acquisition);
  add("risks", s.risks);
  add("failureReasons", s.failureReasons);
  s.competitors.forEach((c, i) => {
    if (c.priceClaimId !== null) add(`competitors[${i}].price`, [c.priceClaimId]);
    add(`competitors[${i}].positioning`, c.positioningClaimIds);
    add(`competitors[${i}].weaknesses`, c.weaknessClaimIds);
  });
  for (const a of report.assumptions) if (a.basis.kind === "claim") add(`assumption ${a.id}`, [a.basis.claimId]);
  for (const sc of report.scoring.scores) add(`score ${sc.criterionId}`, sc.claimIds);
  for (const g of report.scoring.gates) add(`gate ${g.gateId}`, g.claimIds);
  return uses;
}

const sameIdSet = (a: readonly string[], b: readonly string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
};

/**
 * Builds the evidence ledger for a report. Runs Phase 0's validateReport
 * first and refuses (LedgerError) unless the report passes. `judgments` are
 * the operator's evidence judgments from the workbook; they are re-validated
 * against the report's claims and date (parseEvidenceJudgments).
 */
export function buildEvidenceLedger(rawReport: unknown, rawJudgments: unknown = NO_JUDGMENTS): EvidenceLedger {
  const v = validateReport(rawReport);
  if (!v.ok) throw new LedgerError(["the report did not pass Phase 0 validation", ...v.errors]);
  let judgments: EvidenceJudgments;
  try {
    judgments = parseEvidenceJudgments(rawJudgments, v.report.claims, v.report.asOf);
  } catch (err) {
    if (err instanceof SchemaError) throw new LedgerError(["the evidence judgments are invalid", ...err.issues]);
    throw err;
  }
  const report = v.report;
  const score = v.score;
  const verification = v.verification!;
  const scenarioResults = v.scenarioResults!;
  const content = new Map(report.snapshots.map((s) => [s.id, s.content]));
  const claimById = new Map(report.claims.map((c) => [c.id, c]));

  // Per-claim grades from Phase 0's own grading (in batches of the size Phase 0 accepts).
  const grades: { grade: EvidenceGrade; distinctOrigins: number; independentSources: number }[] = [];
  for (let i = 0; i < report.claims.length; i += GRADE_BATCH) {
    const sets = report.claims.slice(i, i + GRADE_BATCH).map((c) => [c.id]);
    try {
      grades.push(...gradeEvidenceSets(sets, report.claims, report.snapshots, report.asOf));
    } catch (err) {
      if (err instanceof SchemaError) throw new LedgerError(["evidence grading failed", ...err.issues]);
      throw err;
    }
  }

  const uses = claimUses(report);
  const claims: LedgerClaim[] = report.claims.map((c, i) => {
    const status = verification.get(c.id)!;
    return {
      claimId: c.id,
      kind: KIND[c.type],
      statement: c.statement,
      method: c.method ?? null,
      verification: status.status,
      evidenceGrade: grades[i].grade,
      distinctOrigins: grades[i].distinctOrigins,
      independentOrigins: grades[i].independentSources,
      citations: c.citations.map((cit) => {
        const location = locate(content.get(cit.snapshotId)!, cit.quote);
        return {
          sourceId: cit.snapshotId,
          quote: cit.quote,
          location,
          locationNote: location ? null : "quote matched only after whitespace/Unicode normalisation; position not reported",
        };
      }),
      usedIn: uses.get(c.id) ?? [],
    };
  });

  const sources: LedgerSource[] = report.snapshots.map((s) => ({
    sourceId: s.id,
    title: s.title,
    publisher: s.publisher,
    url: s.url,
    publishedAt: s.publishedAt,
    retrievedAt: s.retrievedAt,
    originId: s.originId,
    derivedFrom: [...s.derivedFromSnapshotIds],
    independenceVerified: s.independenceVerified,
    contentSha256: sha256Hex(s.content),
    editCheckSha256: s.integritySha256,
    citedByClaimIds: report.claims.filter((c) => c.citations.some((x) => x.snapshotId === s.id)).map((c) => c.id).sort(),
  }));

  const supportOf = (assumptionId: string): InputSupport => {
    const a = report.assumptions.find((x) => x.id === assumptionId)!;
    if (a.basis.kind !== "claim") return "operator_assumption";
    return claimById.get(a.basis.claimId)!.type === "fact" ? "sourced_fact" : "derived_estimate";
  };
  const assumptions: LedgerAssumption[] = report.assumptions.map((a) => ({
    assumptionId: a.id,
    label: a.label,
    value: a.value,
    unit: a.unit,
    support: supportOf(a.id),
    claimId: a.basis.kind === "claim" ? a.basis.claimId : null,
    rationale: a.basis.kind === "assumption" ? a.basis.rationale : null,
    usedInScenarios: scenarioResults.filter((r) => r.inputs.includes(a.id)).map((r) => r.name),
  }));

  const scenarios: LedgerScenario[] = scenarioResults.map((r) => {
    const inputs = r.inputs.map((assumptionId) => ({ assumptionId, support: supportOf(assumptionId) }));
    const count = (support: InputSupport) => inputs.filter((x) => x.support === support).length;
    return {
      name: r.name,
      role: ROLE[r.name],
      currency: r.currency,
      startupCostMinor: r.startupCostMinor,
      monthlyProfitMinor: r.monthlyProfitMinor,
      cumulativeProfitMinor: r.cumulativeProfitMinor,
      horizonMonths: r.horizonMonths,
      breakEvenMonth: r.breakEvenMonth,
      arithmetic: "recalculated_by_phase0",
      inputs,
      sourcedFactInputs: count("sourced_fact"),
      derivedEstimateInputs: count("derived_estimate"),
      operatorAssumptionInputs: count("operator_assumption"),
    };
  });

  const criteria: LedgerCriterion[] = score.criteria.map((c) => ({
    criterionId: c.criterionId,
    label: c.label,
    score: c.score,
    evidenceGrade: c.grade,
    independentOrigins: c.independentSources,
    distinctOrigins: c.distinctOrigins,
    corroboration: c.corroboration,
    claimIds: [...c.claimIds],
    flags: [...c.flags],
  }));

  // Operator-recorded contradictions (all unresolved): both sides stay visible with their sources.
  const contradictions: ContradictionRecord[] = judgments.contradictions.map((c) => ({
    contradictionId: c.id,
    claims: c.claimIds.map((claimId) => {
      const claim = claimById.get(claimId)!;
      return { claimId, kind: KIND[claim.type], sourceIds: [...new Set(claim.citations.map((x) => x.snapshotId))] };
    }),
    description: c.description,
    assessedBy: c.assessedBy,
    assessedAt: c.assessedAt,
    origin: "operator_assessment",
    status: "unresolved",
  }));
  const contradicted = new Map<string, string[]>();
  for (const c of judgments.contradictions) for (const claimId of c.claimIds) contradicted.set(claimId, [...(contradicted.get(claimId) ?? []), c.id]);

  // Operator-recorded negative findings: each applies only if every condition holds (problems in a fixed order).
  const negativeFindings: NegativeFindingRecord[] = judgments.negativeFindings.map((f) => {
    const g = score.gates.find((x) => x.gateId === f.gateId)!;
    const problems: string[] = [];
    if (g.status !== "fail") problems.push(`the gate is not marked failed (Phase 0 status: ${g.status})`);
    if (!sameIdSet(f.claimIds, g.claimIds)) {
      problems.push(`the finding's claims (${[...f.claimIds].sort().join(", ")}) are not exactly the gate's cited claims (${[...new Set(g.claimIds)].sort().join(", ") || "none"})`);
    }
    const notSourced = f.claimIds.filter((claimId) => claimById.get(claimId)!.type !== "fact" || verification.get(claimId)!.status !== "supported");
    if (notSourced.length > 0) problems.push(`claim(s) ${notSourced.join(", ")} are not supported sourced facts`);
    if (g.grade !== "A" && g.grade !== "B") problems.push(`the cited evidence is grade ${g.grade}; grade A or B is required`);
    if (g.relevance === null || !sameIdSet(g.relevance.assessedClaimIds, g.claimIds)) problems.push("the gate has no relevance assessment for exactly its cited claims");
    const disputed = f.claimIds.filter((claimId) => contradicted.has(claimId));
    if (disputed.length > 0) {
      problems.push(`claim(s) ${disputed.join(", ")} are in unresolved contradiction(s) ${[...new Set(disputed.flatMap((x) => contradicted.get(x)!))].join(", ")}`);
    }
    return {
      gateId: f.gateId, claimIds: [...f.claimIds], direction: f.direction, assessedBy: f.assessedBy, assessedAt: f.assessedAt, rationale: f.rationale,
      origin: "operator_assessment", applied: problems.length === 0, problems,
    };
  });
  const confirmedGateIds = new Set(negativeFindings.filter((f) => f.applied).map((f) => f.gateId));

  const gates: LedgerGate[] = score.gates.map((g) => ({
    gateId: g.gateId,
    label: HARD_GATES.find((h) => h.id === g.gateId)!.label,
    status: g.status,
    finding: g.status === "pass" ? "passed"
      : g.status !== "fail" ? "insufficient_evidence"
      : confirmedGateIds.has(g.gateId) ? "confirmed_failure" : "unconfirmed_failure",
    evidenceGrade: g.grade,
    claimIds: [...g.claimIds],
    relevanceAssessed: g.relevance !== null,
  }));

  // Evidence gaps (insufficient evidence), in a fixed order with stable ids.
  const gaps: LedgerQuestion[] = [];
  const gap = (questionId: string, text: string) => gaps.push({ questionId, origin: "evidence_gap", text });
  for (const c of criteria) {
    if (c.evidenceGrade === "D") gap(`gap-criterion-${c.criterionId}`, `Criterion "${c.label}": no quote-verified evidence supports the score (grade D).`);
    else if (c.evidenceGrade === "C") gap(`gap-criterion-${c.criterionId}`, `Criterion "${c.label}": only one stale or undated origin (grade C).`);
    if (c.corroboration === "unverified_independence") {
      gap(`gap-criterion-${c.criterionId}-independence`, `Criterion "${c.label}": ${c.distinctOrigins} origins cited, but their independence is not verified.`);
    }
  }
  const GATE_GAP: Partial<Record<GateStatus, string>> = {
    pass_unverified: "marked passed without quote-verified evidence",
    weak: "only weak grade-C evidence (one stale or undated origin)",
    cited_relevance_unverified: "evidence cited, but its relevance to the gate is not assessed for exactly the cited claims",
  };
  for (const g of gates) {
    const text = GATE_GAP[g.status];
    if (text) gap(`gap-gate-${g.gateId}`, `Hard gate "${g.label}": ${text}.`);
    if (g.finding === "unconfirmed_failure") {
      gap(`gap-gate-${g.gateId}-unconfirmed-failure`,
        `Hard gate "${g.label}": marked failed, but no applicable operator-recorded negative finding shows that the cited evidence supports the failure (an unconfirmed finding to verify).`);
    }
  }
  for (const f of negativeFindings) {
    if (!f.applied) gap(`gap-finding-${f.gateId}-not-applied`, `Negative finding for gate "${f.gateId}" (operator assessment) does not apply: ${f.problems.join("; ")}.`);
  }
  for (const c of contradictions) {
    gaps.push({
      questionId: `contradiction-${c.contradictionId}`, origin: "operator_contradiction",
      text: `Unresolved contradiction (operator assessment) between claims ${c.claims.map((x) => x.claimId).join(", ")}: ${c.description}`,
    });
  }
  const sourceConflicts: LedgerSourceConflict[] = sourceIdentityConflicts(report.snapshots).map((c) => ({
    conflictId: `conflict-${c.kind}-${c.snapshotIds.join("-")}`, kind: c.kind, sourceIds: [...c.snapshotIds], originIds: [...c.originIds],
  }));
  for (const c of sourceConflicts) {
    gap(`gap-${c.conflictId}`, `Sources ${c.sourceIds.join(", ")} are the same ${c.kind === "url" ? "web address" : "text"} but declare different origins (${c.originIds.join(", ")}).`);
  }
  for (const c of report.sections.competitors) {
    if (c.priceClaimId === null) gap(`gap-competitor-${sha256Hex(c.name).slice(0, 12)}-price`, `Competitor "${c.name}": price not found.`);
  }
  for (const s of sources) {
    if (!s.independenceVerified) gap(`gap-source-${s.sourceId}-independence`, `Source ${s.sourceId}: independence not verified (adds no corroboration).`);
    if (s.publishedAt === null) gap(`gap-source-${s.sourceId}-undated`, `Source ${s.sourceId}: no publication date (treated as stale).`);
  }
  const baseCase = scenarios.find((s) => s.role === "base_case")!;
  if (baseCase.sourcedFactInputs < baseCase.inputs.length) {
    gap("gap-financial-inputs", `Base case: ${baseCase.inputs.length - baseCase.sourcedFactInputs} of ${baseCase.inputs.length} inputs are not sourced facts ` +
      `(${baseCase.operatorAssumptionInputs} operator assumption(s), ${baseCase.derivedEstimateInputs} derived estimate(s)).`);
  }

  const operatorQuestions: LedgerQuestion[] = [];
  for (const text of report.sections.missingInformation) {
    const questionId = `q-${sha256Hex(text).slice(0, 12)}`;
    if (!operatorQuestions.some((q) => q.questionId === questionId)) operatorQuestions.push({ questionId, origin: "operator", text });
  }

  const assessment = assess(gates, sourceConflicts, negativeFindings, contradictions, gaps, score);

  return freezeDeep({
    version: LEDGER_VERSION,
    reportId: report.id,
    asOf: report.asOf,
    notice: LEDGER_NOTICE,
    quoteVerification: QUOTE_VERIFICATION_LEGEND,
    sources,
    claims,
    assumptions,
    scenarios,
    criteria,
    gates,
    sourceConflicts,
    negativeFindings,
    contradictions,
    assessment,
    unresolvedQuestions: [...operatorQuestions, ...gaps],
    warnings: [...v.warnings],
  });
}

/** The evidence-aware research assessment: a fixed rule over Phase 0's own results (no re-scoring). */
function assess(
  gates: readonly LedgerGate[], conflicts: readonly LedgerSourceConflict[], findings: readonly NegativeFindingRecord[],
  contradictions: readonly ContradictionRecord[], gaps: readonly LedgerQuestion[],
  score: { verdict: Verdict; verdictReason: string; total: number; confidence: string },
): ResearchAssessment {
  const confirmed = gates.filter((g) => g.finding === "confirmed_failure");
  const unconfirmed = gates.filter((g) => g.finding === "unconfirmed_failure");
  const notApplied = findings.filter((f) => !f.applied);
  const notPassed = gates.filter((g) => g.finding === "insufficient_evidence");
  const lowConfidence = score.confidence === "low";
  const lowScore = score.total < VERDICT_THRESHOLDS.watch;
  const status: AssessmentStatus = confirmed.length > 0 ? "rejected_by_gate"
    : unconfirmed.length > 0 || notApplied.length > 0 || notPassed.length > 0 || conflicts.length > 0 || contradictions.length > 0 || lowConfidence || lowScore
      ? "incomplete" : "supported_for_consideration";

  const reasons: string[] = [];
  for (const g of confirmed) {
    const f = findings.find((x) => x.gateId === g.gateId && x.applied)!;
    reasons.push(`Hard gate "${g.label}" failed: ${f.assessedBy} recorded on ${f.assessedAt} that the cited grade ${g.evidenceGrade} evidence ` +
      "supports the failed condition. This is an operator assessment, not an automatically verified fact.");
  }
  for (const g of unconfirmed) {
    reasons.push(`Hard gate "${g.label}" is marked failed (cited evidence grade ${g.evidenceGrade}; relevance ${g.relevanceAssessed ? "assessed" : "not assessed"}): ` +
      "an unconfirmed failure to verify, not a rejection. No applicable operator-recorded negative finding shows that the cited evidence supports the failure.");
  }
  for (const f of notApplied) reasons.push(`The negative finding recorded for gate "${f.gateId}" does not apply: ${f.problems.join("; ")}.`);
  for (const c of contradictions) {
    reasons.push(`Unresolved contradiction "${c.contradictionId}" between claims ${c.claims.map((x) => x.claimId).join(", ")} (operator assessment).`);
  }
  for (const g of notPassed) reasons.push(`Hard gate "${g.label}" is not shown as passed (${g.status}, evidence grade ${g.evidenceGrade}): evidence is missing or weak.`);
  for (const c of conflicts) reasons.push(`Sources ${c.sourceIds.join(", ")} conflict: the same ${c.kind === "url" ? "web address" : "text"} is declared with different origins.`);
  if (lowConfidence) reasons.push("Overall evidence confidence is low (Phase 0): most criterion weight lacks grade A/B evidence.");
  if (lowScore) reasons.push(`The aggregate score ${score.total} is below ${VERDICT_THRESHOLDS.watch}: a scoring output from the operator's criterion scores, not a gate finding.`);
  if (status === "supported_for_consideration") {
    reasons.push(`Every hard gate passes under Phase 0's rules; overall confidence is ${score.confidence}; the aggregate score is ${score.total}.`);
    reasons.push("This is preliminary screening only: it does not establish demand, profitability or commercial viability.");
  }
  reasons.push(gaps.length > 0 ? `${gaps.length} evidence gap(s) are recorded in the ledger and remain open.` : "No evidence gaps were flagged by these checks.");

  let phase0Relation: string;
  if (status === "rejected_by_gate") {
    phase0Relation = `Phase 0's report below says "Reject" (${score.verdictReason}); this assessment agrees because of the operator-recorded ` +
      `negative finding(s) for: ${confirmed.map((g) => g.gateId).join(", ")}. The opportunity can be reassessed if that evidence changes.`;
  } else if (score.verdict === "reject") {
    phase0Relation = `Phase 0's report below says "Reject" (${score.verdictReason}). That is Phase 0's verdict from the operator's scores and gate marks. ` +
      `It is not a confirmed rejection of the opportunity: ${unconfirmed.length > 0 ? "the failed hard gate(s) are unconfirmed findings" : "no hard gate failed"}, ` +
      "so the research is incomplete and the opportunity stays open for reassessment.";
  } else if (status === "supported_for_consideration") {
    phase0Relation = `Phase 0's report below gives the scoring verdict "${score.verdict}" (${score.verdictReason}).`;
  } else {
    phase0Relation = `Phase 0's report below gives the scoring verdict "${score.verdict}" (${score.verdictReason}); the research is still incomplete for the reasons above.`;
  }

  return {
    status,
    reasons,
    confirmedFailedGates: confirmed.map((g) => g.gateId),
    unconfirmedFailedGates: unconfirmed.map((g) => g.gateId),
    negativeFindingsNotApplied: notApplied.map((f) => f.gateId),
    contradictionIds: contradictions.map((c) => c.contradictionId),
    gatesNotPassed: notPassed.map((g) => g.gateId),
    sourceConflictIds: conflicts.map((c) => c.conflictId),
    gapIds: gaps.map((g) => g.questionId),
    phase0Verdict: score.verdict,
    phase0VerdictReason: score.verdictReason,
    phase0Total: score.total,
    phase0Confidence: score.confidence,
    phase0Relation,
    failureConfirmation: FAILURE_CONFIRMATION,
    limits: ASSESSMENT_LIMITS,
    reassessment: "open",
  };
}

const ASSESSMENT_LABEL: Record<AssessmentStatus, string> = {
  supported_for_consideration: "SUPPORTED FOR CONSIDERATION (preliminary screening): the evidence supports further evaluation; it does not establish demand, profitability or commercial viability",
  incomplete: "INCOMPLETE: evidence is missing, weak or conflicting (this is not a rejection)",
  rejected_by_gate: "REJECTED BY HARD GATE: an operator-recorded negative finding confirms a failed hard gate (operator assessment, not automatically verified)",
};

/**
 * Renders the research assessment as the opening section of the assembled
 * report (before Phase 0's unchanged report). All text is escaped.
 */
export function renderResearchAssessment(ledger: EvidenceLedger): string {
  const e = escapeInline;
  const a = ledger.assessment;
  const out: string[] = [];
  out.push("# Research assessment (Phase 1A, evidence-aware)", "");
  out.push(`**Research assessment: ${ASSESSMENT_LABEL[a.status]}**`, "");
  out.push(...a.reasons.map((r) => `- ${e(r)}`), "");
  out.push(e(a.phase0Relation), "");
  if (a.confirmedFailedGates.length > 0 || a.unconfirmedFailedGates.length > 0) out.push(`**Failed gates:** ${e(a.failureConfirmation)}`, "");
  if (ledger.negativeFindings.length > 0) {
    out.push("**Operator-recorded negative findings** (operator assessments, not automatically verified):", "");
    for (const f of ledger.negativeFindings) {
      out.push(`- Gate ${e(f.gateId)}, claims ${f.claimIds.map((c) => e(c)).join(", ")} -- ${f.applied ? "APPLIED" : "NOT APPLIED"} ` +
        `(by ${e(f.assessedBy)}, ${e(f.assessedAt)}): ${e(f.rationale)}${f.applied ? "" : ` -- not applied because: ${e(f.problems.join("; "))}`}`);
    }
    out.push("");
  }
  if (ledger.contradictions.length > 0) {
    out.push("**Operator-recorded contradictions** (unresolved; operator assessments, not automatically verified):", "");
    for (const c of ledger.contradictions) {
      out.push(`- ${e(c.contradictionId)}: claims ${c.claims.map((x) => e(x.claimId)).join(" vs ")} (by ${e(c.assessedBy)}, ${e(c.assessedAt)}): ${e(c.description)}`);
    }
    out.push("");
  }
  out.push(`**Limits:** ${e(a.limits)}`, "");
  out.push("The opportunity remains open for reassessment when new evidence is supplied. Evidence gaps, source conflicts and unresolved questions are listed in the evidence ledger (Appendix A3).", "");
  out.push(`_${e(ledger.notice)}_`, "", "---", "");
  return out.join("\n");
}

/**
 * Renders the ledger as Markdown appendices. Every piece of text is escaped
 * with Phase 0's escapeInline (one line; Markdown, HTML and link syntax
 * neutralised); URLs use Phase 0's renderUrl. Formatting only: rendering does
 * not validate the ledger.
 */
export function renderEvidenceLedger(ledger: EvidenceLedger): string {
  const e = escapeInline;
  const out: string[] = [];
  out.push("---", "", "# Appendices (Phase 1A pipeline, offline)", "", `_${e(ledger.notice)}_`, "");

  out.push("## A1. Financial scenarios: projections from assumptions, not established outcomes", "");
  out.push("Arithmetic: each figure is Phase 0's deterministic recalculation from the stated inputs. Correct arithmetic does not make the inputs true; " +
    "commercial evidence is shown separately: how many inputs rest on sourced facts, derived estimates or operator assumptions.", "");
  out.push("| Scenario | Role | Monthly profit (projected) | Cumulative over horizon (projected) | Break-even (projected) | Inputs from sourced facts | From derived estimates | Operator assumptions |",
    "|---|---|---|---|---|---|---|---|");
  for (const s of ledger.scenarios) {
    out.push(`| ${e(s.name)} | ${ROLE_LABEL[s.role]} | ${formatMoney(s.monthlyProfitMinor, s.currency)} | ${formatMoney(s.cumulativeProfitMinor, s.currency)} | ` +
      `${s.breakEvenMonth === null ? `not within ${s.horizonMonths} months` : `month ${s.breakEvenMonth}`} | ${s.sourcedFactInputs} of ${s.inputs.length} | ${s.derivedEstimateInputs} of ${s.inputs.length} | ${s.operatorAssumptionInputs} of ${s.inputs.length} |`);
  }
  out.push("");
  out.push("Base case: the realistic scenario. It is a projection from the assumptions above, not an established or expected outcome.", "");
  for (const s of ledger.scenarios) {
    if (s.monthlyProfitMinor <= 0 || s.cumulativeProfitMinor < 0) {
      out.push(`- ${ROLE_LABEL[s.role]} (${e(s.name)}): the projected profit is not positive under these assumptions. This follows from the inputs; it is not evidence about actual profitability.`);
    }
  }
  out.push("");
  out.push("| Assumption | Value | Unit | Support | Used in |", "|---|---|---|---|---|");
  for (const a of ledger.assumptions) {
    const support = a.support === "operator_assumption"
      ? `operator assumption (unverified): ${e(a.rationale ?? "")}`
      : `${a.support === "sourced_fact" ? "sourced fact" : "derived estimate"} claim ${e(a.claimId ?? "")}`;
    out.push(`| ${e(a.assumptionId)}: ${e(a.label)} | ${a.value} | ${e(a.unit)} | ${support} | ${a.usedInScenarios.map((n) => e(n)).join(", ") || "none"} |`);
  }
  out.push("");

  out.push("## A2. Gates and criteria (Phase 0 results)", "");
  out.push(`Research assessment: ${e(ledger.assessment.status)} (see the opening section). Missing or weak evidence is listed as a gap, never as a negative finding.`, "");
  out.push("| Hard gate | Status | Finding | Evidence grade | Relevance assessed |", "|---|---|---|---|---|");
  for (const g of ledger.gates) {
    out.push(`| ${e(g.label)} | ${e(g.status)} | ${e(g.finding)} | ${g.evidenceGrade} | ${g.relevanceAssessed ? "yes" : "no"} |`);
  }
  out.push("", "| Criterion | Score (0-5) | Evidence grade | Independent origins | Distinct origins |", "|---|---|---|---|---|");
  for (const c of ledger.criteria) out.push(`| ${e(c.label)} | ${c.score} | ${c.evidenceGrade} | ${c.independentOrigins} | ${c.distinctOrigins} |`);
  out.push("");

  out.push("## A3. Evidence ledger", "", e(ledger.quoteVerification), "", "### Sources", "");
  out.push("| Source | Title | Publisher | URL | Published | Origin | Independence | Text SHA-256 | Cited by |", "|---|---|---|---|---|---|---|---|---|");
  for (const s of ledger.sources) {
    out.push(`| ${e(s.sourceId)} | ${e(s.title)} | ${e(s.publisher)} | ${renderUrl(s.url)} | ${s.publishedAt ?? "undated"} | ${e(s.originId)} | ` +
      `${s.independenceVerified ? "checked" : "UNVERIFIED"} | ${s.contentSha256.slice(0, 16)} | ${s.citedByClaimIds.map((c) => e(c)).join(", ") || "not cited"} |`);
  }
  out.push("", "### Claims", "");
  for (const c of ledger.claims) {
    out.push(`- **${e(c.claimId)}** (${KIND_LABEL[c.kind]}; ${e(c.verification)}; evidence grade ${c.evidenceGrade}): ${e(c.statement)}`);
    if (c.method !== null) out.push(`  - Method: ${e(c.method)}`);
    for (const cit of c.citations) {
      const where = cit.location
        ? `line ${cit.location.line}, column ${cit.location.column}${cit.location.occurrences === "multiple" ? " (first of several occurrences)" : ""}`
        : e(cit.locationNote ?? "");
      out.push(`  - Source ${e(cit.sourceId)}, quote: "${e(cit.quote)}" (${where})`);
    }
    out.push(`  - Used in: ${c.usedIn.map((u) => e(u)).join("; ") || "not used"}`);
  }
  out.push("", "### Operator judgments (operator assessments, not automatically verified)", "");
  if (ledger.negativeFindings.length === 0 && ledger.contradictions.length === 0) out.push("- none recorded");
  for (const f of ledger.negativeFindings) {
    out.push(`- Negative finding for gate ${e(f.gateId)} (direction: ${e(f.direction)}; ${f.applied ? "applied" : "not applied"}), claims ` +
      `${f.claimIds.map((c) => e(c)).join(", ")}, by ${e(f.assessedBy)} on ${e(f.assessedAt)}: ${e(f.rationale)}`);
    for (const problem of f.problems) out.push(`  - Not applied: ${e(problem)}`);
  }
  for (const c of ledger.contradictions) {
    out.push(`- Contradiction ${e(c.contradictionId)} (${e(c.status)}), by ${e(c.assessedBy)} on ${e(c.assessedAt)}: ${e(c.description)}`);
    for (const x of c.claims) {
      const claim = ledger.claims.find((y) => y.claimId === x.claimId);
      out.push(`  - ${e(x.claimId)} (${KIND_LABEL[x.kind]}; sources ${x.sourceIds.map((sid) => e(sid)).join(", ")}): ${e(claim?.statement ?? "")}`);
    }
  }
  out.push("", "### Source conflicts", "");
  if (ledger.sourceConflicts.length === 0) out.push("- none reported by Phase 0 (contradictions between what sources say are not detected automatically)");
  for (const c of ledger.sourceConflicts) {
    out.push(`- ${e(c.conflictId)}: sources ${c.sourceIds.map((x) => e(x)).join(", ")} share the same ${c.kind === "url" ? "web address" : "text"} but declare origins ${c.originIds.map((x) => e(x)).join(", ")}`);
  }
  out.push("", "### Unresolved questions", "");
  for (const q of ledger.unresolvedQuestions) {
    out.push(`- ${e(q.questionId)} (${q.origin === "operator" ? "operator note, unverified free text" : "evidence gap"}): ${e(q.text)}`);
  }
  out.push("");
  return out.join("\n");
}
