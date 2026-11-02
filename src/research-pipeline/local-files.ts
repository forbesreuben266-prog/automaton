/**
 * Read-only loader for one research run from a local data directory (Phase
 * 1A step 3). It reads FICTIONAL inputs in tests; processing real research
 * material is not approved (decision A) until OS isolation is reviewed.
 *
 * Layout (nothing else is read, and unexpected entries are refused):
 *   <dataRoot>/<opportunityId>/opportunity.json
 *   <dataRoot>/<opportunityId>/runs/<runId>/manifest.json
 *   <dataRoot>/<opportunityId>/runs/<runId>/workbook.json
 *   <dataRoot>/<opportunityId>/runs/<runId>/sources/<file listed in the manifest>
 *
 * Guarantees (each failure refuses; nothing is skipped or defaulted):
 * - The data root is given explicitly with the repository root; it must be a
 *   normalized absolute path outside the repository (never discovered, never
 *   the current directory). Every path component and file name is validated
 *   independently (this module's own patterns) BEFORE any filesystem call:
 *   no traversal, separators, empty, hidden or unsupported names.
 * - Every directory from "/" to each file is checked with lstat: no symlink
 *   anywhere in the chain. The data root and everything below it must not be
 *   writable by others. Inputs must be regular files (symlinks, FIFOs,
 *   sockets and devices are refused).
 * - Directory listings use entry types without following links; only the
 *   expected entries may exist (the sources directory holds exactly the
 *   manifest's files).
 * - Files are opened with O_NOFOLLOW | O_NONBLOCK (a FIFO can't block the
 *   open); the opened file must be the regular file lstat saw (same device
 *   and inode) and within the byte limit; at most limit + 1 bytes are ever
 *   read, so the real size is bounded, not just the reported one. Text must
 *   be valid UTF-8 without a byte-order mark; source text must not contain
 *   control characters other than tab, line feed and carriage return.
 * - Each source's SHA-256 (of its exact bytes) must equal the manifest entry.
 *   A match shows the file is unchanged since the manifest was written; it
 *   does NOT authenticate the publisher or show that any claim is true.
 * - After reading, the whole chain of directories and files is checked again
 *   and must be unchanged (device, inode, type).
 * - Content rules come from the step 2 parsers (parse*Text, checkRunInputs).
 * - Read-only and deterministic: no write, rename, delete or permission
 *   change; sources are returned in manifest order. Source text is returned
 *   as inert data; nothing here executes, interprets or renders it.
 *
 * NOT AN OS SANDBOX. Path checks can't prevent races: between the checks and
 * each open, someone able to write to these directories could swap a
 * component. O_NOFOLLOW only protects the final component; Node has no
 * openat2 / RESOLVE_NO_SYMLINKS, so intermediate directories are checked by
 * path. The identity checks (lstat vs fstat, and the final re-check) detect a
 * swap that is still in place, not one that was undone in between. The
 * defence is that only the operator can write to the data directory (and
 * nothing below the data root may be writable by others). Opening a device
 * node can have side effects; lstat refuses non-regular files first, so a
 * device is only reachable through such a race.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { SourceManifest } from "./manifest.js";
import { checkRunInputs, parseOpportunityText, parseWorkbookText, type OpportunityMetadata, type ResearchWorkbook } from "./workbook.js";
import { parseManifestText } from "./manifest.js";
import { SchemaError } from "./division.js";

/** Byte limits (bytes >= characters, so these also bound the parsers' character limits). */
export const MAX_OPPORTUNITY_BYTES = 20_000;
export const MAX_MANIFEST_BYTES = 1_000_000;
export const MAX_WORKBOOK_BYTES = 2_000_000;
/** Per source and in total (equal to Phase 0's per-snapshot and total character limits). */
export const MAX_SOURCE_BYTES = 500_000;
export const MAX_TOTAL_SOURCE_BYTES = 5_000_000;

/** This module's own name rules (independent of the step 2 parsers, by design). */
const ABSOLUTE_PATH = /^(\/[A-Za-z0-9._-]+)+$/;
const ID_COMPONENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SOURCE_FILE = /^[a-z0-9][a-z0-9_-]{0,63}\.(txt|md)$/;
const OPPORTUNITY_ENTRIES = ["opportunity.json", "runs"];
const RUN_ENTRIES = ["manifest.json", "sources", "workbook.json"];

export interface RunLocation {
  /** Absolute, normalized path of the research data directory (outside the repository). */
  readonly dataRoot: string;
  /** Absolute, normalized path of this repository, so the data root can be refused if it overlaps it. */
  readonly repositoryRoot: string;
  readonly opportunityId: string;
  /** The run folder name; must equal the manifest's run date. */
  readonly runId: string;
}

export interface LoadedSource {
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Untrusted, inert text. */
  readonly content: string;
}

export interface LoadedRun {
  readonly opportunity: OpportunityMetadata;
  readonly manifest: SourceManifest;
  readonly workbook: ResearchWorkbook;
  readonly sources: readonly LoadedSource[];
}

/** Refusal with a path-level reason (never echoes file content). */
export class LocalFileError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Research run refused:\n- ${reasons.join("\n- ")}`);
    this.name = "LocalFileError";
  }
}

const refuse = (reason: string): never => { throw new LocalFileError([reason]); };
const errorCode = (err: unknown) => (err as { code?: string })?.code ?? "error";
const components = (absolute: string) => absolute.split("/").filter((c) => c.length > 0);

/** Validates the location strings before any filesystem access. */
function checkLocation(location: unknown): RunLocation {
  if (typeof location !== "object" || location === null) return refuse("location: must be an object");
  const { dataRoot, repositoryRoot, opportunityId, runId } = location as Record<string, unknown>;
  for (const [name, value] of [["dataRoot", dataRoot], ["repositoryRoot", repositoryRoot]] as const) {
    if (typeof value !== "string" || !ABSOLUTE_PATH.test(value) || components(value).some((c) => c === "." || c === "..")) {
      refuse(`${name}: must be a normalized absolute path (no trailing slash, "." or ".." components, or unusual characters)`);
    }
  }
  const root = dataRoot as string;
  const repo = repositoryRoot as string;
  if (root === repo || root.startsWith(`${repo}/`) || repo.startsWith(`${root}/`)) refuse("dataRoot: must be outside the repository (and must not contain it)");
  for (const [name, value] of [["opportunityId", opportunityId], ["runId", runId]] as const) {
    if (typeof value !== "string" || !ID_COMPONENT.test(value)) refuse(`${name}: must be a plain lower-case name (letters, digits, - and _; no dots or separators)`);
  }
  return { dataRoot: root, repositoryRoot: repo, opportunityId: opportunityId as string, runId: runId as string };
}

interface Identity { readonly path: string; readonly dev: string; readonly ino: string; readonly kind: "dir" | "file" }

/**
 * lstat-checks every component from "/" to `target` (no symlinks; directories
 * at or below `writableCheckFrom` must not be writable by others) and records
 * each identity. `final` says whether the target must be a directory or a
 * regular file.
 */
function checkChain(target: string, final: "dir" | "file", writableCheckFrom: string, identities: Identity[]): fs.Stats {
  const parts = components(target);
  let current = "";
  let stat: fs.Stats | undefined;
  for (let i = -1; i < parts.length; i++) {
    current = i < 0 ? "/" : `${current === "/" ? "" : current}/${parts[i]}`;
    const isLast = i === parts.length - 1;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      return refuse(`${current}: cannot be inspected (${errorCode(err)})`);
    }
    if (stat.isSymbolicLink()) refuse(`${current}: is a symbolic link`);
    const wantFile = isLast && final === "file";
    if (wantFile ? !stat.isFile() : !stat.isDirectory()) refuse(`${current}: is not a ${wantFile ? "regular file" : "directory"}`);
    if ((current === writableCheckFrom || current.startsWith(`${writableCheckFrom}/`)) && (stat.mode & 0o002) !== 0) {
      refuse(`${current}: is writable by others`);
    }
    identities.push({ path: current, dev: String(stat.dev), ino: String(stat.ino), kind: wantFile ? "file" : "dir" });
  }
  return stat!;
}

/** Lists a directory without following links and refuses anything outside `allowed` (and any non-plain entry). */
function checkEntries(dir: string, allowed: readonly string[], kinds: Record<string, "dir" | "file">): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return refuse(`${dir}: cannot be listed (${errorCode(err)})`);
  }
  const names = entries.map((e) => e.name).sort();
  for (const entry of entries) {
    if (!allowed.includes(entry.name)) refuse(`${dir}: unexpected entry "${entry.name.slice(0, 64)}"`);
    const want = kinds[entry.name];
    if (want === "dir" ? !entry.isDirectory() : !entry.isFile()) refuse(`${dir}/${entry.name}: must be a ${want === "dir" ? "directory" : "regular file"} (not a link or special file)`);
  }
  for (const name of allowed) if (!names.includes(name)) refuse(`${dir}/${name}: is missing`);
}

/**
 * Opens and reads one regular file with O_NOFOLLOW | O_NONBLOCK, binding it
 * to the lstat identity, reading at most maxBytes + 1 bytes.
 */
function readBounded(file: string, expected: fs.Stats, maxBytes: number): Uint8Array {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    return refuse(`${file}: cannot be opened (${errorCode(err)})`);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) refuse(`${file}: is not a regular file`);
    if (String(opened.dev) !== String(expected.dev) || String(opened.ino) !== String(expected.ino)) refuse(`${file}: changed between inspection and opening`);
    if (opened.size > maxBytes) refuse(`${file}: is ${opened.size} bytes; the limit is ${maxBytes}`);
    const buffer = new Uint8Array(maxBytes + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) refuse(`${file}: grew beyond the limit of ${maxBytes} bytes while being read`);
    }
    return buffer.subarray(0, total);
  } catch (err) {
    if (err instanceof LocalFileError) throw err;
    return refuse(`${file}: could not be read (${errorCode(err)})`);
  } finally {
    fs.closeSync(fd);
  }
}

/** Strict UTF-8 (invalid sequences refuse; a byte-order mark refuses). */
function decodeUtf8(file: string, bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse(`${file}: must not start with a byte-order mark`);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse(`${file}: is not valid UTF-8`);
  }
}

/** Source text may contain tab, line feed and carriage return, but no other control character (C0, DEL, C1). */
function checkSourceText(file: string, text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const control = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f);
    if (control) refuse(`${file}: contains a control character (U+${code.toString(16).toUpperCase().padStart(4, "0")}) at offset ${i}`);
  }
}

const sha256OfBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Re-parses a step 2 SchemaError as a refusal naming the file. */
function parseWith<T>(file: string, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof SchemaError) throw new LocalFileError([`${file}: invalid content`, ...err.issues]);
    throw err;
  }
}

/** Loads one run: validates the location, the layout, every file and the content (see the module comment). */
export function loadRun(location: unknown): LoadedRun {
  const loc = checkLocation(location);
  const identities: Identity[] = [];
  const oppDir = `${loc.dataRoot}/${loc.opportunityId}`;
  const runsDir = `${oppDir}/runs`;
  const runDir = `${runsDir}/${loc.runId}`;
  const sourcesDir = `${runDir}/sources`;

  // Layout: the chain to the run directory, then the expected entries at each level.
  checkChain(runDir, "dir", loc.dataRoot, identities);
  checkEntries(oppDir, OPPORTUNITY_ENTRIES, { "opportunity.json": "file", runs: "dir" });
  checkEntries(runDir, RUN_ENTRIES, { "manifest.json": "file", "workbook.json": "file", sources: "dir" });
  checkChain(sourcesDir, "dir", loc.dataRoot, identities);

  const readText = (file: string, maxBytes: number) => decodeUtf8(file, readBounded(file, checkChain(file, "file", loc.dataRoot, identities), maxBytes));
  const opportunityFile = `${oppDir}/opportunity.json`;
  const manifestFile = `${runDir}/manifest.json`;
  const workbookFile = `${runDir}/workbook.json`;
  const opportunity = parseWith(opportunityFile, () => parseOpportunityText(readText(opportunityFile, MAX_OPPORTUNITY_BYTES)));
  const manifest = parseWith(manifestFile, () => parseManifestText(readText(manifestFile, MAX_MANIFEST_BYTES)));
  const workbook = parseWith(workbookFile, () => parseWorkbookText(readText(workbookFile, MAX_WORKBOOK_BYTES)));

  if (opportunity.id !== loc.opportunityId) refuse(`${opportunityFile}: id "${opportunity.id}" does not match the folder name "${loc.opportunityId}"`);
  if (manifest.runDate !== loc.runId) refuse(`${manifestFile}: run date ${manifest.runDate} does not match the run folder "${loc.runId}"`);
  parseWith(`${runDir}`, () => checkRunInputs(opportunity, manifest, workbook));

  // Sources: re-validate every file name independently, require exactly the manifest's files, then read and hash each.
  for (const source of manifest.sources) {
    if (!SOURCE_FILE.test(source.file)) refuse(`${manifestFile}: source "${source.id}" has an unsafe file name`);
  }
  const expectedFiles = manifest.sources.map((s) => s.file);
  checkEntries(sourcesDir, expectedFiles, Object.fromEntries(expectedFiles.map((f) => [f, "file" as const])));
  let totalBytes = 0;
  const sources = manifest.sources.map((source): LoadedSource => {
    const file = `${sourcesDir}/${source.file}`;
    const bytes = readBounded(file, checkChain(file, "file", loc.dataRoot, identities), MAX_SOURCE_BYTES);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) refuse(`${sourcesDir}: sources total more than ${MAX_TOTAL_SOURCE_BYTES} bytes`);
    const sha256 = sha256OfBytes(bytes);
    if (sha256 !== source.sha256) refuse(`${file}: SHA-256 does not match the manifest (the file changed since the manifest was written)`);
    const content = decodeUtf8(file, bytes);
    checkSourceText(file, content);
    return Object.freeze({ id: source.id, file: source.file, sha256, bytes: bytes.length, content });
  });

  // Final re-check: every directory and file inspected must still have the same identity and type.
  for (const id of identities) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(id.path);
    } catch (err) {
      return refuse(`${id.path}: changed during loading (${errorCode(err)})`);
    }
    const sameKind = id.kind === "dir" ? stat.isDirectory() : stat.isFile();
    if (stat.isSymbolicLink() || !sameKind || String(stat.dev) !== id.dev || String(stat.ino) !== id.ino) refuse(`${id.path}: changed during loading`);
  }
  return Object.freeze({ opportunity, manifest, workbook, sources: Object.freeze(sources) });
}
