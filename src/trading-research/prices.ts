/**
 * Price bars, spreads and fees (trading research T1). Pure and deterministic.
 *
 * Bars (daily, interval "1d"): { t, open, high, low, close, volume[, spread] }
 * - t: UTC timestamp of the bar's close ("YYYY-MM-DDTHH:MM:SSZ"); timestamps
 *   strictly increase and no two bars share a UTC date;
 * - prices: decimal strings, each a whole positive multiple of the
 *   instrument's tick size, converted exactly to integer ticks;
 *   low <= open, close <= high (so low <= high);
 * - volume: stocks: a whole number of shares as a decimal string (may be
 *   "0"); forex: must be null (no central volume);
 * - spread: present only when the dataset's spread mode is "per_bar".
 *
 * Costs (all required; nothing is defaulted; zero only when written as "0"):
 * - spread: { mode: "fixed", value } (one bid/ask spread for every bar, in
 *   price units, a whole multiple of the tick, may be "0") or
 *   { mode: "per_bar" } (each bar carries its own spread);
 * - fees: { currency, perOrder, proportionalBps }: currency must be the
 *   instrument's accounting currency (USD; GBP for UK stocks even when priced
 *   in GBX; the quote currency for forex); perOrder is a fixed amount per
 *   order (at most 2 decimal places); proportionalBps is basis points of the
 *   traded value (0-1000, at most 2 decimal places).
 * Slippage is an execution assumption of the later backtest (T2), not market
 * data, so it is not part of a dataset. Taxes (e.g. UK stamp duty) are not
 * modelled; an operator who wants them includes them in the fees.
 * Prices in the data are mid prices; spreads are recorded separately.
 */

import type { Instrument } from "./instruments.js";
import {
  Issues, canonicalDecimal, readDecimal, readList, readObject, readOneOf, readTicks, readTimestamp, type Decimal,
} from "./validation.js";

export const MAX_BARS = 50_000;
export const MAX_FEE_BPS = 1_000;
const VOLUME_PATTERN = /^(0|[1-9][0-9]{0,14})$/;

export interface Bar {
  readonly t: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Shares (stocks) or null (forex). */
  readonly volume: number | null;
  /** Spread in ticks for this bar (from the bar or the fixed spread). */
  readonly spread: number;
}

export interface Costs {
  readonly spreadMode: "fixed" | "per_bar";
  /** Fixed spread in ticks, or null in per-bar mode. */
  readonly fixedSpread: number | null;
  readonly feeCurrency: string;
  readonly feePerOrder: string;
  readonly feeProportionalBps: string;
  readonly feePerOrderDecimal: Decimal;
  readonly feeProportionalBpsDecimal: Decimal;
}

export function readCosts(issues: Issues, path: string, value: unknown, instrument: Instrument): Costs | null {
  const before = issues.count;
  const o = readObject(issues, path, value, ["spread", "fees"]);
  if (o === null) return null;
  const s = readObject(issues, `${path}.spread`, o.spread, ["mode"], ["value"]);
  let spreadMode: Costs["spreadMode"] = "fixed";
  let fixedSpread: number | null = null;
  if (s !== null) {
    spreadMode = readOneOf(issues, `${path}.spread.mode`, s.mode, ["fixed", "per_bar"] as const);
    if (spreadMode === "fixed") {
      if (!("value" in s)) issues.add(`${path}.spread.value`, "is required for a fixed spread (write \"0\" for none)");
      else fixedSpread = readTicks(issues, `${path}.spread.value`, s.value, instrument.tick, { allowZero: true });
    } else if ("value" in s) {
      issues.add(`${path}.spread.value`, "must not be given in per_bar mode (each bar carries its spread)");
    }
  }
  const f = readObject(issues, `${path}.fees`, o.fees, ["currency", "perOrder", "proportionalBps"]);
  let perOrder: Decimal | null = null;
  let bps: Decimal | null = null;
  if (f !== null) {
    if (f.currency !== instrument.accountingCurrency) issues.add(`${path}.fees.currency`, `must be ${instrument.accountingCurrency} for this instrument`);
    perOrder = readDecimal(issues, `${path}.fees.perOrder`, f.perOrder);
    if (perOrder !== null && perOrder.scale > 2) issues.add(`${path}.fees.perOrder`, "must have at most 2 decimal places");
    bps = readDecimal(issues, `${path}.fees.proportionalBps`, f.proportionalBps);
    if (bps !== null && (bps.scale > 2 || bps.units > BigInt(MAX_FEE_BPS) * 10n ** BigInt(bps.scale))) {
      issues.add(`${path}.fees.proportionalBps`, `must be at most ${MAX_FEE_BPS} with at most 2 decimal places`);
    }
  }
  if (issues.count > before || perOrder === null || bps === null) return null;
  return Object.freeze({
    spreadMode, fixedSpread, feeCurrency: instrument.accountingCurrency, feePerOrder: canonicalDecimal(perOrder),
    feeProportionalBps: canonicalDecimal(bps), feePerOrderDecimal: perOrder, feeProportionalBpsDecimal: bps,
  });
}

export function readBars(issues: Issues, path: string, value: unknown, instrument: Instrument, costs: Costs): readonly Bar[] | null {
  const before = issues.count;
  const list = readList(issues, path, value, { min: 1, max: MAX_BARS });
  if (list === null) return null;
  const keys = ["t", "open", "high", "low", "close", "volume"];
  const bars: Bar[] = [];
  let previous = "";
  for (let i = 0; i < list.length; i++) {
    const p = `${path}[${i}]`;
    const o = costs.spreadMode === "per_bar" ? readObject(issues, p, list[i], [...keys, "spread"]) : readObject(issues, p, list[i], keys);
    if (o === null) continue;
    const t = readTimestamp(issues, `${p}.t`, o.t);
    if (t && previous) {
      if (t <= previous) issues.add(`${p}.t`, `must be later than the previous bar (${previous})`);
      else if (t.slice(0, 10) === previous.slice(0, 10)) issues.add(`${p}.t`, "is on the same UTC date as the previous bar (daily bars)");
    }
    if (t) previous = t;
    const price = (key: string) => readTicks(issues, `${p}.${key}`, o[key], instrument.tick, { allowZero: false });
    const [open, high, low, close] = [price("open"), price("high"), price("low"), price("close")];
    if (open !== null && high !== null && low !== null && close !== null) {
      if (low > Math.min(open, close) || high < Math.max(open, close)) issues.add(p, "prices are inconsistent (need low <= open, close <= high)");
    }
    let volume: number | null = null;
    if (instrument.volumeRequired) {
      if (typeof o.volume !== "string" || !VOLUME_PATTERN.test(o.volume) || !Number.isSafeInteger(Number(o.volume))) {
        issues.add(`${p}.volume`, "must be a whole number of shares as a string (e.g. \"1200\")");
      } else volume = Number(o.volume);
    } else if (o.volume !== null) {
      issues.add(`${p}.volume`, "must be null for forex (there is no central volume)");
    }
    const spread = costs.spreadMode === "per_bar" ? readTicks(issues, `${p}.spread`, o.spread, instrument.tick, { allowZero: true }) : costs.fixedSpread;
    if (issues.count === before && t && open !== null && high !== null && low !== null && close !== null && spread !== null) {
      bars.push(Object.freeze({ t, open, high, low, close, volume, spread }));
    }
  }
  return issues.count > before ? null : Object.freeze(bars);
}
