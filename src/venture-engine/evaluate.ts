/**
 * Differentiated, explainable evaluation of one experiment's assets (always "simulated" evidence).
 * Components (each 0..1, stored with the evidence so every score can be explained):
 *   completeness  share of verification checks passed
 *   specificity   concrete bullet points (4+ words, not a placeholder) in the documents, out of 12
 *   fit           how many of the problem's key words and the audience appear in the page copy
 *   originality   1 - the highest word overlap with any other venture in the portfolio (title and offer)
 *   opportunity   the opportunity's own (simulated) score
 *   critique      optional: a model's rubric score (only when a model is configured)
 * quality = 0.25 completeness + 0.25 specificity + 0.15 fit + 0.15 originality + 0.20 opportunity, then blended
 * 80/20 with the critique when there is one. None of this is customer or financial data.
 */

import { askJson, num01, text, type ModelUse } from "./model.js";
import type { Check, Opportunity, Venture } from "./types.js";

export const PLACEHOLDERS = new Set(["key points to write", "example"]);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []);
const STOP = new Set(["the", "and", "for", "with", "that", "this", "your", "you", "are", "from", "without", "into", "a", "an", "of", "to", "on", "in"]);
const r2 = (x: number) => Math.round(x * 100) / 100;

export function concreteBullets(markdown: string): number {
  return (markdown.match(/^\s*[-*] .+$/gm) ?? []).map((l) => l.replace(/^\s*[-*] /, "").trim())
    .filter((l) => !PLACEHOLDERS.has(l.toLowerCase()) && l.split(/\s+/).length >= 4).length;
}

export function overlap(a: string, b: string): number {
  const x = [...words(a)].filter((w) => !STOP.has(w)), y = new Set([...words(b)].filter((w) => !STOP.has(w)));
  if (!x.length || !y.size) return 0;
  const inter = x.filter((w) => y.has(w)).length;
  return inter / (new Set([...x, ...y]).size);
}

export interface Evaluation { readonly quality: number; readonly scores: Record<string, number>; readonly weaknesses: readonly string[] }

export async function evaluate(o: Opportunity, checks: readonly Check[], docs: { readonly page: string; readonly markdown: string }, others: readonly Venture[], model: ModelUse): Promise<Evaluation> {
  const completeness = checks.filter((c) => c.passed).length / Math.max(1, checks.length);
  const specificity = Math.min(1, concreteBullets(docs.markdown) / 12);
  const copy = docs.page.replace(/<[^>]+>/g, " ").toLowerCase();
  const terms = [...words(o.problem)].filter((w) => !STOP.has(w) && w.length > 3).slice(0, 6);
  const fit = (terms.filter((t) => copy.includes(t)).length + (copy.includes(o.audience.toLowerCase()) ? 2 : 0)) / (terms.length + 2);
  const originality = 1 - Math.max(0, ...others.filter((v) => v.opportunity.id !== o.id).map((v) => overlap(`${o.title} ${o.offer}`, `${v.opportunity.title} ${v.opportunity.offer}`)));
  const scores: Record<string, number> = { completeness: r2(completeness), specificity: r2(specificity), fit: r2(fit), originality: r2(originality), opportunity: r2(o.score) };
  let quality = 0.25 * completeness + 0.25 * specificity + 0.15 * fit + 0.15 * originality + 0.2 * o.score;
  const weaknesses: string[] = checks.filter((c) => !c.passed).map((c) => `failed check: ${c.name}`);
  if (specificity < 0.5) weaknesses.push("too few concrete points: add specific steps, numbers and examples");
  if (fit < 0.6) weaknesses.push("the page copy does not speak to the audience's problem clearly");
  if (originality < 0.5) weaknesses.push("too similar to another venture in the portfolio");

  const critique = await askJson(model, "critique",
    `Critique this draft digital product for "${o.audience}" with the problem "${o.problem}". Score how likely a real buyer would find it useful and specific (0 = useless, 1 = excellent); be strict.\n` +
    `Return {"score": number 0..1, "weaknesses": [up to 3 short strings]}.\n---PAGE TEXT---\n${copy.slice(0, 4000)}\n---OUTLINE---\n${docs.markdown.slice(0, 6000)}`,
    (v) => { const x = v as { score?: unknown; weaknesses?: unknown }; const s = num01(x?.score); const w = Array.isArray(x?.weaknesses) ? x.weaknesses.slice(0, 3).map((y) => text(y, 160)) : [];
      return s === null || w.some((y) => y === null) ? null : { score: s, weaknesses: w as string[] }; }, 400);
  if (critique) { scores.critique = r2(critique.score); quality = 0.8 * quality + 0.2 * critique.score; weaknesses.push(...critique.weaknesses.map((w) => `critique: ${w}`)); }
  return { quality: r2(quality), scores, weaknesses };
}
