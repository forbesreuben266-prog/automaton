/**
 * AI mode of the product factory: prompts, strict validators, conversion of a model's product spec into a toolkit
 * Concept (rendered Markdown, CSV and offline HTML worksheets), a deterministic MOCK model for tests and
 * demonstrations, and a no-network readiness check.
 *
 * Every model answer is untrusted: it must be JSON and pass the validators below (types, sizes, safe file names,
 * consistent CSV rows, no claimed market evidence, no misleading claims), otherwise the run fails and nothing is
 * generated in its place. HTML is never taken from the model: worksheets are rendered here from a field list, with no
 * scripts and a Content-Security-Policy that blocks every network request.
 */

import fs from "node:fs";
import path from "node:path";
import { concept, type Concept } from "./blueprints/toolkit.js";
import { csv, esc, type ProductFile } from "./blueprints/common.js";
import { anthropicEnvVars, maxCostGbp } from "./claude.js";
import { type EngineConfig } from "./control.js";
import { HARD_CAP_GBP, Ledger } from "./ledger.js";
import { text, type ModelClient } from "./model.js";
import { isSensitive, misleadingClaims } from "./products.js";
import type { Store } from "./store.js";

export const IDEAS_MAX_TOKENS = 1500;
/** Worst-case size of the system message askJson sends (the bound is generous on purpose). */
const SYSTEM_BOUND = "x".repeat(600);

// ---------------------------------------------------------------- ideas

export interface AiIdea {
  readonly slug: string; readonly name: string; readonly customer: string; readonly problem: string; readonly concept: string;
  readonly fileTypes: readonly ("markdown" | "csv" | "html")[]; readonly differentiation: string; readonly complexity: "low" | "medium" | "high";
  readonly usefulness: number; readonly usefulnessRationale: string; readonly monetisation: number; readonly monetisationRationale: string;
  readonly demandEvidence: "unverified"; readonly competitionEvidence: "unverified"; readonly risks: readonly string[]; readonly assumptions: readonly string[];
}

export function ideasPrompt(existing: readonly string[]): string {
  return `PURPOSE: ideas
Propose 3 to 5 ORIGINAL downloadable digital products for freelancers and small businesses: practical tools (templates, trackers,
worksheets, checklists), not ebooks. They must not duplicate these existing products: ${existing.map((x) => JSON.stringify(x)).join(", ") || "none"}.
Avoid anything needing legal, tax, financial, medical or insurance advice. You have NO market data: do not state demand, sales,
prices of competitors, statistics or reviews. Return JSON only:
{"ideas":[{"slug":"kebab-case-id","name":"...","customer":"...","problem":"...","concept":"what the product is",
"fileTypes":["markdown","csv","html"],"differentiation":"how it differs from the existing products","complexity":"low|medium|high",
"usefulness":0.0-1.0,"usefulnessRationale":"...","monetisation":0.0-1.0,"monetisationRationale":"...",
"demandEvidence":"unverified","competitionEvidence":"unverified","risks":["..."],"assumptions":["..."]}]}`;
}

const list = (v: unknown, min: number, max: number, len: number): string[] | null => {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const out = v.map((x) => text(x, len));
  return out.every((x): x is string => x !== null) ? out : null;
};
const clean = (o: Record<string, unknown>) => JSON.stringify(o);

/** Validates the ideas answer; ideas that claim evidence, make misleading claims or break the format are dropped (with reasons). */
export function validateIdeas(v: unknown): { ideas: AiIdea[]; rejected: string[] } | null {
  const raw = (v as { ideas?: unknown })?.ideas;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 6) return null;
  const ideas: AiIdea[] = [], rejected: string[] = [];
  for (const x of raw as Record<string, unknown>[]) {
    const s = typeof x?.slug === "string" ? x.slug.slice(0, 40) : "?";
    const f = {
      slug: typeof x?.slug === "string" && /^[a-z0-9][a-z0-9-]{2,39}$/.test(x.slug) ? x.slug : null,
      name: text(x?.name, 60), customer: text(x?.customer, 120), problem: text(x?.problem, 240), concept: text(x?.concept, 400),
      fileTypes: Array.isArray(x?.fileTypes) && x.fileTypes.length >= 1 && x.fileTypes.every((t) => ["markdown", "csv", "html"].includes(t as string)) ? [...new Set(x.fileTypes as AiIdea["fileTypes"])] : null,
      differentiation: text(x?.differentiation, 300), complexity: ["low", "medium", "high"].includes(x?.complexity as string) ? x.complexity as AiIdea["complexity"] : null,
      usefulness: typeof x?.usefulness === "number" && x.usefulness >= 0 && x.usefulness <= 1 ? x.usefulness : null, usefulnessRationale: text(x?.usefulnessRationale, 300),
      monetisation: typeof x?.monetisation === "number" && x.monetisation >= 0 && x.monetisation <= 1 ? x.monetisation : null, monetisationRationale: text(x?.monetisationRationale, 300),
      risks: list(x?.risks, 1, 6, 200), assumptions: list(x?.assumptions, 1, 6, 200),
    };
    const missing = Object.entries(f).filter(([, val]) => val === null).map(([k]) => k);
    if (missing.length) { rejected.push(`${s}: invalid ${missing.join(", ")}`); continue; }
    if (x.demandEvidence !== "unverified" || x.competitionEvidence !== "unverified") { rejected.push(`${s}: claimed market evidence the model cannot have`); continue; }
    const claims = misleadingClaims(clean(x));
    if (claims.length) { rejected.push(`${s}: ${claims.join(", ")}`); continue; }
    ideas.push({ ...(f as Omit<AiIdea, "demandEvidence" | "competitionEvidence">), demandEvidence: "unverified", competitionEvidence: "unverified" });
  }
  return ideas.length ? { ideas, rejected } : null;
}

// ---------------------------------------------------------------- product spec

type Field = { label: string; type: "text" | "number" | "date" | "checkbox" | "textarea" };
export type SpecFile =
  | { name: string; kind: "markdown"; description: string; template: boolean; content: string }
  | { name: string; kind: "csv"; description: string; template: boolean; header: string[]; rows: (string | number)[][] }
  | { name: string; kind: "html"; description: string; title: string; intro: string; sections: { heading: string; fields: Field[]; repeat: number }[] };
export interface ProductSpec {
  readonly name: string; readonly headline: string; readonly subheadline: string; readonly offer: string; readonly hook: string;
  readonly benefits: readonly string[]; readonly faq: readonly { q: string; a: string }[]; readonly setup: readonly string[];
  readonly price: number; readonly priceRationale: string; readonly imageBrief: string; readonly files: readonly SpecFile[];
}

export function productPrompt(idea: AiIdea, maxTokens: number): string {
  return `PURPOSE: product
Write the complete product "${idea.name}" for ${idea.customer}. Problem: ${idea.problem}. Concept: ${idea.concept}.
Make it genuinely usable: real wording, real steps, real example rows; no placeholders except buyer fill-in fields written [[Like this]]
in files marked "template": true. No legal, tax or financial advice; no claims about results, demand, customers or income.
3 to 8 files; do NOT include start-here.md (it is generated). Stay within ${maxTokens} output tokens. Return JSON only:
{"name":"...","headline":"...","subheadline":"...","offer":"...","hook":"one plain opening line for social posts",
"benefits":["3-6 items"],"faq":[{"q":"...","a":"..."}],"setup":["2-6 setup steps"],"price":number (GBP, a suggestion),"priceRationale":"...",
"imageBrief":"what product images should show",
"files":[{"name":"guide.md","kind":"markdown","description":"...","template":false,"content":"# Markdown with - bullet points"},
{"name":"tracker.csv","kind":"csv","description":"...","template":true,"header":["..."],"rows":[["example row"]]},
{"name":"worksheet.html","kind":"html","description":"...","title":"...","intro":"...","sections":[{"heading":"...","repeat":3,"fields":[{"label":"...","type":"text|number|date|checkbox|textarea"}]}]}]}`;
}

const FILE = /^[a-z0-9][a-z0-9-]{1,40}\.(md|csv|html)$/;
const EXT = { markdown: ".md", csv: ".csv", html: ".html" } as const;

/** Strict validation of the product answer. Returns the spec or a list of problems. */
export function validateSpec(v: unknown): { spec: ProductSpec } | { problems: string[] } {
  const x = v as Record<string, unknown>;
  const p: string[] = [];
  const t = (k: string, max: number) => { const r = text(x?.[k], max); if (r === null) p.push(`${k}: text up to ${max} characters`); return r ?? ""; };
  const spec = {
    name: t("name", 60), headline: t("headline", 120), subheadline: t("subheadline", 240), offer: t("offer", 400), hook: t("hook", 200),
    benefits: list(x?.benefits, 3, 6, 160) ?? (p.push("benefits: 3 to 6 items"), []),
    faq: Array.isArray(x?.faq) && x.faq.length >= 1 && x.faq.length <= 4 ? (x.faq as Record<string, unknown>[]).map((f) => ({ q: text(f?.q, 160) ?? "", a: text(f?.a, 400) ?? "" })) : (p.push("faq: 1 to 4 items"), []),
    setup: list(x?.setup, 2, 6, 200) ?? (p.push("setup: 2 to 6 steps"), []),
    price: typeof x?.price === "number" && x.price >= 1 && x.price <= 100 ? Math.round(x.price) : (p.push("price: a number from 1 to 100"), 0),
    priceRationale: t("priceRationale", 300), imageBrief: t("imageBrief", 800), files: [] as SpecFile[],
  };
  if (spec.faq.some((f) => !f.q || !f.a)) p.push("faq: each item needs q and a");
  const files = Array.isArray(x?.files) ? x.files as Record<string, unknown>[] : [];
  if (files.length < 3 || files.length > 8) p.push("files: 3 to 8 files");
  const names = new Set<string>();
  for (const f of files.slice(0, 8)) {
    const name = typeof f?.name === "string" ? f.name : "";
    const kind = f?.kind as keyof typeof EXT;
    if (!FILE.test(name) || name === "start-here.md" || !EXT[kind] || !name.endsWith(EXT[kind])) { p.push(`file ${JSON.stringify(name.slice(0, 40))}: needs a safe lowercase name whose extension matches its kind (not start-here.md)`); continue; }
    if (names.has(name)) { p.push(`file ${name}: duplicate`); continue; }
    names.add(name);
    const description = text(f.description, 160);
    if (!description) { p.push(`${name}: description`); continue; }
    if (kind === "markdown") {
      const content = typeof f.content === "string" && f.content.length <= 20_000 ? f.content.replace(/\r\n/g, "\n").trim() + "\n" : null;
      if (!content || content.trim().length < 200 || /<script|<iframe|javascript:/i.test(content)) { p.push(`${name}: Markdown content of 200 to 20000 characters, without HTML scripts`); continue; }
      spec.files.push({ name, kind, description, template: f.template === true, content });
    } else if (kind === "csv") {
      const header = list(f.header, 2, 12, 40);
      const rows = Array.isArray(f.rows) && f.rows.length >= 1 && f.rows.length <= 30 && header && (f.rows as unknown[]).every((r) => Array.isArray(r) && r.length === header.length && r.every((c) => (typeof c === "string" && c.length <= 200 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(c)) || (typeof c === "number" && Number.isFinite(c)))) ? f.rows as (string | number)[][] : null;
      if (!header || new Set(header).size !== header.length || !rows) { p.push(`${name}: CSV needs 2-12 unique column names and 1-30 rows with exactly that many cells`); continue; }
      spec.files.push({ name, kind, description, template: f.template === true, header, rows });
    } else {
      const title = text(f.title, 120), intro = text(f.intro, 600);
      const sections = Array.isArray(f.sections) && f.sections.length >= 1 && f.sections.length <= 8 ? (f.sections as Record<string, unknown>[]).map((s) => ({
        heading: text(s?.heading, 100), repeat: Number.isInteger(s?.repeat) && (s.repeat as number) >= 1 && (s.repeat as number) <= 20 ? s.repeat as number : null,
        fields: Array.isArray(s?.fields) && s.fields.length >= 1 && s.fields.length <= 15 ? (s.fields as Record<string, unknown>[]).map((q) => ({ label: text(q?.label, 80), type: ["text", "number", "date", "checkbox", "textarea"].includes(q?.type as string) ? q.type as Field["type"] : null })) : null,
      })) : null;
      if (!title || !intro || !sections || sections.some((s) => !s.heading || !s.repeat || !s.fields || s.fields.some((q) => !q.label || !q.type))) { p.push(`${name}: HTML worksheet needs title, intro and 1-8 sections with headings, repeat 1-20 and 1-15 labelled fields`); continue; }
      spec.files.push({ name, kind, description, title, intro, sections: sections as { heading: string; fields: Field[]; repeat: number }[] });
    }
  }
  const claims = misleadingClaims(JSON.stringify(x ?? {}));
  if (claims.length) p.push(`misleading claims: ${claims.join(", ")}`);
  return p.length ? { problems: p } : { spec: spec as ProductSpec };
}

/** An offline, printable worksheet: inputs only, no scripts, a CSP that blocks all network access. */
export function worksheetHtml(f: Extract<SpecFile, { kind: "html" }>): string {
  const input = (q: Field, id: string) => q.type === "textarea" ? `<textarea id="${id}" rows="3"></textarea>` : `<input id="${id}" type="${q.type}">`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(f.title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 1rem;color:#111}fieldset{margin:1rem 0;border:1px solid #bbb}
label{display:block;margin:.4rem 0}input,textarea{width:100%;box-sizing:border-box;padding:.3rem;font:inherit}input[type=checkbox]{width:auto}
@media print{.hint{display:none}input,textarea{border:none;border-bottom:1px solid #999}}</style>
</head><body>
<h1>${esc(f.title)}</h1>
<p>${esc(f.intro)}</p>
<p class="hint"><small>Works offline in any web browser. Type into the boxes, then print or save as PDF. Nothing you type is sent anywhere or saved: print or save before closing the page.</small></p>
${f.sections.map((s, si) => Array.from({ length: s.repeat }, (_, ri) => `<fieldset><legend>${esc(s.heading)}${s.repeat > 1 ? ` ${ri + 1}` : ""}</legend>
${s.fields.map((q, qi) => `<label for="f${si}-${ri}-${qi}">${esc(q.label)}</label>${input(q, `f${si}-${ri}-${qi}`)}`).join("\n")}
</fieldset>`).join("\n")).join("\n")}
</body></html>
`;
}

/** Turns a validated spec into a toolkit Concept (start-here.md is added by concept()). */
export function specToConcept(spec: ProductSpec, idea: AiIdea, id: string, origin: { mode: "ai" | "mock-demo"; model: string; run: string }): Concept {
  const files: ProductFile[] = spec.files.map((f) => f.kind === "markdown" ? { name: f.name, description: f.description, template: f.template, text: f.content }
    : f.kind === "csv" ? { name: f.name, description: f.description, template: f.template, text: csv([f.header, ...f.rows]) }
    : { name: f.name, description: f.description, template: false, text: worksheetHtml(f) });
  const simplicity = { low: 0.85, medium: 0.65, high: 0.4 }[idea.complexity];
  const label = origin.mode === "mock-demo" ? "MOCK DEMONSTRATION (built-in mock model, not real AI)" : `AI suggestion (${origin.model})`;
  return concept({
    id, name: spec.name, audience: idea.customer, problem: idea.problem, offer: spec.offer, hook: spec.hook,
    pitch: { headline: spec.headline, subheadline: spec.subheadline, benefits: spec.benefits, faq: spec.faq },
    ratings: { usefulness: idea.usefulness, simplicity, monetisation: idea.monetisation },
    reasons: { usefulness: idea.usefulnessRationale, simplicity: `${idea.complexity} complexity (owner rule: low 0.85, medium 0.65, high 0.4)`, monetisation: idea.monetisationRationale },
    price: Math.min(29, Math.max(3, spec.price)),
    priceRationale: `GBP ${Math.min(29, Math.max(3, spec.price))}: ${label}: ${spec.priceRationale} Not based on market price data; clamped to GBP 3-29 by the factory.`,
    setup: spec.setup, files, origin: { ...origin, idea: idea.slug, imageBrief: spec.imageBrief, differentiation: idea.differentiation, risks: idea.risks, assumptions: idea.assumptions },
  });
}

/** Ideas that touch legal, tax, financial or similar advice are not eligible. */
export const ideaNeedsAdvice = (i: AiIdea) => isSensitive(`${i.name} ${i.problem} ${i.concept}`);

// ---------------------------------------------------------------- cost and readiness (no network)

export function estimateRunGbp(cfg: EngineConfig, prompts: readonly { prompt: string; maxTokens: number }[]): number | null {
  if (cfg.model.provider !== "claude") return null;
  return Math.round(prompts.reduce((a, x) => a + maxCostGbp(cfg.model.name, SYSTEM_BOUND, x.prompt, x.maxTokens), 0) * 10000) / 10000;
}
const PROMPT_BOUND = "x".repeat(4000);
export const productMaxTokens = (cfg: EngineConfig) => Math.min(4000, cfg.model.maxOutputTokens ?? 4000);

export interface Readiness { readonly provider: string; readonly paid: boolean; readonly ready: boolean; readonly reasons: readonly string[]; readonly estimatedMaxGbpPerRun: number | null; readonly ledgerRemainingGbp: number | null }

/** What AI mode would need, checked locally: config, key file (existence and permissions only), environment, budget. */
export function aiReadiness(store: Store, cfg: EngineConfig, now: Date, env: NodeJS.ProcessEnv = process.env): Readiness {
  const m = cfg.model, reasons: string[] = [];
  if (m.provider === "none") return { provider: "none", paid: false, ready: false, reasons: ["no model provider is configured (config.json model.provider is \"none\")"], estimatedMaxGbpPerRun: null, ledgerRemainingGbp: null };
  if (m.provider === "ollama") return { provider: `ollama (${m.name})`, paid: false, ready: true, reasons: ["local model on a loopback address: free; not contacted by this check"], estimatedMaxGbpPerRun: 0, ledgerRemainingGbp: null };
  let est: number | null = null;
  try { est = estimateRunGbp(cfg, [{ prompt: PROMPT_BOUND, maxTokens: IDEAS_MAX_TOKENS }, { prompt: PROMPT_BOUND, maxTokens: productMaxTokens(cfg) }]); } catch (e) { reasons.push((e as Error).message); }
  if (m.paidUsageApproved !== true) reasons.push("paid usage is not approved (config.json model.paidUsageApproved is false)");
  const key = path.join(store.dir, "anthropic.key");
  try { const s = fs.lstatSync(key); if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) !== 0) reasons.push("anthropic.key must be your own regular file with mode 600"); }
  catch { reasons.push(`no API key file (${key}, mode 600)`); }
  const vars = anthropicEnvVars(env);
  if (vars.length) reasons.push(`ANTHROPIC_* environment variables are set (${vars.join(", ")}); the paid client refuses to start`);
  let remaining: number | null = HARD_CAP_GBP;
  if (fs.existsSync(path.join(store.dir, "ledger.json"))) { try { remaining = new Ledger(store.dir, HARD_CAP_GBP, now).totals().remainingGbp; } catch (e) { reasons.push(`ledger: ${(e as Error).message}`); remaining = null; } }
  if (est !== null && est > (m.maxGbpPerRun ?? 1)) reasons.push(`a factory run can cost up to £${est}, more than model.maxGbpPerRun (£${m.maxGbpPerRun ?? 1})`);
  if (est !== null && remaining !== null && est > remaining) reasons.push(`a factory run can cost up to £${est}, more than the £${remaining} left in the ledger`);
  return { provider: `claude (${m.name})`, paid: true, ready: reasons.length === 0, reasons: reasons.length ? reasons : ["configured; each paid run still needs 'factory run --ai --paid'"], estimatedMaxGbpPerRun: est, ledgerRemainingGbp: remaining };
}

// ---------------------------------------------------------------- mock model (tests and demonstrations only)

export const MOCK_IDEAS = { ideas: [
  { slug: "freelance-capacity-planner", name: "Freelance capacity planner", customer: "freelancers who juggle several clients",
    problem: "saying yes to more work than fits in the week, then missing deadlines", concept: "A weekly capacity worksheet, a project pipeline tracker, a time log and wording for rescheduling or declining work.",
    fileTypes: ["markdown", "csv", "html"], differentiation: "Plans hours before work is accepted; the invoicing and onboarding kits start after a client says yes.", complexity: "low",
    usefulness: 0.8, usefulnessRationale: "Overcommitting is a common cause of late delivery; a weekly check is quick to adopt.", monetisation: 0.65, monetisationRationale: "Same audience as the existing kits; a small companion purchase.",
    demandEvidence: "unverified", competitionEvidence: "unverified", risks: ["Free planners and calendars already exist"], assumptions: ["Freelancers will spend 15 minutes a week on planning"] },
  { slug: "client-feedback-tracker", name: "Client feedback and revision tracker", customer: "designers and writers working with client feedback",
    problem: "losing track of which feedback was agreed and how many revision rounds remain", concept: "A feedback log, revision-round tracker and wording for confirming changes.",
    fileTypes: ["markdown", "csv"], differentiation: "Covers the revision stage, which the existing kits do not.", complexity: "low",
    usefulness: 0.7, usefulnessRationale: "Revision disputes are common in creative work.", monetisation: 0.6, monetisationRationale: "Narrower audience than the capacity planner.",
    demandEvidence: "unverified", competitionEvidence: "unverified", risks: ["Overlaps with project management tools"], assumptions: ["Buyers use spreadsheets"] },
  { slug: "tax-deadline-planner", name: "Freelance tax deadline planner", customer: "self-employed people",
    problem: "missing tax return and payment deadlines", concept: "A calendar of tax deadlines with reminders.",
    fileTypes: ["markdown", "csv"], differentiation: "Focuses on tax dates.", complexity: "low",
    usefulness: 0.9, usefulnessRationale: "Deadlines matter to every self-employed person.", monetisation: 0.8, monetisationRationale: "Broad audience.",
    demandEvidence: "unverified", competitionEvidence: "unverified", risks: ["Rules differ by country and change"], assumptions: ["Buyers are in one country"] },
] };

export const MOCK_PRODUCT = {
  name: "Freelance capacity planner",
  headline: "Know whether new work fits before you say yes",
  subheadline: "For freelancers juggling several clients: a weekly capacity worksheet, a project pipeline, a time log and wording for moving or declining work.",
  offer: "A weekly planning routine that compares the hours you have with the hours your projects need, so you can accept, reschedule or decline work with confidence.",
  hook: "Said yes to one project too many this month? Check your hours before the next one.",
  benefits: ["See your available hours for the week in one worksheet", "List every project and its remaining hours in one pipeline", "Log the time you actually spend, to plan better next week", "Use ready wording to reschedule or decline work politely"],
  faq: [{ q: "What format is it in?", a: "A printable HTML worksheet that works offline in any web browser, CSV trackers for any spreadsheet program, and Markdown guides." }, { q: "Do I need an app or account?", a: "No. Everything works offline with software you already have." }],
  setup: ["Read capacity-planning-guide.md once (10 minutes).", "Open project-pipeline.csv, delete the example rows and add your current projects.", "Each Monday, fill in weekly-capacity-worksheet.html and print or save it.", "Log your hours in time-log.csv during the week and compare on Friday."],
  price: 7, priceRationale: "Smaller than the existing GBP 12 kit and meant as a companion purchase.",
  imageBrief: "Show the printed weekly capacity worksheet filled in for a sample week, a spreadsheet view of the project pipeline, and the file list. Use the Avenor Studio colours. Do not show invented customer names, ratings or results.",
  files: [
    { name: "capacity-planning-guide.md", kind: "markdown", description: "How to plan a week's capacity and decide on new work", template: false, content: `# Capacity planning guide

## 1. Work out your real hours

- Start from the hours you want to work this week, not the hours you could work
- Subtract time for admin, email, invoicing and calls: often a fifth of the week
- Subtract fixed commitments such as appointments and school runs
- Write the result as your available client hours for the week

## 2. List what your projects need

- Add every active project to project-pipeline.csv with its remaining hours
- Split large projects into this week's share of the work
- Add a buffer of one hour for every five planned hours
- Include work you have promised but not started

## 3. Compare and decide

- If the needed hours fit, confirm the week's plan and start with the nearest deadline
- If they do not fit, move the least urgent work to next week first
- Ask clients about moving dates before a deadline is at risk, not after
- Decline or reschedule new work when the week is already full

## 4. Learn from last week

- Compare the hours in time-log.csv with the hours you planned
- Note which kinds of task took longer than planned
- Adjust next week's estimates for those tasks
` },
    { name: "rescheduling-and-declining.md", kind: "markdown", description: "Wording for moving deadlines or declining new work politely", template: true, content: `# Rescheduling and declining work

## Asking to move a deadline

- Hello [[Client name]], to give [[Project name]] the attention it needs, could we move the delivery to [[new date]]?
- I can send [[partial deliverable]] by the original date so you can start reviewing it
- Please let me know by [[reply date]] if the new date works for you

## Declining new work for now

- Thank you for thinking of me for [[Project name]]
- My schedule is full until [[date]], and I would rather not start than rush it
- If the dates can move, I would be glad to talk again from [[date]]

## Offering a smaller first step

- I cannot take on the full project this month, but I could start with [[smaller piece of work]]
- That would take about [[hours]] hours and could be ready by [[date]]
` },
    { name: "weekly-capacity-worksheet.html", kind: "html", description: "Printable weekly worksheet: available hours, planned work and decisions", title: "Weekly capacity worksheet", intro: "Fill this in each Monday. Compare the hours you have with the hours your projects need, then record what you will move or decline.", sections: [
      { heading: "Your hours this week", repeat: 1, fields: [{ label: "Week starting", type: "date" }, { label: "Hours you want to work", type: "number" }, { label: "Hours for admin, email and calls", type: "number" }, { label: "Fixed commitments (hours)", type: "number" }, { label: "Available client hours", type: "number" }] },
      { heading: "Project", repeat: 5, fields: [{ label: "Project and client", type: "text" }, { label: "Hours needed this week", type: "number" }, { label: "Deadline", type: "date" }, { label: "Can it move?", type: "checkbox" }] },
      { heading: "Decisions", repeat: 1, fields: [{ label: "Total hours needed (with buffer)", type: "number" }, { label: "Work to move to next week", type: "textarea" }, { label: "Requests to decline or reschedule", type: "textarea" }] },
    ] },
    { name: "project-pipeline.csv", kind: "csv", description: "One row per project: remaining hours, deadline and status", template: true, header: ["Project", "Client", "Remaining hours", "This week's hours", "Deadline", "Can move?", "Status", "Notes"], rows: [["Website copy", "Example Ltd", 12, 6, "2026-02-06", "No", "In progress", "Delete this example row"], ["Logo refresh", "Example Studio", 8, 3, "2026-02-20", "Yes", "Not started", "Delete this example row"]] },
    { name: "time-log.csv", kind: "csv", description: "Hours actually spent per project and task, to compare with the plan", template: true, header: ["Date", "Project", "Task", "Planned hours", "Actual hours", "Notes"], rows: [["2026-02-02", "Website copy", "First draft of homepage", 3, 4, "Delete this example row"]] },
  ],
};

/** Deterministic mock model. Its output is labelled as a demonstration wherever it appears. */
export function mockModel(): ModelClient & { prompts: string[] } {
  const prompts: string[] = [];
  return { id: "mock", paid: false, prompts, async complete(req) { prompts.push(req.prompt); return JSON.stringify(/PURPOSE: ideas/.test(req.prompt) ? MOCK_IDEAS : MOCK_PRODUCT); } };
}
