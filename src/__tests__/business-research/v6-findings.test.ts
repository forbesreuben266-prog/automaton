/**
 * Regression tests for the Phase 0 v5 review:
 * C1 — duplicate sources (same canonical URL or identical text) can't
 *      inflate independent-origin counts, grades or gates; conflicting
 *      identities fail closed;
 * F3 — an invalid report never exposes a score, verdict or confidence;
 * F2 — non-validating helpers are not public.
 * All runtime tests; offline; fixtures only.
 */

import { describe, expect, it } from "vitest";
import * as division from "../../divisions/business-research/index.js";
import {
  canonicalSourceUrl, createSnapshot, gradeEvidence, originGroups, renderReport, scoreOpportunity,
  sourceContentFingerprint, sourceIdentityConflicts, validateReport, type SourceSnapshot,
} from "../../divisions/business-research/index.js";
import { AS_OF, SCORING, resnap, validReport } from "./fixtures.js";

const QUOTE = "Demand for weekday dog walking rose sharply in 2025";
const snap = (id: string, overrides: Partial<SourceSnapshot> = {}): SourceSnapshot => createSnapshot({
  id, url: `https://example.org/${id}`, publisher: `Publisher ${id}`, title: `Title ${id}`, publishedAt: "2026-06-01",
  retrievedAt: "2026-10-01T00:00:00Z", originId: `origin-${id}`, derivedFromSnapshotIds: [], independenceVerified: true,
  independenceNote: "checked (fictional)", content: `FICTIONAL. ${QUOTE} (source ${id}).`, ...overrides,
});
const claimFor = (id: string, ...snapshotIds: string[]) => ({
  id, type: "fact", statement: "Demand rose sharply in 2025.",
  citations: snapshotIds.map((snapshotId) => ({ snapshotId, quote: QUOTE })),
});
const grade = (snapshots: SourceSnapshot[], claims: any[], ids = claims.map((c) => c.id)) => gradeEvidence(ids, claims, snapshots, AS_OF);

describe("C1: canonical URLs (conservative)", () => {
  it.each([
    ["scheme", "http://example.org/a", "https://example.org/a"],
    ["host case", "https://EXAMPLE.org/a", "https://example.org/a"],
    ["trailing host dot", "https://example.org./a", "https://example.org/a"],
    ["default https port", "https://example.org:443/a", "https://example.org/a"],
    ["default http port", "http://example.org:80/a", "https://example.org/a"],
    ["fragment", "https://example.org/a#section-2", "https://example.org/a"],
    ["dot segments", "https://example.org/x/../a", "https://example.org/a"],
    ["empty query", "https://example.org/a?", "https://example.org/a"],
    ["root path", "https://example.org", "https://example.org/"],
    ["non-ASCII encoding", "https://example.org/café", "https://example.org/caf%C3%A9"],
  ])("treats %s differences as the same source", (_label, a, b) => {
    expect(canonicalSourceUrl(a)).toBe(canonicalSourceUrl(b));
  });

  it.each([
    ["path case", "https://example.org/A", "https://example.org/a"],
    ["trailing slash", "https://example.org/a/", "https://example.org/a"],
    ["query value", "https://example.org/a?id=1", "https://example.org/a?id=2"],
    ["query parameter present", "https://example.org/a?page=2", "https://example.org/a"],
    ["query order", "https://example.org/a?x=1&y=2", "https://example.org/a?y=2&x=1"],
    ["www", "https://www.example.org/a", "https://example.org/a"],
    ["subdomain", "https://blog.example.org/a", "https://example.org/a"],
    ["non-default port", "https://example.org:8443/a", "https://example.org/a"],
    ["unnormalised encoding", "https://example.org/%7Euser", "https://example.org/~user"],
  ])("keeps %s differences distinct", (_label, a, b) => {
    expect(canonicalSourceUrl(a)).not.toBe(canonicalSourceUrl(b));
  });

  it("refuses non-strings without converting them, other schemes, credentials and invalid URLs", () => {
    let calls = 0;
    const hostile = { toString: () => { calls += 1; return "https://example.org/"; } };
    expect(() => canonicalSourceUrl(hostile as any)).toThrow("url must be a string (got object)");
    expect(calls).toBe(0);
    expect(() => canonicalSourceUrl("ftp://example.org/a")).toThrow("http or https");
    expect(() => canonicalSourceUrl("https://u:p@example.org/a")).toThrow("credentials");
    expect(() => canonicalSourceUrl("not a url")).toThrow("absolute URL");
  });

  it("content fingerprints ignore whitespace only and refuse non-strings", () => {
    expect(sourceContentFingerprint("a  b\nc")).toBe(sourceContentFingerprint("a b c"));
    expect(sourceContentFingerprint("a b c")).not.toBe(sourceContentFingerprint("A b c"));
    expect(() => sourceContentFingerprint(5 as any)).toThrow("(got number)");
  });
});

describe("C1: duplicate sources never count as independent origins", () => {
  it("same canonical URL under different snapshot and origin ids: one origin, conflict reported, independence unverified", () => {
    const a = snap("a", { url: "https://example.org/report" });
    const b = snap("b", { url: "http://EXAMPLE.org/report#top" });
    const g = grade([a, b], [claimFor("ca", "a"), claimFor("cb", "b")]);
    expect(g).toMatchObject({ distinctOrigins: 1, independentSources: 1, unverifiedOrigins: 1, corroboration: "single_origin" });
    expect(g.grade).toBe("B"); // two checked fresh independent origins would be A
    expect(sourceIdentityConflicts([a, b])).toEqual([{ kind: "url", snapshotIds: ["a", "b"], originIds: ["origin-a", "origin-b"] }]);
  });

  it("identical text under different URLs and origins: one origin, conflict reported", () => {
    const content = `FICTIONAL. ${QUOTE}, identical syndicated copy.`;
    const a = snap("a", { content });
    const b = snap("b", { content: content.replace(" ", "   ") }); // whitespace-only difference
    const g = grade([a, b], [claimFor("ca", "a"), claimFor("cb", "b")]);
    expect(g).toMatchObject({ distinctOrigins: 1, independentSources: 1, unverifiedOrigins: 1 });
    expect(sourceIdentityConflicts([a, b])).toEqual([{ kind: "content", snapshotIds: ["a", "b"], originIds: ["origin-a", "origin-b"] }]);
  });

  it("same URL and same declared origin: merged without a conflict (stays checked)", () => {
    const a = snap("a", { url: "https://example.org/r", originId: "same" });
    const b = snap("b", { url: "https://example.org/r", originId: "same" });
    expect(sourceIdentityConflicts([a, b])).toEqual([]);
    expect(grade([a, b], [claimFor("ca", "a"), claimFor("cb", "b")])).toMatchObject({ distinctOrigins: 1, unverifiedOrigins: 0 });
  });

  it("duplicate citations never add origins", () => {
    const a = snap("a");
    const b = snap("b", { url: "https://example.org/a" }); // same URL as a
    expect(grade([a], [claimFor("c", "a", "a")]).distinctOrigins).toBe(1); //            same snapshot cited twice
    expect(grade([a], [claimFor("c1", "a"), claimFor("c2", "a")]).distinctOrigins).toBe(1); // two claims, one snapshot
    expect(grade([a, b], [claimFor("c", "a", "b")]).distinctOrigins).toBe(1); //          one claim, duplicate URLs
  });

  it("duplicates never raise a grade above the single-source grade", () => {
    const single = grade([snap("a")], [claimFor("c", "a")]).grade;
    const dupUrl = grade([snap("a"), snap("b", { url: "https://example.org/a" })], [claimFor("c", "a", "b")]).grade;
    const dupText = grade([snap("a"), snap("b", { content: snap("a").content })], [claimFor("c", "a", "b")]).grade;
    expect([single, dupUrl, dupText]).toEqual(["B", "B", "B"]);
    // Genuinely distinct, checked origins still corroborate.
    expect(grade([snap("a"), snap("b")], [claimFor("c", "a", "b")])).toMatchObject({ grade: "A", corroboration: "independent" });
  });

  it("transitive merging: URL duplicate of one and text duplicate of another collapse into one origin", () => {
    const a = snap("a");
    const b = snap("b", { url: "https://example.org/a" }); //  same URL as a
    const c = snap("c", { content: b.content }); //            same text as b
    const groups = originGroups([a, b, c]);
    expect(new Set(groups.values()).size).toBe(1);
  });

  it("declared repeats (derivedFrom) with different origins are merged but are not conflicts", () => {
    const a = snap("a");
    const b = snap("b", { derivedFromSnapshotIds: ["a"] });
    expect(sourceIdentityConflicts([a, b])).toEqual([]);
    expect(grade([a, b], [claimFor("c", "a", "b")])).toMatchObject({ distinctOrigins: 1, unverifiedOrigins: 0 });
  });

  it("conflicting origin metadata fails closed even when both are marked checked", () => {
    const a = snap("a", { url: "https://example.org/r", originId: "council" });
    const b = snap("b", { url: "https://example.org/r", originId: "independent-outlet" });
    expect(a.independenceVerified && b.independenceVerified).toBe(true);
    expect(grade([a, b], [claimFor("c", "a", "b")])).toMatchObject({ independentSources: 1, unverifiedOrigins: 1 });
  });

  it("in a report: duplicates can't support a score above 3 and the conflict is warned about", () => {
    const r = validReport();
    const trade = r.snapshots.find((s: any) => s.id === "trade-body-2026");
    // Replace the trade body's snapshot with a copy of the survey's URL under a different origin.
    r.snapshots = r.snapshots.map((s: any) => (s.id === "trade-body-2026" ? resnap(trade, { url: r.snapshots[0].url }) : s));
    const v = validateReport(r);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain("score 4 needs at least 2 independent verified sources (has 1; 1 origin(s) have unchecked independence");
    expect(v.warnings.join("\n")).toContain("snapshots survey-2026, trade-body-2026 share the same canonical URL but declare different origins (example-research, example-trade-body)");
  });

  it("a gate can't reach independent corroboration through duplicate sources", () => {
    const r = validReport();
    const council = r.snapshots.find((s: any) => s.id === "council-guidance");
    r.snapshots.push(resnap(council, { id: "council-dup", originId: "other-outlet", url: "https://example.net/repost" })); // same text
    r.claims.push({ ...r.claims.find((c: any) => c.id === "c-legal"), id: "c-legal-dup",
      citations: [{ ...r.claims.find((c: any) => c.id === "c-legal").citations[0], snapshotId: "council-dup" }] });
    r.scoring.gates[0] = { ...r.scoring.gates[0], claimIds: ["c-legal", "c-legal-dup"],
      relevance: { ...r.scoring.gates[0].relevance, assessedClaimIds: ["c-legal", "c-legal-dup"] } };
    const v = validateReport(r);
    expect(v.ok).toBe(true);
    const legal = v.score!.gates.find((g) => g.gateId === "legal")!;
    expect(legal).toMatchObject({ distinctOrigins: 1, independentSources: 1, unverifiedOrigins: 1, grade: "B" });
    const md = renderReport(r);
    expect(md).toMatch(/legal — evidence: .* — corroboration: 1 origin; not corroborated; independence unverified —/);
    expect(md).not.toMatch(/legal — evidence: .* — corroboration: \d+ independent origins/);
  });
});

describe("F3: invalid reports never expose a score, verdict or confidence", () => {
  it.each([
    ["an unsupported fact", (r: any) => { r.claims.push({ id: "bad", type: "fact", statement: "Everyone wants this.", citations: [] }); r.sections.summary.push("bad"); }],
    ["an unknown claim reference", (r: any) => { r.sections.risks.push("ghost"); }],
    ["a missing financial input", (r: any) => { r.assumptions = r.assumptions.filter((a: any) => a.id !== "phone"); }],
    ["an invalid scoring block", (r: any) => { r.scoring.scores[0].score = 9; }],
    ["a tampered snapshot", (r: any) => { r.snapshots[0] = { ...r.snapshots[0], publisher: "edited" }; }],
  ])("%s gives ok:false and score:null", (_label, mutate) => {
    const r = validReport();
    mutate(r);
    const v = validateReport(r);
    expect(v.ok).toBe(false);
    expect(v.score).toBeNull();
  });

  it("a valid report gives ok:true with a score", () => {
    const v = validateReport(validReport());
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("unreachable");
    expect(v.score.verdict).toBe("pursue_to_validation"); // type-narrowed: score is a ScoreResult here
  });

  it("drafts of invalid reports show no verdict, score, confidence or gate PASS", () => {
    const r = validReport();
    r.sections.risks.push("ghost");
    const md = renderReport(r, { mode: "draft" });
    expect(md).toContain("**Verdict: WITHHELD**");
    expect(md).not.toMatch(/\*\*Verdict: (Pursue|Watch|Reject)|\*\*Score:\*\*|\*\*Confidence:\*\*/);
    expect(md).not.toMatch(/^- PASS/m);
    expect(md).toContain("## 10. Score breakdown (draft: not decision-ready)\n\n**NOT COMPUTED**");
    expect(() => renderReport(r, { mode: "final" })).toThrow();
  });
});

describe("F2: non-validating helpers are not public", () => {
  it("the edit-check hash function and deepFreeze are not exported", () => {
    expect("snapshotIntegrityHash" in division).toBe(false);
    expect("deepFreeze" in division).toBe(false);
  });

  it("new public identity helpers refuse getters without reading them", () => {
    let reads = 0;
    const s: any = { ...snap("a") };
    Object.defineProperty(s, "url", { enumerable: true, get: () => { reads += 1; return "https://example.org/a"; } });
    expect(() => sourceIdentityConflicts([s])).toThrow("not a getter/setter");
    expect(() => originGroups([s])).toThrow("not a getter/setter");
    expect(reads).toBe(0);
  });

  it("documented limitation: Proxy traps run during inspection, but the validated result is a plain frozen copy", () => {
    let traps = 0;
    const base = snap("a");
    const proxy = new Proxy({ ...base }, {
      get: (t, k, r) => { traps += 1; return Reflect.get(t, k, r); },
      ownKeys: (t) => { traps += 1; return Reflect.ownKeys(t); },
    });
    const groups = originGroups([proxy]);
    expect(traps).toBeGreaterThan(0); // not a sandbox: caller code ran during validation
    expect([...groups.keys()]).toEqual(["a"]);
  });

  it("scoreOpportunity still refuses forged evidence (unchanged)", () => {
    expect(() => scoreOpportunity(SCORING, [], [{ ...snap("a"), content: "forged" }], AS_OF)).toThrow();
  });
});
