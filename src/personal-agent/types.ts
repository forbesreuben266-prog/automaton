/**
 * Personal agent: shared types. This subsystem is separate from the autonomous agent in src/agent (no wallets,
 * replication, self-modification or survival logic) and from the research and sandbox code. It talks to a model
 * provider, runs a small set of local tools under an explicit policy, and keeps its state in one private folder.
 */

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export type ChatMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly name: string; readonly content: string; readonly isError?: boolean };

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments (an object schema). */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelReply {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSpec[];
  readonly maxTokens: number;
}

/** A model backend. `paid` providers are refused unless the configuration enables them with a token budget. */
export interface ModelProvider {
  readonly id: string;
  readonly paid: boolean;
  chat(request: ModelRequest): Promise<ModelReply>;
}

/**
 * read: only reads the agent's own data or the workspace. write-local: changes the agent's own data or the workspace
 * and needs the operator's confirmation unless auto-approval is configured for it. There is deliberately no network,
 * shell, payment or messaging risk class: such tools do not exist in this subsystem.
 */
export type ToolRisk = "read" | "write-local";

export interface ToolContext {
  readonly dataDir: string;
  readonly workspaceDir: string;
  readonly researchResultsDir: string;
  readonly now: () => Date;
}

export interface ToolDef extends ToolSpec {
  readonly risk: ToolRisk;
  /** Always asks before running, even with auto-approval (e.g. overwriting a workspace file). */
  readonly alwaysConfirm?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Asked before a write-local tool runs; resolves true to allow it. */
export type Confirm = (question: string) => Promise<boolean>;

export class ToolInputError extends Error {}
