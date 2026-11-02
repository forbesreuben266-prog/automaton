/**
 * Static and runtime boundaries of the Phase 1A research pipeline (step 1:
 * the adapter only). The pipeline reaches the Phase 0 division solely
 * through src/research-pipeline/division.ts, which re-exports a reviewed list
 * from the division's public index and contains no logic. Nothing outside the
 * pipeline (tests excepted) imports it. Syntax-tree checks, not a sandbox.
 */

import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as adapter from "../../research-pipeline/division.js";
import * as division from "../../divisions/business-research/index.js";

const SRC = path.resolve(__dirname, "../..");
const PIPELINE = path.join(SRC, "research-pipeline");
const ADAPTER = path.join(PIPELINE, "division.ts");
const DIVISION_INDEX_SPECIFIER = "../divisions/business-research/index.js";

const RUNTIME_EXPORTS = [
  "CLAIM_TYPES", "CRITERIA", "CURRENCIES", "EVIDENCE_GRADES", "HARD_GATES", "HIGH_SCORE_MIN_SOURCES", "Issues", "MAX_CITATIONS_PER_CLAIM",
  "MAX_CLAIMS", "MAX_SNAPSHOTS", "MAX_SNAPSHOT_CHARS", "MAX_TOTAL_SNAPSHOT_CHARS", "MIN_FAILURE_REASONS", "MIN_QUOTE_CHARS", "ProposalQueue",
  "QUOTE_VERIFICATION_LEGEND", "ReportValidationError", "SCENARIO_NAMES", "SchemaError", "UNITS", "VERDICT_THRESHOLDS", "arr", "bool",
  "calculateScenarios", "checkKeys", "createSnapshot", "escapeInline", "formatMoney", "gradeEvidence", "gradeEvidenceSets", "id", "isPlainObject",
  "isoDate", "isoDateTime", "oneOf", "originGroups", "parseAssumptions", "parseExperimentProposal", "parseScenarioDefinitions", "parseScoring",
  "parseSourcesAndClaims", "renderReport", "renderUrl", "safeInt", "scoreOpportunity", "sha256Hex", "sourceIdentityConflicts", "str",
  "uniqueIds", "validateReport", "verifyClaims",
].sort();
const TYPE_EXPORTS = [
  "Assumption", "Citation", "Claim", "ClaimType", "ClaimVerification", "Competitor", "Confidence", "CriterionResult", "Currency",
  "EvidenceAssessment", "EvidenceGrade", "ExperimentProposal", "GateStatus", "HardGateResult", "ProposalStatus", "ReportSections",
  "ReportValidation", "ResearchReport", "ScenarioDefinition", "ScenarioName", "ScenarioResult", "ScoreResult", "SourceSnapshot",
  "StoredProposal", "Verdict",
].sort();
/** Model and budget names the pipeline must never be able to reach through the adapter. */
const EXCLUDED = ["RunBudgetController", "DISABLED_MODEL_PORT", "InferenceDisabledError", "ResearchModelPort", "MAX_RUN_BUDGET_CENTS"];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);

/** Every module specifier: static import/export, dynamic import() and require() (any argument), import.meta. */
function specifiers(file: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(n)) out.push("<import-equals>");
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) out.push("<dynamic>");
    if (ts.isMetaProperty(n)) out.push("<import.meta>");
    ts.forEachChild(n, visit);
  };
  visit(parse(file));
  return out;
}

describe("research pipeline boundaries (step 1: adapter only)", () => {
  it("contains exactly the reviewed modules", () => {
    expect(fs.readdirSync(PIPELINE).sort()).toEqual(["division.ts"]);
  });

  it("the adapter imports nothing but the division's public index; no dynamic import, require or import.meta", () => {
    expect(specifiers(ADAPTER)).toEqual([DIVISION_INDEX_SPECIFIER, DIVISION_INDEX_SPECIFIER]);
  });

  it("the adapter contains no logic: only named re-exports from the public index (no export *, default, imports or statements)", () => {
    const source = parse(ADAPTER);
    expect(source.statements.length).toBe(2);
    for (const stmt of source.statements) {
      expect(ts.isExportDeclaration(stmt), ts.SyntaxKind[stmt.kind]).toBe(true);
      const decl = stmt as ts.ExportDeclaration;
      expect(decl.moduleSpecifier && ts.isStringLiteral(decl.moduleSpecifier) && decl.moduleSpecifier.text).toBe(DIVISION_INDEX_SPECIFIER);
      expect(decl.exportClause && ts.isNamedExports(decl.exportClause)).toBe(true);
      for (const el of (decl.exportClause as ts.NamedExports).elements) expect(el.propertyName, `${el.name.text} must not be renamed`).toBeUndefined();
    }
  });

  it("re-exports exactly the reviewed runtime and type names, and none of the model or budget names", () => {
    const source = parse(ADAPTER);
    const [values, types] = source.statements as unknown as ts.ExportDeclaration[];
    const names = (d: ts.ExportDeclaration) => (d.exportClause as ts.NamedExports).elements.map((e) => e.name.text).sort();
    expect(values.isTypeOnly).toBe(false);
    expect(types.isTypeOnly).toBe(true);
    expect(names(values)).toEqual(RUNTIME_EXPORTS);
    expect(names(types)).toEqual(TYPE_EXPORTS);
    for (const name of EXCLUDED) {
      expect(names(values).concat(names(types)), name).not.toContain(name);
      expect(name in adapter, name).toBe(false);
    }
  });

  it("at runtime the adapter exposes exactly the reviewed names, each identical to the division's own export (pass-through)", () => {
    expect(Object.keys(adapter).sort()).toEqual(RUNTIME_EXPORTS);
    for (const name of RUNTIME_EXPORTS) expect((adapter as Record<string, unknown>)[name], name).toBe((division as Record<string, unknown>)[name]);
  });

  it("nothing outside the pipeline imports or names it (tests excepted)", () => {
    const outside = walk(SRC).filter((f) => f.endsWith(".ts") && !f.startsWith(PIPELINE + path.sep) && !f.includes(`${path.sep}__tests__${path.sep}`));
    expect(outside.length).toBeGreaterThan(50);
    for (const file of outside) {
      const rel = path.relative(SRC, file);
      expect(fs.readFileSync(file, "utf8").includes("research-pipeline"), `${rel} mentions the pipeline`).toBe(false);
      for (const spec of specifiers(file)) {
        if (!spec.startsWith(".")) continue;
        expect(path.resolve(path.dirname(file), spec).startsWith(PIPELINE), `${rel} imports ${spec}`).toBe(false);
      }
    }
  });

  it("the adapter is the only file outside the division (tests excepted) that names it", () => {
    const division_ = path.join(SRC, "divisions", "business-research");
    const naming = walk(SRC).filter((f) => f.endsWith(".ts") && !f.startsWith(division_ + path.sep) && !f.includes(`${path.sep}__tests__${path.sep}`))
      .filter((f) => fs.readFileSync(f, "utf8").includes("business-research"));
    expect(naming).toEqual([ADAPTER]);
  });
});
