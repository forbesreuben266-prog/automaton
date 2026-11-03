/**
 * FICTIONAL records for the R1 readiness tests. Every organisation, symbol,
 * price and domain is invented (example.org/example.com are reserved for
 * documentation). The base records are deliberately complete and fully
 * verified, so each test can break exactly one thing.
 */

export const HASH = "a".repeat(64);
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export const verified = (checkedAt = "2026-10-20T10:00:00Z", note = "Checked against the fictional registry by hand.") =>
  ({ status: "verified", basis: "independent_check", note, checkedBy: "operator", checkedAt });
export const asserted = (note = "The source says so itself.") => ({ status: "asserted", basis: "source_self_statement", note, checkedBy: null, checkedAt: null });
export const unverified = (note = "Not checked.") => ({ status: "unverified", basis: "none", note, checkedBy: null, checkedAt: null });

const allVerified = (at: string) => ({
  content_integrity: verified(at), publisher_identity: verified(at), publication_date: verified(at), origin: verified(at), independence: verified(at),
});

/** A fully verified primary source (the publisher produced the evidence). */
export function primarySource(id = "fict-stats", over: Record<string, unknown> = {}): any {
  return {
    id, sourceClass: "primary", publisher: "Fictional Statistics Office", publisherId: "fict-stats-office", originId: "fict-stats-office",
    title: "Fictional household pet survey 2026", locator: { kind: "url", value: "https://example.org/fictional/pet-survey-2026" },
    retrievedAt: "2026-10-15T09:00:00Z", publishedAt: { status: "stated", value: "2026-06-01" }, contentSha256: HASH,
    derivedFromSourceIds: [], verification: allVerified("2026-10-20T10:00:00Z"), ...over,
  };
}

/** A fully verified secondary source reporting another organisation's evidence. */
export function secondarySource(id: string, originId: string, over: Record<string, unknown> = {}): any {
  return {
    ...primarySource(id), sourceClass: "secondary", publisher: `Fictional News ${id}`, publisherId: `pub-${id}`, originId,
    title: `Fictional article ${id}`, locator: { kind: "document", value: `Fictional trade magazine, issue 12, page 4 (${id})` }, ...over,
  };
}

/** A complete, fully supported business evidence bundle (overall: ready_for_operator_review). */
export function businessBundle(): any {
  return {
    version: 1, asOf: "2026-11-01T12:00:00Z", maxSourceAgeDays: 365,
    sources: [primarySource(), secondarySource("sec-a", "origin-a"), secondarySource("sec-b", "origin-b")],
    claims: [
      { id: "c-demand", statement: "38% of surveyed fictional owners want short-notice walks.", kind: "fact", sourceIds: ["fict-stats"], method: null, financial: null, operatorStatus: "confirmed" },
      { id: "c-price", statement: "Fictional walks sell for 15 GBP.", kind: "fact", sourceIds: ["sec-a", "sec-b"], method: null, financial: { basis: "sourced" }, operatorStatus: "confirmed" },
      { id: "c-revenue", statement: "About 1,200 GBP a month from 80 walks.", kind: "estimate", sourceIds: ["fict-stats"], method: "80 walks x 15 GBP.", financial: { basis: "derived_from_sourced" }, operatorStatus: "unconfirmed" },
    ],
    conflicts: [],
    missingInformation: [{ id: "m-insurance", description: "Insurance cost not yet researched.", blocking: false }],
  };
}

const US_DATES = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13"];
const UK_DATES = ["2026-03-23", "2026-03-24", "2026-03-25", "2026-03-26", "2026-03-27", "2026-03-30", "2026-03-31", "2026-04-01", "2026-04-02", "2026-04-03"];

/** Hand-written UTC closes: US daylight saving starts 2026-03-08, UK summer time 2026-03-29. */
const closeUtc = (kind: "us" | "uk" | "fx", d: string) =>
  kind === "us" ? `${d}T${d < "2026-03-08" ? "21" : "20"}:00:00Z`
    : kind === "fx" ? `${d}T${d < "2026-03-08" ? "22" : "21"}:00:00Z`
      : `${d}T${d < "2026-03-29" ? "16" : "15"}:30:00Z`;

/** A complete, verified market-data record for a fictional US stock, UK stock or EURUSD (overall: ready_for_operator_review). */
export function marketRecord(kind: "us" | "uk" | "fx" = "us"): any {
  const dates = kind === "uk" ? UK_DATES : US_DATES;
  const last = dates[dates.length - 1];
  const instrument = kind === "us" ? { assetClass: "us_equity", symbol: "FICT", exchange: "XNYS", priceCurrency: "USD" }
    : kind === "uk" ? { assetClass: "uk_equity", symbol: "FKUK", exchange: "XLON", priceCurrency: "GBX" }
      : { assetClass: "fx", symbol: "EURUSD", exchange: "FX", priceCurrency: "USD", base: "EUR", quote: "USD", quoteConvention: "quote_per_base" };
  const price = (i: number, d: number) => (kind === "fx" ? (1.1 + i / 1000 + d / 10000).toFixed(5) : (100 + i + d / 4).toFixed(2));
  return {
    version: 1, asOf: "2026-04-10T00:00:00Z",
    source: secondarySource("vendor-file", "fict-exchange", {
      publisher: "Fictional Data Vendor", publisherId: "fict-vendor", title: "Fictional end-of-day file", retrievedAt: `${last}T23:30:00Z`,
      publishedAt: { status: "stated", value: last }, verification: allVerified("2026-04-05T10:00:00Z"),
    }),
    instrument, priceBasis: "raw", adjustment: null,
    corporateActions: kind === "fx" ? null : { actions: [], attestation: verified("2026-04-05T10:00:00Z", "Checked the fictional issuer's notices for the period.") },
    calendar: {
      exchange: instrument.exchange, timeZone: kind === "uk" ? "Europe/London" : "America/New_York",
      sessions: dates.map((date) => ({ date, closeLocal: kind === "us" ? "16:00" : kind === "uk" ? "16:30" : "17:00" })),
      attestation: verified("2026-04-05T10:00:00Z", "Compared with the fictional exchange holiday list."),
    },
    bars: dates.map((d, i) => ({
      session: d, t: closeUtc(kind, d), open: price(i, 0), high: price(i, 2), low: price(i, -1), close: price(i, 1), volume: kind === "fx" ? null : String(1000 + i),
    })),
  };
}

export const statusOf = (r: { checks: readonly { id: string; status: string }[] }, id: string) => r.checks.find((c) => c.id === id)?.status;
export const detailsOf = (r: { checks: readonly { id: string; details: readonly string[] }[] }, id: string) => r.checks.find((c) => c.id === id)?.details ?? [];
