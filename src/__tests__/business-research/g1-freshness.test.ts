/**
 * Regression tests for acceptance finding G1: within a merged origin group
 * (same canonical URL or identical text), a newer duplicate must never make
 * stale evidence look fresh, raise a grade, or turn a WEAK gate into PASS.
 * All runtime tests; offline; fixtures only.
 */

import { describe, expect, it } from "vitest";
import {
  CRITERIA, createSnapshot, gradeEvidence, renderReport, scoreOpportunity, validateReport, type SourceSnapshot,
} from "../../divisions/business-research/index.js";
import { AS_OF, resnap, validReport } from "./fixtures.js";

const QUOTE = "No licence is required to walk up to four dogs at a time";
const snap = (id: string, overrides: Partial<SourceSnapshot> = {}): SourceSnapshot => createSnapshot({
  id, url: "https://example.org/guidance", publisher: "Council (fictional)", title: "Guidance", publishedAt: "2020-01-01",
  retrievedAt: "2026-10-01T00:00:00Z", originId: "council", derivedFromSnapshotIds: [], independenceVerified: true,
  independenceNote: "checked (fictional)", content: `FICTIONAL. ${QUOTE} (${id}).`, ...overrides,
});
const claim = (id: string, ...snapshotIds: string[]) => ({
  id, type: "fact", statement: "No licence is required for up to four dogs.",
  citations: snapshotIds.map((snapshotId) => ({ snapshotId, quote: QUOTE })),
});
const stale = snap("old"); //                                             published 2020: stale on the report date
const freshSameUrl = snap("dup-url", { publishedAt: "2026-06-01" }); //   same URL, newer date
const freshSameText = snap("dup-text", {                               // same text, different URL and origin, newer date
  url: "https://example.net/repost", originId: "outlet", publishedAt: "2026-06-01", content: stale.content,
});
const grade = (snapshots: SourceSnapshot[], claims: any[], ids = claims.map((c) => c.id)) =>
  gradeEvidence(ids, claims, snapshots, AS_OF).grade;

describe("G1: a fresh duplicate can't make stale evidence fresh", () => {
  it("baseline: the stale source alone is grade C", () => {
    expect(grade([stale, freshSameUrl], [claim("c", "old")])).toBe("C");
  });

  it("same URL: citing a fresh duplicate as well doesn't improve the grade", () => {
    expect(grade([stale, freshSameUrl], [claim("c", "old", "dup-url")])).toBe("C"); //          one claim, both citations
    expect(grade([stale, freshSameUrl], [claim("c1", "old"), claim("c2", "dup-url")])).toBe("C"); // separate claims
  });

  it("identical content under a different URL: same result", () => {
    expect(grade([stale, freshSameText], [claim("c", "old", "dup-text")])).toBe("C");
    expect(grade([stale, freshSameText], [claim("c1", "old"), claim("c2", "dup-text")])).toBe("C");
  });

  it("all three together (URL and text duplicates) stay grade C", () => {
    expect(grade([stale, freshSameUrl, freshSameText], [claim("c", "old", "dup-url", "dup-text")])).toBe("C");
  });

  it("conservative regardless of citation, claim and snapshot order", () => {
    const snapshotOrders = [[stale, freshSameUrl, freshSameText], [freshSameText, freshSameUrl, stale], [freshSameUrl, stale, freshSameText]];
    const citationOrders = [["old", "dup-url", "dup-text"], ["dup-text", "dup-url", "old"], ["dup-url", "old", "dup-text"]];
    for (const snaps of snapshotOrders) {
      for (const order of citationOrders) {
        expect(grade(snaps, [claim("c", ...order)])).toBe("C");
        const separate = order.map((sid, i) => claim(`c${i}`, sid));
        expect(grade(snaps, separate)).toBe("C");
        expect(grade(snaps, separate, [...separate].reverse().map((c) => c.id))).toBe("C");
      }
    }
  });

  it("scope check: fresh evidence cited on its own, and genuinely distinct fresh sources, are unaffected", () => {
    expect(grade([stale, freshSameUrl], [claim("c", "dup-url")])).toBe("B"); // the newer snapshot alone is fresh
    const a = snap("a", { url: "https://example.org/a", originId: "o-a", publishedAt: "2026-06-01", content: `FICTIONAL. ${QUOTE} (a).` });
    const b = snap("b", { url: "https://example.org/b", originId: "o-b", publishedAt: "2026-06-01", content: `FICTIONAL. ${QUOTE} (b).` });
    expect(grade([a, b], [claim("c", "a", "b")])).toBe("A");
  });
});

describe("G1: a gate that is WEAK on stale evidence can't become PASS through a fresh duplicate", () => {
  const relevance = (criterion: string, ids: string[]) =>
    ({ criterion, assessedClaimIds: ids, assessedBy: "operator", assessedAt: "2026-10-15T10:00:00Z", rationale: "Guidance states the licence threshold (fictional)" });
  const scoring = (ids: string[]) => ({
    scores: CRITERIA.map((c) => ({ criterionId: c.id, score: 3, rationale: "r", claimIds: [] })),
    gates: [
      { gateId: "legal", passed: true, note: "n", claimIds: ids, relevance: relevance("legal-permitted-in-jurisdiction", ids) },
      { gateId: "licence", passed: true, note: "n", claimIds: ids, relevance: relevance("licence-requirement-stated", ids) },
      { gateId: "upfront_cap", passed: true, note: "n", claimIds: ids, relevance: relevance("startup-cost-item-priced", ids) },
    ],
  });
  const licence = (snaps: SourceSnapshot[], claims: any[], ids: string[]) =>
    scoreOpportunity(scoring(ids), claims, snaps, AS_OF).gates.find((g) => g.gateId === "licence")!;

  it("standalone scoring: WEAK before and after adding a same-URL or same-text fresh duplicate", () => {
    const claims = [claim("c-old", "old"), claim("c-url", "dup-url"), claim("c-text", "dup-text")];
    const snaps = [stale, freshSameUrl, freshSameText];
    expect(licence(snaps, claims, ["c-old"])).toMatchObject({ status: "weak", grade: "C" });
    expect(licence(snaps, claims, ["c-old", "c-url"])).toMatchObject({ status: "weak", grade: "C" });
    expect(licence(snaps, claims, ["c-old", "c-text"])).toMatchObject({ status: "weak", grade: "C" });
    expect(licence(snaps, claims, ["c-text", "c-url", "c-old"])).toMatchObject({ status: "weak", grade: "C" });
  });

  it("in a full report: the gate stays WEAK, the verdict stays capped, and no PASS is rendered for it", () => {
    const r = validReport();
    const council = r.snapshots.findIndex((s: any) => s.id === "council-guidance");
    r.snapshots[council] = resnap(r.snapshots[council], { publishedAt: "2020-01-01" }); // stale
    r.snapshots.push(resnap(r.snapshots[council], { id: "council-dup", publishedAt: "2026-06-01" })); // same URL and origin, fresh
    const legalClaim = r.claims.find((c: any) => c.id === "c-legal");
    r.claims.push({ ...legalClaim, id: "c-legal-dup", citations: [{ ...legalClaim.citations[0], snapshotId: "council-dup" }] });
    for (const index of [0, 1]) {
      r.scoring.gates[index] = { ...r.scoring.gates[index], claimIds: ["c-legal", "c-legal-dup"],
        relevance: { ...r.scoring.gates[index].relevance, assessedClaimIds: ["c-legal-dup", "c-legal"] } };
    }
    const v = validateReport(r);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("unreachable");
    for (const id of ["legal", "licence"]) expect(v.score.gates.find((g) => g.gateId === id)).toMatchObject({ status: "weak", grade: "C", distinctOrigins: 1 });
    expect(v.score.verdict).toBe("watch");
    const md = renderReport(r);
    expect(md).not.toMatch(/^- PASS .* (legal|licence) — /m);
    expect(md).toMatch(/^- \*\*WEAK\*\* \(grade C: one stale or undated origin\) licence — /m);
  });
});
