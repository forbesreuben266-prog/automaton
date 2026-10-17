/**
 * Transparent opportunity scoring.
 *
 * Score and confidence are separate outputs and are never combined:
 * - score (0-100) is the weighted sum of criterion scores (0-5 each);
 * - confidence (low/medium/high) comes only from the evidence grades.
 * A criterion may score above 3 only with at least two independent verified
 * sources. Hard gates override the score: any failed gate means "reject".
 * A gate is shown as PASS only if it cites quote-verified evidence of grade
 * A or B AND the operator recorded a relevance assessment against the gate's
 * defined criterion. A matching quote alone never establishes relevance.
 * Every other "passed" gate (no evidence, weak grade-C evidence, or cited
 * evidence with unassessed relevance) is labelled as such and caps the
 * verdict at "watch". Gates never affect confidence.
 */

import { gradeEvidenceSets, type Corroboration, type EvidenceGrade } from "./citations.js";
import { Issues, arr, bool, checkKeys, deepFreeze, id, isoDateTime, oneOf, safeInt, str, uniqueIds } from "./validation.js";

export const CRITERIA = [
  { id: "demand_evidence", label: "Demand evidence", weight: 20 },
  { id: "problem_severity", label: "Problem severity / willingness to pay", weight: 15 },
  { id: "upfront_cost", label: "Low upfront cost", weight: 15 },
  { id: "unit_economics", label: "Unit economics", weight: 15 },
  { id: "competitive_gap", label: "Competitive gap", weight: 10 },
  { id: "time_to_revenue", label: "Time to first revenue", weight: 10 },
  { id: "acquisition_feasibility", label: "Customer acquisition feasibility", weight: 10 },
  { id: "regulatory_risk", label: "Low regulatory / legal risk", weight: 5 },
] as const;
export type CriterionId = (typeof CRITERIA)[number]["id"];
const CRITERION_IDS = CRITERIA.map((c) => c.id) as readonly CriterionId[];

export const HARD_GATES = [
  {
    id: "legal",
    label: "Legal to operate where intended",
    relevanceCriterion: "legal-permitted-in-jurisdiction",
    criterionText: "The evidence states whether the intended activity is permitted in the intended jurisdiction.",
  },
  {
    id: "licence",
    label: "No licence the operator lacks",
    relevanceCriterion: "licence-requirement-stated",
    criterionText: "The evidence states whether a licence, permit or registration is required for the intended activity.",
  },
  {
    id: "upfront_cap",
    label: "Upfront cost within the operator's cap",
    relevanceCriterion: "startup-cost-item-priced",
    criterionText: "The evidence prices a startup cost item that the scenarios use.",
  },
] as const;
export type HardGateId = (typeof HARD_GATES)[number]["id"];
const GATE_IDS = HARD_GATES.map((g) => g.id) as readonly HardGateId[];

/** Minimum independent verified sources for a criterion score above 3. */
export const HIGH_SCORE_MIN_SOURCES = 2;
export const VERDICT_THRESHOLDS = { pursue: 65, watch: 45 } as const;

export interface CriterionScoreInput {
  readonly criterionId: CriterionId;
  readonly score: number;
  readonly rationale: string;
  readonly claimIds: readonly string[];
}

/**
 * The operator's explicit judgement that specific cited evidence meets the
 * gate's defined relevance criterion. Recorded as data; the code can't
 * assess relevance itself.
 *
 * `assessedClaimIds` binds the judgement to exact evidence. Policy: order
 * doesn't matter; duplicates in `assessedClaimIds` are invalid input
 * (rejected); the gate can show PASS only if the set of assessed ids equals
 * the set of the gate's cited `claimIds`. Any difference means the
 * assessment covers different evidence and the gate stays
 * CITED — RELEVANCE UNVERIFIED.
 */
export interface RelevanceAssessment {
  readonly criterion: string;
  readonly assessedClaimIds: readonly string[];
  readonly assessedBy: string;
  readonly assessedAt: string;
  readonly rationale: string;
}

export interface HardGateInput {
  readonly gateId: HardGateId;
  readonly passed: boolean;
  readonly note: string;
  /** Claims supporting the gate decision. */
  readonly claimIds: readonly string[];
  /** null = relevance not assessed: the gate can't show PASS. */
  readonly relevance: RelevanceAssessment | null;
}

/**
 * pass:                       grade A/B evidence and relevance assessed against the defined criterion for exactly the cited claims
 * cited_relevance_unverified: grade A/B evidence, relevance not assessed or assessed for different evidence ("CITED — RELEVANCE UNVERIFIED")
 * weak:                       grade C evidence (one stale/undated origin), whether or not relevance was assessed
 * pass_unverified:            marked passed with no quote-verified evidence
 * fail:                       marked failed
 */
export type GateStatus = "pass" | "cited_relevance_unverified" | "weak" | "pass_unverified" | "fail";

export interface HardGateResult extends HardGateInput {
  readonly status: GateStatus;
  readonly grade: EvidenceGrade;
  /** Why relevance is unverified when status is cited_relevance_unverified; otherwise null. */
  readonly relevanceIssue: string | null;
  /** Origins counted as independent (checked independence only; see citations.ts). */
  readonly independentSources: number;
  /** All distinct origins behind the gate's quote-verified evidence. */
  readonly distinctOrigins: number;
  /** Origin groups whose independence wasn't checked. */
  readonly unverifiedOrigins: number;
  readonly corroboration: Corroboration;
}

export type Confidence = "low" | "medium" | "high";
export type Verdict = "pursue_to_validation" | "watch" | "reject";

export interface CriterionResult {
  readonly criterionId: CriterionId;
  readonly label: string;
  readonly weight: number;
  readonly score: number;
  /** weight × score ÷ 5: this criterion's contribution to the 0-100 total. */
  readonly weighted: number;
  readonly rationale: string;
  readonly claimIds: readonly string[];
  readonly grade: EvidenceGrade;
  /** Origins counted as independent (checked independence only; see citations.ts). */
  readonly independentSources: number;
  /** All distinct origins, including ones whose independence is unchecked. */
  readonly distinctOrigins: number;
  readonly corroboration: Corroboration;
  /** Human-readable warnings, e.g. missing evidence or unsupported claims. */
  readonly flags: readonly string[];
}

export interface ScoreResult {
  readonly total: number;
  readonly confidence: Confidence;
  readonly criteria: readonly CriterionResult[];
  readonly gates: readonly HardGateResult[];
  readonly failedGates: readonly HardGateId[];
  /** Marked passed with no quote-verified evidence. */
  readonly unverifiedGates: readonly HardGateId[];
  /** Grade-C evidence only. */
  readonly weakGates: readonly HardGateId[];
  /** Grade A/B evidence but relevance not assessed. */
  readonly relevanceUnverifiedGates: readonly HardGateId[];
  readonly verdict: Verdict;
  readonly verdictReason: string;
}

export function parseScoring(raw: unknown): { scores: CriterionScoreInput[]; gates: HardGateInput[] } {
  const issues = new Issues();
  if (!checkKeys(issues, "scoring", raw, ["scores", "gates"])) issues.throwIfAny();
  const r = raw as Record<string, unknown>;
  const scores = arr(issues, "scoring.scores", r.scores, { max: 20 }).map((s, i): CriterionScoreInput => {
    const p = `scoring.scores[${i}]`;
    if (!checkKeys(issues, p, s, ["criterionId", "score", "rationale", "claimIds"])) return undefined as never;
    return {
      criterionId: oneOf(issues, `${p}.criterionId`, s.criterionId, CRITERION_IDS),
      score: safeInt(issues, `${p}.score`, s.score, { min: 0, max: 5 }),
      rationale: str(issues, `${p}.rationale`, s.rationale, { max: 2_000 }),
      claimIds: arr(issues, `${p}.claimIds`, s.claimIds, { max: 50 }).map((c, j) => id(issues, `${p}.claimIds[${j}]`, c)),
    };
  });
  const gates = arr(issues, "scoring.gates", r.gates, { max: 10 }).map((g, i): HardGateInput => {
    const p = `scoring.gates[${i}]`;
    if (!checkKeys(issues, p, g, ["gateId", "passed", "note", "claimIds", "relevance"])) return undefined as never;
    const gateId = oneOf(issues, `${p}.gateId`, g.gateId, GATE_IDS);
    let relevance: RelevanceAssessment | null = null;
    const r = g.relevance;
    if (r !== null && checkKeys(issues, `${p}.relevance`, r, ["criterion", "assessedClaimIds", "assessedBy", "assessedAt", "rationale"])) {
      const expected = HARD_GATES.find((h) => h.id === gateId)!.relevanceCriterion;
      const criterion = str(issues, `${p}.relevance.criterion`, r.criterion, { max: 64 });
      if (criterion && criterion !== expected) {
        issues.add(`${p}.relevance.criterion`, `must be the gate's defined criterion "${expected}"`);
      }
      const assessedClaimIds = arr(issues, `${p}.relevance.assessedClaimIds`, r.assessedClaimIds, { min: 1, max: 50 })
        .map((c, j) => id(issues, `${p}.relevance.assessedClaimIds[${j}]`, c));
      uniqueIds(issues, `${p}.relevance.assessedClaimIds`, assessedClaimIds);
      relevance = {
        criterion,
        assessedClaimIds,
        assessedBy: str(issues, `${p}.relevance.assessedBy`, r.assessedBy, { max: 200 }),
        assessedAt: isoDateTime(issues, `${p}.relevance.assessedAt`, r.assessedAt),
        rationale: str(issues, `${p}.relevance.rationale`, r.rationale, { max: 2_000 }),
      };
    }
    return {
      gateId,
      passed: bool(issues, `${p}.passed`, g.passed),
      note: str(issues, `${p}.note`, g.note, { max: 2_000 }),
      claimIds: arr(issues, `${p}.claimIds`, g.claimIds, { max: 50 }).map((c, j) => id(issues, `${p}.claimIds[${j}]`, c)),
      relevance,
    };
  });
  issues.throwIfAny();
  const exactlyOnce = (path: string, expected: readonly string[], actual: string[]) => {
    for (const e of expected) {
      const n = actual.filter((a) => a === e).length;
      if (n !== 1) issues.add(path, `"${e}" must appear exactly once (found ${n})`);
    }
  };
  exactlyOnce("scoring.scores", CRITERION_IDS, scores.map((s) => s.criterionId));
  exactlyOnce("scoring.gates", GATE_IDS, gates.map((g) => g.gateId));
  issues.throwIfAny();
  return deepFreeze({ scores, gates });
}

/** Order-insensitive set equality; `assessed` has no duplicates (enforced by parseScoring). */
function sameIdSet(assessed: readonly string[], cited: readonly string[]): boolean {
  const citedSet = new Set(cited);
  return assessed.length === citedSet.size && assessed.every((x) => citedSet.has(x));
}

/**
 * Scores an opportunity. Every input is re-validated here (scoring schema,
 * claims, snapshots with integrity hashes, report date); evidence is
 * recomputed, never taken from the caller.
 */
export function scoreOpportunity(scoring: unknown, claims: unknown, snapshots: unknown, asOf: unknown): ScoreResult {
  const input = parseScoring(scoring);
  // Criteria in CRITERIA order, then gates in HARD_GATES order (parseScoring guarantees each exactly once).
  const orderedScores = CRITERIA.map((c) => input.scores.find((x) => x.criterionId === c.id)!);
  const orderedGates = HARD_GATES.map((g) => input.gates.find((x) => x.gateId === g.id)!);
  const assessments = gradeEvidenceSets(
    [...orderedScores.map((s) => s.claimIds), ...orderedGates.map((g) => g.claimIds)], claims, snapshots, asOf);
  const issues = new Issues();
  const criteria: CriterionResult[] = CRITERIA.map((c, index) => {
    const s = orderedScores[index];
    const evidence = assessments[index];
    const flags: string[] = [];
    if (evidence.unknownClaimIds.length > 0) {
      issues.add(`scoring.${c.id}`, `references unknown claim(s): ${evidence.unknownClaimIds.join(", ")}`);
    }
    if (s.score > 3 && evidence.independentSources < HIGH_SCORE_MIN_SOURCES) {
      issues.add(`scoring.${c.id}`, `score ${s.score} needs at least ${HIGH_SCORE_MIN_SOURCES} independent verified sources (has ${evidence.independentSources}` +
        (evidence.unverifiedOrigins > 0 ? `; ${evidence.unverifiedOrigins} origin(s) have unchecked independence and don't count)` : ")"));
    }
    if (evidence.corroboration === "unverified_independence") {
      flags.push(`UNVERIFIED INDEPENDENCE: ${evidence.distinctOrigins} origins cited but only ${evidence.independentSources} can be counted as independent`);
    }
    if (evidence.grade === "D") flags.push("MISSING EVIDENCE: no verified source supports this score");
    if (evidence.nonEvidenceClaimIds.length > 0) {
      flags.push(`claims giving no verified evidence (unsupported, invalid or labelled only): ${evidence.nonEvidenceClaimIds.join(", ")}`);
    }
    return {
      criterionId: c.id,
      label: c.label,
      weight: c.weight,
      score: s.score,
      weighted: (c.weight * s.score) / 5,
      rationale: s.rationale,
      claimIds: s.claimIds,
      grade: evidence.grade,
      independentSources: evidence.independentSources,
      distinctOrigins: evidence.distinctOrigins,
      corroboration: evidence.corroboration,
      flags,
    };
  });
  const gates: HardGateResult[] = orderedGates.map((g, index) => {
    const evidence = assessments[CRITERIA.length + index];
    if (evidence.unknownClaimIds.length > 0) {
      issues.add(`scoring.gates.${g.gateId}`, `references unknown claim(s): ${evidence.unknownClaimIds.join(", ")}`);
    }
    let status: GateStatus;
    let relevanceIssue: string | null = null;
    if (!g.passed) status = "fail";
    else if (evidence.grade === "D") status = "pass_unverified";
    else if (evidence.grade === "C") status = "weak";
    else if (g.relevance === null) {
      status = "cited_relevance_unverified"; // a matching quote doesn't establish relevance
      relevanceIssue = "relevance not assessed";
    } else if (!sameIdSet(g.relevance.assessedClaimIds, g.claimIds)) {
      status = "cited_relevance_unverified";
      relevanceIssue = `assessment covers different evidence (assessed: ${[...g.relevance.assessedClaimIds].sort().join(", ")}; ` +
        `cited: ${[...new Set(g.claimIds)].sort().join(", ") || "none"})`;
    } else {
      status = "pass";
    }
    return {
      ...g,
      status,
      grade: evidence.grade,
      relevanceIssue,
      independentSources: evidence.independentSources,
      distinctOrigins: evidence.distinctOrigins,
      unverifiedOrigins: evidence.unverifiedOrigins,
      corroboration: evidence.corroboration,
    };
  });
  issues.throwIfAny();

  // Integer arithmetic (weights sum to 100), then one division: exact to 0.2.
  const total = criteria.reduce((sum, c) => sum + c.weight * c.score, 0) / 5;
  const strongWeight = criteria.filter((c) => c.grade === "A" || c.grade === "B").reduce((sum, c) => sum + c.weight, 0);
  const confidence: Confidence = strongWeight >= 70 ? "high" : strongWeight >= 40 ? "medium" : "low";
  const failedGates = gates.filter((g) => g.status === "fail").map((g) => g.gateId);
  const unverifiedGates = gates.filter((g) => g.status === "pass_unverified").map((g) => g.gateId);
  const weakGates = gates.filter((g) => g.status === "weak").map((g) => g.gateId);
  const relevanceUnverifiedGates = gates.filter((g) => g.status === "cited_relevance_unverified").map((g) => g.gateId);
  const notPassed = [
    ...unverifiedGates.map((g) => `${g} (no quote-verified evidence)`),
    ...weakGates.map((g) => `${g} (weak grade-C evidence)`),
    ...gates.filter((g) => g.status === "cited_relevance_unverified").map((g) => `${g.gateId} (relevance unverified: ${g.relevanceIssue})`),
  ];

  let verdict: Verdict;
  let verdictReason: string;
  if (failedGates.length > 0) {
    verdict = "reject";
    verdictReason = `failed hard gate(s): ${failedGates.join(", ")}`;
  } else if (total >= VERDICT_THRESHOLDS.pursue && confidence !== "low" && notPassed.length > 0) {
    verdict = "watch";
    verdictReason = `score ${total} ≥ ${VERDICT_THRESHOLDS.pursue} but hard gate(s) not shown as PASS: ${notPassed.join(", ")} (capped at watch)`;
  } else if (total >= VERDICT_THRESHOLDS.pursue && confidence !== "low") {
    verdict = "pursue_to_validation";
    verdictReason = `score ${total} ≥ ${VERDICT_THRESHOLDS.pursue} with ${confidence} confidence`;
  } else if (total >= VERDICT_THRESHOLDS.watch) {
    verdict = "watch";
    verdictReason = total >= VERDICT_THRESHOLDS.pursue
      ? `score ${total} ≥ ${VERDICT_THRESHOLDS.pursue} but confidence is low (capped at watch)`
      : `score ${total} is between ${VERDICT_THRESHOLDS.watch} and ${VERDICT_THRESHOLDS.pursue}`;
  } else {
    verdict = "reject";
    verdictReason = `score ${total} < ${VERDICT_THRESHOLDS.watch}`;
  }

  return deepFreeze({
    total, confidence, criteria, gates, failedGates, unverifiedGates, weakGates, relevanceUnverifiedGates, verdict, verdictReason,
  });
}
