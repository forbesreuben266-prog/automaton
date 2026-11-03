# Trading research - milestones T1 and T2 (offline)

Strict schemas and deterministic metrics for **fictional, operator-supplied**
price data. US stocks, UK stocks and forex pairs only (no cryptocurrency).
T2 adds long-or-flat strategies and an offline backtest. There are no
market-data feeds, network access, trading accounts, real orders or paper
trading here (paper trading will be a separate module). Nothing outside this folder imports it, so
the autonomous agent has no route to it.

| Module | Purpose |
|---|---|
| `validation.ts` | Bounded JSON parsing (size limit, duplicate keys refused, depth limit); strict objects (unknown, missing or accessor fields refused; nothing defaulted); safe text; exact decimals and tick conversion with BigInt; UTC timestamps validated without a clock |
| `instruments.ts` | `us_equity` (USD), `uk_equity` (GBP **or** GBX, always explicit), `fx` (base/quote from a fixed list, symbol = BASE+QUOTE, pip 0.01 for JPY-quoted pairs else 0.0001, tick = pip or pip/10). Fees and profit/loss are in USD, GBP (also for GBX prices) or the forex quote currency |
| `prices.ts` | Daily bars: strictly increasing UTC timestamps, one per UTC date, positive prices on the tick grid as integer ticks, low <= open, close <= high; stock volume required, forex volume null; spreads (fixed or per bar) and fees (per order, basis points) always explicit |
| `dataset.ts` | Dataset metadata (source must be `fictional`; corporate-action adjustment stated; annualisation stated per dataset; limitations) and SHA-256 over a documented canonical form of the validated data |
| `strategy.ts` | (T2) `buy_and_hold` and `ma_crossover` (fast < slow <= 500); a strategy sees only bars 0..t through a view that throws on later bars |
| `backtest.ts` | (T2) Long or flat; decision after bar t closes, fill at bar t+1 open +/- half the spread and slippage; fixed and proportional fees; `fixed_units` or `all_cash` sizing; rejected orders recorded; no short selling, leverage or negative cash; exact money (integers scaled by 10^18); equity curve, realised/unrealised P&L and metrics |
| `report.ts` | (T2) Escaped Markdown report: provenance, parameters, costs, execution assumptions, results, limitations; no profitability claims |
| `metrics.ts` | Simple and total returns, annualised volatility (sample sd of log returns x sqrt(periodsPerYear)), maximum drawdown (peak, trough, length, recovery), long-only risk/reward in ticks; too little data gives `insufficient_data`, never a figure |

## Limits (stated, not solved)
- Descriptive statistics of supplied prices only: not a forecast, advice or evidence that a strategy works.
- Prices are mid prices; the T1 metrics do not deduct costs (the T2 backtest does).
- Backtests: fills exactly at the next open (no partial fills, queues or market impact); fees not rounded to minor units; no dividends, interest, forex swap or taxes; an open position at the end is valued at the last close without exit costs; one instrument at a time; forex results stay in the quote currency.
- Corporate-action adjustment is recorded as stated by the operator, not checked; survivorship bias is not addressed.
- Gaps in the data (holidays, missing days) are treated as consecutive bars; no exchange calendar is assumed.
- The SHA-256 shows the data is unchanged since a reference was recorded; it does not authenticate the source.
- Direct (non-JSON) object input is not a sandbox: JSON text is the intended input.
