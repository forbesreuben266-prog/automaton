/**
 * Strategies (trading research T2). Pure and deterministic.
 *
 * A strategy decides, after bar t has closed, whether it wants to be "long"
 * or "flat". It receives a HistoryView of bars 0..t only: reading any later
 * bar throws, so it cannot see the future. The backtest executes the
 * decision no earlier than the open of bar t+1.
 *
 * Built-in strategies (parameters validated; nothing defaulted):
 * - buy_and_hold: { kind: "buy_and_hold" }. Long from the first decision.
 * - ma_crossover: { kind: "ma_crossover", fast, slow } with whole numbers
 *   1 <= fast < slow <= 500. Long while the simple moving average of the
 *   last `fast` closes is ABOVE that of the last `slow` closes (both ending
 *   at bar t); otherwise flat. Before `slow` closes exist it is flat (warm-up).
 * Strategies only ever use closes; they never place orders themselves.
 */

import type { Bar } from "./prices.js";
import { Issues, readObject, readOneOf, readSafeInt } from "./validation.js";

export type Signal = "long" | "flat";
export const MAX_MA_PERIOD = 500;

/** Bars 0..length-1 (the decision bar is the last). Any later index throws. */
export interface HistoryView {
  readonly length: number;
  bar(index: number): Bar;
  close(index: number): number;
}

export interface Strategy {
  readonly kind: "buy_and_hold" | "ma_crossover";
  readonly params: Readonly<Record<string, number>>;
  /** Closes needed before the strategy can be long (1 for buy_and_hold, slow for ma_crossover). */
  readonly warmupBars: number;
  decide(history: HistoryView): Signal;
}

/** A view of bars[0..lastIndex]; reading outside it throws RangeError. */
export function historyView(bars: readonly Bar[], lastIndex: number): HistoryView {
  const length = lastIndex + 1;
  const check = (i: number) => {
    if (!Number.isInteger(i) || i < 0 || i >= length) throw new RangeError(`history: bar ${i} is not available at decision bar ${lastIndex}`);
  };
  return Object.freeze({
    length,
    bar(i: number) { check(i); return bars[i]; },
    close(i: number) { check(i); return bars[i].close; },
  });
}

function average(history: HistoryView, count: number): number {
  let sum = 0;
  for (let i = history.length - count; i < history.length; i++) sum += history.close(i);
  return sum / count;
}

export function readStrategy(issues: Issues, path: string, value: unknown): Strategy | null {
  const before = issues.count;
  const peek = value && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, "kind") : undefined;
  const kind = readOneOf(issues, `${path}.kind`, peek && !peek.get && !peek.set ? peek.value : undefined, ["buy_and_hold", "ma_crossover"] as const);
  if (issues.count > before) return null;
  if (kind === "buy_and_hold") {
    if (readObject(issues, path, value, ["kind"]) === null) return null;
    return Object.freeze({ kind, params: Object.freeze({}), warmupBars: 1, decide: () => "long" as Signal });
  }
  const o = readObject(issues, path, value, ["kind", "fast", "slow"]);
  if (o === null) return null;
  const fast = readSafeInt(issues, `${path}.fast`, o.fast, { min: 1, max: MAX_MA_PERIOD - 1 });
  const slow = readSafeInt(issues, `${path}.slow`, o.slow, { min: 2, max: MAX_MA_PERIOD });
  if (issues.count === before && fast >= slow) issues.add(path, "fast must be smaller than slow");
  if (issues.count > before) return null;
  return Object.freeze({
    kind, params: Object.freeze({ fast, slow }), warmupBars: slow,
    decide: (h: HistoryView): Signal => (h.length < slow ? "flat" : average(h, fast) > average(h, slow) ? "long" : "flat"),
  });
}
