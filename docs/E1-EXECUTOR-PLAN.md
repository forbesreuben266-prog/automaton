# E1: sandbox executor for research input (PLAN; not implemented)

**Status: plan only.** Nothing here runs untrusted input. E1 is designed to
stay refused while either M1/M3 blocker exists; it is built and tested
offline first, and each host step needs its own approval.

## Goal

Run the research CLI on one approved input set inside the verified gVisor
sandbox, and bring its output back only through quarantine, with every step
fail-closed and auditable.

## Design

| Area | Requirement |
|---|---|
| Run gate | A fresh preflight immediately before each run; `assertUntrustedInputAllowed` must bind the run id, input/output folders, security-argument hash, runsc and sidecar hashes, gVisor fingerprint and Docker version. A development runtime (runc/crun) never runs research input. Refused while `MEETS_SPEC_BLOCKERS` is non-empty. |
| Research image | A separate image holding only the compiled research CLI (no package manager use at run time, no network, no secrets in its environment, no healthcheck, read-only root), built from the same pinned base by digest; its image ID and manifest digest recorded at an approved build, exactly like the canary. |
| Container | The same create flags as the canary (`--pull never`, `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, `--init=false`, limits, tmpfs `/tmp`), purpose "run", a fixed command (no caller-supplied command), full inspect before start, host-process observer during the run, timeout and output caps, re-inspect after exit, verified removal. |
| Input | Staged into `/in` only after the existing R2 import checks; read-only; caps on size, file count and path depth; no links, devices or special files; owner and mode checked on the host. |
| Output | `/out` is untrusted: size/count caps, no links or special files, and the R2 quarantine review before anything leaves the run folder; nothing is executed or rendered from it automatically. |
| Operator control | An explicit confirmation flag per run, no override or skip option, an audit record per run (inputs' hashes, pins, preflight result, exit status, output hashes), and a manual-cleanup message on any unverified removal. |

## Milestones

| Step | Where | Content |
|---|---|---|
| E1a | Offline, one review | Executor module and entry point, research image definition, tests with fakes (hostile inputs, timeouts, crashes, oversized output, cleanup failure, a result for another run). Still refused by M1/M3. |
| E1b | VPS, approval | Build and record the research image; dry run with a fixture input: must be refused by M1/M3, with every other check passing. |
| E1c | VPS, approval | Only after an owner decision lifts the blockers: one controlled run with synthetic input, output reviewed in quarantine. |

No agents, paid APIs, real-world data, wallets or trading are part of E1.
