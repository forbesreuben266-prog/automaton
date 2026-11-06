# Research jobs from Termius (E3 operator guide)

## Status

- **E1c** (first synthetic run under the lifted M1/M3 gate): PASS on 2026-11-06,
  operator-reported. See `docs/E1-EXECUTOR-PLAN.md`.
- **E2** (first operator-approved job): PASS on 2026-11-06, operator-reported.
  - Job: `e2-demo`, the committed fictional backtest.
  - Approval: `5c9299f8ec8ada75...0b99c1`.
  - Script: `e2-job.sh` at commit `93d298c6`, SHA-256 `f6f35e8c...2966`.
  - The run's evidence folder, report hash and gVisor counts were not reported,
    so none are recorded here.
- **E3** (this workflow, validated end to end): PASS on 2026-11-06,
  operator-reported.
  - Script: `jobs.sh` at commit `23571b07`, SHA-256 `f44e660d...bfda`.
  - The `template`, `check` and `prepare` steps passed for job `e3-demo`.
  - One approved run: COMPLETED, research exit 0, runtime 3.1 s.
  - gVisor: 2 gVisor processes observed and 0 research-script processes on
    the host.
  - Cleanup verified, approval consumed, evidence intact.
  - Evidence: `e2-e3-demo-20261106-225942-e8b75e`.
  - Report SHA-256:
    `0d1c79deaeb2727fa82255ce74b5c0ced8f53b82bc5fd098caccd86ed280692d`.
  - Export: `report.txt` and `summary.json` verified against `SHA256SUMS`.

## What this does

`deploy/research-sandbox/jobs.sh` runs offline research jobs on the approved
VPS. Each job gets its own approval and runs once, under gVisor with network
`none`, using the same pinned, hash-verified code as E1c and E2.

The research CLI only accepts **fictional data you write yourself** in this
phase. Its datasets must say `"source": {"kind": "fictional", ...}`; a
dataset with any other source is refused inside the sandbox. Live market data,
agents, paid APIs and trading are not part of this workflow.

## One-time setup per Termius session

Paste the line from the release message. It looks like this:

    jobs() { f=$(mktemp) && curl -fsSL https://raw.githubusercontent.com/forbesreuben266-prog/automaton/<COMMIT>/deploy/research-sandbox/jobs.sh -o "$f" && echo "<SHA256>  $f" | sha256sum -c - && bash "$f" "$@"; }

It downloads the script from a fixed commit and runs it only if
`sha256sum` prints `OK`.

## Everyday use

| Step | Command | Notes |
|---|---|---|
| 1. Start a job | `jobs template my-job` | Creates `~/research-inputs/my-job/` with `job.json`, `prices.json` and `run.json`, copied from the committed fictional example. Other templates: `validate` (dataset only) and `buy-and-hold`. |
| 2. Edit | Termius SFTP, or `nano ~/research-inputs/my-job/prices.json` | Keep the file names that `job.json` lists. |
| 3. Check | `jobs check my-job [other-job...]` | Runs as you; runs no research. Lists each problem with its exact place, e.g. `dataset.bars[3].high: ...`. |
| 4. Prepare | `jobs prepare my-job [other-job...]` | `sudo` asks for your password. Each job gets its own `APPROVAL <job> <hash>` line. Nothing runs. |
| 5. Run | `jobs run my-job <hash>` | Exactly one job. You can use the first 16 or more characters of the hash if they match only one approval. |
| 6. Results | `jobs results` | Recent runs: outcome, runtime, gVisor processes, cleanup and report hash. For one run's details (input hashes, approval, commit), use `jobs results <evidence>`. |
| 7. Export | `jobs export <evidence>` | Writes `report.txt`, `summary.json` and `SHA256SUMS` to `~/research-results/<evidence>/`, readable only by you. Download them with Termius SFTP. |
| Housekeeping | `jobs cleanup` | Lists leftovers only and deletes nothing: expired approvals that were never used, folders left by an interrupted `prepare`, and your temporary build folders in `/tmp`. Run evidence, reports, logs and used approvals are never listed. To delete exactly the listed paths, run `jobs cleanup --delete <plan-hash>` with the hash it printed. If anything changed since the list was shown, nothing is deleted. |

Preparing several jobs at once gives each one its own approval. There is no
batch run: every `run` is one job, with its own hash.

## Rules the scripts enforce

- **The job folder:**
  - holds exactly `job.json` and the files it names;
  - contains only plain `.json` files owned by you, with no links or hard
    links;
  - is not writable by group or others.
- **Size limits:** dataset at most 10 MB, config at most 10 kB, `job.json` at
  most 4 kB.
- **Approvals:** each is single-use and valid for 24 hours. If any file
  changes after `prepare`, the run stops before anything is staged and the
  approval stays unused; prepare again.
- **Reports are untrusted text from your input.** They are shown and exported
  as plain text with control characters replaced; open them as text only.
- **`check` is advisory.** It mirrors the research CLI's main rules, but the
  research CLI inside the sandbox has the final say.

## Reading `results`

- `COMPLETED`: the research CLI exited 0. `INPUT`: the research CLI refused
  the input, and its reasons are in the report. `STOP`: a check failed after
  the job started. `STOPPED`: the run stopped before the job, so no
  container ran.
- **Evidence markers:**
  - `(EVIDENCE CHANGED)`: a file in the evidence folder no longer matches its
    checksum. Investigate.
  - `(NOT SEALED ...)`: the job ran, but the checksum file is missing.
    Investigate.
  - Runs that stopped before the job are never sealed, and show no marker.

## What a run changes on the VPS

- It marks the approval used.
- It moves the run folder's previous inputs, then this job's inputs, into a
  root-only evidence folder under `/var/lib/research-sandbox-setup/`.
- It adds one line to `e2-runs.log`.
- `prepare` and `run` check out and build the pinned commit in `~/automaton`.

## If something stops

Every `FAIL` line says what failed, and the run stops safely; don't retry
blindly. If a run is interrupted, check for leftover containers first:

    sudo docker ps -a --filter name=research-sandbox-
