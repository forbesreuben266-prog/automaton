# M1/M3 decision record: DRAFT (no decision has been made)

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

## 2. Evidence (Step A2, 2026-11-04)

Commit `0806c125d09d2bd5d0f9f8849fdcd84fec7b9695` (trust evidence) reusing
the Step A preflight and negative controls of commit
`fc75cabcddd2923d538b2afd1fcadb2c6c0c0b77` (reuse allowed only because no
sandbox or deploy code other than the trust evaluator changed; checked by
the Step A2 command). Host folder:
`/home/automatonadmin/automaton-evidence/step-a2-20261104-235243-062531742`.

| File | SHA-256 (operator-reported) | Operator-reported content |
|---|---|---|
| `preflight-report.json` | `d8f3901bd8c3ced8d07e06413abb8cad69462b023fc4ff9d91462f3370c082dd` | refused only by M1/M3; runsc; Docker 29.9.3; seccomp builtin; canary removed and removal verified; host processes: 85 polls, 2 gVisor sandbox/gofer processes, 0 canary processes on the host, 0 replaced executables, no overflow |
| `negative-controls.json` | `204501bdc37d656b934e0ef6a49f6bd3971915804713e6389fc7e3c72ffb55ef` | 8/8 controls as expected (baseline, docker-server-version, runsc-sha256, sidecar-sha256, image-id, canary-manifest-digest, gvisor-fingerprint, runc-instead-of-gvisor; runc only development-only) |
| `trust-evidence.json` | `b80fc575b08466678046961ea8961d0fb1c37ab485be4b09fea67c74d285fe35` | verdict needs-review, 0 blocking, 1 review finding (gVisor key `6F1DF85E3A71C24918E727D56FC6D554E32BD943`); AppArmor enabled, docker-default loaded, Docker reports AppArmor, seccomp and cgroups |

**Evidence gap (no new VPS test needed):** the three files themselves must
be transferred (read-only `tar | base64` command, then pasted) so that their
hashes, schemas, findings and absence of sensitive data can be verified
offline and the files committed under `docs/evidence/`. Until then every
row above is operator-reported only, and the governance test cannot accept a
decision record.

## 3. gVisor signing key: verification method (verified, offline)

Performed 2026-11-05T00:03Z, from a network independent of the VPS:

| Step | Source | Result |
|---|---|---|
| 1 | `https://gvisor.dev/archive.key` (the URL in gVisor's install guide, `https://gvisor.dev/docs/user_guide/install/`); file SHA-256 `757d2ebdf00cdc5661f88443e2bea848d3e2ded0780cbcd2d811be05e0c1d5dd` | RSA-4096 public key created 2019-07-10, uid "The gVisor Authors <gvisor-bot@google.com>", fingerprint `6F1DF85E3A71C24918E727D56FC6D554E32BD943` (gpg and the Step A parser agree) |
| 2 | `website/archive.key` in `github.com/google/gvisor` at tag `release-20261102.0` (commit `7a675ac66a1e2357abdaa6cccedabcd3cce9aa5c`) | byte-identical to step 1 |
| 3 | `https://storage.googleapis.com/gvisor/releases/dists/release/InRelease` (SHA-256 `4a07302144e54ce4b058edd7cd2869f64234d5cc3bf8dee66a81c527c581467f`) and `Release` + `Release.gpg`, dated 2026-11-02 21:58:37 UTC | "Good signature" from `6F1DF85E3A71C24918E727D56FC6D554E32BD943` (gpg --verify) |
| 4 | The VPS keyring (operator-reported, in `trust-evidence.json`) | the same fingerprint |

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
| The preflight, observer, negative controls, trust evaluator and governance test behave as specified | Verified offline with fakes (4288 tests); exercised on the host per operator report |
| The Step A2 results and hashes in section 2 | Operator-reported |
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
(operator-reported). Assumption: Docker's build and profile are trustworthy.
Acceptance: "I accept trust in Docker Engine 29.9.3 from Docker's signed
apt repository and in its built-in seccomp profile, for this host only,
until the pinned version changes."

**D2 (M3): gVisor signing key.**
Evidence: section 3 (verified) and the VPS keyring (operator-reported).
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
refused (operator-reported).
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
Evidence: runsc ignores AppArmor (verified, source); AppArmor enabled and
docker-default loaded on the host (operator-reported).
Acceptance: "I accept that gVisor does not apply AppArmor, so containment
relies on gVisor, seccomp (inside with --oci-seccomp, and the Sentry's own
filters), namespaces and cgroups."

## 6. What happens after the owner's answers

1. Transfer the three evidence files; verify them offline (hashes must equal
   section 2, schemas and findings as reported, nothing sensitive); commit
   them under `docs/evidence/` (approval needed).
2. Only for decisions answered ACCEPT: prepare `docs/M1-M3-DECISION.md` from
   the template (owner's name, date, reviewed commit, evidence hashes,
   "Reviewed findings: 1", the accepted risks) and, if every decision for a
   blocker is accepted, the code change removing that blocker; one reviewed
   diff, validated by the governance test.
3. E1 (executor) stays a separate milestone; it is not started by any of
   this.
