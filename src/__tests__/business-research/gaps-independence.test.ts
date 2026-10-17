/**
 * Regression tests for review gaps: zero startup cost, every verdict and
 * confidence threshold, currency-mismatch warnings, unknown claims in draft
 * reports, getter/setter inputs, and source independence (never inferred
 * from publisher names). Offline; fixtures only.
 */

import { describe, expect, it } from "vitest";
import {
  ProposalQueue, SchemaError, calculateScenarios, gradeEvidence, originGroups, parseAssumptions,
  parseScenarioDefinitions, parseSourcesAndClaims, renderReport, scoreOpportunity, validateReport, type SourceSnapshot,
} from "../../divisions/business-research/index.js";
import { ASSUMPTIONS, AS_OF, CLAIMS, EXPERIMENTS, SCENARIOS, SCORING, SNAPSHOTS, resnap, validReport } from "./fixtures.js";

const clone = <T>(v: T): any => structuredClone(v);
const setAssumption = (a: any[], id: string, value: number) => { a.find((x) => x.id === id).value = value; };

describe("zero startup cost", () => {
  it("breaks even in month 1 (never 'month 0') when monthly profit is positive", () => {
    const a = clone(ASSUMPTIONS);
    setAssumption(a, "insurance", 0);
    setAssumption(a, "equipment", 0);
    const results = calculateScenarios(parseScenarioDefinitions(SCENARIOS), parseAssumptions(a));
    for (const r of results) {
      expect(r.startupCostMinor).toBe(0);
      expect(r.breakEvenMonth).toBe(1);
      expect(r.cumulativeProfitMinor).toBe(r.monthlyProfitMinor * 12);
    }
  });

  it("zero profit never breaks even, even with zero startup cost", () => {
    const a = clone(ASSUMPTIONS);
    for (const [id, v] of [["insurance", 0], ["equipment", 0], ["units-low", 10], ["price", 1_000], ["var-cost", 0], ["new-low", 0], ["phone", 10_000]] as const) {
      setAssumption(a, id, v);
    }
    const [conservative] = calculateScenarios(parseScenarioDefinitions(SCENARIOS), parseAssumptions(a));
    expect(conservative.monthlyProfitMinor).toBe(0);
    expect(conservative.breakEvenMonth).toBeNull();
    expect(conservative.cumulativeProfitMinor).toBe(0);
  });

  it("renders break-even month 1 for a zero-cost start", () => {
    const r = validReport();
    setAssumption(r.assumptions, "insurance", 0);
    setAssumption(r.assumptions, "equipment", 0);
    const md = renderReport(r);
    expect(md.match(/^\| Break-even month \| first month m ≥ 1 with profit × m ≥ startup \| 1 \|$/gm)).toHaveLength(3);
  });
});

describe("verdict and confidence thresholds", () => {
  const { snapshots, claims } = parseSourcesAndClaims(SNAPSHOTS, CLAIMS);
  const TWO = ["c-demand", "c-trend"]; // two checked, independent, fresh origins -> grade A
  const ONE = ["c-price"]; //             one fresh origin -> grade B
  // Criterion order: demand(20) problem(15) upfront(15) unit(15) gap(10) time(10) acquisition(10) regulatory(5)
  const run = (scores: number[], claimIds: Array<string[] | undefined> = [], failGate = false) => {
    const s = clone(SCORING);
    s.scores.forEach((x: any, i: number) => { x.score = scores[i]; x.claimIds = claimIds[i] ?? []; });
    if (failGate) s.gates[2].passed = false;
    return scoreOpportunity(s, claims, snapshots, AS_OF);
  };

  it("44 -> reject (below the watch threshold)", () => {
    const r = run([3, 2, 2, 2, 2, 2, 2, 2]);
    expect(r.total).toBe(44);
    expect(r.verdict).toBe("reject");
    expect(r.verdictReason).toBe("score 44 < 45");
  });

  it("45 -> watch (exactly at the watch threshold)", () => {
    const r = run([3, 2, 2, 2, 2, 2, 2, 3]);
    expect(r.total).toBe(45);
    expect(r.verdict).toBe("watch");
  });

  it("64 -> watch (just below the pursue threshold)", () => {
    const r = run([4, 3, 3, 3, 3, 3, 3, 3], [TWO]);
    expect(r.total).toBe(64);
    expect(r.verdict).toBe("watch");
    expect(r.verdictReason).toBe("score 64 is between 45 and 65");
  });

  it("65 with low confidence -> watch (capped)", () => {
    const r = run([4, 3, 3, 3, 3, 3, 3, 4], [TWO, undefined, undefined, undefined, undefined, undefined, undefined, TWO]);
    expect(r.total).toBe(65);
    expect(r.confidence).toBe("low"); // A/B grades cover 25% of the weight
    expect(r.verdict).toBe("watch");
  });

  it("65 with medium confidence -> pursue_to_validation (exactly at both thresholds)", () => {
    const r = run([4, 3, 3, 3, 3, 3, 3, 4], [TWO, ONE, undefined, undefined, undefined, undefined, undefined, TWO]);
    expect(r.total).toBe(65);
    expect(r.confidence).toBe("medium"); // exactly 40%
    expect(r.verdict).toBe("pursue_to_validation");
  });

  it("confidence: 35% -> low, 65% -> medium, 70% -> high", () => {
    expect(run([3, 3, 3, 3, 3, 3, 3, 3], [TWO, ONE]).confidence).toBe("low");
    expect(run([3, 3, 3, 3, 3, 3, 3, 3], [TWO, ONE, ONE, ONE]).confidence).toBe("medium");
    expect(run([3, 3, 3, 3, 3, 3, 3, 3], [TWO, ONE, ONE, ONE, undefined, undefined, undefined, TWO]).confidence).toBe("high");
  });

  it("a perfect score with a failed gate -> reject", () => {
    const r = run([5, 5, 5, 5, 5, 5, 5, 5], Array(8).fill(TWO), true);
    expect(r.total).toBe(100);
    expect(r.confidence).toBe("high");
    expect(r.verdict).toBe("reject");
    expect(r.verdictReason).toBe("failed hard gate(s): upfront_cap");
  });
});

describe("currency mismatch", () => {
  it("warns when experiment costs use a different currency from the scenarios", () => {
    const r = validReport();
    r.experiments[0].currency = "USD";
    const v = validateReport(r);
    expect(v.ok).toBe(true);
    expect(v.warnings).toContain("experiment costs use a different currency from the scenarios");
    expect(renderReport(r)).toContain("Estimated cost: $0.00");
  });

  it("no currency warning when currencies match", () => {
    expect(validateReport(validReport()).warnings.join("\n")).not.toContain("different currency");
  });
});

describe("unknown claims in draft reports", () => {
  it("draft marks unknown section and competitor references; final refuses", () => {
    const r = validReport();
    r.sections.risks.push("ghost");
    r.sections.competitors[0].priceClaimId = "ghost-price";
    expect(() => renderReport(r, { mode: "final" })).toThrow('references unknown claim "ghost"');
    const md = renderReport(r, { mode: "draft" });
    expect(md).toContain("- **[UNKNOWN CLAIM ghost]**");
    expect(md).toContain("Price: **[UNKNOWN CLAIM ghost-price]**");
  });

  it("an unknown claim in scoring leaves the verdict withheld rather than guessed", () => {
    const r = validReport();
    r.scoring.scores[0].claimIds.push("ghost");
    const md = renderReport(r, { mode: "draft" });
    expect(md).toContain("**Verdict: WITHHELD** (report failed validation)");
    expect(md).not.toContain("**Verdict: Pursue");
  });
});

describe("getter/setter inputs are refused without being read", () => {
  it("object getters", () => {
    let reads = 0;
    const raw: any = { ...EXPERIMENTS[0] };
    Object.defineProperty(raw, "title", { enumerable: true, get: () => { reads += 1; return "x"; } });
    expect(() => new ProposalQueue().submit(raw, "2026-10-15T12:00:00Z")).toThrow("not a getter/setter");
    expect(reads).toBe(0);
  });

  it("array element getters", () => {
    let reads = 0;
    const actions: any[] = [];
    Object.defineProperty(actions, 0, { enumerable: true, get: () => { reads += 1; return "x"; } });
    expect(() => new ProposalQueue().submit({ ...EXPERIMENTS[0], externalActions: actions }, "2026-10-15T12:00:00Z")).toThrow("not getters/setters");
    expect(reads).toBe(0);
  });

  it("functions are not accepted as values", () => {
    const fn = () => { throw new Error("must never be called"); };
    expect(() => new ProposalQueue().submit({ ...EXPERIMENTS[0], method: fn }, "2026-10-15T12:00:00Z")).toThrow(SchemaError);
  });
});

describe("source independence (never inferred from publisher names)", () => {
  const base = SNAPSHOTS[1]; // trade-body-2026; same content keeps the quotes valid
  // Each variant gets its own URL and text (keeping the quoted passage), so these tests exercise the
  // declared origin/independence logic; identical URLs/text are merged since v6 (see v6-findings).
  const variant = (overrides: Partial<SourceSnapshot>): SourceSnapshot => {
    const unique = String(overrides.id ?? "x");
    return resnap(base, { url: `https://example.org/fictional-variant/${unique}`, content: `${base.content} Variant ${unique}.`, ...overrides });
  };
  const claimFor = (id: string, snapshotId: string) => ({
    id, type: "fact", statement: "Demand for short-notice walking rose in 2025.",
    citations: [{ snapshotId, quote: "demand for short-notice dog walking rose in 2025" }],
  });
  const assess = (snaps: SourceSnapshot[], claimIds: string[], claims: any[]) => {
    return gradeEvidence(claimIds, claims, snaps, AS_OF);
  };

  it("different publisher names with the same origin count as one origin", () => {
    const a = variant({ id: "a", publisher: "Example Trade Body" });
    const b = variant({ id: "b", publisher: "ETB Insights (a different name)" });
    const g = assess([a, b], ["ca", "cb"], [claimFor("ca", "a"), claimFor("cb", "b")]);
    expect(g.distinctOrigins).toBe(1);
    expect(g.independentSources).toBe(1);
    expect(g.corroboration).toBe("single_origin");
    expect(g.grade).toBe("B"); // one fresh origin, not A
  });

  it("a source that repeats another (derivedFrom) is merged with it, transitively", () => {
    const a = variant({ id: "a", originId: "origin-a" });
    const b = variant({ id: "b", originId: "origin-b", derivedFromSnapshotIds: ["a"] });
    const c = variant({ id: "c", originId: "origin-c", derivedFromSnapshotIds: ["b"] });
    const g = assess([a, b, c], ["ca", "cb", "cc"], [claimFor("ca", "a"), claimFor("cb", "b"), claimFor("cc", "c")]);
    expect(g.distinctOrigins).toBe(1);
    expect(originGroups([a, b, c]).get("c")).toBe(originGroups([a, b, c]).get("a"));
  });

  it("different origins with unchecked independence add no corroboration and are reported as uncertain", () => {
    const a = variant({ id: "a", originId: "origin-a" });
    const b = variant({ id: "b", originId: "origin-b", independenceVerified: false, independenceNote: "ownership unknown" });
    const g = assess([a, b], ["ca", "cb"], [claimFor("ca", "a"), claimFor("cb", "b")]);
    expect(g.distinctOrigins).toBe(2);
    expect(g.independentSources).toBe(1);
    expect(g.unverifiedOrigins).toBe(1);
    expect(g.corroboration).toBe("unverified_independence");
    expect(g.grade).toBe("B"); // would be A if independence were assumed
  });

  it("two unchecked origins count as one, not two", () => {
    const a = variant({ id: "a", originId: "origin-a", independenceVerified: false, independenceNote: "" });
    const b = variant({ id: "b", originId: "origin-b", independenceVerified: false, independenceNote: "" });
    const g = assess([a, b], ["ca", "cb"], [claimFor("ca", "a"), claimFor("cb", "b")]);
    expect(g.independentSources).toBe(1);
    expect(g.corroboration).toBe("unverified_independence");
  });

  it("two checked, different origins are independent", () => {
    const a = variant({ id: "a", originId: "origin-a" });
    const b = variant({ id: "b", originId: "origin-b" });
    const g = assess([a, b], ["ca", "cb"], [claimFor("ca", "a"), claimFor("cb", "b")]);
    expect(g).toMatchObject({ distinctOrigins: 2, independentSources: 2, corroboration: "independent", grade: "A" });
  });

  it("rejects a verified source without a note, unknown or self derivedFrom references", () => {
    expect(() => variant({ id: "a", independenceVerified: true, independenceNote: " " })).toThrow("independenceNote");
    expect(() => variant({ id: "a", derivedFromSnapshotIds: ["a"] })).toThrow("must not include the snapshot itself");
    expect(() => parseSourcesAndClaims([variant({ id: "a", derivedFromSnapshotIds: ["missing"] })], [])).toThrow('unknown snapshot "missing"');
  });

  it("in a report, an unchecked source can't support a high score, and the uncertainty is shown", () => {
    const r = validReport();
    r.snapshots[1] = resnap(r.snapshots[1], { independenceVerified: false, independenceNote: "could be funded by the survey's publisher" });
    expect(validateReport(r).errors.join("\n")).toContain("score 4 needs at least 2 independent verified sources (has 1; 1 origin(s) have unchecked independence and don't count)");

    r.scoring.scores[0].score = 3;
    const v = validateReport(r);
    expect(v.ok).toBe(true);
    expect(v.warnings).toContain("snapshot trade-body-2026: independence unverified (adds no corroboration)");
    const md = renderReport(r);
    expect(md).toContain("1 of 2 (independence unverified)");
    expect(md).toContain("UNVERIFIED INDEPENDENCE: 2 origins cited but only 1 can be counted as independent");
    expect(md).toContain("**INDEPENDENCE UNVERIFIED**: could be funded by the survey's publisher");
  });
});
