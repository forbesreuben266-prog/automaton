/**
 * Venture kind: digital products (guides, templates, checklists, toolkits).
 *
 * Ideas: combinations of a problem area, an audience and a product format, scored on the engine's own estimates of
 * demand, feasibility, risk and cost. Assets: a static landing page (no scripts, no external resources, no tracking),
 * a product outline, a pricing hypothesis and an experiment specification. Verification checks the assets
 * structurally. The simulated evaluation is a heuristic quality score: it is NOT customer or financial data.
 */

import type { Check, Evidence, Opportunity, Plan, VentureKind } from "../types.js";

const AREAS = [
  ["home budgeting", "tracking monthly spending without spreadsheets", 0.7],
  ["job interviews", "preparing structured answers under time pressure", 0.75],
  ["small landlords", "keeping tenancy paperwork and deadlines in order", 0.6],
  ["freelance invoicing", "getting paid on time with clear terms", 0.7],
  ["meal planning", "planning a week of cheap, healthy meals", 0.65],
  ["home office setup", "a productive workspace on a small budget", 0.55],
  ["moving house", "a stress-free moving timeline and checklist", 0.6],
  ["side-project launch", "validating an idea before building it", 0.65],
  ["exam revision", "a realistic revision timetable", 0.6],
  ["running a book club", "organising sessions and discussion questions", 0.45],
] as const;
const AUDIENCES = [["students", 0.6], ["new parents", 0.65], ["freelancers", 0.7], ["small business owners", 0.7], ["retirees", 0.5], ["first-time renters", 0.6]] as const;
const FORMATS = [["printable checklist", 0.95, 0.05, 15], ["step-by-step guide", 0.85, 0.1, 30], ["template pack", 0.8, 0.1, 40], ["30-day planner", 0.75, 0.1, 25]] as const;

/** Deterministic pseudo-random numbers (the seed comes from the engine's cycle counter). */
const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const r2 = (x: number) => Math.round(x * 100) / 100;

export const digitalProduct: VentureKind = {
  id: "digital-product",

  generateOpportunities(seed, avoid, count) {
    const rand = rng(seed);
    const out: Opportunity[] = [];
    for (let tries = 0; out.length < count && tries < 200; tries++) {
      const [area, problem, demandA] = AREAS[Math.floor(rand() * AREAS.length)];
      const [audience, demandB] = AUDIENCES[Math.floor(rand() * AUDIENCES.length)];
      const [format, feasibility, risk] = FORMATS[Math.floor(rand() * FORMATS.length)];
      const title = `${format[0].toUpperCase()}${format.slice(1)}: ${area} for ${audience}`;
      if (avoid.has(title) || out.some((o) => o.title === title)) continue;
      const demand = r2(Math.min(1, (demandA + demandB) / 2 + (rand() - 0.5) * 0.1));
      const score = r2(0.45 * demand + 0.35 * feasibility + 0.2 * (1 - risk));
      out.push({ id: "", kind: "digital-product", title, problem, audience, offer: `A ${format} that helps ${audience} with ${problem}.`,
        estimates: { demand, feasibility, risk, costUsd: 0 }, score, createdAt: "" });
    }
    return out;
  },

  plan(o, iteration, lastChecks) {
    const failed = lastChecks.filter((c) => !c.passed).map((c) => c.name);
    return {
      hypothesis: iteration === 1 ? `${o.audience} will sign up for "${o.title}" when shown a clear landing page.`
        : `A revised page (fixing: ${failed.join(", ") || "clarity and specificity"}) increases the quality score.`,
      deliverables: ["index.html", "product-outline.md", "pricing.json", "experiment.json"],
      successCriteria: ["page has headline, problem, offer, contents, call to action and a disclosure", "outline has at least 5 sections", "no scripts or external resources"],
    };
  },

  build(o, plan, iteration, write) {
    const sections = [
      `Why ${o.problem} is hard`, "Quick-start checklist", "Step-by-step method", "Worked example", "Common mistakes", "Templates you can copy",
      ...(iteration >= 2 ? ["Frequently asked questions"] : []), ...(iteration >= 3 ? ["30-day action plan"] : []),
    ];
    const items = sections.map((s) => `<li>${esc(s)}</li>`).join("");
    write("index.html", `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.6rem 1rem}</style>
</head><body>
<h1>${esc(o.title)}</h1>
<p class="problem">For ${esc(o.audience)}: ${esc(o.problem)}.</p>
<p class="offer">${esc(o.offer)}</p>
<h2>What is inside</h2><ul class="contents">${items}</ul>
<form class="cta" method="post" action="#"><label>Email <input type="email" name="email" required></label> <button type="submit">Get early access</button></form>
<p class="disclosure"><small>Pre-launch draft. Not yet available for purchase. No data is collected by this page.</small></p>
</body></html>
`);
    write("product-outline.md", `# ${o.title}\n\n${o.offer}\n\n${sections.map((s, i) => `## ${i + 1}. ${s}\n\n- Key points to write\n- Example\n`).join("\n")}`);
    write("pricing.json", JSON.stringify({ hypothesis: true, currency: "USD", price: 9, note: "Untested price hypothesis; no sales." }, null, 2) + "\n");
    write("experiment.json", JSON.stringify({ iteration, hypothesis: plan.hypothesis, successCriteria: plan.successCriteria, metricsToCollectAfterApprovedLaunch: ["visitors", "signups", "sales", "revenueUsd"] }, null, 2) + "\n");
  },

  verify(read, names) {
    const html = read("index.html") ?? "";
    const outline = read("product-outline.md") ?? "";
    const c = (name: string, passed: boolean, detail: string): Check => ({ name, passed, detail });
    let pricing: unknown = null; try { pricing = JSON.parse(read("pricing.json") ?? "x"); } catch { /* checked below */ }
    return [
      c("all-deliverables", ["index.html", "product-outline.md", "pricing.json", "experiment.json"].every((n) => names.includes(n)), `assets: ${names.join(", ")}`),
      c("html-structure", /^<!doctype html>/i.test(html) && /<title>[^<]+<\/title>/.test(html) && /<h1>[^<]+<\/h1>/.test(html) && /<\/html>\s*$/.test(html), "doctype, title, h1, closing tag"),
      c("page-sections", ["class=\"problem\"", "class=\"offer\"", "class=\"contents\"", "class=\"cta\"", "class=\"disclosure\""].every((s) => html.includes(s)), "problem, offer, contents, call to action, disclosure"),
      c("no-scripts-or-external-resources", !/<script|javascript:|\son[a-z]+\s*=|src=["']?https?:|href=["']?https?:|@import/i.test(html), "static, self-contained page"),
      c("outline-depth", (outline.match(/^## /gm) ?? []).length >= 5, `${(outline.match(/^## /gm) ?? []).length} sections`),
      c("pricing-is-hypothesis", !!pricing && (pricing as { hypothesis?: unknown }).hypothesis === true, "pricing marked as an untested hypothesis"),
    ];
  },

  simulate(o, checks, iteration): Evidence["metrics"] {
    const pass = checks.filter((c) => c.passed).length / Math.max(1, checks.length);
    const qualityScore = r2(Math.min(1, 0.55 * pass + 0.3 * o.score + 0.05 * Math.min(iteration, 3)));
    return { qualityScore };
  },
};
