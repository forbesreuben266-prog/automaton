/**
 * Business Opportunity Research division — Phase 0 (offline skeleton).
 *
 * Pure, deterministic code: schemas, citation verification, financial
 * scenarios, scoring, report validation/rendering, an inert proposal queue
 * and a per-run budget contract. No network, filesystem, shell, model calls
 * or links to the autonomous agent; see README.md for the boundaries.
 */

// deepFreeze is internal (it inspects objects without validating them) and is deliberately not exported.
export {
  ID_PATTERN, Issues, SchemaError, arr, assertString, bool, checkKeys, daysBetween, id, isPlainObject, isoDate,
  isoDateTime, oneOf, safeInt, str, typeName, uniqueIds,
} from "./validation.js";
export * from "./sources.js";
export * from "./citations.js";
export * from "./finance.js";
export * from "./scoring.js";
export * from "./proposals.js";
export * from "./run-budget.js";
export * from "./untrusted.js";
export * from "./report.js";
