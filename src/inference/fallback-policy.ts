/**
 * Provider fallback policy for the orchestrator/worker inference client.
 *
 * By default a call uses only the tier's configured provider/model, with
 * same-model retries. Moving to a different provider or model requires an
 * explicit mapping listed here. Every mapping must name registered
 * provider/model pairs and differ from its source; any malformed entry makes
 * the whole policy invalid (fail closed). Safe mode never falls back.
 */

export interface FallbackMapping {
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
}

export class InvalidFallbackPolicyError extends Error {
  constructor(message: string) {
    super(`Invalid provider fallback policy: ${message}`);
    this.name = "InvalidFallbackPolicyError";
  }
}

const FIELDS = ["fromProvider", "fromModel", "toProvider", "toModel"] as const;

export function validateFallbackPolicy(
  raw: unknown,
  isRegistered: (providerId: string, modelId: string) => boolean,
): FallbackMapping[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InvalidFallbackPolicyError("must be an array");

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new InvalidFallbackPolicyError(`entry ${index} must be an object`);
    }
    for (const field of FIELDS) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
        throw new InvalidFallbackPolicyError(`entry ${index} needs a non-empty "${field}"`);
      }
    }
    const mapping = entry as FallbackMapping;
    if (mapping.fromProvider === mapping.toProvider && mapping.fromModel === mapping.toModel) {
      throw new InvalidFallbackPolicyError(`entry ${index} maps a model to itself`);
    }
    if (!isRegistered(mapping.fromProvider, mapping.fromModel)) {
      throw new InvalidFallbackPolicyError(`entry ${index}: ${mapping.fromProvider}/${mapping.fromModel} is not registered`);
    }
    if (!isRegistered(mapping.toProvider, mapping.toModel)) {
      throw new InvalidFallbackPolicyError(`entry ${index}: ${mapping.toProvider}/${mapping.toModel} is not registered`);
    }
    return { fromProvider: mapping.fromProvider, fromModel: mapping.fromModel, toProvider: mapping.toProvider, toModel: mapping.toModel };
  });
}

export function isFallbackAuthorized(
  policy: readonly FallbackMapping[],
  from: { providerId: string; modelId: string },
  to: { providerId: string; modelId: string },
): boolean {
  return policy.some(
    (m) =>
      m.fromProvider === from.providerId &&
      m.fromModel === from.modelId &&
      m.toProvider === to.providerId &&
      m.toModel === to.modelId,
  );
}
