/**
 * Shared execution and accounting rules (trading research T2/T3). Used by
 * both the historical backtester (backtest.ts) and the paper-trading
 * simulator (paper.ts), so there is exactly one execution model. Pure and
 * deterministic: no I/O, clock or randomness.
 *
 * Rules (see backtest.ts for the full description):
 * - an order decided after bar t closes is attempted at the OPEN of a later
 *   bar (the caller passes that bar); buy fill = open x (1 + slippage) +
 *   half the bar's spread, sell fill = open x (1 - slippage) - half spread;
 * - fees = fixed fee + proportional fee on traded value (rounded up to
 *   1e-18 of the price unit);
 * - sizing "fixed_units" or "all_cash"; long or flat only; no borrowing,
 *   leverage, short selling or negative cash; failed orders are rejections;
 * - money is exact: integers scaled by 10^18 in the instrument's price unit;
 *   initial cash and fees in the accounting currency are converted exactly
 *   (1 GBP = 100 GBX); amounts are reported in the accounting currency.
 */

import type { BacktestConfig } from "./backtest.js";
import type { DatasetHeader } from "./dataset.js";
import { MIN_VOLATILITY_RETURNS, round, type Metric } from "./metrics.js";
import type { Bar } from "./prices.js";
import type { Signal } from "./strategy.js";
import type { Decimal } from "./validation.js";

const DIGITS = 18;
const SCALE = 10n ** BigInt(DIGITS);

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

export type ExecutionOutcome = { readonly kind: "filled"; readonly fill: Fill } | { readonly kind: "rejected"; readonly rejection: Rejection };

const scaledOf = (d: Decimal) => d.units * 10n ** BigInt(DIGITS - d.scale);
const ceilDiv = (a: bigint, b: bigint) => (a % b === 0n ? a / b : a / b + 1n);

/** Exact decimal text of a scaled amount, with `shift` extra decimal places (2 to show GBX amounts in GBP). */
export function formatScaled(v: bigint, shift: number): string {
  const negative = v < 0n;
  const digits = (negative ? -v : v).toString().padStart(DIGITS + shift + 1, "0");
  const point = digits.length - (DIGITS + shift);
  const fraction = digits.slice(point).replace(/0+$/, "");
  return `${negative ? "-" : ""}${digits.slice(0, point)}${fraction ? `.${fraction}` : ""}`;
}

const toNumber = (v: bigint): number => {
  const n = Number(v) / Number(SCALE);
  if (!Number.isFinite(n)) throw new RangeError("calculation produced a non-finite value");
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

/**
 * A single long-or-flat cash account for one instrument. execute() attempts
 * an order at a bar's open; mark() values the account at that bar's close.
 * State only changes through these two methods; recorded fills, rejections
 * and equity points are frozen and only ever appended.
 */
export class Account {
  private readonly shift: number;
  private readonly tick: bigint;
  private readonly slip: Decimal;
  private readonly slipDivisor: bigint;
  private readonly feeBps: Decimal;
  private readonly feeDivisor: bigint;
  private readonly fixedFee: bigint;
  readonly initialCash: bigint;
  cash: bigint;
  units = 0n;
  private costBasis = 0n;
  private realized = 0n;
  private fees = 0n;
  private spreadCost = 0n;
  private slippageCost = 0n;
  private roundTrips = 0;
  private wins = 0;
  private barsInMarket = 0;
  private lastClose = 0n;
  readonly fills: Fill[] = [];
  readonly rejections: Rejection[] = [];
  readonly equity: EquityPoint[] = [];
  private readonly equityValues: number[] = [];

  constructor(private readonly header: DatasetHeader, private readonly config: BacktestConfig) {
    this.shift = header.instrument.priceUnit === "GBX" ? 2 : 0;
    this.tick = scaledOf(header.instrument.tick);
    this.slip = config.slippageDecimal;
    this.slipDivisor = 10n ** BigInt(this.slip.scale + 4);
    this.feeBps = header.costs.feeProportionalBpsDecimal;
    this.feeDivisor = 10n ** BigInt(this.feeBps.scale + 4);
    this.fixedFee = this.toPriceUnit(scaledOf(header.costs.feePerOrderDecimal));
    this.initialCash = this.toPriceUnit(scaledOf(config.initialCashDecimal));
    this.cash = this.initialCash;
  }

  private toPriceUnit(accounting: bigint): bigint { return this.shift === 2 ? accounting * 100n : accounting; }
  /** An amount in the price unit, shown in the accounting currency. */
  show(priceUnitAmount: bigint): string { return formatScaled(priceUnitAmount, this.shift); }
  private price(ticks: number): bigint { return BigInt(ticks) * this.tick; }
  private fee(value: bigint): bigint { return this.fixedFee + ceilDiv(value * this.feeBps.units, this.feeDivisor); }
  get position(): Signal { return this.units > 0n ? "long" : "flat"; }

  /** Attempts to move to `target` at `bar`'s open (an order decided after bar `decisionIndex` closed). */
  execute(target: Signal, decisionIndex: number, fillIndex: number, bar: Bar): ExecutionOutcome | null {
    if (target === this.position) return null;
    if (fillIndex <= decisionIndex) throw new RangeError("an order must fill on a later bar than its decision (no same-bar fills)");
    const open = this.price(bar.open);
    const half = this.price(bar.spread) / 2n; // exact: the scale is even
    const slipAmount = (open * this.slip.units) / this.slipDivisor; // exact: prices have at most 8 decimals, the scale 18
    const reject = (side: "buy" | "sell", reason: string): ExecutionOutcome => {
      const rejection = Object.freeze({ side, decisionIndex, fillIndex, fillTime: bar.t, reason });
      this.rejections.push(rejection);
      return { kind: "rejected", rejection };
    };
    if (target === "long") {
      const fill = open + slipAmount + half;
      let qty: bigint;
      if (this.config.sizing.mode === "fixed_units") qty = BigInt(this.config.sizing.units);
      else {
        qty = this.cash > this.fixedFee ? ((this.cash - this.fixedFee) * this.feeDivisor) / (fill * (this.feeDivisor + this.feeBps.units)) : 0n;
        while (qty > 0n && qty * fill + this.fee(qty * fill) > this.cash) qty -= 1n; // proportional-fee rounding
      }
      const cost = qty * fill + this.fee(qty * fill);
      if (qty < 1n) return reject("buy", "cash does not cover one unit plus fees");
      if (qty > BigInt(Number.MAX_SAFE_INTEGER)) return reject("buy", "position size exceeds the supported range");
      if (cost > this.cash) return reject("buy", `insufficient cash for ${qty} units including fees`);
      const orderFee = cost - qty * fill;
      this.cash -= cost;
      this.units = qty;
      this.costBasis = cost;
      this.fees += orderFee;
      this.spreadCost += qty * half;
      this.slippageCost += qty * slipAmount;
      const f = Object.freeze({
        side: "buy" as const, decisionIndex, fillIndex, fillTime: bar.t, units: Number(qty), openPrice: formatScaled(open, 0), fillPrice: formatScaled(fill, 0),
        fees: this.show(orderFee), spreadCost: this.show(qty * half), slippageCost: this.show(qty * slipAmount), cashAfter: this.show(this.cash), realizedPnl: null,
      });
      this.fills.push(f);
      return { kind: "filled", fill: f };
    }
    const fill = open - slipAmount - half;
    const proceeds = this.units * fill;
    const orderFee = this.fee(proceeds > 0n ? proceeds : 0n);
    if (fill <= 0n) return reject("sell", "the spread and slippage would make the sale price zero or negative");
    if (this.cash + proceeds - orderFee < 0n) return reject("sell", "fees would exceed the cash available (no negative cash)");
    const net = proceeds - orderFee;
    const pnl = net - this.costBasis;
    this.cash += net;
    this.realized += pnl;
    this.fees += orderFee;
    this.spreadCost += this.units * half;
    this.slippageCost += this.units * slipAmount;
    this.roundTrips += 1;
    if (pnl > 0n) this.wins += 1;
    const f = Object.freeze({
      side: "sell" as const, decisionIndex, fillIndex, fillTime: bar.t, units: Number(this.units), openPrice: formatScaled(open, 0), fillPrice: formatScaled(fill, 0),
      fees: this.show(orderFee), spreadCost: this.show(this.units * half), slippageCost: this.show(this.units * slipAmount), cashAfter: this.show(this.cash), realizedPnl: this.show(pnl),
    });
    this.fills.push(f);
    this.units = 0n;
    this.costBasis = 0n;
    return { kind: "filled", fill: f };
  }

  /** Values the account at `bar`'s close (mid) and records the equity point. */
  mark(bar: Bar): EquityPoint {
    if (this.cash < 0n) throw new RangeError("account invariant broken: negative cash");
    this.lastClose = this.price(bar.close);
    const value = this.cash + this.units * this.lastClose;
    if (this.units > 0n) this.barsInMarket += 1;
    const point = Object.freeze({ t: bar.t, units: Number(this.units), cash: this.show(this.cash), equity: this.show(value) });
    this.equity.push(point);
    this.equityValues.push(toNumber(value));
    return point;
  }

  /** Unrealised P&L of the open position at the last marked close (mid), exit costs not deducted. */
  unrealized(): bigint { return this.units > 0n ? this.units * this.lastClose - this.costBasis : 0n; }

  /** Metrics over the equity points marked so far (at least one). */
  metrics(): BacktestMetrics {
    if (this.equity.length === 0) throw new RangeError("metrics need at least one marked bar");
    const finalValue = this.cash + this.units * this.lastClose;
    const initialNumber = toNumber(this.initialCash);
    return Object.freeze({
      initialEquity: this.show(this.initialCash), finalEquity: this.show(finalValue),
      totalReturn: round(toNumber(finalValue) / initialNumber - 1), maxDrawdown: drawdown([initialNumber, ...this.equityValues]),
      annualizedVolatility: volatility(this.equityValues, this.header.annualization.periodsPerYear), exposure: round(this.barsInMarket / this.equity.length),
      fills: this.fills.length, rejections: this.rejections.length, roundTrips: this.roundTrips, winningRoundTrips: this.wins,
      realizedPnl: this.show(this.realized), unrealizedPnl: this.show(this.unrealized()),
      totalFees: this.show(this.fees), totalSpreadCost: this.show(this.spreadCost), totalSlippageCost: this.show(this.slippageCost),
    });
  }
}
