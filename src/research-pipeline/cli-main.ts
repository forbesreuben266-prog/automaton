/** Entry point for the offline research CLI (see cli.ts). Only arguments, standard output/error and the exit code are used. */
import { runCli } from "./cli.js";

process.exitCode = runCli(process.argv.slice(2), { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) });
