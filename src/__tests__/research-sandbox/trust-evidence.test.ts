/**
 * Step A1 (M3 evidence): the read-only trust evidence collector and its
 * fail-closed evaluation, with fake query results and a fake filesystem.
 * Fingerprints are checked against keys generated with gpg for these tests
 * (public keys only, in ./openpgp/; expected values are gpg's own output).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessResult } from "../../research-sandbox/engine.js";
import {
  DOCKER_SIGNING_FINGERPRINT, EVIDENCE_LIMITS, TRUST_EVIDENCE_CONFIRM_FLAG, aptPolicySources, collectTrustEvidence, duplicateJsonKey, evaluateTrustEvidence, evidenceDigest,
  openpgpFingerprints, parseAptSources, parseExecStart, runTrustEvidenceCommand, stripUserinfo, type FileStat, type TrustEvidence, type TrustEvidenceDeps,
} from "../../research-sandbox/trust-evidence.js";

const KEYS = path.join(__dirname, "openpgp");
const ED25519 = "BD316E7BDC511F2DF785D0658B52F4CA0A318E29";
const RSA = "4A299CE27391D4F05D7776756447520742A216DD";
const asc = (f: string) => fs.readFileSync(path.join(KEYS, f));
const binaryOf = (armored: Buffer) => {
  const t = armored.toString("latin1").split("\n");
  const start = t.findIndex((l) => l.trim() === "") + 1;
  return Buffer.from(t.slice(start).filter((l) => l && !l.startsWith("=") && !l.startsWith("-----")).join(""), "base64");
};

/** Packet tags of a binary OpenPGP stream (the test keyrings use only 1- and 2-octet lengths). */
function packetTags(b: Buffer): number[] {
  const tags: number[] = [];
  for (let i = 0; i < b.length;) {
    const h = b[i];
    if (h & 0x40) {
      const o1 = b[i + 1];
      const [len, hl] = o1 < 192 ? [o1, 2] : o1 < 224 ? [((o1 - 192) << 8) + b[i + 2] + 192, 3] : [b.readUInt32BE(i + 2), 6];
      tags.push(h & 0x3f); i += hl + len;
    } else {
      const lt = h & 3;
      const [len, hl] = lt === 0 ? [b[i + 1], 2] : lt === 1 ? [b.readUInt16BE(i + 1), 3] : [b.readUInt32BE(i + 1), 5];
      tags.push((h >> 2) & 0xf); i += hl + len;
    }
  }
  return tags;
}

describe("A1: OpenPGP fingerprints (public keys only)", () => {
  it("match gpg for an ed25519 and an RSA-3072 key, armored and binary, one or several keys", () => {
    expect(openpgpFingerprints(asc("ed25519.asc"))).toEqual([ED25519]);
    expect(openpgpFingerprints(asc("rsa3072.asc"))).toEqual([RSA]);
    expect(openpgpFingerprints(binaryOf(asc("ed25519.asc")))).toEqual([ED25519]);
    expect(openpgpFingerprints(binaryOf(asc("rsa3072.asc")))).toEqual([RSA]);
    expect(openpgpFingerprints(asc("two-keys.asc"))).toEqual([ED25519, RSA]);
  });

  it.each([
    ["empty", Buffer.alloc(0)], ["not OpenPGP", Buffer.from("hello world")], ["truncated", binaryOf(asc("rsa3072.asc")).subarray(0, 100)],
    ["broken armor", Buffer.from("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n!!!!\n-----END PGP PUBLIC KEY BLOCK-----\n")],
    ["no public key packet", Buffer.from([0xb4, 0x01, 0x41])],
  ])("%s: null (fail closed)", (_l, bytes) => {
    expect(openpgpFingerprints(bytes)).toBeNull();
  });

  it("the test keyrings contain no private key material", () => {
    for (const f of fs.readdirSync(KEYS)) {
      const text = fs.readFileSync(path.join(KEYS, f), "utf8");
      expect(text).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----");
      expect(text).not.toMatch(/PRIVATE/);
      expect(packetTags(binaryOf(Buffer.from(text))).filter((t) => t === 5 || t === 7), `${f} secret-key packets`).toEqual([]);
      expect(packetTags(binaryOf(Buffer.from(text)))).toContain(6);
    }
  });
});

describe("A1: parsers", () => {
  it("apt sources: one-line and deb822; signed-by, inline keys, trusted=yes; user:password removed", () => {
    expect(parseAptSources("/etc/apt/sources.list.d/docker.list", "# c\ndeb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n"))
      .toEqual([{ file: "/etc/apt/sources.list.d/docker.list", uris: ["https://download.docker.com/linux/ubuntu"], signedBy: "/etc/apt/keyrings/docker.asc", signedByInline: false, trusted: false }]);
    expect(parseAptSources("/x.list", "deb [trusted=yes] https://user:secret@storage.googleapis.com/gvisor/releases release main")[0]).toMatchObject({ uris: ["https://storage.googleapis.com/gvisor/releases"], trusted: true, signedBy: null });
    const deb822 = "Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n\nTypes: deb\nURIs: https://x.invalid\nEnabled: no\n";
    expect(parseAptSources("/d.sources", deb822)).toEqual([{ file: "/d.sources", uris: ["https://download.docker.com/linux/ubuntu"], signedBy: "/etc/apt/keyrings/docker.asc", signedByInline: false, trusted: false }]);
    expect(parseAptSources("/i.sources", "URIs: https://download.docker.com/linux/ubuntu\nSigned-By: -----BEGIN PGP PUBLIC KEY BLOCK-----\n .\n abc\n -----END PGP PUBLIC KEY BLOCK-----\n")[0]).toMatchObject({ signedBy: null, signedByInline: true });
    expect(stripUserinfo("see https://u:p@h.example/x and http://h2/y")).toBe("see https://h.example/x and http://h2/y");
  });

  it("apt-cache policy: the sources of exactly the installed version", () => {
    const t = ["docker-ce:", "  Installed: 5:29.9.3-1~ubuntu.24.04~noble", "  Candidate: 5:29.9.4-1~ubuntu.24.04~noble", "  Version table:",
      "     5:29.9.4-1~ubuntu.24.04~noble 500", "        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages",
      " *** 5:29.9.3-1~ubuntu.24.04~noble 500", "        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages", "        100 /var/lib/dpkg/status"].join("\n");
    expect(aptPolicySources(t, "docker-ce", "5:29.9.3-1~ubuntu.24.04~noble")).toEqual(["https://download.docker.com/linux/ubuntu", "/var/lib/dpkg/status"]);
    expect(aptPolicySources(t, "docker-ce", "5:1.0")).toBeNull();
    expect(aptPolicySources(t, "runsc", "x")).toBeNull();
  });

  it("systemctl show ExecStart and duplicate JSON keys", () => {
    expect(parseExecStart("ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock ; ignore_errors=no ; }\nDropInPaths=\n"))
      .toEqual(["/usr/bin/dockerd", "-H", "fd://", "--containerd=/run/containerd/containerd.sock"]);
    expect(parseExecStart("ExecStart=\n")).toBeNull();
    expect(duplicateJsonKey('{"a":1,"b":{"a":2},"c":"\\"a\\":3"}')).toBeNull();
    expect(duplicateJsonKey('{"runtimes":{},"runtimes":{}}')).toBe("runtimes");
  });
});

// ---------------------------------------------------------------- a fake host

const RUNSC = "/usr/bin/runsc";
const EXPECT = { engineBinary: "/usr/bin/docker", engineConfigDir: "/srv/research-engine/docker-config", dockerServerVersion: "29.9.3", runscPath: RUNSC };
const ok = (stdout: string): ProcessResult => ({ exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, truncated: false });
const policy = (pkg: string, v: string, url: string) => `${pkg}:\n  Installed: ${v}\n  Candidate: ${v}\n  Version table:\n *** ${v} 500\n        500 ${url} noble/stable amd64 Packages\n        100 /var/lib/dpkg/status\n`;
const SECRET = "s3cr3t-value-never-recorded";

function host(over: { daemonJson?: string | null; files?: Record<string, string | null>; runs?: Record<string, ProcessResult>; stat?: Record<string, FileStat> } = {}) {
  const VERS: Record<string, [string, string]> = {
    "docker-ce": ["5:29.9.3-1~ubuntu.24.04~noble", "https://download.docker.com/linux/ubuntu"], "docker-ce-cli": ["5:29.9.3-1~ubuntu.24.04~noble", "https://download.docker.com/linux/ubuntu"],
    "containerd.io": ["2.2.1-1~ubuntu.24.04~noble", "https://download.docker.com/linux/ubuntu"], runsc: ["20261102.0", "https://storage.googleapis.com/gvisor/releases"],
  };
  const runs: Record<string, ProcessResult> = {};
  for (const [p, [v, url]] of Object.entries(VERS)) {
    runs[`/usr/bin/dpkg-query -W -f=\${Version}\\t\${db:Status-Abbrev} ${p}`] = ok(`${v}\tii `);
    runs[`/usr/bin/dpkg --verify ${p}`] = ok("");
    runs[`/usr/bin/apt-cache policy ${p}`] = ok(policy(p, v, url));
  }
  runs["/usr/bin/systemctl show docker.service --property=ExecStart --property=DropInPaths --no-pager"] =
    ok("ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock ; ignore_errors=no ; start_time=[n/a] ; }\nDropInPaths=\n");
  const g = `--host unix:///var/run/docker.sock --config ${EXPECT.engineConfigDir}`;
  runs[`/usr/bin/docker ${g} info --format {{json .}}`] = ok(JSON.stringify({
    ServerVersion: "29.9.3", SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"], DefaultRuntime: "runc", Driver: "overlayfs",
    Runtimes: { runc: { path: "runc" }, runsc: { path: RUNSC, runtimeArgs: ["--oci-seccomp"] } }, HttpProxy: `http://user:${SECRET}@proxy.invalid:3128`, Name: "vps-hostname", Labels: [`token=${SECRET}`],
  }));
  runs[`/usr/bin/docker ${g} version --format {{json .}}`] = ok(JSON.stringify({ Client: { Version: "29.9.3" }, Server: { Version: "29.9.3", Components: [{ Name: "Engine", Version: "29.9.3", Details: { GitCommit: "abc1234" } }] } }));
  Object.assign(runs, over.runs ?? {});
  const files: Record<string, string | null> = {
    "/etc/apt/sources.list": "",
    "/etc/apt/sources.list.d/docker.list": "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n",
    "/etc/apt/sources.list.d/gvisor.list": "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n",
    "/etc/docker/daemon.json": over.daemonJson === undefined ? JSON.stringify({ runtimes: { runsc: { path: RUNSC, runtimeArgs: ["--oci-seccomp"] } }, features: { "containerd-snapshotter": true } }) : over.daemonJson,
    "/sys/kernel/security/lsm": "lockdown,capability,landlock,yama,apparmor\n", "/sys/module/apparmor/parameters/enabled": "Y\n",
    ...over.files,
  };
  const bytes: Record<string, Buffer> = { "/etc/apt/keyrings/docker.asc": asc("ed25519.asc"), "/usr/share/keyrings/gvisor-archive-keyring.gpg": binaryOf(asc("rsa3072.asc")),
    "/usr/bin/dockerd": Buffer.from("d"), "/usr/bin/docker": Buffer.from("c"), "/usr/bin/containerd": Buffer.from("ct"), "/usr/bin/containerd-shim-runc-v2": Buffer.from("s"), "/usr/bin/runc": Buffer.from("r") };
  const calls: string[] = [];
  const deps: TrustEvidenceDeps = {
    run: async (file, args) => { const k = [file, ...args].join(" "); calls.push(k); return runs[k] ?? { exitCode: 1, signal: null, stdout: "", stderr: "unexpected", timedOut: false, truncated: false }; },
    readFile: (p) => (p in files ? files[p] : null),
    readBytes: (p) => bytes[p] ?? null,
    lstat: (p) => over.stat?.[p] ?? (p in bytes ? { uid: 0, mode: 0o100644, isFile: true, isSymbolicLink: false } : null),
    readdir: (p) => (p === "/etc/apt/sources.list.d" ? Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)) : []),
    now: () => "2026-11-05T00:00:00.000Z",
  };
  return { deps, calls };
}
/** The evaluation needs Docker's real key: the collected test keyring is substituted by that fingerprint. */
const withDockerKey = (e: TrustEvidence): TrustEvidence => ({ ...e, aptSources: e.aptSources.map((s) => (s.uris[0].includes("docker") ? { ...s, fingerprints: [DOCKER_SIGNING_FINGERPRINT] } : s)) });
const blocking = (e: TrustEvidence) => evaluateTrustEvidence(e, EXPECT).filter((f) => f.severity === "blocking").map((f) => f.message);

describe("A1: collection (read-only)", () => {
  it("runs only the fixed query commands, no shell, nothing that changes the host", async () => {
    const h = host();
    await collectTrustEvidence(h.deps, EXPECT);
    for (const c of h.calls) {
      expect(/^\/usr\/bin\/(dpkg-query -W |dpkg --verify |apt-cache policy |systemctl show docker\.service |docker --host unix:\/\/\/var\/run\/docker\.sock --config \S+ (info|version) --format \{\{json \.\}\}$)/.test(c), c).toBe(true);
    }
    expect(h.calls.join("\n")).not.toMatch(/install|remove|purge|start|stop|restart|reload|create|run |rm |set-property|edit/);
  });

  it("records keyring fingerprints, package sources and the dockerd command line", async () => {
    const e = await collectTrustEvidence(host().deps, EXPECT);
    expect(e.aptSources.map((s) => s.fingerprints)).toEqual([[ED25519], [RSA]]);
    expect(e.packages["docker-ce"]).toEqual({ installed: "5:29.9.3-1~ubuntu.24.04~noble", status: "ii", verify: [], sources: ["https://download.docker.com/linux/ubuntu", "/var/lib/dpkg/status"] });
    expect(e.dockerd).toEqual({ argv: ["/usr/bin/dockerd", "-H", "fd://", "--containerd=/run/containerd/containerd.sock"], dropIns: [] });
    expect(e.dockerVersion?.components).toEqual([{ name: "Engine", version: "29.9.3", gitCommit: "abc1234" }]);
  });

  it("never records secrets: proxy and label values from docker info, other daemon.json values, apt passwords, unreviewed flag values", async () => {
    const h = host({
      daemonJson: JSON.stringify({ runtimes: { runsc: { path: RUNSC, runtimeArgs: ["--oci-seccomp"] } }, "log-opts": { "splunk-token": SECRET } }),
      files: { "/etc/apt/sources.list.d/docker.list": `deb [signed-by=/etc/apt/keyrings/docker.asc] https://me:${SECRET}@download.docker.com/linux/ubuntu noble stable\n` },
      runs: { "/usr/bin/systemctl show docker.service --property=ExecStart --property=DropInPaths --no-pager": ok(`ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// --tlskey=${SECRET} ; }\nDropInPaths=\n`) },
    });
    const e = await collectTrustEvidence(h.deps, EXPECT);
    const findings = evaluateTrustEvidence(e, EXPECT);
    const text = JSON.stringify({ e, findings });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("vps-hostname");
    expect(e.dockerd.argv).toEqual(["/usr/bin/dockerd", "-H", "<value>", "--tlskey=<value>"]);
    expect(findings.map((x) => x.message).join("\n")).toContain('flag names: ["-H","--tlskey"]');
    expect(e.daemonJson.keys).toEqual(["log-opts", "runtimes"]);
  });
});

describe("A1: evaluation (fail closed)", () => {
  it("the reviewed configuration has no blocking finding; the gVisor key is left for the decision record", async () => {
    const e = withDockerKey(await collectTrustEvidence(host().deps, EXPECT));
    expect(blocking(e)).toEqual([]);
    expect(evaluateTrustEvidence(e, EXPECT).map((f) => f.message).join("\n")).toContain(`gVisor signing key fingerprint(s) ${RSA}`);
  });

  it("the test keyring is not Docker's key: refused", async () => {
    expect(blocking(await collectTrustEvidence(host().deps, EXPECT)).join("\n")).toContain(`does not contain Docker's published signing key ${DOCKER_SIGNING_FINGERPRINT}`);
  });

  const fail = (label: string, over: Parameters<typeof host>[0], message: string) => [label, over, message] as const;
  it.each([
    fail("a changed package file", { runs: { "/usr/bin/dpkg --verify docker-ce": ok("??5??????   /usr/bin/dockerd\n") } }, "package docker-ce: dpkg --verify reports changed files: ??5??????   /usr/bin/dockerd"),
    fail("a package not installed", { runs: { "/usr/bin/dpkg-query -W -f=${Version}\\t${db:Status-Abbrev} containerd.io": { exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false } } }, "package containerd.io: not installed"),
    fail("a half-installed package", { runs: { "/usr/bin/dpkg-query -W -f=${Version}\\t${db:Status-Abbrev} runsc": ok("20261102.0\tiU ") } }, 'package runsc: dpkg status is "iU"'),
    fail("installed from a local .deb only", { runs: { "/usr/bin/apt-cache policy docker-ce": ok("docker-ce:\n  Installed: 5:29.9.3-1~ubuntu.24.04~noble\n  Version table:\n *** 5:29.9.3-1~ubuntu.24.04~noble 100\n        100 /var/lib/dpkg/status\n") } }, "not traceable to the signed repository"),
    fail("a plain-http repository", { runs: { "/usr/bin/apt-cache policy runsc": ok(policy("runsc", "20261102.0", "http://storage.googleapis.com/gvisor/releases")) } }, "package runsc: installed version 20261102.0 is not available from https://storage.googleapis.com/gvisor/releases"),
    fail("a mirror", { runs: { "/usr/bin/apt-cache policy docker-ce-cli": ok(policy("docker-ce-cli", "5:29.9.3-1~ubuntu.24.04~noble", "https://mirror.example/docker")) } }, "package docker-ce-cli: installed version"),
    fail("trusted=yes", { files: { "/etc/apt/sources.list.d/gvisor.list": "deb [trusted=yes signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n" } }, "trusted=yes disables signature checks"),
    fail("no signed-by", { files: { "/etc/apt/sources.list.d/docker.list": "deb https://download.docker.com/linux/ubuntu noble stable\n" } }, "no signed-by keyring"),
    fail("no gVisor source", { files: { "/etc/apt/sources.list.d/gvisor.list": null } }, "apt source for gvisor (storage.googleapis.com): none found"),
    fail("a writable keyring", { stat: { "/usr/share/keyrings/gvisor-archive-keyring.gpg": { uid: 0, mode: 0o100666, isFile: true, isSymbolicLink: false } } }, "is writable by group or others"),
    fail("a keyring not owned by root", { stat: { "/usr/share/keyrings/gvisor-archive-keyring.gpg": { uid: 1000, mode: 0o100644, isFile: true, isSymbolicLink: false } } }, "is not owned by root"),
    fail("a symlinked keyring", { stat: { "/usr/share/keyrings/gvisor-archive-keyring.gpg": { uid: 0, mode: 0o120777, isFile: false, isSymbolicLink: true } } }, "not a parseable OpenPGP public keyring"),
    fail("an extra dockerd flag", { runs: { "/usr/bin/systemctl show docker.service --property=ExecStart --property=DropInPaths --no-pager": ok("ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// --seccomp-profile=/tmp/p.json ; }\nDropInPaths=\n") } }, 'flag names: ["-H","--seccomp-profile"]'),
    fail("a TCP API socket", { runs: { "/usr/bin/systemctl show docker.service --property=ExecStart --property=DropInPaths --no-pager": ok("ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 ; }\nDropInPaths=\n") } }, "dockerd: startup flags differ from the reviewed unit"),
    fail("a drop-in", { runs: { "/usr/bin/systemctl show docker.service --property=ExecStart --property=DropInPaths --no-pager": ok("ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock ; }\nDropInPaths=/etc/systemd/system/docker.service.d/override.conf\n") } }, "systemd drop-ins present (/etc/systemd/system/docker.service.d/override.conf)"),
    fail("daemon.json missing", { daemonJson: null }, "/etc/docker/daemon.json: missing"),
    fail("daemon.json invalid", { daemonJson: "{" }, "not a valid JSON object"),
    fail("a duplicate key", { daemonJson: '{"runtimes":{"runsc":{"path":"/usr/bin/runsc","runtimeArgs":["--oci-seccomp"]}},"runtimes":{"runsc":{"path":"/usr/bin/runsc","runtimeArgs":["--oci-seccomp"]}}}' }, 'repeats the key "runtimes"'),
    fail("a seccomp-profile override", { daemonJson: JSON.stringify({ runtimes: { runsc: { path: RUNSC, runtimeArgs: ["--oci-seccomp"] } }, "seccomp-profile": "unconfined" }) }, 'unreviewed top-level keys ["seccomp-profile"]'),
    fail("runsc without the flag in daemon.json", { daemonJson: JSON.stringify({ runtimes: { runsc: { path: RUNSC } } }) }, "runtimes must be exactly"),
    fail("an extra runtime", { daemonJson: JSON.stringify({ runtimes: { runsc: { path: RUNSC, runtimeArgs: ["--oci-seccomp"] }, kata: { path: "/usr/bin/kata" } } }) }, "runtimes must be exactly"),
  ])("%s: blocking", async (_l, over, message) => {
    const e = withDockerKey(await collectTrustEvidence(host(over).deps, EXPECT));
    expect(blocking(e).join("\n")).toContain(message);
  });

  it.each([
    ["a custom seccomp profile", { SecurityOptions: ["name=seccomp,profile=/etc/x.json"] }, "seccomp must be exactly name=seccomp,profile=builtin"],
    ["rootless", { SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"] }, "rootless Docker"],
    ["another default runtime", { DefaultRuntime: "runsc" }, "DefaultRuntime must be runc"],
    ["another server version", { ServerVersion: "29.9.4" }, "is not the pinned 29.9.3"],
    ["runsc without the flag", { Runtimes: { runsc: { path: RUNSC } } }, "docker info: runsc must be"],
  ])("docker info with %s: blocking", async (_l, patch, message) => {
    const h = host();
    const g = `--host unix:///var/run/docker.sock --config ${EXPECT.engineConfigDir}`;
    const base = JSON.parse((await h.deps.run("/usr/bin/docker", g.split(" ").concat(["info", "--format", "{{json .}}"]), { timeoutMs: 1, maxOutputBytes: 1 })).stdout);
    const e = withDockerKey(await collectTrustEvidence(host({ runs: { [`/usr/bin/docker ${g} info --format {{json .}}`]: ok(JSON.stringify({ ...base, ...patch })) } }).deps, EXPECT));
    expect(blocking(e).join("\n")).toContain(message);
  });

  it("docker unreachable: blocking, never a pass", async () => {
    const g = `--host unix:///var/run/docker.sock --config ${EXPECT.engineConfigDir}`;
    const down = { exitCode: 1, signal: null, stdout: "", stderr: "Cannot connect", timedOut: false, truncated: false };
    const e = withDockerKey(await collectTrustEvidence(host({ runs: { [`/usr/bin/docker ${g} info --format {{json .}}`]: down, [`/usr/bin/docker ${g} version --format {{json .}}`]: down } }).deps, EXPECT));
    expect(blocking(e)).toEqual(expect.arrayContaining(["docker info: could not be read"]));
  });

  it("the digest is canonical (key order does not matter) and changes with any value", () => {
    expect(evidenceDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(evidenceDigest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(evidenceDigest({ a: 1 })).not.toBe(evidenceDigest({ a: 2 }));
    expect(evidenceDigest({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("A1: operator command", () => {
  const cmd = async (argv: string[], over: Parameters<typeof host>[0] = {}, pins: Record<string, unknown> = { dockerServerVersion: "29.9.3", runscBinary: { path: RUNSC } }) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runTrustEvidenceCommand(argv, {
      readConfig: () => "{}", parseConfig: () => ({ engineBinary: EXPECT.engineBinary, engineConfigDir: EXPECT.engineConfigDir, pins }),
      evidence: host(over).deps, out: (t) => out.push(t), err: (t) => err.push(t),
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  it.each([[[]], [["--config", "/x.json"]], [["--config", "rel.json", TRUST_EVIDENCE_CONFIRM_FLAG]], [["--config", "/x.json", "--yes"]]])("usage %j: exit 2, nothing collected", async (argv) => {
    const r = await cmd(argv);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
  });
  it("missing pins: exit 2", async () => {
    expect((await cmd(["--config", "/x.json", TRUST_EVIDENCE_CONFIRM_FLAG], {}, {})).code).toBe(2);
  });
  it("prints one JSON document with findings and a digest; exit 1 while anything blocks (here: the test key is not Docker's)", async () => {
    const r = await cmd(["--config", "/x.json", TRUST_EVIDENCE_CONFIRM_FLAG]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.out);
    expect(doc.kind).toBe("research-sandbox-trust-evidence");
    expect(doc.blocking).toBeGreaterThan(0);
    const { digest, ...body } = doc;
    expect(digest).toBe(evidenceDigest(body));
  });
});

describe("Step A final review: secrets, evidence kinds and verdicts", () => {
  it("other runtimes' arguments and unapproved runsc arguments are never recorded (names only)", async () => {
    const e = await collectTrustEvidence(host({
      daemonJson: JSON.stringify({ runtimes: { runsc: { path: RUNSC, runtimeArgs: ["--oci-seccomp"] }, kata: { path: "/usr/bin/kata", runtimeArgs: [`--token=${SECRET}`] } } }),
      runs: { [`/usr/bin/docker --host unix:///var/run/docker.sock --config ${EXPECT.engineConfigDir} info --format {{json .}}`]: ok(JSON.stringify({ ServerVersion: "29.9.3", SecurityOptions: [], DefaultRuntime: "runc",
        Runtimes: { runsc: { path: RUNSC, runtimeArgs: [`--debug-log=/tmp/${SECRET}`] }, kata: { path: "/x", runtimeArgs: [SECRET] } } })) },
    }).deps, EXPECT);
    const text = JSON.stringify(e);
    expect(text).not.toContain(SECRET);
    expect(e.daemonJson.otherRuntimes).toEqual(["kata"]);
    expect(e.runscRuntime).toEqual({ path: RUNSC, runtimeArgs: "(other values; not recorded)" });
    const msgs = blocking(withDockerKey(e)).join("\n");
    expect(msgs).toContain('(other runtimes: ["kata"])');
    expect(msgs).toContain("docker info: runsc must be");
    expect(msgs).not.toContain(SECRET);
  });

  it("every finding names what it is evidence of, and every report states the limits of each kind", async () => {
    const e = await collectTrustEvidence(host({ runs: { "/usr/bin/dpkg --verify runsc": ok("??5?????? c /etc/containerd/runsc.toml\n") } }).deps, EXPECT);
    const f = evaluateTrustEvidence(e, EXPECT);
    expect(f.find((x) => x.message.includes("dpkg --verify reports"))?.kind).toBe("integrity");
    expect(f.find((x) => x.message.includes("Docker's published signing key"))?.kind).toBe("signature");
    expect(f.find((x) => x.message.includes("gVisor signing key"))?.kind).toBe("signature");
    for (const x of f) expect(["origin", "signature", "integrity", "configuration", "daemon"]).toContain(x.kind);
    const origin = evaluateTrustEvidence(await collectTrustEvidence(host({ runs: { "/usr/bin/apt-cache policy runsc": ok(policy("runsc", "20261102.0", "https://mirror.invalid/x")) } }).deps, EXPECT), EXPECT);
    expect(origin.find((x) => x.message.includes("not traceable"))?.kind).toBe("origin");
    expect(EVIDENCE_LIMITS.signature).toContain("not a cryptographic proof about them");
    expect(EVIDENCE_LIMITS.integrity).toContain("root could alter both");
    expect(EVIDENCE_LIMITS.origin).toContain("does not prove these installed bytes were downloaded from it");
  });

  it("exit codes never present incomplete evidence as clean: 1 blocking, 4 review only, 0 only with no findings", async () => {
    const run = async (evidence: TrustEvidenceDeps) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runTrustEvidenceCommand(["--config", "/x.json", TRUST_EVIDENCE_CONFIRM_FLAG], { readConfig: () => "{}",
        parseConfig: () => ({ engineBinary: EXPECT.engineBinary, engineConfigDir: EXPECT.engineConfigDir, pins: { dockerServerVersion: "29.9.3", runscBinary: { path: RUNSC } } }),
        evidence, out: (t) => out.push(t), err: (t) => err.push(t) });
      return { code, doc: JSON.parse(out.join("")), err: err.join("") };
    };
    const blockingRun = await run(host().deps); // the test key is not Docker's
    expect(blockingRun.code).toBe(1);
    expect(blockingRun.doc.verdict).toBe("blocking");
    expect(blockingRun.err).toContain("This is NOT a clean result.");
    // Docker's key cannot be produced in a test, so "review only" is shown by evaluating, then mapping, the same way the command does.
    const e = withDockerKey(await collectTrustEvidence(host().deps, EXPECT));
    const f = evaluateTrustEvidence(e, EXPECT);
    expect(f.filter((x) => x.severity === "blocking")).toEqual([]);
    expect(f.filter((x) => x.severity === "review").length).toBeGreaterThan(0); // the gVisor key is always left for review
    expect(blockingRun.doc.limits).toEqual(EVIDENCE_LIMITS);
    const src = fs.readFileSync(path.join(__dirname, "../../research-sandbox/trust-evidence.ts"), "utf8");
    expect(src).toContain('return verdict === "clean" ? 0 : verdict === "blocking" ? 1 : 4;');
    expect(src).toContain('const verdict = blocking > 0 ? "blocking" : findings.length > 0 ? "needs-review" : "clean";');
  });

  it("a query that fails is a blocking finding, never silently skipped", async () => {
    const fails = { exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false };
    for (const [k, message] of [["/usr/bin/dpkg --verify docker-ce", "dpkg --verify could not be run"], ["/usr/bin/systemctl show docker.service --property=ExecStart --property=DropInPaths --no-pager", "the systemd ExecStart command line could not be read"],
      ["/usr/bin/apt-cache policy containerd.io", "is not listed by apt-cache policy"]] as const) {
      const e = withDockerKey(await collectTrustEvidence(host({ runs: { [k]: fails } }).deps, EXPECT));
      expect(blocking(e).join("\n"), k).toContain(message);
    }
    for (const broken of [{ ...ok(""), timedOut: true }, { ...ok("partial"), timedOut: true }, { ...ok(""), truncated: true }, { ...ok(""), exitCode: -1, signal: "SIGKILL" }, { ...ok(""), exitCode: 2 }]) {
      const e = withDockerKey(await collectTrustEvidence(host({ runs: { "/usr/bin/dpkg --verify runsc": broken } }).deps, EXPECT));
      expect(blocking(e).join("\n"), JSON.stringify(broken)).toContain("package runsc: dpkg --verify could not be run");
    }
    // A non-zero exit that reports changed files is recorded as such (dpkg may exit non-zero when it finds problems).
    const reported = withDockerKey(await collectTrustEvidence(host({ runs: { "/usr/bin/dpkg --verify runsc": { ...ok("??5?????? c /etc/containerd/runsc.toml\n"), exitCode: 1 } } }).deps, EXPECT));
    expect(blocking(reported).join("\n")).toContain("package runsc: dpkg --verify reports changed files: ??5?????? c /etc/containerd/runsc.toml");
  });
});
