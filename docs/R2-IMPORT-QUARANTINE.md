# R2: offline import and quarantine

R2 adds a controlled, offline way to bring externally supplied research data
into Automaton for review. The operator places a content file and an import
manifest in a local data root. The CLI checks both, binds the exact content
hash to the manifest and the R1 readiness result, and prints an auditable
review. Development uses fictional data only.

> **Safety.**
> - A successful validation does not authorize real-world use. There is no
>   approved state, no approval command and no activation switch.
> - Real-world data (`"dataOrigin": "real_world"`) is rejected.
> - Imported content is untrusted, whatever publisher it declares.
> - Nothing is fetched, written, moved, deleted or passed to the research
>   engines. The engines still accept only fictional data.
> - There is no network, Docker or model access, and no trading.

## 1. The import manifest (version 1)

Every field is required and nothing is defaulted. Unknown fields, duplicate
JSON keys, malformed values and unsupported options are rejected.

| Field | Rule |
|---|---|
| `importId`, `receivedAt`, `receivedBy`, `preparedAt` | Identity and timing. `preparedAt` must not be earlier than `receivedAt` |
| `dataType` | `business_evidence` (an R1 evidence bundle) or `market_data` (an R1 market-data record: US stock, UK stock or forex) |
| `dataOrigin` | `fictional`. `real_world` is rejected (not enabled) |
| `content` | `file` (a plain `.json` name in the same data root), `format: "json"`, `encoding: "utf-8"`, `sizeBytes` and `sha256` of the exact file |
| `supplier` | Who supplied the file, and the publisher it declares. Both are recorded as declared and confer no trust |
| `licence` | `licenceId`, `permittedUses`, `restrictions` and an R1-style `attestation` |

`permittedUses` must come from this fixed list: `internal_research`,
`historical_backtesting`, `paper_trading_simulation`, `redistribution` and
`commercial_publication`. Any other term is an unsupported licensing
assertion, and the import is rejected.

The required uses are:

- business evidence: `internal_research`;
- market data: `internal_research` and `historical_backtesting`.

A supplier's own statement about the licence can be `asserted`. Marking it
`verified` is refused, as with every R1 attestation.

## 2. Quarantine lifecycle

```
received -> validated -> awaiting_approval      (end of R2: nothing further exists)
received -> rejected                            (manifest, integrity, origin or content-schema failure)
validated -> rejected                           (the licence does not permit the required uses)
```

`transition()` refuses any other move. There is no `approved` state, and
`awaiting_approval` has no outgoing transition.

The review is checked in a fixed order:

1. The manifest is checked.
2. The content's size and SHA-256 are compared with the manifest. A
   mismatch is rejected before the content is parsed.
3. The content's JSON and schema are parsed and validated, and the R1
   readiness check runs.
4. The licence is checked for permission.

Rejection reasons appear in that order, so the same inputs always give the
same review.

## 3. Three separate questions

| Question | Outcome |
|---|---|
| Syntactic validity: manifest, content integrity, content schema | Any failure rejects the import |
| Evidence quality: R1 readiness | Reported only. Poor evidence (conflicts, stale sources, missing bars) can still await approval, listed as unresolved questions |
| Permission to use: licence | `not_permitted` rejects the import. An `asserted` or `unverified` licence leaves the permission `unverified` |

The **binding SHA-256** covers five things: the import id, the final state,
the manifest's SHA-256, the exact content's SHA-256 and the R1 input SHA-256.
Changing any byte of either file changes it.

## 4. File safety (reused, not broadened)

`import review` reads both files through the CLI's existing read-only loader
(`src/research-cli/trading-files.ts`). No new filesystem code was added.

- The data root must be an absolute, normalised path outside the
  repository. It is checked before any filesystem call.
- File names must be plain lower-case `.json` names directly inside the data
  root. This applies to the name the manifest gives too, and the content file
  must differ from the manifest.
- Symbolic links, files writable by others and non-regular files are
  refused.
- Opens use no-follow and non-blocking flags, and the inode is re-checked
  before and after reading.
- Size limits are 100,000 bytes for the manifest and 10,000,000 bytes for the
  content.
- Content must be strict UTF-8 without a byte-order mark.
- Nothing is written, moved or deleted. The tests confirm that the inputs'
  bytes, times and modes are unchanged.

## 5. Worked fictional example

Create the data root:

```bash
mkdir /tmp/automaton-import && chmod 755 /tmp/automaton-import
```

Save this content as `/tmp/automaton-import/evidence.json`:

```json
{
  "version": 1,
  "asOf": "2026-11-01T12:00:00Z",
  "maxSourceAgeDays": 365,
  "sources": [
    {
      "id": "fict-survey",
      "sourceClass": "primary",
      "publisher": "Fictional Statistics Office",
      "publisherId": "fict-stats-office",
      "originId": "fict-stats-office",
      "title": "Fictional pet survey 2026",
      "locator": { "kind": "url", "value": "https://example.org/fictional/pet-survey-2026" },
      "retrievedAt": "2026-10-15T09:00:00Z",
      "publishedAt": { "status": "stated", "value": "2026-06-01" },
      "contentSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "derivedFromSourceIds": [],
      "verification": {
        "content_integrity": { "status": "verified", "basis": "independent_check", "note": "Recomputed the hash of the saved file.", "checkedBy": "operator", "checkedAt": "2026-10-20T10:00:00Z" },
        "publisher_identity": { "status": "asserted", "basis": "source_self_statement", "note": "The page says it is the statistics office.", "checkedBy": null, "checkedAt": null },
        "publication_date": { "status": "asserted", "basis": "source_self_statement", "note": "Date printed on the page.", "checkedBy": null, "checkedAt": null },
        "origin": { "status": "unverified", "basis": "none", "note": "Not traced yet.", "checkedBy": null, "checkedAt": null },
        "independence": { "status": "unverified", "basis": "none", "note": "Not checked.", "checkedBy": null, "checkedAt": null }
      }
    }
  ],
  "claims": [
    { "id": "c-demand", "statement": "38% of surveyed fictional owners want short-notice walks.", "kind": "fact", "sourceIds": ["fict-survey"], "method": null, "financial": null, "operatorStatus": "unconfirmed" }
  ],
  "conflicts": [],
  "missingInformation": [{ "id": "m-price", "description": "No price evidence yet.", "blocking": false }]
}
```

Then record its size and hash:

```bash
wc -c < /tmp/automaton-import/evidence.json
sha256sum /tmp/automaton-import/evidence.json
```

Save `/tmp/automaton-import/manifest.json`, replacing `SIZE` and `SHA256`
with the two values above:

```json
{
  "version": 1,
  "importId": "imp-dog-walking-1",
  "receivedAt": "2026-11-02T09:00:00Z",
  "receivedBy": "operator",
  "preparedAt": "2026-11-02T10:00:00Z",
  "dataType": "business_evidence",
  "dataOrigin": "fictional",
  "content": { "file": "evidence.json", "format": "json", "encoding": "utf-8", "sizeBytes": SIZE, "sha256": "SHA256" },
  "supplier": { "name": "Fictional Research Supplier", "supplierId": "fict-supplier", "declaredPublisher": "Fictional Statistics Office", "declaredPublisherId": "fict-stats-office" },
  "licence": {
    "licenceId": "FICT-LICENCE-1",
    "permittedUses": ["internal_research"],
    "restrictions": ["No redistribution."],
    "attestation": { "status": "asserted", "basis": "operator_statement", "note": "The supplier's email says research use is allowed.", "checkedBy": null, "checkedAt": null }
  }
}
```

Build and run the review:

```bash
./node_modules/.bin/tsc
node dist/research-cli/main.js import review --data-root /tmp/automaton-import --repo-root "$PWD" --manifest manifest.json
```

Expected result: `AWAITING APPROVAL` with exit code 0. Evidence quality and
permission are both `unverified`, because the publisher, date and licence are
only asserted. The unresolved questions list each gap and end with
"approval for real-world use: not available in R2".

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Awaiting approval |
| 1 | Rejected. The full review is still printed to standard output |
| 1 | File refusal. The reason is on standard error, with paths redacted |
| 2 | Usage error |

## 6. Tests

```bash
./node_modules/.bin/vitest run src/__tests__/research-readiness src/__tests__/research-cli/import.test.ts
```

The tests use only fictional manifests and content. They cover:

- malformed and ambiguous manifests;
- content-hash and size mismatches;
- unsupported licensing assertions and licences without the required uses;
- real-world origin;
- path safety: traversal, symbolic links, permissions, size and encoding;
- conflicting business evidence and market-data gaps;
- untrusted declared publishers and Markdown injection;
- read-only behaviour and the lifecycle's missing approval route.

## 7. Connecting to future approved data sources

Each step needs its own approved milestone.

1. **Retrieval.** A future, operator-triggered retriever for one named,
   licensed source would only save the file and write a manifest:
   `dataOrigin: real_world`, hashes computed at retrieval, and the licence
   terms recorded. R2 is then the mandatory gate.
2. **An approval step.** Real-world input needs a human approval that
   records who approved which binding SHA-256, and when. It would add a
   reviewed `approved` state and transition. Nothing in R2 can be switched
   on to do this.
3. **The engines.** These would accept only approved content through a
   separate, reviewed adapter. Today they refuse anything non-fictional.

## 8. Remaining requirements before a VPS or real data

- **Sandbox and hosting.** The M1/M3 blockers stay active. A server needs
  the hosting plan reviewed, secrets handling, network egress limited to
  approved hosts, monitoring and backups of the quarantine area. No Docker
  socket access.
- **Licences.** Confirm each vendor's licence terms and record them in the
  manifest as `verified` only after a person has read them.
- **Storage.** Decide how quarantined files are stored and retained. R2
  never stores or moves anything; the operator manages the files.
- **No trading.** Broker connections, real orders, live trading, wallets,
  crypto and spending stay out of scope.
