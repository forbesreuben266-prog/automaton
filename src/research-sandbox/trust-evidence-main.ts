/**
 * Process entry point for the Step A1 trust evidence collector (M3). READ-ONLY:
 * fixed query commands without a shell (minimal environment), and file reads.
 *
 *   sudo node dist/research-sandbox/trust-evidence-main.js --config <abs runner config .json> --confirm-read-only-host-queries
 */

import fs from "node:fs";
import { nodeProcessRunner } from "./engine.js";
import { readRunnerConfigFile } from "./preflight-main.js";
import { parseRunnerConfig } from "./runner.js";
import { runTrustEvidenceCommand, type FileStat } from "./trust-evidence.js";

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR";

export async function main(argv: readonly string[]): Promise<number> {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : -1;
  return runTrustEvidenceCommand(argv, {
    readConfig: (p) => readRunnerConfigFile(p, euid),
    parseConfig: parseRunnerConfig,
    evidence: {
      run: nodeProcessRunner,
      readFile: (p) => { try { return fs.readFileSync(p, "utf8"); } catch (err) { if (missing(err)) return null; throw err; } },
      readBytes: (p) => { try { return fs.readFileSync(p); } catch (err) { if (missing(err)) return null; throw err; } },
      lstat: (p): FileStat | null => { try { const s = fs.lstatSync(p); return { uid: s.uid, mode: s.mode, isFile: s.isFile(), isSymbolicLink: s.isSymbolicLink() }; } catch (err) { if (missing(err)) return null; throw err; } },
      readdir: (p) => { try { return fs.readdirSync(p); } catch (err) { if (missing(err)) return []; throw err; } },
      now: () => new Date().toISOString(),
    },
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}

if (process.argv[1]?.endsWith("/research-sandbox/trust-evidence-main.js")) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 3; });
}
