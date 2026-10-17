/**
 * Regression tests for the Phase 0 v2 review findings: hostile getters and
 * coercion hooks, forged inputs to exported functions, oversized inputs,
 * per-scenario formulas, unsupported gates, draft verdicts, estimate and
 * free-text labelling, and metadata tampering. Offline; fixtures only.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_CITATIONS_PER_CLAIM, MAX_CLAIMS, MAX_SNAPSHOTS, MAX_SNAPSHOT_CHARS, ProposalQueue, RunBudgetController,
  SchemaError, calculateScenario, calculateScenarios, createSnapshot, daysBetween, escapeInline, extractNumbers,
  formatMoney, gradeEvidence, gradeEvidenceSets, normalizeText, originGroups, parseSnapshot, renderReport, renderUrl,
  scoreOpportunity, sha256Hex, validateReport, verifyClaims,
} from "../../divisions/business-research/index.js";
import { ASSUMPTIONS, AS_OF, CLAIMS, EXPERIMENTS, SCENARIOS, SCORING, SNAPSHOTS, documentedEditCheckHash, resnap, validReport } from "./fixtures.js";

const T = "2026-10-15T12:00:00Z";
const SENTINEL = "HOSTILE-COERCION-OUTPUT";
const clone = <T>(v: T): any => structuredClone(v);

/** A value whose every coercion hook records the call and returns a sentinel. */
function hostile() {
  const calls: string[] = [];
  const value = {
    toString: () => { calls.push("toString"); return SENTINEL; },
    valueOf: () => { calls.push("valueOf"); return 1; },
    [Symbol.toPrimitive]: () => { calls.push("toPrimitive"); return SENTINEL; },
  };
  return { value, calls };
}

/** An object whose `key` is a getter that records reads. */
function withGetter(base: Record<string, unknown>, key: string, returns: unknown) {
  let reads = 0;
  const obj = { ...base };
  Object.defineProperty(obj, key, { enumerable: true, get: () => { reads += 1; return returns; } });
  return { obj, reads: () => reads };
}

const snapshotInput = () => {
  const { integritySha256: _h, ...fields } = SNAPSHOTS[0];
  return { ...fields, derivedFromSnapshotIds: [...fields.derivedFromSnapshotIds] };
};
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error("expected an error");
};

describe("hostile getters and coercion hooks are refused before evaluation", () => {
  it("createSnapshot: getters are not read; non-string content is not converted", () => {
    const g = withGetter(snapshotInput(), "content", "hello world content here");
    expect(() => createSnapshot(g.obj)).toThrow("not a getter/setter");
    expect(g.reads()).toBe(0);
    const h = hostile();
    const msg = message(() => createSnapshot({ ...snapshotInput(), content: h.value }));
    expect(msg).toContain("snapshot.content: must be a string (got object)");
    expect(msg).not.toContain(SENTINEL);
    expect(h.calls).toEqual([]);
    for (const bad of [null, "text", 5, [snapshotInput()]]) expect(() => createSnapshot(bad)).toThrow(SchemaError);
  });

  it("RunBudgetController.authorize: getters, coercible labels and estimates are refused without being called", () => {
    const b = new RunBudgetController(10);
    const g = withGetter({ label: "x" }, "estimatedCostCents", 1);
    expect(b.authorize(g.obj as any)).toMatchObject({ allowed: false });
    expect(g.reads()).toBe(0);
    const label = hostile();
    const r1 = b.authorize({ label: label.value as any, estimatedCostCents: 1 });
    expect(r1.allowed).toBe(false);
    const estimate = hostile();
    const r2 = b.authorize({ label: "x", estimatedCostCents: estimate.value as any });
    expect(r2).toEqual({ allowed: false, reason: "invalid cost estimate (object)" });
    expect([...label.calls, ...estimate.calls]).toEqual([]);
    expect(JSON.stringify([r1, r2])).not.toContain(SENTINEL);
    for (const bad of [null, "x", 1, [], { label: "x", estimatedCostCents: 1, extra: 1 }]) {
      expect(b.authorize(bad as any).allowed).toBe(false);
    }
    expect(b.reservedCents()).toBe(0);
  });

  it("RunBudgetController.settle: a hostile id is not converted; a hostile outcome is charged the worst case unread", () => {
    const b = new RunBudgetController(10);
    const auth = b.authorize({ label: "x", estimatedCostCents: 4 });
    if (!auth.allowed) throw new Error("expected allowed");
    const id = hostile();
    expect(() => b.settle(id.value as any, { kind: "failure", mayHaveBeenBilled: false })).toThrow("reservationId must be an integer (got object)");
    expect(id.calls).toEqual([]);
    const g = withGetter({}, "kind", "success");
    b.settle(auth.reservationId, g.obj as any);
    expect(g.reads()).toBe(0);
    expect(b.spentCents()).toBe(4);
    expect(b.ledger()[0].outcome).toBe("invalid_outcome_charged");
  });

  it("RunBudgetController constructor: a hostile cap is not converted", () => {
    const h = hostile();
    expect(message(() => new RunBudgetController(h.value as any))).toContain("(got object)");
    expect(h.calls).toEqual([]);
  });

  it("ProposalQueue: hostile ids, timestamps and statuses are refused without conversion", () => {
    const q = new ProposalQueue();
    q.submit(EXPERIMENTS[0], T);
    const id = hostile();
    const msg = message(() => q.recordDecision(id.value as any, { decision: "approved", decidedBy: "x", decidedAt: T, note: "" }));
    expect(msg).toContain("proposalId: must be a string (got object)");
    expect(msg).not.toContain(SENTINEL);
    expect(q.get(id.value as any)).toBeUndefined();
    const ts = hostile();
    expect(() => q.submit({ ...EXPERIMENTS[0], id: "other" }, ts.value as any)).toThrow(SchemaError);
    const status = hostile();
    expect(() => q.list(status.value as any)).toThrow(TypeError);
    expect([...id.calls, ...ts.calls, ...status.calls]).toEqual([]);
    expect(q.get("exp-landing")!.status).toBe("needs_approval");
  });

  it("renderReport options: getters and unknown fields are refused unread", () => {
    const g = withGetter({}, "mode", "final");
    expect(() => renderReport(validReport(), g.obj)).toThrow("not a getter/setter");
    expect(g.reads()).toBe(0);
    expect(() => renderReport(validReport(), { mode: "final", extra: 1 })).toThrow("options.extra");
    expect(() => renderReport(validReport(), { mode: "publish" })).toThrow("options.mode");
  });

  it("string helpers never convert non-strings", () => {
    const h = hostile();
    expect(escapeInline(h.value as any)).toBe("\\[non-text value\\]");
    expect(renderUrl(h.value as any)).toBe("\\[non-text value\\]");
    for (const fn of [extractNumbers, normalizeText, sha256Hex]) expect(() => fn(h.value as any)).toThrow("(got object)");
    expect(() => daysBetween(h.value as any, "2026-01-01")).toThrow("(got object)");
    expect(() => formatMoney(h.value as any, "GBP")).toThrow(TypeError);
    expect(() => formatMoney(1, "EUR" as any)).toThrow(TypeError);
    expect(h.calls).toEqual([]);
  });
});

describe("exported calculation and verification functions re-validate their inputs", () => {
  const forged = { ...SNAPSHOTS[0], content: "forged text that never existed anywhere at all" }; // hash no longer matches
  const forgedClaim = { id: "f", type: "fact", statement: "Forged.", citations: [{ snapshotId: SNAPSHOTS[0].id, quote: "forged text that never existed" }] };

  it("verifyClaims refuses a forged snapshot instead of verifying against it", () => {
    expect(() => verifyClaims([forgedClaim], [forged], AS_OF)).toThrow("does not match the snapshot's metadata and content");
    expect(() => verifyClaims(CLAIMS, SNAPSHOTS, "not-a-date")).toThrow("asOf");
    expect(() => verifyClaims([{ ...CLAIMS[0], extra: 1 }], SNAPSHOTS, AS_OF)).toThrow("not an allowed field");
  });

  it("gradeEvidence / gradeEvidenceSets / originGroups refuse forged or invalid inputs", () => {
    expect(() => gradeEvidence(["f"], [forgedClaim], [forged], AS_OF)).toThrow(SchemaError);
    expect(() => gradeEvidence(["c-demand"], CLAIMS, SNAPSHOTS, AS_OF, -1)).toThrow("maxAgeDays");
    expect(() => gradeEvidence(["c-demand"], CLAIMS, SNAPSHOTS, AS_OF, 1.5)).toThrow("maxAgeDays");
    expect(() => gradeEvidence("c-demand", CLAIMS, SNAPSHOTS, AS_OF)).toThrow("claimIds");
    expect(() => gradeEvidenceSets([["c-demand"]], CLAIMS, [forged], AS_OF)).toThrow(SchemaError);
    expect(() => originGroups([forged])).toThrow(SchemaError);
  });

  it("calculateScenario / calculateScenarios refuse unvalidated values", () => {
    const negative = clone(ASSUMPTIONS);
    negative.find((a: any) => a.id === "price").value = -500;
    expect(() => calculateScenario(SCENARIOS[0], negative)).toThrow("between 0");
    expect(() => calculateScenarios(SCENARIOS, negative)).toThrow("between 0");
    const nan = clone(ASSUMPTIONS);
    nan[0].value = Number.NaN;
    expect(() => calculateScenario(SCENARIOS[0], nan)).toThrow("safe integer");
    expect(() => calculateScenario({ ...SCENARIOS[0], extra: 1 }, ASSUMPTIONS)).toThrow("not an allowed field");
    expect(calculateScenario(SCENARIOS[0], ASSUMPTIONS).monthlyProfitMinor).toBe(45_500);
  });

  it("scoreOpportunity refuses out-of-range scores and forged snapshots instead of computing", () => {
    for (const bad of [9, -1, 2.5]) {
      const s = clone(SCORING);
      s.scores[1].score = bad;
      expect(() => scoreOpportunity(s, CLAIMS, SNAPSHOTS, AS_OF)).toThrow(SchemaError);
    }
    expect(() => scoreOpportunity(SCORING, CLAIMS, [...SNAPSHOTS.slice(1), forged], AS_OF)).toThrow(SchemaError);
    const missingGateEvidence = clone(SCORING);
    delete missingGateEvidence.gates[0].claimIds;
    expect(() => scoreOpportunity(missingGateEvidence, CLAIMS, SNAPSHOTS, AS_OF)).toThrow("claimIds: is required");
  });
});

describe("explicit size limits", () => {
  it("source text over the per-snapshot limit is refused", () => {
    expect(() => createSnapshot({ ...snapshotInput(), content: "x".repeat(MAX_SNAPSHOT_CHARS + 1) })).toThrow(`at most ${MAX_SNAPSHOT_CHARS}`);
  });

  it("too many snapshots or claims are refused before any element is read", () => {
    let traps = 0;
    const counted = () => new Proxy({}, { get: () => { traps += 1; return undefined; }, ownKeys: () => { traps += 1; return []; } });
    const many = Array.from({ length: MAX_SNAPSHOTS + 1 }, counted);
    expect(() => verifyClaims([], many, AS_OF)).toThrow(`at most ${MAX_SNAPSHOTS} items`);
    const claims = Array.from({ length: MAX_CLAIMS + 1 }, counted);
    expect(() => verifyClaims(claims, [], AS_OF)).toThrow(`at most ${MAX_CLAIMS} items`);
    expect(traps).toBe(0);
  });

  it("total source text over the aggregate limit is refused", () => {
    const big = "y".repeat(MAX_SNAPSHOT_CHARS);
    const snaps = Array.from({ length: 11 }, (_, i) => createSnapshot({ ...snapshotInput(), id: `big-${i}`, content: big }));
    expect(() => verifyClaims([], snaps, AS_OF)).toThrow("total content is 5500000 characters");
  });

  it("too many citations on one claim are refused", () => {
    const claim = { ...CLAIMS[0], citations: Array.from({ length: MAX_CITATIONS_PER_CLAIM + 1 }, () => CLAIMS[0].citations[0]) };
    expect(() => verifyClaims([claim], SNAPSHOTS, AS_OF)).toThrow(`at most ${MAX_CITATIONS_PER_CLAIM} items`);
  });
});

describe("report: each scenario shows its own formula and horizon", () => {
  it("formulas name each scenario's own assumptions", () => {
    const md = renderReport(validReport());
    const table = (name: string) => md.slice(md.indexOf(`### ${name}`), md.indexOf("| Break-even month", md.indexOf(`### ${name}`)));
    expect(table("Conservative")).toContain("| Monthly revenue | units-low × price | £600.00 |");
    expect(table("Realistic")).toContain("| Monthly revenue | units-mid × price | £1,200.00 |");
    expect(table("Optimistic")).toContain("| Monthly revenue | units-high × price | £1,800.00 |");
    expect(table("Optimistic")).toContain("| Monthly acquisition cost | new-high × cac | £80.00 |");
  });

  it("horizons are per scenario", () => {
    const r = validReport();
    r.assumptions.push({ id: "horizon-long", label: "Longer horizon", value: 24, unit: "months", basis: { kind: "assumption", rationale: "two-year view" } });
    r.scenarios[2].horizonMonthsId = "horizon-long";
    const md = renderReport(r);
    expect(md).toContain("### Conservative (12-month horizon)");
    expect(md).toContain("### Optimistic (24-month horizon)");
    expect(md).toContain("| Cumulative profit over 24 months | profit × horizon-long − startup |");
    expect(md).toContain("| Cumulative profit over 12 months | profit × horizon − startup |");
  });
});

describe("report: hard gates never show PASS without evidence", () => {
  const gateLines = (md: string) => md.split("\n").filter((l) => /^- (PASS|\*\*(FAIL|UNVERIFIED|WEAK|CITED — RELEVANCE UNVERIFIED)\*\*)/.test(l));

  it("evidenced passes show PASS with their grade and evidence", () => {
    const lines = gateLines(renderReport(validReport()));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- PASS \(cited evidence grade [AB]; relevance assessed by the operator\) legal — evidence: claim c-legal \[F\] fact — corroboration: 1 origin; not corroborated \(independence checked\) — relevance \(legal-permitted-in-jurisdiction\) assessed by operator/);
  });

  it("a pass without verified evidence is UNVERIFIED, warned about, and caps the verdict at watch", () => {
    const r = validReport();
    r.scoring.gates[0].claimIds = [];
    r.scoring.gates[1].claimIds = ["c-customer"]; // an assumption: labelled only, no evidence
    const v = validateReport(r);
    expect(v.ok).toBe(true);
    expect(v.score!.gates.map((g) => g.status)).toEqual(["pass_unverified", "pass_unverified", "pass"]);
    expect(v.score!.verdict).toBe("watch");
    expect(v.score!.verdictReason).toContain("hard gate(s) not shown as PASS: legal (no quote-verified evidence), licence (no quote-verified evidence)");
    expect(v.warnings).toContain("gate legal: marked passed without verified evidence (shown as UNVERIFIED)");
    const lines = gateLines(renderReport(r));
    expect(lines[0]).toMatch(/^- \*\*UNVERIFIED\*\* \(marked passed, but no quote-verified evidence\) legal/);
    expect(lines[1]).toMatch(/^- \*\*UNVERIFIED\*\*.* licence — evidence: claim c-customer \[A\] assumption/);
    expect(lines.filter((l) => l.startsWith("- PASS"))).toHaveLength(1);
  });

  it("a failed gate shows FAIL and rejects; an unknown gate claim is an error", () => {
    const r = validReport();
    r.scoring.gates[2].passed = false;
    expect(gateLines(renderReport(r))[2]).toMatch(/^- \*\*FAIL\*\* upfront_cap/);
    expect(validateReport(r).score!.verdict).toBe("reject");
    const u = validateReport({ ...validReport(), scoring: { ...SCORING, gates: [{ ...SCORING.gates[0], claimIds: ["ghost"] }, ...SCORING.gates.slice(1)] } });
    expect(u.errors.join("\n")).toContain('gate legal: references unknown claim "ghost"');
  });
});

describe("report: no verdict in an invalid draft", () => {
  it("withholds verdict, score and confidence; final mode refuses", () => {
    const r = validReport();
    r.claims.push({ id: "bad", type: "fact", statement: "Everyone wants this.", citations: [] });
    r.sections.summary.push("bad");
    expect(validateReport(r).score).toBeNull(); // v6: an invalid report never exposes a score or verdict
    expect(() => renderReport(r, { mode: "final" })).toThrow();
    const md = renderReport(r, { mode: "draft" });
    expect(md).toContain("**Verdict: WITHHELD** (report failed validation)");
    expect(md).not.toMatch(/\*\*Verdict: (Pursue|Watch|Reject)/);
    expect(md).not.toContain("**Score:**");
    expect(md).not.toContain("**Confidence:**");
    expect(md).toContain("## 10. Score breakdown (draft: not decision-ready)");
  });

  it("a valid final report still shows its verdict", () => {
    expect(renderReport(validReport())).toContain("**Verdict: Pursue to validation**");
  });
});

describe("report: estimates and free text are labelled", () => {
  const md = renderReport(validReport());

  it("estimates are marked as derived, including where they feed assumptions", () => {
    expect(md).toContain("- [E] A solo walker could sell about 80 walks per month. _(estimate: derived figure, not directly quoted)_ — method:");
    expect(md).toContain("| units-mid | Walks per month \\(realistic\\) | 80 | count | claim c-units [E] estimate |");
    expect(md).toContain("| price | Price per walk | 1500 | GBP_minor | claim c-price [F] fact |");
    expect(md).toContain("assumption (unverified): operator estimate, unverified");
  });

  it("free-text fields are marked as unverified", () => {
    expect(md).toContain("Brief _(unverified free text)_: ");
    expect(md).toContain("Name and description _(unverified free text)_.");
    expect(md).toContain("Proposal text below is _(unverified free text)_.");
    expect(md).toContain("- Local demand by postcode _(unverified free text)_");
    expect(md).toMatch(/legal — evidence: .* — note _\(unverified free text\)_: /);
  });
});

describe("snapshot integrity covers metadata and content", () => {
  const fields = Object.keys(snapshotInput());

  it.each([
    ["url", "https://example.org/other"], ["publisher", "Someone else"], ["title", "Other title"],
    ["publishedAt", "2026-09-01"], ["retrievedAt", "2026-10-02T09:00:00Z"], ["originId", "other-origin"],
    ["derivedFromSnapshotIds", ["trade-body-2026"]], ["independenceVerified", false], ["independenceNote", "edited"],
    ["content", "FICTIONAL FIXTURE. edited"], ["id", "renamed"],
  ])("editing %s without re-hashing fails integrity verification everywhere", (field, value) => {
    const edited = { ...SNAPSHOTS[0], [field]: value };
    expect(() => parseSnapshot(edited)).toThrow("does not match the snapshot's metadata and content");
    const r = validReport();
    r.snapshots[0] = edited;
    expect(validateReport(r).errors.join("\n")).toContain("does not match the snapshot's metadata and content");
    expect(() => verifyClaims([], [edited, ...SNAPSHOTS.slice(1)], AS_OF)).toThrow(SchemaError);
  });

  it("covers every snapshot field", () => {
    expect(fields.sort()).toEqual([
      "content", "derivedFromSnapshotIds", "id", "independenceNote", "independenceVerified", "originId",
      "publishedAt", "publisher", "retrievedAt", "title", "url",
    ]);
  });

  it("is deterministic: independent of key order, stable across runs, and differs from a content-only hash", () => {
    const input = snapshotInput();
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    expect(createSnapshot(reversed).integritySha256).toBe(createSnapshot(input).integritySha256);
    expect(createSnapshot(input).integritySha256).toBe(SNAPSHOTS[0].integritySha256);
    expect(SNAPSHOTS[0].integritySha256).not.toBe(sha256Hex(SNAPSHOTS[0].content));
    const { integritySha256, ...rest } = SNAPSHOTS[0];
    expect(documentedEditCheckHash(rest)).toBe(integritySha256);
    // Known-answer value pins the serialization format: a change to it must be deliberate.
    expect(createSnapshot({
      id: "kat", url: "https://example.org/kat", publisher: "P", title: "T", publishedAt: "2026-01-01",
      retrievedAt: "2026-02-01T00:00:00Z", originId: "o", derivedFromSnapshotIds: ["a", "b"], independenceVerified: true,
      independenceNote: "n", content: "known answer",
    }).integritySha256).toBe("ecc015c71545cffa2da490c3a77042ffcda91c53e81fa2320189a51a75c7c58f");
  });

  it("field boundaries can't be shifted to forge a collision", () => {
    const { integritySha256: _h, ...rest } = SNAPSHOTS[0];
    // Checked through the real createSnapshot (the helper itself is private since v6).
    const hash = (o: Record<string, unknown>) => createSnapshot({ ...rest, ...o }).integritySha256;
    expect(hash({ publisher: "ab", title: "c" })).not.toBe(hash({ publisher: "a", title: "bc" }));
    expect(hash({ publisher: 'a","b', title: "c" })).not.toBe(hash({ publisher: "a", title: 'b","c' }));
  });

  it("a legitimate edit re-creates the snapshot with a new hash", () => {
    const updated = resnap(SNAPSHOTS[0], { independenceVerified: false, independenceNote: "rechecked" });
    expect(updated.integritySha256).not.toBe(SNAPSHOTS[0].integritySha256);
    expect(parseSnapshot(updated)).toEqual(updated);
  });
});
