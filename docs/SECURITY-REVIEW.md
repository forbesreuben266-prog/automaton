# Security and deployment review (pre-launch)

Status: **review only, nothing deployed.** No account was created, no server
provisioned, no wallet generated or funded, and the agent loop was never
started.

Passing tests does **not** make this system safe. The tests check that the
code does what it says. They don't show that an autonomous agent with a
shell, a wallet and internet access stays within limits. The controls that
can't be enforced reliably are listed in section 4.

All findings below were checked against the code on branch `custom`
(upstream commit `d8f8168`). File and line references are to that tree.

---

## 1. Commits on `forbesreuben266-prog/automaton` branch `custom`

| Commit | Content |
|---|---|
| `0963307` | First token-counter fix (length ÷ 4 estimate), setup log |
| `8769ee4` | Revised fix: chunked encoding plus byte-count upper bound, 12 new tests |
| (this commit) | Deployment drafts (`deploy/`), this review |

`main` is still identical to upstream `d8f8168`.

## 2. Token-counting change: review

### What was wrong with the first fix (`0963307`)
It estimated long whitespace-free runs at length ÷ 4. Measured against exact
cl100k BPE, that **under-counts** badly:

| Content | Exact / estimate ratio under `0963307` |
|---|---|
| base64 | 0.34× |
| hex | 0.45× |
| minified JS | 0.65× |
| Chinese / Japanese | 0.23× / 0.30× |
| emoji | 0.18× |

### Current design (`8769ee4`, `src/memory/context-manager.ts`)
- Runs of 64 or more non-whitespace characters are encoded in chunks of 32
  code points (the `u` flag means surrogate pairs are never split). BPE
  merges can't cross a chunk boundary, so the count is at or slightly above
  exact. Measured: 1.00–1.01×.
- Only the first 50,000 characters are BPE-encoded. The rest is counted as
  UTF-8 bytes, which is a **hard upper bound** (each token is at least one
  byte).
- Ordinary text is still encoded exactly.

### Tests added (all pass, and 7 of them fail against `0963307`)
- Never under-counts base64, hex, CJK, emoji or minified JS, and stays within
  1.25× of exact.
- Exact at runs of 63, 64 and 65 characters (the threshold boundary).
- Surrogate pairs aren't split at chunk boundaries.
- Never under-counts past the 50k encoded prefix, and never exceeds the
  UTF-8 byte count.
- 500k characters of repeated ASCII, Chinese, or 63-character chunks each
  complete within 15 s (measured 0.4–1.7 s).

Full suite: **64 files, 1,655 tests passed**. Typecheck and build are clean.

### What the counts control
- **Used for:** context assembly, that is when old turns get summarised
  (`src/agent/context.ts`) and memory budgets (`src/memory/*`).
- **Not used for spending limits.** The router's pre-call budget check uses
  its own `characters / 4` estimate (`src/inference/router.ts:65`, upstream),
  and recorded spend uses the provider's reported usage.

### Residual issues
- Text past 50k characters is over-counted (500k chars of English counts as
  about 450k tokens vs. about 83k exact). This is the safe direction: it only
  makes summarisation happen earlier.
- Worst-case CPU time is about 3 s per call (500k chars of CJK in 63-char
  segments). Results are cached, so this is bounded but not free.
- Pre-existing: the token cache uses the full text as its key, up to 10k
  entries, so memory use is unbounded per entry. The container memory limit
  contains this.
- Pre-existing: the router's `chars / 4` pre-call estimate under-counts
  base64 and CJK, so a single call can overshoot a per-call ceiling.

## 3. Inventory: what runs automatically, and how to switch it off

"Config" means a switch I verified in the code. "Code" means no switch
exists.

| Feature | Where | When it fires | Off by config? | Off by code / environment |
|---|---|---|---|---|
| Wallet creation | `identity/wallet.ts` `getWallet()` from `--init`, `--setup`, `--run` | First start if `wallet.json` is missing | **No.** Required to run. | Keep it, and **never fund it** |
| Conway API key provisioning (SIWE) | `identity/provision.ts`, wizard, `--provision` | Wizard or `--provision` | Skipped if you never run those | `--run` exits without a key (`index.ts:201`). `CONWAY_API_KEY` env is in the help text but **not implemented**. |
| Conway identity registration | `index.ts:255` `registerAutomaton` | Every start until it succeeds once | **No** | Safe-mode patch, or block `api.conway.tech` at egress (it fails and logs a warning) |
| USDC → credits: startup | `index.ts:350` `bootstrapTopup` | Credits < $5 and USDC ≥ $5 | **No** | Unfunded wallet; block Base RPC; safe-mode patch |
| USDC → credits: in the loop | `agent/loop.ts:444` | Every 60 s while tier is low/critical and USDC ≥ $5 | **No** | Same as above |
| USDC → credits: heartbeat | `heartbeat/tasks.ts:160` | Every 5 min | `heartbeat.yml` `enabled: false` (verified) | Agent can re-enable via `modify_heartbeat` unless that tool is denied |
| `topup_credits` / `transfer_credits` / `fund_child` tools | `agent/tools.ts` | Agent decision | Treasury limits of 0 deny transfers above 0 (verified for single transfers) | Safe-mode deny list |
| Orchestrator funding of children | `orchestration/orchestrator.ts:258`, `health-monitor.ts:331` → `transferCredits` | Agent creates goals | **No.** Bypasses the policy engine. | Deny `create_goal`; safe-mode patch |
| Child spawning (paid Conway sandboxes) | `replication/spawn.ts`, `loop.ts:237` (orchestrator) | `spawn_child`, or the orchestrator handling a goal | `maxChildren` is **ignored** by `spawn.ts:71` (reads `(db as any).config`, which is always undefined, so always 3) | Fix the bug; deny `spawn_child`, `start_child` and `create_goal` |
| AI usage (main loop) | `loop.ts:603` → `InferenceRouter` | Every turn; wake events from heartbeat | `maxTurnsPerCycle` (verified); `modelStrategy.hourlyBudgetCents` / `sessionBudgetCents` / `perCallCeilingCents` (default 0 = off) | **`maxInferenceDailyCents` never triggers** (it only applies to tools named `chat` or `inference`, and none exist). Provider-side cap is the real limit. |
| Model choice | `inference/router.ts:192` | Every call | `inferenceModel` is only a fallback. A hard-coded list (`gpt-5-mini`, `gpt-5.2`, `gpt-5.3`) is tried first. | With only an Anthropic key, calls route to **Conway** (paid credits). Use an OpenAI key, or patch the registry. |
| Heartbeat daemon | `heartbeat/daemon.ts` | Always, with `--run` | Per task, in `heartbeat.yml` | Agent's `modify_heartbeat` can add or enable **any** built-in task, including the colony/orchestrator ones |
| Self-modification | `edit_own_file`, `install_npm_package`, `install_mcp_server`, `install_skill`, `create_skill`, `update_genesis_prompt`, `modify_heartbeat`, `exec` | Agent decision | **No switch** | Read-only image (verified: `/app` root-owned and read-only); safe-mode deny list |
| Upstream updates | `check_for_updates` heartbeat; `pull_upstream`, `reset_to_upstream` tools | Every 4 h, then agent decision | `heartbeat.yml` | No `.git` in the image (verified), so it's a no-op; deny the tools |
| Public inbox polling | `check_social_inbox` every 2 min, `social.conway.tech` | Always, by default | **`socialRelayUrl: ""`** disables the client everywhere (verified) | Also block at egress |
| Shell (`exec`) | `conway/client.ts:113` `execSync` in `$HOME` | Agent decision | **No** | Container isolation; deny `exec` for the first run |

## 4. Controls that cannot be enforced reliably

1. **`exec` gives the agent arbitrary code execution as its own user.** The
   shell guard blocks only `cat …wallet.json`. `head`, `base64` or `node -e`
   would read the private key, and every API key is in files the same user
   can read. Nothing inside the process prevents this. Mitigations: deny
   `exec` for the first run, keep the wallet unfunded, and allow egress only
   to the inference host.
2. **In-agent spending limits are weak.** `maxInferenceDailyCents` is dead
   code for the main loop. `hourlyBudgetCents` depends on the model price
   table, and a model with a zero or unknown price never trips it. The only
   hard spend limit is a **prepaid provider balance with auto-recharge off**.
3. **The automatic top-up has no config switch** in two of its three code
   paths. The only reliable control is **zero USDC in the wallet**.
4. **The `maxChildren` limit is ignored** by `spawnChild` (bug).
5. **Policy coverage depends on call-site discipline.** `executeTool` skips
   all policy checks if `turnContext` is missing (`tools.ts:3320`). Every
   current caller passes it, but this is fragile. Several money paths
   (orchestrator funding, the top-ups) don't go through the policy engine at
   all.
6. **Heartbeat disables can be undone by the agent** via `modify_heartbeat`,
   unless the tool is denied.
7. **Prompt-level rules are guidance, not enforcement.** That covers the
   genesis prompt, the constitution, and "do not trade". With zero Conway
   credits the agent sees itself in the `critical` survival tier, and its
   system prompt pushes it to seek revenue.
8. **Startup registration with Conway** always runs while the API is
   reachable. It sends the name, both addresses, and a hash of the genesis
   prompt.
9. **The egress allowlist proxy is designed but not tested end-to-end here.**
   This sandbox blocks the Alpine package mirror needed to install tinyproxy.
   The isolation half *was* tested: a container on an `internal: true`
   network cannot resolve or reach any host.
10. **Disk usage of the state volume has no quota** with Docker's default
    local driver. Monitor it, or put the volume on a fixed-size filesystem.
11. **Backups:** upstream `scripts/backup-restore.sh` copies the live SQLite
    file with `cp`. Back up only while the container is stopped.

## 5. Proposed first-run configuration

### 5a. Configuration files (drafted, validated, no secrets)
- `deploy/config/automaton.json.template`, verified through `loadConfig()`:
  - `socialRelayUrl: ""`, `maxChildren: 0`, `maxTurnsPerCycle: 3`,
    `maxTokensPerTurn: 2048`
  - all treasury transfer and x402 limits set to 0, with an empty x402
    allowlist
  - `modelStrategy`: hourly 25¢, session 100¢, per-call 5¢, model fallback
    off. All three model slots are `gpt-5-mini`, **to be checked against your
    OpenAI account**.
  - soul reflection off; creator approval required for purpose changes
- `deploy/config/heartbeat.yml`: top-up, update check and inbox polling are
  disabled (verified through `loadHeartbeatConfig()`).

### 5b. Code changes needed: "safe mode" patch (NOT yet written, needs approval)
Configuration alone can't meet the requirements. I propose a `safeMode: true`
config flag, off by default, so upstream behaviour is unchanged. When on, it
would:
1. Add a highest-priority policy rule that **denies these tools**:
   - money: `transfer_credits`, `topup_credits`, `fund_child`
   - children: `spawn_child`, `start_child`, `message_child`, `create_goal`
   - infrastructure: `create_sandbox`, `delete_sandbox`, `expose_port`,
     `remove_port`, `register_domain`, `manage_dns`
   - self-modification: `edit_own_file`, `revert_last_edit`,
     `reset_to_upstream`, `pull_upstream`, `install_npm_package`,
     `install_mcp_server`, `install_skill`, `create_skill`, `remove_skill`,
     `update_genesis_prompt`, `modify_heartbeat`, `switch_model`
   - outward-facing: `git_push`, `git_clone`, `send_message`,
     `give_feedback`, `update_agent_card`
   - shell: `exec`
2. Skip all three automatic top-up paths and the Conway registration call.
3. Make the orchestrator never call `spawnChild` (local workers only).
4. Fix `spawn.ts` so it honours `config.maxChildren`, so that 0 means 0.
5. Make `maxInferenceDailyCents` actually work by enforcing it in
   `InferenceRouter` from recorded `inference_costs`.
6. Add a `--max-cycles N` flag that exits after N agent cycles, for a single
   controlled run.

Each item would get tests. The denied tools remain visible to the model,
which will see "denied by policy" if it tries them.

### 5c. Genesis prompt: draft for review
> You are a supervised test instance. This is a closed test with no real
> objective beyond demonstrating safe operation. Do not attempt to earn money,
> trade, transfer funds, contact anyone, or modify yourself. Read your status,
> write a short note to memory describing what you are and what tools you
> believe you have, then sleep.

(Your real objective replaces this only after the controlled run is reviewed.)

## 6. Credentials and external spending limits

| Secret | Where it lives | Control outside the agent |
|---|---|---|
| OpenAI key | `automaton.json` in the volume, mode 0600 | Dedicated OpenAI **project** and key. **Prepaid balance of a few dollars with auto-recharge off.** Also set the project budget and model restrictions in the console. Check in the console which limits are hard caps. |
| Conway API key | `config.json` in the volume, mode 0600 | Never add credits. Zero balance means paid Conway calls fail. |
| Wallet private key | `wallet.json` in the volume, mode 0600, plaintext | **Never fund it.** Treat it as disposable for the test. Base RPC is blocked at egress. |
| Your creator address | Public. Use an existing address; no key needed. | – |

- On the iPad, keep keys in a password manager. Paste them only into the SSH
  session. Never put them in GitHub, notes, or this chat.
- On the VPS, secrets exist only inside the Docker volume. The compose file
  and the repo carry placeholders only (`.dockerignore` also excludes
  `deploy/config/*.json`).
- **Kill switch:** revoking the OpenAI key and the Conway key in their web
  consoles stops all spend, even if the server is compromised.

## 7. Deployment plan (isolated, non-root Docker on a small VPS)

### Host
- 1 vCPU, 2 GB RAM, 20 GB+ disk, Ubuntu 24.04 LTS. Most budget providers
  charge roughly $4–7 a month; check current prices.
- Managed from the iPad with Termius or Blink Shell. The provider's web
  console (in Safari) is the fallback.
- Hardening:
  - non-root sudo user, SSH key login only, root and password login disabled
  - `ufw` with default-deny inbound and only SSH allowed
  - `unattended-upgrades`
  - Docker Engine from Docker's own apt repository

### Containers (`deploy/compose.yaml`, `deploy/Dockerfile`, `deploy/egress/`)
- **automaton:**
  - uid 10001, read-only root filesystem, `cap_drop: ALL`,
    `no-new-privileges`
  - 0.5 CPU, 768 MB RAM with no swap, 128 processes, 64 MB `/tmp`
  - no published ports, `restart: "no"`
  - default command `--status`, so starting it never starts the agent loop
- **network:** the agent sits only on an `internal: true` network. Its only
  way out is the `egress` proxy, which allows CONNECT on port 443 to
  `api.openai.com` only (`deploy/egress/allowlist`). Node honours
  `HTTPS_PROXY` through `NODE_USE_ENV_PROXY=1` (supported on Node 22.22).
- **Verified in this session**, on a test build without the apt packages:
  - runs as uid 10001
  - `/app` and `$HOME` are read-only; only the state volume is writable
  - no `.git` in the image
  - the SQLite native module loads
  - `--version` and `--status` work and leave the volume empty
  - an internal-network container can't reach OpenAI, Base RPC or Conway
- **Not verified here:** the `apt-get` layer (`tini`, `git`) and the tinyproxy
  build, because this sandbox blocks the Debian and Alpine mirrors.

### Persistent storage
Named volume `automaton_state` at `/home/automaton/.automaton`. It holds:
`wallet.json`, `config.json`, `automaton.json`, `heartbeat.yml`, `state.db`
(turns, tool calls, policy decisions, spend), `SOUL.md`, and `skills/`.

### Lifecycle (each starred step needs your explicit approval)
| # | Step | Command |
|---|---|---|
| 1 | Clone `custom` to `/opt/automaton` and build images | `docker compose -f deploy/compose.yaml build` |
| 2* | Create the wallet | `docker compose run --rm automaton --init` |
| 3* | Provision the Conway key (creates a Conway account) | Temporarily add `^api\.conway\.tech$` to the allowlist, then `docker compose run --rm automaton --provision` |
| 4 | Remove the Conway allowlist line and restart egress | – |
| 5 | Copy the reviewed `automaton.json` and `heartbeat.yml` into the volume (mode 0600) | – |
| 6 | Check the configuration | `docker compose run --rm automaton --status` |
| 7* | Single controlled run | `docker compose run --rm automaton --run --max-cycles 1` (after the safe-mode patch). Ctrl-C triggers the graceful SIGINT shutdown. |

### Logs and status
- **Runtime log:** `docker compose logs -f automaton` (JSON, rotated at
  5 × 10 MB).
- **Egress log:** `docker compose logs egress` records every outbound attempt,
  including denied ones. It's the best audit trail.
- **Status:** `docker compose run --rm automaton --status`; creator CLI via
  `--entrypoint node automaton /app/packages/cli/dist/index.js status|logs`.
- **Resources:** `docker stats`.

### Backups
1. `docker compose stop automaton`. A consistent SQLite copy needs a stopped
   writer.
2. `docker run --rm -v automaton_state:/s:ro -v /opt/automaton-backups:/b <image> tar czf /b/state-$(date +%F).tgz -C /s .`
3. Encrypt it (`age -p`), because the archive contains keys. Download it with
   Termius SFTP to the iPad's Files app. Keep 7.
4. Restore once as a drill: stop, untar into an empty volume, `--status`.

### Emergency shutdown (fastest first)
1. `docker compose stop automaton`: SIGTERM, then the graceful shutdown
   handler (`index.ts:391`).
2. `docker compose kill automaton`
3. `docker compose down`: this also removes the egress proxy, so no network.
4. Revoke the OpenAI and Conway keys in their web consoles.
5. Power off the VPS from the provider's console.

Nothing restarts on its own (`restart: "no"`). The volume survives every step
above, so the configuration can be recovered.

### Running continuously later (separate approval)
Requires a reviewed controlled run first. Then: `restart: unless-stopped`,
re-enable selected heartbeat tasks, widen the tool deny list only by explicit
decision, and keep provider-side caps in place.

## 8. Decisions needed before anything is created
See the approval list in the chat. Nothing in sections 5–7 has been executed.
