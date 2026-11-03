# Research sandbox — Phase 1, stage S1

Isolation specification and fail-closed preflight for the future offline
research analyst. **Nothing here processes research documents, calls a
model, pulls an image or touches the network.** No untrusted input may be
processed until a preflight on the target host returns `meets-spec`.

> **`meets-spec` is currently unreachable by design.** `MEETS_SPEC_BLOCKERS`
> (`preflight.ts`) refuses every isolating runtime, even when all checks
> pass, until (M1) host-side verification that `runsc` is the approved gVisor
> binary is implemented and reviewed, and (M3) the trust assumptions about the
> pinned Docker version and its daemon-reported seccomp profile are explicitly
> resolved. M1 host-side binary verification now exists (fakes only, see
> below) but has not been reviewed or run on a real host, so the M1 blocker
> stays. `assertUntrustedInputAllowed` refuses for the same reasons, and a
> direct call to `rate()` returns `refused` for the approved configuration.
> Removing a blocker is a reviewed code change.

## Decisions encoded

| Decision | Effect |
|---|---|
| D1 dedicated host | Designed for a machine you control. Software cannot verify host trust; results always say `hostTrust: "operator-attested-only"` (a fixed label; nothing records or checks an attestation). The current root cloud session is **not** a security boundary. |
| D2 runtime | `meets-spec` requires **Docker with gVisor (`runsc`) positively identified** (see "gVisor evidence"; the runtime *name* is never enough) **and the daemon's built-in seccomp profile**, the only approved configuration whose formats this code supports. Docker with `runc`/`crun` (rootless or rootful) is `development-only`: disposable fixture tests only, never untrusted input. **Podman is refused** (its inspect output differs: e.g. `Runtime: "oci"`, `RLIMIT_*` ulimit names) until its formats are verified and approved; rootless Docker is not treated as meets-spec. |
| D3 image | `docker.io/library/node:22.22.0-bookworm-slim`, pinned **by digest, entrypoint, image environment and (containerd image store) platform manifest digest**. All are `null` until a separately approved pull records them; until then every preflight refuses (a reported manifest descriptor without a recorded digest also refuses). `create` always runs with **`--pull never`**: the engine adapter requires exactly one `--pull never` before the single pinned image reference and refuses duplicates, `--pull=...` forms and `--pull` among the command arguments, so a preflight can never download an image. The S3 sandbox image will be built `FROM` that digest and pinned in turn. |

## Specification (`spec.ts`, frozen; runs may only tighten numeric limits)

| Property | Value |
|---|---|
| Run folders | exactly `/srv/research-runs/<runId>/in` (read-only at `/in`) and `/srv/research-runs/<runId>/out` (read-write at `/out`); nothing else can be mounted |
| Network | `--network none` |
| Root filesystem | read-only; `/tmp` tmpfs noexec,nosuid,nodev, 64 MiB |
| Identity | user 10001:10001, `--cap-drop ALL`, `SecurityOpt` exactly `["no-new-privileges:true"]` (allowlist: any other, duplicate or contradictory option refuses, so no seccomp/apparmor/label/systempaths override), daemon must report `name=seccomp,profile=builtin`, AppArmor `docker-default` (or none on non-AppArmor hosts), no SELinux process/mount labels (SELinux hosts refuse until reviewed), no supplementary groups |
| Namespaces/cgroups | ipc none; pid/uts/userns private; `--cgroupns private`; no cgroup parent |
| Resources | 512 MiB memory, no swap, 0.5 CPU (`NanoCpus` only: CPU shares/period/quota/realtime/cpuset, memory reservation/swappiness and all block-IO knobs must be unset), 64 pids, ulimits exactly fsize/nofile/core 50 MiB/256/0 (soft = hard; no other or duplicate entries), `ShmSize` ≤ 64 MiB |
| Image | `--pull never`; pinned digest; pinned entrypoint; `--no-healthcheck`; `--hostname sandbox` (so `Config.Hostname` has a known value) |
| Docker server version | the daemon's `docker info` `ServerVersion` must equal the recorded `dockerServerVersion` (recorded at an approved host setup; `null` refuses; missing, malformed or different refuses; re-checked whenever `docker info` is re-read; the client version is never used). No version is chosen in code. This is groundwork for M3; it does not resolve the trust decision. |
| Engine target | every Docker call uses `--host unix:///var/run/docker.sock --config <operator-prepared empty folder>`; verified before any engine call (see below) |
| Lifecycle | named `research-sandbox-<runId>-<canary|run>`; no restart; no auto-remove (removal is verified instead); `--log-driver none` |
| Environment | exactly the recorded image environment (`PATH`, `NODE_VERSION`, `YARN_VERSION` values recorded at the approved pull) plus `NODE_ENV=production` and `RESEARCH_RUN_ID=<runId>`: names **and values**, no duplicates, every entry a printable `NAME=value`; values never appear in messages |
| `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf` | inspect paths must be exactly `<dockerDataRoot>/containers/<id>/{hosts,hostname,resolv.conf}` (`dockerDataRoot` recorded at an approved host setup; `null` refuses); on the host each is a root-owned regular file (no symlink) under root-owned directories not writable by group/others; the canary must see each mounted exactly once with the `ro` option in `/proc/self/mountinfo` |

## Host folder checks (`host-paths.ts`, target host)
Every component from `/` is a real directory (lstat, never a symlink) whose
realpath is unchanged; `/` and ancestors are owned by root or the operator
and not group/world-writable; `in/` not writable by group/others; `out/`
owned by the configured output uid, mode `0700`-style, **empty**; `in/` ≠
`out/`. The preflight re-checks these and the folders' (dev, ino) identity
after the container is created.

**Limitation (time-of-check/time-of-use):** the engine mounts by path name,
so a folder could be swapped between the check and the mount. Only root or
the operator can do that under the ancestor rules, and identity is
re-checked after creation, but the window cannot be closed portably through
the engine CLI.

## Preflight (`preflight.ts`) — fail closed
spec (digest + entrypoint) → exact paths → host folders → **engine target**
(socket and config folder, below) → engine info (Podman refused; daemon
seccomp profile must be reported as `builtin`) → leftover-container check →
**create** canary (`--pull never`) → **inspect** (allowlisted keys; 65
required fields present with their exact safe values, absence never read
as a default; deprecated/platform keys checked when present; State,
NetworkSettings and `Networks.none`, Healthcheck, LogConfig, GraphDriver,
ulimit and mount entries allowlisted key by key; tmpfs options validated as
a whole; `Path`/`Args` equal the pinned entrypoint plus the command; every property, id, name, command,
entrypoint; host folders re-checked) → **start** probe (timeout 60 s,
64 KiB output cap) → evaluate → **gVisor evidence** for `runsc` (host
`/proc/version` read by the preflight itself) → **blocked** for `runsc`
(M1, M3) → **cleanup always**: up to 3 forced removals by id
(or by name if the id was never learned), then removal **verified**; if it
can't be verified the result is refused and names the container for manual
cleanup. Killing a timed-out CLI does not stop the container; only the
verified removal establishes that it is gone.

**Engine target (`host-paths.ts`):** so that no saved context, `DOCKER_*`
setting or client config can redirect the CLI to another daemon or inject
settings, the CLI is pinned to `/var/run/docker.sock` and to an empty client
config folder that the operator prepares (nothing is created). Checked:
`/` and `/var` real root-owned directories; `/var/run` a real root-owned
directory or a root-owned symlink to `/run`; the socket root-owned, a
socket, not world-writable; the config folder outside the runs root, every
ancestor a real directory owned by root or the operator and not
group/world-writable, the folder itself private (`0700`-style) and empty.
Anyone who can write to the socket (e.g. the `docker` group) is effectively
root on the host; that is a host-trust matter (D1), not checked here.

A passing result is **bound** to run id, folders, image reference, runtime,
the recorded gVisor reference and a hash of the security-relevant create
arguments;
`assertUntrustedInputAllowed` requires all of them to match the intended
run. This prevents accidental reuse; it cannot stop forgery by code already
running in the same process.

## Canary evidence (`canary.ts`; observed inside the container)

| Observation | Source | Required |
|---|---|---|
| uid/gid (real, effective, saved, fs), supplementary groups | `/proc/self/status` | all 10001; no other groups |
| CapEff, CapPrm, CapBnd | `/proc/self/status` | all zero |
| NoNewPrivs, Seccomp | `/proc/self/status` | 1, 2 |
| Interfaces; IPv4 routes; IPv6 route devices | `/proc/net/dev`, `/proc/net/route`, `/proc/net/ipv6_route` | only `lo`; none; only `lo` |
| Outbound TCP attempt to 192.0.2.1:9 | socket | must fail — **supplementary only**: a timeout to an unroutable test address also happens on networked hosts, so it is **not** proof of network denial; the interface and route observations are the evidence |
| Read-only root, `/app`, `/in` | write attempts | must fail with **EROFS** (EACCES would only show missing permission) |
| `/out`, `/tmp` writable | write + delete | allowed |
| Unmounted host canary file | read attempt | absent or denied |
| Socket files | scan of `/`, `/run` (2 levels), `/var/run` (2 levels), `/tmp`, `/app`, `/in`, `/out` | none; every scanned directory readable or absent |
| rlimits soft and hard | `/proc/self/limits` | ≤ spec |
| cgroup memory.max, pids.max | `/sys/fs/cgroup` | ≤ spec |
| Kernel identity | `/proc/version` | present and well-formed (used for gVisor evidence) |

### M1: runtime binary verification (required for `meets-spec`; fakes only so far)
`runscBinary` (path, SHA-256, and runtime args that must be an **empty
array**) is recorded at an approved host setup; `null` refuses. No runsc
flag has been reviewed, so any configured or recorded flag refuses; adding
one later needs a separate review. For an isolating runtime the preflight
requires, before anything is created:
- `docker info` configures the runtime in the classic form: `path` exactly
  the recorded path, `runtimeArgs` absent or `[]` (`null`, strings or any
  flag refuse), `status` absent or an object of string values; the
  `runtimeType`/shim form, `options` or any other key refuses, because it
  would run something other than the checked binary;
- the path is a plain file name (no dot-only or hidden names) directly
  inside `/usr/bin`, `/usr/sbin`, `/usr/local/bin` or `/usr/local/sbin`; `/`
  and every directory down to it are real root-owned directories (no
  symlinks) that group and others can't write, so only root can replace the
  file;
- the binary is a regular root-owned executable (no symlink, not
  group/world-writable, no setuid/setgid), hashed through an
  `O_NOFOLLOW|O_NONBLOCK` descriptor (a FIFO swapped in is refused instead of
  blocking) whose inode must be the one checked, and unchanged (inode, size,
  mtime, ctime) after hashing.

Afterwards: `docker info` is **re-read after create** (before the container
is inspected or started) **and after the canary**; the runtime must still be
offered, its configuration must still pass the rules above and must equal
the verified one (canonical comparison); missing, malformed, unreadable or
changed data refuses. After the canary the binary is verified again and must
be the identical file.

Limits (why the M1 blocker remains):
- Re-reads and re-checks only show the state at those moments. The daemon
  starts the runtime by path, between our reads; a reconfiguration or a
  binary swap that is undone before the next check can't be detected
  (time-of-check/time-of-use). Only root can swap the binary under the
  directory rules.
- `docker info` is the daemon's own report: a dishonest daemon can report
  the approved configuration and run something else. Unchanged reports are
  not proof of what ran.
- Unverified offline: the real `docker info` shape for a configured runtime
  (the field names `path`, `runtimeArgs`, `runtimeType`, `options` and
  `status` do appear in the local Docker binaries); whether Docker runs a
  `path` runtime through containerd and its runc shim (those binaries are
  not verified); and any flags Docker itself adds when invoking runsc.
- A matching hash identifies the file; it does not prove isolation (runsc's
  platform, host kernel and the daemon's seccomp handling still matter).
- JSON duplicate keys in `docker info` output collapse when parsed and can't
  be detected after parsing.

### gVisor evidence (required for `meets-spec`)
Docker maps runtime names to arbitrary binaries, so a runtime named `runsc`
proves nothing. gVisor runs its own emulated kernel, so the container's
`/proc/version` differs from the host's; runc/crun show the host kernel's
text. The preflight requires the container's `/proc/version` to **differ
from the host's** and to **equal the reference recorded for gVisor on this
host** (`gvisorProcVersion`, recorded once at an approved host setup). It is
`null` today, so every preflight that reaches this step refuses. The host's
`/proc/version` is read by the preflight itself (missing or unreadable
refuses); callers cannot supply it. A `runsc`
runtime that fails this check is **refused**, not downgraded. This is a
fingerprint, not a cryptographic proof: the string is static and public,
and anything controlling the runtime (e.g. a wrapper or hook) could
present it. Hence blocker M1: host-side runtime verification is required
before `meets-spec` can ever be granted.

Missing, malformed or ambiguous observations refuse. These are observations
from one probe run in one container; they do not prove enforcement for
paths the probe did not exercise.

## Verified in S1 vs needs the target host

| Verified offline (fixtures, fakes, harmless local processes) | Requires the target host + runtime |
|---|---|
| Spec, exact paths, tighten-only overrides, exact argv, security-args hash | That Docker + gVisor apply each flag |
| Host folder rules against a fake filesystem; real `lstat` symlink detection on a temp folder | Real ownership/permissions/uid mapping of the run folders; the TOCTOU window |
| Inspect refuses every weakened, missing or unknown setting (Docker format); each of the 68 required fields refuses when omitted or malformed; nested objects are allowlisted; host file paths, environment, `Created` (RFC 3339), `Driver` (= `GraphDriver.Name`), `Config.Hostname` (= `sandbox`) and `ImageManifestDescriptor` (recorded digest, linux manifest) have exact checks; `State` must show a never-started container. `MaskedPaths`/`ReadonlyPaths` must include the required entries (more is accepted). **All of this is the daemon's own report:** it detects misconfiguration, not a dishonest daemon (D1/M3) | Exact Docker inspect output on the target version (written from memory, not checked against Docker's documentation; new fields refuse until reviewed; if Docker omits an empty required field, e.g. `Sysctls`, `Annotations` or `Init`, preflight refuses until the format is reviewed) |
| Engine target checks against a fake filesystem; engine argv always carries the pinned `--host`/`--config` | The real socket, its group, and that the Docker CLI honours `--host`/`--config` over contexts on the target version |
| Canary evaluation refuses every failing, missing or ambiguous observation; gVisor evidence logic (host kernel, unrecorded or mismatched reference refuse) | gVisor's real `/proc/version`, `/proc`, cgroup, seccomp-mode and errno behaviour (strict rules may refuse; changes need approval) |
| Preflight ordering, binding, id/name consistency, cleanup verification, refusal on every error/timeout; daemon seccomp profile must be reported as `builtin`; `--pull never` always present | The **contents** of the built-in seccomp profile (trusted as part of the Docker binary, not inspected); whether runsc applies it (`Seccomp: 2` is required, which may need runsc's OCI seccomp support); authz plugins; `start --attach` exit codes with `--log-driver none` |
| Real process runner: timeout kills the whole process group, output cap, signal exit, minimal environment | Behaviour of the real engine CLI under these limits |

**Not established in the current cloud session:** root user, unknown host,
no `runsc`, no `podman`, no pinned image, no recorded gVisor reference.
Nothing can be rated `meets-spec`, and the M1/M3 blockers would refuse even
on a fully configured host.

## Target host requirements (to verify before S3)
- Dedicated machine/VM you control; `/srv/research-runs` owned by root or the operator, mode 755 or stricter; no secrets anywhere under it.
- Docker Engine with gVisor (`runsc`) registered; versions recorded; daemon reports `name=seccomp,profile=builtin`.
- Approved host setup step: record gVisor's `/proc/version` on this host as `gvisorProcVersion` (it must differ from the host kernel's).
- Operator-prepared empty Docker client config folder (outside the runs root, mode 700), passed to the engine adapter.
- Before `meets-spec`: host-side runtime verification (M1) implemented and reviewed; Docker version and seccomp trust decision (M3) recorded.
- Docker server version pin (fail closed, recorded at host setup) implemented with fake-host tests; the canary-probe Dockerfile is prepared but not built (`deploy/research-sandbox/`).
- cgroup v2; engine CLI at an allowlisted absolute path.
- Approved one-time pull of the pinned base image; digest, entrypoint, image environment and platform manifest digest recorded in the spec.
- Approved host setup step: record the Docker data root (`docker info` DockerRootDir, confirmed on the host) as `dockerDataRoot`.
- Approved host setup step: record the runsc binary (path and SHA-256 computed on the host; runtime args must be empty and the daemon must configure none) as `runscBinary`.
