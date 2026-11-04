/**
 * Step A2 (M1 evidence): deliberate-failure runs. The real runPreflight runs
 * against a fake engine and fake host; each control changes one pin and must
 * be refused for its own reason. A preflight that ignored a pin, or an
 * observer that could not see the canary under runc, must fail the run.
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEETS_SPEC_BLOCKERS, imageReference, runPreflight, type ContainerEngine, type PreflightOptions, type PreflightResult, type ProcessResult, type SandboxSpec } from "../../research-sandbox/index.js";
import { NEGATIVE_CONTROLS_CONFIRM_FLAG, buildNegativeControls, flipHex, runNegativeControls, runNegativeControlsCommand } from "../../research-sandbox/negative-controls.js";
import type { HostProcessObserver } from "../../research-sandbox/host-processes.js";
import {
  CONTAINER_ID, DOCKER_INFO, ENGINE_TARGET, FAKE_RUNSC_PATH, HOST_CANARY, HOST_PROC_VERSION, POLICY, RUN, SPEC, compliantHostLayout, compliantInspect, compliantReport,
  fakeHostFs, finishedInspect,
} from "./fixtures.js";

beforeEach(() => {
  const real = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) => (p === "/proc/version" ? HOST_PROC_VERSION : (real as any)(p, ...rest))) as any);
});
afterEach(() => { vi.restoreAllMocks(); });

/** A fake Docker host: only the pinned image exists; inspect reports the runtime requested at create. */
function fakeHost(opts: { leaveContainer?: boolean } = {}) {
  let runtime = "runsc";
  let started = false;
  const existing = new Set<string>();
  const ok: ProcessResult = { exitCode: 0, signal: null, stdout: JSON.stringify(compliantReport()), stderr: "", timedOut: false, truncated: false };
  const engine: ContainerEngine = {
    target: ENGINE_TARGET,
    async info() { return DOCKER_INFO; },
    async create(args, ref) {
      if (ref !== imageReference(SPEC)) throw new Error(`No such image: ${ref.slice(0, 19)}`);
      runtime = args[args.indexOf("--runtime") + 1]; started = false;
      existing.add(CONTAINER_ID); existing.add("research-sandbox-r1-canary");
      return CONTAINER_ID;
    },
    async inspect() { const raw = compliantInspect(runtime); return started ? finishedInspect(raw) : raw; },
    async start() { started = true; return ok; },
    async remove() { if (!opts.leaveContainer) existing.clear(); },
    async exists(ref) { return existing.has(ref); },
  };
  /** The real host's behaviour: gVisor hides the canary; runc shows it as a host process. */
  const observer = (seesRuncCanary = true): HostProcessObserver => ({
    start: () => ({
      stop: () => ({
        polls: 30, unreadable: 0, overflow: false,
        samples: runtime === "runsc" ? [{ pid: 9, exe: FAKE_RUNSC_PATH, argv0: "runsc-sandbox", mentionsContainer: true, runsCanaryScript: false, role: "boot" as const }]
          : seesRuncCanary ? [{ pid: 8, exe: "/usr/local/bin/node", argv0: "node", mentionsContainer: false, runsCanaryScript: true, role: "other" as const }] : [],
      }),
    }),
  });
  return { engine, observer };
}
const base = (h: ReturnType<typeof fakeHost>, seesRuncCanary = true): Omit<PreflightOptions, "spec"> => ({
  engine: h.engine, run: RUN, hostCanaryPath: HOST_CANARY, hostFs: fakeHostFs(compliantHostLayout()), hostPolicy: POLICY, hostProcesses: h.observer(seesRuncCanary),
});

describe("A2: the controls", () => {
  it("one control per recorded pin, each changing exactly that pin (the approved spec is never modified)", () => {
    const full = { ...SPEC, runscBinary: { ...SPEC.runscBinary!, sidecars: [{ path: "/usr/local/bin/gvisor-bin/runsc-sentry", sha256: "a".repeat(64) }] },
      image: { ...SPEC.image, canaryManifestDigest: `sha256:${"b".repeat(64)}` } } as unknown as SandboxSpec;
    const before = JSON.stringify(full);
    const controls = buildNegativeControls(full);
    expect(controls.map((c) => c.name)).toEqual(["baseline", "docker-server-version", "runsc-sha256", "sidecar-sha256", "image-id", "canary-manifest-digest", "gvisor-fingerprint", "runc-instead-of-gvisor"]);
    expect(JSON.stringify(full)).toBe(before);
    const diff = (a: unknown, b: unknown, p = ""): string[] => {
      if (JSON.stringify(a) === JSON.stringify(b)) return [];
      if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a)) return [p];
      return [...new Set([...Object.keys(a), ...Object.keys(b as object)])].flatMap((k) => diff((a as any)[k], (b as any)[k], p ? `${p}.${k}` : k));
    };
    expect(controls.map((c) => diff(full, c.spec))).toEqual([[], ["dockerServerVersion"], ["runscBinary.sha256"], ["runscBinary.sidecars"], ["image.id"], ["image.canaryManifestDigest"], ["gvisorProcVersion"], ["isolatingRuntimes"]]);
    expect(flipHex("ab0")).toBe("ab1");
    expect(flipHex("ab7")).toBe("ab0");
  });

  it("end to end with the real preflight: every control behaves as expected", async () => {
    const h = fakeHost();
    const out = await runNegativeControls(base(h), SPEC);
    expect(out.map((o) => [o.name, o.passed, o.detail])).toEqual([
      ["baseline", true, "as expected"], ["docker-server-version", true, "as expected"], ["runsc-sha256", true, "as expected"],
      ["image-id", true, "as expected"], ["gvisor-fingerprint", true, "as expected"], ["runc-instead-of-gvisor", true, "as expected"],
    ]);
    expect(out.find((o) => o.name === "runsc-sha256")!.firstViolation).toContain("SHA-256 does not match the recorded approved file");
    expect(out.find((o) => o.name === "gvisor-fingerprint")!.lastStep).toBe("gvisor-unverified");
  });

  it("a preflight that IGNORES a changed pin fails that control (never a silent pass)", async () => {
    const h = fakeHost();
    const blind = (o: PreflightOptions) => runPreflight({ ...o, spec: o.spec.runscBinary?.sha256 !== SPEC.runscBinary?.sha256 ? SPEC : o.spec });
    const out = await runNegativeControls(base(h), SPEC, blind);
    const c = out.find((o) => o.name === "runsc-sha256")!;
    expect(c.passed).toBe(false);
    expect(c.detail).toBe("the changed pin was NOT detected (refused only by the M1/M3 blockers)");
  });

  it("an observer that can't see the canary under runc fails the runc control", async () => {
    const out = await runNegativeControls(base(fakeHost(), false), SPEC);
    const c = out.find((o) => o.name === "runc-instead-of-gvisor")!;
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("did NOT see the canary as a host process under runc");
  });

  it("only the pinned canary can run: a probe command is refused, and the runc control keeps the approved image and canary", async () => {
    await expect(runNegativeControls({ ...base(fakeHost()), probeCommand: ["sh", "-c", "id"] } as any, SPEC)).rejects.toThrow("negative controls never accept a probe command");
    const seen: PreflightOptions[] = [];
    await runNegativeControls(base(fakeHost()), SPEC, async (o) => { seen.push(o); return runPreflight(o); });
    for (const o of seen) expect(o.probeCommand).toBeUndefined();
    const runc = buildNegativeControls(SPEC).find((c) => c.name === "runc-instead-of-gvisor")!;
    expect(runc.spec.image).toEqual(SPEC.image);
    expect(runc.spec.developmentRuntimes).toEqual(SPEC.developmentRuntimes);
    expect(Object.keys(runc.spec).filter((k) => JSON.stringify((runc.spec as any)[k]) !== JSON.stringify((SPEC as any)[k]))).toEqual(["isolatingRuntimes"]);
  });

  it("the negative-controls modules never run commands or touch Docker configuration themselves (they only call the preflight)", () => {
    for (const f of ["negative-controls.ts", "negative-controls-main.ts"]) {
      const src = fs.readFileSync(`${__dirname}/../../research-sandbox/${f}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/child_process|spawn|exec\(|daemon\.json|\/etc\/docker|systemctl|writeFile|unlink|rename|chmod/);
    }
  });

  it("a failing baseline stops the run (the controls would mean nothing)", async () => {
    const out = await runNegativeControls(base(fakeHost()), SPEC, async () => ({ rating: "refused", allowsUntrustedInput: false, runtime: null, engine: null, violations: ["x"], hostTrust: "operator-attested-only",
      steps: ["spec"], binding: null, cleanup: null, hostProcessEvidence: null }) as PreflightResult);
    expect(out).toHaveLength(1);
    expect(out[0].passed).toBe(false);
  });

  it("an unverified cleanup stops the run at that control", async () => {
    const out = await runNegativeControls(base(fakeHost({ leaveContainer: true })), SPEC);
    expect(out).toHaveLength(1);
    expect(out[0].detail).toContain("baseline must be refused only by the M1/M3 blockers");
  });

  it("the blockers are still what the baseline must reach", () => {
    expect(MEETS_SPEC_BLOCKERS).toHaveLength(2);
  });
});

describe("A2: operator command", () => {
  const PINS = { imageDigest: SPEC.image.digest, imageEntrypoint: SPEC.image.entrypoint, imageEnv: SPEC.image.env, imageManifestDigest: SPEC.image.manifestDigest, imageId: SPEC.image.id,
    canaryManifestDigest: null, gvisorProcVersion: SPEC.gvisorProcVersion, dockerDataRoot: SPEC.dockerDataRoot, runscBinary: SPEC.runscBinary, dockerServerVersion: SPEC.dockerServerVersion };
  const config = JSON.stringify({ version: 1, engineBinary: "/usr/bin/docker", engineConfigDir: "/srv/research-engine/docker-config", runId: "r1", hostCanaryPath: HOST_CANARY, operatorUid: POLICY.operatorUid, outputOwnerUid: POLICY.outputOwnerUid, pins: PINS });
  const cmd = async (argv: string[], over: Record<string, unknown> = {}) => {
    const h = fakeHost();
    const out: string[] = [];
    const err: string[] = [];
    let engines = 0;
    const code = await runNegativeControlsCommand(argv, { readConfig: () => config, createEngine: () => { engines += 1; return h.engine; }, hostFs: fakeHostFs(compliantHostLayout()),
      hostProcesses: h.observer(), out: (t: string) => out.push(t), err: (t: string) => err.push(t), ...over } as any);
    return { code, out: out.join(""), err: err.join(""), engines };
  };
  it.each([[[]], [["--config", "/etc/x.json"]], [["--config", "x.json", NEGATIVE_CONTROLS_CONFIRM_FLAG]], [["--config", "/etc/x.json", NEGATIVE_CONTROLS_CONFIRM_FLAG, "--skip"]]])("usage %j: exit 2, no engine", async (argv) => {
    const r = await cmd(argv);
    expect(r.code).toBe(2);
    expect(r.engines).toBe(0);
  });
  it("a bad configuration: exit 2, no engine", async () => {
    const r = await cmd(["--config", "/etc/x.json", NEGATIVE_CONTROLS_CONFIRM_FLAG], { readConfig: () => "{}" });
    expect(r.code).toBe(2);
    expect(r.engines).toBe(0);
  });
  it("all controls as expected: exit 0, text and JSON reports", async () => {
    const t = await cmd(["--config", "/etc/x.json", NEGATIVE_CONTROLS_CONFIRM_FLAG]);
    expect(t.code, t.err).toBe(0);
    expect(t.out).toContain("RESULT: every deliberately wrong pin was refused; the approved pins reached only the M1/M3 blockers.");
    const j = await cmd(["--config", "/etc/x.json", NEGATIVE_CONTROLS_CONFIRM_FLAG, "--output", "json"]);
    const doc = JSON.parse(j.out);
    expect(doc).toMatchObject({ runner: "research-sandbox-negative-controls", allPassed: true, expected: 6 });
  });
  it("any failed control: exit 1", async () => {
    const r = await cmd(["--config", "/etc/x.json", NEGATIVE_CONTROLS_CONFIRM_FLAG], { preflight: (o: PreflightOptions) => runPreflight({ ...o, spec: SPEC }) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("RESULT: FAILED");
  });
});
