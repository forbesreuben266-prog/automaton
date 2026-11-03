/**
 * Read-only loader for trading research input files (U1). It follows the
 * same rules as the business research file reader (research step 3):
 * - an explicit data root, a normalized absolute path outside the repository
 *   (and not containing it), checked BEFORE any filesystem call;
 * - the file is named explicitly: a plain lower-case name ending in .json,
 *   directly inside the data root (no directories, traversal or hidden names);
 * - every path component from "/" is checked with lstat: no symbolic links;
 *   the data root must not be writable by others;
 * - the file must be a regular file, opened with O_RDONLY | O_NOFOLLOW |
 *   O_NONBLOCK, bound to the inode lstat saw (device and inode), read up to
 *   a byte limit (limit + 1 bytes at most), strict UTF-8 without a BOM; the
 *   whole chain is re-checked afterwards and must be unchanged.
 * Nothing is written, created or deleted. NOT AN OS SANDBOX: path checks
 * can't prevent races with someone able to write to these directories; only
 * the operator should be able to.
 */

import fs from "node:fs";

export const MAX_DATASET_FILE_BYTES = 10_000_000;
export const MAX_CONFIG_FILE_BYTES = 10_000;
export const INPUT_FILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\.json$/;
const ABSOLUTE_PATH = /^(\/[A-Za-z0-9._-]+)+$/;

export class TradingFileError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Trading input refused:\n- ${reasons.join("\n- ")}`);
    this.name = "TradingFileError";
  }
}

export interface InputLocation {
  readonly dataRoot: string;
  readonly repositoryRoot: string;
  readonly file: string;
}

const refuse = (reason: string): never => { throw new TradingFileError([reason]); };
const errorCode = (err: unknown) => (err as { code?: string })?.code ?? "error";

/** Validates the strings before any filesystem access. */
export function checkInputLocation(location: InputLocation, label: string): void {
  for (const [name, value] of [["data root", location.dataRoot], ["repository root", location.repositoryRoot]] as const) {
    if (typeof value !== "string" || !ABSOLUTE_PATH.test(value) || value.split("/").some((c) => c === "." || c === "..")) {
      refuse(`${name}: must be a normalized absolute path (no trailing slash, "." or ".." components, or unusual characters)`);
    }
  }
  const { dataRoot: root, repositoryRoot: repo } = location;
  if (root === repo || root.startsWith(`${repo}/`) || repo.startsWith(`${root}/`)) refuse("data root: must be outside the repository (and must not contain it)");
  if (typeof location.file !== "string" || !INPUT_FILE_PATTERN.test(location.file)) {
    refuse(`${label}: must be a plain lower-case file name ending in .json, directly inside the data root`);
  }
}

interface Identity { readonly path: string; readonly dev: string; readonly ino: string; readonly file: boolean }

function lstatChain(target: string, finalIsFile: boolean, dataRoot: string): Identity[] {
  const parts = target.split("/").filter(Boolean);
  const out: Identity[] = [];
  let current = "";
  for (let i = -1; i < parts.length; i++) {
    current = i < 0 ? "/" : `${current === "/" ? "" : current}/${parts[i]}`;
    const isLast = i === parts.length - 1;
    let st: fs.Stats;
    try { st = fs.lstatSync(current); } catch (err) { return refuse(`${current}: cannot be inspected (${errorCode(err)})`); }
    if (st.isSymbolicLink()) refuse(`${current}: is a symbolic link`);
    const wantFile = isLast && finalIsFile;
    if (wantFile ? !st.isFile() : !st.isDirectory()) refuse(`${current}: is not a ${wantFile ? "regular file" : "directory"}`);
    if ((current === dataRoot || current.startsWith(`${dataRoot}/`)) && (st.mode & 0o002) !== 0) refuse(`${current}: is writable by others`);
    out.push({ path: current, dev: String(st.dev), ino: String(st.ino), file: wantFile });
  }
  return out;
}

/** Reads one explicitly named input file as UTF-8 text. Throws TradingFileError. */
export function readTradingInput(location: InputLocation, label: string, maxBytes: number): string {
  checkInputLocation(location, label);
  const path = `${location.dataRoot}/${location.file}`;
  const chain = lstatChain(path, true, location.dataRoot);
  const expected = chain[chain.length - 1];
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    return refuse(`${path}: cannot be opened (${errorCode(err)})`);
  }
  let bytes: Uint8Array;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) refuse(`${path}: is not a regular file`);
    if (String(st.dev) !== expected.dev || String(st.ino) !== expected.ino) refuse(`${path}: changed between inspection and opening`);
    if (st.size > maxBytes) refuse(`${path}: is ${st.size} bytes; the limit is ${maxBytes}`);
    const buffer = new Uint8Array(maxBytes + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) refuse(`${path}: grew beyond the limit of ${maxBytes} bytes while being read`);
    }
    bytes = buffer.subarray(0, total);
  } catch (err) {
    if (err instanceof TradingFileError) throw err;
    return refuse(`${path}: could not be read (${errorCode(err)})`);
  } finally {
    fs.closeSync(fd);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse(`${path}: must not start with a byte-order mark`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse(`${path}: is not valid UTF-8`);
  }
  for (const id of chain) {
    let st: fs.Stats;
    try { st = fs.lstatSync(id.path); } catch (err) { return refuse(`${id.path}: changed during loading (${errorCode(err)})`); }
    if (st.isSymbolicLink() || (id.file ? !st.isFile() : !st.isDirectory()) || String(st.dev) !== id.dev || String(st.ino) !== id.ino) {
      refuse(`${id.path}: changed during loading`);
    }
  }
  return text;
}
