/**
 * Architectural boundaries of the business research division.
 *
 * Static checks parse every division file with the TypeScript compiler (an
 * existing dev dependency) and inspect the syntax tree, so comments and
 * strings can't hide or fake an import, and indirect routes (bracket access,
 * string concatenation, `.constructor`, `globalThis`, `Reflect`) are refused.
 * Runtime checks run the whole division with network, process, filesystem,
 * timer and environment APIs replaced by spies.
 *
 * What these tests can't guarantee is documented in the division README:
 * static analysis can't prove the absence of every possible indirection
 * (e.g. reaching a capability through an object passed in by a caller), and
 * runtime spies only see the code paths the fixtures exercise.
 */

import fs from "fs";
import os from "os";
import path from "path";
import childProcess from "child_process";
import dgram from "dgram";
import dns from "dns";
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as division from "../../divisions/business-research/index.js";
import { EXPERIMENTS, validReport } from "./fixtures.js";

const SRC = path.resolve(__dirname, "../..");
const DIVISION = path.join(SRC, "divisions", "business-research");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
const divisionFiles = walk(DIVISION).filter((f) => f.endsWith(".ts"));
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);

/**
 * Names that give access to the network, processes, files, output, dynamic
 * code, global scope, reflection, cross-thread messaging, deferred callbacks,
 * randomness or time. Flagged as identifiers, property names and constant
 * strings. This targets ACCIDENTAL capability use; it is not a sandbox.
 */
const BANNED_NAMES = new Set([
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "navigator", "Request", "Response", "importScripts", "postMessage",
  "require", "module", "exports", "__dirname", "__filename", "process", "Buffer", "Deno", "Bun",
  "globalThis", "global", "window", "self", "Reflect", "Proxy", "Function", "eval", "constructor", "prototype", "__proto__",
  "WebAssembly", "Worker", "SharedArrayBuffer", "Atomics",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "performance",
  "console", "BroadcastChannel", "MessageChannel", "MessagePort", "FinalizationRegistry", "WeakRef", "crypto",
  "fromCharCode", "fromCodePoint", "prepareStackTrace", "captureStackTrace", "stackTraceLimit",
  "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getOwnPropertyNames", "getOwnPropertySymbols",
  "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);
/**
 * The ONLY reflection allowed anywhere in the division: the input validator
 * needs these exact calls to refuse getters without reading them. Each must
 * appear inside the named validation.ts function, exactly once, on that
 * function's never-reassigned `value` parameter (or a fresh `{}`). Any other
 * use of these names, in any file or form, is flagged.
 */
const REFLECTION_CALL_SITES: ReadonlyArray<{ file: string; fn: string; call: string }> = [
  { file: "validation.ts", fn: "isPlainObject", call: "Object.getPrototypeOf(value)" },
  { file: "validation.ts", fn: "isPlainObject", call: "Object.getPrototypeOf({})" },
  { file: "validation.ts", fn: "checkKeys", call: "Object.getOwnPropertyDescriptors(value)" },
  { file: "validation.ts", fn: "arr", call: "Object.getOwnPropertyDescriptors(value)" },
];
const REFLECTION_NAMES = new Set(["getOwnPropertyDescriptors", "getPrototypeOf"]);

/** True if `fn` assigns to (or increments/decrements) the identifier `name` anywhere in its body. */
function reassigns(fn: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
        ts.isIdentifier(node.left) && node.left.text === name) found = true;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        ts.isIdentifier(node.operand) && node.operand.text === name) found = true;
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}
const ALLOWED_EXTERNAL_IMPORTS = new Set(["node:crypto"]);
const ALLOWED_CRYPTO_IMPORTS = new Set(["createHash"]);
/** Shared built-ins whose properties must never be assigned, deleted or merged into. */
const BUILTINS = new Set([
  "Object", "Array", "JSON", "Math", "String", "Number", "Boolean", "BigInt", "Symbol", "Error", "TypeError",
  "Date", "Promise", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "URL", "Intl", "ArrayBuffer",
]);
const ALLOWED_MATH = new Set(["floor", "ceil", "max", "min", "abs", "round", "trunc", "sign"]);
const ALLOWED_DATE = new Set(["parse", "UTC"]);
const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

interface Finding { file: string; line: number; problem: string }

/** Evaluates a constant string expression ("a" + "b", `ab`), or returns null. */
function constantString(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = constantString(node.left);
    const r = constantString(node.right);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

/** The leftmost identifier of a.b.c / a["b"] / (a).b chains, if any. */
function rootIdentifier(node: ts.Node): string | null {
  let current = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else {
      return null;
    }
  }
}

/** Bracket keys allowed: identifiers, property chains, numbers, and non-string arithmetic on those. */
function isPlainKey(node: ts.Expression): boolean {
  if (ts.isIdentifier(node) || ts.isNumericLiteral(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return rootIdentifier(node) !== null;
  if (ts.isParenthesizedExpression(node)) return isPlainKey(node.expression);
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken].includes(node.operatorToken.kind)) {
    return isPlainKey(node.left) && isPlainKey(node.right);
  }
  return false;
}

function scanDivisionFile(file: string): { findings: Finding[]; imports: string[] } {
  const source = parse(file);
  const findings: Finding[] = [];
  const imports: string[] = [];
  const usedSites = new Set<string>();
  /** Whether this reflection identifier is one of the reviewed call sites (each usable once). */
  const reflectionAllowed = (node: ts.Identifier): boolean => {
    const access = node.parent;
    if (!access || !ts.isPropertyAccessExpression(access) || access.name !== node) return false;
    if (!ts.isIdentifier(access.expression) || access.expression.text !== "Object") return false;
    const call = access.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== access) return false;
    let fn: ts.Node | undefined = call.parent;
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
    if (!fn || !ts.isFunctionDeclaration(fn) || !fn.name) return false;
    const callText = call.getText(source).replace(/\s+/g, "");
    const site = REFLECTION_CALL_SITES.find((x) =>
      x.file === path.basename(file) && x.fn === fn!.name!.text && x.call.replace(/\s+/g, "") === callText);
    if (!site) return false;
    if (site.call.includes("(value)")) {
      const hasParam = fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === "value");
      if (!hasParam || reassigns(fn, "value")) return false;
    }
    const key = `${site.fn}|${site.call}`;
    if (usedSites.has(key)) return false; // each reviewed site may be used once
    usedSites.add(key);
    return true;
  };
  const report = (node: ts.Node, problem: string) =>
    findings.push({ file: path.basename(file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, problem });

  const visit = (node: ts.Node): void => {
    // Imports: sibling modules, and only createHash from node:crypto.
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const spec = (node.moduleSpecifier as ts.StringLiteral).text;
      imports.push(spec);
      const sibling = /^\.\/[a-z-]+\.js$/.test(spec) && fs.existsSync(path.join(DIVISION, spec.replace(/\.js$/, ".ts")));
      if (!sibling && !ALLOWED_EXTERNAL_IMPORTS.has(spec)) report(node, `imports "${spec}"`);
      if (spec === "node:crypto" && ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
        if (!clause || clause.name || !named || named.some((el) => !ALLOWED_CRYPTO_IMPORTS.has((el.propertyName ?? el.name).text))) {
          report(node, "imports something other than { createHash } from node:crypto");
        }
      }
    }
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier) {
      // local re-exports are fine
    }
    if (ts.isImportEqualsDeclaration(node)) report(node, "uses import = require()");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) report(node, "uses dynamic import()");
    if (ts.isMetaProperty(node)) report(node, "uses import.meta / new.target");
    if (node.kind === ts.SyntaxKind.WithStatement) report(node, "uses a with statement");

    // Banned names as identifiers / property names.
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && BANNED_NAMES.has(node.text)) {
      const reviewed = ts.isIdentifier(node) && REFLECTION_NAMES.has(node.text) && reflectionAllowed(node);
      if (!reviewed) {
        report(node, `references "${node.text}"${REFLECTION_NAMES.has(node.text) ? " outside the reviewed validation.ts call sites" : ""}`);
      }
    }
    // Banned names as constant strings (literal or concatenated); import specifiers excepted.
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isBinaryExpression(node)) &&
        !(node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))) {
      const value = constantString(node);
      if (value !== null && BANNED_NAMES.has(value)) report(node, `contains the string "${value}"`);
    }
    // Bracket access: only plain keys (no constant strings, templates, calls or string building).
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      const constant = constantString(key);
      if (constant !== null) report(node, `uses bracket access with a constant name ("${constant}")`);
      else if (!isPlainKey(key)) report(node, "uses bracket access with a computed key (template, call or string building)");
    }
    // Writes to shared built-ins: assignment, delete, Object.assign(target, …).
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      const root = rootIdentifier(node.left);
      if (root && BUILTINS.has(root)) report(node, `modifies the shared built-in ${root}`);
    }
    if (ts.isDeleteExpression(node)) {
      const root = rootIdentifier(node.expression);
      if (root && BUILTINS.has(root)) report(node, `deletes from the shared built-in ${root}`);
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === "Object.assign" && node.arguments[0]) {
      const root = rootIdentifier(node.arguments[0]);
      if (root && BUILTINS.has(root)) report(node, `merges into the shared built-in ${root}`);
    }
    // Determinism: Date and Math only through reviewed members; never aliased.
    if (ts.isIdentifier(node) && (node.text === "Date" || node.text === "Math")) {
      const parent = node.parent;
      const member = parent && ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent.name.text : null;
      const isNewDateWithInput = node.text === "Date" && parent && ts.isNewExpression(parent) && parent.expression === node &&
        (parent.arguments?.length ?? 0) > 0;
      const allowed = node.text === "Math" ? member !== null && ALLOWED_MATH.has(member)
        : (member !== null && ALLOWED_DATE.has(member)) || isNewDateWithInput;
      const isTypePosition = parent && (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent));
      if (!allowed && !isTypePosition) {
        report(node, `uses ${node.text}${member ? `.${member}` : ""} outside the reviewed members (non-deterministic or aliased)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { findings, imports };
}

/** Every module specifier (static, export-from, dynamic with a literal, require) in a file. */
function allSpecifiers(file: string): string[] {
  const source = parse(file);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0]) {
      const value = constantString(node.arguments[0]);
      if (value !== null) specs.push(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

describe("division boundaries (static, syntax tree)", () => {
  it("division contains exactly the reviewed modules", () => {
    expect(divisionFiles.map((f) => path.basename(f)).sort()).toEqual([
      "citations.ts", "finance.ts", "index.ts", "proposals.ts", "report.ts", "run-budget.ts",
      "scoring.ts", "sources.ts", "untrusted.ts", "validation.ts",
    ]);
  });

  it("imports only sibling modules and node:crypto; no require, dynamic import or import.meta", () => {
    const all = divisionFiles.flatMap((f) => scanDivisionFile(f).findings).filter((x) => /import|require/.test(x.problem));
    expect(all).toEqual([]);
    // The scanner must actually see imports (guards against a check that matches nothing).
    expect(scanDivisionFile(path.join(DIVISION, "index.ts")).imports).toHaveLength(9);
    expect(scanDivisionFile(path.join(DIVISION, "sources.ts")).imports).toContain("node:crypto");
  });

  it("references no network, process, filesystem, global-scope, dynamic-code, timer or clock API, directly or indirectly", () => {
    expect(divisionFiles.flatMap((f) => scanDivisionFile(f).findings)).toEqual([]);
  });

  it("the scanner detects direct and indirect access (self-test on synthetic code)", () => {
    // Written outside the repo; the scanner judges sibling imports against DIVISION, not the file's folder.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "br-scanner-"));
    const tmp = path.join(tmpDir, "selftest.ts");
    const samples: Array<[string, RegExp]> = [
      ['export const a = () => fetch("https://example.org");', /references "fetch"/],
      ['export const a = (globalThis as any)["fet" + "ch"];', /globalThis/],
      ['export const a = ({} as any)["constructor"];', /bracket access/],
      ['export const a = (x: any) => x.constructor.constructor("return 1")();', /references "constructor"/],
      ['export const a = (x: any) => x["con" + "structor"];', /bracket access/],
      ['export const a = Reflect.get;', /Reflect/],
      ['export const a = new Proxy({}, {});', /Proxy/],
      ['export const a = () => import("node:fs");', /dynamic import/],
      ['import fs from "fs"; export const a = fs;', /imports "fs"/],
      ['import { x } from "../../agent/tools.js"; export const a = x;', /imports "\.\.\/\.\.\/agent\/tools\.js"/],
      ['export const a = (process as any).env;', /process/],
      ['export const a = Date.now();', /Date\.now/],
      ['export const a = Math.random();', /Math\.random/],
      ['export const a = new Date();', /uses Date outside the reviewed members/],
      ['export const a = eval("1");', /eval/],
      ['export const a = new Function("return 1");', /Function/],
      ['export const a = "set" + "Timeout";', /contains the string "setTimeout"/],
      ['export const a = import.meta;', /import\.meta/],
      ['export const a = (o: any) => { const { constructor: c } = o; return c; };', /constructor/],
      // Patterns from the v2 review (S1-S3): each must now be flagged.
      ['export const F = Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => 0))).map((d: any) => d.value);', /getOwnPropertyDescriptors/],
      ["const k = `fe${'tch'}`; export const a = (o: any) => o[`${k}`];", /computed key/],
      ['export const g = (o: any) => o[String.fromCharCode(102, 101)];', /fromCharCode/],
      ['export const g = (o: any, k: string[]) => o[k.join("")];', /computed key/],
      ['const D = Date; export const t = D.now();', /uses Date outside the reviewed members/],
      ['export const t = (Date).now();', /uses Date outside the reviewed members/],
      ['const M = Math; export const r = M.random();', /uses Math outside the reviewed members/],
      ['export const l = () => console.log("leak");', /references "console"/],
      ['JSON.stringify = () => "{}";', /modifies the shared built-in JSON/],
      ['(Object as any).freeze = (x: any) => x;', /modifies the shared built-in Object/],
      ['delete (Array as any).isArray;', /deletes from the shared built-in Array/],
      ['Object.assign(JSON, { parse: () => 1 });', /merges into the shared built-in JSON/],
      ['export const c = new BroadcastChannel("x");', /BroadcastChannel/],
      ['export const r = new FinalizationRegistry(() => 0);', /FinalizationRegistry/],
      ['(Error as any).prepareStackTrace = () => 0;', /prepareStackTrace/],
      ['export const x = crypto.getRandomValues(new Uint8Array(4));', /references "crypto"/],
      ['import { randomBytes } from "node:crypto"; export const x = randomBytes(4);', /other than \{ createHash \}/],
      ['import * as c from "node:crypto"; export const x = c;', /other than \{ createHash \}/],
      ['export const d = Object.defineProperty({}, "x", { get: () => 1 });', /defineProperty/],
    ];
    try {
      for (const [code, expected] of samples) {
        fs.writeFileSync(tmp, code);
        const problems = scanDivisionFile(tmp).findings.map((f) => f.problem).join("\n");
        expect(problems, code).toMatch(expected);
      }
      fs.writeFileSync(tmp, 'import { sha256Hex } from "./sources.js"; export const ok = (x: number[]) => x[0] + sha256Hex("a").length;');
      expect(scanDivisionFile(tmp).findings).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("validation.ts reflection: only the exact reviewed call sites pass; any other reflection there fails", () => {
    const real = fs.readFileSync(path.join(DIVISION, "validation.ts"), "utf8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "br-reflection-"));
    const scanAs = (name: string, code: string) => {
      const file = path.join(tmpDir, name);
      fs.writeFileSync(file, code);
      return scanDivisionFile(file).findings.map((f) => f.problem);
    };
    const outside = /outside the reviewed validation\.ts call sites/;
    try {
      // The required patterns pass (an unmodified copy has no findings).
      expect(scanAs("validation.ts", real)).toEqual([]);
      for (const site of REFLECTION_CALL_SITES) expect(real.split(site.call).length - 1).toBeGreaterThanOrEqual(1);

      const variants: Array<[string, string]> = [
        ["Function via descriptors (review S1 pattern)",
          real + '\nexport const F = (Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => 0))).find(([k]) => k.length === 11) as any)[1].value;\n'],
        ["a new function using an allowed call text",
          real + "\nexport function peek(value: unknown) { return Object.getPrototypeOf(value); }\n"],
        ["a second use inside checkKeys",
          real.replace("  const accessors = Object.entries(", "  const again = Object.getOwnPropertyDescriptors(value);\n  const accessors = Object.entries(")],
        ["a different argument at an allowed site",
          real.replace("if (Object.values(Object.getOwnPropertyDescriptors(value))", "if (Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(value)))")],
        ["reassigning value before an allowed call",
          real.replace("  const proto = Object.getPrototypeOf(value);", "  value = {};\n  const proto = Object.getPrototypeOf(value);")],
        ["the allowed call inside an arrow function",
          real + "\nexport function wrap(value: unknown) { return () => Object.getOwnPropertyDescriptors(value); }\n"],
      ];
      for (const [label, code] of variants) {
        expect(code, label).not.toBe(real);
        expect(scanAs("validation.ts", code).join("\n"), label).toMatch(outside);
      }
      // The same exact calls in any other file fail.
      expect(scanAs("other.ts", real).join("\n")).toMatch(outside);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("names none of the autonomous agent's tools, and nothing about payments, wallets, crypto or trading", () => {
    const toolNames = [...fs.readFileSync(path.join(SRC, "agent", "tools.ts"), "utf8").matchAll(/name:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(toolNames).toEqual(expect.arrayContaining(["exec", "transfer_credits", "spawn_child", "register_domain", "edit_own_file"]));
    const banned = new Set([...toolNames, "x402_fetch", "web_fetch", "child_process"]);
    for (const file of divisionFiles) {
      const source = parse(file);
      const visit = (node: ts.Node): void => {
        const value = ts.isIdentifier(node) ? node.text : constantString(node);
        if (value !== null && !(node.parent && ts.isImportDeclaration(node.parent))) {
          expect(banned.has(value), `${path.basename(file)} names tool "${value}"`).toBe(false);
          expect(/x402|wallet|usdc|trading|crypto(?!$)/i.test(value) && value !== "node:crypto", `${path.basename(file)}: "${value}"`).toBe(false);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  });

  it("nothing outside the division imports it, by any specifier or by name", () => {
    const outside = walk(SRC).filter((f) => f.endsWith(".ts") && !f.startsWith(DIVISION + path.sep) && !f.includes(`${path.sep}__tests__${path.sep}`));
    expect(outside.length).toBeGreaterThan(50);
    for (const file of outside) {
      const rel = path.relative(SRC, file);
      expect(fs.readFileSync(file, "utf8").includes("business-research"), `${rel} mentions the division`).toBe(false);
      for (const spec of allSpecifiers(file)) {
        if (!spec.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        expect(resolved.startsWith(DIVISION), `${rel} imports ${spec}`).toBe(false);
      }
    }
  });

  it("no trading division exists in this phase", () => {
    expect(fs.existsSync(path.join(SRC, "divisions", "trading"))).toBe(false);
    expect(fs.readdirSync(path.join(SRC, "divisions"))).toEqual(["business-research"]);
  });

  it("the public API is exactly the reviewed set (any new export must be reviewed)", () => {
    expect(Object.keys(division).sort()).toEqual([
      "CLAIM_TYPES", "CRITERIA", "CURRENCIES", "DEFAULT_MAX_SOURCE_AGE_DAYS", "DISABLED_MODEL_PORT",
      "EVIDENCE_GRADES", "HARD_GATES", "HIGH_SCORE_MIN_SOURCES", "ID_PATTERN", "InferenceDisabledError", "Issues",
      "MAX_CITATIONS_PER_CLAIM", "MAX_CLAIMS", "MAX_HORIZON_MONTHS", "MAX_RUN_BUDGET_CENTS", "MAX_SNAPSHOTS",
      "MAX_SNAPSHOT_CHARS", "MAX_SOURCE_AGE_LIMIT_DAYS", "MAX_TOTAL_SNAPSHOT_CHARS", "MIN_FAILURE_REASONS",
      "MIN_QUOTE_CHARS", "ProposalQueue", "QUOTE_VERIFICATION_LEGEND", "ReportValidationError",
      "RunBudgetController", "SCENARIO_NAMES", "SchemaError", "UNITS", "VERDICT_THRESHOLDS", "arr", "assertString",
      "bool", "calculateScenario", "calculateScenarios", "canonicalSourceUrl", "checkKeys", "createSnapshot",
      "daysBetween", "escapeInline", "extractNumbers", "formatMoney", "gradeEvidence", "gradeEvidenceSets", "id",
      "isPlainObject", "isoDate", "isoDateTime", "normalizeText", "oneOf", "originGroups", "parseAssumptions",
      "parseClaim", "parseExperimentProposal", "parseScenarioDefinition", "parseScenarioDefinitions", "parseScoring",
      "parseSnapshot", "parseSourcesAndClaims", "renderReport", "renderUrl", "safeInt", "scoreOpportunity",
      "sha256Hex", "sourceContentFingerprint", "sourceIdentityConflicts", "str", "typeName", "uniqueIds",
      "validateReport", "verifyClaims",
    ]);
  });
});

/** Replaces every network, process, filesystem, DNS and timer entry point with a recording spy. */
function installCapabilitySpies() {
  const targets: Array<[string, any, string[]]> = [
    ["child_process", childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
    ["http", http, ["request", "get", "createServer"]],
    ["https", https, ["request", "get", "createServer"]],
    ["net", net, ["connect", "createConnection", "createServer"]],
    ["tls", tls, ["connect", "createServer"]],
    ["dgram", dgram, ["createSocket"]],
    ["dns", dns, ["lookup", "resolve", "resolve4", "resolve6"]],
    ["fs", fs, ["readFileSync", "writeFileSync", "appendFileSync", "openSync", "readdirSync", "statSync", "existsSync", "rmSync", "readFile", "writeFile", "open"]],
    ["fs.promises", fs.promises, ["readFile", "writeFile", "appendFile", "open", "readdir", "stat", "rm"]],
    ["global", globalThis, ["fetch", "setTimeout", "setInterval", "setImmediate", "queueMicrotask"]],
  ];
  const calls: string[] = [];
  const spies = targets.flatMap(([label, obj, names]) =>
    names.filter((n) => typeof obj[n] === "function").map((n) =>
      vi.spyOn(obj, n).mockImplementation(((..._args: unknown[]) => {
        calls.push(`${label}.${n}`);
        throw new Error(`${label}.${n} is not allowed in the business research division`);
      }) as any)));
  const envReads: string[] = [];
  const originalEnv = process.env;
  process.env = new Proxy(originalEnv, {
    get(target, prop) {
      if (typeof prop === "string") envReads.push(prop);
      return Reflect.get(target, prop);
    },
  });
  return {
    calls,
    envReads,
    restore() {
      process.env = originalEnv;
      for (const s of spies) s.mockRestore();
    },
  };
}

describe("division boundaries (runtime)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a full validate/render/queue/budget/model-port run touches no network, process, filesystem, timer or environment API", async () => {
    const inputs = [validReport(), validReport(), validReport()];
    const draft = validReport();
    draft.sections.risks.push("ghost");
    const spies = installCapabilitySpies();
    let refusal: unknown;
    try {
      expect(division.validateReport(inputs[0]).ok).toBe(true);
      division.renderReport(inputs[1], { mode: "final" });
      division.renderReport(draft, { mode: "draft" });
      const q = new division.ProposalQueue();
      q.submit(EXPERIMENTS[0], "2026-10-15T12:00:00Z");
      q.recordDecision("exp-landing", { decision: "approved", decidedBy: "operator", decidedAt: "2026-10-15T12:05:00Z", note: "" });
      const b = new division.RunBudgetController(10);
      const a = b.authorize({ label: "x", estimatedCostCents: 1 });
      if (a.allowed) b.settle(a.reservationId, { kind: "success", actualCostCents: 1 });
      refusal = division.DISABLED_MODEL_PORT.complete({ purpose: "x", untrustedSourceText: "y" });
      (refusal as Promise<never>).catch(() => undefined);
    } finally {
      spies.restore();
    }
    await expect(refusal).rejects.toBeInstanceOf(division.InferenceDisabledError);
    expect(spies.calls).toEqual([]);
    expect(spies.envReads).toEqual([]);
  });

  it("the spies themselves work (self-test)", () => {
    const spies = installCapabilitySpies();
    try {
      expect(() => fs.readFileSync("/etc/hostname")).toThrow("not allowed");
      expect(() => (globalThis as any).fetch("https://example.org")).toThrow("not allowed");
      void process.env.HOME;
    } finally {
      spies.restore();
    }
    expect(spies.calls).toEqual(["fs.readFileSync", "global.fetch"]);
    expect(spies.envReads).toContain("HOME");
  });
});
