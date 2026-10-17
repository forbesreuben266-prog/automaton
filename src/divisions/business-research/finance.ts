/**
 * Deterministic financial scenarios.
 *
 * Every input is a named assumption with an explicit unit and a basis (a
 * claim it comes from, or a stated rationale). Money is integer minor units
 * (pence or cents) so results are exact. A missing, wrong-unit, negative,
 * fractional or overflowing input is rejected; nothing is defaulted.
 *
 * Formulas (per month unless stated):
 *   revenue        = unitsSoldPerMonth × pricePerUnit
 *   variableCost   = unitsSoldPerMonth × variableCostPerUnit
 *   acquisition    = newCustomersPerMonth × acquisitionCostPerCustomer
 *   fixedCost      = Σ monthly fixed cost lines
 *   profit         = revenue − variableCost − acquisition − fixedCost
 *   startupCost    = Σ one-off startup cost lines
 *   cumulative     = profit × horizonMonths − startupCost   (over the horizon)
 *   breakEvenMonth = first month m ≥ 1 with profit × m ≥ startupCost, i.e.
 *                    max(1, ceil(startupCost ÷ profit)); requires profit > 0 and
 *                    m ≤ horizon, else none (zero profit never "breaks even")
 * Steady-state model: no growth, churn, seasonality, tax or financing costs.
 */

import { Issues, SchemaError, arr, checkKeys, deepFreeze, id, oneOf, safeInt, str, typeName, uniqueIds } from "./validation.js";

export const CURRENCIES = ["GBP", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const UNITS = ["GBP_minor", "USD_minor", "count", "months"] as const;
export type Unit = (typeof UNITS)[number];
export const SCENARIO_NAMES = ["conservative", "realistic", "optimistic"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];
export const MAX_HORIZON_MONTHS = 120;

export type AssumptionBasis =
  | { readonly kind: "claim"; readonly claimId: string }
  | { readonly kind: "assumption"; readonly rationale: string };

export interface Assumption {
  readonly id: string;
  readonly label: string;
  /** Non-negative integer in `unit` (minor currency units, a count, or months). */
  readonly value: number;
  readonly unit: Unit;
  readonly basis: AssumptionBasis;
}

export interface ScenarioDefinition {
  readonly name: ScenarioName;
  readonly currency: Currency;
  readonly startupCostIds: readonly string[];
  readonly monthlyFixedCostIds: readonly string[];
  readonly pricePerUnitId: string;
  readonly variableCostPerUnitId: string;
  readonly unitsSoldPerMonthId: string;
  readonly newCustomersPerMonthId: string;
  readonly acquisitionCostPerCustomerId: string;
  readonly horizonMonthsId: string;
}

export interface CalculationLine {
  readonly label: string;
  readonly formula: string;
  readonly value: number;
  readonly unit: Unit;
}

export interface ScenarioResult {
  readonly name: ScenarioName;
  readonly currency: Currency;
  readonly startupCostMinor: number;
  readonly monthlyRevenueMinor: number;
  readonly monthlyVariableCostMinor: number;
  readonly monthlyAcquisitionCostMinor: number;
  readonly monthlyFixedCostMinor: number;
  readonly monthlyProfitMinor: number;
  readonly horizonMonths: number;
  readonly cumulativeProfitMinor: number;
  /** null = does not break even within the horizon. */
  readonly breakEvenMonth: number | null;
  readonly lines: readonly CalculationLine[];
  /** Assumption ids used, for tracing every figure back to its basis. */
  readonly inputs: readonly string[];
}

const moneyUnit = (c: Currency): Unit => (c === "GBP" ? "GBP_minor" : "USD_minor");

export function parseAssumptions(raw: unknown): Assumption[] {
  const issues = new Issues();
  const list = arr(issues, "assumptions", raw, { max: 500 }).map((a, i): Assumption => {
    const p = `assumptions[${i}]`;
    if (!checkKeys(issues, p, a, ["id", "label", "value", "unit", "basis"])) return undefined as never;
    let basis: AssumptionBasis = { kind: "assumption", rationale: "" };
    const b = a.basis;
    if (checkKeys(issues, `${p}.basis`, b, ["kind"], ["claimId", "rationale"])) {
      const kind = oneOf(issues, `${p}.basis.kind`, b.kind, ["claim", "assumption"] as const);
      if (kind === "claim") {
        if (b.rationale !== undefined) issues.add(`${p}.basis.rationale`, "is not allowed for a claim basis");
        basis = { kind, claimId: id(issues, `${p}.basis.claimId`, b.claimId) };
      } else {
        if (b.claimId !== undefined) issues.add(`${p}.basis.claimId`, "is not allowed for an assumption basis");
        basis = { kind, rationale: str(issues, `${p}.basis.rationale`, b.rationale, { max: 2_000 }) };
      }
    }
    return {
      id: id(issues, `${p}.id`, a.id),
      label: str(issues, `${p}.label`, a.label, { max: 200 }),
      value: safeInt(issues, `${p}.value`, a.value, { min: 0 }),
      unit: oneOf(issues, `${p}.unit`, a.unit, UNITS),
      basis,
    };
  });
  issues.throwIfAny();
  uniqueIds(issues, "assumptions", list.map((a) => a.id));
  issues.throwIfAny();
  return deepFreeze(list);
}

const SINGLE_INPUT_FIELDS = [
  "pricePerUnitId", "variableCostPerUnitId", "unitsSoldPerMonthId",
  "newCustomersPerMonthId", "acquisitionCostPerCustomerId", "horizonMonthsId",
] as const;

function readScenario(issues: Issues, p: string, s: unknown): ScenarioDefinition {
  if (!checkKeys(issues, p, s, ["name", "currency", "startupCostIds", "monthlyFixedCostIds", ...SINGLE_INPUT_FIELDS])) {
    return undefined as never;
  }
  const ids = (key: string, value: unknown) =>
    arr(issues, `${p}.${key}`, value, { max: 100 }).map((v, j) => id(issues, `${p}.${key}[${j}]`, v));
  const single = Object.fromEntries(SINGLE_INPUT_FIELDS.map((f) => [f, id(issues, `${p}.${f}`, s[f])]));
  return {
    name: oneOf(issues, `${p}.name`, s.name, SCENARIO_NAMES),
    currency: oneOf(issues, `${p}.currency`, s.currency, CURRENCIES),
    startupCostIds: ids("startupCostIds", s.startupCostIds),
    monthlyFixedCostIds: ids("monthlyFixedCostIds", s.monthlyFixedCostIds),
    ...(single as Record<(typeof SINGLE_INPUT_FIELDS)[number], string>),
  };
}

export function parseScenarioDefinition(raw: unknown, path = "scenario"): ScenarioDefinition {
  const issues = new Issues();
  const def = readScenario(issues, path, raw);
  issues.throwIfAny();
  return deepFreeze(def);
}

export function parseScenarioDefinitions(raw: unknown): ScenarioDefinition[] {
  const issues = new Issues();
  const list = arr(issues, "scenarios", raw, { min: 3, max: 3 }).map((s, i) => readScenario(issues, `scenarios[${i}]`, s));
  issues.throwIfAny();
  const names = list.map((s) => s.name);
  for (const name of SCENARIO_NAMES) if (!names.includes(name)) issues.add("scenarios", `missing the ${name} scenario`);
  if (new Set(list.map((s) => s.currency)).size > 1) issues.add("scenarios", "must all use the same currency");
  issues.throwIfAny();
  return deepFreeze(list);
}

function checkedAdd(issues: Issues, label: string, a: number, b: number): number {
  const r = a + b;
  if (!Number.isSafeInteger(r)) issues.add(label, "overflows the safe integer range");
  return r;
}

function checkedMul(issues: Issues, label: string, a: number, b: number): number {
  const r = a * b;
  if (!Number.isSafeInteger(r)) issues.add(label, "overflows the safe integer range");
  return r;
}

/**
 * Calculates one scenario. Both inputs are re-validated here (strict schema,
 * non-negative safe integers, known units), so unvalidated or negative values
 * can't be calculated by calling this directly.
 */
export function calculateScenario(def: unknown, assumptions: unknown): ScenarioResult {
  return computeScenario(parseScenarioDefinition(def), parseAssumptions(assumptions));
}

function computeScenario(def: ScenarioDefinition, assumptions: readonly Assumption[]): ScenarioResult {
  const issues = new Issues();
  const byId = new Map(assumptions.map((a) => [a.id, a]));
  const money = moneyUnit(def.currency);
  const used: string[] = [];
  const take = (field: string, assumptionId: string, unit: Unit): number => {
    const a = byId.get(assumptionId);
    used.push(assumptionId);
    if (!a) {
      issues.add(`${def.name}.${field}`, `assumption "${assumptionId}" was not supplied`);
      return 0;
    }
    if (a.unit !== unit) issues.add(`${def.name}.${field}`, `assumption "${a.id}" is in ${a.unit}, expected ${unit}`);
    return a.value;
  };

  const startup = def.startupCostIds.reduce((sum, aid) => checkedAdd(issues, `${def.name}.startupCost`, sum, take("startupCostIds", aid, money)), 0);
  const fixed = def.monthlyFixedCostIds.reduce((sum, aid) => checkedAdd(issues, `${def.name}.fixedCost`, sum, take("monthlyFixedCostIds", aid, money)), 0);
  const price = take("pricePerUnitId", def.pricePerUnitId, money);
  const variable = take("variableCostPerUnitId", def.variableCostPerUnitId, money);
  const units = take("unitsSoldPerMonthId", def.unitsSoldPerMonthId, "count");
  const newCustomers = take("newCustomersPerMonthId", def.newCustomersPerMonthId, "count");
  const cac = take("acquisitionCostPerCustomerId", def.acquisitionCostPerCustomerId, money);
  const horizon = take("horizonMonthsId", def.horizonMonthsId, "months");
  if (horizon < 1 || horizon > MAX_HORIZON_MONTHS) {
    issues.add(`${def.name}.horizonMonthsId`, `horizon must be 1-${MAX_HORIZON_MONTHS} months`);
  }
  issues.throwIfAny();

  const revenue = checkedMul(issues, `${def.name}.revenue`, units, price);
  const variableCost = checkedMul(issues, `${def.name}.variableCost`, units, variable);
  const acquisition = checkedMul(issues, `${def.name}.acquisition`, newCustomers, cac);
  const profit = revenue - variableCost - acquisition - fixed;
  const cumulative = checkedMul(issues, `${def.name}.cumulative`, profit, horizon) - startup;
  if (!Number.isSafeInteger(profit) || !Number.isSafeInteger(cumulative)) issues.add(def.name, "overflows the safe integer range");
  issues.throwIfAny();

  let breakEvenMonth: number | null = null;
  if (profit > 0) {
    let months = Math.ceil(startup / profit);
    // Correct any floating-point rounding so months is the exact integer ceiling.
    if (months > 0 && (months - 1) * profit >= startup) months -= 1;
    else if (months * profit < startup) months += 1;
    months = Math.max(1, months); // zero startup cost: break-even in the first month, not "month 0"
    if (months <= horizon) breakEvenMonth = months;
  }

  const lines: CalculationLine[] = [
    { label: "Startup cost (one-off)", formula: `sum(${def.startupCostIds.join(", ") || "none"})`, value: startup, unit: money },
    { label: "Monthly revenue", formula: `${def.unitsSoldPerMonthId} × ${def.pricePerUnitId}`, value: revenue, unit: money },
    { label: "Monthly variable cost", formula: `${def.unitsSoldPerMonthId} × ${def.variableCostPerUnitId}`, value: variableCost, unit: money },
    { label: "Monthly acquisition cost", formula: `${def.newCustomersPerMonthId} × ${def.acquisitionCostPerCustomerId}`, value: acquisition, unit: money },
    { label: "Monthly fixed cost", formula: `sum(${def.monthlyFixedCostIds.join(", ") || "none"})`, value: fixed, unit: money },
    { label: "Monthly profit", formula: "revenue − variable − acquisition − fixed", value: profit, unit: money },
    { label: `Cumulative profit over ${horizon} months`, formula: `profit × ${def.horizonMonthsId} − startup`, value: cumulative, unit: money },
  ];

  return deepFreeze({
    name: def.name,
    currency: def.currency,
    startupCostMinor: startup,
    monthlyRevenueMinor: revenue,
    monthlyVariableCostMinor: variableCost,
    monthlyAcquisitionCostMinor: acquisition,
    monthlyFixedCostMinor: fixed,
    monthlyProfitMinor: profit,
    horizonMonths: horizon,
    cumulativeProfitMinor: cumulative,
    breakEvenMonth,
    lines,
    inputs: [...new Set(used)],
  });
}

/**
 * Calculates all three scenarios and checks they're labelled honestly:
 * conservative ≤ realistic ≤ optimistic by monthly and cumulative profit.
 */
export function calculateScenarios(rawDefs: unknown, rawAssumptions: unknown): ScenarioResult[] {
  const defs = parseScenarioDefinitions(rawDefs);
  const assumptions = parseAssumptions(rawAssumptions);
  const issues = new Issues();
  const results: ScenarioResult[] = [];
  for (const name of SCENARIO_NAMES) {
    const def = defs.find((d) => d.name === name);
    if (!def) {
      issues.add("scenarios", `missing the ${name} scenario`);
      continue;
    }
    try {
      results.push(computeScenario(def, assumptions));
    } catch (err) {
      if (err instanceof SchemaError) issues.list.push(...err.issues);
      else throw err;
    }
  }
  issues.throwIfAny();
  const [c, r, o] = results;
  if (!(c.monthlyProfitMinor <= r.monthlyProfitMinor && r.monthlyProfitMinor <= o.monthlyProfitMinor) ||
      !(c.cumulativeProfitMinor <= r.cumulativeProfitMinor && r.cumulativeProfitMinor <= o.cumulativeProfitMinor)) {
    issues.add("scenarios", "are mislabelled: profit must not decrease from conservative to realistic to optimistic");
  }
  issues.throwIfAny();
  return results;
}

/** Formats minor units for display, e.g. 123456 GBP -> "£1,234.56". Display only. */
export function formatMoney(minor: number, currency: Currency): string {
  if (typeof minor !== "number" || !Number.isSafeInteger(minor)) throw new TypeError(`minor must be a safe integer (got ${typeName(minor)})`);
  if (currency !== "GBP" && currency !== "USD") throw new TypeError("currency must be GBP or USD");
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}${currency === "GBP" ? "£" : "$"}${major}.${cents}`;
}
