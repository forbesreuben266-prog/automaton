/**
 * Minimal strict validators (no dependencies). Every parser rejects unknown
 * keys, wrong types and out-of-range values, and collects all issues so a
 * caller sees everything wrong with an input at once. Nothing is defaulted
 * or invented: a missing required value is an error.
 */

export class SchemaError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid input:\n- ${issues.join("\n- ")}`);
    this.name = "SchemaError";
  }
}

export class Issues {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
  throwIfAny(): void {
    if (this.list.length > 0) throw new SchemaError(this.list);
  }
}

/**
 * Names a value's type for error messages WITHOUT converting it: no
 * toString/valueOf/Symbol.toPrimitive, getter or Proxy trap is invoked.
 * Never interpolate an unvalidated value into a message; use this instead.
 */
export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Throws a TypeError (with a non-coercing message) unless `value` is a primitive string. */
export function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string (got ${typeName(value)})`);
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.getPrototypeOf({});
}

/**
 * Checks the object shape: plain data object, no getters/setters, required
 * keys present, no unknown keys. Returns false (and the caller must not read
 * the object) when it isn't a plain data object.
 */
export function checkKeys(
  issues: Issues,
  path: string,
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    issues.add(path, `must be a plain object (got ${typeName(value)})`);
    return false;
  }
  // Getters/setters would run caller-supplied code when read; refuse them unread.
  const accessors = Object.entries(Object.getOwnPropertyDescriptors(value))
    .filter(([, d]) => d.get !== undefined || d.set !== undefined)
    .map(([k]) => k);
  if (accessors.length > 0) {
    for (const key of accessors) issues.add(`${path}.${key}`, "must be a plain data value, not a getter/setter");
    return false;
  }
  for (const key of required) {
    if (!(key in value)) issues.add(`${path}.${key}`, "is required");
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.add(`${path}.${key}`, "is not an allowed field");
  }
  return true;
}

export function str(
  issues: Issues,
  path: string,
  value: unknown,
  opts: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  const min = opts.min ?? 1;
  const max = opts.max ?? 10_000;
  if (typeof value !== "string") {
    issues.add(path, `must be a string (got ${typeName(value)})`);
    return "";
  }
  if (value.trim().length < min) issues.add(path, `must have at least ${min} non-blank characters`);
  if (value.length > max) issues.add(path, `must be at most ${max} characters`);
  if (opts.pattern && !opts.pattern.test(value)) issues.add(path, `has an invalid format`);
  return value;
}

export function id(issues: Issues, path: string, value: unknown): string {
  return str(issues, path, value, { max: 64, pattern: ID_PATTERN });
}

export function safeInt(
  issues: Issues,
  path: string,
  value: unknown,
  opts: { min?: number; max?: number } = {},
): number {
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    issues.add(path, `must be a safe integer (got ${typeof value === "number" ? String(value) : typeName(value)})`);
    return 0;
  }
  if (value < min || value > max) issues.add(path, `must be between ${min} and ${max}`);
  return value;
}

export function oneOf<T extends string>(issues: Issues, path: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.add(path, `must be one of: ${allowed.join(", ")}`);
    return allowed[0];
  }
  return value as T;
}

export function bool(issues: Issues, path: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    issues.add(path, "must be a boolean");
    return false;
  }
  return value;
}

export function arr(
  issues: Issues,
  path: string,
  value: unknown,
  opts: { min?: number; max?: number } = {},
): unknown[] {
  if (!Array.isArray(value)) {
    issues.add(path, `must be an array (got ${typeName(value)})`);
    return [];
  }
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => d.get !== undefined || d.set !== undefined)) {
    issues.add(path, "must contain plain data values, not getters/setters");
    return [];
  }
  if (opts.min !== undefined && value.length < opts.min) issues.add(path, `must have at least ${opts.min} item(s)`);
  if (opts.max !== undefined && value.length > opts.max) issues.add(path, `must have at most ${opts.max} items`);
  return value;
}

function validCalendarDate(text: string): boolean {
  const date = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text.slice(0, 10);
}

/** YYYY-MM-DD, a real calendar date. */
export function isoDate(issues: Issues, path: string, value: unknown): string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || !validCalendarDate(value)) {
    issues.add(path, "must be a calendar date in YYYY-MM-DD format");
    return "";
  }
  return value;
}

/** UTC timestamp, e.g. 2026-10-01T09:30:00Z. */
export function isoDateTime(issues: Issues, path: string, value: unknown): string {
  if (typeof value !== "string" || !ISO_DATETIME_UTC.test(value) || !validCalendarDate(value) ||
      Number.isNaN(Date.parse(value))) {
    issues.add(path, "must be a UTC timestamp like 2026-10-01T09:30:00Z");
    return "";
  }
  return value;
}

export function uniqueIds(issues: Issues, path: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const value of ids) {
    if (seen.has(value)) issues.add(path, `duplicate id "${value}"`);
    seen.add(value);
  }
}

/** Days from `from` to `to` (both YYYY-MM-DD or ISO timestamps), by UTC calendar date. */
export function daysBetween(from: string, to: string): number {
  assertString(from, "from");
  assertString(to, "to");
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Freezes objects this division constructed itself (never called on caller input). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
