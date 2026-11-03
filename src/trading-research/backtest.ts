/**
 * Long-or-flat backtest (trading research T2). Pure and deterministic: no
 * I/O, clock or randomness. Fictional, operator-supplied data only; results
 * are hypothetical and say nothing about future performance.
 *
 * Execution:
 * - After bar t closes the strategy decides "long" or "flat" from bars 0..t
 *   only. A change of position is executed at the OPEN of bar t+1, never
 *   earlier. A decision on the last bar cannot be executed and is reported.
 * - Buy fill = open x (1 + slippage) + half that bar's spread; sell fill =
 *   open x (1 - slippage) - half the spread. A sell fill at or below zero is
 *   rejected. Slippage (basis points) is required in the config; the spread
 *   and fees come from the dataset. Nothing is defaulted.
 * - Fees per order: the fixed fee plus the proportional fee on the traded
 *   value (rounded UP to 1e-18 of the price unit; nothing else is rounded).
 * - Sizing: "fixed_units" (that many whole units, or the order is rejected
 *   if cash does not cover cost and fees) or "all_cash" (the most whole units
 *   cash covers, including fees). Units are shares, or units of the base
 *   currency for forex (paid in full in the quote currency: no margin).
 * - No short selling, leverage or borrowing: cash never goes negative. A
 *   sell whose fees would exceed the cash available is rejected and the
 *   position is kept. Rejected orders leave the position unchanged; the
 *   strategy's next decision may retry.
 * The execution and accounting rules live in execution.ts (Account), shared
 * with the paper-trading simulator, so both use one execution model.
 * Accounting:
 * - Money is exact: integers scaled by 10^18 in the instrument's PRICE unit
 *   (USD, GBP, GBX pence, or the forex quote currency). Initial cash and
 *   fees are given in the ACCOUNTING currency (USD, GBP for GBP- or
 *   GBX-priced UK stocks, the forex quote currency) and converted exactly
 *   (1 GBP = 100 GBX). Reported amounts are in the accounting currency.
 *   Forex is never converted to another currency.
 * - Equity at each close = cash + units x close (mid). Realised P&L of a
 *   round trip = sale proceeds after fees - purchase cost including fees.
 *   An open position at the end is valued at the last close (mid) as
 *   unrealised P&L; its exit spread, slippage and fees are NOT deducted.
 * - Metrics use the equity curve: total return, maximum drawdown,
 *   annualised volatility (as in metrics.ts, with the dataset's stated
 *   periodsPerYear), exposure, trades and costs. Too little data gives
 *   status "insufficient_data" and no figures.
 */

import { datasetSha256, type Dataset, type DatasetHeader } from "./dataset.js";
import { Account, type BacktestMetrics, type EquityPoint, type Fill, type Rejection } from "./execution.js";
import { historyView, readStrategy, type Signal, type Strategy } from "./strategy.js";
import {
  Issues, ValidationError, parseJsonText, readDecimal, readObject, readOneOf, readSafeInt, type Decimal,
} from "./validation.js";

export const MAX_SLIPPAGE_BPS = 1_000;
export const MAX_CONFIG_CHARS = 10_000;

/** Validated run settings, shared by the backtester and the paper-trading simulator. */
export interface BacktestConfig {
  readonly version: 1;
  readonly strategy: Strategy;
  readonly execution: "next_bar_open";
  readonly initialCash: { readonly currency: string; readonly amount: string };
  readonly sizing: { readonly mode: "fixed_units"; readonly units: number } | { readonly mode: "all_cash" };
  readonly slippageBps: string;
  readonly initialCashDecimal: Decimal;
  readonly slippageDecimal: Decimal;
}

export interface BacktestResult {
  readonly status: "ok" | "insufficient_data";
  readonly reason: string | null;
  readonly datasetId: string;
  readonly datasetSha256: string;
  readonly symbol: string;
  readonly priceUnit: string;
  readonly accountingCurrency: string;
  readonly strategy: { readonly kind: string; readonly params: Readonly<Record<string, number>> };
  readonly sizing: BacktestConfig["sizing"];
  readonly slippageBps: string;
  readonly fills: readonly Fill[];
  readonly rejections: readonly Rejection[];
  readonly equity: readonly EquityPoint[];
  readonly metrics: BacktestMetrics | null;
  /** Units still held after the last bar (valued at the last close). */
  readonly endUnits: number;
  /** The decision on the last bar, which no later bar could execute. */
  readonly unexecutedFinalSignal: Signal | null;
}

/** Validates a run configuration against the dataset (or paper-session header) instrument. Throws ValidationError. */
export function parseBacktestConfig(raw: unknown, ds: DatasetHeader): BacktestConfig {
  const issues = new Issues();
  const o = readObject(issues, "config", raw, ["version", "strategy", "execution", "initialCash", "sizing", "slippageBps"]);
  issues.throwIfAny();
  const c = o!;
  if (c.version !== 1) issues.add("config.version", "must be 1");
  const strategy = readStrategy(issues, "config.strategy", c.strategy);
  const execution = readOneOf(issues, "config.execution", c.execution, ["next_bar_open"] as const);
  const cash = readObject(issues, "config.initialCash", c.initialCash, ["currency", "amount"]);
  let cashDecimal: Decimal | null = null;
  if (cash !== null) {
    if (cash.currency !== ds.instrument.accountingCurrency) issues.add("config.initialCash.currency", `must be ${ds.instrument.accountingCurrency} for this instrument`);
    cashDecimal = readDecimal(issues, "config.initialCash.amount", cash.amount);
    if (cashDecimal !== null && (cashDecimal.units === 0n || cashDecimal.scale > 2)) issues.add("config.initialCash.amount", "must be greater than zero with at most 2 decimal places");
  }
  const sizingRaw = readObject(issues, "config.sizing", c.sizing, ["mode"], ["units"]);
  let sizing: BacktestConfig["sizing"] = { mode: "all_cash" };
  if (sizingRaw !== null) {
    const mode = readOneOf(issues, "config.sizing.mode", sizingRaw.mode, ["fixed_units", "all_cash"] as const);
    if (mode === "fixed_units") {
      if (!("units" in sizingRaw)) issues.add("config.sizing.units", "is required for fixed_units");
      else sizing = { mode, units: readSafeInt(issues, "config.sizing.units", sizingRaw.units, { min: 1, max: 1_000_000_000 }) };
    } else if ("units" in sizingRaw) issues.add("config.sizing.units", "must not be given for all_cash");
  }
  const slip = readDecimal(issues, "config.slippageBps", c.slippageBps);
  if (slip !== null && (slip.scale > 2 || slip.units > BigInt(MAX_SLIPPAGE_BPS) * 10n ** BigInt(slip.scale))) {
    issues.add("config.slippageBps", `must be at most ${MAX_SLIPPAGE_BPS} with at most 2 decimal places (write "0" for none)`);
  }
  issues.throwIfAny();
  return Object.freeze({
    version: 1, strategy: strategy!, execution, initialCash: Object.freeze({ currency: ds.instrument.accountingCurrency, amount: cash!.amount as string }),
    sizing: Object.freeze(sizing), slippageBps: c.slippageBps as string, initialCashDecimal: cashDecimal!, slippageDecimal: slip!,
  }) as BacktestConfig;
}

/** Parses backtest configuration JSON text (size-checked, duplicate keys refused). */
export function parseBacktestConfigText(text: unknown, ds: DatasetHeader): BacktestConfig {
  return parseBacktestConfig(parseJsonText(text, "config", MAX_CONFIG_CHARS), ds);
}

/** Runs a long-or-flat backtest of a validated dataset with a validated config. */
export function runBacktest(ds: Dataset, config: BacktestConfig): BacktestResult {
  const inst = ds.instrument;
  const bars = ds.bars;
  const base = {
    datasetId: ds.id, datasetSha256: datasetSha256(ds), symbol: inst.symbol, priceUnit: inst.priceUnit, accountingCurrency: inst.accountingCurrency,
    strategy: Object.freeze({ kind: config.strategy.kind, params: config.strategy.params }), sizing: config.sizing, slippageBps: config.slippageBps,
  };
  if (bars.length < config.strategy.warmupBars + 1) {
    return Object.freeze({
      ...base, status: "insufficient_data", reason: `needs at least ${config.strategy.warmupBars + 1} bars (${config.strategy.warmupBars} to decide, then one to execute); the dataset has ${bars.length}`,
      fills: [], rejections: [], equity: [], metrics: null, endUnits: 0, unexecutedFinalSignal: null,
    });
  }

  const account = new Account(ds, config);
  let pending: Signal = "flat";
  let pendingFrom = -1;
  let unexecutedFinalSignal: Signal | null = null;
  for (let t = 0; t < bars.length; t++) {
    if (pendingFrom >= 0) account.execute(pending, pendingFrom, t, bars[t]);
    account.mark(bars[t]);
    const signal = config.strategy.decide(historyView(bars, t));
    if (signal !== "long" && signal !== "flat") throw new RangeError("strategy returned an invalid signal");
    if (t === bars.length - 1) {
      if (signal !== account.position) unexecutedFinalSignal = signal;
    } else {
      pending = signal;
      pendingFrom = t;
    }
  }
  return Object.freeze({
    ...base, status: "ok", reason: null, fills: Object.freeze([...account.fills]), rejections: Object.freeze([...account.rejections]),
    equity: Object.freeze([...account.equity]), metrics: account.metrics(), endUnits: Number(account.units), unexecutedFinalSignal,
  });
}

/** Convenience: validate the config text, then run. Throws ValidationError for invalid input. */
export function backtestFromText(ds: Dataset, configText: unknown): BacktestResult {
  if (!ds || !Array.isArray(ds.bars)) throw new ValidationError(["backtest: needs a validated dataset"]);
  return runBacktest(ds, parseBacktestConfigText(configText, ds));
}
