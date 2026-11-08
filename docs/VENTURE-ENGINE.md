# Automaton venture engine (first working loop)

`src/venture-engine/` runs the core loop: **opportunity -> venture -> experiment ->
evidence -> decision -> repeat**, under hard limits. Business types are
plug-in modules (`VentureKind`). The first module is `digital-product`.
Services, software, e-commerce and, later, trading plug in through the same
interface without changing the core.

Each cycle:
1. Applies the owner's approval decisions.
2. Decides **SCALE / IMPROVE / HOLD / KILL** for each active venture, from its
   latest evidence.
3. Runs the improvement iterations: plan -> build -> verify -> simulated
   evaluation.
4. Generates, scores and selects new opportunities while there is room, and
   builds their first experiment.

## Evidence

| Kind | Where it comes from | What it can decide |
|---|---|---|
| `simulated` | The engine's own estimates, such as the quality score. **Not customer or financial data.** | IMPROVE, HOLD (with a launch request), or KILL of an unlaunched draft (archived, so reversible) |
| `actual` | Only what the owner records with `record`, for a venture launched with approval, including where the numbers came from | SCALE (real sales with revenue above cost), IMPROVE (conversion below 2%), HOLD (not enough data), KILL (needs approval) |

Simulated evidence can never produce SCALE. The dashboard's totals count
actual results only.

## What the engine never does

It never publishes, spends money, uses paid models on its own, acts on external
accounts, shuts down a launched venture, or trades. Each of those becomes an
**approval request**. When you approve one, you perform the action yourself,
and the engine records the outcome.

**Limits:**
- 5 active ventures;
- 2 new ventures per cycle;
- 3 iterations per venture;
- 10 cycles per run;
- a spending limit fixed at $0.

## Isolation and data

- **Assets:** each experiment's assets go into its own private folder,
  `~/.automaton-ventures/ventures/<venture>/<experiment>/`. Builders can write
  only plain file names there: no paths, no links, never overwriting, at most
  20 files of 512 KB each.
- **What is generated:** static files only. Nothing generated is executed.
- **Isolation:** the module imports only Node built-ins. A test enforces that
  it doesn't import, and isn't imported by, the autonomous agent, the research
  or sandbox code, or the personal agent.

## Model, evaluation and controls

- **Model interface (`model.ts`):** provider-independent, used for ideas,
  content and critiques.
  - Providers: `none` (the default, deterministic), `ollama` (local,
    loopback only) and `claude` (paid; see "Claude API" below). Claude is
    used only in a run you start with `run --paid` after setting
    `paidUsageApproved`; scheduled runs never use it.
  - Every answer must parse as JSON, pass a validator and fit size limits;
    otherwise the engine falls back to its deterministic behaviour and logs
    why.
  - Each cycle has a model-call budget.
- **Evaluation (`evaluate.ts`, always `simulated`):** each draft is scored
  on:
  - completeness (checks passed);
  - specificity (concrete points, not placeholders);
  - fit to the audience's problem;
  - originality against the portfolio;
  - the opportunity estimate;
  - a model critique, when a model is configured.

  The breakdown and the weaknesses are stored with the evidence and fed into
  the next iteration's plan.
- **Controls (`control.ts`):**
  - `stop [reason]` / `resume`: no cycle runs while STOP is set, and a running
    run ends after its current cycle.
  - One run at a time (a lock file).
  - `config.json` limits can be lowered but never raised above the hard caps.
  - `scheduled-run` does nothing unless `schedule.enabled` is `true`, and it
    respects a daily cycle budget. `schedule-unit` prints a systemd user timer
    for you to review and install; the engine installs nothing.
- **Respecting a "no":** after you deny a request, it isn't repeated until
  something new happens.

## What a real launch and real revenue measurement need

Each launch request lists these, and a `launch-checklist.md` is built with
every draft:
- hosting you control for the static page;
- an email or pre-order collection method you control, with a privacy notice;
- a payment or pre-order link, if selling;
- terms of sale and a refund policy;
- the finished deliverable, or a clearly labelled pre-order;
- visitor and signup counts you can read.

You record results with `record ... --source`. The engine has no connectors:
publishing, payments and analytics are actions you take, each with your
approval.

## Commands

    alias ve='node ~/automaton/dist/venture-engine/main.js'
    ve run 3                 # 1 to 10 cycles, offline
    ve status                # portfolio
    ve show <venture>        # experiments, checks, evidence, decisions, asset folder
    ve approvals             # pending requests
    ve approve <id> | ve deny <id>
    ve record <venture> --source "payment provider, 2026-11-10" --visitors 200 --signups 9 --sales 2 --revenue 18
    ve dashboard             # writes ~/.automaton-ventures/dashboard.html (private)
    ve stop "reason" | ve resume | ve config | ve scheduled-run | ve schedule-unit
    ve run 1 --paid          # Claude only, when approved; prefer scripts/venture-supervised-e2e.sh
    ve ledger                # local paid-usage ledger (an estimate, not a provider cap)
    ve claude-check          # free (no tokens): key accepted and model available? Also run by the supervised script

## Claude API (prepared; not active)

Nothing here is active until you approve paid usage, create the key and set
the config yourself.

**Limits in code**
- Total budget £10, fixed in `ledger.ts`. A ledger's cap can be lowered,
  never raised. Optional per-run cap: `model.maxGbpPerRun`.
- **The ledger is the engine's own estimate, not a provider-enforced cap.**
  The real cap is a spend limit, or prepaid credit only, in the Anthropic
  Console.
- Before each request, the maximum cost is written to `ledger.json` (fsync):
  - input is bounded at 1 token per UTF-8 byte plus 1024;
  - output is bounded by `max_tokens`, which includes thinking;
  - list price × £1 per $1 × 1.2 VAT.
- Each change takes an exclusive lock, is fsynced (including the folder) and
  is appended to `ledger.journal`. If `ledger.json` disappears while the
  journal exists, paid runs are refused rather than starting again from £0.
  Someone with your account can still delete both files or use another
  data folder, so the Console limit is what actually enforces the cap.
- Requests are refused when that would pass the cap, or when the cost can't
  be bounded (unknown model, bad `max_tokens`).
- After a response, the entry is settled from the reported usage.
- After a timeout, error, crash or missing usage, the full reservation stays
  counted.
- Each request:
  - only Opus, Sonnet or Haiku 5.5 (known prices);
  - 0 retries, a 10–300 s timeout and `max_tokens` up to 4000, with effort
    `low`;
  - no tools, caching or temperature.
- Only a complete answer (`end_turn`) is accepted; anything else fails
  closed. The answer must still pass the JSON validators.
- Failures are reported as HTTP status, Anthropic error type, request id
  and a sanitised explanation (for example: rejected key, model not
  available, insufficient credit, rate limit, network error). Headers,
  request contents and anything shaped like a key are never shown.
- One paid request at a time. After any failed or ambiguous request, every
  later paid request in that run is refused.
- The SDK is pinned to `https://api.anthropic.com` with logging off. A paid
  run refuses to start while any `ANTHROPIC_*` environment variable is set:
  the SDK reads them for the base URL, extra headers, profiles and
  telemetry.
- Key: `~/.automaton-ventures/anthropic.key`, your own file, mode 600. It is
  never printed, logged or stored elsewhere. Don't put it in the repository
  or the environment.

**Network**
- Only the engine process (`main.js`) talks to one host,
  `api.anthropic.com:443`, through the pinned SDK.
- Model output is data. It becomes text files that are validated and never
  executed. It has no tools and no network access.
- Research sandboxes stay `network none`. No other change is needed.
- To narrow egress, run the engine as a dedicated user and allow only that
  user's outbound 443 to Anthropic's published API addresses (nftables
  `meta skuid`). Check the current addresses on Anthropic's IP-addresses
  documentation page.

**Deploy to the existing VPS (plan only; needs your approval)**
1. Back up the data:
   `tar -C ~ -czf ~/ve-backup-$(date +%F).tgz .automaton-ventures && chmod 600 ~/ve-backup-*.tgz`.
2. In `~/automaton`:
   - `git fetch origin venture-engine`;
   - `git checkout <reviewed commit>`;
   - check `git rev-parse HEAD`;
   - `pnpm install --frozen-lockfile && pnpm build`.
3. In the Anthropic Console:
   - create a separate workspace and key;
   - set a spend limit of at most the equivalent of £10, or buy only that
     much prepaid credit.
4. Create the key file: `install -m 600 /dev/stdin ~/.automaton-ventures/anthropic.key`
   - paste the key, press Enter, then Ctrl-D;
   - don't use `echo`, which would put the key in shell history.
5. In `config.json`:
   - `provider` `"claude"`, with `name` set to the model;
   - `paidUsageApproved` `true` and `maxGbpPerRun` (for example `1`);
   - `schedule.enabled` stays `false`.
6. Optional: add the egress rule above.
7. Run `scripts/venture-supervised-e2e.sh --max-gbp <approved> --i-approve-paid-usage`.

**Rollback**
1. `ve stop "rollback"`.
2. Set `paidUsageApproved` to `false`, or `provider` to `"none"`.
3. Revoke the key in the Console, then `shred -u ~/.automaton-ventures/anthropic.key`.
4. `git checkout 6b0e507f && pnpm install --frozen-lockfile && pnpm build`.
5. If needed, restore the backup:
   `tar -C ~ -xzf ~/ve-backup-<date>.tgz` (after moving the current folder aside).
6. Keep `ledger.json` as the record of spending, and remove any egress rule
   you added.
