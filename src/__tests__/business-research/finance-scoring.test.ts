/**
 * Deterministic financial scenarios and transparent scoring. Offline.
 */

import { describe, expect, it } from "vitest";
import {
  CRITERIA, SchemaError, calculateScenario, calculateScenarios, formatMoney, parseAssumptions,
  parseScenarioDefinitions, parseScoring, parseSourcesAndClaims, scoreOpportunity,
} from "../../divisions/business-research/index.js";
import { ASSUMPTIONS, AS_OF, CLAIMS, SCENARIOS, SCORING, SNAPSHOTS } from "./fixtures.js";

const clone = <T>(v: T): any => structuredClone(v);
const issuesOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof SchemaError) return err.issues.join("\n");
    throw err;
  }
  throw new Error("expected a SchemaError");
};
const results = () => calculateScenarios(parseScenarioDefinitions(SCENARIOS), parseAssumptions(ASSUMPTIONS));

describe("financial scenarios", () => {
  it("calculates exact figures from the stated formulas", () => {
    const [c, r, o] = results();
    expect(c).toMatchObject({
      startupCostMinor: 40_000, monthlyRevenueMinor: 60_000, monthlyVariableCostMinor: 8_000,
      monthlyAcquisitionCostMinor: 4_000, monthlyFixedCostMinor: 2_500, monthlyProfitMinor: 45_500,
      cumulativeProfitMinor: 45_500 * 12 - 40_000, breakEvenMonth: 1, horizonMonths: 12,
    });
    expect(r.monthlyProfitMinor).toBe(120_000 - 16_000 - 6_000 - 2_500);
    expect(o.monthlyProfitMinor).toBe(180_000 - 24_000 - 8_000 - 2_500);
  });

  it("records every formula and every input used", () => {
    const [c] = results();
    expect(c.lines.map((l) => l.formula)).toContain("units-low × price");
    expect(c.inputs).toEqual(expect.arrayContaining(["insurance", "equipment", "phone", "price", "var-cost", "units-low", "new-low", "cac", "horizon"]));
  });

  it("is deterministic", () => {
    expect(results()).toEqual(results());
  });

  it("break-even: exact ceiling, and none when profit ≤ 0 or beyond the horizon", () => {
    const a = clone(ASSUMPTIONS);
    const def = parseScenarioDefinitions(SCENARIOS)[0];
    const set = (id: string, value: number) => { a.find((x: any) => x.id === id).value = value; };
    set("insurance", 45_500 * 3); set("equipment", 0);
    expect(calculateScenario(def, parseAssumptions(a)).breakEvenMonth).toBe(3); // exactly 3 months
    set("equipment", 1);
    expect(calculateScenario(def, parseAssumptions(a)).breakEvenMonth).toBe(4); // just over
    set("insurance", 45_500 * 20);
    expect(calculateScenario(def, parseAssumptions(a)).breakEvenMonth).toBeNull(); // beyond 12 months
    set("price", 0);
    const loss = calculateScenario(def, parseAssumptions(a));
    expect(loss.monthlyProfitMinor).toBeLessThan(0);
    expect(loss.breakEvenMonth).toBeNull();
  });

  it.each([
    ["negative value", (a: any[]) => { a[0].value = -1; }, "between 0"],
    ["fractional value", (a: any[]) => { a[0].value = 1.5; }, "safe integer"],
    ["NaN value", (a: any[]) => { a[0].value = Number.NaN; }, "safe integer"],
    ["string value", (a: any[]) => { a[0].value = "300"; }, "safe integer"],
    ["unknown unit", (a: any[]) => { a[0].unit = "EUR_minor"; }, "must be one of"],
    ["missing basis", (a: any[]) => { delete a[0].basis; }, "basis: is required"],
    ["blank rationale", (a: any[]) => { a[0].basis.rationale = " "; }, "non-blank"],
    ["claim basis without claimId", (a: any[]) => { a[0].basis = { kind: "claim" }; }, "claimId"],
    ["duplicate id", (a: any[]) => { a[1].id = a[0].id; }, "duplicate id"],
  ])("rejects assumptions with %s", (_label, mutate, message) => {
    const a = clone(ASSUMPTIONS);
    mutate(a);
    expect(issuesOf(() => parseAssumptions(a))).toContain(message);
  });

  it("rejects a missing assumption instead of inventing one", () => {
    const a = clone(ASSUMPTIONS).filter((x: any) => x.id !== "cac");
    expect(issuesOf(() => calculateScenarios(parseScenarioDefinitions(SCENARIOS), parseAssumptions(a)))).toContain('assumption "cac" was not supplied');
  });

  it("rejects wrong units (count used as money, USD in a GBP scenario)", () => {
    const a = clone(ASSUMPTIONS);
    a.find((x: any) => x.id === "price").unit = "count";
    a.find((x: any) => x.id === "cac").unit = "USD_minor";
    const msg = issuesOf(() => calculateScenarios(parseScenarioDefinitions(SCENARIOS), parseAssumptions(a)));
    expect(msg).toContain('"price" is in count, expected GBP_minor');
    expect(msg).toContain('"cac" is in USD_minor, expected GBP_minor');
  });

  it("rejects a horizon outside 1-120 months", () => {
    const a = clone(ASSUMPTIONS);
    a.find((x: any) => x.id === "horizon").value = 0;
    expect(issuesOf(() => calculateScenarios(parseScenarioDefinitions(SCENARIOS), parseAssumptions(a)))).toContain("horizon must be 1-120");
  });

  it("rejects overflow", () => {
    const a = clone(ASSUMPTIONS);
    a.find((x: any) => x.id === "price").value = Number.MAX_SAFE_INTEGER;
    expect(issuesOf(() => calculateScenarios(parseScenarioDefinitions(SCENARIOS), parseAssumptions(a)))).toContain("overflows");
  });

  it("requires exactly the three scenarios in one currency", () => {
    expect(issuesOf(() => parseScenarioDefinitions(SCENARIOS.slice(0, 2)))).toContain("at least 3");
    const dup = clone(SCENARIOS); dup[2].name = "realistic";
    expect(issuesOf(() => parseScenarioDefinitions(dup))).toContain("missing the optimistic scenario");
    const mixed = clone(SCENARIOS); mixed[1].currency = "USD";
    expect(issuesOf(() => parseScenarioDefinitions(mixed))).toContain("same currency");
  });

  it("rejects mislabelled scenarios (optimistic worse than realistic)", () => {
    const s = clone(SCENARIOS);
    s[2].unitsSoldPerMonthId = "units-low";
    expect(issuesOf(() => calculateScenarios(parseScenarioDefinitions(s), parseAssumptions(ASSUMPTIONS)))).toContain("mislabelled");
  });

  it("formats money for display", () => {
    expect(formatMoney(123_456, "GBP")).toBe("£1,234.56");
    expect(formatMoney(-5, "USD")).toBe("-$0.05");
  });
});

describe("scoring", () => {
  const { snapshots, claims } = parseSourcesAndClaims(SNAPSHOTS, CLAIMS);
  const score = (raw: unknown) => scoreOpportunity(raw, claims, snapshots, AS_OF);

  it("weights sum to 100", () => {
    expect(CRITERIA.reduce((s, c) => s + c.weight, 0)).toBe(100);
  });

  it("computes the total, the separate confidence and the verdict transparently", () => {
    const r = score(SCORING);
    expect(r.total).toBe(65); // (80+45+60+45+30+30+20+15)/5
    expect(r.criteria.find((c) => c.criterionId === "demand_evidence")).toMatchObject({ weighted: 16, grade: "A", independentSources: 2 });
    expect(r.confidence).toBe("medium"); // A/B grades cover 65% of the weight
    expect(r.verdict).toBe("pursue_to_validation");
  });

  it("confidence does not change when only scores change, and the score doesn't change with evidence alone", () => {
    const lower = clone(SCORING);
    for (const s of lower.scores) s.score = Math.min(s.score, 1);
    const r = score(lower);
    expect(r.confidence).toBe(score(SCORING).confidence);
    expect(r.total).not.toBe(score(SCORING).total);
  });

  it("flags missing evidence and claims that give no evidence", () => {
    const r = score(SCORING);
    expect(r.criteria.find((c) => c.criterionId === "time_to_revenue")!.flags.join()).toContain("MISSING EVIDENCE");
    expect(r.criteria.find((c) => c.criterionId === "acquisition_feasibility")!.flags.join()).toContain("c-acq");
  });

  it("refuses a score above 3 without two independent verified sources", () => {
    const s = clone(SCORING);
    s.scores.find((x: any) => x.criterionId === "competitive_gap").score = 5;
    expect(issuesOf(() => score(s))).toContain("needs at least 2 independent verified sources (has 1)");
  });

  it("any failed hard gate rejects regardless of score", () => {
    const s = clone(SCORING);
    for (const x of s.scores) x.score = 3;
    s.scores[0].score = 5;
    s.gates[1].passed = false;
    const r = score(s);
    expect(r.verdict).toBe("reject");
    expect(r.verdictReason).toContain("licence");
  });

  it("low confidence caps the verdict at watch even with a high score", () => {
    const s = clone(SCORING);
    for (const x of s.scores) {
      x.score = 3;
      x.claimIds = []; // no evidence anywhere: every grade D
    }
    s.scores[0].score = 5; // can't exceed 3 without sources...
    expect(issuesOf(() => score(s))).toContain("independent verified sources");
    s.scores[0].score = 3;
    s.scores[0].claimIds = ["c-demand", "c-trend"]; // A grade, but only 20% of the weight
    s.scores[0].score = 5;
    s.scores[1].score = 5; s.scores[1].claimIds = ["c-demand", "c-trend"]; // +15% -> 35% < 40%
    const r = score(s);
    expect(r.total).toBe(74); // (100+75+45+45+30+30+30+15)/5 ≥ 65
    expect(r.confidence).toBe("low");
    expect(r.verdict).toBe("watch");
    expect(r.verdictReason).toContain("confidence is low");
  });

  it("requires every criterion and gate exactly once, integer scores 0-5, known claims", () => {
    const missing = clone(SCORING); missing.scores.pop();
    expect(issuesOf(() => parseScoring(missing))).toContain('"regulatory_risk" must appear exactly once (found 0)');
    const dup = clone(SCORING); dup.gates.push(dup.gates[0]);
    expect(issuesOf(() => parseScoring(dup))).toContain('"legal" must appear exactly once (found 2)');
    const frac = clone(SCORING); frac.scores[0].score = 4.5;
    expect(issuesOf(() => parseScoring(frac))).toContain("safe integer");
    const big = clone(SCORING); big.scores[0].score = 6;
    expect(issuesOf(() => parseScoring(big))).toContain("between 0 and 5");
    const ghost = clone(SCORING); ghost.scores[1].claimIds = ["ghost"];
    expect(issuesOf(() => score(ghost))).toContain("unknown claim(s): ghost");
  });
});
