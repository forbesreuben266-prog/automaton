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

import { datasetSha256, type Dataset } from "./dataset.js";
import { MIN_VOLATILITY_RETURNS, round, type Metric } from "./metrics.js";
import { historyView, readStrategy, type Signal, type Strategy } from "./strategy.js";
import {
  Issues, ValidationError, parseJsonText, readDecimal, readObject, readOneOf, readSafeInt, type Decimal,
} from "./validation.js";

const DIGITS = 18;
const SCALE = 10n ** BigInt(DIGITS);
export const MAX_SLIPPAGE_BPS = 1_000;
export const MAX_CONFIG_CHARS = 10_000;

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

export interface Fill {
  readonly side: "buy" | "sell";
  readonly decisionIndex: number;
  readonly fillIndex: number;
  readonly fillTime: string;
  readonly units: number;
  /** Prices are in the instrument's price unit; amounts in the accounting currency. */
  readonly openPrice: string;
  readonly fillPrice: string;
  readonly fees: string;
  readonly spreadCost: string;
  readonly slippageCost: string;
  readonly cashAfter: string;
  /** Sells only: proceeds after fees minus the purchase cost including fees. */
  readonly realizedPnl: string | null;
}

export interface Rejection {
  readonly side: "buy" | "sell";
  readonly decisionIndex: number;
  readonly fillIndex: number;
  readonly fillTime: string;
  readonly reason: string;
}

export interface EquityPoint {
  readonly t: string;
  readonly units: number;
  readonly cash: string;
  readonly equity: string;
}

export interface BacktestMetrics {
  readonly initialEquity: string;
  readonly finalEquity: string;
  readonly totalReturn: number;
  readonly maxDrawdown: number;
  readonly annualizedVolatility: Metric<number>;
  /** Fraction of closes with a position. */
  readonly exposure: number;
  readonly fills: number;
  readonly rejections: number;
  readonly roundTrips: number;
  readonly winningRoundTrips: number;
  readonly realizedPnl: string;
  readonly unrealizedPnl: string;
  readonly totalFees: string;
  readonly totalSpreadCost: string;
  readonly totalSlippageCost: string;
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

/** Validates a backtest configuration against the dataset's instrument. Throws ValidationError. */
export function parseBacktestConfig(raw: unknown, ds: Dataset): BacktestConfig {
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
export function parseBacktestConfigText(text: unknown, ds: Dataset): BacktestConfig {
  return parseBacktestConfig(parseJsonText(text, "config", MAX_CONFIG_CHARS), ds);
}

const scaledOf = (d: Decimal) => d.units * 10n ** BigInt(DIGITS - d.scale);
const ceilDiv = (a: bigint, b: bigint) => (a % b === 0n ? a / b : a / b + 1n);

/** Exact decimal text of a scaled amount, with `shift` extra decimal places (2 to show GBX amounts in GBP). */
function formatScaled(v: bigint, shift: number): string {
  const negative = v < 0n;
  const digits = (negative ? -v : v).toString().padStart(DIGITS + shift + 1, "0");
  const point = digits.length - (DIGITS + shift);
  const fraction = digits.slice(point).replace(/0+$/, "");
  return `${negative ? "-" : ""}${digits.slice(0, point)}${fraction ? `.${fraction}` : ""}`;
}

const toNumber = (v: bigint): number => {
  const n = Number(v) / Number(SCALE);
  if (!Number.isFinite(n)) throw new RangeError("backtest calculation produced a non-finite value");
  return n;
};

function drawdown(values: readonly number[]): number {
  let peak = values[0];
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, v / peak - 1);
  }
  return round(worst);
}

function volatility(values: readonly number[], periodsPerYear: number): Metric<number> {
  const n = values.length - 1;
  if (n < MIN_VOLATILITY_RETURNS) {
    return { status: "insufficient_data", required: MIN_VOLATILITY_RETURNS + 1, available: values.length, reason: `volatility needs at least ${MIN_VOLATILITY_RETURNS} returns` };
  }
  if (values.some((v) => v <= 0)) return { status: "insufficient_data", required: 1, available: 0, reason: "equity reached zero, so log returns are undefined" };
  const logs = values.slice(1).map((v, i) => Math.log(v / values[i]));
  const mean = logs.reduce((s, x) => s + x, 0) / n;
  const variance = logs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { status: "ok", value: round(Math.sqrt(variance) * Math.sqrt(periodsPerYear)) };
}

/** Runs a long-or-flat backtest of a validated dataset with a validated config. */
export function runBacktest(ds: Dataset, config: BacktestConfig): BacktestResult {
  const inst = ds.instrument;
  const shift = inst.priceUnit === "GBX" ? 2 : 0; // price unit -> accounting currency (pence -> pounds)
  const toPriceUnit = (accounting: bigint) => (shift === 2 ? accounting * 100n : accounting);
  const show = (priceUnitAmount: bigint) => formatScaled(priceUnitAmount, shift);
  const tick = scaledOf(inst.tick);
  const price = (ticks: number) => BigInt(ticks) * tick;
  const slip = config.slippageDecimal;
  const slipDivisor = 10n ** BigInt(slip.scale + 4);
  const feeBps = ds.costs.feeProportionalBpsDecimal;
  const feeDivisor = 10n ** BigInt(feeBps.scale + 4);
  const fixedFee = toPriceUnit(scaledOf(ds.costs.feePerOrderDecimal));
  const fee = (value: bigint) => fixedFee + ceilDiv(value * feeBps.units, feeDivisor);
  const initialCash = toPriceUnit(scaledOf(config.initialCashDecimal));
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

  let cash = initialCash;
  let units = 0n;
  let costBasis = 0n;
  let pending: Signal = "flat";
  let pendingFrom = -1;
  let realized = 0n;
  let fees = 0n;
  let spreadCost = 0n;
  let slippageCost = 0n;
  let roundTrips = 0;
  let wins = 0;
  let barsInMarket = 0;
  const fills: Fill[] = [];
  const rejections: Rejection[] = [];
  const equity: EquityPoint[] = [];
  const equityValues: number[] = [];
  let unexecutedFinalSignal: Signal | null = null;

  for (let t = 0; t < bars.length; t++) {
    const bar = bars[t];
    const want = pending === "long" ? 1 : 0;
    const have = units > 0n ? 1 : 0;
    if (pendingFrom >= 0 && want !== have) {
      const open = price(bar.open);
      const half = price(bar.spread) / 2n; // exact: the scale is even
      const slipAmount = (open * slip.units) / slipDivisor; // exact: prices have at most 8 decimals, the scale 18
      const reject = (side: "buy" | "sell", reason: string) => rejections.push(Object.freeze({ side, decisionIndex: pendingFrom, fillIndex: t, fillTime: bar.t, reason }));
      if (want === 1) {
        const fill = open + slipAmount + half;
        let qty: bigint;
        if (config.sizing.mode === "fixed_units") qty = BigInt(config.sizing.units);
        else {
          qty = cash > fixedFee ? ((cash - fixedFee) * feeDivisor) / (fill * (feeDivisor + feeBps.units)) : 0n;
          while (qty > 0n && qty * fill + fee(qty * fill) > cash) qty -= 1n; // proportional-fee rounding
        }
        const cost = qty * fill + fee(qty * fill);
        if (qty < 1n) reject("buy", "cash does not cover one unit plus fees");
        else if (qty > BigInt(Number.MAX_SAFE_INTEGER)) reject("buy", "position size exceeds the supported range");
        else if (cost > cash) reject("buy", `insufficient cash for ${qty} units including fees`);
        else {
          const orderFee = cost - qty * fill;
          cash -= cost;
          units = qty;
          costBasis = cost;
          fees += orderFee;
          spreadCost += qty * half;
          slippageCost += qty * slipAmount;
          fills.push(Object.freeze({
            side: "buy", decisionIndex: pendingFrom, fillIndex: t, fillTime: bar.t, units: Number(qty), openPrice: formatScaled(open, 0), fillPrice: formatScaled(fill, 0),
            fees: show(orderFee), spreadCost: show(qty * half), slippageCost: show(qty * slipAmount), cashAfter: show(cash), realizedPnl: null,
          }));
        }
      } else {
        const fill = open - slipAmount - half;
        const proceeds = units * fill;
        const orderFee = fee(proceeds > 0n ? proceeds : 0n);
        if (fill <= 0n) reject("sell", "the spread and slippage would make the sale price zero or negative");
        else if (cash + proceeds - orderFee < 0n) reject("sell", "fees would exceed the cash available (no negative cash)");
        else {
          const net = proceeds - orderFee;
          const pnl = net - costBasis;
          cash += net;
          realized += pnl;
          fees += orderFee;
          spreadCost += units * half;
          slippageCost += units * slipAmount;
          roundTrips += 1;
          if (pnl > 0n) wins += 1;
          fills.push(Object.freeze({
            side: "sell", decisionIndex: pendingFrom, fillIndex: t, fillTime: bar.t, units: Number(units), openPrice: formatScaled(open, 0), fillPrice: formatScaled(fill, 0),
            fees: show(orderFee), spreadCost: show(units * half), slippageCost: show(units * slipAmount), cashAfter: show(cash), realizedPnl: show(pnl),
          }));
          units = 0n;
          costBasis = 0n;
        }
      }
    }
    if (cash < 0n) throw new RangeError("backtest invariant broken: negative cash");
    const value = cash + units * price(bar.close);
    if (units > 0n) barsInMarket += 1;
    equity.push(Object.freeze({ t: bar.t, units: Number(units), cash: show(cash), equity: show(value) }));
    equityValues.push(toNumber(value));

    const signal = config.strategy.decide(historyView(bars, t));
    if (signal !== "long" && signal !== "flat") throw new RangeError("strategy returned an invalid signal");
    if (t === bars.length - 1) {
      if ((signal === "long" ? 1 : 0) !== (units > 0n ? 1 : 0)) unexecutedFinalSignal = signal;
    } else {
      pending = signal;
      pendingFrom = t;
    }
  }

  const last = bars[bars.length - 1];
  const finalValue = cash + units * price(last.close);
  const unrealized = units > 0n ? units * price(last.close) - costBasis : 0n;
  const initialNumber = toNumber(initialCash);
  const metrics: BacktestMetrics = Object.freeze({
    initialEquity: show(initialCash), finalEquity: show(finalValue),
    totalReturn: round(toNumber(finalValue) / initialNumber - 1), maxDrawdown: drawdown([initialNumber, ...equityValues]),
    annualizedVolatility: volatility(equityValues, ds.annualization.periodsPerYear), exposure: round(barsInMarket / bars.length),
    fills: fills.length, rejections: rejections.length, roundTrips, winningRoundTrips: wins, realizedPnl: show(realized), unrealizedPnl: show(unrealized),
    totalFees: show(fees), totalSpreadCost: show(spreadCost), totalSlippageCost: show(slippageCost),
  });
  return Object.freeze({
    ...base, status: "ok", reason: null, fills: Object.freeze(fills), rejections: Object.freeze(rejections), equity: Object.freeze(equity), metrics,
    endUnits: Number(units), unexecutedFinalSignal,
  });
}

/** Convenience: validate the config text, then run. Throws ValidationError for invalid input. */
export function backtestFromText(ds: Dataset, configText: unknown): BacktestResult {
  if (!ds || !Array.isArray(ds.bars)) throw new ValidationError(["backtest: needs a validated dataset"]);
  return runBacktest(ds, parseBacktestConfigText(configText, ds));
}
