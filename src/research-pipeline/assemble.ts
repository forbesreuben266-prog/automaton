/**
 * Offline report assembly (Phase 1A step 4). Pure and deterministic: no
 * filesystem, network, process, environment, clock, randomness, model or
 * Docker access. The report, the ledger and the Markdown are built in memory
 * and returned; nothing is written, approved, proposed or sent.
 *
 * Input: one run in the shape the step 3 loader returns (RunData). This is
 * the only accepted representation, for loaded runs and test fixtures alike,
 * and it is never trusted as already validated: assembleRun re-validates
 * every part before use.
 * - opportunity, manifest and workbook are parsed again with the step 2
 *   parsers (parseOpportunity, parseManifest, parseWorkbook) and checked
 *   together with checkRunInputs;
 * - sources must be exactly the manifest's sources, in manifest order (same
 *   id, file and SHA-256), and each text must have that SHA-256 (UTF-8) and
 *   byte count and contain no control character other than tab, line feed
 *   and carriage return, and no unpaired surrogate.
 * Like the step 2 parsers, this is not a sandbox for hostile JavaScript
 * objects (Proxy traps run during inspection); callers are trusted code.
 *
 * Assembly: each manifest entry and its text become a Phase 0 snapshot
 * (createSnapshot); the report is the opportunity's title and brief, the
 * workbook's id, date, claims, sections, assumptions, scenarios, scoring
 * and experiments, and those snapshots. Nothing is added, defaulted or
 * invented. Phase 0's validateReport is the final authority: unless it
 * passes, assembly refuses (fail closed) and no report is produced. The
 * Markdown is: the evidence-aware research assessment (renderResearchAssessment;
 * also in the ledger as structured data), then Phase 0's own final
 * rendering, unchanged, then the pipeline appendices (renderEvidenceLedger).
 * All scores, grades, verdicts and figures are Phase 0's; the assessment
 * explains, when Phase 0's scoring says "Reject", whether a hard gate
 * actually failed with confirmed evidence.
 *
 * The workbook's evidence judgments (operator-recorded negative findings and
 * contradictions) are not part of the Phase 0 report; they are passed to
 * the ledger, which re-validates them and decides whether each negative
 * finding applies.
 *
 * Experiments in the report are proposals for the operator to consider;
 * assembly does not queue, approve or carry out anything.
 */

import {
  Issues, MAX_SNAPSHOTS, SchemaError, checkKeys, createSnapshot, renderReport, sha256Hex, validateReport,
  type ResearchReport, type ScenarioResult, type ScoreResult, type SourceSnapshot,
} from "./division.js";
import { buildEvidenceLedger, LedgerError, renderEvidenceLedger, renderResearchAssessment, type EvidenceLedger } from "./ledger.js";
import { parseManifest, type SourceManifest } from "./manifest.js";
import { checkRunInputs, parseOpportunity, parseWorkbook, type OpportunityMetadata, type ResearchWorkbook } from "./workbook.js";

/** One source text as the step 3 loader returns it. */
export interface RunSourceText {
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly content: string;
}

/** One run, in the shape the step 3 loader returns. Always re-validated by assembleRun. */
export interface RunData {
  readonly opportunity: OpportunityMetadata;
  readonly manifest: SourceManifest;
  readonly workbook: ResearchWorkbook;
  readonly sources: readonly RunSourceText[];
}

export interface AssembledReport {
  /** The report as Phase 0 parsed and validated it. */
  readonly report: ResearchReport;
  readonly score: ScoreResult;
  readonly scenarioResults: readonly ScenarioResult[];
  readonly warnings: readonly string[];
  readonly ledger: EvidenceLedger;
  /** The research assessment, then Phase 0's final rendering (unchanged), then the pipeline appendices. */
  readonly markdown: string;
}

/** Refusal with reasons (never echoes source text). */
export class AssemblyError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Report assembly refused:\n- ${reasons.join("\n- ")}`);
    this.name = "AssemblyError";
  }
}

const SOURCE_KEYS = ["id", "file", "sha256", "bytes", "content"];

/** Runs a step 2 or Phase 0 check, turning its SchemaError into an AssemblyError. */
function step<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SchemaError) throw new AssemblyError([`${label}: invalid`, ...err.issues]);
    if (err instanceof LedgerError) throw new AssemblyError(err.reasons);
    throw err;
  }
}

/** Same text rule as the step 3 loader, plus no unpaired surrogates (a decoded UTF-8 text never has one). */
function textProblem(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      return `contains a control character (U+${code.toString(16).toUpperCase().padStart(4, "0")}) at offset ${i}`;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return `contains an unpaired surrogate at offset ${i}`;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return `contains an unpaired surrogate at offset ${i}`;
    }
  }
  return null;
}

/** Checks the source texts against the (re-parsed) manifest; returns the texts in manifest order. */
function checkSources(raw: unknown, manifest: SourceManifest): string[] {
  const issues = new Issues();
  const expected = manifest.sources;
  if (!Array.isArray(raw)) throw new AssemblyError(["run.sources: must be an array"]);
  if (raw.length !== expected.length || raw.length > MAX_SNAPSHOTS || Object.keys(raw).length !== raw.length) {
    throw new AssemblyError([`run.sources: must hold exactly the manifest's ${expected.length} source(s), in order, as a plain array`]);
  }
  const texts: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    const p = `run.sources[${i}]`;
    if (!Object.hasOwn(raw, i) || !checkKeys(issues, p, raw[i], SOURCE_KEYS)) {
      issues.add(p, "must be a source text object");
      continue;
    }
    const s = raw[i] as Record<string, unknown>;
    const [sourceId, file, sha256, bytes, content] = [s.id, s.file, s.sha256, s.bytes, s.content]; // each read once
    const m = expected[i];
    if (sourceId !== m.id) issues.add(`${p}.id`, `must be the manifest's source "${m.id}" (same order)`);
    if (file !== m.file) issues.add(`${p}.file`, `must be the manifest's file for "${m.id}"`);
    if (sha256 !== m.sha256) issues.add(`${p}.sha256`, `must be the manifest's SHA-256 for "${m.id}"`);
    if (typeof content !== "string") {
      issues.add(`${p}.content`, "must be a string");
      continue;
    }
    const problem = textProblem(content);
    if (problem) {
      issues.add(`${p}.content`, problem);
      continue;
    }
    if (bytes !== new TextEncoder().encode(content).length) issues.add(`${p}.bytes`, "must equal the text's UTF-8 byte count");
    if (sha256Hex(content) !== m.sha256) issues.add(`${p}.content`, `SHA-256 does not match the manifest entry for "${m.id}"`);
    texts.push(content);
  }
  if (issues.list.length > 0) throw new AssemblyError(["run.sources: invalid", ...issues.list]);
  return texts;
}

/**
 * Assembles, validates and renders one run. Refuses (AssemblyError) on any
 * invalid input and whenever Phase 0's validateReport does not pass.
 */
export function assembleRun(run: unknown): AssembledReport {
  const issues = new Issues();
  if (!checkKeys(issues, "run", run, ["opportunity", "manifest", "workbook", "sources"])) throw new AssemblyError(issues.list);
  if (issues.list.length > 0) throw new AssemblyError(issues.list);
  const r = run as Record<string, unknown>;
  const [rawOpportunity, rawManifest, rawWorkbook, rawSources] = [r.opportunity, r.manifest, r.workbook, r.sources]; // each read once

  const opportunity = step("opportunity", () => parseOpportunity(rawOpportunity));
  const manifest = step("manifest", () => parseManifest(rawManifest));
  const workbook = step("workbook", () => parseWorkbook(rawWorkbook));
  step("run", () => checkRunInputs(opportunity, manifest, workbook));
  const texts = checkSources(rawSources, manifest);

  const snapshots: SourceSnapshot[] = manifest.sources.map((m, i) => step(`source ${m.id}`, () => createSnapshot({
    id: m.id, url: m.url, publisher: m.publisher, title: m.title, publishedAt: m.publishedAt, retrievedAt: m.retrievedAt, originId: m.originId,
    derivedFromSnapshotIds: [...m.derivedFromSnapshotIds], independenceVerified: m.independenceVerified, independenceNote: m.independenceNote,
    content: texts[i],
  })));
  const report = {
    id: workbook.reportId,
    title: opportunity.title,
    brief: opportunity.brief,
    asOf: workbook.asOf,
    snapshots,
    claims: workbook.claims,
    sections: workbook.sections,
    assumptions: workbook.assumptions,
    scenarios: workbook.scenarios,
    scoring: workbook.scoring,
    experiments: workbook.experiments,
  };

  // Phase 0 is the final authority: refuse unless the assembled report passes validation.
  const v = validateReport(report);
  if (!v.ok) throw new AssemblyError(["the assembled report did not pass Phase 0 validation", ...v.errors]);
  const phase0Markdown = renderReport(report, { mode: "final" });
  const ledger = step("ledger", () => buildEvidenceLedger(report, { negativeFindings: workbook.negativeFindings, contradictions: workbook.contradictions }));

  return Object.freeze({
    report: v.report,
    score: v.score,
    scenarioResults: v.scenarioResults!,
    warnings: Object.freeze([...v.warnings]),
    ledger,
    markdown: `${renderResearchAssessment(ledger)}${phase0Markdown}\n${renderEvidenceLedger(ledger)}`,
  });
}
