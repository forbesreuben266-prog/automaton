/**
 * Market-data readiness (milestone R1). Pure and deterministic.
 *
 * Validates a future REAL-WORLD daily price record for one US stock, UK stock
 * or forex pair and explains, condition by condition, whether it could be
 * relied on. It feeds nothing: the existing offline engines accept only
 * fictional datasets, and this module never converts a record into one.
 *
 *   { version: 1, asOf, source, instrument, priceBasis, adjustment,
 *     corporateActions, calendar, bars }
 *
 * Refused as malformed, ambiguous or unsupported (nothing is guessed):
 * - currency: US stocks in USD; UK stocks in GBP (pounds) or GBX (pence),
 *   stated exactly ("GBp", "p" or "pence" are refused as ambiguous); forex
 *   prices are quote currency per one unit of base (quoteConvention
 *   "quote_per_base", priceCurrency = quote), so an inverted or unstated
 *   quotation is refused;
 * - exchange and time zone: XNYS or XNAS (America/New_York) for US stocks,
 *   XLON (Europe/London) for UK stocks, and the 17:00 New York daily close
 *   for forex; other exchanges, zones or forex closes are unsupported;
 * - calendar: the operator supplies the expected sessions (date and local
 *   close time, allowing early closes); weekends and dates before 2007 (US
 *   daylight-saving rules changed then) are unsupported;
 * - price basis: "raw" or "adjusted"; adjusted stock prices must state the
 *   method (splits, or splits and dividends) and the date they were adjusted
 *   through; forex has no corporate actions and must be raw.
 *
 * Assessed as conditions (pass / fail / unverified): source provenance,
 * retrieval after the data, duplicate or out-of-order timestamps, bars off
 * the calendar or at the wrong UTC close time (time-zone errors), missing
 * bars, inconsistent prices, stale (unchanging) prices, corporate-action
 * completeness and whether the price basis suits the corporate actions.
 */

import { check, assessOrRefuse, result, type ReadinessCheck, type ReadinessResult } from "./readiness.js";
import { readAttestation, readSourceRecord, trustSummary, type Attestation, type SourceRecord } from "./provenance.js";
import {
  Issues, compareDecimals, dayOfWeek, readDate, readList, readObject, readOneOf, readPrice, readText, readTimestamp,
} from "./validation.js";

export const MARKET_ASSET_CLASSES = ["us_equity", "uk_equity", "fx"] as const;
export type MarketAssetClass = (typeof MARKET_ASSET_CLASSES)[number];
/** The same currency list as the offline trading module (a test checks they agree); no crypto codes. */
export const MARKET_FX_CURRENCIES = ["USD", "GBP", "EUR", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK"] as const;
export const EXCHANGES = { us_equity: ["XNYS", "XNAS"], uk_equity: ["XLON"], fx: ["FX"] } as const;
const TIME_ZONE = { XNYS: "America/New_York", XNAS: "America/New_York", XLON: "Europe/London", FX: "America/New_York" } as const;
const STANDARD_CLOSE = { XNYS: "16:00", XNAS: "16:00", XLON: "16:30", FX: "17:00" } as const;
type Exchange = keyof typeof TIME_ZONE;
export const MAX_MARKET_BARS = 50_000;
/** This many consecutive unchanged bars (open = high = low = close = previous close) fail the stale-price check. */
export const STALE_RUN_BARS = 3;
export const EARLIEST_SUPPORTED_DATE = "2007-01-01";
const US_SYMBOL = /^[A-Z]{1,5}(\.[A-Z])?$/;
const UK_SYMBOL = /^[A-Z0-9]{2,5}(\.[A-Z])?$/;
const CLOSE_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const VOLUME = /^(0|[1-9][0-9]{0,14})$/;

type Price = { text: string; units: bigint; scale: number };

export interface MarketInstrument {
  readonly assetClass: MarketAssetClass;
  readonly symbol: string;
  readonly exchange: Exchange;
  readonly priceCurrency: string;
  readonly base: string | null;
  readonly quote: string | null;
}

export interface CorporateAction {
  readonly exDate: string;
  readonly type: "split" | "cash_dividend" | "other";
  readonly detail: string;
}

export interface MarketBar {
  readonly session: string;
  readonly t: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string | null;
}

export interface MarketDataRecord {
  readonly version: 1;
  readonly asOf: string;
  readonly source: SourceRecord;
  readonly instrument: MarketInstrument;
  readonly priceBasis: "raw" | "adjusted";
  readonly adjustment: { readonly method: "splits" | "splits_and_dividends"; readonly adjustedThrough: string } | null;
  /** Null for forex. `attestation` covers the completeness of the listed actions for the data period. */
  readonly corporateActions: { readonly actions: readonly CorporateAction[]; readonly attestation: Attestation } | null;
  readonly calendar: { readonly exchange: Exchange; readonly timeZone: string; readonly sessions: readonly { readonly date: string; readonly closeLocal: string }[]; readonly attestation: Attestation };
  readonly bars: readonly MarketBar[];
}

function readInstrument(issues: Issues, value: unknown): MarketInstrument | null {
  const before = issues.count;
  const peek = typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, "assetClass") : undefined;
  const assetClass = readOneOf(issues, "record.instrument.assetClass", peek && "value" in peek ? peek.value : undefined, MARKET_ASSET_CLASSES);
  if (issues.count > before) return null;
  const keys = assetClass === "fx" ? ["assetClass", "symbol", "exchange", "priceCurrency", "base", "quote", "quoteConvention"] : ["assetClass", "symbol", "exchange", "priceCurrency"];
  const o = readObject(issues, "record.instrument", value, keys);
  if (o === null) return null;
  const exchange = readOneOf(issues, "record.instrument.exchange", o.exchange, EXCHANGES[assetClass] as readonly Exchange[]);
  if (assetClass === "fx") {
    const base = readOneOf(issues, "record.instrument.base", o.base, MARKET_FX_CURRENCIES);
    const quote = readOneOf(issues, "record.instrument.quote", o.quote, MARKET_FX_CURRENCIES);
    if (base === quote) issues.add("record.instrument.quote", "must differ from the base currency");
    if (o.symbol !== `${base}${quote}`) issues.add("record.instrument.symbol", `must be the base and quote codes joined (${base}${quote})`);
    if (o.quoteConvention !== "quote_per_base") issues.add("record.instrument.quoteConvention", "must be quote_per_base (price = quote currency per one unit of base); other or unstated conventions are ambiguous");
    if (o.priceCurrency !== quote) issues.add("record.instrument.priceCurrency", `must be the quote currency (${quote}); a different currency means an inverted or ambiguous quotation`);
    return issues.count > before ? null : Object.freeze({ assetClass, symbol: `${base}${quote}`, exchange, priceCurrency: quote, base, quote });
  }
  const symbol = readText(issues, "record.instrument.symbol", o.symbol, { max: 7, pattern: assetClass === "us_equity" ? US_SYMBOL : UK_SYMBOL });
  let priceCurrency = "";
  if (assetClass === "us_equity") {
    if (o.priceCurrency !== "USD") issues.add("record.instrument.priceCurrency", "must be USD for a US stock");
    priceCurrency = "USD";
  } else if (o.priceCurrency === "GBP" || o.priceCurrency === "GBX") {
    priceCurrency = o.priceCurrency;
  } else {
    issues.add("record.instrument.priceCurrency", "must be GBP (pounds) or GBX (pence) exactly for a UK stock; GBp, p, pence and other spellings are ambiguous");
  }
  return issues.count > before ? null : Object.freeze({ assetClass, symbol, exchange, priceCurrency, base: null, quote: null });
}

/** n-th Sunday (1-based) of a month, or the last one (n = 0) of a 31-day month. */
function sunday(y: number, m: number, n: number): string {
  const mm = String(m).padStart(2, "0");
  if (n === 0) return `${y}-${mm}-${String(31 - dayOfWeek(`${y}-${mm}-31`)).padStart(2, "0")}`;
  const first = 1 + ((7 - dayOfWeek(`${y}-${mm}-01`)) % 7);
  return `${y}-${mm}-${String(first + 7 * (n - 1)).padStart(2, "0")}`;
}

/** UTC timestamp of a local afternoon close on `date` (US rules from 2007; UK/EU rules). */
export function expectedCloseUtc(exchange: Exchange, date: string, closeLocal: string): string {
  const y = Number(date.slice(0, 4));
  const [hh, mm] = closeLocal.split(":").map(Number);
  let utcHour: number;
  if (TIME_ZONE[exchange] === "America/New_York") {
    const dst = date >= sunday(y, 3, 2) && date < sunday(y, 11, 1);
    utcHour = hh + (dst ? 4 : 5);
  } else {
    const dst = date >= sunday(y, 3, 0) && date < sunday(y, 10, 0);
    utcHour = hh - (dst ? 1 : 0);
  }
  return `${date}T${String(utcHour).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`;
}

/** Validates a record (throws ReadinessInputError listing every problem). Data-quality problems are left to the assessment. */
export function parseMarketData(raw: unknown): MarketDataRecord {
  const issues = new Issues();
  const o = readObject(issues, "record", raw, ["version", "asOf", "source", "instrument", "priceBasis", "adjustment", "corporateActions", "calendar", "bars"]);
  issues.throwIfAny();
  if (o!.version !== 1) issues.add("record.version", "must be 1");
  const asOf = readTimestamp(issues, "record.asOf", o!.asOf);
  issues.throwIfAny();
  const source = readSourceRecord(issues, "record.source", o!.source, asOf, new Set());
  const instrument = readInstrument(issues, o!.instrument);
  issues.throwIfAny();
  const inst = instrument!;
  const isFx = inst.assetClass === "fx";

  const priceBasis = readOneOf(issues, "record.priceBasis", o!.priceBasis, ["raw", "adjusted"] as const);
  if (isFx && priceBasis !== "raw") issues.add("record.priceBasis", "must be raw for forex (there are no corporate actions to adjust for)");
  let adjustment: MarketDataRecord["adjustment"] = null;
  if (priceBasis === "adjusted" && !isFx) {
    const a = readObject(issues, "record.adjustment", o!.adjustment, ["method", "adjustedThrough"]);
    if (a !== null) {
      adjustment = Object.freeze({
        method: readOneOf(issues, "record.adjustment.method", a.method, ["splits", "splits_and_dividends"] as const),
        adjustedThrough: readDate(issues, "record.adjustment.adjustedThrough", a.adjustedThrough),
      });
    }
  } else if (o!.adjustment !== null) {
    issues.add("record.adjustment", "must be null for raw prices");
  }

  let corporateActions: MarketDataRecord["corporateActions"] = null;
  if (isFx) {
    if (o!.corporateActions !== null) issues.add("record.corporateActions", "must be null for forex");
  } else {
    const c = readObject(issues, "record.corporateActions", o!.corporateActions, ["actions", "attestation"]);
    if (c !== null) {
      const list = readList(issues, "record.corporateActions.actions", c.actions, { min: 0, max: 500 }) ?? [];
      const actions = list.map((a, i) => {
        const p = `record.corporateActions.actions[${i}]`;
        const x = readObject(issues, p, a, ["exDate", "type", "detail"]);
        if (x === null) return null;
        return Object.freeze({ exDate: readDate(issues, `${p}.exDate`, x.exDate), type: readOneOf(issues, `${p}.type`, x.type, ["split", "cash_dividend", "other"] as const), detail: readText(issues, `${p}.detail`, x.detail, { max: 300 }) });
      }).filter((a): a is CorporateAction => a !== null);
      const attestation = readAttestation(issues, "record.corporateActions.attestation", c.attestation, { earliest: null, asOf });
      if (attestation) corporateActions = Object.freeze({ actions: Object.freeze(actions), attestation });
    }
  }

  const exchange = inst.exchange;
  let calendar: MarketDataRecord["calendar"] | null = null;
  const cal = readObject(issues, "record.calendar", o!.calendar, ["exchange", "timeZone", "sessions", "attestation"]);
  if (cal !== null) {
    if (cal.exchange !== exchange) issues.add("record.calendar.exchange", `must be the instrument's exchange (${exchange})`);
    if (cal.timeZone !== TIME_ZONE[exchange]) issues.add("record.calendar.timeZone", `must be ${TIME_ZONE[exchange]} for ${exchange}; other time zones are unsupported`);
    const list = readList(issues, "record.calendar.sessions", cal.sessions, { min: 1, max: MAX_MARKET_BARS }) ?? [];
    let previous = "";
    const sessions = list.map((s, i) => {
      const p = `record.calendar.sessions[${i}]`;
      const x = readObject(issues, p, s, ["date", "closeLocal"]);
      if (x === null) return null;
      const date = readDate(issues, `${p}.date`, x.date);
      if (date) {
        if (date < EARLIEST_SUPPORTED_DATE) issues.add(`${p}.date`, `is unsupported (sessions before ${EARLIEST_SUPPORTED_DATE} are not modelled)`);
        if ([0, 6].includes(dayOfWeek(date))) issues.add(`${p}.date`, "falls on a weekend (weekend sessions are unsupported)");
        if (previous && date <= previous) issues.add(`${p}.date`, "must be later than the previous session (no duplicates)");
        previous = date;
      }
      const closeLocal = typeof x.closeLocal === "string" && CLOSE_TIME.test(x.closeLocal) ? x.closeLocal : "";
      if (!closeLocal) issues.add(`${p}.closeLocal`, "must be a local time like 16:00");
      else if (exchange === "FX" ? closeLocal !== "17:00" : closeLocal < "12:00" || closeLocal > STANDARD_CLOSE[exchange]) {
        issues.add(`${p}.closeLocal`, exchange === "FX" ? "must be 17:00 (the New York forex daily close); other conventions are unsupported" : `must be from 12:00 to the standard close (${STANDARD_CLOSE[exchange]}) local time`);
      }
      return Object.freeze({ date, closeLocal });
    }).filter((s): s is { date: string; closeLocal: string } => s !== null);
    const attestation = readAttestation(issues, "record.calendar.attestation", cal.attestation, { earliest: null, asOf });
    if (attestation) calendar = Object.freeze({ exchange, timeZone: TIME_ZONE[exchange], sessions: Object.freeze(sessions), attestation });
  }

  const barList = readList(issues, "record.bars", o!.bars, { min: 1, max: MAX_MARKET_BARS }) ?? [];
  const bars = barList.map((b, i) => {
    const p = `record.bars[${i}]`;
    const x = readObject(issues, p, b, ["session", "t", "open", "high", "low", "close", "volume"]);
    if (x === null) return null;
    const prices = (["open", "high", "low", "close"] as const).map((k) => readPrice(issues, `${p}.${k}`, x[k]));
    let volume: string | null = null;
    if (isFx) {
      if (x.volume !== null) issues.add(`${p}.volume`, "must be null for forex (there is no central volume)");
    } else if (typeof x.volume !== "string" || !VOLUME.test(x.volume)) {
      issues.add(`${p}.volume`, "must be a whole number of shares as a string");
    } else volume = x.volume;
    return Object.freeze({
      session: readDate(issues, `${p}.session`, x.session), t: readTimestamp(issues, `${p}.t`, x.t),
      open: prices[0]?.text ?? "", high: prices[1]?.text ?? "", low: prices[2]?.text ?? "", close: prices[3]?.text ?? "", volume,
    });
  }).filter((b): b is MarketBar => b !== null);
  if (corporateActions && bars.length > 0 && issues.count === 0) {
    const first = bars.reduce((m, b) => (b.session < m ? b.session : m), bars[0].session);
    const last = bars.reduce((m, b) => (b.session > m ? b.session : m), bars[0].session);
    corporateActions.actions.forEach((a, i) => {
      if (a.exDate < first || a.exDate > last) issues.add(`record.corporateActions.actions[${i}].exDate`, `must fall within the data period (${first} to ${last})`);
    });
  }
  issues.throwIfAny();
  return Object.freeze({
    version: 1 as const, asOf, source: source!, instrument: inst, priceBasis, adjustment, corporateActions, calendar: calendar!, bars: Object.freeze(bars),
  });
}

const p = (text: string): Price => readPrice(new Issues(), "", text)!;

/** Validates and assesses a record. Malformed input gives a "refused" result. Never approves anything. */
export function assessMarketData(raw: unknown): ReadinessResult {
  return assessOrRefuse("market_data", () => {
    const r = parseMarketData(raw);
    const checks: ReadinessCheck[] = [];
    const inst = r.instrument;
    const lastT = r.bars.reduce((m, b) => (b.t > m ? b.t : m), r.bars[0].t);
    const lastSession = r.bars.reduce((m, b) => (b.session > m ? b.session : m), r.bars[0].session);

    const trust = trustSummary(r.source);
    checks.push(check("source_provenance", r.source.sourceClass === "unverified_claim" ? "fail" : trust.independentlyVerified ? "pass" : "unverified",
      r.source.sourceClass === "unverified_claim" ? "Market data from an unverified claim can't be used." : trust.independentlyVerified ? `The ${r.source.sourceClass} source's content, publisher and origin are independently verified.` : "The source's content, publisher or origin is not independently verified.",
      [`${r.source.id} (${r.source.sourceClass}): verified ${trust.verified.join(", ") || "none"}; asserted ${trust.asserted.join(", ") || "none"}; unverified ${trust.unverified.join(", ") || "none"}`]));

    checks.push(check("retrieved_after_data", r.source.retrievedAt >= lastT ? "pass" : "fail",
      r.source.retrievedAt >= lastT ? "The data was retrieved after its last bar." : `The source was retrieved (${r.source.retrievedAt}) before the last bar it contains (${lastT}): impossible for genuine historical data.`));

    const ordering: string[] = [];
    const seenT = new Set<string>();
    const seenSession = new Set<string>();
    r.bars.forEach((b, i) => {
      if (seenT.has(b.t)) ordering.push(`bar ${i}: duplicate timestamp ${b.t}`);
      if (seenSession.has(b.session)) ordering.push(`bar ${i}: duplicate session ${b.session}`);
      if (i > 0 && b.t <= r.bars[i - 1].t && !seenT.has(b.t)) ordering.push(`bar ${i}: out of order (${b.t} after ${r.bars[i - 1].t})`);
      seenT.add(b.t);
      seenSession.add(b.session);
    });
    checks.push(check("timestamps_unique_and_ordered", ordering.length === 0 ? "pass" : "fail",
      ordering.length === 0 ? "Bar timestamps and sessions are unique and strictly increasing." : "Some bars are duplicated or out of order.", ordering));

    const calendarByDate = new Map(r.calendar.sessions.map((s) => [s.date, s.closeLocal]));
    const offCalendar: string[] = [];
    r.bars.forEach((b, i) => {
      const close = calendarByDate.get(b.session);
      if (close === undefined) offCalendar.push(`bar ${i}: session ${b.session} is not a calendar session`);
      else {
        const expected = expectedCloseUtc(r.calendar.exchange, b.session, close);
        if (b.t !== expected) offCalendar.push(`bar ${i}: timestamp ${b.t} is not the session close ${expected} (${close} ${r.calendar.timeZone}); check the time zone and daylight saving`);
      }
    });
    checks.push(check("bars_match_calendar", offCalendar.length === 0 ? "pass" : "fail",
      offCalendar.length === 0 ? `Every bar is a calendar session stamped at its close in ${r.calendar.timeZone} (converted to UTC).` : "Some bars are off the calendar or stamped at the wrong time.", offCalendar));

    const missing = r.calendar.sessions.filter((s) => !seenSession.has(s.date)).map((s) => s.date);
    checks.push(check("no_missing_bars", missing.length === 0 ? "pass" : "fail",
      missing.length === 0 ? `Every one of the ${r.calendar.sessions.length} calendar sessions has a bar.` : `${missing.length} calendar session(s) have no bar.`, missing.map((d) => `missing ${d}`)));

    checks.push(check("calendar_verified", r.calendar.attestation.status === "verified" ? "pass" : "unverified",
      r.calendar.attestation.status === "verified" ? "The session calendar was independently checked." : `The session calendar is ${r.calendar.attestation.status}, so missing or extra sessions can't be ruled out.`,
      [r.calendar.attestation.note]));

    const inconsistent: string[] = [];
    const flat: number[] = [];
    let run = 0;
    let longest = 0;
    const zeroVolume: string[] = [];
    r.bars.forEach((b, i) => {
      const [o, h, l, c] = [p(b.open), p(b.high), p(b.low), p(b.close)];
      if (compareDecimals(l, o) > 0 || compareDecimals(l, c) > 0 || compareDecimals(h, o) < 0 || compareDecimals(h, c) < 0) inconsistent.push(`bar ${i} (${b.session}): need low <= open, close <= high`);
      const unchanged = i > 0 && [o, h, l].every((x) => compareDecimals(x, c) === 0) && compareDecimals(c, p(r.bars[i - 1].close)) === 0;
      if (unchanged) { flat.push(i); run += 1; longest = Math.max(longest, run); } else run = 0;
      if (b.volume === "0") zeroVolume.push(`bar ${i} (${b.session}): zero volume`);
    });
    checks.push(check("prices_consistent", inconsistent.length === 0 ? "pass" : "fail",
      inconsistent.length === 0 ? "Every bar has low <= open, close <= high." : "Some bars have inconsistent prices.", inconsistent));
    checks.push(check("prices_not_stale", longest >= STALE_RUN_BARS ? "fail" : flat.length + zeroVolume.length > 0 ? "unverified" : "pass",
      longest >= STALE_RUN_BARS ? `${longest} consecutive bars repeat the previous close unchanged (stale or carried-forward prices).` : flat.length + zeroVolume.length > 0 ? "Some bars are unchanged or have zero volume; they may be stale." : "No unchanged or zero-volume bars.",
      [...flat.map((i) => `bar ${i} (${r.bars[i].session}): open = high = low = close = previous close`), ...zeroVolume]));

    const currencyDetail = inst.assetClass === "fx"
      ? `${inst.symbol}: prices are ${inst.quote} per 1 ${inst.base}; profit and loss would be in ${inst.quote}.`
      : inst.priceCurrency === "GBX" ? `${inst.symbol}: prices are in pence (GBX); 100 GBX = 1 GBP.` : `${inst.symbol}: prices are in ${inst.priceCurrency}.`;
    checks.push(check("currency_convention", "pass", "The price currency and quotation convention are stated exactly.", [currencyDetail]));

    if (r.corporateActions === null) {
      checks.push(check("corporate_actions", "pass", "Not applicable to forex."));
      checks.push(check("price_basis", "pass", "Forex prices are raw (no corporate actions)."));
    } else {
      const actions = r.corporateActions.actions;
      const other = actions.filter((a) => a.type === "other");
      const att = r.corporateActions.attestation;
      checks.push(check("corporate_actions", other.length > 0 ? "fail" : att.status === "verified" ? "pass" : "unverified",
        other.length > 0 ? "Some corporate actions are of a kind whose effect on prices is not modelled." : att.status === "verified" ? `The list of corporate actions in the period (${actions.length}) was independently checked.` : `The completeness of the corporate-action list is ${att.status}.`,
        [...other.map((a) => `${a.exDate}: other (${a.detail})`), att.note]));
      const splits = actions.filter((a) => a.type === "split");
      const dividends = actions.filter((a) => a.type === "cash_dividend");
      const basis: { status: "pass" | "fail" | "unverified"; summary: string; details: string[] } = { status: "pass", summary: "", details: [] };
      if (r.priceBasis === "raw") {
        if (splits.length > 0) Object.assign(basis, { status: "fail", summary: "Raw prices span a split, so returns across it are wrong; use split-adjusted prices or exclude the period.", details: splits.map((a) => `split ${a.exDate}: ${a.detail}`) });
        else if (dividends.length > 0) Object.assign(basis, { status: "unverified", summary: "Raw prices exclude dividends, so total returns are understated.", details: dividends.map((a) => `dividend ${a.exDate}: ${a.detail}`) });
        else basis.summary = "Raw prices with no corporate actions listed in the period.";
      } else {
        const adj = r.adjustment!;
        if (adj.adjustedThrough < lastSession) Object.assign(basis, { status: "fail", summary: `Prices were adjusted through ${adj.adjustedThrough}, before the last bar (${lastSession}); later actions are not reflected.` });
        else if (adj.method === "splits" && dividends.length > 0) Object.assign(basis, { status: "unverified", summary: "Prices are adjusted for splits only; dividends in the period are not reflected.", details: dividends.map((a) => `dividend ${a.exDate}: ${a.detail}`) });
        else basis.summary = `Prices are adjusted (${adj.method}) through ${adj.adjustedThrough}; they are not the prices traded on the day.`;
      }
      checks.push(check("price_basis", basis.status, basis.summary, basis.details));
    }
    return result("market_data", JSON.stringify(r), checks);
  });
}
