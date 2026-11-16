/** Renders the daily digest + transactional emails (HTML + plain text). */
import type { Config } from "./config.js";
import type { Subscriber, TenderRow } from "./db.js";
import { REGIONS } from "./regions.js";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function formatGbp(amount: number | null, currency: string | null): string {
  if (!amount) return "Not stated";
  const cur = currency || "GBP";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${cur} ${Math.round(amount).toLocaleString("en-GB")}`;
  }
}

export function formatDeadline(iso: string | null, kind: string | null, now = new Date()): string {
  if (!iso) return "Not stated – check notice";
  const d = new Date(iso);
  const days = Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
  const when = d.toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const label = kind === "eoi" ? "Expression of interest by " : "";
  return `${label}${when} (${days <= 0 ? "today" : days === 1 ? "1 day left" : `${days} days left`})`;
}

export const ukDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const longDate = (d = new Date()) =>
  d.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric" });

export function regionSummary(regions: string[]): string {
  return regions.includes("ALL") ? "All UK regions" : regions.map((r) => REGIONS[r] ?? r).join(", ");
}

export interface Email { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }

export function links(cfg: Config, sub: Pick<Subscriber, "token">) {
  const t = encodeURIComponent(sub.token);
  return {
    preferences: `${cfg.baseUrl}/preferences?token=${t}`,
    unsubscribe: `${cfg.baseUrl}/unsubscribe?token=${t}`,
    billing: `${cfg.baseUrl}/billing?token=${t}`,
  };
}

function shell(cfg: Config, inner: string, footer: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(cfg.brandName)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#1a2433">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#0b3d5c;padding:18px 24px;color:#ffffff;font-size:20px;font-weight:bold">TenderScout <span style="color:#7fd1c7">UK</span></td></tr>
<tr><td style="padding:24px">${inner}</td></tr>
<tr><td style="padding:16px 24px;background:#f8fafc;color:#5b6675;font-size:12px;line-height:1.5">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

function footerHtml(cfg: Config, sub: Subscriber | null): string {
  const l = sub ? links(cfg, sub) : null;
  const company = [cfg.companyLegalName, cfg.companyNumber && `Company no. ${cfg.companyNumber}`, cfg.companyAddress].filter(Boolean).join(" · ");
  return `${l ? `You receive this because you subscribe to ${esc(cfg.brandName)} daily alerts.<br>
<a href="${esc(l.preferences)}" style="color:#0b3d5c">Change regions</a> · <a href="${esc(l.unsubscribe)}" style="color:#0b3d5c">Stop emails</a> · <a href="${esc(l.billing)}" style="color:#0b3d5c">Manage billing / cancel</a><br>` : ""}
Data: Find a Tender and Contracts Finder. Contains public sector information licensed under the Open Government Licence v3.0. Always check full details on the official notice before bidding.<br>
${esc(company)} · <a href="mailto:${esc(cfg.contactEmail)}" style="color:#0b3d5c">${esc(cfg.contactEmail)}</a>`;
}

function footerText(cfg: Config, sub: Subscriber | null): string {
  const l = sub ? links(cfg, sub) : null;
  return [
    "--",
    l ? `Change regions: ${l.preferences}\nStop emails: ${l.unsubscribe}\nManage billing / cancel: ${l.billing}` : "",
    "Data: Find a Tender and Contracts Finder. Contains public sector information licensed under the Open Government Licence v3.0.",
    `${cfg.companyLegalName} · ${cfg.contactEmail}`,
  ].filter(Boolean).join("\n");
}

function tenderCard(t: TenderRow, now: Date): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e8ef;border-radius:6px;margin:0 0 14px">
<tr><td style="padding:14px 16px">
<a href="${esc(t.url)}" style="font-size:16px;font-weight:bold;color:#0b3d5c;text-decoration:none">${esc(t.title)}</a>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0;font-size:13px;line-height:1.6;color:#334155">
<tr><td style="padding-right:10px;color:#64748b">Buyer</td><td>${esc(t.buyer)}</td></tr>
<tr><td style="padding-right:10px;color:#64748b">Location</td><td>${esc(t.location_label)}</td></tr>
<tr><td style="padding-right:10px;color:#64748b">Value</td><td>${esc(formatGbp(t.value_amount, t.value_currency))}</td></tr>
<tr><td style="padding-right:10px;color:#64748b">Deadline</td><td><strong>${esc(formatDeadline(t.deadline, t.deadline_kind, now))}</strong></td></tr>
</table>
${t.description ? `<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:#475569">${esc(t.description)}</p>` : ""}
<a href="${esc(t.url)}" style="display:inline-block;background:#0b7a6f;color:#ffffff;padding:8px 14px;border-radius:4px;font-size:13px;text-decoration:none">View official notice (${t.source === "fts" ? "Find a Tender" : "Contracts Finder"}) →</a>
</td></tr></table>`;
}

function tenderText(t: TenderRow, now: Date): string {
  return [
    `* ${t.title}`,
    `  Buyer: ${t.buyer}`,
    `  Location: ${t.location_label}`,
    `  Value: ${formatGbp(t.value_amount, t.value_currency)}`,
    `  Deadline: ${formatDeadline(t.deadline, t.deadline_kind, now)}`,
    t.description ? `  ${t.description}` : "",
    `  Official notice: ${t.url}`,
  ].filter(Boolean).join("\n");
}

/** Daily digest. `items` = new matches; `stillOpen` = previously-sent matches still open (for the no-results email). */
export function renderDigest(cfg: Config, sub: Subscriber, items: TenderRow[], stillOpen: TenderRow[], now = new Date()): Email {
  const l = links(cfg, sub);
  const regions = regionSummary(sub.regions);
  let inner: string, text: string, subject: string;
  if (items.length) {
    subject = `${items.length} new cleaning contract${items.length === 1 ? "" : "s"} – ${longDate(now)}`;
    inner = `<p style="margin:0 0 4px;font-size:13px;color:#64748b">${esc(longDate(now))}</p>
<h1 style="margin:0 0 6px;font-size:22px">${items.length} new cleaning opportunit${items.length === 1 ? "y" : "ies"}</h1>
<p style="margin:0 0 18px;font-size:14px;color:#475569">Matching your regions: ${esc(regions)}. Sorted by closing date.</p>
${items.map((t) => tenderCard(t, now)).join("\n")}`;
    text = `${cfg.brandName} – ${longDate(now)}\n${items.length} new cleaning opportunities (regions: ${regions})\n\n${items.map((t) => tenderText(t, now)).join("\n\n")}`;
  } else {
    subject = `No new cleaning contracts today – ${longDate(now)}`;
    const soon = stillOpen.slice(0, 3);
    inner = `<p style="margin:0 0 4px;font-size:13px;color:#64748b">${esc(longDate(now))}</p>
<h1 style="margin:0 0 6px;font-size:22px">No new matches today</h1>
<p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#475569">We checked Find a Tender and Contracts Finder and found no new cleaning contracts in ${esc(regions)} since your last alert. Public bodies publish unevenly, so quiet days are normal.</p>
${stillOpen.length ? `<p style="margin:0 0 12px;font-size:14px"><strong>${stillOpen.length}</strong> opportunit${stillOpen.length === 1 ? "y" : "ies"} we sent you earlier ${stillOpen.length === 1 ? "is" : "are"} still open. Closing soonest:</p>${soon.map((t) => tenderCard(t, now)).join("\n")}` : ""}
<p style="margin:14px 0 0;font-size:14px;line-height:1.5;color:#475569">Tip: widening your regions can surface more work. <a href="${esc(l.preferences)}" style="color:#0b3d5c">Update your regions</a>.</p>`;
    text = `${cfg.brandName} – ${longDate(now)}\nNo new cleaning contracts in ${regions} since your last alert.\n` +
      (soon.length ? `\nStill open, closing soonest:\n\n${soon.map((t) => tenderText(t, now)).join("\n\n")}\n` : "") +
      `\nWiden your regions: ${l.preferences}`;
  }
  return {
    to: sub.email,
    subject,
    html: shell(cfg, inner, footerHtml(cfg, sub)),
    text: `${text}\n\n${footerText(cfg, sub)}`,
    headers: {
      "List-Unsubscribe": `<${l.unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export function renderWelcome(cfg: Config, sub: Subscriber): Email {
  const l = links(cfg, sub);
  const inner = `<h1 style="margin:0 0 10px;font-size:22px">Welcome to ${esc(cfg.brandName)}</h1>
<p style="font-size:14px;line-height:1.6">Your subscription is active. From tomorrow, you'll get one email every morning at <strong>7:00am</strong> listing new UK government cleaning contracts in: <strong>${esc(regionSummary(sub.regions))}</strong>.</p>
<p style="font-size:14px;line-height:1.6">Your first alert includes all matching opportunities that are still open, so you can start bidding straight away.</p>
<ul style="font-size:14px;line-height:1.8">
<li><a href="${esc(l.preferences)}" style="color:#0b3d5c">Change your regions</a></li>
<li><a href="${esc(l.billing)}" style="color:#0b3d5c">Update card, view invoices or cancel</a> (secure Stripe portal)</li>
</ul>
<p style="font-size:14px;line-height:1.6">Questions? Just reply or email <a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a>.</p>`;
  const text = `Welcome to ${cfg.brandName}\n\nYour subscription is active. Every morning at 7:00am you'll get new UK government cleaning contracts in: ${regionSummary(sub.regions)}.\n\nChange regions: ${l.preferences}\nBilling / cancel: ${l.billing}\n\nQuestions: ${cfg.contactEmail}`;
  return { to: sub.email, subject: `Welcome to ${cfg.brandName} – your alerts are set up`, html: shell(cfg, inner, footerHtml(cfg, sub)), text: `${text}\n\n${footerText(cfg, sub)}` };
}

export function renderManageLink(cfg: Config, sub: Subscriber): Email {
  const l = links(cfg, sub);
  const inner = `<h1 style="margin:0 0 10px;font-size:20px">Manage your ${esc(cfg.brandName)} subscription</h1>
<p style="font-size:14px;line-height:1.6">Someone (hopefully you) asked to sign up with this email address, which already has an active subscription. Use these links to manage it:</p>
<ul style="font-size:14px;line-height:1.8"><li><a href="${esc(l.preferences)}">Change regions / email settings</a></li><li><a href="${esc(l.billing)}">Billing and cancellation</a></li></ul>
<p style="font-size:13px;color:#64748b">If this wasn't you, you can ignore this email.</p>`;
  return { to: sub.email, subject: `Manage your ${cfg.brandName} subscription`, html: shell(cfg, inner, footerHtml(cfg, null)),
    text: `Manage your ${cfg.brandName} subscription\nRegions/email settings: ${l.preferences}\nBilling: ${l.billing}\n\n${footerText(cfg, null)}` };
}

/** Static example used on the website (clearly labelled as an example). */
export function exampleSubscriber(): Subscriber {
  return { id: "example", email: "you@yourcompany.co.uk", company: "Example Cleaning Ltd", regions: ["ALL"], status: "active",
    emails_enabled: 1, token: "example", stripe_customer_id: null, stripe_subscription_id: null, welcomed: 1 };
}
