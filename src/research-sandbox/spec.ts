/**
 * Research sandbox specification (Phase 1, stage S1).
 *
 * The OS-level isolation every untrusted-input run must have. Values are
 * frozen; a run may only TIGHTEN them (lower limits). Nothing here starts a
 * container: buildCreateArgs returns an argv array for the engine adapter.
 *
 * Decisions encoded: D1 (dedicated host; software can't verify host trust),
 * D2 (gVisor or rootless Podman required for untrusted input; a rootful
 * runc/crun container is development-only), D3 (image pinned by digest; the
 * digest is recorded only after a separately approved pull — until then
 * every preflight refuses; `create` runs with --pull never, so a preflight
 * can never download an image).
 */

import { createHash } from "node:crypto";

const MiB = 1024 * 1024;

export interface ImageSpec {
  readonly repository: string;
  readonly tag: string;
  /** sha256 digest, pinned at an approved pull; null = not pinned yet (preflight refuses). */
  readonly digest: string | null;
  /**
   * The image's ENTRYPOINT, recorded at the same approved pull (it runs before
   * our command). null = not pinned yet (preflight refuses).
   */
  readonly entrypoint: readonly string[] | null;
  /**
   * The image's own environment ("NAME=value" entries, names from
   * imageEnvAllowlist), recorded at the same approved pull. null = not
   * recorded yet: the exact environment can't be checked, so preflight refuses.
   */
  readonly env: readonly string[] | null;
  /**
   * The platform manifest digest Docker reports in ImageManifestDescriptor
   * (containerd image store), recorded at the same approved pull. null = not
   * recorded: a container that reports a descriptor is refused.
   */
  readonly manifestDigest: string | null;
  /**
   * V1B: the exact Docker image ID ("sha256:<64 hex>") of the locally built
   * canary image (FROM the pinned base digest above), recorded at the
   * separately approved build step. Containers are created from this ID (an
   * immutable, content-addressed identifier; never a tag), and inspect
   * requires both the requested reference (Config.Image) and the image the
   * created container actually uses (top-level Image) to equal it. It must
   * differ from the base digest. null = not recorded: preflight refuses.
   */
  readonly id: string | null;
  /**
   * V2 (Option B): the platform manifest digest Docker reports in
   * ImageManifestDescriptor for a container created from the canary image
   * itself (containerd image store), recorded at the separately approved
   * canary build. A container that reports a descriptor must carry exactly
   * this digest. It must differ from the base image's manifestDigest (the
   * canary is a different image). null = not recorded: a reported descriptor
   * refuses. When it IS recorded, a container that reports NO descriptor
   * also refuses (contradictory information).
   */
  readonly canaryManifestDigest: string | null;
}

export interface SandboxSpec {
  readonly image: ImageSpec;
  /** Runtimes acceptable for untrusted input (gVisor). */
  readonly isolatingRuntimes: readonly string[];
  /** Runtimes allowed only for disposable development tests with fixtures (shared host kernel). */
  readonly developmentRuntimes: readonly string[];
  readonly user: string;
  readonly network: "none";
  readonly readOnlyRootfs: true;
  readonly ipcMode: "none";
  readonly memoryBytes: number;
  /** Equal to memoryBytes: no swap. */
  readonly memorySwapBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly ulimits: Readonly<Record<"fsize" | "nofile" | "core", number>>;
  readonly tmpfsBytes: number;
  /** Environment variables we set; the image may add only imageEnvAllowlist names. */
  readonly envAllowlist: readonly string[];
  /** Variables the base image itself defines (no values are trusted from them). */
  readonly imageEnvAllowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxInputFileBytes: number;
  readonly maxInputTotalBytes: number;
  readonly mountPoints: Readonly<{ input: "/in"; output: "/out"; tmp: "/tmp" }>;
  /**
   * The only host directory under which run folders may exist. A run's
   * folders must be exactly <runsRoot>/<runId>/in and <runsRoot>/<runId>/out.
   */
  readonly runsRoot: string;
  /**
   * The seccomp profile the Docker daemon must report in `docker info`
   * SecurityOptions ("name=seccomp,profile=<value>"). Only Docker's built-in
   * default profile is accepted; a custom daemon profile, "unconfined" or an
   * unreported profile refuses.
   */
  readonly seccompProfile: "builtin";
  /**
   * Exact /proc/version text seen inside a gVisor sandbox on the target host,
   * recorded at a separately approved host setup (gVisor reports its own
   * emulated kernel, not the host's). null = not recorded yet: gVisor cannot
   * be verified, so nothing is rated meets-spec.
   */
  readonly gvisorProcVersion: string | null;
  /**
   * The Docker daemon's data directory on the target host (where it keeps
   * each container's hosts/hostname/resolv.conf), recorded at an approved
   * host setup. null = not recorded: those host files can't be verified, so
   * preflight refuses.
   */
  readonly dockerDataRoot: string | null;
  /** Fixed container hostname set by the create argv (so Config.Hostname has a known value). */
  readonly hostname: "sandbox";
  /**
   * The approved gVisor runtime binary on the target host, recorded at a
   * separately approved host setup: absolute path, SHA-256 of its contents
   * and its runtime arguments, which must be EMPTY: no runsc flag has been
   * reviewed and approved, so any configured flag refuses. null =
   * not recorded: an isolating runtime can't be verified on the host, so
   * preflight refuses. A matching hash identifies the file; it does not by
   * itself prove isolation (see host-paths.ts verifyRuntimeBinary).
   */
  readonly runscBinary: RuntimeBinary | null;
  /**
   * The Docker SERVER (daemon) version approved for the target host, exactly
   * as the daemon reports it in `docker info` (ServerVersion), recorded at a
   * separately approved host setup. The inspect and info formats this code
   * checks are version-specific, so any other version refuses. The client
   * version is never used as evidence. null = not recorded: preflight
   * refuses. No version is chosen here.
   */
  readonly dockerServerVersion: string | null;
}

export interface RuntimeBinary {
  readonly path: string;
  readonly sha256: string;
  readonly args: readonly string[];
  /**
   * V2 (M1): every other file of the gVisor package that runsc may execute
   * or read, recorded at the approved host setup with its SHA-256 (since
   * 2026-07 gVisor ships sidecar binaries in a gvisor-bin/ folder next to
   * runsc). Each path is inside <runsc folder>/gvisor-bin/, directly in a
   * RUNTIME_BINARY_DIRS folder, or (V2.1) a *.toml file directly in
   * RUNTIME_CONFIG_DIR (the package's /etc/containerd/runsc.toml). Required (may be empty only for a single-binary release); the
   * preflight also refuses any unrecorded file in that gvisor-bin/ folder.
   */
  readonly sidecars: readonly RuntimeSidecar[];
}

export interface RuntimeSidecar {
  readonly path: string;
  readonly sha256: string;
}

/** Name of gVisor's sidecar folder, next to the runsc binary. */
export const GVISOR_SIDECAR_DIR = "gvisor-bin";
export const MAX_RUNTIME_SIDECARS = 64;

export const SANDBOX_SPEC: SandboxSpec = Object.freeze({
  image: Object.freeze({ repository: "docker.io/library/node", tag: "22.22.0-bookworm-slim", digest: null, entrypoint: null, env: null, manifestDigest: null, id: null, canaryManifestDigest: null }),
  isolatingRuntimes: Object.freeze(["runsc"]),
  developmentRuntimes: Object.freeze(["runc", "crun"]),
  user: "10001:10001",
  network: "none",
  readOnlyRootfs: true,
  ipcMode: "none",
  memoryBytes: 512 * MiB,
  memorySwapBytes: 512 * MiB,
  nanoCpus: 500_000_000,
  pidsLimit: 64,
  ulimits: Object.freeze({ fsize: 50 * MiB, nofile: 256, core: 0 }),
  tmpfsBytes: 64 * MiB,
  envAllowlist: Object.freeze(["NODE_ENV", "RESEARCH_RUN_ID"]),
  imageEnvAllowlist: Object.freeze(["PATH", "NODE_VERSION", "YARN_VERSION"]),
  timeoutMs: 300_000,
  maxOutputBytes: 20 * MiB,
  maxInputFileBytes: 50 * MiB,
  maxInputTotalBytes: 200 * MiB,
  mountPoints: Object.freeze({ input: "/in", output: "/out", tmp: "/tmp" }),
  runsRoot: "/srv/research-runs",
  seccompProfile: "builtin",
  gvisorProcVersion: null,
  dockerDataRoot: null,
  hostname: "sandbox",
  runscBinary: null,
  dockerServerVersion: null,
}) as SandboxSpec;

/** The exact environment a container must have: the recorded image environment plus ours. null if the image's isn't recorded. */
export function expectedEnv(spec: SandboxSpec, run: RunPaths): string[] | null {
  if (spec.image.env === null) return null;
  return [...spec.image.env, "NODE_ENV=production", `RESEARCH_RUN_ID=${run.runId}`];
}

/** Expected host paths of the files Docker bind-mounts at /etc/hosts, /etc/hostname, /etc/resolv.conf. null if the data root isn't recorded. */
export function expectedContainerHostFiles(spec: SandboxSpec, containerId: string): Record<"HostsPath" | "HostnamePath" | "ResolvConfPath", string> | null {
  if (spec.dockerDataRoot === null || !/^[0-9a-f]{64}$/.test(containerId)) return null;
  const dir = `${spec.dockerDataRoot}/containers/${containerId}`;
  return { HostsPath: `${dir}/hosts`, HostnamePath: `${dir}/hostname`, ResolvConfPath: `${dir}/resolv.conf` };
}

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class SandboxSpecError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`Sandbox specification refused:\n- ${violations.join("\n- ")}`);
    this.name = "SandboxSpecError";
  }
}

const NUMERIC_LIMITS = ["memoryBytes", "nanoCpus", "pidsLimit", "tmpfsBytes", "timeoutMs", "maxOutputBytes", "maxInputFileBytes", "maxInputTotalBytes"] as const;
export type SpecOverrides = Partial<Record<(typeof NUMERIC_LIMITS)[number], number>> & {
  readonly imageDigest?: string;
  readonly imageEntrypoint?: readonly string[];
  readonly gvisorProcVersion?: string;
  readonly imageEnv?: readonly string[];
  readonly imageManifestDigest?: string;
  readonly dockerDataRoot?: string;
  readonly runscBinary?: RuntimeBinary;
  readonly dockerServerVersion?: string;
  readonly imageId?: string;
  readonly canaryManifestDigest?: string;
};
const PIN_KEYS = ["imageDigest", "imageEntrypoint", "gvisorProcVersion", "imageEnv", "imageManifestDigest", "dockerDataRoot", "runscBinary", "dockerServerVersion", "imageId", "canaryManifestDigest"];
/** A Docker server version as `docker info` reports it: MAJOR.MINOR.PATCH, optionally with a short pre-release/build suffix. */
export const DOCKER_SERVER_VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]{0,63})?$/;
/** Root-owned system directories the approved runtime binary may live in. */
export const RUNTIME_BINARY_DIRS = Object.freeze(["/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin"]);
/**
 * The one configuration folder a recorded runsc package file may live in
 * (V2.1): the gVisor package ships /etc/containerd/runsc.toml (a dpkg
 * conffile configuring the containerd runsc shim). It is pinned by SHA-256
 * like every other recorded file, never ignored. Only plain *.toml names
 * directly inside it are accepted.
 */
export const RUNTIME_CONFIG_DIR = "/etc/containerd";
const RUNTIME_CONFIG_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,58}\.toml$/;
/** A binary file name: no dot-only or hidden names (".", "..", "...", ".x"). */
const RUNTIME_BINARY_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const ENV_ENTRY = /^([A-Za-z_][A-Za-z0-9_]*)=([\x20-\x7e]*)$/;

/**
 * Validates the recorded sidecar list of a runsc binary at `runscPath`;
 * returns it (sorted by path, frozen) or null after adding violations.
 */
function readSidecars(raw: unknown, runscPath: string, violations: string[]): readonly RuntimeSidecar[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_RUNTIME_SIDECARS) {
    violations.push(`runscBinary.sidecars: must be an array of at most ${MAX_RUNTIME_SIDECARS} { path, sha256 } entries`);
    return null;
  }
  const sidecarRoot = `${runscPath.slice(0, runscPath.lastIndexOf("/"))}/${GVISOR_SIDECAR_DIR}/`;
  const out: RuntimeSidecar[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown>;
    const plain = typeof e === "object" && e !== null && !Array.isArray(e) && Object.keys(e).length === 2 &&
      ["path", "sha256"].every((k) => Object.prototype.hasOwnProperty.call(e, k)) &&
      Object.values(Object.getOwnPropertyDescriptors(e)).every((d) => !d.get && !d.set);
    if (!plain) { violations.push(`runscBinary.sidecars[${i}]: must be { path, sha256 } with plain values`); return null; }
    const p = e.path;
    const inSidecarDir = typeof p === "string" && p.startsWith(sidecarRoot) &&
      p.slice(sidecarRoot.length).split("/").every((c) => RUNTIME_BINARY_NAME.test(c)) && p.slice(sidecarRoot.length).split("/").length <= 4;
    const inBinaryDir = typeof p === "string" && RUNTIME_BINARY_DIRS.some((d) => p.startsWith(`${d}/`) && RUNTIME_BINARY_NAME.test(p.slice(d.length + 1)));
    const inConfigDir = typeof p === "string" && p.startsWith(`${RUNTIME_CONFIG_DIR}/`) && RUNTIME_CONFIG_NAME.test(p.slice(RUNTIME_CONFIG_DIR.length + 1));
    if (typeof p !== "string" || !(inSidecarDir || inBinaryDir || inConfigDir) || p === runscPath) {
      violations.push(`runscBinary.sidecars[${i}].path: must be inside ${sidecarRoot} (at most 4 levels, plain names), directly inside ${RUNTIME_BINARY_DIRS.join(", ")}, or a plain *.toml file directly inside ${RUNTIME_CONFIG_DIR}, and not the runsc binary itself`);
      return null;
    }
    if (seen.has(p)) { violations.push(`runscBinary.sidecars[${i}].path: listed twice`); return null; }
    seen.add(p);
    if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256)) { violations.push(`runscBinary.sidecars[${i}].sha256: must be 64 lowercase hex characters`); return null; }
    out.push(Object.freeze({ path: p, sha256: e.sha256 }));
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Object.freeze(out);
}

/**
 * Returns the effective spec. Overrides may only lower numeric limits (and
 * memory swap follows memory, so swap stays off) or set the pinned digest,
 * entrypoint and gVisor /proc/version reference.
 * Any other key, any increase and any non-positive value is refused.
 */
export function resolveSpec(overrides: unknown = {}, base: SandboxSpec = SANDBOX_SPEC): SandboxSpec {
  const violations: string[] = [];
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides) ||
      Object.getPrototypeOf(overrides) !== Object.getPrototypeOf({})) {
    throw new SandboxSpecError(["overrides must be a plain object"]);
  }
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const values: Record<string, unknown> = {};
  for (const [key, d] of Object.entries(descriptors)) {
    if (d.get || d.set) { violations.push(`${key}: getters/setters are not allowed`); continue; }
    if (!PIN_KEYS.includes(key) && !(NUMERIC_LIMITS as readonly string[]).includes(key)) {
      violations.push(`${key}: cannot be overridden (only lowering ${NUMERIC_LIMITS.join(", ")} or pinning ${PIN_KEYS.join("/")} is allowed)`);
      continue;
    }
    values[key] = d.value;
  }
  const next: Record<string, unknown> = { ...base };
  for (const key of NUMERIC_LIMITS) {
    if (!(key in values)) continue;
    const v = values[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) violations.push(`${key}: must be a positive integer`);
    else if (v > base[key]) violations.push(`${key}: ${v} would loosen the limit of ${base[key]}`);
    else next[key] = v;
  }
  if (typeof next.memoryBytes === "number") next.memorySwapBytes = next.memoryBytes;
  if ("imageDigest" in values) {
    const d = values.imageDigest;
    if (typeof d !== "string" || !DIGEST_PATTERN.test(d)) violations.push("imageDigest: must be sha256:<64 lowercase hex>");
    else if (base.image.digest !== null && base.image.digest !== d) violations.push("imageDigest: differs from the already pinned digest");
    else next.image = Object.freeze({ ...(next.image as ImageSpec), digest: d });
  }
  if ("imageEntrypoint" in values) {
    const ep = values.imageEntrypoint;
    if (!Array.isArray(ep) || ep.length > 8 || ep.some((x) => typeof x !== "string" || x.length === 0 || x.length > 256 || x.includes("\0"))) {
      violations.push("imageEntrypoint: must be an array of at most 8 non-empty strings");
    } else if (base.image.entrypoint !== null && JSON.stringify(base.image.entrypoint) !== JSON.stringify(ep)) {
      violations.push("imageEntrypoint: differs from the already pinned entrypoint");
    } else {
      next.image = Object.freeze({ ...(next.image as ImageSpec), entrypoint: Object.freeze([...ep]) });
    }
  }
  if ("gvisorProcVersion" in values) {
    const pv = values.gvisorProcVersion;
    // At most 512 characters in total, the same limit the gVisor evidence check applies to observed values (canary.ts PROC_VERSION_MAX).
    if (typeof pv !== "string" || !/^Linux version [\x20-\x7e]{1,498}$/.test(pv)) {
      violations.push("gvisorProcVersion: must be the printable /proc/version text starting \"Linux version \" (at most 512 characters)");
    } else if (base.gvisorProcVersion !== null && base.gvisorProcVersion !== pv) {
      violations.push("gvisorProcVersion: differs from the already recorded value");
    } else {
      next.gvisorProcVersion = pv;
    }
  }
  if ("imageEnv" in values) {
    const env = values.imageEnv;
    const names = Array.isArray(env) ? env.map((e) => (typeof e === "string" ? ENV_ENTRY.exec(e)?.[1] : undefined)) : [];
    if (!Array.isArray(env) || env.length > 32 || names.some((n) => n === undefined || !base.imageEnvAllowlist.includes(n))) {
      violations.push(`imageEnv: must be printable NAME=value entries with names from ${base.imageEnvAllowlist.join(", ")}`);
    } else if (new Set(names).size !== names.length) {
      violations.push("imageEnv: duplicate names");
    } else if (base.image.env !== null && JSON.stringify([...base.image.env].sort()) !== JSON.stringify([...env].sort())) {
      violations.push("imageEnv: differs from the already recorded environment");
    } else {
      next.image = Object.freeze({ ...(next.image as ImageSpec), env: Object.freeze([...env]) });
    }
  }
  if ("imageManifestDigest" in values) {
    const d = values.imageManifestDigest;
    if (typeof d !== "string" || !DIGEST_PATTERN.test(d)) violations.push("imageManifestDigest: must be sha256:<64 lowercase hex>");
    else if (base.image.manifestDigest !== null && base.image.manifestDigest !== d) violations.push("imageManifestDigest: differs from the already recorded digest");
    else next.image = Object.freeze({ ...(next.image as ImageSpec), manifestDigest: d });
  }
  if ("imageId" in values) {
    const id = values.imageId;
    const baseDigest = (next.image as ImageSpec).digest;
    if (typeof id !== "string" || !DIGEST_PATTERN.test(id)) violations.push("imageId: must be the full image ID sha256:<64 lowercase hex> (no tag, short ID or repository)");
    else if (base.image.id !== null && base.image.id !== id) violations.push("imageId: differs from the already recorded image ID");
    else if (baseDigest !== null && baseDigest === id) violations.push("imageId: equals the base image digest; it must be the locally built canary image's own ID");
    else next.image = Object.freeze({ ...(next.image as ImageSpec), id });
  }
  if ("dockerDataRoot" in values) {
    const r = values.dockerDataRoot;
    if (typeof r !== "string" || !/^(\/[A-Za-z0-9._-]+)+$/.test(r) || r.split("/").some((c) => c === "." || c === "..") ||
        r === base.runsRoot || r.startsWith(`${base.runsRoot}/`) || base.runsRoot.startsWith(`${r}/`)) {
      violations.push("dockerDataRoot: must be a normalized absolute path that neither contains nor is inside the runs root");
    } else if (base.dockerDataRoot !== null && base.dockerDataRoot !== r) {
      violations.push("dockerDataRoot: differs from the already recorded value");
    } else {
      next.dockerDataRoot = r;
    }
  }
  if ("runscBinary" in values) {
    const b = values.runscBinary as Record<string, unknown> | null;
    const okShape = typeof b === "object" && b !== null && !Array.isArray(b) &&
      Object.keys(b).length === 4 && ["path", "sha256", "args", "sidecars"].every((k) => Object.prototype.hasOwnProperty.call(b, k)) &&
      Object.values(Object.getOwnPropertyDescriptors(b)).every((d) => !d.get && !d.set);
    const path = okShape ? b!.path : undefined;
    const args = okShape ? b!.args : undefined;
    const sidecars = okShape && typeof path === "string" ? readSidecars(b!.sidecars, path, violations) : null;
    if (!okShape) {
      violations.push("runscBinary: must be { path, sha256, args, sidecars } with plain values (sidecars: the recorded gVisor sidecar files, [] for a single-binary release)");
    } else if (sidecars === null) {
      // readSidecars reported the problem
    } else if (typeof path !== "string" || !RUNTIME_BINARY_DIRS.some((d) => path.startsWith(`${d}/`) && RUNTIME_BINARY_NAME.test(path.slice(d.length + 1)))) {
      violations.push(`runscBinary.path: must be a file directly inside ${RUNTIME_BINARY_DIRS.join(", ")} (no dot-only or hidden names)`);
    } else if (typeof b!.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b!.sha256)) {
      violations.push("runscBinary.sha256: must be 64 lowercase hex characters");
    } else if (!Array.isArray(args) || args.length !== 0) {
      violations.push("runscBinary.args: must be an empty array (no runsc runtime flags are approved)");
    } else if (base.runscBinary !== null && JSON.stringify(base.runscBinary) !== JSON.stringify({ path, sha256: b!.sha256, args, sidecars })) {
      violations.push("runscBinary: differs from the already recorded binary");
    } else {
      next.runscBinary = Object.freeze({ path, sha256: b!.sha256 as string, args: Object.freeze([...(args as string[])]), sidecars });
    }
  }
  if ("canaryManifestDigest" in values) {
    const d = values.canaryManifestDigest;
    const baseManifest = (next.image as ImageSpec).manifestDigest;
    if (typeof d !== "string" || !DIGEST_PATTERN.test(d)) violations.push("canaryManifestDigest: must be sha256:<64 lowercase hex>");
    else if (base.image.canaryManifestDigest !== null && base.image.canaryManifestDigest !== d) violations.push("canaryManifestDigest: differs from the already recorded digest");
    else if (baseManifest !== null && baseManifest === d) violations.push("canaryManifestDigest: equals the base image's manifest digest; it must be the canary image's own manifest");
    else next.image = Object.freeze({ ...(next.image as ImageSpec), canaryManifestDigest: d });
  }
  if ("dockerServerVersion" in values) {
    const v = values.dockerServerVersion;
    if (typeof v !== "string" || !DOCKER_SERVER_VERSION_PATTERN.test(v)) {
      violations.push("dockerServerVersion: must be the daemon's reported ServerVersion (MAJOR.MINOR.PATCH, optional short suffix)");
    } else if (base.dockerServerVersion !== null && base.dockerServerVersion !== v) {
      violations.push("dockerServerVersion: differs from the already recorded value");
    } else {
      next.dockerServerVersion = v;
    }
  }
  if (violations.length > 0) throw new SandboxSpecError(violations);
  return Object.freeze(next) as unknown as SandboxSpec;
}

/**
 * The reference containers are created from: the recorded canary image ID
 * (V1B), "sha256:<64 hex>", never a tag. Refuses unless the base digest, the
 * entrypoint AND the image ID are all pinned (D3), and the ID is not the
 * base digest itself (the base image has no probe; the canary is built FROM it).
 */
export function imageReference(spec: SandboxSpec): string {
  const problems: string[] = [];
  if (spec.image.digest === null || !DIGEST_PATTERN.test(spec.image.digest)) {
    problems.push("image digest is not pinned: a separately approved image pull must record it first (D3)");
  }
  if (spec.image.entrypoint === null) {
    problems.push("image entrypoint is not pinned: it must be recorded at the approved image pull (D3)");
  }
  if (spec.image.id === null || !DIGEST_PATTERN.test(spec.image.id)) {
    problems.push("image ID is not recorded: the separately approved canary image build must record its full ID (sha256:<64 hex>) first (V1B)");
  } else if (spec.image.id === spec.image.digest) {
    problems.push("image ID equals the base image digest: it must be the locally built canary image's own ID (V1B)");
  }
  if (problems.length > 0) throw new SandboxSpecError(problems);
  return spec.image.id!;
}

export interface RunPaths {
  /** Must be exactly <runsRoot>/<runId>/in; mounted read-only at /in. */
  readonly inputDir: string;
  /** Must be exactly <runsRoot>/<runId>/out; mounted read-write at /out; dedicated to this run. */
  readonly outputDir: string;
  readonly runId: string;
}

export type ContainerPurpose = "canary" | "run";
export const CONTAINER_NAME_PATTERN = /^research-sandbox-[a-z0-9][a-z0-9-]{0,63}-(canary|run)$/;

/** Deterministic container name, so a container can be found and removed even if its id was lost. */
export function containerName(runId: string, purpose: ContainerPurpose): string {
  const name = `research-sandbox-${runId}-${purpose}`;
  if (!RUN_ID_PATTERN.test(runId) || !CONTAINER_NAME_PATTERN.test(name)) throw new SandboxSpecError(["invalid run id for a container name"]);
  return name;
}

/** The exact folders a run must use. */
export function expectedRunPaths(spec: SandboxSpec, runId: string): { inputDir: string; outputDir: string } {
  return { inputDir: `${spec.runsRoot}/${runId}/in`, outputDir: `${spec.runsRoot}/${runId}/out` };
}

/**
 * String-level checks: the run folders must be exactly
 * <runsRoot>/<runId>/in and <runsRoot>/<runId>/out (so /home, /tmp, /mnt,
 * /opt, home folders and any parent folder are impossible). Filesystem
 * checks (symlinks, ownership, permissions, emptiness) are in host-paths.ts.
 */
export function validateRunPaths(run: unknown, spec: SandboxSpec = SANDBOX_SPEC): string[] {
  const v: string[] = [];
  if (typeof run !== "object" || run === null || Array.isArray(run)) return ["run: must be an object"];
  const r = run as Record<string, unknown>;
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(r))) {
    if (d.get || d.set) return [`run.${key}: getters/setters are not allowed`];
    if (!["inputDir", "outputDir", "runId"].includes(key)) v.push(`run.${key}: is not an allowed field`);
  }
  if (typeof r.runId !== "string" || !RUN_ID_PATTERN.test(r.runId)) {
    v.push("run.runId: must match [a-z0-9-], 1-64 chars, starting with a letter or digit");
    return v;
  }
  const expected = expectedRunPaths(spec, r.runId);
  if (r.inputDir !== expected.inputDir) v.push(`run.inputDir: must be exactly ${expected.inputDir}`);
  if (r.outputDir !== expected.outputDir) v.push(`run.outputDir: must be exactly ${expected.outputDir}`);
  return v;
}

/**
 * Exact `create` argv for docker/podman (no shell). The container is created,
 * inspected and verified BEFORE it is started (see preflight.ts).
 */
export function buildCreateArgs(spec: SandboxSpec, run: RunPaths, runtime: string, command: readonly string[], purpose: ContainerPurpose): string[] {
  const pathProblems = validateRunPaths(run, spec);
  if (pathProblems.length > 0) throw new SandboxSpecError(pathProblems);
  if (![...spec.isolatingRuntimes, ...spec.developmentRuntimes].includes(runtime)) {
    throw new SandboxSpecError([`runtime "${runtime}" is not in the specification`]);
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== "string" || c.length === 0 || c.includes("\0"))) {
    throw new SandboxSpecError(["command must be a non-empty array of non-empty strings"]);
  }
  const m = spec.mountPoints;
  return [
    "create",
    "--name", containerName(run.runId, purpose),
    "--pull", "never",
    "--hostname", spec.hostname,
    "--runtime", runtime,
    "--network", spec.network,
    "--read-only",
    "--user", spec.user,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--ipc", spec.ipcMode,
    "--cgroupns", "private",
    "--pids-limit", String(spec.pidsLimit),
    "--memory", String(spec.memoryBytes),
    "--memory-swap", String(spec.memorySwapBytes),
    "--cpus", (spec.nanoCpus / 1e9).toString(),
    "--ulimit", `fsize=${spec.ulimits.fsize}:${spec.ulimits.fsize}`,
    "--ulimit", `nofile=${spec.ulimits.nofile}:${spec.ulimits.nofile}`,
    "--ulimit", `core=${spec.ulimits.core}:${spec.ulimits.core}`,
    "--tmpfs", `${m.tmp}:rw,noexec,nosuid,nodev,size=${spec.tmpfsBytes}`,
    "--mount", `type=bind,src=${run.inputDir},dst=${m.input},readonly,bind-propagation=rprivate`,
    "--mount", `type=bind,src=${run.outputDir},dst=${m.output},bind-propagation=rprivate`,
    "--env", "NODE_ENV=production",
    "--env", `RESEARCH_RUN_ID=${run.runId}`,
    "--log-driver", "none",
    "--workdir", "/app",
    "--no-healthcheck",
    imageReference(spec),
    ...command,
  ];
}

/**
 * SHA-256 of the security-relevant create arguments: everything up to and
 * including the image reference, minus the container name (which differs
 * between the canary and the real run). The command after the image is not
 * included. Used to bind a preflight result to the configuration it checked.
 */
export function securityArgsHash(args: readonly string[], spec: SandboxSpec): string {
  const ref = imageReference(spec);
  const end = args.indexOf(ref);
  if (args[0] !== "create" || end < 0) throw new SandboxSpecError(["create arguments do not contain the pinned image reference"]);
  const security: string[] = [];
  for (let i = 0; i <= end; i++) {
    if (args[i] === "--name") { i += 1; continue; }
    security.push(args[i]);
  }
  return createHash("sha256").update(JSON.stringify(security), "utf8").digest("hex");
}
