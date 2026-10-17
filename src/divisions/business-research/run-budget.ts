/**
 * Per-run budget control. Phase 0 makes NO model calls: this defines and
 * tests the accounting contract that Phase 1 must use.
 *
 * Contract for any later inference (see README.md):
 * 1. Before EVERY attempt (including retries), compute the worst-case cost
 *    with the existing router estimate and call `authorize`. If refused, do
 *    not send.
 * 2. Also pass the attempt through the existing InferenceSpendGate /
 *    InferenceRouter, which enforce the global per-call, hourly, daily and
 *    session caps. This run budget is an additional, smaller cap; it never
 *    replaces or raises the global ones.
 * 3. After the attempt, `settle` it exactly once: actual cost on success,
 *    the full reserved estimate if the provider may have billed a failure,
 *    zero only if the request provably never left the process.
 */

import { Issues, SchemaError, checkKeys, str, typeName } from "./validation.js";

/** Matches the safe-mode daily maximum (src/safety/spend-caps.ts); a run cap can't exceed it. */
export const MAX_RUN_BUDGET_CENTS = 500;

export type RunAuthorization =
  | { readonly allowed: true; readonly reservationId: number; readonly estimatedCostCents: number }
  | { readonly allowed: false; readonly reason: string };

export type RunAttemptOutcome =
  | { readonly kind: "success"; readonly actualCostCents: number }
  | { readonly kind: "failure"; readonly mayHaveBeenBilled: boolean };

export interface RunBudget {
  readonly capCents: number;
  authorize(attempt: { label: string; estimatedCostCents: number }): RunAuthorization;
  settle(reservationId: number, outcome: RunAttemptOutcome): void;
  spentCents(): number;
  reservedCents(): number;
}

export interface RunLedgerEntry {
  readonly reservationId: number;
  readonly label: string;
  readonly estimatedCostCents: number;
  readonly chargedCents: number | null; // null while in flight
  /** invalid_outcome_charged: settle() got a malformed outcome and charged the worst case. */
  readonly outcome: "in_flight" | "success" | "failure_billed" | "failure_not_billed" | "invalid_outcome_charged";
  /** True when the actual cost exceeded the reserved estimate (estimate was wrong). */
  readonly overran: boolean;
}

export class RunBudgetController implements RunBudget {
  readonly capCents: number;
  #nextId = 1;
  #spent = 0;
  readonly #reserved = new Map<number, number>();
  readonly #ledger = new Map<number, RunLedgerEntry>();

  constructor(capCents: number) {
    if (typeof capCents !== "number" || !Number.isSafeInteger(capCents) || capCents <= 0 || capCents > MAX_RUN_BUDGET_CENTS) {
      const got = typeof capCents === "number" ? String(capCents) : typeName(capCents);
      throw new SchemaError([`run budget cap must be an integer from 1 to ${MAX_RUN_BUDGET_CENTS} cents (got ${got})`]);
    }
    this.capCents = capCents;
  }

  /**
   * Authorizes one attempt. The attempt must be a plain data object (no
   * getters, no Proxy-like accessors) with a string label and a non-negative
   * integer estimate; anything else is refused without coercing or calling it.
   */
  authorize(attempt: { label: string; estimatedCostCents: number }): RunAuthorization {
    const issues = new Issues();
    if (!checkKeys(issues, "attempt", attempt, ["label", "estimatedCostCents"])) {
      return { allowed: false, reason: `invalid attempt: ${issues.list.join("; ")}` };
    }
    const label = str(issues, "attempt.label", attempt.label, { max: 200 });
    const estimate: unknown = attempt.estimatedCostCents;
    if (typeof estimate !== "number" || !Number.isSafeInteger(estimate) || estimate < 0) {
      return { allowed: false, reason: `invalid cost estimate (${typeof estimate === "number" ? String(estimate) : typeName(estimate)})` };
    }
    if (issues.list.length > 0) return { allowed: false, reason: `invalid attempt: ${issues.list.join("; ")}` };
    // Checked and reserved in one synchronous step: no other attempt can
    // pass the check before this one is counted.
    if (this.#spent + this.reservedCents() + estimate > this.capCents) {
      return {
        allowed: false,
        reason: `run budget exhausted: ${this.#spent}c spent + ${this.reservedCents()}c reserved + ${estimate}c estimated > ${this.capCents}c cap`,
      };
    }
    const reservationId = this.#nextId++;
    this.#reserved.set(reservationId, estimate);
    this.#ledger.set(reservationId, Object.freeze({
      reservationId, label, estimatedCostCents: estimate, chargedCents: null, outcome: "in_flight", overran: false,
    }));
    return { allowed: true, reservationId, estimatedCostCents: estimate };
  }

  /**
   * Settles an attempt exactly once. Fails closed: a malformed outcome (not a
   * plain data object of a known kind) is charged the full reserved estimate.
   */
  settle(reservationId: number, outcome: RunAttemptOutcome): void {
    if (typeof reservationId !== "number" || !Number.isSafeInteger(reservationId)) {
      throw new TypeError(`reservationId must be an integer (got ${typeName(reservationId)})`);
    }
    const estimate = this.#reserved.get(reservationId);
    if (estimate === undefined) throw new Error(`reservation ${reservationId} is unknown or already settled`);
    let charged: number;
    let overran = false;
    let kind: RunLedgerEntry["outcome"];
    const issues = new Issues();
    const raw: unknown = outcome;
    const plain = checkKeys(issues, "outcome", raw, ["kind"], ["actualCostCents", "mayHaveBeenBilled"]);
    const fields = (plain ? raw : {}) as Record<string, unknown>;
    const outcomeKind = fields.kind;
    if (plain && outcomeKind === "success" && issues.list.length === 0) {
      const actual = fields.actualCostCents;
      // A missing or invalid reported cost is charged at the reserved worst case.
      charged = typeof actual === "number" && Number.isFinite(actual) && actual >= 0 ? actual : estimate;
      overran = charged > estimate;
      kind = "success";
    } else if (plain && outcomeKind === "failure" && issues.list.length === 0) {
      const billed = fields.mayHaveBeenBilled;
      if (billed === false) {
        charged = 0;
        kind = "failure_not_billed";
      } else {
        charged = estimate;
        kind = "failure_billed";
      }
    } else {
      charged = estimate;
      kind = "invalid_outcome_charged";
    }
    this.#reserved.delete(reservationId);
    this.#spent += charged;
    const entry = this.#ledger.get(reservationId)!;
    this.#ledger.set(reservationId, Object.freeze({ ...entry, chargedCents: charged, outcome: kind, overran }));
  }

  spentCents(): number {
    return this.#spent;
  }

  reservedCents(): number {
    let total = 0;
    for (const c of this.#reserved.values()) total += c;
    return total;
  }

  ledger(): RunLedgerEntry[] {
    return [...this.#ledger.values()];
  }
}

/** Phase 0 has no inference. Anything that asks for a model call gets this error. */
export class InferenceDisabledError extends Error {
  constructor() {
    super("Inference is disabled in Phase 0 of the business research division");
    this.name = "InferenceDisabledError";
  }
}

/** The only model interface Phase 0 provides: it always refuses, before any budget is touched. */
export interface ResearchModelPort {
  complete(request: { purpose: string; untrustedSourceText: string }): Promise<never>;
}

export const DISABLED_MODEL_PORT: ResearchModelPort = Object.freeze({
  complete: async (): Promise<never> => {
    throw new InferenceDisabledError();
  },
});
