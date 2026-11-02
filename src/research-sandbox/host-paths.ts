/**
 * Host-side checks on a run's folders (trusted controller code; runs on the
 * target host). Filesystem access is injected (HostFs) so tests can use fakes.
 *
 * Checked, failing closed on any error:
 * - the paths are exactly <runsRoot>/<runId>/in and /out (spec.ts);
 * - every component from "/" down is a real directory (lstat: never a
 *   symlink) and realpath() returns the path unchanged;
 * - "/" and every ancestor are owned by root or the operator and are not
 *   writable by group or others (so nobody else can swap a component);
 * - in/ is owned by root or the operator and not writable by group/others;
 * - out/ is owned by the configured output owner, accessible only by that
 *   owner (mode & 077 == 0) and EMPTY (dedicated to this run);
 * - in/ and out/ are different directories.
 *
 * Time-of-check/time-of-use: the engine mounts paths by name, so a path could
 * in principle be swapped between this check and the mount. The ancestor
 * rules above leave only root and the operator able to do that, and the
 * preflight re-checks each folder's (dev, ino) identity after the container
 * is created. The window cannot be closed portably through the engine CLI
 * (that would need openat2(RESOLVE_NO_SYMLINKS) and passing file
 * descriptors to the daemon); this is a documented limitation.
 *
 * Engine target (verifyEngineTarget): the engine CLI is pinned to the local
 * socket /var/run/docker.sock and to an operator-prepared, empty client
 * configuration folder, so no saved context or client config can redirect it
 * to another daemon or inject settings. Both are checked here (no symlinks
 * except a root-owned /var/run -> /run; root-owned socket that is not
 * world-writable; config folder owned by root or the operator, mode 0700-style,
 * empty, outside the runs root). Nothing is created or changed.
 */

import fs from "node:fs";
import { expectedContainerHostFiles, validateRunPaths, type RunPaths, type SandboxSpec } from "./spec.js";

export interface HostStat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isSocket(): boolean;
  isFile(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

export interface HostFs {
  lstat(path: string): HostStat;
  realpath(path: string): string;
  readdir(path: string): string[];
}

/** Real filesystem access (target host only; not used by the S1 tests). */
export const nodeHostFs: HostFs = Object.freeze({
  lstat: (p: string) => fs.lstatSync(p),
  realpath: (p: string) => fs.realpathSync.native(p),
  readdir: (p: string) => fs.readdirSync(p),
});

/**
 * The host kernel's /proc/version (trimmed), read by the preflight itself
 * (never supplied by the caller) and compared with the container's by the
 * gVisor evidence check. Returns "" if it can't be read, which refuses.
 */
export function readHostProcVersion(): string {
  try { return fs.readFileSync("/proc/version", "utf8").trim(); } catch { return ""; }
}

/** The only daemon endpoint the engine CLI may use. */
export const DOCKER_SOCKET = "/var/run/docker.sock";
export const DOCKER_HOST = `unix://${DOCKER_SOCKET}`;
const CONFIG_DIR_PATTERN = /^(\/[A-Za-z0-9._-]+)+$/;

export interface EngineTarget {
  /** Must be DOCKER_HOST. */
  readonly host: string;
  /** Operator-prepared, empty client configuration folder (--config). */
  readonly configDir: string;
}

/**
 * Verifies the engine target before any engine call. Returns violations;
 * empty only when the socket and the configuration folder are both safe.
 */
export function verifyEngineTarget(target: unknown, spec: SandboxSpec, hostFs: HostFs, policy: HostPathPolicy): string[] {
  const v = validatePolicy(policy);
  if (typeof target !== "object" || target === null) return [...v, "engine target: not pinned (the engine must use the local socket and an isolated config folder)"];
  const t = target as Record<string, unknown>;
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(t))) {
    if (d.get || d.set) return [...v, `engine target.${key}: getters/setters are not allowed`];
  }
  if (t.host !== DOCKER_HOST) v.push(`engine target: host must be ${DOCKER_HOST}`);
  const dir = t.configDir;
  if (typeof dir !== "string" || !CONFIG_DIR_PATTERN.test(dir) || dir.split("/").some((c) => c === "." || c === "..") ||
      dir === spec.runsRoot || dir.startsWith(`${spec.runsRoot}/`)) {
    v.push("engine target: configDir must be a normalized absolute path outside the runs root");
  }
  if (v.length > 0) return v;
  const trusted = (uid: number) => uid === 0 || uid === policy.operatorUid;
  const stat = (path: string): HostStat | null => {
    try { return hostFs.lstat(path); } catch (err) {
      v.push(`${path}: cannot be checked (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      return null;
    }
  };
  const realDir = (path: string, owner: (uid: number) => boolean, ownerText: string): HostStat | null => {
    const st = stat(path);
    if (!st) return null;
    if (st.isSymbolicLink()) { v.push(`${path}: is a symbolic link`); return null; }
    if (!st.isDirectory()) { v.push(`${path}: is not a directory`); return null; }
    try {
      const real = hostFs.realpath(path);
      if (real !== path) v.push(`${path}: resolves to ${real}`);
    } catch (err) {
      v.push(`${path}: cannot be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (!owner(st.uid)) v.push(`${path}: owned by uid ${st.uid}, not ${ownerText}`);
    if ((st.mode & 0o022) !== 0) v.push(`${path}: writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
    return st;
  };
  const isRoot = (uid: number) => uid === 0;

  // Socket: /, /var as real root-owned directories; /var/run either a real root-owned directory or a root-owned symlink to /run.
  realDir("/", isRoot, "root");
  realDir("/var", isRoot, "root");
  let socketDir = "/var/run";
  const varRun = stat("/var/run");
  if (varRun?.isSymbolicLink()) {
    if (varRun.uid !== 0) v.push(`/var/run: symbolic link owned by uid ${varRun.uid}, not root`);
    try {
      const real = hostFs.realpath("/var/run");
      if (real !== "/run") v.push(`/var/run: must resolve to /run (got ${real})`);
    } catch (err) {
      v.push(`/var/run: cannot be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    socketDir = "/run";
  }
  if (varRun) realDir(socketDir, isRoot, "root");
  const socketPath = `${socketDir}/docker.sock`;
  const sock = stat(socketPath);
  if (sock) {
    if (!sock.isSocket()) v.push(`${socketPath}: is not a socket`);
    if (sock.uid !== 0) v.push(`${socketPath}: owned by uid ${sock.uid}, not root`);
    if ((sock.mode & 0o002) !== 0) v.push(`${socketPath}: writable by others`);
    try {
      const real = hostFs.realpath(DOCKER_SOCKET);
      if (real !== socketPath) v.push(`${DOCKER_SOCKET}: resolves to ${real}, expected ${socketPath}`);
    } catch (err) {
      v.push(`${DOCKER_SOCKET}: cannot be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }

  // Config folder: every ancestor a real directory owned by root or the operator, not group/world-writable; the folder itself private and empty.
  const parts = (dir as string).split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) realDir(`/${parts.slice(0, i).join("/")}`, trusted, "root or the operator");
  const cfg = realDir(dir as string, trusted, "root or the operator");
  if (cfg) {
    if ((cfg.mode & 0o077) !== 0) v.push(`${dir}: must be accessible only by its owner (mode ${(cfg.mode & 0o777).toString(8)})`);
    try {
      if (hostFs.readdir(dir as string).length > 0) v.push(`${dir}: must be empty (no client configuration, contexts or plugins)`);
    } catch (err) {
      v.push(`${dir}: cannot be listed (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
  return v;
}

export interface HostPathPolicy {
  /** Host uid of the operator who prepares runs (may own ancestors and in/). */
  readonly operatorUid: number;
  /** Host uid that must own out/ (the uid the sandbox user maps to on the host). */
  readonly outputOwnerUid: number;
}

export interface DirectoryIdentity {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}

export interface HostPathCheck {
  readonly violations: readonly string[];
  readonly identities: readonly DirectoryIdentity[];
}

export function validatePolicy(policy: unknown): string[] {
  if (typeof policy !== "object" || policy === null) return ["hostPolicy: must be an object"];
  const p = policy as Record<string, unknown>;
  const v: string[] = [];
  for (const key of ["operatorUid", "outputOwnerUid"]) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (!d || d.get || d.set || typeof d.value !== "number" || !Number.isSafeInteger(d.value) || d.value < 0) v.push(`hostPolicy.${key}: must be a non-negative integer`);
  }
  if (p.outputOwnerUid === 0) v.push("hostPolicy.outputOwnerUid: out/ must not be owned by root");
  return v;
}

export function verifyRunDirectories(run: RunPaths, spec: SandboxSpec, hostFs: HostFs, policy: HostPathPolicy): HostPathCheck {
  const violations = [...validateRunPaths(run, spec), ...validatePolicy(policy)];
  if (violations.length > 0) return { violations, identities: [] };
  const runDir = run.inputDir.slice(0, -"/in".length);
  const ancestors: string[] = ["/"];
  for (const segment of runDir.split("/").filter(Boolean)) ancestors.push(`${ancestors.length === 1 ? "" : ancestors[ancestors.length - 1]}/${segment}`);
  const trusted = (uid: number) => uid === 0 || uid === policy.operatorUid;
  const identities: DirectoryIdentity[] = [];

  const inspectDir = (path: string): HostStat | null => {
    let st: HostStat;
    try {
      st = hostFs.lstat(path);
    } catch (err) {
      violations.push(`${path}: cannot be checked (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      return null;
    }
    if (st.isSymbolicLink()) { violations.push(`${path}: is a symbolic link`); return null; }
    if (!st.isDirectory()) { violations.push(`${path}: is not a directory`); return null; }
    try {
      const real = hostFs.realpath(path);
      if (real !== path) violations.push(`${path}: resolves to ${real}`);
    } catch (err) {
      violations.push(`${path}: cannot be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    return st;
  };

  for (const dir of ancestors) {
    const st = inspectDir(dir);
    if (!st) continue;
    if (!trusted(st.uid)) violations.push(`${dir}: owned by uid ${st.uid}, not root or the operator`);
    if ((st.mode & 0o022) !== 0) violations.push(`${dir}: writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
  }

  const inSt = inspectDir(run.inputDir);
  if (inSt) {
    if (!trusted(inSt.uid)) violations.push(`${run.inputDir}: owned by uid ${inSt.uid}, not root or the operator`);
    if ((inSt.mode & 0o022) !== 0) violations.push(`${run.inputDir}: writable by group or others`);
    identities.push({ path: run.inputDir, dev: String(inSt.dev), ino: String(inSt.ino) });
  }
  const outSt = inspectDir(run.outputDir);
  if (outSt) {
    if (outSt.uid !== policy.outputOwnerUid) violations.push(`${run.outputDir}: must be owned by uid ${policy.outputOwnerUid} (got ${outSt.uid})`);
    if ((outSt.mode & 0o077) !== 0) violations.push(`${run.outputDir}: must be accessible only by its owner (mode ${(outSt.mode & 0o777).toString(8)})`);
    try {
      if (hostFs.readdir(run.outputDir).length > 0) violations.push(`${run.outputDir}: must be empty (dedicated to this run)`);
    } catch (err) {
      violations.push(`${run.outputDir}: cannot be listed (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    identities.push({ path: run.outputDir, dev: String(outSt.dev), ino: String(outSt.ino) });
  }
  if (inSt && outSt && String(inSt.dev) === String(outSt.dev) && String(inSt.ino) === String(outSt.ino)) {
    violations.push("in/ and out/ are the same directory");
  }
  return { violations, identities: violations.length > 0 ? [] : identities };
}

/** True if the folders still have the identities recorded before the container was created. */
export function sameIdentities(before: readonly DirectoryIdentity[], after: readonly DirectoryIdentity[]): boolean {
  return before.length === 2 && after.length === 2 &&
    before.every((b, i) => b.path === after[i].path && b.dev === after[i].dev && b.ino === after[i].ino);
}

/**
 * Host-side check of the files Docker bind-mounts into the container at
 * /etc/hosts, /etc/hostname and /etc/resolv.conf: they must be exactly
 * <dockerDataRoot>/containers/<id>/{hosts,hostname,resolv.conf}, every
 * directory from "/" down a real root-owned directory not writable by group
 * or others, and each file a regular root-owned file (never a symlink) not
 * writable by group or others. This detects misconfiguration; it cannot
 * prove what a dishonest daemon actually mounted (D1/M3 trust root).
 */
export function verifyContainerHostFiles(spec: SandboxSpec, containerId: string, hostFs: HostFs): string[] {
  const expected = expectedContainerHostFiles(spec, containerId);
  if (expected === null) return ["container host files: dockerDataRoot is not recorded (approved host setup step), so /etc/hosts, /etc/hostname and /etc/resolv.conf can't be verified"];
  const v: string[] = [];
  const check = (path: string, kind: "dir" | "file") => {
    let st: HostStat;
    try { st = hostFs.lstat(path); } catch (err) {
      v.push(`${path}: cannot be checked (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      return;
    }
    if (st.isSymbolicLink()) { v.push(`${path}: is a symbolic link`); return; }
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) { v.push(`${path}: is not a ${kind === "dir" ? "directory" : "regular file"}`); return; }
    try {
      const real = hostFs.realpath(path);
      if (real !== path) v.push(`${path}: resolves to ${real}`);
    } catch (err) {
      v.push(`${path}: cannot be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (st.uid !== 0) v.push(`${path}: owned by uid ${st.uid}, not root`);
    if ((st.mode & 0o022) !== 0) v.push(`${path}: writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
  };
  const dir = expected.HostsPath.slice(0, -"/hosts".length);
  const parts = dir.split("/").filter(Boolean);
  check("/", "dir");
  for (let i = 1; i <= parts.length; i++) check(`/${parts.slice(0, i).join("/")}`, "dir");
  for (const file of Object.values(expected)) check(file, "file");
  return v;
}
