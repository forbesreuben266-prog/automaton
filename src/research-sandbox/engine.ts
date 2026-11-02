/**
 * Container-engine adapter (Docker Engine CLI; Podman is detected and
 * refused by the preflight until its formats are verified). Tests inject a
 * fake ProcessRunner; the real runner is exercised by tests only with
 * harmless local `node` processes (never an engine, never the network).
 *
 * Real runner: spawn with an argv array and shell:false, a minimal
 * environment (no host credentials or proxy variables reach the engine CLI),
 * its own process group, a timeout that SIGKILLs the whole group, and caps on
 * stdout/stderr (exceeding a cap also kills the group). Killing the CLI does
 * NOT stop a container running in the daemon; the preflight therefore always
 * force-removes and then verifies removal.
 *
 * Daemon targeting: every Docker call carries `--host unix:///var/run/docker.sock`
 * and `--config <empty operator folder>` (global flags, before the
 * subcommand), so saved contexts, DOCKER_* settings or client config can't
 * redirect the CLI or inject settings. The preflight verifies both via
 * `target` before the first engine call. Podman has no target (refused).
 *
 * Create guard: exactly one "--pull" token, immediately followed by "never",
 * placed before the single occurrence of the pinned image reference; no
 * "--pull=..." form anywhere; no "--pull" among the command arguments.
 */

import { spawn } from "node:child_process";
import { DOCKER_HOST, type EngineTarget } from "./host-paths.js";
import { CONTAINER_NAME_PATTERN, DIGEST_PATTERN } from "./spec.js";

export const ALLOWED_ENGINE_BINARIES = Object.freeze(["/usr/bin/docker", "/usr/bin/podman", "/usr/local/bin/docker", "/usr/local/bin/podman"]);
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const ENGINE_CALL_TIMEOUT_MS = 30_000;
const ENGINE_OUTPUT_CAP = 1024 * 1024;
const STDERR_CAP = 4_096;

export interface ProcessResult {
  /** Exit code; -1 when the process was killed by a signal. */
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export type ProcessRunner = (file: string, args: readonly string[], options: { timeoutMs: number; maxOutputBytes: number }) => Promise<ProcessResult>;

export interface EngineInfo {
  readonly engine: "docker" | "podman";
  readonly rootless: boolean;
  readonly runtimes: readonly string[];
  /** Daemon seccomp profile from `docker info` SecurityOptions; null if not reported unambiguously (or Podman). */
  readonly seccompProfile: string | null;
}

export interface ContainerEngine {
  /** The daemon endpoint and client config folder every call uses; null if not pinned (refused). */
  readonly target: EngineTarget | null;
  info(): Promise<EngineInfo>;
  /** imageRef must be the pinned repository@sha256 reference that appears once in args. */
  create(args: readonly string[], imageRef: string): Promise<string>;
  inspect(id: string): Promise<unknown>;
  start(id: string, timeoutMs: number, maxOutputBytes: number): Promise<ProcessResult>;
  /** Force-removes by container id or by the deterministic container name. */
  remove(idOrName: string): Promise<void>;
  /** True if a container with this id or exact name still exists. */
  exists(idOrName: string): Promise<boolean>;
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * Real runner: own process group; SIGKILL to the whole group on timeout or
 * when output exceeds the cap. Resolves only after the process has exited.
 */
export const nodeProcessRunner: ProcessRunner = (file, args, { timeoutMs, maxOutputBytes }) =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], {
      shell: false,
      detached: true, // own process group, so the whole group can be killed
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let truncated = false;
    const killGroup = () => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) { truncated = true; killGroup(); return; }
      out.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (errBytes < STDERR_CAP) err.push(chunk.subarray(0, STDERR_CAP - errBytes));
      errBytes += chunk.length;
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      killGroup(); // leave no process from this group behind
      resolve({
        exitCode: code ?? -1,
        signal: signal ?? null,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        truncated,
      });
    };
    child.once("error", () => finish(-1, null));
    child.once("close", finish);
  });

const checkId = (id: unknown): string => {
  if (typeof id !== "string" || !CONTAINER_ID.test(id)) throw new EngineError("invalid container id");
  return id;
};
const checkRef = (ref: unknown): string => {
  if (typeof ref === "string" && (CONTAINER_ID.test(ref) || CONTAINER_NAME_PATTERN.test(ref))) return ref;
  throw new EngineError("invalid container id or name");
};

/**
 * The profile named in Docker's "name=seccomp,profile=<value>" security
 * option; null when there is none, more than one, or it is malformed.
 */
export function seccompProfileOf(securityOptions: readonly unknown[]): string | null {
  const entries = securityOptions.filter((o): o is string => typeof o === "string" && /^name=seccomp(,|$)/.test(o));
  if (entries.length !== 1) return null;
  const profiles = entries[0].split(",").filter((part) => part.startsWith("profile="));
  return profiles.length === 1 && profiles[0].length > "profile=".length ? profiles[0].slice("profile=".length) : null;
}

/**
 * Pull-guard for create argv: exactly one "--pull" "never" pair before the
 * single image reference; no "--pull=" form and no other "--pull" token.
 * Returns a reason, or null when the argv is acceptable.
 */
export function createArgvProblem(args: readonly string[], imageRef: string): string | null {
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) return "argv must be an array of strings";
  if (args[0] !== "create") return "argv must start with create";
  if (typeof imageRef !== "string" || !/^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/.test(imageRef) || !DIGEST_PATTERN.test(imageRef.slice(imageRef.indexOf("@") + 1))) {
    return "image reference must be pinned by digest";
  }
  const imageAt = args.indexOf(imageRef);
  if (imageAt < 0 || args.lastIndexOf(imageRef) !== imageAt) return "the image reference must appear exactly once";
  if (args.some((a) => a.startsWith("--pull="))) return "the --pull=... form is not allowed";
  const pulls = args.flatMap((a, i) => (a === "--pull" ? [i] : []));
  if (pulls.length !== 1) return `exactly one --pull flag is required (found ${pulls.length})`;
  if (args[pulls[0] + 1] !== "never") return "--pull must be never";
  if (pulls[0] > imageAt) return "--pull never must come before the image reference";
  return null;
}

export function createCliEngine(binary: string, configDir: string, runner: ProcessRunner = nodeProcessRunner): ContainerEngine {
  if (!ALLOWED_ENGINE_BINARIES.includes(binary)) throw new EngineError(`engine binary must be one of ${ALLOWED_ENGINE_BINARIES.join(", ")}`);
  const kind: "docker" | "podman" = binary.endsWith("/podman") ? "podman" : "docker";
  if (typeof configDir !== "string" || !/^(\/[A-Za-z0-9._-]+)+$/.test(configDir)) throw new EngineError("configDir must be an absolute path");
  // Global flags pin the daemon socket and the client config folder for every Docker call.
  const global = kind === "docker" ? ["--host", DOCKER_HOST, "--config", configDir] : [];
  const target: EngineTarget | null = kind === "docker" ? Object.freeze({ host: DOCKER_HOST, configDir }) : null;
  const run = (args: readonly string[], timeoutMs = ENGINE_CALL_TIMEOUT_MS, maxOutputBytes = ENGINE_OUTPUT_CAP) =>
    runner(binary, [...global, ...args], { timeoutMs, maxOutputBytes });
  const ok = (r: ProcessResult, what: string) => {
    if (r.timedOut) throw new EngineError(`${what}: timed out`);
    if (r.truncated) throw new EngineError(`${what}: output exceeded the cap`);
    if (r.exitCode !== 0) throw new EngineError(`${what}: exited with ${r.exitCode}${r.signal ? ` (${r.signal})` : ""}`);
    return r;
  };
  const parseJson = (text: string, what: string): unknown => {
    try { return JSON.parse(text); } catch { throw new EngineError(`${what}: output is not JSON`); }
  };

  return {
    target,
    async info() {
      const r = ok(await run(kind === "docker" ? ["info", "--format", "{{json .}}"] : ["info", "--format", "json"]), "info");
      const j = parseJson(r.stdout, "info") as Record<string, any>;
      if (kind === "docker") {
        const opts: unknown[] = Array.isArray(j?.SecurityOptions) ? j.SecurityOptions : [];
        const runtimes = j?.Runtimes && typeof j.Runtimes === "object" ? Object.keys(j.Runtimes) : [];
        return { engine: "docker", rootless: opts.some((o) => o === "name=rootless"), runtimes, seccompProfile: seccompProfileOf(opts) };
      }
      const rootless = j?.host?.security?.rootless === true;
      const name = j?.host?.ociRuntime?.name;
      return { engine: "podman", rootless, runtimes: typeof name === "string" ? [name] : [], seccompProfile: null };
    },
    async create(args, imageRef) {
      const problem = createArgvProblem(args, imageRef);
      if (problem !== null) throw new EngineError(`create: ${problem} (no image downloads)`);
      const r = ok(await run(args), "create");
      return checkId(r.stdout.trim());
    },
    async inspect(id) {
      const r = ok(await run(["inspect", "--type", "container", checkId(id)]), "inspect");
      return parseJson(r.stdout, "inspect");
    },
    async start(id, timeoutMs, maxOutputBytes) {
      return run(["start", "--attach", checkId(id)], timeoutMs, maxOutputBytes);
    },
    async remove(idOrName) {
      ok(await run(["rm", "--force", checkRef(idOrName)]), "remove");
    },
    async exists(idOrName) {
      const ref = checkRef(idOrName);
      const filter = CONTAINER_ID.test(ref) ? `id=${ref}` : `name=^/${ref}$`;
      const r = ok(await run(["ps", "--all", "--quiet", "--no-trunc", "--filter", filter]), "exists");
      return r.stdout.trim().length > 0;
    },
  };
}
