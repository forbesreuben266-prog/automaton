/**
 * Trading research T3: paper-trading simulator. FICTIONAL bars only; all in
 * memory. Hand-checked values match the T2 backtest examples (same rules).
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Account, GENESIS_HASH, PAPER_DISCLAIMER, PaperSession, canonicalHeaderParts, parseBacktestConfig, parseDataset, parseDatasetHeader,
  parseDatasetText, paperHeaderSha256, renderPaperReport, runBacktest, verifyPaperLedger, type Dataset,
} from "../../trading-research/index.js";
import { fxDataset, issuesOf, text, ukDataset, usDataset } from "./fixtures.js";

const config = (over: Record<string, unknown> = {}) => ({
  version: 1, strategy: { kind: "buy_and_hold" }, execution: "next_bar_open", initialCash: { currency: "USD", amount: "10000.00" },
  sizing: { mode: "fixed_units", units: 10 }, slippageBps: "0", ...over,
});
const headerOf = (raw: any) => { const { bars: _b, ...rest } = raw; return parseDatasetHeader(rest); };
/** Starts a session from a raw fixture's header and steps through its raw bars (decimal strings), one at a time. */
function stepThrough(raw: any, over: Record<string, unknown> = {}, count = raw.bars.length) {
  const header = headerOf(raw);
  const s = PaperSession.start(header, parseBacktestConfig(config(over), header));
  for (const bar of raw.bars.slice(0, count)) s.step(bar);
  return s;
}
const MA = { kind: "ma_crossover", fast: 2, slow: 3 };
function maRaw(closes: string[]): any {
  const d = usDataset();
  d.bars = closes.map((c, i) => ({ t: `2026-02-${String(i + 1).padStart(2, "0")}T21:00:00Z`, open: c, high: c, low: c, close: c, volume: "100" }));
  d.source.recordedAt = "2026-03-01T00:00:00Z";
  d.costs = { spread: { mode: "fixed", value: "0" }, fees: { currency: "USD", perOrder: "0", proportionalBps: "0" } };
  return d;
}
const MA_CLOSES = ["10", "10", "10", "12", "13", "11", "9", "8"];
const MA_OPTS = { strategy: MA, initialCash: { currency: "USD", amount: "1000.00" }, sizing: { mode: "fixed_units", units: 1 } };

describe("one execution model: paper replay equals the backtest", () => {
  const cases: Array<[string, () => any, Record<string, unknown>]> = [
    ["US buy-and-hold", usDataset, {}],
    ["US with slippage", usDataset, { slippageBps: "10" }],
    ["US rejected orders", usDataset, { sizing: { mode: "fixed_units", units: 1000 } }],
    ["UK all-cash in GBX/GBP", ukDataset, { initialCash: { currency: "GBP", amount: "1000.00" }, sizing: { mode: "all_cash" } }],
    ["EURUSD", fxDataset, { initialCash: { currency: "USD", amount: "20000.00" }, sizing: { mode: "fixed_units", units: 10000 }, slippageBps: "1" }],
    ["moving-average crossover", () => maRaw(MA_CLOSES), MA_OPTS],
  ];
  it.each(cases)("%s: identical fills, rejections, equity and metrics", (_label, make, over) => {
    const ds: Dataset = parseDataset(make());
    const cfg = parseBacktestConfig(config(over), ds);
    const bt = runBacktest(ds, cfg);
    const snap = PaperSession.replay(ds, cfg).snapshot();
    expect(bt.status).toBe("ok");
    expect(snap.fills).toEqual(bt.fills);
    expect(snap.rejections).toEqual(bt.rejections);
    expect(snap.equity).toEqual(bt.equity);
    expect(snap.metrics).toEqual(bt.metrics);
  });
});

describe("one bar at a time (hand-checked US buy-and-hold)", () => {
  it("decides after a close, keeps the order pending, and fills at the next open", () => {
    const after1 = stepThrough(usDataset(), {}, 1).snapshot();
    expect(after1).toMatchObject({ barsProcessed: 1, position: "flat", units: 0, cash: "10000", fills: [] });
    expect(after1.pendingOrder).toEqual({ side: "buy", target: "long", decisionIndex: 0, decisionTime: "2026-01-05T21:00:00Z" });
    const after2 = stepThrough(usDataset(), {}, 2).snapshot();
    // fill = 100.00 + 0.02/2 = 100.01; cash = 10000 - (10 x 100.01 + 1.00) = 8998.90
    expect(after2.fills.map((f) => [f.side, f.decisionIndex, f.fillIndex, f.fillPrice, f.cashAfter])).toEqual([["buy", 0, 1, "100.01", "8998.9"]]);
    expect(after2).toMatchObject({ position: "long", units: 10, cash: "8998.9", pendingOrder: null });
    expect(after2.equity.map((p) => p.equity)).toEqual(["10000", "10098.9"]);
  });

  it("records the lifecycle as events in a fixed order", () => {
    const s = stepThrough(usDataset(), {}, 2);
    expect(s.events().map((e) => e.type)).toEqual([
      "session_started", "bar_received", "equity_marked", "decision", "bar_received", "order_filled", "equity_marked", "decision",
    ]);
    const events = s.events();
    expect(events[1].data).toEqual([0, "2026-01-05T21:00:00Z", 9950, 10050, 9900, 10000, 1200, 2]);
    expect(events[3].data).toEqual([0, "2026-01-05T21:00:00Z", "long", "buy"]);
    expect(events[5].data).toEqual(["buy", 0, 1, "2026-01-06T21:00:00Z", 10, "100", "100.01", "1", "0.1", "0", "8998.9", null]);
    expect(events[7].data).toEqual([1, "2026-01-06T21:00:00Z", "long", null]);
  });

  it("an empty session has no figures", () => {
    const header = headerOf(usDataset());
    const s = PaperSession.start(header, parseBacktestConfig(config(), header));
    expect(s.snapshot()).toMatchObject({ barsProcessed: 0, metrics: null, firstBar: null, pendingOrder: null, events: 1 });
  });
});

describe("replay and the hash-chained ledger", () => {
  it("stepping raw bars and replaying the validated dataset give the same events and ledger head", () => {
    const raw = ukDataset();
    const over = { initialCash: { currency: "GBP", amount: "1000.00" }, sizing: { mode: "all_cash" } };
    const stepped = stepThrough(raw, over);
    const ds = parseDatasetText(text(ukDataset()));
    const replayed = PaperSession.replay(ds, parseBacktestConfig(config(over), ds));
    expect(replayed.events()).toEqual(stepped.events());
    expect(replayed.ledgerHead).toBe(stepped.ledgerHead);
    expect(PaperSession.replay(ds, parseBacktestConfig(config(over), ds)).ledgerHead).toBe(stepped.ledgerHead); // deterministic
  });

  it("hashes exactly the documented canonical form", () => {
    const s = stepThrough(usDataset(), {}, 1);
    const events = s.events();
    let prev = GENESIS_HASH;
    for (const e of events) {
      const expected = createHash("sha256").update(JSON.stringify(["automaton/trading-research/paper-event/v1", e.seq, prev, e.type, e.data]), "utf8").digest("hex");
      expect(e.hash).toBe(expected);
      expect(e.prevHash).toBe(prev);
      prev = e.hash;
    }
    const header = headerOf(usDataset());
    const headerHash = createHash("sha256").update(JSON.stringify(["automaton/trading-research/paper-header/v1", ...canonicalHeaderParts(header)]), "utf8").digest("hex");
    expect(paperHeaderSha256(header)).toBe(headerHash);
    expect(events[0].data).toEqual([headerHash, "buy_and_hold", [], ["fixed_units", 10], ["USD", "10000"], "0", "next_bar_open"]);
  });

  it("different inputs give a different ledger head (config, header or any bar)", () => {
    const base = stepThrough(usDataset()).ledgerHead;
    expect(stepThrough(usDataset(), { slippageBps: "1" }).ledgerHead).not.toBe(base);
    const otherBar = usDataset();
    otherBar.bars[3].close = "108.80";
    expect(stepThrough(otherBar).ledgerHead).not.toBe(base);
    const otherHeader = usDataset();
    otherHeader.title = "Another fictional title";
    expect(stepThrough(otherHeader).ledgerHead).not.toBe(base);
  });

  it("verifyPaperLedger accepts the ledger and detects edits, reordering and removal", () => {
    const events = stepThrough(usDataset()).events();
    expect(verifyPaperLedger(events)).toBe(events[events.length - 1].hash);
    const edited = events.map((e, i) => (i === 5 ? { ...e, data: [...e.data.slice(0, 6), "99.99", ...e.data.slice(7)] } : e));
    expect(issuesOf(() => verifyPaperLedger(edited))).toContain("event 5 does not match its hash chain");
    expect(issuesOf(() => verifyPaperLedger([events[0], events[2], events[1], ...events.slice(3)]))).toContain("does not match its hash chain");
    expect(issuesOf(() => verifyPaperLedger(events.slice(1)))).toContain("event 0 does not match");
    // An event from another ledger at the same position is self-consistent but does not chain to its predecessor.
    const other = stepThrough(usDataset(), { slippageBps: "1" }).events();
    const spliced = [...events.slice(0, 3), other[3], ...events.slice(4)];
    expect(spliced[3].seq).toBe(3);
    expect(issuesOf(() => verifyPaperLedger(spliced))).toContain("event 3 does not match its hash chain");
  });

  it("the ledger is append-only: callers get frozen copies", () => {
    const s = stepThrough(usDataset(), {}, 2);
    const copy = s.events() as any[];
    expect(Object.isFrozen(copy)).toBe(true);
    expect(() => copy.push({})).toThrow();
    expect(() => { (copy[1].data as any[])[0] = 99; }).toThrow();
    expect(s.events().length).toBe(8);
  });
});

describe("no look-ahead and no same-bar fills", () => {
  it("events up to bar k are identical whatever bars come later", () => {
    const base = stepThrough(maRaw(MA_CLOSES), MA_OPTS);
    for (let k = 2; k < MA_CLOSES.length - 1; k++) {
      const altered = MA_CLOSES.map((c, i) => (i > k ? String(Number(c) * 5 + i) : c));
      const s = stepThrough(maRaw(altered), MA_OPTS);
      const upTo = (events: ReturnType<typeof s.events>) => events.slice(0, events.findIndex((e) => e.type === "decision" && e.data[0] === k) + 1);
      expect(upTo(s.events()), `k=${k}`).toEqual(upTo(base.events()));
    }
  });

  it("the shared account refuses an order filled on its own decision bar", () => {
    const ds = parseDatasetText(text(usDataset()));
    const account = new Account(ds, parseBacktestConfig(config(), ds));
    expect(() => account.execute("long", 1, 1, ds.bars[1])).toThrow("no same-bar fills");
  });
});

describe("validation of supplied bars (the session is unchanged when a bar is refused)", () => {
  const started = () => stepThrough(usDataset(), {}, 2);
  it.each([
    ["inconsistent prices", { t: "2026-01-07T21:00:00Z", open: "109.00", high: "100.00", low: "98.50", close: "99.00", volume: "1" }, "prices are inconsistent"],
    ["a bar not after the previous one", { ...usDataset().bars[1] }, "must be later than the previous bar"],
    ["a second bar on the same UTC date", { ...usDataset().bars[2], t: "2026-01-06T22:00:00Z" }, "on a later UTC date"],
    ["a price off the tick grid", { ...usDataset().bars[2], close: "99.005" }, "whole multiple of the tick size"],
    ["an extra field", { ...usDataset().bars[2], note: "x" }, "note: is not an allowed field"],
    ["not an object", "bar", "must be an object"],
  ])("refuses %s", (_label, bar, message) => {
    const s = started();
    const before = [s.events().length, s.ledgerHead, s.barsProcessed];
    expect(issuesOf(() => s.step(bar))).toContain(message);
    expect([s.events().length, s.ledgerHead, s.barsProcessed]).toEqual(before);
    // The session continues exactly as if the refused bar had never been supplied.
    s.step(usDataset().bars[2]);
    expect(s.events()).toEqual(stepThrough(usDataset(), {}, 3).events());
  });

  it("refuses forex volume and a header with bars or an invalid source", () => {
    const fx = stepThrough(fxDataset(), { initialCash: { currency: "USD", amount: "20000.00" } }, 2);
    expect(issuesOf(() => fx.step({ ...fxDataset().bars[2], volume: "5" }))).toContain("volume: must be null for forex");
    expect(issuesOf(() => parseDatasetHeader(usDataset()))).toContain("dataset.bars: is not an allowed field");
    const bad = usDataset();
    bad.source.kind = "vendor";
    expect(issuesOf(() => headerOf(bad))).toContain("source.kind: must be one of: fictional");
  });
});

describe("cash limits and currencies", () => {
  it("records rejected orders, never borrows, and retries on the next decision", () => {
    const s = stepThrough(usDataset(), { sizing: { mode: "fixed_units", units: 1000 } });
    expect(s.events().filter((e) => e.type === "order_rejected").map((e) => e.data[4])).toEqual(Array(3).fill("insufficient cash for 1000 units including fees"));
    expect(s.snapshot()).toMatchObject({ cash: "10000", units: 0, fills: [] });
    expect(s.snapshot().pendingOrder).toMatchObject({ side: "buy", decisionIndex: 3 });
  });

  it("UK stock in pence with GBP cash and fees (hand-checked), forex in its quote currency", () => {
    const uk = stepThrough(ukDataset(), { initialCash: { currency: "GBP", amount: "1000.00" }, sizing: { mode: "all_cash" } }).snapshot();
    expect(uk.fills[0]).toMatchObject({ units: 394, fillPrice: "250.75", fees: "9.939775", cashAfter: "2.105225" });
    expect(uk.metrics).toMatchObject({ finalEquity: "1008.775225" });
    const fx = stepThrough(fxDataset(), { initialCash: { currency: "USD", amount: "20000.00" }, sizing: { mode: "fixed_units", units: 10000 }, slippageBps: "1" }).snapshot();
    expect(fx.fills[0]).toMatchObject({ fillPrice: "1.10017", fees: "0.550085", cashAfter: "8997.749915" });
    expect(fx.metrics).toMatchObject({ finalEquity: "18997.749915" });
  });
});

describe("paper report", () => {
  it("is clearly labelled as simulated and states provenance, ledger head, position, pending order and limitations", () => {
    const s = stepThrough(usDataset(), {}, 1);
    const md = renderPaperReport(s);
    expect(md).toContain("# Paper-trading report (SIMULATED)");
    expect(md).toContain(PAPER_DISCLAIMER);
    expect(md).toContain(`Header SHA-256: ${s.headerSha256}`);
    expect(md).toContain(`final hash ${s.ledgerHead}`);
    expect(md).toContain("Pending simulated order: buy (decided after the bar of 2026-01-05T21:00:00Z)");
    expect(md).toContain("there is no clock, schedule or background process");
    expect(md).not.toMatch(/\b(guaranteed|will (make|earn|profit)|proven|predicts?)\b/i);
    const full = renderPaperReport(stepThrough(usDataset()));
    expect(full).toContain("Open position: 10 units");
    expect(full).toContain("| Simulated total return | 0.8790% |");
  });

  it("escapes header text and handles an empty session", () => {
    const raw = usDataset();
    raw.title = "Paper [x](javascript:y) <i>t</i>";
    const header = headerOf(raw);
    const md = renderPaperReport(PaperSession.start(header, parseBacktestConfig(config(), header)));
    expect(md).toContain("Paper \\[x\\]\\(javascript:y\\) \\<i\\>t\\</i\\>");
    expect(md).toContain("No bars processed yet: no figures.");
  });
});
