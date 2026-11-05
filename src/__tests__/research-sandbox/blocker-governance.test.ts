/**
 * Step A4: the M1/M3 blockers can't be removed or reworded without an
 * evidence-based decision record (docs/M1-M3-DECISION.md, format in
 * docs/M1-M3-DECISION-TEMPLATE.md). Adding further blockers is always allowed.
 * This test is the guard; the blockers themselves stay in preflight.ts.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MEETS_SPEC_BLOCKERS, rate } from "../../research-sandbox/index.js";
import { evidenceDigest } from "../../research-sandbox/trust-evidence.js";
import { DOCKER_INFO, SPEC } from "./fixtures.js";

const REPO = path.resolve(__dirname, "../../..");
const DECISION = path.join(REPO, "docs/M1-M3-DECISION.md");
const TEMPLATE = path.join(REPO, "docs/M1-M3-DECISION-TEMPLATE.md");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** SHA-256 of each blocker's exact text, as reviewed. Rewording one needs the decision record, like removing it. */
const PINNED: Readonly<Record<string, string>> = Object.freeze({
  M1: "87d011aed451fa1c7051a78d8ac3782d28f81c74ae13e7567e0aa8ca0d6f10da",
  M3: "4457002a939add92755f70957f99b75bab85088ed6ace68b1be349e0d5463cc4",
});
const REQUIRED_EVIDENCE: Readonly<Record<string, readonly string[]>> = Object.freeze({ M1: ["preflight", "negative-controls", "host-processes"], M3: ["preflight", "trust-evidence"] });

const readJson = (file: string): Record<string, any> | null => { try { const v = JSON.parse(fs.readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
const preflightPassed = (r: Record<string, any>) => r.runner === "research-sandbox-preflight" && r.rating === "refused" && r.blockedOnlyByMeetsSpecBlockers === true && r.runtime === "runsc" &&
  r.allowsUntrustedInput === false && r.cleanup?.verifiedRemoved === true;
/**
 * What an evidence file must SHOW for its label (the record can't just cite a hash): the file is the operator's
 * output of the Step A tools, committed under docs/evidence/ (it contains no secrets by design).
 */
const EVIDENCE_CHECKS: Readonly<Record<string, (r: Record<string, any>, section: string) => string | null>> = Object.freeze({
  preflight: (r) => (preflightPassed(r) ? null : "must be a preflight report refused ONLY by the M1/M3 blockers, under runsc, with verified cleanup"),
  "host-processes": (r) => {
    const h = r.hostProcessEvidence;
    return preflightPassed(r) && h && h.polls >= 10 && h.sandboxProcesses >= 1 && h.canaryOnHost === 0 && h.replacedExecutables === 0 && h.overflow === false ? null
      : "must be a passing preflight report whose hostProcessEvidence shows a gVisor sandbox/gofer process, no canary on the host, no replaced executable, no overflow and at least 10 samples";
  },
  "negative-controls": (r) => {
    const names = Array.isArray(r.outcomes) ? r.outcomes.map((o: any) => o?.name) : [];
    return r.runner === "research-sandbox-negative-controls" && r.allPassed === true && Array.isArray(r.outcomes) && r.outcomes.length === r.expected && r.outcomes.every((o: any) => o?.passed === true) &&
      ["baseline", "docker-server-version", "runsc-sha256", "image-id", "gvisor-fingerprint", "runc-instead-of-gvisor"].every((n) => names.includes(n)) ? null
      : "must be a negative-controls report with every control passed (baseline, version, runsc hash, image, gVisor fingerprint and runc at least)";
  },
  "trust-evidence": (r, section) => {
    const { digest, ...body } = r;
    if (r.kind !== "research-sandbox-trust-evidence" || digest !== evidenceDigest(body)) return "must be an unmodified trust-evidence report (its digest must verify)";
    if (r.blocking !== 0 || !["clean", "needs-review"].includes(r.verdict)) return "must have no blocking findings";
    const reviewed = /^Reviewed findings: (\d+)$/m.exec(section)?.[1];
    return r.verdict === "clean" || Number(reviewed) === r.review ? null : `has ${r.review} findings to review: the section must state "Reviewed findings: ${r.review}" after reviewing each`;
  },
});

/** Problems with the decision record's section for one blocker (empty = a valid acceptance). */
export function decisionProblems(text: string, id: string, repo: string = REPO): string[] {
  const p: string[] = [];
  if (/TEMPLATE/.test(text)) p.push("the decision record must not be the template");
  const parts = text.split(/^## /m);
  const sections = parts.filter((s) => s.split("\n")[0].trim() === id);
  if (sections.length !== 1) return [...p, `exactly one "## ${id}" section is required (found ${sections.length})`];
  const s = sections[0];
  const line = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(s)?.[1].trim() ?? null;
  if (line("Decision") !== "ACCEPTED") p.push("Decision: must be ACCEPTED");
  const by = line("Approved-by");
  if (by === null || by.length < 2 || /^</.test(by)) p.push("Approved-by: required");
  const date = line("Date");
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) p.push("Date: YYYY-MM-DD required");
  if (!/^[0-9a-f]{40}$/.test(line("Commit-reviewed") ?? "")) p.push("Commit-reviewed: a 40-hex commit is required");
  const evidence = [...s.matchAll(/^- sha256:([0-9a-f]{64}) ([a-z-]+) (\S+)\s*$/gm)].map((m) => ({ hash: m[1], label: m[2], file: m[3] }));
  for (const label of REQUIRED_EVIDENCE[id] ?? []) if (!evidence.some((e) => e.label === label)) p.push(`Evidence: a "- sha256:<64 hex> ${label} docs/evidence/<file>.json" line is required`);
  for (const e of evidence) {
    // Each cited file must be committed under docs/evidence/, hash to the cited value, and show what its label claims.
    if (!/^docs\/evidence\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.json$/.test(e.file) || e.file.includes("..")) { p.push(`Evidence: ${e.file} must be a .json file directly in docs/evidence/`); continue; }
    const full = path.join(repo, e.file);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) { p.push(`Evidence: ${e.file} does not exist (the evidence must be committed)`); continue; }
    if (createHash("sha256").update(fs.readFileSync(full)).digest("hex") !== e.hash) { p.push(`Evidence: ${e.file} does not have the cited SHA-256`); continue; }
    const check = EVIDENCE_CHECKS[e.label];
    const json = readJson(full);
    if (check === undefined) p.push(`Evidence: unknown label "${e.label}"`);
    else if (json === null) p.push(`Evidence: ${e.file} is not a JSON object`);
    else { const why = check(json, s); if (why !== null) p.push(`Evidence ${e.label}: ${e.file} ${why}`); }
  }
  const residual = s.split(/^Residual risks accepted:\s*$/m)[1];
  if (residual === undefined || [...residual.matchAll(/^- \S.{9,}$/gm)].length < 1) p.push("Residual risks accepted: at least one listed risk is required");
  return p;
}

describe("A4: blocker governance", () => {
  it("each blocker present has its reviewed text (rewording needs the decision record)", () => {
    const record = fs.existsSync(DECISION) ? fs.readFileSync(DECISION, "utf8") : null;
    for (const id of Object.keys(PINNED)) {
      const entry = MEETS_SPEC_BLOCKERS.find((b) => b.startsWith(`${id}: `));
      if (entry !== undefined && sha(entry) === PINNED[id]) continue;
      expect(record, `${id} was ${entry === undefined ? "removed" : "reworded"} without docs/M1-M3-DECISION.md`).not.toBeNull();
      expect(decisionProblems(record!, id), `${id} decision record`).toEqual([]);
    }
  });

  it("the pinned hashes are the current blockers' hashes (both blockers are in force today)", () => {
    expect(MEETS_SPEC_BLOCKERS.map((b) => b.slice(0, 3))).toEqual(["M1:", "M3:"]);
    expect(MEETS_SPEC_BLOCKERS.map(sha)).toEqual([PINNED.M1, PINNED.M3]);
    expect(fs.existsSync(DECISION)).toBe(false); // no decision has been recorded
  });

  it("blockers are frozen, unique and well-formed; more may be added", () => {
    expect(Object.isFrozen(MEETS_SPEC_BLOCKERS)).toBe(true);
    for (const b of MEETS_SPEC_BLOCKERS) expect(b).toMatch(/^M\d+: \S/);
    expect(new Set(MEETS_SPEC_BLOCKERS.map((b) => b.split(":")[0])).size).toBe(MEETS_SPEC_BLOCKERS.length);
  });

  it("while any blocker exists, a fully verified configuration is still refused, and the runner still guards against a contradiction", () => {
    expect(rate(DOCKER_INFO, "runsc", SPEC, true)).toBe("refused");
    expect(fs.readFileSync(path.join(REPO, "src/research-sandbox/runner.ts"), "utf8")).toContain("if (MEETS_SPEC_BLOCKERS.length > 0 && (result.rating === \"meets-spec\" || result.allowsUntrustedInput)) {");
    expect(fs.readFileSync(path.join(REPO, "src/research-sandbox/preflight.ts"), "utf8")).toMatch(/export const MEETS_SPEC_BLOCKERS: readonly string\[\] = Object\.freeze\(\[/);
  });

  it("the decision draft stays PENDING: it can't be mistaken for a decision and never states an acceptance as a record field", () => {
    const draft = fs.readFileSync(path.join(REPO, "docs/M1-M3-DECISION-DRAFT.md"), "utf8");
    expect(draft).toContain("**Status: PENDING.**");
    expect(draft).not.toMatch(/^Decision: ACCEPTED$/m);
    expect(draft).not.toMatch(/^Approved-by: /m);
    for (const d of ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"]) expect(draft).toContain(`**${d} (M`);
    expect(decisionProblems(draft, "M1").length).toBeGreaterThan(0);
    expect(decisionProblems(draft, "M3").length).toBeGreaterThan(0);
  });

  it("the template describes the required format but is never accepted as a decision", () => {
    const t = fs.readFileSync(TEMPLATE, "utf8");
    for (const id of ["M1", "M3"]) expect(decisionProblems(t, id).length).toBeGreaterThan(0);
    for (const label of [...REQUIRED_EVIDENCE.M1, ...REQUIRED_EVIDENCE.M3]) expect(t).toContain(`\`${label}\``);
  });
});

describe("A4: the decision record format (fail closed; evidence must be real)", () => {
  const preflight = { runner: "research-sandbox-preflight", runId: "setup-x", rating: "refused", allowsUntrustedInput: false, blockedOnlyByMeetsSpecBlockers: true, runtime: "runsc",
    cleanup: { verifiedRemoved: true }, hostProcessEvidence: { polls: 80, sandboxProcesses: 2, canaryOnHost: 0, replacedExecutables: 0, overflow: false, executables: ["/usr/bin/runsc"] } };
  const controls = { runner: "research-sandbox-negative-controls", runId: "setup-x", allPassed: true, expected: 6,
    outcomes: ["baseline", "docker-server-version", "runsc-sha256", "image-id", "gvisor-fingerprint", "runc-instead-of-gvisor"].map((name) => ({ name, passed: true })) };
  const trustBody = { kind: "research-sandbox-trust-evidence", verdict: "needs-review", evidence: {}, findings: [{ severity: "review" }], blocking: 0, review: 1, limits: {} };
  const trust = { ...trustBody, digest: evidenceDigest(trustBody) };

  /** A temporary repository with the three evidence files and a decision record citing them. */
  function repo(over: { files?: Record<string, unknown>; edit?: (t: string) => string } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-"));
    fs.mkdirSync(path.join(dir, "docs/evidence"), { recursive: true });
    const files: Record<string, unknown> = { "preflight.json": preflight, "negative-controls.json": controls, "trust-evidence.json": trust, ...over.files };
    const hash: Record<string, string> = {};
    for (const [f, v] of Object.entries(files)) {
      const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      fs.writeFileSync(path.join(dir, "docs/evidence", f), text);
      hash[f] = sha(text);
    }
    const ev = (label: string, f: string) => `- sha256:${hash[f]} ${label} docs/evidence/${f}`;
    const section = (id: string, lines: string[]) => [`## ${id}`, "Decision: ACCEPTED", "Approved-by: Reuben Forbes", "Date: 2026-11-20", `Commit-reviewed: ${"c".repeat(40)}`, "Evidence:", ...lines,
      "Reviewed findings: 1", "Residual risks accepted:", "- a dishonest root-level daemon could lie", ""];
    let text = ["# M1/M3 decision record", "", ...section("M1", [ev("preflight", "preflight.json"), ev("negative-controls", "negative-controls.json"), ev("host-processes", "preflight.json")]),
      ...section("M3", [ev("preflight", "preflight.json"), ev("trust-evidence", "trust-evidence.json")])].join("\n");
    if (over.edit) text = over.edit(text);
    return { dir, text, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }
  const problems = (r: ReturnType<typeof repo>, id = "M1") => { try { return decisionProblems(r.text, id, r.dir).join("\n"); } finally { r.cleanup(); } };

  it("a record citing real, passing evidence is valid for M1 and M3", () => {
    expect(problems(repo(), "M1")).toBe("");
    expect(problems(repo(), "M3")).toBe("");
  });

  it("arbitrary acceptance text with made-up hashes is refused (the cited files must exist and match)", () => {
    const fake = repo({ edit: (t) => t.replace(/sha256:[0-9a-f]{64}/g, `sha256:${"a".repeat(64)}`) });
    expect(problems(fake)).toContain("does not have the cited SHA-256");
    expect(problems(repo({ edit: (t) => t.replace(/docs\/evidence\/negative-controls\.json/, "docs/evidence/missing.json") }))).toContain("docs/evidence/missing.json does not exist");
  });

  it.each([
    ["a failed negative control", { "negative-controls.json": { ...controls, allPassed: false } }, "M1", "every control passed"],
    ["a control missing", { "negative-controls.json": { ...controls, expected: 5, outcomes: controls.outcomes.slice(0, 5) } }, "M1", "every control passed"],
    ["a preflight that was not blocked only by M1/M3", { "preflight.json": { ...preflight, blockedOnlyByMeetsSpecBlockers: false } }, "M1", "refused ONLY by the M1/M3 blockers"],
    ["the canary seen on the host", { "preflight.json": { ...preflight, hostProcessEvidence: { ...preflight.hostProcessEvidence, canaryOnHost: 1 } } }, "M1", "no canary on the host"],
    ["an incomplete process observation", { "preflight.json": { ...preflight, hostProcessEvidence: { ...preflight.hostProcessEvidence, overflow: true } } }, "M1", "no overflow"],
    ["trust evidence with blocking findings", { "trust-evidence.json": (() => { const b = { ...trustBody, verdict: "blocking", blocking: 1 }; return { ...b, digest: evidenceDigest(b) }; })() }, "M3", "must have no blocking findings"],
    ["edited trust evidence (digest no longer verifies)", { "trust-evidence.json": { ...trust, blocking: 0, review: 0, verdict: "clean" } }, "M3", "digest must verify"],
    ["a non-JSON evidence file", { "preflight.json": "not json" }, "M3", "is not a JSON object"],
  ])("%s: refused", (_l, files, id, message) => {
    expect(problems(repo({ files }), id)).toContain(message);
  });

  it.each([
    ["a REJECTED decision", (t: string) => t.replace("Decision: ACCEPTED", "Decision: REJECTED"), "Decision: must be ACCEPTED"],
    ["no approver", (t: string) => t.replace("Approved-by: Reuben Forbes", "Approved-by: <name>"), "Approved-by: required"],
    ["a bad date", (t: string) => t.replace("Date: 2026-11-20", "Date: soon"), "Date: YYYY-MM-DD required"],
    ["no commit", (t: string) => t.replace(/Commit-reviewed: c+/, "Commit-reviewed: HEAD"), "Commit-reviewed: a 40-hex commit is required"],
    ["missing negative-controls evidence", (t: string) => t.replace(/^- sha256:[0-9a-f]+ negative-controls .*$/m, ""), 'a "- sha256:<64 hex> negative-controls docs/evidence/<file>.json" line is required'],
    ["evidence outside docs/evidence", (t: string) => t.replace("docs/evidence/negative-controls.json", "../../etc/passwd.json"), "must be a .json file directly in docs/evidence/"],
    ["an unknown label", (t: string) => t.replace(/ host-processes docs/, " anything docs"), 'unknown label "anything"'],
    ["review findings not acknowledged", (t: string) => t.replace(/Reviewed findings: 1/g, "Reviewed findings: 0"), 'must state "Reviewed findings: 1"'],
    ["no residual risks", (t: string) => t.replace(/Residual risks accepted:\n- a dishonest root-level daemon could lie\n/, ""), "Residual risks accepted"],
    ["two M1 sections", (t: string) => `${t}\n## M1\nDecision: ACCEPTED\n`, 'exactly one "## M1" section'],
    ["the template text", (t: string) => `${t}\n(TEMPLATE)\n`, "must not be the template"],
  ])("%s: refused", (_l, edit, message) => {
    const id = /Reviewed findings/.test(message) ? "M3" : "M1";
    expect(problems(repo({ edit }), id)).toContain(message);
  });

  it("an M1 acceptance does not cover M3", () => {
    expect(problems(repo({ edit: (t) => t.split("## M3")[0] }), "M3")).toContain('exactly one "## M3" section');
  });
});
