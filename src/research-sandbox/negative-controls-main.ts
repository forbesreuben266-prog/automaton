/**
 * Process entry point for the Step A2 negative controls (M1). Wires the same
 * real engine adapter, host filesystem, configuration reader and host process
 * observer as preflight-main.ts, then calls runNegativeControlsCommand.
 *
 *   sudo node dist/research-sandbox/negative-controls-main.js --config <abs runner config .json> --confirm-docker-access [--output text|json]
 */

import { createCliEngine, nodeProcessRunner } from "./engine.js";
import { nodeHostFs } from "./host-paths.js";
import { procHostProcessObserver } from "./host-processes.js";
import { runNegativeControlsCommand } from "./negative-controls.js";
import { readRunnerConfigFile } from "./preflight-main.js";

export async function main(argv: readonly string[]): Promise<number> {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : -1;
  return runNegativeControlsCommand(argv, {
    readConfig: (p) => readRunnerConfigFile(p, euid),
    createEngine: (binary, configDir) => createCliEngine(binary, configDir, nodeProcessRunner),
    hostFs: nodeHostFs,
    hostProcesses: procHostProcessObserver(),
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}

if (process.argv[1]?.endsWith("/research-sandbox/negative-controls-main.js")) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 3; });
}
