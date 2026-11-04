/**
 * V1B: the locally built canary image is pinned by its recorded, immutable
 * image ID. Offline only: fake pins, a fake engine and the fake host
 * filesystem; nothing is built, pulled or run.
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEETS_SPEC_BLOCKERS, SANDBOX_SPEC, buildCreateArgs, createArgvProblem, imageReference, resolveSpec, runPreflight, validateInspect,
  type ContainerEngine, type ProcessResult,
} from "../../research-sandbox/index.js";
import {
  CONTAINER_ID, DOCKER_INFO, ENGINE_TARGET, FAKE_CANARY_MANIFEST_DIGEST, FAKE_DIGEST, FAKE_ENTRYPOINT, FAKE_IMAGE_ID, FAKE_MANIFEST_DIGEST, HOST_CANARY, HOST_PROC_VERSION, POLICY, PROBE_COMMAND, RUN, SPEC, SPEC_CONTAINERD,
  compliantHostLayout, compliantInspect, compliantReport, fakeHostFs, finishedInspect, fakeHostProcesses,
} from "./fixtures.js";

const OTHER_ID = `sha256:${"9f".repeat(32)}`;
const EXPECT = { run: RUN, purpose: "canary" as const, command: PROBE_COMMAND };
const inspectViolations = (mutate: (c: any) => void, spec = SPEC) => {
  const raw = compliantInspect();
  mutate(raw[0]);
  return validateInspect(raw, spec, EXPECT).violations;
};
const IMAGE_MISMATCH = `Image: the created container's image must be the recorded image ID ${FAKE_IMAGE_ID}`;
const REF_MISMATCH = `Config.Image: must be ${FAKE_IMAGE_ID}`;

describe("the imageId pin", () => {
  it("is unrecorded in the shipped specification, so the image reference is refused", () => {
    expect(SANDBOX_SPEC.image.id).toBeNull();
    expect(() => imageReference(resolveSpec({ imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT })))
      .toThrow("image ID is not recorded: the separately approved canary image build must record its full ID (sha256:<64 hex>) first (V1B)");
  });

  it("accepts only a full, lower-case sha256 image ID (no tag, short ID, repository or other form)", () => {
    for (const bad of ["canary:1", "canary:latest", "node:22", "abcdef012345", "9f".repeat(32), `sha256:${"9f".repeat(31)}`, `sha256:${"9F".repeat(32)}`,
      `docker.io/library/node@${FAKE_IMAGE_ID}`, `${FAKE_IMAGE_ID} `, `sha512:${"9f".repeat(32)}`, "", 42, null, [FAKE_IMAGE_ID]]) {
      expect(() => resolveSpec({ imageId: bad }), JSON.stringify(bad)).toThrow("imageId: must be the full image ID sha256:<64 lowercase hex> (no tag, short ID or repository)");
    }
    expect(resolveSpec({ imageId: OTHER_ID }).image.id).toBe(OTHER_ID);
  });

  it("can't be changed once recorded, and must not be the base image digest", () => {
    expect(() => resolveSpec({ imageId: OTHER_ID }, SPEC)).toThrow("imageId: differs from the already recorded image ID");
    expect(resolveSpec({ imageId: FAKE_IMAGE_ID }, SPEC).image.id).toBe(FAKE_IMAGE_ID);
    expect(() => resolveSpec({ imageDigest: FAKE_DIGEST, imageId: FAKE_DIGEST })).toThrow("imageId: equals the base image digest");
    expect(() => resolveSpec({ imageId: FAKE_DIGEST }, resolveSpec({ imageDigest: FAKE_DIGEST }))).toThrow("imageId: equals the base image digest");
    // Recorded in the other order: the reference itself refuses.
    const sneaky = resolveSpec({ imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT }, resolveSpec({ imageId: FAKE_DIGEST }));
    expect(() => imageReference(sneaky)).toThrow("image ID equals the base image digest");
  });
});

describe("create is bound to the image ID", () => {
  it("the create argv names the image ID exactly once, after --pull never, with no repository or tag", () => {
    const args = buildCreateArgs(SPEC, RUN, "runsc", PROBE_COMMAND, "canary");
    expect(imageReference(SPEC)).toBe(FAKE_IMAGE_ID);
    expect(args.filter((a) => a === FAKE_IMAGE_ID)).toHaveLength(1);
    expect(args.indexOf("--pull")).toBeLessThan(args.indexOf(FAKE_IMAGE_ID));
    expect(args[args.indexOf("--pull") + 1]).toBe("never");
    expect(args.some((a) => a.includes("docker.io/") || a.includes(FAKE_DIGEST) || /:latest$/.test(a))).toBe(false);
    expect(createArgvProblem(args, FAKE_IMAGE_ID)).toBeNull();
  });

  it("the engine guard refuses any reference other than an ID, and an ID that isn't the one in the argv", () => {
    const args = buildCreateArgs(SPEC, RUN, "runsc", PROBE_COMMAND, "canary");
    expect(createArgvProblem(args.map((a) => (a === FAKE_IMAGE_ID ? "canary:1" : a)), "canary:1")).toContain("must be the recorded image ID");
    expect(createArgvProblem(args, OTHER_ID)).toBe("the image reference must appear exactly once");
  });
});

describe("inspect binds the created container's actual image", () => {
  it("a compliant container passes", () => {
    expect(inspectViolations(() => {})).toEqual([]);
  });

  it("refuses a substituted image even when the requested reference looks right", () => {
    expect(inspectViolations((c) => { c.Image = OTHER_ID; })).toEqual([IMAGE_MISMATCH]);
  });

  it("refuses a mutable tag or repository reference, even when the image itself matches", () => {
    expect(inspectViolations((c) => { c.Config.Image = "canary:latest"; })).toEqual([REF_MISMATCH]);
    expect(inspectViolations((c) => { c.Config.Image = `docker.io/library/node@${FAKE_DIGEST}`; })).toEqual([REF_MISMATCH]);
  });

  it("refuses a consistent but different image (reference and image both substituted)", () => {
    const v = inspectViolations((c) => { c.Image = OTHER_ID; c.Config.Image = OTHER_ID; });
    expect(v).toEqual(expect.arrayContaining([IMAGE_MISMATCH, REF_MISMATCH]));
  });

  it("refuses missing, malformed or contradictory image fields", () => {
    for (const image of [undefined, null, "", 42, "sha256:short", FAKE_IMAGE_ID.toUpperCase(), FAKE_IMAGE_ID.slice(7), `${FAKE_IMAGE_ID}\n`]) {
      const v = inspectViolations((c) => { if (image === undefined) delete c.Image; else c.Image = image; });
      expect(v, JSON.stringify(image)).toContain(IMAGE_MISMATCH);
    }
    for (const ref of [undefined, null, 42, FAKE_IMAGE_ID.slice(0, 19)]) {
      const v = inspectViolations((c) => { if (ref === undefined) delete c.Config.Image; else c.Config.Image = ref; });
      expect(v.join("\n"), JSON.stringify(ref)).toContain("Config.Image");
    }
  });

  it("a reported descriptor must carry the canary's recorded manifest digest (V2), never the base image's", () => {
    const descriptor = (digest: string) => (c: any) => { c.ImageManifestDescriptor = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: 1, platform: { os: "linux", architecture: "amd64" } }; };
    expect(inspectViolations(descriptor(FAKE_CANARY_MANIFEST_DIGEST), SPEC_CONTAINERD)).toEqual([]);
    expect(inspectViolations(descriptor(FAKE_MANIFEST_DIGEST), SPEC_CONTAINERD).join("\n")).toContain("ImageManifestDescriptor: must be a linux image manifest descriptor with the recorded canary manifest digest");
    expect(inspectViolations(descriptor(OTHER_ID), SPEC_CONTAINERD).join("\n")).toContain("recorded canary manifest digest");
  });
});

describe("preflight with a substituted image (fake engine)", () => {
  beforeEach(() => {
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) => (p === "/proc/version" ? HOST_PROC_VERSION : (real as any)(p, ...rest))) as any);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function engine(inspectImage: string) {
    const calls: string[] = [];
    const existing = new Set<string>();
    const okStart: ProcessResult = { exitCode: 0, signal: null, stdout: JSON.stringify(compliantReport()), stderr: "", timedOut: false, truncated: false };
    let started = false;
    const e: ContainerEngine = {
      target: ENGINE_TARGET,
      async info() { calls.push("info"); return DOCKER_INFO; },
      async create(args, ref) { calls.push(`create:${ref}`); expect(createArgvProblem(args, ref)).toBeNull(); existing.add(CONTAINER_ID); existing.add("research-sandbox-r1-canary"); return CONTAINER_ID; },
      async inspect() { calls.push("inspect"); const raw = compliantInspect(); raw[0].Image = inspectImage; return started ? finishedInspect(raw) : raw; },
      async start() { calls.push("start"); started = true; return okStart; },
      async remove() { calls.push("remove"); existing.clear(); },
      async exists(ref) { return existing.has(ref); },
    };
    return { e, calls };
  }
  const go = (e: ContainerEngine) => runPreflight({ engine: e, spec: SPEC, run: RUN, hostCanaryPath: HOST_CANARY, hostFs: fakeHostFs(compliantHostLayout()), hostPolicy: POLICY, hostProcesses: fakeHostProcesses() });

  it("the matching image reaches the blockers; a substituted one is refused at inspect, never started, and removed", async () => {
    const good = engine(FAKE_IMAGE_ID);
    expect((await go(good.e)).violations).toEqual(MEETS_SPEC_BLOCKERS);
    expect(good.calls).toContain(`create:${FAKE_IMAGE_ID}`);

    const swapped = engine(OTHER_ID);
    const r = await go(swapped.e);
    expect([r.rating, r.allowsUntrustedInput, r.binding]).toEqual(["refused", false, null]);
    expect(r.violations).toContain(IMAGE_MISMATCH);
    expect(swapped.calls).not.toContain("start");
    expect(swapped.calls).toContain("remove");
    expect(r.cleanup?.verifiedRemoved).toBe(true);
  });
});
