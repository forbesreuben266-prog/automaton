/**
 * Instruments (trading research T1): US stocks, UK stocks and forex pairs.
 * Pure and deterministic. No cryptocurrency or other asset class is accepted.
 *
 * Every price is in an explicit unit, and every instrument states its exact
 * tick size (the smallest price step); prices are later stored as whole
 * numbers of ticks.
 * - us_equity: prices in USD; symbol 1-5 capital letters with an optional
 *   share-class suffix (".A").
 * - uk_equity: prices in GBP (pounds) or GBX (pence), stated explicitly; the
 *   two are never inferred or mixed (100 GBX = 1 GBP). Symbol 2-5 capital
 *   letters/digits with an optional suffix.
 * - fx: a pair of different currencies from FX_CURRENCIES (no crypto codes);
 *   symbol = BASE + QUOTE (e.g. "EURUSD"); prices are in the QUOTE currency
 *   per one unit of BASE, and profit and loss is measured in the quote
 *   currency only. pipSize must be 0.01 when JPY is the quote currency and
 *   0.0001 otherwise; tickSize must be the pip or a tenth of it (a
 *   "fractional pip").
 * Volume: stocks report share volume (required on every bar); forex has no
 * central volume figure, so every forex bar must state volume as null.
 */

import { Issues, canonicalDecimal, isPlainObject, readDecimal, readObject, readOneOf, readText, ticksOf, type Decimal } from "./validation.js";

export const ASSET_CLASSES = ["us_equity", "uk_equity", "fx"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];
export const UK_PRICE_UNITS = ["GBP", "GBX"] as const;
/** ISO 4217 codes accepted for forex pairs (major and common European currencies; no crypto). */
export const FX_CURRENCIES = ["USD", "GBP", "EUR", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK"] as const;

const US_SYMBOL = /^[A-Z]{1,5}(\.[A-Z])?$/;
const UK_SYMBOL = /^[A-Z0-9]{2,5}(\.[A-Z])?$/;
/** Equity tick sizes are explicit; at most 6 decimal places. */
const MAX_EQUITY_TICK_SCALE = 6;

export interface Instrument {
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly name: string;
  /** USD (US stocks), GBP or GBX (UK stocks), or the quote currency (forex). */
  readonly priceUnit: string;
  /** Canonical text of the tick size, e.g. "0.01". */
  readonly tickSize: string;
  readonly tick: Decimal;
  /** Forex only (null for stocks). */
  readonly base: string | null;
  readonly quote: string | null;
  readonly pipSize: string | null;
  /** Ticks per pip (forex: 1 or 10); null for stocks. */
  readonly ticksPerPip: number | null;
  /** The currency fees and profit/loss are measured in: USD, GBP (also for GBX-priced UK stocks) or the forex quote currency. */
  readonly accountingCurrency: string;
  readonly volumeRequired: boolean;
}

const KEYS: Record<AssetClass, readonly string[]> = {
  us_equity: ["assetClass", "symbol", "name", "priceUnit", "tickSize"],
  uk_equity: ["assetClass", "symbol", "name", "priceUnit", "tickSize"],
  fx: ["assetClass", "symbol", "name", "base", "quote", "pipSize", "tickSize"],
};

export function readInstrument(issues: Issues, path: string, value: unknown): Instrument | null {
  const before = issues.count;
  const failed = () => issues.count > before;
  if (!isPlainObject(value)) { issues.add(path, "must be an object"); return null; }
  const peek = Object.getOwnPropertyDescriptor(value, "assetClass");
  const assetClass = readOneOf(issues, `${path}.assetClass`, peek && !peek.get && !peek.set ? peek.value : undefined, ASSET_CLASSES);
  if (failed()) return null;
  const o = readObject(issues, path, value, KEYS[assetClass]);
  if (o === null) return null;
  const name = readText(issues, `${path}.name`, o.name, { max: 120 });
  const tick = readDecimal(issues, `${path}.tickSize`, o.tickSize);
  if (tick !== null && tick.units === 0n) issues.add(`${path}.tickSize`, "must be greater than zero");

  if (assetClass === "fx") {
    const base = readOneOf(issues, `${path}.base`, o.base, FX_CURRENCIES);
    const quote = readOneOf(issues, `${path}.quote`, o.quote, FX_CURRENCIES);
    if (base === quote) issues.add(`${path}.quote`, "must differ from the base currency");
    const symbol = readText(issues, `${path}.symbol`, o.symbol, { max: 6 });
    if (symbol !== `${base}${quote}`) issues.add(`${path}.symbol`, `must be the base and quote codes joined (${base}${quote})`);
    const pip = readDecimal(issues, `${path}.pipSize`, o.pipSize);
    const expectedPip = quote === "JPY" ? "0.01" : "0.0001";
    if (pip !== null && canonicalDecimal(pip) !== expectedPip) issues.add(`${path}.pipSize`, `must be ${expectedPip} for a pair quoted in ${quote}`);
    let ticksPerPip: number | null = null;
    if (pip !== null && tick !== null && tick.units > 0n) {
      ticksPerPip = ticksOf(pip, tick);
      if (ticksPerPip !== 1 && ticksPerPip !== 10) issues.add(`${path}.tickSize`, "must equal the pip size or one tenth of it");
    }
    if (failed() || tick === null || pip === null) return null;
    return Object.freeze({
      symbol, assetClass, name, priceUnit: quote, tickSize: canonicalDecimal(tick), tick, base, quote, pipSize: canonicalDecimal(pip),
      ticksPerPip, accountingCurrency: quote, volumeRequired: false,
    });
  }

  const symbol = readText(issues, `${path}.symbol`, o.symbol, { max: 7, pattern: assetClass === "us_equity" ? US_SYMBOL : UK_SYMBOL });
  const priceUnit = assetClass === "us_equity"
    ? readOneOf(issues, `${path}.priceUnit`, o.priceUnit, ["USD"] as const)
    : readOneOf(issues, `${path}.priceUnit`, o.priceUnit, UK_PRICE_UNITS);
  if (tick !== null && tick.scale > MAX_EQUITY_TICK_SCALE) issues.add(`${path}.tickSize`, `must have at most ${MAX_EQUITY_TICK_SCALE} decimal places`);
  if (failed() || tick === null) return null;
  return Object.freeze({
    symbol, assetClass, name, priceUnit, tickSize: canonicalDecimal(tick), tick, base: null, quote: null, pipSize: null, ticksPerPip: null,
    accountingCurrency: assetClass === "us_equity" ? "USD" : "GBP", volumeRequired: true,
  });
}
