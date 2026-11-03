/**
 * U1: unified offline research CLI. FICTIONAL inputs written to temporary
 * directories outside the repository (removed afterwards). In memory apart
 * from reading those files.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRADING_BANNER, USAGE, EXIT, runResearchCli } from "../../research-cli/cli.js";
import { BANNER as BUSINESS_BANNER, runCli as runBusinessCli, terminalSafe } from "../../research-pipeline/cli.js";
import {
  PaperSession, parseBacktestConfig, parseDatasetText, renderBacktestReport, renderDatasetReport, renderPaperReport, runBacktest,
} from "../../trading-research/index.js";
import { DEMO_INITIAL, DEMO_LATER, DEMO_OPPORTUNITY, writeDemo } from "../research-pipeline/cli-demo.js";
import { fxDataset, ukDataset, usDataset } from "../trading-research/fixtures.js";

const REPO = path.resolve(__dirname, "../../..");
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rp-ucli-")));
  fs.chmodSync(root, 0o755);
  fs.writeFileSync(path.join(root, "fict-us.json"), JSON.stringify(usDataset()));
  fs.writeFileSync(path.join(root, "fict-uk.json"), JSON.stringify(ukDataset()));
  fs.writeFileSync(path.join(root, "fict-fx.json"), JSON.stringify(fxDataset()));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runResearchCli(argv, { out: (t) => { stdout += t; }, err: (t) => { stderr += t; } });
  return { code, stdout, stderr };
}
/** Before beforeEach runs (it.each tables), a placeholder root is used: usage errors happen before any file access. */
const base = (cmd: string, dataset = "fict-us.json", dataRoot?: string) =>
  ["trading", cmd, "--data-root", dataRoot ?? root ?? "/srv/research-data", "--repo-root", REPO, "--dataset", dataset];
const US_SETTINGS = ["--strategy", "buy_and_hold", "--sizing", "fixed_units", "--units", "10", "--cash", "10000.00", "--cash-currency", "USD", "--slippage-bps", "0"];
const US_CONFIG = { version: 1, strategy: { kind: "buy_and_hold" }, execution: "next_bar_open", initialCash: { currency: "USD", amount: "10000.00" }, sizing: { mode: "fixed_units", units: 10 }, slippageBps: "0" };
const dataset = (file: string) => parseDatasetText(fs.readFileSync(path.join(root, file), "utf8"));
function expectSafeRefusal(r: { code: number; stdout: string; stderr: string }) {
  expect(r.code).toBe(EXIT.refused);
  expect(r.stdout).toBe(""); // fail closed: no partial report
  expect(r.stderr).toMatch(/^Refused:\n/);
  expect(r.stderr).not.toContain(root);
  expect(r.stderr).not.toContain(REPO);
  expect(r.stderr).not.toMatch(/^\s+at /m);
}

describe("help and usage", () => {
  it("prints discoverable help with examples (exit 0)", () => {
    const r = cli("--help");
    expect(r).toEqual({ code: EXIT.ok, stdout: USAGE, stderr: "" });
    for (const text of ["trading validate", "trading backtest", "trading paper", "assess", "compare", "Examples:", "Nothing is defaulted"]) expect(USAGE).toContain(text);
  });

  it.each([
    ["no command", [], "no command given"],
    ["an unknown command", ["trade"], "unknown command (expected assess, compare, trading or import)"],
    ["trading without a subcommand", ["trading"], "missing trading command (expected validate, backtest or paper)"],
    ["an unknown trading command", ["trading", "live"], "unknown trading command (expected validate, backtest or paper)"],
    ["an unknown option", [...base("validate"), "--output", "x"], "unknown option --output for trading validate"],
    ["run settings on validate", [...base("validate"), "--cash", "1"], "unknown option --cash for trading validate"],
    ["a repeated option", [...base("validate"), "--dataset", "fict-uk.json"], "option --dataset is given more than once"],
    ["a missing dataset", ["trading", "validate", "--data-root", "/srv/x", "--repo-root", REPO], "missing option --dataset"],
    ["both --config and settings", [...base("backtest"), "--config", "run.json", "--cash", "1"], "give either --config or individual run settings, not both"],
    ["a missing run setting", [...base("backtest"), ...US_SETTINGS.slice(0, -2)], "missing option --slippage-bps (give every run setting, or --config <file.json>; nothing is defaulted)"],
    ["no run settings at all", base("backtest"), "missing option --strategy (give every run setting, or --config <file.json>; nothing is defaulted)"],
    ["--fast with buy_and_hold", [...base("backtest"), ...US_SETTINGS, "--fast", "2"], "--fast and --slow apply only to --strategy ma_crossover"],
    ["ma_crossover without periods", [...base("backtest"), "--strategy", "ma_crossover", ...US_SETTINGS.slice(2)], "ma_crossover needs --fast and --slow"],
    ["--units with all_cash", [...base("backtest"), "--strategy", "buy_and_hold", "--sizing", "all_cash", "--units", "3", ...US_SETTINGS.slice(6)], "--units applies only to --sizing fixed_units"],
    ["a positional argument", ["trading", "validate", "/tmp/x.json"], "argument 3 is not an option (options look like --name value)"],
    ["an over-long argument", ["trading", "validate", "--dataset", "x".repeat(5_000)], "arguments must be text of at most 4096 characters"],
  ])("refuses %s (exit 2, no value echoed)", (_label, argv, message) => {
    const r = cli(...(argv as string[]));
    expect(r.code).toBe(EXIT.usage);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`Usage error: ${message}\n\n${USAGE}`);
  });
});

describe("trading commands (valid fictional runs)", () => {
  it("validate prints the dataset report with its SHA-256", () => {
    const r = cli(...base("validate"));
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(terminalSafe(TRADING_BANNER + renderDatasetReport(dataset("fict-us.json"))));
    expect(r.stdout).toContain("Status: **valid**");
    expect(r.stdout).toContain("| Total return over the data | 8.9000% |");
  });

  it("backtest with explicit options equals the library result, and a config file gives the same report", () => {
    const r = cli(...base("backtest"), ...US_SETTINGS);
    const ds = dataset("fict-us.json");
    const cfg = parseBacktestConfig(US_CONFIG, ds);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toBe(terminalSafe(TRADING_BANNER + renderBacktestReport(ds, cfg, runBacktest(ds, cfg))));
    expect(r.stdout).toContain("| Total return (hypothetical) | 0.8790% |");
    fs.writeFileSync(path.join(root, "run-us.json"), JSON.stringify(US_CONFIG));
    expect(cli(...base("backtest"), "--config", "run-us.json").stdout).toBe(r.stdout);
  });

  it("paper replays the dataset one bar at a time and reports the ledger head", () => {
    const r = cli(...base("paper", "fict-uk.json"), "--strategy", "buy_and_hold", "--sizing", "all_cash", "--cash", "1000.00", "--cash-currency", "GBP", "--slippage-bps", "0");
    const ds = dataset("fict-uk.json");
    const session = PaperSession.replay(ds, parseBacktestConfig({ ...US_CONFIG, initialCash: { currency: "GBP", amount: "1000.00" }, sizing: { mode: "all_cash" } }, ds));
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toBe(terminalSafe(TRADING_BANNER + renderPaperReport(session)));
    expect(r.stdout).toContain(`final hash ${session.ledgerHead}`);
    expect(r.stdout).toContain("(1 GBP = 100 GBX, converted exactly)");
  });

  it("forex with a moving-average strategy from options", () => {
    const r = cli(...base("backtest", "fict-fx.json"), "--strategy", "ma_crossover", "--fast", "2", "--slow", "3", "--sizing", "fixed_units", "--units", "10000",
      "--cash", "20000.00", "--cash-currency", "USD", "--slippage-bps", "1");
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Strategy: ma\\_crossover (fast = 2, slow = 3)");
    expect(r.stdout).toContain("profit/loss stays in USD (no conversion, no margin)");
  });

  it("is deterministic", () => {
    const args = [...base("paper"), ...US_SETTINGS];
    expect(cli(...args).stdout).toBe(cli(...args).stdout);
  });
});

describe("malformed inputs fail closed (exit 1, nothing on standard output)", () => {
  it.each([
    ["malformed JSON", "{not json", "is not valid JSON"],
    ["inconsistent prices", JSON.stringify({ ...usDataset(), bars: [{ ...usDataset().bars[0], low: "200.00" }] }), "prices are inconsistent"],
    ["a non-fictional source", JSON.stringify({ ...usDataset(), source: { ...usDataset().source, kind: "vendor" } }), "source.kind: must be one of: fictional"],
  ])("refuses a dataset with %s", (_label, content, message) => {
    fs.writeFileSync(path.join(root, "bad.json"), content);
    const r = cli(...base("validate", "bad.json"));
    expectSafeRefusal(r);
    expect(r.stderr).toContain(message);
  });

  it.each([
    ["non-numeric slippage", ["--slippage-bps", "fast"], "config.slippageBps: must be a decimal string"],
    ["GBX initial cash for a UK stock", ["--cash-currency", "GBX"], "config.initialCash.currency: must be GBP"],
    ["a fractional unit count", ["--units", "1.5"], "config.sizing.units: must be an integer"],
    ["an unknown strategy", ["--strategy", "short_squeeze"], "config.strategy.kind: must be one of"],
  ])("refuses run settings with %s", (_label, patch, message) => {
    const settings = ["--strategy", "buy_and_hold", "--sizing", "fixed_units", "--units", "10", "--cash", "1000.00", "--cash-currency", "GBP", "--slippage-bps", "0"];
    const i = settings.indexOf(patch[0]);
    settings[i + 1] = patch[1];
    const r = cli(...base("backtest", "fict-uk.json"), ...settings);
    expectSafeRefusal(r);
    expect(r.stderr).toContain(message);
  });

  it("refuses an invalid or oversized config file", () => {
    fs.writeFileSync(path.join(root, "run.json"), JSON.stringify({ ...US_CONFIG, leverage: 2 }));
    expect(cli(...base("backtest"), "--config", "run.json").stderr).toContain("config.leverage: is not an allowed field");
    fs.writeFileSync(path.join(root, "big.json"), " ".repeat(10_001));
    const r = cli(...base("backtest"), "--config", "big.json");
    expectSafeRefusal(r);
    expect(r.stderr).toContain("the limit is 10000");
  });
});

describe("path safety", () => {
  it.each([
    ["a relative data root", "relative/data", "fict-us.json", "data root: must be a normalized absolute path"],
    ["a data root with ..", "/tmp/../etc", "fict-us.json", "data root: must be a normalized absolute path"],
    ["a data root inside the repository", path.join(REPO, "data"), "fict-us.json", "data root: must be outside the repository"],
    ["traversal in the file name", null, "../etc.json", "--dataset: must be a plain lower-case file name ending in .json"],
    ["a sub-directory path", null, "sub/x.json", "--dataset: must be a plain lower-case file name"],
    ["a hidden file", null, ".x.json", "--dataset: must be a plain lower-case file name"],
    ["another extension", null, "fict-us.txt", "--dataset: must be a plain lower-case file name"],
  ])("refuses %s before reading anything", (_label, dataRoot, file, message) => {
    const r = cli(...base("validate", file, dataRoot ?? root));
    expectSafeRefusal(r);
    expect(r.stderr).toContain(message);
  });

  it("refuses symbolic links (data root or file), directories, missing files and other-writable roots", () => {
    const link = `${root}-link`;
    fs.symlinkSync(root, link);
    try {
      expect(cli(...base("validate", "fict-us.json", link)).stderr).toContain("is a symbolic link");
    } finally {
      fs.unlinkSync(link);
    }
    fs.symlinkSync(path.join(root, "fict-us.json"), path.join(root, "alias.json"));
    expect(cli(...base("validate", "alias.json")).stderr).toContain("<data-root>/alias.json: is a symbolic link");
    fs.mkdirSync(path.join(root, "dir.json"));
    expect(cli(...base("validate", "dir.json")).stderr).toContain("<data-root>/dir.json: is not a regular file");
    expect(cli(...base("validate", "missing.json")).stderr).toContain("<data-root>/missing.json: cannot be inspected (ENOENT)");
    fs.chmodSync(root, 0o757);
    const r = cli(...base("validate"));
    expectSafeRefusal(r);
    expect(r.stderr).toContain("<data-root>: is writable by others");
  });

  it("refuses a byte-order mark and invalid UTF-8", () => {
    fs.writeFileSync(path.join(root, "bom.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));
    expect(cli(...base("validate", "bom.json")).stderr).toContain("must not start with a byte-order mark");
    fs.writeFileSync(path.join(root, "bad-utf8.json"), Buffer.from([0x7b, 0xff, 0x7d]));
    expect(cli(...base("validate", "bad-utf8.json")).stderr).toContain("is not valid UTF-8");
  });
});

describe("isolation and offline behaviour", () => {
  it("business commands are handed unchanged to the existing business CLI", () => {
    writeDemo(root);
    const args = ["compare", "--data-root", root, "--repo-root", REPO, "--opportunity", DEMO_OPPORTUNITY, "--previous", DEMO_INITIAL, "--current", DEMO_LATER];
    let expected = "";
    expect(runBusinessCli(args, { out: (t) => { expected += t; }, err: () => {} })).toBe(0);
    const r = cli(...args);
    expect(r).toEqual({ code: 0, stdout: expected, stderr: "" });
    expect(r.stdout.startsWith(BUSINESS_BANNER)).toBe(true);
    expect(r.stdout).not.toContain(TRADING_BANNER.trim());
    expect(cli(...base("validate")).stdout).not.toContain(BUSINESS_BANNER.trim());
  });

  it("trading commands write nothing, open files read-only, and make no network, process or environment call", () => {
    const calls: string[] = [];
    const block = (obj: any, name: string, label: string) => {
      if (typeof obj[name] === "function") vi.spyOn(obj, name).mockImplementation(((..._a: unknown[]) => { calls.push(label); throw new Error(`${label} called`); }) as any);
    };
    for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "renameSync", "unlinkSync", "copyFileSync", "symlinkSync", "chmodSync", "writeSync", "writeFile"]) block(fs, name, `fs.${name}`);
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "fork"]) block(childProcess, name, `child_process.${name}`);
    block(net, "connect", "net.connect"); block(http, "request", "http.request"); block(https, "request", "https.request"); block(globalThis, "fetch", "fetch");
    const realOpen = fs.openSync;
    const flags: number[] = [];
    vi.spyOn(fs, "openSync").mockImplementation(((file: any, f: any, ...rest: any[]) => { flags.push(f); return (realOpen as any)(file, f, ...rest); }) as any);
    const realEnv = process.env;
    process.env = new Proxy(realEnv, { get: (t, k) => { if (typeof k === "string") calls.push(`env.${k}`); return Reflect.get(t, k); } }) as NodeJS.ProcessEnv;
    let codes: number[];
    try {
      codes = [cli(...base("validate")).code, cli(...base("backtest"), ...US_SETTINGS).code, cli(...base("paper"), ...US_SETTINGS).code];
    } finally {
      process.env = realEnv;
    }
    expect(codes).toEqual([0, 0, 0]);
    expect(calls).toEqual([]);
    expect(flags.length).toBe(3);
    expect(flags.every((f) => f === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK))).toBe(true);
  });

  it("an unexpected internal error gives exit 3 with details withheld", () => {
    let stderr = "";
    const code = runResearchCli([...base("validate")], { out: () => { throw new Error(`boom ${root}`); }, err: (t) => { stderr += t; } });
    expect([code, stderr]).toEqual([EXIT.internal, "Internal error (details withheld).\n"]);
  });
});
