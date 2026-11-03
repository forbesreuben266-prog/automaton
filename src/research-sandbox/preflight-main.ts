/**
 * Process entry point for the preflight runner (V1A). The ONLY module in this
 * package that runs at load time: it wires the real engine adapter
 * (createCliEngine with nodeProcessRunner: pinned socket and client config,
 * no shell, minimal environment), the real host filesystem and a fail-closed
 * reader for the operator's configuration file, then calls
 * runPreflightCommand. Every check is in runner.ts and the existing preflight.
 *
 *   node dist/research-sandbox/preflight-main.js --config <abs.json> --confirm-docker-access [--output text|json]
 *
 * Configuration file rules (refused otherwise, before any engine call): an
 * absolute path; the file is a regular file (no symlink, opened with
 * O_NOFOLLOW | O_NONBLOCK and bound to the inode checked), owned by root or
 * the invoking user, not writable by group or others, at most 64 KiB of
 * strict UTF-8; its folder is a real directory owned by root or the invoking
 * user and not writable by group or others. Nothing is written.
 */

import fs from "node:fs";
import { createCliEngine, nodeProcessRunner } from "./engine.js";
import { nodeHostFs } from "./host-paths.js";
import { MAX_RUNNER_CONFIG_BYTES, RunnerConfigError, runPreflightCommand } from "./runner.js";

/** Reads the runner configuration file; throws RunnerConfigError. Exported for tests. */
export function readRunnerConfigFile(path: string, euid: number): string {
  const refuse = (why: string): never => { throw new RunnerConfigError([`configuration file: ${why}`]); };
  const safeOwner = (uid: number) => uid === 0 || uid === euid;
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  let d: fs.Stats;
  let st: fs.Stats;
  try { d = fs.lstatSync(dir); st = fs.lstatSync(path); } catch (err) { return refuse(`cannot be inspected (${(err as NodeJS.ErrnoException).code ?? "error"})`); }
  if (d.isSymbolicLink() || !d.isDirectory()) refuse("its folder must be a real directory (no symbolic link)");
  if (!safeOwner(d.uid) || (d.mode & 0o022) !== 0) refuse("its folder must be owned by root or you and not writable by group or others");
  if (st.isSymbolicLink() || !st.isFile()) refuse("must be a regular file (no symbolic link)");
  if (!safeOwner(st.uid) || (st.mode & 0o022) !== 0) refuse("must be owned by root or you and not writable by group or others");
  if (st.size > MAX_RUNNER_CONFIG_BYTES) refuse(`is ${st.size} bytes; the limit is ${MAX_RUNNER_CONFIG_BYTES}`);
  let fd: number;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (err) { return refuse(`cannot be opened (${(err as NodeJS.ErrnoException).code ?? "error"})`); }
  try {
    const f = fs.fstatSync(fd);
    if (!f.isFile() || f.dev !== st.dev || f.ino !== st.ino) refuse("changed between inspection and opening");
    const buf = Buffer.alloc(MAX_RUNNER_CONFIG_BYTES + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_RUNNER_CONFIG_BYTES) refuse(`grew beyond ${MAX_RUNNER_CONFIG_BYTES} bytes while being read`);
    }
    const bytes = buf.subarray(0, total);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse("must not start with a byte-order mark");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return refuse("is not valid UTF-8"); }
  } finally {
    fs.closeSync(fd);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : -1;
  return runPreflightCommand(argv, {
    readConfig: (p) => readRunnerConfigFile(p, euid),
    createEngine: (binary, configDir) => createCliEngine(binary, configDir, nodeProcessRunner),
    hostFs: nodeHostFs,
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}

if (process.argv[1]?.endsWith("/research-sandbox/preflight-main.js")) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 3; });
}
