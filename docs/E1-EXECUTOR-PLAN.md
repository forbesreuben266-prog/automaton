# E1: sandbox executor for research input

**Status: E1 complete (2026-11-06).** E1c, the first synthetic-only run under
the lifted M1/M3 gate (`docs/M1-M3-DECISION.md`), passed on the VPS. The run
used commit `8e7e4977` and the script `deploy/research-sandbox/e1c-retry.sh`
(branch `e1c-retry`, `701a7ac9`). One fictional `trading backtest` job ran
under gVisor:
- executor and research CLI both exited 0;
- 18 host-process samples showed 2 gVisor processes and 0 research-script
  processes on the host;
- the report hash matched the offline prediction;
- cleanup was verified and no containers were left over.

The evidence is on the host (root-only):
`/var/lib/research-sandbox-setup/e1c-20261106-215858`. These results are
operator-reported.

**Earlier stages:** `src/research-sandbox/executor.ts`
and `executor-main.ts` run one operator job (research CLI `trading validate` or
`trading backtest` on files staged in the run's input folder) after a fresh
preflight and the `assertUntrustedInputAllowed` gate. While M1/M3 exist the
gate always refuses and no research container is created. The research image
(`deploy/research-sandbox/Dockerfile.research`, file list in
`src/research-sandbox/research-image.ts`) holds the canary and the research CLI,
so the preflight and the job use one pinned image ID.

**E1b (offline, ready for one host run):** `host-setup.sh` now builds the
research image (build context generated from `RESEARCH_IMAGE_LAYOUT`), and
`deploy/research-sandbox/e1b-verify.sh --execute` then collects, in one pass:
the preflight report, read-only trust evidence (no kernel or OS versions),
negative controls, and an executor dry run with the committed synthetic sample
(`deploy/research-sandbox/e1b-sample/`, the documented fictional demo data),
which must be refused by the M1/M3 gate with no research container created.
It prints the four evidence files as numbered pieces for transfer.
Nothing here runs untrusted input. E1 is designed to
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
| E1c | VPS, approval | Done 2026-11-06: one controlled run with synthetic input passed (see status above). |

No agents, paid APIs, real-world data, wallets or trading are part of E1.
