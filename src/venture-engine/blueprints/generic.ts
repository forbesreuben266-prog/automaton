/**
 * Blueprint: any digital-product venture. Turns the venture's own outline (its latest experiment's
 * product-outline.md) into a usable pack: a written guide, a printable checklist and an action tracker (CSV).
 * The pack is only as good as the outline: a thin or placeholder outline fails the product QA (incomplete content)
 * instead of being padded with invented material.
 */

import { type Blueprint, csv, DISCLAIMER, type ProductFile } from "./common.js";

export const generic: Blueprint = {
  id: "generic",
  defaultPrice: 9,
  matches: () => true,
  productName: (i) => i.opportunity.title,
  pitch: (i) => ({
    headline: i.opportunity.title,
    subheadline: `For ${i.opportunity.audience}: ${i.opportunity.problem.replace(/\.$/, "")}. ${i.opportunity.offer}`,
    benefits: i.outline.slice(0, 4).map((s) => s.bullets[0]).filter((b): b is string => !!b),
    faq: [
      { q: "What format is it in?", a: "A written guide and checklist (Markdown, opens in any text editor or word processor) and a tracker (CSV, opens in any spreadsheet)." },
      { q: "Is this professional advice?", a: "No. It is practical, general guidance. Ask a qualified adviser about anything legal, tax, financial or medical." },
    ],
  }),
  files(i): ProductFile[] {
    const o = i.opportunity;
    const rows = i.outline.flatMap((s, si) => s.bullets.map((b, bi) => [`${si + 1}.${bi + 1}`, s.heading, b, "", "Not started", ""] as (string | number)[]));
    return [
      { name: "start-here.md", template: false, description: "Start here: what is included and how to use it", text: `# ${o.title}: start here

${o.offer}

## What is included

| File | What it is |
|---|---|
| \`guide.md\` | The full guide, section by section |
| \`checklist.md\` | Every step as a tick-box checklist |
| \`action-tracker.csv\` | One row per step: add target dates and track progress in any spreadsheet |

## How to use it

1. Read \`guide.md\` once from start to finish.
2. Open \`action-tracker.csv\` in a spreadsheet and add a target date to each step you will do.
3. Work through \`checklist.md\`, ticking each step, and update the tracker's Status column (Not started, Doing, Done).

## Important

${DISCLAIMER}
` },
      { name: "guide.md", template: false, description: "The full guide, section by section", text: `# ${o.title}

For ${o.audience}: ${o.problem.replace(/\.$/, "")}.

${i.outline.map((s, n) => `## ${n + 1}. ${s.heading}\n\n${s.bullets.map((b) => `- ${b}`).join("\n")}\n`).join("\n")}
## Important

${DISCLAIMER}
` },
      { name: "checklist.md", template: false, description: "Every step as a tick-box checklist", text: `# Checklist: ${o.title}

${i.outline.map((s, n) => `## ${n + 1}. ${s.heading}\n\n${s.bullets.map((b) => `- [ ] ${b}`).join("\n")}\n`).join("\n")}
## Important

${DISCLAIMER}
` },
      { name: "action-tracker.csv", template: true, description: "Action tracker: one row per step, with target dates and status", text: csv([["Step", "Section", "Action", "Target date", "Status", "Notes"], ...rows]) },
    ];
  },
};
