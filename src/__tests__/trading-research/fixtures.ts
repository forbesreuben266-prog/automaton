/**
 * FICTIONAL trading research fixtures (T1). Invented instruments, prices,
 * spreads and fees chosen for hand-checkable arithmetic; they do not
 * represent any real security, market, price or cost.
 */

const day = (d: number) => `2026-01-${String(d).padStart(2, "0")}T21:00:00Z`;

const header = (id: string, adjustment: string, periodsPerYear: number, basis: string) => ({
  version: 1, id, title: `Fictional dataset ${id}`,
  source: { kind: "fictional", label: "Invented for tests", recordedBy: "operator", recordedAt: "2026-02-01T00:00:00Z" },
  adjustment, interval: "1d", annualization: { periodsPerYear, basis }, limitations: ["Invented prices for arithmetic checks."],
});

/** US stock, USD, tick 0.01, fixed spread. Closes 100.00, 110.00, 99.00, 108.90 (returns +10%, -10%, +10%). */
export function usDataset(): any {
  const bar = (d: number, o: string, h: string, l: string, c: string, v: string) => ({ t: day(d), open: o, high: h, low: l, close: c, volume: v });
  return {
    ...header("fict-us", "splits_and_dividends", 252, "fictional: 252 trading days per year"),
    instrument: { assetClass: "us_equity", symbol: "FICT", name: "Fictional Corp (fictional)", priceUnit: "USD", tickSize: "0.01" },
    costs: { spread: { mode: "fixed", value: "0.02" }, fees: { currency: "USD", perOrder: "1.00", proportionalBps: "0" } },
    bars: [
      bar(5, "99.50", "100.50", "99.00", "100.00", "1200"),
      bar(6, "100.00", "111.00", "100.00", "110.00", "1500"),
      bar(7, "109.00", "109.50", "98.50", "99.00", "1800"),
      bar(8, "99.00", "109.00", "98.90", "108.90", "900"),
    ],
  };
}

/** UK stock priced in pence (GBX), tick 0.5p, per-bar spreads, fees in GBP. */
export function ukDataset(): any {
  const bar = (d: number, o: string, h: string, l: string, c: string, v: string, spread: string) => ({ t: day(d), open: o, high: h, low: l, close: c, volume: v, spread });
  return {
    ...header("fict-uk", "none", 253, "fictional: 253 trading days per year"),
    instrument: { assetClass: "uk_equity", symbol: "FKX", name: "Fictional Holdings plc (fictional)", priceUnit: "GBX", tickSize: "0.5" },
    costs: { spread: { mode: "per_bar" }, fees: { currency: "GBP", perOrder: "5.00", proportionalBps: "50" } },
    bars: [
      bar(5, "250", "252.5", "249", "250", "40000", "1"),
      bar(6, "250", "251", "240.5", "245", "52000", "1.5"),
      bar(7, "245", "260", "244.5", "255.5", "61000", "1"),
    ],
  };
}

/** EURUSD, tick 0.00001 (a tenth of a pip). 21 closes alternating 1.00000 / 1.10000 (20 returns of +-ln 1.1). */
export function fxDataset(): any {
  const bars = Array.from({ length: 21 }, (_, i) => {
    const c = i % 2 === 0 ? "1.00000" : "1.10000";
    return { t: day(i + 1), open: c, high: "1.10000", low: "1.00000", close: c, volume: null };
  });
  return {
    ...header("fict-eurusd", "not_applicable", 260, "fictional: 5 days x 52 weeks"),
    instrument: { assetClass: "fx", symbol: "EURUSD", name: "Euro / US dollar (fictional prices)", base: "EUR", quote: "USD", pipSize: "0.0001", tickSize: "0.00001" },
    costs: { spread: { mode: "fixed", value: "0.00012" }, fees: { currency: "USD", perOrder: "0", proportionalBps: "0.5" } },
    bars,
  };
}

/** USDJPY instrument (quoted in JPY: pip 0.01, tick 0.001). */
export const USDJPY = { assetClass: "fx", symbol: "USDJPY", name: "US dollar / yen (fictional)", base: "USD", quote: "JPY", pipSize: "0.01", tickSize: "0.001" };

export const text = (o: unknown) => JSON.stringify(o);

/** Throws unless fn throws; returns the issues joined. */
export function issuesOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const e = err as { issues?: readonly string[]; message: string };
    return e.issues ? e.issues.join("\n") : e.message;
  }
  throw new Error("expected a refusal");
}
