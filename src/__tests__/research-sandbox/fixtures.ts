/**
 * Offline fixtures for the research sandbox tests. The digest, entrypoint,
 * image environment, manifest digest, Docker data root, runsc path/hash and
 * both /proc/version strings are FAKE test values (not a real image, host or
 * recorded reference); nothing is pulled or started.
 */

import { SANDBOX_SPEC, resolveSpec, type HostFs, type HostStat, type RunPaths } from "../../research-sandbox/index.js";

export const FAKE_DIGEST = `sha256:${"ab".repeat(32)}`;
export const FAKE_ENTRYPOINT = ["docker-entrypoint.sh"];
export const FAKE_GVISOR_PROC_VERSION = "Linux version 4.4.0 #1 SMP (fake gVisor reference for tests)";
export const HOST_PROC_VERSION = "Linux version 6.8.0-fake-host (test fixture) #1 SMP";
export const FAKE_IMAGE_ENV = ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.22.0", "YARN_VERSION=1.22.22"];
export const FAKE_MANIFEST_DIGEST = `sha256:${"ef".repeat(32)}`;
/** FAKE platform manifest digest of the locally built canary image (V2, Option B; containerd image store). */
export const FAKE_CANARY_MANIFEST_DIGEST = `sha256:${"c3".repeat(32)}`;
/** FAKE image ID of the locally built canary image (V1B); the created container's top-level Image. */
export const FAKE_IMAGE_ID = `sha256:${"cd".repeat(32)}`;
export const FAKE_DATA_ROOT = "/var/lib/docker";
export const FAKE_RUNSC_PATH = "/usr/local/bin/runsc";
export const FAKE_RUNSC_SHA256 = "5e".repeat(32);
export const FAKE_RUNSC = Object.freeze({ path: FAKE_RUNSC_PATH, sha256: FAKE_RUNSC_SHA256, args: Object.freeze([] as string[]), sidecars: Object.freeze([] as { path: string; sha256: string }[]) });
/** FAKE Docker server version for tests (deliberately not a real release). */
export const FAKE_DOCKER_SERVER_VERSION = "0.0.0-fake.test";
/** Fully pinned spec (fake values); SANDBOX_SPEC itself has nothing pinned. */
export const SPEC = resolveSpec({
  imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, gvisorProcVersion: FAKE_GVISOR_PROC_VERSION,
  imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST, dockerDataRoot: FAKE_DATA_ROOT, runscBinary: { ...FAKE_RUNSC, args: ["--oci-seccomp"] },
  dockerServerVersion: FAKE_DOCKER_SERVER_VERSION, imageId: FAKE_IMAGE_ID,
});
/** The same spec on a containerd-image-store host: the canary's own manifest digest recorded (V2, Option B). */
export const SPEC_CONTAINERD = resolveSpec({ canaryManifestDigest: FAKE_CANARY_MANIFEST_DIGEST }, SPEC);
/** `docker info` as parsed by the engine adapter: Docker with runc and runsc, built-in seccomp profile. */
export const DOCKER_INFO = Object.freeze({
  engine: "docker" as const, rootless: false, runtimes: Object.freeze(["runc", "runsc"]), seccompProfile: "builtin",
  runtimeConfigs: Object.freeze({ runc: { path: "runc" }, runsc: { path: FAKE_RUNSC_PATH, runtimeArgs: ["--oci-seccomp"] } }),
  serverVersion: FAKE_DOCKER_SERVER_VERSION,
});
export const RUN: RunPaths = { inputDir: "/srv/research-runs/r1/in", outputDir: "/srv/research-runs/r1/out", runId: "r1" };
export const HOST_CANARY = "/srv/research-canary/host-canary.txt";
/** Containers are created from the recorded image ID (V1B), never a tag or repository reference. */
export const IMAGE_REF = FAKE_IMAGE_ID;
export const CONTAINER_ID = "0123456789ab0123456789ab0123456789ab0123456789ab0123456789abcdef";
export const PROBE_COMMAND = ["node", "/app/canary-probe.js", "--canary", HOST_CANARY];
export const OPERATOR_UID = 1000;
export const OUTPUT_UID = 10001;
export const POLICY = { operatorUid: OPERATOR_UID, outputOwnerUid: OUTPUT_UID };
/** Operator-prepared, empty Docker client config folder (fake layout entry below). */
export const DOCKER_CONFIG_DIR = "/srv/research-engine/docker-config";
export const ENGINE_TARGET = Object.freeze({ host: "unix:///var/run/docker.sock", configDir: DOCKER_CONFIG_DIR });

/**
 * V2.2: the same container as Docker 29.9.3 with the containerd image store reports it before its first start
 * (moby docker-v29.9.3): Storage instead of GraphDriver, the omitempty HostConfig maps (Annotations, StorageOpt,
 * Sysctls) absent, and ResolvConfPath/HostnamePath/HostsPath empty (set only by initializeNetworking at start).
 */
export function docker29Inspect(runtime = "runsc"): any {
  const raw = compliantInspect(runtime);
  const c = raw[0];
  delete c.GraphDriver;
  c.Driver = "overlayfs";
  c.Storage = { RootFS: { Snapshot: { Name: "overlayfs" } } };
  for (const k of ["Annotations", "StorageOpt", "Sysctls"]) delete c.HostConfig[k];
  for (const k of ["ResolvConfPath", "HostnamePath", "HostsPath"]) c[k] = "";
  return raw;
}

/** The three host files Docker writes for CONTAINER_ID (absent before a Docker 29 container's first start). */
export const CONTAINER_HOST_FILES = Object.freeze(["hosts", "hostname", "resolv.conf"].map((f) => `${FAKE_DATA_ROOT}/containers/${CONTAINER_ID}/${f}`));

/**
 * V2.2: the re-inspect after the canary exited: the created container's report with State exited (code 0) and the
 * exact host-file paths filled in (Docker 29 sets them at start; older formats already had them).
 */
export function finishedInspect(created: any): any {
  if (!Array.isArray(created) || created.length !== 1 || typeof created[0] !== "object" || created[0] === null) return created;
  const c = JSON.parse(JSON.stringify(created[0]));
  c.State = { ...c.State, Status: "exited", Running: false, Pid: 0, ExitCode: 0, Error: "", StartedAt: "2026-11-04T12:00:00.1Z", FinishedAt: "2026-11-04T12:00:01.2Z" };
  const dir = `${FAKE_DATA_ROOT}/containers/${String(c.Id)}`;
  if (c.HostsPath === "") c.HostsPath = `${dir}/hosts`;
  if (c.HostnamePath === "") c.HostnamePath = `${dir}/hostname`;
  if (c.ResolvConfPath === "") c.ResolvConfPath = `${dir}/resolv.conf`;
  return [c];
}

/** A compliant Docker Engine `inspect` result for a created (not started) canary container. */
export function compliantInspect(runtime = "runsc"): any {
  return [{
    Id: CONTAINER_ID,
    Name: "/research-sandbox-r1-canary",
    AppArmorProfile: "docker-default",
    State: { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, Pid: 0, ExitCode: 0, Error: "", StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" },
    ExecIDs: null,
    Created: "2026-10-17T00:00:00.000000000Z",
    Path: FAKE_ENTRYPOINT[0],
    Args: [...PROBE_COMMAND],
    Image: FAKE_IMAGE_ID,
    ResolvConfPath: `/var/lib/docker/containers/${CONTAINER_ID}/resolv.conf`,
    HostnamePath: `/var/lib/docker/containers/${CONTAINER_ID}/hostname`,
    HostsPath: `/var/lib/docker/containers/${CONTAINER_ID}/hosts`,
    LogPath: "",
    RestartCount: 0,
    Driver: "overlay2",
    Platform: "linux",
    MountLabel: "",
    ProcessLabel: "",
    GraphDriver: { Name: "overlay2", Data: { LowerDir: "/var/lib/docker/overlay2/l/x", MergedDir: "/var/lib/docker/overlay2/x/merged", UpperDir: "/var/lib/docker/overlay2/x/diff", WorkDir: "/var/lib/docker/overlay2/x/work" } },
    Config: {
      Hostname: "sandbox",
      OpenStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      StdinOnce: false,
      Tty: false,
      Labels: null,
      User: "10001:10001",
      Image: IMAGE_REF,
      Entrypoint: [...FAKE_ENTRYPOINT],
      Cmd: [...PROBE_COMMAND],
      WorkingDir: "/app",
      Volumes: null,
      Healthcheck: { Test: ["NONE"] },
      Env: [...FAKE_IMAGE_ENV, "NODE_ENV=production", "RESEARCH_RUN_ID=r1"],
    },
    HostConfig: {
      Runtime: runtime,
      Isolation: "",
      Annotations: null,
      Init: false,
      StorageOpt: null,
      CpuRealtimeRuntime: 0,
      ContainerIDFile: "",
      CpuShares: 0,
      CpuPeriod: 0,
      CpuQuota: 0,
      CpuRealtimePeriod: 0,
      CpusetCpus: "",
      CpusetMems: "",
      MemoryReservation: 0,
      MemorySwappiness: null,
      ShmSize: 67108864,
      BlkioWeight: 0,
      BlkioWeightDevice: [],
      BlkioDeviceReadBps: [],
      BlkioDeviceWriteBps: [],
      BlkioDeviceReadIOps: [],
      BlkioDeviceWriteIOps: [],
      NetworkMode: "none",
      PortBindings: {},
      PublishAllPorts: false,
      ExtraHosts: null,
      Links: null,
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ReadonlyRootfs: true,
      Binds: null,
      VolumesFrom: null,
      VolumeDriver: "",
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=67108864" },
      Mounts: [
        { Type: "bind", Source: RUN.inputDir, Target: "/in", ReadOnly: true, BindOptions: { Propagation: "rprivate" } },
        { Type: "bind", Source: RUN.outputDir, Target: "/out", BindOptions: { Propagation: "rprivate" } },
      ],
      MaskedPaths: ["/proc/asound", "/proc/acpi", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/proc/scsi", "/sys/firmware"],
      ReadonlyPaths: ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
      Sysctls: null,
      GroupAdd: null,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: null,
      SecurityOpt: ["no-new-privileges:true"],
      Devices: [],
      DeviceRequests: null,
      DeviceCgroupRules: null,
      IpcMode: "none",
      PidMode: "",
      UTSMode: "",
      UsernsMode: "",
      CgroupnsMode: "private",
      Cgroup: "",
      CgroupParent: "",
      Memory: 536870912,
      MemorySwap: 536870912,
      NanoCpus: 500000000,
      PidsLimit: 64,
      OomKillDisable: false,
      OomScoreAdj: 0,
      Ulimits: [
        { Name: "fsize", Soft: 52428800, Hard: 52428800 },
        { Name: "nofile", Soft: 256, Hard: 256 },
        { Name: "core", Soft: 0, Hard: 0 },
      ],
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      LogConfig: { Type: "none", Config: {} },
    },
    Mounts: [
      { Type: "bind", Source: RUN.inputDir, Destination: "/in", Mode: "", RW: false, Propagation: "rprivate" },
      { Type: "bind", Source: RUN.outputDir, Destination: "/out", Mode: "", RW: true, Propagation: "rprivate" },
    ],
    NetworkSettings: { Ports: {}, Networks: { none: { Aliases: null, Links: null } } },
  }];
}

/** A compliant version-4 canary report as the probe would print it inside gVisor. */
export function compliantReport(): any {
  return {
    version: 6,
    uids: [10001, 10001, 10001, 10001],
    gids: [10001, 10001, 10001, 10001],
    groups: [],
    capEff: "0000000000000000",
    capPrm: "0000000000000000",
    capBnd: "0000000000000000",
    noNewPrivs: 1,
    seccompMode: 2,
    interfaces: ["lo"],
    ipv4Routes: false,
    ipv6RouteDevices: ["lo", "lo"],
    testNetConnect: "unreachable",
    envNames: ["NODE_ENV", "NODE_VERSION", "PATH", "RESEARCH_RUN_ID", "YARN_VERSION"],
    writes: { root: "EROFS", app: "EROFS", input: "EROFS", output: "allowed", tmp: "allowed" },
    hostCanaryRead: "absent",
    sockets: { found: [], unreadable: [] },
    limits: { fsize: { soft: 52428800, hard: 52428800 }, nofile: { soft: 256, hard: 256 }, core: { soft: 0, hard: 0 } },
    cgroupMemoryMax: 536870912,
    cgroupPidsMax: 64,
    procVersion: FAKE_GVISOR_PROC_VERSION,
    etcMounts: { "/etc/hosts": ["ro,nosuid,nodev,relatime"], "/etc/hostname": ["ro,nosuid,nodev,relatime"], "/etc/resolv.conf": ["ro,nosuid,nodev,relatime"] },
    fsMounts: { "/": ["ro,relatime"], "/in": ["ro,nosuid,nodev,relatime"] },
    cgroupV1: { memoryLimitInBytes: "", pidsMax: "" },
    runtimeEnv: { HOSTNAME: null, HOME: null, PWD: null },
  };
}

export interface FakeEntry { sha256?: string; size?: number; mtimeMs?: number; ctimeMs?: number; kind: "dir" | "symlink" | "file" | "socket"; uid: number; mode: number; ino: number; entries?: string[]; realpath?: string; error?: string }

/** A compliant host layout for RUN, as a mutable map the tests can weaken. */
export function compliantHostLayout(): Record<string, FakeEntry> {
  return {
    "/": { kind: "dir", uid: 0, mode: 0o40755, ino: 2 },
    "/srv": { kind: "dir", uid: 0, mode: 0o40755, ino: 10 },
    "/srv/research-runs": { kind: "dir", uid: OPERATOR_UID, mode: 0o40755, ino: 11 },
    "/srv/research-runs/r1": { kind: "dir", uid: OPERATOR_UID, mode: 0o40755, ino: 12 },
    "/srv/research-runs/r1/in": { kind: "dir", uid: OPERATOR_UID, mode: 0o40755, ino: 13, entries: ["source.txt"] },
    "/srv/research-runs/r1/out": { kind: "dir", uid: OUTPUT_UID, mode: 0o40700, ino: 14, entries: [] },
    // Engine target: /var/run -> /run (root-owned symlink), root-owned socket, empty private config folder.
    "/var": { kind: "dir", uid: 0, mode: 0o40755, ino: 20 },
    "/var/run": { kind: "symlink", uid: 0, mode: 0o120777, ino: 21, realpath: "/run" },
    "/run": { kind: "dir", uid: 0, mode: 0o40755, ino: 22 },
    "/run/docker.sock": { kind: "socket", uid: 0, mode: 0o140660, ino: 23 },
    "/var/run/docker.sock": { kind: "socket", uid: 0, mode: 0o140660, ino: 23, realpath: "/run/docker.sock" },
    "/srv/research-engine": { kind: "dir", uid: OPERATOR_UID, mode: 0o40755, ino: 30 },
    [DOCKER_CONFIG_DIR]: { kind: "dir", uid: OPERATOR_UID, mode: 0o40700, ino: 31, entries: [] },
    // Docker data root with this container's hosts/hostname/resolv.conf.
    "/var/lib": { kind: "dir", uid: 0, mode: 0o40755, ino: 40 },
    [FAKE_DATA_ROOT]: { kind: "dir", uid: 0, mode: 0o40710, ino: 41 },
    [`${FAKE_DATA_ROOT}/containers`]: { kind: "dir", uid: 0, mode: 0o40710, ino: 42 },
    [`${FAKE_DATA_ROOT}/containers/${CONTAINER_ID}`]: { kind: "dir", uid: 0, mode: 0o40710, ino: 43 },
    [`${FAKE_DATA_ROOT}/containers/${CONTAINER_ID}/hosts`]: { kind: "file", uid: 0, mode: 0o100644, ino: 44 },
    [`${FAKE_DATA_ROOT}/containers/${CONTAINER_ID}/hostname`]: { kind: "file", uid: 0, mode: 0o100644, ino: 45 },
    [`${FAKE_DATA_ROOT}/containers/${CONTAINER_ID}/resolv.conf`]: { kind: "file", uid: 0, mode: 0o100644, ino: 46 },
    // Approved runtime binary (fake contents: sha256File returns the recorded fake digest).
    "/usr": { kind: "dir", uid: 0, mode: 0o40755, ino: 50 },
    "/usr/local": { kind: "dir", uid: 0, mode: 0o40755, ino: 51 },
    "/usr/local/bin": { kind: "dir", uid: 0, mode: 0o40755, ino: 52 },
    [FAKE_RUNSC_PATH]: { kind: "file", uid: 0, mode: 0o100755, ino: 53, size: 52_000_000, mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000, sha256: FAKE_RUNSC_SHA256 },
  };
}

/** HostFs over a layout map; unknown paths throw ENOENT. `calls` counts lstat calls per path. */
export function fakeHostFs(layout: Record<string, FakeEntry>): HostFs & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const get = (p: string) => {
    const e = layout[p];
    if (!e) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    if (e.error) throw Object.assign(new Error(`${e.error} ${p}`), { code: e.error });
    return e;
  };
  return {
    calls,
    lstat(p: string): HostStat {
      calls[p] = (calls[p] ?? 0) + 1;
      const e = get(p);
      return { isSymbolicLink: () => e.kind === "symlink", isDirectory: () => e.kind === "dir", isSocket: () => e.kind === "socket", isFile: () => e.kind === "file", uid: e.uid, mode: e.mode, dev: 64769, ino: e.ino,
        size: e.size ?? 4096, mtimeMs: e.mtimeMs ?? 1_600_000_000_000, ctimeMs: e.ctimeMs ?? 1_600_000_000_000 };
    },
    realpath(p: string): string { return get(p).realpath ?? p; },
    readdir(p: string): string[] { return [...(get(p).entries ?? [])]; },
    sha256File(p: string, maxBytes: number) {
      const e = get(p);
      if (e.kind === "symlink") throw Object.assign(new Error(`ELOOP ${p}`), { code: "ELOOP" }); // O_NOFOLLOW
      if (e.kind !== "file") throw Object.assign(new Error(`EINVAL ${p}`), { code: "EINVAL" });
      if ((e.size ?? 4096) > maxBytes) throw Object.assign(new Error(`EFBIG ${p}`), { code: "EFBIG" });
      return { sha256: e.sha256 ?? "0".repeat(64), dev: "64769", ino: String(e.ino), size: e.size ?? 4096 };
    },
  };
}

/** The report gVisor 20261102.0 gives once --oci-seccomp is on (findings 2-6 as observed on the VPS). */
export function gvisorReport(): any {
  const r = compliantReport();
  r.seccompMode = 2;
  r.envNames = [...r.envNames, "HOME", "HOSTNAME", "PWD"].sort();
  r.runtimeEnv = { HOSTNAME: "sandbox", HOME: "/", PWD: "/app" };
  r.writes.root = "EACCES";
  r.writes.input = "EACCES";
  r.fsMounts = { "/": ["ro"], "/in": ["ro,nosuid,nodev"] };
  r.cgroupMemoryMax = null;
  r.cgroupPidsMax = null;
  r.cgroupV1 = { memoryLimitInBytes: "536870912", pidsMax: "max" };
  return r;
}

/**
 * Step A3: a fake host /proc observer. "gvisor": the host shows a runsc process (the recorded binary) naming the
 * container and never the canary; "runc": the canary's node process is an ordinary host process.
 */
export function fakeHostProcesses(kind: "gvisor" | "runc" | "none" = "gvisor", polls = 20): import("../../research-sandbox/host-processes.js").HostProcessObserver & { started: string[] } {
  const started: string[] = [];
  return {
    started,
    start(containerId: string) {
      started.push(containerId);
      return {
        stop: () => ({
          polls, unreadable: 0, overflow: false,
          samples: kind === "gvisor" ? [{ pid: 4242, exe: FAKE_RUNSC_PATH, argv0: "runsc-sandbox", mentionsContainer: true, runsCanaryScript: false, role: "boot" as const }]
            : kind === "runc" ? [{ pid: 4343, exe: "/usr/local/bin/node", argv0: "node", mentionsContainer: false, runsCanaryScript: true, role: "other" as const },
              { pid: 4300, exe: "/usr/bin/containerd-shim-runc-v2", argv0: "containerd-shim-runc-v2", mentionsContainer: true, runsCanaryScript: false, role: "other" as const }]
            : [],
        }),
      };
    },
  };
}
