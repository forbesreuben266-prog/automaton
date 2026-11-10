/**
 * Product factory: one bounded run turns the best eligible concept into a complete product draft and an owner review
 * package. Pipeline: ideas (offline catalogue) -> transparent scoring -> selection -> product build (existing
 * blueprint + QA, products.ts) -> Payhip listing draft -> three platform drafts -> review package and JSON summary.
 *
 *   factory run --offline   offline template generation from hand-written toolkits (blueprints/toolkit.ts). No model,
 *                           network, payment or platform calls. At most one product per run and one run per UK day
 *                           (a rerun the same day shows that day's run). Refused while STOP is set.
 *   factory run             (without --offline) AI-powered generation is not available in this version: it is
 *                           refused with the reason, and nothing is generated in its place.
 *   factory list | show <run>
 *
 * Demand evidence is reported as unverified (0) unless real evidence exists; competition is unknown offline. The
 * factory never approves, publishes, schedules, lists on Payhip, sends or spends: the review package lists the
 * owner's own next steps, all through the existing approval gates (sign-off, launch request, mark-live, campaigns).
 */

import path from "node:path";
import { CONCEPTS, EXTRA_CONCEPTS, type Concept } from "./blueprints/toolkit.js";
import { PLATFORM_MAX } from "./campaign.js";
import { stopReason, withLock, type EngineConfig } from "./control.js";
import { overlap } from "./evaluate.js";
import { readPitch } from "./marketing.js";
import { londonDate } from "./operations.js";
import { buildProduct, misleadingClaims, type Product } from "./products.js";
import { ensurePrivateDir, newId, sha256, type Store } from "./store.js";
import type { Asset, Venture } from "./types.js";

export const MODE = "offline-template" as const;
export const WEIGHTS = { usefulness: 0.3, demandEvidence: 0.25, competition: 0.1, simplicity: 0.15, monetisation: 0.2 } as const;
const DUPLICATE_OVERLAP = 0.3;
const INSTAGRAM_MAX = 2200;
const LINK = "[[link to your Payhip page]]";

export type FactoryStatus = "review-ready" | "failed-validation" | "no-eligible-concept";
export interface Factor { readonly value: number; readonly weight: number; readonly basis: string }
export interface Scored { readonly concept: string; readonly name: string; readonly total: number; readonly eligible: boolean; readonly excluded: string | null; readonly factors: Readonly<Record<keyof typeof WEIGHTS, Factor>> }
export interface FactoryRun {
  readonly id: string; readonly date: string; readonly startedAt: string; readonly mode: typeof MODE; readonly status: FactoryStatus;
  readonly concept: string | null; readonly ventureId: string | null; readonly productId: string | null; readonly score: number | null;
  readonly failedChecks: readonly string[]; readonly dir: string; readonly files: readonly Asset[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export const factoryDir = (store: Store, runId: string) => path.join(store.dir, "factory", runId);

/** Transparent scores for every concept; exclusions say why (duplicate of an existing product or earlier run). */
export function scoreConcepts(store: Store, concepts: readonly Concept[]): Scored[] {
  const runs = store.factoryRuns();
  const products = store.products(), ventures = store.ventures();
  const existing = [...products.map((p) => p.name), ...ventures.map((v) => `${v.opportunity.title} ${v.opportunity.problem}`)];
  return concepts.map((c) => {
    const factors = {
      usefulness: { value: c.ratings.usefulness, weight: WEIGHTS.usefulness, basis: `assumption (catalogue rating): ${c.reasons.usefulness}` },
      demandEvidence: { value: 0, weight: WEIGHTS.demandEvidence, basis: "unverified: no market research or recorded demand evidence exists for this concept (offline mode)" },
      competition: { value: 0.5, weight: WEIGHTS.competition, basis: "unknown: competing products were not researched offline (neutral 0.5)" },
      simplicity: { value: c.ratings.simplicity, weight: WEIGHTS.simplicity, basis: `assumption: ${c.reasons.simplicity}` },
      monetisation: { value: c.ratings.monetisation, weight: WEIGHTS.monetisation, basis: `assumption: ${c.reasons.monetisation}` },
    };
    const total = r2(Object.values(factors).reduce((a, f) => a + f.value * f.weight, 0));
    const earlier = runs.find((r) => r.concept === c.id);
    const similar = existing.find((e) => overlap(`${c.name} ${c.problem}`, e) >= DUPLICATE_OVERLAP || e.toLowerCase().startsWith(c.name.toLowerCase()));
    const excluded = earlier ? `already made in factory run ${earlier.id}` : similar ? `too similar to an existing product or venture ("${similar.slice(0, 60)}")` : null;
    return { concept: c.id, name: c.name, total, eligible: !excluded, excluded, factors };
  }).sort((a, b) => b.total - a.total || a.concept.localeCompare(b.concept));
}

export function listing(p: Product, c: Concept, landing: string): string {
  const x = readPitch(landing);
  const files = p.deliverables.map((n) => `- ${n}: ${c.files.find((f) => f.name === n)?.description ?? ""}`).join("\n");
  return `# Payhip listing draft: ${p.name}

Draft only: no Payhip listing was created or changed. Create it yourself after the launch is approved, then record its
address with 'product mark-live ${p.id} --url <your Payhip URL>'.

**Title:** ${p.name}

**Subtitle:** ${x.headline}

**Price:** ${p.currency} ${p.price} (one-off). ${c.priceRationale}

**Short description:** ${x.offer}

**Description:**

${c.offer}

What you get:

${x.benefits.map((b) => `- ${b}`).join("\n")}

What is inside:

${files}

Format: ${c.pitch.faq[0]?.a ?? "Markdown and CSV files."}

These files help you organise your work. They are not legal, tax or financial advice.

**File to upload:** one ZIP you make of the ${p.deliverables.length} files in the product folder (${p.deliverables.join(", ")}). Do not upload landing.html, tracking-plan.json or qa-report.md.
`;
}

export function marketingDrafts(p: Product, c: Concept, landing: string): { platform: string; max: number; text: string }[] {
  const x = readPitch(landing);
  const price = `${p.currency === "GBP" ? "£" : p.currency === "EUR" ? "€" : "$"}${p.price}`;
  return [
    { platform: "Facebook", max: PLATFORM_MAX.facebook, text: `${c.hook}\n\nThe ${p.name} gives ${c.audience} a ready routine:\n${x.benefits.slice(0, 3).map((b) => `• ${b}`).join("\n")}\n\n${price}, one-off, instant download 👉 ${LINK}` },
    { platform: "LinkedIn", max: PLATFORM_MAX.linkedin, text: `${x.headline}.\n\n${x.offer}\n\nWhat is inside:\n${x.inside.filter((i) => !/^start here/i.test(i)).map((i) => `• ${i}`).join("\n")}\n\nPlain Markdown and CSV files: no software to install. ${price}, one-off: ${LINK}` },
    { platform: "Instagram", max: INSTAGRAM_MAX, text: `${x.headline} ✅\n\n${x.benefits.map((b) => `✔️ ${b}`).join("\n")}\n\nEditable files for any text editor and spreadsheet. ${price}, instant download. Link in bio: ${LINK}\n\n#freelancer #smallbusiness #productivity` },
  ];
}

function reviewPackage(run: { id: string; date: string }, c: Concept, p: Product, scores: readonly Scored[], names: readonly string[], dir: string): string {
  const s = scores.find((x) => x.concept === c.id)!;
  const ok = p.status === "ready";
  return `# Review package: ${p.name} (factory run ${run.id})

- Status: **${ok ? "READY FOR YOUR REVIEW" : "FAILED VALIDATION: not ready for review"}**
- Made ${run.date} in ${MODE} mode: hand-written toolkit files from the offline catalogue; no AI model, network or market research was used.
- Product: ${p.id} (version ${p.version}), venture ${p.ventureId}. Product files: ${path.join("ventures", p.ventureId, p.id)}
- Nothing was published, listed, scheduled, sent, approved or bought.

## Concept and customer

- For: ${c.audience}
- Problem: ${c.problem}
- Offer: ${c.offer}

## Opportunity score: ${s.total} (out of 1)

| Factor | Value | Weight | Basis |
|---|---|---|---|
${Object.entries(s.factors).map(([k, f]) => `| ${k} | ${f.value} | ${f.weight} | ${f.basis} |`).join("\n")}

Other concepts considered: ${scores.filter((x) => x.concept !== c.id).map((x) => `${x.name} ${x.total}${x.excluded ? ` (excluded: ${x.excluded})` : ""}`).join("; ") || "none"}.

Evidence limitations: demand is **unverified** and competition is **unknown**. The score ranks catalogue concepts by stated assumptions; it is not a sales forecast.

## Files

| File | Bytes | SHA-256 (first 12) |
|---|---|---|
${p.files.map((f) => `| ${f.name} | ${f.bytes} | ${f.sha256.slice(0, 12)} |`).join("\n")}

Review package files (${dir}): ${names.join(", ")}

## Automated quality checks

| Check | Result | Detail |
|---|---|---|
${p.checks.map((x) => `| ${x.name} | ${x.passed ? "pass" : "FAIL"} | ${x.detail.replace(/\|/g, "/")} |`).join("\n")}

## Price

${p.currency} ${p.price}. ${c.priceRationale}

## Risks, assumptions and missing information

- No customer has seen this product; usefulness ratings are assumptions.
- Demand and competing products are unknown: check what similar kits exist and cost before launching.
- The files are generic and need your own business details in the [[fields]].
- No product images or preview screenshots were made: Payhip listings usually need at least one.
- The ZIP for Payhip must be made by you from the deliverable files.

## Owner approval checklist (each step is yours; nothing here happens automatically)

1. [ ] Read every product file in the product folder and edit anything that does not fit your business.
2. [ ] Read listing.md and marketing-drafts.md; change the wording you do not like.
3. [ ] Sign off the price and content: \`product sign-off ${p.id}\` (shows the code), then run it with --confirm in a terminal.
4. [ ] Request the launch: \`product request-launch ${p.id}\`, then \`approve <approval id>\`.
5. [ ] Create the Payhip listing yourself from listing.md and upload your ZIP.
6. [ ] Record the live page: \`product mark-live ${p.id} --url <your Payhip URL>\`.
7. [ ] Only then create a campaign with that URL: \`campaign create ${p.id} --url <your Payhip URL>\` and approve each post.
`;
}

export interface FactoryResult { readonly run: FactoryRun; readonly reused: boolean; readonly scores: readonly Scored[] }

/** One bounded factory run. Writes only new records and files; never touches existing products or campaigns. */
export function runFactory(store: Store, cfg: EngineConfig, now: Date, opts: { offline: boolean; concepts?: readonly Concept[] }): FactoryResult {
  if (!opts.offline) throw new Error(cfg.model.provider === "none"
    ? "no AI model is configured, and AI-powered product generation is not available in this version. Nothing was generated. Use 'factory run --offline' for offline template generation (labelled as such)."
    : `AI-powered product generation is not available in this version (configured provider: ${cfg.model.provider}); no model was called and nothing was generated. Use 'factory run --offline'.`);
  const why = stopReason(store.dir);
  if (why) throw new Error(`STOP is set (${why}): the factory does not run until 'resume'`);
  const date = londonDate(now);
  const today = store.factoryRuns().find((r) => r.date === date);
  if (today) return { run: today, reused: true, scores: [] };
  const concepts = opts.concepts ?? [...CONCEPTS, ...EXTRA_CONCEPTS];
  const scores = scoreConcepts(store, concepts);
  const pick = scores.find((s) => s.eligible);
  const id = newId("fct");
  const dir = factoryDir(store, id);
  ensurePrivateDir(path.dirname(dir)); ensurePrivateDir(dir);
  const files: Asset[] = [];
  const write = store.writer(dir, files);
  const base = { id, date, startedAt: now.toISOString(), mode: MODE, dir };
  if (!pick) {
    write("summary.json", JSON.stringify({ ...base, status: "no-eligible-concept", scores }, null, 2) + "\n");
    const run: FactoryRun = { ...base, status: "no-eligible-concept", concept: null, ventureId: null, productId: null, score: null, failedChecks: [], files };
    store.saveFactoryRuns([...store.factoryRuns(), run]);
    store.audit({ kind: "factory-run", run: id, status: run.status }, now);
    return { run, reused: false, scores };
  }
  const c = concepts.find((x) => x.id === pick.concept)!;
  const at = now.toISOString();
  const venture: Venture = { id: newId("ven"), status: "factory-draft", experiments: [], decisions: [], createdAt: at, updatedAt: at,
    opportunity: { id: newId("opp"), kind: "digital-product", title: c.name, problem: c.problem, audience: c.audience, offer: c.offer,
      estimates: { demand: 0, feasibility: c.ratings.simplicity, risk: 0.1, costUsd: 0 }, score: pick.total, createdAt: at, source: `factory:${c.id}` } };
  store.saveVentures([...store.ventures(), venture]);
  const currency = store.products().find((p) => p.status === "live")?.currency ?? "GBP";
  const p = buildProduct(store, venture.id, { now, price: c.price, currency });
  const failed = p.checks.filter((x) => !x.passed).map((x) => x.name);
  const status: FactoryStatus = p.status === "ready" ? "review-ready" : "failed-validation";
  const landing = store.reader(store.assetDir(p.ventureId, p.id))("landing.html") ?? "";
  if (status === "review-ready") {
    const drafts = marketingDrafts(p, c, landing);
    const problems = drafts.flatMap((d) => [...misleadingClaims(d.text).map((w) => `${d.platform}: ${w}`), ...(d.text.length > d.max ? [`${d.platform}: ${d.text.length} > ${d.max} characters`] : []), ...(/https?:\/\/|www\./i.test(d.text) ? [`${d.platform}: contains a link`] : [])]);
    if (problems.length) throw new Error(`marketing drafts failed their checks: ${problems.join("; ")}`);
    write("listing.md", listing(p, c, landing));
    write("marketing-drafts.md", `# Marketing drafts: ${p.name}\n\nDrafts only: nothing was posted or scheduled. Replace ${LINK} with your live Payhip address only after the launch is approved, and post only where self-promotion is allowed.\n\n${drafts.map((d) => `## ${d.platform} (${d.text.length} of ${d.max} characters)\n\n\`\`\`text\n${d.text}\n\`\`\``).join("\n\n")}\n`);
  }
  write("review-package.md", reviewPackage({ id, date }, c, p, scores, [...files.map((f) => f.name), "review-package.md", "summary.json"], dir));
  const summary = { ...base, status, concept: { id: c.id, name: c.name, audience: c.audience, problem: c.problem }, scores, selected: pick,
    product: { id: p.id, ventureId: p.ventureId, version: p.version, status: p.status, price: p.price, currency: p.currency, priceRationale: c.priceRationale, files: p.files, checks: p.checks },
    evidence: { demand: "unverified", competition: "unknown", sales: "none" }, published: false, approved: false, packageFiles: files.map((f) => f.name) };
  write("summary.json", JSON.stringify(summary, null, 2) + "\n");
  const run: FactoryRun = { ...base, status, concept: c.id, ventureId: venture.id, productId: p.id, score: pick.total, failedChecks: failed, files };
  store.saveFactoryRuns([...store.factoryRuns(), run]);
  store.audit({ kind: "factory-run", run: id, status, concept: c.id, product: p.id, failed }, now);
  return { run, reused: false, scores };
}

export const FACTORY_USAGE = "factory run --offline | factory list | factory show <run>";

export async function factoryCli(args: readonly string[], ctx: { store: Store; cfg: EngineConfig; out: (s: string) => void; now: () => Date }): Promise<number> {
  const [sub, ...rest] = args;
  const { store, out } = ctx;
  if (sub === "run") {
    const bad = rest.find((a) => a !== "--offline");
    if (bad) throw new Error(`unknown option ${bad} (${FACTORY_USAGE})`);
    const r = await withLock(store.dir, async () => runFactory(store, ctx.cfg, ctx.now(), { offline: rest.includes("--offline") }));
    const x = r.run;
    out(`${r.reused ? "already ran today: " : ""}factory run ${x.id} (${x.date}, ${x.mode}): ${x.status}${x.productId ? `, product ${x.productId} (${x.concept}), score ${x.score}` : ""}\n`);
    if (x.failedChecks.length) out(`failed checks: ${x.failedChecks.join(", ")}\n`);
    out(`review package: ${path.join(x.dir, "review-package.md")}\nNothing was published, listed, scheduled, sent, approved or bought.\n`);
    return x.status === "failed-validation" ? 1 : 0;
  }
  if (sub === "list") { const rs = store.factoryRuns(); out(rs.length ? rs.map((x) => `${x.id} ${x.date} ${x.status} ${x.concept ?? "-"} ${x.productId ?? "-"}`).join("\n") + "\n" : "no factory runs\n"); return 0; }
  if (sub === "show") {
    const x = store.factoryRuns().find((r) => r.id === rest[0]);
    if (!x) throw new Error(`no factory run ${rest[0] ?? ""}`);
    const text = store.reader(x.dir)("review-package.md");
    if (text !== null && sha256(text) !== x.files.find((f) => f.name === "review-package.md")?.sha256) out("note: review-package.md was edited after the run\n");
    out(text ?? JSON.stringify(x, null, 2) + "\n");
    return 0;
  }
  out(`Usage: ${FACTORY_USAGE}\n`);
  return 2;
}
