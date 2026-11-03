# Offline research guide (operator walkthrough)

This guide shows a beginner how to build this fork, run the offline research
command-line tool (CLI) on a complete FICTIONAL demonstration, and read the
reports it produces.

> **Safety first.**
> - Do NOT run `node dist/index.js --run` or the `curl ... | sh` installer from
>   the main README. Those start the autonomous agent, which creates a wallet,
>   provisions API keys and can spend money. None of that is needed here.
> - The research CLI is offline. It reads files you name, prints a report and
>   exits. It never trades, places orders, contacts anyone, calls a model,
>   uses the network or Docker, or writes files.
> - Use fictional data only. The reports are not evidence that a business or
>   strategy works, and they are not financial advice.

## 1. What you need

- This repository with its dependencies already in `node_modules`. Installing
  dependencies needs the network, so it is not part of this guide.
- Node.js 22.
- A terminal opened in the repository root (the folder containing
  `package.json`).

Call the tools in `node_modules/.bin` directly, as shown below. Avoid `npm` and
`npx` for these steps: npm checks for updates over the network.

## 2. Build

```bash
./node_modules/.bin/tsc                     # compiles src/ into dist/
./node_modules/.bin/tsc --noEmit            # optional: typecheck only
```

Success prints nothing and exits with code 0. The CLI is then
`node dist/research-cli/main.js`. Run it with `--help` to see the usage text:

```bash
node dist/research-cli/main.js --help
```

To build the whole project as well (not needed for research):
`./node_modules/.bin/tsc && (cd packages/cli && ./node_modules/.bin/tsc)`.

## 3. Create the fictional demonstration

The demonstration writer is test tooling that creates every input file. Give it
an existing, EMPTY, absolute directory OUTSIDE the repository. It refuses
anything else and never overwrites a file.

```bash
mkdir /tmp/automaton-demo
chmod 755 /tmp/automaton-demo               # the data root must not be writable by others
./node_modules/.bin/tsx src/__tests__/research-cli/demo.ts /tmp/automaton-demo
```

It writes:

| File | Contents |
|---|---|
| `dog-walking/` | Business research for a fictional dog-walking idea, with two runs (2026-10-15 and 2026-10-20) |
| `fict-us-trend.json` | A fictional US stock in USD: 30 daily bars that rise, fall, then rise |
| `fict-uk.json` | A fictional UK stock priced in pence (GBX), with per-bar spreads |
| `fict-eurusd.json` | A fictional EURUSD forex series: 21 daily bars |
| `run-us-ma.json` | Moving-average crossover (fast 3, slow 8), 50 units, 10,000 USD, 2 bps slippage |
| `run-uk.json` | Buy and hold, all cash, 1,000 GBP, no slippage |
| `run-eurusd.json` | Buy and hold, 10,000 units, 20,000 USD, 1 bp slippage |

To save typing in the commands below:

```bash
D=/tmp/automaton-demo
R="node dist/research-cli/main.js"
```

Every command needs `--data-root "$D"` (where the inputs are) and
`--repo-root "$PWD"` (this repository, so the tool can refuse data inside it).

## 4. Business research example

```bash
$R assess  --data-root "$D" --repo-root "$PWD" --opportunity dog-walking --run 2026-10-15
$R compare --data-root "$D" --repo-root "$PWD" --opportunity dog-walking --previous 2026-10-15 --current 2026-10-20
```

**Reading `assess`:**

- **Research assessment** comes first. It shows one of the evidence-aware
  statuses, for example `SUPPORTED FOR CONSIDERATION (preliminary screening)`.
  No status proves demand, profitability or viability, and none authorises
  spending or any other action.
- **Verdict / Score / Confidence** are the screening result. Score and
  confidence are assessed separately.
- **Scenarios** and **A1 Financial scenarios** are projections calculated from
  the stated assumptions. They are not forecasts.
- **Validation experiments** are suggestions that need your approval. Nothing
  is carried out automatically.
- **A3 Evidence ledger** lists every claim with its kind (sourced fact, derived
  estimate, assumption, speculation), its support and an evidence grade.
  Unverified items are labelled as such.

**Reading `compare`:**

- It lists new or changed evidence (here, a new source:
  `source:neighbourhood-poll (added)`), changed assumptions and projections
  (`assumption:cac (changed)`), and revisit triggers.
- **Opportunity retained** means that nothing is deleted or hidden, whatever
  the score. Revisit triggers suggest a reassessment. They authorise no
  action.

## 5. Trading research example

Every trading report starts with a banner saying the data is fictional and the
results are simulated.

### 5a. Validate a dataset

```bash
$R trading validate --data-root "$D" --repo-root "$PWD" --dataset fict-us-trend.json
```

- `Status: **valid**` means every check passed. Invalid data is refused with
  a list of problems instead (see section 6).
- **SHA-256 of the validated dataset**: record this to detect later edits to
  the data. It does not prove where the data came from.
- **Descriptive metrics** (for this file: total return 10.0000%, volatility
  22.1756%, maximum drawdown -13.9130%) describe the invented prices only.
  They predict nothing.

### 5b. Historical backtest

```bash
$R trading backtest --data-root "$D" --repo-root "$PWD" --dataset fict-us-trend.json --config run-us-ma.json
```

Instead of `--config`, you can give every setting on the command line. Nothing
has a default value:

```bash
$R trading backtest --data-root "$D" --repo-root "$PWD" --dataset fict-us-trend.json \
  --strategy ma_crossover --fast 3 --slow 8 --sizing fixed_units --units 50 \
  --cash 10000.00 --cash-currency USD --slippage-bps 2
```

How the simulation works: a signal is decided after a bar closes and filled at
the NEXT bar's open, adjusted by half the spread and by slippage. Positions
are long or flat only, and cash can never go negative.

For this example, expect:

| Item | Value |
|---|---|
| Fills | buy 50 at 110.5321, sell 50 at 108.9682, buy 50 at 103.0306 USD |
| Final equity | 10267.275 USD (total return 2.6728%) |
| Maximum drawdown | -2.9601% |
| Costs | fees 3, spread 1.5, slippage 3.225 USD |
| Round trips | 1, not profitable (realised -80.195 USD); the open position is valued at the last close |

### 5c. Paper-trading replay

```bash
$R trading paper --data-root "$D" --repo-root "$PWD" --dataset fict-us-trend.json --config run-us-ma.json
```

The paper simulator receives the bars one at a time, as if they were arriving
live, and records every step in a hash-chained event ledger. It uses the same
execution model as the backtester, so with the same inputs **its fills, costs
and final equity are identical to the backtest's**. The automated smoke test
checks this.

- **Event ledger: 94 events; final hash 27ced30a...**: replaying the same files
  always gives the same hash. A changed input or an edited ledger gives a
  different one. It does not identify or authenticate anyone.
- **Open position and pending order** shows the state at the end of the data.

The other two examples work the same way:

```bash
$R trading paper    --data-root "$D" --repo-root "$PWD" --dataset fict-uk.json     --config run-uk.json
$R trading backtest --data-root "$D" --repo-root "$PWD" --dataset fict-eurusd.json --config run-eurusd.json
```

UK prices are in pence (GBX), but cash and profit or loss are reported in
pounds (GBP). For forex, profit or loss stays in the quote currency (USD for
EURUSD). No currency conversion is done.

## 6. Exit codes and troubleshooting

| Exit code | Meaning |
|---|---|
| 0 | Success. The report was printed to standard output |
| 1 | Refused. An input, path or validation problem is listed on standard error |
| 2 | Usage error. The command or options are wrong; the usage text follows |
| 3 | Internal error. Details are withheld; report it with the command you ran |

Refusals print paths as `<data-root>/...` so that your directory names do not
leak into the output.

| Message (abridged) | Cause and fix |
|---|---|
| `Usage error: unknown command ...` | The first word must be `assess`, `compare` or `trading`. |
| `Usage error: missing option --sizing (give every run setting, or --config ...)` | Give every run setting, or use `--config <file.json>`. You can't mix the two forms. |
| `... must be a normalized absolute path` | Use full paths such as `/tmp/automaton-demo`, with no trailing `/`, `.` or `..`. Use `"$PWD"` for `--repo-root`. |
| `data root: must be outside the repository` | Keep data outside the repository folder. |
| `--dataset: must be a plain lower-case file name ending in .json` | Give a file name only, such as `fict-uk.json`, with no folders and no capital letters. |
| `<data-root>/missing.json: cannot be inspected (ENOENT)` | The file does not exist in the data root. Check the spelling. For `assess`, check the run date too. |
| `... is a symbolic link` | Links are refused. Copy the real file into the data root. |
| `<data-root>: is writable by others` | Run `chmod 755 <data root>` (and `chmod 644` for the files). |
| `dataset.bars[2]: prices are inconsistent (need low <= open, close <= high)` | Fix that bar. The list names every invalid field. |
| `config.initialCash.currency: must be GBP for this instrument` | The cash currency must match the instrument: GBP for UK (GBX) stocks, USD for US stocks, the quote currency for forex. |
| `Refused: the destination is not empty.` (demonstration writer) | Use a new empty directory, or delete the old demonstration first. |
| `Cannot find module .../dist/research-cli/main.js` | Build first (section 2). |
| `tsc: not found` / `tsx: not found` | Dependencies are missing from `node_modules`. Installing them needs the network and is outside this guide. |

## 7. Run the automated smoke test

```bash
./node_modules/.bin/vitest run src/__tests__/research-cli/demo.test.ts
```

The test writes the demonstration into a temporary directory and runs every
command above. It checks the key figures, that the backtest and paper replay
give the same fills, costs and final equity, that the paper ledger hash
matches an independent replay, that output is deterministic, and that the
entry point, run as a separate process, returns the documented exit codes. The temporary directory
is then removed.

## 8. What works now and what remains blocked

| Works now (offline, fictional data) | Blocked or not built |
|---|---|
| Business opportunity assessment and run-to-run comparison | Live web research, model calls and automated evidence gathering (M1/M3 stay blocked) |
| Dataset validation for US stocks, UK stocks (GBX) and forex | Real or live market data, data feeds and downloads |
| Deterministic backtests (buy and hold, moving-average crossover) with spread, fee and slippage costs | Short selling, leverage, portfolios, multiple instruments, currency conversion, intraday bars |
| Paper-trading replay with a verifiable, hash-chained ledger | Brokers, exchanges, trading accounts, real orders and live trading |
| Bounded, path-redacted errors and fixed exit codes | Deploying or launching the autonomous agent, wallets, payments and spending |

Every result here describes invented data under stated assumptions. It cannot
show that an opportunity or strategy works in reality.
