/**
 * Spend gate for the orchestrator/worker inference client.
 *
 * Every provider attempt (including retries and provider fallbacks) must be
 * authorized against the shared budget before it is sent, and recorded
 * afterwards: actual cost on success, worst-case estimate if the provider may
 * have billed a failed call. Uses the same budget tracker, pricing policy and
 * upper-bound estimate as the main agent loop's router.
 */

import type { InferenceTaskType, SurvivalTier } from "../types.js";
import type { InferenceBudgetTracker } from "./budget.js";
import type { ModelRegistry } from "./registry.js";
import { normalizeFreeModels, resolveTrustedPricing } from "./pricing-policy.js";
import { estimateCostCentsUpperBound, mayHaveBeenBilled } from "./router.js";

export interface SpendRequest {
  providerId: string;
  /** Endpoint the request will be sent to (undefined = provider SDK default). */
  baseUrl?: string;
  modelId: string;
  messages: unknown[];
  tools?: unknown[];
  /** Output token limit that will be sent with the request. */
  maxTokens: number;
}

export type SpendAuthorization =
  | { allowed: true; estimatedCostCents: number; costPer1kInput: number; costPer1kOutput: number; reservationId: number }
  | { allowed: false; reason: string };

export type SpendOutcome =
  | { kind: "success"; inputTokens: number; outputTokens: number; latencyMs: number }
  | { kind: "failure"; error: unknown; latencyMs: number };

export interface InferenceSpendGate {
  authorize(request: SpendRequest): SpendAuthorization;
  record(request: SpendRequest, authorization: Extract<SpendAuthorization, { allowed: true }>, outcome: SpendOutcome): void;
}

export class SpendRefusedError extends Error {
  constructor(reason: string) {
    super(`Inference refused by spend gate: ${reason}`);
    this.name = "SpendRefusedError";
  }
}

/** Registry prices are only trusted for the provider's own endpoint. */
const OFFICIAL_HOSTS: Record<string, (host: string) => boolean> = {
  openai: (h) => h === "api.openai.com",
  anthropic: (h) => h === "api.anthropic.com",
  ollama: (h) => h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]",
};

export function isOfficialEndpoint(providerId: string, baseUrl: string | undefined): boolean {
  const check = OFFICIAL_HOSTS[providerId];
  if (!check) return false;
  if (baseUrl === undefined) return providerId !== "ollama"; // SDK default is the official API
  try {
    return check(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The free-model policy only applies when the Ollama endpoint is local
 * (loopback). A remote endpoint could be a paid proxy, so the policy is
 * dropped and zero-priced models fall back to requiring a trusted price.
 */
export function effectiveFreeModels(freeModels: unknown, ollamaBaseUrl: string | undefined): string[] {
  const listed = normalizeFreeModels(freeModels);
  if (listed.length === 0) return [];
  return isOfficialEndpoint("ollama", ollamaBaseUrl) ? [...listed] : [];
}

export class BudgetSpendGate implements InferenceSpendGate {
  constructor(
    private readonly budget: InferenceBudgetTracker,
    private readonly registry: ModelRegistry,
    private readonly options: { sessionId: string; taskType: InferenceTaskType; tier: SurvivalTier },
  ) {}

  authorize(request: SpendRequest): SpendAuthorization {
    if (!isOfficialEndpoint(request.providerId, request.baseUrl)) {
      return {
        allowed: false,
        reason: `registry prices are not trusted for provider "${request.providerId}" at ${request.baseUrl ?? "(default endpoint)"}`,
      };
    }
    const pricing = resolveTrustedPricing(this.registry.get(request.modelId), {
      freeModels: this.budget.config.freeModels,
      servingProvider: request.providerId,
    });
    if (!pricing.ok) return { allowed: false, reason: pricing.reason };
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0) {
      return { allowed: false, reason: `an explicit positive output token limit is required (got ${request.maxTokens})` };
    }

    const estimatedCostCents = estimateCostCentsUpperBound(request.messages, request.tools, request.maxTokens, pricing);
    if (!Number.isFinite(estimatedCostCents) || estimatedCostCents < 0) {
      return { allowed: false, reason: `invalid cost estimate (${String(estimatedCostCents)})` };
    }
    const check = this.budget.checkBudget(estimatedCostCents, request.modelId);
    if (!check.allowed) return { allowed: false, reason: check.reason ?? "budget exceeded" };

    const sessionCap = this.budget.config.sessionBudgetCents;
    if (sessionCap > 0) {
      const spent = this.budget.getSessionCost(this.options.sessionId) + this.budget.getReservedCost();
      if (spent + estimatedCostCents > sessionCap) {
        return { allowed: false, reason: `Session budget exceeded: ${spent}c spent + ${estimatedCostCents}c estimated > ${sessionCap}c limit` };
      }
    }
    // Reserved synchronously with the checks above, so no other call can pass
    // them before this one is counted. Released in record().
    const reservationId = this.budget.reserve(estimatedCostCents);
    return { allowed: true, estimatedCostCents, costPer1kInput: pricing.costPer1kInput, costPer1kOutput: pricing.costPer1kOutput, reservationId };
  }

  record(
    request: SpendRequest,
    authorization: Extract<SpendAuthorization, { allowed: true }>,
    outcome: SpendOutcome,
  ): void {
    try {
      this.recordCost(request, authorization, outcome);
    } finally {
      this.budget.release(authorization.reservationId);
    }
  }

  private recordCost(
    request: SpendRequest,
    authorization: Extract<SpendAuthorization, { allowed: true }>,
    outcome: SpendOutcome,
  ): void {
    let costCents: number;
    let inputTokens = 0;
    let outputTokens = 0;
    if (outcome.kind === "success") {
      inputTokens = outcome.inputTokens;
      outputTokens = outcome.outputTokens;
      costCents = Math.ceil(
        (inputTokens / 1000) * authorization.costPer1kInput / 100 +
        (outputTokens / 1000) * authorization.costPer1kOutput / 100,
      );
    } else {
      if (!mayHaveBeenBilled(outcome.error)) return;
      costCents = authorization.estimatedCostCents;
    }
    this.budget.recordCost({
      sessionId: this.options.sessionId,
      turnId: null,
      model: request.modelId,
      provider: request.providerId as any,
      inputTokens,
      outputTokens,
      costCents,
      latencyMs: outcome.latencyMs,
      tier: this.options.tier,
      taskType: this.options.taskType,
      cacheHit: false,
    });
  }
}
