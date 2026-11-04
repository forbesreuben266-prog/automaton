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

import { createHash } from "node:crypto";
import fs from "node:fs";
import { GVISOR_SIDECAR_DIR, expectedContainerHostFiles, validateRunPaths, type RunPaths, type SandboxSpec } from "./spec.js";
import type { EngineInfo } from "./engine.js";

export interface HostStat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isSocket(): boolean;
  isFile(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/** Result of hashing a file through a no-follow descriptor (identity of the inode actually read). */
export interface FileDigest {
  readonly sha256: string;
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
}

export interface HostFs {
  lstat(path: string): HostStat;
  realpath(path: string): string;
  readdir(path: string): string[];
  /** SHA-256 of a regular file opened with O_NOFOLLOW|O_NONBLOCK (a symlink fails; a FIFO can't block); refuses non-regular files and files larger than maxBytes. */
  sha256File(path: string, maxBytes: number): FileDigest;
}

/** Real filesystem access (target host only; not used by the S1 tests). */
export const nodeHostFs: HostFs = Object.freeze({
  lstat: (p: string) => fs.lstatSync(p),
  realpath: (p: string) => fs.realpathSync.native(p),
  readdir: (p: string) => fs.readdirSync(p),
  sha256File: (p: string, maxBytes: number): FileDigest => {
    // O_NOFOLLOW: a symlink at the final component fails (ELOOP) instead of being followed.
    // O_NONBLOCK: a FIFO opens immediately (and is then refused as not a regular file) instead of blocking forever.
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw Object.assign(new Error(`${p}: not a regular file`), { code: "EINVAL" });
      if (st.size > maxBytes) throw Object.assign(new Error(`${p}: larger than ${maxBytes} bytes`), { code: "EFBIG" });
      const hash = createHash("sha256");
      const buf = Buffer.alloc(1024 * 1024);
      let total = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        total += n;
        if (total > maxBytes) throw Object.assign(new Error(`${p}: grew beyond ${maxBytes} bytes while reading`), { code: "EFBIG" });
        hash.update(buf.subarray(0, n));
      }
      return { sha256: hash.digest("hex"), dev: String(st.dev), ino: String(st.ino), size: total };
    } finally {
      fs.closeSync(fd);
    }
  },
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
 * With `files: "pending"` (V2.2: Docker 29 writes them only when the container
 * starts) the directories are checked and the three files must NOT exist yet
 * (anything but ENOENT refuses); the caller verifies them after the start.
 */
export function verifyContainerHostFiles(spec: SandboxSpec, containerId: string, hostFs: HostFs, files: "present" | "pending" = "present"): string[] {
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
  for (const file of Object.values(expected)) {
    if (files === "present") { check(file, "file"); continue; }
    try {
      hostFs.lstat(file);
      v.push(`${file}: already exists before the container's first start (Docker had not reported it; refusing)`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") v.push(`${file}: cannot be checked (${code ?? "error"})`);
    }
  }
  return v;
}

/** Upper bound for hashing the runtime binary (runsc is tens of MiB). */
export const RUNTIME_BINARY_MAX_BYTES = 256 * 1024 * 1024;
const RUNTIME_CONFIG_KEYS = new Set(["path", "runtimeArgs", "status"]);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The daemon-reported configuration of an isolating runtime must be exactly
 * the classic form for the recorded binary: { path: <recorded path> }, with
 * runtimeArgs absent or an empty array, and status (if reported) an object
 * of string values. Anything missing, malformed or extra refuses: a
 * runtimeType/shim form or options would run something other than the
 * checked binary, and no runsc flag is approved. Returns violations.
 */
export function runtimeConfigProblems(info: EngineInfo, runtime: string, spec: SandboxSpec): string[] {
  const approved = spec.runscBinary;
  if (approved === null) return ["runtime binary: no approved runsc binary (path, SHA-256) has been recorded (approved host setup step)"];
  const config = info?.runtimeConfigs?.[runtime];
  if (!isPlainObject(config)) return [`runtime binary: docker info reports no configuration for runtime "${runtime}"`];
  const v: string[] = [];
  const unknown = Object.keys(config).filter((k) => !RUNTIME_CONFIG_KEYS.has(k));
  if (unknown.length > 0) v.push(`runtime binary: unsupported runtime configuration key(s) ${unknown.slice(0, 3).join(", ")} (only path, an empty runtimeArgs and status are verifiable)`);
  if (config.path !== approved.path) v.push(`runtime binary: docker info must configure ${runtime} with path ${approved.path} (got ${JSON.stringify(config.path)?.slice(0, 80)})`);
  if (config.runtimeArgs !== undefined && !(Array.isArray(config.runtimeArgs) && config.runtimeArgs.length === 0)) {
    v.push("runtime binary: runtimeArgs must be absent or empty (no runsc runtime flags are approved)");
  }
  if (config.status !== undefined && !(isPlainObject(config.status) && Object.values(config.status).every((x) => typeof x === "string"))) {
    v.push("runtime binary: status, when reported, must be an object of string values");
  }
  return v;
}

/** Canonical text of a runtime's reported configuration (sorted keys), for change detection; null if missing or not an object. */
export function canonicalRuntimeConfig(info: EngineInfo, runtime: string): string | null {
  const config = info?.runtimeConfigs?.[runtime];
  if (!isPlainObject(config)) return null;
  const canon = (x: unknown): unknown => (Array.isArray(x) ? x.map(canon) : isPlainObject(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
  return JSON.stringify(canon(config));
}

/** One verified file: enough to detect replacement or modification later. */
export interface RuntimeFileIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/** What was verified: the runsc binary, every recorded sidecar file, and the exact contents of its gvisor-bin folder. */
export interface RuntimeBinaryIdentity extends RuntimeFileIdentity {
  readonly sidecars: readonly RuntimeFileIdentity[];
  /** Every entry found under <runsc folder>/gvisor-bin (sorted; empty when the folder doesn't exist). */
  readonly sidecarListing: readonly string[];
}

export interface RuntimeBinaryCheck {
  readonly violations: readonly string[];
  readonly identity: RuntimeBinaryIdentity | null;
}

/** Most entries walked under the gvisor-bin folder (bounded; more refuses). */
export const MAX_SIDECAR_ENTRIES = 256;

/**
 * M1 host-side check of an isolating runtime (fakes-only so far; not yet run
 * on a real host). Fails closed on anything missing or different:
 * 1. the approved binary (path, SHA-256, sidecars; runtime args must be
 *    empty) must be recorded;
 * 2. `docker info` must configure the runtime exactly as runtimeConfigProblems
 *    requires (classic { path } form for that path, no runtime flags);
 * 3. "/" and every directory down to each checked file: real directories
 *    (never symlinks), resolving to themselves, root-owned, not
 *    group/world-writable, so only root can replace the file;
 * 4. each file: a regular root-owned file (never a symlink), not
 *    group/world-writable, no setuid/setgid bit, resolving to itself; runsc
 *    must also be executable;
 * 5. its SHA-256, read through an O_NOFOLLOW|O_NONBLOCK descriptor (a FIFO
 *    swapped in can't block the open), equals the recorded value, and the
 *    descriptor's inode is the one lstat saw;
 * 6. lstat after hashing shows the same inode, size, mtime and ctime;
 * 7. (V2) every recorded sidecar file passes 3-6 against its own recorded
 *    SHA-256, and the gvisor-bin folder next to runsc (when it exists)
 *    contains exactly the recorded sidecars under it: an unrecorded file,
 *    a symlink or any other entry refuses, as does a recorded sidecar that
 *    is missing.
 * Limits: the daemon starts the runtime by path later (time-of-check/time-of-
 * use; only root can swap files under rule 3, and the preflight re-checks
 * them after the canary); `docker info` is the daemon's own report, so a
 * dishonest daemon can still run something else; files outside the runsc
 * package that gVisor or the daemon may load (shared libraries, the
 * containerd shim) are not covered; and matching hashes identify files, they
 * don't prove the runtime isolates. These are why meets-spec stays blocked.
 */
export function verifyRuntimeBinary(info: EngineInfo, runtime: string, spec: SandboxSpec, hostFs: HostFs): RuntimeBinaryCheck {
  const configProblems = runtimeConfigProblems(info, runtime, spec);
  if (configProblems.length > 0) return { violations: configProblems, identity: null };
  const approved = spec.runscBinary!;
  const v: string[] = [];

  const stat = (path: string): HostStat | null => {
    try { return hostFs.lstat(path); } catch (err) {
      v.push(`${path}: cannot be checked (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      return null;
    }
  };
  const resolvesToItself = (path: string) => {
    try {
      const real = hostFs.realpath(path);
      if (real !== path) v.push(`${path}: resolves to ${real}`);
    } catch (err) {
      v.push(`${path}: cannot be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
  };
  const checkedDirs = new Set<string>();
  const checkDir = (dir: string): boolean => {
    if (checkedDirs.has(dir)) return true;
    checkedDirs.add(dir);
    const before = v.length;
    const st = stat(dir);
    if (!st) return false;
    if (st.isSymbolicLink()) { v.push(`${dir}: is a symbolic link`); return false; }
    if (!st.isDirectory()) { v.push(`${dir}: is not a directory`); return false; }
    resolvesToItself(dir);
    if (st.uid !== 0) v.push(`${dir}: owned by uid ${st.uid}, not root`);
    if ((st.mode & 0o022) !== 0) v.push(`${dir}: writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
    return v.length === before;
  };
  /** Rules 3-6 for one file; returns its identity or null (violations added). */
  const checkFile = (path: string, expectedSha: string, requireExecutable: boolean): RuntimeFileIdentity | null => {
    const start = v.length;
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) checkDir(i === 0 ? "/" : `/${parts.slice(0, i).join("/")}`);
    const before = stat(path);
    if (!before) return null;
    if (before.isSymbolicLink()) v.push(`${path}: is a symbolic link`);
    else if (!before.isFile()) v.push(`${path}: is not a regular file`);
    else {
      resolvesToItself(path);
      if (before.uid !== 0) v.push(`${path}: owned by uid ${before.uid}, not root`);
      if ((before.mode & 0o022) !== 0) v.push(`${path}: writable by group or others (mode ${(before.mode & 0o777).toString(8)})`);
      if (requireExecutable && (before.mode & 0o111) === 0) v.push(`${path}: is not executable`);
      if ((before.mode & 0o6000) !== 0) v.push(`${path}: has a setuid or setgid bit`);
    }
    if (v.length > start) return null;
    let digest: FileDigest;
    try {
      digest = hostFs.sha256File(path, RUNTIME_BINARY_MAX_BYTES);
    } catch (err) {
      v.push(`${path}: cannot be hashed (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      return null;
    }
    if (digest.dev !== String(before.dev) || digest.ino !== String(before.ino) || digest.size !== before.size) {
      v.push(`${path}: the file hashed is not the file checked (replaced during verification)`);
    }
    if (digest.sha256 !== expectedSha) v.push(`${path}: SHA-256 does not match the recorded approved file`);
    const after = stat(path);
    if (after && (String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino) || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.isSymbolicLink())) {
      v.push(`${path}: changed while it was being verified`);
    }
    if (v.length > start) return null;
    return Object.freeze({ path, sha256: digest.sha256, dev: digest.dev, ino: digest.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
  };

  const main = checkFile(approved.path, approved.sha256, true);
  const sidecars = approved.sidecars.map((sc) => checkFile(sc.path, sc.sha256, false));

  // Completeness of the gvisor-bin folder next to runsc: exactly the recorded sidecars under it, nothing else.
  const sidecarDir = `${approved.path.slice(0, approved.path.lastIndexOf("/"))}/${GVISOR_SIDECAR_DIR}`;
  const listing: string[] = [];
  let dirExists = true;
  try { hostFs.lstat(sidecarDir); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") dirExists = false;
    else v.push(`${sidecarDir}: cannot be checked (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const recordedUnder = new Set(approved.sidecars.map((sc) => sc.path).filter((p) => p.startsWith(`${sidecarDir}/`)));
  if (dirExists && checkDir(sidecarDir)) {
    const walk = (dir: string, depth: number) => {
      let names: string[];
      try { names = hostFs.readdir(dir); } catch (err) { v.push(`${dir}: cannot be listed (${(err as NodeJS.ErrnoException).code ?? "error"})`); return; }
      for (const name of [...names].sort()) {
        const full = `${dir}/${name}`;
        listing.push(full);
        if (listing.length > MAX_SIDECAR_ENTRIES) { v.push(`${sidecarDir}: more than ${MAX_SIDECAR_ENTRIES} entries`); return; }
        let st: HostStat;
        try { st = hostFs.lstat(full); } catch (err) { v.push(`${full}: cannot be checked (${(err as NodeJS.ErrnoException).code ?? "error"})`); continue; }
        if (st.isDirectory() && !st.isSymbolicLink()) {
          if (depth >= 3) { v.push(`${full}: nested deeper than the recorded sidecars allow`); continue; }
          if (checkDir(full)) walk(full, depth + 1);
        } else if (!recordedUnder.has(full)) {
          v.push(`${full}: is in ${sidecarDir} but is not a recorded sidecar file (every file runsc may execute must be recorded)`);
        }
      }
    };
    walk(sidecarDir, 0);
  } else if (!dirExists && recordedUnder.size > 0) {
    v.push(`${sidecarDir}: does not exist, but sidecar files are recorded in it`);
  }
  if (v.length > 0 || main === null || sidecars.some((x) => x === null)) {
    return { violations: v.length > 0 ? v : ["runtime binary: verification incomplete"], identity: null };
  }
  return {
    violations: [],
    identity: Object.freeze({ ...main, sidecars: Object.freeze(sidecars as RuntimeFileIdentity[]), sidecarListing: Object.freeze(listing) }),
  };
}

const sameFile = (a: RuntimeFileIdentity, b: RuntimeFileIdentity): boolean =>
  a.path === b.path && a.sha256 === b.sha256 && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** True if a later verification found exactly the same files (runsc and every sidecar: path, hash, inode, size, times) and the same gvisor-bin listing. */
export function sameRuntimeBinary(a: RuntimeBinaryIdentity, b: RuntimeBinaryIdentity): boolean {
  return sameFile(a, b) && a.sidecars.length === b.sidecars.length && a.sidecars.every((x, i) => sameFile(x, b.sidecars[i])) &&
    a.sidecarListing.length === b.sidecarListing.length && a.sidecarListing.every((x, i) => x === b.sidecarListing[i]);
}
