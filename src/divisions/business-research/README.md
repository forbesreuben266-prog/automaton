# Business Opportunity Research division — Phase 0

Offline, deterministic skeleton. It verifies and scores research that is
**supplied to it**; it does not gather research, call models or act.

## What exists

| Module | Purpose |
|---|---|
| `validation.ts` | Strict parsers: unknown fields, wrong types, missing values are rejected, never defaulted |
| `sources.ts` | Source snapshots (metadata + text, integrity SHA-256 over both) and labelled claims; size limits |
| `citations.ts` | Quote verification against snapshots; number tracing; origin groups; evidence grades A–D |
| `finance.ts` | Assumptions with units and basis; three scenarios in integer minor units |
| `scoring.ts` | Weighted 0–100 score, separate confidence, hard gates, verdict |
| `report.ts` | Full report validation; Markdown rendering (final refuses invalid; draft marks problems and withholds the verdict) |
| `proposals.ts` | Inert proposal queue: stores, lists, records decisions; cannot execute |
| `run-budget.ts` | Per-run budget contract; the only model port always refuses |
| `untrusted.ts` | Escaping of untrusted text for output |

## Integrity, validation and labelling

- **Snapshot edit-check hash:** `integritySha256` (shown in reports as
  "edit-check SHA-256") is SHA-256 of the JSON array
  `["automaton/business-research/snapshot/v1", id, url, publisher, title,
  publishedAt, retrievedAt, originId, derivedFromSnapshotIds,
  independenceVerified, independenceNote, content]`. Editing any field
  (including dates or the independence flag) without re-creating the
  snapshot fails verification.
  **The stored hash alone is not tamper protection or authentication.**
  Verification compares the hash with the snapshot's own fields, so anyone
  able to edit a snapshot can recompute the hash and replace both. It
  detects accidental or naive later edits only, and proves nothing about
  who created the snapshot or whether the source is genuine. Trusted tamper
  detection requires a reference retained outside the division (e.g. a
  hash list recorded by the operator at collection time, or a keyed MAC
  whose key the division never sees); that is a Phase 1 design item.
- **Quote verification is not truth:** "verified"/"supported" means only
  that each quoted passage appears in the supplied snapshot. It does not
  establish that the source or the claim is true or relevant. Every report
  states this in a legend.
- **No verdict from an invalid report:** `validateReport` returns a
  discriminated result; `score` (verdict, total, confidence, gates) is
  `null` whenever `ok` is false, and TypeScript only allows reading it as a
  score after checking `ok`. Draft and final rendering withhold the verdict,
  score and confidence accordingly.
- **Internal helpers are not exported:** the edit-check hash function and
  `deepFreeze` inspect objects without validating them, so they are
  module-internal (not in the public API). Proxy objects can still run code
  while the validators inspect them; these checks are not a sandbox.
- **Every exported function re-validates:** `verifyClaims`, `gradeEvidence`,
  `gradeEvidenceSets`, `originGroups`, `calculateScenario(s)` and
  `scoreOpportunity` parse their inputs with the strict schemas (including
  integrity hashes and size limits) and recompute evidence; a
  caller-supplied verification result is never accepted.
- **Size limits:** 500,000 characters per snapshot, 5,000,000 in total, 200
  snapshots, 2,000 claims, 20 citations per claim; arrays are refused before
  any element is read.
- **Hostile input values:** values are type-checked before use; a
  non-string is never converted (`toString`/`valueOf`/`Symbol.toPrimitive`
  are not called) and error messages name only its type. Objects and arrays
  with getters/setters are refused unread. A malformed budget outcome is
  charged the worst case.
- **Proxy objects can't be blocked in-process:** their traps run when the
  validator inspects them (e.g. `Object.getPrototypeOf`, listing keys).
  The validator reads each field once and builds a frozen plain copy, so a
  Proxy can't change data after validation, but it can run code while
  being validated. Only process isolation (below) contains that.
- **Report labelling:** estimates are marked as derived figures (also where
  they feed assumptions); free-text fields (title, brief, competitor
  descriptions, gate notes, experiment text, missing information) are
  marked as unverified free text; each scenario shows its own formulas and
  horizon; drafts withhold verdict, score and confidence.
- **Hard gates** must cite claims, and a matching quote never establishes
  relevance. Each gate has a defined relevance criterion (`HARD_GATES`); a
  gate shows **PASS** only with grade A/B evidence *and* an operator
  relevance assessment recorded against that criterion. Otherwise it shows
  **CITED — RELEVANCE UNVERIFIED** (grade A/B, not assessed), **WEAK**
  (grade C: one stale or undated origin) or **UNVERIFIED** (no
  quote-verified evidence); each of these caps the verdict at "watch".
  An assessment lists the exact claim ids it covers (`assessedClaimIds`;
  order-insensitive, duplicates rejected); if they differ from the gate's
  cited claims the gate stays CITED — RELEVANCE UNVERIFIED ("assessment
  covers different evidence"). Each gate line also states its origin count
  and whether independence was checked.
  Relevance assessments are operator judgements recorded as data. Gates
  never affect confidence, which comes only from the criteria's evidence
  grades.

## Source independence

A different publisher name proves nothing. Each snapshot records an
operator-assigned `originId`, any snapshots it repeats
(`derivedFromSnapshotIds`) and whether independence was actually checked
(`independenceVerified`, with a required `independenceNote`).

- Snapshots form one origin group (transitively) when they share an
  `originId`, are linked by `derivedFrom` (either direction), share a
  **canonical URL**, or have **identical text** (SHA-256 of the
  whitespace/Unicode-normalised content). Merging only ever lowers the
  independent-origin count, so duplicate snapshots or citations can't
  inflate a grade or pass a gate.
- URL canonicalisation is conservative: http/https are treated as the same
  source, the host is lowercased, a trailing dot and the default port are
  dropped, the fragment is removed, and the URL parser's own normalisation
  applies (non-ASCII percent-encoded, `.`/`..` segments resolved);
  encodings it leaves alone (e.g. `%7E` vs `~`) stay distinct, so in that
  rare case duplicates are not merged and the content fingerprint is the
  backstop. The path (case, trailing slash), every query parameter
  (in order), `www.`/subdomains and non-default ports are kept, so distinct
  pages are never merged by broad heuristics.
- Identity conflicts fail closed: if snapshots share a canonical URL or
  identical text but declare different origins, they count as one origin
  whose independence is unverified (whatever their flags say), and the
  report warns about it.
- Only groups whose independence was checked count towards "2+ independent
  sources". Unchecked groups add nothing; if all evidence is unchecked it
  counts as one source.
- Scores above 3, evidence grade A/B and confidence use only that count.
- Reports show "N of M (independence unverified)", an UNVERIFIED
  INDEPENDENCE flag per criterion, a warning per unchecked snapshot, and
  each source's origin and independence status.
- Independence itself is an operator judgement recorded as data; the code
  can't verify ownership or syndication.

## Inert by design

- **Proposals:** `ProposalQueue` stores, lists and records decisions. Approval
  sets the status to `approved_not_executed`; there is no "executed" status,
  no execute/run/send method, no callback field, and recording a decision
  calls no network, process, file or timer API (tested with throwing spies).
  Proposal text is stored verbatim and never interpreted. The operator
  carries out any approved action outside this system.
- **Run budget:** `RunBudgetController` lives in memory, in one process. It
  shares nothing between instances and starts from zero after a restart; it
  has no save/load methods. It is an extra, smaller cap on top of the
  existing durable SQLite budget (`InferenceBudgetTracker`) and global caps,
  never a replacement for them.
- **Model interface:** `DISABLED_MODEL_PORT` is frozen, has only `complete`,
  and always rejects with `InferenceDisabledError` without touching any
  budget or capability. It can't be replaced at runtime.
- **Inputs:** objects and arrays with getters/setters are refused unread, so
  parsing caller data runs no caller code (Proxies are a known exception).

## Boundaries

Enforced by tests (`boundaries.test.ts`, `inert-guarantees.test.ts`):
- **Syntax-tree scan** of every division file (TypeScript compiler, an
  existing dev dependency): imports only sibling modules and `node:crypto`;
  no `require`, dynamic `import()`, `import.meta` or `with`; no reference to
  network, process, filesystem, global-scope, dynamic-code, timer or clock
  names (`fetch`, `process`, `globalThis`, `Reflect`, `Proxy`, `Function`,
  `eval`, `constructor`, `prototype`, `setTimeout`, `Date.now`,
  `Math.random`, …), whether written directly, as a constant string, by
  string concatenation, or via bracket access with a constant name. A
  self-test proves the scanner flags each of these patterns.
- No agent tool names (read from `src/agent/tools.ts`) and no
  payment/wallet/crypto/trading names appear in the division.
- No file outside the division imports it, by any relative specifier or by
  name; no other division exists; the public API is a fixed, reviewed list.
- **Runtime:** a full validate/render/queue/budget/model-port run, with
  `child_process`, `http`, `https`, `net`, `tls`, `dgram`, `dns`, `fs`,
  `fetch`, timers and every `process.env` read replaced by throwing or
  recording spies, makes no call and reads no environment variable.

**Static analysis is not a sandbox.** The syntax-tree scanner catches
*accidental* capability use: direct references, constant strings, simple
string building, reflection helpers, writes to shared built-ins, and
aliasing of `Date`/`Math`. It **does not prevent deliberate obfuscation**.
Code written to evade it can still reach any capability of the Node
process: for example by obtaining `Function` through objects passed in, by
building names with logic the scanner can't evaluate, or by using the
reflection that `validation.ts` is allowed for refusing getters. Runtime
spies only observe the code paths the fixtures exercise and the entry
points listed. These tests stop regressions and honest mistakes; review of
every change is still required.

## Phase 1 prerequisite: OS-enforced isolation (not implemented)

Before Phase 1 runs any model or processes any real source text, the
division must run in a **separate process confined by the operating
system**, not just by these tests:
- no network access at all from the division process (model calls go
  through a separate, already-capped component outside it);
- read-only filesystem except one scratch/output directory; no access to
  `~/.automaton`, wallets, keys or the agent's database;
- no secrets in its environment; unprivileged user; no ability to spawn
  processes; resource limits (CPU, memory, time);
- communication only through validated data (the schemas in this module).
Phase 0 does not implement this.

Documented only (not enforceable inside this module):
- Phase 1 inference must follow the contract below.
- Source text is untrusted. Phase 0 never interprets it; Phase 1 prompts
  must pass it as data and must not give the model tools.

## Inference contract for Phase 1 (not implemented)

Before **every** model attempt, including retries:
1. Compute the worst-case cost with the existing router estimate
   (`estimateCostCentsUpperBound`, full `max_tokens`).
2. `RunBudget.authorize({ label, estimatedCostCents })`; if refused, stop.
3. Send only through the existing `InferenceRouter` / `InferenceSpendGate`,
   which enforce safe mode, trusted pricing, strict model routing and the
   global per-call, hourly, daily and session caps. The run cap is extra and
   can never exceed `MAX_RUN_BUDGET_CENTS` (the safe-mode daily maximum).
4. `RunBudget.settle` once: actual cost on success; full estimate if the
   provider may have billed a failure; zero only if nothing was sent.
5. Model output is parsed with these strict schemas and verified like any
   other input; it is never executed and never selects tools or URLs.

Not in Phase 0: collector/web access, scheduler, model calls, persistence,
CLI, trading anything, or any way to execute a proposal.
