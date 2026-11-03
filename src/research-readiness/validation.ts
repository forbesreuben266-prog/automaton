/**
 * Strict, bounded validation helpers for the real-world readiness checks
 * (milestone R1). Pure and deterministic: no filesystem, network, process,
 * environment, clock or randomness. The conventions deliberately match the
 * existing offline research modules (same identifier pattern, the same UTC
 * timestamp format, the same unsafe-text rule); a test checks they agree.
 *
 * - Objects must be plain data with exactly the expected fields: unknown or
 *   missing fields, getters and setters are refused; nothing is defaulted.
 * - Text is printable single-line Unicode without control, bidi or invisible
 *   formatting characters.
 * - Timestamps are "YYYY-MM-DDTHH:MM:SSZ" (UTC) and dates "YYYY-MM-DD", both
 *   checked against the real calendar (no 31 April or 29 February 2027).
 * - At most MAX_ISSUES problems are reported, then a count.
 * Direct (non-JSON) objects are not sandboxed: callers must be trusted code.
 */

export const MAX_ISSUES = 100;
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,8})?$/;
const TIMESTAMP_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;
const DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
/** C0, DEL, C1, bidi controls, zero-width and other invisible formatting characters (as in the trading module). */
export const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export class ReadinessInputError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Readiness input refused:\n- ${issues.join("\n- ")}`);
    this.name = "ReadinessInputError";
  }
}

export class Issues {
  private readonly items: string[] = [];
  private extra = 0;
  add(path: string, message: string): void {
    if (this.items.length < MAX_ISSUES) this.items.push(`${path}: ${message}`);
    else this.extra += 1;
  }
  get count(): number {
    return this.items.length + this.extra;
  }
  throwIfAny(): void {
    if (this.count === 0) return;
    throw new ReadinessInputError(this.extra > 0 ? [...this.items, `... and ${this.extra} more problem(s)`] : [...this.items]);
  }
}

const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

/** Exactly the required keys (plus optional ones); returns a null-prototype copy, each value read once, or null with issues. */
export function readObject(issues: Issues, path: string, value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    issues.add(path, `must be an object (got ${typeName(value)})`);
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null);
  let ok = true;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") { issues.add(path, "must not have symbol keys"); ok = false; continue; }
    const d = descriptors[key];
    if (!("value" in d)) { issues.add(`${path}.${key}`, "must be a plain value (no getter or setter)"); ok = false; continue; }
    if (!required.includes(key) && !optional.includes(key)) { issues.add(`${path}.${key}`, "is not a recognised field"); ok = false; continue; }
    copy[key] = d.value;
  }
  for (const key of required) if (!(key in copy)) { issues.add(`${path}.${key}`, "is required"); ok = false; }
  return ok ? copy : null;
}

/** A dense array of min..max items (values read once), or null with issues. */
export function readList(issues: Issues, path: string, value: unknown, limits: { min: number; max: number }): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    issues.add(path, `must be a list (got ${typeName(value)})`);
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter((k) => k !== "length");
  if (keys.length !== value.length || keys.some((k, i) => k !== String(i) || !("value" in descriptors[k as string]))) {
    issues.add(path, "must be a plain list (no holes, extra properties, getters or setters)");
    return null;
  }
  if (value.length < limits.min || value.length > limits.max) {
    issues.add(path, `must have ${limits.min === limits.max ? limits.min : `${limits.min} to ${limits.max}`} item(s) (got ${value.length})`);
    return null;
  }
  return keys.map((k) => descriptors[k as string].value);
}

export function readText(issues: Issues, path: string, value: unknown, options: { max: number; pattern?: RegExp; allowEmpty?: boolean }): string {
  if (typeof value !== "string") { issues.add(path, `must be text (got ${typeName(value)})`); return ""; }
  if (value.trim() === "" && !options.allowEmpty) { issues.add(path, "must not be empty"); return value; }
  if (value.length > options.max) { issues.add(path, `must be at most ${options.max} characters`); return value; }
  if (/[\t\n\r]/.test(value) || UNSAFE_TEXT.test(value) || UNPAIRED_SURROGATE.test(value)) {
    issues.add(path, "must be printable single-line text (no control, bidi or invisible characters)");
    return value;
  }
  if (options.pattern && !options.pattern.test(value)) issues.add(path, "has an invalid format");
  return value;
}

export const readId = (issues: Issues, path: string, value: unknown): string => readText(issues, path, value, { max: 64, pattern: ID_PATTERN });

export function readOneOf<T extends string>(issues: Issues, path: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.add(path, `must be one of: ${allowed.join(", ")}`);
    return allowed[0];
  }
  return value as T;
}

export function readBool(issues: Issues, path: string, value: unknown): boolean {
  if (typeof value !== "boolean") { issues.add(path, `must be true or false (got ${typeName(value)})`); return false; }
  return value;
}

export function readSafeInt(issues: Issues, path: string, value: unknown, limits: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < limits.min || value > limits.max) {
    issues.add(path, `must be a whole number from ${limits.min} to ${limits.max}`);
    return limits.min;
  }
  return value;
}

const daysInMonth = (y: number, m: number): number => (m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

function validCalendarDate(y: number, m: number, d: number): boolean {
  return y >= 1900 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function readTimestamp(issues: Issues, path: string, value: unknown): string {
  const m = typeof value === "string" ? TIMESTAMP_PATTERN.exec(value) : null;
  if (!m || !validCalendarDate(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59 || +m[6] > 59) {
    issues.add(path, "must be a UTC timestamp like 2026-03-02T21:00:00Z");
    return "";
  }
  return value as string;
}

export function readDate(issues: Issues, path: string, value: unknown): string {
  const m = typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  if (!m || !validCalendarDate(+m[1], +m[2], +m[3])) {
    issues.add(path, "must be a calendar date like 2026-03-02");
    return "";
  }
  return value as string;
}

export function readSha256(issues: Issues, path: string, value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) { issues.add(path, "must be 64 lowercase hexadecimal characters (a SHA-256)"); return ""; }
  return value;
}

/** Positive decimal price text ("123.45"), as an exact scaled integer for comparisons. */
export function readPrice(issues: Issues, path: string, value: unknown): { text: string; units: bigint; scale: number } | null {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) { issues.add(path, "must be a decimal string like \"123.45\""); return null; }
  const [whole, frac = ""] = value.split(".");
  const units = BigInt(whole + frac);
  if (units === 0n) { issues.add(path, "must be greater than zero"); return null; }
  return { text: value, units, scale: frac.length };
}

/** Compares two exact decimals: negative, zero or positive. */
export function compareDecimals(a: { units: bigint; scale: number }, b: { units: bigint; scale: number }): number {
  const scale = Math.max(a.scale, b.scale);
  const x = a.units * 10n ** BigInt(scale - a.scale);
  const y = b.units * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Days since 1970-01-01 for a valid "YYYY-MM-DD" (proleptic Gregorian; no Date object). */
export function dayNumber(date: string): number {
  let y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** 0 = Sunday ... 6 = Saturday. */
export const dayOfWeek = (date: string): number => (((dayNumber(date) + 4) % 7) + 7) % 7;

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export const MAX_JSON_DEPTH = 32;

/**
 * Parses JSON text strictly (R2): text only, at most `maxChars` characters,
 * no byte-order mark, at most MAX_JSON_DEPTH levels of nesting and no
 * duplicate object keys (JSON.parse would silently keep the last one;
 * escaped spellings of the same key count as duplicates). One linear scan,
 * then JSON.parse. Throws ReadinessInputError.
 */
export function parseJsonStrict(text: unknown, label: string, maxChars: number): unknown {
  if (typeof text !== "string") throw new ReadinessInputError([`${label}: must be text`]);
  if (text.length > maxChars) throw new ReadinessInputError([`${label}: is longer than ${maxChars} characters`]);
  if (text.charCodeAt(0) === 0xfeff) throw new ReadinessInputError([`${label}: must not start with a byte-order mark`]);
  const stack: Array<{ object: boolean; keys: Set<string>; expectKey: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\"") j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.object && top.expectKey) {
        let key: unknown;
        try { key = JSON.parse(text.slice(i, j + 1)); } catch { break; } // malformed: JSON.parse below reports it
        if (top.keys.has(key as string)) throw new ReadinessInputError([`${label}: has a duplicate key ${JSON.stringify(key).slice(0, 80)} (ambiguous)`]);
        top.keys.add(key as string);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{" || c === "[") {
      stack.push({ object: c === "{", keys: new Set(), expectKey: c === "{" });
      if (stack.length > MAX_JSON_DEPTH) throw new ReadinessInputError([`${label}: is nested more than ${MAX_JSON_DEPTH} levels deep`]);
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === "," && stack[stack.length - 1]?.object) {
      stack[stack.length - 1].expectKey = true;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReadinessInputError([`${label}: is not valid JSON`]);
  }
}

/** UTF-8 length in bytes (strings here are already strict UTF-8 without lone surrogates). */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
