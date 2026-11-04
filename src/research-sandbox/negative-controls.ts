/**
 * Step A2 (M1 evidence): deliberate-failure ("negative control") runs of the
 * existing preflight on the real host. Each control changes exactly ONE
 * recorded security pin (or, for the runc control, the runtime choice) in an
 * in-memory copy of the approved specification and runs the unchanged
 * runPreflight. A control PASSES only when the preflight refuses for the
 * expected reason at the expected stage; anything else (including an
 * unexpected pass) fails the whole run. This shows the checks are live on
 * this host rather than vacuous. Nothing on the host is changed; containers
 * are created and removed exactly as in a normal preflight run, and the run
 * stops at the first control whose cleanup was not verified.
 *
 * The baseline (unchanged pins) must first end exactly at the M1/M3
 * blockers. The runc control also checks the host process observer itself:
 * under a shared-kernel runtime the canary MUST appear as a host process.
 * Untrusted input is never involved: every container runs the canary probe.
 */

import { MEETS_SPEC_BLOCKERS, runPreflight, type PreflightOptions, type PreflightResult } from "./preflight.js";
import { RUNNER_EXIT, RunnerConfigError, parseRunnerConfig, type RunnerDeps } from "./runner.js";
import { containerName, expectedRunPaths, resolveSpec, SandboxSpecError, type SandboxSpec } from "./spec.js";

export const NEGATIVE_CONTROLS_CONFIRM_FLAG = "--confirm-docker-access";

export interface NegativeControl {
  readonly name: string;
  readonly change: string;
  readonly spec: SandboxSpec;
  /** null when the result is exactly as expected; otherwise why the control failed. */
  readonly check: (r: PreflightResult) => string | null;
}
export interface NegativeControlOutcome {
  readonly name: string;
  readonly change: string;
  readonly passed: boolean;
  readonly detail: string;
  readonly rating: PreflightResult["rating"];
  readonly lastStep: string | null;
  readonly firstViolation: string | null;
}

const printable = (s: string, max = 240) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
/** A different value of the same shape: the last hex digit (or digit) changed. */
export const flipHex = (h: string) => h.slice(0, -1) + (h.slice(-1) === "0" ? "1" : "0");
const flipDigit = (v: string) => v.replace(/(\d)(?!.*\d)/, (d) => String((Number(d) + 1) % 10));
const freeze = (s: Record<string, unknown>) => Object.freeze(s) as unknown as SandboxSpec;
const cleanOk = (r: PreflightResult) => r.cleanup === null || r.cleanup.verifiedRemoved;
const has = (r: PreflightResult, re: RegExp) => r.violations.some((v) => re.test(v));
const last = (r: PreflightResult) => r.steps[r.steps.length - 1] ?? null;

/** Refused for the expected reason, never created/started where that must not happen, cleanup verified. */
function refusal(re: RegExp, opts: { notReached?: string; lastStep?: string; reached?: string }) {
  return (r: PreflightResult): string | null => {
    if (r.rating !== "refused" || r.allowsUntrustedInput) return `expected a refusal, got ${r.rating}`;
    if (r.violations.length === MEETS_SPEC_BLOCKERS.length && r.violations.every((v, i) => v === MEETS_SPEC_BLOCKERS[i])) return "the changed pin was NOT detected (refused only by the M1/M3 blockers)";
    if (!has(r, re)) return `refused, but not for the expected reason (${String(re)})`;
    if (opts.notReached && r.steps.includes(opts.notReached)) return `refused too late: step "${opts.notReached}" was reached`;
    if (opts.reached && !r.steps.includes(opts.reached)) return `step "${opts.reached}" was not reached`;
    if (opts.lastStep && last(r) !== opts.lastStep) return `expected to stop at "${opts.lastStep}", stopped at "${last(r)}"`;
    if (!cleanOk(r)) return "cleanup was not verified";
    return null;
  };
}

/** The baseline and one control per security pin (controls whose pin is not recorded are omitted). */
export function buildNegativeControls(spec: SandboxSpec): NegativeControl[] {
  const base = spec as unknown as Record<string, unknown>;
  const image = spec.image as unknown as Record<string, unknown>;
  const controls: NegativeControl[] = [{
    name: "baseline", change: "none (the approved pins)", spec,
    check: (r) => {
      if (!(r.rating === "refused" && last(r) === "meets-spec-blocked" && r.violations.length === MEETS_SPEC_BLOCKERS.length && r.violations.every((v, i) => v === MEETS_SPEC_BLOCKERS[i]))) {
        return `the baseline must be refused only by the M1/M3 blockers (got ${r.rating}, stopped at "${last(r)}")`;
      }
      const h = r.hostProcessEvidence;
      if (h === null || h.sandboxProcesses < 1 || h.canaryOnHost !== 0) return `host process evidence missing or wrong (${JSON.stringify(h)})`;
      return cleanOk(r) ? null : "cleanup was not verified";
    },
  }];
  if (spec.dockerServerVersion !== null) {
    controls.push({ name: "docker-server-version", change: `dockerServerVersion -> ${flipDigit(spec.dockerServerVersion)}`,
      spec: freeze({ ...base, dockerServerVersion: flipDigit(spec.dockerServerVersion) }), check: refusal(/server version|ServerVersion/i, { notReached: "create" }) });
  }
  if (spec.runscBinary !== null) {
    const rb = spec.runscBinary;
    controls.push({ name: "runsc-sha256", change: "runscBinary.sha256 -> one hex digit changed",
      spec: freeze({ ...base, runscBinary: Object.freeze({ ...rb, sha256: flipHex(rb.sha256) }) }), check: refusal(/SHA-256 does not match the recorded approved file/, { notReached: "create" }) });
    if (rb.sidecars.length > 0) {
      const sidecars = rb.sidecars.map((s, i) => (i === 0 ? Object.freeze({ ...s, sha256: flipHex(s.sha256) }) : s));
      controls.push({ name: "sidecar-sha256", change: `sidecar ${rb.sidecars[0].path} sha256 -> one hex digit changed`,
        spec: freeze({ ...base, runscBinary: Object.freeze({ ...rb, sidecars: Object.freeze(sidecars) }) }), check: refusal(/SHA-256 does not match the recorded approved file/, { notReached: "create" }) });
    }
  }
  if (spec.image.id !== null) {
    controls.push({ name: "image-id", change: "imageId -> one hex digit changed (an image that does not exist)",
      spec: freeze({ ...base, image: Object.freeze({ ...image, id: flipHex(spec.image.id) }) }), check: refusal(/./, { notReached: "canary" }) });
  }
  if (spec.image.canaryManifestDigest !== null) {
    controls.push({ name: "canary-manifest-digest", change: "canaryManifestDigest -> one hex digit changed",
      spec: freeze({ ...base, image: Object.freeze({ ...image, canaryManifestDigest: flipHex(spec.image.canaryManifestDigest) }) }), check: refusal(/ImageManifestDescriptor/, { notReached: "canary" }) });
  }
  if (spec.gvisorProcVersion !== null) {
    controls.push({ name: "gvisor-fingerprint", change: "gvisorProcVersion -> one character added",
      spec: freeze({ ...base, gvisorProcVersion: `${spec.gvisorProcVersion}x` }), check: refusal(/gVisor evidence: the container \/proc\/version does not match/, { reached: "canary", lastStep: "gvisor-unverified" }) });
  }
  controls.push({
    name: "runc-instead-of-gvisor", change: "isolating runtimes removed (Docker's default runc runs the canary)",
    spec: freeze({ ...base, isolatingRuntimes: Object.freeze([]) }),
    check: (r) => {
      if (r.allowsUntrustedInput || r.rating === "meets-spec") return `runc must never allow untrusted input (got ${r.rating})`;
      if (r.runtime !== "runc") return `expected the runc runtime, got ${String(r.runtime)}`;
      const h = r.hostProcessEvidence;
      if (h === null || h.canaryOnHost < 1) return `the host process observer did NOT see the canary as a host process under runc (${JSON.stringify(h)}); it can't be trusted to show its absence under gVisor`;
      return cleanOk(r) ? null : "cleanup was not verified";
    },
  });
  return controls;
}

/** Runs the controls in order; stops after a control whose cleanup was not verified, or after a failed baseline. */
export async function runNegativeControls(options: Omit<PreflightOptions, "spec" | "probeCommand">, spec: SandboxSpec,
  preflight: (o: PreflightOptions) => Promise<PreflightResult> = runPreflight): Promise<NegativeControlOutcome[]> {
  // Only the pinned canary may ever run: a caller-supplied command (which the runc control would run on the
  // shared kernel) is refused outright, and any such key is stripped from what reaches the preflight.
  if ((options as { probeCommand?: unknown }).probeCommand !== undefined) throw new Error("negative controls never accept a probe command (only the pinned canary runs)");
  const { probeCommand: _ignored, ...safe } = options as PreflightOptions;
  const out: NegativeControlOutcome[] = [];
  for (const c of buildNegativeControls(spec)) {
    let r: PreflightResult;
    try { r = await preflight({ ...safe, spec: c.spec }); } catch (err) {
      out.push({ name: c.name, change: c.change, passed: false, detail: `the preflight threw: ${printable(String((err as Error)?.message ?? err))}`, rating: "refused", lastStep: null, firstViolation: null });
      break;
    }
    const why = c.check(r);
    out.push({ name: c.name, change: c.change, passed: why === null, detail: why ?? "as expected", rating: r.rating, lastStep: last(r),
      firstViolation: r.violations[0] === undefined ? null : printable(r.violations[0]) });
    if (!cleanOk(r) || (c.name === "baseline" && why !== null)) break;
  }
  return out;
}

export const NEGATIVE_CONTROLS_USAGE = [
  "Research sandbox negative controls (Step A2). Operator-invoked only, on the approved host.",
  "",
  `  negative-controls-main.js --config <absolute path to the runner configuration .json> ${NEGATIVE_CONTROLS_CONFIRM_FLAG} [--output text|json]`,
  "",
  "Runs the preflight once with the approved pins and once per deliberately wrong pin; each wrong pin must be refused.",
  "Each run creates and removes one canary container (--pull never). Exit 0 only when every control behaved as expected.",
  "",
].join("\n");

/** One operator invocation; returns the exit code. Never throws. */
export async function runNegativeControlsCommand(argv: readonly string[], deps: RunnerDeps): Promise<number> {
  const usage = (m: string) => { deps.err(`Usage error: ${m}\n\n${NEGATIVE_CONTROLS_USAGE}`); return RUNNER_EXIT.usage; };
  try {
    let configPath: string | null = null;
    let output: "text" | "json" = "text";
    let confirmed = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === NEGATIVE_CONTROLS_CONFIRM_FLAG && !confirmed) confirmed = true;
      else if ((a === "--config" && configPath === null) || a === "--output") {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) return usage(`${a} needs a value`);
        i += 1;
        if (a === "--config") configPath = v;
        else if (v === "text" || v === "json") output = v;
        else return usage("--output must be text or json");
      } else return usage(`unrecognised or repeated argument ${JSON.stringify(printable(String(a), 40))}`);
    }
    if (configPath === null || !/^(\/[A-Za-z0-9._-]+)+$/.test(configPath)) return usage("--config <absolute path> is required");
    if (!confirmed) return usage(`missing ${NEGATIVE_CONTROLS_CONFIRM_FLAG}`);
    if (deps.hostProcesses === undefined) return usage("internal: no host process observer");
    let spec: SandboxSpec;
    let config;
    try {
      config = parseRunnerConfig(deps.readConfig(configPath));
      spec = resolveSpec(Object.fromEntries(Object.entries(config.pins).filter(([, v]) => v !== null)));
    } catch (err) {
      const problems = err instanceof RunnerConfigError ? err.problems : err instanceof SandboxSpecError ? err.violations : [String((err as Error)?.message ?? err)];
      deps.err(`Refused before any engine call (configuration):\n${problems.map((p) => `- ${printable(p)}`).join("\n")}\n`);
      return RUNNER_EXIT.usage;
    }
    const outcomes = await runNegativeControls({
      engine: deps.createEngine(config.engineBinary, config.engineConfigDir), run: { runId: config.runId, ...expectedRunPaths(spec, config.runId) },
      hostCanaryPath: config.hostCanaryPath, hostFs: deps.hostFs, hostPolicy: { operatorUid: config.operatorUid, outputOwnerUid: config.outputOwnerUid },
      hostProcesses: deps.hostProcesses,
    }, spec, deps.preflight ?? runPreflight);
    const expected = buildNegativeControls(spec).length;
    const allPassed = outcomes.length === expected && outcomes.every((o) => o.passed);
    if (output === "json") deps.out(`${JSON.stringify({ runner: "research-sandbox-negative-controls", runId: config.runId, allPassed, expected, outcomes }, null, 2)}\n`);
    else {
      deps.out([`Negative controls: ${outcomes.filter((o) => o.passed).length}/${expected} behaved as expected${allPassed ? "" : " (FAILED)"}.`, "",
        ...outcomes.map((o) => `  ${o.passed ? "ok  " : "FAIL"}  ${o.name}: ${o.change}\n        -> ${o.rating}, stopped at ${o.lastStep ?? "(none)"}; ${o.detail}${o.firstViolation ? `\n        first problem: ${o.firstViolation}` : ""}`),
        "", allPassed ? "RESULT: every deliberately wrong pin was refused; the approved pins reached only the M1/M3 blockers." :
          `RESULT: FAILED. Check for a leftover container named ${containerName(config.runId, "canary")} before anything else.`, ""].join("\n"));
    }
    return allPassed ? 0 : RUNNER_EXIT.refused;
  } catch (err) {
    try { deps.err(`Internal error: ${printable(String((err as Error)?.message ?? err), 300)}\n`); } catch { /* nothing more */ }
    return RUNNER_EXIT.internal;
  }
}
