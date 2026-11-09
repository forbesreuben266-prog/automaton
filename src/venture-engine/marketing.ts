/**
 * Marketing pack generator: ready-to-use DRAFTS for an existing product. It never publishes, sends, schedules or
 * contacts anyone, and makes no network or model calls.
 *
 * Content comes only from the product's own (QA-checked) landing page: headline, offer, benefits, what is inside and
 * the proposed price. Nothing is invented: no testimonials, customer numbers, sales figures, rankings or guarantees.
 * Every draft is checked with the same misleading-claim rules as the product QA and must contain no links (the owner
 * adds the real page link, marked [[link to your page]], after an approved launch).
 *
 * Each run writes a new private folder ventures/<venture>/<mkt-id>/ (mode 600 files, never overwritten) with
 * social-posts.md, email.md, pitch.md, seven-day-plan.md and pack.json. Product files and records are not touched.
 */

import { sha256, newId, type Store } from "./store.js";
import { misleadingClaims, type Product } from "./products.js";
import type { Asset } from "./types.js";

export const SHORT_POST_MAX = 280;

export interface ProductPitch { readonly headline: string; readonly offer: string; readonly benefits: readonly string[]; readonly inside: readonly string[]; readonly price: string }
export interface MarketingPack { readonly id: string; readonly product: string; readonly dir: string; readonly files: readonly Asset[] }

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();

/** The approved product details, read from the product's own landing page. */
export function readPitch(landing: string): ProductPitch {
  const one = (re: RegExp, what: string) => { const m = re.exec(landing); if (!m) throw new Error(`the landing page has no ${what}; review the product first`); return unescape(m[1]); };
  const list = (block: RegExp, what: string) => {
    const b = block.exec(landing)?.[1];
    const items = b ? [...b.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => unescape(m[1].replace(/<strong>[^<]*<\/strong>:\s*/, "").replace(/<[^>]+>/g, ""))).filter(Boolean) : [];
    if (!items.length) throw new Error(`the landing page has no ${what}; review the product first`);
    return items;
  };
  return {
    headline: one(/<h1>([^<]+)<\/h1>/, "headline"),
    offer: one(/<p class="offer">([^<]+)<\/p>/, "offer"),
    benefits: list(/<ul class="benefits">([\s\S]*?)<\/ul>/, "benefits"),
    inside: list(/<ul class="includes">([\s\S]*?)<\/ul>/, "list of included files"),
    price: one(/Proposed price: <strong>([^<]+)<\/strong>/, "proposed price"),
  };
}

const LINK = "[[link to your page]]";
const short = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

export function draftPack(p: Pick<Product, "name" | "review">, x: ProductPitch): { name: string; text: string }[] {
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const careful = p.review.length > 0 ? "\n\nGeneral information to help you organise your work; not legal, tax or financial advice." : "";
  const post1 = short(`${x.headline}. ${x.benefits[0]}. ${x.price}. ${LINK}`, SHORT_POST_MAX);
  // Short post: the main files only (not the "start here" guide), without bracketed asides.
  const main = x.inside.filter((i) => !/^start here/i.test(i)).map((i) => i.replace(/\s*\([^)]*\)/g, "").trim());
  const post2 = short(`What is inside ${p.name}: ${(main.length ? main : x.inside).slice(0, 3).map(lower).join("; ")}. ${LINK}`, SHORT_POST_MAX);
  const post3 = `${x.offer}\n\n${x.benefits.map((b) => `- ${b}`).join("\n")}\n\nPrice: ${x.price}, one-off. Details: ${LINK}${careful}`;
  const draftNote = "Drafts only: nothing has been posted or sent. Before using them, check the price, replace [[link to your page]] with your live page (only after an approved launch), and post only where self-promotion is allowed.";
  return [
    { name: "social-posts.md", text: `# Social media posts: ${p.name}\n\n${draftNote}\n\n## Post 1 (short, ${post1.length} characters)\n\n${post1}\n\n## Post 2 (short, ${post2.length} characters)\n\n${post2}\n\n## Post 3 (longer, for LinkedIn or a community post)\n\n${post3}\n` },
    { name: "email.md", text: `# Promotional email draft: ${p.name}\n\nSend only to people who agreed to hear from you (for example your waiting list). Nothing has been sent.\n\n**Subject options**\n\n- ${x.headline}\n- Now available: ${p.name}\n\n**Body**\n\nHi [[first name]],\n\n${x.offer}\n\nWhat you get:\n\n${x.benefits.map((b) => `- ${b}`).join("\n")}\n\nWhat is inside:\n\n${x.inside.map((i) => `- ${i}`).join("\n")}\n\nThe price is ${x.price}, a one-off payment. You can see the details here: ${LINK}\n\nThanks,\n[[Your name]]${careful}\n\n[[Your business address]] · [[unsubscribe link]]\n` },
    { name: "pitch.md", text: `# Product pitch: ${p.name}\n\n**One line:** ${x.headline}.\n\n**Short pitch:** ${x.offer} ${x.benefits.slice(0, 2).join(". ")}. ${x.price}, one-off.${careful}\n` },
    { name: "seven-day-plan.md", text: `# Seven-day organic promotion plan: ${p.name}\n\nFree, manual actions only: no paid ads, no cold messages, nothing automated. Start only after the launch is approved and the page is live, and record real results with 'product record'.\n\n| Day | Action | Use |\n|---|---|---|\n| 1 | Publish Post 1 on your main account and pin it | social-posts.md, Post 1 |\n| 2 | Share Post 3 in one or two communities you already take part in, where self-promotion is allowed; read the rules first | social-posts.md, Post 3 |\n| 3 | Publish Post 2 and reply to every comment or question | social-posts.md, Post 2 |\n| 4 | Send the email to people who opted in (your waiting list) | email.md |\n| 5 | Use the short pitch in your profile, bio or email signature | pitch.md |\n| 6 | Ask three people from your audience for honest feedback on the page; note what is unclear and fix it | pitch.md |\n| 7 | Read your visits, signups and sales from your providers and record them with 'product record' | the product's tracking-plan.json |\n\nDo not invent reviews, results or urgency. Answer questions with what the product actually contains.\n` },
  ];
}

/** Generates and saves a new marketing pack for a product that passed every QA check. */
export function generateMarketing(store: Store, productId: string, now: Date): MarketingPack {
  const p = store.products().find((x) => x.id === productId);
  if (!p) throw new Error(`no product ${productId}`);
  if (p.status !== "ready" && p.status !== "live") throw new Error(`${productId} is ${p.status}: marketing drafts are made only for a product that passed every check`);
  const read = store.reader(store.assetDir(p.ventureId, p.id));
  const landing = read("landing.html");
  if (landing === null) throw new Error(`${productId}: landing.html is missing; review the product first`);
  const rec = p.files.find((f) => f.name === "landing.html");
  if (!rec || sha256(landing) !== rec.sha256) throw new Error(`${productId}: landing.html changed since the build; review (or adopt) it first so the drafts use checked content`);
  const files = draftPack(p, readPitch(landing));
  const problems = files.flatMap((f) => [
    ...misleadingClaims(f.text).map((why) => `${f.name}: ${why}`),
    ...(/https?:\/\/|www\./i.test(f.text) ? [`${f.name}: contains a link (only the [[link to your page]] placeholder is allowed)`] : []),
  ]);
  if (problems.length) throw new Error(`marketing drafts not saved: ${problems.join("; ")}`);
  const id = newId("mkt");
  const dir = store.assetDir(p.ventureId, id);
  const written: Asset[] = [];
  const write = store.writer(dir, written);
  for (const f of files) write(f.name, f.text);
  write("pack.json", JSON.stringify({ pack: id, product: p.id, version: p.version, createdAt: now.toISOString(), status: "drafts only: nothing posted, sent or scheduled", files: written }, null, 2) + "\n");
  store.audit({ kind: "marketing-pack", pack: id, product: p.id, files: written.map((f) => f.name) }, now);
  return { id, product: p.id, dir, files: written };
}
