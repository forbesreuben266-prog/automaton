/**
 * Deterministic citation verification and evidence grading.
 *
 * A citation is valid only if its snapshot exists, was collected on or before
 * the report date, and contains the quote verbatim (after Unicode and
 * whitespace normalisation; case-sensitive). A fact is supported only if it
 * has at least one citation, every citation is valid, and every number in the
 * statement appears in a quote. No model is involved, so the same inputs
 * always give the same result.
 */

import {
  MIN_QUOTE_CHARS, canonicalSourceUrl, normalizeText, parseSourcesAndClaims, sourceContentFingerprint,
  type Claim, type ClaimType, type SourceSnapshot,
} from "./sources.js";
import { Issues, arr, assertString, daysBetween, id, isoDate, safeInt } from "./validation.js";

export const EVIDENCE_GRADES = ["A", "B", "C", "D"] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

/** Sources older than this (by publication date, relative to the report date) count as stale. */
export const DEFAULT_MAX_SOURCE_AGE_DAYS = 365;

export type ClaimStatus =
  | "supported" //        fact/estimate whose citations and numbers check out
  | "unsupported" //      fact without citations, or a number that isn't in any quote/method
  | "invalid_citation" // a quote doesn't match its snapshot, or the snapshot is missing/future-dated
  | "labelled_only"; //   assumption/speculation: needs no citation, shown with its label

export interface ClaimVerification {
  readonly claimId: string;
  readonly type: ClaimType;
  readonly status: ClaimStatus;
  readonly problems: readonly string[];
  /** Snapshots whose quotes verified for this claim. */
  readonly verifiedSnapshotIds: readonly string[];
}

/** Numbers as written (thousand separators removed), e.g. "1,250" -> "1250", "3.5" -> "3.5". */
export function extractNumbers(text: string): string[] {
  assertString(text, "text");
  const matches = text.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return matches.map((m) => m.replace(/,(?=\d{3}(?:\D|$))/g, ""));
}

/** Maximum age limit accepted by gradeEvidence (10 years). */
export const MAX_SOURCE_AGE_LIMIT_DAYS = 3_650;

/**
 * Verifies claims against snapshots. Inputs are re-validated here (strict
 * schemas, integrity hashes, size limits), so a forged or edited snapshot or
 * claim can't be verified by calling this directly.
 */
export function verifyClaims(claims: unknown, snapshots: unknown, asOf: unknown): Map<string, ClaimVerification> {
  const v = validatedInputs(snapshots, claims, asOf);
  return verifyParsed(v.claims, v.snapshots, v.asOf);
}

function validatedInputs(snapshots: unknown, claims: unknown, asOf: unknown) {
  const parsed = parseSourcesAndClaims(snapshots, claims);
  const issues = new Issues();
  const date = isoDate(issues, "asOf", asOf);
  issues.throwIfAny();
  return { ...parsed, asOf: date };
}

function verifyParsed(
  claims: readonly Claim[],
  snapshots: readonly SourceSnapshot[],
  asOf: string,
): Map<string, ClaimVerification> {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const normalizedContent = new Map(snapshots.map((s) => [s.id, normalizeText(s.content)]));
  const results = new Map<string, ClaimVerification>();

  for (const claim of claims) {
    const problems: string[] = [];
    const verified = new Set<string>();
    const verifiedQuotes: string[] = [];
    let invalid = false;

    for (const [i, citation] of claim.citations.entries()) {
      const snapshot = byId.get(citation.snapshotId);
      const quote = normalizeText(citation.quote);
      if (!snapshot) {
        problems.push(`citation ${i + 1}: snapshot "${citation.snapshotId}" was not supplied`);
        invalid = true;
      } else if (snapshot.retrievedAt.slice(0, 10) > asOf) {
        problems.push(`citation ${i + 1}: snapshot "${snapshot.id}" was retrieved after the report date ${asOf}`);
        invalid = true;
      } else if (quote.length < MIN_QUOTE_CHARS) {
        problems.push(`citation ${i + 1}: quote is shorter than ${MIN_QUOTE_CHARS} characters`);
        invalid = true;
      } else if (!normalizedContent.get(snapshot.id)!.includes(quote)) {
        problems.push(`citation ${i + 1}: quote does not appear in snapshot "${snapshot.id}"`);
        invalid = true;
      } else {
        verified.add(snapshot.id);
        verifiedQuotes.push(quote);
      }
    }

    let status: ClaimStatus;
    if (invalid) {
      status = "invalid_citation";
    } else if (claim.type === "assumption" || claim.type === "speculation") {
      status = "labelled_only";
    } else {
      const traceable = new Set(extractNumbers([...verifiedQuotes, claim.method ?? ""].join(" ")));
      const untraced = extractNumbers(claim.statement).filter((n) => !traceable.has(n));
      if (claim.type === "fact" && claim.citations.length === 0) {
        problems.push("fact has no citation");
        status = "unsupported";
      } else if (untraced.length > 0) {
        problems.push(`number(s) ${untraced.join(", ")} not found in any verified quote${claim.type === "estimate" ? " or the method" : ""}`);
        status = "unsupported";
      } else {
        status = "supported";
      }
    }
    results.set(claim.id, Object.freeze({
      claimId: claim.id,
      type: claim.type,
      status,
      problems: Object.freeze(problems),
      verifiedSnapshotIds: Object.freeze([...verified]),
    }));
  }
  return results;
}

export type Corroboration =
  | "none" //                     no verified evidence
  | "single_origin" //            all evidence traces to one origin
  | "independent" //              2+ origins, all with checked independence
  | "unverified_independence"; // more origins than can be shown to be independent

export interface EvidenceAssessment {
  readonly grade: EvidenceGrade;
  /**
   * Origins that can be counted as independent: groups whose independence was
   * checked, or 1 if all evidence is unchecked. Never inferred from publisher names.
   */
  readonly independentSources: number;
  /** Same, counting only origins with a source published within the age limit. */
  readonly freshIndependentSources: number;
  /** Distinct origin groups (same originId or derivedFrom links merged), checked or not. */
  readonly distinctOrigins: number;
  /** Origin groups whose independence wasn't checked; they add no corroboration. */
  readonly unverifiedOrigins: number;
  readonly corroboration: Corroboration;
  /** Referenced claims that give no evidence (unsupported, invalid, or labelled only). */
  readonly nonEvidenceClaimIds: readonly string[];
  /** Referenced claim ids that don't exist. */
  readonly unknownClaimIds: readonly string[];
}

/** Two or more snapshots that are the same source (same canonical URL or same text) but declare different origins. */
export interface SourceIdentityConflict {
  readonly kind: "url" | "content";
  readonly snapshotIds: readonly string[];
  readonly originIds: readonly string[];
}

interface OriginGrouping {
  /** snapshot id -> group key */
  readonly groupOf: Map<string, string>;
  /** Groups containing an identity conflict: never counted as checked/independent. */
  readonly conflictedGroups: ReadonlySet<string>;
  readonly conflicts: readonly SourceIdentityConflict[];
}

/**
 * Groups snapshots that can't be independent of each other. Snapshots are
 * merged (transitively) when they share an `originId`, are linked by
 * `derivedFromSnapshotIds` (either direction), share a canonical URL
 * (canonicalSourceUrl), or have identical text (sourceContentFingerprint).
 * Merging only ever reduces the independent-origin count. Returns snapshot
 * id -> group key.
 */
export function originGroups(snapshots: unknown): Map<string, string> {
  return groupOrigins(parseSourcesAndClaims(snapshots, []).snapshots).groupOf;
}

/**
 * Lists snapshots that are the same source (same canonical URL or identical
 * text) yet declare different origins. Such groups are treated as one origin
 * whose independence is unverified (fail closed), whatever their flags say.
 */
export function sourceIdentityConflicts(snapshots: unknown): SourceIdentityConflict[] {
  return [...groupOrigins(parseSourcesAndClaims(snapshots, []).snapshots).conflicts];
}

function groupOrigins(snapshots: readonly SourceSnapshot[]): OriginGrouping {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const node = (key: string) => { if (!parent.has(key)) parent.set(key, key); };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const identity = (s: SourceSnapshot) => ({
    url: `u:${canonicalSourceUrl(s.url)}`,
    content: `c:${sourceContentFingerprint(s.content)}`,
  });
  const ids = new Map(snapshots.map((s) => [s.id, identity(s)]));
  for (const s of snapshots) {
    const { url, content } = ids.get(s.id)!;
    for (const key of [`s:${s.id}`, `o:${s.originId}`, url, content]) node(key);
  }
  for (const s of snapshots) {
    const { url, content } = ids.get(s.id)!;
    union(`s:${s.id}`, `o:${s.originId}`);
    union(`s:${s.id}`, url);
    union(`s:${s.id}`, content);
    for (const d of s.derivedFromSnapshotIds) if (parent.has(`s:${d}`)) union(`s:${s.id}`, `s:${d}`);
  }
  const groupOf = new Map(snapshots.map((s) => [s.id, find(`s:${s.id}`)]));

  // Same canonical URL or same text but different declared origins: an inconsistent identity.
  const conflicts: SourceIdentityConflict[] = [];
  const conflictedGroups = new Set<string>();
  for (const kind of ["url", "content"] as const) {
    const byKey = new Map<string, SourceSnapshot[]>();
    for (const s of snapshots) {
      const key = ids.get(s.id)![kind];
      byKey.set(key, [...(byKey.get(key) ?? []), s]);
    }
    for (const members of byKey.values()) {
      const origins = [...new Set(members.map((m) => m.originId))].sort();
      if (origins.length > 1) {
        conflicts.push({ kind, snapshotIds: members.map((m) => m.id).sort(), originIds: origins });
        for (const m of members) conflictedGroups.add(groupOf.get(m.id)!);
      }
    }
  }
  return { groupOf, conflictedGroups, conflicts };
}

/**
 * Grades the evidence behind a set of claims, counting independent ORIGINS:
 * A = 2+ independent fresh origins; B = 2+ independent origins of any age,
 * or 1 fresh; C = 1 stale/undated origin; D = no verified evidence.
 * An origin whose independence wasn't checked can't be one of the "2+".
 */
export function gradeEvidence(
  claimIds: unknown,
  claims: unknown,
  snapshots: unknown,
  asOf: unknown,
  maxAgeDays: unknown = DEFAULT_MAX_SOURCE_AGE_DAYS,
): EvidenceAssessment {
  // Everything is re-validated; a caller-supplied verification result is never trusted.
  const v = validatedInputs(snapshots, claims, asOf);
  const issues = new Issues();
  const ids = arr(issues, "claimIds", claimIds, { max: 100 }).map((c, i) => id(issues, `claimIds[${i}]`, c));
  const maxAge = safeInt(issues, "maxAgeDays", maxAgeDays, { min: 0, max: MAX_SOURCE_AGE_LIMIT_DAYS });
  issues.throwIfAny();
  return gradeParsed(ids, verifyParsed(v.claims, v.snapshots, v.asOf), v.snapshots, v.asOf, maxAge);
}

/**
 * Grades several claim-id sets against one validated set of claims and
 * snapshots (validated once). Used by scoring for criteria and hard gates.
 */
export function gradeEvidenceSets(
  claimIdSets: unknown,
  claims: unknown,
  snapshots: unknown,
  asOf: unknown,
): EvidenceAssessment[] {
  const v = validatedInputs(snapshots, claims, asOf);
  const issues = new Issues();
  const sets = arr(issues, "claimIdSets", claimIdSets, { max: 100 }).map((set, i) =>
    arr(issues, `claimIdSets[${i}]`, set, { max: 100 }).map((c, j) => id(issues, `claimIdSets[${i}][${j}]`, c)));
  issues.throwIfAny();
  const verification = verifyParsed(v.claims, v.snapshots, v.asOf);
  return sets.map((ids) => gradeParsed(ids, verification, v.snapshots, v.asOf, DEFAULT_MAX_SOURCE_AGE_DAYS));
}

function gradeParsed(
  claimIds: readonly string[],
  verification: ReadonlyMap<string, ClaimVerification>,
  snapshots: readonly SourceSnapshot[],
  asOf: string,
  maxAgeDays: number,
): EvidenceAssessment {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const { groupOf, conflictedGroups } = groupOrigins(snapshots);
  const groups = new Map<string, { checked: boolean; fresh: boolean }>();
  const nonEvidence: string[] = [];
  const unknown: string[] = [];

  for (const claimId of claimIds) {
    const v = verification.get(claimId);
    if (!v) {
      unknown.push(claimId);
      continue;
    }
    if (v.status !== "supported") {
      nonEvidence.push(claimId);
      continue;
    }
    for (const snapshotId of v.verifiedSnapshotIds) {
      const s = byId.get(snapshotId)!;
      const key = groupOf.get(snapshotId)!;
      const fresh = s.publishedAt !== null && daysBetween(s.publishedAt, asOf) <= maxAgeDays;
      const g = groups.get(key) ?? { checked: true, fresh: true };
      // Checked only if every snapshot used was checked and the group has no identity conflict (fail closed).
      // Fresh only if every snapshot used from the group is fresh: a newer duplicate never makes stale evidence fresh.
      groups.set(key, { checked: g.checked && s.independenceVerified && !conflictedGroups.has(key), fresh: g.fresh && fresh });
    }
  }

  const all = [...groups.values()];
  const checked = all.filter((g) => g.checked);
  const independentSources = Math.max(checked.length, all.length > 0 ? 1 : 0);
  const freshIndependentSources = Math.max(checked.filter((g) => g.fresh).length, all.some((g) => g.fresh) ? 1 : 0);
  const unverifiedOrigins = all.length - checked.length;

  let grade: EvidenceGrade;
  if (freshIndependentSources >= 2) grade = "A";
  else if (independentSources >= 2 || freshIndependentSources === 1) grade = "B";
  else if (independentSources === 1) grade = "C";
  else grade = "D";

  let corroboration: Corroboration;
  if (all.length === 0) corroboration = "none";
  else if (all.length === 1) corroboration = "single_origin";
  else if (independentSources < all.length) corroboration = "unverified_independence";
  else corroboration = "independent";

  return Object.freeze({
    grade,
    independentSources,
    freshIndependentSources,
    distinctOrigins: all.length,
    unverifiedOrigins,
    corroboration,
    nonEvidenceClaimIds: Object.freeze(nonEvidence),
    unknownClaimIds: Object.freeze(unknown),
  });
}
