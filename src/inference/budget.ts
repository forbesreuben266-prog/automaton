/**
 * Inference Budget Tracker
 *
 * Tracks inference costs and enforces budget limits per call,
 * per hour, per session, and per day.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { InferenceCostRow, ModelStrategyConfig } from "../types.js";
import {
  inferenceInsertCost,
  inferenceGetSessionCosts,
  inferenceGetDailyCost,
  inferenceGetHourlyCost,
  inferenceGetModelCosts,
} from "../state/database.js";
import { isSafeModeActive } from "../safety/safe-mode.js";
import { validateSafeModeSpendCaps } from "../safety/spend-caps.js";

type Database = BetterSqlite3.Database;

export class InferenceBudgetTracker {
  private db: Database;
  readonly config: ModelStrategyConfig;

  /** In-flight calls' worst-case estimates, counted until their cost is recorded. */
  private readonly reservations = new Map<number, number>();
  private nextReservationId = 1;

  constructor(db: Database, config: ModelStrategyConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Reserve an authorized call's estimate so concurrent calls (main loop,
   * orchestrator, workers) can't all pass the aggregate checks before any of
   * them records its cost. Release only after recording the actual or
   * worst-case cost.
   */
  reserve(cents: number): number {
    const id = this.nextReservationId++;
    this.reservations.set(id, Number.isFinite(cents) && cents > 0 ? cents : 0);
    return id;
  }

  release(id: number): void {
    this.reservations.delete(id);
  }

  getReservedCost(): number {
    let total = 0;
    for (const cents of this.reservations.values()) total += cents;
    return total;
  }

  /**
   * Check whether a call with estimated cost is within budget.
   * Returns { allowed: true } or { allowed: false, reason: "..." }.
   */
  checkBudget(
    estimatedCostCents: number,
    model: string,
  ): { allowed: boolean; reason?: string } {
    // Safe mode: caps are mandatory and bounded; refuse every call otherwise.
    if (isSafeModeActive()) {
      const problems = validateSafeModeSpendCaps({
        perCallCents: this.config.perCallCeilingCents,
        hourlyCents: this.config.hourlyBudgetCents,
        dailyCents: this.config.dailyBudgetCents,
      });
      if (problems.length > 0) {
        return { allowed: false, reason: `Safe mode spending caps invalid: ${problems.join("; ")}` };
      }
    }

    // Per-call ceiling check
    if (this.config.perCallCeilingCents > 0 && estimatedCostCents > this.config.perCallCeilingCents) {
      return {
        allowed: false,
        reason: `Per-call cost ${estimatedCostCents}c exceeds ceiling of ${this.config.perCallCeilingCents}c`,
      };
    }

    // Hourly budget check
    if (this.config.hourlyBudgetCents > 0) {
      const hourlyCost = this.getHourlyCost();
      if (hourlyCost + this.getReservedCost() + estimatedCostCents > this.config.hourlyBudgetCents) {
        return {
          allowed: false,
          reason: `Hourly budget exhausted: ${hourlyCost}c spent + ${this.getReservedCost()}c reserved + ${estimatedCostCents}c estimated > ${this.config.hourlyBudgetCents}c limit`,
        };
      }
    }

    // Daily budget check (treasuryPolicy.maxInferenceDailyCents). Unlike the
    // hourly/session limits, 0 is a real cap here, and an invalid value
    // fails closed.
    const dailyCap = this.config.dailyBudgetCents;
    if (dailyCap !== undefined) {
      if (typeof dailyCap !== "number" || !Number.isFinite(dailyCap) || dailyCap < 0) {
        return { allowed: false, reason: `Invalid daily inference budget: ${String(dailyCap)}` };
      }
      const dailyCost = this.getDailyCost();
      if (dailyCost + this.getReservedCost() + estimatedCostCents > dailyCap) {
        return {
          allowed: false,
          reason: `Daily inference budget exhausted: ${dailyCost}c spent + ${this.getReservedCost()}c reserved + ${estimatedCostCents}c estimated > ${dailyCap}c limit`,
        };
      }
    }

    // Session budget check
    if (this.config.sessionBudgetCents > 0) {
      // Session budget is enforced via getSessionCost when sessionId is known
      // This is a guard for the overall session — enforced in router.route()
    }

    return { allowed: true };
  }

  /**
   * Record a completed inference cost.
   */
  recordCost(cost: Omit<InferenceCostRow, "id" | "createdAt">): void {
    inferenceInsertCost(this.db, cost);
  }

  /**
   * Get total cost for the current hour.
   */
  getHourlyCost(): number {
    return inferenceGetHourlyCost(this.db);
  }

  /**
   * Get total cost for today (or a specific date).
   */
  getDailyCost(date?: string): number {
    return inferenceGetDailyCost(this.db, date);
  }

  /**
   * Get total cost for a specific session.
   */
  getSessionCost(sessionId: string): number {
    const costs = inferenceGetSessionCosts(this.db, sessionId);
    return costs.reduce((sum, c) => sum + c.costCents, 0);
  }

  /**
   * Get cost breakdown for a specific model.
   */
  getModelCosts(model: string, days?: number): { totalCents: number; callCount: number } {
    return inferenceGetModelCosts(this.db, model, days);
  }
}
