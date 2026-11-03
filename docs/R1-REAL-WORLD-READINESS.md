# R1: real-world research readiness

R1 prepares the business and trading research systems to accept real-world
information in a later milestone, without connecting to any source. The new
module `src/research-readiness/` validates provenance and data, and explains
condition by condition whether a record would be acceptable as real-world
research input.

> **Nothing here enables real-world input.**
> - Readiness results are never approvals: `approvedForRealWorldUse` is
>   always `false`, and `assertRealWorldInputApproved` refuses every result.
> - The existing engines are unchanged and still accept only fictional data.
>   For example, the trading parser refuses any `source.kind` other than
>   `fictional`.
> - The module is offline and pure. It does no network, file, process, clock,
>   model, trading or Docker access, and nothing outside it (tests excepted)
>   imports it.
> - "Verified" means the operator says they checked it independently. R1
>   records and cross-checks these statements; it cannot confirm them.

## 1. Source trust and provenance (`provenance.ts`)

A **source record** has these fields: `id`, `sourceClass`, `publisher`,
`publisherId`, `originId`, `title`, `locator` (URL or document reference,
recorded and never requested), `retrievedAt`, `publishedAt` (stated date, or
explicitly `not_stated`), `contentSha256` (of the exact retrieved text),
`derivedFromSourceIds` and `verification`.

| Source class | Meaning | Enforced |
|---|---|---|
| `primary` | The publisher produced the evidence | `originId` = `publisherId`; derived from nothing |
| `secondary` | Reports someone else's evidence | `originId` (if known) is not the publisher |
| `unverified_claim` | Origin can't be traced | Its origin can't be marked verified |

`verification` states each of five aspects explicitly: `content_integrity`,
`publisher_identity`, `publication_date`, `origin` and `independence`.

| Status | Basis required | Also required |
|---|---|---|
| `verified` | `independent_check` | Who checked, and when (between retrieval and `asOf`) |
| `asserted` | `source_self_statement` or `operator_statement` | Note |
| `unverified` | `none` | Note |

Decisions:

- **A source's own statement is never verification.** Marking it `verified`
  is refused. Words such as "official" or "verified" in a title or publisher
  name change nothing.
- **Missing, unknown or contradictory fields are refused.** This includes
  future retrievals, publication after retrieval, impossible dates, malformed
  hashes, URLs with credentials, hidden control or bidi characters, getters,
  and duplicate or dangling ids.
- **"Independently verified"** means content, publisher identity and origin
  are all verified, and the source is not an `unverified_claim`.
- `contentMatches(record, text)` re-checks the recorded SHA-256. It detects
  edits; it does not authenticate the source.

## 2. Business evidence readiness (`business.ts`)

A bundle contains `asOf`, `maxSourceAgeDays`, `sources`, `claims` (each a
fact, estimate, assumption or speculation), operator-recorded `conflicts`
and `missingInformation`.

| Condition | Fail | Unverified |
|---|---|---|
| `source_provenance` | | A cited source is not independently verified |
| `source_attribution` | A fact cites no source, or only unverified claims; a "derived from sourced" figure cites nothing | |
| `evidence_freshness` | A cited source is older than `maxSourceAgeDays` | A publication date is not stated, or only asserted |
| `conflicting_claims` | A recorded conflict is unresolved | |
| `confirmed_claims_substantiated` | An operator-confirmed fact lacks qualifying evidence | |
| `financial_claims_supported` | | A figure is labelled **UNSUPPORTED FINANCIAL ESTIMATE** |
| `missing_information` | A recorded gap is blocking | |

How claims are handled:

- **No automatic promotion.** A claim becomes a `confirmed_fact` only when
  all of these hold:
  - the operator confirmed it;
  - it cites a verified primary source, or two verified secondary sources
    with different, verified-independent origins;
  - every cited source is fresh;
  - no unresolved conflict involves it.

  A well-supported claim the operator has not confirmed stays unconfirmed.
- **The financial label must match the claim kind.** A fact must be
  `sourced`. An estimate is `derived_from_sourced` or `unsupported_estimate`.
  Assumptions and speculation are `unsupported_estimate`. Any mismatch is
  refused.
- **Conflicts are recorded by the operator.** They are not detected
  automatically.

## 3. Market-data readiness (`market-data.ts`)

A record is one instrument's daily bars. It contains a source record, the
instrument, the price basis (`raw` or `adjusted`), the corporate actions, the
expected session calendar and the bars.

These inputs are refused as ambiguous or unsupported:

| Area | Rule |
|---|---|
| Currency | US stocks are priced in USD. UK stocks use `GBP` or `GBX` exactly (`GBp`, `p` and `pence` are refused). Forex prices are quote currency per one unit of base, stated as `quote_per_base`, with the price currency equal to the quote currency; inverted quotations are refused. No crypto. |
| Exchange and time zone | XNYS or XNAS (America/New_York); XLON (Europe/London); forex closes at 17:00 New York. Anything else is refused. |
| Calendar | Weekday sessions from 2007 onward, each with a local close time. Early closes are allowed up to the standard close. |
| Price basis | Adjusted prices must state the method (splits, or splits and dividends) and the date they are adjusted through. Forex must be raw and has no corporate actions. Corporate actions must fall within the data period. |

These conditions are assessed:

| Condition | Fail | Unverified |
|---|---|---|
| `source_provenance` | The source is an unverified claim | The source is not independently verified |
| `retrieved_after_data` | The source was retrieved before its last bar | |
| `timestamps_unique_and_ordered` | Duplicate or out-of-order bars | |
| `bars_match_calendar` | A bar is not a calendar session, or is stamped at the wrong UTC close (time-zone or daylight-saving error) | |
| `no_missing_bars` | A calendar session has no bar | |
| `calendar_verified` | | The calendar is asserted or unverified |
| `prices_consistent` | low > open/close, or high < open/close | |
| `prices_not_stale` | 3 or more consecutive unchanged bars | A single unchanged bar, or zero volume |
| `currency_convention` | Never (ambiguous currencies are refused before assessment); the accepted convention is stated | |
| `corporate_actions` | An action type whose effect is not modelled ("other") | The completeness of the action list is not verified |
| `price_basis` | Raw prices span a split; the adjustment ends before the last bar | Dividends are not reflected (raw prices, or adjusted for splits only) |

UTC closes use the US daylight-saving rules from 2007 and the UK/EU rules.
The tests check the conversion against hand-written examples on both sides of
each transition.

## 4. Fail-closed results (`readiness.ts`)

- **Overall status:** `refused` (malformed input, which is not assessed), then
  `not_ready` (any fail), then `unverified`, then `ready_for_operator_review`
  (every condition passes). An empty assessment is never "ready".
- **Contents:** each result is frozen and deterministic. It includes the
  SHA-256 of the validated input and the fixed notice that nothing is
  approved.
- **Rendering:** `renderReadiness` produces Markdown and escapes all supplied
  text.

## 5. Running the R1 tests

```bash
./node_modules/.bin/vitest run src/__tests__/research-readiness
```

All test records are fictional. Organisations, symbols and prices are
invented, and URLs use the reserved `example.org` domain.

## 6. What still requires real-world verification

R1 checks that records are complete and consistent. It cannot establish any
of the following:

- that a source is genuine, that the publisher is who it claims to be, or
  that an operator's "verified" statement is true;
- that a session calendar, holiday list or early-close time is correct;
- that a corporate-action list is complete, or that adjusted prices were
  calculated correctly;
- that prices are accurate, beyond internal consistency and staleness
  heuristics. Survivorship bias, delistings and symbol changes are not
  addressed;
- that business conflicts exist. R1 only checks the ones the operator
  recorded; it does not detect them.

## 7. Remaining requirements before VPS deployment and real data ingestion

Each item needs its own approved milestone.

1. **Ingestion design.** Define read-only, operator-triggered import of
   specific licensed sources, with retrieval logging and content hashing at
   import. Readiness checks must be mandatory at that boundary.
2. **An approval step.** Define a human approval that records who approved
   which readiness result (by input SHA-256) and when. Only that step may
   replace `assertRealWorldInputApproved`. The engines would then accept
   approved inputs through a separate, reviewed path.
3. **Data licensing and terms.** Confirm that each data vendor's licence
   permits research use and storage.
4. **Calendars.** Obtain authoritative exchange calendars, or have a person
   verify them for each period.
5. **Sandbox and hosting.** The M1/M3 blockers stay active. Deployment
   needs the hosting plan reviewed, secrets handling, network egress limited
   to approved hosts, and monitoring. No Docker socket access is needed or
   allowed.
6. **No trading.** Broker connections, real orders, live trading, wallets
   and spending stay out of scope.
