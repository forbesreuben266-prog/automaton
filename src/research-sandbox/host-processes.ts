/**
 * Step A3 (M1 evidence): host-side observation of WHICH host processes run
 * the canary. While the canary runs, the preflight samples the host's /proc
 * (read-only). Under gVisor the canary's node process lives inside the
 * Sentry, so no host process has the canary command line; the host instead
 * shows runsc processes (the sandbox and gofer, executables = the recorded
 * runsc binary or a recorded sidecar) whose command line names the container
 * id. Under runc the canary's node process is an ordinary host process.
 *
 * Privacy: only processes whose command line mentions the container id or
 * the canary script are kept, and for each only its pid, executable path,
 * argv[0] basename and two booleans. No other process, argument value or
 * environment is recorded.
 *
 * This is daemon-independent evidence (the host kernel's own process table),
 * but it is not proof against a malicious root: root can fake /proc views.
 */

import fs from "node:fs";

export const CANARY_SCRIPT = "/app/canary-probe.js";
/** Minimum /proc samples during the canary for the observation to count (fail closed below it). */
export const MIN_HOST_PROCESS_POLLS = 10;
const POLL_INTERVAL_MS = 20;
const MAX_KEPT = 64;

export interface HostProcessSample {
  readonly pid: number;
  /** Resolved executable path, or null when it could not be read. */
  readonly exe: string | null;
  readonly argv0: string;
  readonly mentionsContainer: boolean;
  readonly runsCanaryScript: boolean;
  /** gVisor's long-lived per-container processes: the sandbox ("boot") and the gofer; anything else is "other". */
  readonly role: "boot" | "gofer" | "other";
}
export interface HostProcessObservation {
  readonly polls: number;
  readonly samples: readonly HostProcessSample[];
  /** True when more matching processes were seen than are kept (the observation is then incomplete: refused). */
  readonly overflow: boolean;
  /** /proc entries that vanished or could not be read during sampling (normal for short-lived processes). */
  readonly unreadable: number;
}
export interface HostProcessObserver {
  /** Starts sampling for processes mentioning containerId or the canary script; stop() ends it. */
  start(containerId: string): { stop(): HostProcessObservation };
}
export interface HostProcessEvidence {
  readonly polls: number;
  /** Processes naming THIS container, running a recorded gVisor file, in the boot or gofer role. */
  readonly sandboxProcesses: number;
  readonly canaryOnHost: number;
  /** Matching processes whose executable file was deleted or replaced while running. */
  readonly replacedExecutables: number;
  readonly overflow: boolean;
  readonly executables: readonly string[];
}

/** Minimal /proc access, injectable for tests. */
export interface ProcFs {
  readonly listPids: () => number[];
  readonly cmdline: (pid: number) => Buffer;
  readonly exe: (pid: number) => string;
}
export const nodeProcFs: ProcFs = {
  listPids: () => fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number),
  cmdline: (pid) => fs.readFileSync(`/proc/${pid}/cmdline`),
  exe: (pid) => fs.readlinkSync(`/proc/${pid}/exe`),
};

/** One pass over /proc: the matching processes. Exported for tests. */
export function sampleOnce(proc: ProcFs, containerId: string): { samples: HostProcessSample[]; unreadable: number } {
  const samples: HostProcessSample[] = [];
  let unreadable = 0;
  for (const pid of proc.listPids()) {
    let argv: string[];
    try { argv = proc.cmdline(pid).toString("utf8").split("\0").filter((a) => a.length > 0); } catch { unreadable += 1; continue; }
    const mentionsContainer = argv.some((a) => a.includes(containerId));
    const runsCanaryScript = argv.some((a) => a === CANARY_SCRIPT || a.endsWith(CANARY_SCRIPT));
    if (!mentionsContainer && !runsCanaryScript) continue;
    let exe: string | null = null;
    try { exe = proc.exe(pid); } catch { exe = null; }
    const argv0 = (argv[0] ?? "").split("/").pop()!.replace(/[^\x20-\x7e]/g, "?").slice(0, 64);
    const role = argv.includes("boot") ? "boot" : argv.includes("gofer") ? "gofer" : "other";
    // A " (deleted)" suffix means the executable was replaced or removed while running: kept as is, so it never matches a recorded file.
    samples.push({ pid, exe, argv0, mentionsContainer, runsCanaryScript, role });
  }
  return { samples, unreadable };
}

/** The real observer: samples /proc every 20 ms until stopped. */
export function procHostProcessObserver(proc: ProcFs = nodeProcFs): HostProcessObserver {
  return {
    start(containerId: string) {
      let polls = 0;
      let unreadable = 0;
      let overflow = false;
      const kept = new Map<string, HostProcessSample>();
      const poll = () => {
        try {
          const r = sampleOnce(proc, containerId);
          polls += 1;
          unreadable += r.unreadable;
          for (const s of r.samples) {
            const key = `${s.pid}|${s.exe}|${s.argv0}|${s.mentionsContainer}|${s.runsCanaryScript}|${s.role}`;
            if (kept.size < MAX_KEPT || kept.has(key)) kept.set(key, s);
            else overflow = true;
          }
        } catch { unreadable += 1; }
      };
      poll();
      const timer = setInterval(poll, POLL_INTERVAL_MS);
      return {
        stop() { clearInterval(timer); poll(); return { polls, samples: [...kept.values()], unreadable, overflow }; },
      };
    },
  };
}

/** Summary of an observation for the given runtime executables (the recorded runsc binary and its sidecars). */
export function summarizeHostProcesses(obs: HostProcessObservation, runtimeExecutables: readonly string[]): HostProcessEvidence {
  const isRuntime = (s: HostProcessSample) => s.exe !== null && runtimeExecutables.includes(s.exe);
  const sandbox = new Set(obs.samples.filter((s) => s.mentionsContainer && isRuntime(s) && s.role !== "other").map((s) => s.pid));
  const canary = new Set(obs.samples.filter((s) => s.runsCanaryScript && !isRuntime(s)).map((s) => s.pid));
  const replaced = new Set(obs.samples.filter((s) => s.exe !== null && / \(deleted\)$/.test(s.exe)).map((s) => s.pid));
  return {
    polls: obs.polls, sandboxProcesses: sandbox.size, canaryOnHost: canary.size, replacedExecutables: replaced.size, overflow: obs.overflow === true,
    executables: [...new Set(obs.samples.filter((s) => s.mentionsContainer || s.runsCanaryScript).map((s) => s.exe ?? "(unreadable)"))].sort().slice(0, 16),
  };
}

/**
 * Isolating runtime requirements (fail closed): enough samples; at least one
 * host process naming the container id whose executable is a recorded gVisor
 * file; and NO host process running the canary script outside those files.
 */
export function hostProcessViolations(e: HostProcessEvidence): string[] {
  const v: string[] = [];
  if (e.polls < MIN_HOST_PROCESS_POLLS) v.push(`host processes: only ${e.polls} samples while the canary ran (at least ${MIN_HOST_PROCESS_POLLS} required)`);
  if (e.sandboxProcesses < 1) v.push(`host processes: no gVisor sandbox or gofer process naming the container ran from the recorded runsc binary or a recorded sidecar (seen: ${JSON.stringify(e.executables)})`);
  if (e.canaryOnHost > 0) v.push(`host processes: the canary script ran as ${e.canaryOnHost} ordinary host process(es) (a shared-kernel runtime, not gVisor)`);
  if (e.replacedExecutables > 0) v.push(`host processes: ${e.replacedExecutables} matching process(es) ran an executable that was deleted or replaced while running`);
  if (e.overflow) v.push("host processes: more matching processes than can be recorded (incomplete observation)");
  return v;
}
