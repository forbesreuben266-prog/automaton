/**
 * Proposal queue: records proposed validation experiments and other actions
 * that would need the operator's approval. It is deliberately inert:
 *
 * - It has no execute/run/send method and imports nothing that can reach the
 *   network, the filesystem, a shell, a wallet or another agent.
 * - Every new proposal is stored as "needs_approval"; callers cannot submit
 *   one as already approved.
 * - Recording an approval only changes the stored status. Nothing in this
 *   division acts on it: the operator carries out any approved action
 *   themselves, outside this system.
 */

import { CURRENCIES, type Currency } from "./finance.js";
import { Issues, SchemaError, arr, checkKeys, deepFreeze, id, isoDateTime, oneOf, safeInt, str, typeName } from "./validation.js";

export type ProposalStatus = "needs_approval" | "approved_not_executed" | "rejected";

export interface ExperimentProposal {
  readonly id: string;
  readonly title: string;
  readonly hypothesis: string;
  readonly method: string;
  /** What would have to happen outside this system (e.g. "buy £20 of search ads"). */
  readonly externalActions: readonly string[];
  readonly estimatedCostMinor: number;
  readonly currency: Currency;
  readonly durationDays: number;
  readonly successThreshold: string;
}

export interface ProposalDecision {
  readonly decision: "approved" | "rejected";
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly note: string;
}

export interface StoredProposal {
  readonly proposal: ExperimentProposal;
  readonly status: ProposalStatus;
  readonly submittedAt: string;
  readonly decision: ProposalDecision | null;
}

export function parseExperimentProposal(raw: unknown, path = "proposal"): ExperimentProposal {
  const issues = new Issues();
  if (!checkKeys(issues, path, raw, [
    "id", "title", "hypothesis", "method", "externalActions", "estimatedCostMinor", "currency", "durationDays", "successThreshold",
  ])) issues.throwIfAny();
  const r = raw as Record<string, unknown>;
  const proposal: ExperimentProposal = {
    id: id(issues, `${path}.id`, r.id),
    title: str(issues, `${path}.title`, r.title, { max: 200 }),
    hypothesis: str(issues, `${path}.hypothesis`, r.hypothesis, { max: 2_000 }),
    method: str(issues, `${path}.method`, r.method, { max: 4_000 }),
    externalActions: arr(issues, `${path}.externalActions`, r.externalActions, { max: 20 })
      .map((a, i) => str(issues, `${path}.externalActions[${i}]`, a, { max: 500 })),
    estimatedCostMinor: safeInt(issues, `${path}.estimatedCostMinor`, r.estimatedCostMinor, { min: 0 }),
    currency: oneOf(issues, `${path}.currency`, r.currency, CURRENCIES),
    durationDays: safeInt(issues, `${path}.durationDays`, r.durationDays, { min: 1, max: 365 }),
    successThreshold: str(issues, `${path}.successThreshold`, r.successThreshold, { max: 1_000 }),
  };
  issues.throwIfAny();
  return deepFreeze(proposal);
}

export class ProposalQueue {
  readonly #items = new Map<string, StoredProposal>();

  /** Stores a proposal as needs_approval. Rejects duplicates and any extra fields (e.g. a status). */
  submit(raw: unknown, submittedAt: string): StoredProposal {
    const issues = new Issues();
    isoDateTime(issues, "submittedAt", submittedAt); // type-checked first, never coerced
    issues.throwIfAny();
    const proposal = parseExperimentProposal(raw);
    if (this.#items.has(proposal.id)) issues.add("proposal.id", `"${proposal.id}" is already in the queue`);
    issues.throwIfAny();
    const stored = deepFreeze<StoredProposal>({ proposal, status: "needs_approval", submittedAt, decision: null });
    this.#items.set(proposal.id, stored);
    return stored;
  }

  get(proposalId: string): StoredProposal | undefined {
    if (typeof proposalId !== "string") return undefined; // never coerced
    return this.#items.get(proposalId);
  }

  list(status?: ProposalStatus): StoredProposal[] {
    if (status !== undefined && status !== "needs_approval" && status !== "approved_not_executed" && status !== "rejected") {
      throw new TypeError("status must be needs_approval, approved_not_executed or rejected");
    }
    return [...this.#items.values()].filter((p) => status === undefined || p.status === status);
  }

  /**
   * Records the operator's decision. This is a record only: it does not, and
   * cannot, carry out the proposal. A proposal can be decided once.
   */
  recordDecision(proposalId: string, raw: unknown): StoredProposal {
    const issues = new Issues();
    // Type-check before any use: a non-string id is never coerced or formatted.
    if (typeof proposalId !== "string") throw new SchemaError([`proposalId: must be a string (got ${typeName(proposalId)})`]);
    const current = this.#items.get(proposalId);
    if (!current) issues.add("proposalId", `"${proposalId}" is not in the queue`);
    else if (current.status !== "needs_approval") issues.add("proposalId", `"${proposalId}" was already decided`);
    let decision: ProposalDecision | null = null;
    if (checkKeys(issues, "decision", raw, ["decision", "decidedBy", "decidedAt", "note"])) {
      decision = {
        decision: oneOf(issues, "decision.decision", raw.decision, ["approved", "rejected"] as const),
        decidedBy: str(issues, "decision.decidedBy", raw.decidedBy, { max: 200 }),
        decidedAt: isoDateTime(issues, "decision.decidedAt", raw.decidedAt),
        note: str(issues, "decision.note", raw.note, { min: 0, max: 2_000 }),
      };
    }
    issues.throwIfAny();
    const updated = deepFreeze<StoredProposal>({
      ...current!,
      status: decision!.decision === "approved" ? "approved_not_executed" : "rejected",
      decision,
    });
    this.#items.set(proposalId, updated);
    return updated;
  }

  /** Plain-data copy for saving or display. */
  toJSON(): StoredProposal[] {
    return this.list();
  }
}
