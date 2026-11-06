/**
 * Private, link-safe file access for the personal agent. The data folder and every file in it belong to the current
 * user and are not accessible to group or others; writes are atomic (temporary file, then rename) and never follow a
 * symbolic link. Workspace paths are resolved component by component without following links (Linux /proc/self/fd).
 */

import fs from "node:fs";
import path from "node:path";
import { ToolInputError } from "./types.js";

const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/** Creates (mode 700) or checks a private directory owned by the current user. */
export function ensurePrivateDir(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const s = fs.lstatSync(dir);
  if (s.isSymbolicLink() || !s.isDirectory()) throw new Error(`${dir} must be a real directory, not a link`);
  if (s.uid !== uid()) throw new Error(`${dir} must be owned by you`);
  if ((s.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** Reads a private file (regular, owned by the user, not a link); null when it does not exist. */
export function readPrivate(file: string, maxBytes = 8 * 1024 * 1024): string | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path.basename(file)}: cannot be opened (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== uid()) throw new Error(`${path.basename(file)}: must be your own regular file`);
    if (s.size > maxBytes) throw new Error(`${path.basename(file)}: larger than ${maxBytes} bytes`);
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

/** Atomically replaces a private file (mode 600). */
export function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

/** Appends a line to a private log file (created mode 600; refuses links). */
export function appendPrivate(file: string, line: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, line.endsWith("\n") ? line : `${line}\n`); } finally { fs.closeSync(fd); }
}

/** Checks a workspace-relative path: plain components only, no absolute paths, no "." or "..". */
export function workspaceParts(rel: unknown): string[] {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 400) throw new ToolInputError("path: must be a relative path inside the workspace");
  if (rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) throw new ToolInputError("path: must be relative to the workspace (no leading /, backslash or NUL)");
  const parts = rel.split("/").filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 12 || parts.some((p) => p === "." || p === ".." || p.length > 120)) throw new ToolInputError("path: '.' and '..' are not allowed");
  return parts;
}

/** Opens a directory path from the filesystem root without following any link; returns the fd. */
function openDirNoFollow(abs: string): number {
  let fd = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  for (const c of abs.split("/").filter(Boolean)) {
    let next: number;
    try { next = fs.openSync(`/proc/self/fd/${fd}/${c}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
    catch (e) { fs.closeSync(fd); throw new ToolInputError(`${c}: missing, not a folder, or a link (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
    fs.closeSync(fd);
    fd = next;
  }
  return fd;
}

/** Runs fn with an fd for the workspace sub-folder (opened without following links). */
export function withWorkspaceDir<T>(workspace: string, dirParts: readonly string[], fn: (dirFd: number) => T): T {
  const fd = openDirNoFollow(path.join(workspace, ...dirParts));
  try { return fn(fd); } finally { fs.closeSync(fd); }
}

export const MAX_WORKSPACE_READ = 64 * 1024;
export const MAX_WORKSPACE_WRITE = 256 * 1024;

export function readWorkspaceFile(workspace: string, rel: unknown): { text: string; bytes: number; truncated: boolean } {
  const parts = workspaceParts(rel);
  return withWorkspaceDir(workspace, parts.slice(0, -1), (dfd) => {
    let fd: number;
    try { fd = fs.openSync(`/proc/self/fd/${dfd}/${parts[parts.length - 1]}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (e) { throw new ToolInputError(`${parts.join("/")}: cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"}; links are not followed)`); }
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile()) throw new ToolInputError(`${parts.join("/")}: not a regular file`);
      const buf = Buffer.alloc(Math.min(s.size, MAX_WORKSPACE_READ));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return { text: buf.subarray(0, n).toString("utf8"), bytes: s.size, truncated: s.size > MAX_WORKSPACE_READ };
    } finally { fs.closeSync(fd); }
  });
}

export function listWorkspace(workspace: string, rel: unknown): string[] {
  const parts = rel === undefined || rel === "" || rel === "." ? [] : workspaceParts(rel);
  return withWorkspaceDir(workspace, parts, (dfd) =>
    fs.readdirSync(`/proc/self/fd/${dfd}`, { withFileTypes: true }).slice(0, 500)
      .map((e) => `${e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file"} ${e.name}`).sort());
}

export function writeWorkspaceFile(workspace: string, rel: unknown, content: unknown): number {
  const parts = workspaceParts(rel);
  if (typeof content !== "string") throw new ToolInputError("content: must be text");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WORKSPACE_WRITE) throw new ToolInputError(`content: ${bytes} bytes; the limit is ${MAX_WORKSPACE_WRITE}`);
  return withWorkspaceDir(workspace, parts.slice(0, -1), (dfd) => {
    const name = parts[parts.length - 1];
    const tmp = `.${name}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(`/proc/self/fd/${dfd}/${tmp}`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
    try { const s = fs.lstatSync(`/proc/self/fd/${dfd}/${name}`); if (s.isSymbolicLink() || s.isDirectory()) { fs.unlinkSync(`/proc/self/fd/${dfd}/${tmp}`); throw new ToolInputError(`${parts.join("/")}: is a link or folder; not overwritten`); } } catch (e) { if (e instanceof ToolInputError) throw e; }
    fs.renameSync(`/proc/self/fd/${dfd}/${tmp}`, `/proc/self/fd/${dfd}/${name}`);
    return bytes;
  });
}

/** Reads <base>/<dir>/<file> (no links followed anywhere; a regular file owned by you; size-capped). */
export function readPrivateDirFile(base: string, dir: string, file: string, maxBytes: number): string {
  for (const n of [dir, file]) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n)) throw new ToolInputError(`${n}: not a plain name`);
  return withWorkspaceDir(base, [dir], (dfd) => {
    let fd: number;
    try { fd = fs.openSync(`/proc/self/fd/${dfd}/${file}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (e) { throw new ToolInputError(`${dir}/${file}: cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.uid !== uid()) throw new ToolInputError(`${dir}/${file}: must be your own regular file`);
      const buf = Buffer.alloc(Math.min(s.size, maxBytes)); const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8").replace(/[^\x20-\x7e\n\t]/g, "?") + (s.size > maxBytes ? `\n(truncated: ${s.size} bytes)` : "");
    } finally { fs.closeSync(fd); }
  });
}
