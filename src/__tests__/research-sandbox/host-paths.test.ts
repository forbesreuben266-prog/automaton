/**
 * Host folder checks against a fake filesystem (no real /srv needed), plus
 * one real-filesystem test that the default HostFs uses lstat (detects
 * symlinks) — on a temporary folder only.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { nodeHostFs, resolveSpec, sameIdentities, validatePolicy, verifyContainerHostFiles, verifyEngineTarget, verifyRunDirectories } from "../../research-sandbox/index.js";
import { CONTAINER_ID, DOCKER_CONFIG_DIR, ENGINE_TARGET, FAKE_DATA_ROOT, OPERATOR_UID, POLICY, RUN, SPEC, compliantHostLayout, fakeHostFs } from "./fixtures.js";

const check = (mutate: (l: ReturnType<typeof compliantHostLayout>) => void, policy: any = POLICY) => {
  const layout = compliantHostLayout();
  mutate(layout);
  return verifyRunDirectories(RUN, SPEC, fakeHostFs(layout), policy);
};

describe("host folder checks", () => {
  it("a compliant layout passes and records both folder identities", () => {
    const r = verifyRunDirectories(RUN, SPEC, fakeHostFs(compliantHostLayout()), POLICY);
    expect(r.violations).toEqual([]);
    expect(r.identities).toEqual([
      { path: RUN.inputDir, dev: "64769", ino: "13" },
      { path: RUN.outputDir, dev: "64769", ino: "14" },
    ]);
  });

  it.each(["/srv", "/srv/research-runs", "/srv/research-runs/r1", "/srv/research-runs/r1/in", "/srv/research-runs/r1/out"])(
    "refuses a symbolic link at %s", (p) => {
      expect(check((l) => { l[p].kind = "symlink"; }).violations.join("\n")).toContain(`${p}: is a symbolic link`);
    });

  it("refuses a path that resolves elsewhere (e.g. through a bind mount or symlink above)", () => {
    expect(check((l) => { l["/srv/research-runs/r1/in"].realpath = "/home/user"; }).violations.join("\n")).toContain("resolves to /home/user");
  });

  it("refuses a regular file where a folder is expected", () => {
    expect(check((l) => { l["/srv/research-runs/r1/out"].kind = "file"; }).violations.join("\n")).toContain("is not a directory");
  });

  it.each([
    ["an ancestor owned by another user", (l: any) => { l["/srv"].uid = 4242; }, "/srv: owned by uid 4242"],
    ["a group-writable ancestor", (l: any) => { l["/srv/research-runs"].mode = 0o40775; }, "writable by group or others"],
    ["a world-writable ancestor (sticky tmp-like)", (l: any) => { l["/srv/research-runs/r1"].mode = 0o41777; }, "writable by group or others"],
    ["an input folder others can write", (l: any) => { l["/srv/research-runs/r1/in"].mode = 0o40757; }, "in: writable by group or others"],
    ["an input folder owned by another user", (l: any) => { l["/srv/research-runs/r1/in"].uid = 4242; }, "in: owned by uid 4242"],
    ["an output folder with the wrong owner", (l: any) => { l["/srv/research-runs/r1/out"].uid = OPERATOR(); }, "must be owned by uid 10001"],
    ["an output folder others can read", (l: any) => { l["/srv/research-runs/r1/out"].mode = 0o40750; }, "accessible only by its owner"],
    ["a non-empty output folder", (l: any) => { l["/srv/research-runs/r1/out"].entries = ["old-report.md"]; }, "must be empty"],
    ["a missing folder", (l: any) => { delete l["/srv/research-runs/r1/out"]; }, "cannot be checked (ENOENT)"],
    ["an unreadable folder", (l: any) => { l["/srv/research-runs/r1"].error = "EACCES"; }, "cannot be checked (EACCES)"],
    ["in/ and out/ being the same folder", (l: any) => { l["/srv/research-runs/r1/out"].ino = 13; l["/srv/research-runs/r1/out"].uid = 10001; }, "same directory"],
  ])("refuses %s", (_label, mutate, message) => {
    const r = check(mutate);
    expect(r.violations.join("\n")).toContain(message);
    expect(r.identities).toEqual([]); // no identities from a failing check
  });

  it("refuses paths outside the exact layout before touching the filesystem", () => {
    const hostFs = fakeHostFs(compliantHostLayout());
    const r = verifyRunDirectories({ ...RUN, inputDir: "/home/user" }, SPEC, hostFs, POLICY);
    expect(r.violations.join()).toContain("must be exactly");
    expect(hostFs.calls).toEqual({});
  });

  it("refuses an unsafe policy (root-owned output, negative or missing uids, getters)", () => {
    expect(validatePolicy({ operatorUid: 1000, outputOwnerUid: 0 }).join()).toContain("must not be owned by root");
    expect(validatePolicy({ operatorUid: -1, outputOwnerUid: 10001 }).join()).toContain("operatorUid");
    expect(validatePolicy({ operatorUid: 1000 }).join()).toContain("outputOwnerUid");
    const p = { outputOwnerUid: 10001 };
    Object.defineProperty(p, "operatorUid", { enumerable: true, get: () => 1000 });
    expect(validatePolicy(p).join()).toContain("operatorUid");
  });

  it("identity comparison detects a swapped folder", () => {
    const a = verifyRunDirectories(RUN, SPEC, fakeHostFs(compliantHostLayout()), POLICY).identities;
    const layout = compliantHostLayout();
    layout["/srv/research-runs/r1/in"].ino = 999;
    const b = verifyRunDirectories(RUN, SPEC, fakeHostFs(layout), POLICY).identities;
    expect(sameIdentities(a, a)).toBe(true);
    expect(sameIdentities(a, b)).toBe(false);
    expect(sameIdentities(a, [])).toBe(false);
  });

  it("the real HostFs uses lstat, so it sees symlinks (temporary folder only)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-hostfs-"));
    try {
      fs.mkdirSync(path.join(dir, "real"));
      fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
      expect(nodeHostFs.lstat(path.join(dir, "link")).isSymbolicLink()).toBe(true);
      expect(nodeHostFs.lstat(path.join(dir, "real")).isDirectory()).toBe(true);
      expect(nodeHostFs.realpath(path.join(dir, "link"))).toBe(fs.realpathSync(path.join(dir, "real")));
      expect(nodeHostFs.readdir(path.join(dir, "real"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function OPERATOR() { return 1000; }

describe("H1: engine target (local socket + isolated config folder) verification", () => {
  const target = (mutate: (l: ReturnType<typeof compliantHostLayout>) => void = () => {}, t: any = ENGINE_TARGET) => {
    const layout = compliantHostLayout();
    mutate(layout);
    return verifyEngineTarget(t, SPEC, fakeHostFs(layout), POLICY).join("\n");
  };

  it("the compliant socket (/var/run -> /run, root-owned) and an empty private config folder pass", () => {
    expect(target()).toBe("");
  });

  it("a real /var/run directory (no symlink) with the socket inside it also passes", () => {
    expect(target((l) => {
      l["/var/run"] = { kind: "dir", uid: 0, mode: 0o40755, ino: 21 };
      l["/var/run/docker.sock"] = { kind: "socket", uid: 0, mode: 0o140660, ino: 23 };
    })).toBe("");
  });

  it.each([
    ["no target (engine not pinned)", null, "not pinned"],
    ["another daemon endpoint", { ...ENGINE_TARGET, host: "tcp://10.0.0.5:2375" }, "host must be unix:///var/run/docker.sock"],
    ["a relative config folder", { ...ENGINE_TARGET, configDir: "docker-config" }, "configDir must be a normalized absolute path"],
    ["a config folder inside the runs root", { ...ENGINE_TARGET, configDir: "/srv/research-runs/cfg" }, "outside the runs root"],
    ["a config folder with ..", { ...ENGINE_TARGET, configDir: "/srv/research-engine/../etc" }, "normalized absolute path"],
  ])("refuses %s", (_label, t, message) => {
    expect(target(() => {}, t)).toContain(message);
  });

  it("refuses a getter on the target without reading it", () => {
    let reads = 0;
    const t = Object.defineProperty({ host: "unix:///var/run/docker.sock" }, "configDir", { enumerable: true, get: () => { reads += 1; return DOCKER_CONFIG_DIR; } });
    expect(target(() => {}, t)).toContain("getters/setters are not allowed");
    expect(reads).toBe(0);
  });

  it.each([
    ["socket missing", (l: any) => { delete l["/run/docker.sock"]; }, "/run/docker.sock: cannot be checked (ENOENT)"],
    ["socket is a regular file", (l: any) => { l["/run/docker.sock"].kind = "file"; }, "is not a socket"],
    ["socket owned by a non-root user", (l: any) => { l["/run/docker.sock"].uid = OPERATOR_UID; }, "not root"],
    ["socket world-writable", (l: any) => { l["/run/docker.sock"].mode = 0o140666; }, "writable by others"],
    ["/var/run symlink owned by a non-root user", (l: any) => { l["/var/run"].uid = OPERATOR_UID; }, "/var/run: symbolic link owned by uid"],
    ["/var/run resolving somewhere else", (l: any) => { l["/var/run"].realpath = "/home/x/run"; }, "/var/run: must resolve to /run"],
    ["/run writable by others", (l: any) => { l["/run"].mode = 0o41777; }, "/run: writable by group or others"],
    ["/var a symlink", (l: any) => { l["/var"].kind = "symlink"; }, "/var: is a symbolic link"],
    ["/var/run/docker.sock resolving to another socket", (l: any) => { l["/var/run/docker.sock"].realpath = "/run/user/1000/docker.sock"; }, "resolves to /run/user/1000/docker.sock"],
    ["config folder missing", (l: any) => { delete l[DOCKER_CONFIG_DIR]; }, "cannot be checked (ENOENT)"],
    ["config folder not empty (client config, contexts or plugins)", (l: any) => { l[DOCKER_CONFIG_DIR].entries = ["config.json"]; }, "must be empty"],
    ["config folder readable by group", (l: any) => { l[DOCKER_CONFIG_DIR].mode = 0o40750; }, "accessible only by its owner"],
    ["config folder a symlink", (l: any) => { l[DOCKER_CONFIG_DIR].kind = "symlink"; }, "is a symbolic link"],
    ["config folder owned by another user", (l: any) => { l[DOCKER_CONFIG_DIR].uid = 4242; }, "not root or the operator"],
    ["config folder parent writable by others", (l: any) => { l["/srv/research-engine"].mode = 0o40777; }, "/srv/research-engine: writable by group or others"],
  ])("refuses: %s", (_label, mutate, message) => {
    expect(target(mutate)).toContain(message);
  });
});

describe("v5 review finding 1: host files behind /etc/hosts, /etc/hostname, /etc/resolv.conf", () => {
  const DIR = `${FAKE_DATA_ROOT}/containers/${CONTAINER_ID}`;
  const files = (mutate: (l: any) => void = () => {}, spec = SPEC, id = CONTAINER_ID) => {
    const layout = compliantHostLayout();
    mutate(layout);
    return verifyContainerHostFiles(spec, id, fakeHostFs(layout)).join("\n");
  };

  it("root-owned regular files under root-owned, non-writable directories pass", () => {
    expect(files()).toBe("");
  });

  it("refuses when the data root isn't recorded, or the id is invalid", () => {
    expect(files(() => {}, resolveSpec({}))).toContain("dockerDataRoot is not recorded");
    expect(files(() => {}, SPEC, "not-an-id")).toContain("dockerDataRoot is not recorded");
  });

  it.each([
    ["hosts file is a symlink", (l: any) => { l[`${DIR}/hosts`].kind = "symlink"; }, `${DIR}/hosts: is a symbolic link`],
    ["hostname is a directory", (l: any) => { l[`${DIR}/hostname`].kind = "dir"; }, `${DIR}/hostname: is not a regular file`],
    ["resolv.conf missing", (l: any) => { delete l[`${DIR}/resolv.conf`]; }, `${DIR}/resolv.conf: cannot be checked (ENOENT)`],
    ["hosts owned by a non-root user", (l: any) => { l[`${DIR}/hosts`].uid = OPERATOR_UID; }, "not root"],
    ["hosts writable by group", (l: any) => { l[`${DIR}/hosts`].mode = 0o100664; }, "writable by group or others"],
    ["hosts resolving elsewhere", (l: any) => { l[`${DIR}/hosts`].realpath = "/etc/shadow"; }, "resolves to /etc/shadow"],
    ["containers directory world-writable", (l: any) => { l[`${FAKE_DATA_ROOT}/containers`].mode = 0o40777; }, "writable by group or others"],
    ["data root a symlink", (l: any) => { l[FAKE_DATA_ROOT].kind = "symlink"; }, `${FAKE_DATA_ROOT}: is a symbolic link`],
    ["container directory owned by a non-root user", (l: any) => { l[DIR].uid = OPERATOR_UID; }, `${DIR}: owned by uid`],
  ])("refuses: %s", (_label, mutate, message) => {
    expect(files(mutate)).toContain(message);
  });
});
