/**
 * Offline import and quarantine (milestone R2). Pure and deterministic: the
 * caller supplies the manifest and content TEXT (the unified CLI reads them
 * with its read-only, no-follow file reader); nothing here touches files,
 * the network, clocks or the research engines.
 *
 * Import manifest (version 1), every field required, nothing defaulted:
 *   { version, importId, receivedAt, receivedBy, preparedAt, dataType, dataOrigin,
 *     content: { file, format: "json", encoding: "utf-8", sizeBytes, sha256 },
 *     supplier: { name, supplierId, declaredPublisher, declaredPublisherId },
 *     licence: { licenceId, permittedUses, restrictions, attestation } }
 * - dataType: "business_evidence" (an R1 evidence bundle) or "market_data"
 *   (an R1 market-data record for a US stock, UK stock or forex pair);
 * - dataOrigin: "fictional" or "real_world"; real-world data is rejected
 *   (not enabled);
 * - permittedUses come from a fixed vocabulary; any other term is an
 *   unsupported licensing assertion and the manifest is rejected. The licence
 *   attestation follows the R1 rules (a supplier's own statement is never
 *   verification).
 * The declared publisher is recorded exactly as declared and changes
 * nothing: all imported content is untrusted.
 *
 * Quarantine lifecycle (explicit transitions only):
 *   received -> validated | rejected;  validated -> awaiting_approval | rejected.
 * There is NO approved state and no transition out of awaiting_approval:
 * approval for real-world use doesn't exist in R2.
 *
 * Three separate questions, never merged:
 * - syntactic validity: the manifest, the content hash and size, and the
 *   content's schema (failure: rejected);
 * - evidence quality: the R1 readiness result (reported, not a rejection);
 * - permission to use: the licence assertions (a licence that doesn't
 *   permit the required uses is rejected; an unchecked one is unverified).
 * The binding hash ties the import id, final state, manifest hash, exact
 * content hash and R1 input hash together.
 */

import { assessBusinessEvidence } from "./business.js";
import { assessMarketData } from "./market-data.js";
import { readAttestation, type Attestation } from "./provenance.js";
import { escapeMarkdown, renderReadiness, sha256Hex, type ReadinessResult } from "./readiness.js";
import {
  Issues, ReadinessInputError, parseJsonStrict, readId, readList, readObject, readOneOf, readSafeInt, readSha256, readText, readTimestamp, utf8Bytes,
} from "./validation.js";

export const IMPORT_MANIFEST_VERSION = 1;
export const MAX_IMPORT_MANIFEST_BYTES = 100_000;
export const MAX_IMPORT_CONTENT_BYTES = 10_000_000;
export const IMPORT_DATA_TYPES = ["business_evidence", "market_data"] as const;
export type ImportDataType = (typeof IMPORT_DATA_TYPES)[number];
export const IMPORT_USES = ["internal_research", "historical_backtesting", "paper_trading_simulation", "redistribution", "commercial_publication"] as const;
export type ImportUse = (typeof IMPORT_USES)[number];
/** Uses a licence must permit before content of each type could even await approval. */
export const REQUIRED_USES: Readonly<Record<ImportDataType, readonly ImportUse[]>> = Object.freeze({
  business_evidence: Object.freeze(["internal_research"] as const),
  market_data: Object.freeze(["internal_research", "historical_backtesting"] as const),
});
/** Same rule as the CLI's input files: a plain lower-case name ending in .json, no directories. */
export const IMPORT_FILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\.json$/;

export const QUARANTINE_STATES = ["received", "validated", "rejected", "awaiting_approval"] as const;
export type QuarantineState = (typeof QUARANTINE_STATES)[number];
export const QUARANTINE_TRANSITIONS: Readonly<Record<QuarantineState, readonly QuarantineState[]>> = Object.freeze({
  received: Object.freeze(["validated", "rejected"] as const),
  validated: Object.freeze(["awaiting_approval", "rejected"] as const),
  rejected: Object.freeze([] as const),
  awaiting_approval: Object.freeze([] as const),
});

export const IMPORT_NOTICE =
  "A successful validation does not authorize real-world use. Imported content is untrusted whatever its declared publisher; " +
  "R2 has no approval or activation step, and nothing was fetched, verified online or passed to the research engines.";

export interface ImportManifest {
  readonly version: 1;
  readonly importId: string;
  readonly receivedAt: string;
  readonly receivedBy: string;
  readonly preparedAt: string;
  readonly dataType: ImportDataType;
  readonly dataOrigin: "fictional" | "real_world";
  readonly content: { readonly file: string; readonly format: "json"; readonly encoding: "utf-8"; readonly sizeBytes: number; readonly sha256: string };
  readonly supplier: { readonly name: string; readonly supplierId: string; readonly declaredPublisher: string; readonly declaredPublisherId: string };
  readonly licence: { readonly licenceId: string; readonly permittedUses: readonly ImportUse[]; readonly restrictions: readonly string[]; readonly attestation: Attestation };
}

export type Check3 = "pass" | "fail" | "not_checked";
export type Permission = "permitted" | "not_permitted" | "unverified" | "not_checked";

export interface ImportReview {
  readonly importId: string | null;
  readonly state: QuarantineState;
  readonly history: readonly QuarantineState[];
  /** Deterministic, in check order; empty unless rejected. */
  readonly rejectionReasons: readonly string[];
  readonly manifest: ImportManifest | null;
  readonly manifestSha256: string | null;
  readonly declaredContentSha256: string | null;
  readonly suppliedContentSha256: string | null;
  readonly suppliedContentBytes: number | null;
  readonly syntax: { readonly manifest: Check3; readonly integrity: Check3; readonly content: Check3 };
  readonly quality: ReadinessResult | null;
  readonly permission: { readonly status: Permission; readonly details: readonly string[] };
  readonly unresolvedQuestions: readonly string[];
  readonly bindingSha256: string;
  readonly approvedForRealWorldUse: false;
  readonly notice: string;
}

/** The only way the lifecycle moves; throws on any transition not in QUARANTINE_TRANSITIONS. */
export function transition(from: QuarantineState, to: QuarantineState): QuarantineState {
  if (!(QUARANTINE_TRANSITIONS[from] as readonly string[]).includes(to)) throw new ReadinessInputError([`quarantine: no transition from ${from} to ${to}`]);
  return to;
}

/** Validates a manifest object (throws ReadinessInputError listing every problem). */
export function parseImportManifest(raw: unknown): ImportManifest {
  const issues = new Issues();
  const o = readObject(issues, "manifest", raw, ["version", "importId", "receivedAt", "receivedBy", "preparedAt", "dataType", "dataOrigin", "content", "supplier", "licence"]);
  issues.throwIfAny();
  const m = o!;
  if (m.version !== IMPORT_MANIFEST_VERSION) issues.add("manifest.version", `must be ${IMPORT_MANIFEST_VERSION}`);
  const importId = readId(issues, "manifest.importId", m.importId);
  const receivedAt = readTimestamp(issues, "manifest.receivedAt", m.receivedAt);
  const receivedBy = readText(issues, "manifest.receivedBy", m.receivedBy, { max: 100 });
  const preparedAt = readTimestamp(issues, "manifest.preparedAt", m.preparedAt);
  if (receivedAt && preparedAt && preparedAt < receivedAt) issues.add("manifest.preparedAt", "must not be earlier than receivedAt");
  const dataType = readOneOf(issues, "manifest.dataType", m.dataType, IMPORT_DATA_TYPES);
  const dataOrigin = readOneOf(issues, "manifest.dataOrigin", m.dataOrigin, ["fictional", "real_world"] as const);

  let content: ImportManifest["content"] | null = null;
  const c = readObject(issues, "manifest.content", m.content, ["file", "format", "encoding", "sizeBytes", "sha256"]);
  if (c !== null) {
    const file = readText(issues, "manifest.content.file", c.file, { max: 70 });
    if (file && !IMPORT_FILE_PATTERN.test(file)) issues.add("manifest.content.file", "must be a plain lower-case file name ending in .json (no directories)");
    if (c.format !== "json") issues.add("manifest.content.format", "must be json (other formats are unsupported)");
    if (c.encoding !== "utf-8") issues.add("manifest.content.encoding", "must be utf-8 (other encodings are unsupported)");
    content = Object.freeze({
      file, format: "json" as const, encoding: "utf-8" as const,
      sizeBytes: readSafeInt(issues, "manifest.content.sizeBytes", c.sizeBytes, { min: 1, max: MAX_IMPORT_CONTENT_BYTES }), sha256: readSha256(issues, "manifest.content.sha256", c.sha256),
    });
  }
  let supplier: ImportManifest["supplier"] | null = null;
  const s = readObject(issues, "manifest.supplier", m.supplier, ["name", "supplierId", "declaredPublisher", "declaredPublisherId"]);
  if (s !== null) {
    supplier = Object.freeze({
      name: readText(issues, "manifest.supplier.name", s.name, { max: 200 }), supplierId: readId(issues, "manifest.supplier.supplierId", s.supplierId),
      declaredPublisher: readText(issues, "manifest.supplier.declaredPublisher", s.declaredPublisher, { max: 200 }),
      declaredPublisherId: readId(issues, "manifest.supplier.declaredPublisherId", s.declaredPublisherId),
    });
  }
  let licence: ImportManifest["licence"] | null = null;
  const l = readObject(issues, "manifest.licence", m.licence, ["licenceId", "permittedUses", "restrictions", "attestation"]);
  if (l !== null) {
    const uses = (readList(issues, "manifest.licence.permittedUses", l.permittedUses, { min: 0, max: IMPORT_USES.length }) ?? []).map((u, i) => {
      if (typeof u !== "string" || !(IMPORT_USES as readonly string[]).includes(u)) {
        issues.add(`manifest.licence.permittedUses[${i}]`, `is an unsupported licensing assertion (supported: ${IMPORT_USES.join(", ")})`);
        return null;
      }
      return u as ImportUse;
    }).filter((u): u is ImportUse => u !== null);
    if (new Set(uses).size !== uses.length) issues.add("manifest.licence.permittedUses", "lists a use twice");
    const restrictions = (readList(issues, "manifest.licence.restrictions", l.restrictions, { min: 0, max: 20 }) ?? []).map((r, i) => readText(issues, `manifest.licence.restrictions[${i}]`, r, { max: 300 }));
    const attestation = readAttestation(issues, "manifest.licence.attestation", l.attestation, { earliest: null, asOf: preparedAt || "9999" });
    if (attestation) licence = Object.freeze({ licenceId: readText(issues, "manifest.licence.licenceId", l.licenceId, { max: 200 }), permittedUses: Object.freeze(uses), restrictions: Object.freeze(restrictions), attestation });
  }
  issues.throwIfAny();
  return Object.freeze({ version: 1 as const, importId, receivedAt, receivedBy, preparedAt, dataType, dataOrigin, content: content!, supplier: supplier!, licence: licence! });
}

/** The content file a manifest names, or null when the manifest text is not a valid manifest. */
export function importContentFile(manifestText: unknown): string | null {
  try {
    return parseImportManifest(parseJsonStrict(manifestText, "manifest", MAX_IMPORT_MANIFEST_BYTES)).content.file;
  } catch (err) {
    if (err instanceof ReadinessInputError) return null;
    throw err;
  }
}

const BINDING_DOMAIN = "automaton/research-import/review/v1";

/**
 * Reviews one import: manifest, then content integrity, then content schema
 * and R1 readiness, then permission. Never throws for bad input; never
 * approves anything. `contentText` is null when no content could be read.
 */
export function reviewImport(manifestText: unknown, contentText: unknown): ImportReview {
  const history: QuarantineState[] = ["received"];
  const reasons: string[] = [];
  const syntax = { manifest: "not_checked" as Check3, integrity: "not_checked" as Check3, content: "not_checked" as Check3 };
  const manifestSha256 = typeof manifestText === "string" ? sha256Hex(manifestText) : null;
  const suppliedContentSha256 = typeof contentText === "string" ? sha256Hex(contentText) : null;
  const suppliedContentBytes = typeof contentText === "string" ? utf8Bytes(contentText) : null;
  let manifest: ImportManifest | null = null;
  let quality: ReadinessResult | null = null;
  let permission: ImportReview["permission"] = { status: "not_checked", details: [] };

  try {
    manifest = parseImportManifest(parseJsonStrict(manifestText, "manifest", MAX_IMPORT_MANIFEST_BYTES));
    syntax.manifest = "pass";
  } catch (err) {
    if (!(err instanceof ReadinessInputError)) throw err;
    syntax.manifest = "fail";
    reasons.push(...err.issues);
  }

  if (manifest) {
    if (manifest.dataOrigin === "real_world") reasons.push("manifest.dataOrigin: real-world data is not enabled (R2 quarantines fictional data only)");
    const integrity: string[] = [];
    if (typeof contentText !== "string") integrity.push("content: was not supplied");
    else {
      if (suppliedContentBytes !== manifest.content.sizeBytes) integrity.push(`content: is ${suppliedContentBytes} bytes; the manifest declares ${manifest.content.sizeBytes}`);
      if (suppliedContentSha256 !== manifest.content.sha256) integrity.push("content: SHA-256 does not match the manifest (the content changed, or is a different file)");
    }
    syntax.integrity = integrity.length === 0 ? "pass" : "fail";
    reasons.push(...integrity);
  }

  if (manifest && reasons.length === 0) {
    try {
      const raw = parseJsonStrict(contentText, "content", MAX_IMPORT_CONTENT_BYTES);
      quality = manifest.dataType === "business_evidence" ? assessBusinessEvidence(raw) : assessMarketData(raw);
    } catch (err) {
      if (!(err instanceof ReadinessInputError)) throw err;
      reasons.push(...err.issues);
    }
    if (quality?.overall === "refused") reasons.push(...quality.checks[0].details.map((d) => `content: ${d}`));
    syntax.content = reasons.length === 0 ? "pass" : "fail";
    if (reasons.length > 0) quality = null;
  }

  if (manifest && reasons.length === 0) {
    const required = REQUIRED_USES[manifest.dataType];
    const missing = required.filter((u) => !manifest!.licence.permittedUses.includes(u));
    const att = manifest.licence.attestation;
    const details = [
      `licence ${manifest.licence.licenceId}: permits ${manifest.licence.permittedUses.join(", ") || "nothing"}; required for ${manifest.dataType}: ${required.join(", ")}`,
      `licence terms are ${att.status} (${att.basis}): ${att.note}`,
      ...manifest.licence.restrictions.map((r) => `restriction: ${r}`),
    ];
    permission = { status: missing.length > 0 ? "not_permitted" : att.status === "verified" ? "permitted" : "unverified", details };
    if (missing.length > 0) reasons.push(`manifest.licence.permittedUses: does not permit ${missing.join(", ")} (required for ${manifest.dataType})`);
  }

  if (reasons.length > 0) {
    history.push(transition("received", syntax.content === "pass" ? "validated" : "rejected"));
    if (history[1] === "validated") history.push(transition("validated", "rejected"));
  } else {
    history.push(transition("received", "validated"));
    history.push(transition("validated", "awaiting_approval")); // never further: no approved state exists
  }
  const state = history[history.length - 1];

  const unresolved: string[] = [];
  if (state === "awaiting_approval") {
    for (const c of quality!.checks) if (c.status !== "pass") unresolved.push(`${c.id} (${c.status}): ${c.summary}`);
    if (permission.status === "unverified") unresolved.push(`licence (unverified): the licence terms are ${manifest!.licence.attestation.status}, not independently checked`);
    for (const r of manifest!.licence.restrictions) unresolved.push(`licence restriction to confirm compliance with: ${r}`);
    unresolved.push("approval for real-world use: not available in R2 (no approval step exists)");
  }
  const bindingSha256 = sha256Hex(JSON.stringify([BINDING_DOMAIN, manifest?.importId ?? null, state, manifestSha256, suppliedContentSha256, quality?.inputSha256 ?? null]));
  return Object.freeze({
    importId: manifest?.importId ?? null, state, history: Object.freeze(history), rejectionReasons: Object.freeze(reasons), manifest, manifestSha256,
    declaredContentSha256: manifest?.content.sha256 ?? null, suppliedContentSha256, suppliedContentBytes, syntax: Object.freeze(syntax), quality,
    permission: Object.freeze({ status: permission.status, details: Object.freeze([...permission.details]) }), unresolvedQuestions: Object.freeze(unresolved),
    bindingSha256, approvedForRealWorldUse: false as const, notice: IMPORT_NOTICE,
  });
}

/** Markdown operator review; every supplied value is escaped. */
export function renderImportReview(r: ImportReview): string {
  const e = escapeMarkdown;
  const m = r.manifest;
  const label = (s: string) => s.toUpperCase().replace(/_/g, " ");
  const out = [
    `# Import review: ${r.importId ? e(r.importId) : "(manifest not readable)"}`, "",
    `**Quarantine state: ${label(r.state)}.** Approved for real-world use: **no**.`, "",
    `**${e(r.notice)}**`, "",
    `- Lifecycle: ${r.history.join(" -> ")}`,
  ];
  if (r.rejectionReasons.length > 0) out.push("", "## Rejection reasons", "", ...r.rejectionReasons.map((x) => `- ${e(x)}`));
  out.push("", "## Validity, quality and permission (separate questions)", "", "| Question | Result |", "|---|---|",
    `| Manifest well formed | ${r.syntax.manifest} |`, `| Content matches the manifest (size and SHA-256) | ${r.syntax.integrity} |`,
    `| Content schema valid | ${r.syntax.content} |`, `| Evidence quality (R1 readiness) | ${r.quality ? r.quality.overall : "not_checked"} |`,
    `| Permission to use (licence) | ${r.permission.status} |`);
  out.push("", "## Content integrity", "",
    `- Declared content SHA-256: ${r.declaredContentSha256 ?? "(none)"}`, `- Supplied content SHA-256: ${r.suppliedContentSha256 ?? "(none)"} (${r.suppliedContentBytes ?? 0} bytes)`,
    `- Manifest SHA-256: ${r.manifestSha256 ?? "(none)"}`, `- R1 input SHA-256: ${r.quality?.inputSha256 ?? "(none)"}`,
    `- Binding SHA-256 (import id, state, manifest, content, R1 input): ${r.bindingSha256}`);
  if (m) {
    out.push("", "## Provenance (as declared; untrusted)", "",
      `- Import ${e(m.importId)}: ${m.dataType}, origin ${m.dataOrigin}; received ${m.receivedAt} by ${e(m.receivedBy)}; manifest prepared ${m.preparedAt}`,
      `- Supplier: ${e(m.supplier.name)} (${e(m.supplier.supplierId)}); declared publisher: ${e(m.supplier.declaredPublisher)} (${e(m.supplier.declaredPublisherId)}). A declared publisher changes nothing.`,
      `- Content file: ${e(m.content.file)} (${m.content.format}, ${m.content.encoding}, ${m.content.sizeBytes} bytes declared)`);
    out.push("", "## Licensing assertions", "", ...(r.permission.details.length > 0 ? r.permission.details : [`licence ${m.licence.licenceId}: not assessed (rejected earlier)`]).map((x) => `- ${e(x)}`));
  }
  if (r.quality) out.push("", renderReadiness(r.quality).replace(/^#/gm, "##").trimEnd());
  out.push("", "## Unresolved questions", "", ...(r.unresolvedQuestions.length > 0 ? r.unresolvedQuestions : ["none (the import was rejected)"]).map((x) => `- ${e(x)}`), "");
  return out.join("\n");
}
