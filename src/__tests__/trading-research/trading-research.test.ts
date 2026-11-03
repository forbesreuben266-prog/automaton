/** Trading research T1: schemas, provenance and metrics. FICTIONAL data only; everything runs in memory. */

import { describe, expect, it } from "vitest";
import {
  MAX_BARS, MAX_DATASET_CHARS, MAX_ISSUES, MIN_VOLATILITY_RETURNS, ValidationError, annualizedVolatility, canonicalDatasetText, datasetSha256,
  maxDrawdown, parseDataset, parseDatasetText, readInstrument, riskReward, simpleReturns, summarizeDataset, ticksOf, totalReturn, verifyDatasetSha256,
  Issues,
} from "../../trading-research/index.js";
import { USDJPY, fxDataset, issuesOf, text, ukDataset, usDataset } from "./fixtures.js";

const instrumentOf = (raw: unknown) => {
  const issues = new Issues();
  const i = readInstrument(issues, "instrument", raw);
  issues.throwIfAny();
  return i!;
};

describe("datasets: valid fictional US, UK and forex data", () => {
  it("parses each dataset from JSON text into exact integer ticks", () => {
    const us = parseDatasetText(text(usDataset()));
    expect(us.bars.map((b) => b.close)).toEqual([10000, 11000, 9900, 10890]);
    expect(us.bars[0]).toEqual({ t: "2026-01-05T21:00:00Z", open: 9950, high: 10050, low: 9900, close: 10000, volume: 1200, spread: 2 });
    expect(us.instrument).toMatchObject({ priceUnit: "USD", tickSize: "0.01", accountingCurrency: "USD", volumeRequired: true });
    const uk = parseDatasetText(text(ukDataset()));
    expect(uk.instrument).toMatchObject({ priceUnit: "GBX", tickSize: "0.5", accountingCurrency: "GBP" });
    expect(uk.bars.map((b) => [b.close, b.spread])).toEqual([[500, 2], [490, 3], [511, 2]]); // ticks of 0.5p
    const fx = parseDatasetText(text(fxDataset()));
    expect(fx.instrument).toMatchObject({ base: "EUR", quote: "USD", priceUnit: "USD", pipSize: "0.0001", ticksPerPip: 10, accountingCurrency: "USD", volumeRequired: false });
    expect(fx.bars[1]).toMatchObject({ close: 110000, volume: null, spread: 12 });
    expect(Object.isFrozen(fx.bars[0])).toBe(true);
  });

  it("handles a yen-quoted pair (pip 0.01) and refuses the wrong pip size", () => {
    expect(instrumentOf(USDJPY)).toMatchObject({ pipSize: "0.01", ticksPerPip: 10, accountingCurrency: "JPY" });
    expect(issuesOf(() => instrumentOf({ ...USDJPY, pipSize: "0.0001" }))).toContain("must be 0.01 for a pair quoted in JPY");
  });
});

describe("instruments: explicit units, symbols and tick sizes", () => {
  const us = () => usDataset().instrument;
  const uk = () => ukDataset().instrument;
  const fx = () => fxDataset().instrument;
  it.each([
    ["an unknown asset class (no crypto)", { ...us(), assetClass: "crypto" }, "assetClass: must be one of: us_equity, uk_equity, fx"],
    ["a UK stock without its price unit", (() => { const { priceUnit: _p, ...rest } = uk(); return rest; })(), "priceUnit: is required"],
    ["a UK stock in an unknown unit", { ...uk(), priceUnit: "GBp" }, "priceUnit: must be one of: GBP, GBX"],
    ["a US stock not in USD", { ...us(), priceUnit: "GBP" }, "priceUnit: must be one of: USD"],
    ["a malformed US symbol", { ...us(), symbol: "fict" }, "symbol: has an invalid format"],
    ["a zero tick size", { ...us(), tickSize: "0" }, "tickSize: must be greater than zero"],
    ["a numeric tick size", { ...us(), tickSize: 0.01 }, "tickSize: must be a decimal string"],
    ["too many tick decimals for a stock", { ...us(), tickSize: "0.0000001" }, "at most 6 decimal places"],
    ["a crypto currency code", { ...fx(), base: "BTC", symbol: "BTCUSD" }, "base: must be one of"],
    ["the same base and quote", { ...fx(), quote: "EUR", symbol: "EUREUR" }, "must differ from the base currency"],
    ["a symbol that doesn't match the pair", { ...fx(), symbol: "USDEUR" }, "must be the base and quote codes joined (EURUSD)"],
    ["a tick that is not the pip or a tenth of it", { ...fx(), tickSize: "0.00002" }, "must equal the pip size or one tenth of it"],
    ["an extra field", { ...us(), exchange: "NYSE" }, "exchange: is not an allowed field"],
    ["stock fields on a forex pair", { ...fx(), priceUnit: "USD" }, "priceUnit: is not an allowed field"],
  ])("refuses %s", (_label, raw, message) => {
    expect(issuesOf(() => instrumentOf(raw))).toContain(message);
  });
});

describe("bars, spreads and fees: strict and never defaulted", () => {
  const withBars = (mutate: (d: any) => void, base = usDataset) => { const d = base(); mutate(d); return () => parseDataset(d); };
  it.each([
    ["timestamps out of order", (d: any) => { d.bars[2].t = d.bars[1].t; }, "must be later than the previous bar"],
    ["two bars on one UTC date", (d: any) => { d.bars[2].t = "2026-01-06T22:00:00Z"; }, "same UTC date as the previous bar"],
    ["a malformed timestamp", (d: any) => { d.bars[0].t = "2026-01-05 21:00"; }, "must be a UTC timestamp"],
    ["a non-UTC timestamp", (d: any) => { d.bars[0].t = "2026-01-05T21:00:00+01:00"; }, "must be a UTC timestamp"],
    ["an impossible date", (d: any) => { d.bars[0].t = "2026-02-30T21:00:00Z"; }, "not a real calendar date"],
    ["low above the close", (d: any) => { d.bars[0].low = "100.10"; }, "prices are inconsistent"],
    ["high below the open", (d: any) => { d.bars[1].high = "99.00"; }, "prices are inconsistent"],
    ["a zero price", (d: any) => { d.bars[0].low = "0"; }, "must be greater than zero"],
    ["a negative price", (d: any) => { d.bars[0].low = "-1"; }, "must be a decimal string"],
    ["a numeric (floating-point) price", (d: any) => { d.bars[0].close = 100; }, "must be a decimal string"],
    ["an exponent", (d: any) => { d.bars[0].close = "1e2"; }, "must be a decimal string"],
    ["a price off the tick grid", (d: any) => { d.bars[0].close = "100.005"; }, "whole multiple of the tick size 0.01"],
    ["a price beyond the safe integer range in ticks", (d: any) => { d.bars[0].high = "999999999999999"; }, "within the safe range"],
    ["missing stock volume", (d: any) => { d.bars[0].volume = null; }, "volume: must be a whole number of shares"],
    ["fractional volume", (d: any) => { d.bars[0].volume = "12.5"; }, "volume: must be a whole number of shares"],
    ["a per-bar spread in fixed mode", (d: any) => { d.bars[0].spread = "0.02"; }, "spread: is not an allowed field"],
    ["a fixed spread without a value", (d: any) => { delete d.costs.spread.value; }, "is required for a fixed spread"],
    ["missing fees", (d: any) => { delete d.costs.fees; }, "costs.fees: is required"],
    ["a fee in the wrong currency", (d: any) => { d.costs.fees.currency = "GBP"; }, "fees.currency: must be USD"],
    ["fees with sub-penny precision", (d: any) => { d.costs.fees.perOrder = "1.001"; }, "at most 2 decimal places"],
    ["an excessive proportional fee", (d: any) => { d.costs.fees.proportionalBps = "1000.01"; }, "must be at most 1000"],
    ["no bars", (d: any) => { d.bars = []; }, "must have at least 1 entry"],
  ])("refuses %s", (_label, mutate, message) => {
    expect(issuesOf(withBars(mutate))).toContain(message);
  });

  it("requires per-bar spreads in per-bar mode, null forex volume, and a UK fee currency of GBP even for GBX prices", () => {
    expect(issuesOf(withBars((d) => { delete d.bars[1].spread; }, ukDataset))).toContain("dataset.bars[1].spread: is required");
    expect(issuesOf(withBars((d) => { d.costs.spread.value = "1"; }, ukDataset))).toContain("must not be given in per_bar mode");
    expect(issuesOf(withBars((d) => { d.costs.fees.currency = "GBX"; }, ukDataset))).toContain("fees.currency: must be GBP");
    expect(issuesOf(withBars((d) => { d.bars[0].volume = "100"; }, fxDataset))).toContain("volume: must be null for forex");
    expect(issuesOf(withBars((d) => { d.costs.spread.value = "0.000001"; }, fxDataset))).toContain("whole multiple of the tick size 0.00001");
  });

  it("allows explicitly zero spreads and fees (stated, not defaulted)", () => {
    const d = usDataset();
    d.costs = { spread: { mode: "fixed", value: "0" }, fees: { currency: "USD", perOrder: "0", proportionalBps: "0" } };
    expect(parseDataset(d).costs).toMatchObject({ fixedSpread: 0, feePerOrder: "0", feeProportionalBps: "0" });
  });

  it("bounds the work: oversized text and bar lists are refused before parsing them", () => {
    expect(issuesOf(() => parseDatasetText("x".repeat(MAX_DATASET_CHARS + 1)))).toContain(`the limit is ${MAX_DATASET_CHARS}`);
    const d = usDataset();
    d.bars = { length: MAX_BARS + 1 } as any;
    expect(issuesOf(() => parseDataset(d))).toContain("must be an array");
    const big = usDataset();
    big.bars = new Array(MAX_BARS + 1).fill(big.bars[0]);
    expect(issuesOf(() => parseDataset(big))).toContain(`must have at most ${MAX_BARS} entries`);
  });

  it("reports at most MAX_ISSUES problems plus a count", () => {
    const d = fxDataset();
    d.bars = Array.from({ length: 300 }, (_, i) => ({ t: "bad", open: "x", high: "x", low: "x", close: "x", volume: null, i }));
    const err = (() => { try { parseDataset(d); } catch (e) { return e as ValidationError; } throw new Error("no error"); })();
    expect(err.issues.length).toBe(MAX_ISSUES + 1);
    expect(err.issues[MAX_ISSUES]).toMatch(/^\.\.\. and \d+ more problem\(s\)$/);
  });
});

describe("dataset header and JSON text", () => {
  it.each([
    ["a non-fictional source", (d: any) => { d.source.kind = "vendor"; }, "source.kind: must be one of: fictional"],
    ["recordedAt before the last bar", (d: any) => { d.source.recordedAt = "2026-01-06T00:00:00Z"; }, "must not be earlier than the last bar"],
    ["an unsupported interval", (d: any) => { d.interval = "1h"; }, "interval: must be one of: 1d"],
    ["no annualization basis", (d: any) => { d.annualization = { periodsPerYear: 252 }; }, "annualization.basis: is required"],
    ["an implausible periodsPerYear", (d: any) => { d.annualization.periodsPerYear = 400; }, "from 1 to 366"],
    ["a forex adjustment for a stock", (d: any) => { d.adjustment = "not_applicable"; }, "must be none, splits or splits_and_dividends for stocks"],
    ["control characters in text", (d: any) => { d.title = "Fictional\u001b[2J"; }, "control, bidi or invisible"],
    ["a multi-line title", (d: any) => { d.title = "a\nb"; }, "must be a single line"],
    ["an unknown version", (d: any) => { d.version = 2; }, "version: must be 1"],
  ])("refuses %s", (_label, mutate, message) => {
    const d = usDataset();
    mutate(d);
    expect(issuesOf(() => parseDataset(d))).toContain(message);
  });

  it("refuses duplicate keys (including escaped spellings), deep nesting, a BOM and non-JSON", () => {
    const t = text(usDataset());
    expect(issuesOf(() => parseDatasetText(t.replace('"id":"fict-us"', '"id":"fict-us","id":"other"')))).toContain('duplicate key "id"');
    expect(issuesOf(() => parseDatasetText(t.replace('"title":', '"\\u0074itle":"x","title":')))).toContain('duplicate key "title"');
    expect(issuesOf(() => parseDatasetText(`${"[".repeat(40)}${"]".repeat(40)}`))).toContain("nested more than");
    expect(issuesOf(() => parseDatasetText(`\ufeff${t}`))).toContain("byte-order mark");
    expect(issuesOf(() => parseDatasetText("{not json"))).toContain("is not valid JSON");
    expect(issuesOf(() => parseDatasetText(42))).toContain("must be JSON text");
  });

  it("refuses getters without reading them (direct objects)", () => {
    const d = usDataset();
    let reads = 0;
    Object.defineProperty(d, "title", { get: () => { reads += 1; return "x"; }, enumerable: true });
    expect(issuesOf(() => parseDataset(d))).toContain("getter/setter");
    expect(reads).toBe(0);
  });
});

describe("SHA-256 provenance over the validated dataset", () => {
  it("is deterministic, independent of formatting and equivalent decimals, and changes with any data", () => {
    const a = datasetSha256(parseDatasetText(text(usDataset())));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(datasetSha256(parseDatasetText(JSON.stringify(usDataset(), null, 2)))).toBe(a);
    const reordered = usDataset();
    reordered.bars[0].close = "100.0";
    reordered.costs.spread.value = "0.020";
    expect(datasetSha256(parseDataset(reordered))).toBe(a);
    const changed = usDataset();
    changed.bars[3].close = "108.80";
    expect(datasetSha256(parseDataset(changed))).not.toBe(a);
    const relabelled = usDataset();
    relabelled.adjustment = "none";
    expect(datasetSha256(parseDataset(relabelled))).not.toBe(a);
  });

  it("hashes exactly the documented representation", () => {
    const ds = parseDatasetText(text(ukDataset()));
    expect(JSON.parse(canonicalDatasetText(ds))).toEqual([
      "automaton/trading-research/dataset/v1", 1, "fict-uk", "Fictional dataset fict-uk", "fictional", "Invented for tests", "operator", "2026-02-01T00:00:00Z",
      "none", "1d", 253, "fictional: 253 trading days per year", ["Invented prices for arithmetic checks."],
      ["FKX", "uk_equity", "Fictional Holdings plc (fictional)", "GBX", "0.5", null, null, null],
      ["per_bar", null, "GBP", "5", "50"],
      [["2026-01-05T21:00:00Z", 500, 505, 498, 500, 40000, 2], ["2026-01-06T21:00:00Z", 500, 502, 481, 490, 52000, 3], ["2026-01-07T21:00:00Z", 490, 520, 489, 511, 61000, 2]],
    ]);
  });

  it("verifies against an operator-retained reference and refuses a mismatch", () => {
    const ds = parseDatasetText(text(fxDataset()));
    expect(() => verifyDatasetSha256(ds, datasetSha256(ds))).not.toThrow();
    expect(issuesOf(() => verifyDatasetSha256(ds, "0".repeat(64)))).toContain("does not match the recorded reference");
    expect(issuesOf(() => verifyDatasetSha256(ds, "ABC"))).toContain("64 lowercase hex characters");
  });
});

describe("metrics (hand-checked)", () => {
  const usCloses = [10000, 11000, 9900, 10890];

  it("returns: simple close-to-close and total", () => {
    expect(simpleReturns(usCloses)).toEqual([0.1, -0.1, 0.1]);
    expect(totalReturn(usCloses)).toEqual({ status: "ok", value: 0.089 }); // 108.90 / 100.00 - 1
    expect(totalReturn([10000])).toMatchObject({ status: "insufficient_data", required: 2, available: 1 });
  });

  it("maximum drawdown with peak, trough, length and recovery", () => {
    expect(maxDrawdown(usCloses)).toEqual({ status: "ok", value: { maxDrawdown: -0.1, peakIndex: 1, troughIndex: 2, lengthBars: 1, recoveryIndex: null } });
    expect(maxDrawdown([500, 490, 511]).value).toMatchObject({ maxDrawdown: -0.02, recoveryIndex: 2 }); // 245p after 250p, recovered at 255.5p
    expect(maxDrawdown([100, 101, 102]).value).toEqual({ maxDrawdown: 0, peakIndex: 0, troughIndex: 0, lengthBars: 0, recoveryIndex: null });
    expect(maxDrawdown([100])).toMatchObject({ status: "insufficient_data" });
  });

  it("annualised volatility: sample standard deviation of log returns times sqrt(periodsPerYear)", () => {
    const closes = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 100000 : 110000));
    // 20 returns of +/- ln(1.1), mean 0: sample sd = ln(1.1) * sqrt(20/19); x sqrt(260) = 1.5767547943 (computed independently)
    expect(annualizedVolatility(closes, 260)).toEqual({ status: "ok", value: 1.5767547943 });
    expect(annualizedVolatility(closes.slice(0, MIN_VOLATILITY_RETURNS), 260)).toMatchObject({ status: "insufficient_data", required: 21, available: 20 });
    expect(annualizedVolatility(Array(21).fill(100), 252)).toEqual({ status: "ok", value: 0 });
    expect(() => annualizedVolatility(closes, 0)).toThrow("periodsPerYear");
  });

  it("risk/reward of a long idea in exact ticks", () => {
    const us = parseDatasetText(text(usDataset())).instrument;
    expect(riskReward(us, { entry: "100.00", stop: "95.00", target: "115.00" })).toEqual({ riskTicks: 500, rewardTicks: 1500, ratio: 3 });
    expect(riskReward(instrumentOf(USDJPY), { entry: "150.000", stop: "149.500", target: "151.250" })).toEqual({ riskTicks: 500, rewardTicks: 1250, ratio: 2.5 });
    expect(issuesOf(() => riskReward(us, { entry: "100.00", stop: "105.00", target: "115.00" }))).toContain("stop < entry < target");
    expect(issuesOf(() => riskReward(us, { entry: "100.001", stop: "95", target: "115" }))).toContain("whole multiple of the tick size");
  });

  it("refuses invalid inputs instead of computing misleading figures", () => {
    for (const bad of [[0, 1], [-5, 10], [1.5, 2], [Number.MAX_SAFE_INTEGER + 1, 1], "x"]) expect(() => totalReturn(bad as any)).toThrow("positive safe-integer");
  });

  it("summarises a dataset with explicit assumptions; too little data yields no volatility figure", () => {
    const s = summarizeDataset(parseDatasetText(text(usDataset())));
    expect(s.totalReturn).toEqual({ status: "ok", value: 0.089 });
    expect(s.annualizedVolatility).toMatchObject({ status: "insufficient_data", available: 4 });
    expect(s.notes.join("\n")).toContain("Annualised with 252 bars per year (operator-stated: fictional: 252 trading days per year)");
    expect(s.notes.join("\n")).toContain("not a forecast or advice");
    const fx = summarizeDataset(parseDatasetText(text(fxDataset())));
    expect(fx.annualizedVolatility).toEqual({ status: "ok", value: 1.5767547943 });
    expect(fx.maxDrawdown.value).toMatchObject({ maxDrawdown: -0.0909090909, recoveryIndex: 3 });
    expect(summarizeDataset(parseDatasetText(text(ukDataset()))).notes.join("\n")).toContain("NOT adjusted for splits or dividends");
  });

  it("exact tick conversion uses no floating point", () => {
    expect(ticksOf({ units: 30n, scale: 1 }, { units: 1n, scale: 1 })).toBe(30); // 3.0 / 0.1
    expect(ticksOf({ units: 3n, scale: 1 }, { units: 3n, scale: 2 })).toBe(10); // 0.3 / 0.03 (inexact in binary floats)
    expect(ticksOf({ units: 1n, scale: 0 }, { units: 3n, scale: 0 })).toBeNull();
  });
});
