/**
 * Static and runtime boundaries of the Phase 1A research pipeline (step 1:
 * the adapter only). The pipeline reaches the Phase 0 division solely
 * through src/research-pipeline/division.ts, which re-exports a reviewed list
 * from the division's public index and contains no logic. Nothing outside the
 * pipeline (tests excepted) imports it. Syntax-tree checks, not a sandbox.
 */

import childProcess from "child_process";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import path from "path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as adapter from "../../research-pipeline/division.js";
import * as division from "../../divisions/business-research/index.js";
import { parseManifestText } from "../../research-pipeline/manifest.js";
import { checkRunInputs, parseOpportunityText, parseWorkbookText } from "../../research-pipeline/workbook.js";
import { validManifest, validOpportunity, validWorkbook } from "./fixtures.js";

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
    expect(fs.readdirSync(PIPELINE).sort()).toEqual(["assemble.ts", "cli-main.ts", "cli.ts", "division.ts", "history.ts", "ledger.ts", "local-files.ts", "manifest.ts", "workbook.ts"]);
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

/** Step 2 parsers: sibling imports only (the division solely via the adapter), no capability names. */
const PARSER_IMPORTS: Record<string, readonly string[]> = {
  "manifest.ts": ["./division.js"],
  "workbook.ts": ["./division.js", "./manifest.js"],
  // Step 3: the only module with filesystem access (read-only calls; see the fs allowlist below).
  "local-files.ts": ["node:crypto", "node:fs", "./division.js", "./manifest.js", "./workbook.js"],
  // Step 4: in-memory assembly and ledger (no node: modules; Phase 0 only through the adapter).
  "ledger.ts": ["./division.js", "./workbook.js"],
  "assemble.ts": ["./division.js", "./ledger.js", "./manifest.js", "./workbook.js"],
  // Step 5: in-memory comparison of two runs, each assembled (and so validated) through assemble.ts.
  "history.ts": ["./assemble.js", "./division.js", "./ledger.js"],
  // Step 6: the CLI logic (no process or filesystem access of its own; files only through the step 3 loader).
  "cli.ts": ["./assemble.js", "./history.js", "./local-files.js"],
};
/** Names that would reach files, network, processes, environment, time, randomness, dynamic code or global scope. */
const FORBIDDEN_IDENTIFIERS = new Set([
  "process", "require", "globalThis", "global", "fetch", "eval", "Function", "Reflect", "Proxy", "XMLHttpRequest", "WebSocket", "Worker",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Date", "performance", "Buffer", "Deno", "Bun", "crypto",
]);

describe("research pipeline boundaries (step 2: parsers)", () => {
  for (const [file, allowed] of Object.entries(PARSER_IMPORTS)) {
    it(`${file} imports only ${allowed.join(" and ")}; no dynamic import, require or import.meta`, () => {
      const specs = specifiers(path.join(PIPELINE, file));
      expect(specs.length).toBeGreaterThan(0);
      for (const spec of specs) expect(allowed, `${file} imports ${spec}`).toContain(spec);
    });

    it(`${file} references no file, network, process, environment, clock, randomness or dynamic-code name`, () => {
      const found: string[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && FORBIDDEN_IDENTIFIERS.has(n.text)) {
          const parent = n.parent;
          const isMemberName = parent && ts.isPropertyAccessExpression(parent) && parent.name === n;
          if (!isMemberName) found.push(n.text);
        }
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Math" && n.name.text === "random") found.push("Math.random");
        // Import specifiers are governed by the per-file import allowlist above; every other string is checked here.
        const isImportSpecifier = n.parent !== undefined && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)) && n.parent.moduleSpecifier === n;
        if (!isImportSpecifier && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /^(node:)?(fs|net|http|https|child_process|dgram|dns|tls|worker_threads|os|process|vm|module|inspector)$/.test(n.text)) found.push(n.text);
        // Constant strings naming a capability (catches bracket access such as globalThis["process"] or obj["eval"]).
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && (FORBIDDEN_IDENTIFIERS.has(n.text) || n.text === "constructor" || n.text === "__proto__")) found.push(`"${n.text}"`);
        // Reaching constructors or prototypes through objects (e.g. ({}).constructor.constructor("code")).
        if (ts.isPropertyAccessExpression(n) && (n.name.text === "constructor" || n.name.text === "__proto__")) found.push(`.${n.name.text}`);
        if (ts.isIdentifier(n) && n.text === "__proto__") found.push("__proto__");
        ts.forEachChild(n, visit);
      };
      visit(parse(path.join(PIPELINE, file)));
      expect(found).toEqual([]);
    });
  }

  afterEach(() => vi.restoreAllMocks());

  it("at runtime the parsers make no file, network, process or environment calls", () => {
    const calls: string[] = [];
    const spy = (obj: any, name: string, label: string) => {
      if (typeof obj[name] === "function") vi.spyOn(obj, name).mockImplementation(((...a: unknown[]) => { calls.push(label); throw new Error(`${label} called`); }) as any);
    };
    for (const name of ["readFileSync", "writeFileSync", "openSync", "readdirSync", "statSync", "lstatSync", "existsSync", "readFile", "writeFile", "open"]) spy(fs, name, `fs.${name}`);
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) spy(childProcess, name, `child_process.${name}`);
    spy(net, "connect", "net.connect"); spy(net, "createConnection", "net.createConnection");
    spy(http, "request", "http.request"); spy(https, "request", "https.request");
    spy(globalThis, "fetch", "fetch");
    const envBefore = { ...process.env };
    const envProxy = new Proxy(process.env, { get: (t, k) => { if (typeof k === "string") calls.push(`env.${k}`); return Reflect.get(t, k); } });
    const realEnv = process.env;
    process.env = envProxy as NodeJS.ProcessEnv;
    try {
      const o = parseOpportunityText(JSON.stringify(validOpportunity()));
      const m = parseManifestText(JSON.stringify(validManifest()));
      const w = parseWorkbookText(JSON.stringify(validWorkbook()));
      checkRunInputs(o, m, w);
    } finally {
      process.env = realEnv;
    }
    expect(calls).toEqual([]);
    expect(process.env).toEqual(envBefore);
  });
});

/** Step 3: local-files.ts may use only these read-only filesystem calls. */
const READ_ONLY_FS = new Set(["lstatSync", "fstatSync", "openSync", "readSync", "closeSync", "readdirSync", "constants"]);
const OPEN_FLAGS = new Set(["O_RDONLY", "O_NOFOLLOW", "O_NONBLOCK"]);

describe("research pipeline boundaries (step 3: local files)", () => {
  const source = parse(path.join(PIPELINE, "local-files.ts"));

  it("uses only read-only filesystem calls (no write, rename, delete, link, permission or directory creation)", () => {
    const used = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fs") used.add(n.name.text);
      if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fs") used.add("<computed>");
      ts.forEachChild(n, visit);
    };
    visit(source);
    expect([...used].filter((name) => !READ_ONLY_FS.has(name))).toEqual([]);
    expect(used.has("openSync")).toBe(true);
  });

  it("opens files read-only with no-follow and non-blocking flags only", () => {
    const flags = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "constants") flags.add(n.name.text);
      ts.forEachChild(n, visit);
    };
    visit(source);
    expect([...flags].sort()).toEqual([...OPEN_FLAGS].sort());
  });

  it("is imported by nothing in the pipeline but the CLI (no other module gains filesystem access through it)", () => {
    for (const file of fs.readdirSync(PIPELINE).filter((f) => f !== "local-files.ts" && f !== "cli.ts")) {
      expect(specifiers(path.join(PIPELINE, file)), file).not.toContain("./local-files.js");
    }
  });

  it("the parsers and the adapter still import no filesystem, network or process module", () => {
    for (const file of ["assemble.ts", "cli.ts", "division.ts", "history.ts", "ledger.ts", "manifest.ts", "workbook.ts"]) {
      for (const spec of specifiers(path.join(PIPELINE, file))) expect(spec.startsWith("node:"), `${file} imports ${spec}`).toBe(false);
    }
  });
});

/** Step 4: assembly and ledger stay in memory, render only final reports and never touch the proposal queue. */
describe("research pipeline boundaries (step 4: assembly and ledger)", () => {
  const STEP4 = ["assemble.ts", "ledger.ts"];
  const identifiers = (file: string) => {
    const names = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) names.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(parse(path.join(PIPELINE, file)));
    return names;
  };
  const strings = (file: string) => {
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) found.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(parse(path.join(PIPELINE, file)));
    return found;
  };

  for (const file of STEP4) {
    it(`${file} uses no proposal queue, budget, model or filesystem name`, () => {
      const names = identifiers(file);
      for (const name of ["ProposalQueue", "fs", "RunBudgetController", "DISABLED_MODEL_PORT", "loadRun"]) expect(names.has(name), `${file} uses ${name}`).toBe(false);
    });
  }

  it("assemble.ts renders only final reports (no draft mode) and only through Phase 0's renderer", () => {
    expect(strings("assemble.ts")).not.toContain("draft");
    expect(identifiers("assemble.ts").has("renderReport")).toBe(true);
    expect(identifiers("assemble.ts").has("validateReport")).toBe(true);
  });

  it("ledger.ts validates with Phase 0 before building anything", () => {
    expect(identifiers("ledger.ts").has("validateReport")).toBe(true);
  });
});

/** Step 5: the comparison assembles its own inputs, stays in memory and never touches proposals, files or rendering of Phase 0 drafts. */
describe("research pipeline boundaries (step 5: history)", () => {
  const source = parse(path.join(PIPELINE, "history.ts"));
  const names = new Set<string>();
  const literals: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) names.add(n.text);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) literals.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(source);

  it("uses no proposal queue, budget, model, filesystem or loader name, and no Phase 0 renderer", () => {
    for (const name of ["ProposalQueue", "fs", "RunBudgetController", "DISABLED_MODEL_PORT", "loadRun", "renderReport", "validateReport"]) {
      expect(names.has(name), `history.ts uses ${name}`).toBe(false);
    }
  });

  it("obtains assembled runs only by calling assembleRun itself", () => {
    expect(names.has("assembleRun")).toBe(true);
    expect(literals).not.toContain("draft");
  });

  it("is imported by no other pipeline module but the CLI", () => {
    for (const file of fs.readdirSync(PIPELINE).filter((f) => f !== "history.ts" && f !== "cli.ts")) {
      expect(specifiers(path.join(PIPELINE, file)), file).not.toContain("./history.js");
    }
  });
});

/** Step 6: the CLI. cli.ts holds the logic (no process, filesystem or environment access); cli-main.ts only wires process I/O. */
describe("research pipeline boundaries (step 6: CLI)", () => {
  const MAIN = path.join(PIPELINE, "cli-main.ts");

  it("cli-main.ts imports only ./cli.js and uses only process.argv, process.stdout, process.stderr and process.exitCode", () => {
    expect(specifiers(MAIN)).toEqual(["./cli.js"]);
    const used = new Set<string>();
    const others: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "process") used.add(n.name.text);
      else if (ts.isIdentifier(n) && n.text === "process" && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)) others.push("bare process");
      if (ts.isIdentifier(n) && FORBIDDEN_IDENTIFIERS.has(n.text) && n.text !== "process") others.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(parse(MAIN));
    expect([...used].sort()).toEqual(["argv", "exitCode", "stderr", "stdout"]);
    expect(others).toEqual([]);
  });

  it("cli.ts uses no filesystem, Docker, sandbox, model, proposal or scheduling name", () => {
    const names = new Set<string>();
    const literals: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) names.add(n.text);
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) literals.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(parse(path.join(PIPELINE, "cli.ts")));
    for (const name of ["fs", "ProposalQueue", "RunBudgetController", "DISABLED_MODEL_PORT", "renderReport", "writeFileSync"]) expect(names.has(name), name).toBe(false);
    expect(literals.some((l) => /docker|sandbox|runsc|\.sock|cron|schedule/i.test(l))).toBe(false);
  });

  it("only the CLI imports the history module and the loader together, and nothing imports the CLI but its entry point", () => {
    for (const file of fs.readdirSync(PIPELINE).filter((f) => f !== "cli-main.ts")) {
      expect(specifiers(path.join(PIPELINE, file)), file).not.toContain("./cli.js");
    }
  });
});
