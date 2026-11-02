/**
 * Source manifest parser (Phase 1A step 2). Pure and deterministic: no
 * filesystem, network, process, environment, clock, model or Docker access.
 * It parses data that a later step reads from a run folder; it never opens
 * the listed files itself.
 *
 * The manifest lists one entry per source: a plain file name inside the run
 * folder's sources/ directory, the SHA-256 the operator recorded when they
 * collected it, and the snapshot metadata. Everything is validated strictly:
 * unknown fields, wrong types, missing values, duplicate ids or file names,
 * unsafe file names and unknown references are refused, never defaulted.
 *
 * Snapshot metadata is checked by Phase 0's own rules (createSnapshot, run
 * with placeholder content because the real content is only loaded later),
 * so no Phase 0 rule is re-implemented or relaxed here. The recorded SHA-256
 * is the operator-retained reference a later step compares each file with; it
 * detects changes after recording, it does not authenticate a source.
 *
 * Input hardening shared by all pipeline parsers (exported for workbook.ts):
 * - parseBoundedJson: size limit before any work, then a bounded,
 *   syntax-aware scan that rejects duplicate object keys (at any depth;
 *   escaped spellings of the same key count as duplicates), excessive
 *   nesting and malformed JSON, then JSON.parse.
 * - normalizeInput: reads every property exactly once (from its descriptor)
 *   and builds a fresh copy that all later checks read, so a getter or Proxy
 *   can't show one value to validation and another to storage. It refuses
 *   sparse arrays and arrays with extra properties (at any depth), getters,
 *   symbol keys, non-enumerable properties, class instances and other
 *   non-plain objects, non-finite numbers and non-JSON values, and unsafe
 *   text (control characters including ANSI escapes, bidi controls,
 *   unpaired surrogates; line breaks and tabs in single-line fields). Copied
 *   objects have a null prototype, so inherited properties can never satisfy
 *   a required field. Work is bounded before it is done: an array's declared
 *   length and an object's own-key count are checked against the value
 *   budget (MAX_INPUT_NODES) before any entry or property is read.
 * - BoundedIssues: at most MAX_REPORTED_ISSUES detailed issues are kept per
 *   parse; the rest are counted and summarised in one line.
 *
 * NOT A SANDBOX. The intended input path is JSON text (parseManifestText,
 * parseWorkbookText, parseOpportunityText): JSON.parse only produces plain
 * objects, arrays and primitives, so JSON input can't contain getters,
 * Proxies or other code. When a JavaScript object is passed directly to a
 * parse* or normalizeInput function, inspecting it can run the caller's
 * code: Proxy traps (getPrototypeOf, ownKeys, getOwnPropertyDescriptor) are
 * invoked, once per property, during normalisation. The normaliser
 * guarantees that what is stored is what was validated; it is not a sandbox
 * or a safe execution boundary for arbitrary JavaScript objects, and direct
 * callers must be trusted code.
 *
 * File names accepted here are still re-validated by the step that opens
 * files (defence in depth); this module never opens anything.
 */

import { Issues, MAX_SNAPSHOTS, SchemaError, arr, checkKeys, createSnapshot, id, isoDate, str, uniqueIds } from "./division.js";

export const MANIFEST_VERSION = 1;
/** Size limit of the manifest text, checked before JSON parsing. */
export const MAX_MANIFEST_CHARS = 1_000_000;
/** At most as many sources as Phase 0 accepts snapshots. */
export const MAX_MANIFEST_SOURCES = MAX_SNAPSHOTS;
/** A plain lower-case file name with a text extension: no directories, no leading dot, no traversal. */
export const SOURCE_FILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\.(txt|md)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Nesting limit for JSON text and direct inputs (pipeline structures need fewer than 10 levels). */
export const MAX_JSON_DEPTH = 32;
/** Value-count limit for direct inputs (bounds work independently of text size). */
export const MAX_INPUT_NODES = 300_000;
/** Detailed validation issues kept per parse; further issues are counted and summarised in one line. */
export const MAX_REPORTED_ISSUES = 100;
/** Fields that must be a single line (no line breaks or tabs). */
const SINGLE_LINE_KEYS = new Set(["title", "publisher", "name", "product", "label", "assessedBy", "criterion", "file", "sha256", "url", "id"]);
/**
 * Disallowed in any text: C0 controls except tab, line feed and carriage return; DEL and C1 controls
 * (covers ANSI escape sequences, which start with ESC or CSI); bidi marks, embeddings, overrides and isolates.
 */
const UNSAFE_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const LONE_CARRIAGE_RETURN = /\r(?!\n)/;
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const SNAPSHOT_METADATA_FIELDS = [
  "id", "url", "publisher", "title", "publishedAt", "retrievedAt", "originId", "derivedFromSnapshotIds", "independenceVerified", "independenceNote",
] as const;
const SOURCE_FIELDS = ["file", "sha256", ...SNAPSHOT_METADATA_FIELDS] as const;
/** Stand-in content so Phase 0 can validate the metadata before the real text is loaded; never stored or reported. */
const METADATA_CHECK_CONTENT = "metadata check (content is loaded and verified in a later step)";

export interface ManifestSource {
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
  readonly url: string;
  readonly publisher: string;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly retrievedAt: string;
  readonly originId: string;
  readonly derivedFromSnapshotIds: readonly string[];
  readonly independenceVerified: boolean;
  readonly independenceNote: string;
}

export interface SourceManifest {
  readonly version: 1;
  readonly opportunityId: string;
  /** The run's date; every source must have been retrieved on or before it. */
  readonly runDate: string;
  readonly sources: readonly ManifestSource[];
}

/**
 * Parses JSON text after checking its type and size, so oversized input is
 * refused before any parsing work. No reviver; a leading byte-order mark or
 * invalid JSON is refused. Shared by the manifest and workbook parsers.
 */
export function parseBoundedJson(text: unknown, label: string, maxChars: number): unknown {
  if (typeof text !== "string") throw new SchemaError([`${label}: must be text (got ${text === null ? "null" : typeof text})`]);
  if (text.length > maxChars) throw new SchemaError([`${label}: is ${text.length} characters; the limit is ${maxChars}`]);
  if (text.startsWith("\ufeff")) throw new SchemaError([`${label}: must not start with a byte-order mark`]);
  scanJson(text, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new SchemaError([`${label}: is not valid JSON`]);
  }
}

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const JSON_ESCAPE = /^(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/;

/**
 * Bounded, syntax-aware JSON scan (iterative; no recursion): validates the
 * grammar and rejects duplicate object keys (compared after decoding escapes)
 * and nesting deeper than MAX_JSON_DEPTH. Throws SchemaError naming the
 * position; never echoes the input.
 */
function scanJson(text: string, label: string): void {
  let i = 0;
  const n = text.length;
  const fail = (message: string): never => { throw new SchemaError([`${label}: is not valid JSON (${message} at position ${i})`]); };
  const skipWhitespace = () => { while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++; };
  const readString = (): string => {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= n) fail("unterminated string");
      const code = text.charCodeAt(i);
      if (code === 0x22) { i++; break; }
      if (code === 0x5c) {
        if (!JSON_ESCAPE.test(text.slice(i + 1, i + 6))) fail("invalid escape");
        i += text[i + 1] === "u" ? 6 : 2;
      } else if (code < 0x20) {
        fail("unescaped control character in string");
      } else {
        i++;
      }
    }
    return JSON.parse(text.slice(start, i)) as string; // decodes the escapes of an already-validated string token
  };
  type Frame = { kind: "object"; keys: Set<string> } | { kind: "array" };
  const stack: Frame[] = [];
  let state: "value" | "key" | "after" = "value";
  for (;;) {
    skipWhitespace();
    if (state === "value") {
      if (i >= n) fail("unexpected end");
      const ch = text[i];
      if (ch === "{" || ch === "[") {
        if (stack.length >= MAX_JSON_DEPTH) fail(`nesting deeper than ${MAX_JSON_DEPTH} levels`);
        i++;
        skipWhitespace();
        if (ch === "{") {
          stack.push({ kind: "object", keys: new Set() });
          if (text[i] === "}") { i++; stack.pop(); state = "after"; } else state = "key";
        } else {
          stack.push({ kind: "array" });
          if (text[i] === "]") { i++; stack.pop(); state = "after"; } else state = "value";
        }
      } else if (ch === '"') {
        readString();
        state = "after";
      } else if (text.startsWith("true", i) || text.startsWith("null", i)) {
        i += 4;
        state = "after";
      } else if (text.startsWith("false", i)) {
        i += 5;
        state = "after";
      } else {
        JSON_NUMBER.lastIndex = i;
        if (!JSON_NUMBER.test(text)) fail("unexpected character");
        i = JSON_NUMBER.lastIndex;
        state = "after";
      }
    } else if (state === "key") {
      if (text[i] !== '"') fail("expected a quoted key");
      const key = readString();
      const frame = stack[stack.length - 1] as { kind: "object"; keys: Set<string> };
      if (frame.keys.has(key)) fail("duplicate object key");
      frame.keys.add(key);
      skipWhitespace();
      if (text[i] !== ":") fail("expected ':'");
      i++;
      state = "value";
    } else {
      if (stack.length === 0) {
        if (i < n) fail("unexpected trailing characters");
        return;
      }
      const top = stack[stack.length - 1];
      const ch = text[i];
      if (ch === ",") { i++; state = top.kind === "object" ? "key" : "value"; }
      else if (ch === "}" && top.kind === "object") { i++; stack.pop(); state = "after"; }
      else if (ch === "]" && top.kind === "array") { i++; stack.pop(); state = "after"; }
      else fail("expected ',' or a closing bracket");
    }
  }
}

/** Rejects text that could hide or inject content later (terminal, files, reports); never echoes it. */
function checkText(issues: BoundedIssues, path: string, text: string, key: string | null): void {
  const bad = UNSAFE_CHARACTER.exec(text);
  if (bad) issues.add(path, `contains a disallowed control, escape or bidi character (U+${bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")})`);
  if (LONE_CARRIAGE_RETURN.test(text)) issues.add(path, "contains a carriage return that is not part of a line break");
  if (UNPAIRED_SURROGATE.test(text)) issues.add(path, "contains an unpaired surrogate (invalid Unicode)");
  if (key !== null && SINGLE_LINE_KEYS.has(key) && /[\n\r\t]/.test(text)) issues.add(path, "must be a single line (no line breaks or tabs)");
}

const INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * Phase 0's issue collector with a cap (D2): at most MAX_REPORTED_ISSUES
 * detailed issues are kept; further ones are only counted and reported as a
 * one-line summary, so a large invalid input can't build a huge issue list or
 * error message. Every pipeline parser uses it, for JSON and direct inputs.
 */
export class BoundedIssues extends Issues {
  omitted = 0;
  override add(path: string, message: string): void {
    if (this.list.length < MAX_REPORTED_ISSUES) super.add(path, message);
    else this.omitted += 1;
  }
  /** Adds an already-formatted "path: message" line (e.g. from a Phase 0 parser), under the same cap. */
  addMessage(message: string): void {
    if (this.list.length < MAX_REPORTED_ISSUES) this.list.push(message);
    else this.omitted += 1;
  }
  override throwIfAny(): void {
    if (this.list.length === 0 && this.omitted === 0) return;
    const summary = this.omitted > 0 ? [`(${this.omitted} further issue(s) omitted; fix the ones listed and check again)`] : [];
    throw new SchemaError([...this.list, ...summary]);
  }
}

/**
 * Reads a JSON-like input exactly once and returns a fresh, validated copy
 * (objects with a null prototype, plain arrays). See the module comment for
 * what is refused. Throws SchemaError listing the problems (bounded).
 *
 * Work is bounded before it is done (D1): an array's declared length is
 * checked against the remaining value budget before its keys are listed or
 * its entries visited, and an object's own-key count before any property is
 * read; holes count against the budget. Each property's descriptor is then
 * read exactly once.
 */
export function normalizeInput(raw: unknown, label: string): unknown {
  const issues = new BoundedIssues();
  let nodes = 0;
  const overBudget = () => new SchemaError([`${label}: has more than ${MAX_INPUT_NODES} values`]);
  const visit = (value: unknown, path: string, depth: number, key: string | null): unknown => {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES) throw overBudget();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) issues.add(path, "must be a finite number");
      return value;
    }
    if (typeof value === "string") {
      checkText(issues, path, value, key);
      return value;
    }
    if (typeof value !== "object") {
      issues.add(path, `has an unsupported type (${typeof value})`);
      return null;
    }
    if (depth >= MAX_JSON_DEPTH) {
      issues.add(path, `is nested deeper than ${MAX_JSON_DEPTH} levels`);
      return null;
    }
    const budget = MAX_INPUT_NODES - nodes; // values this subtree may still contain
    let proto: unknown;
    let isArray: boolean;
    let length = 0;
    let names: string[];
    let symbolKeys: number;
    try {
      isArray = Array.isArray(value);
      proto = Object.getPrototypeOf(value);
      if (isArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        const declared: unknown = lengthDescriptor?.value;
        if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 0) {
          issues.add(path, "must be a plain array");
          return [];
        }
        if (declared > budget) throw overBudget(); // before listing keys or visiting entries (huge or sparse lengths)
        length = declared;
      }
      names = Object.getOwnPropertyNames(value);
      if (names.length > budget + (isArray ? 1 : 0)) throw overBudget(); // before reading any property
      symbolKeys = Object.getOwnPropertySymbols(value).length;
    } catch (err) {
      if (err instanceof SchemaError) throw err;
      issues.add(path, "could not be read as plain data");
      return null;
    }
    if (symbolKeys > 0) issues.add(path, "must not have symbol keys");
    /** Reads one property's descriptor exactly once; undefined if absent or unreadable. */
    const descriptorOf = (name: string): PropertyDescriptor | undefined | "unreadable" => {
      try {
        return Object.getOwnPropertyDescriptor(value, name);
      } catch {
        return "unreadable";
      }
    };
    const read = (d: PropertyDescriptor, childName: string, childPath: string): unknown => {
      if (d.get !== undefined || d.set !== undefined) {
        issues.add(childPath, "must be a plain data value, not a getter/setter");
        return null;
      }
      if (!d.enumerable) issues.add(childPath, "must be an ordinary (enumerable) property");
      return visit(d.value, childPath, depth + 1, isArray ? key : childName);
    };
    if (isArray) {
      if (proto !== Array.prototype) issues.add(path, "must be a plain array");
      if (names.some((k) => k !== "length" && !(INDEX.test(k) && Number(k) < length))) {
        issues.add(path, "must not have properties other than its elements");
      }
      const out: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const childPath = `${path}[${index}]`;
        const d = descriptorOf(String(index));
        if (d === undefined || d === "unreadable") {
          nodes += 1; // holes count against the budget too
          if (nodes > MAX_INPUT_NODES) throw overBudget();
          issues.add(childPath, d === undefined ? "is missing (sparse arrays are not allowed)" : "could not be read as plain data");
          out.push(null);
          continue;
        }
        out.push(read(d, String(index), childPath));
      }
      return out;
    }
    if (proto !== Object.prototype && proto !== null) {
      issues.add(path, "must be a plain object");
      return null;
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const name of names) {
      const childPath = `${path}.${name}`;
      const d = descriptorOf(name);
      if (d === undefined || d === "unreadable") {
        issues.add(childPath, "could not be read as plain data");
        out[name] = null;
        continue;
      }
      out[name] = read(d, name, childPath);
    }
    return out;
  };
  const copy = visit(raw, label, 0, null);
  issues.throwIfAny();
  return copy;
}

/** Runs a Phase 0 parser and moves its issues (re-prefixed) into ours instead of throwing. */
function capture<T>(issues: BoundedIssues, prefix: string, from: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    if (!(err instanceof SchemaError)) throw err;
    for (const message of err.issues) issues.addMessage(message.startsWith(from) ? `${prefix}${message.slice(from.length)}` : `${prefix}: ${message}`);
    return null;
  }
}

export function parseManifest(raw: unknown): SourceManifest {
  const input = normalizeInput(raw, "manifest"); // every later read sees this stable copy
  const issues = new BoundedIssues();
  if (!checkKeys(issues, "manifest", input, ["version", "opportunityId", "runDate", "sources"])) issues.throwIfAny();
  const m = input as Record<string, unknown>;
  if (m.version !== MANIFEST_VERSION) issues.add("manifest.version", `must be ${MANIFEST_VERSION}`);
  const opportunityId = id(issues, "manifest.opportunityId", m.opportunityId);
  const runDate = isoDate(issues, "manifest.runDate", m.runDate);
  const list = arr(issues, "manifest.sources", m.sources, { min: 1, max: MAX_MANIFEST_SOURCES });
  issues.throwIfAny(); // refuse a malformed header or an oversized source list before reading any entry

  const sources = list.map((rawSource, i): ManifestSource | null => {
    const p = `manifest.sources[${i}]`;
    if (!checkKeys(issues, p, rawSource, SOURCE_FIELDS)) return null;
    const s = rawSource as Record<string, unknown>;
    const fileValue = s.file; // read once: the value validated is the value stored
    const file = str(issues, `${p}.file`, fileValue, { max: 68 });
    if (typeof fileValue === "string" && !SOURCE_FILE_PATTERN.test(fileValue)) {
      issues.add(`${p}.file`, "must be a plain lower-case file name ending in .txt or .md (no directories, leading dot or other characters)");
    }
    const sha256 = str(issues, `${p}.sha256`, s.sha256, { pattern: SHA256_PATTERN });
    const metadata = Object.fromEntries(SNAPSHOT_METADATA_FIELDS.map((k) => [k, s[k]]));
    const checked = capture(issues, p, "snapshot", () => createSnapshot({ ...metadata, content: METADATA_CHECK_CONTENT }));
    if (checked === null) return null;
    if (runDate && checked.retrievedAt.slice(0, 10) > runDate) issues.add(`${p}.retrievedAt`, `is after the run date ${runDate}`);
    return Object.freeze({
      id: checked.id, file, sha256, url: checked.url, publisher: checked.publisher, title: checked.title, publishedAt: checked.publishedAt,
      retrievedAt: checked.retrievedAt, originId: checked.originId, derivedFromSnapshotIds: Object.freeze([...checked.derivedFromSnapshotIds]),
      independenceVerified: checked.independenceVerified, independenceNote: checked.independenceNote,
    });
  });
  issues.throwIfAny();

  const valid = sources as ManifestSource[];
  uniqueIds(issues, "manifest.sources (ids)", valid.map((s) => s.id));
  uniqueIds(issues, "manifest.sources (files)", valid.map((s) => s.file));
  const ids = new Set(valid.map((s) => s.id));
  valid.forEach((s, i) => s.derivedFromSnapshotIds.forEach((d) => {
    if (!ids.has(d)) issues.add(`manifest.sources[${i}].derivedFromSnapshotIds`, `unknown source "${d}"`);
  }));
  issues.throwIfAny();
  return Object.freeze({ version: MANIFEST_VERSION, opportunityId, runDate, sources: Object.freeze(valid) });
}

/** Parses manifest JSON text (size-checked before parsing). */
export function parseManifestText(text: unknown): SourceManifest {
  return parseManifest(parseBoundedJson(text, "manifest", MAX_MANIFEST_CHARS));
}
