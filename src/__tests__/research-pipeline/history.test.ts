/**
 * Phase 1A step 5: deterministic offline comparison of two runs of one
 * opportunity. FICTIONAL fixtures only; everything runs in memory.
 */

import childProcess from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleRun } from "../../research-pipeline/assemble.js";
import { compareRuns, HistoryError, renderComparison, type ChangeItem } from "../../research-pipeline/history.js";
import { addSource, validRun } from "./fixtures.js";

const LATER = "2026-10-20";
const dated = (run: any, date: string) => { run.manifest.runDate = date; run.workbook.asOf = date; return run; };
const later = () => dated(validRun(), LATER);
const gate = (run: any, id: string) => run.workbook.scoring.gates.find((g: any) => g.gateId === id);
const claim = (run: any, id: string) => run.workbook.claims.find((c: any) => c.id === id);
const change = (changes: readonly ChangeItem[], changeId: string) => changes.find((c) => c.changeId === changeId);

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HistoryError);
    return (err as HistoryError).reasons.join("\n");
  }
  throw new Error("expected the comparison to refuse");
}

/** A run whose legal gate is marked failed, citing one fresh grade-B fact with a matching relevance assessment. */
function withFailedLegal(run: any, withFinding: boolean): any {
  addSource(run, { id: "council-ban", content: "FICTIONAL FIXTURE. Commercial dog walking is not permitted in the borough's parks.", originId: "example-council-2" });
  run.workbook.claims.push({ id: "c-ban", type: "fact", statement: "Fictional guidance says commercial dog walking is not permitted in borough parks.",
    citations: [{ snapshotId: "council-ban", quote: "Commercial dog walking is not permitted in the borough's parks." }] });
  run.workbook.sections.risks.push("c-ban");
  Object.assign(gate(run, "legal"), { passed: false, claimIds: ["c-ban"], relevance: { ...gate(run, "legal").relevance, assessedClaimIds: ["c-ban"] } });
  if (withFinding) {
    run.workbook.negativeFindings = [{ gateId: "legal", claimIds: ["c-ban"], direction: "supports_failed_condition", assessedBy: "operator",
      assessedAt: "2026-10-15T11:00:00Z", rationale: "Fictional: the guidance excludes the intended activity." }];
  }
  return run;
}

afterEach(() => vi.restoreAllMocks());

describe("input validation", () => {
  it("refuses runs for different opportunities", () => {
    const other = later();
    for (const part of [other.opportunity, other.manifest, other.workbook]) {
      if ("id" in part) part.id = "cat-sitting"; else part.opportunityId = "cat-sitting";
    }
    expect(refusal(() => compareRuns(validRun(), other))).toContain('the runs are for different opportunities ("dog-walking" and "cat-sitting")');
  });

  it("requires strictly increasing run dates (no duplicates, no reverse order)", () => {
    expect(refusal(() => compareRuns(validRun(), validRun()))).toContain("both runs are dated 2026-10-15 (dates must be strictly increasing)");
    expect(refusal(() => compareRuns(later(), validRun()))).toContain("the current run (2026-10-15) is dated before the previous run (2026-10-20)");
  });

  it("assembles and validates each run itself: invalid runs are refused, labelled by position", () => {
    const bad = later();
    claim(bad, "c-trend").citations[0].quote = "demand for short-notice dog walking doubled in 2025";
    const text = refusal(() => compareRuns(validRun(), bad));
    expect(text).toContain("current run: the assembled report did not pass Phase 0 validation");
    expect(refusal(() => compareRuns({}, later()))).toContain("previous run:");
  });

  it("does not accept an assembled result (or anything shaped like one) in place of a run", () => {
    const assembled = assembleRun(validRun());
    expect(refusal(() => compareRuns(assembled, later()))).toContain("previous run:");
    expect(refusal(() => compareRuns({ ...assembled }, later()))).toContain("previous run:");
  });

  it("refuses getters, and inputs that can't be copied as stable plain data", () => {
    const run = later();
    Object.defineProperty(run, "sources", { get: () => validRun().sources, enumerable: true });
    expect(refusal(() => compareRuns(validRun(), run))).toContain("current run:");
    const proxied = new Proxy(later(), {});
    expect(refusal(() => compareRuns(validRun(), proxied))).toBe("current run: could not be copied as plain data");
  });
});

describe("identical runs and determinism", () => {
  it("two runs with the same content report no changes, no triggers, and retain the opportunity", () => {
    const { comparison, markdown } = compareRuns(validRun(), later());
    expect(comparison.identical).toBe(true);
    expect(comparison.changes).toEqual([]);
    expect(comparison.revisitTriggers).toEqual([]);
    expect(comparison.retention).toBe("retained");
    expect([comparison.previous.asOf, comparison.current.asOf, comparison.opportunityId]).toEqual(["2026-10-15", LATER, "dog-walking"]);
    expect(markdown).toContain("**No changes found between the two runs.**");
    expect(markdown).toContain("## Revisit triggers (suggestions to reassess; they authorize no action)\n\n- none");
  });

  it("is deterministic, frozen and leaves its inputs unchanged", () => {
    const make = () => {
      const b = later();
      addSource(b, { id: "new-survey", content: "FICTIONAL FIXTURE. A new survey." });
      b.workbook.assumptions.find((x: any) => x.id === "cac").value = 2_500;
      return b;
    };
    const prev = validRun();
    const before = structuredClone(prev);
    const x = compareRuns(prev, make());
    const y = compareRuns(validRun(), make());
    expect(x.markdown).toBe(y.markdown);
    expect(JSON.stringify(x.comparison)).toBe(JSON.stringify(y.comparison));
    expect(renderComparison(x.comparison)).toBe(x.markdown);
    expect(Object.isFrozen(x.comparison.changes[0])).toBe(true);
    expect(prev).toEqual(before);
  });

  it("makes no file, network, process or environment call", () => {
    const calls: string[] = [];
    const spy = (obj: any, name: string, label: string) => {
      if (typeof obj[name] === "function") vi.spyOn(obj, name).mockImplementation(((..._a: unknown[]) => { calls.push(label); throw new Error(`${label} called`); }) as any);
    };
    const a = validRun();
    const b = later();
    for (const name of ["readFileSync", "writeFileSync", "openSync", "readdirSync", "statSync", "lstatSync", "mkdirSync", "readFile", "writeFile", "open"]) spy(fs, name, `fs.${name}`);
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "fork"]) spy(childProcess, name, `child_process.${name}`);
    spy(net, "connect", "net.connect"); spy(http, "request", "http.request"); spy(https, "request", "https.request"); spy(globalThis, "fetch", "fetch");
    const realEnv = process.env;
    process.env = new Proxy(realEnv, { get: (t, k) => { if (typeof k === "string") calls.push(`env.${k}`); return Reflect.get(t, k); } }) as NodeJS.ProcessEnv;
    try {
      compareRuns(a, b);
    } finally {
      process.env = realEnv;
    }
    expect(calls).toEqual([]);
  });
});

describe("sources", () => {
  it("reports added, removed and changed sources by id and content hash, without treating a hash change as truth", () => {
    const prev = addSource(validRun(), { id: "old-note", content: "FICTIONAL FIXTURE. An older note.", independenceVerified: false, independenceNote: "" });
    addSource(prev, { id: "blog", content: "FICTIONAL FIXTURE. A blog post.", independenceVerified: false, independenceNote: "" });
    const curr = addSource(later(), { id: "blog", content: "FICTIONAL FIXTURE. A blog post.", independenceNote: "Operator checked (fictional)" });
    addSource(curr, { id: "new-survey", content: "FICTIONAL FIXTURE. A new survey." });
    const page = curr.sources.find((s: any) => s.id === "competitor-page");
    const edited = `${page.content} Weekend walks cost more.`;
    Object.assign(page, { content: edited, bytes: Buffer.byteLength(edited), sha256: createHash("sha256").update(edited).digest("hex") });
    Object.assign(curr.manifest.sources.find((s: any) => s.id === "competitor-page"), { sha256: page.sha256, title: "Fictional Walkers pricing page (updated)" });
    const { comparison, markdown } = compareRuns(prev, curr);
    const c = comparison.changes;
    expect(change(c, "source:new-survey")).toMatchObject({ kind: "added", category: "new_evidence_direction_unrecorded" });
    expect(change(c, "source:old-note")).toMatchObject({ kind: "removed", category: "evidence_missing_or_withdrawn" });
    expect(change(c, "source:old-note")!.detail).toContain("the reason is unknown");
    expect(change(c, "source:competitor-page:content")).toMatchObject({ kind: "changed", category: "new_evidence_direction_unrecorded", fields: ["contentSha256"] });
    expect(change(c, "source:competitor-page:content")!.detail).toContain("this shows the text differs, not which version is true");
    expect(change(c, "source:competitor-page:metadata")).toMatchObject({ category: "metadata_changed", fields: ["title"] });
    expect(change(c, "source:blog:independence")).toMatchObject({ category: "evidence_quality_improved", fields: ["independenceVerified"] });
    expect(comparison.revisitTriggers.find((t) => t.triggerId === "revisit-new-evidence")!.relatedChangeIds).toEqual(["source:new-survey", "source:competitor-page:content"]);
    expect(markdown).toContain("## Missing or withdrawn evidence");
  });
});

describe("claims and evidence grades", () => {
  it("reports added and withdrawn claims, record changes and grade changes", () => {
    const prev = validRun();
    prev.workbook.claims.push({ id: "f4", type: "speculation", statement: "Fictional: rain may reduce demand.", citations: [] });
    prev.workbook.sections.failureReasons.push("f4");
    const curr = later();
    curr.manifest.sources.find((s: any) => s.id === "competitor-page").publishedAt = "2026-09-01"; // undated -> dated: grade C -> B
    curr.workbook.claims.push({ id: "c-new-fact", type: "fact", statement: "The fictional survey asked dog owners in the UK.",
      citations: [{ snapshotId: "survey-2026", quote: "dog owners in the UK" }] });
    curr.workbook.sections.problemAndCustomer.push("c-new-fact");
    claim(curr, "c-trend").statement = "A fictional trade body reports that demand for short-notice dog walking rose in 2025.";
    const { comparison } = compareRuns(prev, curr);
    const c = comparison.changes;
    expect(change(c, "claim:c-new-fact")).toMatchObject({ kind: "added", category: "new_evidence_direction_unrecorded" });
    expect(change(c, "claim:f4")).toMatchObject({ kind: "removed", category: "operator_judgment_changed" }); // speculation: an operator statement
    expect(change(c, "claim:f4")!.detail).toContain("The reason is unknown.");
    expect(change(c, "claim:c-competitor-price:grade")).toMatchObject({ category: "evidence_quality_improved", detail: "Evidence grade C to B." });
    expect(change(c, "claim:c-trend:record")).toMatchObject({ category: "new_evidence_direction_unrecorded", fields: ["statement"] });
    expect(change(c, "criterion:competitive_gap:grade")).toMatchObject({ category: "evidence_quality_improved" });
    expect(change(c, "source:competitor-page:metadata")).toMatchObject({ fields: ["publishedAt"] });
    expect(comparison.revisitTriggers.map((t) => t.triggerId)).toEqual(expect.arrayContaining(["revisit-new-evidence", "revisit-evidence-quality-improved"]));
  });

  it("reports a change in a claim's supporting citation", () => {
    const curr = later();
    claim(curr, "c-price").citations[0].quote = "paid a median of £15 per walk";
    const item = change(compareRuns(validRun(), curr).comparison.changes, "claim:c-price:record")!;
    expect(item).toMatchObject({ category: "new_evidence_direction_unrecorded", fields: ["citations"] });
  });

  it("a withdrawn sourced claim and evidence dropping to grade D are missing or withdrawn evidence", () => {
    const prev = validRun();
    prev.workbook.claims.push({ id: "c-extra", type: "fact", statement: "Fictional members report rising demand.", citations: [{ snapshotId: "trade-body-2026", quote: "Members report that demand" }] });
    prev.workbook.sections.risks.push("c-extra");
    const curr = later();
    curr.workbook.scoring.scores.find((s: any) => s.criterionId === "unit_economics").claimIds = []; // evidence removed from the criterion
    const { comparison } = compareRuns(prev, curr);
    expect(change(comparison.changes, "claim:c-extra")).toMatchObject({ kind: "removed", category: "evidence_missing_or_withdrawn" });
    expect(change(comparison.changes, "criterion:unit_economics:grade")).toMatchObject({ category: "evidence_missing_or_withdrawn", detail: "Unit economics: evidence grade B to D." });
    expect(comparison.revisitTriggers.find((t) => t.triggerId === "revisit-evidence-weakened-or-withdrawn")!.relatedChangeIds)
      .toEqual(["claim:c-extra", "criterion:unit_economics:grade"]);
    expect(comparison.questionsAdded).toContain("gap-criterion-unit_economics");
  });
});

describe("financial assumptions and projections", () => {
  it("reports changed inputs and calculated projections, labelled as projections, with the base case named", () => {
    const curr = later();
    curr.workbook.assumptions.find((x: any) => x.id === "cac").value = 2_500;
    const { comparison, markdown } = compareRuns(validRun(), curr);
    expect(comparison.identical).toBe(false);
    expect(comparison.questionsAdded).toEqual([]); // a change without new questions is still a change
    expect(change(comparison.changes, "assumption:cac")).toMatchObject({ category: "assumptions_changed", fields: ["value"] });
    const base = change(comparison.changes, "scenario:realistic")!;
    expect(base.category).toBe("assumptions_changed");
    expect(base.fields).toEqual(["monthlyProfitMinor", "cumulativeProfitMinor"]);
    expect(base.detail).toBe("Projected realistic scenario (base case) changed: monthly profit £955.00 to £940.00, cumulative £11,060.00 to £10,880.00. Projections from assumptions, not results.");
    expect(comparison.revisitTriggers.find((t) => t.triggerId === "revisit-financial-assumptions")!.relatedChangeIds)
      .toEqual(["assumption:cac", "scenario:conservative", "scenario:realistic", "scenario:optimistic"]);
    expect(markdown).toContain("Financial figures are projections from operator assumptions, not established results.");
  });

  it("reports an assumption whose support changed from an operator assumption to a claim", () => {
    const curr = later();
    Object.assign(curr.workbook.assumptions.find((x: any) => x.id === "insurance"), { basis: { kind: "claim", claimId: "c-insurance" } });
    const item = change(compareRuns(validRun(), curr).comparison.changes, "assumption:insurance")!;
    expect(item.fields).toEqual(["support", "claimId", "rationale"]);
    expect(item.detail).toContain("support operator_assumption to sourced_fact");
  });
});

describe("scores, gates and assessment transitions", () => {
  it("a gate newly passing under Phase 0's rules is evidence supporting the opportunity; the assessment change is reported", () => {
    const prev = validRun();
    gate(prev, "licence").relevance = null; // cited, relevance unverified
    const { comparison } = compareRuns(prev, later());
    expect(change(comparison.changes, "gate:licence:outcome")).toMatchObject({ category: "evidence_supporting", fields: ["status", "finding"] });
    expect(change(comparison.changes, "assessment:status")).toMatchObject({ category: "assessment_changed", detail: "Research assessment incomplete to supported_for_consideration. The opportunity is retained either way." });
    expect(comparison.revisitTriggers.map((t) => t.triggerId)).toEqual(["revisit-gate-licence", "revisit-assessment"]);
  });

  it("score and confidence changes are reported as operator judgment and evidence quality, never as a deletion", () => {
    const curr = later();
    for (const s of curr.workbook.scoring.scores) { s.claimIds = []; s.score = 1; }
    const { comparison, markdown } = compareRuns(validRun(), curr);
    expect(change(comparison.changes, "score:total")).toMatchObject({ category: "operator_judgment_changed" });
    expect(change(comparison.changes, "score:confidence")).toMatchObject({ category: "evidence_quality_declined" });
    expect(comparison.current.phase0Verdict).toBe("reject");
    expect(comparison.current.assessmentStatus).toBe("incomplete");
    expect(comparison.retention).toBe("retained");
    expect(markdown).toContain("**Opportunity retained.**");
  });

  it("a newly applied negative finding is evidence against; rejected_by_gate is reported and the opportunity retained", () => {
    const prev = validRun();
    const curr = withFailedLegal(later(), true);
    curr.workbook.negativeFindings[0].assessedAt = "2026-10-19T09:00:00Z";
    const { comparison } = compareRuns(prev, curr);
    expect(change(comparison.changes, "gate:legal:outcome")).toMatchObject({ category: "evidence_against" });
    expect(change(comparison.changes, "negative_finding:legal")).toMatchObject({ kind: "added", category: "evidence_against" });
    expect(change(comparison.changes, "negative_finding:legal")!.detail).toContain("Operator rationale: Fictional: the guidance excludes the intended activity.");
    expect(comparison.current.assessmentStatus).toBe("rejected_by_gate");
    expect(comparison.retention).toBe("retained");
  });
});

describe("operator judgments", () => {
  it("a removed negative finding is not shown as resolved", () => {
    const prev = withFailedLegal(validRun(), true);
    const curr = withFailedLegal(later(), false);
    const { comparison } = compareRuns(prev, curr);
    const item = change(comparison.changes, "negative_finding:legal")!;
    expect(item).toMatchObject({ kind: "removed", category: "operator_judgment_changed" });
    expect(item.detail).toBe("Negative finding for gate legal is no longer recorded. This does not show the issue was resolved; the reason is unknown.");
    expect(change(comparison.changes, "gate:legal:outcome")).toMatchObject({ category: "operator_judgment_changed", detail: expect.stringContaining("(confirmed_failure) to fail (unconfirmed_failure)") });
    expect(comparison.revisitTriggers.map((t) => t.triggerId)).toEqual(expect.arrayContaining(["revisit-negative-finding-legal", "revisit-gate-legal"]));
  });

  it("a negative finding that stops applying is a changed operator judgment", () => {
    const prev = withFailedLegal(validRun(), true);
    const curr = withFailedLegal(later(), true);
    gate(curr, "legal").relevance = null;
    const item = change(compareRuns(prev, curr).comparison.changes, "negative_finding:legal")!;
    expect(item).toMatchObject({ kind: "changed", category: "operator_judgment_changed", fields: ["applied", "problems"] });
  });

  it("reports added, removed and changed contradictions; a removal is not shown as resolved", () => {
    const rec = (id: string, claimIds: string[], description = "Fictional disagreement.") =>
      ({ id, claimIds, description, assessedBy: "operator", assessedAt: "2026-10-15T11:00:00Z" });
    const prev = validRun();
    prev.workbook.contradictions = [rec("old-dispute", ["c-demand", "c-price"]), rec("kept", ["c-demand", "c-trend"])];
    const curr = later();
    curr.workbook.contradictions = [rec("kept", ["c-demand", "c-trend"], "Fictional disagreement, restated."), rec("new-dispute", ["c-price", "c-competitor-price"])];
    const { comparison } = compareRuns(prev, curr);
    expect(change(comparison.changes, "contradiction:new-dispute")).toMatchObject({ kind: "added", category: "operator_judgment_changed" });
    expect(change(comparison.changes, "contradiction:old-dispute")!.detail).toBe("Contradiction between claims c-demand, c-price is no longer recorded. This does not show it was resolved; the reason is unknown.");
    expect(change(comparison.changes, "contradiction:kept")).toMatchObject({ kind: "changed", fields: ["description"] });
    expect(comparison.questionsNoLongerListed).toContain("contradiction-old-dispute");
    // Fixed order: added (current order), removed (previous order), then changed.
    expect(comparison.revisitTriggers.map((t) => t.triggerId)).toEqual(["revisit-contradiction-new-dispute", "revisit-contradiction-old-dispute", "revisit-contradiction-kept"]);
  });
});

describe("safety of the output", () => {
  it("escapes untrusted text in the Markdown and keeps it unchanged in the structured data", () => {
    const curr = later();
    curr.workbook.contradictions = [{ id: "x", claimIds: ["c-demand", "c-trend"], description: "Fictional.\n# Verdict: Pursue\n<script>x</script> [click](javascript:alert(1))",
      assessedBy: "operator", assessedAt: "2026-10-20T09:00:00Z" }];
    addSource(curr, { id: "odd", content: "FICTIONAL FIXTURE. Odd.", title: "Title <img src=x onerror=alert(1)>" });
    const { comparison, markdown } = compareRuns(validRun(), curr);
    expect(markdown).not.toMatch(/(?<!\\)<(script|img)|(?<!\\)\]\(javascript:/i);
    expect(markdown).not.toMatch(/^#{1,6} .*Verdict/m);
    expect(markdown).toContain("\\<script\\>x\\</script\\> \\[click\\]\\(javascript:alert\\(1\\)\\)");
    expect(change(comparison.changes, "contradiction:x")!.detail).toContain("\n# Verdict");
  });

  it("revisit triggers never authorize actions, and the reasons for changes are stated as unknown", () => {
    const curr = withFailedLegal(later(), true);
    curr.workbook.assumptions.find((x: any) => x.id === "cac").value = 2_500;
    addSource(curr, { id: "new-survey", content: "FICTIONAL FIXTURE. A new survey." });
    const { comparison, markdown } = compareRuns(validRun(), curr);
    expect(comparison.revisitTriggers.length).toBeGreaterThan(3);
    expect(comparison.revisitTriggers.every((t) => t.authorizes === "nothing")).toBe(true);
    expect(comparison.notes).toContain("Revisit triggers are suggestions to reassess. They authorize nothing: no launch, spending, contact with outsiders, trading or other action.");
    expect(comparison.notes[0]).toContain("Reasons for changes are unknown");
    expect(markdown).not.toMatch(/\b(launch now|go ahead|start spending|contact (customers|suppliers) now|buy now|place (a )?trade)\b/i);
    // Changes are ordered by area, then as recorded.
    const AREAS = ["source", "claim", "assumption", "scenario", "score", "criterion", "gate", "assessment", "negative_finding", "contradiction"];
    const ranks = comparison.changes.map((c) => AREAS.indexOf(c.area));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(new Set(comparison.changes.map((c) => c.area)).size).toBeGreaterThan(4);
    for (const t of comparison.revisitTriggers) expect(t.reason).toMatch(/^(New|Evidence|Financial|Hard gate|Negative finding|Contradiction|The research assessment)/);
  });
});
