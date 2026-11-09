/**
 * Offline product review and repair: inspect a product version, fix what is safe and deterministic, rerun QA, and
 * hand the owner only the decisions that need a person.
 *
 *   1. Inspect the stored files: the full product QA (files changed or missing since the build, links, placeholders,
 *      scripts, CSV formulas, misleading claims, legal/tax/financial wording, landing page, tracking plan,
 *      instructions) plus price consistency, invoice-calculator integrity and whether the version still matches its
 *      reviewed blueprint.
 *   2. Repair (only when something failed or the blueprint has improved): regenerate the version from the reviewed
 *      blueprint, then apply deterministic text fixes (external Markdown links -> plain text, CSV formula cells
 *      neutralised, missing disclaimer added). QA runs again after each pass; at most MAX_PASSES passes.
 *   3. If every check passes, the repaired files are saved as a NEW version (existing versions are never modified).
 *      If not, nothing is written and the review stops with the reason.
 *   4. Never decided automatically: misleading or commercial claims, legal positions stated as fact, the legal, tax
 *      and financial passages and the proposed price. They are listed for the owner ('product sign-off').
 *
 * No model, no network, no publication: the same inputs always give the same result.
 */

import { csvCell, DISCLAIMER, SYMBOL } from "./blueprints/common.js";
import { INVOICE_CALC_JS } from "./blueprints/invoice-template.js";
import { type GeneratedVersion, generateVersion, parseCsv, type Product, qa, qaGenerated, reviewHash, writeVersion } from "./products.js";
import { sha256, type Store } from "./store.js";
import type { Check } from "./types.js";

export const MAX_PASSES = 3;
/** Failures no automatic fix may touch: they need the owner's judgement. */
const OWNER_ONLY = new Set(["no-misleading-claims"]);
const DISCLAIMED = /not legal, tax or financial advice/i;
const SENSITIVE = /\b(legal(ly)?|law(s|yer)?|solicitor|attorney|court|statutory|legislation|contract|tax(es)?|VAT|GST|HMRC|IRS|interest|debt|invest(ment|ing)?|pension|insurance)/i;

export interface ReviewResult {
  readonly product: string;
  readonly repairedAs: Product | null;
  readonly fixed: readonly string[];
  readonly passed: readonly string[];
  readonly ownerDecisions: readonly string[];
  readonly stopped: string | null;
  readonly passes: number;
}

type Files = { name: string; text: string; template: boolean }[];

/** Checks beyond the generic QA: price shown = price recorded; the invoice calculator is the reviewed one. */
export function extraChecks(p: Pick<Product, "price" | "currency" | "id">, read: (n: string) => string | null, names: readonly string[]): Check[] {
  const money = `${SYMBOL[p.currency]}${p.price.toFixed(2).replace(/\.00$/, "")}`;
  const landing = read("landing.html") ?? "";
  let plan = ""; try { plan = String(JSON.parse(read("tracking-plan.json") ?? "{}").proposedPrice ?? ""); } catch { plan = ""; }
  const out: Check[] = [{ name: "price-consistency", passed: landing.includes(`Proposed price: <strong>${money}</strong>`) && plan.startsWith(money),
    detail: `landing page and tracking plan must both show ${money}` }];
  if (names.includes("invoice-template.html")) {
    const inv = read("invoice-template.html") ?? "";
    const js = /<script>([\s\S]*?)<\/script>/.exec(inv)?.[1];
    out.push({ name: "calculator-integrity", passed: js === undefined || js === INVOICE_CALC_JS,
      detail: js === undefined ? "no calculator (older template: totals typed by hand)" : js === INVOICE_CALC_JS ? "the reviewed calculator, unmodified" : "the calculator differs from the reviewed version" });
  }
  return out;
}

/** Deterministic text fixes. Each returns a description when it changed something. */
function textFixes(files: Files): string[] {
  const done: string[] = [];
  for (const f of files) {
    if (f.name.endsWith(".md")) {
      const t = f.text.replace(/\[([^\]\n]*)\]\((?:https?|ftp|mailto):[^)\s]*\)/gi, "$1");
      if (t !== f.text) { f.text = t; done.push(`${f.name}: external links turned into plain text (none are allowed before an approved launch)`); }
      if (SENSITIVE.test(f.text) && !DISCLAIMED.test(f.text)) { f.text = `${f.text.replace(/\s*$/, "")}\n\n## Important\n\n${DISCLAIMER}\n`; done.push(`${f.name}: general-information disclaimer added`); }
    }
    if (f.name.endsWith(".csv")) {
      const rows = parseCsv(f.text).filter((r) => r.some((x) => x !== ""));
      const t = rows.map((r) => r.map((x) => csvCell(x.replace(/^'(?=[=+@\t\r-])/, ""))).join(",")).join("\r\n") + "\r\n";
      if (rows.flat().some((x) => /^[=+@\t\r]/.test(x) || (/^-/.test(x) && !/^-\d+(\.\d+)?$/.test(x)))) { f.text = t; done.push(`${f.name}: cells a spreadsheet would run as formulas neutralised`); }
    }
  }
  return done;
}

function check(g: GeneratedVersion): { checks: Check[]; review: string[] } {
  const { checks, review } = qaGenerated(g);
  const read = (n: string) => g.files.find((f) => f.name === n)?.text ?? null;
  return { checks: [...checks, ...extraChecks({ id: g.id, price: g.price, currency: g.currency }, read, g.files.map((f) => f.name))], review };
}

function ownerItems(p: { review: readonly string[]; price: number; currency: string; id: string }, failed: readonly Check[], signedOff: boolean): string[] {
  const items = failed.filter((c) => OWNER_ONLY.has(c.name) || /states a legal or financial position as fact/.test(c.detail)).map((c) => `${c.name}: ${c.detail}`);
  if (!signedOff) {
    items.push(`confirm the proposed price ${p.currency} ${p.price} (an untested hypothesis)`);
    items.push(...p.review.map((r) => `legal/tax/financial wording to approve: ${r}`));
  }
  return items;
}

export function reviewProduct(store: Store, id: string, now: Date, maxPasses = MAX_PASSES): ReviewResult {
  const p = store.products().find((x) => x.id === id);
  if (!p) throw new Error(`no product ${id}`);
  const dir = store.assetDir(p.ventureId, p.id);
  const read = store.reader(dir);
  const manifest = p.files.filter((f) => f.name !== "qa-report.md").map((f) => ({ name: f.name, template: p.templates.includes(f.name) }));
  const current = [...qa(read, manifest, p.files).checks, ...extraChecks(p, read, manifest.map((m) => m.name))];
  const failed = current.filter((c) => !c.passed);
  const signedOff = !!p.signOff && p.signOff.reviewHash === reviewHash(p);
  const base = { product: p.id, passes: 0 };
  const audit = (r: ReviewResult) => { store.audit({ kind: "product-review", product: p.id, repairedAs: r.repairedAs?.id ?? null, fixed: r.fixed.length, ownerDecisions: r.ownerDecisions.length, stopped: r.stopped }, now); return r; };

  if (p.status === "live" || p.status === "archived") {
    return audit({ ...base, repairedAs: null, fixed: [], passed: current.filter((c) => c.passed).map((c) => c.name), ownerDecisions: [...failed.map((c) => `${c.name}: ${c.detail}`), ...(failed.length ? [`${p.id} is ${p.status}: repairs are not applied automatically; build a new version if needed`] : [])], stopped: null });
  }

  // Would the reviewed blueprint produce different buyer files today (template fixes, wording, calculator)?
  const fresh = generateVersion(store, p.ventureId, { previous: p });
  // Only intact files count as "outdated": files changed since the build are already reported by files-unchanged.
  const intact = (n: string) => { const t = read(n), rec = p.files.find((f) => f.name === n); return t !== null && !!rec && sha256(t) === rec.sha256; };
  const outdated = fresh.files.filter((f) => f.name !== "tracking-plan.json" && intact(f.name) && read(f.name) !== f.text).map((f) => f.name);
  if (!failed.length && !outdated.length) {
    return audit({ ...base, repairedAs: null, fixed: [], passed: current.map((c) => c.name), ownerDecisions: ownerItems(p, [], signedOff), stopped: null });
  }

  const fixed = [
    ...failed.filter((c) => !OWNER_ONLY.has(c.name)).map((c) => `${c.name} failed (${c.detail.slice(0, 120)}): files regenerated from the reviewed blueprint`),
    ...(outdated.length ? [`blueprint improved since version ${p.version}: regenerated ${outdated.join(", ")}`] : []),
  ];
  let result = check(fresh), passes = 0;
  while (passes < maxPasses && result.checks.some((c) => !c.passed)) {
    passes += 1;
    const done = textFixes(fresh.files);
    if (!done.length) break; // nothing more a deterministic fix can do
    fixed.push(...done);
    result = check(fresh);
  }
  const stillFailing = result.checks.filter((c) => !c.passed);
  if (stillFailing.length) {
    return audit({ ...base, passes, repairedAs: null, fixed: [], passed: result.checks.filter((c) => c.passed).map((c) => c.name),
      ownerDecisions: [...ownerItems({ ...fresh, review: result.review }, stillFailing, false), ...stillFailing.filter((c) => !OWNER_ONLY.has(c.name)).map((c) => `cannot be fixed automatically: ${c.name}: ${c.detail}`)],
      stopped: `${stillFailing.length} check(s) still fail after ${passes} repair pass(es): nothing was written; fix the source (venture outline or blueprint) and review again` });
  }
  const repaired = writeVersion(store, fresh, { now, previous: p });
  return audit({ ...base, passes, repairedAs: repaired, fixed, passed: result.checks.map((c) => c.name), ownerDecisions: ownerItems(repaired, [], false), stopped: null });
}

export function formatReview(r: ReviewResult): string {
  const list = (xs: readonly string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  - none");
  return [
    `review of ${r.product}${r.repairedAs ? `: repaired as ${r.repairedAs.id} (version ${r.repairedAs.version}); ${r.product} is unchanged` : ""}`,
    `FIXED AUTOMATICALLY (${r.fixed.length}):`, list(r.fixed),
    `PASSED (${r.passed.length}): ${r.passed.join(", ") || "none"}`,
    `NEEDS OWNER DECISION (${r.ownerDecisions.length}):`, list(r.ownerDecisions),
    ...(r.stopped ? [`STOPPED: ${r.stopped}`] : []),
    ...(!r.stopped && r.ownerDecisions.length ? [`next: read qa-report.md of ${r.repairedAs?.id ?? r.product}, then 'product sign-off ${r.repairedAs?.id ?? r.product} --note "..."'`] : []),
  ].join("\n") + "\n";
}

/** Reviews the latest version of every venture's product (archived and live versions are reported, not repaired). */
export function reviewAll(store: Store, now: Date): ReviewResult[] {
  const latest = new Map<string, Product>();
  for (const p of store.products()) if ((latest.get(p.ventureId)?.version ?? 0) < p.version) latest.set(p.ventureId, p);
  return [...latest.values()].map((p) => reviewProduct(store, p.id, now));
}
