/** R1: market-data readiness for US stocks, UK stocks and forex (fictional records only). */

import { describe, expect, it } from "vitest";
import { assessMarketData, expectedCloseUtc, parseMarketData } from "../../research-readiness/index.js";
import { asserted, clone, detailsOf, marketRecord, statusOf, unverified, verified } from "./fixtures.js";

const refusal = (raw: unknown) => {
  const r = assessMarketData(raw);
  expect(r.overall).toBe("refused");
  return r.checks[0].details.join("\n");
};
const edit = (kind: "us" | "uk" | "fx", f: (r: any) => void) => { const r = marketRecord(kind); f(r); return r; };
const split = { exDate: "2026-03-10", type: "split", detail: "Fictional 2-for-1 split." };
const dividend = { exDate: "2026-03-10", type: "cash_dividend", detail: "Fictional 0.50 USD dividend." };

describe("complete, verified records", () => {
  it.each(["us", "uk", "fx"] as const)("%s: every condition passes across a daylight-saving change, and nothing is approved", (kind) => {
    const r = assessMarketData(marketRecord(kind));
    expect(r.overall).toBe("ready_for_operator_review");
    expect(r.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(r.approvedForRealWorldUse).toBe(false);
  });

  it("converts local closes to UTC with US (from 2007) and UK daylight-saving rules", () => {
    expect([
      expectedCloseUtc("XNYS", "2026-03-06", "16:00"), expectedCloseUtc("XNYS", "2026-03-09", "16:00"),
      expectedCloseUtc("XNAS", "2026-10-30", "16:00"), expectedCloseUtc("XNAS", "2026-11-02", "16:00"),
      expectedCloseUtc("XNYS", "2026-11-27", "13:00"), expectedCloseUtc("FX", "2026-07-01", "17:00"), expectedCloseUtc("FX", "2026-12-01", "17:00"),
      expectedCloseUtc("XLON", "2026-03-27", "16:30"), expectedCloseUtc("XLON", "2026-03-30", "16:30"),
      expectedCloseUtc("XLON", "2026-10-23", "16:30"), expectedCloseUtc("XLON", "2026-10-26", "16:30"), expectedCloseUtc("XLON", "2026-12-24", "12:30"),
    ]).toEqual([
      "2026-03-06T21:00:00Z", "2026-03-09T20:00:00Z", "2026-10-30T20:00:00Z", "2026-11-02T21:00:00Z", "2026-11-27T18:00:00Z", "2026-07-01T21:00:00Z", "2026-12-01T22:00:00Z",
      "2026-03-27T16:30:00Z", "2026-03-30T15:30:00Z", "2026-10-23T15:30:00Z", "2026-10-26T16:30:00Z", "2026-12-24T12:30:00Z",
    ]);
  });

  it("is deterministic and frozen", () => {
    const r = assessMarketData(marketRecord("uk"));
    expect(assessMarketData(marketRecord("uk"))).toEqual(r);
    expect(Object.isFrozen(r.checks[0])).toBe(true);
  });
});

describe("timestamps, calendars and time zones", () => {
  it("duplicate timestamps and sessions fail", () => {
    const r = assessMarketData(edit("us", (x) => { x.bars[3] = { ...x.bars[2] }; }));
    expect(statusOf(r, "timestamps_unique_and_ordered")).toBe("fail");
    expect(detailsOf(r, "timestamps_unique_and_ordered")).toEqual(["bar 3: duplicate timestamp 2026-03-04T21:00:00Z", "bar 3: duplicate session 2026-03-04"]);
    expect(statusOf(r, "no_missing_bars")).toBe("fail"); // 2026-03-05 now has no bar
  });

  it("out-of-order bars fail", () => {
    const r = assessMarketData(edit("us", (x) => { [x.bars[4], x.bars[5]] = [x.bars[5], x.bars[4]]; }));
    expect(detailsOf(r, "timestamps_unique_and_ordered")).toEqual(["bar 5: out of order (2026-03-06T21:00:00Z after 2026-03-09T20:00:00Z)"]);
  });

  it("a missing bar fails, naming the session", () => {
    const r = assessMarketData(edit("uk", (x) => { x.bars.splice(4, 1); }));
    expect([statusOf(r, "no_missing_bars"), detailsOf(r, "no_missing_bars"), r.overall]).toEqual(["fail", ["missing 2026-03-27"], "not_ready"]);
  });

  it("a bar stamped with the wrong daylight-saving offset fails (time-zone error)", () => {
    const r = assessMarketData(edit("us", (x) => { x.bars[5].t = "2026-03-09T21:00:00Z"; }));
    expect(statusOf(r, "bars_match_calendar")).toBe("fail");
    expect(detailsOf(r, "bars_match_calendar")[0]).toBe("bar 5: timestamp 2026-03-09T21:00:00Z is not the session close 2026-03-09T20:00:00Z (16:00 America/New_York); check the time zone and daylight saving");
  });

  it("a bar on a date that is not a session fails; an early close matches its own time", () => {
    const off = assessMarketData(edit("us", (x) => { x.calendar.sessions.splice(2, 1); }));
    expect(detailsOf(off, "bars_match_calendar")).toEqual(["bar 2: session 2026-03-04 is not a calendar session"]);
    const early = edit("us", (x) => { x.calendar.sessions[9].closeLocal = "13:00"; x.bars[9].t = "2026-03-13T17:00:00Z"; });
    expect(assessMarketData(early).overall).toBe("ready_for_operator_review");
  });

  it("an unchecked calendar leaves the result unverified", () => {
    const r = assessMarketData(edit("fx", (x) => { x.calendar.attestation = asserted("The vendor's file says these are all sessions."); }));
    expect([statusOf(r, "calendar_verified"), r.overall]).toEqual(["unverified", "unverified"]);
  });

  const unsupported: Array<[string, "us" | "uk" | "fx", (x: any) => void, RegExp]> = [
    ["a weekend session", "us", (x) => { x.calendar.sessions.push({ date: "2026-03-14", closeLocal: "16:00" }); }, /falls on a weekend/],
    ["duplicate sessions", "us", (x) => { x.calendar.sessions.push({ date: "2026-03-13", closeLocal: "16:00" }); }, /must be later than the previous session/],
    ["another time zone", "uk", (x) => { x.calendar.timeZone = "UTC"; }, /timeZone: must be Europe\/London for XLON; other time zones are unsupported/],
    ["a calendar for another exchange", "us", (x) => { x.calendar.exchange = "XNAS"; }, /calendar\.exchange: must be the instrument's exchange \(XNYS\)/],
    ["an unsupported exchange", "uk", (x) => { x.instrument.exchange = "XPAR"; }, /instrument\.exchange: must be one of: XLON/],
    ["another forex daily close", "fx", (x) => { x.calendar.sessions[0].closeLocal = "16:00"; }, /must be 17:00 \(the New York forex daily close\)/],
    ["a close after the standard close", "uk", (x) => { x.calendar.sessions[0].closeLocal = "17:00"; }, /must be from 12:00 to the standard close \(16:30\)/],
    ["dates before 2007", "us", (x) => { x.calendar.sessions.unshift({ date: "2006-12-29", closeLocal: "16:00" }); }, /sessions before 2007-01-01 are not modelled/],
  ];
  it.each(unsupported)("refuses %s", (_name, kind, f, message) => {
    expect(refusal(edit(kind, f))).toMatch(message);
  });
});

describe("stale and inconsistent prices", () => {
  const flatten = (x: any, from: number, count: number) => {
    for (let i = from; i < from + count; i++) {
      const c = x.bars[from - 1].close;
      Object.assign(x.bars[i], { open: c, high: c, low: c, close: c });
    }
  };
  it(`${3} unchanged bars in a row fail as stale; a single one is unverified`, () => {
    const run = assessMarketData(edit("us", (x) => flatten(x, 4, 3)));
    expect([statusOf(run, "prices_not_stale"), run.checks.find((c) => c.id === "prices_not_stale")!.summary]).toEqual([
      "fail", "3 consecutive bars repeat the previous close unchanged (stale or carried-forward prices).",
    ]);
    const one = assessMarketData(edit("fx", (x) => flatten(x, 4, 1)));
    expect([statusOf(one, "prices_not_stale"), detailsOf(one, "prices_not_stale")]).toEqual(["unverified", ["bar 4 (2026-03-06): open = high = low = close = previous close"]]);
  });

  it("zero volume is flagged for review", () => {
    const r = assessMarketData(edit("uk", (x) => { x.bars[2].volume = "0"; }));
    expect([statusOf(r, "prices_not_stale"), detailsOf(r, "prices_not_stale")]).toEqual(["unverified", ["bar 2 (2026-03-25): zero volume"]]);
  });

  it("inconsistent prices fail; malformed prices are refused", () => {
    const r = assessMarketData(edit("us", (x) => { x.bars[1].high = "1.00"; }));
    expect(detailsOf(r, "prices_consistent")).toEqual(["bar 1 (2026-03-03): need low <= open, close <= high"]);
    expect(refusal(edit("us", (x) => { x.bars[1].close = 101; }))).toMatch(/bars\[1\]\.close: must be a decimal string/);
    expect(refusal(edit("us", (x) => { x.bars[1].close = "0"; }))).toMatch(/must be greater than zero/);
    expect(refusal(edit("fx", (x) => { x.bars[1].volume = "10"; }))).toMatch(/must be null for forex/);
  });

  it("a source retrieved before its last bar fails; an untraced source fails", () => {
    const early = assessMarketData(edit("us", (x) => { x.source.retrievedAt = "2026-03-12T00:00:00Z"; x.source.publishedAt.value = "2026-03-11"; }));
    expect(statusOf(early, "retrieved_after_data")).toBe("fail");
    const rumour = edit("us", (x) => {
      Object.assign(x.source, { sourceClass: "unverified_claim", originId: null });
      x.source.verification.origin = unverified();
    });
    expect(statusOf(assessMarketData(rumour), "source_provenance")).toBe("fail");
    const unchecked = edit("uk", (x) => { x.source.verification.publisher_identity = asserted("The file header names the vendor."); });
    expect(statusOf(assessMarketData(unchecked), "source_provenance")).toBe("unverified");
  });
});

describe("currency conventions", () => {
  const ambiguous: Array<[string, "us" | "uk" | "fx", (x: any) => void, RegExp]> = [
    ["UK pence written GBp", "uk", (x) => { x.instrument.priceCurrency = "GBp"; }, /must be GBP \(pounds\) or GBX \(pence\) exactly for a UK stock; GBp, p, pence/],
    ["UK prices written pence", "uk", (x) => { x.instrument.priceCurrency = "pence"; }, /GBP \(pounds\) or GBX \(pence\) exactly/],
    ["a UK stock with no currency", "uk", (x) => { delete x.instrument.priceCurrency; }, /instrument\.priceCurrency: is required/],
    ["a US stock priced in GBP", "us", (x) => { x.instrument.priceCurrency = "GBP"; }, /must be USD for a US stock/],
    ["an inverted forex quotation", "fx", (x) => { x.instrument.priceCurrency = "EUR"; }, /must be the quote currency \(USD\); a different currency means an inverted or ambiguous quotation/],
    ["an unstated forex convention", "fx", (x) => { x.instrument.quoteConvention = "per_unit"; }, /must be quote_per_base/],
    ["a forex symbol that disagrees with its currencies", "fx", (x) => { x.instrument.symbol = "USDEUR"; }, /must be the base and quote codes joined \(EURUSD\)/],
    ["a crypto code", "fx", (x) => { x.instrument.base = "BTC"; x.instrument.symbol = "BTCUSD"; }, /instrument\.base: must be one of: USD, GBP, EUR/],
  ];
  it.each(ambiguous)("refuses %s", (_name, kind, f, message) => {
    expect(refusal(edit(kind, f))).toMatch(message);
  });

  it("states the convention it accepted", () => {
    expect(detailsOf(assessMarketData(marketRecord("uk")), "currency_convention")).toEqual(["FKUK: prices are in pence (GBX); 100 GBX = 1 GBP."]);
    expect(detailsOf(assessMarketData(marketRecord("fx")), "currency_convention")).toEqual(["EURUSD: prices are USD per 1 EUR; profit and loss would be in USD."]);
  });
});

describe("raw versus adjusted prices and corporate actions", () => {
  it("raw prices across a split fail; across a dividend they are unverified", () => {
    const s = assessMarketData(edit("us", (x) => { x.corporateActions.actions.push(split); }));
    expect([statusOf(s, "price_basis"), detailsOf(s, "price_basis")]).toEqual(["fail", ["split 2026-03-10: Fictional 2-for-1 split."]]);
    const d = assessMarketData(edit("us", (x) => { x.corporateActions.actions.push(dividend); }));
    expect([statusOf(d, "price_basis"), d.overall]).toEqual(["unverified", "unverified"]);
  });

  it("adjusted prices state their method and must be adjusted through the last bar", () => {
    const adjusted = (method: string, through: string, actions: unknown[]) => edit("us", (x) => {
      x.priceBasis = "adjusted";
      x.adjustment = { method, adjustedThrough: through };
      x.corporateActions.actions = actions;
    });
    expect(assessMarketData(adjusted("splits_and_dividends", "2026-03-13", [split, { ...dividend, exDate: "2026-03-11" }])).overall).toBe("ready_for_operator_review");
    expect(statusOf(assessMarketData(adjusted("splits", "2026-03-13", [dividend])), "price_basis")).toBe("unverified");
    const old = assessMarketData(adjusted("splits", "2026-03-12", [split]));
    expect(old.checks.find((c) => c.id === "price_basis")).toMatchObject({ status: "fail", summary: expect.stringContaining("adjusted through 2026-03-12, before the last bar (2026-03-13)") });
  });

  it("an unchecked corporate-action list is unverified; unmodelled actions fail", () => {
    const u = assessMarketData(edit("uk", (x) => { x.corporateActions.attestation = unverified("Issuer notices not reviewed."); }));
    expect([statusOf(u, "corporate_actions"), detailsOf(u, "corporate_actions")]).toEqual(["unverified", ["Issuer notices not reviewed."]]);
    const other = assessMarketData(edit("uk", (x) => { x.corporateActions.actions.push({ exDate: "2026-03-30", type: "other", detail: "Fictional spin-off." }); }));
    expect(statusOf(other, "corporate_actions")).toBe("fail");
  });

  const ambiguousBasis: Array<[string, "us" | "uk" | "fx", (x: any) => void, RegExp]> = [
    ["adjusted prices without a method", "us", (x) => { x.priceBasis = "adjusted"; }, /record\.adjustment: must be an object/],
    ["raw prices with an adjustment", "us", (x) => { x.adjustment = { method: "splits", adjustedThrough: "2026-03-13" }; }, /adjustment: must be null for raw prices/],
    ["an unknown price basis", "uk", (x) => { x.priceBasis = "total_return"; }, /priceBasis: must be one of: raw, adjusted/],
    ["adjusted forex", "fx", (x) => { x.priceBasis = "adjusted"; }, /must be raw for forex/],
    ["corporate actions for forex", "fx", (x) => { x.corporateActions = { actions: [], attestation: verified() }; }, /corporateActions: must be null for forex/],
    ["a stock with no corporate-action record", "us", (x) => { x.corporateActions = null; }, /corporateActions: must be an object/],
    ["an action outside the data period", "us", (x) => { x.corporateActions.actions.push({ ...split, exDate: "2026-02-02" }); }, /must fall within the data period \(2026-03-02 to 2026-03-13\)/],
    ["an unknown action type", "us", (x) => { x.corporateActions.actions.push({ ...split, type: "merger" }); }, /type: must be one of: split, cash_dividend, other/],
  ];
  it.each(ambiguousBasis)("refuses %s", (_name, kind, f, message) => {
    expect(refusal(edit(kind, f))).toMatch(message);
  });
});

describe("parsing", () => {
  it("refuses unknown fields and non-objects, and reports problems together", () => {
    expect(refusal({ ...marketRecord(), live: true })).toMatch(/record\.live: is not a recognised field/);
    expect(refusal("data")).toMatch(/record: must be an object/);
    const many = refusal(edit("us", (x) => { x.bars[0].open = "x"; x.bars[1].t = "2026-03-03"; }));
    expect(many.split("\n")).toEqual(["record.bars[0].open: must be a decimal string like \"123.45\"", "record.bars[1].t: must be a UTC timestamp like 2026-03-02T21:00:00Z"]);
  });

  it("parseMarketData returns the validated record", () => {
    const r = parseMarketData(clone(marketRecord("fx")));
    expect([r.instrument.priceCurrency, r.calendar.timeZone, r.bars.length]).toEqual(["USD", "America/New_York", 10]);
  });
});
