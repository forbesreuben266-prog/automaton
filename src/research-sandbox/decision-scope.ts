/**
 * The scope of the owner's M1/M3 decision (docs/M1-M3-DECISION.md: D1-D8 accepted on 2026-11-05 for the owner's
 * current VPS only). preflight.ts lifts the M1/M3 blockers ONLY for a configuration that matches every item here;
 * anything else (another Docker version or daemon runtime set, another runsc binary, sidecar, gVisor reference,
 * image or data root, a rootless or non-Docker engine) is still refused by them.
 *
 * Values come from the committed E1b evidence (docs/evidence/e1b-*.json). The host pins that evidence does not
 * contain (runsc and sidecar SHA-256, gVisor /proc/version reference) were recorded on 2026-11-06 from the VPS's
 * approved runner configuration, after a read-only check (owner-run) reported it byte-identical to the E1b run's
 * copy, every pinned file on disk matching its hash, and the Docker configuration unchanged since E1b. A null host
 * pin means "not recorded": NO configuration is then in scope.
 *
 * This is configuration binding, not host identification: a different machine set up with byte-identical binaries,
 * configuration and image would match. Pure data and checks only (no I/O). Changing anything here is a reviewed
 * code change guarded by blocker-governance.test.ts.
 */

import type { EngineInfo } from "./engine.js";
import type { SandboxSpec } from "./spec.js";

export interface DecisionScope {
  readonly record: string;
  readonly dockerServerVersion: string;
  readonly seccompProfile: string;
  readonly runtime: string;
  readonly runscPath: string;
  readonly runscArgs: readonly string[];
  /** The exact set of runtimes the daemon reports (`docker info` Runtimes); an added runtime is out of scope. */
  readonly daemonRuntimes: readonly string[];
  readonly dockerDataRoot: string;
  /** The research image the preflight canary and the job both run (image ID). */
  readonly imageId: string;
  /** Host pins from the VPS runner configuration; null = not yet recorded (nothing is in scope). */
  readonly runscSha256: string | null;
  readonly sidecars: readonly { readonly path: string; readonly sha256: string }[] | null;
  readonly gvisorProcVersion: string | null;
}

export const ACCEPTED_DECISION_SCOPE: DecisionScope = Object.freeze({
  record: "docs/M1-M3-DECISION.md",
  dockerServerVersion: "29.9.3",
  seccompProfile: "builtin",
  runtime: "runsc",
  runscPath: "/usr/bin/runsc",
  runscArgs: Object.freeze(["--oci-seccomp"]),
  daemonRuntimes: Object.freeze(["io.containerd.runc.v2", "runc", "runsc"]),
  dockerDataRoot: "/var/lib/docker",
  imageId: "sha256:3e8a7371ba841599f91a259089fd4bad1e0e5e0bda7feba0518a555b5e6d46c5",
  runscSha256: "c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098",
  sidecars: Object.freeze([
    Object.freeze({ path: "/usr/bin/gvisor-bin/checkpointgofer", sha256: "37e6e92d6dcb3296e10dc2f21b0ef6156f1373ff0668d27a4fccc8ded2b51f94" }),
    Object.freeze({ path: "/usr/bin/gvisor-bin/gvisor-proc-umounter", sha256: "b3bbbaef5ddc62084e5febd19d3acca14f3d42b2a25d8552fb40def699467019" }),
    Object.freeze({ path: "/usr/bin/gvisor-bin/gvisor-sentry-prewarmer", sha256: "046e3ec1de3aa7b7ec7ce53b4f0d1e08db15987847606a8e361133d5c5bd3d73" }),
    Object.freeze({ path: "/usr/bin/gvisor-bin/gvisor_sentry", sha256: "6dfd3af65e664663f332d0e4b9fb82452496e34ebc6cb568ae49f5b1ac9d8166" }),
    Object.freeze({ path: "/usr/bin/gvisor-bin/runsc-fd-parking", sha256: "03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11" }),
    Object.freeze({ path: "/usr/bin/gvisor-bin/runsc-metric-server", sha256: "b9857ebe290c403fda7ff014368df3a0f45e5428dc1eb6efe413cfe0e5a940f4" }),
    Object.freeze({ path: "/usr/bin/containerd-shim-runsc-v1", sha256: "6187d6d34f4996e859353fbb4c56d5ed41fc35b5afa44bff766f4e4b424da5bb" }),
    Object.freeze({ path: "/etc/containerd/runsc.toml", sha256: "ea5ada6422655b972fd3af73f7a23b88cc3385c98767cca2f360b2aa749d114c" }),
  ]),
  gvisorProcVersion: "Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016",
});

const sameList = (a: readonly unknown[] | null | undefined, b: readonly unknown[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const sorted = (xs: readonly string[]) => [...xs].sort();

/**
 * Why a configuration is outside the decision scope (empty = inside it). spec: the operator's pinned configuration;
 * runtime: the runtime the preflight chose; info: the daemon's report (null = none, out of scope).
 */
export function decisionScopeProblems(spec: SandboxSpec, runtime: string | null, info: EngineInfo | null, scope: DecisionScope = ACCEPTED_DECISION_SCOPE): string[] {
  const p: string[] = [];
  const s = scope;
  if (runtime !== s.runtime) p.push(`runtime ${JSON.stringify(runtime)} is not ${s.runtime}`);
  if (spec?.dockerServerVersion !== s.dockerServerVersion) p.push(`Docker server version pin ${JSON.stringify(spec?.dockerServerVersion ?? null)} is not ${s.dockerServerVersion}`);
  if (spec?.seccompProfile !== s.seccompProfile) p.push(`seccomp profile is not ${s.seccompProfile}`);
  if (spec?.dockerDataRoot !== s.dockerDataRoot) p.push(`Docker data root pin is not ${s.dockerDataRoot}`);
  if (spec?.image?.id !== s.imageId) p.push(`image ID pin is not the reviewed research image ${s.imageId}`);
  const rb = spec?.runscBinary ?? null;
  if (rb === null || rb.path !== s.runscPath) p.push(`runsc binary pin is not ${s.runscPath}`);
  if (rb === null || !sameList(rb.args, s.runscArgs)) p.push(`runsc arguments are not ${JSON.stringify(s.runscArgs)}`);
  if (s.runscSha256 === null) p.push("the decision's runsc SHA-256 has not been recorded");
  else if (rb === null || rb.sha256 !== s.runscSha256) p.push("runsc SHA-256 pin is not the reviewed binary");
  if (s.sidecars === null) p.push("the decision's runsc sidecar hashes have not been recorded");
  else {
    const key = (xs: readonly { path: string; sha256: string }[]) => sorted(xs.map((x) => `${x.path} ${x.sha256}`));
    if (rb === null || !Array.isArray(rb.sidecars) || !sameList(key(rb.sidecars), key(s.sidecars))) p.push("runsc sidecar pins are not the reviewed files");
  }
  if (s.gvisorProcVersion === null) p.push("the decision's gVisor reference has not been recorded");
  else if (spec?.gvisorProcVersion !== s.gvisorProcVersion) p.push("gVisor reference pin is not the reviewed one");
  if (info === null || typeof info !== "object") p.push("no daemon report");
  else {
    if (info.engine !== "docker" || info.rootless !== false) p.push("the daemon is not rootful Docker");
    if (info.serverVersion !== s.dockerServerVersion) p.push(`the daemon reports Docker ${JSON.stringify(info.serverVersion ?? null)}, not ${s.dockerServerVersion}`);
    if (info.seccompProfile !== s.seccompProfile) p.push(`the daemon's seccomp profile is not ${s.seccompProfile}`);
    if (!sameList(Array.isArray(info.runtimes) ? sorted(info.runtimes) : null, sorted(s.daemonRuntimes))) p.push(`the daemon's runtimes ${JSON.stringify(info.runtimes)} are not exactly ${JSON.stringify(s.daemonRuntimes)}`);
    const rc = (info.runtimeConfigs as Record<string, any> | undefined)?.[s.runtime];
    if (!rc || typeof rc !== "object" || rc.path !== s.runscPath || !sameList(rc.runtimeArgs, s.runscArgs) || Object.keys(rc).some((k) => !["path", "runtimeArgs", "status"].includes(k))) {
      p.push(`the daemon's ${s.runtime} configuration is not { path: ${s.runscPath}, runtimeArgs: ${JSON.stringify(s.runscArgs)} } (plus an optional status)`);
    }
  }
  return p;
}
