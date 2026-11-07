/**
 * Venture kind: digital products (checklists, guides, template packs, planners).
 *
 * Ideas: with a model, the model proposes opportunities (validated JSON); without one, a catalogue of problem areas,
 * each with only the audiences it fits and concrete points, so no nonsensical combinations are produced. Assets: a
 * static landing page (no scripts, no external resources, no tracking), a product outline, a pricing hypothesis, an
 * experiment spec and a launch checklist. Model-written text is validated, length-limited and HTML-escaped.
 */

import { askJson, num01, text } from "../model.js";
import type { Check, Opportunity, VentureKind } from "../types.js";

interface Area { readonly area: string; readonly problem: string; readonly demand: number; readonly audiences: readonly string[]; readonly points: readonly string[] }
const AREAS: readonly Area[] = [
  { area: "home budgeting", problem: "tracking monthly spending without spreadsheets", demand: 0.7, audiences: ["students", "new parents", "first-time renters", "retirees"],
    points: ["List every fixed bill with its due date in one place", "Set a weekly spending limit and check it every Sunday", "Keep a 3-category system: needs, wants, savings", "Review subscriptions every month and cancel unused ones", "Move savings on payday before spending starts"] },
  { area: "job interviews", problem: "preparing structured answers under time pressure", demand: 0.75, audiences: ["students", "career changers", "graduates"],
    points: ["Prepare 6 stories using situation, task, action and result", "Practise each answer aloud in under 2 minutes", "Research the company's last 3 announcements", "Write 3 questions to ask the interviewer", "Send a short thank-you note within 24 hours"] },
  { area: "freelance invoicing", problem: "getting paid on time with clear terms", demand: 0.7, audiences: ["freelancers", "small business owners"],
    points: ["State payment terms and late fees before work starts", "Send invoices on the day work is delivered", "Number invoices consistently and keep copies", "Follow up after 7 days with a polite reminder", "Ask for a deposit on projects over two weeks"] },
  { area: "small landlords", problem: "keeping tenancy paperwork and deadlines in order", demand: 0.6, audiences: ["small landlords", "accidental landlords"],
    points: ["Keep one folder per property with every certificate", "Diarise safety-check renewal dates 30 days early", "Record every repair request with date and outcome", "Photograph the property at every check-in and check-out", "Keep deposit protection evidence with the tenancy agreement"] },
  { area: "meal planning", problem: "planning a week of cheap, healthy meals", demand: 0.65, audiences: ["students", "new parents", "retirees"],
    points: ["Plan 5 dinners and 2 leftover nights each week", "Build the shopping list from the plan, by aisle", "Cook one batch base (rice, beans, sauce) on Sunday", "Keep 10 store-cupboard staples always in stock", "Rotate a 4-week menu to cut planning time"] },
  { area: "side-project launch", problem: "validating an idea before building it", demand: 0.65, audiences: ["freelancers", "career changers", "small business owners"],
    points: ["Write the problem in one sentence a customer would say", "Talk to 10 potential customers before building", "Put up a one-page offer and count real signups", "Set a kill date and a success number in advance", "Build only what the first 5 customers ask for"] },
  { area: "moving house", problem: "a stress-free moving timeline and checklist", demand: 0.6, audiences: ["first-time renters", "new parents", "retirees"],
    points: ["Book movers or van hire 4 weeks ahead", "Redirect post and update addresses 2 weeks before", "Pack one essentials box for the first night", "Label every box with room and contents", "Take meter readings on moving day"] },
];
const FORMATS = [{ name: "printable checklist", feasibility: 0.95, risk: 0.05 }, { name: "step-by-step guide", feasibility: 0.85, risk: 0.1 }, { name: "template pack", feasibility: 0.8, risk: 0.1 }, { name: "30-day planner", feasibility: 0.75, risk: 0.1 }];

const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const r2 = (x: number) => Math.round(x * 100) / 100;
const score = (demand: number, feasibility: number, risk: number) => r2(0.45 * demand + 0.35 * feasibility + 0.2 * (1 - risk));
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

interface Content { headline: string; subheadline: string; benefits: string[]; sections: { heading: string; bullets: string[] }[] }
const validContent = (v: unknown): Content | null => {
  const x = v as Partial<Content>;
  const headline = text(x?.headline, 120), subheadline = text(x?.subheadline, 240);
  if (!headline || !subheadline || !Array.isArray(x.benefits) || !Array.isArray(x.sections) || x.benefits.length < 3 || x.benefits.length > 6 || x.sections.length < 5 || x.sections.length > 10) return null;
  const benefits = x.benefits.map((b) => text(b, 160));
  const sections = x.sections.map((s) => ({ heading: text((s as any)?.heading, 100), bullets: Array.isArray((s as any)?.bullets) ? (s as any).bullets.slice(0, 6).map((b: unknown) => text(b, 200)) : [] }));
  if (benefits.some((b) => !b) || sections.some((s) => !s.heading || s.bullets.length < 2 || s.bullets.some((b: string | null) => !b))) return null;
  return { headline, subheadline, benefits: benefits as string[], sections: sections as Content["sections"] };
};

export const LAUNCH_REQUIREMENTS: readonly string[] = [
  "A place to host the static page that you control (external account: needs approval)",
  "A way to collect emails or pre-orders that you control, with a privacy notice (the page form posts nowhere until then)",
  "A payment or pre-order link from a payment provider, if selling (external account and money: needs approval)",
  "Terms of sale and a refund policy, if selling",
  "The finished deliverable before taking payment, or a clearly labelled pre-order",
  "Visitor and signup counts you can read (privacy-respecting analytics or the form's own counts)",
  "Results recorded with: record <venture> --source \"<where the numbers came from>\" ...",
];

export const digitalProduct: VentureKind = {
  id: "digital-product",
  launchRequirements: () => LAUNCH_REQUIREMENTS,

  async generateOpportunities({ seed, avoid, count, model }) {
    const proposed = await askJson(model, "opportunities",
      `Propose ${count + 2} distinct digital products (a checklist, guide, template pack or 30-day planner) that solve a specific, common problem for a specific audience and could be sold online for under $30.\n` +
      `Avoid these titles: ${[...avoid].slice(0, 30).join("; ") || "none"}.\n` +
      `Return {"opportunities": [{"title", "problem", "audience", "offer", "format": one of ${FORMATS.map((f) => f.name).join(", ")}, "demand": 0..1, "risk": 0..1, "rationale"}]}. Demand and risk are your honest estimates, not data.`,
      (v) => {
        const list = (v as { opportunities?: unknown })?.opportunities;
        if (!Array.isArray(list)) return null;
        const out = list.slice(0, count + 2).map((o: any) => ({ title: text(o?.title, 100), problem: text(o?.problem, 200), audience: text(o?.audience, 60), offer: text(o?.offer, 240), format: FORMATS.find((f) => f.name === o?.format), demand: num01(o?.demand), risk: num01(o?.risk) }));
        return out.every((o) => o.title && o.problem && o.audience && o.offer && o.format && o.demand !== null && o.risk !== null) ? out : null;
      });
    if (proposed) {
      return proposed.filter((o) => !avoid.has(o.title!)).slice(0, count).map((o) => ({ id: "", kind: "digital-product", title: o.title!, problem: o.problem!, audience: o.audience!, offer: o.offer!,
        estimates: { demand: o.demand!, feasibility: o.format!.feasibility, risk: o.risk!, costUsd: 0 }, score: score(o.demand!, o.format!.feasibility, o.risk!), createdAt: "", source: `model (${model.client?.id})` }));
    }
    const rand = rng(seed);
    const out: Opportunity[] = [];
    for (let tries = 0; out.length < count && tries < 200; tries++) {
      const a = AREAS[Math.floor(rand() * AREAS.length)];
      const audience = a.audiences[Math.floor(rand() * a.audiences.length)];
      const f = FORMATS[Math.floor(rand() * FORMATS.length)];
      const title = `${cap(f.name)}: ${a.area} for ${audience}`;
      if (avoid.has(title) || out.some((o) => o.title === title)) continue;
      const demand = r2(Math.min(1, a.demand + (rand() - 0.5) * 0.1));
      out.push({ id: "", kind: "digital-product", title, problem: a.problem, audience, offer: `A ${f.name} that helps ${audience} with ${a.problem}.`,
        estimates: { demand, feasibility: f.feasibility, risk: f.risk, costUsd: 0 }, score: score(demand, f.feasibility, f.risk), createdAt: "", source: "catalogue" });
    }
    return out;
  },

  plan(o, iteration, lastChecks, weaknesses) {
    const fix = [...lastChecks.filter((c) => !c.passed).map((c) => c.name), ...weaknesses].slice(0, 5);
    return {
      hypothesis: iteration === 1 ? `${o.audience} will sign up for "${o.title}" when shown a clear, specific landing page.` : `Fixing ${fix.join("; ") || "clarity"} raises the evaluated quality.`,
      deliverables: ["index.html", "product-outline.md", "pricing.json", "experiment.json", "launch-checklist.md"],
      successCriteria: ["page has headline, problem, offer, contents, call to action and disclosure", "outline has at least 5 sections with concrete points", "no scripts or external resources"],
      fix,
    };
  },

  async build(o, plan, iteration, write, model) {
    const area = AREAS.find((a) => o.title.toLowerCase().includes(a.area));
    const fromModel = await askJson(model, "content",
      `Write the content for "${o.title}": ${o.offer}\nAudience: ${o.audience}. Problem: ${o.problem}.\n${plan.fix.length ? `Fix these weaknesses from the last draft: ${plan.fix.join("; ")}.\n` : ""}` +
      `Be concrete: real steps, numbers and examples. No claims about customers, sales or results.\nReturn {"headline", "subheadline", "benefits": [3-6 strings], "sections": [5-10 of {"heading", "bullets": [2-6 strings]}]}.`, validContent, 2500);
    const points = area?.points ?? [];
    const content: Content = fromModel ?? {
      headline: o.title, subheadline: `For ${o.audience}: ${o.problem}.`, benefits: points.slice(0, 3),
      sections: [
        { heading: `Why ${o.problem} is hard`, bullets: ["Key points to write", "Example"] },
        { heading: "The method", bullets: points.length ? points.slice(0, 2 + iteration) : ["Key points to write", "Example"] },
        { heading: "Quick-start checklist", bullets: points.slice(0, Math.min(points.length, 1 + iteration)) },
        { heading: "Common mistakes", bullets: ["Key points to write", "Example"] },
        { heading: "Templates you can copy", bullets: ["Key points to write", "Example"] },
        ...(iteration >= 2 ? [{ heading: "Frequently asked questions", bullets: points.slice(0, 3).map((p) => `How do I ${p.charAt(0).toLowerCase()}${p.slice(1)}?`) }] : []),
        ...(iteration >= 3 ? [{ heading: "30-day action plan", bullets: points.map((p, i) => `Week ${Math.min(4, i + 1)}: ${p}`) }] : []),
      ].filter((s) => s.bullets.length >= 1),
    };
    const items = content.sections.map((s) => `<li>${esc(s.heading)}</li>`).join("");
    write("index.html", `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(content.headline)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.6rem 1rem}</style>
</head><body>
<h1>${esc(content.headline)}</h1>
<p class="problem">For ${esc(o.audience)}: ${esc(o.problem)}.</p>
<p class="offer">${esc(content.subheadline)} ${esc(o.offer)}</p>
<ul class="benefits">${content.benefits.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
<h2>What is inside</h2><ul class="contents">${items}</ul>
<form class="cta" method="post" action="#"><label>Email <input type="email" name="email" required></label> <button type="submit">Get early access</button></form>
<p class="disclosure"><small>Pre-launch draft. Not yet available for purchase. No data is collected by this page.</small></p>
</body></html>
`);
    write("product-outline.md", `# ${content.headline}\n\n${o.offer}\n\n${content.sections.map((s, i) => `## ${i + 1}. ${s.heading}\n\n${s.bullets.map((b) => `- ${b}`).join("\n")}\n`).join("\n")}`);
    write("pricing.json", JSON.stringify({ hypothesis: true, currency: "USD", price: 9, note: "Untested price hypothesis; no sales." }, null, 2) + "\n");
    write("experiment.json", JSON.stringify({ iteration, contentSource: fromModel ? `model (${model.client?.id})` : "template", hypothesis: plan.hypothesis, successCriteria: plan.successCriteria, metricsToCollectAfterApprovedLaunch: ["visitors", "signups", "sales", "revenueUsd"] }, null, 2) + "\n");
    write("launch-checklist.md", `# Before launching "${content.headline}" (owner actions; each needs approval)\n\n${LAUNCH_REQUIREMENTS.map((r) => `- [ ] ${r}`).join("\n")}\n`);
    return { contentSource: fromModel ? "model" : "template" };
  },

  verify(read, names) {
    const html = read("index.html") ?? "";
    const outline = read("product-outline.md") ?? "";
    const c = (name: string, passed: boolean, detail: string): Check => ({ name, passed, detail });
    let pricing: unknown = null; try { pricing = JSON.parse(read("pricing.json") ?? "x"); } catch { /* checked below */ }
    return [
      c("all-deliverables", ["index.html", "product-outline.md", "pricing.json", "experiment.json", "launch-checklist.md"].every((n) => names.includes(n)), `assets: ${names.join(", ")}`),
      c("html-structure", /^<!doctype html>/i.test(html) && /<title>[^<]+<\/title>/.test(html) && /<h1>[^<]+<\/h1>/.test(html) && /<\/html>\s*$/.test(html), "doctype, title, h1, closing tag"),
      c("page-sections", ["class=\"problem\"", "class=\"offer\"", "class=\"contents\"", "class=\"cta\"", "class=\"disclosure\""].every((s) => html.includes(s)), "problem, offer, contents, call to action, disclosure"),
      c("no-scripts-or-external-resources", !/<script|javascript:|\son[a-z]+\s*=|src=["']?https?:|href=["']?https?:|@import/i.test(html), "static, self-contained page"),
      c("outline-depth", (outline.match(/^## /gm) ?? []).length >= 5, `${(outline.match(/^## /gm) ?? []).length} sections`),
      c("pricing-is-hypothesis", !!pricing && (pricing as { hypothesis?: unknown }).hypothesis === true, "pricing marked as an untested hypothesis"),
      c("no-placeholder-text", !/^\s*- (Key points to write|Example)\s*$/im.test(outline), "every outline point is written (unfinished drafts are never proposed for launch)"),
    ];
  },
};
