/**
 * Unified offline research CLI (U1). Operator-invoked only: no background
 * work, scheduling, network, models, brokers, real orders, Docker or sandbox.
 * This module has no process access of its own (main.ts passes in the
 * arguments and output functions) and reads files only through
 * trading-files.ts (trading inputs) or the business research CLI's own
 * loader. Nothing is written: reports go to standard output.
 *
 * Commands:
 *   assess ... | compare ...   business research, handed unchanged to the
 *                              existing research-pipeline CLI (runCli)
 *   trading validate  --data-root <abs> --repo-root <abs> --dataset <file.json>
 *   trading backtest  --data-root <abs> --repo-root <abs> --dataset <file.json> <run settings>
 *   trading paper     --data-root <abs> --repo-root <abs> --dataset <file.json> <run settings>
 *   import review     --data-root <abs> --repo-root <abs> --manifest <file.json>
 *                     (R2 quarantine review: reads the manifest and the content
 *                     file it names, both through trading-files.ts; prints the
 *                     review; exit 0 awaiting approval, 1 rejected; never approves)
 * Run settings: either --config <file.json> (a run configuration file in the
 * data root) or ALL of --strategy, --sizing, --cash, --cash-currency and
 * --slippage-bps (plus --fast/--slow for ma_crossover and --units for
 * fixed_units). The two forms can't be mixed, and nothing is defaulted: the
 * values are validated by the trading module's own configuration parser.
 *
 * Output safety, errors and exit codes follow the business CLI: every line
 * passes terminalSafe; errors are bounded and path-redacted (formatRefusal);
 * usage errors never echo argument values; 0 ok, 1 refused, 2 usage error,
 * 3 internal error (details withheld).
 */

import { EXIT, MAX_ARG_CHARS, formatRefusal, runCli as runBusinessCli, terminalSafe, type CliIo } from "../research-pipeline/cli.js";
import {
  PaperSession, ValidationError, parseBacktestConfig, parseBacktestConfigText, parseDatasetText, renderBacktestReport, renderDatasetReport,
  renderPaperReport, runBacktest, type BacktestConfig, type Dataset,
} from "../trading-research/index.js";
import { MAX_IMPORT_CONTENT_BYTES, MAX_IMPORT_MANIFEST_BYTES, importContentFile, renderImportReview, reviewImport } from "../research-readiness/index.js";
import { MAX_CONFIG_FILE_BYTES, MAX_DATASET_FILE_BYTES, TradingFileError, readTradingInput } from "./trading-files.js";

export { EXIT };

export const USAGE = [
  "Offline research CLI (fictional, operator-supplied data only; nothing is traded, written or sent).",
  "",
  "Business research (handled unchanged by the existing research-pipeline CLI):",
  "  assess  --data-root <abs> --repo-root <abs> --opportunity <id> --run <YYYY-MM-DD>",
  "  compare --data-root <abs> --repo-root <abs> --opportunity <id> --previous <YYYY-MM-DD> --current <YYYY-MM-DD>",
  "",
  "Trading research (US stocks, UK stocks, forex; simulated, hypothetical results):",
  "  trading validate --data-root <abs> --repo-root <abs> --dataset <file.json>",
  "  trading backtest --data-root <abs> --repo-root <abs> --dataset <file.json> RUN-SETTINGS",
  "  trading paper    --data-root <abs> --repo-root <abs> --dataset <file.json> RUN-SETTINGS",
  "",
  "Import quarantine review (R2; fictional data only; validation never authorizes real-world use):",
  "  import review --data-root <abs> --repo-root <abs> --manifest <file.json>",
  "  (reads the manifest and the content file it names; exit 0 = awaiting approval, 1 = rejected)",
  "",
  "RUN-SETTINGS: either   --config <file.json>",
  "              or all of --strategy buy_and_hold|ma_crossover [--fast N --slow N]",
  "                        --sizing fixed_units|all_cash [--units N]",
  "                        --cash <amount> --cash-currency <USD|GBP|quote currency> --slippage-bps <basis points>",
  "Nothing is defaulted: every financial assumption must be given.",
  "Files are read only from the data root (outside the repository): plain names ending in .json, no symbolic links.",
  "",
  "Examples:",
  "  trading validate --data-root /srv/research-data --repo-root \"$PWD\" --dataset fict-us.json",
  "  trading backtest --data-root /srv/research-data --repo-root \"$PWD\" --dataset fict-us.json \\",
  "      --strategy ma_crossover --fast 2 --slow 3 --sizing fixed_units --units 10 --cash 10000.00 --cash-currency USD --slippage-bps 1",
  "  trading paper --data-root /srv/research-data --repo-root \"$PWD\" --dataset fict-uk.json --config run-uk.json",
  "",
].join("\n");

export const TRADING_BANNER = [
  "Offline trading research -- FICTIONAL data only. Results are simulated and hypothetical: nothing was traded,",
  "no trading account, real order or live market data was involved, and no claim of predictive accuracy or profitability is made.",
  "",
  "",
].join("\n");

const IMPORT_BANNER = [
  "Offline import quarantine review -- FICTIONAL data only. Imported content is untrusted; nothing was fetched, approved,",
  "traded or passed to the research engines, and a successful validation does not authorize real-world use.",
  "",
  "",
].join("\n");

const COMMON = ["data-root", "repo-root", "dataset"];
const IMPORT_OPTIONS = ["data-root", "repo-root", "manifest"];
const SETTINGS = ["strategy", "fast", "slow", "sizing", "units", "cash", "cash-currency", "slippage-bps"];
const TRADING_OPTIONS: Record<string, readonly string[]> = {
  validate: COMMON,
  backtest: [...COMMON, "config", ...SETTINGS],
  paper: [...COMMON, "config", ...SETTINGS],
};

class UsageError extends Error {}

function parseOptions(rest: readonly string[], allowed: readonly string[], command: string, required: readonly string[] = COMMON): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const name = /^--[a-z][a-z-]{0,31}$/.test(flag) ? flag.slice(2) : null;
    if (name === null) throw new UsageError(`argument ${i + 3} is not an option (options look like --name value)`);
    if (!allowed.includes(name)) throw new UsageError(`unknown option --${name} for ${command}`);
    if (options.has(name)) throw new UsageError(`option --${name} is given more than once`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`option --${name} needs a value`);
    options.set(name, value);
  }
  for (const name of required) if (!options.has(name)) throw new UsageError(`missing option --${name}`);
  return options;
}

/** Whole numbers are converted; anything else is passed through as text so the trading parser refuses it with a clear message. */
const integerOrText = (v: string): number | string => (/^[1-9][0-9]{0,9}$/.test(v) ? Number(v) : v);

/** Builds the run configuration object from explicit options (validated afterwards by the trading module). */
function settingsFromOptions(o: Map<string, string>): unknown {
  for (const name of ["strategy", "sizing", "cash", "cash-currency", "slippage-bps"]) {
    if (!o.has(name)) throw new UsageError(`missing option --${name} (give every run setting, or --config <file.json>; nothing is defaulted)`);
  }
  const kind = o.get("strategy")!;
  const strategy: Record<string, unknown> = { kind };
  if (kind === "ma_crossover") {
    if (!o.has("fast") || !o.has("slow")) throw new UsageError("ma_crossover needs --fast and --slow");
    strategy.fast = integerOrText(o.get("fast")!);
    strategy.slow = integerOrText(o.get("slow")!);
  } else if (o.has("fast") || o.has("slow")) {
    throw new UsageError("--fast and --slow apply only to --strategy ma_crossover");
  }
  const mode = o.get("sizing")!;
  const sizing: Record<string, unknown> = { mode };
  if (mode === "fixed_units") {
    if (!o.has("units")) throw new UsageError("--sizing fixed_units needs --units");
    sizing.units = integerOrText(o.get("units")!);
  } else if (o.has("units")) {
    throw new UsageError("--units applies only to --sizing fixed_units");
  }
  return {
    version: 1, strategy, execution: "next_bar_open", initialCash: { currency: o.get("cash-currency"), amount: o.get("cash") }, sizing,
    slippageBps: o.get("slippage-bps"),
  };
}

function runTrading(command: string, rest: readonly string[], io: CliIo, roots: string[]): number {
  if (!Object.hasOwn(TRADING_OPTIONS, command)) throw new UsageError("unknown trading command (expected validate, backtest or paper)");
  const o = parseOptions(rest, TRADING_OPTIONS[command], `trading ${command}`);
  roots.push(o.get("data-root")!, o.get("repo-root")!);
  const location = (file: string) => ({ dataRoot: o.get("data-root")!, repositoryRoot: o.get("repo-root")!, file });
  let config: BacktestConfig | null = null;
  let configRaw: unknown = null;
  if (command !== "validate") {
    const settingGiven = SETTINGS.some((s) => o.has(s));
    if (o.has("config") && settingGiven) throw new UsageError("give either --config or individual run settings, not both");
    if (!o.has("config")) configRaw = settingsFromOptions(o);
  }
  // Read and validate everything before producing any output (fail closed; no partial reports).
  const ds: Dataset = parseDatasetText(readTradingInput(location(o.get("dataset")!), "--dataset", MAX_DATASET_FILE_BYTES));
  if (command !== "validate") {
    config = o.has("config")
      ? parseBacktestConfigText(readTradingInput(location(o.get("config")!), "--config", MAX_CONFIG_FILE_BYTES), ds)
      : parseBacktestConfig(configRaw, ds);
  }
  let report: string;
  if (command === "validate") report = renderDatasetReport(ds);
  else if (command === "backtest") report = renderBacktestReport(ds, config!, runBacktest(ds, config!));
  else report = renderPaperReport(PaperSession.replay(ds, config!));
  io.out(terminalSafe(TRADING_BANNER + report));
  return EXIT.ok;
}

/**
 * R2 import review: the manifest, then the content file it names, are read
 * through the same read-only loader as trading inputs (data root only, plain
 * .json names, no symbolic links, size limits, strict UTF-8). File problems
 * are refusals (exit 1); a completed review is printed (exit 0 when awaiting
 * approval, 1 when rejected). Nothing is written, moved or deleted.
 */
function runImport(command: string, rest: readonly string[], io: CliIo, roots: string[]): number {
  if (command !== "review") throw new UsageError("unknown import command (expected review)");
  const o = parseOptions(rest, IMPORT_OPTIONS, "import review", IMPORT_OPTIONS);
  roots.push(o.get("data-root")!, o.get("repo-root")!);
  const location = (file: string) => ({ dataRoot: o.get("data-root")!, repositoryRoot: o.get("repo-root")!, file });
  const manifestText = readTradingInput(location(o.get("manifest")!), "--manifest", MAX_IMPORT_MANIFEST_BYTES);
  const file = importContentFile(manifestText);
  if (file !== null && file === o.get("manifest")) throw new TradingFileError(["manifest.content.file: must name a different file from the manifest"]);
  const contentText = file === null ? null : readTradingInput(location(file), "manifest.content.file", MAX_IMPORT_CONTENT_BYTES);
  const review = reviewImport(manifestText, contentText);
  io.out(terminalSafe(IMPORT_BANNER + renderImportReview(review)));
  return review.state === "awaiting_approval" ? EXIT.ok : EXIT.refused;
}

/** Runs one command; returns the exit code. Never throws. */
export function runResearchCli(argv: readonly string[], io: CliIo): number {
  if (argv[0] === "assess" || argv[0] === "compare") return runBusinessCli(argv, io); // existing business CLI, unchanged
  const roots: string[] = [];
  try {
    if (argv.some((a) => typeof a !== "string" || a.length > MAX_ARG_CHARS)) throw new UsageError(`arguments must be text of at most ${MAX_ARG_CHARS} characters`);
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      io.out(USAGE);
      return EXIT.ok;
    }
    if (argv[0] === undefined) throw new UsageError("no command given");
    if (argv[0] === "import") return runImport(argv[1] ?? "", argv.slice(2), io, roots);
    if (argv[0] !== "trading") throw new UsageError("unknown command (expected assess, compare, trading or import)");
    if (argv[1] === undefined) throw new UsageError("missing trading command (expected validate, backtest or paper)");
    return runTrading(argv[1], argv.slice(2), io, roots);
  } catch (err) {
    try {
      if (err instanceof UsageError) {
        io.err(`${terminalSafe(`Usage error: ${err.message}`)}\n\n${USAGE}`);
        return EXIT.usage;
      }
      if (err instanceof TradingFileError || err instanceof ValidationError) {
        io.err(formatRefusal(err instanceof TradingFileError ? err.reasons : err.issues, roots));
        return EXIT.refused;
      }
      io.err("Internal error (details withheld).\n");
    } catch {
      // Nothing more can be reported safely.
    }
    return EXIT.internal;
  }
}
