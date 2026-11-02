/**
 * Inspect validation (Docker Engine format): a compliant container passes;
 * every missing, weakened or unknown setting is refused; Podman-shaped output
 * is refused rather than guessed at. Offline fixtures.
 */

import { describe, expect, it } from "vitest";
import { ALLOWED_SECURITY_OPTS, OPTIONAL_FIELDS, REQUIRED_FIELDS, SANDBOX_SPEC, resolveSpec, validateInspect } from "../../research-sandbox/index.js";
import { CONTAINER_ID, FAKE_DIGEST, FAKE_ENTRYPOINT, FAKE_IMAGE_ENV, FAKE_MANIFEST_DIGEST, PROBE_COMMAND, RUN, SPEC, compliantInspect } from "./fixtures.js";

const EXPECT = { run: RUN, purpose: "canary" as const, command: PROBE_COMMAND };
const check = (mutate: (c: any) => void, spec = SPEC) => {
  const raw = compliantInspect();
  mutate(raw[0]);
  return validateInspect(raw, spec, EXPECT).violations.join("\n");
};

describe("inspect validation", () => {
  it("a compliant gVisor container passes and reports runtime and id", () => {
    expect(validateInspect(compliantInspect(), SPEC, EXPECT)).toEqual({ violations: [], runtime: "runsc", containerId: CONTAINER_ID });
  });

  it("a compliant runc container passes inspection (its weaker rating is decided by the preflight)", () => {
    expect(validateInspect(compliantInspect("runc"), SPEC, EXPECT).violations).toEqual([]);
  });

  it.each([
    // network
    ["host network", (c: any) => { c.HostConfig.NetworkMode = "host"; }, "NetworkMode"],
    ["bridge network", (c: any) => { c.HostConfig.NetworkMode = "bridge"; }, "NetworkMode"],
    ["a joined network", (c: any) => { c.NetworkSettings.Networks.bridge = {}; }, "only the none network"],
    ["published ports", (c: any) => { c.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "8080" }] }; }, "PortBindings"],
    ["extra hosts", (c: any) => { c.HostConfig.ExtraHosts = ["host.docker.internal:host-gateway"]; }, "ExtraHosts"],
    ["links", (c: any) => { c.HostConfig.Links = ["/db:/research/db"]; }, "Links"],
    ["DNS servers", (c: any) => { c.HostConfig.Dns = ["1.1.1.1"]; }, "HostConfig.Dns"],
    // filesystem
    ["writable root filesystem", (c: any) => { c.HostConfig.ReadonlyRootfs = false; }, "ReadonlyRootfs"],
    ["extra -v bind", (c: any) => { c.HostConfig.Binds = ["/home/u:/home/u"]; }, "Binds"],
    ["volumes-from", (c: any) => { c.HostConfig.VolumesFrom = ["other"]; }, "VolumesFrom"],
    ["volume driver", (c: any) => { c.HostConfig.VolumeDriver = "nfs"; }, "VolumeDriver"],
    ["image-declared volume", (c: any) => { c.Config.Volumes = { "/data": {} }; }, "Config.Volumes"],
    ["tmpfs exec allowed", (c: any) => { c.HostConfig.Tmpfs["/tmp"] = "rw,nosuid,nodev,size=67108864"; }, "must be noexec"],
    ["tmpfs too large", (c: any) => { c.HostConfig.Tmpfs["/tmp"] = "rw,noexec,nosuid,nodev,size=1073741824"; }, "exactly one size, at most"],
    ["input mount writable", (c: any) => { c.Mounts[0].RW = true; }, "/in must be read-only"],
    ["input mount from another source", (c: any) => { c.Mounts[0].Source = "/home/u"; }, "/in source must be"],
    ["shared propagation", (c: any) => { c.Mounts[1].Propagation = "rshared"; }, "propagation must be rprivate"],
    ["extra mount", (c: any) => { c.Mounts.push({ Type: "bind", Source: "/home/u/.automaton", Destination: "/secrets", RW: false, Propagation: "rprivate" }); }, "exactly 2 bind mounts"],
    ["engine socket mount", (c: any) => { c.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true, Propagation: "rprivate" }); }, "engine sockets must never be mounted"],
    ["mount request: different source", (c: any) => { c.HostConfig.Mounts[0].Source = "/home/u"; }, "HostConfig.Mounts: /in must bind"],
    ["mount request: input not read-only", (c: any) => { delete c.HostConfig.Mounts[0].ReadOnly; }, "read-only flag is wrong"],
    ["mount request: shared propagation", (c: any) => { c.HostConfig.Mounts[1].BindOptions.Propagation = "shared"; }, "HostConfig.Mounts: /out propagation"],
    ["mount request: extra", (c: any) => { c.HostConfig.Mounts.push({ Type: "volume", Target: "/x" }); }, "exactly 2 mount requests"],
    ["masked paths emptied", (c: any) => { c.HostConfig.MaskedPaths = []; }, "MaskedPaths"],
    ["/proc/kcore unmasked", (c: any) => { c.HostConfig.MaskedPaths = c.HostConfig.MaskedPaths.filter((p: string) => p !== "/proc/kcore"); }, "MaskedPaths"],
    ["read-only paths emptied", (c: any) => { c.HostConfig.ReadonlyPaths = []; }, "ReadonlyPaths"],
    ["sysctls set", (c: any) => { c.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" }; }, "Sysctls"],
    // identity and privilege
    ["root user", (c: any) => { c.Config.User = ""; }, "Config.User"],
    ["uid 0", (c: any) => { c.Config.User = "0:0"; }, "Config.User"],
    ["supplementary group (e.g. docker group)", (c: any) => { c.HostConfig.GroupAdd = ["999"]; }, "GroupAdd"],
    ["privileged", (c: any) => { c.HostConfig.Privileged = true; }, "Privileged"],
    ["capabilities not dropped", (c: any) => { c.HostConfig.CapDrop = ["NET_RAW"]; }, "CapDrop"],
    ["capability added", (c: any) => { c.HostConfig.CapAdd = ["SYS_ADMIN"]; }, "CapAdd"],
    ["no-new-privileges missing", (c: any) => { c.HostConfig.SecurityOpt = []; }, "no-new-privileges"],
    ["seccomp unconfined", (c: any) => { c.HostConfig.SecurityOpt.push("seccomp=unconfined"); }, "HostConfig.SecurityOpt: must be exactly"],
    ["apparmor unconfined option", (c: any) => { c.HostConfig.SecurityOpt.push("apparmor:unconfined"); }, "HostConfig.SecurityOpt: must be exactly"],
    ["apparmor unconfined profile", (c: any) => { c.AppArmorProfile = "unconfined"; }, "AppArmorProfile"],
    ["selinux labels disabled", (c: any) => { c.HostConfig.SecurityOpt.push("label=disable"); }, "HostConfig.SecurityOpt: must be exactly"],
    ["systempaths unconfined", (c: any) => { c.HostConfig.SecurityOpt.push("systempaths=unconfined"); }, "HostConfig.SecurityOpt: must be exactly"],
    ["device passed through", (c: any) => { c.HostConfig.Devices = [{ PathOnHost: "/dev/fuse" }]; }, "Devices"],
    ["GPU request", (c: any) => { c.HostConfig.DeviceRequests = [{ Count: -1 }]; }, "DeviceRequests"],
    // namespaces and cgroups
    ["host IPC", (c: any) => { c.HostConfig.IpcMode = "host"; }, "IpcMode"],
    ["host PID namespace", (c: any) => { c.HostConfig.PidMode = "host"; }, "PidMode"],
    ["another container's PID namespace", (c: any) => { c.HostConfig.PidMode = "container:abc"; }, "PidMode"],
    ["host user namespace", (c: any) => { c.HostConfig.UsernsMode = "host"; }, "UsernsMode"],
    ["host UTS", (c: any) => { c.HostConfig.UTSMode = "host"; }, "UTSMode"],
    ["host cgroup namespace", (c: any) => { c.HostConfig.CgroupnsMode = "host"; }, "CgroupnsMode"],
    ["joined cgroup", (c: any) => { c.HostConfig.Cgroup = "container:abc"; }, "HostConfig.Cgroup"],
    ["cgroup parent", (c: any) => { c.HostConfig.CgroupParent = "/"; }, "CgroupParent"],
    // resources
    ["memory unlimited", (c: any) => { c.HostConfig.Memory = 0; }, "Memory"],
    ["swap allowed", (c: any) => { c.HostConfig.MemorySwap = -1; }, "MemorySwap"],
    ["more CPU", (c: any) => { c.HostConfig.NanoCpus = 2_000_000_000; }, "NanoCpus"],
    ["pids unlimited", (c: any) => { c.HostConfig.PidsLimit = -1; }, "PidsLimit"],
    ["OOM killer disabled", (c: any) => { c.HostConfig.OomKillDisable = true; }, "OomKillDisable"],
    ["OOM score lowered", (c: any) => { c.HostConfig.OomScoreAdj = -1000; }, "OomScoreAdj"],
    ["realtime CPU", (c: any) => { c.HostConfig.CpuRealtimeRuntime = 950000; }, "CpuRealtimeRuntime"],
    ["file size limit missing", (c: any) => { c.HostConfig.Ulimits = c.HostConfig.Ulimits.filter((u: any) => u.Name !== "fsize"); }, "fsize"],
    ["hard limit above soft", (c: any) => { c.HostConfig.Ulimits[1].Hard = 1_048_576; }, "nofile"],
    // lifecycle
    ["restart policy", (c: any) => { c.HostConfig.RestartPolicy = { Name: "always" }; }, "RestartPolicy"],
    ["auto-remove", (c: any) => { c.HostConfig.AutoRemove = true; }, "AutoRemove"],
    ["engine logging", (c: any) => { c.HostConfig.LogConfig.Type = "json-file"; }, "LogConfig"],
    // identity of the container and its image/command
    ["wrong container name", (c: any) => { c.Name = "/research-sandbox-r2-canary"; }, "Name: must be /research-sandbox-r1-canary"],
    ["malformed container id", (c: any) => { c.Id = "abc"; }, "Id: must be"],
    ["image by tag", (c: any) => { c.Config.Image = "docker.io/library/node:22.22.0-bookworm-slim"; }, "Config.Image"],
    ["different digest", (c: any) => { c.Config.Image = `docker.io/library/node@sha256:${"cd".repeat(32)}`; }, "Config.Image"],
    ["overridden entrypoint", (c: any) => { c.Config.Entrypoint = ["/bin/sh", "-c"]; }, "Config.Entrypoint"],
    ["different command", (c: any) => { c.Config.Cmd = ["node", "/app/other.js"]; }, "Config.Cmd"],
    ["different working directory", (c: any) => { c.Config.WorkingDir = "/"; }, "WorkingDir"],
    // environment
    ["proxy injected by client config", (c: any) => { c.Config.Env.push("HTTPS_PROXY=http://proxy:3128"); }, "HTTPS_PROXY"],
    ["API key in env", (c: any) => { c.Config.Env.push("OPENAI_API_KEY=x"); }, "OPENAI_API_KEY"],
    ["unknown env name", (c: any) => { c.Config.Env.push("FOO=bar"); }, '"FOO" is not on the allowlist'],
    ["required env missing", (c: any) => { c.Config.Env = c.Config.Env.filter((e: string) => !e.startsWith("RESEARCH_RUN_ID=")); }, "RESEARCH_RUN_ID must be set"],
    // unknown or missing fields (fail closed)
    ["unknown HostConfig field", (c: any) => { c.HostConfig.FutureDangerousOption = true; }, 'HostConfig: unknown field "FutureDangerousOption"'],
    ["unknown Config field", (c: any) => { c.Config.Privileges = "all"; }, 'Config: unknown field "Privileges"'],
    ["unknown top-level field", (c: any) => { c.OCIRuntime = "crun"; }, 'unknown top-level field "OCIRuntime"'],
    ["unknown runtime", (c: any) => { c.HostConfig.Runtime = "kata-unknown"; }, "Runtime"],
    ["missing HostConfig", (c: any) => { delete c.HostConfig; }, "HostConfig: missing"],
    ["missing Mounts", (c: any) => { c.Mounts = "none"; }, "Mounts: must be an array"],
    ["malformed SecurityOpt", (c: any) => { c.HostConfig.SecurityOpt = "x"; }, "SecurityOpt: must be exactly"],
    ["malformed Ulimits", (c: any) => { c.HostConfig.Ulimits = {}; }, "Ulimits: must contain exactly fsize, nofile, core"],
    ["missing MaskedPaths", (c: any) => { c.HostConfig.MaskedPaths = "x"; }, "MaskedPaths"],
  ])("refuses %s", (_label, mutate, message) => {
    expect(check(mutate)).toContain(message);
  });

  it("refuses Podman-shaped output (runtime 'oci', RLIMIT_* names, extra top-level fields) instead of guessing", () => {
    const podmanLike = compliantInspect("crun");
    podmanLike[0].HostConfig.Runtime = "oci";
    podmanLike[0].OCIRuntime = "crun";
    podmanLike[0].HostConfig.Ulimits = podmanLike[0].HostConfig.Ulimits.map((u: any) => ({ ...u, Name: `RLIMIT_${u.Name.toUpperCase()}` }));
    const v = validateInspect(podmanLike, SPEC, EXPECT).violations.join("\n");
    expect(v).toContain("Runtime");
    expect(v).toContain("OCIRuntime");
    expect(v).toContain("Ulimits: fsize");
  });

  it("refuses everything when the spec's digest/entrypoint isn't pinned (D3)", () => {
    const v = validateInspect(compliantInspect(), SANDBOX_SPEC, EXPECT).violations.join("\n");
    expect(v).toContain("image digest is not pinned");
    expect(v).toContain("image entrypoint is not pinned");
  });

  it("checks against the expected purpose and command", () => {
    expect(validateInspect(compliantInspect(), SPEC, { ...EXPECT, purpose: "run" }).violations.join()).toContain("research-sandbox-r1-run");
    expect(validateInspect(compliantInspect(), SPEC, { ...EXPECT, command: ["node"] }).violations.join()).toContain("Config.Cmd");
  });

  it("refuses malformed output", () => {
    for (const raw of [null, [], [{}, {}], "text", 5, compliantInspect()[0]]) expect(validateInspect(raw, SPEC, EXPECT).violations.length).toBeGreaterThan(0);
  });

  it("never echoes environment variable values", () => {
    expect(check((c) => { c.Config.Env.push("OPENAI_API_KEY=sk-test-SECRET-VALUE-not-real"); })).not.toContain("SECRET-VALUE");
  });
});

describe("acceptance finding 3: required inspect fields must be present and valid (never defaulted from absence)", () => {
  const obj = (c: any, where: string) => (where === "top" ? c : c[where]);
  const label = (where: string, key: string) => (where === "top" ? key : `${where}.${key}`);

  it("covers exactly the 68 reviewed fields (29 + 7 from the v3 review + 29 from the v4 review + AttachStdout, AttachStderr, Created from the v5 review), all present in the fixture", () => {
    expect(REQUIRED_FIELDS).toHaveLength(68);
    expect(new Set(REQUIRED_FIELDS.map(([w, k]) => `${w}.${k}`)).size).toBe(68);
    for (const [where, key] of REQUIRED_FIELDS) expect(Object.prototype.hasOwnProperty.call(obj(compliantInspect()[0], where), key), label(where, key)).toBe(true);
  });

  it.each(REQUIRED_FIELDS.map(([where, key]) => [label(where, key), where, key]))("%s omitted: refused as missing", (name, where, key) => {
    const msg = check((c) => { delete obj(c, where)[key]; });
    expect(msg).toContain(`${name}: missing (required; absence is not treated as a default)`);
  });

  it.each(REQUIRED_FIELDS.map(([where, key]) => [label(where, key), where, key]))("%s malformed or ambiguous: refused", (name, where, key) => {
    const valid = JSON.stringify(obj(compliantInspect()[0], where)[key]);
    for (const bad of [-12345, "unexpected", { unexpected: true }, [1], undefined, true, false].filter((b) => JSON.stringify(b) !== valid)) {
      const msg = check((c) => { obj(c, where)[key] = bad; });
      expect(msg, `${name} = ${JSON.stringify(bad)}`).toContain(`${name}: `);
    }
  });

  it("Docker's empty encodings (null, [] or {}) are accepted where the field is a list or map", () => {
    expect(check((c) => { c.HostConfig.Dns = null; c.HostConfig.Links = []; c.HostConfig.PortBindings = null; c.Config.Volumes = {}; c.HostConfig.OomKillDisable = null; })).toBe("");
  });

  it("weakened values are refused with the field named", () => {
    const cases: Array<[(c: any) => void, string]> = [
      [(c) => { c.AppArmorProfile = "custom-permissive"; }, "AppArmorProfile: must be docker-default"],
      [(c) => { c.NetworkSettings = { Ports: {}, Networks: { bridge: {} } }; }, "NetworkSettings: must contain only the none network"],
      [(c) => { c.NetworkSettings = {}; }, "NetworkSettings: must contain only the none network"],
      [(c) => { c.HostConfig.RestartPolicy = { Name: "always", MaximumRetryCount: 0 }; }, "HostConfig.RestartPolicy"],
      [(c) => { c.HostConfig.RestartPolicy = { Name: "no" }; }, "HostConfig.RestartPolicy"],
      [(c) => { c.HostConfig.OomKillDisable = true; }, "HostConfig.OomKillDisable"],
      [(c) => { c.HostConfig.PublishAllPorts = null; }, "HostConfig.PublishAllPorts"],
      [(c) => { c.HostConfig.UsernsMode = "host"; }, "HostConfig.UsernsMode"],
    ];
    for (const [mutate, message] of cases) expect(check(mutate)).toContain(message);
  });

  it("acceptance finding 2: any per-container seccomp override is refused, including a custom profile", () => {
    expect(check((c) => { c.HostConfig.SecurityOpt.push(`seccomp=${JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW" })}`); })).toContain("HostConfig.SecurityOpt: must be exactly");
    expect(check((c) => { c.HostConfig.SecurityOpt.push("seccomp:/etc/custom.json"); })).toContain("HostConfig.SecurityOpt: must be exactly");
  });
});

describe("M5 and L1: review probes and nested objects are refused", () => {
  it.each([
    // the exact probes from the review
    ["Annotations with a runtime flag", (c: any) => { c.HostConfig.Annotations = { "dev.gvisor.flag.network": "host" }; }, "HostConfig.Annotations: must be empty"],
    ["Init true (host docker-init injected)", (c: any) => { c.HostConfig.Init = true; }, "HostConfig.Init: must not inject"],
    ["State running", (c: any) => { c.State = { Status: "running", Running: true, Pid: 1234 }; }, "State: must be a created, never-started container"],
    ["ExecIDs non-empty", (c: any) => { c.ExecIDs = ["x"]; }, "ExecIDs: no exec sessions"],
    ["Healthcheck command", (c: any) => { c.Config.Healthcheck = { Test: ["CMD", "node", "-e", "1"] }; }, "Config.Healthcheck: must be disabled"],
    ["mount BindOptions.ReadOnlyNonRecursive", (c: any) => { c.HostConfig.Mounts[0].BindOptions.ReadOnlyNonRecursive = true; }, "no NonRecursive, ReadOnlyNonRecursive"],
    ["NetworkSettings published ports", (c: any) => { c.NetworkSettings.Ports = { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] }; }, "NetworkSettings: must contain only the none network"],
    ["NetworkSettings unknown key", (c: any) => { c.NetworkSettings.SandboxKeyX = "/var/run/docker/netns/x"; }, "NetworkSettings: must contain only the none network"],
    ["StorageOpt absent", (c: any) => { delete c.HostConfig.StorageOpt; }, "HostConfig.StorageOpt: missing"],
    ["CpuRealtimeRuntime absent", (c: any) => { delete c.HostConfig.CpuRealtimeRuntime; }, "HostConfig.CpuRealtimeRuntime: missing"],
    // further unsafe or ambiguous nested values
    ["State with an unknown key", (c: any) => { c.State.Unexpected = 1; }, "State: must be a created"],
    ["State with health data", (c: any) => { c.State.Health = { Status: "healthy" }; }, "State: must be a created"],
    ["State missing a required flag", (c: any) => { delete c.State.Running; }, "State: must be a created"],
    ["Healthcheck missing (not disabled)", (c: any) => { delete c.Config.Healthcheck; }, "Config.Healthcheck: missing"],
    ["Healthcheck with extra keys", (c: any) => { c.Config.Healthcheck = { Test: ["NONE"], Interval: 1 }; }, "Config.Healthcheck: must be disabled"],
    ["Annotations missing", (c: any) => { delete c.HostConfig.Annotations; }, "HostConfig.Annotations: missing"],
    ["Init missing", (c: any) => { delete c.HostConfig.Init; }, "HostConfig.Init: missing"],
    ["mount BindOptions.NonRecursive", (c: any) => { c.HostConfig.Mounts[1].BindOptions.NonRecursive = true; }, "HostConfig.Mounts: entries may have only"],
    ["mount BindOptions.CreateMountpoint", (c: any) => { c.HostConfig.Mounts[0].BindOptions.CreateMountpoint = true; }, "HostConfig.Mounts: entries may have only"],
    ["mount request with VolumeOptions", (c: any) => { c.HostConfig.Mounts[0].VolumeOptions = {}; }, "HostConfig.Mounts: entries may have only"],
    ["mount request without BindOptions", (c: any) => { delete c.HostConfig.Mounts[0].BindOptions; }, "HostConfig.Mounts: entries may have only"],
    ["top-level mount with an unknown key", (c: any) => { c.Mounts[0].Driver = "local"; }, "Mounts: every entry must have only"],
    ["top-level mount with a non-empty Mode", (c: any) => { c.Mounts[0].Mode = "z"; }, "Mounts: every entry must have only"],
    ["the none network with aliases", (c: any) => { c.NetworkSettings.Networks.none.Aliases = ["db"]; }, "NetworkSettings: must contain only"],
    ["an IP address assigned", (c: any) => { c.NetworkSettings.IPAddress = "172.17.0.2"; }, "NetworkSettings: must contain only"],
    ["Ports missing", (c: any) => { delete c.NetworkSettings.Ports; }, "NetworkSettings: must contain only"],
    ["log driver options", (c: any) => { c.HostConfig.LogConfig.Config = { "syslog-address": "udp://x" }; }, "HostConfig.LogConfig: must be type none with no options"],
  ])("%s: refused", (_label, mutate, message) => {
    expect(check(mutate)).toContain(message);
  });
});

describe("v4 review: exact allowlists for security options, ulimits, tmpfs options and the remaining fields", () => {
  it.each([
    // SecurityOpt (exact allowlist)
    ["SELinux super-privileged label (label=type:spc_t)", (c: any) => { c.HostConfig.SecurityOpt.push("label=type:spc_t"); }, "HostConfig.SecurityOpt: must be exactly"],
    ["contradictory no-new-privileges:false after :true", (c: any) => { c.HostConfig.SecurityOpt.push("no-new-privileges:false"); }, "HostConfig.SecurityOpt: must be exactly"],
    ["unknown security option", (c: any) => { c.HostConfig.SecurityOpt.push("writable-cgroups=true"); }, "HostConfig.SecurityOpt: must be exactly"],
    ["duplicate no-new-privileges", (c: any) => { c.HostConfig.SecurityOpt.push("no-new-privileges:true"); }, "HostConfig.SecurityOpt: must be exactly"],
    ["the bare no-new-privileges spelling (not what the argv sets)", (c: any) => { c.HostConfig.SecurityOpt = ["no-new-privileges"]; }, "HostConfig.SecurityOpt: must be exactly"],
    ["empty SecurityOpt (missing evidence)", (c: any) => { c.HostConfig.SecurityOpt = []; }, "HostConfig.SecurityOpt: must be exactly"],
    ["null SecurityOpt", (c: any) => { c.HostConfig.SecurityOpt = null; }, "HostConfig.SecurityOpt: must be exactly"],
    ["SecurityOpt absent", (c: any) => { delete c.HostConfig.SecurityOpt; }, "HostConfig.SecurityOpt: missing"],
    // Ulimits (exact set)
    ["extra ulimit rtprio=99", (c: any) => { c.HostConfig.Ulimits.push({ Name: "rtprio", Soft: 99, Hard: 99 }); }, "HostConfig.Ulimits: must contain exactly fsize, nofile, core"],
    ["extra ulimit memlock=-1", (c: any) => { c.HostConfig.Ulimits.push({ Name: "memlock", Soft: -1, Hard: -1 }); }, "HostConfig.Ulimits: must contain exactly"],
    ["duplicate ulimit (replacing another)", (c: any) => { c.HostConfig.Ulimits[2] = { Name: "nofile", Soft: 256, Hard: 256 }; }, "HostConfig.Ulimits: core must appear once"],
    ["ulimit entry with an extra key", (c: any) => { c.HostConfig.Ulimits[0].Extra = 1; }, "HostConfig.Ulimits: entries must have only Name, Soft and Hard"],
    ["ulimit entry missing Hard", (c: any) => { delete c.HostConfig.Ulimits[1].Hard; }, "HostConfig.Ulimits: entries must have only Name, Soft and Hard"],
    ["ulimit entry not an object", (c: any) => { c.HostConfig.Ulimits[1] = "nofile=256:256"; }, "HostConfig.Ulimits: entries must have only Name, Soft and Hard"],
    ["ulimit soft above spec", (c: any) => { c.HostConfig.Ulimits[1].Soft = 1024; }, "HostConfig.Ulimits: nofile must appear once as 256:256"],
    ["Ulimits null", (c: any) => { c.HostConfig.Ulimits = null; }, "HostConfig.Ulimits: must contain exactly"],
    // tmpfs options (whole list)
    ["tmpfs exec after noexec", (c: any) => { c.HostConfig.Tmpfs["/tmp"] = "rw,noexec,nosuid,nodev,size=67108864,exec"; }, 'option "exec" is not allowed'],
    ["tmpfs duplicate size (small then huge)", (c: any) => { c.HostConfig.Tmpfs["/tmp"] = "rw,noexec,nosuid,nodev,size=1024,size=99999999999"; }, "exactly one size"],
    ["tmpfs repeated noexec", (c: any) => { c.HostConfig.Tmpfs["/tmp"] = "rw,noexec,noexec,nosuid,nodev,size=1024"; }, "must be noexec (exactly once)"],
    ["tmpfs suid / dev", (c: any) => { c.HostConfig.Tmpfs["/tmp"] = "rw,noexec,nosuid,nodev,suid,size=1024"; }, 'option "suid" is not allowed'],
    ["tmpfs mode option", (c: any) => { c.HostConfig.Tmpfs["/tmp"] = "rw,noexec,nosuid,nodev,size=1024,mode=1777"; }, 'option "mode=1777" is not allowed'],
    ["tmpfs size with a unit", (c: any) => { c.HostConfig.Tmpfs["/tmp"] = "rw,noexec,nosuid,nodev,size=64m"; }, 'option "size=64m" is not allowed'],
    ["tmpfs repeated rw", (c: any) => { c.HostConfig.Tmpfs["/tmp"] = "rw,rw,noexec,nosuid,nodev,size=1024"; }, "rw may appear at most once"],
    // Remaining fields from the review
    ["CpuQuota/CpuPeriod set", (c: any) => { c.HostConfig.CpuQuota = 900000; c.HostConfig.CpuPeriod = 100000; }, "HostConfig.CpuQuota: must be 0"],
    ["CpusetCpus set", (c: any) => { c.HostConfig.CpusetCpus = "0-63"; }, "HostConfig.CpusetCpus: must be empty"],
    ["BlkioWeight set", (c: any) => { c.HostConfig.BlkioWeight = 1000; }, "HostConfig.BlkioWeight: must be 0"],
    ["Blkio device throttle set", (c: any) => { c.HostConfig.BlkioDeviceReadBps = [{ Path: "/dev/sda", Rate: 1 }]; }, "HostConfig.BlkioDeviceReadBps: must be empty"],
    ["ShmSize 1 GiB", (c: any) => { c.HostConfig.ShmSize = 1 << 30; }, "HostConfig.ShmSize: must be 0..64 MiB"],
    ["ProcessLabel unconfined SELinux type", (c: any) => { c.ProcessLabel = "system_u:system_r:spc_t:s0"; }, "ProcessLabel: must be empty"],
    ["MountLabel set", (c: any) => { c.MountLabel = "system_u:object_r:container_file_t:s0"; }, "MountLabel: must be empty"],
    ["Path/Args differ from Entrypoint/Cmd", (c: any) => { c.Path = "/bin/sh"; c.Args = ["-c", "id"]; }, "Path/Args: must be the pinned entrypoint followed by the requested command"],
    ["Path/Args missing", (c: any) => { delete c.Path; }, "Path/Args: missing"],
    ["OpenStdin", (c: any) => { c.Config.OpenStdin = true; }, "Config.OpenStdin: must be false"],
    ["Tty", (c: any) => { c.Config.Tty = true; }, "Config.Tty: must be false"],
    ["Labels", (c: any) => { c.Config.Labels = { x: "y" }; }, "Config.Labels: must be empty"],
    ["Networks.none DriverOpts", (c: any) => { c.NetworkSettings.Networks.none.DriverOpts = { a: "b" }; }, "NetworkSettings: must contain only"],
    ["Networks.none IPAMConfig", (c: any) => { c.NetworkSettings.Networks.none.IPAMConfig = { IPv4Address: "10.1.1.1" }; }, "NetworkSettings: must contain only"],
    ["Networks.none unknown key", (c: any) => { c.NetworkSettings.Networks.none.Unexpected = 1; }, "NetworkSettings: must contain only"],
    ["Networks.none endpoint assigned", (c: any) => { c.NetworkSettings.Networks.none.EndpointID = "abc"; }, "NetworkSettings: must contain only"],
    ["GraphDriver unknown Data key", (c: any) => { c.GraphDriver.Data.Extra = "/x"; }, "GraphDriver: must have only Name and string Data paths"],
    ["GraphDriver extra key", (c: any) => { c.GraphDriver.Options = {}; }, "GraphDriver: must have only Name and string Data paths"],
    ["GraphDriver malformed", (c: any) => { c.GraphDriver = "overlay2"; }, "GraphDriver: must have only Name"],
    ["LogPath set", (c: any) => { c.LogPath = "/var/lib/docker/containers/x/x-json.log"; }, "LogPath: must be empty"],
    ["Image id malformed", (c: any) => { c.Image = "node:latest"; }, "Image: must be a sha256 image id"],
    ["Platform other", (c: any) => { c.Platform = "windows"; }, "Platform: must be linux"],
    ["RestartCount non-zero", (c: any) => { c.RestartCount = 3; }, "RestartCount: must be 0"],
    ["MemorySwappiness set", (c: any) => { c.HostConfig.MemorySwappiness = 60; }, "HostConfig.MemorySwappiness: must be unset"],
    ["ContainerIDFile set", (c: any) => { c.HostConfig.ContainerIDFile = "/tmp/cid"; }, "HostConfig.ContainerIDFile: must be empty"],
    // Optional (deprecated/platform) keys: unsafe when present
    ["KernelMemory present and non-zero", (c: any) => { c.HostConfig.KernelMemory = 1; }, "HostConfig.KernelMemory: must be 0"],
    ["ExposedPorts present", (c: any) => { c.Config.ExposedPorts = { "80/tcp": {} }; }, "Config.ExposedPorts: must be empty"],
    ["StopSignal malformed", (c: any) => { c.Config.StopSignal = "kill -9"; }, "Config.StopSignal: must be a signal name"],
    ["SizeRw malformed", (c: any) => { c.SizeRw = "big"; }, "SizeRw: must be a size"],
    // Type-only metadata: must still be present strings
    ["ResolvConfPath missing", (c: any) => { delete c.ResolvConfPath; }, "ResolvConfPath: must be /var/lib/docker/containers/"],
    ["Config.Hostname malformed", (c: any) => { c.Config.Hostname = 1; }, 'Config.Hostname: must be "sandbox"'],
    ["ImageManifestDescriptor malformed", (c: any) => { c.ImageManifestDescriptor = "x"; }, "ImageManifestDescriptor: must be a linux image manifest descriptor"],
    ["MaskedPaths with a non-string entry", (c: any) => { c.HostConfig.MaskedPaths.push(42); }, "HostConfig.MaskedPaths: must include"],
  ])("%s: refused", (_label, mutate, message) => {
    expect(check(mutate)).toContain(message);
  });

  it("the security-option allowlist is exactly the option the create argv sets", () => {
    expect(ALLOWED_SECURITY_OPTS).toEqual(["no-new-privileges:true"]);
    expect(Object.isFrozen(ALLOWED_SECURITY_OPTS)).toBe(true);
  });

  it("optional keys may be absent, and are accepted only with their safe values", () => {
    expect(check(() => {})).toBe(""); // fixture has none of them
    const safe: Record<string, unknown> = { KernelMemory: 0, KernelMemoryTCP: 0, CpuCount: 0, CpuPercent: 0, IOMaximumIOps: 0, IOMaximumBandwidth: 0, ConsoleSize: [0, 0],
      Domainname: "", ExposedPorts: null, OnBuild: null, MacAddress: "", NetworkDisabled: false, ArgsEscaped: false, Shell: null, StopSignal: "SIGTERM", StopTimeout: 10, SizeRw: 0, SizeRootFs: 0 };
    expect(check((c) => { for (const [where, key] of OPTIONAL_FIELDS) (where === "top" ? c : c[where])[key] = safe[key]; })).toBe("");
  });
});

describe("v5 review: host file paths, attach flags, exact environment, metadata and never-started state", () => {
  const OTHER = "f".repeat(64);
  const withEnv = (f: (env: string[]) => string[]) => (c: any) => { c.Config.Env = f(c.Config.Env); };
  it.each([
    // 1. host files behind /etc/hosts, /etc/hostname, /etc/resolv.conf
    ["ResolvConfPath -> /etc/shadow", (c: any) => { c.ResolvConfPath = "/etc/shadow"; }, `ResolvConfPath: must be /var/lib/docker/containers/${CONTAINER_ID}/resolv.conf`],
    ["HostsPath -> /root/.ssh/authorized_keys", (c: any) => { c.HostsPath = "/root/.ssh/authorized_keys"; }, "HostsPath: must be"],
    ["HostnamePath relative", (c: any) => { c.HostnamePath = "../../etc/passwd"; }, "HostnamePath: must be"],
    ["HostsPath of another container", (c: any) => { c.HostsPath = `/var/lib/docker/containers/${OTHER}/hosts`; }, "HostsPath: must be"],
    ["ResolvConfPath empty", (c: any) => { c.ResolvConfPath = ""; }, "ResolvConfPath: must be"],
    // 2. attach flags
    ["AttachStdout absent", (c: any) => { delete c.Config.AttachStdout; }, "Config.AttachStdout: missing"],
    ["AttachStdout malformed", (c: any) => { c.Config.AttachStdout = "yes"; }, "Config.AttachStdout: must be true"],
    ["AttachStderr false", (c: any) => { c.Config.AttachStderr = false; }, "Config.AttachStderr: must be true"],
    // 3. exact environment
    ["duplicate NODE_ENV overriding", withEnv((e) => [...e, "NODE_ENV=development"]), "Config.Env: duplicate variable names"],
    ["NODE_ENV=development", withEnv((e) => e.map((x) => (x.startsWith("NODE_ENV=") ? "NODE_ENV=development" : x))), "Config.Env: must be exactly"],
    ["RESEARCH_RUN_ID for another run", withEnv((e) => e.map((x) => (x.startsWith("RESEARCH_RUN_ID=") ? "RESEARCH_RUN_ID=r2" : x))), "Config.Env: must be exactly"],
    ["PATH with writable directories first", withEnv((e) => e.map((x) => (x.startsWith("PATH=") ? "PATH=/tmp:/out:/usr/bin" : x))), "Config.Env: must be exactly"],
    ["bare name without =", withEnv((e) => [...e, "NODE_VERSION"]), "Config.Env: every entry must be a printable NAME=value string"],
    ["duplicate PATH", withEnv((e) => [...e, "PATH=/out"]), "Config.Env: duplicate variable names"],
    ["an image variable missing", withEnv((e) => e.filter((x) => !x.startsWith("YARN_VERSION="))), "Config.Env: must be exactly"],
    ["non-printable value", withEnv((e) => [...e.filter((x) => !x.startsWith("NODE_ENV=")), "NODE_ENV=prod\nuction"]), "Config.Env: every entry must be"],
    // 4. metadata
    ["Created arbitrary text", (c: any) => { c.Created = "not a date"; }, "Created: must be an RFC 3339 UTC timestamp"],
    ["Created impossible date", (c: any) => { c.Created = "2026-13-45T99:99:99Z"; }, "Created: must be an RFC 3339 UTC timestamp"],
    ["Driver arbitrary", (c: any) => { c.Driver = "../../x"; }, "Driver: must be a driver name equal to GraphDriver.Name"],
    ["Driver differs from GraphDriver.Name", (c: any) => { c.Driver = "vfs"; }, "Driver: must be a driver name equal to GraphDriver.Name"],
    ["Hostname not the configured one", (c: any) => { c.Config.Hostname = "evil.example"; }, 'Config.Hostname: must be "sandbox"'],
    ["ImageManifestDescriptor arbitrary object", (c: any) => { c.ImageManifestDescriptor = { anything: true, digest: FAKE_MANIFEST_DIGEST }; }, "ImageManifestDescriptor: must be a linux image manifest descriptor"],
    ["ImageManifestDescriptor with another digest", (c: any) => { c.ImageManifestDescriptor = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${"00".repeat(32)}`, size: 1000 }; }, "ImageManifestDescriptor: must be"],
    ["ImageManifestDescriptor for windows", (c: any) => { c.ImageManifestDescriptor = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: FAKE_MANIFEST_DIGEST, size: 1000, platform: { os: "windows", architecture: "amd64" } }; }, "ImageManifestDescriptor: must be"],
    ["ImageManifestDescriptor with an index media type", (c: any) => { c.ImageManifestDescriptor = { mediaType: "application/vnd.oci.image.index.v1+json", digest: FAKE_MANIFEST_DIGEST, size: 1000 }; }, "ImageManifestDescriptor: must be"],
    // 5. never-started state
    ["State.Error non-empty", (c: any) => { c.State.Error = "OCI runtime create failed"; }, "State: must be a created, never-started container"],
    ["State.StartedAt set", (c: any) => { c.State.StartedAt = "2026-10-17T00:00:01Z"; }, "State: must be a created, never-started container"],
    ["State.FinishedAt set", (c: any) => { c.State.FinishedAt = "2026-10-17T00:00:02Z"; }, "State: must be a created, never-started container"],
    ["State.Error missing", (c: any) => { delete c.State.Error; }, "State: must be a created, never-started container"],
    ["State.StartedAt missing", (c: any) => { delete c.State.StartedAt; }, "State: must be a created, never-started container"],
  ])("%s: refused", (_label, mutate, message) => {
    expect(check(mutate)).toContain(message);
  });

  it("environment values never appear in messages", () => {
    const msg = check(withEnv((e) => e.map((x) => (x.startsWith("NODE_ENV=") ? "NODE_ENV=super-secret-value" : x))));
    expect(msg).toContain("Config.Env");
    expect(msg).not.toContain("super-secret-value");
  });

  it("a correct ImageManifestDescriptor with the recorded digest is accepted; absent is accepted (classic image store)", () => {
    expect(check((c) => { c.ImageManifestDescriptor = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: FAKE_MANIFEST_DIGEST, size: 1234, platform: { architecture: "amd64", os: "linux" } }; })).toBe("");
    expect(check(() => {})).toBe("");
  });

  it("unrecorded data root, image environment or manifest digest: refused rather than guessed", () => {
    const base = { imageDigest: FAKE_DIGEST, imageEntrypoint: FAKE_ENTRYPOINT };
    expect(check(() => {}, resolveSpec({ ...base, imageEnv: FAKE_IMAGE_ENV, imageManifestDigest: FAKE_MANIFEST_DIGEST }))).toContain("dockerDataRoot is not recorded");
    expect(check(() => {}, resolveSpec({ ...base, imageManifestDigest: FAKE_MANIFEST_DIGEST, dockerDataRoot: "/var/lib/docker" }))).toContain("Config.Env: the image environment has not been recorded");
    const noDigest = resolveSpec({ ...base, imageEnv: FAKE_IMAGE_ENV, dockerDataRoot: "/var/lib/docker" });
    expect(check(() => {}, noDigest)).toBe(""); // no descriptor reported: nothing to compare
    expect(check((c) => { c.ImageManifestDescriptor = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: FAKE_MANIFEST_DIGEST, size: 1 }; }, noDigest))
      .toContain("ImageManifestDescriptor: reported, but no manifest digest has been recorded");
  });
});
