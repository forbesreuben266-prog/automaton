/**
 * Offline reports (trading research T2/T3): Markdown for a backtest (from a
 * validated dataset, config and result) and for a paper-trading session
 * (from the session itself). Pure. Shared sections keep the two consistent.
 *
 * The report states the dataset's provenance (fictional source, SHA-256),
 * the strategy parameters, all costs and execution assumptions, the results
 * and the limitations. All text from inputs is escaped (one line; Markdown,
 * HTML and link syntax neutralised; control, bidi and invisible characters
 * removed). It makes no claim of predictive accuracy or profitability.
 */

import type { BacktestConfig, BacktestResult } from "./backtest.js";
import { datasetSha256, type Dataset, type DatasetHeader } from "./dataset.js";
import type { BacktestMetrics, Fill, Rejection } from "./execution.js";
import type { PaperSession } from "./paper.js";
import { summarizeDataset } from "./metrics.js";
import { UNSAFE_TEXT, ValidationError } from "./validation.js";

const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#|<>~!]/g;

/** One-line, Markdown-inert text. Input text is already validated as safe; this is defence in depth. */
export function escapeText(text: string): string {
  const flat = String(text).replace(/\s+/g, " ").replace(new RegExp(UNSAFE_TEXT.source, "g"), "").trim();
  return flat.replace(MARKDOWN_SPECIAL, (c) => `\\${c}`);
}

export const REPORT_DISCLAIMER =
  "Hypothetical backtest on FICTIONAL, operator-supplied data. It makes no claim of predictive accuracy, profitability or future " +
  "performance and is not advice. Nothing was traded: no trading account, real order or live market data was involved.";

const pct = (x: number) => `${(x * 100).toFixed(4)}%`;

export const PAPER_DISCLAIMER =
  "SIMULATED PAPER TRADING on FICTIONAL, operator-supplied bars. These are not real trading results: nothing was traded, no trading " +
  "account, real order or live market data was involved, and no claim of predictive accuracy, profitability or future performance is made.";

function instrumentLines(h: DatasetHeader): string[] {
  const e = escapeText;
  const i = h.instrument;
  const lines = [
    `- ${e(i.symbol)} (${e(i.name)}), ${e(i.assetClass)}; tick size ${e(i.tickSize)} ${e(i.priceUnit)}`,
    `- Prices are in ${e(i.priceUnit)}; cash, fees and profit/loss are reported in ${e(i.accountingCurrency)}${i.priceUnit === "GBX" ? " (1 GBP = 100 GBX, converted exactly)" : ""}.`,
  ];
  if (i.assetClass === "fx") lines.push(`- Forex: units are ${e(i.base!)}, paid in full in ${e(i.quote!)}; profit/loss stays in ${e(i.quote!)} (no conversion, no margin).`);
  return lines;
}

function strategyLines(h: DatasetHeader, config: BacktestConfig): string[] {
  const e = escapeText;
  const c = h.costs;
  const params = Object.entries(config.strategy.params).map(([k, v]) => `${k} = ${v}`).join(", ");
  return [
    `- Strategy: ${e(config.strategy.kind)}${params ? ` (${e(params)})` : ""}`,
    `- Initial cash: ${e(config.initialCash.amount)} ${e(h.instrument.accountingCurrency)}; sizing: ${config.sizing.mode === "fixed_units" ? `${config.sizing.units} units per entry` : "as many whole units as cash covers, including fees"}`,
    `- Spread: ${c.spreadMode === "fixed" ? `fixed ${c.fixedSpread} ticks` : "per bar, from the data"}; half the spread is paid on each fill`,
    `- Fees: ${e(c.feePerOrder)} ${e(c.feeCurrency)} per order plus ${e(c.feeProportionalBps)} basis points of traded value`,
    `- Slippage: ${e(config.slippageBps)} basis points of the open price, against the trade`,
    "- Execution: decide after bar t closes using bars 0..t only; fill at the open of bar t+1; long or flat only (no short selling, leverage or borrowing; cash never negative)",
  ];
}

function resultLines(h: DatasetHeader, m: BacktestMetrics, fills: readonly Fill[], rejections: readonly Rejection[], returnLabel: string): string[] {
  const e = escapeText;
  const ccy = e(h.instrument.accountingCurrency);
  const vol = m.annualizedVolatility.status === "ok" ? pct(m.annualizedVolatility.value) : `not reported (${e(m.annualizedVolatility.reason)})`;
  const out = [
    "| Measure | Value |", "|---|---|",
    `| Initial equity | ${m.initialEquity} ${ccy} |`, `| Final equity (open position at last close, mid) | ${m.finalEquity} ${ccy} |`,
    `| ${returnLabel} | ${pct(m.totalReturn)} |`, `| Maximum drawdown of equity | ${pct(m.maxDrawdown)} |`,
    `| Annualised volatility of equity | ${vol} |`, `| Exposure (closes with a position) | ${pct(m.exposure)} |`,
    `| Fills / rejected orders | ${m.fills} / ${m.rejections} |`, `| Round trips (profitable) | ${m.roundTrips} (${m.winningRoundTrips}) |`,
    `| Realised / unrealised P&L | ${m.realizedPnl} / ${m.unrealizedPnl} ${ccy} |`,
    `| Fees / spread cost / slippage cost | ${m.totalFees} / ${m.totalSpreadCost} / ${m.totalSlippageCost} ${ccy} |`, "",
    "### Fills", "",
  ];
  if (fills.length === 0) out.push("- none");
  for (const f of fills) {
    out.push(`- ${f.fillTime} ${f.side} ${f.units} at ${f.fillPrice} ${e(h.instrument.priceUnit)} (open ${f.openPrice}; decided after bar ${f.decisionIndex}); fees ${f.fees}, cash after ${f.cashAfter} ${ccy}` +
      (f.realizedPnl !== null ? `; realised P&L ${f.realizedPnl} ${ccy}` : ""));
  }
  out.push("", "### Rejected orders", "");
  if (rejections.length === 0) out.push("- none");
  for (const j of rejections) out.push(`- ${j.fillTime} ${j.side} (decided after bar ${j.decisionIndex}): ${e(j.reason)}`);
  out.push("");
  return out;
}

function limitationLines(h: DatasetHeader, extra: readonly string[]): string[] {
  return [
    "Fictional data: the figures describe this invented series only; they say nothing about real markets or the future.",
    "Daily bars only; gaps are consecutive bars; fills happen exactly at the next open adjusted for half the spread and slippage (no partial fills, queues or market impact).",
    "Fees are not rounded to currency minor units; taxes (e.g. UK stamp duty) are not modelled unless included in the fees.",
    "Dividends, interest, forex rollover/swap and corporate actions are not modelled beyond the stated price adjustment; survivorship bias is not addressed.",
    "One instrument, one position at a time; no portfolio effects or currency conversion.",
    ...extra,
    ...h.limitations.map((l) => `Operator note: ${escapeText(l)}`),
  ].map((l) => `- ${l}`);
}

export function renderBacktestReport(ds: Dataset, config: BacktestConfig, r: BacktestResult): string {
  if (r.datasetSha256 !== datasetSha256(ds) || r.datasetId !== ds.id) throw new ValidationError(["report: the result was not produced from this dataset"]);
  const e = escapeText;
  const out: string[] = [];
  out.push(`# Backtest report: ${e(ds.title)}`, "", `**${REPORT_DISCLAIMER}**`, "");
  out.push(`Status: **${r.status}**${r.reason ? ` (${e(r.reason)})` : ""}`, "");
  out.push("## Dataset and provenance", "");
  out.push(`- Dataset ${e(ds.id)}: ${ds.bars.length} daily bars, ${ds.bars[0].t} to ${ds.bars[ds.bars.length - 1].t}`);
  out.push(`- Source: ${e(ds.source.kind)} (${e(ds.source.label)}), recorded by ${e(ds.source.recordedBy)} at ${ds.source.recordedAt}`);
  out.push(`- SHA-256 of the validated dataset: ${r.datasetSha256} (shows the data is unchanged since a reference was recorded; it does not authenticate the source)`);
  out.push(`- Corporate-action adjustment (as stated, not checked): ${e(ds.adjustment)}`);
  out.push(`- Annualisation: ${ds.annualization.periodsPerYear} bars per year (${e(ds.annualization.basis)})`, "");
  out.push("## Instrument and currency", "", ...instrumentLines(ds), "");
  out.push("## Strategy, costs and execution", "", ...strategyLines(ds, config), "");
  out.push("## Results", "");
  if (r.metrics === null) {
    out.push("No figures: there is not enough data for this strategy (see the status above).", "");
  } else {
    out.push(...resultLines(ds, r.metrics, r.fills, r.rejections, "Total return (hypothetical)"));
    if (r.endUnits > 0) out.push(`Open position at the end: ${r.endUnits} units, valued at the last close (mid); exit spread, slippage and fees are not deducted.`, "");
    if (r.unexecutedFinalSignal !== null) out.push(`The decision after the last bar (${r.unexecutedFinalSignal}) could not be executed: there is no later bar.`, "");
  }
  out.push("## Assumptions and limitations", "", ...limitationLines(ds, []), "");
  return out.join("\n");
}

/** Report of a paper-trading session's current state (simulated; fictional bars). */
export function renderPaperReport(session: PaperSession): string {
  const e = escapeText;
  const h = session.header;
  const s = session.snapshot();
  const out: string[] = [];
  out.push(`# Paper-trading report (SIMULATED): ${e(h.title)}`, "", `**${PAPER_DISCLAIMER}**`, "");
  out.push("## Session and provenance", "");
  out.push(`- Session header ${e(h.id)}; source: ${e(h.source.kind)} (${e(h.source.label)}), recorded by ${e(h.source.recordedBy)} at ${h.source.recordedAt}`);
  out.push(`- Header SHA-256: ${s.headerSha256}`);
  out.push(`- Bars processed: ${s.barsProcessed}${s.firstBar ? ` (${s.firstBar} to ${s.lastBar})` : ""}; each bar was supplied one at a time by the operator`);
  out.push(`- Event ledger: ${s.events} events; final hash ${s.ledgerHead} (a hash chain that detects later edits; replaying the same inputs reproduces it; it does not authenticate anyone)`);
  out.push(`- Annualisation: ${h.annualization.periodsPerYear} bars per year (${e(h.annualization.basis)})`, "");
  out.push("## Instrument and currency", "", ...instrumentLines(h), "");
  out.push("## Strategy, costs and execution", "", ...strategyLines(h, session.config), "");
  out.push("## Simulated results", "");
  if (s.metrics === null) out.push("No bars processed yet: no figures.", "");
  else out.push(...resultLines(h, s.metrics, s.fills, s.rejections, "Simulated total return"));
  out.push("## Open position and pending order", "");
  out.push(s.units > 0 ? `- Open position: ${s.units} units, valued at the last close (mid); exit spread, slippage and fees are not deducted.` : "- No open position.");
  out.push(s.pendingOrder ? `- Pending simulated order: ${s.pendingOrder.side} (decided after the bar of ${s.pendingOrder.decisionTime}); it will be attempted at the next supplied bar's open.` : "- No pending order.", "");
  out.push("## Assumptions and limitations", "", ...limitationLines(h, [
    "Simulated paper trading: no trading account, exchange connection, real order types or live market data; fills are computed, not executed.",
    "Bars arrive only when the operator supplies them; there is no clock, schedule or background process.",
  ]), "");
  return out.join("\n");
}

export const DATASET_DISCLAIMER =
  "Validation of a FICTIONAL, operator-supplied dataset. The figures are descriptive statistics of these invented prices: " +
  "not a forecast, not evidence that any strategy works, and not advice.";

/** Validation report of a dataset: provenance, instrument, costs and descriptive metrics (no trading simulation). */
export function renderDatasetReport(ds: Dataset): string {
  const e = escapeText;
  const s = summarizeDataset(ds);
  const c = ds.costs;
  const metric = (m: { status: string; value?: unknown; reason?: string }, fmt: (v: number) => string) =>
    m.status === "ok" ? fmt(m.value as number) : `not reported (${e(m.reason ?? "insufficient data")})`;
  const dd = s.maxDrawdown;
  const out: string[] = [];
  out.push(`# Dataset validation report: ${e(ds.title)}`, "", `**${DATASET_DISCLAIMER}**`, "", "Status: **valid**", "");
  out.push("## Dataset and provenance", "");
  out.push(`- Dataset ${e(ds.id)}: ${s.bars} daily bars, ${s.firstBar} to ${s.lastBar}`);
  out.push(`- Source: ${e(ds.source.kind)} (${e(ds.source.label)}), recorded by ${e(ds.source.recordedBy)} at ${ds.source.recordedAt}`);
  out.push(`- SHA-256 of the validated dataset: ${datasetSha256(ds)} (record it to detect later changes; it does not authenticate the source)`);
  out.push(`- Corporate-action adjustment (as stated, not checked): ${e(ds.adjustment)}`, "");
  out.push("## Instrument and currency", "", ...instrumentLines(ds), "");
  out.push("## Costs recorded in the dataset", "");
  out.push(`- Spread: ${c.spreadMode === "fixed" ? `fixed ${c.fixedSpread} ticks` : "per bar, from the data"}`);
  out.push(`- Fees: ${e(c.feePerOrder)} ${e(c.feeCurrency)} per order plus ${e(c.feeProportionalBps)} basis points of traded value`);
  out.push("- Slippage is not part of a dataset: it is an explicit backtest or paper-trading setting.", "");
  out.push("## Descriptive metrics (closes, mid prices, no costs deducted)", "", "| Measure | Value |", "|---|---|");
  out.push(`| Total return over the data | ${metric(s.totalReturn, pct)} |`);
  out.push(`| Annualised volatility | ${metric(s.annualizedVolatility, pct)} |`);
  out.push(`| Maximum drawdown | ${dd.status === "ok" ? `${pct(dd.value.maxDrawdown)} (bars ${dd.value.peakIndex} to ${dd.value.troughIndex}${dd.value.recoveryIndex === null ? ", not recovered" : `, recovered at bar ${dd.value.recoveryIndex}`})` : `not reported (${e(dd.reason)})`} |`, "");
  out.push("## Assumptions and limitations", "", ...s.notes.map((n) => `- ${e(n)}`), ...ds.limitations.map((l) => `- Operator note: ${e(l)}`), "");
  return out.join("\n");
}
