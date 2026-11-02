/**
 * Offline fixtures for the research sandbox tests. The digest, entrypoint,
 * image environment, manifest digest, Docker data root and both
 * /proc/version strings are FAKE test values (not a real image, host or
 * recorded reference); nothing is pulled or started.
 */

import { SANDBOX_SPEC, resolveSpec, type HostFs, type HostStat, type RunPaths } from "../../research-sandbox/index.js";

export const FAKE_DIGEST = `sha256:${"ab".repeat(32)}`;
export const FAKE_ENTRYPOINT = ["docker-entrypoint.sh"];
export const FAKE_GVISOR_PROC_VERSION = "Linux version 4.4.0 #1 SMP (fake gVisor reference for tests)";
export const HOST_PROC_VERSION = "Linux version 6.8.0-fake-host (test fixture) #1 SMP";
export const FAKE_IMAGE_ENV = ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.22.0", "YARN_VERSION=1.22.22"];
export const FAKE_MANIFEST_DIGEST = `sha256:${"ef".repeat(32)}`;
export const FAKE_DATA_ROOT = "/var/lib/docker";
/** Fully pinned spec (fake values); SANDBOX_SPEC itself has nothing pinned. */
export const SPEC = resolveSpec({
  imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT, gvisorProcVersion: FAKE_GVISOR_PROC_VERSION,
  imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST, dockerDataRoot: FAKE_DATA_ROOT,
});
/** `docker info` as parsed by the engine adapter: Docker with runc and runsc, built-in seccomp profile. */
export const DOCKER_INFO = Object.freeze({ engine: "docker" as const, rootless: false, runtimes: Object.freeze(["runc", "runsc"]), seccompProfile: "builtin" });
export const RUN: RunPaths = { inputDir: "/srv/research-runs/r1/in", outputDir: "/srv/research-runs/r1/out", runId: "r1" };
export const HOST_CANARY = "/srv/research-canary/host-canary.txt";
export const IMAGE_REF = `${SANDBOX_SPEC.image.repository}@${FAKE_DIGEST}`;
export const CONTAINER_ID = "0123456789ab0123456789ab0123456789ab0123456789ab0123456789abcdef";
export const PROBE_COMMAND = ["node", "/app/canary-probe.js", "--canary", HOST_CANARY];
export const OPERATOR_UID = 1000;
export const OUTPUT_UID = 10001;
export const POLICY = { operatorUid: OPERATOR_UID, outputOwnerUid: OUTPUT_UID };
/** Operator-prepared, empty Docker client config folder (fake layout entry below). */
export const DOCKER_CONFIG_DIR = "/srv/research-engine/docker-config";
export const ENGINE_TARGET = Object.freeze({ host: "unix:///var/run/docker.sock", configDir: DOCKER_CONFIG_DIR });

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
    Image: `sha256:${"cd".repeat(32)}`,
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
    version: 4,
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
  };
}

export interface FakeEntry { kind: "dir" | "symlink" | "file" | "socket"; uid: number; mode: number; ino: number; entries?: string[]; realpath?: string; error?: string }

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
      return { isSymbolicLink: () => e.kind === "symlink", isDirectory: () => e.kind === "dir", isSocket: () => e.kind === "socket", isFile: () => e.kind === "file", uid: e.uid, mode: e.mode, dev: 64769, ino: e.ino };
    },
    realpath(p: string): string { return get(p).realpath ?? p; },
    readdir(p: string): string[] { return [...(get(p).entries ?? [])]; },
  };
}
