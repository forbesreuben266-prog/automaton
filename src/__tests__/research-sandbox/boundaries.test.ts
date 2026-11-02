/**
 * Static checks on the research sandbox package (syntax tree; not a sandbox):
 * per-file import allowlists, process spawning only in engine.ts with no shell, the probe's only network
 * target is the reserved TEST-NET-1 address, and the package is independent
 * of the agent, inference, wallet and research-division code (D6 untouched).
 */

import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");
const PKG = path.join(SRC, "research-sandbox");
const files = fs.readdirSync(PKG).filter((f) => f.endsWith(".ts")).sort();
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(path.join(PKG, file), "utf8"), ts.ScriptTarget.ES2022, true);

const ALLOWED_EXTERNAL: Record<string, readonly string[]> = {
  "engine.ts": ["node:child_process"],
  "canary-probe.ts": ["node:fs", "node:net"],
  "host-paths.ts": ["node:crypto", "node:fs"],
  "spec.ts": ["node:crypto"],
};

function imports(file: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) out.push("<dynamic>");
    ts.forEachChild(n, visit);
  };
  visit(parse(file));
  return out;
}

function stringLiterals(file: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    if (ts.isTemplateExpression(n)) out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(n, visit);
  };
  visit(parse(file));
  return out;
}

describe("research sandbox static boundaries", () => {
  it("contains exactly the reviewed modules", () => {
    expect(files).toEqual(["canary-probe.ts", "canary.ts", "engine.ts", "host-paths.ts", "index.ts", "inspect.ts", "preflight.ts", "spec.ts"]);
  });

  it("each file imports only siblings and its allowlisted Node modules; no dynamic import/require", () => {
    for (const file of files) {
      for (const spec of imports(file)) {
        const sibling = /^\.\/[a-z-]+\.js$/.test(spec) && fs.existsSync(path.join(PKG, spec.replace(/\.js$/, ".ts")));
        expect(sibling || (ALLOWED_EXTERNAL[file] ?? []).includes(spec), `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("process execution is spawn with shell:false in its own process group (engine.ts only); nothing else can run commands", () => {
    for (const file of files) {
      const code = fs.readFileSync(path.join(PKG, file), "utf8");
      // child_process is importable only by engine.ts (previous test); here: no other process APIs, never a shell.
      expect(/(?<!\.)\b(spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|\bchild_process\.exec\b|shell:\s*true/.test(code), `${file} runs commands unsafely`).toBe(false);
      if (file !== "engine.ts") expect(/\bspawn\s*\(/.test(code), `${file} must not execute processes`).toBe(false);
    }
    const engine = fs.readFileSync(path.join(PKG, "engine.ts"), "utf8");
    expect(engine.match(/\bspawn\s*\(/g)).toHaveLength(1);
    expect(engine).toContain("shell: false");
    expect(engine).toContain("detached: true");
  });

  it("the only network address anywhere is the reserved TEST-NET-1 host used by the probe", () => {
    for (const file of files) {
      for (const s of stringLiterals(file)) {
        expect(/^https?:\/\//i.test(s), `${file} contains a URL: ${s}`).toBe(false);
        const ips = s.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
        for (const ip of ips) expect(ip, `${file} contains address ${ip}`).toBe("192.0.2.1");
      }
    }
    expect(stringLiterals("canary-probe.ts")).toContain("192.0.2.1");
    // No DNS: node:dns isn't importable (import allowlist) and no socket lookup override is used.
    expect(imports("canary-probe.ts")).not.toContain("node:dns");
    const probeCode = fs.readFileSync(path.join(PKG, "canary-probe.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(probeCode).not.toMatch(/\.lookup\s*\(|\blookup\s*:/);
  });

  it("is independent of the agent, inference, wallet, budget and research-division code", () => {
    for (const file of files) {
      const code = fs.readFileSync(path.join(PKG, file), "utf8");
      expect(/(agent|inference|conway|wallet|identity|divisions|spend|budget)\//.test(imports(file).join(" ")), `${file} imports protected code`).toBe(false);
      expect(code.toLowerCase().includes("business-research"), `${file} references the research division`).toBe(false);
    }
  });

  it("nothing outside the package (tests excepted) imports it yet", () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
    const outside = walk(SRC).filter((f) => f.endsWith(".ts") && !f.startsWith(PKG + path.sep) && !f.includes(`${path.sep}__tests__${path.sep}`));
    for (const f of outside) expect(fs.readFileSync(f, "utf8").includes("research-sandbox"), path.relative(SRC, f)).toBe(false);
  });

  it("no module performs work at import time (no top-level calls outside declarations)", () => {
    for (const file of files) {
      for (const stmt of parse(file).statements) {
        const ok = ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) || ts.isFunctionDeclaration(stmt) ||
          ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isVariableStatement(stmt);
        expect(ok, `${file}: top-level ${ts.SyntaxKind[stmt.kind]}`).toBe(true);
      }
    }
  });
});
