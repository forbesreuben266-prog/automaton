/**
 * Boundaries of the trading research foundation (T1): offline, pure modules
 * with no route to files, network, processes, clocks, brokers, orders,
 * wallets or crypto assets. Syntax-tree checks plus a runtime spy check;
 * not a sandbox.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { datasetSha256, parseDatasetText, riskReward, summarizeDataset } from "../../trading-research/index.js";
import { fxDataset, text, ukDataset, usDataset } from "./fixtures.js";

const SRC = path.resolve(__dirname, "../..");
const MODULE = path.join(SRC, "trading-research");
const FILES = ["backtest.ts", "dataset.ts", "execution.ts", "index.ts", "instruments.ts", "metrics.ts", "paper.ts", "prices.ts", "report.ts", "strategy.ts", "validation.ts"];
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
/** Capability names: files, network, processes, environment, time, randomness, dynamic code, global scope. */
const FORBIDDEN_IDENTIFIERS = new Set([
  "process", "require", "globalThis", "global", "fetch", "eval", "Function", "Proxy", "XMLHttpRequest", "WebSocket", "Worker",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Date", "performance", "Buffer", "Deno", "Bun",
]);
/** Broker, order, account and crypto-asset vocabulary that has no place in an offline research foundation. */
const FORBIDDEN_WORDS = /broker|alpaca|ibkr|interactive.?brokers|oanda|placeorder|submitorder|sendorder|wallet|x402|usdc|bitcoin|ethereum|binance|coinbase|apikey|api_key/i;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe("trading research boundaries (static)", () => {
  it("contains exactly the reviewed modules", () => {
    expect(fs.readdirSync(MODULE).filter((f) => f.endsWith(".ts")).sort()).toEqual(FILES);
  });

  for (const file of FILES) {
    it(`${file}: imports only sibling modules (and node:crypto in dataset.ts and paper.ts); no dynamic import, require or import.meta`, () => {
      const specs: string[] = [];
      const visit = (n: ts.Node): void => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
        if (ts.isImportEqualsDeclaration(n) || ts.isMetaProperty(n)) specs.push("<forbidden>");
        if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) specs.push("<dynamic>");
        ts.forEachChild(n, visit);
      };
      visit(parse(path.join(MODULE, file)));
      const allowed = (s: string) => /^\.\/[a-z-]+\.js$/.test(s) && FILES.includes(s.slice(2, -3) + ".ts") || ((file === "dataset.ts" || file === "paper.ts") && s === "node:crypto");
      expect(specs.filter((s) => !allowed(s))).toEqual([]);
    });

    it(`${file}: names no capability, broker, order, wallet or crypto-asset API`, () => {
      const found: string[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) {
          const isMember = n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n;
          if (FORBIDDEN_IDENTIFIERS.has(n.text) && !isMember) found.push(n.text);
          if (FORBIDDEN_WORDS.test(n.text)) found.push(n.text);
        }
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Math" && n.name.text === "random") found.push("Math.random");
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Reflect" && n.name.text !== "ownKeys") found.push(`Reflect.${n.name.text}`);
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !(n.parent && ts.isImportDeclaration(n.parent))) {
          if (FORBIDDEN_WORDS.test(n.text) || FORBIDDEN_IDENTIFIERS.has(n.text) || /^https?:/i.test(n.text)) found.push(JSON.stringify(n.text));
        }
        if (ts.isPropertyAccessExpression(n) && (n.name.text === "constructor" || n.name.text === "__proto__")) found.push(`.${n.name.text}`);
        ts.forEachChild(n, visit);
      };
      visit(parse(path.join(MODULE, file)));
      expect(found).toEqual([]);
    });
  }

  it("accepts no crypto-asset currency or asset class", async () => {
    const { ASSET_CLASSES, FX_CURRENCIES } = await import("../../trading-research/index.js");
    expect([...ASSET_CLASSES]).toEqual(["us_equity", "uk_equity", "fx"]);
    for (const code of ["BTC", "ETH", "USDT", "USDC", "XRP", "SOL"]) expect(FX_CURRENCIES as readonly string[]).not.toContain(code);
  });

  it("nothing outside the module imports or names it (tests excepted; one approved coordinator, the unified CLI), so the agent has no route to it", () => {
    const COORDINATOR = path.join(SRC, "research-cli", "cli.ts");
    const coordinatorSpecs = [...fs.readFileSync(COORDINATOR, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).filter((spec) => spec.includes("trading-research"));
    expect(coordinatorSpecs).toEqual(["../trading-research/index.js"]);
    const outside = walk(SRC).filter((f) => f.endsWith(".ts") && !f.startsWith(MODULE + path.sep) && !f.includes(`${path.sep}__tests__${path.sep}`) && f !== COORDINATOR);
    expect(outside.length).toBeGreaterThan(50);
    for (const file of outside) expect(fs.readFileSync(file, "utf8").includes("trading-research"), path.relative(SRC, file)).toBe(false);
  });

  it("no trading division was added under src/divisions (the completed Phase 0 boundary still holds)", () => {
    expect(fs.readdirSync(path.join(SRC, "divisions"))).toEqual(["business-research"]);
  });
});

describe("trading research boundaries (runtime)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parsing, hashing and metrics make no file, network, process or environment call", () => {
    const calls: string[] = [];
    const block = (obj: any, name: string, label: string) => {
      if (typeof obj[name] === "function") vi.spyOn(obj, name).mockImplementation(((..._a: unknown[]) => { calls.push(label); throw new Error(`${label} called`); }) as any);
    };
    const inputs = [usDataset(), ukDataset(), fxDataset()].map(text);
    for (const name of ["readFileSync", "writeFileSync", "openSync", "readdirSync", "statSync", "lstatSync", "existsSync", "readFile", "writeFile", "open"]) block(fs, name, `fs.${name}`);
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) block(childProcess, name, `child_process.${name}`);
    block(net, "connect", "net.connect"); block(http, "request", "http.request"); block(https, "request", "https.request"); block(globalThis, "fetch", "fetch");
    const realEnv = process.env;
    process.env = new Proxy(realEnv, { get: (t, k) => { if (typeof k === "string") calls.push(`env.${k}`); return Reflect.get(t, k); } }) as NodeJS.ProcessEnv;
    try {
      for (const input of inputs) {
        const ds = parseDatasetText(input);
        datasetSha256(ds);
        summarizeDataset(ds);
      }
      riskReward(parseDatasetText(inputs[0]).instrument, { entry: "100.00", stop: "95.00", target: "115.00" });
    } finally {
      process.env = realEnv;
    }
    expect(calls).toEqual([]);
  });
});
