/**
 * Boundaries of the unified research CLI (U1): it coordinates the business
 * and trading modules only through their public entry points, reads files
 * only through its read-only loader, and has no other capability.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");
// E1 exception (reviewed): src/research-sandbox/research-image.ts lists the research CLI's compiled files as paths inside the
// sandbox image, so it names this module; it must contain no import, re-export or require, so it can never be a code route.
const IMAGE_LIST = path.join(SRC, "research-sandbox", "research-image.ts");
const imageListIsInert = () => !/\bimport\b|\bexport\s+[^;]*\bfrom\b|\brequire\s*\(/.test(fs.readFileSync(IMAGE_LIST, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""));
const DIR = path.join(SRC, "research-cli");
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(path.join(DIR, file), "utf8"), ts.ScriptTarget.ES2022, true);
function specifiers(file: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(n) || ts.isMetaProperty(n)) out.push("<forbidden>");
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) out.push("<dynamic>");
    ts.forEachChild(n, visit);
  };
  visit(parse(file));
  return out;
}
function identifiers(file: string): { names: Set<string>; members: Map<string, Set<string>>; strings: string[] } {
  const names = new Set<string>();
  const members = new Map<string, Set<string>>();
  const strings: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) names.add(n.text);
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      if (!members.has(n.expression.text)) members.set(n.expression.text, new Set());
      members.get(n.expression.text)!.add(n.name.text);
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !(n.parent && ts.isImportDeclaration(n.parent))) strings.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(parse(file));
  return { names, members, strings };
}

describe("research CLI boundaries", () => {
  it("contains exactly the reviewed modules", () => {
    expect(fs.readdirSync(DIR).sort()).toEqual(["cli.ts", "main.ts", "trading-files.ts"]);
  });

  it("cli.ts reaches the business, trading and readiness modules only through their public entry points, and has no process or filesystem access", () => {
    expect(specifiers("cli.ts").sort()).toEqual(["../research-pipeline/cli.js", "../research-readiness/index.js", "../trading-research/index.js", "./trading-files.js"]);
    const { names } = identifiers("cli.ts");
    for (const name of ["process", "fs", "require", "fetch", "globalThis", "eval", "Function", "Date", "setTimeout", "setInterval", "loadRun"]) expect(names.has(name), name).toBe(false);
  });

  it("trading-files.ts uses only read-only filesystem calls with no-follow, non-blocking opens", () => {
    expect(specifiers("trading-files.ts")).toEqual(["node:fs"]);
    const { names, members } = identifiers("trading-files.ts");
    expect([...(members.get("fs") ?? [])].sort()).toEqual(["closeSync", "constants", "fstatSync", "lstatSync", "openSync", "readSync"]);
    const flags = [...fs.readFileSync(path.join(DIR, "trading-files.ts"), "utf8").matchAll(/constants\.(O_[A-Z]+)/g)].map((m) => m[1]).sort();
    expect([...new Set(flags)]).toEqual(["O_NOFOLLOW", "O_NONBLOCK", "O_RDONLY"]);
    for (const name of ["process", "require", "fetch", "globalThis"]) expect(names.has(name), name).toBe(false);
  });

  it("main.ts imports only ./cli.js and uses only process.argv, stdout, stderr and exitCode", () => {
    expect(specifiers("main.ts")).toEqual(["./cli.js"]);
    expect([...(identifiers("main.ts").members.get("process") ?? [])].sort()).toEqual(["argv", "exitCode", "stderr", "stdout"]);
  });

  it("names no broker, order-placement, wallet, crypto-asset, Docker or sandbox API", () => {
    for (const file of ["cli.ts", "main.ts", "trading-files.ts"]) {
      const { names, strings } = identifiers(file);
      for (const value of [...names, ...strings]) {
        expect(/broker|alpaca|ibkr|oanda|placeorder|submitorder|wallet|x402|usdc|bitcoin|ethereum|docker|runsc|sandbox|\.sock\b/i.test(value), `${file}: ${value.slice(0, 60)}`).toBe(false);
      }
    }
  });

  it("nothing outside the CLI folder imports it (tests excepted)", () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const outside = walk(SRC).filter((f) => f.endsWith(".ts") && !f.startsWith(DIR + path.sep) && !f.includes(`${path.sep}__tests__${path.sep}`));
    expect(outside.length).toBeGreaterThan(50);
    for (const file of outside) {
      if (file === IMAGE_LIST) { expect(imageListIsInert(), "research-image.ts must stay inert").toBe(true); continue; }
      expect(fs.readFileSync(file, "utf8").includes("research-cli"), path.relative(SRC, file)).toBe(false);
    }
  });
});
