/**
 * Inference Router
 *
 * Routes inference requests through the model registry using
 * tier-based selection, budget enforcement, and provider-specific
 * message transformation.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEntry,
  SurvivalTier,
  InferenceTaskType,
  ModelProvider,
  ChatMessage,
  ModelPreference,
} from "../types.js";
import { ModelRegistry } from "./registry.js";
import { InferenceBudgetTracker } from "./budget.js";
import { DEFAULT_ROUTING_MATRIX, TASK_TIMEOUTS } from "./types.js";
import { isSafeModeActive } from "../safety/safe-mode.js";

type Database = BetterSqlite3.Database;

/** Errors raised before any request reached a provider. */
const NOT_SENT_ERRORS = new Set(["InferenceRoutingError", "SafeModeBlockedError", "CircuitOpenError"]);

/**
 * Upper bound on a call's cost. Input is the UTF-8 size of everything sent
 * (messages, tool calls, tool schemas): byte-level BPE tokenizers emit at
 * most one token per byte, so base64, CJK and emoji can't be under-counted
 * the way a characters/4 guess is. Output assumes the full max_tokens.
 */
export function estimateCostCentsUpperBound(
  messages: unknown[],
  tools: unknown[] | undefined,
  maxTokens: number,
  model: Pick<ModelEntry, "costPer1kInput" | "costPer1kOutput">,
): number {
  const inputTokens =
    Buffer.byteLength(JSON.stringify(messages), "utf8") +
    Buffer.byteLength(JSON.stringify(tools ?? []), "utf8");
  return Math.ceil(
    (inputTokens / 1000) * model.costPer1kInput / 100 +
    (maxTokens / 1000) * model.costPer1kOutput / 100,
  );
}

/**
 * Could the provider have billed this failed call? Providers don't document
 * which error responses are free, so any failure after the request was sent
 * (any HTTP status, timeout or network error) counts as billed. Only errors
 * raised before sending are free.
 */
export function mayHaveBeenBilled(error: any): boolean {
  return !NOT_SENT_ERRORS.has(error?.name);
}

export class InferenceRouter {
  private db: Database;
  private registry: ModelRegistry;
  private budget: InferenceBudgetTracker;

  constructor(db: Database, registry: ModelRegistry, budget: InferenceBudgetTracker) {
    this.db = db;
    this.registry = registry;
    this.budget = budget;
  }

  /**
   * Route an inference request: select model, check budget,
   * transform messages, call inference, record cost.
   */
  async route(
    request: InferenceRequest,
    inferenceChat: (messages: any[], options: any) => Promise<any>,
  ): Promise<InferenceResult> {
    const { messages, taskType, tier, sessionId, turnId, tools } = request;

    // 1. Select the configured model (never substituted)
    const selection = this.selectModelWithReason(tier, taskType);
    const model = selection.model;
    if (!model) {
      return {
        content: `Model selection refused: ${selection.reason}`,
        model: "none",
        provider: "other",
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "error",
        toolCalls: undefined,
      };
    }

    // 1b. Safe mode: spend limits are computed from registry prices, so a
    // remote model with no price would never trip them. Refuse it.
    const isUnpriced = model.costPer1kInput <= 0 && model.costPer1kOutput <= 0;
    if (isSafeModeActive() && isUnpriced && model.provider !== "ollama") {
      return {
        content: `Blocked by safe mode: model ${model.modelId} (${model.provider}) has no price, so spend limits cannot be enforced`,
        model: model.modelId,
        provider: model.provider,
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "budget_exceeded",
      };
    }

    // 2. Estimate cost (upper bound) and check budget
    const preference = this.getPreference(tier, taskType);
    const maxTokens = request.maxTokens || preference?.maxTokens || model.maxTokens;
    const estimatedCostCents = estimateCostCentsUpperBound(messages, tools, maxTokens, model);

    const budgetCheck = this.budget.checkBudget(estimatedCostCents, model.modelId);
    if (!budgetCheck.allowed) {
      return {
        content: `Budget exceeded: ${budgetCheck.reason}`,
        model: model.modelId,
        provider: model.provider,
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "budget_exceeded",
      };
    }

    // 3. Check session budget
    if (request.sessionId && this.budget.config.sessionBudgetCents > 0) {
      const sessionCost = this.budget.getSessionCost(request.sessionId);
      if (sessionCost + estimatedCostCents > this.budget.config.sessionBudgetCents) {
        return {
          content: `Session budget exceeded: ${sessionCost}c spent + ${estimatedCostCents}c estimated > ${this.budget.config.sessionBudgetCents}c limit`,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          latencyMs: 0,
          finishReason: "budget_exceeded",
        };
      }
    }

    // 4. Transform messages for provider
    const transformedMessages = this.transformMessagesForProvider(messages, model.provider);

    // 5. Build inference options
    const timeout = TASK_TIMEOUTS[taskType] || 120_000;

    const inferenceOptions: any = {
      model: model.modelId,
      maxTokens,
      tools: tools,
    };

    // 6. Call inference with timeout
    const startTime = Date.now();
    let response: any;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        inferenceOptions.signal = controller.signal;
        response = await inferenceChat(transformedMessages, inferenceOptions);
      } finally {
        clearTimeout(timer);
      }
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      // The provider may have processed (and billed) this request even though
      // we got no usable response. Record the worst-case estimate so budgets
      // stay conservative. Errors raised before sending are not recorded.
      if (mayHaveBeenBilled(error)) {
        this.budget.recordCost({
          sessionId,
          turnId: turnId || null,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: estimatedCostCents,
          latencyMs,
          tier,
          taskType,
          cacheHit: false,
        });
      }
      // If fallback is enabled, try next candidate
      if (error.name === "AbortError") {
        return {
          content: `Inference timeout after ${timeout}ms`,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          latencyMs,
          finishReason: "timeout",
        };
      }
      throw error;
    }
    const latencyMs = Date.now() - startTime;

    // 7. Calculate actual cost
    const inputTokens = response.usage?.promptTokens || 0;
    const outputTokens = response.usage?.completionTokens || 0;
    const actualCostCents = Math.ceil(
      (inputTokens / 1000) * model.costPer1kInput / 100 +
      (outputTokens / 1000) * model.costPer1kOutput / 100,
    );

    // 8. Record cost
    this.budget.recordCost({
      sessionId,
      turnId: turnId || null,
      model: model.modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      costCents: actualCostCents,
      latencyMs,
      tier,
      taskType,
      cacheHit: false,
    });

    // 9. Build result
    return {
      content: response.message?.content || "",
      model: model.modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      costCents: actualCostCents,
      latencyMs,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason || "stop",
    };
  }

  /**
   * Select the model for a tier and task type: exactly the configured model
   * (inferenceModel for normal/high, lowComputeModel for low_compute,
   * criticalModel for critical/dead). The routing matrix only decides
   * whether the task runs at this tier at all; it never picks or substitutes
   * a model. If the configured model can't be used, selection fails closed.
   */
  selectModelWithReason(
    tier: SurvivalTier,
    taskType: InferenceTaskType,
  ): { model: ModelEntry; reason?: undefined } | { model: null; reason: string } {
    const strategy = this.budget.config;

    if (strategy.modelConfigError) {
      return { model: null, reason: strategy.modelConfigError };
    }

    const preference = this.getPreference(tier, taskType);
    if (preference && preference.candidates.length === 0) {
      return { model: null, reason: `Task "${taskType}" is not allowed at survival tier "${tier}"` };
    }

    const modelId =
      tier === "critical" || tier === "dead" ? strategy.criticalModel
      : tier === "low_compute" ? strategy.lowComputeModel
      : strategy.inferenceModel;
    if (!modelId) {
      return { model: null, reason: `No model configured for tier "${tier}"` };
    }

    const entry = this.registry.get(modelId);
    if (!entry) {
      return { model: null, reason: `Configured model "${modelId}" is unknown (not in the model registry); refusing to substitute another model` };
    }
    if (!entry.enabled) {
      return { model: null, reason: `Configured model "${modelId}" is disabled; refusing to substitute another model` };
    }
    return { model: entry };
  }

  selectModel(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry | null {
    return this.selectModelWithReason(tier, taskType).model;
  }

  /**
   * Transform messages for a specific provider.
   * Handles Anthropic's alternating-role requirement.
   */
  transformMessagesForProvider(messages: ChatMessage[], provider: ModelProvider): ChatMessage[] {
    if (messages.length === 0) {
      throw new Error("Cannot route inference with empty message array");
    }

    if (provider === "anthropic") {
      return this.fixAnthropicMessages(messages);
    }

    // For OpenAI/Conway, merge consecutive same-role messages
    return this.mergeConsecutiveSameRole(messages);
  }

  /**
   * Fix messages for Anthropic's API requirements:
   * 1. Extract system messages
   * 2. Merge consecutive same-role messages
   * 3. Merge consecutive tool messages into a single user message
   *    with multiple tool_result content blocks
   */
  private fixAnthropicMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      // System messages are handled separately by the Anthropic client
      if (msg.role === "system") {
        result.push(msg);
        continue;
      }

      // Tool messages become user messages with tool_result content
      if (msg.role === "tool") {
        const last = result[result.length - 1];
        // If previous message was also a tool (now a user), merge into it
        if (last && last.role === "user" && (last as any)._toolResultMerged) {
          // Append to the merged content
          last.content = last.content + "\n[tool_result:" + (msg.tool_call_id || "unknown") + "] " + msg.content;
          continue;
        }
        // Otherwise create a new user message
        const userMsg: ChatMessage & { _toolResultMerged?: boolean } = {
          role: "user",
          content: "[tool_result:" + (msg.tool_call_id || "unknown") + "] " + msg.content,
          _toolResultMerged: true,
        };
        result.push(userMsg);
        continue;
      }

      // For user/assistant: merge with previous if same role
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }

      result.push({ ...msg });
    }

    // Clean up internal markers
    for (const msg of result) {
      delete (msg as any)._toolResultMerged;
    }

    return result;
  }

  /**
   * Merge consecutive messages with the same role.
   */
  private mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role && msg.role !== "system" && msg.role !== "tool") {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }
      result.push({ ...msg });
    }

    return result;
  }

  private getPreference(tier: SurvivalTier, taskType: InferenceTaskType): ModelPreference | undefined {
    return DEFAULT_ROUTING_MATRIX[tier]?.[taskType];
  }
}
