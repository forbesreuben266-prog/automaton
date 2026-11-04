# V1B host compatibility evidence (IONOS UK VPS)

Status: **evidence for review, not deployment approval.** The sandbox
blockers M1 and M3 (`MEETS_SPEC_BLOCKERS`) remain active. Automaton was not
installed or run, the repository's preflight runner was not run, and no
research, agent, trading or paid API was involved.

Source: the operator's report of an initial manual test on 2026-11-04. These
are operator-reported observations; no command output or files were
supplied with them.

## 1. Reported results

| Item | Reported |
|---|---|
| Host | IONOS UK, KVM virtualisation, Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, about 120 GB disk |
| Kernel | cgroups v2; seccomp and seccomp filtering supported; AppArmor enabled; unprivileged user namespaces enabled with AppArmor restrictions; OverlayFS available |
| Host hardening | SSH hardened; UFW enabled |
| Docker | Engine 29.9.3; storage reported as "overlayfs"; AppArmor and seccomp listed among its security options |
| gVisor | `runsc` release-20261102.0 (OCI spec 1.2.1), registered with Docker at `/usr/bin/runsc`; the default runtime stays `runc` |
| Network exposure | No Docker TCP listener detected |
| Test | `docker run --rm --runtime=runsc --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=64 --memory=128m --cpus=0.5 alpine:3.20 /bin/echo "gVisor test passed"` printed `gVisor test passed` |
| Cleanup | `docker ps -a` afterwards showed no containers |

## 2. What this establishes

- On this host, with AppArmor enabled and the Ubuntu 24.04 user-namespace
  restriction reported as active, Docker 29.9.3 with the runtime named
  `runsc` can create, start and remove a container using hardened flags:
  no network, a read-only root filesystem, all capabilities dropped,
  `no-new-privileges`, and pids, memory and CPU limits.
- The AppArmor user-namespace restriction did not prevent that container
  from running.
- Docker did not expose a TCP API.

## 3. What remains unverified

| Gap | Why it matters | Repository rule it affects |
|---|---|---|
| gVisor not **positively identified** | A runtime *named* `runsc` proves nothing. The echo test would also succeed under runc. No `/proc/version` comparison was made | gVisor evidence (`gvisorProcVersion`); M1 |
| Exact runtime configuration | It's unknown whether the apt package's automatic configuration added `runtimeArgs`, `runtimeType` or options | `runtimeConfigProblems`; spec requires `args: []` |
| Binary identity | No SHA-256 of `/usr/bin/runsc`, and no inventory or hashes of the new `gvisor-bin/` sidecar binaries | `runscBinary` pin; **M1 gap**: the repository verifies only `runsc` |
| Seccomp profile value | "seccomp listed" isn't the same as `name=seccomp,profile=builtin` | Preflight requires `builtin`; M3 |
| `Seccomp: 2` under gVisor | Untested | Canary requirement; M3 |
| Image store type | "overlayfs" most likely means the **containerd image store** (Docker 29+ fresh-install default; its snapshotter is `overlayfs`, whereas the classic driver is named `overlay2`). Not confirmed by `DriverStatus` | Manifest-descriptor check (section 4) |
| Sandbox identity and isolation | Uid 10001, `/proc/net` interfaces and routes, read-only mount errors, cgroup limits and socket scans weren't observed | Canary checks |
| Socket permissions, CLI path, version hold, UFW unchanged | Not reported | Engine-target checks; version pin |
| Image pinning | `alpine:3.20` was used by mutable tag | V1B requires an image ID; a test-only use is acceptable |
| The repository preflight | Never run, and can't run until every pin is recorded | Everything above |

## 4. Canary manifest digest decision (reassessed)

The compatibility test does **not** resolve this decision.

**What the evidence changes.** If the host uses the containerd image store,
as "overlayfs" strongly suggests:
- container inspect will report an `ImageManifestDescriptor` for the
  container's **own** image;
- for the locally built canary, that is the canary's manifest, which can
  never equal the base image's manifest digest recorded at the pull;
- so with today's code, every preflight on this host would refuse at
  inspect. That is fail-closed and correct, and it makes the decision
  **necessary**, not optional.

**Option B (preferred in principle): record the canary's own manifest digest.**

Open questions, each answerable only on the host by approved read-only
inspection after an approved canary build:
1. For a locally built image on the containerd store, what do
   `docker image inspect` (`Id`, `Descriptor`) and container inspect
   (`ImageManifestDescriptor`) report? Is the descriptor digest the image ID
   (manifest) or a separate platform manifest inside an index?
2. Is it stable? It must be the same on every inspect of the same image.
   Rebuilds aren't expected to match, because builds aren't bit-reproducible
   by default (timestamps). That's acceptable, since each approved build is
   recorded once.
3. Does BuildKit's default provenance or SBOM attestation turn the result
   into an image index? Building with `--provenance=false --sbom=false` is
   expected to produce a single manifest, which is simpler to bind (to be
   confirmed).

**Trust:** the descriptor is the daemon's own report, the same trust
boundary as every other inspect field (D1 and M3). It binds the exact local
artifact, not its provenance; provenance stays with the base digest, the
reviewed Dockerfile and the recorded file hashes.

**Likely implementation shape (not authorised):**
- add a separate `canaryManifestDigest` pin, recorded at the build;
- compare the descriptor with it;
- keep the base `imageManifestDigest` as recorded provenance;
- refuse whenever a descriptor is reported but the pin isn't recorded,
  which is today's rule.

No existing check is relaxed.

**Fallback if Option B can't be established reliably:**
- Option A': run Docker on the classic store
  (`"features": {"containerd-snapshotter": false}` in `daemon.json`), where
  no descriptor is reported. This changes daemon configuration and data
  location, so it needs approval.
- Otherwise, keep refusing. Both are fail-closed.

## 5. Next safest verification milestone (proposed)

**V1C: read-only host evidence capture.** It needs no new downloads, builds
or configuration changes. It requires approved `sudo docker` access to the
socket on the VPS.

It reuses the already-pulled `alpine:3.20`, referenced by its image ID with
`--pull never`, to collect:
- the exact `docker info` fields (`SecurityOptions`, `Runtimes`,
  `DriverStatus`, `DockerRootDir`, `ServerVersion`);
- `/etc/docker/daemon.json`;
- socket and CLI paths;
- the `dpkg -L runsc` inventory, with SHA-256 of each file;
- `/proc/version` on the host and under runc and runsc;
- `/proc/self/status` (uid, capabilities, `NoNewPrivs`, `Seccomp`);
- network interfaces, and cgroup `memory.max` / `pids.max` under runsc;
- the image's `Id`, `Descriptor` and `RepoDigests`, plus container
  `ImageManifestDescriptor` output for a pulled image (informs Option B);
- UFW status compared with the baseline.

The output decides whether gVisor is positively identified, whether the
runtime configuration matches the spec, and which image store is in use.

The steps after it, each separately approved:
- **V1D:** an approved canary image build (`--pull=false`, base digest,
  `--iidfile`, no attestations) and inspection to answer the Option B
  questions;
- an offline code milestone to extend M1 binary verification to gVisor's
  sidecar binaries;
- only then an Option B code change, and later a preflight-runner run.
