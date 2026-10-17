/**
 * Regression tests for the Phase 0 v3 review findings:
 * D1 — reports must not imply that a matching quote proves a claim true, or
 *      that a stored hash proves authenticity;
 * D2 — a hard gate shows PASS only with grade A/B evidence AND an explicit
 *      relevance assessment against the gate's defined criterion; weak
 *      (grade C) and unassessed gates cap the verdict and never touch
 *      confidence. Offline; fixtures only.
 */

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  HARD_GATES, QUOTE_VERIFICATION_LEGEND, SchemaError, parseSnapshot, renderReport, scoreOpportunity,
  validateReport, verifyClaims,
} from "../../divisions/business-research/index.js";
import { AS_OF, CLAIMS, SCORING, SNAPSHOTS, documentedEditCheckHash, resnap, validReport } from "./fixtures.js";

const clone = <T>(v: T): any => structuredClone(v);
const README = fs.readFileSync(path.resolve(__dirname, "../../divisions/business-research/README.md"), "utf8");
const gateLine = (md: string, gateId: string) => md.split("\n").find((l) => l.startsWith("- ") && l.includes(` ${gateId} — `))!;

describe("D1: evidence and integrity wording", () => {
  it("every report (final and draft) carries the quote-verification legend", () => {
    expect(QUOTE_VERIFICATION_LEGEND).toContain("means only that each quoted passage appears in the supplied source snapshot");
    expect(QUOTE_VERIFICATION_LEGEND).toContain("does not establish that the source, or the claim, is true or relevant");
    expect(QUOTE_VERIFICATION_LEGEND).toContain("they are not tamper protection or proof of authenticity");
    expect(renderReport(validReport())).toContain(QUOTE_VERIFICATION_LEGEND);
    const bad = validReport();
    bad.sections.risks.push("ghost");
    expect(renderReport(bad, { mode: "draft" })).toContain(QUOTE_VERIFICATION_LEGEND);
  });

  it("sources show an edit-check SHA-256, never an 'integrity' hash", () => {
    const md = renderReport(validReport());
    expect(md).toMatch(/edit-check SHA-256 [0-9a-f]{12}/);
    expect(md.toLowerCase()).not.toContain("integrity sha256");
    expect(md.toLowerCase()).not.toContain("integrity");
  });

  it("estimates say 'not directly quoted', not 'not a verified fact'", () => {
    const md = renderReport(validReport());
    expect(md).toContain("_(estimate: derived figure, not directly quoted)_");
    expect(md).not.toContain("not a verified fact");
  });

  it("the report never claims authenticity or truth, except to deny it in the legend", () => {
    const md = renderReport(validReport()).replace(QUOTE_VERIFICATION_LEGEND, "");
    // ("guaranteed" is excluded: the report's own disclaimer says projections are "not guaranteed results".)
    for (const phrase of ["authentic", "tamper", "proven", "proves", "is true"]) {
      expect(md.toLowerCase(), phrase).not.toContain(phrase);
    }
  });

  it("README documents that the stored hash alone is not tamper protection or authentication", () => {
    expect(README).toContain("The stored hash alone is not tamper protection or authentication.");
    expect(README).toContain("Trusted tamper");
    expect(README).toContain("requires a reference retained outside the division");
    expect(README).toContain("Quote verification is not truth");
  });

  it("documented limitation holds: re-hashing an edited snapshot with the documented serialization is accepted", () => {
    // This is why the hash is described as an edit check only.
    const { integritySha256: _h, ...fields } = SNAPSHOTS[0];
    const edited = { ...fields, publisher: "Someone else" };
    const rehashed = { ...edited, integritySha256: documentedEditCheckHash(edited) };
    expect(() => parseSnapshot({ ...SNAPSHOTS[0], publisher: "Someone else" })).toThrow("edited after creation, or corrupted");
    expect(parseSnapshot(rehashed).publisher).toBe("Someone else");
  });
});

describe("D2: hard gates need grade A/B evidence and an explicit relevance assessment for PASS", () => {
  const withGate = (index: number, patch: Record<string, unknown>) => {
    const r = validReport();
    r.scoring.gates[index] = { ...r.scoring.gates[index], ...patch };
    return r;
  };

  it("the fixture's assessed, evidenced gates show PASS with the criterion and assessor", () => {
    const md = renderReport(validReport());
    expect(gateLine(md, "legal")).toMatch(/^- PASS \(cited evidence grade B; relevance assessed by the operator\) legal/);
    expect(gateLine(md, "legal")).toContain("relevance (legal-permitted-in-jurisdiction) assessed by operator on 2026-10-15T10:00:00Z _(unverified free text)_:");
  });

  it("unrelated evidence with a matching quote is CITED — RELEVANCE UNVERIFIED, not PASS", () => {
    const r = withGate(0, { claimIds: ["c-demand"], relevance: null }); // a demand survey cited for legality
    const v = validateReport(r);
    expect(v.ok).toBe(true);
    const legal = v.score!.gates.find((g) => g.gateId === "legal")!;
    expect(legal.grade).toBe("B");
    expect(legal.status).toBe("cited_relevance_unverified");
    expect(v.score!.verdict).toBe("watch");
    expect(v.score!.verdictReason).toContain("legal (relevance unverified: relevance not assessed)");
    expect(v.warnings).toContain("gate legal: evidence cited but relevance not assessed (shown as CITED — RELEVANCE UNVERIFIED)");
    const line = gateLine(renderReport(r), "legal");
    expect(line).toMatch(/^- \*\*CITED — RELEVANCE UNVERIFIED\*\* \(evidence grade B; a matching quote doesn't show the evidence meets the gate\) legal/);
    expect(line).toContain(`relevance criterion not assessed: ${HARD_GATES[0].criterionText}`);
    expect(line.startsWith("- PASS")).toBe(false);
  });

  it("a relevance assessment must name the gate's own defined criterion", () => {
    const r = withGate(0, { relevance: { ...SCORING.gates[0].relevance, criterion: "startup-cost-item-priced" } });
    expect(validateReport(r).errors.join("\n")).toContain('must be the gate\'s defined criterion "legal-permitted-in-jurisdiction"');
    const blank = withGate(1, { relevance: { ...SCORING.gates[1].relevance, rationale: " " } });
    expect(validateReport(blank).ok).toBe(false);
    const missing = clone(SCORING);
    delete missing.gates[0].relevance;
    expect(() => scoreOpportunity(missing, CLAIMS, SNAPSHOTS, AS_OF)).toThrow("relevance: is required");
  });

  it("grade C evidence (an undated source) is WEAK even with a relevance assessment, and caps the verdict", () => {
    const r = withGate(2, { claimIds: ["c-competitor-price"] }); // competitor page has no publication date
    const v = validateReport(r);
    const gate = v.score!.gates.find((g) => g.gateId === "upfront_cap")!;
    expect(gate).toMatchObject({ grade: "C", status: "weak" });
    expect(v.score!.verdict).toBe("watch");
    expect(v.score!.verdictReason).toContain("upfront_cap (weak grade-C evidence)");
    expect(v.warnings).toContain("gate upfront_cap: only weak grade-C evidence (shown as WEAK)");
    expect(gateLine(renderReport(r), "upfront_cap")).toMatch(/^- \*\*WEAK\*\* \(grade C: one stale or undated origin\) upfront_cap/);
  });

  it("stale evidence (published over a year before the report) is also WEAK", () => {
    const r = validReport();
    const old = r.snapshots.findIndex((s: any) => s.id === "insurance-quote");
    r.snapshots[old] = resnap(r.snapshots[old], { publishedAt: "2024-01-01" });
    expect(validateReport(r).score!.gates.find((g) => g.gateId === "upfront_cap")!.status).toBe("weak");
  });

  it("unchecked independence adds no corroboration for gates: two unchecked origins grade like one", () => {
    const r = validReport();
    const extra = resnap(r.snapshots.find((s: any) => s.id === "council-guidance"), {
      // Distinct URL and text, so only the declared origin/independence logic is under test (v6 merges identical sources).
      id: "council-copy", originId: "other-outlet", independenceVerified: false, independenceNote: "may repeat the council page",
      url: "https://example.net/fictional-outlet/council-story",
      content: "FICTIONAL FIXTURE. Outlet report: Commercial dog walking is permitted in borough parks. No licence is required to walk up to four dogs at a time.",
    });
    r.snapshots.push(extra);
    r.snapshots = r.snapshots.map((s: any) => (s.id === "council-guidance"
      ? resnap(s, { independenceVerified: false, independenceNote: "not checked" }) : s));
    r.claims.push({ ...CLAIMS.find((c) => c.id === "c-legal"), id: "c-legal-copy", citations: [{ ...CLAIMS.find((c) => c.id === "c-legal")!.citations[0], snapshotId: "council-copy" }] });
    // New evidence needs a new assessment covering exactly that evidence (v5 binding).
    r.scoring.gates[0] = {
      ...r.scoring.gates[0], claimIds: ["c-legal", "c-legal-copy"],
      relevance: { ...r.scoring.gates[0].relevance, assessedClaimIds: ["c-legal-copy", "c-legal"] },
    };
    const legal = validateReport(r).score!.gates.find((g) => g.gateId === "legal")!;
    expect(legal.grade).toBe("B"); // two fresh origins would be A if independence were assumed
    expect(legal.status).toBe("pass"); // explicit relevance assessment for exactly the cited claims
    expect(legal).toMatchObject({ distinctOrigins: 2, independentSources: 1, unverifiedOrigins: 2, corroboration: "unverified_independence" });
    const md = renderReport(r);
    expect(md).toContain("**INDEPENDENCE UNVERIFIED**: may repeat the council page");
    expect(gateLine(md, "legal")).toContain("— corroboration: 2 origins, only 1 counted as independent; independence unverified —");
  });

  it("gate status never changes confidence or the score; it only caps the verdict", () => {
    const base = validateReport(validReport()).score!;
    const variants = [
      withGate(0, { relevance: null }), //                            cited_relevance_unverified
      withGate(2, { claimIds: ["c-competitor-price"] }), //          weak
      withGate(1, { claimIds: [] }), //                               pass_unverified
    ].map((r) => validateReport(r).score!);
    for (const v of variants) {
      expect(v.confidence).toBe(base.confidence);
      expect(v.total).toBe(base.total);
      expect(v.criteria).toEqual(base.criteria);
      expect(v.verdict).toBe("watch");
    }
    expect(base.verdict).toBe("pursue_to_validation");
  });

  it("only gates with status 'pass' render as PASS", () => {
    const r = validReport();
    r.scoring.gates[0] = { ...r.scoring.gates[0], relevance: null };
    r.scoring.gates[1] = { ...r.scoring.gates[1], claimIds: [] };
    r.scoring.gates[2] = { ...r.scoring.gates[2], claimIds: ["c-competitor-price"] };
    const md = renderReport(r);
    expect(md.split("\n").filter((l) => l.startsWith("- PASS"))).toEqual([]);
    const statuses = validateReport(r).score!.gates.map((g) => g.status);
    expect(statuses).toEqual(["cited_relevance_unverified", "pass_unverified", "weak"]);
  });

  it("scoreOpportunity standalone refuses forged evidence before grading gates", () => {
    const forged = [{ ...SNAPSHOTS[3], content: "FICTIONAL FIXTURE. Anything goes, no licence ever needed anywhere." }, ...SNAPSHOTS.filter((s) => s.id !== "council-guidance")];
    expect(() => scoreOpportunity(SCORING, CLAIMS, forged, AS_OF)).toThrow(SchemaError);
    expect(() => verifyClaims(CLAIMS, forged, AS_OF)).toThrow(SchemaError);
  });
});
