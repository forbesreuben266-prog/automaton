# M1/M3 decision record (TEMPLATE; not a decision)

This is the format `src/__tests__/research-sandbox/blocker-governance.test.ts`
requires before a blocker may be removed from `MEETS_SPEC_BLOCKERS`. A
decision is recorded by the owner in `docs/M1-M3-DECISION.md` (that file does
not exist yet). The test refuses the removal, or any rewording, of a blocker
unless that file has a valid, accepted section for it. Removing a blocker is
still a separate, reviewed code change; it does not by itself enable any
research processing (there is no executor for untrusted input yet).

Each section needs, exactly in this form:

```
## M1
Decision: ACCEPTED
Approved-by: <the owner's name>
Date: <YYYY-MM-DD>
Commit-reviewed: <40-hex commit the evidence was produced with>
Evidence:
- sha256:<64 hex> preflight docs/evidence/<preflight-report>.json
- sha256:<64 hex> negative-controls docs/evidence/<negative-controls>.json
- sha256:<64 hex> host-processes docs/evidence/<preflight-report>.json
Reviewed findings: <the trust evidence's "review" count, only in the M3 section>
Residual risks accepted:
- <each residual limit, in your words>
```

Required evidence labels: **M1**: `preflight`, `negative-controls`,
`host-processes`. **M3**: `preflight`, `trust-evidence`.

The cited files are the unedited JSON output of the Step A tools
(`preflight-report.json` from host-setup, `negative-controls-main.js
--output json`, `trust-evidence-main.js`), committed under `docs/evidence/`
(they contain no secrets by design; review them before committing). The test
checks that each file exists, has the cited SHA-256 and actually shows a pass
for its label: a preflight refused only by M1/M3 under runsc with verified
cleanup; host-process evidence with a gVisor sandbox/gofer process and no
canary on the host; every negative control passed; trust evidence whose
digest verifies, with no blocking findings and every review finding counted
as reviewed. A record citing made-up hashes or failing evidence is refused.

Residual limits that a decision must address explicitly:
- **M1:** a dishonest root-level daemon or runtime can report one thing and
  run another; the gVisor `/proc/version` fingerprint is trust-on-first-use;
  checks and use are separated in time; the pids limit is enforced on the
  sandbox's host cgroup only; host `/proc` can be faked by root.
- **M3:** trust in the Docker 29.9.3 build from Docker's signed repository
  and in its built-in seccomp profile (as applied inside gVisor with
  `--oci-seccomp`); every blocking trust-evidence finding resolved or
  accepted; re-review whenever the pinned version changes.

Any doubt: the blocker stays.
