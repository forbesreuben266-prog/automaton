/**
 * Operator-invoked preflight runner (V1A). A thin wrapper around the existing
 * preflight: it parses an operator-prepared configuration, builds the spec
 * with resolveSpec (the existing pin validation), creates the engine with
 * createCliEngine (the existing pinned Docker adapter) and calls runPreflight
 * (every security check lives there; nothing is re-implemented here). It
 * then reports the result in text or JSON.
 *
 * Fail closed:
 * - usage or configuration problems (missing, unknown, null or malformed
 *   values, duplicate JSON keys, a spec pin that resolveSpec refuses, an
 *   engine binary createCliEngine refuses) stop BEFORE any engine call;
 * - every preflight outcome other than meets-spec is a refusal (exit 1),
 *   including development-only, which never allows untrusted input;
 * - meets-spec is unreachable while MEETS_SPEC_BLOCKERS (M1, M3) is non-empty;
 *   if a result ever claimed it (or claimed untrusted input is allowed) while
 *   a blocker exists, the runner reports an internal inconsistency (exit 3)
 *   instead of success;
 * - an unexpected error is exit 3, with a reminder to check for a leftover
 *   canary container by name.
 * There is no override, trust switch or "skip" option of any kind.
 *
 * Exit codes: 0 meets-spec (unreachable while the blockers exist),
 * 1 refused or development-only, 2 usage or configuration error (no engine
 * call was made), 3 internal error or inconsistency.
 */

import type { ContainerEngine } from "./engine.js";
import type { HostFs } from "./host-paths.js";
import { MEETS_SPEC_BLOCKERS, runPreflight, type PreflightOptions, type PreflightResult } from "./preflight.js";
import { containerName, expectedRunPaths, resolveSpec, SandboxSpecError, type RunPaths } from "./spec.js";

export const RUNNER_CONFIG_VERSION = 1;
export const MAX_RUNNER_CONFIG_BYTES = 64 * 1024;
export const RUNNER_EXIT = Object.freeze({ meetsSpec: 0, refused: 1, usage: 2, internal: 3 });
/** The deliberate-invocation flag: the run contacts the Docker daemon and creates (then removes) one canary container. */
export const CONFIRM_FLAG = "--confirm-docker-access";

export const RUNNER_USAGE = [
  "Research sandbox preflight runner (V1A). Operator-invoked only; run it only on the approved host, after the approved setup steps.",
  "",
  `  preflight-main.js --config <absolute path to the runner configuration .json> ${CONFIRM_FLAG} [--output text|json]`,
  "",
  `${CONFIRM_FLAG} is required: the run talks to the local Docker daemon (/var/run/docker.sock), creates one canary`,
  "container from the pinned image (--pull never), runs the probe in it and removes it. It never downloads anything.",
  "Exit codes: 0 meets-spec (unreachable while the M1/M3 blockers exist), 1 refused or development-only,",
  "2 usage or configuration error (no engine call made), 3 internal error.",
  "",
].join("\n");

const PIN_KEYS = ["imageDigest", "imageEntrypoint", "imageEnv", "imageManifestDigest", "gvisorProcVersion", "dockerDataRoot", "runscBinary", "dockerServerVersion"] as const;
/** Pins that may be explicitly null: a classic (non-containerd) image store reports no platform manifest digest. */
const NULLABLE_PINS: readonly string[] = ["imageManifestDigest"];
const CONFIG_KEYS = ["version", "engineBinary", "engineConfigDir", "runId", "hostCanaryPath", "operatorUid", "outputOwnerUid", "pins"];

export class RunnerConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Runner configuration refused:\n- ${problems.join("\n- ")}`);
    this.name = "RunnerConfigError";
  }
}

export interface RunnerConfig {
  readonly engineBinary: string;
  readonly engineConfigDir: string;
  readonly runId: string;
  readonly hostCanaryPath: string;
  readonly operatorUid: number;
  readonly outputOwnerUid: number;
  readonly pins: Readonly<Record<string, unknown>>;
}

/** Throws RunnerConfigError on duplicate object keys (JSON.parse would silently keep the last one). */
function refuseDuplicateKeys(text: string): void {
  const stack: Array<{ keys: Set<string>; expectKey: boolean } | null> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\"") j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.expectKey) {
        let key: string;
        try { key = JSON.parse(text.slice(i, j + 1)) as string; } catch { return; } // malformed: JSON.parse reports it
        if (top.keys.has(key)) throw new RunnerConfigError([`configuration: duplicate key ${JSON.stringify(key).slice(0, 80)} (ambiguous)`]);
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && stack[stack.length - 1]) stack[stack.length - 1]!.expectKey = true;
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const ABSOLUTE = /^(\/[A-Za-z0-9._-]+)+$/;

/** Parses and validates the runner configuration text. Spec pins are validated later by resolveSpec. */
export function parseRunnerConfig(text: unknown): RunnerConfig {
  if (typeof text !== "string") throw new RunnerConfigError(["configuration: must be text"]);
  if (text.length > MAX_RUNNER_CONFIG_BYTES) throw new RunnerConfigError([`configuration: is longer than ${MAX_RUNNER_CONFIG_BYTES} characters`]);
  refuseDuplicateKeys(text);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new RunnerConfigError(["configuration: is not valid JSON"]); }
  const problems: string[] = [];
  if (!isPlain(raw)) throw new RunnerConfigError(["configuration: must be a JSON object"]);
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.includes(k)) problems.push(`${k}: is not a recognised field`);
  for (const k of CONFIG_KEYS) if (!(k in raw)) problems.push(`${k}: is required`);
  if (problems.length > 0) throw new RunnerConfigError(problems);
  if (raw.version !== RUNNER_CONFIG_VERSION) problems.push(`version: must be ${RUNNER_CONFIG_VERSION}`);
  for (const k of ["engineBinary", "engineConfigDir", "hostCanaryPath"]) {
    if (typeof raw[k] !== "string" || !ABSOLUTE.test(raw[k] as string)) problems.push(`${k}: must be an absolute path`);
  }
  if (typeof raw.runId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.runId)) problems.push("runId: must be lower-case letters, digits and hyphens (at most 64)");
  for (const k of ["operatorUid", "outputOwnerUid"]) {
    if (typeof raw[k] !== "number" || !Number.isSafeInteger(raw[k]) || (raw[k] as number) < 0) problems.push(`${k}: must be a non-negative whole number`);
  }
  if (!isPlain(raw.pins)) {
    problems.push("pins: must be an object");
  } else {
    for (const k of Object.keys(raw.pins)) if (!(PIN_KEYS as readonly string[]).includes(k)) problems.push(`pins.${k}: is not a recognised pin`);
    for (const k of PIN_KEYS) {
      if (!(k in raw.pins)) problems.push(`pins.${k}: is required (recorded at an approved host-setup step; nothing is defaulted)`);
      else if (raw.pins[k] === null && !NULLABLE_PINS.includes(k)) problems.push(`pins.${k}: is not recorded (null); the preflight can't run without it`);
    }
  }
  if (problems.length > 0) throw new RunnerConfigError(problems);
  return Object.freeze({
    engineBinary: raw.engineBinary as string, engineConfigDir: raw.engineConfigDir as string, runId: raw.runId as string,
    hostCanaryPath: raw.hostCanaryPath as string, operatorUid: raw.operatorUid as number, outputOwnerUid: raw.outputOwnerUid as number,
    pins: Object.freeze({ ...(raw.pins as Record<string, unknown>) }),
  });
}

export interface RunnerDeps {
  /** Reads the configuration file (the entry point's safe reader); throws RunnerConfigError. */
  readonly readConfig: (path: string) => string;
  /** Creates the engine (the entry point passes createCliEngine with the real process runner). */
  readonly createEngine: (binary: string, configDir: string) => ContainerEngine;
  readonly hostFs: HostFs;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** The preflight; tests may substitute it. Defaults to the existing runPreflight. */
  readonly preflight?: (options: PreflightOptions) => Promise<PreflightResult>;
}

/** Replaces anything but printable ASCII so daemon- or file-sourced text can't control the terminal. */
const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?");

export interface RunnerReport {
  readonly runner: "research-sandbox-preflight";
  readonly runId: string;
  readonly rating: PreflightResult["rating"];
  readonly allowsUntrustedInput: boolean;
  /** True when every check passed and only the M1/M3 blockers refused. */
  readonly blockedOnlyByMeetsSpecBlockers: boolean;
  readonly blockers: readonly string[];
  readonly violations: readonly string[];
  readonly steps: readonly string[];
  readonly runtime: string | null;
  readonly engine: { readonly serverVersion: string | null; readonly seccompProfile: string | null; readonly rootless: boolean; readonly runtimes: readonly string[] } | null;
  readonly cleanup: PreflightResult["cleanup"];
  readonly hostTrust: "operator-attested-only";
}

export function toReport(r: PreflightResult, runId: string): RunnerReport {
  const blockedOnly = r.rating === "refused" && r.steps[r.steps.length - 1] === "meets-spec-blocked" &&
    r.violations.length === MEETS_SPEC_BLOCKERS.length && r.violations.every((v, i) => v === MEETS_SPEC_BLOCKERS[i]);
  return Object.freeze({
    runner: "research-sandbox-preflight" as const, runId, rating: r.rating, allowsUntrustedInput: r.allowsUntrustedInput, blockedOnlyByMeetsSpecBlockers: blockedOnly,
    blockers: [...MEETS_SPEC_BLOCKERS], violations: [...r.violations], steps: [...r.steps], runtime: r.runtime,
    engine: r.engine === null ? null : { serverVersion: r.engine.serverVersion, seccompProfile: r.engine.seccompProfile, rootless: r.engine.rootless, runtimes: [...r.engine.runtimes] },
    cleanup: r.cleanup, hostTrust: r.hostTrust,
  });
}

export function renderRunnerReport(rep: RunnerReport): string {
  const lines = [
    "Research sandbox preflight (V1A runner). Host trust is operator-attested only; no result approves research input by itself.",
    "",
    `Rating: ${rep.rating.toUpperCase()}    Untrusted input allowed: ${rep.allowsUntrustedInput ? "yes" : "no"}`,
  ];
  if (rep.rating === "development-only") lines.push("development-only: shared host kernel (runc/crun); never allows untrusted input.");
  if (rep.blockedOnlyByMeetsSpecBlockers) lines.push("Every check passed; refused only because of the M1/M3 blockers (removing one is a reviewed code change).");
  lines.push("", "Blockers (M1/M3, active):", ...rep.blockers.map((b) => `  - ${printable(b)}`));
  if (!rep.blockedOnlyByMeetsSpecBlockers && rep.violations.length > 0) lines.push("", "Problems found:", ...rep.violations.map((v) => `  - ${printable(v)}`));
  lines.push("", `Steps completed: ${rep.steps.map(printable).join(" -> ") || "(none)"}`);
  if (rep.engine) {
    lines.push(`Engine: Docker server ${printable(String(rep.engine.serverVersion))}; seccomp ${printable(String(rep.engine.seccompProfile))}; rootless ${rep.engine.rootless ? "yes" : "no"}; runtimes ${rep.engine.runtimes.map(printable).join(", ") || "(none)"}; chosen ${printable(String(rep.runtime))}`);
  }
  if (rep.cleanup) {
    lines.push(rep.cleanup.verifiedRemoved
      ? `Cleanup: canary container removed and removal verified (${printable(rep.cleanup.containerName)}).`
      : `Cleanup: MANUAL CLEANUP REQUIRED: ${printable(rep.cleanup.containerId ?? rep.cleanup.containerName)} (${printable(rep.cleanup.detail)}).`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Runs one operator invocation; returns the exit code. Never throws. */
export async function runPreflightCommand(argv: readonly string[], deps: RunnerDeps): Promise<number> {
  let configPath: string | null = null;
  let output: "text" | "json" = "text";
  let confirmed = false;
  const usage = (message: string) => { deps.err(`Usage error: ${message}\n\n${RUNNER_USAGE}`); return RUNNER_EXIT.usage; };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === CONFIRM_FLAG) { if (confirmed) return usage(`${CONFIRM_FLAG} is given more than once`); confirmed = true; }
      else if (a === "--config" || a === "--output") {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) return usage(`${a} needs a value`);
        i += 1;
        if (a === "--config") { if (configPath !== null) return usage("--config is given more than once"); configPath = v; }
        else if (v === "text" || v === "json") output = v;
        else return usage("--output must be text or json");
      } else return usage(`unrecognised argument ${JSON.stringify(printable(String(a)).slice(0, 40))}`);
    }
    if (configPath === null) return usage("missing --config");
    if (!ABSOLUTE.test(configPath)) return usage("--config must be an absolute path");
    if (!confirmed) return usage(`missing ${CONFIRM_FLAG} (the run contacts the Docker daemon and creates one canary container)`);

    let config: RunnerConfig;
    let spec;
    let run: RunPaths;
    let engine: ContainerEngine;
    try {
      config = parseRunnerConfig(deps.readConfig(configPath));
      spec = resolveSpec(Object.fromEntries(Object.entries(config.pins).filter(([, v]) => v !== null)));
      run = { runId: config.runId, ...expectedRunPaths(spec, config.runId) };
      engine = deps.createEngine(config.engineBinary, config.engineConfigDir);
    } catch (err) {
      const problems = err instanceof RunnerConfigError || err instanceof SandboxSpecError ? (err instanceof RunnerConfigError ? err.problems : err.violations)
        : [(err as Error)?.message ?? "configuration could not be used"];
      deps.err(`Refused before any engine call (configuration):\n${problems.map((p) => `- ${printable(p)}`).join("\n")}\n`);
      return RUNNER_EXIT.usage;
    }

    let result: PreflightResult;
    try {
      result = await (deps.preflight ?? runPreflight)({
        engine, spec, run, hostCanaryPath: config.hostCanaryPath, hostFs: deps.hostFs,
        hostPolicy: { operatorUid: config.operatorUid, outputOwnerUid: config.outputOwnerUid },
      });
    } catch (err) {
      deps.err(`Internal error during the preflight: ${printable(String((err as Error)?.message ?? err)).slice(0, 300)}\n` +
        `Check for a leftover container named ${containerName(config.runId, "canary")} and remove it manually.\n`);
      return RUNNER_EXIT.internal;
    }
    if (MEETS_SPEC_BLOCKERS.length > 0 && (result.rating === "meets-spec" || result.allowsUntrustedInput)) {
      deps.err("Internal inconsistency: a result claimed meets-spec or allowed untrusted input while the M1/M3 blockers exist. Treated as refused.\n");
      return RUNNER_EXIT.internal;
    }
    const report = toReport(result, config.runId);
    deps.out(output === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderRunnerReport(report));
    return result.rating === "meets-spec" ? RUNNER_EXIT.meetsSpec : RUNNER_EXIT.refused;
  } catch (err) {
    try { deps.err(`Internal error: ${printable(String((err as Error)?.message ?? err)).slice(0, 300)}\n`); } catch { /* nothing more can be reported */ }
    return RUNNER_EXIT.internal;
  }
}
