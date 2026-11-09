/**
 * Approval-gated marketing campaigns (LinkedIn and Facebook), first version: NOTHING is published automatically.
 *
 *   campaign create   seven-day schedule of platform-specific drafts from the product's own checked landing page and
 *                     the owner's real Payhip URL. Needs a product that passed every check and has a current owner
 *                     sign-off. Drafts are checked with the product QA's misleading-claim rules; the only link
 *                     allowed is the campaign URL.
 *   approve / reject  one post at a time, by the owner at an interactive terminal (automated jobs cannot approve).
 *                     An approval is bound to the post's exact text and URL.
 *   published         the owner records the link of a post THEY published, only after the approved launch: the
 *                     product must be live and its recorded live URL must be the campaign URL.
 *   revise            reworded text for an unpublished post becomes a NEW draft: its approval is cleared and the
 *                     previous text, status and decision are kept in the post's history. Same checks as create.
 *   export            a copy-ready handoff document for scheduling in the platform's own tool (for Facebook: Meta
 *                     Business Suite), with the schedule, each post's status and exact text. Exporting schedules
 *                     nothing; only approved posts are marked ready.
 *   record            verified results for a published post: numbers the owner read from the platform's own
 *                     analytics for a stated period (after publication, not in the future, not overlapping), with a
 *                     source and an optional hashed evidence export. Nothing is estimated.
 *
 * No passwords or tokens are requested or stored; no network, model or payment calls are made.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withLock } from "./control.js";
import { readPitch } from "./marketing.js";
import { changedFiles, misleadingClaims, type Product, reviewHash } from "./products.js";
import { newId, sha256, type Store } from "./store.js";

export type Platform = "linkedin" | "facebook";
export type PostStatus = "draft" | "approved" | "rejected" | "published";
export interface PostResult {
  readonly id: string; readonly recordedAt: string; readonly periodStart: string; readonly periodEnd: string;
  readonly impressions: number; readonly reactions: number; readonly comments: number; readonly shares: number; readonly clicks: number;
  readonly source: string; readonly verification: "evidence-file" | "owner-reported";
  readonly evidence: { readonly name: string; readonly bytes: number; readonly sha256: string } | null;
}
export interface Post {
  readonly id: string; readonly platform: Platform; readonly day: number; readonly date: string; readonly theme: string; readonly text: string;
  readonly status: PostStatus;
  readonly decision: { readonly at: string; readonly contentHash: string; readonly note: string } | null;
  readonly published: { readonly url: string; readonly at: string } | null;
  readonly results: readonly PostResult[];
  /** Earlier versions of this post (text, status and decision at the time it was revised). */
  readonly history?: readonly { readonly at: string; readonly text: string; readonly status: PostStatus; readonly decision: Post["decision"] }[];
}
export interface Campaign {
  readonly id: string; readonly productId: string; readonly productVersion: number; readonly productUrl: string;
  readonly startDate: string; readonly createdAt: string; readonly posts: readonly Post[];
}

/** Per-platform limits used for the drafts (well inside each platform's own maximum). */
export const PLATFORM_MAX: Readonly<Record<Platform, number>> = { linkedin: 1300, facebook: 600 };
const PAYHIP = /^https:\/\/payhip\.com\/b\/[A-Za-z0-9]{3,20}$/;
const HOSTS: Readonly<Record<Platform, RegExp>> = { linkedin: /^(www\.)?linkedin\.com$/, facebook: /^(www\.|m\.)?facebook\.com$|^fb\.com$/ };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const contentHash = (p: Pick<Post, "text" | "platform" | "date">, url: string) => sha256(JSON.stringify({ text: p.text, platform: p.platform, date: p.date, url }));

/** Seven days, alternating platforms: LinkedIn on days 1, 3, 5, 7 and Facebook on days 2, 4, 6. */
export function draftPosts(productName: string, landing: string, url: string, legalTopics: boolean): { platform: Platform; day: number; theme: string; text: string }[] {
  const x = readPitch(landing);
  const b = (i: number) => x.benefits[i % x.benefits.length];
  const inside = x.inside.filter((i) => !/^start here/i.test(i)).map((i) => i.replace(/\s*\([^)]*\)/g, "").trim());
  const note = legalTopics ? "\n\nGeneral information to help you organise your work; not legal, tax or financial advice." : "";
  return [
    { platform: "linkedin", day: 1, theme: "announcement", text: `${x.headline}.\n\n${x.offer}\n\n${x.benefits.map((y) => `• ${y}`).join("\n")}\n\n${x.price}, one-off: ${url}${note}` },
    { platform: "facebook", day: 2, theme: "problem", text: `${b(0)}. ${productName} helps: ${x.price}, one-off. ${url}${note}` },
    { platform: "linkedin", day: 3, theme: "what is inside", text: `What is inside ${productName}:\n\n${inside.map((y) => `• ${y}`).join("\n")}\n\n${url}${note}` },
    { platform: "facebook", day: 4, theme: "benefit", text: `${b(1)}. ${b(2)}. Everything is in ${productName}: ${url}${note}` },
    { platform: "linkedin", day: 5, theme: "how it works", text: `How ${productName} works:\n\n${inside.slice(0, 4).map((y, i) => `${i + 1}. ${y}`).join("\n")}\n\n${b(3)}.\n\n${url}${note}` },
    { platform: "facebook", day: 6, theme: "what you get", text: `${productName}: ${inside.slice(0, 3).join("; ")}. ${x.price}. ${url}${note}` },
    { platform: "linkedin", day: 7, theme: "summary", text: `${x.headline}.\n\n${x.benefits.slice(0, 2).map((y) => `• ${y}`).join("\n")}\n\nAvailable now for ${x.price}: ${url}${note}` },
  ];
}

/** The checks every post text must pass (create and revise). */
export function postProblems(d: { day: number; platform: Platform; text: string }, url: string): string[] {
  return [
    ...misleadingClaims(d.text).map((why) => `day ${d.day}: ${why}`),
    ...(d.text.replaceAll(url, "").match(/https?:\/\/|www\./i) ? [`day ${d.day}: contains a link other than the campaign URL`] : []),
    ...(!d.text.includes(url) ? [`day ${d.day}: must contain the campaign URL ${url}`] : []),
    ...(d.text.length > PLATFORM_MAX[d.platform] ? [`day ${d.day}: ${d.text.length} characters, over ${PLATFORM_MAX[d.platform]} for ${d.platform}`] : []),
    ...(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(d.text) || !d.text.trim() ? [`day ${d.day}: empty text or control characters`] : []),
  ];
}

const getCampaign = (store: Store, id: string) => { const c = store.campaigns().find((x) => x.id === id); if (!c) throw new Error(`no campaign ${id}`); return c; };
const getPost = (c: Campaign, id: string) => { const p = c.posts.find((x) => x.id === id); if (!p) throw new Error(`no post ${id} in ${c.id}`); return p; };
const savePost = (store: Store, c: Campaign, post: Post) => store.saveCampaigns(store.campaigns().map((x) => (x.id === c.id ? { ...x, posts: x.posts.map((p) => (p.id === post.id ? post : p)) } : x)));

export function createCampaign(store: Store, productId: string, opts: { url: string; start?: string; now: Date }): Campaign {
  const p = store.products().find((x) => x.id === productId);
  if (!p) throw new Error(`no product ${productId}`);
  if (p.status !== "ready" && p.status !== "live") throw new Error(`${productId} is ${p.status}: campaigns are made only for a product that passed every check`);
  if (!p.signOff || p.signOff.reviewHash !== reviewHash(p)) throw new Error(`${productId} has no current owner sign-off: run 'product sign-off ${productId}' first`);
  if (changedFiles(store, p).length) throw new Error(`${productId}: files changed since the build; review the product first`);
  if (!PAYHIP.test(opts.url)) throw new Error("--url: the real Payhip product link, https://payhip.com/b/<code> (copy it from your Payhip dashboard)");
  if (p.live && p.live.url !== opts.url) throw new Error(`${productId} is live at ${p.live.url}: the campaign must use that URL`);
  const start = opts.start ?? addDays(opts.now.toISOString().slice(0, 10), 1);
  if (!DAY.test(start) || Number.isNaN(Date.parse(start))) throw new Error("--start: YYYY-MM-DD");
  if (start < opts.now.toISOString().slice(0, 10)) throw new Error("--start: not in the past");
  const landing = store.reader(store.assetDir(p.ventureId, p.id))("landing.html");
  if (landing === null) throw new Error(`${productId}: landing.html is missing`);
  const drafts = draftPosts(p.name, landing, opts.url, p.review.length > 0);
  const problems = drafts.flatMap((d) => postProblems(d, opts.url));
  if (problems.length) throw new Error(`campaign not created: ${problems.join("; ")}`);
  const c: Campaign = { id: newId("cmp"), productId: p.id, productVersion: p.version, productUrl: opts.url, startDate: start, createdAt: opts.now.toISOString(),
    posts: drafts.map((d) => ({ id: newId("pst"), ...d, date: addDays(start, d.day - 1), status: "draft", decision: null, published: null, results: [] })) };
  store.saveCampaigns([...store.campaigns(), c]);
  store.audit({ kind: "campaign-created", campaign: c.id, product: p.id, url: c.productUrl, posts: c.posts.length }, opts.now);
  return c;
}

/** The owner approves or rejects one post, at an interactive terminal. Approval is bound to the post's text and URL. */
export function decidePost(store: Store, campaignId: string, postId: string, a: { approve: boolean; note: string; interactive: boolean }, now: Date): Post {
  if (!a.interactive) throw new Error("approving or rejecting posts needs an interactive terminal: automated jobs cannot decide");
  const c = getCampaign(store, campaignId);
  const p = getPost(c, postId);
  if (p.status === "published") throw new Error(`${postId} is already published`);
  if (!a.approve && a.note.trim().length < 3) throw new Error("reject needs a short note saying what is wrong");
  const next: Post = { ...p, status: a.approve ? "approved" : "rejected", decision: { at: now.toISOString(), contentHash: contentHash(p, c.productUrl), note: a.note.trim().slice(0, 200) } };
  savePost(store, c, next);
  store.audit({ kind: a.approve ? "campaign-post-approved" : "campaign-post-rejected", campaign: c.id, post: p.id, platform: p.platform, day: p.day, note: next.decision!.note, interactive: true }, now);
  return next;
}

/** Reworded text for an unpublished post becomes a new draft that needs approval again; the old version is kept. */
export function revisePost(store: Store, campaignId: string, postId: string, text: string, now: Date): Post {
  const c = getCampaign(store, campaignId);
  const p = getPost(c, postId);
  if (p.status === "published") throw new Error(`${postId} is already published: published posts are not revised`);
  const t = text.replace(/\r\n/g, "\n").trim();
  if (t === p.text) throw new Error(`${postId}: the new text is the same as the current text`);
  const problems = postProblems({ day: p.day, platform: p.platform, text: t }, c.productUrl);
  if (problems.length) throw new Error(`revision not saved: ${problems.join("; ")}`);
  const next: Post = { ...p, text: t, status: "draft", decision: null, history: [...(p.history ?? []), { at: now.toISOString(), text: p.text, status: p.status, decision: p.decision }] };
  savePost(store, c, next);
  store.audit({ kind: "campaign-post-revised", campaign: c.id, post: p.id, previousStatus: p.status, newDraftHash: contentHash(next, c.productUrl) }, now);
  return next;
}

/** A copy-ready handoff for scheduling in the platform's own tool. Schedules nothing. */
export function exportHandoff(c: Campaign, platform: Platform): string {
  const tool = platform === "facebook" ? "Meta Business Suite" : "LinkedIn";
  const posts = c.posts.filter((p) => p.platform === platform);
  const ready = (p: Post) => p.status === "approved" && !!p.decision && p.decision.contentHash === contentHash(p, c.productUrl);
  const label = (p: Post) => (p.status === "published" ? `PUBLISHED (${p.published?.url})` : ready(p) ? "APPROVED: ready to schedule" : p.status === "rejected" ? "REJECTED: do not schedule" : "DRAFT: approve it in Automaton before scheduling");
  return [
    `# ${tool} handoff: ${platform} posts for campaign ${c.id}`,
    "",
    `Product ${c.productId} (version ${c.productVersion}). Link in every post: ${c.productUrl}`,
    `Status: ${posts.filter(ready).length} of ${posts.length} ${platform} post(s) approved and ready to schedule. This document schedules nothing; you schedule the posts yourself in ${tool}.`,
    "",
    "## Schedule",
    "",
    "| Day | Date | Post | Status |",
    "|---|---|---|---|",
    ...posts.map((p) => `| ${p.day} | ${p.date} | ${p.id} (${p.theme}) | ${label(p)} |`),
    "",
    ...posts.flatMap((p) => [`## Day ${p.day}, ${p.date}: ${p.id} (${label(p)})`, "", `${p.text.length} characters. Copy everything between the lines:`, "", "```text", p.text, "```", ""]),
    "## After each post goes out",
    "",
    "Open the published post, copy its link, and record it (only approved posts can be recorded):",
    "",
    ...posts.map((p) => `    campaign published ${c.id} ${p.id} --url <link of the published post>`),
    "",
    "Later, record the post's numbers from the platform's own insights (never estimates):",
    "",
    `    campaign record ${c.id} <post> --period YYYY-MM-DD..YYYY-MM-DD --impressions N --reactions N --comments N --shares N --clicks N --source "${platform === "facebook" ? "Meta Business Suite insights" : "LinkedIn post analytics"}"`,
    "",
  ].join("\n");
}

/** The owner records the link of a post they published themselves on the platform. */
export function recordPublished(store: Store, campaignId: string, postId: string, url: string, now: Date): Post {
  const c = getCampaign(store, campaignId);
  const p = getPost(c, postId);
  if (p.status !== "approved" || !p.decision || p.decision.contentHash !== contentHash(p, c.productUrl)) throw new Error(`${postId} is ${p.status}: only an approved post can be recorded as published`);
  const product = store.products().find((x) => x.id === c.productId);
  if (product?.status !== "live" || !product.live) throw new Error(`${c.productId} is not live: posts can be recorded as published only after the approved launch ('product mark-live')`);
  if (product.live.url !== c.productUrl) throw new Error(`the campaign URL ${c.productUrl} is not the product's live URL ${product.live.url}`);
  let u: URL; try { u = new URL(url); } catch { throw new Error("--url: not a URL"); }
  if (u.protocol !== "https:" || u.username || u.password || url.length > 300 || !HOSTS[p.platform].test(u.hostname)) throw new Error(`--url: the https link of the published ${p.platform} post`);
  const next: Post = { ...p, status: "published", published: { url: u.toString(), at: now.toISOString() } };
  savePost(store, c, next);
  store.audit({ kind: "campaign-post-published", campaign: c.id, post: p.id, platform: p.platform, url: next.published!.url, by: "owner" }, now);
  return next;
}

/** Verified results for one published post, read by the owner from the platform's own analytics. */
export function recordResults(store: Store, campaignId: string, postId: string, r: { periodStart: string; periodEnd: string; impressions: number; reactions: number; comments: number; shares: number; clicks: number; source: string; evidenceFile?: string }, now: Date): PostResult {
  const c = getCampaign(store, campaignId);
  const p = getPost(c, postId);
  if (p.status !== "published" || !p.published) throw new Error(`${postId} is not published: results can only be recorded for a post you published`);
  if (!DAY.test(r.periodStart) || !DAY.test(r.periodEnd) || r.periodStart > r.periodEnd) throw new Error("--period: YYYY-MM-DD..YYYY-MM-DD");
  if (r.periodStart < p.published.at.slice(0, 10)) throw new Error(`--period: starts before the post was published (${p.published.at.slice(0, 10)})`);
  if (r.periodEnd > now.toISOString().slice(0, 10)) throw new Error("--period: ends in the future");
  if (p.results.some((x) => !(r.periodEnd < x.periodStart || r.periodStart > x.periodEnd))) throw new Error("--period overlaps an existing record for this post");
  for (const k of ["impressions", "reactions", "comments", "shares", "clicks"] as const) if (!Number.isInteger(r[k]) || r[k] < 0 || r[k] > 100_000_000) throw new Error(`--${k}: a whole number`);
  if (r.reactions + r.comments + r.shares + r.clicks > 0 && r.impressions === 0) throw new Error("interactions without impressions: check the numbers");
  if (typeof r.source !== "string" || r.source.trim().length < 5) throw new Error("--source: where the numbers were read, e.g. 'LinkedIn post analytics'");
  let evidence: PostResult["evidence"] = null;
  if (r.evidenceFile !== undefined) {
    let fd: number;
    try { fd = fs.openSync(r.evidenceFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw new Error("--evidence: cannot open the file (links are not followed)"); }
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.size === 0 || s.size > 10 * 1024 * 1024) throw new Error("--evidence: a non-empty regular file up to 10 MB");
      evidence = { name: path.basename(r.evidenceFile).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80), bytes: s.size, sha256: createHash("sha256").update(fs.readFileSync(fd)).digest("hex") };
    } finally { fs.closeSync(fd); }
  }
  const rec: PostResult = { id: newId("res"), recordedAt: now.toISOString(), periodStart: r.periodStart, periodEnd: r.periodEnd, impressions: r.impressions, reactions: r.reactions, comments: r.comments, shares: r.shares, clicks: r.clicks,
    source: r.source.trim().slice(0, 200), verification: evidence ? "evidence-file" : "owner-reported", evidence };
  savePost(store, c, { ...p, results: [...p.results, rec] });
  store.audit({ kind: "campaign-results", campaign: c.id, post: p.id, period: `${rec.periodStart}..${rec.periodEnd}`, clicks: rec.clicks, verification: rec.verification }, now);
  return rec;
}

export function campaignStatus(c: Campaign): string {
  const count = (s: PostStatus) => c.posts.filter((p) => p.status === s).length;
  const sum = (k: "impressions" | "reactions" | "comments" | "shares" | "clicks") => c.posts.reduce((a, p) => a + p.results.reduce((b, r) => b + r[k], 0), 0);
  const recorded = c.posts.some((p) => p.results.length);
  return [
    `campaign ${c.id} for ${c.productId} (version ${c.productVersion}), ${c.startDate} to ${addDays(c.startDate, 6)}, link ${c.productUrl}`,
    `posts: ${count("draft")} draft, ${count("approved")} approved, ${count("rejected")} rejected, ${count("published")} published (nothing is published automatically)`,
    ...c.posts.map((p) => `  day ${p.day} ${p.date} ${p.platform.padEnd(8)} ${p.status.padEnd(9)} ${p.id}  ${p.theme}${p.published ? `  ${p.published.url}` : ""}${p.decision?.note ? `  (${p.decision.note})` : ""}`),
    recorded ? `verified results (owner-recorded from platform analytics): impressions ${sum("impressions")}, reactions ${sum("reactions")}, comments ${sum("comments")}, shares ${sum("shares")}, clicks ${sum("clicks")}` : "results: none recorded (no engagement is known)",
    "sales: see 'product report' (recorded from Payhip with 'product record')",
  ].join("\n") + "\n";
}

const flags = (args: readonly string[], allowed: readonly string[]) => {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) { if (!allowed.includes(args[i]) || args[i + 1] === undefined) throw new Error(`unknown or incomplete option ${args[i]}`); out[args[i]] = args[i + 1]; }
  return out;
};
const int = (s: string | undefined, k: string) => { if (s === undefined || !/^\d+$/.test(s)) throw new Error(`${k}: a whole number`); return Number(s); };
export const CAMPAIGN_USAGE = "campaign create <product> --url https://payhip.com/b/<code> [--start YYYY-MM-DD] | list | show <campaign> | post <campaign> <post> | revise <campaign> <post> --text-file <file> | export <campaign> --platform facebook|linkedin [--save] | approve <campaign> <post> [--note <text>] | reject <campaign> <post> --note <text> | published <campaign> <post> --url <post link> | record <campaign> <post> --period YYYY-MM-DD..YYYY-MM-DD --impressions N --reactions N --comments N --shares N --clicks N --source <text> [--evidence <file>]";

export async function campaignCli(args: readonly string[], ctx: { store: Store; out: (s: string) => void; now: () => Date; interactive: () => boolean }): Promise<number> {
  const [sub, a, b, ...rest] = args;
  const { store, out } = ctx;
  const locked = <T>(fn: () => T) => withLock(store.dir, async () => fn());
  if (sub === "create") { const f = flags([b, ...rest].filter((x) => x !== undefined), ["--url", "--start"]); const c = await locked(() => createCampaign(store, String(a), { url: f["--url"] ?? "", start: f["--start"], now: ctx.now() })); out(campaignStatus(c)); out("Drafts only. Review each post with 'campaign post', then approve or reject it.\n"); return 0; }
  if (sub === "list") { const cs = store.campaigns(); out(cs.length ? cs.map((c) => `${c.id} ${c.productId} ${c.startDate} ${c.posts.filter((p) => p.status === "published").length}/${c.posts.length} published`).join("\n") + "\n" : "no campaigns\n"); return 0; }
  if (sub === "show") { out(campaignStatus(getCampaign(store, String(a)))); return 0; }
  if (sub === "post") { const c = getCampaign(store, String(a)); const p = getPost(c, String(b)); out(`${p.id} day ${p.day} ${p.date} ${p.platform} ${p.status}\n---\n${p.text}\n---\n${p.text.length} characters\n`); return 0; }
  if (sub === "revise") {
    const f = flags(rest, ["--text-file"]);
    if (!f["--text-file"]) throw new Error("campaign revise <campaign> <post> --text-file <file>");
    let fd: number;
    try { fd = fs.openSync(f["--text-file"], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw new Error("--text-file: cannot open the file (links are not followed)"); }
    let text: string;
    try { const st = fs.fstatSync(fd); if (!st.isFile() || st.size > 20_000) throw new Error("--text-file: a regular file up to 20 KB"); text = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
    const p = await locked(() => revisePost(store, String(a), String(b), text, ctx.now()));
    out(`${p.id} revised: it is now a DRAFT and needs your approval again ('campaign approve ${a} ${p.id}'); the previous version is kept in its history\n`);
    return 0;
  }
  if (sub === "export") {
    const save = rest.includes("--save");
    const f = flags([b, ...rest].filter((x) => x !== undefined && x !== "--save"), ["--platform"]);
    const platform = f["--platform"];
    if (platform !== "facebook" && platform !== "linkedin") throw new Error("--platform: facebook or linkedin");
    const c = getCampaign(store, String(a));
    const doc = exportHandoff(c, platform);
    if (!save) { out(doc); return 0; }
    const product = store.products().find((x) => x.id === c.productId);
    if (!product) throw new Error(`no product ${c.productId}`);
    const dir = store.assetDir(product.ventureId, c.id);
    const name = `${platform}-handoff-${ctx.now().toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase()}.md`;
    await locked(() => store.writer(dir, [])(name, doc));
    store.audit({ kind: "campaign-exported", campaign: c.id, platform, file: name }, ctx.now());
    out(`${path.join(dir, name)}\n(nothing was scheduled or published)\n`);
    return 0;
  }
  if (sub === "approve" || sub === "reject") { const f = flags(rest, ["--note"]); const p = await locked(() => decidePost(store, String(a), String(b), { approve: sub === "approve", note: f["--note"] ?? "", interactive: ctx.interactive() }, ctx.now())); out(`${p.id} ${p.status}${p.status === "approved" ? ": publish it yourself on " + p.platform + ", then record the link with 'campaign published'" : ""}\n`); return 0; }
  if (sub === "published") { const f = flags(rest, ["--url"]); const p = await locked(() => recordPublished(store, String(a), String(b), f["--url"] ?? "", ctx.now())); out(`${p.id} recorded as published at ${p.published!.url} (by you; nothing was posted by Automaton)\n`); return 0; }
  if (sub === "record") {
    const f = flags(rest, ["--period", "--impressions", "--reactions", "--comments", "--shares", "--clicks", "--source", "--evidence"]);
    const [ps, pe] = (f["--period"] ?? "").split("..");
    const r = await locked(() => recordResults(store, String(a), String(b), { periodStart: ps ?? "", periodEnd: pe ?? "", impressions: int(f["--impressions"], "--impressions"), reactions: int(f["--reactions"], "--reactions"), comments: int(f["--comments"], "--comments"), shares: int(f["--shares"], "--shares"), clicks: int(f["--clicks"], "--clicks"), source: f["--source"] ?? "", evidenceFile: f["--evidence"] }, ctx.now()));
    out(`recorded ${r.id}: ${r.periodStart}..${r.periodEnd}, ${r.impressions} impressions, ${r.clicks} clicks (${r.verification})\n`);
    return 0;
  }
  out(`Usage: ${CAMPAIGN_USAGE}\n`);
  return 2;
}
