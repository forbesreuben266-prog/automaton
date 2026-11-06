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

It never publishes, spends money, uses paid models, acts on external
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

## Commands

    alias ve='node ~/automaton/dist/venture-engine/main.js'
    ve run 3                 # 1 to 10 cycles, offline
    ve status                # portfolio
    ve show <venture>        # experiments, checks, evidence, decisions, asset folder
    ve approvals             # pending requests
    ve approve <id> | ve deny <id>
    ve record <venture> --source "payment provider, 2026-11-10" --visitors 200 --signups 9 --sales 2 --revenue 18
    ve dashboard             # writes ~/.automaton-ventures/dashboard.html (private)
