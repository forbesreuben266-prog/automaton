/**
 * FICTIONAL demonstration data for the Phase 1A research CLI (step 6). The
 * runs are invented (reserved example domains, fictional organisations and
 * figures); they do not represent real demand, prices, profitability or
 * market conditions.
 *
 * Usage (writes two fictional runs into an EMPTY directory outside the repository):
 *   ./node_modules/.bin/tsx src/__tests__/research-pipeline/cli-demo.ts /absolute/empty/dir
 * The destination must be an existing, absolute, empty directory (checked
 * with lstat: not a symbolic link or a file) whose real path is outside the
 * repository's real path (symlinked ancestors are resolved; resolution
 * failures refuse). Files are created exclusively ("wx"), so an existing file
 * is never overwritten. Refusals print a short message (no stack trace) and
 * exit with code 2; a failed write exits with code 1.
 * This helper is test tooling; the CLI itself never writes files.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AS_OF, OPPORTUNITY_ID, addSource, validRun } from "./fixtures.js";

export const DEMO_OPPORTUNITY = OPPORTUNITY_ID;
export const DEMO_INITIAL = AS_OF;
export const DEMO_LATER = "2026-10-20";
const DEMO_BRIEF = "FICTIONAL DEMONSTRATION: invented data; not real demand, prices, profitability or market conditions.";

/** The initial run and a later run with one new source and claim, and a changed acquisition-cost assumption. */
export function demoRuns(): { initial: any; later: any } {
  const initial = validRun();
  initial.opportunity.brief = DEMO_BRIEF;
  const later = validRun();
  later.opportunity.brief = DEMO_BRIEF;
  later.manifest.runDate = DEMO_LATER;
  later.workbook.asOf = DEMO_LATER;
  addSource(later, { id: "neighbourhood-poll", content: "FICTIONAL FIXTURE. In a neighbourhood poll, 42 of 60 dog owners wanted weekday walks." });
  later.workbook.claims.push({ id: "c-poll", type: "fact", statement: "In a fictional neighbourhood poll, 42 of 60 dog owners wanted weekday walks.",
    citations: [{ snapshotId: "neighbourhood-poll", quote: "42 of 60 dog owners wanted weekday walks" }] });
  later.workbook.sections.demandAndMarket.push("c-poll");
  later.workbook.assumptions.find((a: any) => a.id === "cac").value = 2_500;
  return { initial, later };
}

/** Exclusive creation: throws (EEXIST) rather than overwrite an existing file. */
const create = (file: string, text: string) => fs.writeFileSync(file, text, { flag: "wx" });

/**
 * Writes one run in the step 3 layout under root. Files are created
 * exclusively; pass writeOpportunity = false when the opportunity file
 * already exists (a second run of the same opportunity).
 */
export function writeRun(root: string, run: any, writeOpportunity = true): void {
  const oppDir = path.join(root, run.opportunity.id);
  const runDir = path.join(oppDir, "runs", run.manifest.runDate);
  fs.mkdirSync(path.join(runDir, "sources"), { recursive: true });
  if (writeOpportunity) create(path.join(oppDir, "opportunity.json"), JSON.stringify(run.opportunity, null, 2));
  create(path.join(runDir, "manifest.json"), JSON.stringify(run.manifest, null, 2));
  create(path.join(runDir, "workbook.json"), JSON.stringify(run.workbook, null, 2));
  for (const s of run.sources) create(path.join(runDir, "sources", s.file), s.content);
}

export function writeDemo(root: string): void {
  const { initial, later } = demoRuns();
  writeRun(root, initial);
  writeRun(root, later, false);
}

const USAGE_LINE = "Usage: cli-demo.ts <existing empty absolute directory outside the repository>";

/** Checks the destination; returns its real path, or a short refusal reason (never echoes the path). */
export function checkDestination(target: string | undefined, repo: string): { real: string } | { refused: string } {
  if (!target) return { refused: "no destination given" };
  if (!path.isAbsolute(target)) return { refused: "the destination must be an absolute path" };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { refused: "the destination does not exist or cannot be inspected" };
  }
  if (stat.isSymbolicLink()) return { refused: "the destination must not be a symbolic link" };
  if (!stat.isDirectory()) return { refused: "the destination is not a directory" };
  let real: string;
  let repoReal: string;
  try {
    real = fs.realpathSync(target);
    repoReal = fs.realpathSync(repo);
  } catch {
    return { refused: "real paths could not be resolved" };
  }
  if (real === repoReal || real.startsWith(repoReal + path.sep) || repoReal.startsWith(real + path.sep)) {
    return { refused: "the destination is inside the repository (or contains it)" };
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(real);
  } catch {
    return { refused: "the destination cannot be listed" };
  }
  if (entries.length > 0) return { refused: "the destination is not empty" };
  return { real };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const checked = process.argv.length === 3 ? checkDestination(process.argv[2], repo) : { refused: "expected exactly one destination argument" };
  if ("refused" in checked) {
    process.stderr.write(`Refused: ${checked.refused}.\n${USAGE_LINE}\n`);
    process.exitCode = 2;
  } else {
    try {
      writeDemo(checked.real);
      process.stdout.write(`Wrote fictional demonstration runs ${DEMO_INITIAL} and ${DEMO_LATER} for "${DEMO_OPPORTUNITY}".\n`);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "error";
      process.stderr.write(`Refused: the demonstration files could not be created (${code}); no existing file was overwritten.\n`);
      process.exitCode = 1;
    }
  }
}
