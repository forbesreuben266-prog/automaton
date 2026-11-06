# M1/M3 decision record: DRAFT (no decision has been made)

> **Superseded on 2026-11-05 by `docs/M1-M3-DECISION.md`** (D1-D8 accepted
> by the owner, for the current VPS only). This draft is kept unchanged below
> as the prepared basis for that decision.

**Status: PENDING.** Both blockers (`MEETS_SPEC_BLOCKERS`, M1 and M3) remain
active. Nothing in this draft accepts a risk or removes a blocker. Each of
the eight decisions D1-D8 below needs the owner's explicit answer. A valid
decision can only be recorded in `docs/M1-M3-DECISION.md` (format:
`docs/M1-M3-DECISION-TEMPLATE.md`), with the evidence files committed under
`docs/evidence/`. Neither exists yet. Removing a blocker would still be a
separate, reviewed code change, and would not by itself enable research
processing (there is no executor; see `docs/E1-EXECUTOR-PLAN.md`).

## 1. Kinds of statement used here

- **Verified (offline):** checked by reproducible commands outside the VPS;
  method and result recorded here.
- **Operator-reported:** read by the owner from the VPS terminal and
  screenshots. Not independently authenticated: the full JSON files have not
  been received or checked.
- **Trust assumption:** cannot be proven by any evidence available; only the
  owner can accept it.

## 2. Evidence (E1b, 2026-11-05; verified offline)

Commit `f3d5057b9c8fa6263d7bba7794e26a0a6eaa57cf` (E1b): `host-setup.sh`
built the research image (canary probe + offline research CLI) and passed its
preflight; `e1b-verify.sh` then collected the evidence. Host folders:
`/var/lib/research-sandbox-setup/e1b-20261105-104443-776070701` (evidence)
and `/home/automatonadmin/automaton-evidence/e1b-20261105-104414-712725951`
(logs).

| File (committed as `docs/evidence/e1b-<name>`) | SHA-256 (verified; equals the VPS `SHA256SUMS`) | Content (verified offline from the file) |
|---|---|---|
| `preflight-report.json` | `f9640ccea26832e65a008333b267c35bfca0fcd7398019593620350370ff8225` | refused only by M1/M3 (blocker texts identical to the code); runsc; Docker 29.9.3; seccomp builtin; rootful; canary removed and removal verified; gVisor host-process evidence (gVisor sandbox/gofer processes for the container, 0 canary processes on the host, 0 replaced executables, no overflow) |
| `negative-controls.json` | `d48ee65686ac5383b743114a59049d871816b1584568fdbb3ba887d4bac82cbf` | 8/8 controls as expected (baseline, docker-server-version, runsc-sha256, sidecar-sha256, image-id, canary-manifest-digest, gvisor-fingerprint, runc-instead-of-gvisor); runsc hash refused before create; wrong gVisor fingerprint refused at gvisor-unverified; runc never meets-spec |
| `trust-evidence.json` | `9ecc6ca25b6ba2df2a981bbbb854b65af11cdcc713646b65c71a95222564764f` | digest verifies; needs-review, 0 blocking, 1 review finding (gVisor key `6F1DF85E3A71C24918E727D56FC6D554E32BD943`); docker-ce/docker-ce-cli 5:29.9.3, containerd.io 2.4.2, runsc 20261102.0, each `dpkg --verify` clean and offered by its HTTPS repository; both keyrings hold the expected keys (root-owned, 644); dockerd `-H fd:// --containerd=...`, no drop-ins; daemon.json only `runtimes` with runsc `["--oci-seccomp"]`; SecurityOptions `name=apparmor,profile=default`, `name=seccomp,profile=builtin`, `name=cgroupns`; default runtime runc; **no host kernel or OS versions recorded** |
| `executor-dryrun.json` | `cdd73765295e266647119320e2e471645adae395a70986a04529e38623689dc0` | the E1 executor with the committed fictional sample job: its own fresh preflight was refused at meets-spec-blocked and the job was **refused by the M1/M3 gate** before any research container (steps `inputs-checked`, `preflight`; no container id, research exit code or report); fixed command `trading backtest` on exactly the two sample files; image `sha256:3e8a7371ba841599f91a259089fd4bad1e0e5e0bda7feba0518a555b5e6d46c5` |

**Transfer and verification (2026-11-05):** the owner pasted 15 numbered
pieces with per-piece checksums and the four VPS hashes. All 15 checksums
matched. The decoded stream began with the four `SHA256SUMS` text lines
(byte-identical to the pasted hashes) followed by the archive; the archive
held exactly the four files, each with exactly the VPS hash. All content
checks (47) and a sensitive-data scan plus manual read passed (only standard
system paths, repository URLs and key fingerprints). The files are verified
as transferred; that they truthfully describe the host remains D4.

**Earlier Step A2 evidence (canary image, 2026-11-04):** verified offline
the same way but kept out of the public repository because it records the
host's kernel and OS versions; superseded by the E1b evidence above.

## 3. gVisor signing key: verification method (verified, offline)

Performed 2026-11-05T00:03Z, from a network independent of the VPS:

| Step | Source | Result |
|---|---|---|
| 1 | `https://gvisor.dev/archive.key` (the URL in gVisor's install guide, `https://gvisor.dev/docs/user_guide/install/`); file SHA-256 `757d2ebdf00cdc5661f88443e2bea848d3e2ded0780cbcd2d811be05e0c1d5dd` | RSA-4096 public key created 2019-07-10, uid "The gVisor Authors <gvisor-bot@google.com>", fingerprint `6F1DF85E3A71C24918E727D56FC6D554E32BD943` (gpg and the Step A parser agree) |
| 2 | `website/archive.key` in `github.com/google/gvisor` at tag `release-20261102.0` (commit `7a675ac66a1e2357abdaa6cccedabcd3cce9aa5c`) | byte-identical to step 1 |
| 3 | `https://storage.googleapis.com/gvisor/releases/dists/release/InRelease` (SHA-256 `4a07302144e54ce4b058edd7cd2869f64234d5cc3bf8dee66a81c527c581467f`) and `Release` + `Release.gpg`, dated 2026-11-02 21:58:37 UTC | "Good signature" from `6F1DF85E3A71C24918E727D56FC6D554E32BD943` (gpg --verify) |
| 4 | The VPS keyring (verified in `docs/evidence/e1b-trust-evidence.json`) | the same fingerprint |

Commands: `curl -fsS` (HTTPS) for each file; `gpg --import` into an empty
temporary home; `gpg --with-colons --fingerprint`; `gpg --verify InRelease`;
`gpg --verify Release.gpg Release`; `cmp` against the git checkout.

Limits: all three sources are operated by Google / the gVisor project; the
install page publishes the key file, not a fingerprint text; a compromise of
gVisor's own release infrastructure would not be detected.

## 4. Verified facts, operator reports and trust assumptions

| Statement | Kind |
|---|---|
| The gVisor key fingerprint and its signature over the current gVisor repository index (section 3) | Verified (offline) |
| runsc ignores the OCI seccomp profile unless `--oci-seccomp` (gVisor `runsc/boot/seccomp.go`); runsc ignores AppArmor profiles (`runsc/specutils/specutils.go`); runsc applies the pids limit to the sandbox's host cgroup (`runsc/cgroup`) and not inside its cgroupfs; Docker 29 reports AppArmor as `name=apparmor,profile=...` (moby `daemon/info.go`) | Verified (source reading, pinned versions) |
| The preflight, observer, negative controls, trust evaluator, executor and governance test behave as specified | Verified offline with fakes (4365 tests); exercised on the host (section 2) |
| The four E1b files are the files produced on the VPS, unaltered (hashes equal the VPS values; trust digest verifies) | Verified (offline) |
| What the files report about the host | Produced by the tools on the host; trusted only under D4 |
| While M1/M3 exist, the executor refuses research before creating any container | Verified offline (tests) and on the host (`e1b-executor-dryrun.json`) |
| Docker, containerd, runsc and the kernel on the host report honestly | Trust assumption |
| Docker's and gVisor's release infrastructure and signing keys are not compromised | Trust assumption |

## 5. Decisions D1-D8 (owner to answer each; none answered)

Each answer is one of: **ACCEPT**, **REJECT**, or **MORE EVIDENCE**. Any
answer other than ACCEPT keeps the related blocker. To accept, the owner
states the acceptance sentence verbatim.

**D1 (M3): Docker 29.9.3 build and built-in seccomp profile.**
Evidence: installed from Docker's signed repository (keyring holds Docker's
published key `9DC858229FC7DD38854AE2D88D81803C0EBFCD88`), `dpkg --verify`
clean, daemon reports 29.9.3 with `name=seccomp,profile=builtin`
(verified in `docs/evidence/e1b-trust-evidence.json`). Assumption: Docker's build and profile are trustworthy.
Acceptance: "I accept trust in Docker Engine 29.9.3 from Docker's signed
apt repository and in its built-in seccomp profile, for this host only,
until the pinned version changes."

**D2 (M3): gVisor signing key.**
Evidence: section 3 (verified) and the VPS keyring (verified in `docs/evidence/e1b-trust-evidence.json`).
Assumption: gVisor's release infrastructure is not compromised.
Acceptance: "I accept `6F1DF85E3A71C24918E727D56FC6D554E32BD943` as the
gVisor release signing key and trust gVisor runsc release-20261102.0
installed from that repository."

**D3 (M3): integrity limits of package evidence.**
Evidence: `EVIDENCE_LIMITS` in `src/research-sandbox/trust-evidence.ts`.
Assumption: apt verified signatures at download time; the local dpkg
database (MD5 sums) has not been altered.
Acceptance: "I accept that package integrity is shown by apt's
download-time signature checks and `dpkg --verify` against the local
package database, which a host root user could alter."

**D4 (M1): host root and daemon honesty.**
Evidence: none possible from the host itself; every check is reported by
the daemon, runtime, kernel or files a root user controls.
Assumption: the host's root account, Docker daemon and runsc are not
malicious.
Acceptance: "I accept that the host's root account, Docker daemon and
runtime are trusted, and that their reports (including /proc) could be
falsified by a compromised root."

**D5 (M1): gVisor fingerprint is trust-on-first-use.**
Evidence: container `/proc/version` differs from the host's and equals the
reference recorded at setup; the gvisor-fingerprint negative control was
refused (verified in `docs/evidence/e1b-negative-controls.json`).
Acceptance: "I accept the gVisor /proc/version fingerprint recorded at setup
as a trust-on-first-use identification, not a cryptographic proof."

**D6 (M1): time gap between checks and use.**
Evidence: binary, sidecar and runtime-configuration re-checks after create
and after the canary.
Acceptance: "I accept that a change made between the preflight's checks and
a later run cannot be fully excluded; re-checks narrow but do not close the
gap."

**D7 (M1): pids limit enforced outside gVisor only.**
Evidence: inspect requires PidsLimit 64; runsc applies it to the sandbox's
host cgroup (verified, source); it is not observable inside gVisor.
Acceptance: "I accept that the pids limit of 64 is enforced on the
sandbox's host cgroup and is not observable inside gVisor."

**D8 (M1): AppArmor does not confine the gVisor sandbox.**
Evidence: runsc ignores AppArmor (verified, source); Docker reports
`name=apparmor,profile=default` and the kernel module is enabled (verified in
`docs/evidence/e1b-trust-evidence.json`); docker-default loaded per `aa-status`
(operator-reported, Step A2).
Acceptance: "I accept that gVisor does not apply AppArmor, so containment
relies on gVisor, seccomp (inside with --oci-seccomp, and the Sentry's own
filters), namespaces and cgroups."

## 6. What happens after the owner's answers

1. Done: the four E1b evidence files are verified and prepared under
   `docs/evidence/e1b-*.json` (committed only with the owner's approval).
2. Only for decisions answered ACCEPT: prepare `docs/M1-M3-DECISION.md` from
   the template (owner's name, date, reviewed commit, evidence hashes,
   "Reviewed findings: 1", the accepted risks) and, if every decision for a
   blocker is accepted, the code change removing that blocker; one reviewed
   diff, validated by the governance test.
3. No research runs from any of this: even after a blocker removal, each
   executor run needs the owner's explicit approval.
