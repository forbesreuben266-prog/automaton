/**
 * Boundaries of the R1 readiness module: offline and pure (no files,
 * network, processes, clocks, randomness or trading vocabulary), imported by
 * nothing outside it (tests excepted), consistent with the conventions of the
 * existing research modules, and unable to make real-world input reach the
 * existing engines. Syntax-tree and runtime spy checks; not a sandbox.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as businessDivision from "../../divisions/business-research/validation.js";
import * as readiness from "../../research-readiness/index.js";
import * as trading from "../../trading-research/index.js";
import * as tradingValidation from "../../trading-research/validation.js";
import { usDataset } from "../trading-research/fixtures.js";
import { businessBundle, marketRecord } from "./fixtures.js";

const SRC = path.resolve(__dirname, "../..");
const MODULE = path.join(SRC, "research-readiness");
const FILES = ["business.ts", "index.ts", "market-data.ts", "provenance.ts", "quarantine.ts", "readiness.ts", "validation.ts"];
const FORBIDDEN_IDENTIFIERS = new Set([
  "process", "require", "globalThis", "global", "fetch", "eval", "Function", "Proxy", "XMLHttpRequest", "WebSocket", "Worker", "URL",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Date", "Intl", "performance", "Buffer", "Deno", "Bun",
]);
const FORBIDDEN_WORDS = /broker|alpaca|ibkr|oanda|placeorder|submitorder|sendorder|wallet|x402|usdc|bitcoin|ethereum|binance|coinbase|apikey|api_key|docker|sandbox/i;
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe("readiness module boundaries (static)", () => {
  it("contains exactly the reviewed modules", () => {
    expect(fs.readdirSync(MODULE).sort()).toEqual(FILES);
  });

  for (const file of FILES) {
    it(`${file}: imports only sibling modules (and node:crypto in readiness.ts); no dynamic import, require or import.meta`, () => {
      const specs: string[] = [];
      const visit = (n: ts.Node): void => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
        if (ts.isImportEqualsDeclaration(n) || ts.isMetaProperty(n)) specs.push("<forbidden>");
        if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) specs.push("<dynamic>");
        ts.forEachChild(n, visit);
      };
      visit(parse(path.join(MODULE, file)));
      const allowed = (s: string) => (/^\.\/[a-z-]+\.js$/.test(s) && FILES.includes(`${s.slice(2, -3)}.ts`)) || (file === "readiness.ts" && s === "node:crypto");
      expect(specs.filter((s) => !allowed(s))).toEqual([]);
    });

    it(`${file}: names no capability, broker, order, wallet, crypto-asset, Docker or sandbox API`, () => {
      const found: string[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) {
          const isMember = n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n;
          if (FORBIDDEN_IDENTIFIERS.has(n.text) && !isMember) found.push(n.text);
          if (FORBIDDEN_WORDS.test(n.text)) found.push(n.text);
        }
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Math" && n.name.text === "random") found.push("Math.random");
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !(n.parent && ts.isImportDeclaration(n.parent))) {
          if (FORBIDDEN_WORDS.test(n.text) || /^https?:/i.test(n.text)) found.push(JSON.stringify(n.text));
        }
        if (ts.isPropertyAccessExpression(n) && (n.name.text === "constructor" || n.name.text === "__proto__")) found.push(`.${n.name.text}`);
        ts.forEachChild(n, visit);
      };
      visit(parse(path.join(MODULE, file)));
      expect(found).toEqual([]);
    });
  }

  it("nothing outside the module imports or names it (tests excepted; one approved coordinator, the unified CLI, via the public index), so neither the agent nor the engines can reach it", () => {
    const COORDINATOR = path.join(SRC, "research-cli", "cli.ts");
    const coordinatorSpecs = [...fs.readFileSync(COORDINATOR, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).filter((spec) => spec.includes("research-readiness"));
    expect(coordinatorSpecs).toEqual(["../research-readiness/index.js"]);
    const outside = walk(SRC).filter((f) => f.endsWith(".ts") && !f.startsWith(MODULE + path.sep) && !f.includes(`${path.sep}__tests__${path.sep}`) && f !== COORDINATOR);
    expect(outside.length).toBeGreaterThan(50);
    for (const file of outside) expect(fs.readFileSync(file, "utf8").includes("research-readiness"), path.relative(SRC, file)).toBe(false);
  });

  it("the module names none of the existing research modules (their own boundary rules stay intact)", () => {
    for (const file of FILES) {
      const text = fs.readFileSync(path.join(MODULE, file), "utf8");
      for (const name of ["business-research", "trading-research", "research-pipeline", "research-cli", "research-sandbox"]) expect(text.includes(name), `${file}: ${name}`).toBe(false);
    }
  });
});

describe("consistency with the existing research modules", () => {
  it("uses the same identifier pattern, unsafe-text rule, asset classes and forex currencies (no crypto)", () => {
    expect(readiness.ID_PATTERN.source).toBe(businessDivision.ID_PATTERN.source);
    expect(readiness.UNSAFE_TEXT.source).toBe(tradingValidation.UNSAFE_TEXT.source);
    expect([...readiness.MARKET_ASSET_CLASSES]).toEqual([...trading.ASSET_CLASSES]);
    expect([...readiness.MARKET_FX_CURRENCIES]).toEqual([...trading.FX_CURRENCIES]);
  });
});

describe("fail-closed: real-world input can't reach the existing engines", () => {
  it("the trading engine still accepts only fictional datasets", () => {
    for (const kind of ["real_world", "vendor", "exchange", "verified"]) {
      const d = usDataset();
      d.source.kind = kind;
      expect(() => trading.parseDataset(d)).toThrow(/dataset\.source\.kind: must be one of: fictional/);
    }
  });

  it("a readiness record is not a dataset the engine accepts, whatever its readiness", () => {
    const record = marketRecord("us");
    expect(readiness.assessMarketData(record).overall).toBe("ready_for_operator_review");
    expect(() => trading.parseDataset(record)).toThrow(trading.ValidationError);
  });

  it("every result says it is not approved, and the approval gate refuses all of them", () => {
    const results = [
      readiness.assessBusinessEvidence(businessBundle()), readiness.assessMarketData(marketRecord("uk")), readiness.assessMarketData({}),
    ];
    expect(results.map((r) => r.overall)).toEqual(["ready_for_operator_review", "ready_for_operator_review", "refused"]);
    for (const r of results) {
      expect(r.approvedForRealWorldUse).toBe(false);
      expect(r.notice).toMatch(/does not approve anything: real-world research input is not enabled/);
      expect(() => readiness.assertRealWorldInputApproved(r)).toThrow(readiness.ReadinessInputError);
    }
    expect(readiness.overallOf([])).toBe("unverified");
  });
});

describe("readiness module boundaries (runtime)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("assessments make no file, network, process or environment call", () => {
    const calls: string[] = [];
    const block = (obj: any, name: string, label: string) => {
      if (typeof obj[name] === "function") vi.spyOn(obj, name).mockImplementation(((..._a: unknown[]) => { calls.push(label); throw new Error(`${label} called`); }) as any);
    };
    const inputs = [businessBundle(), marketRecord("us"), marketRecord("uk"), marketRecord("fx")];
    for (const name of ["readFileSync", "writeFileSync", "openSync", "readdirSync", "statSync", "lstatSync", "existsSync", "readFile", "writeFile", "open"]) block(fs, name, `fs.${name}`);
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) block(childProcess, name, `child_process.${name}`);
    block(net, "connect", "net.connect"); block(http, "request", "http.request"); block(https, "request", "https.request"); block(globalThis, "fetch", "fetch");
    const realEnv = process.env;
    process.env = new Proxy(realEnv, { get: (t, k) => { if (typeof k === "string") calls.push(`env.${k}`); return Reflect.get(t, k); } }) as NodeJS.ProcessEnv;
    try {
      readiness.renderReadiness(readiness.assessBusinessEvidence(inputs[0]));
      for (const r of inputs.slice(1)) readiness.renderReadiness(readiness.assessMarketData(r));
    } finally {
      process.env = realEnv;
    }
    expect(calls).toEqual([]);
  });
});
