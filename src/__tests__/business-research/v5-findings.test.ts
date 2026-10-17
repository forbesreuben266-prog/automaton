/**
 * Regression tests for the Phase 0 v4 check:
 * D3 — a relevance assessment is bound to exactly the evidence it assessed;
 * D4 — every gate line states its origin count and independence status, so
 *      grade B from one fresh source can't pass for independent corroboration;
 * plus the legend wording. Offline; fixtures only.
 */

import { describe, expect, it } from "vitest";
import { QUOTE_VERIFICATION_LEGEND, SchemaError, renderReport, scoreOpportunity, validateReport } from "../../divisions/business-research/index.js";
import { AS_OF, CLAIMS, SCORING, SNAPSHOTS, resnap, validReport } from "./fixtures.js";

const clone = <T>(v: T): any => structuredClone(v);
const gateLine = (md: string, gateId: string) => md.split("\n").find((l) => l.startsWith("- ") && l.includes(` ${gateId} — `))!;
/** The fixture report with the legal gate's cited claims and assessed claims replaced. */
const legalGate = (claimIds: unknown, assessedClaimIds: unknown) => {
  const r = validReport();
  r.scoring.gates[0] = { ...r.scoring.gates[0], claimIds, relevance: { ...r.scoring.gates[0].relevance, assessedClaimIds } };
  return r;
};
const legal = (r: any) => validateReport(r).score!.gates.find((g) => g.gateId === "legal")!;

describe("D3: relevance assessments are bound to the exact cited evidence", () => {
  it("matching evidence passes, in any order", () => {
    expect(legal(validReport())).toMatchObject({ status: "pass", relevanceIssue: null });
    expect(legal(legalGate(["c-demand", "c-trend"], ["c-trend", "c-demand"])).status).toBe("pass");
  });

  it("swapped claims: an assessment of other evidence is CITED — RELEVANCE UNVERIFIED with the reason", () => {
    const r = legalGate(["c-demand"], ["c-legal"]); // assessment made for the council guidance, evidence swapped
    const g = legal(r);
    expect(g.grade).toBe("B");
    expect(g.status).toBe("cited_relevance_unverified");
    expect(g.relevanceIssue).toBe("assessment covers different evidence (assessed: c-legal; cited: c-demand)");
    const v = validateReport(r);
    expect(v.score!.verdict).toBe("watch");
    expect(v.score!.verdictReason).toContain("legal (relevance unverified: assessment covers different evidence");
    const line = gateLine(renderReport(r), "legal");
    // The reason is Markdown-escaped like all rendered text, so its parentheses appear as \( \).
    expect(line).toMatch(/^- \*\*CITED — RELEVANCE UNVERIFIED\*\* \(evidence grade B; assessment covers different evidence \\\(assessed: c-legal; cited: c-demand\\\)\) legal/);
    expect(line.startsWith("- PASS")).toBe(false);
  });

  it("extra assessed ids, missing assessed ids, or an unknown assessed id never PASS", () => {
    expect(legal(legalGate(["c-legal"], ["c-legal", "c-insurance"])).status).toBe("cited_relevance_unverified"); // extra
    expect(legal(legalGate(["c-legal", "c-insurance"], ["c-legal"])).status).toBe("cited_relevance_unverified"); // missing
    expect(legal(legalGate(["c-legal"], ["ghost"])).status).toBe("cited_relevance_unverified"); // not the cited claim
  });

  it("duplicate assessed ids are invalid input", () => {
    const v = validateReport(legalGate(["c-legal"], ["c-legal", "c-legal"]));
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain('relevance.assessedClaimIds: duplicate id "c-legal"');
    expect(v.score).toBeNull();
  });

  it("duplicates in the gate's cited ids collapse: the comparison is set equality", () => {
    expect(legal(legalGate(["c-legal", "c-legal"], ["c-legal"])).status).toBe("pass");
  });

  it.each([
    ["missing", undefined, "assessedClaimIds: is required"],
    ["null", null, "must be an array (got null)"],
    ["a string", "c-legal", "must be an array (got string)"],
    ["empty", [], "at least 1 item"],
    ["a number id", [5], "must be a string (got number)"],
    ["a malformed id", ["Bad ID!"], "invalid format"],
  ])("malformed assessedClaimIds (%s) is refused and never yields PASS", (_label, value, message) => {
    const r = validReport();
    const relevance: any = { ...r.scoring.gates[0].relevance, assessedClaimIds: value };
    if (value === undefined) delete relevance.assessedClaimIds;
    r.scoring.gates[0] = { ...r.scoring.gates[0], relevance };
    const v = validateReport(r);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain(message);
    expect(v.score).toBeNull();
    // Structurally invalid scoring can't be rendered at all, not even as a draft.
    expect(() => renderReport(r, { mode: "final" })).toThrow();
    expect(() => renderReport(r, { mode: "draft" })).toThrow();
  });

  it("a getter for assessedClaimIds is refused without being read", () => {
    let reads = 0;
    const s = clone(SCORING);
    Object.defineProperty(s.gates[0].relevance, "assessedClaimIds", { enumerable: true, get: () => { reads += 1; return ["c-legal"]; } });
    expect(() => scoreOpportunity(s, CLAIMS, SNAPSHOTS, AS_OF)).toThrow(SchemaError);
    expect(reads).toBe(0);
  });
});

describe("D4: each gate line discloses origin count and independence", () => {
  it("one checked origin: not corroborated", () => {
    const md = renderReport(validReport());
    expect(gateLine(md, "legal")).toContain("— corroboration: 1 origin; not corroborated (independence checked) —");
    expect(legal(validReport())).toMatchObject({ distinctOrigins: 1, independentSources: 1, unverifiedOrigins: 0, corroboration: "single_origin" });
  });

  it("one fresh origin with unchecked independence: PASS still says not corroborated and independence unverified", () => {
    const r = validReport();
    r.snapshots = r.snapshots.map((s: any) => (s.id === "council-guidance" ? resnap(s, { independenceVerified: false, independenceNote: "" }) : s));
    const g = legal(r);
    expect(g).toMatchObject({ status: "pass", grade: "B", distinctOrigins: 1, unverifiedOrigins: 1 });
    const line = gateLine(renderReport(r), "legal");
    expect(line.startsWith("- PASS (cited evidence grade B")).toBe(true);
    expect(line).toContain("— corroboration: 1 origin; not corroborated; independence unverified —");
    expect(line).not.toMatch(/\d+ independent origins/);
  });

  it("two checked, independent origins are reported as such (and only then)", () => {
    const r = legalGate(["c-demand", "c-trend"], ["c-demand", "c-trend"]);
    expect(legal(r)).toMatchObject({ grade: "A", corroboration: "independent", independentSources: 2 });
    expect(gateLine(renderReport(r), "legal")).toContain("— corroboration: 2 independent origins (independence checked) —");
  });

  it("two origins where one is unchecked: only one counted as independent", () => {
    const r = legalGate(["c-demand", "c-trend"], ["c-demand", "c-trend"]);
    r.snapshots = r.snapshots.map((s: any) => (s.id === "trade-body-2026" ? resnap(s, { independenceVerified: false, independenceNote: "" }) : s));
    r.scoring.scores[0].score = 3; // demand_evidence 4 would need two independent origins, which no longer holds
    expect(legal(r).grade).toBe("B");
    expect(gateLine(renderReport(r), "legal")).toContain("— corroboration: 2 origins, only 1 counted as independent; independence unverified —");
  });

  it("no quote-verified evidence: no origin", () => {
    const r = validReport();
    r.scoring.gates[0] = { ...r.scoring.gates[0], claimIds: [], relevance: null };
    expect(gateLine(renderReport(r), "legal")).toContain("— corroboration: no quote-verified origin —");
  });

  it("origin counting is deterministic", () => {
    const a = validateReport(legalGate(["c-demand", "c-trend"], ["c-demand", "c-trend"])).score!.gates;
    const b = validateReport(legalGate(["c-trend", "c-demand"], ["c-trend", "c-demand"])).score!.gates;
    expect(a.map(({ claimIds: _c, relevance: _r, relevanceIssue: _i, ...rest }) => rest))
      .toEqual(b.map(({ claimIds: _c, relevance: _r, relevanceIssue: _i, ...rest }) => rest));
  });
});

describe("legend wording", () => {
  it("states the PASS rule and that independence is a separate, possibly unverified, dimension", () => {
    expect(QUOTE_VERIFICATION_LEGEND).toContain("Hard gates show PASS only with grade A/B evidence and an operator relevance assessment tied to exactly the cited evidence (the same claim ids)");
    expect(QUOTE_VERIFICATION_LEGEND).toContain("Independence and corroboration are a separate dimension");
    expect(QUOTE_VERIFICATION_LEGEND).toContain("it may remain unverified even when a gate shows PASS");
    expect(renderReport(validReport())).toContain(QUOTE_VERIFICATION_LEGEND);
  });
});
