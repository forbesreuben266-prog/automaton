/**
 * Offline backtest report (trading research T2): Markdown built from a
 * validated dataset, its validated config and the backtest result. Pure.
 *
 * The report states the dataset's provenance (fictional source, SHA-256),
 * the strategy parameters, all costs and execution assumptions, the results
 * and the limitations. All text from inputs is escaped (one line; Markdown,
 * HTML and link syntax neutralised; control, bidi and invisible characters
 * removed). It makes no claim of predictive accuracy or profitability.
 */

import type { BacktestConfig, BacktestResult } from "./backtest.js";
import { datasetSha256, type Dataset } from "./dataset.js";
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

export function renderBacktestReport(ds: Dataset, config: BacktestConfig, r: BacktestResult): string {
  if (r.datasetSha256 !== datasetSha256(ds) || r.datasetId !== ds.id) throw new ValidationError(["report: the result was not produced from this dataset"]);
  const e = escapeText;
  const i = ds.instrument;
  const c = ds.costs;
  const ccy = i.accountingCurrency;
  const out: string[] = [];
  out.push(`# Backtest report: ${e(ds.title)}`, "", `**${REPORT_DISCLAIMER}**`, "");
  out.push(`Status: **${r.status}**${r.reason ? ` (${e(r.reason)})` : ""}`, "");

  out.push("## Dataset and provenance", "");
  out.push(`- Dataset ${e(ds.id)}: ${ds.bars.length} daily bars, ${ds.bars[0].t} to ${ds.bars[ds.bars.length - 1].t}`);
  out.push(`- Source: ${e(ds.source.kind)} (${e(ds.source.label)}), recorded by ${e(ds.source.recordedBy)} at ${ds.source.recordedAt}`);
  out.push(`- SHA-256 of the validated dataset: ${r.datasetSha256} (shows the data is unchanged since a reference was recorded; it does not authenticate the source)`);
  out.push(`- Corporate-action adjustment (as stated, not checked): ${e(ds.adjustment)}`);
  out.push(`- Annualisation: ${ds.annualization.periodsPerYear} bars per year (${e(ds.annualization.basis)})`, "");

  out.push("## Instrument and currency", "");
  out.push(`- ${e(i.symbol)} (${e(i.name)}), ${e(i.assetClass)}; tick size ${e(i.tickSize)} ${e(i.priceUnit)}`);
  out.push(`- Prices are in ${e(i.priceUnit)}; cash, fees and profit/loss are reported in ${e(ccy)}${i.priceUnit === "GBX" ? " (1 GBP = 100 GBX, converted exactly)" : ""}.`);
  if (i.assetClass === "fx") out.push(`- Forex: units are ${e(i.base!)}, paid in full in ${e(i.quote!)}; profit/loss stays in ${e(i.quote!)} (no conversion, no margin).`);
  out.push("");

  out.push("## Strategy, costs and execution", "");
  const params = Object.entries(config.strategy.params).map(([k, v]) => `${k} = ${v}`).join(", ");
  out.push(`- Strategy: ${e(config.strategy.kind)}${params ? ` (${e(params)})` : ""}`);
  out.push(`- Initial cash: ${e(config.initialCash.amount)} ${e(ccy)}; sizing: ${config.sizing.mode === "fixed_units" ? `${config.sizing.units} units per entry` : "as many whole units as cash covers, including fees"}`);
  out.push(`- Spread: ${c.spreadMode === "fixed" ? `fixed ${c.fixedSpread} ticks` : "per bar, from the data"}; half the spread is paid on each fill`);
  out.push(`- Fees: ${e(c.feePerOrder)} ${e(c.feeCurrency)} per order plus ${e(c.feeProportionalBps)} basis points of traded value`);
  out.push(`- Slippage: ${e(config.slippageBps)} basis points of the open price, against the trade`);
  out.push("- Execution: decide after bar t closes using bars 0..t only; fill at the open of bar t+1; long or flat only (no short selling, leverage or borrowing; cash never negative)", "");

  out.push("## Results", "");
  if (r.metrics === null) {
    out.push("No figures: there is not enough data for this strategy (see the status above).", "");
  } else {
    const m = r.metrics;
    const vol = m.annualizedVolatility.status === "ok" ? pct(m.annualizedVolatility.value) : `not reported (${e(m.annualizedVolatility.reason)})`;
    out.push("| Measure | Value |", "|---|---|");
    out.push(`| Initial equity | ${m.initialEquity} ${e(ccy)} |`, `| Final equity (open position at last close, mid) | ${m.finalEquity} ${e(ccy)} |`);
    out.push(`| Total return (hypothetical) | ${pct(m.totalReturn)} |`, `| Maximum drawdown of equity | ${pct(m.maxDrawdown)} |`);
    out.push(`| Annualised volatility of equity | ${vol} |`, `| Exposure (closes with a position) | ${pct(m.exposure)} |`);
    out.push(`| Fills / rejected orders | ${m.fills} / ${m.rejections} |`, `| Round trips (profitable) | ${m.roundTrips} (${m.winningRoundTrips}) |`);
    out.push(`| Realised / unrealised P&L | ${m.realizedPnl} / ${m.unrealizedPnl} ${e(ccy)} |`);
    out.push(`| Fees / spread cost / slippage cost | ${m.totalFees} / ${m.totalSpreadCost} / ${m.totalSlippageCost} ${e(ccy)} |`, "");
    out.push("### Fills", "");
    if (r.fills.length === 0) out.push("- none");
    for (const f of r.fills) {
      out.push(`- ${f.fillTime} ${f.side} ${f.units} at ${f.fillPrice} ${e(i.priceUnit)} (open ${f.openPrice}; decided after bar ${f.decisionIndex}); fees ${f.fees}, cash after ${f.cashAfter} ${e(ccy)}` +
        (f.realizedPnl !== null ? `; realised P&L ${f.realizedPnl} ${e(ccy)}` : ""));
    }
    out.push("", "### Rejected orders", "");
    if (r.rejections.length === 0) out.push("- none");
    for (const j of r.rejections) out.push(`- ${j.fillTime} ${j.side} (decided after bar ${j.decisionIndex}): ${e(j.reason)}`);
    out.push("");
    if (r.endUnits > 0) out.push(`Open position at the end: ${r.endUnits} units, valued at the last close (mid); exit spread, slippage and fees are not deducted.`, "");
    if (r.unexecutedFinalSignal !== null) out.push(`The decision after the last bar (${r.unexecutedFinalSignal}) could not be executed: there is no later bar.`, "");
  }

  out.push("## Assumptions and limitations", "");
  for (const line of [
    "Fictional data: the figures describe this invented series only; they say nothing about real markets or the future.",
    "Daily bars only; gaps are consecutive bars; fills happen exactly at the next open adjusted for half the spread and slippage (no partial fills, queues or market impact).",
    "Fees are not rounded to currency minor units; taxes (e.g. UK stamp duty) are not modelled unless included in the fees.",
    "Dividends, interest, forex rollover/swap and corporate actions are not modelled beyond the stated price adjustment; survivorship bias is not addressed.",
    "One instrument, one position at a time; no portfolio effects or currency conversion.",
    ...ds.limitations.map((l) => `Operator note: ${e(l)}`),
  ]) out.push(`- ${line}`);
  out.push("");
  return out.join("\n");
}
