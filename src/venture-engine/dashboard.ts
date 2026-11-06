/**
 * Private dashboard: one self-contained HTML file (no scripts, no external resources) written into the private data
 * folder. Simulated estimates and actual, owner-recorded results are shown in separate columns, and totals count only
 * actual results.
 */

import type { ApprovalRequest, Venture } from "./types.js";

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface PortfolioTotals { readonly ventures: number; readonly active: number; readonly launched: number; readonly actualRevenueUsd: number; readonly actualCostUsd: number; readonly pendingApprovals: number }

export function totals(ventures: readonly Venture[], approvals: readonly ApprovalRequest[]): PortfolioTotals {
  let rev = 0, cost = 0;
  for (const v of ventures) for (const x of v.experiments) for (const e of x.evidence) if (e.kind === "actual") { rev += e.metrics.revenueUsd ?? 0; cost += e.metrics.costUsd ?? 0; }
  return {
    ventures: ventures.length, active: ventures.filter((v) => !["archived", "shut-down"].includes(v.status)).length, launched: ventures.filter((v) => v.status === "launched").length,
    actualRevenueUsd: Math.round(rev * 100) / 100, actualCostUsd: Math.round(cost * 100) / 100, pendingApprovals: approvals.filter((a) => a.status === "pending").length,
  };
}

export function renderDashboard(ventures: readonly Venture[], approvals: readonly ApprovalRequest[], now: Date): string {
  const t = totals(ventures, approvals);
  const row = (v: Venture) => {
    const last = v.experiments.at(-1);
    const sim = last?.evidence.filter((e) => e.kind === "simulated").at(-1)?.metrics.qualityScore;
    const act = [...v.experiments].reverse().flatMap((x) => [...x.evidence].reverse()).find((e) => e.kind === "actual");
    const d = v.decisions.at(-1);
    return `<tr><td>${esc(v.id)}</td><td>${esc(v.opportunity.title)}</td><td>${esc(v.status)}</td><td>${esc(v.opportunity.score)}</td><td>${v.experiments.length}</td>
<td>${last ? (last.verified ? "yes" : "no") : "-"}</td><td>${sim === undefined ? "-" : esc(sim)}</td>
<td>${act ? esc(`${act.metrics.visitors ?? 0} visitors, ${act.metrics.signups ?? 0} signups, ${act.metrics.sales ?? 0} sales, $${act.metrics.revenueUsd ?? 0} (${act.source})`) : "none"}</td>
<td>${d ? esc(`${d.kind} (${d.basis}): ${d.reason}`) : "-"}</td></tr>`;
  };
  const pending = approvals.filter((a) => a.status === "pending");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Automaton portfolio</title>
<style>body{font-family:system-ui,sans-serif;margin:1.5rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.3rem .5rem;font-size:.9rem;vertical-align:top}th{background:#f3f3f3}.note{background:#fff7d6;padding:.5rem}</style>
</head><body>
<h1>Automaton portfolio</h1>
<p>Generated ${esc(now.toISOString())}. ${t.ventures} ventures (${t.active} active, ${t.launched} launched); ${t.pendingApprovals} approval request(s) pending.</p>
<p class="note"><strong>Actual results</strong> (owner-recorded only): revenue $${t.actualRevenueUsd}, cost $${t.actualCostUsd}. <strong>Simulated quality</strong> is the engine's own estimate and is not customer or financial data.</p>
<h2>Approval requests</h2>
${pending.length ? `<ul>${pending.map((a) => `<li><code>${esc(a.id)}</code> ${esc(a.action)}: ${esc(a.summary)}</li>`).join("")}</ul>` : "<p>None pending.</p>"}
<h2>Ventures</h2>
<table><tr><th>id</th><th>opportunity</th><th>status</th><th>opportunity score (simulated)</th><th>iterations</th><th>verified</th><th>quality (simulated)</th><th>actual results</th><th>latest decision</th></tr>
${ventures.map(row).join("\n")}
</table>
</body></html>
`;
}
