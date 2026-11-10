/**
 * Revenue: goals, channel attribution, owner-verified marketing measurements and costs, and an offline opportunity
 * scoring framework. Every number comes from an owner record; anything not recorded is "unknown" (never zero), and a
 * conversion rate is shown only when its numerator and denominator were recorded for the same channel and days.
 *
 *   revenue record (--plan <pln> | --campaign <cmp>) --channel <c> --date YYYY-MM-DD [--clicks N] [--visits N] --source <t> [--evidence <file>]
 *   revenue cost --date YYYY-MM-DD --amount X --description <t> [--channel <c>] --source <t>
 *   revenue goals | revenue report
 *   opportunities score [--file ideas.json]
 *
 * Automaton never spends: costs are what the owner paid and records here.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, type Channel } from "./audience.js";
import { CONCEPTS } from "./blueprints/toolkit.js";
import { DEFAULT_BRAND } from "./brands.js";
import { withLock } from "./control.js";
import { londonDate } from "./operations.js";
import { pence, pounds, salesTotals, type Order } from "./sales.js";
import { ensurePrivateDir, newId, type Store } from "./store.js";

export const FIRST_SALES_GOAL = 10;
export interface Metric { readonly id: string; readonly brand: string; readonly planId: string | null; readonly campaignId: string | null; readonly productId: string; readonly channel: Channel; readonly date: string; readonly clicks: number | null; readonly visits: number | null; readonly source: string; readonly verification: "evidence-file" | "owner-reported"; readonly evidence: { readonly name: string; readonly bytes: number; readonly sha256: string } | null; readonly recordedAt: string }
export interface Cost { readonly id: string; readonly brand: string; readonly date: string; readonly pence: number; readonly channel: Channel | null; readonly description: string; readonly source: string; readonly recordedAt: string }
export interface MarketingLedger { readonly metrics: readonly Metric[]; readonly costs: readonly Cost[] }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const count = (s: string | undefined, what: string) => { if (s === undefined) return null; if (!/^\d{1,7}$/.test(s)) throw new Error(`${what}: a whole number`); return Number(s); };
const channel = (s: string | undefined) => { if (!CHANNELS.includes(s as Channel)) throw new Error(`--channel: one of ${CHANNELS.join(", ")}`); return s as Channel; };
const evidenceOf = (file: string) => {
  let fd: number; try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw new Error("--evidence: cannot open the file (links are not followed)"); }
  try { const s = fs.fstatSync(fd); if (!s.isFile() || !s.size || s.size > 10 * 1024 * 1024) throw new Error("--evidence: a non-empty regular file up to 10 MB"); return { name: path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80), bytes: s.size, sha256: createHash("sha256").update(fs.readFileSync(fd)).digest("hex") }; } finally { fs.closeSync(fd); }
};

/** One verified measurement per scope, channel and day (duplicates refused). */
export function recordMetric(store: Store, r: { planId?: string; campaignId?: string; channel: string; date: string; clicks?: string; visits?: string; source: string; evidenceFile?: string }, now: Date): Metric {
  if (!!r.planId === !!r.campaignId) throw new Error("give exactly one of --plan or --campaign");
  const ch = channel(r.channel);
  if (!DAY.test(r.date) || r.date > londonDate(now)) throw new Error("--date: YYYY-MM-DD, not in the future");
  const clicks = count(r.clicks, "--clicks"), visits = count(r.visits, "--visits");
  if (clicks === null && visits === null) throw new Error("record at least one of --clicks or --visits (as shown in your analytics)");
  if (r.source.trim().length < 3) throw new Error("--source: where you read the numbers (for example \"Payhip dashboard\")");
  let productId: string;
  if (r.planId) { const p = store.audiencePlans().find((x) => x.id === r.planId); if (!p) throw new Error(`no audience plan ${r.planId}`); if (!p.channels.includes(ch)) throw new Error(`--channel: ${ch} is not in plan ${p.id}`); if (r.date < p.start) throw new Error("--date: before the plan started"); productId = p.productId; }
  else { const c = store.campaigns().find((x) => x.id === r.campaignId); if (!c) throw new Error(`no campaign ${r.campaignId}`); if (!c.posts.some((x) => x.platform === ch)) throw new Error(`--channel: ${ch} is not in campaign ${c.id}`); productId = c.productId; }
  const m = store.marketing();
  const dup = m.metrics.find((x) => x.channel === ch && x.date === r.date && x.planId === (r.planId ?? null) && x.campaignId === (r.campaignId ?? null));
  if (dup) throw new Error(`${ch} on ${r.date} is already recorded (${dup.id}); nothing was added`);
  const evidence = r.evidenceFile ? evidenceOf(r.evidenceFile) : null;
  const rec: Metric = { id: newId("mtr"), brand: DEFAULT_BRAND.id, planId: r.planId ?? null, campaignId: r.campaignId ?? null, productId, channel: ch, date: r.date, clicks, visits, source: r.source.trim().slice(0, 200), verification: evidence ? "evidence-file" : "owner-reported", evidence, recordedAt: now.toISOString() };
  store.saveMarketing({ ...m, metrics: [...m.metrics, rec] });
  store.audit({ kind: "marketing-metric", metric: rec.id, channel: ch, date: r.date, clicks, visits }, now);
  return rec;
}

export function recordCost(store: Store, r: { date: string; amount: string; description: string; channel?: string; source: string }, now: Date): Cost {
  if (!DAY.test(r.date) || r.date > londonDate(now)) throw new Error("--date: YYYY-MM-DD, not in the future");
  const p = pence(r.amount, "--amount");
  const description = r.description.trim();
  if (description.length < 3 || r.source.trim().length < 3) throw new Error("--description and --source: what it was and where the receipt is");
  const m = store.marketing();
  if (m.costs.some((x) => x.date === r.date && x.pence === p && x.description.toLowerCase() === description.toLowerCase())) throw new Error("this cost is already recorded; nothing was added");
  const rec: Cost = { id: newId("cst"), brand: DEFAULT_BRAND.id, date: r.date, pence: p, channel: r.channel ? channel(r.channel) : null, description: description.slice(0, 200), source: r.source.trim().slice(0, 200), recordedAt: now.toISOString() };
  store.saveMarketing({ ...m, costs: [...m.costs, rec] });
  store.audit({ kind: "marketing-cost", cost: rec.id, pence: p }, now);
  return rec;
}

const fullyRefunded = (o: Order) => o.refunds.reduce((a, r) => a + r.pence, 0) >= o.grossPence;

export interface GoalProgress { readonly productId: string; readonly name: string; readonly target: number; readonly sales: number; readonly withEvidence: number; readonly remaining: number }
/** Progress towards the first 10 verified sales of each live product (fully refunded orders do not count). */
export function goals(store: Store): GoalProgress[] {
  return store.products().filter((p) => p.status === "live").map((p) => {
    const os = store.orders().filter((o) => o.productId === p.id && !fullyRefunded(o));
    return { productId: p.id, name: p.name, target: FIRST_SALES_GOAL, sales: os.length, withEvidence: os.filter((o) => o.verification === "evidence-file").length, remaining: Math.max(0, FIRST_SALES_GOAL - os.length) };
  });
}

export interface ChannelRow { readonly channel: string; readonly posted: number; readonly clicks: number | null; readonly visits: number | null; readonly orders: number; readonly grossPence: number; readonly netPence: number; readonly costPence: number; readonly conversion: string }
/** Per-channel performance from records only. Conversion: attributed orders on days that also have recorded visits, over those visits. */
export function channelPerformance(store: Store): ChannelRow[] {
  const m = store.marketing(), orders = store.orders(), plans = store.audiencePlans();
  const campaignPosts = store.campaigns().flatMap((c) => c.posts);
  return CHANNELS.map((ch) => {
    const ms = m.metrics.filter((x) => x.channel === ch);
    const sum = (k: "clicks" | "visits") => (ms.some((x) => x[k] !== null) ? ms.reduce((a, x) => a + (x[k] ?? 0), 0) : null);
    const os = orders.filter((o) => (o as Order & { channel?: string }).channel === ch);
    const t = salesTotals(os);
    const visitDays = new Set(ms.filter((x) => x.visits !== null).map((x) => x.date));
    const visits = ms.filter((x) => x.visits !== null).reduce((a, x) => a + (x.visits ?? 0), 0);
    const comparable = os.filter((o) => visitDays.has(o.date)).length;
    const posted = plans.reduce((a, pl) => a + pl.days.filter((d) => d.channel === ch && d.posted).length, 0) + campaignPosts.filter((x) => x.platform === ch && x.status === "published").length;
    return { channel: ch, posted, clicks: sum("clicks"), visits: sum("visits"), orders: os.length, grossPence: t.grossPence, netPence: t.netPence,
      costPence: m.costs.filter((c) => c.channel === ch).reduce((a, c) => a + c.pence, 0),
      conversion: visits > 0 ? `${((100 * comparable) / visits).toFixed(1)}% (${comparable} order(s) / ${visits} recorded visit(s), same days)` : "not measurable (no recorded visits)" };
  });
}

export function experimentResult(store: Store, planId: string, today: string): { status: string; orders: number; visits: number | null; clicks: number | null; posted: number; conclusion: string } {
  const p = store.audiencePlans().find((x) => x.id === planId)!;
  const os = store.orders().filter((o) => (o as Order & { planId?: string }).planId === p.id);
  const ms = store.marketing().metrics.filter((x) => x.planId === p.id);
  const status = today < p.start ? "not started" : today > p.end ? "ended" : `running (day ${Math.round((Date.parse(today) - Date.parse(p.start)) / 86_400_000) + 1} of ${p.days.length})`;
  const posted = p.days.filter((d) => d.posted).length;
  const conclusion = today <= p.end ? "not yet measured: the experiment is still running" : posted === 0 ? "not measurable: no post was recorded as published" : os.length >= 1 ? `met: ${os.length} verified order(s)` : "not met: no verified order attributed to this plan";
  return { status, orders: os.length, visits: ms.some((x) => x.visits !== null) ? ms.reduce((a, x) => a + (x.visits ?? 0), 0) : null, clicks: ms.some((x) => x.clicks !== null) ? ms.reduce((a, x) => a + (x.clicks ?? 0), 0) : null, posted, conclusion };
}

export function revenueReport(store: Store, today: string): string {
  const t = salesTotals(store.orders()), costs = store.marketing().costs.reduce((a, c) => a + c.pence, 0);
  const g = goals(store);
  const rows = channelPerformance(store);
  const n = (v: number | null) => (v === null ? "unknown" : String(v));
  return `REVENUE (verified, owner-recorded; ${DEFAULT_BRAND.name})
gross ${pounds(t.grossPence)}, refunds ${pounds(t.refundsPence)}, fees ${pounds(t.feesPence)}${t.ordersWithoutFees ? ` (fees not recorded for ${t.ordersWithoutFees} order(s): net is an upper bound)` : ""}, net ${pounds(t.netPence)}; marketing costs ${pounds(costs)}; net contribution ${pounds(t.netPence - costs)}${t.orders ? "" : " (no orders recorded: revenue unknown, not zero)"}
goals: ${g.map((x) => `${x.name} ${x.sales}/${x.target} sales`).join("; ") || "no live product"}
channels:
${rows.map((r) => `  ${r.channel.padEnd(15)} posted ${r.posted}, clicks ${n(r.clicks)}, visits ${n(r.visits)}, orders ${r.orders}, net ${pounds(r.netPence)}, costs ${pounds(r.costPence)}, conversion ${r.conversion}`).join("\n")}
experiments:
${store.audiencePlans().map((p) => { const e = experimentResult(store, p.id, today); return `  ${p.id} ${p.productId}: ${e.status}; posted ${e.posted}/${p.days.length}; orders ${e.orders}; visits ${n(e.visits)}; ${e.conclusion}`; }).join("\n") || "  none"}
`;
}

// ---------------------------------------------------------------- opportunities (offline)

export const OPPORTUNITY_FACTORS = ["problem", "willingnessToPay", "distribution", "competition", "deliveryCost", "maintenance", "evidenceQuality"] as const;
type Factor = (typeof OPPORTUNITY_FACTORS)[number];
export interface ScoredOpportunity { readonly name: string; readonly source: string; readonly score: number; readonly validatedFactors: readonly Factor[]; readonly factors: Readonly<Record<Factor, { value: number; status: "validated" | "hypothesis"; basis: string }>> }
const W: Readonly<Record<Factor, number>> = { problem: 0.2, willingnessToPay: 0.2, distribution: 0.15, competition: 0.1, deliveryCost: 0.1, maintenance: 0.1, evidenceQuality: 0.15 };

/** Scores current products, unbuilt catalogue concepts and optional owner ideas. Only recorded orders or measurements validate a factor. */
export function scoreOpportunities(store: Store, extra: readonly { name: string; factors: Partial<Record<Factor, number>>; evidence?: string }[] = []): ScoredOpportunity[] {
  const h = (value: number, basis: string) => ({ value, status: "hypothesis" as const, basis });
  const out: ScoredOpportunity[] = [];
  const mk = (name: string, source: string, f: Record<Factor, { value: number; status: "validated" | "hypothesis"; basis: string }>) =>
    out.push({ name, source, factors: f, validatedFactors: OPPORTUNITY_FACTORS.filter((k) => f[k].status === "validated"), score: Math.round(100 * OPPORTUNITY_FACTORS.reduce((a, k) => a + f[k].value * W[k], 0)) / 100 });
  const metrics = store.marketing().metrics;
  for (const p of store.products().filter((x) => x.status === "live" || x.status === "ready")) {
    if (store.products().some((x) => x.previous === p.id)) continue;
    const os = store.orders().filter((o) => o.productId === p.id && !fullyRefunded(o));
    const ms = metrics.filter((m) => m.productId === p.id && ((m.visits ?? 0) > 0 || (m.clicks ?? 0) > 0));
    mk(p.name, `product ${p.id} (${p.status})`, {
      problem: h(0.7, "hypothesis: the product addresses a stated problem; no customer interviews recorded"),
      willingnessToPay: os.length ? { value: Math.min(1, 0.5 + os.length / 20), status: "validated", basis: `${os.length} verified order(s)` } : h(0.5, "hypothesis: no verified order yet"),
      distribution: ms.length ? { value: 0.7, status: "validated", basis: `${ms.length} recorded measurement(s) with clicks or visits` } : h(0.5, "hypothesis: no verified clicks or visits yet"),
      competition: h(0.5, "unknown: no competitor research recorded"),
      deliveryCost: h(0.9, "digital download: no per-sale delivery cost"), maintenance: h(0.8, "static files; occasional updates"),
      evidenceQuality: os.length ? { value: 0.8, status: "validated", basis: "orders recorded" } : ms.length ? { value: 0.5, status: "validated", basis: "measurements only" } : h(0.1, "no evidence recorded"),
    });
  }
  const built = new Set(store.products().map((p) => p.name.toLowerCase()));
  for (const c of CONCEPTS.filter((x) => !built.has(x.name.toLowerCase()))) mk(c.name, "offline catalogue concept", {
    problem: h(c.ratings.usefulness, c.reasons.usefulness), willingnessToPay: h(c.ratings.monetisation, c.reasons.monetisation), distribution: h(0.5, "hypothesis: same channels as the live product"),
    competition: h(0.5, "unknown: not researched"), deliveryCost: h(0.9, "digital download"), maintenance: h(c.ratings.simplicity, c.reasons.simplicity), evidenceQuality: h(0.1, "no evidence recorded"),
  });
  for (const e of extra) {
    const v = (k: Factor, d: number) => { const x = e.factors[k]; return typeof x === "number" && x >= 0 && x <= 1 ? x : d; };
    mk(e.name.slice(0, 80), "owner idea", Object.fromEntries(OPPORTUNITY_FACTORS.map((k) => [k, h(v(k, 0.5), k === "evidenceQuality" ? (e.evidence ? `owner note (not verified): ${e.evidence.slice(0, 120)}` : "no evidence recorded") : "owner estimate (hypothesis)")])) as Record<Factor, { value: number; status: "hypothesis"; basis: string }>);
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export const REVENUE_USAGE = "revenue record (--plan <pln> | --campaign <cmp>) --channel <c> --date YYYY-MM-DD [--clicks N] [--visits N] --source <text> [--evidence <file>] | revenue cost --date YYYY-MM-DD --amount X --description <text> [--channel <c>] --source <text> | revenue goals | revenue report | opportunities score [--file <ideas.json>]";

const parse = (args: readonly string[], allowed: readonly string[]) => { const f: Record<string, string> = {}; for (let i = 0; i < args.length; i += 2) { if (!allowed.includes(args[i]) || args[i + 1] === undefined) throw new Error(`unknown or incomplete option ${args[i] ?? ""}`); f[args[i]] = args[i + 1]; } return f; };

export async function revenueCli(cmd: "revenue" | "opportunities", args: readonly string[], ctx: { store: Store; out: (s: string) => void; now: () => Date }): Promise<number> {
  const [sub, ...rest] = args;
  const { store, out } = ctx;
  const today = londonDate(ctx.now());
  if (cmd === "opportunities") {
    if (sub !== "score") { out(`Usage: ${REVENUE_USAGE}\n`); return 2; }
    const f = parse(rest, ["--file"]);
    let extra: { name: string; factors: Partial<Record<Factor, number>>; evidence?: string }[] = [];
    if (f["--file"]) { try { const j = JSON.parse(fs.readFileSync(f["--file"], "utf8")); extra = (Array.isArray(j) ? j : []).filter((x) => typeof x?.name === "string").slice(0, 50).map((x) => ({ name: x.name, factors: x.factors ?? {}, evidence: typeof x.evidence === "string" ? x.evidence : undefined })); } catch { throw new Error("--file: a JSON list of {name, factors, evidence}"); } }
    const s = scoreOpportunities(store, extra);
    const dir = path.join(store.dir, "opportunities"); ensurePrivateDir(dir);
    const file = path.join(dir, `scores-${today}.json`); const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ date: today, weights: W, note: "hypotheses unless a factor is marked validated by recorded orders or measurements", opportunities: s }, null, 2) + "\n", { mode: 0o600, flag: "wx" }); fs.renameSync(tmp, file);
    out(`OPPORTUNITIES (offline; no research, scraping or paid calls)\n${s.map((o) => `  ${o.score.toFixed(2)}  ${o.name} [${o.source}]: validated ${o.validatedFactors.join(", ") || "none"}; rest are hypotheses`).join("\n")}\nSaved: ${file}\n`);
    return 0;
  }
  if (sub === "record") {
    const f = parse(rest, ["--plan", "--campaign", "--channel", "--date", "--clicks", "--visits", "--source", "--evidence"]);
    const m = await withLock(store.dir, async () => recordMetric(store, { planId: f["--plan"], campaignId: f["--campaign"], channel: f["--channel"], date: f["--date"] ?? "", clicks: f["--clicks"], visits: f["--visits"], source: f["--source"] ?? "", evidenceFile: f["--evidence"] }, ctx.now()));
    out(`recorded ${m.id}: ${m.channel} ${m.date}, clicks ${m.clicks ?? "not recorded"}, visits ${m.visits ?? "not recorded"} (${m.verification})\n`); return 0;
  }
  if (sub === "cost") {
    const f = parse(rest, ["--date", "--amount", "--description", "--channel", "--source"]);
    const c = await withLock(store.dir, async () => recordCost(store, { date: f["--date"] ?? "", amount: f["--amount"] ?? "", description: f["--description"] ?? "", channel: f["--channel"], source: f["--source"] ?? "" }, ctx.now()));
    out(`recorded cost ${c.id}: £${pounds(c.pence)} on ${c.date} (${c.description}). Automaton itself never spends.\n`); return 0;
  }
  if (sub === "goals") { const g = goals(store); out(g.length ? g.map((x) => `${x.name} (${x.productId}): ${x.sales}/${x.target} verified sales (${x.withEvidence} with an evidence file); ${x.remaining} to go`).join("\n") + "\n" : "no live product: the first-sales goal starts when a product is live\n"); return 0; }
  if (sub === "report") { out(revenueReport(store, today)); return 0; }
  out(`Usage: ${REVENUE_USAGE}\n`);
  return 2;
}
