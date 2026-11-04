/**
 * V2.2: Docker 29.9.3 inspect compatibility, offline. Each accepted difference
 * is grounded in the moby source at tag docker-v29.9.3:
 * - daemon/inspect.go: with the containerd image store (UsesSnapshotter) the
 *   daemon reports Storage {RootFS:{Snapshot:{Name: ctr.Driver}}} and NO
 *   GraphDriver; otherwise GraphDriver and no Storage.
 * - api/types/container/hostconfig.go: Annotations, StorageOpt, Sysctls (maps)
 *   and Init (*bool) are `json:",omitempty"`. A nil map has no effect; a nil
 *   Init means the daemon-wide "init" default applies (daemon/oci_linux.go),
 *   so Init stays required and the create argv passes --init=false.
 * - HostsPath/ResolvConfPath (container_operations_unix.go) and HostnamePath
 *   (container_unix.go) are set from initializeNetworking at start
 *   (start.go), so a created, never-started container reports them empty.
 * Nothing else is relaxed: unknown keys still refuse, and M1/M3 stay blocked.
 */

import { describe, expect, it } from "vitest";
import { MEETS_SPEC_BLOCKERS, validateFinishedInspect, validateInspect } from "../../research-sandbox/index.js";
import { CONTAINER_ID, PROBE_COMMAND, RUN, SPEC, compliantInspect, docker29Inspect, finishedInspect } from "./fixtures.js";

const EXPECT = { run: RUN, purpose: "canary" as const, command: PROBE_COMMAND };
const check29 = (mutate: (c: any) => void) => { const raw = docker29Inspect(); mutate(raw[0]); return validateInspect(raw, SPEC, EXPECT).violations.join("\n"); };
const FIN = { run: RUN, purpose: "canary" as const, containerId: CONTAINER_ID, runtime: "runsc" };
const finished = (mutate: (c: any) => void, created = docker29Inspect()) => { const raw = finishedInspect(created); mutate(raw[0]); return validateFinishedInspect(raw, SPEC, FIN).join("\n"); };

describe("V2.2: the Docker 29.9.3 created-container format", () => {
  it("is accepted, with the host files reported as pending (verified after the start)", () => {
    expect(validateInspect(docker29Inspect(), SPEC, EXPECT)).toEqual({ violations: [], runtime: "runsc", containerId: CONTAINER_ID, hostFilesPending: true });
  });

  it("the classic format is still accepted, with the host files verified before the start", () => {
    expect(validateInspect(compliantInspect(), SPEC, EXPECT).hostFilesPending).toBe(false);
  });

  it("reproduces the VPS refusal list on the V2.1 rules' inputs: every former finding is now handled, none silently", () => {
    // The exact fields the V2.1 preflight reported for setup-20261104-121723-952384032.
    const raw = docker29Inspect()[0];
    expect(Object.keys(raw)).toContain("Storage");
    expect(raw.GraphDriver).toBeUndefined();
    for (const k of ["Annotations", "StorageOpt", "Sysctls"]) expect(k in raw.HostConfig).toBe(false);
    expect(raw.HostConfig.Init).toBe(false); // reported because the create argv now passes --init=false
    expect([raw.HostsPath, raw.HostnamePath, raw.ResolvConfPath]).toEqual(["", "", ""]);
    expect(check29(() => {})).toBe("");
  });
});

describe("V2.2: storage metadata is exactly one of GraphDriver or Storage, named as Driver", () => {
  it.each([
    ["both GraphDriver and Storage", (c: any) => { c.GraphDriver = { Name: "overlayfs" }; }, "GraphDriver/Storage: exactly one must be present (got both)"],
    ["neither", (c: any) => { delete c.Storage; }, "GraphDriver/Storage: exactly one must be present (got neither)"],
    ["Storage with an extra top-level key", (c: any) => { c.Storage.Other = {}; }, "Storage: must be exactly"],
    ["Storage.RootFS with an extra key", (c: any) => { c.Storage.RootFS.Extra = 1; }, "Storage: must be exactly"],
    ["Storage.RootFS.Snapshot with an extra key", (c: any) => { c.Storage.RootFS.Snapshot.Options = ["x"]; }, "Storage: must be exactly"],
    ["Storage.RootFS missing", (c: any) => { c.Storage = {}; }, "Storage: must be exactly"],
    ["Storage null", (c: any) => { c.Storage = null; }, "Storage: must be exactly"],
    ["Storage as an array", (c: any) => { c.Storage = [{ RootFS: { Snapshot: { Name: "overlayfs" } } }]; }, "Storage: must be exactly"],
    ["Snapshot name not a string", (c: any) => { c.Storage.RootFS.Snapshot.Name = 1; }, "Storage: must be exactly"],
    ["Snapshot name with a path", (c: any) => { c.Storage.RootFS.Snapshot.Name = "../overlayfs"; }, "Storage: must be exactly"],
    ["Snapshot name empty", (c: any) => { c.Storage.RootFS.Snapshot.Name = ""; }, "Storage: must be exactly"],
    ["Snapshot name differs from Driver", (c: any) => { c.Storage.RootFS.Snapshot.Name = "native"; }, "Driver: must be a snapshotter name equal to Storage.RootFS.Snapshot.Name"],
    ["Driver missing", (c: any) => { delete c.Driver; }, "Driver: must be a snapshotter name"],
  ])("%s: refused", (_label, mutate, message) => {
    expect(check29(mutate)).toContain(message);
  });

  it("classic GraphDriver rules are unchanged (shape, and Name equal to Driver)", () => {
    const classic = (m: (c: any) => void) => { const raw = compliantInspect(); m(raw[0]); return validateInspect(raw, SPEC, EXPECT).violations.join("\n"); };
    expect(classic(() => {})).toBe("");
    expect(classic((c) => { c.GraphDriver.Extra = 1; })).toContain("GraphDriver: must have only Name and string Data paths");
    expect(classic((c) => { c.GraphDriver.Name = "vfs"; })).toContain("Driver: must be a driver name equal to GraphDriver.Name");
    expect(classic((c) => { c.Storage = { RootFS: { Snapshot: { Name: "overlay2" } } }; })).toContain("got both");
  });

  it("other unknown top-level fields are still refused (only Storage was added to the allowlist)", () => {
    expect(check29((c) => { c.Snapshotter = "overlayfs"; })).toContain('inspect: unknown top-level field "Snapshotter"');
    expect(check29((c) => { c.HostConfig.NewOption = true; })).toContain('HostConfig: unknown field "NewOption"');
  });
});

describe("V2.2: omitempty HostConfig fields", () => {
  it.each(["Annotations", "StorageOpt", "Sysctls"])("%s absent is accepted (a nil map has no effect); empty is accepted; any entry refuses", (key) => {
    expect(check29(() => {})).toBe("");
    expect(check29((c) => { c.HostConfig[key] = {}; })).toBe("");
    expect(check29((c) => { c.HostConfig[key] = null; })).toBe("");
    expect(check29((c) => { c.HostConfig[key] = { x: "1" }; })).toContain(`HostConfig.${key}: must be empty`);
    expect(check29((c) => { c.HostConfig[key] = ["x"]; })).toContain(`HostConfig.${key}: must be empty`);
  });

  it("Init absent refuses (the daemon default would apply), as do null and true", () => {
    expect(check29((c) => { delete c.HostConfig.Init; })).toContain("HostConfig.Init: missing (required; absence is not treated as a default)");
    expect(check29((c) => { c.HostConfig.Init = null; })).toContain("HostConfig.Init: must be false");
    expect(check29((c) => { c.HostConfig.Init = true; })).toContain("HostConfig.Init: must be false");
  });
});

describe("V2.2: host-file paths before the first start", () => {
  const PATH_KEYS = ["HostsPath", "HostnamePath", "ResolvConfPath"];
  it.each(PATH_KEYS)("only %s empty (a mix of empty and exact paths): refused", (key) => {
    const msg = (() => { const raw = compliantInspect(); raw[0][key] = ""; return validateInspect(raw, SPEC, EXPECT).violations.join("\n"); })();
    expect(msg).toContain(`${key}: must be /var/lib/docker/containers/${CONTAINER_ID}/`);
  });

  it.each([["null", null], ["missing", undefined], ["a host path", "/etc/hosts"], ["whitespace", " "]])("one path %s while the others are empty: refused", (_l, value) => {
    const msg = check29((c) => { if (value === undefined) delete c.HostsPath; else c.HostsPath = value; });
    expect(msg).toContain("HostsPath: must be");
  });

  it("empty paths are only possible on a never-started container: a started State still refuses", () => {
    expect(check29((c) => { c.State.Status = "exited"; c.State.StartedAt = "2026-11-04T12:00:00Z"; })).toContain("State: must be a created, never-started container");
  });

  it("an unrecorded Docker data root still refuses, whatever the paths", () => {
    const raw = docker29Inspect();
    const unrecorded = { ...SPEC, dockerDataRoot: null };
    expect(validateInspect(raw, unrecorded, EXPECT).violations.join("\n")).toContain("dockerDataRoot is not recorded");
  });
});

describe("V2.2: validateFinishedInspect (the re-inspect after the canary)", () => {
  it("accepts the exited container with the exact host-file paths (both formats)", () => {
    expect(finished(() => {})).toBe("");
    expect(finished(() => {}, compliantInspect())).toBe("");
  });

  it.each([
    ["paths still empty", (c: any) => { c.HostsPath = ""; }, "HostsPath: must be"],
    ["a path elsewhere", (c: any) => { c.HostnamePath = "/etc/hostname"; }, "HostnamePath: must be"],
    ["another container", (c: any) => { c.Id = "e".repeat(64); }, "Id: differs"],
    ["another name", (c: any) => { c.Name = "/other"; }, "Name: must be /research-sandbox-r1-canary"],
    ["another image", (c: any) => { c.Image = `sha256:${"d".repeat(64)}`; }, "Image: must be the recorded image ID"],
    ["another runtime", (c: any) => { c.HostConfig.Runtime = "runc"; }, "HostConfig.Runtime: must be runsc"],
    ["another network", (c: any) => { c.HostConfig.NetworkMode = "bridge"; }, "HostConfig.NetworkMode"],
    ["no HostConfig", (c: any) => { delete c.HostConfig; }, "HostConfig.Runtime"],
    ["still running", (c: any) => { c.State.Status = "running"; c.State.Running = true; }, "State: must be exited with code 0"],
    ["non-zero exit", (c: any) => { c.State.ExitCode = 1; }, "State: must be exited with code 0"],
    ["OOM-killed", (c: any) => { c.State.OOMKilled = true; }, "State: must be exited"],
    ["dead", (c: any) => { c.State.Dead = true; }, "State: must be exited"],
    ["an error", (c: any) => { c.State.Error = "x"; }, "State: must be exited"],
    ["an unknown State key", (c: any) => { c.State.X = 1; }, "State: must be exited"],
    ["restarted", (c: any) => { c.RestartCount = 2; }, "RestartCount: must be 0"],
    ["an exec session", (c: any) => { c.ExecIDs = ["abc"]; }, "ExecIDs: no exec sessions"],
  ])("%s: refused", (_label, mutate, message) => {
    expect(finished(mutate)).toContain(`inspect after the canary: ${message}`);
  });

  it("malformed output and an unrecorded data root refuse", () => {
    expect(validateFinishedInspect([], SPEC, FIN).join("\n")).toContain("expected an array with exactly one container object");
    expect(validateFinishedInspect({}, SPEC, FIN).join("\n")).toContain("expected an array with exactly one container object");
    expect(validateFinishedInspect(finishedInspect(docker29Inspect()), { ...SPEC, dockerDataRoot: null }, FIN).join("\n")).toContain("dockerDataRoot is not recorded");
  });
});

describe("V2.2 keeps M1/M3 blocked", () => {
  it("the frozen blockers are unchanged", () => {
    expect(MEETS_SPEC_BLOCKERS).toHaveLength(2);
    expect(MEETS_SPEC_BLOCKERS[0]).toMatch(/^M1: /);
    expect(MEETS_SPEC_BLOCKERS[1]).toMatch(/^M3: /);
    expect(Object.isFrozen(MEETS_SPEC_BLOCKERS)).toBe(true);
  });
});
