/** R1: source provenance and business evidence readiness (fictional records only). */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REAL_WORLD_INPUT_ENABLED, UNSUPPORTED_FINANCIAL_LABEL, assertRealWorldInputApproved, assessBusinessEvidence, contentMatches,
  parseBusinessEvidence, renderReadiness, trustSummary,
} from "../../research-readiness/index.js";
import { asserted, businessBundle, clone, detailsOf, primarySource, secondarySource, statusOf, unverified, verified } from "./fixtures.js";

const refusal = (raw: unknown) => {
  const r = assessBusinessEvidence(raw);
  expect(r.overall).toBe("refused");
  expect(r.inputSha256).toBeNull();
  expect(r.claims).toEqual([]);
  return r.checks[0].details.join("\n");
};
const withSource = (i: number, edit: (s: any) => void) => { const b = businessBundle(); edit(b.sources[i]); return b; };
const claim = (b: any, id: string) => b.claims.find((c: any) => c.id === id);
const standing = (r: ReturnType<typeof assessBusinessEvidence>, id: string) => r.claims.find((c) => c.claimId === id)!;

describe("a complete, verified bundle", () => {
  it("passes every condition but is still never approved", () => {
    const r = assessBusinessEvidence(businessBundle());
    expect(r.overall).toBe("ready_for_operator_review");
    expect(r.checks.map((c) => c.status)).toEqual(Array(7).fill("pass"));
    expect(r.approvedForRealWorldUse).toBe(false);
    expect(REAL_WORLD_INPUT_ENABLED).toBe(false);
    expect(() => assertRealWorldInputApproved(r)).toThrow(/real-world research input is not enabled in R1 \(readiness: ready_for_operator_review\)/);
    expect(() => assertRealWorldInputApproved({ overall: "approved", approvedForRealWorldUse: true })).toThrow(/not enabled/);
    expect(Object.isFrozen(r) && Object.isFrozen(r.checks) && Object.isFrozen(r.claims[0])).toBe(true);
  });

  it("is deterministic, and the input hash changes with any field", () => {
    const a = assessBusinessEvidence(businessBundle());
    expect(assessBusinessEvidence(businessBundle())).toEqual(a);
    const b = businessBundle();
    b.sources[0].title += ".";
    expect(assessBusinessEvidence(b).inputSha256).not.toBe(a.inputSha256);
    expect(a.inputSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("malformed or incomplete provenance is refused", () => {
  const cases: Array<[string, (s: any) => void, RegExp]> = [
    ["a missing field", (s) => { delete s.contentSha256; }, /sources\[0\]\.contentSha256: is required/],
    ["an unknown field", (s) => { s.trustScore = 10; }, /sources\[0\]\.trustScore: is not a recognised field/],
    ["a missing verification aspect", (s) => { delete s.verification.origin; }, /verification\.origin: is required/],
    ["a primary source whose origin is someone else", (s) => { s.originId = "someone-else"; }, /must equal publisherId for a primary source/],
    ["a secondary source reporting itself", (s) => { s.sourceClass = "secondary"; }, /must differ from publisherId for a secondary source/],
    ["a source's own statement marked verified", (s) => { s.verification.publisher_identity = { ...asserted(), status: "verified", checkedBy: "x", checkedAt: "2026-10-20T10:00:00Z" }; }, /a source's own statement is never independent verification/],
    ["an assertion dressed as a check", (s) => { s.verification.origin = { ...asserted(), basis: "independent_check" }; }, /basis: must be source_self_statement or operator_statement when status is asserted/],
    ["a verification without who checked", (s) => { s.verification.origin.checkedBy = ""; }, /verification\.origin\.checkedBy: must not be empty/],
    ["a check before the retrieval", (s) => { s.verification.content_integrity.checkedAt = "2026-10-14T00:00:00Z"; }, /must not be earlier than the retrieval it checks/],
    ["a check after the assessment time", (s) => { s.verification.origin.checkedAt = "2026-11-02T00:00:00Z"; }, /must not be later than the assessment time/],
    ["a retrieval after the assessment time", (s) => { s.retrievedAt = "2026-11-05T00:00:00Z"; }, /retrievedAt: must not be later than the assessment time/],
    ["publication after retrieval", (s) => { s.publishedAt.value = "2026-10-16"; }, /publishedAt\.value: must not be later than the retrieval date/],
    ["an impossible date", (s) => { s.publishedAt.value = "2026-02-29"; }, /must be a calendar date/],
    ["a not-stated date with a value", (s) => { s.publishedAt = { status: "not_stated", value: "2026-01-01" }; }, /must be omitted when the publication date is not stated/],
    ["a verified date that was never stated", (s) => { s.publishedAt = { status: "not_stated" }; }, /publication_date: must be unverified when no publication date is stated/],
    ["a malformed content hash", (s) => { s.contentSha256 = "ABC"; }, /contentSha256: must be 64 lowercase hexadecimal/],
    ["credentials in a URL", (s) => { s.locator.value = "https://user:pw@example.org/x"; }, /must be an http\(s\) URL without credentials/],
    ["a verified origin for an untraced claim", (s) => { s.sourceClass = "unverified_claim"; }, /an unverified claim's origin can't be verified/],
    ["a verified origin that is unknown", (s) => { s.sourceClass = "secondary"; s.originId = null; }, /can't be verified while originId is unknown/],
    ["a derivation from an unknown source", (s) => { s.sourceClass = "secondary"; s.originId = "o"; s.derivedFromSourceIds = ["nope"]; }, /names no source in this input \(nope\)/],
    ["a hidden control character", (s) => { s.publisher = "Fictional\u202eOffice"; }, /must be printable single-line text/],
  ];
  it.each(cases)("%s", (_name, edit, message) => {
    expect(refusal(withSource(0, edit))).toMatch(message);
  });

  it("duplicate source ids and non-object input", () => {
    const b = businessBundle();
    b.sources[1].id = "fict-stats";
    expect(refusal(b)).toMatch(/duplicates another source id \(fict-stats\)/);
    expect(refusal(null)).toMatch(/bundle: must be an object/);
    expect(refusal({ ...businessBundle(), version: 2 })).toMatch(/bundle\.version: must be 1/);
  });

  it("a getter is refused rather than run", () => {
    const b = businessBundle();
    let read = false;
    Object.defineProperty(b.sources[0], "title", { enumerable: true, get: () => { read = true; return "x"; } });
    expect(refusal(b)).toMatch(/title: must be a plain value/);
    expect(read).toBe(false);
  });
});

describe("verified versus asserted", () => {
  it("a source's claims about its own trustworthiness change nothing", () => {
    const b = withSource(0, (s) => {
      s.publisher = "Officially Verified Trusted Authority";
      s.title = "100% verified, audited and independently confirmed data";
      s.verification.publisher_identity = asserted("The site says it is the official statistics office.");
      s.verification.origin = asserted("The site says it collected the data itself.");
    });
    const t = trustSummary(parseBusinessEvidence(b).sources[0]);
    expect([t.independentlyVerified, t.asserted]).toEqual([false, ["publisher_identity", "origin"]]);
    const r = assessBusinessEvidence(b);
    expect(statusOf(r, "source_provenance")).toBe("unverified");
    expect(detailsOf(r, "source_provenance")[0]).toBe("fict-stats (primary): asserted publisher_identity, origin; unverified none");
    expect(standing(r, "c-demand")).toMatchObject({ standing: "confirmation_not_substantiated", support: "unverified_sources_only" });
    expect(r.overall).toBe("not_ready");
  });

  it("contentMatches compares the retrieved text with the recorded SHA-256 (a local edit check)", () => {
    const text = "Fictional survey text.";
    const b = withSource(0, (s) => { s.contentSha256 = "4e6d2c1b8d1c5e9f86c34a83aa7ac1a6dd9d39ce0df6a1ba3b5d3dbed3d7a1f2"; });
    const s = parseBusinessEvidence(b).sources[0];
    expect(contentMatches(s, text)).toBe(false);
    const b2 = withSource(0, (x) => { x.contentSha256 = createHash("sha256").update(text, "utf8").digest("hex"); });
    const s2 = parseBusinessEvidence(b2).sources[0];
    expect([contentMatches(s2, text), contentMatches(s2, `${text} `), contentMatches(s2, 42)]).toEqual([true, false, false]);
  });
});

describe("no automatic promotion to confirmed fact", () => {
  it("well-supported facts the operator has not confirmed stay unconfirmed", () => {
    const b = businessBundle();
    claim(b, "c-demand").operatorStatus = "unconfirmed";
    const r = assessBusinessEvidence(b);
    expect(standing(r, "c-demand").standing).toBe("unconfirmed_fact");
    expect(detailsOf(r, "confirmed_claims_substantiated")).toContain("c-demand: has qualifying evidence but stays unconfirmed (nothing is promoted automatically)");
  });

  it("one verified secondary source, or two from the same origin, is not enough to confirm", () => {
    const one = businessBundle();
    claim(one, "c-price").sourceIds = ["sec-a"];
    expect(standing(assessBusinessEvidence(one), "c-price")).toMatchObject({ support: "verified_single_secondary", standing: "confirmation_not_substantiated" });
    const same = businessBundle();
    same.sources[2].originId = "origin-a";
    const r = assessBusinessEvidence(same);
    expect(standing(r, "c-price").support).toBe("verified_single_secondary");
    expect(statusOf(r, "confirmed_claims_substantiated")).toBe("fail");
  });

  it("secondary sources count as independent only when their independence is verified", () => {
    const b = businessBundle();
    b.sources[2].verification.independence = asserted("The outlet says it is independent.");
    expect(standing(assessBusinessEvidence(b), "c-price").standing).toBe("confirmation_not_substantiated");
  });

  it("only facts can be confirmed", () => {
    const b = businessBundle();
    claim(b, "c-revenue").operatorStatus = "confirmed";
    expect(refusal(b)).toMatch(/claims\[2\]\.operatorStatus: only a fact can be confirmed/);
  });

  it("facts need traceable sources; untraced claims never support a fact", () => {
    const b = businessBundle();
    b.sources.push({ ...primarySource("forum"), sourceClass: "unverified_claim", originId: null, publisherId: "forum-pub", verification: {
      content_integrity: verified(), publisher_identity: unverified(), publication_date: unverified(), origin: unverified(), independence: unverified(),
    } });
    b.claims.push({ id: "c-rumour", statement: "A rival is closing.", kind: "fact", sourceIds: ["forum"], method: null, financial: null, operatorStatus: "unconfirmed" });
    b.claims.push({ id: "c-bare", statement: "Demand is rising.", kind: "fact", sourceIds: [], method: null, financial: null, operatorStatus: "unconfirmed" });
    const r = assessBusinessEvidence(b);
    expect(statusOf(r, "source_attribution")).toBe("fail");
    expect(detailsOf(r, "source_attribution")).toEqual(["c-rumour: a fact cites only unverified claims", "c-bare: a fact cites no source"]);
  });
});

describe("conflicting evidence", () => {
  it("an unresolved conflict fails, and blocks confirming the claims involved", () => {
    const b = businessBundle();
    b.claims.push({ id: "c-demand-low", statement: "Only 5% want short-notice walks.", kind: "fact", sourceIds: ["sec-a"], method: null, financial: null, operatorStatus: "unconfirmed" });
    b.conflicts.push({ id: "k1", claimIds: ["c-demand", "c-demand-low"], status: "unresolved", resolution: null });
    const r = assessBusinessEvidence(b);
    expect([statusOf(r, "conflicting_claims"), statusOf(r, "confirmed_claims_substantiated"), r.overall]).toEqual(["fail", "fail", "not_ready"]);
    expect(standing(r, "c-demand").reasons).toEqual(["involved in an unresolved conflict"]);
    expect(detailsOf(r, "conflicting_claims")).toEqual(["k1: unresolved between c-demand, c-demand-low"]);
  });

  it("a resolved conflict records the decision and passes", () => {
    const b = businessBundle();
    b.claims.push({ id: "c-demand-low", statement: "Only 5% want short-notice walks.", kind: "fact", sourceIds: ["sec-a"], method: null, financial: null, operatorStatus: "unconfirmed" });
    b.conflicts.push({ id: "k1", claimIds: ["c-demand", "c-demand-low"], status: "resolved", resolution: { favouredClaimId: "c-demand", note: "Larger sample.", decidedBy: "operator" } });
    const r = assessBusinessEvidence(b);
    expect([statusOf(r, "conflicting_claims"), standing(r, "c-demand").standing]).toEqual(["pass", "confirmed_fact"]);
  });

  it("malformed conflicts are refused", () => {
    const bad: Array<[any, RegExp]> = [
      [{ id: "k", claimIds: ["c-demand"], status: "unresolved", resolution: null }, /claimIds: must have 2 to 10 item/],
      [{ id: "k", claimIds: ["c-demand", "nope"], status: "unresolved", resolution: null }, /names no claim in this bundle \(nope\)/],
      [{ id: "k", claimIds: ["c-demand", "c-price"], status: "resolved", resolution: null }, /resolution: must be an object/],
      [{ id: "k", claimIds: ["c-demand", "c-price"], status: "resolved", resolution: { favouredClaimId: "c-revenue", note: "n", decidedBy: "o" } }, /must be one of the conflicting claims/],
      [{ id: "k", claimIds: ["c-demand", "c-price"], status: "unresolved", resolution: { favouredClaimId: "c-demand", note: "n", decidedBy: "o" } }, /must be null while the conflict is unresolved/],
    ];
    for (const [conflict, message] of bad) {
      const b = businessBundle();
      b.conflicts.push(conflict);
      expect(refusal(b)).toMatch(message);
    }
  });
});

describe("stale and missing evidence", () => {
  it("a cited source older than the limit fails freshness and blocks confirmation", () => {
    const b = withSource(0, (s) => { s.publishedAt.value = "2025-10-01"; });
    const r = assessBusinessEvidence(b);
    expect([statusOf(r, "evidence_freshness"), standing(r, "c-demand").standing]).toEqual(["fail", "confirmation_not_substantiated"]);
    expect(detailsOf(r, "evidence_freshness")).toEqual(["fict-stats: stale (published 2025-10-01)"]);
  });

  it("an unstated or merely asserted publication date leaves freshness unverified", () => {
    const undated = withSource(0, (s) => { s.publishedAt = { status: "not_stated" }; s.verification.publication_date = unverified(); });
    expect(detailsOf(assessBusinessEvidence(undated), "evidence_freshness")).toEqual(["fict-stats: date_unknown"]);
    const assertedDate = withSource(0, (s) => { s.verification.publication_date = asserted(); });
    const r = assessBusinessEvidence(assertedDate);
    expect([statusOf(r, "evidence_freshness"), detailsOf(r, "evidence_freshness")]).toEqual(["unverified", ["fict-stats: date_asserted"]]);
  });

  it("blocking gaps fail; non-blocking gaps are listed", () => {
    const b = businessBundle();
    b.missingInformation.push({ id: "m-licence", description: "Local licensing rules unknown.", blocking: true });
    const r = assessBusinessEvidence(b);
    expect([statusOf(r, "missing_information"), r.overall]).toEqual(["fail", "not_ready"]);
    expect(detailsOf(r, "missing_information")).toEqual(["m-insurance: Insurance cost not yet researched.", "m-licence (blocking): Local licensing rules unknown."]);
  });
});

describe("unsupported financial estimates are labelled", () => {
  it("assumed figures and estimates without verified support carry the label", () => {
    const b = businessBundle();
    b.claims.push({ id: "c-cac", statement: "Acquiring a customer costs 20 GBP.", kind: "assumption", sourceIds: [], method: null, financial: { basis: "unsupported_estimate" }, operatorStatus: "unconfirmed" });
    b.sources[0].verification.origin = asserted();
    const r = assessBusinessEvidence(b);
    expect(standing(r, "c-cac")).toMatchObject({ standing: "assumption", label: UNSUPPORTED_FINANCIAL_LABEL });
    expect(standing(r, "c-revenue")).toMatchObject({ standing: "unsupported_estimate", label: UNSUPPORTED_FINANCIAL_LABEL });
    expect(statusOf(r, "financial_claims_supported")).toBe("unverified");
    expect(detailsOf(r, "financial_claims_supported")).toEqual([
      `c-revenue: ${UNSUPPORTED_FINANCIAL_LABEL} (estimate; support: unverified_sources_only)`, `c-cac: ${UNSUPPORTED_FINANCIAL_LABEL} (assumption; support: no_sources)`,
    ]);
    expect(renderReadiness(r)).toContain("UNSUPPORTED FINANCIAL ESTIMATE");
  });

  it("a financial basis that contradicts the claim kind is refused", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["c-demand", { basis: "unsupported_estimate" }, /financial\.basis: must be sourced for a fact/],
      ["c-revenue", { basis: "sourced" }, /must be derived_from_sourced or unsupported_estimate for a estimate/],
      ["c-revenue", { basis: "guess" }, /financial\.basis: must be one of/],
    ];
    for (const [id, financial, message] of cases) {
      const b = businessBundle();
      claim(b, id).financial = financial;
      expect(refusal(b)).toMatch(message);
    }
  });

  it("a figure derived from sources must cite one; estimates must explain their method", () => {
    const b = businessBundle();
    claim(b, "c-revenue").sourceIds = [];
    const r = assessBusinessEvidence(b);
    expect(detailsOf(r, "source_attribution")).toEqual(["c-revenue: a figure \"derived from sourced\" inputs cites no source"]);
    const m = businessBundle();
    claim(m, "c-revenue").method = null;
    expect(refusal(m)).toMatch(/claims\[2\]\.method: must be text/);
  });
});

describe("rendering", () => {
  it("escapes supplied text and always states that nothing is approved", () => {
    const b = businessBundle();
    b.missingInformation[0].description = "[click](https://example.com) **now**";
    const md = renderReadiness(assessBusinessEvidence(b));
    expect(md).toContain("Approved for real-world use: **no**.");
    expect(md).toContain("\\[click\\]\\(https://example.com\\) \\*\\*now\\*\\*");
    expect(md).not.toContain("[click](");
  });
});
