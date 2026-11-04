# V2 milestone: sandbox infrastructure preflight verified on the host

**Status: VERIFIED on this host (2026-11-04).** The M1 and M3 blockers
(`MEETS_SPEC_BLOCKERS`) remain active, so the result is still `refused`.
Nothing here allows untrusted input. No code path runs untrusted input in
the sandbox yet (nothing calls `assertUntrustedInputAllowed`). Automaton,
agents, paid APIs, research processing and trading were not started.

## Result

| Item | Value |
|---|---|
| Commit | `cf8e5f12e8ea13578ad7104ac7666decc253a572` (V2.4.2) |
| Command | `sudo bash deploy/research-sandbox/host-setup.sh --execute --expect-base-digest=sha256:dd9d2197...7d94` |
| Result | `RESULT: every preflight check passed on this host; refused only by the M1/M3 blockers (as expected).` |
| Evidence | `/var/lib/research-sandbox-setup/setup-20261104-224933-363690104/` (on the host; not copied here) |
| Host | IONOS VPS, Ubuntu 24.04, KVM, 2 vCPU, 4 GB |
| Engine | Docker 29.9.3, containerd image store (overlayfs snapshotter) |
| Runtime | gVisor runsc release-20261102.0 (apt), registered as `{"path": "/usr/bin/runsc", "runtimeArgs": ["--oci-seccomp"]}` |
| Base image | `node:22.22.0-bookworm-slim`, index digest `sha256:dd9d2197...7d94` |

## What the passing run verified (daemon- and canary-reported)

- Engine target, rootful Docker, server version pin, seccomp profile
  `builtin`, data root pin.
- runsc binary, every gVisor sidecar file and `/etc/containerd/runsc.toml`
  by SHA-256 (plus `dpkg --verify runsc`), before create and after the
  canary; the runtime configuration re-read after create and after the canary.
- The canary container's full inspect allowlist (Docker 29 format, V2.2),
  `--init=false`, image ID and manifest descriptor, host-file paths and
  files (after the start), verified removal.
- Canary observations inside gVisor: uid/gid 10001, no capabilities,
  no_new_privs, **seccomp mode 2** (with `--oci-seccomp`), loopback only,
  no routes, failed outbound attempt, exact environment (image env, ours,
  HOSTNAME, HOME=/, PWD=/app), read-only root and input (EROFS, or EACCES
  with the mount's `ro` flag), writable output and /tmp, no sockets, host
  canary not readable, `/etc` files read-only, rlimits, cgroup v1 memory
  limit at most 512 MiB.
- gVisor positively identified by its `/proc/version` fingerprint (differs
  from the host, equals the recorded reference).

## Fixes needed to reach this result

V2.2 (Docker 29 inspect format), V2.3 (canary probe entry point), V2.4
(gVisor evidence and `--oci-seccomp`), V2.4.1 (`enable-oci-seccomp.sh`
hardening), V2.4.2 (`PWD` from the image's entrypoint shell).

## Residual limits (why M1 and M3 still block)

- Everything above is reported by the daemon, the runtime or the canary
  running under them; a dishonest root-level daemon or runtime could lie.
- The gVisor fingerprint is trust-on-first-use, not a cryptographic proof.
- Checks and use are separated in time (re-checks narrow, not close, the gap).
- The pids limit (64) is enforced by runsc on the sandbox's host cgroup
  and is not observable inside gVisor (V2.4).
- No written trust decision yet on the Docker 29.9.3 build and its built-in
  seccomp profile (M3).
