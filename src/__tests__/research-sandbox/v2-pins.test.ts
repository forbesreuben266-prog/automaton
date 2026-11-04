/**
 * V2: Option B (the canary's own manifest digest) and M1 coverage of gVisor's
 * sidecar binaries. Offline only: fake pins, a fake engine and the fake host
 * filesystem; nothing is built, pulled or run.
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEETS_SPEC_BLOCKERS, MAX_RUNTIME_SIDECARS, parseRunnerConfig, resolveSpec, runPreflight, sameRuntimeBinary, validateInspect, verifyRuntimeBinary,
  type ContainerEngine, type HostFs, type ProcessResult,
} from "../../research-sandbox/index.js";
import {
  CONTAINER_ID, DOCKER_INFO, ENGINE_TARGET, FAKE_CANARY_MANIFEST_DIGEST, FAKE_MANIFEST_DIGEST, FAKE_RUNSC, FAKE_RUNSC_PATH, HOST_CANARY, HOST_PROC_VERSION,
  POLICY, PROBE_COMMAND, RUN, SPEC, SPEC_CONTAINERD, compliantHostLayout, compliantInspect, compliantReport, fakeHostFs, finishedInspect, fakeHostProcesses, type FakeEntry,
} from "./fixtures.js";

const EXPECT = { run: RUN, purpose: "canary" as const, command: PROBE_COMMAND };
const descriptor = (digest: string) => ({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: 1234, platform: { architecture: "amd64", os: "linux" } });
const inspectWith = (spec: typeof SPEC, mutate: (c: any) => void) => {
  const raw = compliantInspect();
  mutate(raw[0]);
  return validateInspect(raw, spec, EXPECT).violations.join("\n");
};

describe("Option B: the canaryManifestDigest pin", () => {
  it("validates format, can't be changed once recorded, and must differ from the base manifest digest", () => {
    for (const bad of ["sha256:abc", FAKE_CANARY_MANIFEST_DIGEST.toUpperCase(), "", 7, null]) {
      expect(() => resolveSpec({ canaryManifestDigest: bad }), JSON.stringify(bad)).toThrow("canaryManifestDigest: must be sha256:<64 lowercase hex>");
    }
    expect(() => resolveSpec({ canaryManifestDigest: `sha256:${"0d".repeat(32)}` }, SPEC_CONTAINERD)).toThrow("canaryManifestDigest: differs from the already recorded digest");
    expect(() => resolveSpec({ canaryManifestDigest: FAKE_MANIFEST_DIGEST }, SPEC)).toThrow("canaryManifestDigest: equals the base image's manifest digest");
    expect(() => resolveSpec({ imageManifestDigest: FAKE_MANIFEST_DIGEST, canaryManifestDigest: FAKE_MANIFEST_DIGEST })).toThrow("equals the base image's manifest digest");
    expect(SPEC_CONTAINERD.image.canaryManifestDigest).toBe(FAKE_CANARY_MANIFEST_DIGEST);
    expect(SPEC.image.canaryManifestDigest).toBeNull();
  });

  it("containerd store: the descriptor must carry the canary's digest; the base image's digest or another digest refuses", () => {
    expect(inspectWith(SPEC_CONTAINERD, (c) => { c.ImageManifestDescriptor = descriptor(FAKE_CANARY_MANIFEST_DIGEST); })).toBe("");
    expect(inspectWith(SPEC_CONTAINERD, (c) => { c.ImageManifestDescriptor = descriptor(FAKE_MANIFEST_DIGEST); }))
      .toContain("ImageManifestDescriptor: must be a linux image manifest descriptor with the recorded canary manifest digest");
    expect(inspectWith(SPEC_CONTAINERD, (c) => { c.ImageManifestDescriptor = { ...descriptor(FAKE_CANARY_MANIFEST_DIGEST), platform: { os: "windows" } }; }))
      .toContain("recorded canary manifest digest");
  });

  it("a reported descriptor with no canary digest recorded refuses (never guessed)", () => {
    expect(inspectWith(SPEC, (c) => { c.ImageManifestDescriptor = descriptor(FAKE_CANARY_MANIFEST_DIGEST); }))
      .toContain("ImageManifestDescriptor: reported, but no canary manifest digest has been recorded (approved canary build step)");
  });

  it("the base manifest digest must still be recorded when a descriptor is reported (unchanged rule)", () => {
    const spec = { ...SPEC_CONTAINERD, image: { ...SPEC_CONTAINERD.image, manifestDigest: null } } as typeof SPEC;
    expect(inspectWith(spec, (c) => { c.ImageManifestDescriptor = descriptor(FAKE_CANARY_MANIFEST_DIGEST); }))
      .toContain("ImageManifestDescriptor: reported, but no manifest digest has been recorded (approved pull step)");
  });

  it("a recorded canary digest with no descriptor reported refuses (contradictory: the store changed)", () => {
    expect(inspectWith(SPEC_CONTAINERD, () => {})).toContain("ImageManifestDescriptor: a canary manifest digest is recorded, but the daemon reports no descriptor");
    expect(inspectWith(SPEC, () => {})).toBe(""); // classic store, nothing recorded: unchanged
  });

  it("the runner configuration requires the pin (null allowed for a classic store)", () => {
    const base = {
      version: 1, engineBinary: "/usr/bin/docker", engineConfigDir: "/root/research-docker-config", runId: "r1", hostCanaryPath: HOST_CANARY, operatorUid: 0, outputOwnerUid: 10001,
      pins: { imageDigest: "x", imageEntrypoint: [], imageEnv: [], imageManifestDigest: null, imageId: "x", gvisorProcVersion: "x", dockerDataRoot: "x", runscBinary: {}, dockerServerVersion: "x" },
    };
    expect(() => parseRunnerConfig(JSON.stringify(base))).toThrow("pins.canaryManifestDigest: is required");
    expect(parseRunnerConfig(JSON.stringify({ ...base, pins: { ...base.pins, canaryManifestDigest: null } })).pins.canaryManifestDigest).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

const BIN_DIR = FAKE_RUNSC_PATH.slice(0, FAKE_RUNSC_PATH.lastIndexOf("/"));
const SIDE = `${BIN_DIR}/gvisor-bin`;
const SENTRY = `${SIDE}/runsc-sentry`;
const GOFER = `${SIDE}/helpers/runsc-gofer`;
const SHA_SENTRY = "a1".repeat(32);
const SHA_GOFER = "b2".repeat(32);
const SIDECARS = [{ path: SENTRY, sha256: SHA_SENTRY }, { path: GOFER, sha256: SHA_GOFER }];
const SPEC_SIDE = resolveSpec({ runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"], sidecars: SIDECARS } }, resolveSpec({}, { ...SPEC, runscBinary: null }));

/** The compliant layout plus a gvisor-bin folder holding exactly the two recorded sidecars. */
function sidecarLayout(): Record<string, FakeEntry> {
  const l = compliantHostLayout();
  l[SIDE] = { kind: "dir", uid: 0, mode: 0o40755, ino: 60, entries: ["helpers", "runsc-sentry"] };
  l[`${SIDE}/helpers`] = { kind: "dir", uid: 0, mode: 0o40755, ino: 61, entries: ["runsc-gofer"] };
  l[SENTRY] = { kind: "file", uid: 0, mode: 0o100755, ino: 62, size: 30_000_000, sha256: SHA_SENTRY };
  l[GOFER] = { kind: "file", uid: 0, mode: 0o100644, ino: 63, size: 1_000, sha256: SHA_GOFER }; // not executable: allowed for sidecars
  return l;
}
const verify = (mutate: (l: Record<string, FakeEntry>) => void = () => {}, spec = SPEC_SIDE) => {
  const l = sidecarLayout();
  mutate(l);
  return verifyRuntimeBinary(DOCKER_INFO, "runsc", spec, fakeHostFs(l));
};
const msg = (r: ReturnType<typeof verify>) => r.violations.join("\n");

describe("M1 sidecar coverage: recording", () => {
  const rb = (sidecars: unknown) => ({ runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"], sidecars } });
  it("accepts sidecars inside gvisor-bin (nested) or directly in a system binary folder; stores them sorted and frozen", () => {
    const s = resolveSpec(rb([{ path: GOFER, sha256: SHA_GOFER }, { path: "/usr/bin/containerd-shim-runsc-v1", sha256: SHA_SENTRY }, { path: SENTRY, sha256: SHA_SENTRY }]));
    expect(s.runscBinary!.sidecars.map((x) => x.path)).toEqual(["/usr/bin/containerd-shim-runsc-v1", GOFER, SENTRY]);
    expect(Object.isFrozen(s.runscBinary!.sidecars) && Object.isFrozen(s.runscBinary!.sidecars[0])).toBe(true);
  });

  it.each([
    ["a path outside the allowed folders", [{ path: "/tmp/sentry", sha256: SHA_SENTRY }], "runscBinary.sidecars[0].path: must be inside"],
    ["a path in another binary's gvisor-bin", [{ path: "/opt/gvisor-bin/sentry", sha256: SHA_SENTRY }], "runscBinary.sidecars[0].path"],
    ["traversal", [{ path: `${SIDE}/../../../tmp/x`, sha256: SHA_SENTRY }], "runscBinary.sidecars[0].path"],
    ["a hidden name", [{ path: `${SIDE}/.hidden`, sha256: SHA_SENTRY }], "runscBinary.sidecars[0].path"],
    ["too deep", [{ path: `${SIDE}/a/b/c/d/e`, sha256: SHA_SENTRY }], "runscBinary.sidecars[0].path"],
    ["the runsc binary itself", [{ path: FAKE_RUNSC_PATH, sha256: SHA_SENTRY }], "runscBinary.sidecars[0].path"],
    ["a duplicate", [{ path: SENTRY, sha256: SHA_SENTRY }, { path: SENTRY, sha256: SHA_SENTRY }], "runscBinary.sidecars[1].path: listed twice"],
    ["a malformed hash", [{ path: SENTRY, sha256: "ABC" }], "runscBinary.sidecars[0].sha256"],
    ["an extra key", [{ path: SENTRY, sha256: SHA_SENTRY, mode: 493 }], "runscBinary.sidecars[0]: must be { path, sha256 }"],
    ["not an array", { path: SENTRY }, "runscBinary.sidecars: must be an array"],
    ["too many", Array.from({ length: MAX_RUNTIME_SIDECARS + 1 }, (_, i) => ({ path: `${SIDE}/f${i}`, sha256: SHA_SENTRY })), "runscBinary.sidecars: must be an array of at most"],
  ])("refuses %s", (_label, sidecars, message) => {
    expect(() => resolveSpec(rb(sidecars))).toThrow(message);
  });

  it("a recorded binary can't be changed by adding or altering sidecars later", () => {
    expect(() => resolveSpec(rb(SIDECARS), SPEC)).toThrow("runscBinary: differs from the already recorded binary");
  });
});

describe("V2.1: the runsc package's /etc/containerd/runsc.toml is pinned, never ignored", () => {
  const TOML = "/etc/containerd/runsc.toml";
  const SHA_TOML = "ea5ada6422655b972fd3af73f7a23b88cc3385c98767cca2f360b2aa749d114c"; // the shipped release-20261102.0 example file
  const rb = (sidecars: unknown) => ({ runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"], sidecars } });
  const SPEC_TOML = resolveSpec({ runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"], sidecars: [...SIDECARS, { path: TOML, sha256: SHA_TOML }] } }, resolveSpec({}, { ...SPEC, runscBinary: null }));
  const tomlLayout = (mutate: (l: Record<string, FakeEntry>) => void = () => {}) => {
    const l = sidecarLayout();
    l["/etc"] = { kind: "dir", uid: 0, mode: 0o40755, ino: 90 };
    l["/etc/containerd"] = { kind: "dir", uid: 0, mode: 0o40755, ino: 91 };
    l[TOML] = { kind: "file", uid: 0, mode: 0o100644, ino: 92, size: 297, sha256: SHA_TOML };
    mutate(l);
    return verifyRuntimeBinary(DOCKER_INFO, "runsc", SPEC_TOML, fakeHostFs(l));
  };

  it("accepts a plain *.toml file directly in /etc/containerd as a recorded file", () => {
    expect(SPEC_TOML.runscBinary!.sidecars.map((s) => s.path)).toContain(TOML);
  });

  it.each([
    ["a nested path", "/etc/containerd/sub/runsc.toml"], ["another /etc folder", "/etc/runsc.toml"], ["Docker's configuration", "/etc/docker/daemon.json"],
    ["a non-toml name", "/etc/containerd/runsc.conf"], ["a hidden name", "/etc/containerd/.runsc.toml"], ["containerd's own config is .toml but traversal", "/etc/containerd/../shadow.toml"],
  ])("refuses %s", (_label, path) => {
    expect(() => resolveSpec(rb([{ path, sha256: SHA_TOML }]))).toThrow("runscBinary.sidecars[0].path: must be inside");
  });

  it("verifies it like every recorded file: present, root-owned chain, not writable by others, exact SHA-256", () => {
    const ok = tomlLayout();
    expect(ok.violations).toEqual([]);
    expect(ok.identity!.sidecars.find((s) => s.path === TOML)!.sha256).toBe(SHA_TOML);
  });

  it.each([
    ["edited after recording", (l: any) => { l[TOML].sha256 = "11".repeat(32); }, `${TOML}: SHA-256 does not match the recorded approved file`],
    ["missing", (l: any) => { delete l[TOML]; }, `${TOML}: cannot be checked (ENOENT)`],
    ["replaced by a symlink", (l: any) => { l[TOML] = { kind: "symlink", uid: 0, mode: 0o120777, ino: 92, realpath: "/tmp/x.toml" }; }, `${TOML}: is a symbolic link`],
    ["world-writable", (l: any) => { l[TOML].mode = 0o100646; }, `${TOML}: writable by group or others`],
    ["owned by another user", (l: any) => { l[TOML].uid = 1000; }, `${TOML}: owned by uid 1000, not root`],
    ["in a group-writable /etc/containerd", (l: any) => { l["/etc/containerd"].mode = 0o40775; }, "/etc/containerd: writable by group or others"],
    ["in a /etc/containerd that is a symlink", (l: any) => { l["/etc/containerd"] = { kind: "symlink", uid: 0, mode: 0o120777, ino: 91, realpath: "/tmp" }; }, "/etc/containerd: is a symbolic link"],
  ])("refuses the file when %s", (_label, mutate, message) => {
    const r = tomlLayout(mutate as never);
    expect(r.violations.join("\n")).toContain(message);
    expect(r.identity).toBeNull();
  });
});

describe("M1 sidecar coverage: verification on the host (fakes)", () => {
  it("runsc and every recorded sidecar verified; the gvisor-bin listing is recorded", () => {
    const r = verify();
    expect(r.violations).toEqual([]);
    expect(r.identity!.sidecars.map((s) => [s.path, s.sha256])).toEqual([[GOFER, SHA_GOFER], [SENTRY, SHA_SENTRY]]);
    expect(r.identity!.sidecarListing).toEqual([`${SIDE}/helpers`, GOFER, SENTRY]);
  });

  it.each([
    ["a sidecar whose contents differ", (l: any) => { l[SENTRY].sha256 = "00".repeat(32); }, `${SENTRY}: SHA-256 does not match the recorded approved file`],
    ["a recorded sidecar that is missing", (l: any) => { delete l[GOFER]; l[`${SIDE}/helpers`].entries = []; }, `${GOFER}: cannot be checked (ENOENT)`],
    ["an unrecorded extra file", (l: any) => { l[SIDE].entries.push("injected"); l[`${SIDE}/injected`] = { kind: "file", uid: 0, mode: 0o100755, ino: 70 }; }, `${SIDE}/injected: is in ${SIDE} but is not a recorded sidecar file`],
    ["a symlink in gvisor-bin", (l: any) => { l[SIDE].entries.push("link"); l[`${SIDE}/link`] = { kind: "symlink", uid: 0, mode: 0o120777, ino: 71, realpath: "/tmp/x" }; }, `${SIDE}/link: is in ${SIDE} but is not a recorded sidecar file`],
    ["a recorded sidecar replaced by a symlink", (l: any) => { l[SENTRY] = { kind: "symlink", uid: 0, mode: 0o120777, ino: 62, realpath: "/tmp/x" }; }, `${SENTRY}: is a symbolic link`],
    ["a group-writable gvisor-bin folder", (l: any) => { l[SIDE].mode = 0o40775; }, `${SIDE}: writable by group or others`],
    ["a gvisor-bin folder owned by another user", (l: any) => { l[SIDE].uid = 1000; }, `${SIDE}: owned by uid 1000, not root`],
    ["gvisor-bin replaced by a symlink", (l: any) => { l[SIDE] = { kind: "symlink", uid: 0, mode: 0o120777, ino: 60, realpath: "/tmp" }; }, `${SIDE}: is a symbolic link`],
    ["a setuid sidecar", (l: any) => { l[SENTRY].mode = 0o104755; }, `${SENTRY}: has a setuid or setgid bit`],
    ["a world-writable sidecar", (l: any) => { l[GOFER].mode = 0o100646; }, `${GOFER}: writable by group or others`],
    ["a sidecar owned by another user", (l: any) => { l[GOFER].uid = 1000; }, `${GOFER}: owned by uid 1000, not root`],
    ["nesting deeper than recordable", (l: any) => {
      l[`${SIDE}/helpers`].entries.push("a"); l[`${SIDE}/helpers/a`] = { kind: "dir", uid: 0, mode: 0o40755, ino: 80, entries: ["b"] };
      l[`${SIDE}/helpers/a/b`] = { kind: "dir", uid: 0, mode: 0o40755, ino: 81, entries: ["c"] }; l[`${SIDE}/helpers/a/b/c`] = { kind: "dir", uid: 0, mode: 0o40755, ino: 82, entries: [] };
    }, "nested deeper than the recorded sidecars allow"],
    ["an unreadable gvisor-bin folder", (l: any) => { l[SIDE].error = "EACCES"; }, `${SIDE}: cannot be checked (EACCES)`],
  ])("%s: refused", (_label, mutate, message) => {
    const r = verify(mutate as never);
    expect(msg(r)).toContain(message);
    expect(r.identity).toBeNull();
  });

  it("a single-binary release: no gvisor-bin folder and no recorded sidecars is fine; recorded sidecars without the folder refuse", () => {
    expect(verifyRuntimeBinary(DOCKER_INFO, "runsc", SPEC, fakeHostFs(compliantHostLayout())).violations).toEqual([]);
    const r = verifyRuntimeBinary(DOCKER_INFO, "runsc", SPEC_SIDE, fakeHostFs(compliantHostLayout()));
    expect(msg(r)).toContain(`${SENTRY}: cannot be checked (ENOENT)`);
    expect(msg(r)).toContain(`${SIDE}: does not exist, but sidecar files are recorded in it`);
  });

  it("a gvisor-bin folder on the host while the record lists no sidecars refuses (an unrecorded runtime binary)", () => {
    const r = verifyRuntimeBinary(DOCKER_INFO, "runsc", SPEC, fakeHostFs(sidecarLayout()));
    expect(msg(r)).toContain(`${SENTRY}: is in ${SIDE} but is not a recorded sidecar file`);
    expect(r.identity).toBeNull();
  });

  it("sameRuntimeBinary notices a replaced sidecar or a changed listing", () => {
    const a = verify().identity!;
    const replaced = verify((l) => { l[SENTRY].ino = 99; }).identity!;
    const listed = { ...a, sidecarListing: [...a.sidecarListing, `${SIDE}/new`] };
    expect([sameRuntimeBinary(a, verify().identity!), sameRuntimeBinary(a, replaced), sameRuntimeBinary(a, listed)]).toEqual([true, false, false]);
  });
});

describe("preflight with sidecars and the canary manifest digest (fake engine)", () => {
  beforeEach(() => {
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) => (p === "/proc/version" ? HOST_PROC_VERSION : (real as any)(p, ...rest))) as any);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const SPEC_ALL = resolveSpec({ canaryManifestDigest: FAKE_CANARY_MANIFEST_DIGEST }, SPEC_SIDE);
  function engine(descriptorDigest: string | null) {
    const calls: string[] = [];
    const existing = new Set<string>();
    const ok: ProcessResult = { exitCode: 0, signal: null, stdout: JSON.stringify(compliantReport()), stderr: "", timedOut: false, truncated: false };
    let started = false;
    const e: ContainerEngine = {
      target: ENGINE_TARGET,
      async info() { calls.push("info"); return DOCKER_INFO; },
      async create() { calls.push("create"); existing.add(CONTAINER_ID); existing.add("research-sandbox-r1-canary"); return CONTAINER_ID; },
      async inspect() { calls.push("inspect"); const raw = compliantInspect(); if (descriptorDigest) raw[0].ImageManifestDescriptor = descriptor(descriptorDigest); return started ? finishedInspect(raw) : raw; },
      async start() { calls.push("start"); started = true; return ok; },
      async remove() { calls.push("remove"); existing.clear(); },
      async exists(ref) { return existing.has(ref); },
    };
    return { e, calls };
  }
  const go = (e: ContainerEngine, hostFs: HostFs = fakeHostFs(sidecarLayout()), spec = SPEC_ALL) =>
    runPreflight({ engine: e, spec, run: RUN, hostCanaryPath: HOST_CANARY, hostFs, hostPolicy: POLICY, hostProcesses: fakeHostProcesses() });

  it("every check passes, including sidecars and the canary's descriptor: still refused only by M1/M3", async () => {
    const r = await go(engine(FAKE_CANARY_MANIFEST_DIGEST).e);
    expect(r.violations).toEqual(MEETS_SPEC_BLOCKERS);
    expect(r.steps).toContain("runtime-binary-rechecked");
  });

  it("the base image's manifest in the descriptor is refused at inspect, never started", async () => {
    const f = engine(FAKE_MANIFEST_DIGEST);
    const r = await go(f.e);
    expect(r.violations.join("\n")).toContain("recorded canary manifest digest");
    expect(f.calls).not.toContain("start");
  });

  it("a sidecar replaced while the canary ran is detected by the re-check after the canary", async () => {
    const layout = sidecarLayout();
    const hostFs = fakeHostFs(layout);
    let hashes = 0;
    const swapping: HostFs = {
      ...hostFs,
      sha256File(p, max) {
        if (p === SENTRY && ++hashes === 2) layout[SENTRY] = { ...layout[SENTRY], ino: 777, sha256: "ee".repeat(32) }; // swapped before the second verification
        return hostFs.sha256File(p, max);
      },
    };
    const r = await go(engine(FAKE_CANARY_MANIFEST_DIGEST).e, swapping);
    expect(r.rating).toBe("refused");
    expect(r.violations.join("\n")).toMatch(/runsc-sentry: (SHA-256 does not match|the file hashed is not the file checked)|changed between/);
    expect(r.steps).toContain("runtime-binary-changed");
  });
});
