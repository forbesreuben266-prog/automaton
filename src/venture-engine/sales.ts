/**
 * Verified sales: order-level records the owner enters from their own Payhip evidence (an order export or the order
 * page). Only an order reference, date and amounts are kept: no customer names, emails or addresses. An evidence file
 * is hashed, never copied. Amounts are held in pence (no rounding drift).
 *
 *   sales record <product> --order <ref> --date YYYY-MM-DD --gross X [--fees X] [--campaign <cmp> [--post <pst>]]
 *                --source <text> [--evidence <file>]
 *   sales refund <order-id> --amount X --date YYYY-MM-DD --source <text>
 *   sales report [product]
 *
 * Duplicate order references are refused. Attribution is recorded only to a campaign of the same product and only to a
 * post with a recorded publication. Nothing is estimated: fees are "not recorded" unless given.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withLock } from "./control.js";
import type { Product } from "./products.js";
import { newId, type Store } from "./store.js";

export interface Order {
  readonly id: string; readonly productId: string; readonly orderRef: string; readonly date: string; readonly currency: string;
  readonly grossPence: number; readonly feesPence: number | null;
  readonly refunds: readonly { readonly at: string; readonly date: string; readonly pence: number; readonly source: string }[];
  readonly campaignId: string | null; readonly postId: string | null;
  readonly source: string; readonly verification: "evidence-file" | "owner-reported";
  readonly evidence: { readonly name: string; readonly bytes: number; readonly sha256: string } | null;
  readonly recordedAt: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
export function pence(s: string | undefined, what: string, allowZero = false): number {
  if (s === undefined || !/^\d{1,6}(\.\d{1,2})?$/.test(s)) throw new Error(`${what}: an amount like 12 or 12.50`);
  const [w, f = ""] = s.split(".");
  const p = Number(w) * 100 + Number(f.padEnd(2, "0"));
  if (!allowZero && p === 0) throw new Error(`${what}: must be more than 0`);
  return p;
}
export const pounds = (p: number) => (p / 100).toFixed(2);
const refunded = (o: Order) => o.refunds.reduce((a, r) => a + r.pence, 0);

function evidenceOf(file: string): Order["evidence"] {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw new Error("--evidence: cannot open the file (links are not followed)"); }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size === 0 || s.size > 10 * 1024 * 1024) throw new Error("--evidence: a non-empty regular file up to 10 MB");
    return { name: path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80), bytes: s.size, sha256: createHash("sha256").update(fs.readFileSync(fd)).digest("hex") };
  } finally { fs.closeSync(fd); }
}

export function recordOrder(store: Store, productId: string, r: { orderRef: string; date: string; gross: string; fees?: string; campaignId?: string; postId?: string; source: string; evidenceFile?: string }, now: Date): Order {
  const p = store.products().find((x) => x.id === productId) as Product | undefined;
  if (!p) throw new Error(`no product ${productId}`);
  if (p.status !== "live" || !p.live) throw new Error(`${productId} is ${p.status}: sales can be recorded only for a live product (product mark-live)`);
  if (!REF.test(r.orderRef)) throw new Error("--order: the Payhip order reference (3 to 64 letters, digits, - or _)");
  if (!DAY.test(r.date) || Number.isNaN(Date.parse(r.date)) || r.date > now.toISOString().slice(0, 10) || r.date < p.live.at.slice(0, 10)) throw new Error("--date: YYYY-MM-DD, not in the future and not before the product went live");
  const source = r.source.trim();
  if (source.length < 3) throw new Error("--source: where the order came from (for example \"Payhip orders export\")");
  const grossPence = pence(r.gross, "--gross");
  const feesPence = r.fees === undefined ? null : pence(r.fees, "--fees", true);
  if (feesPence !== null && feesPence > grossPence) throw new Error("--fees: cannot be more than the gross amount");
  const orders = store.orders();
  const dup = orders.find((o) => o.orderRef.toLowerCase() === r.orderRef.toLowerCase());
  if (dup) throw new Error(`order ${r.orderRef} is already recorded (${dup.id}, ${dup.date}); nothing was added`);
  let campaignId: string | null = null, postId: string | null = null;
  if (r.postId !== undefined && r.campaignId === undefined) throw new Error("--post needs --campaign");
  if (r.campaignId !== undefined) {
    const c = store.campaigns().find((x) => x.id === r.campaignId);
    if (!c || c.productId !== productId) throw new Error(`--campaign: ${r.campaignId} is not a campaign for ${productId}`);
    campaignId = c.id;
    if (r.postId !== undefined) {
      const post = c.posts.find((x) => x.id === r.postId);
      if (!post) throw new Error(`--post: ${r.postId} is not in ${c.id}`);
      if (post.status !== "published" || !post.published) throw new Error(`--post: ${r.postId} has no recorded publication, so a sale cannot be attributed to it`);
      postId = post.id;
    }
  }
  const evidence = r.evidenceFile !== undefined ? evidenceOf(r.evidenceFile) : null;
  const o: Order = { id: newId("ord"), productId, orderRef: r.orderRef, date: r.date, currency: p.currency, grossPence, feesPence, refunds: [], campaignId, postId,
    source: source.slice(0, 200), verification: evidence ? "evidence-file" : "owner-reported", evidence, recordedAt: now.toISOString() };
  store.saveOrders([...orders, o]);
  store.audit({ kind: "sale-recorded", order: o.id, product: productId, orderRef: o.orderRef, grossPence, feesPence, campaign: campaignId, post: postId, verification: o.verification, evidenceSha256: evidence?.sha256 ?? null }, now);
  return o;
}

export function recordRefund(store: Store, orderId: string, r: { amount: string; date: string; source: string }, now: Date): Order {
  const orders = store.orders();
  const o = orders.find((x) => x.id === orderId);
  if (!o) throw new Error(`no order ${orderId}`);
  const amount = pence(r.amount, "--amount");
  if (!DAY.test(r.date) || r.date < o.date || r.date > now.toISOString().slice(0, 10)) throw new Error("--date: YYYY-MM-DD, on or after the order date and not in the future");
  if (refunded(o) + amount > o.grossPence) throw new Error(`refunds would total more than the order's gross £${pounds(o.grossPence)} (already refunded £${pounds(refunded(o))})`);
  if (r.source.trim().length < 3) throw new Error("--source: where the refund is shown");
  const next: Order = { ...o, refunds: [...o.refunds, { at: now.toISOString(), date: r.date, pence: amount, source: r.source.trim().slice(0, 200) }] };
  store.saveOrders(orders.map((x) => (x.id === o.id ? next : x)));
  store.audit({ kind: "refund-recorded", order: o.id, pence: amount }, now);
  return next;
}

export interface SalesTotals { readonly orders: number; readonly grossPence: number; readonly refundsPence: number; readonly feesPence: number; readonly ordersWithoutFees: number; readonly netPence: number; readonly verified: number; readonly byCampaign: Readonly<Record<string, number>>; readonly unattributed: number }
/** Exact totals from recorded orders only. net = gross - refunds - recorded fees (orders without fees are counted, not guessed). */
export function salesTotals(orders: readonly Order[]): SalesTotals {
  const byCampaign: Record<string, number> = {};
  for (const o of orders) if (o.campaignId) byCampaign[o.campaignId] = (byCampaign[o.campaignId] ?? 0) + 1;
  const gross = orders.reduce((a, o) => a + o.grossPence, 0), refunds = orders.reduce((a, o) => a + refunded(o), 0), fees = orders.reduce((a, o) => a + (o.feesPence ?? 0), 0);
  return { orders: orders.length, grossPence: gross, refundsPence: refunds, feesPence: fees, ordersWithoutFees: orders.filter((o) => o.feesPence === null).length, netPence: gross - refunds - fees,
    verified: orders.filter((o) => o.verification === "evidence-file").length, byCampaign, unattributed: orders.filter((o) => !o.campaignId).length };
}

export function salesReport(store: Store, productId?: string): string {
  const orders = store.orders().filter((o) => !productId || o.productId === productId);
  if (!orders.length) return `no orders recorded${productId ? ` for ${productId}` : ""}: sales and revenue are unknown, not zero\n`;
  const lines: string[] = [];
  for (const cur of [...new Set(orders.map((o) => o.currency))]) {
    const t = salesTotals(orders.filter((o) => o.currency === cur));
    lines.push(`${cur}: ${t.orders} order(s) (${t.verified} with an evidence file); gross ${pounds(t.grossPence)}, refunds ${pounds(t.refundsPence)}, fees ${pounds(t.feesPence)}${t.ordersWithoutFees ? ` (fees not recorded for ${t.ordersWithoutFees} order(s))` : ""}, net ${pounds(t.netPence)}`);
    lines.push(`  attribution: ${Object.entries(t.byCampaign).map(([c, n]) => `${c} ${n}`).join(", ") || "none"}; unattributed ${t.unattributed}`);
  }
  return `verified sales (owner-recorded orders only; no estimates)\n${lines.join("\n")}\n${orders.map((o) => `  ${o.id} ${o.date} ${o.productId} ${o.orderRef} gross ${pounds(o.grossPence)}${o.refunds.length ? ` refunded ${pounds(refunded(o))}` : ""}${o.feesPence !== null ? ` fees ${pounds(o.feesPence)}` : ""}${o.campaignId ? ` via ${o.campaignId}${o.postId ? `/${o.postId}` : ""}` : ""} [${o.verification}]`).join("\n")}\n`;
}

export const SALES_USAGE = "sales record <product> --order <ref> --date YYYY-MM-DD --gross X [--fees X] [--campaign <cmp> [--post <pst>]] --source <text> [--evidence <file>] | sales refund <order> --amount X --date YYYY-MM-DD --source <text> | sales report [product]";

const flags = (args: readonly string[], allowed: readonly string[]) => {
  const f: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) { if (!allowed.includes(args[i]) || args[i + 1] === undefined) throw new Error(`unknown or incomplete option ${args[i] ?? ""} (${SALES_USAGE})`); f[args[i]] = args[i + 1]; }
  return f;
};

export async function salesCli(args: readonly string[], ctx: { store: Store; out: (s: string) => void; now: () => Date }): Promise<number> {
  const [sub, a, ...rest] = args;
  const { store, out } = ctx;
  if (sub === "record") {
    const f = flags(rest, ["--order", "--date", "--gross", "--fees", "--campaign", "--post", "--source", "--evidence"]);
    for (const k of ["--order", "--date", "--gross", "--source"]) if (f[k] === undefined) throw new Error(`sales record: ${k} is required`);
    const o = await withLock(store.dir, async () => recordOrder(store, String(a), { orderRef: f["--order"], date: f["--date"], gross: f["--gross"], fees: f["--fees"], campaignId: f["--campaign"], postId: f["--post"], source: f["--source"], evidenceFile: f["--evidence"] }, ctx.now()));
    out(`recorded ${o.id}: order ${o.orderRef}, ${o.currency} ${pounds(o.grossPence)} gross${o.feesPence !== null ? `, fees ${pounds(o.feesPence)}` : ", fees not recorded"} (${o.verification})\n`);
    return 0;
  }
  if (sub === "refund") {
    const f = flags(rest, ["--amount", "--date", "--source"]);
    for (const k of ["--amount", "--date", "--source"]) if (f[k] === undefined) throw new Error(`sales refund: ${k} is required`);
    const o = await withLock(store.dir, async () => recordRefund(store, String(a), { amount: f["--amount"], date: f["--date"], source: f["--source"] }, ctx.now()));
    out(`refund recorded on ${o.id}: total refunded ${pounds(refunded(o))} of ${pounds(o.grossPence)}\n`);
    return 0;
  }
  if (sub === "report") { out(salesReport(store, a)); return 0; }
  out(`Usage: ${SALES_USAGE}\n`);
  return 2;
}
