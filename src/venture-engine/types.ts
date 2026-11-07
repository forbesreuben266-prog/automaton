/**
 * Venture engine: opportunity -> venture -> experiment -> evidence -> decision -> repeat.
 *
 * Business-specific work lives in VentureKind modules (digital products first; services, software, e-commerce and,
 * later, trading plug in the same way). The core never spends money, publishes, contacts anyone, uses paid models or
 * trades: such actions become ApprovalRequests for the owner. Evidence is always labelled: "simulated" evidence comes
 * from the engine's own estimates; "actual" evidence is only what the owner records from a real, approved launch.
 */

import type { ModelUse } from "./model.js";

export type VentureStatus = "draft" | "built" | "awaiting-launch-approval" | "launched" | "archived" | "awaiting-shutdown-approval" | "shut-down";
export type DecisionKind = "SCALE" | "IMPROVE" | "HOLD" | "KILL";
export type EvidenceKind = "simulated" | "actual";

/** Actions the engine may never perform on its own. */
export type ApprovalAction = "launch-public" | "spend-money" | "use-paid-model" | "external-account-action" | "irreversible-shutdown" | "trading";

export interface Opportunity {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly problem: string;
  readonly audience: string;
  readonly offer: string;
  /** 0..1 estimates made by the engine (simulated, never customer data). */
  readonly estimates: { readonly demand: number; readonly feasibility: number; readonly risk: number; readonly costUsd: number };
  readonly score: number;
  readonly createdAt: string;
  /** Where the idea came from: "catalogue" or "model (<id>)". */
  readonly source: string;
}

export interface Asset { readonly name: string; readonly bytes: number; readonly sha256: string }
export interface Check { readonly name: string; readonly passed: boolean; readonly detail: string }

export interface Evidence {
  readonly id: string;
  readonly kind: EvidenceKind;
  /** For actual evidence: where the numbers came from (stated by the owner). */
  readonly source: string;
  readonly at: string;
  readonly metrics: { readonly visitors?: number; readonly signups?: number; readonly sales?: number; readonly revenueUsd?: number; readonly costUsd?: number; readonly qualityScore?: number;
    /** Simulated only: the evaluation breakdown behind qualityScore (each 0..1). */
    readonly scores?: Readonly<Record<string, number>> };
  readonly notes: string;
}

export interface Experiment {
  readonly id: string;
  readonly iteration: number;
  readonly hypothesis: string;
  readonly assets: readonly Asset[];
  readonly checks: readonly Check[];
  readonly verified: boolean;
  readonly evidence: readonly Evidence[];
  readonly createdAt: string;
}

export interface Decision { readonly at: string; readonly kind: DecisionKind; readonly basis: EvidenceKind | "none"; readonly reason: string }

export interface Venture {
  readonly id: string;
  readonly opportunity: Opportunity;
  readonly status: VentureStatus;
  readonly experiments: readonly Experiment[];
  readonly decisions: readonly Decision[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly ventureId: string;
  readonly action: ApprovalAction;
  readonly summary: string;
  readonly status: "pending" | "approved" | "denied";
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface Limits {
  readonly maxActiveVentures: number;
  readonly maxNewVenturesPerCycle: number;
  readonly maxIterationsPerVenture: number;
  readonly maxCyclesPerRun: number;
  /** Fixed at 0 in this phase: the engine has no way to spend. */
  readonly spendLimitUsd: 0;
}

export interface Plan { readonly hypothesis: string; readonly deliverables: readonly string[]; readonly successCriteria: readonly string[]; readonly fix: readonly string[] }

/** A pluggable business type. Builders write only through the provided writer (confined to the venture's folder). */
export interface VentureKind {
  readonly id: string;
  /** What the owner must provide or do before a public launch (shown in the launch approval request). */
  launchRequirements(): readonly string[];
  generateOpportunities(ctx: { readonly seed: number; readonly avoid: ReadonlySet<string>; readonly count: number; readonly model: ModelUse }): Promise<Opportunity[]>;
  plan(o: Opportunity, iteration: number, lastChecks: readonly Check[], weaknesses: readonly string[]): Plan;
  build(o: Opportunity, plan: Plan, iteration: number, write: (name: string, text: string) => void, model: ModelUse): Promise<{ readonly contentSource: "model" | "template" }>;
  verify(read: (name: string) => string | null, names: readonly string[]): Check[];
}
