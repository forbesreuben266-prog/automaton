/**
 * Run Guard
 *
 * Bounds how long `--run` may operate. `--max-cycles N` stops the runtime
 * after N agent-loop cycles (successful, failed or retried — every attempt
 * counts). In safe mode a cycle limit is mandatory, and any value that
 * cannot be enforced makes the runtime refuse to start.
 */

const MAX_CYCLES_FLAG = "--max-cycles";
const MAX_ALLOWED_CYCLES = 1_000;
const MAX_ALLOWED_TURNS_PER_CYCLE = 1_000;
const DEFAULT_TURNS_PER_CYCLE = 25;

export class RunGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunGuardError";
  }
}

function parsePositiveInt(raw: string | undefined, what: string, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    throw new RunGuardError(`${what} must be a whole number between 1 and ${max} (got ${JSON.stringify(raw)})`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RunGuardError(`${what} must be between 1 and ${max} (got ${value})`);
  }
  return value;
}

/**
 * Parse `--max-cycles N` or `--max-cycles=N`. Returns null when the flag is
 * absent; throws when it is present but malformed or repeated.
 */
export function parseMaxCycles(args: string[]): number | null {
  const matches = args
    .map((arg, index) => ({ arg, index }))
    .filter(({ arg }) => arg === MAX_CYCLES_FLAG || arg.startsWith(`${MAX_CYCLES_FLAG}=`));

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new RunGuardError(`${MAX_CYCLES_FLAG} may only be given once`);
  }

  const { arg, index } = matches[0];
  const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
  return parsePositiveInt(raw, MAX_CYCLES_FLAG, MAX_ALLOWED_CYCLES);
}

/**
 * Validate that this run is bounded. Throws (refuse to start) when:
 * - safe mode is active and no cycle limit was given, or
 * - a cycle limit was given but turns per cycle are not a valid bound.
 */
export function assertRunBounded(params: {
  safeMode: boolean;
  maxCycles: number | null;
  maxTurnsPerCycle: unknown;
}): void {
  const { safeMode, maxCycles, maxTurnsPerCycle } = params;

  if (safeMode && maxCycles === null) {
    throw new RunGuardError(
      `Safe mode requires ${MAX_CYCLES_FLAG} N so the run is bounded. Refusing to start.`,
    );
  }

  if (maxCycles !== null) {
    const turns = maxTurnsPerCycle === undefined ? DEFAULT_TURNS_PER_CYCLE : maxTurnsPerCycle;
    if (
      typeof turns !== "number" ||
      !Number.isSafeInteger(turns) ||
      turns < 1 ||
      turns > MAX_ALLOWED_TURNS_PER_CYCLE
    ) {
      throw new RunGuardError(
        `maxTurnsPerCycle must be a whole number between 1 and ${MAX_ALLOWED_TURNS_PER_CYCLE} when ${MAX_CYCLES_FLAG} is used (got ${JSON.stringify(turns)}). Refusing to start.`,
      );
    }
  }
}

/** Counts agent-loop cycles and reports when the limit is reached. */
export class CycleLimiter {
  private started = 0;

  constructor(private readonly maxCycles: number | null) {}

  /** Call before each cycle attempt. Returns false when no cycles remain. */
  tryBeginCycle(): boolean {
    if (this.maxCycles !== null && this.started >= this.maxCycles) return false;
    this.started += 1;
    return true;
  }

  /** True once every allowed cycle has been started. */
  isExhausted(): boolean {
    return this.maxCycles !== null && this.started >= this.maxCycles;
  }

  get cyclesStarted(): number {
    return this.started;
  }
}
