/**
 * Process entry point for the E1 research executor. Wires the real engine
 * adapter, host filesystem, host process observer and the same fail-closed
 * file reader as preflight-main.ts, then calls runResearchJobCommand with the
 * DEFAULT internals (the real preflight and gate; never an override).
 *
 *   sudo node dist/research-sandbox/executor-main.js --config <abs runner config .json> --job <abs job .json> --confirm-sandboxed-research
 */

import { createCliEngine, nodeProcessRunner } from "./engine.js";
import { runResearchJobCommand } from "./executor.js";
import { nodeHostFs } from "./host-paths.js";
import { procHostProcessObserver } from "./host-processes.js";
import { readRunnerConfigFile } from "./preflight-main.js";
import { parseRunnerConfig } from "./runner.js";
import { expectedRunPaths, resolveSpec } from "./spec.js";

export async function main(argv: readonly string[]): Promise<number> {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : -1;
  return runResearchJobCommand(argv, {
    readFile: (p) => readRunnerConfigFile(p, euid),
    parseConfig: parseRunnerConfig,
    resolveSpec: (pins) => resolveSpec(pins),
    runPaths: (spec, runId) => ({ runId, ...expectedRunPaths(spec, runId) }),
    createEngine: (binary, configDir) => createCliEngine(binary, configDir, nodeProcessRunner),
    hostFs: nodeHostFs,
    hostProcesses: procHostProcessObserver(),
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}

if (process.argv[1]?.endsWith("/research-sandbox/executor-main.js")) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 3; });
}
