/**
 * Step A1 (M3 evidence): READ-ONLY collection of Docker / containerd / runsc
 * package provenance and daemon configuration, and its fail-closed
 * evaluation. Nothing is changed on the host: the commands are fixed argv
 * lists of query tools (dpkg-query, dpkg --verify, apt-cache policy,
 * systemctl show, docker info/version) run without a shell, and files are
 * only read.
 *
 * Nothing sensitive is recorded:
 * - docker info / docker version: an explicit allowlist of fields (no proxy,
 *   registry, label or host-name fields);
 * - daemon.json: its SHA-256, its top-level key NAMES, the runsc runtime
 *   entry (path, runtimeArgs), the NAMES of any other runtimes, default-runtime
 *   and features (booleans); never other values (other runtimes' arguments
 *   could hold secrets);
 * - dockerd startup flags: flag NAMES; values only for the reviewed flags;
 * - apt sources and policy: URLs with any user:password@ part removed;
 * - signing keys: OpenPGP fingerprints computed here from the keyring file
 *   (public keys only; no gpg call, no private material);
 * - environment variables are never read.
 *
 * Findings are "blocking" (must be fixed, or explicitly accepted in the
 * M1/M3 decision record) or "review" (recorded for the decision), and each
 * names what it is evidence of (EVIDENCE_LIMITS states what each kind can and
 * cannot show):
 * - origin: the installed version is offered by the expected HTTPS repository;
 * - signature: that repository is configured with a signed-by keyring holding
 *   the expected key (apt checks the signature at download time);
 * - integrity: installed files match the package database (dpkg --verify);
 * - configuration / daemon: dockerd's unit, daemon.json and the running daemon.
 * The evidence never lifts a blocker by itself.
 */

import { createHash } from "node:crypto";
import type { ProcessRunner } from "./engine.js";
import { APPROVED_RUNSC_ARGS } from "./spec.js";

export const TRUST_EVIDENCE_VERSION = 1;
export const DOCKER_PACKAGES = Object.freeze(["docker-ce", "docker-ce-cli", "containerd.io"]);
export const RUNSC_PACKAGE = "runsc";
/** Docker's published Linux package signing key (https://docs.docker.com/engine/install/ubuntu/). */
export const DOCKER_SIGNING_FINGERPRINT = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88";
const REPO_HOSTS: Readonly<Record<string, { host: string; pathPrefix: string }>> = Object.freeze({
  docker: { host: "download.docker.com", pathPrefix: "/linux/" },
  gvisor: { host: "storage.googleapis.com", pathPrefix: "/gvisor/releases" },
});
/** The reviewed dockerd command line (the Docker CE systemd unit). Anything else is a finding. */
export const REVIEWED_DOCKERD_ARGV: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["/usr/bin/dockerd", "-H", "fd://", "--containerd=/run/containerd/containerd.sock"]),
  Object.freeze(["/usr/bin/dockerd", "-H", "fd://"]),
]);
const DAEMON_JSON = "/etc/docker/daemon.json";
const DAEMON_JSON_REVIEWED_KEYS = new Set(["runtimes", "features"]);
const HASHED_BINARIES = Object.freeze(["/usr/bin/dockerd", "/usr/bin/docker", "/usr/bin/containerd", "/usr/bin/containerd-shim-runc-v2", "/usr/bin/runc"]);
const INFO_FIELDS = Object.freeze(["ServerVersion", "SecurityOptions", "DefaultRuntime", "CgroupDriver", "CgroupVersion", "Driver", "DockerRootDir", "KernelVersion", "OperatingSystem", "OSType", "Architecture"]);

export type FindingKind = "origin" | "signature" | "integrity" | "configuration" | "daemon";
export interface Finding { readonly severity: "blocking" | "review"; readonly kind: FindingKind; readonly message: string }
/** What each kind of evidence can and cannot show (printed with every report). */
export const EVIDENCE_LIMITS: Readonly<Record<FindingKind, string>> = Object.freeze({
  origin: "apt-cache policy shows the installed VERSION is offered by the repository; it does not prove these installed bytes were downloaded from it.",
  signature: "the repository is configured with a signed-by keyring holding the expected key, so apt verified its signed index at download time; no signature is stored for the installed files, so this is not a cryptographic proof about them.",
  integrity: "dpkg --verify compares installed files with the MD5 sums in the local package database; root could alter both; binary SHA-256 values are recorded for later comparison.",
  configuration: "the dockerd systemd unit and /etc/docker/daemon.json as read now.",
  daemon: "docker info and docker version as reported by the running daemon (self-reported).",
});
export interface FileStat { readonly uid: number; readonly mode: number; readonly isFile: boolean; readonly isSymbolicLink: boolean }
export interface TrustEvidenceDeps {
  readonly run: ProcessRunner;
  /** File text, or null when it does not exist (other errors throw). */
  readonly readFile: (path: string) => string | null;
  readonly readBytes: (path: string) => Buffer | null;
  readonly lstat: (path: string) => FileStat | null;
  readonly readdir: (path: string) => string[];
  readonly now: () => string;
}
export interface TrustEvidenceExpect {
  readonly engineBinary: string;
  readonly engineConfigDir: string;
  readonly dockerServerVersion: string;
  readonly runscPath: string;
}

const printable = (s: string, max = 200) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
/** Removes user:password@ from URLs. */
export const stripUserinfo = (s: string) => s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** First key repeated within one JSON object, or null. The text must already be valid JSON. */
export function duplicateJsonKey(text: string): string | null {
  const stack: Array<{ keys: Set<string>; expectKey: boolean } | null> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\"") j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && stack[stack.length - 1]) stack[stack.length - 1]!.expectKey = true;
  }
  return null;
}

// ---------------------------------------------------------------- OpenPGP fingerprints (public keys only)

/** Decodes an ASCII-armored block, or returns binary input unchanged; null when the armor is malformed. */
function dearmor(bytes: Buffer): Buffer | null {
  const text = bytes.toString("latin1");
  if (!text.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")) return bytes;
  const body = text.split("-----BEGIN PGP PUBLIC KEY BLOCK-----")[1]?.split("-----END PGP PUBLIC KEY BLOCK-----")[0];
  if (body === undefined) return null;
  const lines = body.replace(/\r/g, "").split("\n");
  const blank = lines.findIndex((l, i) => i > 0 && l.trim() === "");
  const data = (blank >= 0 ? lines.slice(blank + 1) : lines).filter((l) => l.trim() !== "" && !l.startsWith("=")).join("");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  return Buffer.from(data, "base64");
}

/**
 * Fingerprints of every primary public key (packet tag 6) in a keyring:
 * v4 = SHA-1(0x99 || 2-octet length || body); v5/v6 = SHA-256(0x9A/0x9B ||
 * 4-octet length || body). Returns null for anything it can't parse (fail closed).
 */
export function openpgpFingerprints(input: Buffer): string[] | null {
  const bytes = dearmor(input);
  if (bytes === null || bytes.length === 0) return null;
  const out: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const h = bytes[i];
    if ((h & 0x80) === 0) return null;
    let tag: number;
    let len: number;
    let p = i + 1;
    if (h & 0x40) {
      tag = h & 0x3f;
      const o1 = bytes[p];
      if (o1 === undefined) return null;
      if (o1 < 192) { len = o1; p += 1; }
      else if (o1 < 224) { if (bytes[p + 1] === undefined) return null; len = ((o1 - 192) << 8) + bytes[p + 1] + 192; p += 2; }
      else if (o1 === 255) { if (p + 4 >= bytes.length) return null; len = bytes.readUInt32BE(p + 1); p += 5; }
      else return null; // partial lengths are not used for key material
    } else {
      tag = (h >> 2) & 0x0f;
      const lt = h & 0x03;
      if (lt === 0) { len = bytes[p]; p += 1; }
      else if (lt === 1) { len = bytes.readUInt16BE(p); p += 2; }
      else if (lt === 2) { len = bytes.readUInt32BE(p); p += 4; }
      else return null;
      if (len === undefined || Number.isNaN(len)) return null;
    }
    if (p + len > bytes.length) return null;
    const body = bytes.subarray(p, p + len);
    if (tag === 6) {
      const version = body[0];
      if (version === 4) {
        const head = Buffer.from([0x99, (len >> 8) & 0xff, len & 0xff]);
        out.push(createHash("sha1").update(head).update(body).digest("hex").toUpperCase());
      } else if (version === 5 || version === 6) {
        const head = Buffer.alloc(5);
        head[0] = version === 5 ? 0x9a : 0x9b;
        head.writeUInt32BE(len, 1);
        out.push(createHash("sha256").update(head).update(body).digest("hex").toUpperCase());
      } else return null;
    }
    i = p + len;
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------- parsers

export interface AptSource { readonly file: string; readonly uris: readonly string[]; readonly signedBy: string | null; readonly signedByInline: boolean; readonly trusted: boolean }

/** One-line (.list) and deb822 (.sources) apt sources. URIs have userinfo removed. */
export function parseAptSources(file: string, text: string): AptSource[] {
  const out: AptSource[] = [];
  if (file.endsWith(".sources")) {
    for (const stanza of text.replace(/\r/g, "").split(/\n\s*\n/)) {
      const fields: Record<string, string> = {};
      let last: string | null = null;
      for (const line of stanza.split("\n")) {
        if (/^\s*#/.test(line) || line.trim() === "") continue;
        const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
        if (m && !/^\s/.test(line)) { last = m[1].toLowerCase(); fields[last] = m[2]; }
        else if (last !== null && /^\s/.test(line)) fields[last] += `\n${line.trim()}`;
      }
      if (fields.enabled?.trim().toLowerCase() === "no" || !fields.uris) continue;
      const sb = fields["signed-by"]?.trim() ?? null;
      out.push({ file, uris: fields.uris.split(/\s+/).filter(Boolean).map(stripUserinfo), signedBy: sb && !sb.startsWith("-----BEGIN") ? sb : null,
        signedByInline: sb !== null && sb.startsWith("-----BEGIN"), trusted: /^yes$/i.test(fields.trusted?.trim() ?? "") });
    }
  } else {
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      const m = /^deb\s+(?:\[([^\]]*)\]\s+)?(\S+)/.exec(line);
      if (!m) continue;
      const opts = Object.fromEntries((m[1] ?? "").trim().split(/\s+/).filter(Boolean).map((o) => [o.split("=")[0].toLowerCase(), o.split("=").slice(1).join("=")]));
      out.push({ file, uris: [stripUserinfo(m[2])], signedBy: opts["signed-by"] || null, signedByInline: false, trusted: opts.trusted === "yes" });
    }
  }
  return out;
}

/** Sources (priority + location) of one version in `apt-cache policy <pkg>` output; null when the version is not listed. */
export function aptPolicySources(text: string, pkg: string, version: string): string[] | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `${pkg}:`);
  if (start < 0) return null;
  let inVersion = false;
  let found = false;
  const sources: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break; // the next package
    const v = /^\s*(?:\*\*\*)?\s+(\S+)\s+-?\d+\s*$/.exec(l);
    if (v && !/^\s+-?\d+\s+\S/.test(l)) { inVersion = v[1] === version; if (inVersion) found = true; continue; }
    const s = /^\s+-?\d+\s+(\S+)/.exec(l);
    if (s && inVersion) sources.push(stripUserinfo(s[1]));
  }
  return found ? sources : null;
}

/** argv of `systemctl show -p ExecStart` (the first command), or null. */
export function parseExecStart(text: string): string[] | null {
  const m = /argv\[\]=([^;]*?)\s*;/.exec(text);
  return m ? m[1].trim().split(/\s+/) : null;
}

// ---------------------------------------------------------------- collection (read-only)

export interface TrustEvidence {
  readonly version: number;
  readonly collectedAt: string;
  readonly packages: Readonly<Record<string, { readonly installed: string | null; readonly status: string | null; readonly verify: readonly string[] | null; readonly sources: readonly string[] | null }>>;
  readonly aptSources: readonly (AptSource & { readonly keyringSha256: string | null; readonly keyringOwnerUid: number | null; readonly keyringMode: string | null; readonly fingerprints: readonly string[] | null })[];
  readonly dockerd: { readonly argv: readonly string[] | null; readonly dropIns: readonly string[] | null };
  readonly daemonJson: { readonly present: boolean; readonly sha256: string | null; readonly keys: readonly string[]; readonly duplicateKey: string | null; readonly valid: boolean;
    readonly runscRuntime: unknown; readonly otherRuntimes: readonly string[]; readonly defaultRuntime: unknown; readonly features: unknown };
  readonly dockerInfo: Readonly<Record<string, unknown>> | null;
  readonly runscRuntime: unknown;
  readonly dockerVersion: { readonly server: string | null; readonly client: string | null; readonly components: readonly { readonly name: string; readonly version: string; readonly gitCommit: string | null }[] } | null;
  readonly binaries: Readonly<Record<string, string | null>>;
  readonly kernel: { readonly lsm: string | null; readonly apparmor: string | null };
}

const QUERY = { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 };

export async function collectTrustEvidence(deps: TrustEvidenceDeps, expect: TrustEvidenceExpect): Promise<TrustEvidence> {
  const run = async (file: string, args: string[]) => {
    const r = await deps.run(file, args, QUERY);
    return r.exitCode === 0 && !r.timedOut && !r.truncated && r.signal === null ? r.stdout : null;
  };
  const packages: Record<string, { installed: string | null; status: string | null; verify: string[] | null; sources: string[] | null }> = {};
  for (const pkg of [...DOCKER_PACKAGES, RUNSC_PACKAGE]) {
    const q = await run("/usr/bin/dpkg-query", ["-W", "-f=${Version}\\t${db:Status-Abbrev}", pkg]);
    const [installed, status] = q === null ? [null, null] : q.split("\t");
    const verifyOut = installed ? await deps.run("/usr/bin/dpkg", ["--verify", pkg], QUERY) : null;
    // A timeout, truncation or signal means "not verified" (never "no changed files"). A non-zero exit counts only when
    // it reported changed files; otherwise it also means "not verified".
    const lines = verifyOut ? verifyOut.stdout.split("\n").filter(Boolean).map((l) => printable(l)) : [];
    const verify = !verifyOut || verifyOut.timedOut || verifyOut.truncated || verifyOut.signal !== null ? null : verifyOut.exitCode === 0 ? lines : lines.length > 0 ? lines : null;
    const policy = installed ? await run("/usr/bin/apt-cache", ["policy", pkg]) : null;
    packages[pkg] = { installed: installed ? printable(installed, 100) : null, status: status ? printable(status.trim(), 8) : null, verify,
      sources: policy !== null && installed ? aptPolicySources(policy, pkg, installed) : null };
  }

  const aptSources: TrustEvidence["aptSources"][number][] = [];
  const sourceFiles = ["/etc/apt/sources.list", ...(deps.readdir("/etc/apt/sources.list.d").filter((f) => /\.(list|sources)$/.test(f)).sort().map((f) => `/etc/apt/sources.list.d/${f}`))];
  for (const f of sourceFiles) {
    const text = deps.readFile(f);
    if (text === null) continue;
    for (const s of parseAptSources(f, text)) {
      if (!s.uris.some((u) => Object.values(REPO_HOSTS).some((r) => hostOf(u) === r.host))) continue;
      const key = s.signedBy && s.signedBy.startsWith("/") ? s.signedBy : null;
      const st = key ? deps.lstat(key) : null;
      const bytes = key && st && st.isFile && !st.isSymbolicLink ? deps.readBytes(key) : null;
      aptSources.push({ ...s, keyringSha256: bytes ? sha256(bytes) : null, keyringOwnerUid: st ? st.uid : null, keyringMode: st ? (st.mode & 0o7777).toString(8) : null,
        fingerprints: bytes ? openpgpFingerprints(bytes) : null });
    }
  }

  const show = await run("/usr/bin/systemctl", ["show", "docker.service", "--property=ExecStart", "--property=DropInPaths", "--no-pager"]);
  const dropLine = show?.split("\n").find((l) => l.startsWith("DropInPaths="));
  const rawArgv = show === null ? null : parseExecStart(show);
  // The reviewed command line is recorded as is; any other is recorded as flag NAMES only (values could be secrets).
  const argv = rawArgv === null ? null : REVIEWED_DOCKERD_ARGV.some((r) => JSON.stringify(r) === JSON.stringify(rawArgv)) ? rawArgv
    : [printable(rawArgv[0] ?? "", 80), ...rawArgv.slice(1).map((a) => (a.startsWith("-") ? `${printable(a.split("=")[0], 64)}${a.includes("=") ? "=<value>" : ""}` : "<value>"))];
  const dockerd = { argv, dropIns: dropLine === undefined ? null : dropLine.slice("DropInPaths=".length).split(/\s+/).filter(Boolean).map((p) => printable(p)) };

  const dj = deps.readFile(DAEMON_JSON);
  let daemonJson: TrustEvidence["daemonJson"] = { present: false, sha256: null, keys: [], duplicateKey: null, valid: false, runscRuntime: null, otherRuntimes: [], defaultRuntime: null, features: null };
  if (dj !== null) {
    let raw: unknown = null;
    try { raw = JSON.parse(dj); } catch { raw = undefined; }
    const ok = isObj(raw);
    const parsed: Record<string, unknown> = isObj(raw) ? raw : {};
    daemonJson = {
      present: true, sha256: sha256(dj), keys: ok ? Object.keys(parsed).map((k) => printable(k, 64)).sort() : [], duplicateKey: ok ? duplicateJsonKey(dj) : null, valid: ok,
      // Only runsc's entry is recorded (as two plain values); other runtimes by name only.
      runscRuntime: isObj(parsed.runtimes) && isObj(parsed.runtimes.runsc)
        ? { keys: Object.keys(parsed.runtimes.runsc).map((k) => printable(k, 32)).sort(), path: typeof parsed.runtimes.runsc.path === "string" ? printable(parsed.runtimes.runsc.path, 120) : null,
          runtimeArgs: Array.isArray(parsed.runtimes.runsc.runtimeArgs) && parsed.runtimes.runsc.runtimeArgs.every((a) => a === "--oci-seccomp") ? parsed.runtimes.runsc.runtimeArgs : "(other values; not recorded)" }
        : null,
      otherRuntimes: isObj(parsed.runtimes) ? Object.keys(parsed.runtimes).filter((k) => k !== "runsc").map((k) => printable(k, 64)).sort() : [],
      defaultRuntime: ok ? (typeof parsed["default-runtime"] === "string" ? printable(parsed["default-runtime"], 64) : parsed["default-runtime"] === undefined ? null : "(not a string)") : null,
      features: ok && isObj(parsed.features) ? Object.fromEntries(Object.entries(parsed.features).map(([k, v]) => [printable(k, 64), typeof v === "boolean" ? v : "(not a boolean)"])) : null,
    };
  }

  const global = ["--host", "unix:///var/run/docker.sock", "--config", expect.engineConfigDir];
  const infoText = await run(expect.engineBinary, [...global, "info", "--format", "{{json .}}"]);
  let dockerInfo: Record<string, unknown> | null = null;
  let runscRuntime: unknown = null;
  try {
    const info = infoText === null ? null : JSON.parse(infoText);
    if (isObj(info)) {
      dockerInfo = Object.fromEntries(INFO_FIELDS.filter((k) => k in info).map((k) => [k, info[k]]));
      const rr = isObj(info.Runtimes) && isObj(info.Runtimes.runsc) ? info.Runtimes.runsc : null;
      runscRuntime = rr === null ? null : { path: typeof rr.path === "string" ? printable(rr.path, 120) : null,
        runtimeArgs: Array.isArray(rr.runtimeArgs) && rr.runtimeArgs.every((a) => a === "--oci-seccomp") ? rr.runtimeArgs : rr.runtimeArgs === undefined ? undefined : "(other values; not recorded)" };
    }
  } catch { dockerInfo = null; }
  const versionText = await run(expect.engineBinary, [...global, "version", "--format", "{{json .}}"]);
  let dockerVersion: TrustEvidence["dockerVersion"] = null;
  try {
    const v = versionText === null ? null : JSON.parse(versionText);
    if (isObj(v)) {
      const server = isObj(v.Server) ? v.Server : {};
      const comps = Array.isArray(server.Components) ? server.Components : [];
      dockerVersion = {
        server: typeof server.Version === "string" ? printable(server.Version, 64) : null,
        client: isObj(v.Client) && typeof v.Client.Version === "string" ? printable(v.Client.Version, 64) : null,
        components: comps.filter(isObj).map((c) => ({ name: printable(String(c.Name), 64), version: printable(String(c.Version), 64),
          gitCommit: isObj(c.Details) && typeof c.Details.GitCommit === "string" ? printable(c.Details.GitCommit, 64) : null })),
      };
    }
  } catch { dockerVersion = null; }

  const binaries: Record<string, string | null> = {};
  for (const b of HASHED_BINARIES) { const bytes = deps.readBytes(b); binaries[b] = bytes ? sha256(bytes) : null; }
  const kernel = { lsm: deps.readFile("/sys/kernel/security/lsm")?.trim().slice(0, 200) ?? null, apparmor: deps.readFile("/sys/module/apparmor/parameters/enabled")?.trim().slice(0, 8) ?? null };

  return { version: TRUST_EVIDENCE_VERSION, collectedAt: deps.now(), packages, aptSources, dockerd, daemonJson, dockerInfo, runscRuntime, dockerVersion, binaries, kernel };
}

function hostOf(uri: string): string | null {
  try { return new URL(uri).host.toLowerCase(); } catch { return null; }
}

// ---------------------------------------------------------------- evaluation (pure, fail closed)

export function evaluateTrustEvidence(e: TrustEvidence, expect: TrustEvidenceExpect): Finding[] {
  const f: Finding[] = [];
  let kind: FindingKind = "origin";
  const block = (message: string) => f.push({ severity: "blocking", kind, message });
  const review = (message: string) => f.push({ severity: "review", kind, message });

  // Packages: installed, unmodified, from the expected signed repository.
  for (const [pkg, repo] of [...DOCKER_PACKAGES.map((p) => [p, "docker"] as const), [RUNSC_PACKAGE, "gvisor"] as const]) {
    const p = e.packages?.[pkg];
    kind = "integrity";
    if (!p || p.installed === null) { block(`package ${pkg}: not installed (or dpkg-query failed)`); continue; }
    if (p.status !== "ii") block(`package ${pkg}: dpkg status is ${JSON.stringify(p.status)}, not "ii"`);
    if (p.verify === null) block(`package ${pkg}: dpkg --verify could not be run`);
    else if (p.verify.length > 0) block(`package ${pkg}: dpkg --verify reports changed files: ${p.verify.slice(0, 3).join("; ")}`);
    kind = "origin";
    const r = REPO_HOSTS[repo];
    const fromRepo = (p.sources ?? []).some((s) => { try { const u = new URL(s); return u.protocol === "https:" && u.host === r.host && u.pathname.startsWith(r.pathPrefix); } catch { return false; } });
    if (p.sources === null) block(`package ${pkg}: installed version ${p.installed} is not listed by apt-cache policy`);
    else if (!fromRepo) block(`package ${pkg}: installed version ${p.installed} is not available from https://${r.host}${r.pathPrefix}... (sources: ${JSON.stringify(p.sources).slice(0, 160)}); not traceable to the signed repository`);
  }

  // apt sources for both repositories: signed-by a root-owned, not group/other-writable keyring; never trusted=yes.
  kind = "signature";
  for (const [repo, r] of Object.entries(REPO_HOSTS)) {
    const entries = (e.aptSources ?? []).filter((s) => s.uris.some((u) => hostOf(u) === r.host));
    if (entries.length === 0) { block(`apt source for ${repo} (${r.host}): none found`); continue; }
    for (const s of entries) {
      const where = `${s.file} (${r.host})`;
      if (s.trusted) block(`apt source ${where}: trusted=yes disables signature checks`);
      if (s.signedByInline) review(`apt source ${where}: the signing key is inline (fingerprint not computed); confirm it by hand`);
      else if (s.signedBy === null) block(`apt source ${where}: no signed-by keyring (any key trusted by apt would be accepted)`);
      else if (s.fingerprints === null) block(`apt source ${where}: keyring ${s.signedBy} is missing, not a regular file, or not a parseable OpenPGP public keyring`);
      else {
        if (s.keyringOwnerUid !== 0) block(`apt source ${where}: keyring ${s.signedBy} is not owned by root`);
        if (s.keyringMode === null || (parseInt(s.keyringMode, 8) & 0o022) !== 0) block(`apt source ${where}: keyring ${s.signedBy} is writable by group or others`);
        if (repo === "docker") {
          if (!s.fingerprints.includes(DOCKER_SIGNING_FINGERPRINT)) block(`apt source ${where}: keyring does not contain Docker's published signing key ${DOCKER_SIGNING_FINGERPRINT} (found ${s.fingerprints.join(", ")})`);
          if (s.fingerprints.length !== 1) review(`apt source ${where}: keyring holds ${s.fingerprints.length} keys`);
        } else {
          review(`apt source ${where}: gVisor signing key fingerprint(s) ${s.fingerprints.join(", ")}: compare with https://gvisor.dev/docs/user_guide/install/ in the decision record`);
        }
      }
    }
  }

  // dockerd startup: exactly a reviewed command line, no drop-ins.
  kind = "configuration";
  const argv = e.dockerd?.argv ?? null;
  if (argv === null) block("dockerd: the systemd ExecStart command line could not be read");
  else if (!REVIEWED_DOCKERD_ARGV.some((r) => JSON.stringify(r) === JSON.stringify(argv))) {
    const names = argv.slice(1).filter((a) => a.startsWith("-")).map((a) => a.split("=")[0]);
    block(`dockerd: startup flags differ from the reviewed unit (flag names: ${JSON.stringify(names).slice(0, 200)}); flags such as --seccomp-profile, --add-runtime or a TCP -H would bypass the reviewed settings`);
  }
  if (e.dockerd?.dropIns === null || e.dockerd?.dropIns === undefined) block("dockerd: systemd drop-in paths could not be read");
  else if (e.dockerd.dropIns.length > 0) block(`dockerd: systemd drop-ins present (${e.dockerd.dropIns.join(", ")}); review them`);

  // daemon.json
  const d = e.daemonJson;
  if (!d || !d.present) block(`${DAEMON_JSON}: missing (runsc must be registered there)`);
  else if (!d.valid) block(`${DAEMON_JSON}: not a valid JSON object`);
  else {
    if (d.duplicateKey !== null) block(`${DAEMON_JSON}: repeats the key ${JSON.stringify(d.duplicateKey)}`);
    const unknown = d.keys.filter((k) => !DAEMON_JSON_REVIEWED_KEYS.has(k));
    if (unknown.length > 0) block(`${DAEMON_JSON}: unreviewed top-level keys ${JSON.stringify(unknown)} (values not recorded); seccomp-profile, default-runtime, hosts or similar would change the reviewed configuration`);
    const want = { runsc: { path: expect.runscPath, runtimeArgs: [...APPROVED_RUNSC_ARGS] } };
    const rr = isObj(d.runscRuntime) ? d.runscRuntime : null;
    if (rr === null || JSON.stringify(rr.keys) !== JSON.stringify(["path", "runtimeArgs"]) || rr.path !== expect.runscPath || JSON.stringify(rr.runtimeArgs) !== JSON.stringify(APPROVED_RUNSC_ARGS)
      || d.otherRuntimes.length > 0) {
      block(`${DAEMON_JSON}: runtimes must be exactly ${JSON.stringify(want)}${d.otherRuntimes.length > 0 ? ` (other runtimes: ${JSON.stringify(d.otherRuntimes)})` : ""}`);
    }
    if (d.features !== null && Object.values(d.features as Record<string, unknown>).some((v) => typeof v !== "boolean")) block(`${DAEMON_JSON}: features must be booleans`);
  }

  // Running daemon
  kind = "daemon";
  const i = e.dockerInfo;
  if (i === null) block("docker info: could not be read");
  else {
    if (i.ServerVersion !== expect.dockerServerVersion) block(`docker info: ServerVersion ${JSON.stringify(i.ServerVersion)} is not the pinned ${expect.dockerServerVersion}`);
    const opts = Array.isArray(i.SecurityOptions) ? i.SecurityOptions.filter((o): o is string => typeof o === "string") : [];
    const sec = opts.filter((o) => /^name=seccomp(,|$)/.test(o));
    if (sec.length !== 1 || sec[0] !== "name=seccomp,profile=builtin") block(`docker info: seccomp must be exactly name=seccomp,profile=builtin (got ${JSON.stringify(sec)})`);
    if (opts.includes("name=rootless")) block("docker info: rootless Docker");
    if (!opts.includes("name=apparmor")) review("docker info: AppArmor is not reported");
    if (i.DefaultRuntime !== "runc") block(`docker info: DefaultRuntime must be runc (got ${JSON.stringify(i.DefaultRuntime)})`);
  }
  const wantRt = { path: expect.runscPath, runtimeArgs: [...APPROVED_RUNSC_ARGS] };
  const rt = isObj(e.runscRuntime) ? { path: e.runscRuntime.path, runtimeArgs: e.runscRuntime.runtimeArgs } : null;
  if (JSON.stringify(rt) !== JSON.stringify(wantRt)) block(`docker info: runsc must be ${JSON.stringify(wantRt)} (got ${JSON.stringify(rt)?.slice(0, 120)})`);
  const v = e.dockerVersion;
  if (v === null || v.server !== expect.dockerServerVersion) block(`docker version: server version must be the pinned ${expect.dockerServerVersion} (got ${JSON.stringify(v?.server ?? null)})`);

  kind = "integrity";
  for (const [b, h] of Object.entries(e.binaries ?? {})) if (h === null) review(`binary ${b}: not found (not hashed)`);
  kind = "configuration";
  if (e.kernel?.apparmor !== "Y") review(`kernel: AppArmor module not enabled (got ${JSON.stringify(e.kernel?.apparmor ?? null)})`);
  return f;
}

/** SHA-256 of the canonical evidence JSON (what the decision record cites). */
export function evidenceDigest(value: unknown): string {
  const canon = (x: unknown): unknown => (Array.isArray(x) ? x.map(canon) : isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
  return `sha256:${sha256(JSON.stringify(canon(value)))}`;
}

// ---------------------------------------------------------------- operator command

export const TRUST_EVIDENCE_CONFIRM_FLAG = "--confirm-read-only-host-queries";
export const TRUST_EVIDENCE_USAGE = [
  "Research sandbox trust evidence (Step A1, M3). READ-ONLY: queries dpkg, apt, systemd and the Docker daemon, reads files; changes nothing.",
  "",
  `  trust-evidence-main.js --config <absolute path to the runner configuration .json> ${TRUST_EVIDENCE_CONFIRM_FLAG}`,
  "",
  "Prints one JSON document (evidence, findings, the limits of each kind of evidence, and its SHA-256 digest for the decision record).",
  "Exit 0: no findings at all; 1: blocking findings; 4: no blocking findings, but findings that need review (e.g. the gVisor key);",
  "2: usage or configuration error; 3: internal error. Only exit 0 is a clean result.",
  "",
].join("\n");

export interface TrustEvidenceCommandDeps {
  readonly readConfig: (path: string) => string;
  readonly parseConfig: (text: string) => { engineBinary: string; engineConfigDir: string; pins: Readonly<Record<string, unknown>> };
  readonly evidence: TrustEvidenceDeps;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export async function runTrustEvidenceCommand(argv: readonly string[], deps: TrustEvidenceCommandDeps): Promise<number> {
  const usage = (m: string) => { deps.err(`Usage error: ${m}\n\n${TRUST_EVIDENCE_USAGE}`); return 2; };
  try {
    if (argv.length !== 3 || argv[0] !== "--config" || argv[2] !== TRUST_EVIDENCE_CONFIRM_FLAG) return usage(`expected exactly: --config <path> ${TRUST_EVIDENCE_CONFIRM_FLAG}`);
    if (!/^(\/[A-Za-z0-9._-]+)+$/.test(argv[1])) return usage("--config must be an absolute path");
    let expect: TrustEvidenceExpect;
    try {
      const c = deps.parseConfig(deps.readConfig(argv[1]));
      const rb = c.pins.runscBinary as { path?: unknown } | null;
      if (typeof c.pins.dockerServerVersion !== "string" || !rb || typeof rb.path !== "string") throw new Error("pins.dockerServerVersion and pins.runscBinary.path must be recorded");
      expect = { engineBinary: c.engineBinary, engineConfigDir: c.engineConfigDir, dockerServerVersion: c.pins.dockerServerVersion, runscPath: rb.path };
    } catch (err) {
      const problems = (err as { problems?: string[] }).problems ?? [String((err as Error)?.message ?? err)];
      deps.err(`Refused (configuration):\n${problems.map((p) => `- ${printable(p)}`).join("\n")}\n`);
      return 2;
    }
    const evidence = await collectTrustEvidence(deps.evidence, expect);
    const findings = evaluateTrustEvidence(evidence, expect);
    const blocking = findings.filter((x) => x.severity === "blocking").length;
    const verdict = blocking > 0 ? "blocking" : findings.length > 0 ? "needs-review" : "clean";
    const body = { kind: "research-sandbox-trust-evidence", verdict, evidence, findings, blocking, review: findings.length - blocking, limits: EVIDENCE_LIMITS };
    deps.out(`${JSON.stringify({ ...body, digest: evidenceDigest(body) }, null, 2)}\n`);
    deps.err(`Trust evidence: ${verdict.toUpperCase()} (${blocking} blocking, ${findings.length - blocking} to review). ${verdict === "clean" ? "" : "This is NOT a clean result."}\n`);
    return verdict === "clean" ? 0 : verdict === "blocking" ? 1 : 4;
  } catch (err) {
    try { deps.err(`Internal error: ${printable(String((err as Error)?.message ?? err), 300)}\n`); } catch { /* nothing more */ }
    return 3;
  }
}
