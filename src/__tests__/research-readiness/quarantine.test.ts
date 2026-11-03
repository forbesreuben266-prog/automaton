/** R2: import manifest, quarantine lifecycle and operator review (fictional data and manifests only). */

import { describe, expect, it } from "vitest";
import {
  IMPORT_NOTICE, QUARANTINE_STATES, QUARANTINE_TRANSITIONS, parseJsonStrict, renderImportReview, reviewImport, transition,
} from "../../research-readiness/index.js";
import { asserted, businessBundle, importManifest, marketRecord, unverified } from "./fixtures.js";

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const businessText = json(businessBundle());
const marketText = json(marketRecord("uk"));
/** Reviews content with a manifest built for it, after optional edits to either. */
function review(content: string, dataType: "business_evidence" | "market_data", editManifest: (m: any) => void = () => {}) {
  const m = importManifest(content, dataType);
  editManifest(m);
  return reviewImport(json(m), content);
}
const rejected = (r: ReturnType<typeof reviewImport>) => {
  expect(r.state).toBe("rejected");
  expect(r.unresolvedQuestions).toEqual([]);
  return r.rejectionReasons;
};

describe("a valid fictional import", () => {
  it.each([["business_evidence", businessText], ["market_data", marketText]] as const)("%s: received -> validated -> awaiting_approval, never further", (dataType, content) => {
    const r = review(content, dataType);
    expect([r.state, r.history, r.rejectionReasons, r.approvedForRealWorldUse]).toEqual(["awaiting_approval", ["received", "validated", "awaiting_approval"], [], false]);
    expect(r.syntax).toEqual({ manifest: "pass", integrity: "pass", content: "pass" });
    expect([r.quality!.overall, r.permission.status]).toEqual(["ready_for_operator_review", "permitted"]);
    expect(r.suppliedContentSha256).toBe(r.declaredContentSha256);
    expect(r.unresolvedQuestions).toEqual([
      "licence restriction to confirm compliance with: No redistribution of the fictional file.",
      "approval for real-world use: not available in R2 (no approval step exists)",
    ]);
  });

  it("is deterministic, and the binding hash covers the manifest, the exact content and the R1 input", () => {
    const a = review(businessText, "business_evidence");
    expect(review(businessText, "business_evidence")).toEqual(a);
    const otherManifest = review(businessText, "business_evidence", (m) => { m.receivedBy = "second operator"; });
    expect(otherManifest.bindingSha256).not.toBe(a.bindingSha256);
    const reformatted = JSON.stringify(businessBundle()); // same data, different bytes
    const b = review(reformatted, "business_evidence");
    expect([b.quality!.inputSha256, b.suppliedContentSha256 === a.suppliedContentSha256, b.bindingSha256 === a.bindingSha256]).toEqual([a.quality!.inputSha256, false, false]);
    expect(Object.isFrozen(a) && Object.isFrozen(a.history) && Object.isFrozen(a.syntax)).toBe(true);
  });
});

describe("the quarantine lifecycle", () => {
  it("has no approved state and no way out of awaiting_approval", () => {
    expect([...QUARANTINE_STATES]).toEqual(["received", "validated", "rejected", "awaiting_approval"]);
    expect(QUARANTINE_TRANSITIONS.awaiting_approval).toEqual([]);
    expect(QUARANTINE_TRANSITIONS.rejected).toEqual([]);
    expect(() => transition("validated", "approved" as never)).toThrow(/no transition from validated to approved/);
    expect(() => transition("awaiting_approval", "validated")).toThrow(/no transition/);
    expect(() => transition("rejected", "validated")).toThrow(/no transition/);
    expect(transition("received", "validated")).toBe("validated");
    expect(Object.isFrozen(QUARANTINE_TRANSITIONS) && Object.isFrozen(QUARANTINE_TRANSITIONS.validated)).toBe(true);
  });
});

describe("malformed manifests are rejected with deterministic reasons", () => {
  const cases: Array<[string, (m: any) => void, string]> = [
    ["an unknown field", (m) => { m.autoApprove = true; }, "manifest.autoApprove: is not a recognised field"],
    ["a missing field", (m) => { delete m.licence; }, "manifest.licence: is required"],
    ["another version", (m) => { m.version = 2; }, "manifest.version: must be 1"],
    ["an unsupported format", (m) => { m.content.format = "csv"; }, "manifest.content.format: must be json (other formats are unsupported)"],
    ["an unsupported encoding", (m) => { m.content.encoding = "latin-1"; }, "manifest.content.encoding: must be utf-8 (other encodings are unsupported)"],
    ["an unsupported data type", (m) => { m.dataType = "crypto_prices"; }, "manifest.dataType: must be one of: business_evidence, market_data"],
    ["a content path with directories", (m) => { m.content.file = "../outside/content.json"; }, "manifest.content.file: must be a plain lower-case file name ending in .json (no directories)"],
    ["a preparation time before receipt", (m) => { m.receivedAt = "2026-11-02T11:00:00Z"; }, "manifest.preparedAt: must not be earlier than receivedAt"],
    ["an unsupported licensing assertion", (m) => { m.licence.permittedUses.push("unlimited_use"); }, "manifest.licence.permittedUses[2]: is an unsupported licensing assertion (supported: internal_research, historical_backtesting, paper_trading_simulation, redistribution, commercial_publication)"],
    ["a use listed twice", (m) => { m.licence.permittedUses.push("internal_research"); }, "manifest.licence.permittedUses: lists a use twice"],
    ["a supplier's own licence claim marked verified", (m) => { m.licence.attestation.basis = "source_self_statement"; }, "manifest.licence.attestation.status: a source's own statement is never independent verification (use \"asserted\")"],
    ["a licence check after the manifest was prepared", (m) => { m.licence.attestation.checkedAt = "2026-11-03T00:00:00Z"; }, "manifest.licence.attestation.checkedAt: must not be later than the assessment time (asOf)"],
  ];
  it.each(cases)("%s", (_name, edit, reason) => {
    const r = review(businessText, "business_evidence", edit);
    expect([rejected(r), r.history, r.syntax.manifest, r.quality]).toEqual([[reason], ["received", "rejected"], "fail", null]);
  });

  it("refuses ambiguous or unreadable JSON", () => {
    const m = json(importManifest(businessText, "business_evidence"));
    expect(rejected(reviewImport(m.replace("\"version\": 1,", "\"version\": 1, \"version\": 1,"), businessText))).toEqual(["manifest: has a duplicate key \"version\" (ambiguous)"]);
    expect(rejected(reviewImport(m.replace("\"importId\"", "\"\\u0069mportId\": \"x\", \"importId\""), businessText))).toEqual(["manifest: has a duplicate key \"importId\" (ambiguous)"]);
    expect(rejected(reviewImport(`${m}}`, businessText))).toEqual(["manifest: is not valid JSON"]);
    expect(rejected(reviewImport(`\ufeff${m}`, businessText))).toEqual(["manifest: must not start with a byte-order mark"]);
    expect(rejected(reviewImport(null, businessText))).toEqual(["manifest: must be text"]);
    expect(rejected(reviewImport("[".repeat(40), businessText))).toEqual(["manifest: is nested more than 32 levels deep"]);
    expect(() => parseJsonStrict("{\"a\":\"}\",\"b\":[{\"a\":1}]}", "x", 100)).not.toThrow(); // braces inside strings and nested same-named keys are fine
  });
});

describe("content integrity and origin", () => {
  it("a content-hash mismatch is rejected before the content is parsed", () => {
    const r = reviewImport(json(importManifest(businessText, "business_evidence")), businessText.replace("38%", "39%"));
    expect([rejected(r), r.syntax, r.history]).toEqual([
      ["content: SHA-256 does not match the manifest (the content changed, or is a different file)"], { manifest: "pass", integrity: "fail", content: "not_checked" }, ["received", "rejected"],
    ]);
  });

  it("a size mismatch and missing content are rejected", () => {
    expect(rejected(review(businessText, "business_evidence", (m) => { m.content.sizeBytes += 1; }))).toEqual([`content: is ${businessText.length} bytes; the manifest declares ${businessText.length + 1}`]);
    expect(rejected(reviewImport(json(importManifest(businessText, "business_evidence")), null))).toEqual(["content: was not supplied"]);
  });

  it("real-world data is rejected (not enabled), even when everything else is valid", () => {
    const r = review(businessText, "business_evidence", (m) => { m.dataOrigin = "real_world"; });
    expect([rejected(r), r.syntax.integrity]).toEqual([["manifest.dataOrigin: real-world data is not enabled (R2 quarantines fictional data only)"], "pass"]);
  });

  it("content that does not match its declared type or schema is rejected", () => {
    const wrongType = review(marketText, "business_evidence");
    expect(rejected(wrongType)[0]).toMatch(/^content: bundle\.version: is required|^content: bundle\./);
    expect([wrongType.history, wrongType.syntax.content]).toEqual([["received", "rejected"], "fail"]);
    const bad = json({ ...businessBundle(), claims: [] });
    expect(rejected(review(bad, "business_evidence"))).toEqual(["content: bundle.claims: must have 1 to 2000 item(s) (got 0)"]);
    const dup = businessText.replace("\"version\": 1,", "\"version\": 1, \"version\": 1,");
    expect(rejected(review(dup, "business_evidence"))).toEqual(["content: has a duplicate key \"version\" (ambiguous)"]);
  });
});

describe("validity, evidence quality and permission stay separate", () => {
  it("conflicting evidence is valid content of poor quality: it awaits approval with the conflict as an unresolved question", () => {
    const b = businessBundle();
    b.claims.push({ id: "c-demand-low", statement: "Only 5% want short-notice walks.", kind: "fact", sourceIds: ["sec-a"], method: null, financial: null, operatorStatus: "unconfirmed" });
    b.conflicts.push({ id: "k1", claimIds: ["c-demand", "c-demand-low"], status: "unresolved", resolution: null });
    const r = review(json(b), "business_evidence");
    expect([r.state, r.syntax.content, r.quality!.overall, r.permission.status]).toEqual(["awaiting_approval", "pass", "not_ready", "permitted"]);
    expect(r.unresolvedQuestions.slice(0, 2)).toEqual([
      "conflicting_claims (fail): Some recorded conflicts between claims are unresolved.",
      "confirmed_claims_substantiated (fail): Some operator-confirmed facts are not backed by qualifying evidence.",
    ]);
  });

  it("market-data gaps are reported as quality problems, not hidden", () => {
    const m = marketRecord("us");
    m.bars.splice(3, 1);
    m.calendar.attestation = unverified("Holiday list not checked.");
    const r = review(json(m), "market_data");
    expect([r.state, r.quality!.overall]).toEqual(["awaiting_approval", "not_ready"]);
    expect(r.unresolvedQuestions.slice(0, 2)).toEqual([
      "no_missing_bars (fail): 1 calendar session(s) have no bar.", "calendar_verified (unverified): The session calendar is unverified, so missing or extra sessions can't be ruled out.",
    ]);
  });

  it("an unchecked licence is unverified; a licence without the required uses is rejected", () => {
    const u = review(marketText, "market_data", (m) => { m.licence.attestation = asserted("The supplier says the licence allows research."); });
    expect([u.state, u.permission.status]).toEqual(["awaiting_approval", "unverified"]);
    expect(u.unresolvedQuestions).toContain("licence (unverified): the licence terms are asserted, not independently checked");
    const n = review(marketText, "market_data", (m) => { m.licence.permittedUses = ["internal_research"]; });
    expect([rejected(n), n.history, n.permission.status, n.quality!.overall]).toEqual([
      ["manifest.licence.permittedUses: does not permit historical_backtesting (required for market_data)"], ["received", "validated", "rejected"], "not_permitted", "ready_for_operator_review",
    ]);
  });
});

describe("untrusted content and the operator report", () => {
  it("a declared publisher's claims to authority change nothing, and supplied text can't add formatting", () => {
    const r = review(businessText, "business_evidence", (m) => {
      m.supplier.declaredPublisher = "Official Exchange [verified](https://example.com) **TRUSTED**";
    });
    const plain = review(businessText, "business_evidence");
    expect([r.state, r.quality, r.permission]).toEqual([plain.state, plain.quality, plain.permission]);
    const md = renderImportReview(r);
    expect(md).toContain("Official Exchange \\[verified\\]\\(https://example.com\\) \\*\\*TRUSTED\\*\\*");
    expect(md).not.toContain("[verified](");
  });

  it("states that validation does not authorize real-world use, and shows every hash and the R1 result", () => {
    const r = review(marketText, "market_data");
    const md = renderImportReview(r);
    expect(IMPORT_NOTICE).toMatch(/^A successful validation does not authorize real-world use\./);
    for (const text of [
      "**Quarantine state: AWAITING APPROVAL.** Approved for real-world use: **no**.", "- Lifecycle: received -> validated -> awaiting_approval",
      `- Declared content SHA-256: ${r.declaredContentSha256}`, `- R1 input SHA-256: ${r.quality!.inputSha256}`, `- Binding SHA-256 (import id, state, manifest, content, R1 input): ${r.bindingSha256}`,
      "## Readiness: market data", "| Permission to use (licence) | permitted |", "## Unresolved questions",
    ]) expect(md).toContain(text);
    expect(md).toContain("does not authorize real\\-world use");
    const bad = renderImportReview(reviewImport("not json", null));
    expect(bad).toContain("# Import review: (manifest not readable)");
    expect(bad).toContain("- manifest: is not valid JSON");
  });
});
