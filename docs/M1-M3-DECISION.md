# M1/M3 decision record

**Status: ACCEPTED by the repository owner on 2026-11-05, for the owner's
current IONOS VPS only. Host pins recorded on 2026-11-06.**

This record lifts the M1 and M3 blockers
(`MEETS_SPEC_BLOCKERS` in `src/research-sandbox/preflight.ts`) **only** for
the exact configuration in `ACCEPTED_DECISION_SCOPE` (`decision-scope.ts`).
Every other configuration is still refused by M1/M3.
`src/__tests__/research-sandbox/blocker-governance.test.ts` checks this
record: its fields, the Scope lines (which must equal the code), and that
each piece of cited evidence is committed, has the cited SHA-256 and shows a
pass.

Lifting the blockers does not run research by itself. Each executor run,
starting with one synthetic-only validation, needs the owner's separate
explicit approval. No agents, paid APIs, real-world data, wallets or trading
are covered by this decision.

## Owner's acceptance (verbatim)

> I explicitly ACCEPT D1–D8, including all documented residual security
> risks, for my current IONOS VPS only.
> This includes trusting the host and hosting provider, Docker 29.9.3, the
> gVisor release signing key and pinned runsc version, the limitations of
> package integrity verification, the gVisor fingerprint, the
> preflight-to-execution timing gap, host-side PID enforcement, and the
> absence of AppArmor enforcement inside gVisor.

Before that, on the same day, the owner provisionally agreed to D1-D3 and
D5-D8, and ran the read-only host-security check prepared for D4.

## D4 host-security check (operator-reported, 2026-11-05)

The owner ran the read-only check on the VPS and reviewed the output in
Termius. The results below are **operator-reported** from the owner's
screenshots: the reviewer of this record did not see the raw output, and
nothing here is independently verified. They describe the host at that
moment only. They do not show that the host cannot be compromised, and a
compromised root could falsify them.

| Item | Reported result |
|---|---|
| `PermitRootLogin` | `no` |
| `PasswordAuthentication` | `no` |
| `KbdInteractiveAuthentication` | `no` |
| `PubkeyAuthentication` | `yes` |
| `sudo` group | only `automatonadmin` |
| Firewall (UFW) | active; only SSH permitted |
| Docker containers | 0 |
| Automatic security updates | enabled |
| Authorized SSH keys | 3 entries for `root`, 3 for `automatonadmin` |

The owner believes they are the only person with access. **Who holds each of
the six authorized keys was not independently verified.**

Not reported, so not relied on: the full list of listening services, the
`docker` group membership, accounts with a usable password, sudoers rules,
cron jobs and fail2ban.

## The eight decisions (each ACCEPTED)

The acceptance sentences below are the ones prepared in
`docs/M1-M3-DECISION-DRAFT.md` (section 5); the owner's statement above
accepts all eight.

| | Blocker | Accepted |
|---|---|---|
| D1 | M3 | "I accept trust in Docker Engine 29.9.3 from Docker's signed apt repository and in its built-in seccomp profile, for this host only, until the pinned version changes." |
| D2 | M3 | "I accept `6F1DF85E3A71C24918E727D56FC6D554E32BD943` as the gVisor release signing key and trust gVisor runsc release-20261102.0 installed from that repository." |
| D3 | M3 | "I accept that package integrity is shown by apt's download-time signature checks and `dpkg --verify` against the local package database, which a host root user could alter." |
| D4 | M1 | "I accept that the host's root account, Docker daemon and runtime are trusted, and that their reports (including /proc) could be falsified by a compromised root." Extended by the owner to the hosting provider; informed by the operator-reported host-security check above. |
| D5 | M1 | "I accept the gVisor /proc/version fingerprint recorded at setup as a trust-on-first-use identification, not a cryptographic proof." |
| D6 | M1 | "I accept that a change made between the preflight's checks and a later run cannot be fully excluded; re-checks narrow but do not close the gap." |
| D7 | M1 | "I accept that the pids limit of 64 is enforced on the sandbox's host cgroup and is not observable inside gVisor." |
| D8 | M1 | "I accept that gVisor does not apply AppArmor, so containment relies on gVisor, seccomp (inside with --oci-seccomp, and the Sentry's own filters), namespaces and cgroups." |

## Scope (enforced in code)

The scope is `ACCEPTED_DECISION_SCOPE` in `src/research-sandbox/decision-scope.ts`.
The preflight rating, the runner, the negative-control baseline and the
`assertUntrustedInputAllowed` gate apply M1/M3 to any configuration that
differs in **any** item:

| Item | Accepted value | Source |
|---|---|---|
| Docker server version: the pin and the daemon's report | `29.9.3` | E1b preflight and trust evidence |
| Engine | rootful Docker | E1b preflight |
| Daemon seccomp profile: the pin and the report | `builtin` | E1b preflight |
| Daemon runtimes (exact set) | `io.containerd.runc.v2`, `runc`, `runsc` | E1b preflight |
| Daemon's runsc configuration | `{ path: /usr/bin/runsc, runtimeArgs: ["--oci-seccomp"] }`, plus an optional `status` | E1b trust evidence |
| Runtime chosen | `runsc` | E1b preflight |
| runsc binary pin: path and arguments | `/usr/bin/runsc`, `["--oci-seccomp"]` | E1b trust evidence |
| Docker data root pin | `/var/lib/docker` | E1b trust evidence (`DockerRootDir`) |
| Research image ID pin | `sha256:3e8a7371ba841599f91a259089fd4bad1e0e5e0bda7feba0518a555b5e6d46c5` | E1b executor dry run |
| runsc SHA-256 pin | `c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098` | VPS runner configuration (read-only check, 2026-11-06) |
| runsc sidecar pins (exact set, path and SHA-256) | 8 files, listed below | VPS runner configuration (read-only check, 2026-11-06) |
| | `/usr/bin/gvisor-bin/checkpointgofer` `37e6e92d6dcb3296e10dc2f21b0ef6156f1373ff0668d27a4fccc8ded2b51f94` | |
| | `/usr/bin/gvisor-bin/gvisor-proc-umounter` `b3bbbaef5ddc62084e5febd19d3acca14f3d42b2a25d8552fb40def699467019` | |
| | `/usr/bin/gvisor-bin/gvisor-sentry-prewarmer` `046e3ec1de3aa7b7ec7ce53b4f0d1e08db15987847606a8e361133d5c5bd3d73` | |
| | `/usr/bin/gvisor-bin/gvisor_sentry` `6dfd3af65e664663f332d0e4b9fb82452496e34ebc6cb568ae49f5b1ac9d8166` | |
| | `/usr/bin/gvisor-bin/runsc-fd-parking` `03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11` | |
| | `/usr/bin/gvisor-bin/runsc-metric-server` `b9857ebe290c403fda7ff014368df3a0f45e5428dc1eb6efe413cfe0e5a940f4` | |
| | `/usr/bin/containerd-shim-runsc-v1` `6187d6d34f4996e859353fbb4c56d5ed41fc35b5afa44bff766f4e4b424da5bb` | |
| | `/etc/containerd/runsc.toml` `ea5ada6422655b972fd3af73f7a23b88cc3385c98767cca2f360b2aa749d114c` | |
| gVisor `/proc/version` reference pin | `Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016` | VPS runner configuration (read-only check, 2026-11-06) |

**Host pins (2026-11-06):** the owner ran a fail-closed, read-only check on
the VPS and reported `RESULT: ALL CHECKS PASSED (unchanged since E1b)`. The
check confirmed five things:
1. The runner configuration is byte-identical to the copy saved by the E1b
   setup run (located by the committed preflight report's hash).
2. Every pin is present and well-formed. The gVisor reference differs from
   the host's own kernel string.
3. The runsc binary and all 8 sidecars on disk match their pins, and are
   root-owned and not writable by group or others.
4. The research image exists with the pinned ID.
5. A fresh trust-evidence report has a valid digest, 0 blocking findings and
   1 review finding (the gVisor key, D2). Its `daemon.json` hash, dockerd
   arguments, drop-ins, package versions, `dpkg --verify` results, daemon
   security options, data root and apt keyring hashes all equal the E1b
   values.

These results are operator-reported: the owner pasted the pin and on-disk
hash lines, which are copied above exactly.

Each preflight still checks every pin against the host: the binary and
sidecar hashes before create and after the canary, the daemon-reported
runtime configuration, and the image, folders and host files. The negative
controls showed that a changed pin is refused.

**Limits of the scope:**
- **This is configuration binding, not host identification.** The code
  cannot identify the VPS. A different machine set up with byte-identical
  binaries, configuration and image would match. The decision is limited to
  this VPS by the owner's statement and by the root-only runner
  configuration that exists only there. No host identifier is used: the SSH
  host key or machine ID would be weak (a cloned snapshot shares them, and
  root can change them), and publishing them could help locate the server.
- **Daemon settings outside `docker info` and the container inspect are not
  enforced at run time.** This covers `daemon.json` contents beyond the
  runtimes, dockerd flags and drop-ins, and package versions. The read-only
  trust-evidence tool records them, and the E1b values are in the committed
  evidence.
- Any upgrade of Docker or runsc, a rebuilt image or a re-run of
  `host-setup.sh` changes a pin, which puts the configuration out of scope
  until the owner re-reviews it.

## Evidence (E1b, 2026-11-05)

The evidence was produced on the VPS by commit
`f3d5057b9c8fa6263d7bba7794e26a0a6eaa57cf`. It was committed unaltered at
`8e91aebebc3bd4d40a98865535eab01afe273696`, and verified offline: the 15
transfer pieces matched their checksums, every file matched its VPS
SHA-256, the trust-evidence digest verified, 47 content checks passed and a
sensitive-data scan was clean.

| File | SHA-256 | Shows |
|---|---|---|
| `docs/evidence/e1b-preflight-report.json` | `f9640ccea26832e65a008333b267c35bfca0fcd7398019593620350370ff8225` | every check passed and the preflight was refused only by M1/M3, under runsc with Docker 29.9.3 and the built-in seccomp profile; gVisor host-process evidence: 2 sandbox processes, no canary on the host, no replaced executable, no overflow, 86 samples; cleanup verified |
| `docs/evidence/e1b-negative-controls.json` | `d48ee65686ac5383b743114a59049d871816b1584568fdbb3ba887d4bac82cbf` | all 8 controls behaved as expected: baseline, Docker version, runsc hash, sidecar hash, image ID, canary manifest digest, gVisor fingerprint, runc instead of gVisor |
| `docs/evidence/e1b-trust-evidence.json` | `9ecc6ca25b6ba2df2a981bbbb854b65af11cdcc713646b65c71a95222564764f` | needs-review, 0 blocking, 1 review finding (the gVisor key, reviewed under D2) |
| `docs/evidence/e1b-executor-dryrun.json` | `cdd73765295e266647119320e2e471645adae395a70986a04529e38623689dc0` | the executor refused the synthetic sample job at the M1/M3 gate before any research container was created |

**Reviewed versions:**
- Docker Engine and CLI `5:29.9.3-1~ubuntu.24.04~noble`, containerd.io
  `2.4.2-3~ubuntu.24.04~noble` (runc 1.5.2), runsc `20261102.0`. Each
  `dpkg --verify` was clean, and each package was offered by its HTTPS
  repository.
- Keys: Docker `9DC858229FC7DD38854AE2D88D81803C0EBFCD88`; gVisor
  `6F1DF85E3A71C24918E727D56FC6D554E32BD943`, verified offline against three
  sources (draft, section 3).
- dockerd runs with `-H fd:// --containerd=...`, with no drop-ins.
  `daemon.json` holds only the runsc runtime, with `["--oci-seccomp"]`.
- Research image: `sha256:3e8a7371ba841599f91a259089fd4bad1e0e5e0bda7feba0518a555b5e6d46c5`.

## M1
Decision: ACCEPTED
Approved-by: forbesreuben266-prog (repository owner)
Date: 2026-11-05
Commit-reviewed: f3d5057b9c8fa6263d7bba7794e26a0a6eaa57cf
Evidence-commit: 8e91aebebc3bd4d40a98865535eab01afe273696
Scope: docker-server-version=29.9.3 seccomp-profile=builtin runtime=runsc runsc-path=/usr/bin/runsc runsc-args=--oci-seccomp daemon-runtimes=io.containerd.runc.v2,runc,runsc docker-data-root=/var/lib/docker image-id=sha256:3e8a7371ba841599f91a259089fd4bad1e0e5e0bda7feba0518a555b5e6d46c5 runsc-sha256=c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098 runsc-sidecars=/usr/bin/gvisor-bin/checkpointgofer@37e6e92d6dcb3296e10dc2f21b0ef6156f1373ff0668d27a4fccc8ded2b51f94,/usr/bin/gvisor-bin/gvisor-proc-umounter@b3bbbaef5ddc62084e5febd19d3acca14f3d42b2a25d8552fb40def699467019,/usr/bin/gvisor-bin/gvisor-sentry-prewarmer@046e3ec1de3aa7b7ec7ce53b4f0d1e08db15987847606a8e361133d5c5bd3d73,/usr/bin/gvisor-bin/gvisor_sentry@6dfd3af65e664663f332d0e4b9fb82452496e34ebc6cb568ae49f5b1ac9d8166,/usr/bin/gvisor-bin/runsc-fd-parking@03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11,/usr/bin/gvisor-bin/runsc-metric-server@b9857ebe290c403fda7ff014368df3a0f45e5428dc1eb6efe413cfe0e5a940f4,/usr/bin/containerd-shim-runsc-v1@6187d6d34f4996e859353fbb4c56d5ed41fc35b5afa44bff766f4e4b424da5bb,/etc/containerd/runsc.toml@ea5ada6422655b972fd3af73f7a23b88cc3385c98767cca2f360b2aa749d114c gvisor-reference-sha256=08e3660897da779368754ef8f7f504a5ac90089d5389114f6ce891df55174561; host: the owner's current IONOS VPS only
Accepted decisions: D4 D5 D6 D7 D8
Evidence:
- sha256:f9640ccea26832e65a008333b267c35bfca0fcd7398019593620350370ff8225 preflight docs/evidence/e1b-preflight-report.json
- sha256:d48ee65686ac5383b743114a59049d871816b1584568fdbb3ba887d4bac82cbf negative-controls docs/evidence/e1b-negative-controls.json
- sha256:f9640ccea26832e65a008333b267c35bfca0fcd7398019593620350370ff8225 host-processes docs/evidence/e1b-preflight-report.json
Residual risks accepted:
- D4: the host's root account, the hosting provider, the Docker daemon and runsc are trusted; a compromised root or provider can falsify every report, including /proc and the host-process evidence.
- D4: the host-security check results are operator-reported (owner's screenshots), not independently verified, and describe one moment only.
- D4: three authorized keys exist for root and three for automatonadmin; root key login is refused only by PermitRootLogin no, and who holds each key was not independently verified.
- D4: listening services, docker group membership, password-enabled accounts, sudoers rules, cron and fail2ban were not reported.
- D5: the gVisor /proc/version fingerprint is trust-on-first-use identification, not a cryptographic proof.
- D6: a change between the preflight's checks and the research run cannot be fully excluded; re-checks narrow the gap but do not close it.
- D7: the pids limit of 64 is enforced on the sandbox's host cgroup only and is not observable inside gVisor.
- D8: gVisor does not apply AppArmor; containment relies on gVisor, seccomp (with --oci-seccomp and the Sentry's own filters), namespaces and cgroups.
- Scope: configuration binding, not host identification; a byte-identical configuration on another machine would match. The decision is limited to this VPS by the owner's statement and the host's root-only runner configuration.
- Scope: daemon settings outside docker info and the container inspect (daemon.json beyond runtimes, dockerd flags, drop-ins, package versions) are not enforced at run time.

## M3
Decision: ACCEPTED
Approved-by: forbesreuben266-prog (repository owner)
Date: 2026-11-05
Commit-reviewed: f3d5057b9c8fa6263d7bba7794e26a0a6eaa57cf
Evidence-commit: 8e91aebebc3bd4d40a98865535eab01afe273696
Scope: docker-server-version=29.9.3 seccomp-profile=builtin runtime=runsc runsc-path=/usr/bin/runsc runsc-args=--oci-seccomp daemon-runtimes=io.containerd.runc.v2,runc,runsc docker-data-root=/var/lib/docker image-id=sha256:3e8a7371ba841599f91a259089fd4bad1e0e5e0bda7feba0518a555b5e6d46c5 runsc-sha256=c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098 runsc-sidecars=/usr/bin/gvisor-bin/checkpointgofer@37e6e92d6dcb3296e10dc2f21b0ef6156f1373ff0668d27a4fccc8ded2b51f94,/usr/bin/gvisor-bin/gvisor-proc-umounter@b3bbbaef5ddc62084e5febd19d3acca14f3d42b2a25d8552fb40def699467019,/usr/bin/gvisor-bin/gvisor-sentry-prewarmer@046e3ec1de3aa7b7ec7ce53b4f0d1e08db15987847606a8e361133d5c5bd3d73,/usr/bin/gvisor-bin/gvisor_sentry@6dfd3af65e664663f332d0e4b9fb82452496e34ebc6cb568ae49f5b1ac9d8166,/usr/bin/gvisor-bin/runsc-fd-parking@03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11,/usr/bin/gvisor-bin/runsc-metric-server@b9857ebe290c403fda7ff014368df3a0f45e5428dc1eb6efe413cfe0e5a940f4,/usr/bin/containerd-shim-runsc-v1@6187d6d34f4996e859353fbb4c56d5ed41fc35b5afa44bff766f4e4b424da5bb,/etc/containerd/runsc.toml@ea5ada6422655b972fd3af73f7a23b88cc3385c98767cca2f360b2aa749d114c gvisor-reference-sha256=08e3660897da779368754ef8f7f504a5ac90089d5389114f6ce891df55174561; host: the owner's current IONOS VPS only
Accepted decisions: D1 D2 D3
Evidence:
- sha256:f9640ccea26832e65a008333b267c35bfca0fcd7398019593620350370ff8225 preflight docs/evidence/e1b-preflight-report.json
- sha256:9ecc6ca25b6ba2df2a981bbbb854b65af11cdcc713646b65c71a95222564764f trust-evidence docs/evidence/e1b-trust-evidence.json
Reviewed findings: 1
Residual risks accepted:
- D1: Docker Engine 29.9.3 from Docker's signed apt repository and its built-in seccomp profile are trusted, for this host only, until the pinned version changes.
- D2: 6F1DF85E3A71C24918E727D56FC6D554E32BD943 is trusted as the gVisor release key, along with runsc release-20261102.0; all three key sources are operated by Google / the gVisor project, so a compromise of gVisor's release infrastructure would not be detected.
- D3: package integrity rests on apt's download-time signature checks and dpkg --verify against the local package database, which a host root user could alter.
- Scope: the runsc version is bound through the recorded runsc and sidecar hashes (from the owner-run read-only check of 2026-11-06, operator-reported); an upgrade of Docker or runsc requires a new review.

## Changes that void this decision

Any of the following requires a new owner decision and a reviewed code change:
- a different host;
- another Docker or runsc version, another runsc or sidecar binary, or other runsc arguments;
- another daemon runtime set, data root or seccomp profile;
- a rebuilt research image or a re-run of `host-setup.sh`;
- a change to `ACCEPTED_DECISION_SCOPE`;
- any change to the evidence files cited above.

Any doubt: the blockers apply.
