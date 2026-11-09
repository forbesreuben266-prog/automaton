/**
 * Products: turns a venture into a complete, usable digital product and prepares it for real customer validation.
 *
 *   build      a new product version from a blueprint (deterministic: no model, no network): the product files, a
 *              landing page (offer, proposed price, measurable conversion actions), a tracking plan and a QA report.
 *   check      re-runs the QA on the stored files (also detects files changed or missing since the build).
 *   improve    builds the next version from the venture's current outline; earlier versions are kept unchanged.
 *   archive    marks a version archived (files kept; nothing is deleted).
 *   request-launch / mark-live   the launch gate: an owner approval request, then the owner's own record that they
 *              published it at a URL. The engine never publishes anything.
 *   record     real results for one period, read by the owner from their providers, with an optional evidence file
 *              (its hash is stored; the file is not copied). Only for live products, only for dates after going live.
 *   report     real evidence and simulated estimates, strictly separated; decisions from real evidence only.
 *
 * Storage: products.json in the private data folder (atomic writes), files in ventures/<venture>/<product>/ through
 * the store's confined writer (exclusive create: files are never overwritten). Building never rewrites venture
 * records; only the launch gate and recorded results touch them, through the existing approval and evidence paths.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Blueprint, type BlueprintInput, CURRENCIES, type Currency, DISCLAIMER, esc, money, type ProductFile, type Section } from "./blueprints/common.js";
import { freelanceInvoicing } from "./blueprints/freelance-invoicing.js";
import { generic } from "./blueprints/generic.js";
import { withLock } from "./control.js";
import { recordActual } from "./engine.js";
import { concreteBullets, PLACEHOLDERS } from "./evaluate.js";
import { newId, sha256, Store } from "./store.js";
import type { ApprovalRequest, Asset, Check, Venture } from "./types.js";

export const BLUEPRINTS: readonly Blueprint[] = [freelanceInvoicing, generic];

export type ProductStatus = "ready" | "needs-work" | "archived" | "live";
export interface ValidationRecord {
  readonly id: string; readonly recordedAt: string; readonly periodStart: string; readonly periodEnd: string;
  readonly visits: number; readonly signups: number; readonly sales: number; readonly revenue: number;
  /** Where the owner read the numbers (provider and report name). */
  readonly source: string;
  /** "evidence-file": an export from the provider was hashed; "owner-reported": the owner's statement only. */
  readonly verification: "evidence-file" | "owner-reported";
  readonly evidence: { readonly name: string; readonly bytes: number; readonly sha256: string } | null;
}
export interface Product {
  readonly id: string; readonly ventureId: string; readonly version: number; readonly previous: string | null;
  readonly blueprint: string; readonly name: string; readonly status: ProductStatus;
  readonly price: number; readonly currency: Currency;
  readonly files: readonly Asset[];
  /** Files the buyer gets (the rest are the landing page, tracking plan and QA report). */
  readonly deliverables: readonly string[];
  /** Deliverables meant to be filled in by the buyer ([[fields]] allowed). */
  readonly templates: readonly string[];
  readonly checks: readonly Check[];
  /** Passages on legal, tax or financial topics, listed for the owner to read before any launch. */
  readonly review: readonly string[];
  readonly createdAt: string; readonly updatedAt: string;
  readonly archivedReason: string | null;
  readonly live: { readonly url: string; readonly at: string; readonly approvalId: string } | null;
  readonly validation: readonly ValidationRecord[];
  /** The owner's sign-off on the legal, tax and financial passages and the proposed price (needed before a launch request). */
  readonly signOff?: { readonly at: string; readonly reviewHash: string; readonly code: string; readonly items: number; readonly note: string } | null;
  /** Files whose content the owner adopted (product adopt). Later repairs keep them instead of regenerating them. */
  readonly customised?: readonly string[];
}

// ---------------------------------------------------------------- inputs

/** Sections of a product-outline.md, without placeholder points (an unfinished outline gives a thin product). */
export function parseOutline(md: string): Section[] {
  const out: { heading: string; bullets: string[] }[] = [];
  for (const line of md.split("\n")) {
    const h = /^##\s+(?:\d+\.\s*)?(.+?)\s*$/.exec(line);
    if (h) { out.push({ heading: h[1], bullets: [] }); continue; }
    const b = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (b && out.length && !PLACEHOLDERS.has(b[1].toLowerCase())) out.at(-1)!.bullets.push(b[1]);
  }
  return out.filter((s) => s.bullets.length > 0);
}

function latestOutline(store: Store, v: Venture): Section[] {
  const exp = v.experiments.at(-1);
  if (!exp) return [];
  return parseOutline(store.reader(store.assetDir(v.id, exp.id))("product-outline.md") ?? "");
}

// ---------------------------------------------------------------- landing page and tracking plan

export function landingPage(name: string, i: BlueprintInput, b: Blueprint, files: readonly ProductFile[]): string {
  const p = b.pitch(i);
  const price = money(i);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.headline)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111}
.prelaunch{background:#fff4c2;padding:.5rem .8rem;border-radius:.3rem}.cta{display:inline-block;font-size:1rem;padding:.6rem 1rem;margin:.3rem 0}
.price{font-size:1.2rem}li{margin:.25rem 0}</style>
</head><body>
<p class="prelaunch" id="top"><strong>Pre-launch preview.</strong> Not yet on sale. This page collects no data until the owner connects a sign-up form and a payment link.</p>
<h1>${esc(p.headline)}</h1>
<p class="offer">${esc(p.subheadline)}</p>
<ul class="benefits">${p.benefits.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<h2 id="inside">What is inside</h2>
<ul class="includes">${files.map((f) => `<li data-file="${esc(f.name)}"><strong>${esc(f.name)}</strong>: ${esc(f.description)}</li>`).join("")}</ul>
<h2 id="price-section">Price</h2>
<p class="price">Proposed price: <strong>${esc(price)}</strong>, one-off payment, instant download. This is an untested price hypothesis; nothing is on sale yet.</p>
<p><a class="cta" data-conversion="preorder" href="#preorder">Pre-order for ${esc(price)}</a></p>
<section id="signup"><h2>Get it first</h2>
<form class="cta-form" data-conversion="signup" method="post" action="#signup"><label>Email <input type="email" name="email" required></label> <button type="submit">Join the waiting list</button></form>
<p><small>Join the list to hear when it is available. Your email will be used only for that, and you can unsubscribe at any time.</small></p></section>
<section id="preorder"><h2>Pre-orders</h2><p>Pre-orders are not open yet. Join the waiting list above to be told first.</p></section>
<h2 id="faq">Questions</h2>
<dl class="faq">${p.faq.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join("")}</dl>
<p class="disclosure"><small>No customer reviews, numbers or results are shown because none exist yet. ${esc(DISCLAIMER)}</small></p>
<p><a href="#top">Back to top</a></p>
</body></html>
`;
}

export const DECISION_RULES = Object.freeze({ minimumVisits: 100, continueSignupRate: 0.05, improveBelowSignupRate: 0.02, stopAfterVisitsWithoutSignups: 300 });

export function trackingPlan(productId: string, version: number, price: string): string {
  return JSON.stringify({
    product: productId, version, status: "plan only: no data has been collected",
    conversionActions: [
      { id: "visit", element: "page load", measuredBy: "the hosting provider's privacy-respecting visit count (owner-provided)", recordWith: "--visits" },
      { id: "signup", element: "form[data-conversion=signup]", measuredBy: "the form provider's submission count or export (owner-provided)", recordWith: "--signups" },
      { id: "preorder", element: "a[data-conversion=preorder]", measuredBy: "the payment link's checkout count (owner-provided)", recordWith: "informational" },
      { id: "sale", element: "payment provider checkout", measuredBy: "the payment provider's dashboard or export", recordWith: "--sales and --revenue" },
    ],
    proposedPrice: `${price} (hypothesis, untested)`,
    decisionRules: {
      note: "Set in advance, before any data. Applied only to real, owner-recorded evidence.",
      minimumVisitsBeforeDeciding: DECISION_RULES.minimumVisits,
      continue: `signup rate >= ${DECISION_RULES.continueSignupRate * 100}% or at least 1 sale`,
      improve: `signup rate < ${DECISION_RULES.improveBelowSignupRate * 100}% after ${DECISION_RULES.minimumVisits} visits`,
      stop: `no signups after ${DECISION_RULES.stopAfterVisitsWithoutSignups} visits`,
    },
    evidenceRules: [
      "Record only numbers read from a provider (hosting, form, payment) for a stated period after going live.",
      "Attach the provider's export with --evidence to mark a record as verified by evidence file.",
      "Never record estimates, test visits from yourself, or numbers from before the product went live.",
    ],
  }, null, 2) + "\n";
}

// ---------------------------------------------------------------- QA

const NO_SCRIPTS = /<script|javascript:|\son[a-z]+\s*=|src=["']?https?:|href=["']?https?:|action=["']?https?:|@import|<iframe|<object|<embed/i;
/** APIs a buyer-side calculator never needs: network, storage, navigation, dynamic code, HTML injection, other windows. */
const FORBIDDEN_JS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|Worker|SharedWorker|ServiceWorker|serviceWorker|eval|Function|setTimeout|setInterval|innerHTML|outerHTML|insertAdjacentHTML|write|writeln|location|open|postMessage|localStorage|sessionStorage|indexedDB|cookie|caches|Image|navigator|import)\b|https?:|\/\/[a-z0-9.-]+\.[a-z]{2,}/;

/**
 * HTML safety. The landing page and every non-template page: no scripts and no external resources at all. A template
 * page (a buyer's tool, such as the invoice) may carry ONE inline script, only if it uses none of FORBIDDEN_JS and the
 * page's Content-Security-Policy blocks all network access (default-src 'none') and allows only that script by hash.
 */
export function htmlSafety(name: string, html: string, template: boolean): string[] {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!template || name === "landing.html" || scripts.length === 0) return NO_SCRIPTS.test(html) ? [`${name}: scripts or external resources`] : [];
  const out: string[] = [];
  if (scripts.length > 1 || (html.match(/<script/gi) ?? []).length !== scripts.length) out.push(`${name}: at most one inline script, without attributes`);
  const js = scripts[0][1];
  const bad = FORBIDDEN_JS.exec(js);
  if (bad) out.push(`${name}: the script uses "${bad[0]}" (not allowed in a buyer's file)`);
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? "";
  const hash = `'sha256-${createHash("sha256").update(js, "utf8").digest("base64")}'`;
  if (!/(^|;)\s*default-src 'none'\s*(;|$)/.test(csp) || !csp.includes(`script-src ${hash}`) || /unsafe-eval|unsafe-inline'[^;]*script|script-src[^;]*(https?:|\*|'unsafe)/.test(csp)) out.push(`${name}: the Content-Security-Policy must block all network access and allow only this script by hash`);
  if (NO_SCRIPTS.test(html.replace(scripts[0][0], ""))) out.push(`${name}: scripts or external resources outside the one allowed script`);
  return out;
}
const INCOMPLETE = [/\b(TODO|TBD|FIXME|XXX)\b/, /lorem ipsum/i, /^\s*- (Key points to write|Example)\s*$/im, /\binsert (text|content) here\b/i];
const MISLEADING: readonly [RegExp, string][] = [
  [/\b(we|it|this kit|this product)\s+(guarantee|guarantees)\b|\bguaranteed (results?|payment|income|to)\b/i, "guaranteed outcome"],
  [/\b(risk[- ]free|100% (success|guaranteed|effective))\b/i, "risk-free or 100% claim"],
  [/\b(thousands|hundreds|millions) of (happy )?(customers|users|freelancers|buyers|clients)\b|\bused by \d/i, "invented customer numbers"],
  [/\b(best[- ]selling|bestseller|number one|award[- ]winning)\b|(^|\s)#1\b/im, "unverifiable ranking claim"],
  [/\bas seen (on|in)\b/i, "unverifiable press claim"],
  [/\bonly \d+ (left|remaining|copies)\b|\boffer ends (today|tonight)\b/i, "false scarcity"],
  [/\b(earn|make) (up to )?[$£€]?\d[\d,]*\b|\bdouble your (income|revenue|sales)\b/i, "income claim"],
  [/["“][^"”\n]{12,}["”]\s*[—–-]\s*[A-Z][a-z]+/, "testimonial (none exist yet)"],
  [/\b\d+(\.\d+)?% (faster|more|of (customers|freelancers|users))\b/i, "unsupported statistic"],
];
/** The misleading-claim patterns found in a text (the same rules as the product QA). */
export const misleadingClaims = (text: string): string[] => MISLEADING.filter(([r]) => r.test(text)).map(([, why]) => why);
const SENSITIVE = /\b(legal(ly)?|law(s|yer)?|solicitor|attorney|court|sue|lawsuit|statutory|legislation|contract|tax(es)?|VAT|GST|HMRC|IRS|interest|debt|invest(ment|ing)?|pension|insurance|medical|diagnos)/i;
const DIRECTIVE = /\b(you are (legally )?entitled to|you must (legally )?(charge|pay|claim)|you can always (sue|charge)|this is legally binding|will (definitely )?(win|be enforced))\b/i;
const DISCLAIMED = /not legal, tax or financial advice/i;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const visible = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");

/** Runs every product check on the stored files. `expected` are the recorded hashes (null at build time). */
export function qa(read: (name: string) => string | null, manifest: readonly { name: string; template: boolean }[], expected: readonly Asset[] | null): { checks: Check[]; review: string[] } {
  const c = (name: string, passed: boolean, detail: string): Check => ({ name, passed, detail: detail.slice(0, 400) });
  const names = manifest.map((m) => m.name);
  const text = new Map<string, string>();
  for (const n of names) { const t = read(n); if (t !== null) text.set(n, t); }
  const problems = (fn: (n: string, t: string) => string[]) => [...text].flatMap(([n, t]) => fn(n, t));
  const checks: Check[] = [];

  const missing = names.filter((n) => !text.get(n)?.trim());
  checks.push(c("files-present", missing.length === 0, missing.length ? `missing or empty: ${missing.join(", ")}` : `${names.length} files present`));
  if (expected) {
    const changed = expected.filter((a) => { const t = read(a.name); return t === null || sha256(t) !== a.sha256; }).map((a) => a.name);
    checks.push(c("files-unchanged", changed.length === 0, changed.length ? `missing or changed since the build: ${changed.join(", ")}` : `all ${expected.length} files match their recorded hashes`));
  }

  const broken = problems((n, t) => {
    const out: string[] = [];
    if (n.endsWith(".html")) {
      const ids = new Set([...t.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
      for (const m of t.matchAll(/\b(href|src|action)\s*=\s*"([^"]*)"/gi)) {
        const u = m[2];
        if (u.startsWith("#")) { if (u.length > 1 && !ids.has(u.slice(1))) out.push(`${n}: ${m[1]}="${u}" (no such anchor)`); }
        else if (/^[a-z][a-z0-9+.-]*:/i.test(u)) out.push(`${n}: ${m[1]}="${u.slice(0, 60)}" (external links are not allowed before an approved launch)`);
        else if (!names.includes(u)) out.push(`${n}: ${m[1]}="${u.slice(0, 60)}" (file not in the package)`);
      }
    }
    if (n.endsWith(".md")) for (const m of t.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const u = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(u)) out.push(`${n}: (${u.slice(0, 60)}) (external link)`);
      else if (!u.startsWith("#") && !names.includes(u)) out.push(`${n}: (${u.slice(0, 60)}) (file not in the package)`);
    }
    return out;
  });
  checks.push(c("links", broken.length === 0, broken.length ? broken.join("; ") : "every link points to an anchor or a file in the package"));

  const unsafe = problems((n, t) => (n.endsWith(".html") ? htmlSafety(n, t, !!manifest.find((m) => m.name === n)?.template) : []));
  const calculators = [...text].filter(([n, t]) => n.endsWith(".html") && n !== "landing.html" && /<script>/.test(t)).map(([n]) => n);
  checks.push(c("no-scripts-or-external-resources", unsafe.length === 0, unsafe.length ? unsafe.join("; ") : `no external resources; landing page has no scripts${calculators.length ? `; ${calculators.join(", ")}: one inline calculator, no network or storage APIs, CSP-locked by hash` : ""}`));

  const incomplete = problems((n, t) => {
    const out: string[] = [];
    for (const r of INCOMPLETE) if (r.test(t)) out.push(`${n}: unfinished text (${r.source.slice(0, 30)})`);
    if (/\[\[[^\]]*\]\]/.test(t) && !manifest.find((m) => m.name === n)?.template) out.push(`${n}: fill-in field in a file that is not a template`);
    if (n.endsWith(".md")) {
      const lines = t.split("\n");
      lines.forEach((l, i) => { if (/^#{1,6} /.test(l)) { const next = lines.slice(i + 1).find((x) => x.trim() !== ""); if (next === undefined || /^#{1,6} /.test(next) && next.match(/^#+/)![0].length <= l.match(/^#+/)![0].length) out.push(`${n}: empty section "${l.slice(0, 60)}"`); } });
    }
    if (n.endsWith(".csv")) {
      const rows = parseCsv(t).filter((r) => r.some((x) => x !== ""));
      if (rows.length < 2) out.push(`${n}: needs a header and at least one row`);
      else {
        const w = rows[0].length;
        if (rows[0].some((h) => !h.trim()) || new Set(rows[0]).size !== w) out.push(`${n}: empty or duplicate column names`);
        rows.forEach((r, i) => { if (r.length !== w) out.push(`${n}: row ${i + 1} has ${r.length} cells, expected ${w}`); });
      }
    }
    return out;
  });
  const substance = concreteBullets([...text].filter(([n]) => n.endsWith(".md")).map(([, t]) => t).join("\n"));
  if (substance < 15) incomplete.push(`only ${substance} concrete points across the documents (at least 15 needed)`);
  checks.push(c("complete-content", incomplete.length === 0, incomplete.length ? incomplete.join("; ") : `no unfinished text; ${substance} concrete points`));

  const formulas = problems((n, t) => (n.endsWith(".csv") ? parseCsv(t).flat().filter((x) => /^[=+@\t\r]/.test(x) || (/^-/.test(x) && !/^-\d+(\.\d+)?$/.test(x))).slice(0, 3).map((x) => `${n}: "${x.slice(0, 30)}"`) : []));
  checks.push(c("csv-formula-safety", formulas.length === 0, formulas.length ? `cells a spreadsheet would run as formulas: ${formulas.join("; ")}` : "no cell starts with = + - @"));

  const claims = problems((n, t) => { if (!/\.(md|html)$/.test(n)) return []; const v = n.endsWith(".html") ? visible(t) : t; return MISLEADING.filter(([r]) => r.test(v)).map(([, why]) => `${n}: ${why}`); });
  checks.push(c("no-misleading-claims", claims.length === 0, claims.length ? claims.join("; ") : "no guarantees, invented numbers, rankings, testimonials, scarcity or income claims"));

  const review: string[] = [];
  const advice = problems((n, t) => {
    if (!n.endsWith(".md") && n !== "landing.html") return [];
    const v = n.endsWith(".html") ? visible(t) : t;
    const out: string[] = [];
    v.split("\n").forEach((l, i) => { if (SENSITIVE.test(l) && !DISCLAIMED.test(l)) review.push(`${n}:${i + 1}: ${l.trim().slice(0, 140)}`); if (DIRECTIVE.test(l)) out.push(`${n}:${i + 1}: states a legal or financial position as fact`); });
    if (SENSITIVE.test(v) && !DISCLAIMED.test(v)) out.push(`${n}: touches legal, tax or financial topics without the disclaimer`);
    return out;
  });
  checks.push(c("sensitive-advice", advice.length === 0, advice.length ? advice.join("; ") : `disclaimed where needed; ${review.length} passage(s) listed for owner review`));

  const page = text.get("landing.html") ?? "";
  const included = [...page.matchAll(/data-file="([^"]+)"/g)].map((m) => m[1]);
  const landingMissing = [
    [/<h1>[^<]+<\/h1>/, "headline"], [/class="offer"/, "offer"], [/class="price">[^<]*Proposed price: <strong>[$£€]\d/, "proposed price"],
    [/untested price hypothesis/, "price labelled as a hypothesis"], [/data-conversion="signup"/, "signup action"], [/data-conversion="preorder"/, "pre-order action"],
    [/class="prelaunch"/, "pre-launch notice"], [/class="disclosure"/, "disclosure"],
  ].filter(([r]) => !(r as RegExp).test(page)).map(([, w]) => w as string);
  const notListed = manifest.filter((m) => !["landing.html", "tracking-plan.json", "qa-report.md"].includes(m.name) && !included.includes(m.name)).map((m) => m.name);
  const listedMissing = included.filter((n) => !names.includes(n));
  checks.push(c("landing-page", !landingMissing.length && !notListed.length && !listedMissing.length,
    [landingMissing.length ? `missing: ${landingMissing.join(", ")}` : "", notListed.length ? `files not listed: ${notListed.join(", ")}` : "", listedMissing.length ? `lists files that do not exist: ${listedMissing.join(", ")}` : ""].filter(Boolean).join("; ") || "offer, proposed price, signup and pre-order actions, notices; lists every file"));

  let plan: { status?: unknown; conversionActions?: { id?: unknown }[] } | null = null; try { plan = JSON.parse(text.get("tracking-plan.json") ?? "x"); } catch { plan = null; }
  const ids = new Set((plan?.conversionActions ?? []).map((a) => a.id));
  checks.push(c("tracking-plan", !!plan && ["visit", "signup", "sale"].every((x) => ids.has(x)) && /no data/.test(String(plan.status)), plan ? `conversion actions: ${[...ids].join(", ")}` : "tracking-plan.json missing or not JSON"));

  const readme = text.get("start-here.md") ?? "";
  const undocumented = manifest.filter((m) => !["start-here.md", "landing.html", "tracking-plan.json", "qa-report.md"].includes(m.name) && !readme.includes(m.name)).map((m) => m.name);
  checks.push(c("instructions", !!readme && undocumented.length === 0, undocumented.length ? `start-here.md does not explain: ${undocumented.join(", ")}` : "start-here.md explains every file"));

  return { checks, review };
}

function qaReport(p: { id: string; version: number; name: string }, checks: readonly Check[], review: readonly string[]): string {
  return `# QA report: ${p.name} (${p.id}, version ${p.version})

Automatic checks only: they cannot judge whether the advice is right for a particular buyer. Read the review list
below before any launch.

| Check | Result | Detail |
|---|---|---|
${checks.map((x) => `| ${x.name} | ${x.passed ? "pass" : "FAIL"} | ${x.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`).join("\n")}

## Passages on legal, tax or financial topics (owner review)

${review.length ? review.map((r) => `- ${r.replace(/\|/g, "/")}`).join("\n") : "None found."}
`;
}

// ---------------------------------------------------------------- operations

const cents = (x: number) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
const parseMoney = (s: string | undefined, what: string) => { const x = Number(s); if (s === undefined || !/^\d+(\.\d{1,2})?$/.test(s) || x <= 0 || x > 1000) throw new Error(`${what}: an amount from 0.01 to 1000, at most 2 decimals`); return x; };

/** A product version generated in memory (nothing written yet). */
export interface GeneratedVersion {
  readonly id: string; readonly ventureId: string; readonly version: number; readonly blueprint: string; readonly name: string;
  readonly price: number; readonly currency: Currency;
  /** Deliverables, landing.html and tracking-plan.json, in write order. */
  readonly files: { name: string; text: string; template: boolean }[];
  readonly deliverables: readonly string[];
}

export function generateVersion(store: Store, ventureId: string, opts: { price?: number; currency?: Currency; previous?: Product | null }): GeneratedVersion {
  const v = store.ventures().find((x) => x.id === ventureId);
  if (!v) throw new Error(`no venture ${ventureId}`);
  if (v.status === "shut-down") throw new Error(`${ventureId} is shut down`);
  const b = BLUEPRINTS.find((x) => x.matches(v.opportunity))!;
  const currency = opts.currency ?? opts.previous?.currency ?? "USD";
  if (!CURRENCIES.includes(currency)) throw new Error(`currency: one of ${CURRENCIES.join(", ")}`);
  const price = opts.price ?? opts.previous?.price ?? b.defaultPrice;
  const input: BlueprintInput = { opportunity: v.opportunity, outline: latestOutline(store, v), price, currency };
  const id = newId("prd");
  const version = store.products().filter((p) => p.ventureId === ventureId).length + 1;
  const name = b.productName(input);
  const deliverables = b.files(input);
  return { id, ventureId, version, blueprint: b.id, name, price, currency, deliverables: deliverables.map((f) => f.name),
    files: [...deliverables.map((f) => ({ name: f.name, text: f.text, template: f.template })),
      { name: "landing.html", text: landingPage(name, input, b, deliverables), template: false },
      { name: "tracking-plan.json", text: trackingPlan(id, version, money(input)), template: false }] };
}

/** QA of a generated version, in memory. */
export const qaGenerated = (g: GeneratedVersion) => qa((n) => g.files.find((f) => f.name === n)?.text ?? null, g.files.map((f) => ({ name: f.name, template: f.template })), null);

/** Writes a generated version as a new product (exclusive create: never overwrites) and records it. */
export function writeVersion(store: Store, g: GeneratedVersion, opts: { now: Date; previous?: Product | null; customised?: readonly string[] }): Product {
  const { checks, review } = qaGenerated(g);
  const written: Asset[] = [];
  const write = store.writer(store.assetDir(g.ventureId, g.id), written);
  for (const f of g.files) write(f.name, f.text);
  write("qa-report.md", qaReport({ id: g.id, version: g.version, name: g.name }, checks, review));
  const at = opts.now.toISOString();
  const p: Product = { id: g.id, ventureId: g.ventureId, version: g.version, previous: opts.previous?.id ?? null, blueprint: g.blueprint, name: g.name, status: checks.every((x) => x.passed) ? "ready" : "needs-work",
    price: g.price, currency: g.currency, files: written, deliverables: g.deliverables, templates: g.files.filter((f) => f.template).map((f) => f.name), checks, review, createdAt: at, updatedAt: at, archivedReason: null, live: null, validation: [], signOff: null, customised: [...(opts.customised ?? [])] };
  store.saveProducts([...store.products(), p]);
  store.audit({ kind: "product-built", product: p.id, venture: p.ventureId, version: p.version, blueprint: p.blueprint, status: p.status, previous: p.previous, failed: checks.filter((x) => !x.passed).map((x) => x.name) }, opts.now);
  return p;
}

export function buildProduct(store: Store, ventureId: string, opts: { now: Date; price?: number; currency?: Currency; previous?: Product | null }): Product {
  return writeVersion(store, generateVersion(store, ventureId, opts), opts);
}

/** What the owner approves: the proposed price and every legal, tax or financial passage, numbered. */
export const signOffItems = (p: Pick<Product, "review" | "price" | "currency">): string[] => [`Proposed price: ${p.currency} ${p.price} (an untested hypothesis)`, ...p.review];

/** Binds an approval to the exact items AND the exact file contents (recorded hashes) of this version. */
export const reviewHash = (p: Pick<Product, "id" | "review" | "price" | "currency" | "files">) =>
  sha256(JSON.stringify({ id: p.id, items: signOffItems(p), files: p.files.map((f) => [f.name, f.sha256]) }));
/** The confirmation code shown with the items; any change to the items or files gives a different code. */
export const confirmationCode = (p: Parameters<typeof reviewHash>[0]) => reviewHash(p).slice(0, 8);

/** Names of stored files that are missing or no longer match their recorded hash. */
export function changedFiles(store: Store, p: Product): string[] {
  const read = store.reader(store.assetDir(p.ventureId, p.id));
  return p.files.filter((f) => { const t = read(f.name); return t === null || sha256(t) !== f.sha256; }).map((f) => f.name);
}

/**
 * The owner approves the numbered items. Requires an interactive terminal (timers, scripts and the engine have none),
 * the confirmation code of the CURRENT items and files, and the proposed price typed back exactly.
 */
export function signOff(store: Store, id: string, a: { confirm: string; price: string; note: string; interactive: boolean }, now: Date): Product {
  const p = getProduct(store, id);
  if (!a.interactive) throw new Error("sign-off needs an interactive terminal: automated jobs, scripts and timers cannot sign off");
  if (p.status !== "ready") throw new Error(`${id} is ${p.status}: only a product that passed every check can be signed off`);
  const changed = changedFiles(store, p);
  if (changed.length) throw new Error(`files changed since the build (${changed.join(", ")}): review the product first; nothing was signed off`);
  const code = confirmationCode(p);
  if (a.confirm.trim().toLowerCase() !== code) throw new Error(`confirmation code does not match the current items (stale or mistyped): run 'product sign-off ${id}' to see the current items and code`);
  const m = /^([A-Za-z]{3})\s*[£$€]?\s*(\d+(?:\.\d{1,2})?)$/.exec(a.price.trim());
  if (!m || m[1].toUpperCase() !== p.currency || Number(m[2]) !== p.price) throw new Error(`price not confirmed: type the proposed price exactly, for example --price "${p.currency} ${p.price}"`);
  if (a.note.trim().length < 3) throw new Error("sign-off needs a short note (for example: read qa-report.md; price OK)");
  const items = signOffItems(p).length;
  const next: Product = { ...p, signOff: { at: now.toISOString(), reviewHash: reviewHash(p), code, items, note: a.note.trim().slice(0, 200) }, updatedAt: now.toISOString() };
  saveProduct(store, next);
  store.audit({ kind: "product-signed-off", product: id, code, items, price: `${p.currency} ${p.price}`, note: next.signOff!.note, interactive: true }, now);
  return next;
}

function getProduct(store: Store, id: string): Product {
  const p = store.products().find((x) => x.id === id);
  if (!p) throw new Error(`no product ${id}`);
  return p;
}
function saveProduct(store: Store, p: Product): void { store.saveProducts(store.products().map((x) => (x.id === p.id ? p : x))); }

export function checkProduct(store: Store, id: string, now: Date): Product {
  const p = getProduct(store, id);
  const manifest = p.files.filter((f) => f.name !== "qa-report.md").map((f) => ({ name: f.name, template: p.templates.includes(f.name) }));
  const { checks } = qa(store.reader(store.assetDir(p.ventureId, p.id)), manifest, p.files);
  const ok = checks.every((x) => x.passed);
  const next: Product = { ...p, checks, updatedAt: now.toISOString(), status: p.status === "archived" || p.status === "live" ? p.status : ok ? "ready" : "needs-work" };
  saveProduct(store, next);
  store.audit({ kind: "product-checked", product: id, failed: checks.filter((x) => !x.passed).map((x) => x.name) }, now);
  return next;
}

export function archiveProduct(store: Store, id: string, reason: string, now: Date): Product {
  const p = getProduct(store, id);
  if (p.status === "live") throw new Error(`${id} is live: take it down yourself first, then archive it`);
  if (p.status === "archived") throw new Error(`${id} is already archived`);
  if (reason.trim().length < 3) throw new Error("archive needs a reason");
  const next: Product = { ...p, status: "archived", archivedReason: reason.trim().slice(0, 200), updatedAt: now.toISOString() };
  saveProduct(store, next);
  store.audit({ kind: "product-archived", product: id, reason: next.archivedReason }, now);
  return next;
}

export function requestLaunch(store: Store, id: string, now: Date): ApprovalRequest {
  const p = getProduct(store, id);
  if (p.status !== "ready") throw new Error(`${id} is ${p.status}: only a product that passed every check can be proposed for launch`);
  if (!p.signOff || p.signOff.reviewHash !== reviewHash(p)) throw new Error(`${id} has no current owner sign-off for its ${p.review.length} legal, tax or financial passage(s) and proposed price: run 'product sign-off ${id}' to see the items`);
  const changed = changedFiles(store, p);
  if (changed.length) throw new Error(`${id}: files changed since the build and sign-off (${changed.join(", ")}); review it again`);
  const approvals = store.approvals();
  const open = approvals.find((a) => a.ventureId === p.ventureId && a.action === "launch-public" && a.status === "pending");
  if (open) return open;
  const ventures = store.ventures();
  const v = ventures.find((x) => x.id === p.ventureId)!;
  if (!["built", "archived", "awaiting-launch-approval"].includes(v.status)) throw new Error(`venture ${v.id} is ${v.status}`);
  const req: ApprovalRequest = { id: newId("apr"), ventureId: p.ventureId, action: "launch-public", status: "pending", createdAt: now.toISOString(), decidedAt: null,
    summary: `Launch publicly: product ${p.id} (${p.name}, version ${p.version}) for venture ${v.id}. Proposed price ${p.currency} ${p.price} (hypothesis). Read qa-report.md first (${p.review.length} passage(s) on legal, tax or financial topics). Approving does not publish anything: you host the page, connect your own form and payment link, then run 'product mark-live ${p.id} --url <https://...>'.` };
  store.saveApprovals([...approvals, req]);
  if (v.status !== "awaiting-launch-approval") store.saveVentures(ventures.map((x) => (x.id === v.id ? { ...x, status: "awaiting-launch-approval", updatedAt: now.toISOString() } : x)));
  store.audit({ kind: "product-launch-requested", product: id, approval: req.id }, now);
  return req;
}

export function markLive(store: Store, id: string, url: string, now: Date): Product {
  const p = getProduct(store, id);
  if (p.status !== "ready") throw new Error(`${id} is ${p.status}: only a product that passed every check can go live`);
  const appr = store.approvals().filter((a) => a.ventureId === p.ventureId && a.action === "launch-public" && a.status === "approved").at(-1);
  if (!appr) throw new Error(`no approved launch for venture ${p.ventureId}: run 'product request-launch ${id}', then 'approve <id>'`);
  if (store.products().some((x) => x.ventureId === p.ventureId && x.status === "live")) throw new Error(`venture ${p.ventureId} already has a live product`);
  let u: URL; try { u = new URL(url); } catch { throw new Error("--url: not a URL"); }
  if (u.protocol !== "https:" || u.username || u.password || url.length > 200) throw new Error("--url: an https address without credentials, up to 200 characters");
  const next: Product = { ...p, status: "live", live: { url: u.toString(), at: now.toISOString(), approvalId: appr.id }, updatedAt: now.toISOString() };
  saveProduct(store, next);
  const ventures = store.ventures();
  store.saveVentures(ventures.map((x) => (x.id === p.ventureId && x.status !== "launched" ? { ...x, status: "launched", updatedAt: now.toISOString() } : x)));
  store.audit({ kind: "product-live", product: id, url: next.live!.url, approval: appr.id }, now);
  return next;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export function recordValidation(store: Store, id: string, r: { periodStart: string; periodEnd: string; visits: number; signups: number; sales: number; revenue: number; source: string; evidenceFile?: string }, now: Date): ValidationRecord {
  const p = getProduct(store, id);
  if (p.status !== "live" || !p.live) throw new Error(`${id} is not live: results can only be recorded after an approved launch ('product mark-live')`);
  if (!DAY.test(r.periodStart) || !DAY.test(r.periodEnd) || Number.isNaN(Date.parse(r.periodStart)) || Number.isNaN(Date.parse(r.periodEnd))) throw new Error("--period: YYYY-MM-DD..YYYY-MM-DD");
  if (r.periodStart > r.periodEnd) throw new Error("--period: the start is after the end");
  if (r.periodStart < p.live.at.slice(0, 10)) throw new Error(`--period: starts before the product went live (${p.live.at.slice(0, 10)})`);
  if (r.periodEnd > now.toISOString().slice(0, 10)) throw new Error("--period: ends in the future");
  const clash = p.validation.find((x) => !(r.periodEnd < x.periodStart || r.periodStart > x.periodEnd));
  if (clash) throw new Error(`--period overlaps an existing record (${clash.periodStart}..${clash.periodEnd}); record each period once`);
  for (const [k, x] of Object.entries({ visits: r.visits, signups: r.signups, sales: r.sales })) if (!Number.isInteger(x) || x < 0 || x > 10_000_000) throw new Error(`--${k}: a whole number`);
  if (!Number.isFinite(r.revenue) || r.revenue < 0 || r.revenue > 100_000_000 || !cents(r.revenue)) throw new Error("--revenue: a non-negative amount with at most 2 decimals");
  if (r.signups > r.visits) throw new Error("signups cannot exceed visits");
  if (r.sales === 0 && r.revenue > 0) throw new Error("revenue without sales");
  if (typeof r.source !== "string" || r.source.trim().length < 5) throw new Error("--source: say where the numbers were read (provider and report), e.g. 'form provider export'");
  let evidence: ValidationRecord["evidence"] = null;
  if (r.evidenceFile !== undefined) {
    let fd: number;
    try { fd = fs.openSync(r.evidenceFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw new Error("--evidence: cannot open the file (links are not followed)"); }
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.size === 0 || s.size > 10 * 1024 * 1024) throw new Error("--evidence: a non-empty regular file up to 10 MB");
      evidence = { name: path.basename(r.evidenceFile).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80), bytes: s.size, sha256: createHash("sha256").update(fs.readFileSync(fd)).digest("hex") };
    } finally { fs.closeSync(fd); }
  }
  const rec: ValidationRecord = { id: newId("val"), recordedAt: now.toISOString(), periodStart: r.periodStart, periodEnd: r.periodEnd, visits: r.visits, signups: r.signups, sales: r.sales,
    revenue: Math.round(r.revenue * 100) / 100, source: r.source.trim().slice(0, 200), verification: evidence ? "evidence-file" : "owner-reported", evidence };
  const next: Product = { ...p, validation: [...p.validation, rec], updatedAt: now.toISOString() };
  saveProduct(store, next);
  store.audit({ kind: "product-validation", product: id, period: `${rec.periodStart}..${rec.periodEnd}`, visits: rec.visits, signups: rec.signups, sales: rec.sales, revenue: rec.revenue, verification: rec.verification, evidenceSha256: evidence?.sha256 ?? null }, now);
  // Feed the engine's existing evidence path (cumulative totals), so its decisions use the same real numbers.
  const v = store.ventures().find((x) => x.id === p.ventureId);
  if (v?.status === "launched" && v.experiments.length > 0) {
    const t = realTotals(next);
    recordActual(store, p.ventureId, { visitors: t.visits, signups: t.signups, sales: t.sales, ...(p.currency === "USD" ? { revenueUsd: t.revenue } : {}) },
      `product ${p.id}: cumulative of ${next.validation.length} owner-recorded period(s); latest source: ${rec.source}`.slice(0, 200), now);
  }
  return rec;
}

export function realTotals(p: Product) {
  const sum = (k: "visits" | "signups" | "sales" | "revenue") => p.validation.reduce((a, x) => a + x[k], 0);
  return { periods: p.validation.length, verified: p.validation.filter((x) => x.verification === "evidence-file").length, visits: sum("visits"), signups: sum("signups"), sales: sum("sales"), revenue: Math.round(sum("revenue") * 100) / 100 };
}

/** The decision the pre-registered rules give, from real evidence only. */
export function realDecision(p: Product): string {
  if (p.status !== "live") return "no decision: not launched, so there is no real evidence";
  const t = realTotals(p);
  if (!t.periods) return "no decision: no results recorded yet";
  if (t.sales >= 1 || (t.visits >= DECISION_RULES.minimumVisits && t.signups / t.visits >= DECISION_RULES.continueSignupRate)) return `continue: ${t.sales} sale(s), signup rate ${pct(t)}`;
  if (t.visits >= DECISION_RULES.stopAfterVisitsWithoutSignups && t.signups === 0) return `stop: ${t.visits} visits and no signups (shutting down needs your approval)`;
  if (t.visits >= DECISION_RULES.minimumVisits && t.signups / t.visits < DECISION_RULES.improveBelowSignupRate) return `improve: signup rate ${pct(t)} is below ${DECISION_RULES.improveBelowSignupRate * 100}%`;
  return `not enough data: ${t.visits} visits (decisions start at ${DECISION_RULES.minimumVisits})`;
}
const pct = (t: { visits: number; signups: number }) => (t.visits ? `${((100 * t.signups) / t.visits).toFixed(1)}%` : "n/a");

export function productReport(store: Store, p: Product): string {
  const v = store.ventures().find((x) => x.id === p.ventureId);
  const sim = v?.experiments.at(-1)?.evidence.filter((e) => e.kind === "simulated").at(-1)?.metrics.qualityScore;
  const t = realTotals(p);
  return [
    `product ${p.id} (${p.name}), version ${p.version}, blueprint ${p.blueprint}, status ${p.status}${p.live ? `, live since ${p.live.at.slice(0, 10)} at ${p.live.url}` : ""}`,
    `proposed price: ${p.currency} ${p.price} (hypothesis)`,
    `checks: ${p.checks.filter((c) => c.passed).length}/${p.checks.length} passed${p.checks.some((c) => !c.passed) ? ` (failed: ${p.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")})` : ""}; ${p.review.length} passage(s) for owner review`,
    "REAL EVIDENCE (owner-recorded from providers; the engine never creates these numbers):",
    t.periods ? `  ${t.periods} period(s): ${t.verified} verified by evidence file, ${t.periods - t.verified} owner-reported only` : "  none recorded: no customer activity is known",
    ...(t.periods ? [`  visits ${t.visits}, signups ${t.signups} (${pct(t)}), sales ${t.sales}, revenue ${p.currency} ${t.revenue}`] : []),
    ...p.validation.map((x) => `  - ${x.periodStart}..${x.periodEnd}: ${x.visits} visits, ${x.signups} signups, ${x.sales} sales, ${p.currency} ${x.revenue}; ${x.verification}${x.evidence ? ` (${x.evidence.name}, sha256 ${x.evidence.sha256.slice(0, 12)}...)` : ""}; source: ${x.source}`),
    `  decision (pre-registered rules, real evidence only): ${realDecision(p)}`,
    "SIMULATED (engine estimates; not customer or financial data):",
    `  venture quality score ${sim ?? "n/a"}; opportunity demand estimate ${v?.opportunity.estimates.demand ?? "n/a"}`,
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------- command line

function flags(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i], val = args[i + 1];
    if (!allowed.includes(k)) throw new Error(`unknown option ${k}`);
    if (val === undefined) throw new Error(`${k} needs a value`);
    out[k] = val;
  }
  return out;
}
const int = (s: string | undefined, what: string) => { if (s === undefined || !/^\d+$/.test(s)) throw new Error(`${what}: a whole number`); return Number(s); };
const summary = (p: Product) => `${p.id} v${p.version} ${p.status.padEnd(10)} ${p.blueprint.padEnd(18)} ${p.currency} ${p.price}  ${p.checks.filter((c) => c.passed).length}/${p.checks.length} checks  venture ${p.ventureId}  ${p.name}`;
export const PRODUCT_USAGE = "product build <venture> [--price N] [--currency USD|GBP|EUR] | review <product> [--discard-edits] | review-all | adopt <product> | marketing <product> | sign-off <product> [--confirm CODE --price \"GBP 12\" --note <text>] | improve <product> [--price N] | check <product> | archive <product> --reason <text> | list [venture] | show <product> | request-launch <product> | mark-live <product> --url <https://...> | record <product> --period YYYY-MM-DD..YYYY-MM-DD --visits N --signups N --sales N --revenue X --source <text> [--evidence <file>] | report <product>";

export async function productCli(args: readonly string[], ctx: { store: Store; out: (s: string) => void; now: () => Date }): Promise<number> {
  const [sub, id, ...rest] = args;
  const { store, out } = ctx;
  const now = ctx.now();
  const locked = <T>(fn: () => T) => withLock(store.dir, async () => fn());
  const where = (p: Product) => path.join(store.dir, "ventures", p.ventureId, p.id);
  const printBuild = (p: Product) => {
    out(`${summary(p)}\nfiles: ${where(p)}\n`);
    for (const c of p.checks) out(`  ${c.passed ? "pass" : "FAIL"} ${c.name}: ${c.detail}\n`);
    out(`${p.review.length} passage(s) on legal, tax or financial topics are listed in qa-report.md for your review.\n`);
  };
  if (sub === "build") {
    if (!id) throw new Error("product build <venture>");
    const f = flags(rest, ["--price", "--currency"]);
    printBuild(await locked(() => buildProduct(store, id, { now, price: f["--price"] === undefined ? undefined : parseMoney(f["--price"], "--price"), currency: f["--currency"] as Currency | undefined })));
    return 0;
  }
  if (sub === "improve") {
    const prev = getProduct(store, String(id));
    const f = flags(rest, ["--price"]);
    printBuild(await locked(() => buildProduct(store, prev.ventureId, { now, previous: prev, price: f["--price"] === undefined ? undefined : parseMoney(f["--price"], "--price") })));
    return 0;
  }
  if (sub === "check") { const p = await locked(() => checkProduct(store, String(id), now)); printBuild(p); return p.checks.every((c) => c.passed) ? 0 : 1; }
  if (sub === "archive") { const f = flags(rest, ["--reason"]); const p = await locked(() => archiveProduct(store, String(id), f["--reason"] ?? "", now)); out(`${p.id} archived (files kept in ${where(p)})\n`); return 0; }
  if (sub === "list") { const ps = store.products().filter((p) => !id || p.ventureId === id); out(ps.length ? ps.map(summary).join("\n") + "\n" : "no products\n"); return 0; }
  if (sub === "show") { const p = getProduct(store, String(id)); out(JSON.stringify(p, null, 2) + `\nfiles: ${where(p)}\n`); return 0; }
  if (sub === "request-launch") {
    const a = await locked(() => requestLaunch(store, String(id), now));
    out(`approval request ${a.id} (${a.status}): ${a.summary}\nNothing has been published. Approve with 'approve ${a.id}' only when you are ready to publish it yourself.\n`);
    return 0;
  }
  if (sub === "mark-live") { const f = flags(rest, ["--url"]); const p = await locked(() => markLive(store, String(id), f["--url"] ?? "", now)); out(`${p.id} recorded as live at ${p.live!.url} (you published it; the engine did not)\n`); return 0; }
  if (sub === "record") {
    const f = flags(rest, ["--period", "--visits", "--signups", "--sales", "--revenue", "--source", "--evidence"]);
    const [a, b] = (f["--period"] ?? "").split("..");
    const rev = Number(f["--revenue"] ?? "x");
    const r = await locked(() => recordValidation(store, String(id), { periodStart: a ?? "", periodEnd: b ?? "", visits: int(f["--visits"], "--visits"), signups: int(f["--signups"], "--signups"), sales: int(f["--sales"], "--sales"), revenue: rev, source: f["--source"] ?? "", evidenceFile: f["--evidence"] }, now));
    out(`recorded ${r.id}: ${r.periodStart}..${r.periodEnd}, ${r.visits} visits, ${r.signups} signups, ${r.sales} sales (${r.verification})\n`);
    return 0;
  }
  if (sub === "report") { out(productReport(store, getProduct(store, String(id)))); return 0; }
  out(`Usage: ${PRODUCT_USAGE}\n`);
  return 2;
}
