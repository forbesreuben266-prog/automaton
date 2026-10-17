/**
 * Source snapshots and claims.
 *
 * A snapshot is the exact text of a source as supplied (Phase 0/1: by the
 * operator; this module never fetches anything), with where it came from and
 * when it was collected. Its edit-check hash covers all metadata and the
 * content (it detects later edits; it is not tamper protection). Content is UNTRUSTED DATA: it is hashed, searched for quotes and
 * escaped on output, and never interpreted as instructions.
 *
 * Independence: a different publisher name proves nothing (one organisation
 * can trade under several names, and outlets repeat each other). Each
 * snapshot therefore records the operator-assigned `originId` of whoever
 * produced the underlying evidence, any snapshots it repeats
 * (`derivedFromSnapshotIds`), and whether its independence was actually
 * checked (`independenceVerified` + `independenceNote`). Unverified sources
 * are never counted as corroboration (see citations.ts).
 *
 * A claim is one statement labelled fact / estimate / assumption /
 * speculation. Facts must cite snapshots with exact quotes; estimates must
 * explain their method.
 */

import { createHash } from "node:crypto";
import {
  Issues, arr, assertString, bool, checkKeys, deepFreeze, id, isoDate, isoDateTime, oneOf, str, uniqueIds,
} from "./validation.js";

export const CLAIM_TYPES = ["fact", "estimate", "assumption", "speculation"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Size limits, so oversized input is refused before any expensive work. */
export const MAX_SNAPSHOT_CHARS = 500_000;
export const MAX_TOTAL_SNAPSHOT_CHARS = 5_000_000;
export const MAX_SNAPSHOTS = 200;
export const MAX_CLAIMS = 2_000;
export const MAX_CITATIONS_PER_CLAIM = 20;
/** Shortest quote accepted, after whitespace normalisation; stops trivial matches like "the". */
export const MIN_QUOTE_CHARS = 15;

export interface SourceSnapshot {
  readonly id: string;
  readonly url: string;
  readonly publisher: string;
  readonly title: string;
  /** Publication date, or null when the source doesn't state one (treated as stale). */
  readonly publishedAt: string | null;
  readonly retrievedAt: string;
  /** Operator-assigned id of the organisation/dataset that produced the evidence (not the display name). */
  readonly originId: string;
  /** Other snapshots this one repeats or syndicates; they are never independent of each other. */
  readonly derivedFromSnapshotIds: readonly string[];
  /** True only if the operator checked ownership/syndication; false = independence unknown. */
  readonly independenceVerified: boolean;
  /** How independence was checked (required when verified), or why it couldn't be. */
  readonly independenceNote: string;
  readonly content: string;
  /**
   * Edit-check SHA-256 over every field above in a fixed serialization (see
   * snapshotIntegrityHash). Verification compares it with the snapshot's own
   * fields, so it detects later or accidental edits only: anyone able to edit
   * a snapshot can recompute it. It is not tamper protection or authentication.
   */
  readonly integritySha256: string;
}

export interface Citation {
  readonly snapshotId: string;
  readonly quote: string;
}

export interface Claim {
  readonly id: string;
  readonly type: ClaimType;
  readonly statement: string;
  readonly citations: readonly Citation[];
  /** Required for estimates: how the figure was derived. */
  readonly method?: string;
}

export function sha256Hex(text: string): string {
  assertString(text, "text");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Whitespace-insensitive, Unicode-normalised form used for quote matching. Case is preserved. */
export function normalizeText(text: string): string {
  assertString(text, "text");
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Canonical form of a source URL, used only to decide whether two snapshots
 * are the same source (never for fetching). Deliberately conservative: it
 * removes only differences that can't distinguish one document from another.
 * - http and https are treated as the same source ("http(s)://");
 * - the host is lowercased (by the URL parser), a trailing dot is removed,
 *   and the scheme's default port is dropped (by the URL parser);
 * - the fragment (#...) is removed;
 * - the WHATWG URL parser's own normalisation applies (non-ASCII characters
 *   percent-encoded, "." and ".." path segments resolved, an empty "?" dropped);
 *   equivalent encodings it leaves alone (e.g. "%7E" vs "~") stay distinct.
 * Kept exactly: path (including case and any trailing slash), the whole query
 * string (every parameter, in order), "www." and other subdomains, and any
 * non-default port. Throws a TypeError for non-strings, invalid URLs, other
 * schemes and URLs with credentials.
 */
export function canonicalSourceUrl(url: string): string {
  assertString(url, "url");
  let parsed: URL;
  try {
    parsed = new URL(url); // parsing only; never requested
  } catch {
    throw new TypeError("url must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("url must use http or https");
  if (parsed.username || parsed.password) throw new TypeError("url must not contain credentials");
  const host = parsed.hostname.replace(/\.$/, "");
  const port = parsed.port ? `:${parsed.port}` : "";
  return `http(s)://${host}${port}${parsed.pathname}${parsed.search}`;
}

/**
 * Deterministic fingerprint of a snapshot's text: SHA-256 of the
 * whitespace- and Unicode-normalised content (normalizeText). Snapshots with
 * the same fingerprint are the same text and are never independent sources.
 */
export function sourceContentFingerprint(content: string): string {
  assertString(content, "content");
  return sha256Hex(normalizeText(content));
}

function checkUrl(issues: Issues, path: string, value: unknown): string {
  const text = str(issues, path, value, { max: 2_048 });
  if (!text) return text;
  let parsed: URL;
  try {
    parsed = new URL(text); // parsing only; never requested
  } catch {
    issues.add(path, "must be an absolute URL");
    return text;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") issues.add(path, "must use http or https");
  if (parsed.username || parsed.password) issues.add(path, "must not contain credentials");
  return text;
}

const SNAPSHOT_FIELDS = [
  "id", "url", "publisher", "title", "publishedAt", "retrievedAt", "originId",
  "derivedFromSnapshotIds", "independenceVerified", "independenceNote", "content",
] as const;
const INTEGRITY_DOMAIN = "automaton/business-research/snapshot/v1";

/**
 * Deterministic edit-check hash of a snapshot's metadata and content: SHA-256
 * of the JSON array [domain, ...fields in SNAPSHOT_FIELDS order]. Arrays keep
 * their order and JSON escaping is fixed, so the same snapshot always hashes
 * the same and changing any field (including dates or the independence flag)
 * changes the hash. Module-private: it is only ever called on fields that
 * createSnapshot/readSnapshot have already validated.
 */
function snapshotIntegrityHash(fields: Omit<SourceSnapshot, "integritySha256">): string {
  const serialized = JSON.stringify([INTEGRITY_DOMAIN, ...SNAPSHOT_FIELDS.map((k) => fields[k])]);
  return sha256Hex(serialized);
}

/**
 * Builds a snapshot from operator-supplied fields, computing its integrity
 * hash. The input is validated (plain data object, no getters, every field a
 * primitive of the right type) BEFORE any value is read or converted.
 */
export function createSnapshot(input: unknown): SourceSnapshot {
  const issues = new Issues();
  if (!checkKeys(issues, "snapshot", input, SNAPSHOT_FIELDS)) issues.throwIfAny();
  const fields = readSnapshotFields(issues, "snapshot", input as Record<string, unknown>);
  issues.throwIfAny();
  return deepFreeze({ ...fields, integritySha256: snapshotIntegrityHash(fields) });
}

export function parseSnapshot(raw: unknown, path = "snapshot"): SourceSnapshot {
  const issues = new Issues();
  const snapshot = readSnapshot(issues, path, raw);
  issues.throwIfAny();
  return snapshot;
}

function readSnapshot(issues: Issues, path: string, raw: unknown): SourceSnapshot {
  if (!checkKeys(issues, path, raw, [...SNAPSHOT_FIELDS, "integritySha256"])) return undefined as never;
  const issuesBefore = issues.list.length;
  const fields = readSnapshotFields(issues, path, raw);
  const integritySha256 = str(issues, `${path}.integritySha256`, raw.integritySha256, { pattern: /^[0-9a-f]{64}$/ });
  // Hash only well-formed fields (this snapshot's own issues, not earlier array items').
  if (issues.list.length === issuesBefore && snapshotIntegrityHash(fields) !== integritySha256) {
    issues.add(`${path}.integritySha256`, "does not match the snapshot's metadata and content (edited after creation, or corrupted)");
  }
  return deepFreeze({ ...fields, integritySha256 });
}

function readSnapshotFields(issues: Issues, path: string, raw: Record<string, unknown>): Omit<SourceSnapshot, "integritySha256"> {
  const content = str(issues, `${path}.content`, raw.content, { max: MAX_SNAPSHOT_CHARS });
  const publishedAt = raw.publishedAt === null ? null : isoDate(issues, `${path}.publishedAt`, raw.publishedAt);
  const retrievedAt = isoDateTime(issues, `${path}.retrievedAt`, raw.retrievedAt);
  if (publishedAt && retrievedAt && publishedAt > retrievedAt.slice(0, 10)) {
    issues.add(`${path}.publishedAt`, "is after retrievedAt");
  }
  const snapshotId = id(issues, `${path}.id`, raw.id);
  const derivedFromSnapshotIds = arr(issues, `${path}.derivedFromSnapshotIds`, raw.derivedFromSnapshotIds, { max: 50 })
    .map((d, i) => id(issues, `${path}.derivedFromSnapshotIds[${i}]`, d));
  if (derivedFromSnapshotIds.includes(snapshotId)) issues.add(`${path}.derivedFromSnapshotIds`, "must not include the snapshot itself");
  const independenceVerified = bool(issues, `${path}.independenceVerified`, raw.independenceVerified);
  const independenceNote = str(issues, `${path}.independenceNote`, raw.independenceNote, { min: independenceVerified ? 1 : 0, max: 1_000 });
  return {
    id: snapshotId,
    url: checkUrl(issues, `${path}.url`, raw.url),
    publisher: str(issues, `${path}.publisher`, raw.publisher, { max: 200 }),
    title: str(issues, `${path}.title`, raw.title, { max: 500 }),
    publishedAt,
    retrievedAt,
    originId: id(issues, `${path}.originId`, raw.originId),
    derivedFromSnapshotIds,
    independenceVerified,
    independenceNote,
    content,
  };
}

export function parseClaim(raw: unknown, path = "claim"): Claim {
  const issues = new Issues();
  const claim = readClaim(issues, path, raw);
  issues.throwIfAny();
  return claim;
}

function readClaim(issues: Issues, path: string, raw: unknown): Claim {
  if (!checkKeys(issues, path, raw, ["id", "type", "statement", "citations"], ["method"])) return undefined as never;
  const type = oneOf(issues, `${path}.type`, raw.type, CLAIM_TYPES);
  const citations = arr(issues, `${path}.citations`, raw.citations, { max: MAX_CITATIONS_PER_CLAIM }).map((c, i) => {
    const cp = `${path}.citations[${i}]`;
    if (!checkKeys(issues, cp, c, ["snapshotId", "quote"])) return { snapshotId: "", quote: "" };
    return {
      snapshotId: id(issues, `${cp}.snapshotId`, c.snapshotId),
      quote: str(issues, `${cp}.quote`, c.quote, { max: 2_000 }),
    };
  });
  let method: string | undefined;
  if (raw.method !== undefined) method = str(issues, `${path}.method`, raw.method, { max: 4_000 });
  if (type === "estimate" && method === undefined) issues.add(`${path}.method`, "is required for estimates");
  return deepFreeze({
    id: id(issues, `${path}.id`, raw.id),
    type,
    statement: str(issues, `${path}.statement`, raw.statement, { max: 2_000 }),
    citations,
    ...(method !== undefined ? { method } : {}),
  });
}

/** Parses arrays of snapshots and claims, checking ids are unique. */
export function parseSourcesAndClaims(rawSnapshots: unknown, rawClaims: unknown): {
  snapshots: SourceSnapshot[];
  claims: Claim[];
} {
  const issues = new Issues();
  const snapshotList = arr(issues, "snapshots", rawSnapshots, { max: MAX_SNAPSHOTS });
  const claimList = arr(issues, "claims", rawClaims, { max: MAX_CLAIMS });
  issues.throwIfAny(); // refuse oversized arrays before reading any element
  const snapshots = snapshotList.map((s, i) => readSnapshot(issues, `snapshots[${i}]`, s));
  const claims = claimList.map((c, i) => readClaim(issues, `claims[${i}]`, c));
  issues.throwIfAny();
  const totalChars = snapshots.reduce((sum, s) => sum + s.content.length, 0);
  if (totalChars > MAX_TOTAL_SNAPSHOT_CHARS) {
    issues.add("snapshots", `total content is ${totalChars} characters; the limit is ${MAX_TOTAL_SNAPSHOT_CHARS}`);
  }
  uniqueIds(issues, "snapshots", snapshots.map((s) => s.id));
  uniqueIds(issues, "claims", claims.map((c) => c.id));
  const snapshotIds = new Set(snapshots.map((s) => s.id));
  snapshots.forEach((s, i) => s.derivedFromSnapshotIds.forEach((d) => {
    if (!snapshotIds.has(d)) issues.add(`snapshots[${i}].derivedFromSnapshotIds`, `unknown snapshot "${d}"`);
  }));
  issues.throwIfAny();
  return { snapshots, claims };
}
