/**
 * Trading research foundation (milestone T1): strict schemas for fictional
 * instruments, daily price bars, spreads, fees and datasets with SHA-256
 * provenance, and deterministic descriptive metrics. Offline and pure: no
 * market data feeds, network, broker, orders, strategies, backtests or paper
 * trading. US stocks, UK stocks and forex only (no cryptocurrency).
 */

export * from "./validation.js";
export * from "./instruments.js";
export * from "./prices.js";
export * from "./dataset.js";
export * from "./metrics.js";
