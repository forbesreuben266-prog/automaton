/**
 * Daily operations: one bounded, offline, read-mostly run that inspects the business and writes a report.
 *
 *   operations daily [--json]   checks ventures, products, campaigns, approvals and recorded results; writes
 *                               reports/daily-YYYY-MM-DD.md and .json (Europe/London date; a rerun on the same day
 *                               replaces that day's report) and an audit entry. The only maintenance it performs is
 *                               the MAINTENANCE allowlist below (local and idempotent), skipped while STOP is set.
 *   operations block <scope> --reason <text> | unblock <scope> | blockers
 *                               the owner records an outside blocker (for example "facebook": account verification).
 *                               Only reporting uses it; nothing is retried, published or contacted.
 *   operations unit             prints systemd user service and timer templates (08:00 Europe/London); installs nothing.
 *
 * It never publishes, schedules, sends, buys, approves, changes prices or copy, deletes records, or makes network or
 * model calls. Numbers come only from records the owner made; anything else is reported as unknown or not recorded.
 */

import fs from "node:fs";
import path from "node:path";
import { contentHash, type Campaign, type Post } from "./campaign.js";
import { stopReason, withLock, type EngineConfig } from "./control.js";
import { renderDashboard } from "./dashboard.js";
import { changedFiles, realTotals, reviewHash, type Product } from "./products.js";
import { ensurePrivateDir, type Store } from "./store.js";
import { aiReadiness, type Readiness } from "./ai-factory.js";

export const TIMEZONE = "Europe/London";
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
/** The calendar date in the UK (GMT in winter, BST in summer). */
export const londonDate = (d: Date) => ymd.format(d);
export const londonTime = (d: Date) => hm.format(d);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Local maintenance the daily run may perform: each is idempotent, local and reversible by rerunning. */
export const MAINTENANCE = ["dashboard: regenerate the private dashboard.html from current records"] as const;
/** What the daily run will never do; shown in every report. */
export const NEVER = "Nothing was published, scheduled, sent, bought, approved, priced, reworded or deleted; no network or model calls were made.";

export interface Blocker { readonly scope: string; readonly reason: string; readonly since: string }
export interface Item { readonly priority: 1 | 2 | 3; readonly ref: string; readonly text: string; readonly command?: string }
export type RunStatus = "ok" | "partial" | "failed";

export interface DailyReport {
  readonly schema: 1; readonly date: string; readonly timezone: string; readonly generatedAt: string; readonly status: RunStatus;
  readonly business: { readonly ventures: number; readonly venturesByStatus: Readonly<Record<string, number>>; readonly pendingApprovals: number; readonly stopped: string | null; readonly engineSchedule: boolean; readonly modelProvider: string; readonly paidUsageApproved: boolean } | null;
  readonly products: readonly { readonly id: string; readonly name: string; readonly version: number; readonly status: string; readonly price: string; readonly signOff: "current" | "stale" | "missing"; readonly filesIntact: boolean | null; readonly liveUrl: string | null; readonly supersededBy: string | null }[];
  readonly campaigns: readonly { readonly id: string; readonly productId: string; readonly url: string; readonly posts: readonly { readonly id: string; readonly platform: string; readonly date: string; readonly status: string; readonly state: string }[] }[];
  /** Owner-recorded results only. null = nothing recorded (unknown), never zero. */
  readonly sales: readonly { readonly productId: string; readonly periods: number; readonly verifiedPeriods: number; readonly lastPeriodEnd: string | null; readonly visits: number | null; readonly signups: number | null; readonly sales: number | null; readonly revenue: number | null; readonly currency: string }[];
  /** Product factory runs (factory.ts). */
  readonly factory: readonly { readonly id: string; readonly date: string; readonly mode: string; readonly status: string; readonly concept: string | null; readonly productId: string | null; readonly productStatus: string | null }[];
  /** AI provider readiness from local checks only (no network, no tokens). */
  readonly aiProvider: Readiness | null;
  readonly engagement: readonly { readonly campaignId: string; readonly postsWithResults: number; readonly impressions: number | null; readonly clicks: number | null }[];
  readonly actions: readonly Item[]; readonly blocked: readonly Item[]; readonly approvals: readonly Item[]; readonly problems: readonly Item[];
  readonly checked: readonly string[]; readonly completed: readonly string[]; readonly errors: readonly string[]; readonly limitations: readonly string[];
}

const SCOPE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const clean = (s: string, max = 200) => s.replace(/[^\x20-\x7e£€]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function blockers(store: Store): Blocker[] { return store.operations().blockers ?? []; }
export function setBlocker(store: Store, scope: string, reason: string, now: Date): Blocker {
  if (!SCOPE.test(scope)) throw new Error("scope: a platform (facebook, linkedin, payhip) or a campaign, post or product id");
  const r = clean(reason);
  if (r.length < 3) throw new Error("--reason: say what blocks it (at least 3 characters)");
  const b: Blocker = { scope, reason: r, since: now.toISOString() };
  store.saveOperations({ ...store.operations(), blockers: [...blockers(store).filter((x) => x.scope !== scope), b] });
  store.audit({ kind: "operations-blocker-set", scope, reason: r }, now);
  return b;
}
export function clearBlocker(store: Store, scope: string, now: Date): boolean {
  const all = blockers(store);
  if (!all.some((x) => x.scope === scope)) return false;
  store.saveOperations({ ...store.operations(), blockers: all.filter((x) => x.scope !== scope) });
  store.audit({ kind: "operations-blocker-cleared", scope }, now);
  return true;
}

/** Inspects everything and builds the report. Read-only: each section that fails is reported, the rest still runs. */
export function inspect(store: Store, cfg: EngineConfig, now: Date): Omit<DailyReport, "completed" | "errors"> & { completed: string[]; errors: string[] } {
  const today = londonDate(now);
  const actions: Item[] = [], blocked: Item[] = [], approvals: Item[] = [], problems: Item[] = [], errors: string[] = [], checked: string[] = [];
  const limitations: string[] = [
    "Automaton cannot see Facebook, LinkedIn or Payhip: it knows only what you recorded with 'campaign published', 'campaign record' and 'product record'.",
    "A post scheduled in Meta Business Suite is not treated as published until you record its link.",
  ];
  const section = <T>(name: string, fn: () => T, fallback: T): T => { try { const r = fn(); checked.push(name); return r; } catch (e) { errors.push(`${name}: ${clean((e as Error).message, 300)}`); return fallback; } };
  const blocks = section("operations blockers", () => blockers(store), [] as Blocker[]);
  const blockFor = (...scopes: string[]) => blocks.find((b) => scopes.includes(b.scope));

  const business = section("ventures, approvals and controls", () => {
    const vs = store.ventures(), ap = store.approvals();
    const byStatus: Record<string, number> = {};
    for (const v of vs) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
    for (const a of ap.filter((x) => x.status === "pending")) approvals.push({ priority: 1, ref: a.id, text: `${a.action}: ${clean(a.summary, 240)}`, command: `approvals  (then: approve ${a.id} | deny ${a.id})` });
    const stopped = stopReason(store.dir);
    if (stopped) problems.push({ priority: 1, ref: "STOP", text: `STOP is set (${clean(stopped)}): engine cycles and daily maintenance are paused`, command: "resume" });
    if (cfg.model.paidUsageApproved === true) problems.push({ priority: 2, ref: "config", text: "paid model usage is approved in config.json; the daily run never uses it" });
    return { ventures: vs.length, venturesByStatus: byStatus, pendingApprovals: ap.filter((x) => x.status === "pending").length, stopped, engineSchedule: cfg.schedule.enabled, modelProvider: cfg.model.provider, paidUsageApproved: cfg.model.paidUsageApproved === true };
  }, null);

  const allProducts = section("product records", () => store.products(), [] as Product[]);
  const allApprovals = section("approval records", () => store.approvals(), [] as ReturnType<Store["approvals"]>);
  const launch = (p: Product, s: string) => allApprovals.some((x) => x.ventureId === p.ventureId && x.action === "launch-public" && x.status === s);
  const ventureIds = new Set(section("venture ids", () => store.ventures().map((v) => v.id), [] as string[]));
  const supersededBy = (p: Product) => allProducts.find((x) => x.previous === p.id)?.id ?? null;
  const current = allProducts.filter((p) => p.status !== "archived" && !supersededBy(p));
  const products = section("products (status, sign-off, file integrity)", () => allProducts.filter((p) => p.status !== "archived").map((p) => {
    const sup = supersededBy(p);
    const signOff: "current" | "stale" | "missing" = !p.signOff ? "missing" : p.signOff.reviewHash === reviewHash(p) ? "current" : "stale";
    let intact: boolean | null = null;
    if (!sup) {
      try { const ch = changedFiles(store, p); intact = ch.length === 0; if (!intact) problems.push({ priority: 1, ref: p.id, text: `files changed or missing since the build: ${ch.join(", ")}`, command: `product review ${p.id}` }); }
      catch (e) { errors.push(`${p.id} files: ${clean((e as Error).message)}`); }
      if (!ventureIds.has(p.ventureId)) problems.push({ priority: 2, ref: p.id, text: `its venture ${p.ventureId} is not in portfolio.json` });
      if (p.status === "needs-work") actions.push({ priority: 2, ref: p.id, text: "failed a QA check: review and repair it", command: `product review ${p.id}` });
      if (p.status === "ready") {
        if (signOff !== "current") approvals.push({ priority: 1, ref: p.id, text: `owner sign-off ${signOff} for the price ${p.currency} ${p.price} and ${p.review.length} legal/tax passage(s)`, command: `product sign-off ${p.id}` });
        else if (launch(p, "approved")) actions.push({ priority: 1, ref: p.id, text: "launch approved but the product is not marked live: once your Payhip page is public, record its address", command: `product mark-live ${p.id} --url <your Payhip URL>` });
        else if (!launch(p, "pending")) approvals.push({ priority: 2, ref: p.id, text: "signed off but no launch has been requested", command: `product request-launch ${p.id}` });
      }
    }
    return { id: p.id, name: p.name, version: p.version, status: p.status, price: `${p.currency} ${p.price}`, signOff, filesIntact: intact, liveUrl: p.live?.url ?? null, supersededBy: sup };
  }), []);

  const sales = section("recorded sales and visits", () => current.filter((p) => p.status === "live").map((p) => {
    const t = realTotals(p), last = p.validation.map((v) => v.periodEnd).sort().at(-1) ?? null;
    if (!t.periods) actions.push({ priority: 2, ref: p.id, text: "no visits or sales recorded yet: read them from your Payhip dashboard and record them", command: `product record ${p.id} --period YYYY-MM-DD..YYYY-MM-DD --visits N --signups N --sales N --revenue X --source "Payhip sales report"` });
    else if (last && daysBetween(last, today) > 7) actions.push({ priority: 3, ref: p.id, text: `latest recorded results end ${last} (${daysBetween(last, today)} days ago): record the period since`, command: `product record ${p.id} ...` });
    return { productId: p.id, periods: t.periods, verifiedPeriods: t.verified, lastPeriodEnd: last, visits: t.periods ? t.visits : null, signups: t.periods ? t.signups : null, sales: t.periods ? t.sales : null, revenue: t.periods ? t.revenue : null, currency: p.currency };
  }), []);
  if (!sales.some((s) => s.periods)) limitations.push("No sales, revenue or visits have been recorded: they are unknown, not zero.");

  const factory = section("product factory runs", () => store.factoryRuns().map((r) => {
    const p = r.productId ? allProducts.find((x) => x.id === r.productId) : undefined;
    const mode = r.mode ?? "offline-template";
    if (r.date === today) actions.push({ priority: 2, ref: r.id, text: `new factory run (${mode}, ${r.status}${r.concept ? `: ${r.concept}` : ""}): read its review package${mode === "mock-demo" ? " (MOCK DEMONSTRATION, not real AI)" : ""}`, command: `factory show ${r.id}` });
    if (r.status === "failed-validation" || r.status === "needs-repair") problems.push({ priority: 2, ref: r.id, text: `factory product ${r.productId} needs repair: failed ${r.failedChecks.join(", ")}`, command: `factory show ${r.id}` });
    if (r.status === "ai-failed" && r.date === today) problems.push({ priority: 2, ref: r.id, text: `AI factory run failed: ${(r.reason ?? "").slice(0, 200)}`, command: `factory show ${r.id}` });
    if (r.productId && !p) problems.push({ priority: 2, ref: r.id, text: `its product ${r.productId} is missing from products.json` });
    return { id: r.id, date: r.date, mode, status: r.status, concept: r.concept, productId: r.productId, productStatus: p ? (p.status === "ready" && p.signOff ? "ready, signed off" : p.status === "ready" ? "ready, awaiting your review and sign-off" : p.status) : null };
  }).slice(-10), []);
  const aiProvider = section("AI provider readiness (local checks only)", () => aiReadiness(store, cfg, now), null);

  const engagement: { campaignId: string; postsWithResults: number; impressions: number | null; clicks: number | null }[] = [];
  const campaigns = section("campaigns and posts", () => store.campaigns().map((c: Campaign) => {
    const prod = allProducts.find((p) => p.id === c.productId);
    if (!prod) problems.push({ priority: 1, ref: c.id, text: `its product ${c.productId} is missing from products.json` });
    else if (prod.live && prod.live.url !== c.productUrl) problems.push({ priority: 1, ref: c.id, text: `campaign link ${c.productUrl} differs from the product's live URL ${prod.live.url}: published posts cannot be recorded` });
    const live = prod?.status === "live";
    const posts = c.posts.map((p: Post) => {
      const b = blockFor(p.platform, c.id, p.id);
      const ref = `${c.id} ${p.id} (${p.platform}, ${p.date})`;
      let state: string;
      if (p.status === "published") {
        const since = p.published ? daysBetween(londonDate(new Date(p.published.at)), today) : 0;
        state = p.results.length ? "published, results recorded" : "published, no results recorded";
        if (!p.results.length && since >= 2) actions.push({ priority: 2, ref, text: `published ${since} day(s) ago: record its numbers from the platform's insights`, command: `campaign record ${c.id} ${p.id} --period ... --source "${p.platform === "facebook" ? "Meta Business Suite insights" : "LinkedIn post analytics"}"` });
      } else if (p.status === "rejected") state = "rejected";
      else if (p.status === "draft") { state = "draft: needs your approval"; approvals.push({ priority: p.date <= today ? 1 : 2, ref, text: "draft post: read it, then approve or reject it (interactive terminal)", command: `campaign post ${c.id} ${p.id}` }); }
      else if (!p.decision || p.decision.contentHash !== contentHash(p, c.productUrl)) { state = "approval stale: re-approve"; approvals.push({ priority: 1, ref, text: "approved text or date changed since approval: approve it again", command: `campaign approve ${c.id} ${p.id}` }); }
      else {
        const d = daysBetween(today, p.date);
        state = d < 0 ? `approved, ${-d} day(s) overdue, not recorded as published` : d === 0 ? "approved, due today" : `approved, due in ${d} day(s)`;
        if (b) blocked.push({ priority: d <= 0 ? 1 : 2, ref, text: `${state}; blocked: ${b.reason} (since ${b.since.slice(0, 10)})`, command: `operations unblock ${b.scope}  (once it is resolved)` });
        else if (d <= 0) actions.push({ priority: 1, ref, text: `${state}: publish it yourself on ${p.platform} (or reschedule), then record the link${live ? "" : "; the product must be marked live first"}`, command: `campaign published ${c.id} ${p.id} --url <post link>` });
        else if (d <= 3) actions.push({ priority: 2, ref, text: `${state}: make sure it is scheduled in ${p.platform === "facebook" ? "Meta Business Suite" : "LinkedIn"}`, command: `campaign export ${c.id} --platform ${p.platform}` });
        if (b) state += " (blocked)";
      }
      return { id: p.id, platform: p.platform, date: p.date, status: p.status, state };
    });
    if (!live && c.posts.some((p) => p.status === "approved")) blocked.push({ priority: 2, ref: c.id, text: `product ${c.productId} is not marked live, so no post can be recorded as published`, command: `product mark-live ${c.productId} --url ${c.productUrl}  (after an approved launch)` });
    const withRes = c.posts.filter((p) => p.results.length);
    engagement.push({ campaignId: c.id, postsWithResults: withRes.length, impressions: withRes.length ? withRes.reduce((a, p) => a + p.results.reduce((s, r) => s + r.impressions, 0), 0) : null, clicks: withRes.length ? withRes.reduce((a, p) => a + p.results.reduce((s, r) => s + r.clicks, 0), 0) : null });
    return { id: c.id, productId: c.productId, url: c.productUrl, posts };
  }), []);
  if (!campaigns.length && !errors.some((e) => e.startsWith("campaigns"))) limitations.push("No campaigns are recorded.");
  if (!engagement.some((e) => e.postsWithResults)) limitations.push("No impressions, clicks or other engagement have been recorded: unknown.");
  for (const b of blocks) if (!["facebook", "linkedin", "payhip"].includes(b.scope) && !campaigns.some((c) => c.id === b.scope || c.posts.some((p) => p.id === b.scope)) && !allProducts.some((p) => p.id === b.scope)) problems.push({ priority: 3, ref: b.scope, text: "blocker for an unknown scope", command: `operations unblock ${b.scope}` });
  for (const b of blocks.filter((x) => x.scope === "payhip")) blocked.push({ priority: 1, ref: "payhip", text: `Payhip: ${b.reason}` });

  const order = (xs: Item[]) => xs.sort((a, b) => a.priority - b.priority || a.ref.localeCompare(b.ref) || a.text.localeCompare(b.text));
  return { schema: 1, date: today, timezone: TIMEZONE, generatedAt: now.toISOString(), status: errors.length ? "partial" : "ok", business, products, campaigns, sales, factory, aiProvider, engagement,
    actions: order(actions), blocked: order(blocked), approvals: order(approvals), problems: order(problems), checked, completed: [], errors, limitations };
}

const list = (xs: readonly Item[], none: string) => (xs.length ? xs.map((x) => `- **P${x.priority}** \`${x.ref}\`: ${x.text}${x.command ? `\n  - \`${x.command}\`` : ""}`).join("\n") : `- ${none}`);
const n = (v: number | null) => (v === null ? "not recorded" : String(v));

export function renderReport(r: DailyReport): string {
  const b = r.business;
  const health = r.status !== "ok" ? "INCOMPLETE: some checks failed (see Errors)" : r.problems.some((x) => x.priority === 1) ? "ATTENTION: problems need fixing" : r.blocked.length ? "BLOCKED: some activity is waiting on outside blockers" : r.actions.length || r.approvals.length ? "OK: actions or approvals are waiting for you" : "OK: nothing needs you today";
  return [
    `# Automaton daily operations: ${r.date}`, "",
    `- Run status: **${r.status.toUpperCase()}**, generated ${londonTime(new Date(r.generatedAt))} on ${r.date} (${r.timezone})`,
    `- Health: ${health}`,
    `- ${NEVER}`, "",
    "## Business", "",
    b ? `- Ventures: ${b.ventures} (${Object.entries(b.venturesByStatus).map(([k, v]) => `${v} ${k}`).join(", ") || "none"})\n- Pending approval requests: ${b.pendingApprovals}\n- STOP switch: ${b.stopped ? `set (${b.stopped})` : "not set"}\n- Engine schedule: ${b.engineSchedule ? "enabled" : "disabled"}; model provider: ${b.modelProvider}; paid usage approved: ${b.paidUsageApproved ? "yes" : "no"}` : "- unknown (could not be read)", "",
    "## Products", "",
    r.products.length ? ["| Product | Version | Status | Price | Sign-off | Files intact | Live URL |", "|---|---|---|---|---|---|---|", ...r.products.map((p) => `| ${p.id} ${p.name} | ${p.version} | ${p.supersededBy ? `superseded by ${p.supersededBy}` : p.status} | ${p.price} | ${p.signOff} | ${p.filesIntact === null ? "-" : p.filesIntact ? "yes" : "NO"} | ${p.liveUrl ?? "not live"} |`)].join("\n") : "- no products recorded", "",
    "## Campaigns", "",
    r.campaigns.length ? r.campaigns.map((c) => [`**${c.id}** for ${c.productId}, link ${c.url}`, "", "| Date | Platform | Post | State |", "|---|---|---|---|", ...c.posts.map((p) => `| ${p.date} | ${p.platform} | ${p.id} | ${p.state} |`)].join("\n")).join("\n\n") : "- no campaigns recorded", "",
    "## Product factory", "",
    `- AI provider: ${r.aiProvider ? `${r.aiProvider.provider}, ${r.aiProvider.ready ? "ready" : "not ready"} (${r.aiProvider.reasons.join("; ")})` : "unknown"}. Unattended AI generation is not enabled.`,
    r.factory.length ? r.factory.map((x) => `- ${x.id} (${x.date}, ${x.mode}): ${x.status}${x.concept ? `, ${x.concept}` : ""}${x.productId ? `, product ${x.productId}: ${x.productStatus ?? "missing"}` : ""}`).join("\n") : "- no factory runs", "",
    "## Verified sales and engagement (owner-recorded only)", "",
    r.sales.length ? r.sales.map((s) => `- ${s.productId}: ${s.periods} period(s) recorded (${s.verifiedPeriods} with an evidence file), latest ending ${s.lastPeriodEnd ?? "-"}; visits ${n(s.visits)}, signups ${n(s.signups)}, sales ${n(s.sales)}, revenue ${s.revenue === null ? "not recorded" : `${s.currency} ${s.revenue}`}`).join("\n") : "- Sales and revenue: not recorded (no live product with recorded results)",
    ...r.engagement.map((e) => `- ${e.campaignId}: ${e.postsWithResults} post(s) with results; impressions ${n(e.impressions)}, clicks ${n(e.clicks)}`), "",
    "## Today's recommended actions", "", list(r.actions, "none"), "",
    "## Blocked", "", list(r.blocked, "nothing recorded as blocked"), "",
    "## Needs your approval", "", list(r.approvals, "nothing waiting"), "",
    "## Problems and missing information", "", list(r.problems, "none found"), "",
    "## What Automaton checked", "", ...r.checked.map((c) => `- ${c}`), "",
    "## What Automaton completed", "", ...(r.completed.length ? r.completed.map((c) => `- ${c}`) : ["- nothing"]), "",
    ...(r.errors.length ? ["## Errors", "", ...r.errors.map((e) => `- ${e}`), ""] : []),
    "## Data freshness and limitations", "", ...r.limitations.map((l) => `- ${l}`), "",
  ].join("\n");
}

function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}
export const reportDir = (store: Store) => path.join(store.dir, "reports");

/** The daily run: inspect, allowlisted maintenance, then the report files and an audit entry. */
export function runDaily(store: Store, cfg: EngineConfig, now: Date): { report: DailyReport; files: string[] } {
  const r = inspect(store, cfg, now);
  if (r.business?.stopped) r.completed.push("maintenance skipped: STOP is set");
  else {
    try { writePrivate(path.join(store.dir, "dashboard.html"), renderDashboard(store.ventures(), store.approvals(), now)); r.completed.push("dashboard.html regenerated"); }
    catch (e) { r.errors.push(`maintenance dashboard: ${clean((e as Error).message)}`); }
  }
  const report: DailyReport = { ...r, status: r.errors.length ? "partial" : "ok" };
  const dir = reportDir(store);
  ensurePrivateDir(dir);
  const base = path.join(dir, `daily-${report.date}`);
  const done: DailyReport = { ...report, completed: [...report.completed, `report saved: reports/daily-${report.date}.md and .json`] };
  writePrivate(`${base}.json`, JSON.stringify(done, null, 2) + "\n");
  writePrivate(`${base}.md`, renderReport(done));
  store.audit({ kind: "operations-daily", date: done.date, status: done.status, actions: done.actions.length, blocked: done.blocked.length, approvals: done.approvals.length, problems: done.problems.length, errors: done.errors.length }, now);
  return { report: done, files: [`${base}.md`, `${base}.json`] };
}

export const OPERATIONS_USAGE = "operations daily [--json] | operations block <scope> --reason <text> | operations unblock <scope> | operations blockers | operations unit";

export function systemdUnits(): string {
  return `# Review, then install yourself as your own user (not root). Installing does not enable it.
# ~/.config/systemd/user/automaton-daily.service
[Unit]
Description=Automaton daily operations report (offline; publishes nothing)

[Service]
Type=oneshot
ExecStart=/usr/bin/env node %h/automaton/dist/venture-engine/main.js operations daily
TimeoutStartSec=300
Nice=10
NoNewPrivileges=yes
# Local files only: no IPv4/IPv6 sockets, so no network calls are possible.
RestrictAddressFamilies=AF_UNIX

# ~/.config/systemd/user/automaton-daily.timer
[Unit]
Description=Automaton daily operations at 08:00 UK time

[Timer]
# The zone makes 08:00 follow GMT/BST changes.
OnCalendar=*-*-* 08:00:00 ${TIMEZONE}
Persistent=true
AccuracySec=1min
Unit=automaton-daily.service

[Install]
WantedBy=timers.target
`;
}

export async function operationsCli(args: readonly string[], ctx: { store: Store; cfg: EngineConfig; out: (s: string) => void; now: () => Date }): Promise<number> {
  const [sub, a, ...rest] = args;
  const { store, out } = ctx;
  if (sub === "daily") {
    const json = a === "--json";
    if ((a !== undefined && !json) || rest.length) throw new Error("operations daily [--json]");
    const { report, files } = await withLock(store.dir, async () => runDaily(store, ctx.cfg, ctx.now()));
    out(json ? JSON.stringify(report, null, 2) + "\n" : renderReport(report) + `\nSaved: ${files.join(", ")}\n`);
    return report.status === "ok" ? 0 : 1;
  }
  if (sub === "block") {
    if (rest[0] !== "--reason" || rest[1] === undefined || rest.length !== 2) throw new Error("operations block <scope> --reason <text>");
    const b = await withLock(store.dir, async () => setBlocker(store, String(a), rest[1], ctx.now()));
    out(`blocked ${b.scope}: ${b.reason} (reporting only; nothing is retried or published)\n`); return 0;
  }
  if (sub === "unblock") { if (!a || rest.length) throw new Error("operations unblock <scope>"); const ok = await withLock(store.dir, async () => clearBlocker(store, a, ctx.now())); out(ok ? `unblocked ${a}\n` : `${a} was not blocked\n`); return 0; }
  if (sub === "blockers") { const bs = blockers(store); out(bs.length ? bs.map((b) => `${b.scope}: ${b.reason} (since ${b.since})`).join("\n") + "\n" : "no blockers recorded\n"); return 0; }
  if (sub === "unit") { out(systemdUnits()); return 0; }
  out(`Usage: ${OPERATIONS_USAGE}\n`);
  return 2;
}
