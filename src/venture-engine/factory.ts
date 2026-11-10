/**
 * Product factory: one bounded run turns the best eligible concept into a complete product draft, a ZIP and an owner
 * review package. Pipeline: ideas -> transparent scoring -> selection -> product build (toolkit blueprint + product
 * QA, products.ts) -> factory QA (ZIP integrity, near-duplicates, listing consistency, usability, marketing checks)
 * -> Payhip listing draft, three platform drafts, image brief -> review package and JSON summary.
 *
 *   factory run --offline       hand-written catalogue toolkits (blueprints/toolkit.ts). No model or network.
 *   factory run --ai [--paid]   ideas and product content from the configured model (model.ts / claude.ts), strictly
 *                               validated. A paid provider needs config model.paidUsageApproved AND --paid, and its
 *                               worst-case cost must fit model.maxGbpPerRun and the ledger before any call.
 *   factory run --ai --mock     the same pipeline with the built-in MOCK model: a labelled demonstration, not AI.
 *   factory preflight           AI readiness from local checks only (no network, no tokens).
 *   factory list | show <run>
 *
 * Limits: one run per UK day per mode (a rerun shows that day's run), one product per run, at most 2 model calls,
 * refused while STOP is set. A failing check marks the run needs-repair; nothing is ever marked approved. Demand and
 * competition are unverified unless real evidence exists. The factory never approves, publishes, schedules, lists on
 * Payhip, sends or spends beyond the approved budget: the review package lists the owner's own next steps.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { aiReadiness, estimateRunGbp, IDEAS_MAX_TOKENS, ideaNeedsAdvice, ideasPrompt, mockModel, productMaxTokens, productPrompt, specToConcept, validateIdeas, validateSpec, type AiIdea, type ProductSpec } from "./ai-factory.js";
import { CONCEPTS, EXTRA_CONCEPTS, type Concept } from "./blueprints/toolkit.js";
import { PLATFORM_MAX } from "./campaign.js";
import { stopReason, withLock, type EngineConfig } from "./control.js";
import { overlap } from "./evaluate.js";
import { readPitch } from "./marketing.js";
import { askJson, ModelBudget, type ModelClient } from "./model.js";
import { londonDate } from "./operations.js";
import { buildProduct, misleadingClaims, type Product } from "./products.js";
import { ensurePrivateDir, newId, sha256, type Store } from "./store.js";
import type { Asset, Check, Venture } from "./types.js";
import { makeZip, verifyZip, zipManifest } from "./zip.js";

export type FactoryMode = "offline-template" | "ai" | "mock-demo";
/** Kept for compatibility with earlier runs. */
export const MODE = "offline-template" as const;
export const WEIGHTS = { usefulness: 0.3, demandEvidence: 0.25, competition: 0.1, simplicity: 0.15, monetisation: 0.2 } as const;
export const MAX_MODEL_CALLS = 2;
const DUPLICATE_OVERLAP = 0.3, NEAR_DUPLICATE_CONTENT = 0.6, INSTAGRAM_MAX = 2200;
const LINK = "[[link to your Payhip page]]";

export type FactoryStatus = "review-ready" | "needs-repair" | "failed-validation" | "no-eligible-concept" | "ai-failed";
export type EvidenceCategory = "verified" | "ai-inference" | "owner-assumption" | "unknown";
export interface Factor { readonly value: number; readonly weight: number; readonly category: EvidenceCategory; readonly basis: string }
export interface Scored { readonly concept: string; readonly name: string; readonly total: number; readonly eligible: boolean; readonly excluded: string | null; readonly factors: Readonly<Record<keyof typeof WEIGHTS, Factor>> }
export interface FactoryRun {
  readonly id: string; readonly date: string; readonly startedAt: string; readonly mode: FactoryMode; readonly status: FactoryStatus;
  readonly concept: string | null; readonly ventureId: string | null; readonly productId: string | null; readonly score: number | null;
  readonly failedChecks: readonly string[]; readonly dir: string; readonly files: readonly Asset[];
  readonly model?: string | null; readonly modelCalls?: number; readonly reason?: string | null; readonly zip?: string | null;
  /** Set when this run was rebuilt locally from an earlier run's saved model answers (no model call). */
  readonly recoveredFrom?: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export const factoryDir = (store: Store, runId: string) => path.join(store.dir, "factory", runId);

interface Candidate { readonly id: string; readonly name: string; readonly problem: string; readonly ratings: Concept["ratings"]; readonly reasons: Concept["reasons"]; readonly ai: boolean; readonly needsAdvice?: boolean }

/** Transparent scores; each factor says whether it is verified evidence, AI inference, an owner assumption or unknown. */
export function scoreCandidates(store: Store, cs: readonly Candidate[]): Scored[] {
  const runs = store.factoryRuns();
  const existing = [...store.products().map((p) => p.name), ...store.ventures().map((v) => `${v.opportunity.title} ${v.opportunity.problem}`), ...runs.map((r) => r.concept ?? "").filter(Boolean)];
  return cs.map((c) => {
    const rated = (k: "usefulness" | "monetisation"): Factor => ({ value: c.ratings[k], weight: WEIGHTS[k], category: c.ai ? "ai-inference" : "owner-assumption", basis: `${c.ai ? "AI inference" : "assumption (catalogue rating)"}: ${c.reasons[k]}` });
    const factors = {
      usefulness: rated("usefulness"),
      demandEvidence: { value: 0, weight: WEIGHTS.demandEvidence, category: "unknown" as const, basis: "unverified: no market research or recorded demand evidence exists; AI reasoning is not evidence" },
      competition: { value: 0.5, weight: WEIGHTS.competition, category: "unknown" as const, basis: "unknown: competing products were not researched (neutral 0.5)" },
      simplicity: { value: c.ratings.simplicity, weight: WEIGHTS.simplicity, category: "owner-assumption" as const, basis: `owner assumption: ${c.reasons.simplicity}` },
      monetisation: rated("monetisation"),
    };
    const total = r2(Object.values(factors).reduce((a, f) => a + f.value * f.weight, 0));
    const earlier = runs.find((r) => r.concept === c.id);
    const similar = existing.find((e) => overlap(`${c.name} ${c.problem}`, e) >= DUPLICATE_OVERLAP || e.toLowerCase().startsWith(c.name.toLowerCase()));
    const excluded = c.needsAdvice ? "touches legal, tax or financial advice (not eligible)" : earlier ? `already made in factory run ${earlier.id}` : similar ? `too similar to an existing product, venture or run ("${similar.slice(0, 60)}")` : null;
    return { concept: c.id, name: c.name, total, eligible: !excluded, excluded, factors };
  }).sort((a, b) => b.total - a.total || a.concept.localeCompare(b.concept));
}
export const scoreConcepts = (store: Store, concepts: readonly Concept[]) => scoreCandidates(store, concepts.map((c) => ({ ...c, ai: false })));

const formats = (c: Concept) => { const f = new Set(c.files.map((x) => x.name.split(".").pop())); return [f.has("html") && "an offline HTML worksheet", f.has("csv") && "CSV trackers", f.has("md") && "Markdown guides"].filter(Boolean).join(", "); };
const demoNote = (c: Concept) => (c.origin?.mode === "mock-demo" ? "\n\n> **MOCK DEMONSTRATION:** this content came from the built-in mock model to show the pipeline. It is not real AI output.\n" : c.origin?.mode === "ai" ? `\n\n> AI-generated draft (${c.origin.model}): check every file before use.\n` : "");

export function listing(p: Product, c: Concept, landing: string): string {
  const x = readPitch(landing);
  return `# Payhip listing draft: ${p.name}${demoNote(c)}

Draft only: no Payhip listing was created or changed. Create it yourself after the launch is approved, then record its
address with 'product mark-live ${p.id} --url <your Payhip URL>'.

**Title:** ${p.name}

**Subtitle:** ${x.headline}

**Price:** ${p.currency} ${p.price} (one-off). ${c.priceRationale}

**Short description:** ${x.offer}

**Feature summary:** ${c.files.length} files: ${formats(c)}. No accounts or software to install.

**Description:**

${c.offer}

What you get:

${x.benefits.map((b) => `- ${b}`).join("\n")}

What is inside:

${p.deliverables.map((n) => `- ${n}: ${c.files.find((f) => f.name === n)?.description ?? ""}`).join("\n")}

Format: ${c.pitch.faq[0]?.a ?? "Markdown and CSV files."}

These files help you organise your work. They are not legal, tax or financial advice.

**File to upload:** the ZIP in this factory run folder (it contains exactly the ${p.deliverables.length} deliverables: ${p.deliverables.join(", ")}).

**Images:** none were created. See image-brief.md.
`;
}

export function marketingDrafts(p: Product, c: Concept, landing: string): { platform: string; max: number; text: string }[] {
  const x = readPitch(landing);
  const price = `${p.currency === "GBP" ? "£" : p.currency === "EUR" ? "€" : "$"}${p.price}`;
  const fmt = formats(c);
  return [
    { platform: "Facebook", max: PLATFORM_MAX.facebook, text: `${c.hook}\n\nThe ${p.name} gives ${c.audience} a ready routine:\n${x.benefits.slice(0, 3).map((b) => `• ${b}`).join("\n")}\n\n${price}, one-off, instant download 👉 ${LINK}` },
    { platform: "LinkedIn", max: PLATFORM_MAX.linkedin, text: `${x.headline}.\n\n${x.offer}\n\nWhat is inside:\n${x.inside.filter((i) => !/^start here/i.test(i)).map((i) => `• ${i}`).join("\n")}\n\n${fmt.charAt(0).toUpperCase() + fmt.slice(1)}: no software to install. ${price}, one-off: ${LINK}` },
    { platform: "Instagram", max: INSTAGRAM_MAX, text: `${x.headline} ✅\n\n${x.benefits.map((b) => `✔️ ${b}`).join("\n")}\n\nEditable files: ${fmt}. ${price}, instant download. Link in bio: ${LINK}\n\n#freelancer #smallbusiness #productivity` },
  ];
}

function imageBrief(p: Product, c: Concept): string {
  return `# Product image brief: ${p.name}${demoNote(c)}

No images were created. Make them yourself (or have them made) before listing; Payhip listings usually need at least one.

- ${c.origin?.imageBrief ?? `Show the printed or on-screen files (${c.files.map((f) => f.name).join(", ")}) with realistic example content.`}
- Use only real screenshots of these files; do not show invented customer names, reviews, ratings, sales or results.
- Suggested set: one cover image with the product name, one image of the file list, one of the main tool in use.
`;
}

/** Factory-level checks on top of the product QA. */
function factoryChecks(store: Store, p: Product, c: Concept, zip: Buffer, manifest: ReturnType<typeof zipManifest>, listingText: string, drafts: ReturnType<typeof marketingDrafts>): Check[] {
  const ck = (name: string, passed: boolean, detail: string): Check => ({ name, passed, detail: detail.slice(0, 400) });
  const zipProblems = verifyZip(zip, manifest);
  const read = store.reader(store.assetDir(p.ventureId, p.id));
  const mine = p.deliverables.filter((n) => /\.(md|csv)$/.test(n)).map((n) => read(n) ?? "").join("\n");
  const near = store.products().filter((x) => x.id !== p.id && x.status !== "archived").map((x) => {
    const r = store.reader(store.assetDir(x.ventureId, x.id));
    return { id: x.id, sim: overlap(mine, x.deliverables.filter((n) => /\.(md|csv)$/.test(n)).map((n) => r(n) ?? "").join("\n")) };
  }).filter((x) => x.sim >= NEAR_DUPLICATE_CONTENT);
  const missing = [p.name, `${p.currency} ${p.price}`, ...p.deliverables].filter((s) => !listingText.includes(s));
  const htmlUnusable = p.deliverables.filter((n) => n.endsWith(".html") && !/<(input|textarea|table)\b/.test(read(n) ?? ""));
  const draftProblems = drafts.flatMap((d) => [...misleadingClaims(d.text).map((w) => `${d.platform}: ${w}`), ...(d.text.length > d.max ? [`${d.platform}: ${d.text.length} > ${d.max} characters`] : []), ...(/https?:\/\/|www\./i.test(d.text) ? [`${d.platform}: contains a link`] : [])]);
  return [
    ck("zip-integrity", zipProblems.length === 0, zipProblems.length ? zipProblems.join("; ") : `${manifest.length} files; names, sizes and SHA-256 match the manifest; archive extracts cleanly`),
    ck("not-near-duplicate", near.length === 0, near.length ? `content too similar to ${near.map((x) => `${x.id} (${x.sim.toFixed(2)})`).join(", ")}` : "content differs from every other product"),
    ck("listing-consistency", missing.length === 0 && c.name === p.name, missing.length ? `listing does not mention: ${missing.join(", ")}` : "listing names the product, price and every file"),
    ck("usability", p.deliverables.includes("start-here.md") && htmlUnusable.length === 0, htmlUnusable.length ? `HTML files without anything to fill in: ${htmlUnusable.join(", ")}` : "start-here.md included; every HTML tool has fields to fill in"),
    ck("marketing-drafts", draftProblems.length === 0, draftProblems.length ? draftProblems.join("; ") : "3 drafts within platform limits, no claims, no links"),
  ];
}

function reviewPackage(run: { id: string; date: string; mode: FactoryMode; model: string | null }, c: Concept, p: Product, scores: readonly Scored[], checks: readonly Check[], zipName: string, names: readonly string[], dir: string): string {
  const s = scores.find((x) => x.concept === c.id)!;
  const ok = checks.every((x) => x.passed);
  const how = run.mode === "offline-template" ? "hand-written toolkit files from the offline catalogue; no AI model, network or market research was used"
    : run.mode === "mock-demo" ? "the built-in MOCK model (a demonstration of the pipeline, NOT real AI output)" : `AI-generated content from ${run.model}, validated by the factory; no market research was used`;
  const cat = (k: EvidenceCategory) => Object.entries(s.factors).filter(([, f]) => f.category === k).map(([n]) => n).join(", ") || "none";
  return `# Review package: ${p.name} (factory run ${run.id})${demoNote(c)}

- Status: **${ok ? "READY FOR YOUR REVIEW" : "NEEDS REPAIR: not ready for review"}**
- Made ${run.date} (${run.mode}): ${how}.
- Product: ${p.id} (version ${p.version}), venture ${p.ventureId}. Product files: ${path.join("ventures", p.ventureId, p.id)}
- Draft download: ${zipName} (not published anywhere)
- Nothing was published, listed, scheduled, sent, approved or bought.

## Concept and customer

- For: ${c.audience}
- Problem: ${c.problem}
- Offer: ${c.offer}
${c.origin ? `- Differentiation: ${c.origin.differentiation}\n` : ""}
## Opportunity score: ${s.total} (out of 1)

| Factor | Value | Weight | Category | Basis |
|---|---|---|---|---|
${Object.entries(s.factors).map(([k, f]) => `| ${k} | ${f.value} | ${f.weight} | ${f.category} | ${f.basis.replace(/\|/g, "/")} |`).join("\n")}

- Verified evidence: none
- AI inference: ${cat("ai-inference")}
- Owner assumptions: ${cat("owner-assumption")}
- Unknown: ${cat("unknown")}

Other concepts considered: ${scores.filter((x) => x.concept !== c.id).map((x) => `${x.name} ${x.total}${x.excluded ? ` (excluded: ${x.excluded})` : ""}`).join("; ") || "none"}.

The score ranks concepts by stated assumptions${c.origin ? " and AI reasoning" : ""}; it is not market evidence or a sales forecast.

## Files

| File | Bytes | SHA-256 (first 12) |
|---|---|---|
${p.files.map((f) => `| ${f.name} | ${f.bytes} | ${f.sha256.slice(0, 12)} |`).join("\n")}

Review package files (${dir}): ${names.join(", ")}

## Automated quality checks

| Check | Result | Detail |
|---|---|---|
${checks.map((x) => `| ${x.name} | ${x.passed ? "pass" : "FAIL"} | ${x.detail.replace(/\|/g, "/")} |`).join("\n")}

## Price

${p.currency} ${p.price}. ${c.priceRationale}

## Risks, assumptions and missing information

- No customer has seen this product; usefulness and monetisation ratings are ${c.origin ? "AI inferences" : "assumptions"}.
- Demand and competing products are unknown: check what similar products exist and cost before launching.
${(c.origin?.risks ?? []).map((r) => `- Risk: ${r}`).join("\n")}
${(c.origin?.assumptions ?? []).map((r) => `- Assumption: ${r}`).join("\n")}
- No product images were made (see image-brief.md).

## Owner approval checklist (each step is yours; nothing here happens automatically)

1. [ ] Read every product file and open the ZIP; edit anything that does not fit your business.
2. [ ] Read listing.md, marketing-drafts.md and image-brief.md; change the wording you do not like.
3. [ ] Sign off the price and content: \`product sign-off ${p.id}\` (shows the code), then run it with --confirm in a terminal.
4. [ ] Request the launch: \`product request-launch ${p.id}\`, then \`approve <approval id>\`.
5. [ ] Create the Payhip listing yourself from listing.md and upload the ZIP.
6. [ ] Record the live page: \`product mark-live ${p.id} --url <your Payhip URL>\`.
7. [ ] Only then create a campaign with that URL: \`campaign create ${p.id} --url <your Payhip URL>\` and approve each post.
`;
}

export interface FactoryResult { readonly run: FactoryRun; readonly reused: boolean; readonly scores: readonly Scored[] }

function startRun(store: Store, now: Date, mode: FactoryMode) {
  const why = stopReason(store.dir);
  if (why) throw new Error(`STOP is set (${why}): the factory does not run until 'resume'`);
  const date = londonDate(now);
  const today = store.factoryRuns().find((r) => r.date === date && (r.mode ?? MODE) === mode);
  return { date, today };
}
function newRunDir(store: Store) {
  const id = newId("fct"), dir = factoryDir(store, id);
  ensurePrivateDir(path.dirname(dir)); ensurePrivateDir(dir);
  const files: Asset[] = [];
  return { id, dir, files, write: store.writer(dir, files) };
}
function record(store: Store, now: Date, run: FactoryRun, extra: Record<string, unknown> = {}): FactoryRun {
  store.saveFactoryRuns([...store.factoryRuns(), run]);
  store.audit({ kind: "factory-run", run: run.id, mode: run.mode, status: run.status, concept: run.concept, product: run.productId, failed: run.failedChecks, modelCalls: run.modelCalls ?? 0, ...extra }, now);
  return run;
}

/** Builds the product for a selected concept and writes the ZIP and the review package. */
function produce(store: Store, now: Date, r: ReturnType<typeof newRunDir>, base: { date: string; mode: FactoryMode; model: string | null; modelCalls: number }, c: Concept, pick: Scored, scores: readonly Scored[], extraChecks: readonly Check[] = []): FactoryRun {
  const at = now.toISOString();
  const venture: Venture = { id: newId("ven"), status: "factory-draft", experiments: [], decisions: [], createdAt: at, updatedAt: at,
    opportunity: { id: newId("opp"), kind: "digital-product", title: c.name, problem: c.problem, audience: c.audience, offer: c.offer,
      estimates: { demand: 0, feasibility: c.ratings.simplicity, risk: 0.1, costUsd: 0 }, score: pick.total, createdAt: at, source: `factory:${c.id}` } };
  store.saveVentures([...store.ventures(), venture]);
  const currency = store.products().find((x) => x.status === "live")?.currency ?? "GBP";
  const p = buildProduct(store, venture.id, { now, price: c.price, currency });
  const read = store.reader(store.assetDir(p.ventureId, p.id));
  const landing = read("landing.html") ?? "";
  const entries = p.deliverables.map((n) => ({ name: n, data: Buffer.from(read(n) ?? "", "utf8") }));
  const manifest = zipManifest(entries);
  const zipName = `${c.id.replace(/[^a-z0-9-]/g, "").slice(0, 50) || "product"}.zip`;
  const zip = makeZip(entries);
  fs.writeFileSync(path.join(r.dir, zipName), zip, { mode: 0o600, flag: "wx" });
  r.files.push({ name: zipName, bytes: zip.length, sha256: createHash("sha256").update(zip).digest("hex") });
  const onDisk = fs.readFileSync(path.join(r.dir, zipName));
  const listingText = listing(p, c, landing);
  const drafts = marketingDrafts(p, c, landing);
  const checks = [...p.checks, ...factoryChecks(store, p, c, onDisk, manifest, listingText, drafts), ...extraChecks];
  const failed = checks.filter((x) => !x.passed).map((x) => x.name);
  const status: FactoryStatus = failed.length ? "needs-repair" : "review-ready";
  r.write("listing.md", listingText);
  r.write("marketing-drafts.md", `# Marketing drafts: ${p.name}${demoNote(c)}\n\nDrafts only: nothing was posted or scheduled. Replace ${LINK} with your live Payhip address only after the launch is approved, and post only where self-promotion is allowed.\n\n${drafts.map((d) => `## ${d.platform} (${d.text.length} of ${d.max} characters)\n\n\`\`\`text\n${d.text}\n\`\`\``).join("\n\n")}\n`);
  r.write("image-brief.md", imageBrief(p, c));
  r.write("zip-manifest.json", JSON.stringify({ archive: zipName, bytes: zip.length, files: manifest }, null, 2) + "\n");
  r.write("review-package.md", reviewPackage({ id: r.id, date: base.date, mode: base.mode, model: base.model }, c, p, scores, checks, zipName, [...r.files.map((f) => f.name), "review-package.md", "summary.json"], r.dir));
  const summary = { id: r.id, date: base.date, startedAt: at, mode: base.mode, model: base.model, modelCalls: base.modelCalls, demonstration: base.mode === "mock-demo", status,
    concept: { id: c.id, name: c.name, audience: c.audience, problem: c.problem, differentiation: c.origin?.differentiation ?? null }, scores, selected: pick,
    product: { id: p.id, ventureId: p.ventureId, version: p.version, status: p.status, price: p.price, currency: p.currency, priceRationale: c.priceRationale, files: p.files },
    checks, zip: { name: zipName, bytes: zip.length, files: manifest },
    evidence: { verified: [], demand: "unverified", competition: "unknown", sales: "none" }, imagesCreated: false, published: false, approved: false, packageFiles: [...r.files.map((f) => f.name), "summary.json"] };
  r.write("summary.json", JSON.stringify(summary, null, 2) + "\n");
  return record(store, now, { id: r.id, date: base.date, startedAt: at, mode: base.mode, status, concept: c.id, ventureId: venture.id, productId: p.id, score: pick.total, failedChecks: failed, dir: r.dir, files: r.files, model: base.model, modelCalls: base.modelCalls, reason: null, zip: zipName });
}

/** Offline run from the hand-written catalogue. */
export function runFactory(store: Store, cfg: EngineConfig, now: Date, opts: { offline: boolean; concepts?: readonly Concept[] }): FactoryResult {
  if (!opts.offline) throw new Error("use 'factory run --offline' (catalogue) or 'factory run --ai' (model); nothing was generated");
  const { date, today } = startRun(store, now, "offline-template");
  if (today) return { run: today, reused: true, scores: [] };
  const concepts = (opts.concepts ?? [...CONCEPTS, ...EXTRA_CONCEPTS]).filter((c) => !c.origin);
  const scores = scoreConcepts(store, concepts);
  const pick = scores.find((s) => s.eligible);
  const r = newRunDir(store);
  if (!pick) {
    r.write("summary.json", JSON.stringify({ id: r.id, date, mode: "offline-template", status: "no-eligible-concept", scores }, null, 2) + "\n");
    return { run: record(store, now, { id: r.id, date, startedAt: now.toISOString(), mode: "offline-template", status: "no-eligible-concept", concept: null, ventureId: null, productId: null, score: null, failedChecks: [], dir: r.dir, files: r.files }), reused: false, scores };
  }
  return { run: produce(store, now, r, { date, mode: "offline-template", model: null, modelCalls: 0 }, concepts.find((c) => c.id === pick.concept)!, pick, scores), reused: false, scores };
}

/**
 * AI run. `client` comes from the configured provider (or the mock). Paid clients need paidApproved and a worst-case
 * cost within maxGbpPerRun before the first call; failures stop the run (no catalogue fallback).
 */
export async function runAiFactory(store: Store, cfg: EngineConfig, now: Date, opts: { client: ModelClient | null; mock: boolean; paidApproved: boolean }): Promise<FactoryResult> {
  const mode: FactoryMode = opts.mock ? "mock-demo" : "ai";
  const { client } = opts;
  const { date, today } = startRun(store, now, mode);
  if (today) return { run: today, reused: true, scores: [] };
  if (!client) throw new Error("AI mode is unavailable: no model provider is configured (config.json model.provider is \"none\"). Nothing was generated. Check with 'factory preflight'; 'factory run --ai --mock' shows a labelled demonstration.");
  if (client.paid && !opts.paidApproved) throw new Error(`the configured provider (${client.id}) is paid: it needs config.json model.paidUsageApproved = true AND 'factory run --ai --paid'. No call was made and nothing was generated.`);
  const existing = [...new Set([...store.products().filter((p) => p.status !== "archived").map((p) => p.name), ...store.factoryRuns().map((x) => x.concept ?? "").filter(Boolean)])];
  const prompt1 = ideasPrompt(existing);
  const maxTokens = productMaxTokens(cfg);
  if (client.paid) {
    const est = estimateRunGbp(cfg, [{ prompt: prompt1, maxTokens: IDEAS_MAX_TOKENS }, { prompt: "x".repeat(4000), maxTokens }]) ?? Infinity;
    if (est > (cfg.model.maxGbpPerRun ?? 1)) throw new Error(`budget: a factory run can cost up to £${est}, more than model.maxGbpPerRun (£${cfg.model.maxGbpPerRun ?? 1}). No call was made.`);
  }
  const log: Record<string, unknown>[] = [];
  const budget = new ModelBudget(MAX_MODEL_CALLS);
  let calls = 0; // calls actually sent (the budget is closed early after a paid failure)
  const counted: ModelClient = { id: client.id, paid: client.paid, complete: (req) => { calls += 1; return client.complete(req); } };
  const use = { client: counted, budget, log: (e: Record<string, unknown>) => log.push(e), paidApproved: opts.paidApproved };
  const r = newRunDir(store);
  const answers: Record<string, unknown> = {};
  // The model's answers are kept (private, mode 600) so a paid answer is never lost: the owner can inspect or repair it.
  const keep = () => { if (Object.keys(answers).length) r.write("model-answers.json", JSON.stringify(answers, null, 2) + "\n"); };
  const fail = (reason: string, scores: Scored[] = []): FactoryResult => {
    keep();
    r.write("summary.json", JSON.stringify({ id: r.id, date, mode, model: client.id, status: "ai-failed", reason, modelLog: log, scores, generated: false }, null, 2) + "\n");
    return { run: record(store, now, { id: r.id, date, startedAt: now.toISOString(), mode, status: "ai-failed", concept: null, ventureId: null, productId: null, score: null, failedChecks: [], dir: r.dir, files: r.files, model: client.id, modelCalls: calls, reason }), reused: false, scores };
  };
  const why = (purpose: string) => String(log.filter((e) => e.purpose === purpose).at(-1)?.reason ?? log.filter((e) => e.purpose === purpose).at(-1)?.error ?? "no answer");
  let rejected: string[] = [];
  const ideas = await askJson(use, "factory-ideas", prompt1, (v) => { answers.ideas = v; const x = validateIdeas(v); if (x) rejected = x.rejected; return x?.ideas ?? null; }, IDEAS_MAX_TOKENS);
  if (!ideas) return fail(`the model's ideas were unusable (${why("factory-ideas")}); nothing was generated in their place`);
  const ids = new Map(ideas.map((i) => [i.slug, i] as [string, AiIdea]));
  const scores = scoreCandidates(store, ideas.map((i) => ({ id: `${opts.mock ? "mock" : "ai"}-${i.slug}`, name: i.name, problem: i.problem, ai: true, needsAdvice: ideaNeedsAdvice(i),
    ratings: { usefulness: i.usefulness, simplicity: { low: 0.85, medium: 0.65, high: 0.4 }[i.complexity], monetisation: i.monetisation },
    reasons: { usefulness: i.usefulnessRationale, simplicity: `${i.complexity} complexity (owner rule: low 0.85, medium 0.65, high 0.4)`, monetisation: i.monetisationRationale } })));
  const pick = scores.find((s) => s.eligible);
  if (!pick) return fail(`no eligible idea (${scores.map((s) => `${s.name}: ${s.excluded}`).join("; ")}${rejected.length ? `; rejected: ${rejected.join("; ")}` : ""})`, scores);
  const idea = ids.get(pick.concept.replace(/^(mock|ai)-/, ""))!;
  let problems: string[] = [];
  const spec = await askJson(use, "factory-product", productPrompt(idea, maxTokens), (v) => { answers.product = v; const x = validateSpec(v); if ("problems" in x) { problems = x.problems; return null; } return x.spec as ProductSpec; }, maxTokens);
  if (!spec) return fail(`the model's product was unusable (${problems.length ? problems.slice(0, 6).join("; ") : why("factory-product")}); nothing was generated in its place`, scores);
  const c = specToConcept(spec, idea, pick.concept, { mode: opts.mock ? "mock-demo" : "ai", model: client.id, run: r.id });
  store.saveAiConcepts([...store.aiConcepts().filter((x) => x.id !== c.id), c]);
  if (!EXTRA_CONCEPTS.some((x) => x.id === c.id)) EXTRA_CONCEPTS.push(c);
  r.write("model-log.json", JSON.stringify({ model: client.id, calls, log, rejectedIdeas: rejected }, null, 2) + "\n");
  keep();
  return { run: produce(store, now, r, { date, mode, model: client.id, modelCalls: calls }, c, pick, scores, [outputCheck(spec)]), reused: false, scores };
}

const outputCheck = (spec: ProductSpec): Check => {
  const dropped = spec.dropped ?? [], repairs = spec.repairs ?? [];
  return { name: "model-output-complete", passed: dropped.length === 0,
    detail: ((dropped.length ? `left out (could not be repaired safely): ${dropped.join("; ")}` : "every file the model wrote was usable") + (repairs.length ? `; safe repairs: ${repairs.join("; ")}` : "")).slice(0, 400) };
};

/** Runs whose saved model answers could be rebuilt locally: ai-failed, answers kept, not yet recovered. */
export function recoverable(store: Store): FactoryRun[] {
  const runs = store.factoryRuns();
  return runs.filter((r) => r.status === "ai-failed" && !runs.some((x) => x.recoveredFrom === r.id) && store.reader(r.dir)("model-answers.json") !== null);
}

/**
 * Rebuilds a failed AI run from its SAVED model answers with the current validators and local repairs. No model is
 * called, so it costs nothing; the result goes through the full QA and stays in review (or needs repair).
 */
export function recoverRun(store: Store, now: Date, runId: string): FactoryResult {
  const why = stopReason(store.dir);
  if (why) throw new Error(`STOP is set (${why}): nothing was recovered`);
  const runs = store.factoryRuns();
  const old = runs.find((r) => r.id === runId);
  if (!old) throw new Error(`no factory run ${runId}`);
  if (old.status !== "ai-failed") throw new Error(`${runId} is ${old.status}: only ai-failed runs are recovered (needs-repair runs already have a product to edit)`);
  const done = runs.find((r) => r.recoveredFrom === runId);
  if (done) throw new Error(`${runId} was already recovered in ${done.id}`);
  const raw = store.reader(old.dir)("model-answers.json");
  if (raw === null) throw new Error(`${runId} has no saved model answers (runs before the CSV fix did not keep them): it cannot be recovered without a new model call, which needs your approval`);
  let answers: { ideas?: unknown; product?: unknown };
  try { answers = JSON.parse(raw); } catch { throw new Error(`${runId}: model-answers.json is not valid JSON`); }
  const ideas = validateIdeas(answers.ideas)?.ideas;
  if (!ideas) throw new Error(`${runId}: the saved ideas are still unusable`);
  const v = validateSpec(answers.product);
  if ("problems" in v) throw new Error(`${runId}: the saved product is still unusable after local repairs (${v.problems.slice(0, 4).join("; ")})`);
  const prefix = old.mode === "mock-demo" ? "mock" : "ai";
  const scores = scoreCandidates(store, ideas.map((i) => ({ id: `${prefix}-${i.slug}`, name: i.name, problem: i.problem, ai: true, needsAdvice: ideaNeedsAdvice(i),
    ratings: { usefulness: i.usefulness, simplicity: { low: 0.85, medium: 0.65, high: 0.4 }[i.complexity], monetisation: i.monetisation },
    reasons: { usefulness: i.usefulnessRationale, simplicity: `${i.complexity} complexity (owner rule: low 0.85, medium 0.65, high 0.4)`, monetisation: i.monetisationRationale } })));
  const pick = scores.find((s) => s.eligible && ideas.find((i) => `${prefix}-${i.slug}` === s.concept)?.name === v.spec.name) ?? scores.find((s) => s.eligible);
  if (!pick) throw new Error(`${runId}: no saved idea is eligible any more (${scores.map((s) => `${s.name}: ${s.excluded}`).join("; ")})`);
  const idea = ideas.find((i) => `${prefix}-${i.slug}` === pick.concept)!;
  const r = newRunDir(store);
  r.write("model-answers.json", raw);
  const model = `${old.model ?? "model"} (recovered from saved answers of ${runId})`;
  const c = specToConcept(v.spec, idea, pick.concept, { mode: prefix === "mock" ? "mock-demo" : "ai", model, run: r.id });
  store.saveAiConcepts([...store.aiConcepts().filter((x) => x.id !== c.id), c]);
  if (!EXTRA_CONCEPTS.some((x) => x.id === c.id)) EXTRA_CONCEPTS.push(c);
  const run = produce(store, now, r, { date: londonDate(now), mode: old.mode, model, modelCalls: 0 }, c, pick, scores, [outputCheck(v.spec)]);
  const all = store.factoryRuns();
  const tagged = { ...run, recoveredFrom: runId };
  store.saveFactoryRuns(all.map((x) => (x.id === run.id ? tagged : x)));
  store.audit({ kind: "factory-recovered", run: run.id, from: runId, status: run.status, modelCalls: 0 }, now);
  return { run: tagged, reused: false, scores };
}

export const FACTORY_USAGE = "factory run --offline | factory run --ai [--paid] | factory run --ai --mock | factory recover <run> | factory preflight | factory list | factory show <run>";

export async function factoryCli(args: readonly string[], ctx: { store: Store; cfg: EngineConfig; out: (s: string) => void; now: () => Date; model: (paid: boolean) => ModelClient | null }): Promise<number> {
  const [sub, ...rest] = args;
  const { store, out, cfg } = ctx;
  if (sub === "run") {
    const bad = rest.find((a) => !["--offline", "--ai", "--paid", "--mock"].includes(a));
    const ai = rest.includes("--ai"), offline = rest.includes("--offline"), mock = rest.includes("--mock"), paid = rest.includes("--paid");
    if (bad || ai === offline || (!ai && (mock || paid)) || (mock && paid)) throw new Error(`${bad ? `unknown option ${bad}: ` : ""}${FACTORY_USAGE}`);
    const r = await withLock(store.dir, async () => {
      if (offline) return runFactory(store, cfg, ctx.now(), { offline: true });
      if (mock) return runAiFactory(store, cfg, ctx.now(), { client: mockModel(), mock: true, paidApproved: false });
      const ready = aiReadiness(store, cfg, ctx.now());
      if (cfg.model.provider === "claude" && !paid) throw new Error("the configured provider (claude) is paid: run 'factory run --ai --paid' only after you approve the cost. No call was made.");
      if (cfg.model.provider === "claude" && !ready.ready) throw new Error(`AI mode is not ready: ${ready.reasons.join("; ")}. No call was made.`);
      return runAiFactory(store, cfg, ctx.now(), { client: ctx.model(paid), mock: false, paidApproved: paid && cfg.model.paidUsageApproved === true });
    });
    const x = r.run;
    if (x.mode === "mock-demo") out("MOCK DEMONSTRATION: the built-in mock model, not real AI.\n");
    out(`${r.reused ? "already ran today: " : ""}factory run ${x.id} (${x.date}, ${x.mode}): ${x.status}${x.productId ? `, product ${x.productId} (${x.concept}), score ${x.score}` : ""}${x.modelCalls ? `, ${x.modelCalls} model call(s)` : ""}\n`);
    if (x.reason) out(`reason: ${x.reason}\n`);
    if (x.failedChecks.length) out(`failed checks: ${x.failedChecks.join(", ")}\n`);
    out(`review package: ${path.join(x.dir, x.productId ? "review-package.md" : "summary.json")}\nNothing was published, listed, scheduled, sent, approved or bought.\n`);
    return x.status === "review-ready" || x.status === "no-eligible-concept" ? 0 : 1;
  }
  if (sub === "recover") {
    if (rest.length !== 1) throw new Error("factory recover <run>");
    const { run: x } = await withLock(store.dir, async () => recoverRun(store, ctx.now(), rest[0]));
    out(`recovered ${rest[0]} locally (no model call) as ${x.id}: ${x.status}, product ${x.productId}${x.failedChecks.length ? `; failed checks: ${x.failedChecks.join(", ")}` : ""}\nreview package: ${path.join(x.dir, "review-package.md")}\nNothing was published, listed, scheduled, sent, approved or bought.\n`);
    return x.status === "review-ready" ? 0 : 1;
  }
  if (sub === "preflight") {
    const r = aiReadiness(store, cfg, ctx.now());
    out(`AI provider: ${r.provider}\nready: ${r.ready ? "yes" : "no"}\n${r.reasons.map((x) => `- ${x}`).join("\n")}\n${r.estimatedMaxGbpPerRun !== null ? `worst-case cost of one AI factory run: £${r.estimatedMaxGbpPerRun} (${MAX_MODEL_CALLS} calls)\n` : ""}${r.ledgerRemainingGbp !== null ? `ledger remaining: £${r.ledgerRemainingGbp}\n` : ""}No network call or token was used. ${cfg.model.provider === "claude" ? "For a free check that the key and model are accepted, run 'claude-check'." : ""}\n`);
    return r.ready ? 0 : 1;
  }
  if (sub === "list") { const rs = store.factoryRuns(); out(rs.length ? rs.map((x) => `${x.id} ${x.date} ${x.mode ?? MODE} ${x.status} ${x.concept ?? "-"} ${x.productId ?? "-"}`).join("\n") + "\n" : "no factory runs\n"); return 0; }
  if (sub === "show") {
    const x = store.factoryRuns().find((y) => y.id === rest[0]);
    if (!x) throw new Error(`no factory run ${rest[0] ?? ""}`);
    const text = store.reader(x.dir)("review-package.md");
    if (text !== null && sha256(text) !== x.files.find((f) => f.name === "review-package.md")?.sha256) out("note: review-package.md was edited after the run\n");
    out(text ?? (store.reader(x.dir)("summary.json") ?? JSON.stringify(x, null, 2)) + "\n");
    return 0;
  }
  out(`Usage: ${FACTORY_USAGE}\n`);
  return 2;
}
