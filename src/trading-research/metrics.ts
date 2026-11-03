/**
 * Deterministic price metrics (trading research T1). Pure: no I/O, clock or
 * randomness. Inputs are closing prices in integer ticks (all positive safe
 * integers), so the tick size cancels out of every ratio below.
 *
 * Assumptions (stated, not hidden):
 * - Returns are close-to-close. totalReturn = last / first - 1 (simple).
 * - Volatility uses log returns ln(c[i] / c[i-1]), their SAMPLE standard
 *   deviation (n - 1), multiplied by sqrt(periodsPerYear). periodsPerYear
 *   comes from the dataset (the operator's statement for that market); no
 *   calendar is assumed, and gaps in the data (holidays, missing days) are
 *   treated as consecutive bars.
 * - Maximum drawdown is the largest fall from a running peak close to a
 *   later close, as a negative fraction (0 = never below a prior peak), with
 *   the peak and trough positions, its length in bars and the recovery
 *   position (the first later close at or above the peak), or null.
 * - Risk/reward (long only in T1): risk = entry - stop, reward = target -
 *   entry, in ticks (exact); ratio = reward / risk.
 * - Results are rounded to 10 decimal places so they compare exactly across
 *   runs; any non-finite intermediate value throws.
 * - Too little data gives { status: "insufficient_data" } with the counts,
 *   never a figure: at least 2 closes for returns and drawdown, and at least
 *   MIN_VOLATILITY_RETURNS returns for volatility.
 * These are descriptive statistics of the supplied (fictional) prices: not a
 * forecast, and not evidence that any strategy works.
 */

import type { Dataset } from "./dataset.js";
import type { Instrument } from "./instruments.js";
import { Issues, ValidationError, readTicks } from "./validation.js";

/** Fewer returns than this give no volatility figure (a smaller sample is too noisy to report). */
export const MIN_VOLATILITY_RETURNS = 20;
const DECIMALS = 10;

export type Metric<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "insufficient_data"; readonly required: number; readonly available: number; readonly reason: string };

export interface Drawdown {
  /** Largest peak-to-trough fall as a negative fraction (0 when the price never fell below a prior peak). */
  readonly maxDrawdown: number;
  readonly peakIndex: number;
  readonly troughIndex: number;
  /** Bars from the peak to the trough. */
  readonly lengthBars: number;
  /** First index after the trough with a close at or above the peak, or null if not recovered within the data. */
  readonly recoveryIndex: number | null;
}

export interface RiskReward {
  readonly riskTicks: number;
  readonly rewardTicks: number;
  readonly ratio: number;
}

/** Rounds to DECIMALS places; refuses non-finite values. */
export function round(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError("metric calculation produced a non-finite value");
  const r = Number(x.toFixed(DECIMALS));
  return Object.is(r, -0) ? 0 : r;
}

function checkCloses(closes: readonly number[]): void {
  if (!Array.isArray(closes) || closes.some((c) => typeof c !== "number" || !Number.isSafeInteger(c) || c <= 0)) {
    throw new RangeError("closes must be an array of positive safe-integer tick values");
  }
}

const insufficient = (required: number, available: number, reason: string): Metric<never> =>
  Object.freeze({ status: "insufficient_data", required, available, reason });

/** Simple close-to-close returns, rounded. Length = closes.length - 1. */
export function simpleReturns(closes: readonly number[]): number[] {
  checkCloses(closes);
  return closes.slice(1).map((c, i) => round(c / closes[i] - 1));
}

export function totalReturn(closes: readonly number[]): Metric<number> {
  checkCloses(closes);
  if (closes.length < 2) return insufficient(2, closes.length, "a return needs at least two closes");
  return Object.freeze({ status: "ok", value: round(closes[closes.length - 1] / closes[0] - 1) });
}

export function annualizedVolatility(closes: readonly number[], periodsPerYear: number): Metric<number> {
  checkCloses(closes);
  if (!Number.isSafeInteger(periodsPerYear) || periodsPerYear < 1 || periodsPerYear > 366) throw new RangeError("periodsPerYear must be an integer from 1 to 366");
  const n = closes.length - 1;
  if (n < MIN_VOLATILITY_RETURNS) {
    return insufficient(MIN_VOLATILITY_RETURNS + 1, closes.length, `volatility needs at least ${MIN_VOLATILITY_RETURNS} returns (${MIN_VOLATILITY_RETURNS + 1} closes)`);
  }
  const logs = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = logs.reduce((s, x) => s + x, 0) / n;
  const variance = logs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return Object.freeze({ status: "ok", value: round(Math.sqrt(variance) * Math.sqrt(periodsPerYear)) });
}

export function maxDrawdown(closes: readonly number[]): Metric<Drawdown> {
  checkCloses(closes);
  if (closes.length < 2) return insufficient(2, closes.length, "a drawdown needs at least two closes");
  let peak = 0;
  let worst = 0;
  let worstPeak = 0;
  let worstTrough = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[peak]) peak = i;
    const dd = closes[i] / closes[peak] - 1;
    if (dd < worst) { worst = dd; worstPeak = peak; worstTrough = i; }
  }
  let recoveryIndex: number | null = null;
  if (worst < 0) {
    for (let i = worstTrough + 1; i < closes.length; i++) if (closes[i] >= closes[worstPeak]) { recoveryIndex = i; break; }
  }
  return Object.freeze({ status: "ok", value: Object.freeze({
    maxDrawdown: round(worst), peakIndex: worstPeak, troughIndex: worstTrough, lengthBars: worstTrough - worstPeak, recoveryIndex,
  }) });
}

/**
 * Risk/reward of a long idea with decimal entry, stop and target prices in
 * the instrument's price unit (each a whole multiple of its tick). Requires
 * stop < entry < target. Throws ValidationError otherwise.
 */
export function riskReward(instrument: Instrument, levels: { entry: unknown; stop: unknown; target: unknown }): RiskReward {
  const issues = new Issues();
  const ticks = (key: "entry" | "stop" | "target") => readTicks(issues, `riskReward.${key}`, levels?.[key], instrument.tick, { allowZero: false });
  const [entry, stop, target] = [ticks("entry"), ticks("stop"), ticks("target")];
  if (entry !== null && stop !== null && target !== null && !(stop < entry && entry < target)) {
    issues.add("riskReward", "a long idea needs stop < entry < target (short positions are not supported in T1)");
  }
  issues.throwIfAny();
  const riskTicks = entry! - stop!;
  const rewardTicks = target! - entry!;
  return Object.freeze({ riskTicks, rewardTicks, ratio: round(rewardTicks / riskTicks) });
}

export interface DatasetSummary {
  readonly datasetId: string;
  readonly symbol: string;
  readonly priceUnit: string;
  readonly bars: number;
  readonly firstBar: string;
  readonly lastBar: string;
  readonly periodsPerYear: number;
  readonly totalReturn: Metric<number>;
  readonly annualizedVolatility: Metric<number>;
  readonly maxDrawdown: Metric<Drawdown>;
  readonly notes: readonly string[];
}

/** Descriptive metrics of a validated dataset's closes, with the assumptions stated alongside. */
export function summarizeDataset(ds: Dataset): DatasetSummary {
  if (!ds || !Array.isArray(ds.bars) || ds.bars.length === 0) throw new ValidationError(["summary: needs a validated dataset"]);
  const closes = ds.bars.map((b) => b.close);
  const adjustmentNote = ds.adjustment === "not_applicable" ? "Forex prices: no corporate-action adjustment applies."
    : ds.adjustment === "none" ? "Prices are NOT adjusted for splits or dividends: such events appear as price jumps."
    : ds.adjustment === "splits" ? "Prices are adjusted for splits only (not dividends), as stated by the operator (not checked)."
    : "Prices are adjusted for splits and dividends, as stated by the operator (not checked).";
  return Object.freeze({
    datasetId: ds.id, symbol: ds.instrument.symbol, priceUnit: ds.instrument.priceUnit, bars: closes.length,
    firstBar: ds.bars[0].t, lastBar: ds.bars[ds.bars.length - 1].t, periodsPerYear: ds.annualization.periodsPerYear,
    totalReturn: totalReturn(closes),
    annualizedVolatility: annualizedVolatility(closes, ds.annualization.periodsPerYear),
    maxDrawdown: maxDrawdown(closes),
    notes: Object.freeze([
      "Fictional, operator-supplied data: descriptive statistics only, not a forecast or advice.",
      "Close-to-close figures from mid prices; spreads and fees are not deducted here.",
      `Annualised with ${ds.annualization.periodsPerYear} bars per year (operator-stated: ${ds.annualization.basis}); gaps count as consecutive bars.`,
      adjustmentNote,
      "Survivorship bias is not addressed.",
    ]),
  });
}
