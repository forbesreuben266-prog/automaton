/**
 * Fictional price datasets with SHA-256 provenance (trading research T1).
 * Pure and deterministic; the only module used is node:crypto (hashing).
 *
 * A dataset is one instrument's daily bars plus metadata:
 *   { version: 1, id, title, source, adjustment, interval: "1d",
 *     annualization, limitations, instrument, costs, bars }
 * - source: { kind: "fictional", label, recordedBy, recordedAt }. Only
 *   fictional, operator-supplied data is approved in this phase, so any
 *   other kind is refused. recordedAt must not be earlier than the last bar.
 * - adjustment: how prices treat corporate actions. Stocks: "none",
 *   "splits" or "splits_and_dividends"; forex: "not_applicable". The value
 *   is recorded, not checked: nothing here adjusts prices, and survivorship
 *   bias (instruments that no longer exist) is not addressed.
 * - annualization: { periodsPerYear, basis }: the operator states how many
 *   bars make a year for THIS dataset (e.g. trading days on its exchange);
 *   no calendar is assumed.
 * - limitations: the operator's notes (free text, may be empty).
 *
 * SHA-256 (datasetSha256): computed over a deterministic representation of
 * the VALIDATED dataset, not over the input text, so formatting, key order
 * and equivalent decimals ("1.50" and "1.5") do not change it. The hashed
 * text is the JSON serialisation (UTF-8) of this array, in this order:
 *   ["automaton/trading-research/dataset/v1", version, id, title,
 *    source.kind, source.label, source.recordedBy, source.recordedAt,
 *    adjustment, interval, annualization.periodsPerYear, annualization.basis,
 *    limitations,
 *    [symbol, assetClass, name, priceUnit, tickSize, base|null, quote|null, pipSize|null],
 *    [spreadMode, fixedSpreadTicks|null, feeCurrency, feePerOrder, feeProportionalBps],
 *    [[t, openTicks, highTicks, lowTicks, closeTicks, volume|null, spreadTicks], ...]]
 * with decimals in canonical form (no trailing fractional zeros) and prices
 * as integer ticks. A matching hash shows the data is unchanged since the
 * reference was recorded; it does not authenticate who made it or show that
 * any price is real. Keep the reference hash outside the dataset.
 */

import { createHash } from "node:crypto";
import { readInstrument, type Instrument } from "./instruments.js";
import { readBars, readCosts, type Bar, type Costs } from "./prices.js";
import { Issues, ValidationError, parseJsonText, readList, readObject, readOneOf, readSafeInt, readText, readTimestamp } from "./validation.js";

export const DATASET_VERSION = 1;
export const HASH_DOMAIN = "automaton/trading-research/dataset/v1";
/** Bounds the work before parsing (50,000 bars of about 120 characters fit comfortably). */
export const MAX_DATASET_CHARS = 10_000_000;
export const ADJUSTMENTS = ["none", "splits", "splits_and_dividends", "not_applicable"] as const;
export type Adjustment = (typeof ADJUSTMENTS)[number];
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Everything in a dataset except its bars (used to start a paper-trading session, which receives bars one at a time). */
export interface DatasetHeader {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly source: { readonly kind: "fictional"; readonly label: string; readonly recordedBy: string; readonly recordedAt: string };
  readonly adjustment: Adjustment;
  readonly interval: "1d";
  readonly annualization: { readonly periodsPerYear: number; readonly basis: string };
  readonly limitations: readonly string[];
  readonly instrument: Instrument;
  readonly costs: Costs;
}

export interface Dataset extends DatasetHeader {
  readonly bars: readonly Bar[];
}

const HEADER_KEYS = ["version", "id", "title", "source", "adjustment", "interval", "annualization", "limitations", "instrument", "costs"];

/** Validates a dataset object (normally from parseDatasetText). Throws ValidationError listing the problems. */
export function parseDataset(raw: unknown): Dataset {
  const issues = new Issues();
  const o = readObject(issues, "dataset", raw, [...HEADER_KEYS, "bars"]);
  issues.throwIfAny();
  const header = readHeader(issues, o!);
  const bars = readBars(issues, "dataset.bars", o!.bars, header.instrument, header.costs);
  if (bars !== null && header.source.recordedAt < bars[bars.length - 1].t) {
    issues.add("dataset.source.recordedAt", "must not be earlier than the last bar");
  }
  issues.throwIfAny();
  return Object.freeze({ ...header, bars: bars! });
}

/**
 * Validates a dataset header: the same fields and rules as a dataset, with no
 * bars (and so no check of recordedAt against the last bar). Throws ValidationError.
 */
export function parseDatasetHeader(raw: unknown): DatasetHeader {
  const issues = new Issues();
  const o = readObject(issues, "dataset", raw, HEADER_KEYS);
  issues.throwIfAny();
  return readHeader(issues, o!);
}

/** Header fields of an already shape-checked dataset object; throws on any problem. */
function readHeader(issues: Issues, d: Record<string, unknown>): DatasetHeader {
  if (d.version !== DATASET_VERSION) issues.add("dataset.version", `must be ${DATASET_VERSION}`);
  const id = readText(issues, "dataset.id", d.id, { max: 64, pattern: ID_PATTERN });
  const title = readText(issues, "dataset.title", d.title, { max: 200 });
  const s = readObject(issues, "dataset.source", d.source, ["kind", "label", "recordedBy", "recordedAt"]);
  const source = s === null ? null : {
    kind: readOneOf(issues, "dataset.source.kind", s.kind, ["fictional"] as const),
    label: readText(issues, "dataset.source.label", s.label, { max: 200 }),
    recordedBy: readText(issues, "dataset.source.recordedBy", s.recordedBy, { max: 100 }),
    recordedAt: readTimestamp(issues, "dataset.source.recordedAt", s.recordedAt),
  };
  const adjustment = readOneOf(issues, "dataset.adjustment", d.adjustment, ADJUSTMENTS);
  const interval = readOneOf(issues, "dataset.interval", d.interval, ["1d"] as const);
  const a = readObject(issues, "dataset.annualization", d.annualization, ["periodsPerYear", "basis"]);
  const annualization = a === null ? null : {
    periodsPerYear: readSafeInt(issues, "dataset.annualization.periodsPerYear", a.periodsPerYear, { min: 1, max: 366 }),
    basis: readText(issues, "dataset.annualization.basis", a.basis, { max: 300 }),
  };
  const limitationList = readList(issues, "dataset.limitations", d.limitations, { min: 0, max: 20 });
  const limitations = (limitationList ?? []).map((l, i) => readText(issues, `dataset.limitations[${i}]`, l, { max: 500, multiLine: true }));
  issues.throwIfAny(); // header first, so instrument and bar errors are reported against a sound header

  const instrument = readInstrument(issues, "dataset.instrument", d.instrument);
  issues.throwIfAny();
  if ((instrument!.assetClass === "fx") !== (adjustment === "not_applicable")) {
    issues.add("dataset.adjustment", instrument!.assetClass === "fx" ? "must be not_applicable for forex" : "must be none, splits or splits_and_dividends for stocks");
  }
  const costs = readCosts(issues, "dataset.costs", d.costs, instrument!);
  issues.throwIfAny();
  return Object.freeze({
    version: DATASET_VERSION, id, title, source: Object.freeze(source!), adjustment, interval, annualization: Object.freeze(annualization!),
    limitations: Object.freeze(limitations), instrument: instrument!, costs: costs!,
  });
}

/** Parses dataset JSON text (size-checked, duplicate keys refused) and validates it. */
export function parseDatasetText(text: unknown): Dataset {
  return parseDataset(parseJsonText(text, "dataset", MAX_DATASET_CHARS));
}

/** The header fields in their canonical order (shared by the dataset hash and the paper-trading header hash). */
export function canonicalHeaderParts(h: DatasetHeader): unknown[] {
  const i = h.instrument;
  const c = h.costs;
  return [
    h.version, h.id, h.title, h.source.kind, h.source.label, h.source.recordedBy, h.source.recordedAt,
    h.adjustment, h.interval, h.annualization.periodsPerYear, h.annualization.basis, [...h.limitations],
    [i.symbol, i.assetClass, i.name, i.priceUnit, i.tickSize, i.base, i.quote, i.pipSize],
    [c.spreadMode, c.fixedSpread, c.feeCurrency, c.feePerOrder, c.feeProportionalBps],
  ];
}

/** Canonical form of one bar: [t, open, high, low, close (ticks), volume|null, spread (ticks)]. */
export const canonicalBar = (b: Bar): unknown[] => [b.t, b.open, b.high, b.low, b.close, b.volume, b.spread];

/** The exact text that datasetSha256 hashes (see the module comment). */
export function canonicalDatasetText(ds: Dataset): string {
  return JSON.stringify([HASH_DOMAIN, ...canonicalHeaderParts(ds), ds.bars.map(canonicalBar)]);
}

/** SHA-256 (lowercase hex) of canonicalDatasetText. */
export function datasetSha256(ds: Dataset): string {
  return createHash("sha256").update(canonicalDatasetText(ds), "utf8").digest("hex");
}

/** Refuses (ValidationError) unless the dataset's hash equals the operator-retained reference. */
export function verifyDatasetSha256(ds: Dataset, expected: unknown): void {
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) throw new ValidationError(["expected SHA-256: must be 64 lowercase hex characters"]);
  if (datasetSha256(ds) !== expected) throw new ValidationError(["dataset: SHA-256 does not match the recorded reference (the data changed or is a different dataset)"]);
}
