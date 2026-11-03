/**
 * Strict, bounded validation helpers for the trading research foundation
 * (milestone T1). Pure and deterministic: no filesystem, network, process,
 * environment, clock or randomness.
 *
 * - JSON text is the intended input. parseJsonText checks the type and size
 *   first, then scans the text once (bounded, linear) for duplicate object
 *   keys (escaped spellings of the same key count as duplicates) and
 *   excessive nesting, then parses it. Duplicate keys are refused because
 *   JSON.parse would silently keep the last one (ambiguous input).
 * - Objects must be plain data: unknown fields, missing fields, getters and
 *   setters are refused; nothing is defaulted. Arrays must be dense with no
 *   extra properties. Each value is read once.
 * - Text is printable single-line (or explicitly multi-line) Unicode without
 *   control, bidi or invisible formatting characters.
 * - Decimals are strings ("123.45"), never JSON numbers, and are converted
 *   exactly with BigInt; tick conversions must divide exactly and fit in a
 *   safe integer.
 * - At most MAX_ISSUES detailed problems are reported, then a count.
 * Direct (non-JSON) objects are not sandboxed: Proxy traps run during
 * inspection, so direct callers must be trusted code.
 */

export const MAX_ISSUES = 100;
export const MAX_JSON_DEPTH = 16;
/** Longest accepted decimal: 15 integer digits and 8 decimal places. */
export const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,8})?$/;
const TIMESTAMP_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;
/** C0 (except tab/LF/CR handled by the caller), DEL, C1, bidi controls, zero-width and other invisible formatting characters. */
export const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const LINE_BREAK = /[\t\n\r]/;
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export class ValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Trading research input refused:\n- ${issues.join("\n- ")}`);
    this.name = "ValidationError";
  }
}

/** Collects at most MAX_ISSUES problems, then counts the rest. */
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
    throw new ValidationError(this.extra > 0 ? [...this.items, `... and ${this.extra} more problem(s)`] : [...this.items]);
  }
}

const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

/**
 * Reads a plain data object with exactly the required keys (plus any optional
 * ones). Returns a null-prototype copy holding each value read once, or null
 * (with issues) when the shape is wrong.
 */
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
    if (d.get || d.set) { issues.add(`${path}.${key}`, "must be a plain value, not a getter/setter"); ok = false; continue; }
    if (!required.includes(key) && !optional.includes(key)) { issues.add(`${path}.${key}`, "is not an allowed field"); ok = false; continue; }
    copy[key] = d.value;
  }
  for (const key of required) if (!(key in copy) && !(key in descriptors)) { issues.add(`${path}.${key}`, "is required"); ok = false; }
  return ok ? copy : null;
}

/** Reads a dense array of at most max entries (refused before any entry is read if longer). Returns a copy. */
export function readList(issues: Issues, path: string, value: unknown, opts: { min: number; max: number }): unknown[] | null {
  if (!Array.isArray(value)) {
    issues.add(path, `must be an array (got ${typeName(value)})`);
    return null;
  }
  if (value.length > opts.max) { issues.add(path, `must have at most ${opts.max} entries`); return null; }
  if (value.length < opts.min) { issues.add(path, `must have at least ${opts.min} entr${opts.min === 1 ? "y" : "ies"}`); return null; }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) { issues.add(path, "must be a plain array (no holes or extra properties)"); return null; }
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = descriptors[i];
    if (!d || d.get || d.set) { issues.add(`${path}[${i}]`, "must be a plain value"); return null; }
    out.push(d.value);
  }
  return out;
}

/** A string of safe text. Single-line by default (no tab or line breaks). */
export function readText(issues: Issues, path: string, value: unknown, opts: { max: number; min?: number; multiLine?: boolean; pattern?: RegExp }): string {
  if (typeof value !== "string") { issues.add(path, `must be a string (got ${typeName(value)})`); return ""; }
  const min = opts.min ?? 1;
  if (value.trim().length < min) issues.add(path, `must have at least ${min} non-blank character(s)`);
  if (value.length > opts.max) issues.add(path, `must be at most ${opts.max} characters`);
  else if (UNSAFE_TEXT.test(value) || UNPAIRED_SURROGATE.test(value)) issues.add(path, "contains a control, bidi or invisible formatting character");
  else if (!opts.multiLine && LINE_BREAK.test(value)) issues.add(path, "must be a single line");
  if (opts.pattern && !opts.pattern.test(value)) issues.add(path, "has an invalid format");
  return value;
}

export function readOneOf<T extends string>(issues: Issues, path: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.add(path, `must be one of: ${allowed.join(", ")}`);
    return allowed[0];
  }
  return value as T;
}

export function readSafeInt(issues: Issues, path: string, value: unknown, opts: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < opts.min || value > opts.max) {
    issues.add(path, `must be an integer from ${opts.min} to ${opts.max}`);
    return opts.min;
  }
  return value;
}

/** An exact decimal: units / 10^scale (scale 0-8). */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

/** Parses a decimal string ("12.30"); JSON numbers are refused (no binary floating-point input). */
export function readDecimal(issues: Issues, path: string, value: unknown): Decimal | null {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    issues.add(path, "must be a decimal string such as \"12.34\" (no sign, exponent or more than 8 decimal places)");
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

/** Canonical text of a decimal: no trailing fractional zeros ("12.30" -> "12.3", "0.000" -> "0"). */
export function canonicalDecimal(d: Decimal): string {
  const digits = d.units.toString().padStart(d.scale + 1, "0");
  if (d.scale === 0) return digits;
  const whole = digits.slice(0, digits.length - d.scale);
  const fraction = digits.slice(digits.length - d.scale).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

export const isZero = (d: Decimal) => d.units === 0n;

/**
 * Exact number of ticks in a decimal: value / tick must be a whole number and
 * a safe integer (otherwise null). Computed with BigInt, so no rounding occurs.
 */
export function ticksOf(value: Decimal, tick: Decimal): number | null {
  if (tick.units <= 0n) return null;
  const numerator = value.units * 10n ** BigInt(tick.scale);
  const denominator = tick.units * 10n ** BigInt(value.scale);
  if (numerator % denominator !== 0n) return null;
  const ticks = numerator / denominator;
  return ticks <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(ticks) : null;
}

/** Reads a decimal and converts it to whole ticks, refusing non-multiples, zero (unless allowed) and unsafe sizes. */
export function readTicks(issues: Issues, path: string, value: unknown, tick: Decimal, opts: { allowZero: boolean }): number | null {
  const d = readDecimal(issues, path, value);
  if (d === null) return null;
  const ticks = ticksOf(d, tick);
  if (ticks === null) { issues.add(path, `must be a whole multiple of the tick size ${canonicalDecimal(tick)} (and within the safe range)`); return null; }
  if (ticks === 0 && !opts.allowZero) { issues.add(path, "must be greater than zero"); return null; }
  return ticks;
}

const daysInMonth = (year: number, month: number) =>
  month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/** A UTC timestamp "YYYY-MM-DDTHH:MM:SSZ" (years 1970-2199), validated as a real calendar instant without using a clock. */
export function readTimestamp(issues: Issues, path: string, value: unknown): string {
  const m = typeof value === "string" ? TIMESTAMP_PATTERN.exec(value) : null;
  if (!m) { issues.add(path, "must be a UTC timestamp like 2026-01-05T21:00:00Z"); return ""; }
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (year < 1970 || year > 2199 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    issues.add(path, "is not a real calendar date and time");
    return "";
  }
  return value as string;
}

/**
 * Parses JSON text after checking type and size, refusing duplicate keys and
 * nesting deeper than MAX_JSON_DEPTH. Throws ValidationError.
 */
export function parseJsonText(text: unknown, label: string, maxChars: number): unknown {
  if (typeof text !== "string") throw new ValidationError([`${label}: must be JSON text (got ${typeName(text)})`]);
  if (text.length > maxChars) throw new ValidationError([`${label}: is ${text.length} characters; the limit is ${maxChars}`]);
  if (text.charCodeAt(0) === 0xfeff) throw new ValidationError([`${label}: must not start with a byte-order mark`]);
  const problem = scanJson(text);
  if (problem !== null) throw new ValidationError([`${label}: ${problem}`]);
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError([`${label}: is not valid JSON`]);
  }
}

/** One linear pass: duplicate keys (compared after unescaping) and nesting depth. Malformed JSON is left to JSON.parse. */
function scanJson(src: string): string | null {
  const frames: Array<Set<string> | null> = []; // a Set of keys for objects, null for arrays
  let keyNext = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\"") {
      let j = i + 1;
      while (j < src.length && src[j] !== "\"") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return "is not valid JSON (unterminated string)";
      if (keyNext) {
        let key: string;
        try { key = JSON.parse(src.slice(i, j + 1)) as string; } catch { return "is not valid JSON (malformed string)"; }
        const keys = frames[frames.length - 1]!;
        if (keys.has(key)) return `duplicate key ${JSON.stringify(key.slice(0, 40))} (ambiguous input)`;
        keys.add(key);
        keyNext = false;
      }
      i = j;
    } else if (c === "{" || c === "[") {
      frames.push(c === "{" ? new Set() : null);
      if (frames.length > MAX_JSON_DEPTH) return `is nested more than ${MAX_JSON_DEPTH} levels deep`;
      keyNext = c === "{";
    } else if (c === "}" || c === "]") {
      frames.pop();
      keyNext = false;
    } else if (c === ",") {
      keyNext = frames[frames.length - 1] instanceof Set;
    }
  }
  return null;
}
