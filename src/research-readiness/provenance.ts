/**
 * Source records and provenance (milestone R1). Pure and deterministic.
 *
 * A source record describes ONE retrieved source: who published it, who
 * produced the underlying evidence, when it was retrieved and published, the
 * SHA-256 of the exact content retrieved, and, aspect by aspect, what was
 * independently verified versus merely asserted. Nothing is fetched or
 * checked online here; the record is the operator's account, validated for
 * completeness and internal consistency.
 *
 * Source classes:
 * - primary: the publisher produced the evidence itself (originId must equal
 *   publisherId; it repeats no other source);
 * - secondary: the publisher reports evidence produced by someone else
 *   (originId, when known, must differ from publisherId);
 * - unverified_claim: a statement whose origin can't be traced (its origin
 *   can't be marked verified; reclassify it once traced).
 *
 * Verification, for each of five aspects (content_integrity,
 * publisher_identity, publication_date, origin, independence), is stated
 * explicitly; nothing is defaulted:
 * - verified: basis "independent_check", with who checked, when, and how;
 * - asserted: basis "source_self_statement" or "operator_statement": someone
 *   SAYS it is so, nobody checked;
 * - unverified: basis "none".
 * A source's own statement (including any claim to be official, audited or
 * trustworthy) is never independent verification: marking it "verified" is
 * refused. Words in a title or publisher name change nothing.
 */

import { sha256Hex } from "./readiness.js";
import {
  Issues, readDate, readId, readList, readObject, readOneOf, readSha256, readText, readTimestamp,
} from "./validation.js";

export const SOURCE_CLASSES = ["primary", "secondary", "unverified_claim"] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];
export const ASPECTS = ["content_integrity", "publisher_identity", "publication_date", "origin", "independence"] as const;
export type Aspect = (typeof ASPECTS)[number];
export const ATTESTATION_STATUSES = ["verified", "asserted", "unverified"] as const;
export type AttestationStatus = (typeof ATTESTATION_STATUSES)[number];
export const BASES = ["independent_check", "source_self_statement", "operator_statement", "none"] as const;
export type Basis = (typeof BASES)[number];
export const MAX_SOURCES = 200;
const URL_LOCATOR = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s]*)?$/;

export interface Attestation {
  readonly status: AttestationStatus;
  readonly basis: Basis;
  /** How it was checked (verified), what was stated and by whom (asserted), or why it couldn't be checked (unverified). */
  readonly note: string;
  /** Verified only: who checked (null otherwise). */
  readonly checkedBy: string | null;
  /** Verified only: when (null otherwise). */
  readonly checkedAt: string | null;
}

export interface SourceRecord {
  readonly id: string;
  readonly sourceClass: SourceClass;
  readonly publisher: string;
  /** Operator-assigned id of the publishing organisation (not its display name). */
  readonly publisherId: string;
  /** Operator-assigned id of whoever produced the underlying evidence, or null when unknown. */
  readonly originId: string | null;
  readonly title: string;
  readonly locator: { readonly kind: "url" | "document"; readonly value: string };
  readonly retrievedAt: string;
  readonly publishedAt: { readonly status: "stated"; readonly value: string } | { readonly status: "not_stated" };
  /** SHA-256 of the exact retrieved content (UTF-8 text). */
  readonly contentSha256: string;
  readonly derivedFromSourceIds: readonly string[];
  readonly verification: Readonly<Record<Aspect, Attestation>>;
}

const BASIS_FOR: Record<AttestationStatus, readonly Basis[]> = {
  verified: ["independent_check"],
  asserted: ["source_self_statement", "operator_statement"],
  unverified: ["none"],
};

/** Reads one attestation; `earliest` bounds a verified check's time from below (e.g. the retrieval time). */
export function readAttestation(issues: Issues, path: string, value: unknown, bounds: { earliest: string | null; asOf: string }): Attestation | null {
  const o = readObject(issues, path, value, ["status", "basis", "note", "checkedBy", "checkedAt"]);
  if (o === null) return null;
  const status = readOneOf(issues, `${path}.status`, o.status, ATTESTATION_STATUSES);
  const basis = readOneOf(issues, `${path}.basis`, o.basis, BASES);
  const note = readText(issues, `${path}.note`, o.note, { max: 500 });
  if (basis === "source_self_statement" && status === "verified") {
    issues.add(`${path}.status`, "a source's own statement is never independent verification (use \"asserted\")");
  } else if (!BASIS_FOR[status].includes(basis)) {
    issues.add(`${path}.basis`, `must be ${BASIS_FOR[status].join(" or ")} when status is ${status}`);
  }
  let checkedBy: string | null = null;
  let checkedAt: string | null = null;
  if (status === "verified") {
    checkedBy = readText(issues, `${path}.checkedBy`, o.checkedBy, { max: 100 });
    checkedAt = readTimestamp(issues, `${path}.checkedAt`, o.checkedAt);
    if (checkedAt && checkedAt > bounds.asOf) issues.add(`${path}.checkedAt`, "must not be later than the assessment time (asOf)");
    if (checkedAt && bounds.earliest && checkedAt < bounds.earliest) issues.add(`${path}.checkedAt`, "must not be earlier than the retrieval it checks");
  } else {
    if (o.checkedBy !== null) issues.add(`${path}.checkedBy`, "must be null unless verified");
    if (o.checkedAt !== null) issues.add(`${path}.checkedAt`, "must be null unless verified");
  }
  return Object.freeze({ status, basis, note, checkedBy, checkedAt });
}

const SOURCE_KEYS = [
  "id", "sourceClass", "publisher", "publisherId", "originId", "title", "locator", "retrievedAt", "publishedAt",
  "contentSha256", "derivedFromSourceIds", "verification",
];

/**
 * Reads one source record (asOf: the assessment time, a UTC timestamp).
 * `knownIds` are the other source ids it may be derived from.
 */
export function readSourceRecord(issues: Issues, path: string, value: unknown, asOf: string, knownIds: ReadonlySet<string>): SourceRecord | null {
  const before = issues.count;
  const o = readObject(issues, path, value, SOURCE_KEYS);
  if (o === null) return null;
  const id = readId(issues, `${path}.id`, o.id);
  const sourceClass = readOneOf(issues, `${path}.sourceClass`, o.sourceClass, SOURCE_CLASSES);
  const publisher = readText(issues, `${path}.publisher`, o.publisher, { max: 200 });
  const publisherId = readId(issues, `${path}.publisherId`, o.publisherId);
  const originId = o.originId === null ? null : readId(issues, `${path}.originId`, o.originId);
  const title = readText(issues, `${path}.title`, o.title, { max: 300 });

  const l = readObject(issues, `${path}.locator`, o.locator, ["kind", "value"]);
  let locator: SourceRecord["locator"] | null = null;
  if (l !== null) {
    const kind = readOneOf(issues, `${path}.locator.kind`, l.kind, ["url", "document"] as const);
    const v = readText(issues, `${path}.locator.value`, l.value, { max: 2_048 });
    if (kind === "url" && v && !URL_LOCATOR.test(v)) issues.add(`${path}.locator.value`, "must be an http(s) URL without credentials or spaces (it is recorded, never requested)");
    locator = Object.freeze({ kind, value: v });
  }
  const retrievedAt = readTimestamp(issues, `${path}.retrievedAt`, o.retrievedAt);
  if (retrievedAt && retrievedAt > asOf) issues.add(`${path}.retrievedAt`, "must not be later than the assessment time (asOf)");

  const p = readObject(issues, `${path}.publishedAt`, o.publishedAt, ["status"], ["value"]);
  let publishedAt: SourceRecord["publishedAt"] | null = null;
  if (p !== null) {
    const status = readOneOf(issues, `${path}.publishedAt.status`, p.status, ["stated", "not_stated"] as const);
    if (status === "stated") {
      const v = readDate(issues, `${path}.publishedAt.value`, p.value);
      if (v && retrievedAt && v > retrievedAt.slice(0, 10)) issues.add(`${path}.publishedAt.value`, "must not be later than the retrieval date");
      publishedAt = Object.freeze({ status, value: v });
    } else {
      if ("value" in p) issues.add(`${path}.publishedAt.value`, "must be omitted when the publication date is not stated");
      publishedAt = Object.freeze({ status });
    }
  }
  const contentSha256 = readSha256(issues, `${path}.contentSha256`, o.contentSha256);
  const derivedList = readList(issues, `${path}.derivedFromSourceIds`, o.derivedFromSourceIds, { min: 0, max: 20 }) ?? [];
  const derivedFromSourceIds = derivedList.map((d, i) => readId(issues, `${path}.derivedFromSourceIds[${i}]`, d));
  derivedFromSourceIds.forEach((d, i) => {
    if (d === id) issues.add(`${path}.derivedFromSourceIds[${i}]`, "must not be the source itself");
    else if (d && !knownIds.has(d)) issues.add(`${path}.derivedFromSourceIds[${i}]`, `names no source in this input (${d})`);
  });

  const v = readObject(issues, `${path}.verification`, o.verification, ASPECTS);
  const verification: Partial<Record<Aspect, Attestation>> = {};
  if (v !== null) {
    for (const aspect of ASPECTS) {
      const a = readAttestation(issues, `${path}.verification.${aspect}`, v[aspect], { earliest: retrievedAt || null, asOf });
      if (a) verification[aspect] = a;
    }
  }
  if (issues.count > before) return null;

  // Consistency between the class, the origin and what is claimed to be verified.
  if (sourceClass === "primary") {
    if (originId !== publisherId) issues.add(`${path}.originId`, "must equal publisherId for a primary source (the publisher produced the evidence)");
    if (derivedFromSourceIds.length > 0) issues.add(`${path}.derivedFromSourceIds`, "must be empty for a primary source");
  } else if (sourceClass === "secondary") {
    if (originId !== null && originId === publisherId) issues.add(`${path}.originId`, "must differ from publisherId for a secondary source (or classify it as primary)");
  } else if (verification.origin!.status === "verified") {
    issues.add(`${path}.verification.origin`, "an unverified claim's origin can't be verified (reclassify the source as primary or secondary once traced)");
  }
  if (verification.origin!.status === "verified" && originId === null) issues.add(`${path}.verification.origin`, "can't be verified while originId is unknown (null)");
  if (verification.publication_date!.status !== "unverified" && publishedAt!.status === "not_stated") {
    issues.add(`${path}.verification.publication_date`, "must be unverified when no publication date is stated");
  }
  if (issues.count > before) return null;
  return Object.freeze({
    id, sourceClass, publisher, publisherId, originId, title, locator: locator!, retrievedAt, publishedAt: publishedAt!, contentSha256,
    derivedFromSourceIds: Object.freeze(derivedFromSourceIds), verification: Object.freeze(verification as Record<Aspect, Attestation>),
  });
}

/** Reads a list of source records with unique ids (derivations may refer to any of them). */
export function readSourceRecords(issues: Issues, path: string, value: unknown, asOf: string, limits = { min: 1, max: MAX_SOURCES }): SourceRecord[] {
  const list = readList(issues, path, value, limits);
  if (list === null) return [];
  const ids = new Set<string>();
  list.forEach((s, i) => {
    const raw = typeof s === "object" && s !== null ? Object.getOwnPropertyDescriptor(s, "id") : undefined;
    const sid = raw && "value" in raw && typeof raw.value === "string" ? raw.value : "";
    if (ids.has(sid)) issues.add(`${path}[${i}].id`, `duplicates another source id (${sid})`);
    ids.add(sid);
  });
  return list.map((s, i) => readSourceRecord(issues, `${path}[${i}]`, s, asOf, ids)).filter((s): s is SourceRecord => s !== null);
}

export interface TrustSummary {
  readonly sourceId: string;
  readonly sourceClass: SourceClass;
  /** Content, publisher identity and origin all independently verified. */
  readonly independentlyVerified: boolean;
  readonly verified: readonly Aspect[];
  readonly asserted: readonly Aspect[];
  readonly unverified: readonly Aspect[];
}

/** What is verified versus merely asserted for one source. Derived only from the attestations, never from names or titles. */
export function trustSummary(s: SourceRecord): TrustSummary {
  const by = (status: AttestationStatus) => Object.freeze(ASPECTS.filter((a) => s.verification[a].status === status));
  const verified = by("verified");
  return Object.freeze({
    sourceId: s.id, sourceClass: s.sourceClass, verified, asserted: by("asserted"), unverified: by("unverified"),
    independentlyVerified: s.sourceClass !== "unverified_claim" && ["content_integrity", "publisher_identity", "origin"].every((a) => verified.includes(a as Aspect)),
  });
}

/** True when `content` is exactly the text whose SHA-256 the record holds (a local edit check, not authentication). */
export function contentMatches(s: SourceRecord, content: unknown): boolean {
  return typeof content === "string" && sha256Hex(content) === s.contentSha256;
}
