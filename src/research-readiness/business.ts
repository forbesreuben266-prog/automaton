/**
 * Business evidence readiness (milestone R1). Pure and deterministic.
 *
 * Validates a bundle of future real-world business evidence and explains,
 * condition by condition, whether it could be relied on:
 *   { version: 1, asOf, maxSourceAgeDays, sources, claims, conflicts, missingInformation }
 * - sources: source records (provenance.ts);
 * - claims: { id, statement, kind, sourceIds, method, financial, operatorStatus }
 *   kind fact | estimate | assumption | speculation; estimates must explain
 *   their method; financial is null or { basis }, where the basis must match
 *   the kind: fact = "sourced", estimate = "derived_from_sourced" or
 *   "unsupported_estimate", assumption/speculation = "unsupported_estimate";
 *   operatorStatus is "confirmed" (facts only) or "unconfirmed";
 * - conflicts: operator-recorded disagreements between claims (they are not
 *   detected automatically), unresolved or resolved with a recorded decision;
 * - missingInformation: known gaps, blocking or not.
 *
 * Nothing is promoted automatically: a claim is a "confirmed_fact" only when
 * the OPERATOR confirmed it AND its evidence qualifies (a cited primary
 * source that is independently verified, or two independently verified
 * secondary sources with different, verified-independent origins), every
 * cited source is fresh, and no unresolved conflict involves it. A
 * confirmation the evidence doesn't support is reported as a failure, and
 * well-supported claims the operator hasn't confirmed stay unconfirmed.
 * Unsupported financial figures are labelled "UNSUPPORTED FINANCIAL ESTIMATE".
 */

import { check, assessOrRefuse, result, type ReadinessCheck, type ReadinessResult } from "./readiness.js";
import { readSourceRecords, trustSummary, type SourceRecord, type TrustSummary } from "./provenance.js";
import { Issues, dayNumber, readBool, readId, readList, readObject, readOneOf, readSafeInt, readText, readTimestamp } from "./validation.js";

export const CLAIM_KINDS = ["fact", "estimate", "assumption", "speculation"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const FINANCIAL_BASES = ["sourced", "derived_from_sourced", "unsupported_estimate"] as const;
export type FinancialBasis = (typeof FINANCIAL_BASES)[number];
export const MAX_SOURCE_AGE_DAYS_LIMIT = 3_650;
export const UNSUPPORTED_FINANCIAL_LABEL = "UNSUPPORTED FINANCIAL ESTIMATE";

const BASES_FOR_KIND: Record<ClaimKind, readonly FinancialBasis[]> = {
  fact: ["sourced"],
  estimate: ["derived_from_sourced", "unsupported_estimate"],
  assumption: ["unsupported_estimate"],
  speculation: ["unsupported_estimate"],
};

export interface EvidenceClaim {
  readonly id: string;
  readonly statement: string;
  readonly kind: ClaimKind;
  readonly sourceIds: readonly string[];
  readonly method: string | null;
  readonly financial: { readonly basis: FinancialBasis } | null;
  readonly operatorStatus: "confirmed" | "unconfirmed";
}

export interface EvidenceConflict {
  readonly id: string;
  readonly claimIds: readonly string[];
  readonly status: "unresolved" | "resolved";
  readonly resolution: { readonly favouredClaimId: string; readonly note: string; readonly decidedBy: string } | null;
}

export interface MissingInformation {
  readonly id: string;
  readonly description: string;
  readonly blocking: boolean;
}

export interface BusinessEvidenceBundle {
  readonly version: 1;
  readonly asOf: string;
  readonly maxSourceAgeDays: number;
  readonly sources: readonly SourceRecord[];
  readonly claims: readonly EvidenceClaim[];
  readonly conflicts: readonly EvidenceConflict[];
  readonly missingInformation: readonly MissingInformation[];
}

export type Support =
  | "no_sources"
  | "unverified_sources_only"
  | "verified_single_secondary"
  | "verified_independent_secondaries"
  | "verified_primary";

export type Freshness = "fresh" | "stale" | "date_asserted" | "date_unknown";

export type Standing =
  | "confirmed_fact"
  | "confirmation_not_substantiated"
  | "unconfirmed_fact"
  | "estimate"
  | "unsupported_estimate"
  | "assumption"
  | "speculation";

export interface ClaimStanding {
  readonly claimId: string;
  readonly kind: ClaimKind;
  readonly support: Support;
  readonly standing: Standing;
  /** "UNSUPPORTED FINANCIAL ESTIMATE" for financial figures without verified support; otherwise null. */
  readonly label: string | null;
  readonly reasons: readonly string[];
}

export interface BusinessReadiness extends ReadinessResult {
  readonly claims: readonly ClaimStanding[];
  readonly sources: readonly TrustSummary[];
}

/** Validates a bundle (throws ReadinessInputError listing every problem). */
export function parseBusinessEvidence(raw: unknown): BusinessEvidenceBundle {
  const issues = new Issues();
  const o = readObject(issues, "bundle", raw, ["version", "asOf", "maxSourceAgeDays", "sources", "claims", "conflicts", "missingInformation"]);
  issues.throwIfAny();
  if (o!.version !== 1) issues.add("bundle.version", "must be 1");
  const asOf = readTimestamp(issues, "bundle.asOf", o!.asOf);
  const maxSourceAgeDays = readSafeInt(issues, "bundle.maxSourceAgeDays", o!.maxSourceAgeDays, { min: 1, max: MAX_SOURCE_AGE_DAYS_LIMIT });
  issues.throwIfAny();
  const sources = readSourceRecords(issues, "bundle.sources", o!.sources, asOf, { min: 0, max: 200 });
  const sourceIds = new Set(sources.map((s) => s.id));

  const claimList = readList(issues, "bundle.claims", o!.claims, { min: 1, max: 2_000 }) ?? [];
  const claims: EvidenceClaim[] = [];
  const claimIds = new Set<string>();
  claimList.forEach((raw_, i) => {
    const p = `bundle.claims[${i}]`;
    const c = readObject(issues, p, raw_, ["id", "statement", "kind", "sourceIds", "method", "financial", "operatorStatus"]);
    if (c === null) return;
    const id = readId(issues, `${p}.id`, c.id);
    if (claimIds.has(id)) issues.add(`${p}.id`, `duplicates another claim id (${id})`);
    claimIds.add(id);
    const statement = readText(issues, `${p}.statement`, c.statement, { max: 1_000 });
    const kind = readOneOf(issues, `${p}.kind`, c.kind, CLAIM_KINDS);
    const ids = (readList(issues, `${p}.sourceIds`, c.sourceIds, { min: 0, max: 20 }) ?? []).map((s, j) => readId(issues, `${p}.sourceIds[${j}]`, s));
    ids.forEach((s, j) => {
      if (s && !sourceIds.has(s)) issues.add(`${p}.sourceIds[${j}]`, `names no source in this bundle (${s})`);
      if (ids.indexOf(s) !== j) issues.add(`${p}.sourceIds[${j}]`, "is listed twice");
    });
    let method: string | null = null;
    if (kind === "estimate") method = readText(issues, `${p}.method`, c.method, { max: 1_000 });
    else if (c.method !== null) issues.add(`${p}.method`, "must be null unless the claim is an estimate");
    let financial: EvidenceClaim["financial"] = null;
    if (c.financial !== null) {
      const f = readObject(issues, `${p}.financial`, c.financial, ["basis"]);
      if (f !== null) {
        const basis = readOneOf(issues, `${p}.financial.basis`, f.basis, FINANCIAL_BASES);
        if (!BASES_FOR_KIND[kind].includes(basis)) issues.add(`${p}.financial.basis`, `must be ${BASES_FOR_KIND[kind].join(" or ")} for a ${kind}`);
        financial = Object.freeze({ basis });
      }
    }
    const operatorStatus = readOneOf(issues, `${p}.operatorStatus`, c.operatorStatus, ["unconfirmed", "confirmed"] as const);
    if (operatorStatus === "confirmed" && kind !== "fact") issues.add(`${p}.operatorStatus`, "only a fact can be confirmed");
    claims.push(Object.freeze({ id, statement, kind, sourceIds: Object.freeze(ids), method, financial, operatorStatus }));
  });

  const conflictList = readList(issues, "bundle.conflicts", o!.conflicts, { min: 0, max: 100 }) ?? [];
  const conflictIds = new Set<string>();
  const conflicts: EvidenceConflict[] = [];
  conflictList.forEach((raw_, i) => {
    const p = `bundle.conflicts[${i}]`;
    const c = readObject(issues, p, raw_, ["id", "claimIds", "status", "resolution"]);
    if (c === null) return;
    const id = readId(issues, `${p}.id`, c.id);
    if (conflictIds.has(id)) issues.add(`${p}.id`, `duplicates another conflict id (${id})`);
    conflictIds.add(id);
    const ids = (readList(issues, `${p}.claimIds`, c.claimIds, { min: 2, max: 10 }) ?? []).map((s, j) => readId(issues, `${p}.claimIds[${j}]`, s));
    ids.forEach((s, j) => {
      if (s && !claimIds.has(s)) issues.add(`${p}.claimIds[${j}]`, `names no claim in this bundle (${s})`);
      if (ids.indexOf(s) !== j) issues.add(`${p}.claimIds[${j}]`, "is listed twice");
    });
    const status = readOneOf(issues, `${p}.status`, c.status, ["unresolved", "resolved"] as const);
    let resolution: EvidenceConflict["resolution"] = null;
    if (status === "resolved") {
      const r = readObject(issues, `${p}.resolution`, c.resolution, ["favouredClaimId", "note", "decidedBy"]);
      if (r !== null) {
        const favouredClaimId = readId(issues, `${p}.resolution.favouredClaimId`, r.favouredClaimId);
        if (favouredClaimId && !ids.includes(favouredClaimId)) issues.add(`${p}.resolution.favouredClaimId`, "must be one of the conflicting claims");
        resolution = Object.freeze({
          favouredClaimId, note: readText(issues, `${p}.resolution.note`, r.note, { max: 1_000 }), decidedBy: readText(issues, `${p}.resolution.decidedBy`, r.decidedBy, { max: 100 }),
        });
      }
    } else if (c.resolution !== null) {
      issues.add(`${p}.resolution`, "must be null while the conflict is unresolved");
    }
    conflicts.push(Object.freeze({ id, claimIds: Object.freeze(ids), status, resolution }));
  });

  const missingList = readList(issues, "bundle.missingInformation", o!.missingInformation, { min: 0, max: 100 }) ?? [];
  const missingIds = new Set<string>();
  const missingInformation = missingList.map((raw_, i) => {
    const p = `bundle.missingInformation[${i}]`;
    const m = readObject(issues, p, raw_, ["id", "description", "blocking"]);
    if (m === null) return null;
    const id = readId(issues, `${p}.id`, m.id);
    if (missingIds.has(id)) issues.add(`${p}.id`, `duplicates another item id (${id})`);
    missingIds.add(id);
    return Object.freeze({ id, description: readText(issues, `${p}.description`, m.description, { max: 1_000 }), blocking: readBool(issues, `${p}.blocking`, m.blocking) });
  });
  issues.throwIfAny();
  return Object.freeze({
    version: 1 as const, asOf, maxSourceAgeDays, sources: Object.freeze(sources), claims: Object.freeze(claims),
    conflicts: Object.freeze(conflicts), missingInformation: Object.freeze(missingInformation as MissingInformation[]),
  });
}

function freshnessOf(s: SourceRecord, asOf: string, maxAgeDays: number): Freshness {
  if (s.publishedAt.status === "not_stated") return "date_unknown";
  if (dayNumber(asOf.slice(0, 10)) - dayNumber(s.publishedAt.value) > maxAgeDays) return "stale";
  return s.verification.publication_date.status === "verified" ? "fresh" : "date_asserted";
}

function supportOf(cited: readonly SourceRecord[], trust: ReadonlyMap<string, TrustSummary>): Support {
  if (cited.length === 0) return "no_sources";
  const verified = cited.filter((s) => trust.get(s.id)!.independentlyVerified);
  if (verified.some((s) => s.sourceClass === "primary")) return "verified_primary";
  const secondaries = verified.filter((s) => s.sourceClass === "secondary" && s.verification.independence.status === "verified");
  if (new Set(secondaries.map((s) => s.originId)).size >= 2) return "verified_independent_secondaries";
  return verified.length > 0 ? "verified_single_secondary" : "unverified_sources_only";
}

const QUALIFYING: readonly Support[] = ["verified_primary", "verified_independent_secondaries"];

/** Validates and assesses a bundle. Malformed input gives a "refused" result. Never approves anything. */
export function assessBusinessEvidence(raw: unknown): BusinessReadiness {
  let claims: ClaimStanding[] = [];
  let sources: TrustSummary[] = [];
  const base = assessOrRefuse("business_evidence", () => {
    const b = parseBusinessEvidence(raw);
    const byId = new Map(b.sources.map((s) => [s.id, s]));
    const trust = new Map(b.sources.map((s) => [s.id, trustSummary(s)]));
    sources = [...trust.values()];
    const fresh = new Map(b.sources.map((s) => [s.id, freshnessOf(s, b.asOf, b.maxSourceAgeDays)]));
    const unresolved = new Set(b.conflicts.filter((c) => c.status === "unresolved").flatMap((c) => c.claimIds));

    claims = b.claims.map((c) => {
      const cited = c.sourceIds.map((id) => byId.get(id)!);
      const support = supportOf(cited, trust);
      const reasons: string[] = [];
      let standing: Standing;
      if (c.kind === "fact") {
        if (!QUALIFYING.includes(support)) reasons.push(`evidence does not qualify (${support})`);
        for (const s of cited) if (fresh.get(s.id) !== "fresh") reasons.push(`source ${s.id} is not confirmed fresh (${fresh.get(s.id)})`);
        if (unresolved.has(c.id)) reasons.push("involved in an unresolved conflict");
        if (c.operatorStatus === "confirmed") standing = reasons.length === 0 ? "confirmed_fact" : "confirmation_not_substantiated";
        else standing = "unconfirmed_fact";
      } else if (c.kind === "estimate") {
        standing = c.financial?.basis === "unsupported_estimate" || support === "no_sources" || support === "unverified_sources_only" ? "unsupported_estimate" : "estimate";
      } else {
        standing = c.kind;
      }
      const financialUnsupported = c.financial !== null && (c.financial.basis === "unsupported_estimate" || !["verified_primary", "verified_independent_secondaries", "verified_single_secondary"].includes(support));
      return Object.freeze({ claimId: c.id, kind: c.kind, support, standing, label: financialUnsupported ? UNSUPPORTED_FINANCIAL_LABEL : null, reasons: Object.freeze(reasons) });
    });

    const checks: ReadinessCheck[] = [];
    const evidential = b.claims.filter((c) => c.kind === "fact" || c.kind === "estimate");
    const citedIds = [...new Set(evidential.flatMap((c) => c.sourceIds))].sort();

    const notVerified = citedIds.filter((id) => !trust.get(id)!.independentlyVerified);
    checks.push(check("source_provenance", notVerified.length === 0 ? "pass" : "unverified",
      notVerified.length === 0 ? "Every source cited by a fact or estimate is independently verified (content, publisher and origin)." : "Some cited sources are not independently verified.",
      notVerified.map((id) => {
        const t = trust.get(id)!;
        return `${id} (${t.sourceClass}): asserted ${t.asserted.join(", ") || "none"}; unverified ${t.unverified.join(", ") || "none"}`;
      })));

    const attribution: string[] = [];
    for (const c of b.claims) {
      const cited = c.sourceIds.map((id) => byId.get(id)!);
      if (c.kind === "fact" && cited.length === 0) attribution.push(`${c.id}: a fact cites no source`);
      else if (c.kind === "fact" && cited.every((s) => s.sourceClass === "unverified_claim")) attribution.push(`${c.id}: a fact cites only unverified claims`);
      if (c.financial?.basis === "derived_from_sourced" && cited.length === 0) attribution.push(`${c.id}: a figure "derived from sourced" inputs cites no source`);
    }
    checks.push(check("source_attribution", attribution.length === 0 ? "pass" : "fail",
      attribution.length === 0 ? "Every fact, and every figure said to be derived from sources, cites at least one traceable source." : "Some claims lack traceable source attribution.", attribution));

    const stale = citedIds.filter((id) => fresh.get(id) === "stale");
    const undated = citedIds.filter((id) => fresh.get(id) === "date_unknown" || fresh.get(id) === "date_asserted");
    checks.push(check("evidence_freshness", stale.length > 0 ? "fail" : undated.length > 0 ? "unverified" : "pass",
      stale.length > 0 ? `Some cited sources are older than ${b.maxSourceAgeDays} days.` : undated.length > 0 ? "Some cited sources have no stated or no verified publication date." : `Every cited source was published within ${b.maxSourceAgeDays} days (verified dates).`,
      [...stale.map((id) => `${id}: stale (published ${(byId.get(id)!.publishedAt as { value: string }).value})`), ...undated.map((id) => `${id}: ${fresh.get(id)}`)]));

    const open = b.conflicts.filter((c) => c.status === "unresolved");
    checks.push(check("conflicting_claims", open.length === 0 ? "pass" : "fail",
      open.length === 0 ? `No unresolved conflicts (${b.conflicts.length} recorded and resolved). Conflicts are operator-recorded, not detected automatically.` : "Some recorded conflicts between claims are unresolved.",
      [...open.map((c) => `${c.id}: unresolved between ${c.claimIds.join(", ")}`), ...b.conflicts.filter((c) => c.status === "resolved").map((c) => `${c.id}: resolved in favour of ${c.resolution!.favouredClaimId} by ${c.resolution!.decidedBy}`)]));

    const unsubstantiated = claims.filter((c) => c.standing === "confirmation_not_substantiated");
    const notPromoted = claims.filter((c) => c.standing === "unconfirmed_fact" && c.reasons.length === 0);
    checks.push(check("confirmed_claims_substantiated", unsubstantiated.length === 0 ? "pass" : "fail",
      unsubstantiated.length === 0 ? `Every operator confirmation is backed by qualifying evidence (${claims.filter((c) => c.standing === "confirmed_fact").length} confirmed facts).` : "Some operator-confirmed facts are not backed by qualifying evidence.",
      [...unsubstantiated.map((c) => `${c.claimId}: ${c.reasons.join("; ")}`), ...notPromoted.map((c) => `${c.claimId}: has qualifying evidence but stays unconfirmed (nothing is promoted automatically)`)]));

    const financial = claims.filter((c) => b.claims.find((x) => x.id === c.claimId)!.financial !== null);
    const labelled = financial.filter((c) => c.label !== null);
    checks.push(check("financial_claims_supported", labelled.length === 0 ? "pass" : "unverified",
      financial.length === 0 ? "No financial figures." : labelled.length === 0 ? "Every financial figure has independently verified support." : `Some financial figures are labelled ${UNSUPPORTED_FINANCIAL_LABEL}.`,
      labelled.map((c) => `${c.claimId}: ${UNSUPPORTED_FINANCIAL_LABEL} (${c.kind}; support: ${c.support})`)));

    const blocking = b.missingInformation.filter((m) => m.blocking);
    checks.push(check("missing_information", blocking.length === 0 ? "pass" : "fail",
      blocking.length === 0 ? `No blocking gaps (${b.missingInformation.length} non-blocking gap(s) recorded).` : "Some recorded gaps block reliance on this evidence.",
      b.missingInformation.map((m) => `${m.id}${m.blocking ? " (blocking)" : ""}: ${m.description}`)));

    return result("business_evidence", JSON.stringify(b), checks);
  });
  return Object.freeze({ ...base, claims: Object.freeze(base.overall === "refused" ? [] : claims), sources: Object.freeze(base.overall === "refused" ? [] : sources) });
}
