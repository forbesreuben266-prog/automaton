/**
 * Pricing policy for budget enforcement.
 *
 * Budgets are computed from registry prices, so a model is only usable if
 * its pricing can be trusted:
 * - unknown models are refused (never treated as free);
 * - prices must be finite numbers >= 0;
 * - a price registered for a different provider than the one serving the
 *   call is refused;
 * - partial pricing (one side 0, the other > 0) is refused;
 * - a fully zero-priced model is allowed only if it is a local Ollama model
 *   explicitly listed in `freeModels`. Remote models are never free.
 */

import type { ModelEntry } from "../types.js";

export type PricingDecision =
  | { ok: true; costPer1kInput: number; costPer1kOutput: number; free: boolean }
  | { ok: false; reason: string };

/** Only local inference can be genuinely free. */
const FREE_CAPABLE_PROVIDERS = new Set(["ollama"]);

export function normalizeFreeModels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0 && v === v.trim());
}

export function resolveTrustedPricing(
  entry: Pick<ModelEntry, "modelId" | "provider" | "costPer1kInput" | "costPer1kOutput"> | undefined | null,
  options: { freeModels?: unknown; servingProvider?: string } = {},
): PricingDecision {
  if (!entry) {
    return { ok: false, reason: "Model is not in the model registry, so its price is unknown" };
  }
  const { modelId, provider, costPer1kInput: input, costPer1kOutput: output } = entry;

  if (options.servingProvider !== undefined && options.servingProvider !== provider) {
    return {
      ok: false,
      reason: `Price for ${modelId} is registered for provider "${provider}", not the serving provider "${options.servingProvider}"`,
    };
  }
  for (const [side, value] of [["input", input], ["output", output]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { ok: false, reason: `Invalid ${side} price for ${modelId}: ${JSON.stringify(value)}` };
    }
  }
  if (input === 0 && output === 0) {
    const listed = normalizeFreeModels(options.freeModels).includes(modelId);
    if (listed && FREE_CAPABLE_PROVIDERS.has(provider)) {
      return { ok: true, costPer1kInput: 0, costPer1kOutput: 0, free: true };
    }
    return {
      ok: false,
      reason: listed
        ? `${modelId} is listed as free, but provider "${provider}" is remote and cannot be free`
        : `${modelId} has no price and is not on the explicit free-model policy (freeModels)`,
    };
  }
  if (input === 0 || output === 0) {
    return { ok: false, reason: `Partial pricing for ${modelId} (input ${input}, output ${output}) is not trusted` };
  }
  return { ok: true, costPer1kInput: input, costPer1kOutput: output, free: false };
}
