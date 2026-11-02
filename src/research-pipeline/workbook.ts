/**
 * Opportunity metadata and research workbook parsers (Phase 1A step 2). Pure
 * and deterministic: no filesystem, network, process, environment, clock,
 * model or Docker access.
 *
 * The workbook is the operator's analysis for one run: claims with quotes,
 * report sections, assumptions, scenarios, scores, gate relevance and
 * experiment proposals. Phase 1A makes no model calls, so every entry is
 * operator-written.
 *
 * Validation layers (each refuses; nothing is defaulted or invented):
 * 1. Phase 0's own exported parsers for claims (parseSourcesAndClaims),
 *    assumptions, scenarios, scoring and experiments, so their rules apply
 *    unchanged. Phase 0's section parser is internal: sections are checked
 *    here with the same limits, and Phase 0's validateReport (run on the
 *    assembled report in a later step) remains the final authority.
 * 2. Stricter pipeline rules that never relax Phase 0's: facts (the claims
 *    that depend on sources) must cite at least one source; speculation may
 *    not be hard-gate evidence or an assumption's basis; every referenced
 *    claim and assumption must exist. Phase 0 semantics are kept otherwise:
 *    an estimate is a derived figure whose method is required and which may
 *    cite sources (any citation must name a manifest source); speculation
 *    may appear in a criterion score, where Phase 0 grades it D (it lowers
 *    confidence and can't raise a score).
 * 3. checkRunInputs: consistency of opportunity, manifest and workbook
 *    (matching ids and date; every citation names a manifest source).
 *
 * Evidence judgments (step 4.5, version 2): the operator may record
 * - negativeFindings: that the claims cited for a hard gate support the
 *   gate's FAILED condition (direction "supports_failed_condition"), with
 *   who assessed it, when and why. At most one per gate;
 * - contradictions: that two or more source-backed claims materially
 *   disagree, with a description, who assessed it and when. Recorded
 *   contradictions are unresolved (there is no resolution field yet).
 * These are operator assessments, never inferred: nothing here reads the
 * direction of evidence or a disagreement from claim text, citations,
 * grades or a gate's passed value. This parser checks their structure and
 * references (known gate and claims, no duplicates, no self-contradiction,
 * dates not after the run date). Whether a negative finding applies to the
 * gate and is adequately supported is decided later, in the ledger, against
 * Phase 0's validated results.
 *
 * Kinds of statement stay distinct: claims keep Phase 0's types (fact,
 * estimate, assumption, speculation); assumptions keep their basis (a claim,
 * or a stated rationale); unknowns are the required missingInformation list.
 * Quote verification against source text happens later, once the text is
 * loaded; parsing a citation here proves nothing about its source.
 *
 * Every parser first runs normalizeInput (manifest.ts): each property is read
 * once into a fresh copy that all later checks read (getters, Proxies, sparse
 * arrays, non-plain objects and unsafe text are refused there), and JSON text
 * is scanned for duplicate keys before parsing. Issues are collected with a
 * cap (BoundedIssues). Direct (non-JSON) object input is not sandboxed: see
 * the "NOT A SANDBOX" note in manifest.ts. Text is stored as inert data:
 * nothing here executes or interprets it, records an approval, changes a
 * budget or triggers any action.
 */

import {
  CLAIM_TYPES, HARD_GATES, Issues, MIN_FAILURE_REASONS, SchemaError, arr, checkKeys, id, isoDate, isoDateTime, oneOf, parseAssumptions,
  parseExperimentProposal, parseScenarioDefinitions, parseScoring, parseSourcesAndClaims, str, uniqueIds,
  type Assumption, type Claim, type ClaimType, type ExperimentProposal, type ReportSections, type ScenarioDefinition,
} from "./division.js";
import { BoundedIssues, normalizeInput, parseBoundedJson, type SourceManifest } from "./manifest.js";

export const OPPORTUNITY_VERSION = 1;
/**
 * Version 2 adds the operator's evidence judgments (negativeFindings, contradictions). Version 1 workbooks
 * are refused: there is no automatic upgrade (add the two lists, empty if none, and set version 2).
 */
export const WORKBOOK_VERSION = 2;
/** Size limits of the JSON texts, checked before parsing. */
export const MAX_OPPORTUNITY_CHARS = 20_000;
export const MAX_WORKBOOK_CHARS = 2_000_000;
/** Same limit Phase 0 applies to a report's experiments. */
export const MAX_EXPERIMENTS = 20;
/** Claim types that depend on sources and must therefore cite at least one (estimates are derived and state their method instead). */
export const SOURCE_DEPENDENT_CLAIM_TYPES: readonly ClaimType[] = Object.freeze(["fact"]);
const SECTION_KEYS = ["summary", "problemAndCustomer", "demandAndMarket", "competitors", "acquisition", "risks", "failureReasons", "missingInformation"];
const WORKBOOK_KEYS = [
  "version", "opportunityId", "reportId", "asOf", "claims", "sections", "assumptions", "scenarios", "scoring", "experiments", "negativeFindings", "contradictions",
];
/** The only direction a negative finding can record. */
export const NEGATIVE_FINDING_DIRECTION = "supports_failed_condition";
export const MAX_CONTRADICTIONS = 100;
/** Claims per contradiction (at least two distinct claims). */
export const MAX_CONTRADICTION_CLAIMS = 10;
const NEGATIVE_FINDING_KEYS = ["gateId", "claimIds", "direction", "assessedBy", "assessedAt", "rationale"];
const CONTRADICTION_KEYS = ["id", "claimIds", "description", "assessedBy", "assessedAt"];
const SCENARIO_ID_FIELDS = [
  "pricePerUnitId", "variableCostPerUnitId", "unitsSoldPerMonthId", "newCustomersPerMonthId", "acquisitionCostPerCustomerId", "horizonMonthsId",
] as const;

export interface OpportunityMetadata {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly brief: string;
}

export type WorkbookScoring = ReturnType<typeof parseScoring>;

/** Operator assessment: the cited claims support the gate's failed condition. Never inferred. */
export interface NegativeFinding {
  readonly gateId: string;
  /** Must be exactly the gate's cited claims for the finding to apply (checked in the ledger). */
  readonly claimIds: readonly string[];
  readonly direction: typeof NEGATIVE_FINDING_DIRECTION;
  readonly assessedBy: string;
  readonly assessedAt: string;
  readonly rationale: string;
}

/** Operator assessment: these source-backed claims materially disagree. Unresolved. Never inferred. */
export interface Contradiction {
  readonly id: string;
  readonly claimIds: readonly string[];
  readonly description: string;
  readonly assessedBy: string;
  readonly assessedAt: string;
}

export interface EvidenceJudgments {
  readonly negativeFindings: readonly NegativeFinding[];
  readonly contradictions: readonly Contradiction[];
}

export interface ResearchWorkbook {
  readonly version: 2;
  readonly opportunityId: string;
  /** Id of the report this run produces (Phase 0 id rules). */
  readonly reportId: string;
  /** The date the report is "as of"; must equal the manifest's run date. */
  readonly asOf: string;
  readonly claims: readonly Claim[];
  readonly sections: ReportSections;
  readonly assumptions: readonly Assumption[];
  readonly scenarios: readonly ScenarioDefinition[];
  readonly scoring: WorkbookScoring;
  readonly experiments: readonly ExperimentProposal[];
  readonly negativeFindings: readonly NegativeFinding[];
  readonly contradictions: readonly Contradiction[];
}

/** Runs a Phase 0 parser and moves its issues (prefixed) into ours instead of throwing. */
function capture<T>(issues: BoundedIssues, prefix: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    if (!(err instanceof SchemaError)) throw err;
    for (const message of err.issues) issues.addMessage(`${prefix}${message}`);
    return null;
  }
}

export function parseOpportunity(raw: unknown): OpportunityMetadata {
  const input = normalizeInput(raw, "opportunity");
  const issues = new BoundedIssues();
  if (!checkKeys(issues, "opportunity", input, ["version", "id", "title", "brief"])) issues.throwIfAny();
  const o = input as Record<string, unknown>;
  if (o.version !== OPPORTUNITY_VERSION) issues.add("opportunity.version", `must be ${OPPORTUNITY_VERSION}`);
  const result = {
    version: OPPORTUNITY_VERSION,
    id: id(issues, "opportunity.id", o.id),
    title: str(issues, "opportunity.title", o.title, { max: 200 }),
    brief: str(issues, "opportunity.brief", o.brief, { max: 4_000 }),
  } as const;
  issues.throwIfAny();
  return Object.freeze(result);
}

export function parseOpportunityText(text: unknown): OpportunityMetadata {
  return parseOpportunity(parseBoundedJson(text, "opportunity", MAX_OPPORTUNITY_CHARS));
}

/** Sections with the same shape and limits as Phase 0's report parser (claim id lists; unknowns as text). */
function readSections(issues: Issues, raw: unknown): ReportSections | null {
  if (!checkKeys(issues, "workbook.sections", raw, SECTION_KEYS)) return null;
  const s = raw as Record<string, unknown>;
  const claimIdList = (path: string, value: unknown, min: number) =>
    arr(issues, path, value, { min, max: 100 }).map((v, i) => id(issues, `${path}[${i}]`, v));
  const competitors = arr(issues, "workbook.sections.competitors", s.competitors, { max: 50 }).map((c, i) => {
    const p = `workbook.sections.competitors[${i}]`;
    if (!checkKeys(issues, p, c, ["name", "product", "priceClaimId", "positioningClaimIds", "weaknessClaimIds"])) return null;
    const comp = c as Record<string, unknown>;
    return Object.freeze({
      name: str(issues, `${p}.name`, comp.name, { max: 200 }),
      product: str(issues, `${p}.product`, comp.product, { max: 500 }),
      priceClaimId: comp.priceClaimId === null ? null : id(issues, `${p}.priceClaimId`, comp.priceClaimId),
      positioningClaimIds: Object.freeze(claimIdList(`${p}.positioningClaimIds`, comp.positioningClaimIds, 0)),
      weaknessClaimIds: Object.freeze(claimIdList(`${p}.weaknessClaimIds`, comp.weaknessClaimIds, 0)),
    });
  });
  if (competitors.some((c) => c === null)) return null;
  return Object.freeze({
    summary: Object.freeze(claimIdList("workbook.sections.summary", s.summary, 1)),
    problemAndCustomer: Object.freeze(claimIdList("workbook.sections.problemAndCustomer", s.problemAndCustomer, 1)),
    demandAndMarket: Object.freeze(claimIdList("workbook.sections.demandAndMarket", s.demandAndMarket, 1)),
    competitors: Object.freeze(competitors as NonNullable<(typeof competitors)[number]>[]),
    acquisition: Object.freeze(claimIdList("workbook.sections.acquisition", s.acquisition, 1)),
    risks: Object.freeze(claimIdList("workbook.sections.risks", s.risks, 1)),
    failureReasons: Object.freeze(claimIdList("workbook.sections.failureReasons", s.failureReasons, MIN_FAILURE_REASONS)),
    // Unknowns: at least one entry is required, so a report always states what is not known.
    missingInformation: Object.freeze(arr(issues, "workbook.sections.missingInformation", s.missingInformation, { min: 1, max: 100 })
      .map((m, i) => str(issues, `workbook.sections.missingInformation[${i}]`, m, { max: 1_000 }))),
  });
}

export function parseWorkbook(raw: unknown): ResearchWorkbook {
  const input = normalizeInput(raw, "workbook"); // every later read (ours and Phase 0's) sees this stable copy
  const issues = new BoundedIssues();
  if (!checkKeys(issues, "workbook", input, WORKBOOK_KEYS)) issues.throwIfAny();
  const w = input as Record<string, unknown>;
  if (w.version !== WORKBOOK_VERSION) issues.add("workbook.version", `must be ${WORKBOOK_VERSION}`);
  const opportunityId = id(issues, "workbook.opportunityId", w.opportunityId);
  const reportId = id(issues, "workbook.reportId", w.reportId);
  const asOf = isoDate(issues, "workbook.asOf", w.asOf);
  const experimentList = arr(issues, "workbook.experiments", w.experiments, { max: MAX_EXPERIMENTS });
  issues.throwIfAny(); // refuse a malformed header or oversized experiment list before parsing the body

  // Layer 1: Phase 0's own parsers (each refuses oversized arrays before reading elements).
  const claims = capture(issues, "workbook.", () => parseSourcesAndClaims([], w.claims).claims);
  const assumptions = capture(issues, "workbook.", () => parseAssumptions(w.assumptions));
  const scenarios = capture(issues, "workbook.", () => parseScenarioDefinitions(w.scenarios));
  const scoring = capture(issues, "workbook.", () => parseScoring(w.scoring));
  const experiments = experimentList.map((e, i) => capture(issues, "", () => parseExperimentProposal(e, `workbook.experiments[${i}]`)));
  const sections = readSections(issues, w.sections);
  issues.throwIfAny();
  const judgments = readJudgments(issues, w.negativeFindings, w.contradictions, claims!, asOf);
  issues.throwIfAny();

  const exps = experiments as ExperimentProposal[];
  uniqueIds(issues, "workbook.experiments", exps.map((e) => e.id));
  checkReferences(issues, claims!, sections!, assumptions!, scenarios!, scoring!);
  issues.throwIfAny();
  return Object.freeze({
    version: WORKBOOK_VERSION, opportunityId, reportId, asOf,
    claims: Object.freeze([...claims!]), sections: sections!, assumptions: Object.freeze([...assumptions!]), scenarios: Object.freeze([...scenarios!]),
    scoring: scoring!, experiments: Object.freeze(exps),
    negativeFindings: judgments.negativeFindings, contradictions: judgments.contradictions,
  });
}

/** Validates the operator's evidence judgments: structure and references only (application is decided in the ledger). */
function readJudgments(issues: Issues, rawFindings: unknown, rawContradictions: unknown, claims: readonly Claim[], asOf: string): EvidenceJudgments {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const gateIds = HARD_GATES.map((g) => g.id);
  const dateNotAfterRun = (path: string, value: unknown): string => {
    const at = isoDateTime(issues, path, value);
    if (at && asOf && at.slice(0, 10) > asOf) issues.add(path, `is after the run date ${asOf}`);
    return at;
  };
  const claimList = (path: string, value: unknown, min: number, max: number): string[] => {
    const list = arr(issues, path, value, { min, max }).map((v, i) => id(issues, `${path}[${i}]`, v));
    if (new Set(list).size !== list.length) issues.add(path, "must not repeat a claim");
    list.forEach((claimId, i) => { if (claimId && !byId.has(claimId)) issues.add(`${path}[${i}]`, `unknown claim "${claimId}"`); });
    return list;
  };

  const findings = arr(issues, "workbook.negativeFindings", rawFindings, { max: HARD_GATES.length }).map((raw, i): NegativeFinding | null => {
    const p = `workbook.negativeFindings[${i}]`;
    if (!checkKeys(issues, p, raw, NEGATIVE_FINDING_KEYS)) return null;
    const f = raw as Record<string, unknown>;
    return Object.freeze({
      gateId: oneOf(issues, `${p}.gateId`, f.gateId, gateIds),
      claimIds: Object.freeze(claimList(`${p}.claimIds`, f.claimIds, 1, 100)),
      direction: oneOf(issues, `${p}.direction`, f.direction, [NEGATIVE_FINDING_DIRECTION] as const),
      assessedBy: str(issues, `${p}.assessedBy`, f.assessedBy, { max: 200 }),
      assessedAt: dateNotAfterRun(`${p}.assessedAt`, f.assessedAt),
      rationale: str(issues, `${p}.rationale`, f.rationale, { max: 1_000 }),
    });
  });
  if (findings.every((f) => f !== null)) uniqueIds(issues, "workbook.negativeFindings (gates)", findings.map((f) => f!.gateId));

  const contradictions = arr(issues, "workbook.contradictions", rawContradictions, { max: MAX_CONTRADICTIONS }).map((raw, i): Contradiction | null => {
    const p = `workbook.contradictions[${i}]`;
    if (!checkKeys(issues, p, raw, CONTRADICTION_KEYS)) return null;
    const c = raw as Record<string, unknown>;
    const claimIds = claimList(`${p}.claimIds`, c.claimIds, 2, MAX_CONTRADICTION_CLAIMS);
    claimIds.forEach((claimId, j) => {
      const claim = byId.get(claimId);
      if (claim && claim.citations.length === 0) {
        issues.add(`${p}.claimIds[${j}]`, `claim "${claimId}" is not source-backed (a ${claim.type} with no citation)`);
      }
    });
    return Object.freeze({
      id: id(issues, `${p}.id`, c.id),
      claimIds: Object.freeze(claimIds),
      description: str(issues, `${p}.description`, c.description, { max: 1_000 }),
      assessedBy: str(issues, `${p}.assessedBy`, c.assessedBy, { max: 200 }),
      assessedAt: dateNotAfterRun(`${p}.assessedAt`, c.assessedAt),
    });
  });
  if (contradictions.every((c) => c !== null)) {
    const valid = contradictions as Contradiction[];
    uniqueIds(issues, "workbook.contradictions (ids)", valid.map((c) => c.id));
    const seen = new Map<string, string>();
    for (const c of valid) {
      const key = [...c.claimIds].sort().join(",");
      const first = seen.get(key);
      if (first !== undefined) issues.add("workbook.contradictions", `"${c.id}" records the same claims as "${first}" (duplicate)`);
      else seen.set(key, c.id);
    }
  }
  return {
    negativeFindings: Object.freeze(findings as NegativeFinding[]),
    contradictions: Object.freeze(contradictions as Contradiction[]),
  };
}

/**
 * Re-validates evidence judgments against a set of claims and a run date
 * (used by the ledger, which receives judgments separately from the report).
 * The input is normalised first (see normalizeInput); throws SchemaError.
 */
export function parseEvidenceJudgments(raw: unknown, claims: readonly Claim[], asOf: string): EvidenceJudgments {
  const input = normalizeInput(raw, "judgments");
  const issues = new BoundedIssues();
  if (!checkKeys(issues, "judgments", input, ["negativeFindings", "contradictions"])) issues.throwIfAny();
  const j = input as Record<string, unknown>;
  const result = readJudgments(issues, j.negativeFindings, j.contradictions, claims, asOf);
  issues.throwIfAny();
  return Object.freeze(result);
}

/** Layer 2: pipeline rules on references and claim kinds (stricter than Phase 0, never looser). */
function checkReferences(
  issues: Issues, claims: readonly Claim[], sections: ReportSections, assumptions: readonly Assumption[],
  scenarios: readonly ScenarioDefinition[], scoring: WorkbookScoring,
): void {
  const byId = new Map(claims.map((c) => [c.id, c]));
  claims.forEach((c, i) => {
    if (!(CLAIM_TYPES as readonly string[]).includes(c.type)) issues.add(`workbook.claims[${i}].type`, "is not a known claim type");
    if (SOURCE_DEPENDENT_CLAIM_TYPES.includes(c.type) && c.citations.length === 0) {
      issues.add(`workbook.claims[${i}].citations`, `a ${c.type} depends on sources and must cite at least one`);
    }
  });
  const known = (where: string, claimId: string) => {
    if (!byId.has(claimId)) issues.add(where, `unknown claim "${claimId}"`);
  };
  /** Gate evidence and assumption bases must not rest on speculation. */
  const notSpeculation = (where: string, claimId: string, use: string) => {
    known(where, claimId);
    if (byId.get(claimId)?.type === "speculation") issues.add(where, `speculation "${claimId}" can't be ${use}`);
  };
  for (const key of ["summary", "problemAndCustomer", "demandAndMarket", "acquisition", "risks", "failureReasons"] as const) {
    sections[key].forEach((claimId, i) => known(`workbook.sections.${key}[${i}]`, claimId));
  }
  sections.competitors.forEach((c, i) => {
    if (c.priceClaimId !== null) known(`workbook.sections.competitors[${i}].priceClaimId`, c.priceClaimId);
    c.positioningClaimIds.forEach((claimId, j) => known(`workbook.sections.competitors[${i}].positioningClaimIds[${j}]`, claimId));
    c.weaknessClaimIds.forEach((claimId, j) => known(`workbook.sections.competitors[${i}].weaknessClaimIds[${j}]`, claimId));
  });
  assumptions.forEach((a, i) => {
    if (a.basis.kind === "claim") notSpeculation(`workbook.assumptions[${i}].basis.claimId`, a.basis.claimId, "an assumption's basis");
  });
  const assumptionIds = new Set(assumptions.map((a) => a.id));
  scenarios.forEach((s, i) => {
    const used = [...s.startupCostIds, ...s.monthlyFixedCostIds, ...SCENARIO_ID_FIELDS.map((f) => s[f])];
    for (const assumptionId of used) {
      if (!assumptionIds.has(assumptionId)) issues.add(`workbook.scenarios[${i}]`, `unknown assumption "${assumptionId}" (missing values are never defaulted)`);
    }
  });
  // Criterion scores may cite speculation (Phase 0 grades it D: lower confidence, never a higher score).
  scoring.scores.forEach((sc, i) => sc.claimIds.forEach((claimId, j) => known(`workbook.scoring.scores[${i}].claimIds[${j}]`, claimId)));
  scoring.gates.forEach((g, i) => {
    g.claimIds.forEach((claimId, j) => notSpeculation(`workbook.scoring.gates[${i}].claimIds[${j}]`, claimId, "hard-gate evidence"));
    g.relevance?.assessedClaimIds.forEach((claimId, j) => known(`workbook.scoring.gates[${i}].relevance.assessedClaimIds[${j}]`, claimId));
  });
}

export function parseWorkbookText(text: unknown): ResearchWorkbook {
  return parseWorkbook(parseBoundedJson(text, "workbook", MAX_WORKBOOK_CHARS));
}

/**
 * Layer 3: consistency of one run's inputs. Ids must match, the workbook's
 * as-of date must be the manifest's run date, and every citation must name a
 * source in the manifest. Throws SchemaError listing every problem.
 */
export function checkRunInputs(opportunity: OpportunityMetadata, manifest: SourceManifest, workbook: ResearchWorkbook): void {
  const issues = new BoundedIssues();
  if (manifest.opportunityId !== opportunity.id) issues.add("manifest.opportunityId", `must equal the opportunity id "${opportunity.id}"`);
  if (workbook.opportunityId !== opportunity.id) issues.add("workbook.opportunityId", `must equal the opportunity id "${opportunity.id}"`);
  if (workbook.asOf !== manifest.runDate) issues.add("workbook.asOf", `must equal the manifest run date ${manifest.runDate}`);
  const sourceIds = new Set(manifest.sources.map((s) => s.id));
  workbook.claims.forEach((c, i) => c.citations.forEach((cit, j) => {
    if (!sourceIds.has(cit.snapshotId)) issues.add(`workbook.claims[${i}].citations[${j}].snapshotId`, `"${cit.snapshotId}" is not a source in the manifest`);
  }));
  issues.throwIfAny();
}
