/**
 * FICTIONAL end-to-end demonstration data for the offline research CLI (U2).
 * Everything here is invented: fictional organisations, reserved example
 * domains, made-up prices, spreads and fees. It does not represent real
 * demand, prices, profitability or market conditions.
 *
 * Writes into an EMPTY directory outside the repository (same destination
 * checks as the business demo helper: absolute, existing, empty, not a
 * symbolic link, real path outside the repository; files created
 * exclusively, never overwritten):
 *   dog-walking/...        business research: two runs (2026-10-15, 2026-10-20)
 *   fict-us-trend.json     US stock, USD, 30 daily bars (rise, fall, rise)
 *   fict-uk.json           UK stock priced in pence (GBX), per-bar spreads
 *   fict-eurusd.json       EURUSD forex pair, 21 daily bars
 *   run-us-ma.json         moving-average crossover, fixed units, USD cash
 *   run-uk.json            buy-and-hold, all cash, GBP cash
 *   run-eurusd.json        buy-and-hold, 10,000 EUR units, USD cash
 *
 * Usage:
 *   ./node_modules/.bin/tsx src/__tests__/research-cli/demo.ts /absolute/empty/dir
 * This is test tooling; the CLI itself never writes files.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDestination, writeDemo as writeBusinessDemo } from "../research-pipeline/cli-demo.js";
import { fxDataset, ukDataset, usDataset } from "../trading-research/fixtures.js";

const cents = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/** 30 fictional daily bars: +1.50 for 10 days, -2.00 for 8 days, +1.00 for 11 days (whole-cent arithmetic, no floating point). */
export function usTrendDataset(): any {
  const d = usDataset();
  const closes = [10000];
  for (let i = 0; i < 29; i++) closes.push(closes[i] + (i < 10 ? 150 : i < 18 ? -200 : 100));
  d.id = "fict-us-trend";
  d.title = "Fictional US stock: rise, fall, rise (demonstration)";
  d.bars = closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1];
    return {
      t: `2026-03-${String(i + 1).padStart(2, "0")}T21:00:00Z`, open: cents(open), high: cents(Math.max(open, c) + 25), low: cents(Math.min(open, c) - 25),
      close: cents(c), volume: String(1000 + i * 10),
    };
  });
  d.source = { ...d.source, recordedAt: "2026-04-01T00:00:00Z" };
  d.limitations = ["Invented trend for demonstration only."];
  return d;
}

export const DEMO_RUNS = {
  "run-us-ma.json": {
    version: 1, strategy: { kind: "ma_crossover", fast: 3, slow: 8 }, execution: "next_bar_open",
    initialCash: { currency: "USD", amount: "10000.00" }, sizing: { mode: "fixed_units", units: 50 }, slippageBps: "2",
  },
  "run-uk.json": {
    version: 1, strategy: { kind: "buy_and_hold" }, execution: "next_bar_open",
    initialCash: { currency: "GBP", amount: "1000.00" }, sizing: { mode: "all_cash" }, slippageBps: "0",
  },
  "run-eurusd.json": {
    version: 1, strategy: { kind: "buy_and_hold" }, execution: "next_bar_open",
    initialCash: { currency: "USD", amount: "20000.00" }, sizing: { mode: "fixed_units", units: 10000 }, slippageBps: "1",
  },
} as const;

/** Writes the whole demonstration into `root` (which the caller has checked is empty). */
export function writeFullDemo(root: string): void {
  writeBusinessDemo(root);
  const create = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  create("fict-us-trend.json", usTrendDataset());
  create("fict-uk.json", ukDataset());
  create("fict-eurusd.json", fxDataset());
  for (const [name, config] of Object.entries(DEMO_RUNS)) create(name, config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const checked = process.argv.length === 3 ? checkDestination(process.argv[2], repo) : { refused: "expected exactly one destination argument" };
  if ("refused" in checked) {
    process.stderr.write(`Refused: ${checked.refused}.\nUsage: demo.ts <existing empty absolute directory outside the repository>\n`);
    process.exitCode = 2;
  } else {
    try {
      writeFullDemo(checked.real);
      process.stdout.write("Wrote the fictional demonstration (business runs, three trading datasets and three run settings files).\n");
    } catch (err) {
      process.stderr.write(`Refused: the demonstration files could not be created (${(err as { code?: string })?.code ?? "error"}); no existing file was overwritten.\n`);
      process.exitCode = 1;
    }
  }
}
