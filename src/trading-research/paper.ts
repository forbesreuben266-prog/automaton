/**
 * Paper-trading simulator (trading research T3). SIMULATED trading on
 * fictional, operator-supplied daily bars: no trading account, real orders,
 * broker, network, files, clock or background work. Pure and deterministic.
 *
 * Lifecycle: start(header, config) creates a session with no bars. Each
 * step(bar) supplies ONE new bar (validated with the T1 bar rules, and
 * strictly after the previous bar on a later UTC date), and then, in order:
 *   1. bar_received: the bar is appended to the session's history;
 *   2. a pending order (decided after the previous bar closed) is attempted
 *      at THIS bar's open with the shared execution rules (execution.ts:
 *      spread, fees, slippage, long or flat, no negative cash):
 *      order_filled or order_rejected; the order is then no longer pending;
 *   3. equity_marked: the account is valued at this bar's close (mid);
 *   4. decision: the strategy decides from the bars received so far (bars
 *      that have not been supplied do not exist in the session); if its
 *      signal differs from the position, a pending order is created for the
 *      next bar's open. No order ever fills on the bar it was decided on.
 * The backtester and this simulator share the Account rules, so replaying a
 * dataset here gives the same fills and equity as backtesting it.
 *
 * Event ledger: append-only and hash-chained. Each event is
 *   { seq, type, data, prevHash, hash }
 * with hash = SHA-256 (hex) of the UTF-8 JSON text of
 *   ["automaton/trading-research/paper-event/v1", seq, prevHash, type, data]
 * where seq counts from 0, prevHash of the first event is 64 zeros, and data
 * is the event's canonical array:
 *   session_started: [headerSha256, strategyKind, [[param, value]...] (sorted),
 *                     [sizingMode, units|null], [cashCurrency, cashAmount],
 *                     slippageBps, execution]
 *   bar_received:    [index, t, openTicks, highTicks, lowTicks, closeTicks, volume|null, spreadTicks]
 *   order_filled:    [side, decisionIndex, fillIndex, fillTime, units, openPrice,
 *                     fillPrice, fees, spreadCost, slippageCost, cashAfter, realizedPnl|null]
 *   order_rejected:  [side, decisionIndex, fillIndex, fillTime, reason]
 *   equity_marked:   [index, t, units, cash, equity]
 *   decision:        [index, t, signal, pendingSide ("buy" | "sell" | null)]
 * Decimal amounts are canonical strings (prices in the price unit, money in
 * the accounting currency). headerSha256 = SHA-256 of the JSON text of
 * ["automaton/trading-research/paper-header/v1", ...canonicalHeaderParts].
 * The same header, config and bars therefore always give the same events and
 * the same final hash (ledgerHead), which replay checks rely on. The hashes
 * detect changes to a recorded ledger; they do not authenticate anyone.
 */

import { createHash } from "node:crypto";
import type { BacktestConfig } from "./backtest.js";
import { canonicalBar, canonicalHeaderParts, type Dataset, type DatasetHeader } from "./dataset.js";
import { Account, type BacktestMetrics, type EquityPoint, type Fill, type Rejection } from "./execution.js";
import { MAX_BARS, readBars, type Bar } from "./prices.js";
import { historyView, type Signal } from "./strategy.js";
import { Issues, ValidationError, canonicalDecimal } from "./validation.js";

export const PAPER_EVENT_DOMAIN = "automaton/trading-research/paper-event/v1";
export const PAPER_HEADER_DOMAIN = "automaton/trading-research/paper-header/v1";
export const GENESIS_HASH = "0".repeat(64);

export type PaperEventType = "session_started" | "bar_received" | "order_filled" | "order_rejected" | "equity_marked" | "decision";

export interface PaperEvent {
  readonly seq: number;
  readonly type: PaperEventType;
  readonly data: readonly unknown[];
  readonly prevHash: string;
  readonly hash: string;
}

export interface PendingOrder {
  readonly side: "buy" | "sell";
  readonly target: Signal;
  readonly decisionIndex: number;
  readonly decisionTime: string;
}

export interface PaperSnapshot {
  readonly headerId: string;
  readonly headerSha256: string;
  readonly barsProcessed: number;
  readonly firstBar: string | null;
  readonly lastBar: string | null;
  readonly position: Signal;
  readonly units: number;
  readonly cash: string;
  readonly pendingOrder: PendingOrder | null;
  readonly fills: readonly Fill[];
  readonly rejections: readonly Rejection[];
  readonly equity: readonly EquityPoint[];
  /** Null until at least one bar has been processed. */
  readonly metrics: BacktestMetrics | null;
  readonly events: number;
  readonly ledgerHead: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** SHA-256 of a session header's canonical form (see the module comment). */
export function paperHeaderSha256(h: DatasetHeader): string {
  return sha256(JSON.stringify([PAPER_HEADER_DOMAIN, ...canonicalHeaderParts(h)]));
}

/** Recomputes every hash of a ledger; refuses (ValidationError) on any break. */
export function verifyPaperLedger(events: readonly PaperEvent[]): string {
  let prev = GENESIS_HASH;
  events.forEach((e, i) => {
    const expected = sha256(JSON.stringify([PAPER_EVENT_DOMAIN, i, prev, e.type, e.data]));
    if (e.seq !== i || e.prevHash !== prev || e.hash !== expected) throw new ValidationError([`paper ledger: event ${i} does not match its hash chain (edited, reordered or missing events)`]);
    prev = e.hash;
  });
  return prev;
}

export class PaperSession {
  private readonly account: Account;
  private readonly bars: Bar[] = [];
  private readonly ledger: PaperEvent[] = [];
  private pending: PendingOrder | null = null;
  readonly headerSha256: string;

  private constructor(readonly header: DatasetHeader, readonly config: BacktestConfig) {
    this.account = new Account(header, config);
    this.headerSha256 = paperHeaderSha256(header);
    const params = Object.keys(config.strategy.params).sort().map((k) => [k, config.strategy.params[k]]);
    this.append("session_started", [
      this.headerSha256, config.strategy.kind, params, [config.sizing.mode, config.sizing.mode === "fixed_units" ? config.sizing.units : null],
      [config.initialCash.currency, canonicalDecimal(config.initialCashDecimal)], canonicalDecimal(config.slippageDecimal), config.execution,
    ]);
  }

  /** Starts a session from a validated header and a validated config (the same config schema as backtests). */
  static start(header: DatasetHeader, config: BacktestConfig): PaperSession {
    if (!header || !config || config.execution !== "next_bar_open") throw new ValidationError(["paper session: needs a validated header and config"]);
    return new PaperSession(header, config);
  }

  private append(type: PaperEventType, data: unknown[]): void {
    const seq = this.ledger.length;
    const prevHash = seq === 0 ? GENESIS_HASH : this.ledger[seq - 1].hash;
    const frozen = Object.freeze(data.map((d) => (Array.isArray(d) ? Object.freeze(d) : d)));
    const hash = sha256(JSON.stringify([PAPER_EVENT_DOMAIN, seq, prevHash, type, frozen]));
    this.ledger.push(Object.freeze({ seq, type, data: frozen, prevHash, hash }));
  }

  get ledgerHead(): string { return this.ledger[this.ledger.length - 1].hash; }
  get barsProcessed(): number { return this.bars.length; }

  /** Supplies one new bar as data ({ t, open, high, low, close, volume[, spread] }); validated before anything changes. */
  step(rawBar: unknown): void {
    const issues = new Issues();
    const parsed = readBars(issues, `bar[${this.bars.length}]`, [rawBar], this.header.instrument, this.header.costs);
    issues.throwIfAny();
    this.apply(parsed![0]);
  }

  /** Applies an already validated bar (used by step and by replay). */
  private apply(bar: Bar): void {
    const index = this.bars.length;
    if (index >= MAX_BARS) throw new ValidationError([`paper session: at most ${MAX_BARS} bars`]);
    const prev = this.bars[index - 1];
    if (prev && (bar.t <= prev.t || bar.t.slice(0, 10) === prev.t.slice(0, 10))) {
      throw new ValidationError([`bar[${index}].t: must be later than the previous bar (${prev.t}) and on a later UTC date`]);
    }
    this.bars.push(bar);
    this.append("bar_received", [index, ...canonicalBar(bar)]);
    if (this.pending !== null) {
      const outcome = this.account.execute(this.pending.target, this.pending.decisionIndex, index, bar);
      this.pending = null;
      if (outcome?.kind === "filled") {
        const f = outcome.fill;
        this.append("order_filled", [f.side, f.decisionIndex, f.fillIndex, f.fillTime, f.units, f.openPrice, f.fillPrice, f.fees, f.spreadCost, f.slippageCost, f.cashAfter, f.realizedPnl]);
      } else if (outcome?.kind === "rejected") {
        const r = outcome.rejection;
        this.append("order_rejected", [r.side, r.decisionIndex, r.fillIndex, r.fillTime, r.reason]);
      }
    }
    const point = this.account.mark(bar);
    this.append("equity_marked", [index, point.t, point.units, point.cash, point.equity]);
    const signal = this.config.strategy.decide(historyView(this.bars, index));
    if (signal !== "long" && signal !== "flat") throw new RangeError("strategy returned an invalid signal");
    if (signal !== this.account.position) {
      this.pending = Object.freeze({ side: signal === "long" ? "buy" : "sell", target: signal, decisionIndex: index, decisionTime: bar.t });
    }
    this.append("decision", [index, bar.t, signal, this.pending?.side ?? null]);
  }

  /** A frozen copy of the ledger (the session's own ledger can only be appended to). */
  events(): readonly PaperEvent[] { return Object.freeze([...this.ledger]); }

  snapshot(): PaperSnapshot {
    const a = this.account;
    return Object.freeze({
      headerId: this.header.id, headerSha256: this.headerSha256, barsProcessed: this.bars.length,
      firstBar: this.bars[0]?.t ?? null, lastBar: this.bars[this.bars.length - 1]?.t ?? null,
      position: a.position, units: Number(a.units), cash: a.show(a.cash), pendingOrder: this.pending,
      fills: Object.freeze([...a.fills]), rejections: Object.freeze([...a.rejections]), equity: Object.freeze([...a.equity]),
      metrics: this.bars.length > 0 ? a.metrics() : null, events: this.ledger.length, ledgerHead: this.ledgerHead,
    });
  }

  /** Replays a validated dataset bar by bar: same header, config and bars give the same events and ledger head. */
  static replay(ds: Dataset, config: BacktestConfig): PaperSession {
    const session = PaperSession.start(ds, config);
    for (const bar of ds.bars) session.apply(bar);
    return session;
  }
}
