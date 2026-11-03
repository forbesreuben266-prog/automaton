/**
 * Fail-closed readiness results (milestone R1).
 *
 * A readiness result explains, condition by condition, whether a business
 * evidence bundle or a market-data record would be acceptable as future
 * REAL-WORLD research input:
 * - pass: the condition was checked and holds;
 * - fail: the condition was checked and does not hold;
 * - unverified: the condition cannot be confirmed from what was supplied
 *   (an assertion, a missing date, an unchecked calendar, ...).
 * The overall status is the worst of the conditions: "refused" (malformed
 * input; nothing else is assessed), "not_ready" (any fail), "unverified"
 * (no fail, at least one unverified) or "ready_for_operator_review" (every
 * condition passes).
 *
 * No overall status is an approval. In R1 real-world input is NOT enabled:
 * `approvedForRealWorldUse` is always false, and assertRealWorldInputApproved
 * refuses every result. The existing offline engines still accept only
 * fictional data; nothing here feeds them.
 */

import { createHash } from "node:crypto";
import { ReadinessInputError } from "./validation.js";

export const CHECK_STATUSES = ["pass", "fail", "unverified"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export type OverallStatus = "refused" | "not_ready" | "unverified" | "ready_for_operator_review";
export type ReadinessSubject = "business_evidence" | "market_data";

/** R1 has no route by which real-world input becomes approved. */
export const REAL_WORLD_INPUT_ENABLED = false as const;
/** Most detail lines kept per check (the rest are counted). */
export const MAX_DETAILS = 20;

export const READINESS_NOTICE =
  "Readiness assessment only (milestone R1). It does not approve anything: real-world research input is not enabled, " +
  "nothing was fetched or verified online, and operator-recorded verifications are the operator's statements.";

export interface ReadinessCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly details: readonly string[];
}

export interface ReadinessResult {
  readonly subject: ReadinessSubject;
  readonly overall: OverallStatus;
  /** SHA-256 of the validated input's canonical form (null when refused). */
  readonly inputSha256: string | null;
  readonly checks: readonly ReadinessCheck[];
  /** Always false in R1. */
  readonly approvedForRealWorldUse: false;
  readonly notice: string;
}

export function check(id: string, status: CheckStatus, summary: string, details: readonly string[] = []): ReadinessCheck {
  const kept = details.slice(0, MAX_DETAILS);
  if (details.length > MAX_DETAILS) kept.push(`... and ${details.length - MAX_DETAILS} more`);
  return Object.freeze({ id, status, summary, details: Object.freeze(kept) });
}

export function overallOf(checks: readonly ReadinessCheck[]): OverallStatus {
  if (checks.length === 0) return "unverified"; // nothing checked is never "ready"
  if (checks.some((c) => c.status === "fail")) return "not_ready";
  if (checks.some((c) => c.status === "unverified")) return "unverified";
  return "ready_for_operator_review";
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function result(subject: ReadinessSubject, canonical: string, checks: readonly ReadinessCheck[]): ReadinessResult {
  return Object.freeze({
    subject, overall: overallOf(checks), inputSha256: sha256Hex(canonical), checks: Object.freeze([...checks]),
    approvedForRealWorldUse: false as const, notice: READINESS_NOTICE,
  });
}

/** Runs an assessment; malformed input becomes a "refused" result listing the problems (never a partial assessment). */
export function assessOrRefuse(subject: ReadinessSubject, run: () => ReadinessResult): ReadinessResult {
  try {
    return run();
  } catch (err) {
    if (!(err instanceof ReadinessInputError)) throw err;
    return Object.freeze({
      subject, overall: "refused" as const, inputSha256: null,
      checks: Object.freeze([check("input_well_formed", "fail", "The input is malformed or incomplete and was not assessed.", err.issues)]),
      approvedForRealWorldUse: false as const, notice: READINESS_NOTICE,
    });
  }
}

/**
 * The gate a future milestone would use before real-world input reaches a
 * research engine. In R1 it refuses everything, whatever the result says.
 */
export function assertRealWorldInputApproved(r: unknown): never {
  const overall = typeof r === "object" && r !== null ? (r as { overall?: unknown }).overall : undefined;
  throw new ReadinessInputError([
    `real-world research input is not enabled in R1 (readiness: ${typeof overall === "string" ? overall : "none"}); ` +
      "a readiness result is evidence for an operator decision, never an approval",
  ]);
}

/** Markdown rendering; all text is escaped so supplied names can't add formatting or links. */
export function renderReadiness(r: ReadinessResult): string {
  const esc = (t: string) => t.replace(/[\\`*_{}[\]()<>#+|!~-]/g, (c) => `\\${c}`);
  const label: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", unverified: "UNVERIFIED" };
  const out = [
    `# Readiness: ${r.subject === "business_evidence" ? "business evidence" : "market data"}`, "",
    `**Overall: ${r.overall.toUpperCase().replace(/_/g, " ")}.** Approved for real-world use: **no**.`, "",
    `_${esc(r.notice)}_`, "",
  ];
  if (r.inputSha256) out.push(`- Input SHA-256 (canonical form): ${r.inputSha256}`, "");
  out.push("| Condition | Status | Summary |", "|---|---|---|");
  for (const c of r.checks) out.push(`| ${esc(c.id)} | ${label[c.status]} | ${esc(c.summary)} |`);
  for (const c of r.checks.filter((x) => x.details.length > 0)) {
    out.push("", `### ${esc(c.id)}`, "", ...c.details.map((d) => `- ${esc(d)}`));
  }
  out.push("");
  return out.join("\n");
}
