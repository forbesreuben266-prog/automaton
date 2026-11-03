/**
 * Offline research CLI (Phase 1A step 6). Operator-invoked only: no
 * background work, scheduling, network, models, Docker or sandbox. This
 * module has no process or filesystem access of its own; cli-main.ts passes
 * in the arguments and the output functions, and files are read only through
 * the step 3 loader (loadRun: explicit data and repository roots, path and
 * symlink checks, read-only). Nothing is written.
 *
 * Commands (each prints Markdown to standard output):
 *   assess  --data-root <abs> --repo-root <abs> --opportunity <id> --run <date>
 *     loadRun, then assembleRun (steps 2-4.5 and Phase 0 validation).
 *   compare --data-root <abs> --repo-root <abs> --opportunity <id> --previous <date> --current <date>
 *     loadRun for both runs, then compareRuns (step 5; each run is
 *     re-validated independently).
 *
 * Output safety: report text is already escaped by the renderers; every
 * line written (results and errors) additionally passes terminalSafe, which
 * replaces control, bidi and invisible formatting characters with a visible
 * \\u{...} form, so input text can't move the cursor, clear the screen or
 * forge output. Errors are bounded (at most MAX_ERROR_LINES lines of at most
 * MAX_ERROR_LINE_CHARS characters), never include stack traces or
 * environment values, and show the data and repository roots as
 * <data-root> and <repo-root> (other absolute paths as <path>).
 *
 * Exit codes: 0 success; 1 input refused (validation, files, comparison);
 * 2 usage error; 3 unexpected internal error (details withheld).
 */

import { assembleRun, AssemblyError } from "./assemble.js";
import { compareRuns, HistoryError } from "./history.js";
import { loadRun, LocalFileError } from "./local-files.js";

export const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2, internal: 3 });
export const MAX_ERROR_LINES = 20;
export const MAX_ERROR_LINE_CHARS = 300;
/** Longest accepted argument (paths and ids are far shorter). */
export const MAX_ARG_CHARS = 4_096;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const USAGE = [
  "Usage (Phase 1A offline research CLI; approved for fictional inputs only):",
  "  assess  --data-root <absolute path> --repo-root <absolute path> --opportunity <id> --run <YYYY-MM-DD>",
  "  compare --data-root <absolute path> --repo-root <absolute path> --opportunity <id> --previous <YYYY-MM-DD> --current <YYYY-MM-DD>",
  "  --help",
  "",
  "Reads <data-root>/<opportunity>/opportunity.json and runs/<date>/{manifest.json,workbook.json,sources/*}.",
  "The data root must be outside the repository. Results are printed to standard output; nothing is written.",
  "",
].join("\n");

export const BANNER = [
  "Phase 1A offline research output -- approved for fictional inputs only; not a basis for real decisions.",
  "Operator assessments (scores, gate marks, negative findings, contradictions) are not independently verified facts.",
  "Financial figures are projections from assumptions, not established business results. Nothing here authorizes any action.",
  "",
  "",
].join("\n");

const COMMANDS: Record<string, readonly string[]> = {
  assess: ["data-root", "repo-root", "opportunity", "run"],
  compare: ["data-root", "repo-root", "opportunity", "previous", "current"],
};

/** Replaces terminal control, bidi and invisible formatting characters (keeping line feeds) with a visible form. */
export function terminalSafe(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g,
    (c) => `\\u{${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}}`);
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): { command: string; options: Map<string, string> } {
  if (argv.some((a) => typeof a !== "string" || a.length > MAX_ARG_CHARS)) throw new UsageError(`arguments must be text of at most ${MAX_ARG_CHARS} characters`);
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError("no command given");
  const allowed = COMMANDS[command];
  if (!Object.hasOwn(COMMANDS, command) || !allowed) throw new UsageError("unknown command (expected assess or compare)");
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const name = /^--[a-z][a-z-]{0,31}$/.test(flag) ? flag.slice(2) : null;
    if (name === null) throw new UsageError(`argument ${i + 2} is not an option (options look like --name value)`);
    if (!allowed.includes(name)) throw new UsageError(`unknown option --${name} for ${command}`);
    if (options.has(name)) throw new UsageError(`option --${name} is given more than once`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`option --${name} needs a value`);
    options.set(name, value);
  }
  for (const name of allowed) if (!options.has(name)) throw new UsageError(`missing option --${name}`);
  return { command, options };
}

/** Bounded, path-redacted, terminal-safe refusal text (roots: [dataRoot, repositoryRoot]). */
export function formatRefusal(reasons: readonly string[], roots: readonly string[]): string {
  const redact = (line: string) => {
    let out = line;
    for (const [root, label] of roots.map((r, i) => [r, i === 0 ? "<data-root>" : "<repo-root>"] as const).sort((a, b) => b[0].length - a[0].length)) {
      if (root.length > 1) out = out.split(root).join(label);
    }
    // Paths under a root keep their (validated) relative part; any other absolute path is hidden.
    return out.replace(/(?<![\w:/<>.-])(\/[A-Za-z0-9._-]+)+\/?/g, "<path>");
  };
  const lines = reasons.slice(0, MAX_ERROR_LINES).map((r) => {
    const safe = terminalSafe(redact(String(r)));
    return safe.length > MAX_ERROR_LINE_CHARS ? `${safe.slice(0, MAX_ERROR_LINE_CHARS)}...` : safe;
  });
  if (reasons.length > MAX_ERROR_LINES) lines.push(`... and ${reasons.length - MAX_ERROR_LINES} more`);
  return `Refused:\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
}

/**
 * Runs one command. Returns the exit code; writes results with io.out and
 * errors with io.err. Never throws (unexpected errors give EXIT.internal
 * with details withheld).
 */
export function runCli(argv: readonly string[], io: CliIo): number {
  let roots: string[] = [];
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      io.out(USAGE);
      return EXIT.ok;
    }
    const { command, options } = parseArgs(argv);
    const location = (runId: string) => ({
      dataRoot: options.get("data-root")!, repositoryRoot: options.get("repo-root")!, opportunityId: options.get("opportunity")!, runId,
    });
    roots = [options.get("data-root")!, options.get("repo-root")!];
    let markdown: string;
    if (command === "assess") {
      markdown = assembleRun(loadRun(location(options.get("run")!))).markdown;
    } else {
      const previous = loadRun(location(options.get("previous")!));
      const current = loadRun(location(options.get("current")!));
      markdown = compareRuns(previous, current).markdown;
    }
    io.out(terminalSafe(BANNER + markdown));
    return EXIT.ok;
  } catch (err) {
    try {
      if (err instanceof UsageError) {
        io.err(`${terminalSafe(`Usage error: ${err.message}`)}\n\n${USAGE}`);
        return EXIT.usage;
      }
      if (err instanceof LocalFileError || err instanceof AssemblyError || err instanceof HistoryError) {
        io.err(formatRefusal(err.reasons, roots));
        return EXIT.refused;
      }
      io.err("Internal error (details withheld).\n");
    } catch {
      // Nothing more can be reported safely.
    }
    return EXIT.internal;
  }
}
