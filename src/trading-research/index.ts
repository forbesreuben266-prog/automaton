/**
 * Trading research foundation. T1: strict schemas for fictional instruments,
 * daily price bars, spreads, fees and datasets with SHA-256 provenance, and
 * deterministic descriptive metrics. T2: long-or-flat strategies, an offline
 * backtest (next-bar-open execution; explicit spread, fees and slippage) and
 * a report. T3: a paper-trading simulator that receives one bar at a time,
 * sharing the backtest's execution rules (execution.ts), with a hash-chained
 * event ledger. Offline and pure: no market data feeds, network, broker,
 * real orders or live trading. US stocks, UK stocks and forex only (no
 * cryptocurrency).
 */

export * from "./validation.js";
export * from "./instruments.js";
export * from "./prices.js";
export * from "./dataset.js";
export * from "./metrics.js";
export * from "./strategy.js";
export * from "./execution.js";
export * from "./backtest.js";
export * from "./paper.js";
export * from "./report.js";
