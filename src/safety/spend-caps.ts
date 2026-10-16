/**
 * Safe-mode spending caps
 *
 * In safe mode the per-call, hourly and daily inference caps are mandatory.
 * Each must be a whole number of cents, above 0 and at most the hard maxima
 * below, with perCall <= hourly <= daily. Missing values can't fall back to
 * permissive defaults: a missing per-call or hourly cap merges to 0 (no
 * limit) and a missing daily cap merges to the $500 default, and both are
 * rejected here.
 */

export const SAFE_MODE_SPEND_MAXIMA = Object.freeze({
  perCallCents: 10,
  hourlyCents: 50,
  dailyCents: 500,
});

export interface SpendCaps {
  perCallCents: unknown;
  hourlyCents: unknown;
  dailyCents: unknown;
}

export function spendCapsFromConfig(config: {
  modelStrategy?: { perCallCeilingCents?: unknown; hourlyBudgetCents?: unknown };
  treasuryPolicy?: { maxInferenceDailyCents?: unknown };
}): SpendCaps {
  return {
    perCallCents: config.modelStrategy?.perCallCeilingCents,
    hourlyCents: config.modelStrategy?.hourlyBudgetCents,
    dailyCents: config.treasuryPolicy?.maxInferenceDailyCents,
  };
}

/** Returns a list of problems; empty means the caps are valid for safe mode. */
export function validateSafeModeSpendCaps(caps: SpendCaps): string[] {
  const problems: string[] = [];
  const check = (name: string, value: unknown, max: number): number | null => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      problems.push(`${name} must be a whole number of cents (got ${JSON.stringify(value)})`);
      return null;
    }
    if (value <= 0) {
      problems.push(`${name} must be greater than 0 (got ${value})`);
      return null;
    }
    if (value > max) {
      problems.push(`${name} must be at most ${max} cents in safe mode (got ${value})`);
      return null;
    }
    return value;
  };

  const perCall = check("perCallCeilingCents", caps.perCallCents, SAFE_MODE_SPEND_MAXIMA.perCallCents);
  const hourly = check("hourlyBudgetCents", caps.hourlyCents, SAFE_MODE_SPEND_MAXIMA.hourlyCents);
  const daily = check("maxInferenceDailyCents", caps.dailyCents, SAFE_MODE_SPEND_MAXIMA.dailyCents);

  if (perCall !== null && hourly !== null && perCall > hourly) {
    problems.push(`perCallCeilingCents (${perCall}) must not exceed hourlyBudgetCents (${hourly})`);
  }
  if (hourly !== null && daily !== null && hourly > daily) {
    problems.push(`hourlyBudgetCents (${hourly}) must not exceed maxInferenceDailyCents (${daily})`);
  }
  return problems;
}
