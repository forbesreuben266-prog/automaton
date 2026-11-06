# D9: operator-supplied historical data (DRAFT; nothing is enabled)

**Status: PENDING.** Today the research CLI accepts only datasets with
`"source": {"kind": "fictional", ...}` (`src/trading-research/dataset.ts`),
and refuses any other kind inside the sandbox. This draft describes what
would have to be decided and built before historical market data supplied
by the owner could be used. Nothing here changes that rule. Real data,
network access, live market data, agents, paid APIs and trading all stay
out of scope.

## 1. What would change

| Area | Today | Proposed (only after the decisions below) |
|---|---|---|
| Dataset `source.kind` | `"fictional"` only | `"fictional"` or `"operator-historical"` |
| Provenance | free-text label | required, structured fields (section 2) |
| Who supplies data | the operator writes fictional files | the operator places exported files on the VPS by hand (Termius SFTP); the VPS itself fetches nothing |
| Where data is parsed | only inside gVisor (research CLI) | unchanged; the host-side `check` stays advisory and never runs research code |
| Report wording | "FICTIONAL data only" banner | a historical banner naming the source, licence and limitations; still "hypothetical, not advice, nothing was traded" |
| Network | `none` | unchanged |

## 2. Provenance (required per dataset)

```
"source": {
  "kind": "operator-historical",
  "provider": "<who the data came from>",
  "retrievedAt": "<UTC time the operator downloaded it>",
  "retrievedBy": "operator",
  "licence": "<licence or terms name>",
  "licenceUrl": "<where the terms are published>",
  "redistribution": "none" | "permitted",
  "originalFileSha256": "<64 hex: the file exactly as downloaded>",
  "transformations": ["<each step from the original file to this dataset>"]
}
```

- `originalFileSha256` ties the dataset to the operator's downloaded file.
  The dataset's own canonical hash (`datasetSha256`) already identifies the
  validated content.
- Provenance is **operator-attested**: the system can record it and check
  its shape, but cannot verify where data came from.
- With `redistribution: "none"`, exports stay on the VPS and in the
  operator's own storage only. Nothing is committed to the public
  repository.

## 3. Licensing

- **D9.1:** the owner confirms, for each provider, that the licence allows
  this private, offline, non-commercial research use and storing copies on
  the VPS.
- Datasets, reports derived from them, and evidence containing them are
  never committed to the public repository. A repository test would refuse
  `operator-historical` files under `docs/` and `deploy/`.
- No scraping or automated download is in scope. The operator brings the
  files.

## 4. Data validation (inside the sandbox; the existing rules plus these)

- Every rule that applies today: daily bars, decimal text, ascending UTC
  times, high/low consistency, size limits (10 MB, 50,000 bars), exact
  keys.
- Plausibility checks that refuse with clear messages, never "fix" data:
  - no non-positive prices;
  - bar-to-bar jumps over a stated threshold must be declared in
    `transformations` (for example, an unadjusted split);
  - no duplicate dates;
  - gaps reported in the report;
  - `retrievedAt` must not be earlier than the last bar.
- Corporate actions: `adjustment` stays a declared value. The report states
  that adjustments, survivorship bias and data errors are the provider's
  and the operator's responsibility.

## 5. Security implications

- **Larger data, same isolation.** Historical files are larger and
  third-party-shaped, but they are still parsed only inside gVisor
  (network `none`, the existing limits), bound by approval hash and
  single-use approvals. The host never interprets them beyond the JSON
  shape check.
- **No new code paths outside the sandbox.** The change is to the research
  CLI's validation (`dataset.ts`, the report banner) and to the format
  check's messages.
- **Misuse risk.** Results on real data can look like trading signals.
  Reports keep the "hypothetical, not advice, nothing was traded" wording,
  and this decision does not cover live trading or paper trading against
  live data.
- **Confidentiality.** Licensed data may not be redistributable. Evidence
  folders are root-only today, and exports are owner-only. The policy above
  keeps the data out of git.
- **Code change.** Changing the research code changes the research image and
  the compiled research CLI. That means:
  - a new image build;
  - a new pinned image ID, which changes `ACCEPTED_DECISION_SCOPE.imageId`;
  - a governance-reviewed update to the decision scope;
  - a new E1-style validation run before routine use.

## 6. Tests that would be required

- A unit test for each new rule and message: missing or invalid provenance
  fields, an unknown licence value, a bad `originalFileSha256`, plausibility
  failures, and `retrievedAt` earlier than the last bar.
- `fictional` datasets keep working unchanged, so their hashes and reports
  stay identical.
- A repository guard: no `operator-historical` dataset under version
  control.
- An end-to-end test with a small, clearly synthetic file labelled
  `operator-historical`. Its banner and wording must appear in the report.
- Governance: the new image ID is accepted only with an updated decision
  record and passing evidence, as for M1/M3.

## 7. Decisions for the owner (each needs an explicit ACCEPT)

- **D9.1 Licences:** confirm that each provider's terms permit this use and
  storage.
- **D9.2 Provenance is attested, not proven:** accept that the provider and
  download details are operator-attested.
- **D9.3 Data quality:** accept that errors, adjustments and survivorship
  bias in third-party data are not detected beyond the checks in section 4.
- **D9.4 Confidentiality:** accept the rules on keeping data out of git and
  on owner-only exports.
- **D9.5 Image change:** approve building and pinning a new research image,
  and the decision-scope update this requires.
- **D9.6 Scope:** confirm that this covers offline backtests and validation
  only. It covers no paper trading on live data, no trading and no automated
  data fetching.

## 8. Rollout if accepted

1. **Offline:** change the research CLI rules, the format check and the
   tests, then review.
2. **VPS, with approval:** build the new image with `host-setup.sh`, record
   its ID, run the negative controls and trust evidence, and do one
   preflight.
3. **Governance diff:** update the decision scope's `imageId` with the new
   evidence, then review.
4. **VPS, with approval:** one validation run on a small, licensed or
   synthetic `operator-historical` file.
