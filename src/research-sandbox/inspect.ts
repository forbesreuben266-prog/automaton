/**
 * Validates Docker Engine `inspect` output for a created (not yet started)
 * container against the sandbox specification. Pure function.
 *
 * Fail closed:
 * - every security-relevant property is checked explicitly;
 * - the fields in REQUIRED_FIELDS must be PRESENT with exactly their safe
 *   empty/default value: an absent field is never read as "empty" (a
 *   missing field means an unreviewed format), and a wrong type refuses;
 * - SecurityOpt must be EXACTLY ["no-new-privileges:true"] (an allowlist:
 *   any other, duplicate or contradictory option refuses, including any
 *   seccomp/apparmor/label/systempaths override); Ulimits must be exactly the
 *   three specified entries; tmpfs options are validated as a whole (each
 *   allowed option at most once, nothing else);
 * - fields in OPTIONAL_FIELDS are deprecated or platform-specific keys that
 *   newer Docker versions may omit: when present they must hold their safe
 *   value;
 * - unknown keys at the top level, in HostConfig and in Config are rejected
 *   (each object is checked against a reviewed allowlist), so a new or
 *   unexpected setting refuses rather than being ignored. Nested objects
 *   allowlisted key by key: State, NetworkSettings and Networks.none,
 *   Config.Healthcheck, HostConfig.LogConfig, GraphDriver or Storage,
 *   ImageManifestDescriptor, every Ulimits, Mounts and HostConfig.Mounts
 *   entry and its BindOptions.
 * - Storage metadata (V2.2, Docker 29): EXACTLY ONE of GraphDriver (classic
 *   graph drivers) or Storage (containerd image store; only the exact shape
 *   {RootFS:{Snapshot:{Name}}}) must be present, and its name must equal
 *   Driver. Both, neither, or any other shape refuses.
 * - ResolvConfPath/HostnamePath/HostsPath must be the exact paths under the
 *   recorded dockerDataRoot for this container id, or (V2.2, Docker 29: the
 *   daemon sets them only when the container starts) ALL three empty on this
 *   never-started container; any mix, other value or null refuses. When they
 *   are empty, the preflight re-inspects after the canary
 *   (validateFinishedInspect) and requires the exact paths then. The
 *   environment must be exactly the recorded image environment plus ours
 *   (not recorded refuses); a reported ImageManifestDescriptor must carry the
 *   recorded manifest digest (not recorded refuses).
 * - Everything here is the daemon's own report: it detects misconfiguration,
 *   not a dishonest daemon (D1/M3 trust root).
 * - Only the Docker Engine format is supported. Podman's format is
 *   different and is refused by the preflight before it gets here.
 */

import {
  containerName, expectedContainerHostFiles, expectedEnv, imageReference, type ContainerPurpose, type RunPaths, type SandboxSpec,
} from "./spec.js";

const SECRETISH_ENV = /proxy|key|token|secret|pass|auth|cred|cookie|session|wallet/i;
/** The only security options a sandbox container may carry, exactly as the create argv sets them. */
export const ALLOWED_SECURITY_OPTS: readonly string[] = Object.freeze(["no-new-privileges:true"]);
/** Docker's default masked/read-only paths that must stay in place (subset; more is fine). */
export const REQUIRED_MASKED_PATHS = Object.freeze(["/proc/kcore", "/proc/keys", "/proc/timer_list", "/sys/firmware"]);
export const REQUIRED_READONLY_PATHS = Object.freeze(["/proc/sys", "/proc/sysrq-trigger", "/proc/irq", "/proc/bus"]);

const TOP_LEVEL_KEYS = new Set([
  "Id", "Created", "Path", "Args", "State", "Image", "ResolvConfPath", "HostnamePath", "HostsPath", "LogPath", "Name",
  "RestartCount", "Driver", "Platform", "MountLabel", "ProcessLabel", "AppArmorProfile", "ExecIDs", "HostConfig",
  "GraphDriver", "Storage", "SizeRw", "SizeRootFs", "Mounts", "Config", "NetworkSettings", "ImageManifestDescriptor",
]);
const HOST_CONFIG_KEYS = new Set([
  "Binds", "ContainerIDFile", "LogConfig", "NetworkMode", "PortBindings", "RestartPolicy", "AutoRemove", "VolumeDriver",
  "VolumesFrom", "ConsoleSize", "Annotations", "CapAdd", "CapDrop", "CgroupnsMode", "Dns", "DnsOptions", "DnsSearch",
  "ExtraHosts", "GroupAdd", "IpcMode", "Cgroup", "Links", "OomScoreAdj", "PidMode", "Privileged", "PublishAllPorts",
  "ReadonlyRootfs", "SecurityOpt", "StorageOpt", "Tmpfs", "UTSMode", "UsernsMode", "ShmSize", "Sysctls", "Runtime",
  "Isolation", "CpuShares", "Memory", "NanoCpus", "CgroupParent", "BlkioWeight", "BlkioWeightDevice", "BlkioDeviceReadBps",
  "BlkioDeviceWriteBps", "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps", "CpuPeriod", "CpuQuota", "CpuRealtimePeriod",
  "CpuRealtimeRuntime", "CpusetCpus", "CpusetMems", "Devices", "DeviceCgroupRules", "DeviceRequests", "KernelMemory",
  "KernelMemoryTCP", "MemoryReservation", "MemorySwap", "MemorySwappiness", "OomKillDisable", "PidsLimit", "Ulimits",
  "CpuCount", "CpuPercent", "IOMaximumIOps", "IOMaximumBandwidth", "Mounts", "MaskedPaths", "ReadonlyPaths", "Init",
]);
const CONFIG_KEYS = new Set([
  "Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr", "ExposedPorts", "Tty", "OpenStdin",
  "StdinOnce", "Env", "Cmd", "Healthcheck", "ArgsEscaped", "Image", "Volumes", "WorkingDir", "Entrypoint", "NetworkDisabled",
  "MacAddress", "OnBuild", "Labels", "StopSignal", "StopTimeout", "Shell",
]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] | null => (v === null || v === undefined ? [] : Array.isArray(v) ? v : null);
// Docker encodes an empty list or map as null or []/{}; both mean "none".
const emptyList = (v: unknown) => v === null || (Array.isArray(v) && v.length === 0);
const emptyMap = (v: unknown) => v === null || (isObj(v) && Object.keys(v).length === 0);
const emptyString = (v: unknown) => v === "";

const STATE_KEYS = new Set(["Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead", "Pid", "ExitCode", "Error", "StartedAt", "FinishedAt", "Health"]);
/** A created container that has never run: no process, no health state. */
const NEVER = "0001-01-01T00:00:00Z";
const stateOk = (v: unknown) => isObj(v) && Object.keys(v).every((k) => STATE_KEYS.has(k)) && v.Status === "created" &&
  v.Running === false && v.Paused === false && v.Restarting === false && v.OOMKilled === false && v.Dead === false &&
  v.Pid === 0 && v.ExitCode === 0 && (v.Health === undefined || v.Health === null) &&
  v.Error === "" && v.StartedAt === NEVER && v.FinishedAt === NEVER;
const NETWORK_SETTINGS_KEYS = new Set([
  "Bridge", "SandboxID", "SandboxKey", "HairpinMode", "LinkLocalIPv6Address", "LinkLocalIPv6PrefixLen", "Ports",
  "SecondaryIPAddresses", "SecondaryIPv6Addresses", "EndpointID", "Gateway", "GlobalIPv6Address", "GlobalIPv6PrefixLen",
  "IPAddress", "IPPrefixLen", "IPv6Gateway", "MacAddress", "Networks",
]);
const ADDRESS_KEYS = ["Bridge", "Gateway", "GlobalIPv6Address", "IPAddress", "IPv6Gateway", "LinkLocalIPv6Address", "MacAddress"];
/** Only the none network; no published ports, addresses or secondary addresses. */
const networkSettingsOk = (v: unknown) => {
  if (!isObj(v) || !Object.keys(v).every((k) => NETWORK_SETTINGS_KEYS.has(k))) return false;
  if (!Object.prototype.hasOwnProperty.call(v, "Ports") || !emptyMap(v.Ports)) return false;
  if (!isObj(v.Networks) || Object.keys(v.Networks).length !== 1 || !isObj(v.Networks.none)) return false;
  const none = v.Networks.none;
  if (!Object.keys(none).every((k) => NONE_NETWORK_RULES.has(k))) return false;
  for (const [k, ok] of NONE_NETWORK_RULES) if (none[k] !== undefined && !ok(none[k])) return false;
  if (ADDRESS_KEYS.some((k) => v[k] !== undefined && v[k] !== "")) return false;
  if (["LinkLocalIPv6PrefixLen", "GlobalIPv6PrefixLen", "IPPrefixLen"].some((k) => v[k] !== undefined && v[k] !== 0)) return false;
  if (["SecondaryIPAddresses", "SecondaryIPv6Addresses"].some((k) => v[k] !== undefined && !emptyList(v[k]))) return false;
  return v.HairpinMode === undefined || v.HairpinMode === false;
};
/** Allowed keys of NetworkSettings.Networks.none and their safe values (checked when present). */
const NONE_NETWORK_RULES = new Map<string, (v: unknown) => boolean>([
  ["IPAMConfig", (v) => v === null], ["Links", (v) => emptyList(v)], ["Aliases", (v) => emptyList(v)], ["DNSNames", (v) => emptyList(v)],
  ["DriverOpts", (v) => emptyMap(v)], ["GwPriority", (v) => v === 0], ["NetworkID", (v) => typeof v === "string" && /^([0-9a-f]{64})?$/.test(v)],
  ["EndpointID", (v) => v === ""], ["Gateway", (v) => v === ""], ["IPAddress", (v) => v === ""], ["IPPrefixLen", (v) => v === 0],
  ["IPv6Gateway", (v) => v === ""], ["GlobalIPv6Address", (v) => v === ""], ["GlobalIPv6PrefixLen", (v) => v === 0], ["MacAddress", (v) => v === ""],
]);
const GRAPH_DRIVER_DATA_KEYS = new Set(["LowerDir", "MergedDir", "UpperDir", "WorkDir", "ID"]);
/** Storage driver metadata: a driver name and, optionally, its host paths (strings only). */
const graphDriverOk = (v: unknown) => isObj(v) && Object.keys(v).every((k) => k === "Name" || k === "Data") &&
  typeof v.Name === "string" && /^[a-z0-9_-]{1,32}$/.test(v.Name) &&
  (v.Data === null || v.Data === undefined || (isObj(v.Data) && Object.entries(v.Data).every(([k, x]) => GRAPH_DRIVER_DATA_KEYS.has(k) && typeof x === "string")));
/**
 * V2.2: Docker 29 with the containerd image store reports the snapshotter in
 * Storage instead of GraphDriver (moby daemon/inspect.go). Only this exact
 * shape is accepted: {"RootFS":{"Snapshot":{"Name":"<snapshotter>"}}}.
 */
const exactKeys = (v: unknown, keys: readonly string[]): v is Json =>
  isObj(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
const storageOk = (v: unknown) => exactKeys(v, ["RootFS"]) && exactKeys(v.RootFS, ["Snapshot"]) && exactKeys(v.RootFS.Snapshot, ["Name"]) &&
  typeof v.RootFS.Snapshot.Name === "string" && /^[a-z0-9_-]{1,32}$/.test(v.RootFS.Snapshot.Name);
const zero = (v: unknown) => v === 0;

/** --no-healthcheck: Docker records {"Test": ["NONE"]}. */
const healthcheckDisabled = (v: unknown) => isObj(v) && Object.keys(v).length === 1 && JSON.stringify(v.Test) === JSON.stringify(["NONE"]);

type Where = "top" | "HostConfig" | "Config";
/**
 * Security-relevant fields Docker always reports. Each must be present AND
 * satisfy its rule; absence, a wrong type or a non-default value refuses.
 */
export const REQUIRED_FIELDS: readonly (readonly [Where, string, (v: unknown) => boolean, string])[] = Object.freeze([
  ["top", "AppArmorProfile", (v) => v === "" || v === "docker-default", "must be docker-default (or empty on hosts without AppArmor)"],
  ["top", "NetworkSettings", networkSettingsOk, "must contain only the none network, no ports, addresses or unknown keys"],
  ["top", "State", stateOk, "must be a created, never-started container (no error, StartedAt/FinishedAt unset) with no unknown keys"],
  ["top", "ExecIDs", emptyList, "no exec sessions may exist"],
  // V2.2: Init must be PRESENT and false. Absent (nil) would mean the daemon-wide "init" default applies
  // (moby daemon/oci_linux.go), so the create argv passes --init=false explicitly.
  ["HostConfig", "Init", (v) => v === false, "must be false (the create argv passes --init=false; absent would mean the daemon default)"],
  ["HostConfig", "CpuRealtimeRuntime", (v) => v === 0, "must be 0"],
  ["HostConfig", "Isolation", (v) => v === "" || v === "default", "must be default"],
  ["HostConfig", "PortBindings", emptyMap, "must be empty"],
  ["HostConfig", "PublishAllPorts", (v) => v === false, "must be false"],
  ["HostConfig", "ExtraHosts", emptyList, "must be empty"],
  ["HostConfig", "Links", emptyList, "must be empty"],
  ["HostConfig", "Dns", emptyList, "must be empty"],
  ["HostConfig", "DnsOptions", emptyList, "must be empty"],
  ["HostConfig", "DnsSearch", emptyList, "must be empty"],
  ["HostConfig", "Binds", emptyList, "must be empty (only the two --mount binds are allowed)"],
  ["HostConfig", "VolumesFrom", emptyList, "must be empty"],
  ["HostConfig", "VolumeDriver", emptyString, "must be empty"],
  ["HostConfig", "GroupAdd", emptyList, "no supplementary groups may be added"],
  ["HostConfig", "CapAdd", emptyList, "must be empty"],
  ["HostConfig", "Devices", emptyList, "must be empty"],
  ["HostConfig", "DeviceRequests", emptyList, "must be empty"],
  ["HostConfig", "DeviceCgroupRules", emptyList, "must be empty"],
  ["HostConfig", "PidMode", emptyString, "must be private"],
  ["HostConfig", "UTSMode", emptyString, "must be private"],
  ["HostConfig", "UsernsMode", emptyString, "must be the daemon default"],
  ["HostConfig", "Cgroup", emptyString, "must not join another cgroup"],
  ["HostConfig", "CgroupParent", emptyString, "must be empty"],
  ["HostConfig", "OomKillDisable", (v) => v === false || v === null, "must not disable the OOM killer"],
  ["HostConfig", "OomScoreAdj", (v) => v === 0, "must be 0"],
  ["HostConfig", "RestartPolicy", (v) => isObj(v) && v.Name === "no" && v.MaximumRetryCount === 0, "must be no restart"],
  ["HostConfig", "AutoRemove", (v) => v === false, "must be false (removal is verified by the preflight)"],
  ["Config", "Volumes", emptyMap, "the image must not declare volumes"],
  ["Config", "Healthcheck", healthcheckDisabled, "must be disabled (--no-healthcheck)"],
  // Security labels, process, storage metadata, logging
  ["top", "ProcessLabel", emptyString, "must be empty (SELinux process labels are not supported; refuse rather than guess)"],
  ["top", "MountLabel", emptyString, "must be empty (SELinux mount labels are not supported; refuse rather than guess)"],
  ["top", "LogPath", emptyString, "must be empty (log driver none)"],
  ["top", "RestartCount", zero, "must be 0"],
  ["top", "Platform", (v) => v === "linux", "must be linux"],
  ["top", "Image", (v) => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v), "must be a sha256 image id"],
  ["HostConfig", "SecurityOpt", (v) => Array.isArray(v) && JSON.stringify(v) === JSON.stringify(ALLOWED_SECURITY_OPTS),
    `must be exactly ${JSON.stringify(ALLOWED_SECURITY_OPTS)} (unknown, duplicate or contradictory options refuse)`],
  ["HostConfig", "ContainerIDFile", emptyString, "must be empty"],
  // CPU, memory and block-IO knobs: only the specified limits may be set
  ["HostConfig", "CpuShares", zero, "must be 0"],
  ["HostConfig", "CpuPeriod", zero, "must be 0 (NanoCpus is the only CPU limit)"],
  ["HostConfig", "CpuQuota", zero, "must be 0 (NanoCpus is the only CPU limit)"],
  ["HostConfig", "CpuRealtimePeriod", zero, "must be 0"],
  ["HostConfig", "CpusetCpus", emptyString, "must be empty"],
  ["HostConfig", "CpusetMems", emptyString, "must be empty"],
  ["HostConfig", "MemoryReservation", zero, "must be 0"],
  ["HostConfig", "MemorySwappiness", (v) => v === null, "must be unset"],
  ["HostConfig", "ShmSize", (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 64 * 1024 * 1024, "must be 0..64 MiB (no /dev/shm with ipc none)"],
  ["HostConfig", "BlkioWeight", zero, "must be 0"],
  ["HostConfig", "BlkioWeightDevice", emptyList, "must be empty"],
  ["HostConfig", "BlkioDeviceReadBps", emptyList, "must be empty"],
  ["HostConfig", "BlkioDeviceWriteBps", emptyList, "must be empty"],
  ["HostConfig", "BlkioDeviceReadIOps", emptyList, "must be empty"],
  ["HostConfig", "BlkioDeviceWriteIOps", emptyList, "must be empty"],
  // Process I/O and metadata
  ["Config", "OpenStdin", (v) => v === false, "must be false"],
  ["Config", "AttachStdin", (v) => v === false, "must be false"],
  ["Config", "StdinOnce", (v) => v === false, "must be false"],
  ["Config", "Tty", (v) => v === false, "must be false"],
  ["Config", "AttachStdout", (v) => v === true, "must be true (as the create argv requests)"],
  ["Config", "AttachStderr", (v) => v === true, "must be true (as the create argv requests)"],
  ["top", "Created", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v) && Number.isFinite(Date.parse(v)), "must be an RFC 3339 UTC timestamp"],
  ["Config", "Labels", emptyMap, "must be empty (the pinned image and create argv set no labels)"],
]);

/**
 * Deprecated or platform-specific keys newer Docker versions may omit: when
 * present they must hold their safe value; absence is allowed.
 */
export const OPTIONAL_FIELDS: readonly (readonly [Where, string, (v: unknown) => boolean, string])[] = Object.freeze([
  ["HostConfig", "KernelMemory", zero, "must be 0"],
  ["HostConfig", "KernelMemoryTCP", zero, "must be 0"],
  ["HostConfig", "CpuCount", zero, "must be 0"],
  ["HostConfig", "CpuPercent", zero, "must be 0"],
  ["HostConfig", "IOMaximumIOps", zero, "must be 0"],
  ["HostConfig", "IOMaximumBandwidth", zero, "must be 0"],
  ["HostConfig", "ConsoleSize", (v) => v === null || JSON.stringify(v) === "[0,0]", "must be unset"],
  // V2.2: map fields tagged `json:",omitempty"` in moby api/types/container/hostconfig.go. Docker 29 omits them
  // when empty; a nil map has no effect (no daemon-wide default is substituted). Present means it must be empty.
  ["HostConfig", "Annotations", emptyMap, "must be empty (runtime-specific options are not allowed)"],
  ["HostConfig", "StorageOpt", emptyMap, "must be empty"],
  ["HostConfig", "Sysctls", emptyMap, "must be empty"],
  ["Config", "Domainname", emptyString, "must be empty"],
  ["Config", "ExposedPorts", emptyMap, "must be empty"],
  ["Config", "OnBuild", emptyList, "must be empty"],
  ["Config", "MacAddress", emptyString, "must be empty"],
  ["Config", "NetworkDisabled", (v) => typeof v === "boolean", "must be a boolean"],
  ["Config", "ArgsEscaped", (v) => v === false, "must be false"],
  ["Config", "Shell", emptyList, "must be empty"],
  ["Config", "StopSignal", (v) => typeof v === "string" && /^SIG[A-Z0-9]{1,16}$/.test(v), "must be a signal name"],
  ["Config", "StopTimeout", (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 3600, "must be 0..3600"],
  ["top", "SizeRw", (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0, "must be a size"],
  ["top", "SizeRootFs", (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0, "must be a size"],
]);
const MANIFEST_DESCRIPTOR_KEYS = new Set(["mediaType", "digest", "size", "platform", "annotations"]);
const PLATFORM_KEYS = new Set(["architecture", "os", "variant", "os.version", "os.features"]);
const MANIFEST_MEDIA_TYPES = new Set(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"]);

export interface InspectExpectations {
  readonly run: RunPaths;
  readonly purpose: ContainerPurpose;
  /** The command passed after the image (must equal Config.Cmd exactly). */
  readonly command: readonly string[];
}

export interface InspectCheck {
  readonly violations: readonly string[];
  readonly runtime: string | null;
  readonly containerId: string | null;
  /**
   * V2.2: true when ResolvConfPath/HostnamePath/HostsPath were all empty (Docker 29 sets them at start). The
   * caller must then verify them with validateFinishedInspect and verifyContainerHostFiles after the container ran.
   */
  readonly hostFilesPending: boolean;
}

export function validateInspect(raw: unknown, spec: SandboxSpec, expected: InspectExpectations): InspectCheck {
  const v: string[] = [];
  const container = Array.isArray(raw) && raw.length === 1 ? raw[0] : null;
  if (!isObj(container)) return { violations: ["inspect output: expected an array with exactly one container object"], runtime: null, containerId: null, hostFilesPending: false };
  const host = container.HostConfig;
  const config = container.Config;
  if (!isObj(host)) v.push("HostConfig: missing");
  if (!isObj(config)) v.push("Config: missing");
  if (!isObj(host) || !isObj(config)) return { violations: v, runtime: null, containerId: null, hostFilesPending: false };
  const expect = (cond: boolean, msg: string) => { if (!cond) v.push(msg); };
  const run = expected.run;

  // Unknown keys (fail closed on unreviewed settings)
  for (const key of Object.keys(container)) if (!TOP_LEVEL_KEYS.has(key)) v.push(`inspect: unknown top-level field "${key.slice(0, 64)}"`);
  for (const key of Object.keys(host)) if (!HOST_CONFIG_KEYS.has(key)) v.push(`HostConfig: unknown field "${key.slice(0, 64)}"`);
  for (const key of Object.keys(config)) if (!CONFIG_KEYS.has(key)) v.push(`Config: unknown field "${key.slice(0, 64)}"`);

  // Required fields: present and safe (never defaulted from absence)
  for (const [where, key, ok, rule] of REQUIRED_FIELDS) {
    const obj = where === "top" ? container : where === "HostConfig" ? host : config;
    const label = where === "top" ? key : `${where}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(obj, key)) v.push(`${label}: missing (required; absence is not treated as a default)`);
    else if (!ok(obj[key])) v.push(`${label}: ${rule}`);
  }
  for (const [where, key, ok, rule] of OPTIONAL_FIELDS) {
    const obj = where === "top" ? container : where === "HostConfig" ? host : config;
    if (Object.prototype.hasOwnProperty.call(obj, key) && !ok(obj[key])) v.push(`${where === "top" ? key : `${where}.${key}`}: ${rule}`);
  }

  // Host files bind-mounted at /etc/hosts, /etc/hostname, /etc/resolv.conf: exact paths for this container id, or
  // (V2.2) all three empty on this never-started container (State is required to be "created" above).
  const hostFiles = typeof container.Id === "string" ? expectedContainerHostFiles(spec, container.Id) : null;
  let hostFilesPending = false;
  if (hostFiles === null) v.push("ResolvConfPath/HostnamePath/HostsPath: dockerDataRoot is not recorded (or the id is invalid), so the host files can't be verified");
  else {
    const entries = Object.entries(hostFiles);
    hostFilesPending = entries.every(([key]) => container[key] === "");
    if (!hostFilesPending) for (const [key, path] of entries) expect(container[key] === path, `${key}: must be ${path} (or all three host-file paths empty before the first start)`);
  }

  // Storage metadata (V2.2): exactly one of GraphDriver (classic) or Storage (containerd snapshotter), named as Driver
  const hasGraph = Object.prototype.hasOwnProperty.call(container, "GraphDriver");
  const hasStorage = Object.prototype.hasOwnProperty.call(container, "Storage");
  const driverOk = typeof container.Driver === "string" && /^[a-z0-9_-]{1,32}$/.test(container.Driver);
  if (hasGraph === hasStorage) v.push(`GraphDriver/Storage: exactly one must be present (got ${hasGraph ? "both" : "neither"})`);
  else if (hasGraph) {
    if (!graphDriverOk(container.GraphDriver)) v.push("GraphDriver: must have only Name and string Data paths");
    else expect(driverOk && container.Driver === (container.GraphDriver as Json).Name, "Driver: must be a driver name equal to GraphDriver.Name");
  } else {
    if (!storageOk(container.Storage)) v.push('Storage: must be exactly {"RootFS":{"Snapshot":{"Name":"<snapshotter>"}}}');
    else expect(driverOk && container.Driver === ((container.Storage as Json).RootFS as Json & { Snapshot: Json }).Snapshot.Name, "Driver: must be a snapshotter name equal to Storage.RootFS.Snapshot.Name");
  }

  // Hostname, image manifest descriptor
  expect(config.Hostname === spec.hostname, `Config.Hostname: must be "${spec.hostname}" (set by the create argv)`);
  // V2 (Option B): the container's own image is the locally built canary, so a reported descriptor must carry the
  // canary's recorded manifest digest. The base image's manifest digest must still be recorded (provenance).
  const imd = container.ImageManifestDescriptor;
  if (imd !== undefined) {
    const platform = isObj(imd) ? imd.platform : undefined;
    expect(spec.image.manifestDigest !== null, "ImageManifestDescriptor: reported, but no manifest digest has been recorded (approved pull step); refusing rather than guessing");
    expect(spec.image.canaryManifestDigest !== null, "ImageManifestDescriptor: reported, but no canary manifest digest has been recorded (approved canary build step); refusing rather than guessing");
    expect(isObj(imd) && Object.keys(imd).every((k) => MANIFEST_DESCRIPTOR_KEYS.has(k)) && spec.image.canaryManifestDigest !== null && imd.digest === spec.image.canaryManifestDigest &&
      typeof imd.mediaType === "string" && MANIFEST_MEDIA_TYPES.has(imd.mediaType) && typeof imd.size === "number" && Number.isSafeInteger(imd.size) && imd.size > 0 &&
      (platform === undefined || (isObj(platform) && Object.keys(platform).every((k) => PLATFORM_KEYS.has(k)) && platform.os === "linux")) &&
      (imd.annotations === undefined || (isObj(imd.annotations) && Object.values(imd.annotations).every((x) => typeof x === "string"))),
      "ImageManifestDescriptor: must be a linux image manifest descriptor with the recorded canary manifest digest and only known keys");
  } else {
    expect(spec.image.canaryManifestDigest === null, "ImageManifestDescriptor: a canary manifest digest is recorded, but the daemon reports no descriptor (contradictory; refusing)");
  }

  // Identity of this container
  const containerId = typeof container.Id === "string" && /^[0-9a-f]{64}$/.test(container.Id) ? container.Id : null;
  expect(containerId !== null, "Id: must be a 64-character hex container id");
  let name: string | null = null;
  try { name = containerName(run.runId, expected.purpose); } catch { v.push("Name: invalid run id"); }
  if (name) expect(container.Name === `/${name}`, `Name: must be /${name}`);

  // Runtime
  const runtime = typeof host.Runtime === "string" ? host.Runtime : null;
  expect(runtime !== null && [...spec.isolatingRuntimes, ...spec.developmentRuntimes].includes(runtime),
    `HostConfig.Runtime: "${String(runtime)}" is not an allowed runtime`);

  // Network
  expect(host.NetworkMode === spec.network, `HostConfig.NetworkMode: must be "${spec.network}" (got ${JSON.stringify(host.NetworkMode)})`);

  // Filesystem
  expect(host.ReadonlyRootfs === true, "HostConfig.ReadonlyRootfs: must be true");
  const tmpfs = host.Tmpfs;
  if (!isObj(tmpfs) || Object.keys(tmpfs).length !== 1 || typeof tmpfs[spec.mountPoints.tmp] !== "string") {
    v.push(`HostConfig.Tmpfs: must contain exactly ${spec.mountPoints.tmp}`);
  } else {
    // The whole option list: only these options, each at most once; noexec, nosuid, nodev and size= exactly once.
    const opts = String(tmpfs[spec.mountPoints.tmp]).split(",");
    const count = (pred: (o: string) => boolean) => opts.filter(pred).length;
    const unknown = opts.filter((o) => !["rw", "noexec", "nosuid", "nodev"].includes(o) && !/^size=\d+$/.test(o));
    if (unknown.length > 0) v.push(`HostConfig.Tmpfs: option "${unknown[0].slice(0, 32)}" is not allowed (only rw, noexec, nosuid, nodev, size=<bytes>)`);
    expect(count((o) => o === "rw") <= 1, "HostConfig.Tmpfs: rw may appear at most once");
    for (const o of ["noexec", "nosuid", "nodev"]) expect(count((x) => x === o) === 1, `HostConfig.Tmpfs: ${spec.mountPoints.tmp} must be ${o} (exactly once)`);
    const sizes = opts.filter((o) => /^size=\d+$/.test(o));
    const bytes = sizes.length === 1 ? Number(sizes[0].slice(5)) : NaN;
    expect(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= spec.tmpfsBytes, `HostConfig.Tmpfs: exactly one size, at most ${spec.tmpfsBytes} bytes`);
  }
  checkMounts(container.Mounts, host.Mounts, spec, run, v);
  const masked = asArray(host.MaskedPaths);
  expect(masked !== null && masked.every((p) => typeof p === "string") && REQUIRED_MASKED_PATHS.every((p) => masked.includes(p)), `HostConfig.MaskedPaths: must include ${REQUIRED_MASKED_PATHS.join(", ")}`);
  const readonlyPaths = asArray(host.ReadonlyPaths);
  expect(readonlyPaths !== null && readonlyPaths.every((p) => typeof p === "string") && REQUIRED_READONLY_PATHS.every((p) => readonlyPaths.includes(p)), `HostConfig.ReadonlyPaths: must include ${REQUIRED_READONLY_PATHS.join(", ")}`);

  // Identity and privilege
  expect(config.User === spec.user, `Config.User: must be "${spec.user}"`);
  expect(host.Privileged === false, "HostConfig.Privileged: must be false");
  const capDrop = asArray(host.CapDrop);
  expect(capDrop !== null && capDrop.some((c) => typeof c === "string" && c.toUpperCase().replace(/^CAP_/, "") === "ALL"), "HostConfig.CapDrop: must include ALL");
  // HostConfig.SecurityOpt: exact allowlist, checked with the required fields above.

  // Namespaces and cgroups
  expect(host.IpcMode === spec.ipcMode, `HostConfig.IpcMode: must be "${spec.ipcMode}"`);
  expect(host.CgroupnsMode === "private", `HostConfig.CgroupnsMode: must be private (got ${JSON.stringify(host.CgroupnsMode)})`);

  // Resource limits
  expect(host.Memory === spec.memoryBytes, `HostConfig.Memory: must be ${spec.memoryBytes}`);
  expect(host.MemorySwap === spec.memorySwapBytes, `HostConfig.MemorySwap: must equal Memory (${spec.memorySwapBytes}): no swap`);
  expect(typeof host.NanoCpus === "number" && host.NanoCpus > 0 && host.NanoCpus <= spec.nanoCpus, `HostConfig.NanoCpus: must be 1..${spec.nanoCpus}`);
  expect(typeof host.PidsLimit === "number" && host.PidsLimit > 0 && host.PidsLimit <= spec.pidsLimit, `HostConfig.PidsLimit: must be 1..${spec.pidsLimit}`);
  // Ulimits: exactly the specified entries, each once, keys Name/Soft/Hard only, soft = hard = the specified value.
  const ulimits = host.Ulimits;
  const wanted = Object.entries(spec.ulimits);
  if (!Array.isArray(ulimits) || ulimits.length !== wanted.length) {
    v.push(`HostConfig.Ulimits: must contain exactly ${wanted.map(([n]) => n).join(", ")} (no other or duplicate entries)`);
  } else {
    for (const u of ulimits) {
      if (!isObj(u) || Object.keys(u).length !== 3 || !["Name", "Soft", "Hard"].every((k) => k in u)) { v.push("HostConfig.Ulimits: entries must have only Name, Soft and Hard"); break; }
    }
    for (const [ulimitName, max] of wanted) {
      const matches = ulimits.filter((x) => isObj(x) && x.Name === ulimitName);
      expect(matches.length === 1 && matches[0].Soft === max && matches[0].Hard === max, `HostConfig.Ulimits: ${ulimitName} must appear once as ${max}:${max}`);
    }
  }

  // Lifecycle and logging
  expect(isObj(host.LogConfig) && host.LogConfig.Type === "none" && Object.keys(host.LogConfig).every((k) => k === "Type" || k === "Config") &&
    (host.LogConfig.Config === undefined || emptyMap(host.LogConfig.Config)), "HostConfig.LogConfig: must be type none with no options");

  // Image, entrypoint and command
  let ref: string | null = null;
  try { ref = imageReference(spec); } catch (err) { v.push(...(err as Error).message.split("\n- ").slice(1)); }
  if (ref !== null) {
    expect(config.Image === ref, `Config.Image: must be ${ref}`);
    // V1B: the image the created container actually uses (top-level Image), not just the reference requested, must be the recorded ID.
    expect(container.Image === spec.image.id, `Image: the created container's image must be the recorded image ID ${spec.image.id}`);
    expect(JSON.stringify(config.Entrypoint ?? null) === JSON.stringify(spec.image.entrypoint), "Config.Entrypoint: must equal the pinned image entrypoint");
  }
  expect(JSON.stringify(config.Cmd ?? null) === JSON.stringify(expected.command), "Config.Cmd: must equal the requested command");
  // Path/Args are the process Docker actually executes: pinned entrypoint followed by the command.
  const process_ = [...(spec.image.entrypoint ?? []), ...expected.command];
  if (!Object.prototype.hasOwnProperty.call(container, "Path") || !Object.prototype.hasOwnProperty.call(container, "Args")) v.push("Path/Args: missing (required)");
  else expect(spec.image.entrypoint !== null && container.Path === process_[0] && JSON.stringify(container.Args) === JSON.stringify(process_.slice(1)),
    "Path/Args: must be the pinned entrypoint followed by the requested command");
  expect(config.WorkingDir === "/app", "Config.WorkingDir: must be /app");

  // Environment: exact set of NAME=value entries; names only in messages, never values.
  const env = asArray(config.Env);
  if (env === null) v.push("Config.Env: must be an array");
  else {
    const allowed = new Set([...spec.envAllowlist, ...spec.imageEnvAllowlist]);
    const malformed = env.some((e) => typeof e !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=[\x20-\x7e]*$/.test(e));
    if (malformed) v.push("Config.Env: every entry must be a printable NAME=value string");
    const names = env.map((e) => (typeof e === "string" ? e.split("=")[0] : ""));
    for (const n of names) {
      if (!allowed.has(n)) v.push(`Config.Env: variable "${n.slice(0, 64)}" is not on the allowlist`);
      else if (SECRETISH_ENV.test(n)) v.push(`Config.Env: variable "${n}" looks like a credential or proxy setting`);
    }
    if (new Set(names).size !== names.length) v.push("Config.Env: duplicate variable names (a later entry would override an earlier one)");
    for (const required of spec.envAllowlist) expect(names.includes(required), `Config.Env: ${required} must be set`);
    const want = expectedEnv(spec, expected.run);
    if (want === null) v.push("Config.Env: the image environment has not been recorded (approved pull step), so the exact environment can't be verified");
    else if (!malformed) {
      expect(JSON.stringify([...env].sort()) === JSON.stringify([...want].sort()),
        "Config.Env: must be exactly the recorded image environment plus NODE_ENV=production and this run's RESEARCH_RUN_ID (a name or value differs)");
    }
  }

  return { violations: v, runtime, containerId, hostFilesPending };
}

/**
 * V2.2: the re-inspect after the canary ran (before removal). Narrow by design:
 * the full allowlist was checked before start. It requires the same container
 * (id, name, image, runtime, network), a clean exit (never restarted, no OOM,
 * no exec session), and the EXACT host-file paths under the recorded
 * dockerDataRoot, which Docker 29 sets only at start. Returns violations.
 */
export function validateFinishedInspect(raw: unknown, spec: SandboxSpec, expected: {
  readonly run: RunPaths; readonly purpose: ContainerPurpose; readonly containerId: string; readonly runtime: string;
  /** E1: exit codes accepted as a clean finish (default [0]; the research CLI also exits 1 when it refuses its input). */
  readonly allowedExitCodes?: readonly number[];
}): string[] {
  const container = Array.isArray(raw) && raw.length === 1 ? raw[0] : null;
  if (!isObj(container)) return ["inspect after the canary: expected an array with exactly one container object"];
  const v: string[] = [];
  const expect = (cond: boolean, msg: string) => { if (!cond) v.push(`inspect after the canary: ${msg}`); };
  expect(container.Id === expected.containerId, "Id: differs from the container that was checked before start");
  let name: string | null = null;
  try { name = containerName(expected.run.runId, expected.purpose); } catch { v.push("inspect after the canary: Name: invalid run id"); }
  if (name) expect(container.Name === `/${name}`, `Name: must be /${name}`);
  expect(container.Image === spec.image.id, `Image: must be the recorded image ID ${spec.image.id}`);
  const host = container.HostConfig;
  expect(isObj(host) && host.Runtime === expected.runtime, `HostConfig.Runtime: must be ${expected.runtime}`);
  expect(isObj(host) && host.NetworkMode === spec.network, `HostConfig.NetworkMode: must be "${spec.network}"`);
  const s = container.State;
  expect(isObj(s) && Object.keys(s).every((k) => STATE_KEYS.has(k)) && s.Status === "exited" && s.Running === false && s.Paused === false &&
    s.Restarting === false && s.OOMKilled === false && s.Dead === false && s.Pid === 0 && (expected.allowedExitCodes ?? [0]).includes(s.ExitCode as number) && s.Error === "",
    `State: must be exited with code ${(expected.allowedExitCodes ?? [0]).join(" or ")} (not running, restarting, dead or OOM-killed; no error; no unknown keys)`);
  expect(container.RestartCount === 0, "RestartCount: must be 0");
  expect(emptyList(container.ExecIDs), "ExecIDs: no exec sessions may exist");
  const hostFiles = expectedContainerHostFiles(spec, expected.containerId);
  if (hostFiles === null) v.push("inspect after the canary: dockerDataRoot is not recorded (or the id is invalid), so the host files can't be verified");
  else for (const [key, path] of Object.entries(hostFiles)) expect(container[key] === path, `${key}: must be ${path}`);
  return v;
}

const MOUNT_KEYS = new Set(["Type", "Source", "Destination", "Mode", "RW", "Propagation"]);
const MOUNT_REQUEST_KEYS = new Set(["Type", "Source", "Target", "ReadOnly", "BindOptions"]);

function checkMounts(topLevel: unknown, hostMounts: unknown, spec: SandboxSpec, run: RunPaths, v: string[]): void {
  const expected = [
    { source: run.inputDir, destination: spec.mountPoints.input, rw: false },
    { source: run.outputDir, destination: spec.mountPoints.output, rw: true },
  ];
  const mounts = asArray(topLevel);
  if (mounts === null) { v.push("Mounts: must be an array"); return; }
  for (const m of mounts) {
    if (!isObj(m) || !Object.keys(m).every((k) => MOUNT_KEYS.has(k)) || m.Mode !== "") {
      v.push(`Mounts: every entry must have only ${[...MOUNT_KEYS].join(", ")} and an empty Mode`);
      break;
    }
  }
  const binds = mounts.filter((m) => !(isObj(m) && m.Type === "tmpfs" && m.Destination === spec.mountPoints.tmp));
  if (binds.length !== expected.length) v.push(`Mounts: expected exactly ${expected.length} bind mounts (got ${binds.length})`);
  for (const want of expected) {
    const got = binds.find((m) => isObj(m) && m.Destination === want.destination);
    if (!isObj(got)) { v.push(`Mounts: ${want.destination} is missing`); continue; }
    if (got.Type !== "bind") v.push(`Mounts: ${want.destination} must be a bind mount`);
    if (got.Source !== want.source) v.push(`Mounts: ${want.destination} source must be ${want.source}`);
    if (got.RW !== want.rw) v.push(`Mounts: ${want.destination} must be ${want.rw ? "read-write" : "read-only"}`);
    if (got.Propagation !== "rprivate") v.push(`Mounts: ${want.destination} propagation must be rprivate`);
  }
  for (const m of mounts) {
    if (isObj(m) && /docker\.sock|podman\.sock|containerd\.sock/.test(`${String(m.Source)} ${String(m.Destination)}`)) v.push("Mounts: engine sockets must never be mounted");
  }
  // HostConfig.Mounts records the --mount requests themselves.
  const requested = asArray(hostMounts);
  if (requested === null || requested.length !== expected.length) { v.push(`HostConfig.Mounts: expected exactly ${expected.length} mount requests`); return; }
  for (const m of requested) {
    if (!isObj(m) || !Object.keys(m).every((k) => MOUNT_REQUEST_KEYS.has(k)) ||
        !isObj(m.BindOptions) || Object.keys(m.BindOptions).length !== 1 || !("Propagation" in m.BindOptions)) {
      v.push("HostConfig.Mounts: entries may have only Type, Source, Target, ReadOnly and BindOptions.Propagation (no NonRecursive, ReadOnlyNonRecursive, CreateMountpoint or other options)");
      break;
    }
  }
  for (const want of expected) {
    const got = requested.find((m) => isObj(m) && m.Target === want.destination);
    if (!isObj(got)) { v.push(`HostConfig.Mounts: ${want.destination} request is missing`); continue; }
    if (got.Type !== "bind" || got.Source !== want.source) v.push(`HostConfig.Mounts: ${want.destination} must bind ${want.source}`);
    if ((got.ReadOnly === true) !== !want.rw) v.push(`HostConfig.Mounts: ${want.destination} read-only flag is wrong`);
    const prop = isObj(got.BindOptions) ? got.BindOptions.Propagation : undefined;
    if (prop !== "rprivate") v.push(`HostConfig.Mounts: ${want.destination} propagation must be rprivate`);
  }
}
