/**
 * Step A4: the M1/M3 blockers can't be removed, reworded or lifted for any
 * configuration (ACCEPTED_DECISION_SCOPE) without an evidence-based decision
 * record (docs/M1-M3-DECISION.md, format in docs/M1-M3-DECISION-TEMPLATE.md)
 * whose Scope lines equal the code's scope. Adding further blockers is always
 * allowed. This test is the guard; the blockers themselves stay in preflight.ts.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPTED_DECISION_SCOPE, MEETS_SPEC_BLOCKERS, assertUntrustedInputAllowed, blockersFor, decisionScopeProblems, rate, resolveSpec, type DecisionScope, type SandboxSpec } from "../../research-sandbox/index.js";
import { evidenceDigest } from "../../research-sandbox/trust-evidence.js";
import { DOCKER_INFO, FAKE_DATA_ROOT, FAKE_DIGEST, FAKE_ENTRYPOINT, FAKE_GVISOR_PROC_VERSION, FAKE_IMAGE_ENV, FAKE_IMAGE_ID, FAKE_MANIFEST_DIGEST, FAKE_RUNSC_SHA256, RUN, SPEC } from "./fixtures.js";

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

/** The Scope line each decision section must carry, derived from the code's ACCEPTED_DECISION_SCOPE. */
export function expectedScopeLine(): string {
  const s = ACCEPTED_DECISION_SCOPE;
  const pending = (v: string | null) => v ?? "pending";
  return [`docker-server-version=${s.dockerServerVersion}`, `seccomp-profile=${s.seccompProfile}`, `runtime=${s.runtime}`, `runsc-path=${s.runscPath}`, `runsc-args=${s.runscArgs.join(",")}`,
    `daemon-runtimes=${s.daemonRuntimes.join(",")}`, `docker-data-root=${s.dockerDataRoot}`, `image-id=${s.imageId}`, `runsc-sha256=${pending(s.runscSha256)}`,
    `runsc-sidecars=${s.sidecars === null ? "pending" : s.sidecars.map((x) => `${x.path}@${x.sha256}`).join(",") || "none"}`,
    `gvisor-reference-sha256=${s.gvisorProcVersion === null ? "pending" : sha(s.gvisorProcVersion)}`].join(" ");
}

/**
 * Problems with lifting M1/M3 inside the code's scope (empty = the lift is backed by a valid decision): the record
 * must exist, accept BOTH blockers with real, passing evidence (decisionProblems), and each section's Scope line must
 * equal the code's scope, so the code can't silently widen what the owner accepted.
 */
export function scopeLiftProblems(record: string | null, repo: string = REPO): string[] {
  if (record === null) return ["the M1/M3 decision scope lifts the blockers without docs/M1-M3-DECISION.md"];
  const p: string[] = [];
  for (const id of ["M1", "M3"]) {
    p.push(...decisionProblems(record, id, repo).map((x) => `${id}: ${x}`));
    const section = record.split(/^## /m).find((s) => s.split("\n")[0].trim() === id);
    const scope = section === undefined ? null : /^Scope: (.+)$/m.exec(section)?.[1] ?? null;
    if (scope === null || scope.split(";")[0].trim() !== expectedScopeLine()) p.push(`${id}: Scope: must be "${expectedScopeLine()}; host: ..." (the code's ACCEPTED_DECISION_SCOPE)`);
    else if (!/; host: \S.{5,}$/.test(scope)) p.push(`${id}: Scope: must name the host it applies to`);
  }
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

  it("the pinned hashes are the current blockers' hashes (both blockers stay in force outside the accepted scope)", () => {
    expect(MEETS_SPEC_BLOCKERS.map((b) => b.slice(0, 3))).toEqual(["M1:", "M3:"]);
    expect(MEETS_SPEC_BLOCKERS.map(sha)).toEqual([PINNED.M1, PINNED.M3]);
    expect(blockersFor(SPEC, "runsc", DOCKER_INFO)).toEqual(MEETS_SPEC_BLOCKERS); // the fixtures are outside the scope
  });

  it("the scope lift is backed by the committed decision record (valid, both blockers, matching Scope lines)", () => {
    const record = fs.existsSync(DECISION) ? fs.readFileSync(DECISION, "utf8") : null;
    expect(scopeLiftProblems(record)).toEqual([]);
    expect(record).toContain("Evidence-commit: 8e91aebebc3bd4d40a98865535eab01afe273696");
    expect(record).toContain("for the owner's\ncurrent IONOS VPS only");
    for (const d of ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"]) expect(record).toMatch(new RegExp(`^\\| ${d} \\| M[13] \\| "I accept`, "m"));
  });

  it("the accepted scope is exactly the reviewed configuration, taken from the committed E1b evidence", () => {
    expect(ACCEPTED_DECISION_SCOPE).toEqual({
      record: "docs/M1-M3-DECISION.md", dockerServerVersion: "29.9.3", seccompProfile: "builtin", runtime: "runsc", runscPath: "/usr/bin/runsc", runscArgs: ["--oci-seccomp"],
      daemonRuntimes: ["io.containerd.runc.v2", "runc", "runsc"], dockerDataRoot: "/var/lib/docker", imageId: "sha256:3e8a7371ba841599f91a259089fd4bad1e0e5e0bda7feba0518a555b5e6d46c5",
      runscSha256: "c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098",
      sidecars: [
        { path: "/usr/bin/gvisor-bin/checkpointgofer", sha256: "37e6e92d6dcb3296e10dc2f21b0ef6156f1373ff0668d27a4fccc8ded2b51f94" },
        { path: "/usr/bin/gvisor-bin/gvisor-proc-umounter", sha256: "b3bbbaef5ddc62084e5febd19d3acca14f3d42b2a25d8552fb40def699467019" },
        { path: "/usr/bin/gvisor-bin/gvisor-sentry-prewarmer", sha256: "046e3ec1de3aa7b7ec7ce53b4f0d1e08db15987847606a8e361133d5c5bd3d73" },
        { path: "/usr/bin/gvisor-bin/gvisor_sentry", sha256: "6dfd3af65e664663f332d0e4b9fb82452496e34ebc6cb568ae49f5b1ac9d8166" },
        { path: "/usr/bin/gvisor-bin/runsc-fd-parking", sha256: "03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11" },
        { path: "/usr/bin/gvisor-bin/runsc-metric-server", sha256: "b9857ebe290c403fda7ff014368df3a0f45e5428dc1eb6efe413cfe0e5a940f4" },
        { path: "/usr/bin/containerd-shim-runsc-v1", sha256: "6187d6d34f4996e859353fbb4c56d5ed41fc35b5afa44bff766f4e4b424da5bb" },
        { path: "/etc/containerd/runsc.toml", sha256: "ea5ada6422655b972fd3af73f7a23b88cc3385c98767cca2f360b2aa749d114c" },
      ],
      gvisorProcVersion: "Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016",
    });
    expect(Object.isFrozen(ACCEPTED_DECISION_SCOPE.sidecars) && ACCEPTED_DECISION_SCOPE.sidecars!.every((x) => Object.isFrozen(x))).toBe(true);
    // The gVisor reference is gVisor's emulated kernel string, never the test host's own.
    expect(ACCEPTED_DECISION_SCOPE.gvisorProcVersion).toMatch(/^Linux version \S+-gvisor /);
    for (const v of [ACCEPTED_DECISION_SCOPE, ACCEPTED_DECISION_SCOPE.runscArgs, ACCEPTED_DECISION_SCOPE.daemonRuntimes]) expect(Object.isFrozen(v)).toBe(true);
    const report = readJson(path.join(REPO, "docs/evidence/e1b-preflight-report.json"))!;
    expect(report.engine).toMatchObject({ serverVersion: ACCEPTED_DECISION_SCOPE.dockerServerVersion, seccompProfile: ACCEPTED_DECISION_SCOPE.seccompProfile, rootless: false });
    expect([...report.engine.runtimes].sort()).toEqual([...ACCEPTED_DECISION_SCOPE.daemonRuntimes].sort());
    expect(report.runtime).toBe(ACCEPTED_DECISION_SCOPE.runtime);
    const trust = readJson(path.join(REPO, "docs/evidence/e1b-trust-evidence.json"))!;
    expect(trust.evidence.runscRuntime).toEqual({ path: ACCEPTED_DECISION_SCOPE.runscPath, runtimeArgs: [...ACCEPTED_DECISION_SCOPE.runscArgs] });
    expect(trust.evidence.dockerInfo.DockerRootDir).toBe(ACCEPTED_DECISION_SCOPE.dockerDataRoot);
    expect(readJson(path.join(REPO, "docs/evidence/e1b-executor-dryrun.json"))!.audit.imageRef).toBe(ACCEPTED_DECISION_SCOPE.imageId);
  });

  it("with the real recorded scope, exactly the reviewed configuration meets the spec, and any single change brings M1/M3 back", () => {
    const s = ACCEPTED_DECISION_SCOPE;
    expect(s.runscSha256 !== null && s.sidecars !== null && s.gvisorProcVersion !== null).toBe(true);
    const runsc = { path: s.runscPath, sha256: s.runscSha256!, args: [...s.runscArgs], sidecars: s.sidecars!.map((x) => ({ ...x })) };
    const spec = resolveSpec({
      imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, gvisorProcVersion: s.gvisorProcVersion!, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST,
      dockerDataRoot: s.dockerDataRoot, runscBinary: runsc, dockerServerVersion: s.dockerServerVersion, imageId: s.imageId,
    });
    const info = { ...DOCKER_INFO, serverVersion: s.dockerServerVersion, runtimes: [...s.daemonRuntimes], runtimeConfigs: { runc: { path: "runc" }, runsc: { path: s.runscPath, runtimeArgs: [...s.runscArgs] } } };
    expect(decisionScopeProblems(spec, "runsc", info)).toEqual([]);
    expect(blockersFor(spec, "runsc", info)).toEqual([]);
    expect(rate(info, "runsc", spec, true)).toBe("meets-spec");
    const changed: [string, SandboxSpec, any][] = [
      ["runsc hash", { ...spec, runscBinary: { ...spec.runscBinary!, sha256: "0".repeat(64) } }, info],
      ["one sidecar hash", { ...spec, runscBinary: { ...spec.runscBinary!, sidecars: spec.runscBinary!.sidecars.map((x, i) => (i === 3 ? { ...x, sha256: "0".repeat(64) } : x)) } }, info],
      ["a sidecar dropped", { ...spec, runscBinary: { ...spec.runscBinary!, sidecars: spec.runscBinary!.sidecars.slice(1) } }, info],
      ["gVisor reference", { ...spec, gvisorProcVersion: "Linux version 4.4.0 #1 SMP Sun Jan 10 15:06:54 PST 2016" }, info],
      ["image", { ...spec, image: { ...spec.image, id: `sha256:${"0".repeat(64)}` } }, info],
      ["daemon runtimes", spec, { ...info, runtimes: [...info.runtimes, "kata"] }],
      ["daemon runsc arguments", spec, { ...info, runtimeConfigs: { runsc: { path: s.runscPath, runtimeArgs: [] } } }],
      ["reported Docker version", spec, { ...info, serverVersion: "29.9.4" }],
    ];
    for (const [label, sp, inf] of changed) {
      expect(blockersFor(sp, "runsc", inf), label).toEqual(MEETS_SPEC_BLOCKERS);
      expect(rate(inf, "runsc", sp, true), label).not.toBe("meets-spec");
    }
    expect(rate(info, "runsc", spec, false)).toBe("development-only"); // gVisor must still be positively verified at run time
  });

  it("blockers are frozen, unique and well-formed; more may be added", () => {
    expect(Object.isFrozen(MEETS_SPEC_BLOCKERS)).toBe(true);
    for (const b of MEETS_SPEC_BLOCKERS) expect(b).toMatch(/^M\d+: \S/);
    expect(new Set(MEETS_SPEC_BLOCKERS.map((b) => b.split(":")[0])).size).toBe(MEETS_SPEC_BLOCKERS.length);
  });

  it("outside the accepted scope a fully verified configuration is still refused, and the runner still guards against a contradiction", () => {
    expect(rate(DOCKER_INFO, "runsc", SPEC, true)).toBe("refused");
    expect(fs.readFileSync(path.join(REPO, "src/research-sandbox/runner.ts"), "utf8")).toContain("const blockers = blockersFor(spec, result.runtime, result.engine);\n    if (blockers.length > 0 && (result.rating === \"meets-spec\" || result.allowsUntrustedInput)) {");
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

  /** Lifting the blockers in the code's scope: the record with valid Scope lines in both sections, then an edit. */
  const withScope = (t: string) => t.replace(/^(Commit-reviewed: .*)$/gm, `$1\nScope: ${expectedScopeLine()}; host: the owner's current VPS only`);
  const lift = (edit: (t: string) => string = (t) => t) => { const r = repo({ edit: (t) => edit(withScope(t)) }); try { return scopeLiftProblems(r.text, r.dir).join("\n"); } finally { r.cleanup(); } };

  it("a lift backed by a valid record for both blockers with matching Scope lines is accepted", () => {
    expect(lift()).toBe("");
  });

  it.each([
    ["missing: no decision record at all", null, "without docs/M1-M3-DECISION.md"],
    ["incomplete: only M1 accepted", (t: string) => t.split("## M3")[0], 'M3: exactly one "## M3" section'],
    ["incomplete: evidence line removed", (t: string) => t.replace(/^- sha256:[0-9a-f]+ trust-evidence .*$/m, ""), "M3: Evidence: a \"- sha256:<64 hex> trust-evidence"],
    ["mismatched: a cited hash differs from the committed file", (t: string) => t.replace(/sha256:[0-9a-f]{64} preflight/, `sha256:${"0".repeat(64)} preflight`), "does not have the cited SHA-256"],
    ["mismatched: the record's scope names another Docker version", (t: string) => t.replace(/docker-server-version=29\.9\.3/, "docker-server-version=29.9.4"), "M1: Scope: must be"],
    ["mismatched: no Scope line", (t: string) => t.replace(/^Scope: .*\n/gm, ""), "Scope: must be"],
    ["mismatched: the scope names no host", (t: string) => t.replace(/; host: .*$/gm, ""), "Scope: must name the host"],
    ["unaccepted: M3 REJECTED", (t: string) => t.replace(/(## M3\n)Decision: ACCEPTED/, "$1Decision: REJECTED"), "M3: Decision: must be ACCEPTED"],
    ["unaccepted: M1 still PENDING", (t: string) => t.replace("Decision: ACCEPTED", "Decision: PENDING"), "M1: Decision: must be ACCEPTED"],
  ])("%s: the lift is refused", (_l, edit, message) => {
    if (edit === null) { expect(scopeLiftProblems(null).join("\n")).toContain(message); return; }
    expect(lift(edit)).toContain(message);
  });

  it("the committed draft is never accepted as a lift", () => {
    expect(scopeLiftProblems(fs.readFileSync(path.join(REPO, "docs/M1-M3-DECISION-DRAFT.md"), "utf8")).length).toBeGreaterThan(0);
  });
});

describe("A4: the decision scope check (with a fully recorded scope)", () => {
  const RUNSC = { path: "/usr/bin/runsc", sha256: FAKE_RUNSC_SHA256, args: ["--oci-seccomp"], sidecars: [{ path: "/usr/bin/gvisor-bin/gvisor_sentry", sha256: "7a".repeat(32) }] };
  /** The real scope with its host pins recorded (as they will be from the VPS configuration). */
  const FULL: DecisionScope = Object.freeze({ ...ACCEPTED_DECISION_SCOPE, runscSha256: FAKE_RUNSC_SHA256, sidecars: RUNSC.sidecars, gvisorProcVersion: FAKE_GVISOR_PROC_VERSION });
  const SCOPED: SandboxSpec = resolveSpec({
    imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, gvisorProcVersion: FAKE_GVISOR_PROC_VERSION, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST,
    dockerDataRoot: "/var/lib/docker", runscBinary: RUNSC, dockerServerVersion: "29.9.3", imageId: ACCEPTED_DECISION_SCOPE.imageId,
  });
  const INFO = { ...DOCKER_INFO, serverVersion: "29.9.3", runtimes: ["io.containerd.runc.v2", "runc", "runsc"], runtimeConfigs: { runc: { path: "runc" }, runsc: { path: "/usr/bin/runsc", runtimeArgs: ["--oci-seccomp"] } } };
  const problems = (spec: SandboxSpec, info: any = INFO, runtime: string | null = "runsc") => decisionScopeProblems(spec, runtime, info, FULL).join("\n");

  it("the exact reviewed configuration is inside the scope", () => {
    expect(problems(SCOPED)).toBe("");
    expect(problems(SCOPED, { ...INFO, runtimes: ["runsc", "runc", "io.containerd.runc.v2"] })).toBe(""); // order of the daemon's list does not matter
    expect(problems(SCOPED, { ...INFO, runtimeConfigs: { runsc: { path: "/usr/bin/runsc", runtimeArgs: ["--oci-seccomp"], status: {} } } })).toBe("");
  });

  it.each([
    ["a changed runsc binary hash (e.g. re-recorded after an upgrade)", { runscBinary: { ...RUNSC, sha256: "00".repeat(32) } }, "runsc SHA-256 pin is not the reviewed binary"],
    ["a changed sidecar hash", { runscBinary: { ...RUNSC, sidecars: [{ ...RUNSC.sidecars[0], sha256: "00".repeat(32) }] } }, "sidecar pins are not the reviewed files"],
    ["an extra sidecar", { runscBinary: { ...RUNSC, sidecars: [...RUNSC.sidecars, { path: "/usr/bin/gvisor-bin/extra", sha256: "11".repeat(32) }] } }, "sidecar pins are not the reviewed files"],
    ["no sidecars", { runscBinary: { ...RUNSC, sidecars: [] } }, "sidecar pins are not the reviewed files"],
    ["another runsc path", { runscBinary: { ...RUNSC, path: "/usr/local/bin/runsc" } }, "runsc binary pin"],
    ["no runsc arguments", { runscBinary: { ...RUNSC, args: [] } }, "runsc arguments"],
    ["an extra runsc argument", { runscBinary: { ...RUNSC, args: ["--oci-seccomp", "--debug"] } }, "runsc arguments"],
    ["no runsc pin", { runscBinary: null }, "runsc binary pin"],
    ["another gVisor reference", { gvisorProcVersion: "Linux version 4.4.0 #2" }, "gVisor reference pin"],
    ["another Docker version", { dockerServerVersion: "29.9.4" }, "Docker server version pin"],
    ["another data root", { dockerDataRoot: "/srv/docker" }, "Docker data root pin"],
    ["another (rebuilt) image", { image: { ...SCOPED.image, id: `sha256:${"0".repeat(64)}` } }, "image ID pin"],
  ])("configuration with %s: outside the scope", (_l, over, message) => {
    expect(problems({ ...SCOPED, ...over } as SandboxSpec)).toContain(message);
  });

  it.each([
    ["an extra daemon runtime", { runtimes: [...INFO.runtimes, "kata"] }, "the daemon's runtimes"],
    ["a missing daemon runtime", { runtimes: ["runc", "runsc"] }, "the daemon's runtimes"],
    ["a rootless daemon", { rootless: true }, "not rootful Docker"],
    ["Podman", { engine: "podman" }, "not rootful Docker"],
    ["another reported version", { serverVersion: "29.9.4" }, "the daemon reports Docker"],
    ["another seccomp profile", { seccompProfile: "unconfined" }, "seccomp profile is not builtin"],
    ["runsc configured without --oci-seccomp", { runtimeConfigs: { runsc: { path: "/usr/bin/runsc" } } }, "runsc configuration"],
    ["runsc from another path", { runtimeConfigs: { runsc: { path: "/tmp/runsc", runtimeArgs: ["--oci-seccomp"] } } }, "runsc configuration"],
    ["an unknown runsc configuration key", { runtimeConfigs: { runsc: { path: "/usr/bin/runsc", runtimeArgs: ["--oci-seccomp"], options: {} } } }, "runsc configuration"],
  ])("daemon report with %s: outside the scope", (_l, over, message) => {
    expect(problems(SCOPED, { ...INFO, ...over })).toContain(message);
  });

  it("another runtime, no daemon report or no spec: outside the scope", () => {
    expect(problems(SCOPED, INFO, "runc")).toContain('runtime "runc" is not runsc');
    expect(problems(SCOPED, null)).toContain("no daemon report");
    expect(decisionScopeProblems(undefined as unknown as SandboxSpec, "runsc", INFO, FULL).length).toBeGreaterThan(0);
  });

  it("a recorded scope still never lifts M1/M3 for the test fixtures' configuration", () => {
    expect(decisionScopeProblems(SPEC, "runsc", DOCKER_INFO, FULL).length).toBeGreaterThan(5);
  });
});

describe("A4: the gate applies M1/M3 outside the scope", () => {
  it("the gate refuses a meets-spec result whose intended configuration is outside the scope (blockers named)", () => {
    const r = { rating: "meets-spec", allowsUntrustedInput: true, runtime: "runsc", violations: [], steps: [], cleanup: null, binding: null, engine: DOCKER_INFO } as any;
    let reasons: string[] = [];
    try { assertUntrustedInputAllowed(r, { spec: SPEC, run: RUN }); } catch (e) { reasons = [...(e as { reasons: readonly string[] }).reasons]; }
    expect(reasons).toEqual(expect.arrayContaining([...MEETS_SPEC_BLOCKERS]));
  });
});
