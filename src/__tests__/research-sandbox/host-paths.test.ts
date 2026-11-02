/**
 * Host folder checks against a fake filesystem (no real /srv needed), plus
 * one real-filesystem test that the default HostFs uses lstat (detects
 * symlinks) — on a temporary folder only.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  RUNTIME_BINARY_MAX_BYTES, nodeHostFs, resolveSpec, sameIdentities, sameRuntimeBinary, validatePolicy, verifyContainerHostFiles, verifyEngineTarget,
  verifyRunDirectories, verifyRuntimeBinary,
} from "../../research-sandbox/index.js";
import {
  CONTAINER_ID, DOCKER_CONFIG_DIR, DOCKER_INFO, ENGINE_TARGET, FAKE_DATA_ROOT, FAKE_RUNSC_PATH, FAKE_RUNSC_SHA256, OPERATOR_UID, POLICY, RUN, SPEC,
  compliantHostLayout, fakeHostFs,
} from "./fixtures.js";

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

describe("M1: host-side verification of the approved runtime binary (fakes only)", () => {
  const verify = (mutate: (l: any) => void = () => {}, info: any = DOCKER_INFO, spec = SPEC, wrap?: (fs: any) => any) => {
    const layout = compliantHostLayout();
    mutate(layout);
    const hostFs = fakeHostFs(layout);
    return verifyRuntimeBinary(info, "runsc", spec, wrap ? wrap(hostFs) : hostFs);
  };
  const msg = (r: ReturnType<typeof verify>) => r.violations.join("\n");

  it("the recorded binary, configured by docker info, root-owned under root-owned directories, with the recorded hash: verified", () => {
    const r = verify();
    expect(r.violations).toEqual([]);
    expect(r.identity).toEqual({ path: FAKE_RUNSC_PATH, sha256: FAKE_RUNSC_SHA256, dev: "64769", ino: "53", size: 52_000_000, mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000 });
  });

  it("no approved binary recorded: refused without touching the host", () => {
    let calls = 0;
    const r = verify(() => {}, DOCKER_INFO, resolveSpec({}), (f) => ({ ...f, lstat: (p: string) => { calls += 1; return f.lstat(p); } }));
    expect(msg(r)).toContain("no approved runsc binary");
    expect(r.identity).toBeNull();
    expect(calls).toBe(0);
  });

  it.each([
    ["no configuration for runsc", { ...DOCKER_INFO, runtimeConfigs: { runc: { path: "runc" } } }, 'reports no configuration for runtime "runsc"'],
    ["a different path", { ...DOCKER_INFO, runtimeConfigs: { runsc: { path: "/opt/runsc" } } }, `must configure runsc with path ${FAKE_RUNSC_PATH}`],
    ["a bare name resolved through the daemon's PATH", { ...DOCKER_INFO, runtimeConfigs: { runsc: { path: "runsc" } } }, "must configure runsc with path"],
    ["the runtimeType (shim) form, which runs a different binary", { ...DOCKER_INFO, runtimeConfigs: { runsc: { runtimeType: "io.containerd.runsc.v1" } } }, "unsupported runtime configuration key(s) runtimeType"],
    ["shim options alongside the path", { ...DOCKER_INFO, runtimeConfigs: { runsc: { path: FAKE_RUNSC_PATH, options: { BinaryName: "/tmp/x" } } } }, "unsupported runtime configuration key(s) options"],
    ["extra runtime args", { ...DOCKER_INFO, runtimeConfigs: { runsc: { path: FAKE_RUNSC_PATH, runtimeArgs: ["--network=host"] } } }, "runtimeArgs must be absent or empty"],
    ["malformed runtime args", { ...DOCKER_INFO, runtimeConfigs: { runsc: { path: FAKE_RUNSC_PATH, runtimeArgs: "--debug" } } }, "runtimeArgs must be absent or empty"],
    ["config not an object", { ...DOCKER_INFO, runtimeConfigs: { runsc: "/usr/local/bin/runsc" } }, 'reports no configuration for runtime "runsc"'],
  ])("docker info with %s: refused", (_label, info, message) => {
    const r = verify(() => {}, info);
    expect(msg(r)).toContain(message);
    expect(r.identity).toBeNull();
  });

  it.each([
    ["the binary is a symlink", (l: any) => { l[FAKE_RUNSC_PATH].kind = "symlink"; }, `${FAKE_RUNSC_PATH}: is a symbolic link`],
    ["the binary is a directory", (l: any) => { l[FAKE_RUNSC_PATH].kind = "dir"; }, "is not a regular file"],
    ["the binary is missing", (l: any) => { delete l[FAKE_RUNSC_PATH]; }, "cannot be checked (ENOENT)"],
    ["the binary owned by a non-root user", (l: any) => { l[FAKE_RUNSC_PATH].uid = OPERATOR_UID; }, "not root"],
    ["the binary group-writable (replaceable in place)", (l: any) => { l[FAKE_RUNSC_PATH].mode = 0o100775; }, "writable by group or others"],
    ["the binary not executable", (l: any) => { l[FAKE_RUNSC_PATH].mode = 0o100644; }, "is not executable"],
    ["the binary setuid", (l: any) => { l[FAKE_RUNSC_PATH].mode = 0o104755; }, "setuid or setgid"],
    ["the binary resolving elsewhere", (l: any) => { l[FAKE_RUNSC_PATH].realpath = "/opt/other/runsc"; }, "resolves to /opt/other/runsc"],
    ["a parent directory is a symlink", (l: any) => { l["/usr/local/bin"].kind = "symlink"; }, "/usr/local/bin: is a symbolic link"],
    ["a parent directory writable by others (binary replaceable by rename)", (l: any) => { l["/usr/local"].mode = 0o40777; }, "/usr/local: writable by group or others"],
    ["a parent directory owned by a non-root user", (l: any) => { l["/usr"].uid = OPERATOR_UID; }, "/usr: owned by uid"],
    ["the contents differ from the recorded hash", (l: any) => { l[FAKE_RUNSC_PATH].sha256 = "00".repeat(32); }, "SHA-256 does not match the recorded approved binary"],
    ["the binary larger than the hashing limit", (l: any) => { l[FAKE_RUNSC_PATH].size = RUNTIME_BINARY_MAX_BYTES + 1; }, "cannot be hashed (EFBIG)"],
  ])("%s: refused", (_label, mutate, message) => {
    const r = verify(mutate);
    expect(msg(r)).toContain(message);
    expect(r.identity).toBeNull();
  });

  it("time-of-check/time-of-use: the file hashed must be the inode lstat saw", () => {
    const r = verify(() => {}, DOCKER_INFO, SPEC, (f) => ({ ...f, sha256File: (p: string, m: number) => ({ ...f.sha256File(p, m), ino: "999" }) }));
    expect(msg(r)).toContain("the file hashed is not the file checked");
  });

  it("time-of-check/time-of-use: a file swapped or modified while being hashed is refused", () => {
    for (const change of [{ ino: 999 }, { mtimeMs: 1_800_000_000_000 }, { ctimeMs: 1_800_000_000_000 }, { size: 1 }]) {
      const r = verify(() => {}, DOCKER_INFO, SPEC, (f) => {
        let seen = 0;
        return { ...f, lstat: (p: string) => { const st = f.lstat(p); if (p !== FAKE_RUNSC_PATH) return st; seen += 1; return seen > 1 ? { ...st, ...change } : st; } };
      });
      expect(msg(r), JSON.stringify(change)).toMatch(/changed while it was being verified|the file hashed is not the file checked/);
    }
  });

  it("sameRuntimeBinary detects any difference in path, hash, inode, size or times", () => {
    const id = verify().identity!;
    expect(sameRuntimeBinary(id, { ...id })).toBe(true);
    for (const change of [{ path: "/usr/bin/runsc" }, { sha256: "00".repeat(32) }, { dev: "1" }, { ino: "1" }, { size: 1 }, { mtimeMs: 1 }, { ctimeMs: 1 }]) {
      expect(sameRuntimeBinary(id, { ...id, ...change }), JSON.stringify(change)).toBe(false);
    }
  });

  it("the real HostFs hashes through O_NOFOLLOW: symlinks, directories and oversized files fail (temporary folder only)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-hash-"));
    try {
      const file = path.join(dir, "bin");
      const content = Buffer.from("fake runtime binary contents\n".repeat(1000));
      fs.writeFileSync(file, content);
      const d = nodeHostFs.sha256File(file, 1 << 20);
      expect(d.sha256).toBe(createHash("sha256").update(content).digest("hex"));
      expect(d.size).toBe(content.length);
      expect(d.ino).toBe(String(fs.statSync(file).ino));
      fs.symlinkSync(file, path.join(dir, "link"));
      expect(() => nodeHostFs.sha256File(path.join(dir, "link"), 1 << 20)).toThrow(expect.objectContaining({ code: "ELOOP" }));
      expect(() => nodeHostFs.sha256File(dir, 1 << 20)).toThrow();
      expect(() => nodeHostFs.sha256File(file, 10)).toThrow(expect.objectContaining({ code: "EFBIG" }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("C1, C3, C5: runtime arguments, FIFO hashing and status shape", () => {
  const cfg = (runsc: unknown) => verifyRuntimeBinary({ ...DOCKER_INFO, runtimeConfigs: { runsc } } as any, "runsc", SPEC, fakeHostFs(compliantHostLayout())).violations.join("\n");

  it.each([
    ["absent runtimeArgs", { path: FAKE_RUNSC_PATH }],
    ["empty runtimeArgs", { path: FAKE_RUNSC_PATH, runtimeArgs: [] }],
    ["an empty status object", { path: FAKE_RUNSC_PATH, status: {} }],
    ["a status object of strings", { path: FAKE_RUNSC_PATH, status: { "org.opencontainers.runtime-spec.features": "{\"ociVersionMin\":\"1.0.0\"}" } }],
  ])("C1/C5 accepted: %s", (_label, runsc) => {
    expect(cfg(runsc)).toBe("");
  });

  it.each([
    ["C1: one flag", { path: FAKE_RUNSC_PATH, runtimeArgs: ["--platform=systrap"] }, "runtimeArgs must be absent or empty"],
    ["C1: a host-path logging flag", { path: FAKE_RUNSC_PATH, runtimeArgs: ["--debug-log=/etc/cron.d/x"] }, "runtimeArgs must be absent or empty"],
    ["C1: null runtimeArgs (unexpected format)", { path: FAKE_RUNSC_PATH, runtimeArgs: null }, "runtimeArgs must be absent or empty"],
    ["C1: string runtimeArgs", { path: FAKE_RUNSC_PATH, runtimeArgs: "--rootless" }, "runtimeArgs must be absent or empty"],
    ["C1: an empty-string arg", { path: FAKE_RUNSC_PATH, runtimeArgs: [""] }, "runtimeArgs must be absent or empty"],
    ["C5: numeric status", { path: FAKE_RUNSC_PATH, status: 42 }, "status, when reported, must be an object of string values"],
    ["C5: array status", { path: FAKE_RUNSC_PATH, status: ["a"] }, "status, when reported, must be an object of string values"],
    ["C5: null status", { path: FAKE_RUNSC_PATH, status: null }, "status, when reported, must be an object of string values"],
    ["C5: string status", { path: FAKE_RUNSC_PATH, status: "ok" }, "status, when reported, must be an object of string values"],
    ["C5: non-string value", { path: FAKE_RUNSC_PATH, status: { a: 1 } }, "status, when reported, must be an object of string values"],
    ["C5: nested object value", { path: FAKE_RUNSC_PATH, status: { a: { b: "c" } } }, "status, when reported, must be an object of string values"],
  ])("refused: %s", (_label, runsc, message) => {
    expect(cfg(runsc)).toContain(message);
  });

  it("C3: hashing a FIFO is refused promptly instead of blocking (real filesystem, child process with a timeout)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-fifo-"));
    try {
      const fifo = path.join(dir, "runsc");
      execFileSync("/usr/bin/mkfifo", [fifo]);
      const script = path.join(dir, "probe.mts");
      const hostPaths = path.resolve(__dirname, "../../research-sandbox/host-paths.ts");
      fs.writeFileSync(script, `import { nodeHostFs } from ${JSON.stringify(hostPaths)};
try { nodeHostFs.sha256File(process.argv[2], 1 << 20); console.log("RETURNED"); } catch (e) { console.log("THREW " + e.code); }\n`);
      const tsx = path.resolve(__dirname, "../../../node_modules/.bin/tsx");
      const r = spawnSync(tsx, [script, fifo], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } });
      expect(r.error, "the hash call blocked until the timeout").toBeUndefined();
      expect(r.signal).toBeNull();
      expect(r.stdout.trim()).toBe("THREW EINVAL"); // opened without blocking, then refused as not a regular file
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
