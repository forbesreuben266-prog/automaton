/**
 * Report validation and rendering.
 *
 * `validateReport` parses the whole report strictly, verifies every citation,
 * recalculates every scenario and score from inputs, and returns errors and
 * warnings. `renderReport` produces Markdown:
 * - "final" mode refuses to render a report with any error;
 * - "draft" mode renders it with a FAILED VALIDATION banner, inline markers
 *   on every unsupported claim and missing piece of evidence, and no verdict,
 *   score or confidence.
 * Figures in the report come only from the deterministic calculations.
 */

import { sourceIdentityConflicts, verifyClaims, type ClaimVerification, DEFAULT_MAX_SOURCE_AGE_DAYS } from "./citations.js";
import {
  calculateScenarios, formatMoney, parseAssumptions, parseScenarioDefinitions,
  type Assumption, type ScenarioDefinition, type ScenarioResult,
} from "./finance.js";
import { parseExperimentProposal, type ExperimentProposal } from "./proposals.js";
import { HARD_GATES, parseScoring, scoreOpportunity, type ScoreResult } from "./scoring.js";
import { parseSourcesAndClaims, type Claim, type SourceSnapshot } from "./sources.js";
import { escapeInline, renderUrl } from "./untrusted.js";
import { Issues, SchemaError, arr, checkKeys, daysBetween, id, isoDate, oneOf, str, uniqueIds } from "./validation.js";

export interface Competitor {
  readonly name: string;
  readonly product: string;
  readonly priceClaimId: string | null;
  readonly positioningClaimIds: readonly string[];
  readonly weaknessClaimIds: readonly string[];
}

export interface ReportSections {
  readonly summary: readonly string[];
  readonly problemAndCustomer: readonly string[];
  readonly demandAndMarket: readonly string[];
  readonly competitors: readonly Competitor[];
  readonly acquisition: readonly string[];
  readonly risks: readonly string[];
  readonly failureReasons: readonly string[];
  readonly missingInformation: readonly string[];
}

export interface ResearchReport {
  readonly id: string;
  readonly title: string;
  readonly brief: string;
  readonly asOf: string;
  readonly snapshots: readonly SourceSnapshot[];
  readonly claims: readonly Claim[];
  readonly sections: ReportSections;
  readonly assumptions: readonly Assumption[];
  readonly scenarios: readonly ScenarioDefinition[];
  readonly scoring: ReturnType<typeof parseScoring>;
  readonly experiments: readonly ExperimentProposal[];
}

export const MIN_FAILURE_REASONS = 3;

interface ReportValidationBase {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** Present when the report parsed; computed parts may be null if their inputs were invalid. */
  readonly report: ResearchReport | null;
  readonly verification: ReadonlyMap<string, ClaimVerification> | null;
  readonly scenarioResults: readonly ScenarioResult[] | null;
}

/**
 * Result of validateReport. The score (verdict, total, confidence, gates) is
 * available ONLY when ok is true: an invalid report always has score null,
 * so an unsupported verdict can't be consumed by mistake. TypeScript narrows
 * `score` to ScoreResult after checking `ok`.
 */
export type ReportValidation =
  | (ReportValidationBase & { readonly ok: true; readonly report: ResearchReport; readonly score: ScoreResult })
  | (ReportValidationBase & { readonly ok: false; readonly score: null });

function captureSchema<T>(errors: string[], fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SchemaError) {
      errors.push(...err.issues);
      return null;
    }
    throw err;
  }
}

function parseReport(raw: unknown): ResearchReport {
  const issues = new Issues();
  const keys = ["id", "title", "brief", "asOf", "snapshots", "claims", "sections", "assumptions", "scenarios", "scoring", "experiments"];
  if (!checkKeys(issues, "report", raw, keys)) issues.throwIfAny();
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];
  const sources = captureSchema(errors, () => parseSourcesAndClaims(r.snapshots, r.claims));
  const assumptions = captureSchema(errors, () => parseAssumptions(r.assumptions));
  const scenarios = captureSchema(errors, () => parseScenarioDefinitions(r.scenarios));
  const scoring = captureSchema(errors, () => parseScoring(r.scoring));
  const experiments = arr(issues, "report.experiments", r.experiments, { max: 20 })
    .map((e, i) => captureSchema(errors, () => parseExperimentProposal(e, `report.experiments[${i}]`)));

  const claimIdList = (path: string, value: unknown, min: number) =>
    arr(issues, path, value, { min, max: 100 }).map((v, i) => id(issues, `${path}[${i}]`, v));
  let sections: ReportSections | null = null;
  const s = r.sections;
  const sectionKeys = ["summary", "problemAndCustomer", "demandAndMarket", "competitors", "acquisition", "risks", "failureReasons", "missingInformation"];
  if (checkKeys(issues, "report.sections", s, sectionKeys)) {
    sections = {
      summary: claimIdList("sections.summary", s.summary, 1),
      problemAndCustomer: claimIdList("sections.problemAndCustomer", s.problemAndCustomer, 1),
      demandAndMarket: claimIdList("sections.demandAndMarket", s.demandAndMarket, 1),
      competitors: arr(issues, "sections.competitors", s.competitors, { max: 50 }).map((c, i) => {
        const p = `sections.competitors[${i}]`;
        if (!checkKeys(issues, p, c, ["name", "product", "priceClaimId", "positioningClaimIds", "weaknessClaimIds"])) {
          return undefined as never;
        }
        return {
          name: str(issues, `${p}.name`, c.name, { max: 200 }),
          product: str(issues, `${p}.product`, c.product, { max: 500 }),
          priceClaimId: c.priceClaimId === null ? null : id(issues, `${p}.priceClaimId`, c.priceClaimId),
          positioningClaimIds: claimIdList(`${p}.positioningClaimIds`, c.positioningClaimIds, 0),
          weaknessClaimIds: claimIdList(`${p}.weaknessClaimIds`, c.weaknessClaimIds, 0),
        };
      }),
      acquisition: claimIdList("sections.acquisition", s.acquisition, 1),
      risks: claimIdList("sections.risks", s.risks, 1),
      failureReasons: claimIdList("sections.failureReasons", s.failureReasons, MIN_FAILURE_REASONS),
      missingInformation: arr(issues, "sections.missingInformation", s.missingInformation, { min: 1, max: 100 })
        .map((m, i) => str(issues, `sections.missingInformation[${i}]`, m, { max: 1_000 })),
    };
  }
  const report = {
    id: id(issues, "report.id", r.id),
    title: str(issues, "report.title", r.title, { max: 200 }),
    brief: str(issues, "report.brief", r.brief, { max: 4_000 }),
    asOf: isoDate(issues, "report.asOf", r.asOf),
  };
  issues.list.push(...errors);
  if (experiments.every((e) => e !== null)) {
    uniqueIds(issues, "report.experiments", experiments.map((e) => e!.id));
  }
  issues.throwIfAny();
  return {
    ...report,
    snapshots: sources!.snapshots,
    claims: sources!.claims,
    sections: sections!,
    assumptions: assumptions!,
    scenarios: scenarios!,
    scoring: scoring!,
    experiments: experiments as ExperimentProposal[],
  };
}

/** Every claim id the report refers to, with where it is used. */
function claimReferences(report: ResearchReport): Array<{ where: string; claimId: string }> {
  const refs: Array<{ where: string; claimId: string }> = [];
  const s = report.sections;
  const add = (where: string, ids: readonly string[]) => ids.forEach((claimId) => refs.push({ where, claimId }));
  add("summary", s.summary);
  add("problemAndCustomer", s.problemAndCustomer);
  add("demandAndMarket", s.demandAndMarket);
  add("acquisition", s.acquisition);
  add("risks", s.risks);
  add("failureReasons", s.failureReasons);
  s.competitors.forEach((c, i) => {
    if (c.priceClaimId) add(`competitors[${i}].price`, [c.priceClaimId]);
    add(`competitors[${i}].positioning`, c.positioningClaimIds);
    add(`competitors[${i}].weaknesses`, c.weaknessClaimIds);
  });
  report.assumptions.forEach((a) => {
    if (a.basis.kind === "claim") add(`assumption ${a.id}`, [a.basis.claimId]);
  });
  report.scoring.scores.forEach((sc) => add(`score ${sc.criterionId}`, sc.claimIds));
  report.scoring.gates.forEach((g) => add(`gate ${g.gateId}`, g.claimIds));
  return refs;
}

export function validateReport(raw: unknown): ReportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const report = captureSchema(errors, () => parseReport(raw));
  if (!report) {
    return { ok: false, errors, warnings, report: null, verification: null, scenarioResults: null, score: null };
  }

  for (const c of sourceIdentityConflicts(report.snapshots)) {
    warnings.push(`snapshots ${c.snapshotIds.join(", ")} share the same ${c.kind === "url" ? "canonical URL" : "text"} but declare different origins ` +
      `(${c.originIds.join(", ")}): counted as one origin with unverified independence`);
  }
  for (const s of report.snapshots) {
    if (s.retrievedAt.slice(0, 10) > report.asOf) errors.push(`snapshot ${s.id}: retrieved after the report date ${report.asOf}`);
    if (!s.independenceVerified) warnings.push(`snapshot ${s.id}: independence unverified (adds no corroboration)`);
    if (s.publishedAt === null) warnings.push(`snapshot ${s.id}: no publication date (treated as stale)`);
    else if (daysBetween(s.publishedAt, report.asOf) > DEFAULT_MAX_SOURCE_AGE_DAYS) {
      warnings.push(`snapshot ${s.id}: published ${s.publishedAt}, more than ${DEFAULT_MAX_SOURCE_AGE_DAYS} days before the report`);
    }
  }

  const verification = verifyClaims(report.claims, report.snapshots, report.asOf);
  for (const v of verification.values()) {
    if (v.status === "invalid_citation" || v.status === "unsupported") {
      errors.push(`claim ${v.claimId} (${v.type}) is ${v.status.replace("_", " ")}: ${v.problems.join("; ")}`);
    }
  }

  const claimIds = new Set(report.claims.map((c) => c.id));
  const refs = claimReferences(report);
  for (const ref of refs) {
    if (!claimIds.has(ref.claimId)) errors.push(`${ref.where}: references unknown claim "${ref.claimId}"`);
  }
  for (const a of report.assumptions) {
    if (a.basis.kind === "claim") {
      const v = verification.get(a.basis.claimId);
      if (v && v.status !== "supported") {
        errors.push(`assumption ${a.id}: based on claim ${a.basis.claimId}, which is not a supported fact or estimate`);
      }
    }
  }
  const used = new Set(refs.map((r) => r.claimId));
  for (const c of report.claims) if (!used.has(c.id)) warnings.push(`claim ${c.id} is not used in the report`);
  const cited = new Set(report.claims.flatMap((c) => c.citations.map((x) => x.snapshotId)));
  for (const s of report.snapshots) if (!cited.has(s.id)) warnings.push(`snapshot ${s.id} is not cited`);
  if (report.sections.competitors.length === 0) warnings.push("no competitors listed");

  const scenarioResults = captureSchema(errors, () => calculateScenarios(report.scenarios, report.assumptions));
  const currencies = new Set(report.experiments.map((e) => e.currency));
  if (scenarioResults && [...currencies].some((c) => c !== scenarioResults[0].currency)) {
    warnings.push("experiment costs use a different currency from the scenarios");
  }
  const score = captureSchema(errors, () => scoreOpportunity(report.scoring, report.claims, report.snapshots, report.asOf));
  if (score) {
    for (const g of score.unverifiedGates) warnings.push(`gate ${g}: marked passed without verified evidence (shown as UNVERIFIED)`);
    for (const g of score.weakGates) warnings.push(`gate ${g}: only weak grade-C evidence (shown as WEAK)`);
    for (const g of score.relevanceUnverifiedGates) warnings.push(`gate ${g}: evidence cited but relevance not assessed (shown as CITED — RELEVANCE UNVERIFIED)`);
    for (const c of score.criteria) for (const f of c.flags) warnings.push(`score ${c.criterionId}: ${f}`);
    if (score.confidence === "low") warnings.push("overall confidence is low");
  }

  if (errors.length > 0 || !score) {
    // Never expose a verdict, score or confidence for an invalid report.
    return { ok: false, errors, warnings, report, verification, scenarioResults, score: null };
  }
  return { ok: true, errors, warnings, report, verification, scenarioResults, score };
}

export class ReportValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`Report failed validation:\n- ${errors.join("\n- ")}`);
    this.name = "ReportValidationError";
  }
}

const TYPE_TAG: Record<Claim["type"], string> = { fact: "F", estimate: "E", assumption: "A", speculation: "S" };
const VERDICT_LABEL = { pursue_to_validation: "Pursue to validation", watch: "Watch", reject: "Reject" } as const;

const UNTRUSTED = "_(unverified free text)_";

/** Origin count and independence status for a gate, never implying independence that wasn't checked. */
function gateCorroboration(g: { distinctOrigins: number; independentSources: number; unverifiedOrigins: number; corroboration: string }): string {
  if (g.distinctOrigins === 0) return "no quote-verified origin";
  if (g.distinctOrigins === 1) {
    return g.unverifiedOrigins > 0
      ? "1 origin; not corroborated; independence unverified"
      : "1 origin; not corroborated (independence checked)";
  }
  if (g.corroboration === "independent") return `${g.independentSources} independent origins (independence checked)`;
  return `${g.distinctOrigins} origins, only ${g.independentSources} counted as independent; independence unverified`;
}

/** States what "verified" and the snapshot hashes do and don't establish. Shown in every report. */
export const QUOTE_VERIFICATION_LEGEND =
  "Quote verification: a \"verified\" or \"supported\" claim means only that each quoted passage appears in the supplied " +
  "source snapshot. It does not establish that the source, or the claim, is true or relevant. Edit-check SHA-256 values " +
  "detect later edits to a snapshot; they are not tamper protection or proof of authenticity. Hard gates show PASS only " +
  "with grade A/B evidence and an operator relevance assessment tied to exactly the cited evidence (the same claim ids) " +
  "against the gate's defined criterion. Independence and corroboration are a separate dimension: each gate and source " +
  "states how many origins support it and whether their independence was checked, and it may remain unverified even " +
  "when a gate shows PASS.";

/**
 * Renders the report as Markdown. `options` must be a plain data object
 * `{ mode: "final" | "draft" }` (getters are refused unread).
 * - final: refuses any report with errors.
 * - draft: renders with a FAILED VALIDATION banner; the verdict, score and
 *   confidence are withheld, and every problem is marked inline.
 * Free-text fields (title, brief, competitor descriptions, gate notes,
 * experiment text, missing-information notes) are labelled as unverified.
 */
export function renderReport(raw: unknown, options: unknown = { mode: "final" }): string {
  const optionIssues = new Issues();
  let mode: "final" | "draft" = "final";
  if (checkKeys(optionIssues, "options", options, ["mode"])) {
    mode = oneOf(optionIssues, "options.mode", options.mode, ["final", "draft"] as const);
  }
  optionIssues.throwIfAny();

  const v = validateReport(raw);
  if (!v.report) throw new ReportValidationError(v.errors);
  if (mode === "final" && !v.ok) throw new ReportValidationError(v.errors);
  const report = v.report;
  const verification = v.verification!;
  const claims = new Map(report.claims.map((c) => [c.id, c]));
  const sourceNumber = new Map(report.snapshots.map((s, i) => [s.id, i + 1]));
  const e = escapeInline;
  const out: string[] = [];
  const draft = !v.ok;

  const claimLine = (claimId: string): string => {
    const c = claims.get(claimId);
    if (!c) return `- **[UNKNOWN CLAIM ${e(claimId)}]**`;
    const status = verification.get(c.id)!;
    const refs = status.verifiedSnapshotIds.map((sid) => `[${sourceNumber.get(sid)}]`).join("");
    let marker = "";
    if (status.status === "unsupported") marker = " **[UNSUPPORTED]**";
    else if (status.status === "invalid_citation") marker = " **[INVALID CITATION]**";
    else if (c.type === "speculation") marker = " _(speculation, unverified)_";
    else if (c.type === "assumption") marker = " _(assumption, unverified)_";
    else if (c.type === "estimate") marker = " _(estimate: derived figure, not directly quoted)_";
    const method = c.type === "estimate" && c.method ? ` — method: ${e(c.method)}` : "";
    return `- [${TYPE_TAG[c.type]}] ${e(c.statement)}${refs ? ` ${refs}` : ""}${marker}${method}`;
  };
  const claimLabel = (claimId: string): string => {
    const c = claims.get(claimId);
    if (!c) return `**[UNKNOWN CLAIM ${e(claimId)}]**`;
    const status = verification.get(c.id)!.status;
    const flag = status === "supported" || status === "labelled_only" ? "" : ` **[${status.replace("_", " ").toUpperCase()}]**`;
    return `claim ${e(c.id)} [${TYPE_TAG[c.type]}] ${c.type}${flag}`;
  };
  const section = (heading: string, ids: readonly string[]) => {
    out.push(`## ${heading}`, "", ...(ids.length > 0 ? ids.map(claimLine) : ["- **[MISSING EVIDENCE]** nothing supplied"]), "");
  };

  if (draft) {
    out.push("> **DRAFT — FAILED VALIDATION. Not a decision-ready report. Verdict, score and confidence are withheld.**", ">");
    for (const err of v.errors) out.push(`> - ${e(err)}`);
    out.push("");
  }
  out.push(`# ${e(report.title)} — business opportunity research`, "");
  out.push(`Report date: ${report.asOf} · Report id: ${e(report.id)}`, "");
  if (draft) {
    out.push("**Verdict: WITHHELD** (report failed validation)", "");
  } else if (v.score) {
    out.push(`**Verdict: ${VERDICT_LABEL[v.score.verdict]}** (${e(v.score.verdictReason)})`, "");
    out.push(`**Score:** ${v.score.total}/100 · **Confidence:** ${v.score.confidence} — score and confidence are assessed separately.`, "");
  }
  out.push("Labels: [F] fact (cited) · [E] estimate (derived; method shown) · [A] assumption · [S] speculation. Numbers in brackets refer to Sources.", "");
  out.push(`Title, brief, competitor descriptions, gate notes, experiment text and missing-information notes are unverified free text supplied with the report; they are not findings.`, "");
  out.push(QUOTE_VERIFICATION_LEGEND, "");
  out.push(`Brief ${UNTRUSTED}: ${e(report.brief)}`, "");

  section("1. Summary", report.sections.summary);
  section("2. Problem and target customer", report.sections.problemAndCustomer);
  section("3. Demand and market size", report.sections.demandAndMarket);

  out.push("## 4. Competitors", "");
  if (report.sections.competitors.length === 0) out.push("- **[MISSING EVIDENCE]** no competitors listed");
  for (const c of report.sections.competitors) {
    out.push(`### ${e(c.name)} — ${e(c.product)}`, "", `Name and description ${UNTRUSTED}.`, "");
    if (c.priceClaimId) out.push(`Price: ${claimLine(c.priceClaimId).slice(2)}`);
    else out.push("Price: **[MISSING EVIDENCE]** not found");
    if (c.positioningClaimIds.length > 0) out.push("Positioning:", ...c.positioningClaimIds.map(claimLine));
    if (c.weaknessClaimIds.length > 0) out.push("Weaknesses:", ...c.weaknessClaimIds.map(claimLine));
    out.push("");
  }
  out.push("");

  out.push("## 5. Assumptions (inputs to the calculations)", "", "| Id | Assumption | Value | Unit | Basis |", "|---|---|---|---|---|");
  for (const a of report.assumptions) {
    const basis = a.basis.kind === "claim" ? claimLabel(a.basis.claimId) : `assumption (unverified): ${e(a.basis.rationale)}`;
    out.push(`| ${e(a.id)} | ${e(a.label)} | ${a.value} | ${a.unit} | ${basis} |`);
  }
  out.push("");

  out.push("## 6. Scenarios (deterministic; not a forecast or guarantee)", "");
  if (v.scenarioResults) {
    for (const r of v.scenarioResults) {
      out.push(`### ${r.name[0].toUpperCase()}${r.name.slice(1)} (${r.horizonMonths}-month horizon)`, "", "| Line | Formula | Value |", "|---|---|---|");
      for (const line of r.lines) out.push(`| ${e(line.label)} | ${e(line.formula)} | ${formatMoney(line.value, r.currency)} |`);
      out.push(`| Break-even month | first month m ≥ 1 with profit × m ≥ startup | ${r.breakEvenMonth ?? `not within ${r.horizonMonths} months`} |`, "");
    }
    out.push("Model: steady state — no growth, churn, seasonality, tax or financing costs.", "");
  } else {
    out.push("**NOT COMPUTED** — financial inputs are missing or invalid (see validation errors).", "");
  }

  section("7. Customer acquisition", report.sections.acquisition);
  section("8. Risks, legal and regulatory considerations, barriers to entry", report.sections.risks);
  section("9. Why this could fail", report.sections.failureReasons);

  out.push(`## 10. Score breakdown${draft ? " (draft: not decision-ready)" : ""}`, "");
  if (v.score) {
    out.push("| Criterion | Weight | Score (0-5) | Points | Evidence grade | Independent origins | Flags |", "|---|---|---|---|---|---|---|");
    for (const c of v.score.criteria) {
      const origins = c.distinctOrigins > c.independentSources
        ? `${c.independentSources} of ${c.distinctOrigins} (independence unverified)`
        : String(c.independentSources);
      out.push(`| ${e(c.label)} | ${c.weight} | ${c.score} | ${c.weighted} | ${c.grade} | ${origins} | ${c.flags.map((f) => e(f)).join("; ") || "—"} |`);
    }
    out.push("", "Hard gates:");
    for (const g of v.score.gates) {
      const label = {
        fail: "**FAIL**",
        pass: `PASS (cited evidence grade ${g.grade}; relevance assessed by the operator)`,
        cited_relevance_unverified: g.relevance === null
          ? `**CITED — RELEVANCE UNVERIFIED** (evidence grade ${g.grade}; a matching quote doesn't show the evidence meets the gate)`
          : `**CITED — RELEVANCE UNVERIFIED** (evidence grade ${g.grade}; ${e(g.relevanceIssue ?? "")})`,
        weak: "**WEAK** (grade C: one stale or undated origin)",
        pass_unverified: "**UNVERIFIED** (marked passed, but no quote-verified evidence)",
      }[g.status];
      const criterion = HARD_GATES.find((h) => h.id === g.gateId)!;
      const refs = g.claimIds.length > 0 ? ` — evidence: ${g.claimIds.map(claimLabel).join("; ")}` : "";
      const relevance = g.relevance
        ? ` — relevance (${e(criterion.relevanceCriterion)}) assessed by ${e(g.relevance.assessedBy)} on ${g.relevance.assessedAt} ${UNTRUSTED}: ${e(g.relevance.rationale)}`
        : ` — relevance criterion not assessed: ${e(criterion.criterionText)}`;
      out.push(`- ${label} ${g.gateId}${refs} — corroboration: ${gateCorroboration(g)}${relevance} — note ${UNTRUSTED}: ${e(g.note)}`);
    }
  } else {
    out.push("**NOT COMPUTED**");
  }
  out.push("");

  out.push("## 11. Validation experiments — NEED YOUR APPROVAL (nothing here is carried out automatically)", "");
  if (report.experiments.length > 0) out.push(`Proposal text below is ${UNTRUSTED}.`, "");
  if (report.experiments.length === 0) out.push("- none proposed");
  for (const x of report.experiments) {
    out.push(`- **${e(x.title)}** (${e(x.id)}): ${e(x.hypothesis)}`);
    out.push(`  - Method: ${e(x.method)}`);
    out.push(`  - Estimated cost: ${formatMoney(x.estimatedCostMinor, x.currency)} · Duration: ${x.durationDays} days · Success threshold: ${e(x.successThreshold)}`);
    out.push(`  - External actions required: ${x.externalActions.length ? x.externalActions.map((a) => e(a)).join("; ") : "none"}`);
  }
  out.push("");

  out.push("## 12. Missing information and open questions", "", ...report.sections.missingInformation.map((m) => `- ${e(m)} ${UNTRUSTED}`), "");
  if (v.warnings.length > 0) out.push("Warnings:", ...v.warnings.map((w) => `- ${e(w)}`), "");

  out.push("## 13. Sources", "");
  for (const s of report.snapshots) {
    const independence = s.independenceVerified
      ? `independence checked: ${e(s.independenceNote)}`
      : `**INDEPENDENCE UNVERIFIED**${s.independenceNote ? `: ${e(s.independenceNote)}` : ""}`;
    const derived = s.derivedFromSnapshotIds.length > 0
      ? ` — repeats ${s.derivedFromSnapshotIds.map((d) => `[${sourceNumber.get(d)}]`).join("")}`
      : "";
    out.push(`${sourceNumber.get(s.id)}. ${e(s.title)} — ${e(s.publisher)} — ${renderUrl(s.url)} — published ${s.publishedAt ?? "undated"}, retrieved ${s.retrievedAt}, edit-check SHA-256 ${s.integritySha256.slice(0, 12)} — origin ${e(s.originId)}; ${independence}${derived}`);
  }
  out.push("", "_Projections are illustrative calculations from the stated assumptions, not guaranteed results._", "");
  return out.join("\n");
}
