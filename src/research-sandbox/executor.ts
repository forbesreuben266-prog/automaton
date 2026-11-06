/**
 * E1: the sandbox executor. Runs ONE operator-approved offline research job
 * (the research CLI's trading validate/backtest on operator-staged files) in
 * the verified gVisor sandbox, and returns its report as untrusted text plus
 * an audit record. Fail closed, in this order:
 *
 *  1. the job file is strict JSON (no unknown or duplicate keys) naming only
 *     plain .json input files; the command line is fixed (never caller text);
 *  2. the run's input folder holds exactly those files: regular, not links,
 *     owned by root or the operator, not group/other writable, within size
 *     limits; hashed; the output folder is empty;
 *  3. a FRESH preflight runs (canary from the same pinned image), then the
 *     GATE: assertUntrustedInputAllowed must accept the result for this exact
 *     run, image and security arguments. Outside the accepted M1/M3 decision
 *     scope (ACCEPTED_DECISION_SCOPE, docs/M1-M3-DECISION.md) it always
 *     refuses, so no research container is ever created there;
 *  4. re-checks after the gate: inputs unchanged, run folders valid, Docker
 *     version, runtime configuration and runtime binary equal to what the
 *     preflight bound;
 *  5. create with the same pinned flags (purpose "run"), full inspect, host
 *     files, host process observer during the run (gVisor processes for this
 *     container; the research script never a host process), timeout and
 *     output caps, re-inspect after exit (exit 0 or 1 only), host files;
 *  6. the output folder must still be empty (the CLI writes nothing; any file
 *     there is refused and never read);
 *  7. removal is always attempted and verified; the runtime binary and
 *     configuration are re-checked after the run;
 *  8. the report (standard output) is returned with every character outside
 *     printable ASCII, newline and tab replaced, plus its SHA-256. It is
 *     untrusted: nothing executes or renders it automatically.
 * There is no override, skip or trust option. Exit-code meaning is decided by
 * executor-main.ts.
 */

import { createHash } from "node:crypto";
import type { ContainerEngine } from "./engine.js";
import { canonicalRuntimeConfig, runtimeConfigProblems, sameRuntimeBinary, verifyContainerHostFiles, verifyRunDirectories, verifyRuntimeBinary, type HostFs, type HostPathPolicy } from "./host-paths.js";
import { hostProcessViolations, summarizeHostProcesses, type HostProcessEvidence, type HostProcessObserver } from "./host-processes.js";
import { validateFinishedInspect, validateInspect } from "./inspect.js";
import { IsolationRefusedError, assertUntrustedInputAllowed, removeAndVerify, runPreflight, type CleanupOutcome, type PreflightOptions, type PreflightResult } from "./preflight.js";
import { RESEARCH_SCRIPT } from "./research-image.js";
import { buildCreateArgs, containerName, imageReference, securityArgsHash, type RunPaths, type SandboxSpec } from "./spec.js";
import { duplicateJsonKey } from "./trust-evidence.js";

export const RESEARCH_JOB_VERSION = 1;
export const MAX_JOB_FILE_BYTES = 4096;
/** The research CLI's own input limits (trading-files.ts), tighter than the spec's. */
export const MAX_DATASET_BYTES = 10_000_000;
export const MAX_CONFIG_BYTES = 10_000;
/** Standard-output cap for a research job (the report). */
export const MAX_REPORT_BYTES = 1024 * 1024;
const RUN_TIMEOUT_CAP_MS = 300_000;
const JOB_FILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}\.json$/;
const COMMANDS = Object.freeze({ "trading-validate": "validate", "trading-backtest": "backtest" } as const);
export type ResearchCommand = keyof typeof COMMANDS;

export class ResearchJobError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Research job refused:\n- ${problems.join("\n- ")}`);
    this.name = "ResearchJobError";
  }
}

export interface ResearchJob {
  readonly command: ResearchCommand;
  readonly dataset: string;
  /** Required for trading-backtest; null for trading-validate. */
  readonly config: string | null;
}

/** Parses a job file: {"version":1,"command":"trading-validate"|"trading-backtest","dataset":"<f>.json"[,"config":"<f>.json"]}. */
export function parseResearchJob(text: unknown): ResearchJob {
  if (typeof text !== "string") throw new ResearchJobError(["job: must be text"]);
  if (Buffer.byteLength(text, "utf8") > MAX_JOB_FILE_BYTES) throw new ResearchJobError([`job: larger than ${MAX_JOB_FILE_BYTES} bytes`]);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ResearchJobError(["job: not valid JSON"]); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ResearchJobError(["job: must be a JSON object"]);
  const dup = duplicateJsonKey(text);
  if (dup !== null) throw new ResearchJobError([`job: repeats the key ${JSON.stringify(dup).slice(0, 40)}`]);
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  const command = o.command;
  const allowed = command === "trading-backtest" ? ["version", "command", "dataset", "config"] : ["version", "command", "dataset"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`job: "${k.replace(/[^\x20-\x7e]/g, "?").slice(0, 32)}" is not allowed here`);
  if (o.version !== RESEARCH_JOB_VERSION) problems.push(`job: version must be ${RESEARCH_JOB_VERSION}`);
  if (command !== "trading-validate" && command !== "trading-backtest") problems.push('job: command must be "trading-validate" or "trading-backtest"');
  if (typeof o.dataset !== "string" || !JOB_FILE_NAME.test(o.dataset)) problems.push("job: dataset must be a plain lower-case .json file name");
  if (command === "trading-backtest" && (typeof o.config !== "string" || !JOB_FILE_NAME.test(o.config))) problems.push("job: config must be a plain lower-case .json file name");
  if (command === "trading-backtest" && o.config === o.dataset) problems.push("job: dataset and config must be different files");
  if (problems.length > 0) throw new ResearchJobError(problems);
  return Object.freeze({ command: command as ResearchCommand, dataset: o.dataset as string, config: command === "trading-backtest" ? (o.config as string) : null });
}

/** The fixed command line run inside the container (no caller-supplied text other than validated file names). */
export function researchCommand(job: ResearchJob, spec: SandboxSpec): string[] {
  return ["node", RESEARCH_SCRIPT, "trading", COMMANDS[job.command], "--data-root", spec.mountPoints.input, "--repo-root", "/app", "--dataset", job.dataset,
    ...(job.config === null ? [] : ["--config", job.config])];
}

export interface JobInput { readonly name: string; readonly sha256: string; readonly size: number; readonly dev: string; readonly ino: string }

/** The input folder must hold exactly the job's files, each safe and within limits; returns their identities. */
export function checkJobInputs(job: ResearchJob, run: RunPaths, spec: SandboxSpec, hostFs: HostFs, policy: HostPathPolicy): { violations: string[]; inputs: JobInput[] } {
  const v: string[] = [];
  const wanted = [job.dataset, ...(job.config === null ? [] : [job.config])];
  let listing: string[];
  try { listing = hostFs.readdir(run.inputDir); } catch (err) { return { violations: [`input folder: cannot be listed (${(err as NodeJS.ErrnoException).code ?? "error"})`], inputs: [] }; }
  const extra = listing.filter((n) => !wanted.includes(n));
  if (extra.length > 0) v.push(`input folder: holds files the job does not name (${extra.length}); it must hold exactly the job's files`);
  const inputs: JobInput[] = [];
  let total = 0;
  for (const name of wanted) {
    const path = `${run.inputDir}/${name}`;
    const cap = Math.min(spec.maxInputFileBytes, name === job.config ? MAX_CONFIG_BYTES : MAX_DATASET_BYTES);
    if (!listing.includes(name)) { v.push(`input ${name}: missing`); continue; }
    try {
      const st = hostFs.lstat(path);
      if (st.isSymbolicLink() || !st.isFile()) { v.push(`input ${name}: must be a regular file (no link)`); continue; }
      if (st.uid !== 0 && st.uid !== policy.operatorUid) v.push(`input ${name}: must be owned by root or the operator`);
      if ((st.mode & 0o022) !== 0) v.push(`input ${name}: must not be writable by group or others`);
      const d = hostFs.sha256File(path, cap);
      if (String(d.dev) !== String(st.dev) || String(d.ino) !== String(st.ino)) { v.push(`input ${name}: changed while being checked`); continue; }
      total += d.size;
      inputs.push({ name, sha256: d.sha256, size: d.size, dev: String(d.dev), ino: String(d.ino) });
    } catch (err) {
      v.push(`input ${name}: cannot be checked (${(err as NodeJS.ErrnoException).code ?? "error"}; at most ${cap} bytes)`);
    }
  }
  if (total > spec.maxInputTotalBytes) v.push(`inputs: ${total} bytes in total; the limit is ${spec.maxInputTotalBytes}`);
  return { violations: v, inputs };
}

const sameInputs = (a: readonly JobInput[], b: readonly JobInput[]) => JSON.stringify(a) === JSON.stringify(b);
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
/** Every character outside printable ASCII, newline and tab becomes "?" (the report is untrusted text). */
export const sanitizeReport = (s: string) => s.replace(/[^\x20-\x7e\n\t]/g, "?");

export interface ExecutorOptions {
  readonly engine: ContainerEngine;
  readonly spec: SandboxSpec;
  readonly run: RunPaths;
  readonly hostCanaryPath: string;
  readonly hostFs: HostFs;
  readonly hostPolicy: HostPathPolicy;
  readonly hostProcesses: HostProcessObserver;
  readonly job: ResearchJob;
  /** Text of the job file as read (hashed into the audit record). */
  readonly jobText: string;
  readonly now?: () => string;
}

/**
 * Internals the TESTS replace to reach the post-gate path while the blockers exist. The entry point never passes
 * them (checked by a boundary test); with the defaults the gate refuses while M1/M3 exist.
 */
export interface ExecutorInternals {
  readonly preflight: (o: PreflightOptions) => Promise<PreflightResult>;
  readonly gate: (r: PreflightResult, intended: { spec: SandboxSpec; run: RunPaths }) => void;
}
const DEFAULT_INTERNALS: ExecutorInternals = Object.freeze({ preflight: runPreflight, gate: assertUntrustedInputAllowed });

export interface ExecutorAudit {
  readonly version: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runId: string;
  readonly jobSha256: string;
  readonly command: readonly string[];
  readonly inputs: readonly JobInput[];
  readonly imageRef: string | null;
  readonly runtime: string | null;
  readonly preflight: { readonly rating: string; readonly lastStep: string | null; readonly violations: number } | null;
  readonly containerId: string | null;
  readonly researchExitCode: number | null;
  readonly reportSha256: string | null;
  readonly reportBytes: number | null;
  readonly hostProcessEvidence: HostProcessEvidence | null;
  readonly cleanup: CleanupOutcome | null;
}

export interface ExecutorResult {
  /** completed: the job ran and its report is returned (researchExitCode 0 = done, 1 = the CLI refused the input). */
  readonly status: "completed" | "refused" | "failed";
  readonly violations: readonly string[];
  readonly steps: readonly string[];
  readonly report: string | null;
  readonly audit: ExecutorAudit;
}

export async function runResearchJob(options: ExecutorOptions, internals: ExecutorInternals = DEFAULT_INTERNALS): Promise<ExecutorResult> {
  const { engine, spec, run, hostFs, hostPolicy, job } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const steps: string[] = [];
  const command = researchCommand(job, spec);
  const audit = {
    version: 1 as const, startedAt: now(), finishedAt: "", runId: run.runId, jobSha256: sha256(options.jobText), command, inputs: [] as JobInput[],
    imageRef: null as string | null, runtime: null as string | null, preflight: null as ExecutorAudit["preflight"], containerId: null as string | null,
    researchExitCode: null as number | null, reportSha256: null as string | null, reportBytes: null as number | null,
    hostProcessEvidence: null as HostProcessEvidence | null, cleanup: null as CleanupOutcome | null,
  };
  const done = (status: ExecutorResult["status"], violations: string[], report: string | null = null): ExecutorResult =>
    Object.freeze({ status, violations: Object.freeze([...violations]), steps: Object.freeze([...steps]), report, audit: Object.freeze({ ...audit, finishedAt: now() }) });

  // 1-2. Job and inputs, before any engine call
  try { audit.imageRef = imageReference(spec); } catch { return done("refused", ["image: no pinned image ID is recorded"]); }
  const first = checkJobInputs(job, run, spec, hostFs, hostPolicy);
  if (first.violations.length > 0) return done("refused", first.violations);
  audit.inputs = first.inputs;
  steps.push("inputs-checked");
  const outputEmpty = () => { try { return hostFs.readdir(run.outputDir).length === 0; } catch { return false; } };
  if (!outputEmpty()) return done("refused", ["output folder: must exist and be empty before the job"]);

  // 3. Fresh preflight, then the gate (refuses while M1/M3 exist; nothing is created for the job before it passes)
  let pre: PreflightResult;
  try {
    pre = await internals.preflight({ engine, spec, run, hostCanaryPath: options.hostCanaryPath, hostFs, hostPolicy, hostProcesses: options.hostProcesses });
  } catch (err) {
    return done("failed", [`preflight error: ${String((err as Error)?.message ?? err).slice(0, 300)}`]);
  }
  audit.preflight = { rating: pre.rating, lastStep: pre.steps[pre.steps.length - 1] ?? null, violations: pre.violations.length };
  steps.push("preflight");
  try {
    internals.gate(pre, { spec, run });
  } catch (err) {
    const reasons = err instanceof IsolationRefusedError ? [...err.reasons] : [String((err as Error)?.message ?? err)];
    return done("refused", ["gate: untrusted input is not allowed by this preflight result", ...reasons]);
  }
  steps.push("gate-passed");
  const b = pre.binding;
  const runtime = pre.runtime;
  if (b === null || runtime === null || !spec.isolatingRuntimes.includes(runtime)) return done("refused", ["gate: the preflight result names no isolating runtime"]);
  audit.runtime = runtime;

  // 4. Re-checks after the gate
  const again = checkJobInputs(job, run, spec, hostFs, hostPolicy);
  if (again.violations.length > 0 || !sameInputs(first.inputs, again.inputs)) return done("refused", ["inputs: changed between the first check and the job", ...again.violations]);
  const dirs = verifyRunDirectories(run, spec, hostFs, hostPolicy);
  if (dirs.violations.length > 0) return done("refused", [...dirs.violations]);
  if (!outputEmpty()) return done("refused", ["output folder: no longer empty"]);
  let info;
  try { info = await engine.info(); } catch (err) { return done("failed", [`engine info failed: ${(err as Error).message}`]); }
  if (info.serverVersion !== spec.dockerServerVersion || info.serverVersion !== b.dockerServerVersion) return done("refused", ["Docker server version: differs from the preflight's"]);
  const configProblems = runtimeConfigProblems(info, runtime, spec);
  const config = canonicalRuntimeConfig(info, runtime);
  if (configProblems.length > 0 || config === null) return done("refused", configProblems.length > 0 ? configProblems : ["runtime configuration: not reported"]);
  const bin = verifyRuntimeBinary(info, runtime, spec, hostFs);
  if (bin.violations.length > 0 || bin.identity === null || bin.identity.sha256 !== b.runtimeBinarySha256) return done("refused", bin.violations.length > 0 ? [...bin.violations] : ["runtime binary: differs from the preflight's"]);
  const args = buildCreateArgs(spec, run, runtime, command, "run");
  if (securityArgsHash(args, spec) !== b.securityArgsSha256) return done("refused", ["security arguments: differ from the preflight's binding"]);
  steps.push("rechecked");
  const name = containerName(run.runId, "run");
  try {
    if (await engine.exists(name)) return done("refused", [`a container named ${name} already exists; remove it manually`]);
  } catch (err) { return done("failed", [`could not check for a leftover container: ${(err as Error).message}`]); }

  // 5-6. Create, inspect, run, re-inspect, output folder; 7. always remove and verify
  let id: string | null = null;
  let violations: string[] = [];
  let report: string | null = null;
  try {
    id = await engine.create(args, imageReference(spec));
    steps.push("create");
    const fresh = await engine.info();
    if (canonicalRuntimeConfig(fresh, runtime) !== config) throw new Error("runtime configuration changed after create");
    const inspected = validateInspect(await engine.inspect(id), spec, { run, purpose: "run", command });
    steps.push("inspect");
    if (inspected.violations.length > 0) { violations = [...inspected.violations]; throw null; }
    if (inspected.runtime !== runtime || inspected.containerId === null || !inspected.containerId.startsWith(id)) { violations = ["inspect: runtime or container id differs"]; throw null; }
    audit.containerId = inspected.containerId;
    const files = verifyContainerHostFiles(spec, inspected.containerId, hostFs, inspected.hostFilesPending ? "pending" : "present");
    if (files.length > 0) { violations = files; throw null; }
    const watch = options.hostProcesses.start(inspected.containerId, RESEARCH_SCRIPT);
    let r: Awaited<ReturnType<ContainerEngine["start"]>>;
    try { r = await engine.start(id, Math.min(spec.timeoutMs, RUN_TIMEOUT_CAP_MS), Math.min(spec.maxOutputBytes, MAX_REPORT_BYTES)); }
    finally { audit.hostProcessEvidence = summarizeHostProcesses(watch.stop(), bin.identity ? [bin.identity.path, ...bin.identity.sidecars.map((s) => s.path)] : []); }
    steps.push("run");
    const hv = hostProcessViolations(audit.hostProcessEvidence);
    if (hv.length > 0) { violations = hv; throw null; }
    if (r.timedOut) { violations = ["run: timed out"]; throw null; }
    if (r.truncated) { violations = ["run: report exceeded the output cap"]; throw null; }
    if (r.exitCode !== 0 && r.exitCode !== 1) { violations = [`run: the research CLI exited with ${r.exitCode}${r.signal ? ` (${r.signal})` : ""}`]; throw null; }
    audit.researchExitCode = r.exitCode;
    const finished = validateFinishedInspect(await engine.inspect(id), spec, { run, purpose: "run", containerId: inspected.containerId, runtime, allowedExitCodes: [r.exitCode] });
    steps.push("inspect-after-run");
    if (finished.length > 0) { violations = finished; throw null; }
    const after = verifyContainerHostFiles(spec, inspected.containerId, hostFs, "present");
    if (after.length > 0) { violations = after; throw null; }
    if (!outputEmpty()) { violations = ["output folder: the job left files there (not read; remove them manually after review)"]; throw null; }
    audit.reportSha256 = sha256(Buffer.from(r.stdout, "utf8"));
    audit.reportBytes = Buffer.byteLength(r.stdout, "utf8");
    report = sanitizeReport(r.stdout);
    steps.push("report");
  } catch (err) {
    if (err !== null) violations = [...violations, `executor error: ${String((err as Error)?.message ?? err).slice(0, 300)}`];
  }
  audit.cleanup = await removeAndVerify(engine, id, name);
  steps.push(audit.cleanup.verifiedRemoved ? "removed-verified" : "remove-unverified");
  if (!audit.cleanup.verifiedRemoved) violations = [...violations, `cleanup: ${audit.cleanup.detail} (container ${audit.cleanup.containerId ?? name}; manual cleanup required)`];
  if (violations.length > 0) return done("failed", violations);

  // 7. Runtime re-check after the run
  try {
    const last = await engine.info();
    const end = verifyRuntimeBinary(last, runtime, spec, hostFs);
    if (canonicalRuntimeConfig(last, runtime) !== config || end.identity === null || !sameRuntimeBinary(bin.identity, end.identity)) {
      return done("failed", ["runtime: configuration or binary changed during the job (report withheld)"]);
    }
  } catch (err) { return done("failed", [`engine info failed after the job: ${(err as Error).message}`]); }
  steps.push("runtime-rechecked");
  return done("completed", [], report);
}

// ---------------------------------------------------------------- operator command

export const EXECUTOR_CONFIRM_FLAG = "--confirm-sandboxed-research";
export const EXECUTOR_USAGE = [
  "Research sandbox executor (E1). Operator-invoked only, on the approved host.",
  "",
  `  executor-main.js --config <absolute runner configuration .json> --job <absolute job .json> ${EXECUTOR_CONFIRM_FLAG}`,
  "",
  "Runs a fresh preflight; while the M1/M3 blockers exist the gate ALWAYS refuses and no research container is created.",
  "The job's input files must already be in the run's input folder (exactly those files). Prints one JSON result.",
  "Exit codes: 0 completed (research CLI exit 0); 1 refused, or completed with the research CLI refusing its input; 2 usage or",
  "configuration error (no engine call); 3 failed or internal error (check for a leftover container named research-sandbox-<run>-run).",
  "",
].join("\n");

export interface ExecutorCommandDeps {
  readonly readFile: (path: string) => string;
  readonly parseConfig: (text: string) => { engineBinary: string; engineConfigDir: string; runId: string; hostCanaryPath: string; operatorUid: number; outputOwnerUid: number; pins: Readonly<Record<string, unknown>> };
  readonly resolveSpec: (pins: Record<string, unknown>) => SandboxSpec;
  readonly runPaths: (spec: SandboxSpec, runId: string) => RunPaths;
  readonly createEngine: (binary: string, configDir: string) => ContainerEngine;
  readonly hostFs: HostFs;
  readonly hostProcesses: HostProcessObserver;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** One operator invocation; returns the exit code. Never throws. Uses the default internals only (no gate override). */
export async function runResearchJobCommand(argv: readonly string[], deps: ExecutorCommandDeps): Promise<number> {
  const usage = (m: string) => { deps.err(`Usage error: ${m}\n\n${EXECUTOR_USAGE}`); return 2; };
  const abs = /^(\/[A-Za-z0-9._-]+)+$/;
  try {
    if (argv.length !== 5 || argv[0] !== "--config" || argv[2] !== "--job" || argv[4] !== EXECUTOR_CONFIRM_FLAG) return usage(`expected exactly: --config <path> --job <path> ${EXECUTOR_CONFIRM_FLAG}`);
    if (!abs.test(argv[1]) || !abs.test(argv[3])) return usage("--config and --job must be absolute paths");
    let options: ExecutorOptions;
    try {
      const c = deps.parseConfig(deps.readFile(argv[1]));
      const spec = deps.resolveSpec(Object.fromEntries(Object.entries(c.pins).filter(([, v]) => v !== null)));
      const jobText = deps.readFile(argv[3]);
      options = {
        engine: deps.createEngine(c.engineBinary, c.engineConfigDir), spec, run: deps.runPaths(spec, c.runId), hostCanaryPath: c.hostCanaryPath, hostFs: deps.hostFs,
        hostPolicy: { operatorUid: c.operatorUid, outputOwnerUid: c.outputOwnerUid }, hostProcesses: deps.hostProcesses, job: parseResearchJob(jobText), jobText,
      };
    } catch (err) {
      const problems = (err as { problems?: string[]; violations?: string[] }).problems ?? (err as { violations?: string[] }).violations ?? [String((err as Error)?.message ?? err)];
      deps.err(`Refused before any engine call (configuration or job):\n${problems.map((p) => `- ${String(p).replace(/[^\x20-\x7e]/g, "?").slice(0, 300)}`).join("\n")}\n`);
      return 2;
    }
    const r = await runResearchJob(options);
    deps.out(`${JSON.stringify({ runner: "research-sandbox-executor", ...r }, null, 2)}\n`);
    deps.err(`Research job: ${r.status.toUpperCase()}${r.status === "completed" ? ` (research CLI exit ${r.audit.researchExitCode})` : `: ${String(r.violations[0] ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 200)}`}\n`);
    if (r.status === "completed") return r.audit.researchExitCode === 0 ? 0 : 1;
    return r.status === "refused" ? 1 : 3;
  } catch (err) {
    try { deps.err(`Internal error: ${String((err as Error)?.message ?? err).replace(/[^\x20-\x7e]/g, "?").slice(0, 300)}\n`); } catch { /* nothing more */ }
    return 3;
  }
}
