/**
 * Fail-closed isolation preflight. Sequence (no step is skipped, no fallback):
 *  1. spec: image digest AND entrypoint pinned (D3);
 *  2. run paths exactly <runsRoot>/<runId>/{in,out}; host folders verified
 *     (no symlinks, safe owners/permissions, empty out/) and their identities
 *     recorded;
 *  3. engine target verified (local socket /var/run/docker.sock and an
 *     empty, private client config folder; see host-paths.ts) BEFORE any
 *     engine call; engine info; Podman is refused (its inspect/canary formats are not
 *     verified); the daemon's ServerVersion must equal the recorded, approved
 *     dockerServerVersion (not recorded, missing, malformed or different
 *     refuses; the client version is never evidence; re-checked whenever
 *     `docker info` is re-read); the daemon must report Docker's built-in seccomp profile
 *     (custom, unconfined or unreported refuses); a runtime from the
 *     specification must be available; (M1) for an isolating runtime, its
 *     binary is verified on the host (recorded path and SHA-256, no runtime
 *     flags; see host-paths.ts verifyRuntimeBinary) and re-verified after the
 *     canary, and `docker info` is re-read after create and after the canary
 *     with the runtime's configuration required to be unchanged (these
 *     re-reads narrow, but cannot close, the window in which the daemon could
 *     be reconfigured; they are no defence against a dishonest daemon);
 *     a leftover container with this run's canary name refuses;
 *  4. CREATE the canary with the exact production flags (--pull never);
 *  5. INSPECT it: every property, the container id and name, and the host
 *     folders re-verified with unchanged identities; the host files behind
 *     /etc/hosts, /etc/hostname and /etc/resolv.conf verified under the
 *     recorded Docker data root (not recorded refuses; V2.2: Docker 29 creates
 *     them only at start, so then their folders are verified and the files
 *     must not exist yet); on any violation it is removed without ever being
 *     started;
 *  6. START the probe under a timeout and output cap; RE-INSPECT the exited
 *     container (same id, image, runtime; exit 0; exact host-file paths) and
 *     verify the host files (V2.2, both formats); evaluate its report;
 *     for an isolating runtime, require positive gVisor evidence (canary.ts:
 *     the runtime's NAME is never enough; the host's /proc/version is read
 *     here, never supplied by the caller);
 *  7. CLEANUP, always: bounded forced removal by id (or by name if the id
 *     was never learned), then removal is VERIFIED; unverified cleanup
 *     refuses and the result reports the container id/name for manual
 *     cleanup.
 *
 * meets-spec is BLOCKED (MEETS_SPEC_BLOCKERS, acceptance decisions M1 and
 * M3) for every configuration outside ACCEPTED_DECISION_SCOPE: the owner's
 * recorded decision (docs/M1-M3-DECISION.md) lifts them only for the reviewed
 * configuration in decision-scope.ts (Docker version and runtimes, runsc
 * binary, sidecars and arguments, gVisor reference, image, data root).
 * Changing the blockers or the scope requires a reviewed code change.
 *
 * Ratings (D2, as approved):
 * - meets-spec:       everything passed on Docker with runsc AND gVisor was
 *                     positively identified AND the built-in seccomp profile
 *                     is in use;
 * - development-only: everything passed on Docker with runc/crun (shared host
 *                     kernel), rootless or not; never allows untrusted input;
 * - refused:          anything else, including any Podman setup and a runtime
 *                     named runsc without positive gVisor evidence.
 * hostTrust is always "operator-attested-only": no software check can
 * establish that the host itself is trustworthy.
 *
 * Binding: a passing result records the run id, folders, image reference,
 * runtime and a hash of the security-relevant create arguments, and
 * assertUntrustedInputAllowed requires them to match the intended run. This
 * prevents accidental reuse of a result for another run or configuration; it
 * cannot prevent forgery by code already running in the same process.
 */

import { evaluateCanary, verifyGvisorEvidence } from "./canary.js";
import { ACCEPTED_DECISION_SCOPE, decisionScopeProblems } from "./decision-scope.js";
import type { ContainerEngine, EngineInfo } from "./engine.js";
import {
  canonicalRuntimeConfig, readHostProcVersion, runtimeConfigProblems, sameIdentities, sameRuntimeBinary, verifyContainerHostFiles, verifyRuntimeBinary,
  type RuntimeBinaryIdentity, verifyEngineTarget, verifyRunDirectories, type HostFs, type HostPathPolicy,
} from "./host-paths.js";
import { hostProcessViolations, summarizeHostProcesses, type HostProcessEvidence, type HostProcessObserver } from "./host-processes.js";
import { validateFinishedInspect, validateInspect } from "./inspect.js";
import {
  DOCKER_SERVER_VERSION_PATTERN, SandboxSpecError, buildCreateArgs, containerName, imageReference, securityArgsHash, validateRunPaths,
  type RunPaths, type SandboxSpec,
} from "./spec.js";

export type IsolationRating = "meets-spec" | "development-only" | "refused";

export interface RunBinding {
  readonly runId: string;
  readonly inputDir: string;
  readonly outputDir: string;
  readonly imageRef: string;
  readonly runtime: string;
  readonly securityArgsSha256: string;
  /** The recorded gVisor /proc/version reference this result was verified against. */
  readonly gvisorProcVersion: string;
  /** SHA-256 of the runtime binary verified on the host before create and re-verified after the canary ("" for development runtimes). */
  readonly runtimeBinarySha256: string;
  /** The recorded Docker server version the daemon reported during this preflight. */
  readonly dockerServerVersion: string;
}

export interface CleanupOutcome {
  readonly containerName: string;
  readonly containerId: string | null;
  readonly attempts: number;
  readonly verifiedRemoved: boolean;
  readonly detail: string;
}

export interface PreflightResult {
  readonly rating: IsolationRating;
  readonly allowsUntrustedInput: boolean;
  readonly runtime: string | null;
  readonly engine: EngineInfo | null;
  readonly violations: readonly string[];
  readonly hostTrust: "operator-attested-only";
  readonly steps: readonly string[];
  /** Present only on a passing result. */
  readonly binding: RunBinding | null;
  /** Present whenever a container may have been created. */
  readonly cleanup: CleanupOutcome | null;
  /** Step A3: which host processes ran the canary (host /proc), when observed. */
  readonly hostProcessEvidence: HostProcessEvidence | null;
}

export interface PreflightOptions {
  readonly engine: ContainerEngine;
  readonly spec: SandboxSpec;
  readonly run: RunPaths;
  /** Host path of a canary file that exists on the host but is NOT mounted (outside the runs root). */
  readonly hostCanaryPath: string;
  readonly hostFs: HostFs;
  readonly hostPolicy: HostPathPolicy;
  /** Command inside the image that runs the probe (S3 image). */
  readonly probeCommand?: readonly string[];
  /**
   * Step A3: samples host /proc while the canary runs. REQUIRED for an isolating runtime (refused before create
   * without it); optional otherwise, where it is only recorded.
   */
  readonly hostProcesses?: HostProcessObserver;
}

/**
 * Unresolved acceptance decisions that keep meets-spec unreachable. Frozen;
 * changing it is a reviewed code change, never a runtime option.
 */
export const MEETS_SPEC_BLOCKERS: readonly string[] = Object.freeze([
  "M1: host-side runtime binary and configuration verification is implemented against fakes only and has not been reviewed or exercised on a real host; a matching binary hash, unchanged daemon-reported configuration and the in-container /proc/version fingerprint do not by themselves prove isolation",
  "M3: trust in the daemon-reported seccomp profile and the pinned Docker version has not been explicitly resolved",
]);

/**
 * The blockers that apply to a configuration: none inside the accepted M1/M3 decision scope (decision-scope.ts,
 * docs/M1-M3-DECISION.md), M1/M3 otherwise. info: the daemon's report the preflight checked (null = none).
 */
export function blockersFor(spec: SandboxSpec, runtime: string | null, info: EngineInfo | null): readonly string[] {
  return decisionScopeProblems(spec, runtime, info, ACCEPTED_DECISION_SCOPE).length === 0 ? [] : MEETS_SPEC_BLOCKERS;
}

export const CLEANUP_ATTEMPTS = 3;
const CANARY_TIMEOUT_CAP_MS = 60_000;
const CANARY_OUTPUT_CAP = 64 * 1024;
const PROBE_CANARY_FLAG = "--canary";

function result(fields: Partial<PreflightResult> & { violations: string[]; steps: string[] }): PreflightResult {
  return Object.freeze({
    rating: "refused" as IsolationRating, allowsUntrustedInput: false, runtime: null, engine: null,
    hostTrust: "operator-attested-only" as const, binding: null, cleanup: null, hostProcessEvidence: null,
    ...fields,
    violations: Object.freeze([...fields.violations]),
    steps: Object.freeze([...fields.steps]),
  });
}

/** Picks the most isolating Docker runtime offered; null if none is in the spec. */
export function chooseRuntime(info: EngineInfo, spec: SandboxSpec): string | null {
  return spec.isolatingRuntimes.find((r) => info.runtimes.includes(r))
    ?? spec.developmentRuntimes.find((r) => info.runtimes.includes(r))
    ?? null;
}

/** The approved configuration before blockers: Docker at the recorded server version + positively identified gVisor + built-in seccomp profile. */
function approvedConfiguration(info: EngineInfo, runtime: string, spec: SandboxSpec, gvisorVerified: boolean): boolean {
  return info.engine === "docker" && spec.isolatingRuntimes.includes(runtime) && gvisorVerified === true &&
    info.seccompProfile === spec.seccompProfile && serverVersionProblems(info, spec).length === 0;
}

/**
 * The daemon-reported Docker server version must equal the recorded,
 * approved pin. Not recorded, missing, malformed or different refuses.
 * Only `docker info` ServerVersion (the daemon's report) is used, never the
 * client version. Returns violations.
 */
export function serverVersionProblems(info: EngineInfo, spec: SandboxSpec): string[] {
  if (spec.dockerServerVersion === null) {
    return ["Docker server version: no approved version has been recorded for this host (approved host setup step), so its inspect and info formats can't be trusted"];
  }
  const reported = info?.serverVersion;
  if (typeof reported !== "string" || !DOCKER_SERVER_VERSION_PATTERN.test(reported)) {
    return [`Docker server version: the daemon did not report a well-formed ServerVersion (got ${JSON.stringify(reported ?? null)?.slice(0, 40)})`];
  }
  if (reported !== spec.dockerServerVersion) {
    return [`Docker server version: the daemon reports ${reported}; the approved version is ${spec.dockerServerVersion}`];
  }
  return [];
}

/**
 * Rating for checked evidence. Fails closed: the approved configuration is
 * "refused" while M1/M3 apply to it (blockersFor: any configuration outside
 * the accepted decision scope). Everything else is development-only.
 */
export function rate(info: EngineInfo, runtime: string, spec: SandboxSpec, gvisorVerified: boolean): IsolationRating {
  if (!approvedConfiguration(info, runtime, spec, gvisorVerified)) return "development-only";
  return blockersFor(spec, runtime, info).length > 0 ? "refused" : "meets-spec";
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const steps: string[] = [];
  const { engine, spec, run } = options;

  // 1-2. Static and host checks
  let imageRef: string;
  try {
    imageRef = imageReference(spec);
  } catch (err) {
    return result({ violations: err instanceof SandboxSpecError ? [...err.violations] : ["image reference invalid"], steps: ["spec"] });
  }
  steps.push("spec");
  const pathProblems = validateRunPaths(run, spec);
  const canary = options.hostCanaryPath;
  if (typeof canary !== "string" || !/^(\/[A-Za-z0-9._-]+)+$/.test(canary) || canary.split("/").some((x) => x === "." || x === "..") || canary.startsWith(`${spec.runsRoot}/`)) {
    pathProblems.push("hostCanaryPath: must be an absolute path outside the runs root (no . or .. segments; the probe refuses them)");
  }
  if (pathProblems.length > 0) return result({ violations: pathProblems, steps: [...steps, "paths"] });
  steps.push("paths");
  const before = verifyRunDirectories(run, spec, options.hostFs, options.hostPolicy);
  if (before.violations.length > 0) return result({ violations: [...before.violations], steps: [...steps, "host-paths"] });
  steps.push("host-paths");

  // 3. Engine target (before any engine call), then engine info
  const targetProblems = verifyEngineTarget(engine.target, spec, options.hostFs, options.hostPolicy);
  if (targetProblems.length > 0) return result({ violations: targetProblems, steps: [...steps, "engine-target"] });
  steps.push("engine-target");
  let info: EngineInfo;
  try {
    info = await engine.info();
  } catch (err) {
    return result({ violations: [`engine info failed: ${(err as Error).message}`], steps });
  }
  steps.push("engine-info");
  if (info.engine !== "docker") {
    return result({ violations: ["Podman is not supported yet: its inspect and canary formats have not been verified (fail closed)"], steps, engine: info });
  }
  const versionProblems = serverVersionProblems(info, spec);
  if (versionProblems.length > 0) return result({ violations: versionProblems, steps: [...steps, "engine-version"], engine: info });
  steps.push("engine-version");
  if (info.seccompProfile !== spec.seccompProfile) {
    return result({ violations: [`seccomp: the daemon must report the built-in default profile ("${spec.seccompProfile}"); got ${JSON.stringify(info.seccompProfile)} (custom, unconfined or unreported profiles refuse)`], steps, engine: info });
  }
  const runtime = chooseRuntime(info, spec);
  if (runtime === null) return result({ violations: ["no runtime from the specification is available"], steps, engine: info });
  // M1: an isolating runtime's binary must be verified on the host before anything is created; failure refuses outright.
  let binary: RuntimeBinaryIdentity | null = null;
  let runtimeConfig: string | null = null;
  if (spec.isolatingRuntimes.includes(runtime)) {
    const check = verifyRuntimeBinary(info, runtime, spec, options.hostFs);
    runtimeConfig = canonicalRuntimeConfig(info, runtime);
    if (check.violations.length > 0 || check.identity === null || runtimeConfig === null) {
      return result({ violations: check.violations.length > 0 ? [...check.violations] : ["runtime binary: configuration could not be recorded"], steps: [...steps, "runtime-binary-unverified"], engine: info, runtime });
    }
    binary = check.identity;
    steps.push("runtime-binary-verified");
    if (options.hostProcesses === undefined) {
      return result({ violations: ["host processes: no host process observer was provided (required to show that gVisor, not a shared-kernel runtime, runs the canary)"], steps: [...steps, "host-process-observer-missing"], engine: info, runtime });
    }
  }
  const name = containerName(run.runId, "canary");
  try {
    if (await engine.exists(name)) {
      return result({ violations: [`a container named ${name} already exists; remove it manually before retrying`], steps, engine: info, runtime });
    }
  } catch (err) {
    return result({ violations: [`could not check for a leftover container: ${(err as Error).message}`], steps, engine: info, runtime });
  }

  // 4-6. Create, inspect, start
  const command = options.probeCommand ?? ["node", "/app/canary-probe.js", PROBE_CANARY_FLAG, canary];
  let args: string[];
  try {
    args = buildCreateArgs(spec, run, runtime, command, "canary");
  } catch (err) {
    return result({ violations: err instanceof SandboxSpecError ? [...err.violations] : [String(err)], steps, engine: info, runtime });
  }
  let id: string | null = null;
  let violations: string[] = [];
  let report: unknown;
  let hostProcessEvidence: HostProcessEvidence | null = null;
  const runtimeExecutables = binary === null ? [] : [binary.path, ...binary.sidecars.map((s) => s.path)];
  try {
    id = await engine.create(args, imageRef);
    steps.push("create");
    // C2: the daemon's runtime configuration must be unchanged now that the container exists; otherwise never inspect or start it.
    const fresh = runtimeConfig === null ? [] : await recheckRuntimeConfig(engine, runtime, spec, runtimeConfig, "after create");
    if (fresh.length > 0) {
      violations = fresh;
    } else {
      if (runtimeConfig !== null) steps.push("runtime-config-rechecked-after-create");
      ({ violations, report, hostProcessEvidence } = await inspectAndProbe(options, id, runtime, command, before.identities, steps, runtimeExecutables));
    }
  } catch (err) {
    violations = [`preflight error: ${(err as Error).message}`];
  }

  // 7. Cleanup, always (a create that failed or timed out may still have left a named container)
  const cleanup = await removeAndVerify(engine, id, name);
  steps.push(cleanup.verifiedRemoved ? "removed-verified" : "remove-unverified");
  if (!cleanup.verifiedRemoved) violations = [...violations, `cleanup: ${cleanup.detail} (container ${cleanup.containerId ?? cleanup.containerName}; manual cleanup required)`];
  if (violations.length > 0) return result({ violations, steps, engine: info, runtime, cleanup, hostProcessEvidence });

  // M1: the same runtime configuration and the same binary must still be in place after the canary ran.
  if (binary !== null && runtimeConfig !== null) {
    const fresh = await recheckRuntimeConfig(engine, runtime, spec, runtimeConfig, "after the canary");
    if (fresh.length > 0) return result({ violations: fresh, steps: [...steps, "runtime-config-changed"], engine: info, runtime, cleanup, hostProcessEvidence });
    steps.push("runtime-config-rechecked-after-canary");
    const again = verifyRuntimeBinary(info, runtime, spec, options.hostFs);
    if (again.violations.length > 0 || again.identity === null || !sameRuntimeBinary(binary, again.identity)) {
      return result({ violations: again.violations.length > 0 ? [...again.violations] : ["runtime binary: changed between the check before create and the re-check after the canary"],
        steps: [...steps, "runtime-binary-changed"], engine: info, runtime, cleanup, hostProcessEvidence });
    }
    steps.push("runtime-binary-rechecked");
  }

  // A runtime NAMED as isolating must be positively identified as gVisor; failure refuses outright.
  let gvisorVerified = false;
  if (spec.isolatingRuntimes.includes(runtime)) {
    const gvisor = verifyGvisorEvidence(report, spec, readHostProcVersion());
    if (gvisor.length > 0) return result({ violations: gvisor, steps: [...steps, "gvisor-unverified"], engine: info, runtime, cleanup, hostProcessEvidence });
    steps.push("gvisor-verified");
    gvisorVerified = true;
  }
  const rating = rate(info, runtime, spec, gvisorVerified);
  if (rating === "refused") {
    return result({ violations: [...blockersFor(spec, runtime, info)], steps: [...steps, "meets-spec-blocked"], engine: info, runtime, cleanup, hostProcessEvidence });
  }
  return result({
    rating, allowsUntrustedInput: rating === "meets-spec", runtime, engine: info, violations: [], steps, cleanup, hostProcessEvidence,
    binding: Object.freeze({
      runId: run.runId, inputDir: run.inputDir, outputDir: run.outputDir, imageRef, runtime,
      securityArgsSha256: securityArgsHash(args, spec),
      gvisorProcVersion: spec.gvisorProcVersion ?? "",
      runtimeBinarySha256: binary?.sha256 ?? "",
      dockerServerVersion: spec.dockerServerVersion ?? "",
    }),
  });
}

async function inspectAndProbe(
  options: PreflightOptions, id: string, runtime: string, command: readonly string[],
  identities: Parameters<typeof sameIdentities>[0], steps: string[], runtimeExecutables: readonly string[],
): Promise<{ violations: string[]; report: unknown; hostProcessEvidence: HostProcessEvidence | null }> {
  let hostProcessEvidence: HostProcessEvidence | null = null;
  const fail = (violations: string[]) => ({ violations, report: undefined, hostProcessEvidence });
  const { engine, spec, run } = options;
  const inspected = validateInspect(await engine.inspect(id), spec, { run, purpose: "canary", command });
  steps.push("inspect");
  if (inspected.violations.length > 0) return fail([...inspected.violations]); // never started
  if (inspected.runtime !== runtime) return fail([`inspect: runtime ${String(inspected.runtime)} differs from requested ${runtime}`]);
  if (inspected.containerId === null || !inspected.containerId.startsWith(id)) return fail(["inspect: container id differs from the one created"]);
  const after = verifyRunDirectories(run, spec, options.hostFs, options.hostPolicy);
  steps.push("host-paths-recheck");
  if (after.violations.length > 0) return fail([...after.violations]);
  if (!sameIdentities(identities, after.identities)) return fail(["host folders changed identity between the checks and container creation"]);
  // The host files Docker bind-mounts at /etc/hosts, /etc/hostname, /etc/resolv.conf (exact paths already checked by inspect).
  // V2.2: Docker 29 reports and writes them only at start; then the folders are checked now, the files after the canary.
  const pending = inspected.hostFilesPending;
  const hostFiles = verifyContainerHostFiles(spec, inspected.containerId, options.hostFs, pending ? "pending" : "present");
  steps.push(pending ? "container-host-files-pending" : "container-host-files");
  if (hostFiles.length > 0) return fail(hostFiles);

  // Step A3: sample host /proc for the whole time the canary runs (always stopped, even if start throws).
  const watch = options.hostProcesses?.start(inspected.containerId);
  let r: Awaited<ReturnType<typeof engine.start>>;
  try {
    r = await engine.start(id, Math.min(spec.timeoutMs, CANARY_TIMEOUT_CAP_MS), CANARY_OUTPUT_CAP);
  } finally {
    const observed = watch?.stop();
    hostProcessEvidence = observed === undefined ? null : summarizeHostProcesses(observed, runtimeExecutables);
  }
  steps.push("canary");
  if (r.timedOut) return fail(["canary: timed out (the engine CLI was killed; the container is force-removed and removal verified next)"]);
  if (r.truncated) return fail(["canary: output exceeded the cap"]);
  if (r.exitCode !== 0) return fail([`canary: exited with ${r.exitCode}${r.signal ? ` (${r.signal})` : ""}`]);
  let report: unknown;
  // V2.3: byte counts only (never the content) so a report shows e.g. an empty stdout.
  try { report = JSON.parse(r.stdout); } catch {
    return fail([`canary: output is not JSON (stdout ${Buffer.byteLength(r.stdout, "utf8")} bytes, stderr ${Buffer.byteLength(r.stderr, "utf8")} bytes)`]);
  }
  // Step A3: under an isolating runtime, gVisor (not a shared-kernel runtime) must be seen running the canary.
  if (spec.isolatingRuntimes.includes(runtime)) {
    const hv = hostProcessEvidence === null ? ["host processes: no observation was made"] : hostProcessViolations(hostProcessEvidence);
    steps.push("host-process-evidence");
    if (hv.length > 0) return fail(hv);
  }
  // V2.2: re-inspect the stopped container (always, both formats): same container, clean exit, exact host-file paths;
  // then the host files themselves, which now exist.
  const finished = validateFinishedInspect(await engine.inspect(id), spec, { run, purpose: "canary", containerId: inspected.containerId, runtime });
  steps.push("inspect-after-canary");
  if (finished.length > 0) return fail(finished);
  const filesAfter = verifyContainerHostFiles(spec, inspected.containerId, options.hostFs, "present");
  steps.push("container-host-files-after-canary");
  if (filesAfter.length > 0) return fail(filesAfter);
  return { violations: evaluateCanary(report, spec, { isolating: spec.isolatingRuntimes.includes(runtime) }), report, hostProcessEvidence };
}

/**
 * C2: re-reads `docker info` and requires the isolating runtime to still be
 * offered, its configuration to still pass runtimeConfigProblems, and its
 * canonical configuration to equal the one verified before create. Any
 * failure to read, or missing, malformed or changed data, refuses. This
 * detects a reconfiguration visible at these moments; it does not prove what
 * the daemon executed (dishonest daemon) or close the race between re-reads.
 */
async function recheckRuntimeConfig(engine: ContainerEngine, runtime: string, spec: SandboxSpec, verified: string, when: string): Promise<string[]> {
  let fresh: EngineInfo;
  try {
    fresh = await engine.info();
  } catch (err) {
    return [`runtime configuration (${when}): docker info failed: ${(err as Error).message}`];
  }
  if (typeof fresh !== "object" || fresh === null || fresh.engine !== "docker" || !Array.isArray(fresh.runtimes) || !fresh.runtimes.includes(runtime)) {
    return [`runtime configuration (${when}): docker info no longer reports the ${runtime} runtime`];
  }
  const problems = [...serverVersionProblems(fresh, spec), ...runtimeConfigProblems(fresh, runtime, spec)];
  if (problems.length > 0) return problems.map((p) => `runtime configuration (${when}): ${p}`);
  if (canonicalRuntimeConfig(fresh, runtime) !== verified) return [`runtime configuration (${when}): changed since it was verified before create`];
  return [];
}

/** Bounded forced removal, then verification that neither the id nor the name still exists. */
export async function removeAndVerify(engine: ContainerEngine, id: string | null, name: string): Promise<CleanupOutcome> {
  let attempts = 0;
  let lastError = "";
  for (; attempts < CLEANUP_ATTEMPTS; ) {
    attempts += 1;
    try {
      // Without a known id, a create that failed or timed out may still have made the named container.
      if (id !== null) await engine.remove(id);
      else if (await engine.exists(name)) await engine.remove(name);
    } catch (err) {
      lastError = (err as Error).message;
    }
    try {
      const gone = !(await engine.exists(name)) && (id === null || !(await engine.exists(id)));
      if (gone) return { containerName: name, containerId: id, attempts, verifiedRemoved: true, detail: "removed and verified" };
      lastError = lastError || "container still exists after forced removal";
    } catch (err) {
      lastError = `could not verify removal: ${(err as Error).message}`;
    }
  }
  return { containerName: name, containerId: id, attempts, verifiedRemoved: false, detail: lastError };
}

export class IsolationRefusedError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Untrusted input refused:\n- ${reasons.join("\n- ")}`);
    this.name = "IsolationRefusedError";
  }
}

/**
 * Gate for any future stage that touches untrusted documents: only a passing
 * meets-spec result whose binding matches the intended run, folders, image,
 * runtime and security arguments, with verified cleanup, is accepted.
 */
export function assertUntrustedInputAllowed(r: PreflightResult, intended: { spec: SandboxSpec; run: RunPaths }): void {
  const reasons: string[] = [];
  if (!r || typeof r !== "object") throw new IsolationRefusedError(["no preflight result"]);
  reasons.push(...blockersFor(intended?.spec, typeof r.runtime === "string" ? r.runtime : null, r.engine ?? null));
  if (r.rating !== "meets-spec" || r.allowsUntrustedInput !== true) reasons.push(`rating is ${String(r.rating)}`);
  if (!Array.isArray(r.violations) || r.violations.length > 0) reasons.push("result has violations");
  if (!Array.isArray(r.steps) || !r.steps.includes("canary") || !r.steps.includes("removed-verified")) reasons.push("preflight did not complete with verified cleanup");
  if (!Array.isArray(r.steps) || !r.steps.includes("gvisor-verified")) reasons.push("gVisor was not positively verified");
  if (!Array.isArray(r.steps) || !r.steps.includes("engine-version")) reasons.push("the Docker server version was not verified against the recorded pin");
  if (!Array.isArray(r.steps) || !r.steps.includes("runtime-binary-verified") || !r.steps.includes("runtime-binary-rechecked")) reasons.push("the runtime binary was not verified before create and re-verified after the canary");
  if (!Array.isArray(r.steps) || !r.steps.includes("runtime-config-rechecked-after-create") || !r.steps.includes("runtime-config-rechecked-after-canary")) {
    reasons.push("the runtime configuration was not re-read after create and after the canary");
  }
  if (!r.cleanup || r.cleanup.verifiedRemoved !== true) reasons.push("cleanup was not verified");
  const b = r.binding;
  if (!b) reasons.push("result is not bound to a run");
  else {
    try {
      const { spec, run } = intended;
      if (b.runId !== run.runId || b.inputDir !== run.inputDir || b.outputDir !== run.outputDir) reasons.push("result was produced for a different run or folders");
      if (b.imageRef !== imageReference(spec)) reasons.push("result was produced for a different image");
      if (spec.gvisorProcVersion === null || b.gvisorProcVersion !== spec.gvisorProcVersion) reasons.push("result was not verified against the recorded gVisor reference");
      if (spec.runscBinary === null || b.runtimeBinarySha256 !== spec.runscBinary.sha256) reasons.push("result was not verified against the recorded runtime binary");
      if (spec.dockerServerVersion === null || b.dockerServerVersion !== spec.dockerServerVersion) reasons.push("result was not verified against the recorded Docker server version");
      if (b.runtime !== r.runtime || !spec.isolatingRuntimes.includes(b.runtime)) reasons.push("result runtime is not an approved isolating runtime");
      const expectedHash = securityArgsHash(buildCreateArgs(spec, run, b.runtime, ["node"], "run"), spec);
      if (b.securityArgsSha256 !== expectedHash) reasons.push("result was produced for different security arguments");
    } catch (err) {
      reasons.push(`binding could not be checked: ${(err as Error).message}`);
    }
  }
  if (reasons.length > 0) throw new IsolationRefusedError(reasons);
}
