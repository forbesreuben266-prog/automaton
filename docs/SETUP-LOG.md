# Automaton setup log

Record of inspecting, building and testing Conway Research's Automaton.
Nothing in this log launched the agent, created a wallet, provisioned an API
key, funded anything or touched a blockchain.

## Upstream source

- Repo: https://github.com/Conway-Research/automaton
- Commit inspected: `d8f816881fd24b6f5e3d616e59edec387a447667` ("it's beautiful")
- Version: `@conway/automaton` 0.2.1, MIT licence
- About 39k lines of TypeScript in `src/`, plus a small creator CLI in `packages/cli/`

Fork: https://github.com/forbesreuben266-prog/automaton
- `main`: kept identical to upstream. Only ever fast-forward it from Conway.
- `custom`: all of our changes, including this log (`docs/SETUP-LOG.md`).

## Build environment (Claude Code cloud session)

| Tool | Version |
|---|---|
| Node.js | 22.22.0 (upstream needs >= 20; CI tests 20 and 22) |
| pnpm | 10.28.1 (pinned by `packageManager`) |
| git | 2.43.0 |
| OS | Linux (x86_64) |

## Commands run and results

| Step | Command | Result |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | OK. Native `better-sqlite3` loads. |
| Typecheck | `pnpm run typecheck` | OK, 0 errors |
| Build | `pnpm run build` | OK. Produces `dist/index.js` and `packages/cli/dist/index.js` |
| Tests (upstream, unmodified) | `HOME=<throwaway dir> npx vitest run` | 63 of 64 files passed (1,614 tests, 0 failures). `context-hardening.test.ts` **hangs indefinitely**; see Fix 1. |
| Tests (`custom` branch, after Fix 1) | same | **All 64 files, 1,645 tests passed** in 112 s. Typecheck and build clean. |

Tests ran with `HOME` pointed at an empty throwaway folder, so they could not
read or write a real `~/.automaton`.

Install warnings, both harmless:
- "Failed to create bin ... automaton": the CLI package links to the runtime's
  `dist/`, which doesn't exist until after the build.
- "Ignored build scripts: bufferutil, utf-8-validate": these are optional
  WebSocket speedups.

## README vs. code: discrepancies found

1. **README says `npm install && npm run build`. Use pnpm instead.** The build
   script calls `pnpm -r build`, and `packages/cli` depends on
   `workspace:*`, which npm doesn't support. `package-lock.json` is a 757-byte
   stub. The DOCUMENTATION.md and the CI both use pnpm.
2. **DOCUMENTATION.md says a 403 in sandbox mode falls back to local
   execution.** The code (`src/conway/client.ts`) does the opposite, and
   refuses on purpose for security. The code is the safer behaviour.
3. **There is no `AUTOMATON_DIR` setting.** All state goes to
   `$HOME/.automaton` (see `src/identity/wallet.ts`). To isolate an instance,
   run it with a dedicated `HOME`.
4. **`--run` won't start without a Conway API key**, even with a
   bring-your-own OpenAI, Anthropic or Ollama key (`src/index.ts`). The key is
   provisioned for free by signing in with the agent's wallet (SIWE), but this
   creates a Conway account.

## Things that happen automatically on `--run` (review before launching)

- Creates a wallet if none exists: `~/.automaton/wallet.json`, holding a
  plaintext private key with file mode 0600.
- Registers the automaton's identity with `api.conway.tech`. This is one-time,
  and the record can't be changed afterwards.
- **Bootstrap top-up:** if credits are below $5 and the wallet holds at least
  $5 USDC on Base, it **automatically spends $5 USDC** on Conway credits.
  There's no prompt. If the wallet is unfunded, this is a no-op.
- Starts the heartbeat. By default it runs:
  - a ping every 15 minutes
  - a credits check every 6 hours
  - a USDC check every 5 minutes, which can wake the agent to top up
  - an **update check every 4 hours** (the agent has a `pull_upstream` tool)
  - a health check every 30 minutes
  - a **social inbox poll every 2 minutes** against `social.conway.tech`,
    which is untrusted outside input
- **Local mode:** when `sandboxId` is empty, which is the case outside a
  Conway sandbox, the `exec` tool runs shell commands **directly on the host**
  with `child_process.execSync`, as the user running the process.

## Default treasury limits (`DEFAULT_TREASURY_POLICY`)

| Limit | Default |
|---|---|
| Max single transfer | $50 |
| Max hourly transfers | $100 |
| Max daily transfers | $250 |
| Minimum reserve | $10 |
| Max x402 payment | $1 (domains: `conway.tech`) |
| Max daily inference | **$500** |
| Quarantine transfers above | $10 |
| Max children | 3 |

These defaults are far too generous for a first test. Proposed first-run
values come later, at the launch-review step.

## Fix 1: token counter hangs on long unbroken text (`custom` branch)

**Symptom:** `src/__tests__/context-hardening.test.ts` never finishes.

**Root cause:** `createTokenCounter()` in `src/memory/context-manager.ts` runs
`js-tiktoken` BPE over the whole text. BPE cost is quadratic in the length of
a single whitespace-free run.

| Input | Time before fix |
|---|---|
| 5,000 × `x` | 2.5 s |
| 20,000 × `x` | 36 s |
| 500,000 × `x` (from the test) | hours, extrapolated |
| 20,000 chars of normal prose | 3 ms |

**Why it matters beyond the test:** turn token estimates use the full,
untruncated tool output. One tool result containing a long base64 blob,
minified JS, or a hex dump would freeze the agent's process, heartbeat
included.

**Fix:** any run of 64+ non-whitespace characters is removed before encoding
and estimated at length ÷ 4 tokens. That matches the length ÷ 4 floor that
`estimateTokens()` already applies. All other text is still encoded exactly.

**Trade-off:** base64-like runs are now estimated at length ÷ 4, which is the
same as upstream's existing fallback. Real BPE on base64 is closer to
length ÷ 2.5, so context budgets may slightly under-count such content.

| Input | Time after fix |
|---|---|
| 500,000 × `x` | ~0.05 s |
| 500,000 chars of normal prose | ~75 ms |
| 500,000 chars in 63-char chunks (worst case just under the cutoff) | ~3 s |

Regression tests were added to `src/__tests__/memory/context-manager.test.ts`.
This is a good candidate to offer upstream as a PR.
