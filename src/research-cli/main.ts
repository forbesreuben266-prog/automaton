/** Entry point for the unified offline research CLI (see cli.ts). Only arguments, standard output/error and the exit code are used. */
import { runResearchCli } from "./cli.js";

process.exitCode = runResearchCli(process.argv.slice(2), { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) });
