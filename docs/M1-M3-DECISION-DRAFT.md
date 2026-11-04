# M1/M3 decision record: DRAFT (no decision has been made)

**Status: PENDING.** This draft records the evidence gathered so far and what
is still missing. It is not a decision: no blocker is accepted or removed, and
no residual risk has been accepted by the owner. The governance test only
accepts a decision in `docs/M1-M3-DECISION.md` (format:
`docs/M1-M3-DECISION-TEMPLATE.md`), with the evidence files committed under
`docs/evidence/`. Neither exists yet.

## Evidence gathered (Step A, 2026-11-04)

| Item | Result | Where |
|---|---|---|
| Commit | `fc75cabcddd2923d538b2afd1fcadb2c6c0c0b77` (Step A) | |
| Host evidence folder | `/home/automatonadmin/automaton-evidence/step-a-20261104-234013-181648004` (on the VPS; not yet copied here) | |
| Sandbox preflight | refused only by M1/M3 under runsc, cleanup verified | `preflight-report.json` |
| gVisor host-process evidence | passed (gVisor sandbox/gofer process seen; canary never a host process) | `preflight-report.json` |
| Negative controls | all 8 behaved as expected | `negative-controls.json` |
| Trust evidence | REVIEW: 0 blocking, 2 to review | `trust-evidence.json` |

### Review finding 1: gVisor signing key (offline verification done)

The VPS keyring holds `6F1DF85E3A71C24918E727D56FC6D554E32BD943`. Checked
independently on 2026-11-04 from a different network:
- `https://gvisor.dev/archive.key` (the URL gVisor's install guide uses) has
  exactly this fingerprint (computed by the Step A parser and by gpg);
- `website/archive.key` in `google/gvisor` at tag `release-20261102.0`
  (commit `7a675ac6`) is byte-identical to it;
- the current repository index
  (`https://storage.googleapis.com/gvisor/releases/dists/release/InRelease`
  and `Release` + `Release.gpg`, dated 2026-11-02) carries a good signature
  from this key ("The gVisor Authors <gvisor-bot@google.com>").

Limits: all three sources are controlled by Google/gVisor; no published
fingerprint text was found on the install page. Owner to confirm.

### Review finding 2: AppArmor "not reported" (Docker reporting format)

Docker 29.9.3 reports AppArmor as `name=apparmor,profile=default` (moby
`daemon/info.go`); the Step A evaluator looked only for the older exact string
`name=apparmor`, so the finding is expected to be a format mismatch. The fix
(accept both forms) is prepared offline. Host confirmation is pending (the
read-only command prints Docker's recorded SecurityOptions and `aa-status`
counts). Independently of reporting, gVisor ignores a container's AppArmor
profile (`runsc/specutils/specutils.go`: "AppArmor profile ... is being
ignored"), so AppArmor is not an isolation control on the runsc path; it
still confines runc containers and host services.

## Still required before any decision

1. Host confirmation for finding 2 (read-only command).
2. The three evidence files committed under `docs/evidence/` (unedited, after
   a review that they hold no secrets), and their SHA-256 values cited.
3. A re-run of trust evidence with the corrected evaluator, so that the cited
   trust evidence has 0 blocking findings and its review count matches the
   findings the owner has reviewed (expected: 1, the gVisor key, or 0).
4. The owner's own decision on each residual risk below.

## Residual risks the owner must decide on (none accepted)

**M1**
- A dishonest root-level daemon or runtime can report one thing and run
  another; host `/proc`, dpkg and file contents can be faked by root.
- The gVisor `/proc/version` fingerprint is trust-on-first-use.
- Checks and use are separated in time (re-checks narrow, not close, the gap).
- The pids limit (64) is enforced on the sandbox's host cgroup, not visible
  inside gVisor.
- gVisor ignores AppArmor; containment relies on gVisor, seccomp (inside with
  `--oci-seccomp`; the Sentry's own filters outside), namespaces and cgroups.

**M3**
- Trust in Docker 29.9.3 from Docker's signed repository and in its built-in
  seccomp profile; apt checks signatures at download time only, and dpkg
  verifies installed files against local MD5 sums.
- Trust in gVisor release-20261102.0 from the key above.
- Re-review whenever a pinned version changes (the pins already refuse a
  different version).

## When (and only when) the owner decides to accept

Copy the template into `docs/M1-M3-DECISION.md`, fill every field from the
committed evidence, and submit it together with the code change that removes
the accepted blocker(s). The governance test validates the record and the
evidence. Removing a blocker does not by itself enable research processing:
there is no executor for untrusted input yet (see `docs/E1-EXECUTOR-PLAN.md`).
