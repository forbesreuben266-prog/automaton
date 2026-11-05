/**
 * E1: the research image. One image holds BOTH the canary probe and the
 * offline research CLI, so the preflight's canary and the research job run
 * from the same pinned image ID: the preflight result's binding (image
 * reference, security arguments) then matches the job exactly
 * (assertUntrustedInputAllowed). Built from the pinned base by digest
 * (deploy/research-sandbox/Dockerfile.research) with no ENV, ENTRYPOINT,
 * USER, VOLUME or LABEL, so the recorded base entrypoint and environment
 * still apply. Only Node built-ins are used by these files (checked by test).
 */

/**
 * Compiled files of the research CLI under /app, at their dist/-relative paths (plus /app/package.json). The canary
 * keeps the canary image's layout (/app/canary-probe.js and /app/canary.js; see RESEARCH_IMAGE_LAYOUT), so the
 * preflight's probe command and the host-process marker are unchanged.
 */
export const RESEARCH_IMAGE_FILES: readonly string[] = Object.freeze([
  "divisions/business-research/citations.js",
  "divisions/business-research/finance.js",
  "divisions/business-research/index.js",
  "divisions/business-research/proposals.js",
  "divisions/business-research/report.js",
  "divisions/business-research/run-budget.js",
  "divisions/business-research/scoring.js",
  "divisions/business-research/sources.js",
  "divisions/business-research/untrusted.js",
  "divisions/business-research/validation.js",
  "research-cli/cli.js",
  "research-cli/main.js",
  "research-cli/trading-files.js",
  "research-pipeline/assemble.js",
  "research-pipeline/cli.js",
  "research-pipeline/division.js",
  "research-pipeline/history.js",
  "research-pipeline/ledger.js",
  "research-pipeline/local-files.js",
  "research-pipeline/manifest.js",
  "research-pipeline/workbook.js",
  "research-readiness/business.js",
  "research-readiness/index.js",
  "research-readiness/market-data.js",
  "research-readiness/provenance.js",
  "research-readiness/quarantine.js",
  "research-readiness/readiness.js",
  "research-readiness/validation.js",
  "trading-research/backtest.js",
  "trading-research/dataset.js",
  "trading-research/execution.js",
  "trading-research/index.js",
  "trading-research/instruments.js",
  "trading-research/metrics.js",
  "trading-research/paper.js",
  "trading-research/prices.js",
  "trading-research/report.js",
  "trading-research/strategy.js",
  "trading-research/validation.js",
]);

/** [path under /app, source path under dist/] for every file in the image (package.json comes from deploy/research-sandbox/). */
export const RESEARCH_IMAGE_LAYOUT: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(["canary-probe.js", "research-sandbox/canary-probe.js"] as const),
  Object.freeze(["canary.js", "research-sandbox/canary.js"] as const),
  ...RESEARCH_IMAGE_FILES.map((f) => Object.freeze([f, f] as const)),
]);

/** The research CLI entry point inside the image (also the host-process marker for a research job). */
export const RESEARCH_SCRIPT = "/app/research-cli/main.js";
