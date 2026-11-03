# V1: VPS deployment plan and security preparation

Status: **planning baseline only. Nothing has been bought, installed or
deployed.** Every stage below needs its own approval. The sandbox blockers
**M1 and M3** (`MEETS_SPEC_BLOCKERS` in `src/research-sandbox/preflight.ts`)
stay active. They are unrelated to the spend and routing items called M1-M3
in `SECURITY-REVIEW.md` section 9b.

## 1. Decided host (U1)

Use a dedicated **KVM** virtual machine running **Ubuntu 24.04 LTS**, with
**2 vCPU, 4 GB RAM and at least 40 GB of disk**, located in the UK or nearby
Europe. Don't buy it yet.

Don't rely on a provider's advertised virtualisation support: Stage 2 checks
it.

| Requirement | Why (repository source) |
|---|---|
| A full VM, not OpenVZ, LXC or a container VPS | The spec needs its own kernel, cgroups and Docker daemon |
| cgroup v2 | `--cgroupns private`; the canary reads `memory.max` and `pids.max` |
| AppArmor or nothing; **no SELinux** | Inspect accepts `docker-default` or no profile. SELinux labels refuse |
| Only you have root | D1: host trust is attested by the operator only |

## 2. Docker Engine and gVisor requirements

- **Docker:** rootful Docker Engine from Docker's own apt repository. Rootless
  Docker is not meets-spec, and Podman is refused.
  - The CLI must be at `/usr/bin/docker` (allowlisted path).
  - The socket must be `/var/run/docker.sock`, root-owned and not
    world-writable.
- **seccomp:** `docker info` must report `name=seccomp,profile=builtin`. Don't
  set a custom seccomp profile or any `runtimeArgs`.
- **Version pin:** record the daemon's `ServerVersion` as
  `dockerServerVersion`, then `apt-mark hold` the Docker packages. Any other
  version refuses.
- **gVisor binary:** `runsc` must be a root-owned, non-setuid regular file
  in `/usr/bin` or `/usr/local/bin`, not writable by group or others. Every
  directory above it must be root-owned with no symlinks.
- **gVisor registration:** classic form only,
  `"runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}`, with **no**
  `runtimeArgs`, `runtimeType` or options. Check `daemon.json` by hand after
  any install helper runs.
- **Unverified until tested on the host:** gVisor's seccomp compatibility.
  - The canary requires `Seccomp: 2` in `/proc/self/status` inside the
    container.
  - Whether runsc applies the daemon's built-in profile, and how gVisor
    reports it, is **unknown**.
  - If the check fails, that is a finding to review, never a reason to
    relax the check.
  - M3 can't be resolved before this is tested.

## 3. Host checks for M1 and M3

Record each value at an approved host-setup step. Each one becomes a pin in
the runner configuration.

| Pin | How it is obtained (approved step) |
|---|---|
| `dockerServerVersion` | `docker info` -> `ServerVersion` |
| `dockerDataRoot` | `docker info` -> `DockerRootDir` |
| `runscBinary` | Path, plus the SHA-256 computed on the host; `args: []` |
| `imageDigest`, `imageEntrypoint`, `imageEnv`, `imageManifestDigest` | Recorded at the one approved base-image pull (`imageManifestDigest` may be `null` on a classic image store; see the manifest conflict in section 7) |
| `imageId` | The full ID (`sha256:<64 hex>`) of the locally built canary image, recorded at the approved build (section 7) |
| `gvisorProcVersion` | `/proc/version` inside one container started under `runsc` from the pinned image. It must differ from the host's. This is a trust-on-first-use fingerprint and needs its own approval (one Docker run) |

Then run the V1A preflight runner (section 6).

**Expected result:** `REFUSED`, with "Every check passed; refused only
because of the M1/M3 blockers".

**What would remove the blockers:**
- **M1:** review the real host evidence, and decide whether to accept the
  documented residual limits: the timing gap between checks, and a daemon
  that reports one thing and runs another.
- **M3:** record a written trust decision on the pinned Docker build and its
  built-in seccomp profile, after the gVisor seccomp test above.

Either removal is a reviewed code change.

## 4. Isolation, permissions, network and limits

These are already enforced by `spec.ts` and the preflight.

- **Image:** `--pull never` and digest pinning.
- **Identity:** uid 10001, `--cap-drop ALL`, `no-new-privileges`.
- **Filesystem:**
  - read-only root, and a 64 MiB tmpfs `/tmp` (noexec);
  - `/srv/research-runs` owned by root, mode 755;
  - per run, `in/` not writable by group or others, and `out/` owned by
    10001, mode 0700, empty;
  - an empty Docker client config folder, mode 0700, outside the runs root.
- **Network:** `--network none`. On the host, `ufw` denies all inbound
  traffic except key-only SSH, and no ports are published.
- **Limits:** 512 MiB memory with no swap, 0.5 CPU, 64 pids, ulimits fsize
  50 MiB / nofile 256 / core 0.

## 5. Staged sequence (stop at any failure)

| Stage | Action (each needs approval) | Stop if |
|---|---|---|
| 0 | Buy the VM, add your SSH key, log in | No KVM VM is offered, or there is no web console |
| 1 | Create a non-root sudo user, use SSH keys only, enable `ufw` and unattended-upgrades | You lose console access |
| 2 | Read-only checks: `systemd-detect-virt` (must be `kvm` or similar, not `lxc` or `openvz`), `uname -r`, `stat -fc %T /sys/fs/cgroup` (must be `cgroup2fs`), AppArmor on, SELinux absent | Any mismatch |
| 3 | Install Docker (download) and hold the version | Rootless, no builtin seccomp, wrong socket or CLI path, or cgroup v1 |
| 4 | Install runsc (download, verify checksum) and register it without args | Checksum or ownership mismatch, or args present |
| 5 | Pull the base image once and record the pins; record `gvisorProcVersion` (one Docker run) | Any pin that can't be recorded exactly |
| 6 | Build the canary image and record its `imageId` (section 7) | The ID can't be recorded exactly, its entrypoint or environment differ from the base pins, or the manifest conflict (section 7) is unresolved on this host |
| 7 | Run the V1A runner | Any result other than "refused only by M1/M3" |
| 8 | Review the evidence; decide on M1 and M3 | Any doubt: the blockers stay |

## 6. V1A preflight runner (operator-invoked)

Build with `./node_modules/.bin/tsc`, then run as the operator on the
approved host only:

```bash
node dist/research-sandbox/preflight-main.js --config /etc/research-sandbox/preflight.json --confirm-docker-access [--output text|json]
```

- `--confirm-docker-access` is required. The run contacts the local Docker
  daemon, creates **one** canary container from the pinned image with
  `--pull never`, runs the probe and removes the container, then verifies
  the removal. It never downloads anything.
- There is no override or skip option. Unknown arguments are refused.
- **Configuration file:** an absolute path; a regular file (not a symlink)
  owned by root or the operator, not writable by group or others, at most
  64 KiB of UTF-8; its folder must also be safe. Every field is required,
  unknown fields and duplicate keys are refused, and pins are validated by
  the existing `resolveSpec`:

```json
{
  "version": 1,
  "engineBinary": "/usr/bin/docker",
  "engineConfigDir": "/root/research-docker-config",
  "runId": "canary-001",
  "hostCanaryPath": "/srv/research-canary/host-canary.txt",
  "operatorUid": 1000,
  "outputOwnerUid": 10001,
  "pins": {
    "imageDigest": "sha256:<recorded>",
    "imageEntrypoint": ["<recorded>"],
    "imageEnv": ["PATH=<recorded>", "NODE_VERSION=<recorded>", "YARN_VERSION=<recorded>"],
    "imageManifestDigest": "sha256:<recorded> or null",
    "imageId": "sha256:<recorded at the canary build>",
    "gvisorProcVersion": "<recorded>",
    "dockerDataRoot": "/var/lib/docker",
    "runscBinary": { "path": "/usr/local/bin/runsc", "sha256": "<recorded>", "args": [] },
    "dockerServerVersion": "<recorded>"
  }
}
```

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | meets-spec. **Unreachable while M1/M3 exist.** If a result ever claimed it, the runner reports an internal inconsistency instead |
| 1 | Refused or development-only. Neither allows untrusted input |
| 2 | Usage or configuration error. No engine call was made |
| 3 | Internal error. The message names the canary container to check for manual cleanup |

**Host prerequisites before the first run:**
- Stages 1-5 are complete.
- `/srv/research-runs/<runId>/in` and `/out` are prepared as in section 4.
- A host canary file exists outside the runs root.
- The empty client config folder exists.
- The canary image exists (Stage 6).

## 7. Canary image pinning by image ID (U4 Option A, V1B)

**How it works:**
- A locally built image has an image ID but no repository digest, so the
  canary image is pinned by its recorded **image ID** (`imageId`,
  `sha256:<64 hex>`). No registry service is needed.
- `imageReference()` returns that ID, and only once the base digest, the
  entrypoint **and** the ID are all recorded. The ID must not equal the base
  digest.
- The engine's create guard accepts only a full image ID. Tags, short IDs and
  repository references are refused, and `--pull never` is still required.
- Inspect requires both the requested reference (`Config.Image`) **and** the
  image the created container actually uses (top-level `Image`) to equal the
  recorded ID. A substituted image is refused before the container is
  started, and the container is then removed.

**Unchanged:**
- The base `imageDigest`, `imageEntrypoint`, `imageEnv` and
  `imageManifestDigest` pins are all still required.
- The canary Dockerfile adds no `ENTRYPOINT` or `ENV`, so the canary image
  keeps the base values the inspect checks require.
- The base digest is now **provenance**: it is enforced by the build's
  `FROM ...@digest`, and the preflight doesn't observe it at run time (the
  container's image is the canary image, not the base).

**Future recording procedure.** Each step needs separate approval and Docker
socket access on the host.

1. Prepare the build context described in `deploy/research-sandbox/README.md`
   and record the SHA-256 of its three files.
2. Build with `--pull=false` and
   `--build-arg NODE_BASE_DIGEST=<recorded base digest>`, writing the ID to a
   file with `--iidfile`. Don't tag the image.
3. Record the file's contents as `imageId`. Check it with
   `docker image inspect --format '{{.Id}}' <imageId>`.
4. Confirm that the image's `Config.Entrypoint` and `Config.Env` equal the
   recorded base pins.
5. Put `imageId` in the runner configuration (section 6).

**Manifest-digest conflict (reported, not bypassed):**
- On Docker's **containerd image store**, a container reports an
  `ImageManifestDescriptor` for its **own** image. For the canary that is the
  canary's manifest, not the base image's manifest recorded at the pull, so
  every preflight there would refuse. That is fail-closed, and the check has
  not been changed.
- The options need a decision and must be verified on the host:
  - (a) use the classic image store, which reports no descriptor;
  - (b) a separately approved change that records the canary image's own
    manifest digest (taken at the build) as the value compared.
- Neither is chosen here. Which store the pinned Docker version uses by
  default, and exactly what it reports, are unverified offline.

**Limitations (unverified offline):**
- Docker is assumed to accept `docker create sha256:<id>` as an image ID and
  never as a repository name.
- Container inspect is assumed to report the resolved ID in the top-level
  `Image` field on both stores.
- An image ID identifies content only. The canary's provenance rests on the
  reviewed Dockerfile, the pinned base digest and the recorded file hashes.

## 8. Preventing the agent, wallet, spending or trading from starting

- Don't build `deploy/Dockerfile`, don't run `docker compose up`, and never
  run `node dist/index.js --run`, `--setup`, `--init`, `--provision` or the
  README's `curl ... | sh`.
- Put no API keys, `automaton.json` or wallet on the host. Safe mode is on
  by default and never creates a wallet, but don't rely on that alone.
- Run the research CLI as a user that is **not** in the `docker` group;
  that group is effectively root. Only the preflight runner, invoked
  deliberately, uses the socket.

## 9. Operations needing separate approval

- Each download and install (Docker, runsc, packages).
- **Any** access to the Docker socket, including `docker info`, the runner,
  and the `gvisorProcVersion` recording run.
- The base-image pull and the recording of each pin.
- The canary image build.
- Each trust decision: the runsc checksum source, the Docker version and
  seccomp (M3), and M1's residual limits.
- Each code change: the manifest-conflict option (section 7), and removing either blocker.
- Paid snapshots.
- Any destructive rollback (section 10).
- Any real-world research or data, and anything to do with the agent, keys,
  a wallet or trading.

## 10. Rollback and recovery

- Snapshot after Stage 1, and before Stages 3 and 4, if snapshots are
  affordable. Taking one is a paid action and needs approval.
- **Destructive rollback needs separate, explicit approval every time,**
  even when the plan describes it. That covers:
  - removing the runsc entry from `daemon.json`, deleting `runsc` and
    restarting Docker;
  - purging Docker and deleting `/var/lib/docker`, which destroys every
    image and container;
  - restoring a snapshot, which loses everything since it was taken;
  - destroying and rebuilding the VM.

  Before approving, check what will be lost.
- Non-destructive recovery is always available: use the provider's web
  console, replace your SSH key, and stop Docker
  (`systemctl stop docker docker.socket`).
- No secrets or funds are kept on the host, so rebuilding it is safe once
  approved.

## 11. Your checklist (when approved)

1. Choose a provider offering a KVM VM with Ubuntu 24.04 in the UK or nearby
   Europe, with a web console (and optional snapshots). Avoid container,
   OpenVZ or LXC plans.
2. Pick 2 vCPU / 4 GB / 40 GB or more. Set a billing alert, and use no
   auto-billed add-ons.
3. Create an SSH key in Termius. Add only the public key. Keep the console
   password in a password manager.
4. Log in once, then send me the output of `uname -a` and
   `systemd-detect-virt`. Install nothing until Stage 1 is approved.
