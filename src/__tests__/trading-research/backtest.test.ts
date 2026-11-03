/**
 * Trading research T2: strategies, long-or-flat backtest and report.
 * FICTIONAL data only; expected values were computed independently with
 * exact fractions (see the comments), not with the code under test.
 */

import { describe, expect, it } from "vitest";
import {
  REPORT_DISCLAIMER, backtestFromText, historyView, parseBacktestConfig, parseDataset, parseDatasetText, renderBacktestReport, runBacktest,
  type BacktestResult, type Dataset,
} from "../../trading-research/index.js";
import { fxDataset, issuesOf, text, ukDataset, usDataset } from "./fixtures.js";

const config = (over: Record<string, unknown> = {}) => ({
  version: 1, strategy: { kind: "buy_and_hold" }, execution: "next_bar_open", initialCash: { currency: "USD", amount: "10000.00" },
  sizing: { mode: "fixed_units", units: 10 }, slippageBps: "0", ...over,
});
const run = (ds: Dataset, over: Record<string, unknown> = {}) => runBacktest(ds, parseBacktestConfig(config(over), ds));

/** USD stock, tick 0.01, zero costs unless overridden; open = close = high = low for easy arithmetic. */
function series(closes: string[], costs?: unknown, spreads?: string[]): Dataset {
  const d = usDataset();
  d.bars = closes.map((c, i) => ({ t: `2026-02-${String(i + 1).padStart(2, "0")}T21:00:00Z`, open: c, high: c, low: c, close: c, volume: "100", ...(spreads ? { spread: spreads[i] } : {}) }));
  d.source.recordedAt = "2026-03-01T00:00:00Z";
  d.costs = costs ?? { spread: { mode: "fixed", value: "0" }, fees: { currency: "USD", perOrder: "0", proportionalBps: "0" } };
  return parseDataset(d);
}
const MA = { kind: "ma_crossover", fast: 2, slow: 3 };
const MA_CLOSES = ["10", "10", "10", "12", "13", "11", "9", "8"];

describe("buy-and-hold on a fictional US stock (hand-checked)", () => {
  it("buys at the second bar's open plus half the spread, pays the fee, and marks equity at each close", () => {
    const r = run(parseDatasetText(text(usDataset())));
    // fill = 100.00 + 0.02/2 = 100.01; cost = 10 x 100.01 + 1.00 fee = 1001.10; cash = 8998.90
    expect(r.fills).toEqual([{
      side: "buy", decisionIndex: 0, fillIndex: 1, fillTime: "2026-01-06T21:00:00Z", units: 10, openPrice: "100", fillPrice: "100.01",
      fees: "1", spreadCost: "0.1", slippageCost: "0", cashAfter: "8998.9", realizedPnl: null,
    }]);
    expect(r.equity.map((p) => p.equity)).toEqual(["10000", "10098.9", "9988.9", "10087.9"]);
    expect(r.metrics).toMatchObject({
      initialEquity: "10000", finalEquity: "10087.9", totalReturn: 0.00879, maxDrawdown: -0.0108922754, exposure: 0.75,
      fills: 1, rejections: 0, roundTrips: 0, realizedPnl: "0", unrealizedPnl: "87.9", totalFees: "1", totalSpreadCost: "0.1", totalSlippageCost: "0",
    });
    expect(r.metrics!.annualizedVolatility.status).toBe("insufficient_data");
    expect([r.endUnits, r.unexecutedFinalSignal]).toEqual([10, null]);
  });

  it("applies slippage against the trade (10 bps: fill 100.00 x 1.001 + 0.01 = 100.11)", () => {
    const r = run(parseDatasetText(text(usDataset())), { slippageBps: "10" });
    expect(r.fills[0]).toMatchObject({ fillPrice: "100.11", slippageCost: "1", cashAfter: "8997.9" }); // 10000 - (1001.10 + 1.00)
  });
});

describe("moving-average crossover (fast 2, slow 3), hand-checked", () => {
  it("decides on closes up to bar t, trades at the next open, and records the round trip", () => {
    const r = run(series(MA_CLOSES), { strategy: MA, initialCash: { currency: "USD", amount: "1000.00" }, sizing: { mode: "fixed_units", units: 1 } });
    // t=3: mean(10,12)=11 > mean(10,10,12)=10.67 -> long -> buy at bar 4 open 13
    // t=5: mean(13,11)=12 is not > mean(12,13,11)=12 -> flat -> sell at bar 6 open 9: realised -4
    expect(r.fills.map((f) => [f.side, f.decisionIndex, f.fillIndex, f.fillPrice, f.realizedPnl])).toEqual([["buy", 3, 4, "13", null], ["sell", 5, 6, "9", "-4"]]);
    expect(r.equity.map((p) => p.equity)).toEqual(["1000", "1000", "1000", "1000", "1000", "998", "996", "996"]);
    expect(r.metrics).toMatchObject({ totalReturn: -0.004, maxDrawdown: -0.004, roundTrips: 1, winningRoundTrips: 0, realizedPnl: "-4", exposure: 0.25 });
    expect(r.unexecutedFinalSignal).toBeNull();
  });

  it("reports a final decision that no later bar could execute", () => {
    const r = run(series(["10", "10", "10", "12"]), { strategy: MA, initialCash: { currency: "USD", amount: "1000.00" }, sizing: { mode: "fixed_units", units: 1 } });
    expect(r.fills).toEqual([]);
    expect(r.unexecutedFinalSignal).toBe("long");
  });
});

describe("no look-ahead", () => {
  it("a strategy can only read bars up to the decision bar", () => {
    const ds = series(MA_CLOSES);
    const h = historyView(ds.bars, 3);
    expect(h.close(3)).toBe(1200);
    expect(() => h.close(4)).toThrow("not available at decision bar 3");
    expect(() => h.bar(-1)).toThrow(RangeError);
  });

  it("changing future bars never changes earlier decisions, fills or equity", () => {
    const opts = { strategy: MA, initialCash: { currency: "USD", amount: "1000.00" }, sizing: { mode: "fixed_units", units: 1 } };
    const base = run(series(MA_CLOSES), opts);
    for (let k = 3; k < MA_CLOSES.length - 1; k++) {
      const altered = MA_CLOSES.map((c, i) => (i > k ? String(Number(c) * 7 + i) : c));
      const r = run(series(altered), opts);
      const early = (x: BacktestResult) => x.fills.filter((f) => f.fillIndex <= k);
      expect(early(r), `k=${k}`).toEqual(early(base));
      expect(r.equity.slice(0, k + 1)).toEqual(base.equity.slice(0, k + 1));
    }
  });
});

describe("currencies: GBX prices with GBP cash, forex in the quote currency (hand-checked)", () => {
  it("UK stock priced in pence: all-cash sizing with GBP fees converted exactly (1 GBP = 100 GBX)", () => {
    const uk = parseDatasetText(text(ukDataset()));
    const r = run(uk, { initialCash: { currency: "GBP", amount: "1000.00" }, sizing: { mode: "all_cash" } });
    // fill 250 + 1.5/2 = 250.75p; units = floor((100000p - 500p) / (250.75p x 1.005)) = 394;
    // fee = 500p + 0.5% x 98795.5p = 993.9775p; cash left 210.5225p = 2.105225 GBP; final = (210.5225 + 394 x 255.5) / 100
    expect(r.fills[0]).toMatchObject({ units: 394, fillPrice: "250.75", fees: "9.939775", cashAfter: "2.105225" });
    expect(r.metrics).toMatchObject({ initialEquity: "1000", finalEquity: "1008.775225", totalReturn: 0.008775225 });
    expect(r.accountingCurrency).toBe("GBP");
    expect(r.priceUnit).toBe("GBX");
  });

  it("forex: units of EUR paid in full in USD, profit and loss stays in USD", () => {
    const fx = parseDatasetText(text(fxDataset()));
    const r = run(fx, { initialCash: { currency: "USD", amount: "20000.00" }, sizing: { mode: "fixed_units", units: 10000 }, slippageBps: "1" });
    // fill = 1.10000 x 1.0001 + 0.00012/2 = 1.10017; fee = 0.5 bp of 11001.70 = 0.550085; cash = 8997.749915
    expect(r.fills[0]).toMatchObject({ fillPrice: "1.10017", fees: "0.550085", cashAfter: "8997.749915" });
    expect(r.metrics).toMatchObject({ finalEquity: "18997.749915", totalReturn: -0.0501125043 });
    expect(r.metrics!.annualizedVolatility.status).toBe("ok");
    expect(r.accountingCurrency).toBe("USD");
  });

  it("refuses initial cash in the wrong currency (GBX instead of GBP; another currency for forex)", () => {
    const uk = parseDatasetText(text(ukDataset()));
    expect(issuesOf(() => parseBacktestConfig(config({ initialCash: { currency: "GBX", amount: "1000" } }), uk))).toContain("initialCash.currency: must be GBP");
    const fx = parseDatasetText(text(fxDataset()));
    expect(issuesOf(() => parseBacktestConfig(config({ initialCash: { currency: "EUR", amount: "1000" } }), fx))).toContain("initialCash.currency: must be USD");
  });
});

describe("conservative handling: rejections, cash, insufficient data", () => {
  it("rejects a buy that cash can't cover; the position and cash stay unchanged and later decisions retry", () => {
    const r = run(parseDatasetText(text(usDataset())), { sizing: { mode: "fixed_units", units: 1000 } });
    expect(r.fills).toEqual([]);
    expect(r.rejections.map((j) => [j.side, j.fillIndex, j.reason])).toEqual([1, 2, 3].map((i) => ["buy", i, "insufficient cash for 1000 units including fees"]));
    expect(r.equity.every((p) => p.cash === "10000" && p.units === 0)).toBe(true);
  });

  it("rejects a sale the spread would push to zero or below, keeps the position, and sells at the next valid open", () => {
    const costs = { spread: { mode: "per_bar" }, fees: { currency: "USD", perOrder: "0", proportionalBps: "0" } };
    const spreads = ["0", "0", "0", "0", "0", "0", "30.00", "0"];
    const r = run(series(MA_CLOSES, costs, spreads), { strategy: MA, initialCash: { currency: "USD", amount: "1000.00" }, sizing: { mode: "fixed_units", units: 1 } });
    expect(r.rejections).toEqual([{ side: "sell", decisionIndex: 5, fillIndex: 6, fillTime: "2026-02-07T21:00:00Z", reason: "the spread and slippage would make the sale price zero or negative" }]);
    expect(r.fills.map((f) => [f.side, f.fillIndex, f.fillPrice])).toEqual([["buy", 4, "13"], ["sell", 7, "8"]]);
    expect(r.equity.every((p) => !p.cash.startsWith("-"))).toBe(true);
  });

  it("rejects a sale whose fees would make cash negative", () => {
    const costs = { spread: { mode: "fixed", value: "0" }, fees: { currency: "USD", perOrder: "20.00", proportionalBps: "0" } };
    // all cash: buys 1 unit at 13 for 13 + 20 = 33 (cash 0); selling at 9 would leave 9 - 20 = -11
    const r = run(series(MA_CLOSES, costs), { strategy: MA, initialCash: { currency: "USD", amount: "33.00" }, sizing: { mode: "all_cash" } });
    expect(r.fills.map((f) => [f.side, f.cashAfter])).toEqual([["buy", "0"]]);
    expect(r.rejections.map((j) => j.reason)).toEqual(["fees would exceed the cash available (no negative cash)", "fees would exceed the cash available (no negative cash)"]);
    expect(r.endUnits).toBe(1);
  });

  it("too little data gives insufficient_data and no figures", () => {
    const r = run(series(["10", "10", "10"]), { strategy: MA });
    expect(r).toMatchObject({ status: "insufficient_data", metrics: null, fills: [] });
    expect(r.reason).toContain("needs at least 4 bars");
    expect(run(series(["10"])).status).toBe("insufficient_data");
  });

  it("is deterministic and returns frozen results", () => {
    const ds = parseDatasetText(text(ukDataset()));
    const opts = { initialCash: { currency: "GBP", amount: "1000.00" }, sizing: { mode: "all_cash" } };
    expect(run(ds, opts)).toEqual(run(ds, opts));
    expect(Object.isFrozen(run(ds, opts).fills[0])).toBe(true);
  });
});

describe("configuration: strict, nothing defaulted", () => {
  const ds = parseDatasetText(text(usDataset()));
  it.each([
    ["no slippage", (c: any) => { delete c.slippageBps; }, "config.slippageBps: is required"],
    ["numeric slippage", (c: any) => { c.slippageBps = 1; }, "must be a decimal string"],
    ["excessive slippage", (c: any) => { c.slippageBps = "1000.01"; }, "must be at most 1000"],
    ["another execution model", (c: any) => { c.execution = "same_bar_close"; }, "config.execution: must be one of: next_bar_open"],
    ["an unknown strategy", (c: any) => { c.strategy = { kind: "short_momentum" }; }, "strategy.kind: must be one of: buy_and_hold, ma_crossover"],
    ["fast not below slow", (c: any) => { c.strategy = { kind: "ma_crossover", fast: 5, slow: 5 }; }, "fast must be smaller than slow"],
    ["a non-integer period", (c: any) => { c.strategy = { kind: "ma_crossover", fast: 1.5, slow: 5 }; }, "strategy.fast: must be an integer"],
    ["a period beyond the limit", (c: any) => { c.strategy = { kind: "ma_crossover", fast: 2, slow: 501 }; }, "strategy.slow: must be an integer from 2 to 500"],
    ["extra strategy parameters", (c: any) => { c.strategy = { kind: "buy_and_hold", leverage: 2 }; }, "strategy.leverage: is not an allowed field"],
    ["fixed units without a count", (c: any) => { c.sizing = { mode: "fixed_units" }; }, "sizing.units: is required for fixed_units"],
    ["a unit count with all_cash", (c: any) => { c.sizing = { mode: "all_cash", units: 5 }; }, "must not be given for all_cash"],
    ["zero units", (c: any) => { c.sizing = { mode: "fixed_units", units: 0 }; }, "sizing.units: must be an integer"],
    ["zero initial cash", (c: any) => { c.initialCash = { currency: "USD", amount: "0" }; }, "must be greater than zero"],
    ["an extra field (e.g. leverage)", (c: any) => { c.leverage = 2; }, "config.leverage: is not an allowed field"],
  ])("refuses %s", (_label, mutate, message) => {
    const c = config();
    mutate(c);
    expect(issuesOf(() => parseBacktestConfig(c, ds))).toContain(message);
  });

  it("accepts config JSON text and refuses duplicate keys there", () => {
    expect(backtestFromText(ds, JSON.stringify(config())).status).toBe("ok");
    expect(issuesOf(() => backtestFromText(ds, JSON.stringify(config()).replace('"slippageBps":"0"', '"slippageBps":"0","slippageBps":"5"')))).toContain("duplicate key");
  });
});

describe("report", () => {
  it("states provenance, parameters, costs, assumptions and limitations, with no claims of profitability", () => {
    const uk = parseDatasetText(text(ukDataset()));
    const cfg = parseBacktestConfig(config({ initialCash: { currency: "GBP", amount: "1000.00" }, sizing: { mode: "all_cash" }, slippageBps: "2.5" }), uk);
    const r = runBacktest(uk, cfg);
    const md = renderBacktestReport(uk, cfg, r);
    expect(md).toContain(REPORT_DISCLAIMER);
    expect(md).toContain(`SHA-256 of the validated dataset: ${r.datasetSha256}`);
    expect(md).toContain("Source: fictional (Invented for tests)");
    expect(md).toContain("cash, fees and profit/loss are reported in GBP (1 GBP = 100 GBX, converted exactly)");
    expect(md).toContain("Fees: 5 GBP per order plus 50 basis points");
    expect(md).toContain("Slippage: 2.5 basis points");
    expect(md).toContain("fill at the open of bar t+1");
    expect(md).toContain("Operator note: Invented prices for arithmetic checks.");
    expect(md).not.toMatch(/\b(guaranteed|will (make|earn|profit)|proven|predicts?)\b/i);
  });

  it("escapes text from the data and refuses a result from another dataset", () => {
    const d = usDataset();
    d.title = "Title [link](javascript:x) <b>*bold*</b> # heading";
    const ds = parseDataset(d);
    const cfg = parseBacktestConfig(config(), ds);
    const md = renderBacktestReport(ds, cfg, runBacktest(ds, cfg));
    expect(md).toContain("Title \\[link\\]\\(javascript:x\\) \\<b\\>\\*bold\\*\\</b\\> \\# heading");
    const other = parseDatasetText(text(usDataset()));
    expect(issuesOf(() => renderBacktestReport(other, cfg, runBacktest(ds, cfg)))).toContain("not produced from this dataset");
  });
});
