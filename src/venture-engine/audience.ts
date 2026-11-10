/**
 * Audience and content engine: a 14-day organic marketing experiment for a live product, with platform-specific
 * content packages for LinkedIn, Facebook, Instagram, TikTok, YouTube Shorts and Pinterest.
 *
 * Content is educational first: every day's piece teaches one practical step taken from the product's OWN files
 * (its checklists and guides), with a soft call to action; a direct "get the kit" call to action appears on only 3 of
 * the 14 days. Nothing is invented (no results, numbers, testimonials), the only link is the product's live URL
 * (optionally with UTM parameters), and video platforms get scripts, storyboards and shot lists: no video is produced.
 *
 *   audience plan <product> [--start YYYY-MM-DD] [--utm]   writes audience/<pln-id>/ (plan, calendar, content)
 *   audience content <product> | calendar <product> | status
 *   audience approve <plan> --day N [--note <text>]        interactive terminal only; bound to the content hash
 *   audience posted <plan> --day N --url <post link>       records publication evidence (the post's own link)
 *
 * Calendar: one primary action per day, never two on the same channel on one day; channels with an outside blocker
 * (for example Facebook verification) are left out and listed. Nothing is posted, scheduled, followed, messaged or
 * paid for. A rerun with unchanged inputs returns the existing plan.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_BRAND } from "./brands.js";
import { stopReason, withLock } from "./control.js";
import { overlap } from "./evaluate.js";
import { readPitch } from "./marketing.js";
import { londonDate } from "./operations.js";
import { misleadingClaims, type Product } from "./products.js";
import { ensurePrivateDir, newId, sha256, type Store } from "./store.js";
import type { Asset } from "./types.js";

export const CHANNELS = ["linkedin", "facebook", "instagram", "tiktok", "youtube-shorts", "pinterest"] as const;
export type Channel = (typeof CHANNELS)[number];
export const EXPERIMENT_DAYS = 14;
const BUY_DAYS = new Set([5, 10, 14]);
const HOSTS: Readonly<Record<Channel, RegExp>> = { linkedin: /^(www\.)?linkedin\.com$/, facebook: /^(www\.|m\.)?facebook\.com$|^fb\.com$/, instagram: /^(www\.)?instagram\.com$/,
  tiktok: /^(www\.)?tiktok\.com$/, "youtube-shorts": /^(www\.)?youtube\.com$|^youtu\.be$/, pinterest: /^([a-z]{2}\.|www\.)?pinterest\.[a-z.]+$|^pin\.it$/ };
export const CHANNEL_INFO: Readonly<Record<Channel, { label: string; kind: "text" | "image" | "video"; max: number; why: string; rules: string }>> = {
  linkedin: { label: "LinkedIn", kind: "text", max: 1300, why: "freelancers and consultants share working practices there", rules: "post on your own profile or page; no connection-request or DM campaigns" },
  facebook: { label: "Facebook", kind: "text", max: 600, why: "your business Page and groups that allow self-promotion", rules: "read each group's rules; no repeated posting across groups" },
  instagram: { label: "Instagram", kind: "image", max: 2200, why: "carousel tips are easy to save and share", rules: "post from your own account; at most 5 relevant hashtags; no follow/unfollow tactics" },
  tiktok: { label: "TikTok", kind: "video", max: 300, why: "short how-to videos reach people starting out as freelancers", rules: "original footage only; follow TikTok's commercial content disclosure settings" },
  "youtube-shorts": { label: "YouTube Shorts", kind: "video", max: 100, why: "searchable short how-tos with a lasting audience", rules: "original footage; no misleading titles or thumbnails" },
  pinterest: { label: "Pinterest", kind: "image", max: 500, why: "checklists and templates are saved and searched for months", rules: "one pin per idea; link only to the product page" },
};
const HOOKS = ["One habit worth building this week:", "A step that is easy to skip:", "Save this for your next project:", "Small change, less admin:", "Try this before your next client:", "A quick check that saves time later:", "From the checklist:"];
const HASHTAGS = ["#freelancer", "#freelancetips", "#smallbusiness", "#selfemployed", "#productivity"];

export interface PlanDay { readonly day: number; readonly date: string; readonly channel: Channel; readonly tip: string; readonly cta: "soft" | "buy"; readonly text: string; readonly hash: string;
  readonly approval: { readonly at: string; readonly hash: string; readonly note: string } | null; readonly posted: { readonly url: string; readonly at: string } | null }
export interface AudiencePlan {
  readonly id: string; readonly brand: string; readonly productId: string; readonly version: number; readonly inputHash: string; readonly createdAt: string;
  readonly start: string; readonly end: string; readonly url: string; readonly utm: boolean; readonly channels: readonly Channel[]; readonly blocked: readonly { readonly channel: Channel; readonly reason: string }[];
  readonly days: readonly PlanDay[]; readonly dir: string; readonly files: readonly Asset[];
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const utmLink = (url: string, channel: Channel, planId: string) => `${url}${url.includes("?") ? "&" : "?"}utm_source=${channel}&utm_medium=social&utm_campaign=${planId}`;

/** Practical steps taken from the product's own Markdown files (checklist items and bullet points). */
export function tipsFrom(store: Store, p: Product): string[] {
  const read = store.reader(store.assetDir(p.ventureId, p.id));
  const seen = new Set<string>(), out: string[] = [];
  for (const n of p.deliverables.filter((x) => x.endsWith(".md") && x !== "start-here.md")) {
    for (const m of (read(n) ?? "").matchAll(/^\s*- (?:\[ \] )?(.+)$/gm)) {
      const t = m[1].replace(/`([^`]+)`/g, "$1").replace(/\s*\(see [^)]*\)/gi, "").replace(/[.:;]+$/, "").trim();
      if (t.split(/\s+/).length < 5 || t.length > 160 || /\[\[|\]\]|https?:|\.(csv|md|html)\b/i.test(t) || misleadingClaims(t).length) continue;
      const k = t.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(t); }
    }
  }
  return out;
}

function piece(ch: Channel, p: Product, day: number, tip: string, cta: "soft" | "buy", link: string): string {
  const hook = HOOKS[(day - 1) % HOOKS.length];
  const price = `${p.currency === "GBP" ? "£" : p.currency === "EUR" ? "€" : "$"}${p.price}`;
  const soft = `It is one of the steps in the ${p.name}.`;
  const buy = `The ${p.name} has the full routine and templates: ${price}, one-off, instant download.`;
  const tail = cta === "buy" ? buy : soft;
  switch (ch) {
    case "linkedin": return `${hook}\n\n${cap(tip)}.\n\nIt takes a minute, and it is easier to keep as a habit than to fix later.\n\n${tail}\n${link}`;
    case "facebook": return `${hook}\n\n${cap(tip)}.\n\n${tail} ${link}`;
    case "instagram": return `CAPTION:\n${hook} ${cap(tip)}.\n\n${tail} Link in bio.\n${HASHTAGS.join(" ")}\n\nCAROUSEL BRIEF (4 slides, 1080x1350):\n1. "${hook}"\n2. "${cap(tip)}"\n3. "Why: it keeps the work and the paperwork in step."\n4. "${p.name}${cta === "buy" ? `: ${price}` : ""}" (no ratings or results)\n\nBIO LINK: ${link}`;
    case "tiktok": case "youtube-shorts": return `${ch === "tiktok" ? `CAPTION (${CHANNEL_INFO.tiktok.max} max):` : "TITLE (100 max):"}\n${ch === "tiktok" ? `${hook} ${cap(tip)} #freelancer #smallbusiness` : `${cap(tip).slice(0, 90)}`}\n\nSCRIPT (about 30 seconds, spoken to camera):\n0-3s  "${hook}"\n3-15s "${cap(tip)}."\n15-25s Show it on screen: open the matching file of the ${p.name} and point to the step.\n25-30s "${cta === "buy" ? `The full kit is ${price}, link in ${ch === "tiktok" ? "bio" : "the description"}.` : `More steps like this on this channel.`}"\n\nSTORYBOARD:\n1. Face to camera, hook as on-screen text\n2. Screen recording of the step (real file, no invented data)\n3. Close-up of the step text\n4. End card: ${p.name}${cta === "buy" ? `, ${price}` : ""}\n\nSHOT LIST: phone camera (vertical 9:16), screen recording of the file, end card made in any editor.\nNO VIDEO HAS BEEN PRODUCED: record it yourself.\n${ch === "youtube-shorts" ? `\nDESCRIPTION:\n${cap(tip)}. ${tail} ${link}` : `\nBIO LINK: ${link}`}`;
    case "pinterest": return `PIN TITLE (100 max):\n${cap(tip).slice(0, 95)}\n\nDESCRIPTION:\n${cap(tip)}. ${tail}\n\nIMAGE BRIEF (vertical 1000x1500): the step as large text over a clean photo of a desk or the printed checklist; ${p.name} name at the bottom; no ratings or results.\n\nLINK: ${link}`;
  }
}

export interface PlanContext { readonly segments: readonly string[]; readonly themes: readonly string[] }
function context(store: Store, p: Product): PlanContext & { audience: string; problem: string } {
  const v = store.ventures().find((x) => x.id === p.ventureId);
  const audience = v?.opportunity.audience ?? "freelancers", problem = v?.opportunity.problem ?? p.name;
  const segments = p.blueprint === "freelance-invoicing"
    ? ["Freelance designers, writers and developers who invoice several clients a month", "Consultants and coaches billing by project or retainer", "New freelancers setting up their first invoicing routine"]
    : [cap(audience), `${cap(audience)} who are just starting out`];
  const read = store.reader(store.assetDir(p.ventureId, p.id));
  const themes = [...new Set(p.deliverables.filter((n) => n.endsWith(".md") && n !== "start-here.md").flatMap((n) => [...(read(n) ?? "").matchAll(/^## (?:\d+\.\s*)?(.+)$/gm)].map((m) => m[1].trim())))].slice(0, 8);
  return { audience, problem, segments, themes };
}

/** Builds (or returns the unchanged existing) 14-day plan for a live product. */
export function createPlan(store: Store, productId: string, now: Date, opts: { start?: string; utm?: boolean } = {}): { plan: AudiencePlan; reused: boolean } {
  const why = stopReason(store.dir);
  if (why) throw new Error(`STOP is set (${why}): nothing was planned`);
  const p = store.products().find((x) => x.id === productId);
  if (!p) throw new Error(`no product ${productId}`);
  if (p.status !== "live" || !p.live) throw new Error(`${productId} is ${p.status}: audience plans link to a live product page (product mark-live first)`);
  const today = londonDate(now);
  const start = opts.start ?? addDays(today, 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start < today) throw new Error("--start: YYYY-MM-DD, today or later");
  const blockers = store.operations().blockers ?? [];
  const blocked = CHANNELS.filter((c) => blockers.some((b) => b.scope === c)).map((c) => ({ channel: c, reason: blockers.find((b) => b.scope === c)!.reason }));
  const channels = CHANNELS.filter((c) => !blocked.some((b) => b.channel === c));
  if (!channels.length) throw new Error("every channel is blocked");
  const tips = tipsFrom(store, p);
  if (tips.length < EXPERIMENT_DAYS) throw new Error(`${productId}: only ${tips.length} practical steps found in its files (${EXPERIMENT_DAYS} needed for distinct daily content)`);
  const inputHash = sha256(JSON.stringify({ files: p.files.map((f) => [f.name, f.sha256]), url: p.live.url, start, blocked, utm: !!opts.utm }));
  const plans = store.audiencePlans();
  const same = plans.find((x) => x.productId === p.id && x.inputHash === inputHash);
  if (same) return { plan: same, reused: true };
  // Avoid repeating content: skip steps already used in earlier plans or very similar to existing campaign posts.
  const used = new Set(plans.filter((x) => x.productId === p.id).flatMap((x) => x.days.map((d) => d.tip.toLowerCase())));
  const posts = store.campaigns().filter((c) => c.productId === p.id).flatMap((c) => c.posts.map((x) => x.text));
  const fresh = tips.filter((t) => !used.has(t.toLowerCase()) && !posts.some((x) => overlap(t, x) >= 0.6));
  const pool = fresh.length >= EXPERIMENT_DAYS ? fresh : [...fresh, ...tips.filter((t) => !fresh.includes(t))];
  const id = newId("pln");
  const days: PlanDay[] = Array.from({ length: EXPERIMENT_DAYS }, (_, i) => {
    const day = i + 1, channel = channels[i % channels.length], cta: "soft" | "buy" = BUY_DAYS.has(day) ? "buy" : "soft";
    const link = opts.utm ? utmLink(p.live!.url, channel, id) : p.live!.url;
    const text = piece(channel, p, day, pool[i], cta, link);
    return { day, date: addDays(start, i), channel, tip: pool[i], cta, text, hash: sha256(text), approval: null, posted: null };
  });
  const problems = days.flatMap((d) => [...misleadingClaims(d.text).map((w) => `day ${d.day}: ${w}`), ...(d.text.replaceAll(p.live!.url, "").match(/https?:\/\/|www\./) ? [`day ${d.day}: a link other than the product URL`] : []),
    ...(CHANNEL_INFO[d.channel].kind === "text" && d.text.length > CHANNEL_INFO[d.channel].max ? [`day ${d.day}: too long for ${d.channel}`] : [])]);
  if (problems.length) throw new Error(`plan not saved: ${problems.join("; ")}`);
  const c = context(store, p);
  const dir = path.join(store.dir, "audience", id);
  ensurePrivateDir(path.dirname(dir)); ensurePrivateDir(dir);
  const files: Asset[] = [];
  const write = store.writer(dir, files);
  const pitch = readPitch(store.reader(store.assetDir(p.ventureId, p.id))("landing.html") ?? "");
  write("plan.md", `# Audience plan and 14-day experiment: ${p.name} (${DEFAULT_BRAND.name})

Drafts only: nothing was posted, scheduled, followed, messaged or paid for. Product page: ${p.live.url}

## Customer and problem

- Target customer: ${c.audience}
- Problem solved: ${c.problem}
- Offer: ${pitch.offer}

## Audience segments (hypotheses to test, not research findings)

${c.segments.map((s) => `- ${s}`).join("\n")}

## Channels

${channels.map((ch) => `- **${CHANNEL_INFO[ch].label}**: ${CHANNEL_INFO[ch].why}. Rules: ${CHANNEL_INFO[ch].rules}.`).join("\n")}
${blocked.map((b) => `- **${CHANNEL_INFO[b.channel].label}: left out**, blocked (${b.reason}). Run 'operations unblock ${b.channel}' and plan again when resolved.`).join("\n")}

## Educational themes (from the product's own sections)

${c.themes.map((t) => `- ${t}`).join("\n") || "- the product's checklist steps"}

## Calls to action

- Most days: a soft mention ("It is one of the steps in the ${p.name}") with the link.
- Days ${[...BUY_DAYS].join(", ")}: a direct, plain offer with the price. No urgency, scarcity, discounts or results claims.

## Experiment (${start} to ${addDays(start, EXPERIMENT_DAYS - 1)})

- Hypothesis: daily educational posts, one channel a day, lead to at least one verified order within 14 days.
- Primary measure: verified orders attributed to this plan ('sales record ${p.id} ... --plan ${id} --channel <channel>').
- Secondary: verified clicks or visits per channel, only if you can read them ('revenue record --plan ${id} --channel <c> --date <d> --clicks N').
- Success: at least 1 verified order. Learn: which channel had verified visits or orders; drop channels with none.
- Not measured unless recorded: reach, impressions, likes. Unknown is not zero.
${opts.utm ? `- Links carry UTM parameters (utm_source=<channel>, utm_campaign=${id}); use them only if your analytics shows them.` : "- Links are the plain product URL. Plan again with --utm if you can read UTM parameters in your analytics."}
`);
  write("calendar.md", `# Calendar: ${p.name}, ${start} to ${addDays(start, EXPERIMENT_DAYS - 1)}

One primary action per day; never two on the same channel on one day.

| Day | Date | Channel | Action | Call to action | Step taught |
|---|---|---|---|---|---|
${days.map((d) => `| ${d.day} | ${d.date} | ${CHANNEL_INFO[d.channel].label} | ${CHANNEL_INFO[d.channel].kind === "video" ? "record and post a short video" : CHANNEL_INFO[d.channel].kind === "image" ? "post the image or carousel" : "post"} | ${d.cta} | ${d.tip.replace(/\|/g, "/")} |`).join("\n")}
`);
  write("calendar.csv", ["Day,Date,Channel,Call to action,Step", ...days.map((d) => `${d.day},${d.date},${d.channel},${d.cta},"${d.tip.replace(/"/g, '""')}"`)].join("\r\n") + "\r\n");
  for (const ch of channels) {
    const mine = days.filter((d) => d.channel === ch);
    write(`content-${ch}.md`, `# ${CHANNEL_INFO[ch].label} content: ${p.name}\n\nDrafts for owner approval ('audience approve ${id} --day N'). Rules: ${CHANNEL_INFO[ch].rules}.${CHANNEL_INFO[ch].kind === "video" ? " No video has been produced: these are scripts to record yourself." : ""}\n\n${mine.map((d) => `## Day ${d.day} (${d.date}, ${d.cta} call to action)\n\n\`\`\`text\n${d.text}\n\`\`\``).join("\n\n")}\n`);
  }
  const plan: AudiencePlan = { id, brand: DEFAULT_BRAND.id, productId: p.id, version: p.version, inputHash, createdAt: now.toISOString(), start, end: addDays(start, EXPERIMENT_DAYS - 1), url: p.live.url, utm: !!opts.utm, channels, blocked, days, dir, files };
  write("plan.json", JSON.stringify({ ...plan, files: undefined }, null, 2) + "\n");
  store.saveAudiencePlans([...plans, { ...plan, files }]);
  store.audit({ kind: "audience-plan", plan: id, product: p.id, start, channels, blocked: blocked.map((b) => b.channel) }, now);
  return { plan: { ...plan, files }, reused: false };
}

const getPlan = (store: Store, id: string) => { const p = store.audiencePlans().find((x) => x.id === id); if (!p) throw new Error(`no audience plan ${id}`); return p; };
const savePlan = (store: Store, p: AudiencePlan) => store.saveAudiencePlans(store.audiencePlans().map((x) => (x.id === p.id ? p : x)));
const getDay = (p: AudiencePlan, n: number) => { const d = p.days.find((x) => x.day === n); if (!d) throw new Error(`--day: 1 to ${p.days.length}`); return d; };

/** Owner approval of one day's content, at an interactive terminal; bound to the exact text. */
export function approveDay(store: Store, planId: string, day: number, a: { note: string; interactive: boolean }, now: Date): PlanDay {
  if (!a.interactive) throw new Error("approving content needs an interactive terminal: automated jobs cannot approve");
  const p = getPlan(store, planId), d = getDay(p, day);
  if (sha256(d.text) !== d.hash) throw new Error(`day ${day}: content changed since it was prepared`);
  const next: PlanDay = { ...d, approval: { at: now.toISOString(), hash: d.hash, note: a.note.trim().slice(0, 200) } };
  savePlan(store, { ...p, days: p.days.map((x) => (x.day === day ? next : x)) });
  store.audit({ kind: "audience-approved", plan: planId, day, hash: d.hash }, now);
  return next;
}

/** Records publication evidence: the post's own link on the planned channel, for approved content, on or after its date. */
export function recordPosted(store: Store, planId: string, day: number, url: string, now: Date): PlanDay {
  const p = getPlan(store, planId), d = getDay(p, day);
  if (!d.approval || d.approval.hash !== d.hash) throw new Error(`day ${day} is not approved: only approved content can be recorded as posted`);
  if (d.posted) throw new Error(`day ${day} is already recorded as posted (${d.posted.url})`);
  if (londonDate(now) < d.date) throw new Error(`day ${day} is planned for ${d.date}: record it on or after that date`);
  let u: URL; try { u = new URL(url); } catch { throw new Error("--url: not a URL"); }
  if (u.protocol !== "https:" || u.username || u.password || !HOSTS[d.channel].test(u.hostname) || url.length > 300) throw new Error(`--url: the post's https link on ${CHANNEL_INFO[d.channel].label}`);
  if (store.audiencePlans().some((x) => x.days.some((y) => y.posted?.url === u.toString()))) throw new Error("--url: that post link is already recorded");
  const next: PlanDay = { ...d, posted: { url: u.toString(), at: now.toISOString() } };
  savePlan(store, { ...p, days: p.days.map((x) => (x.day === day ? next : x)) });
  store.audit({ kind: "audience-posted", plan: planId, day, url: next.posted!.url }, now);
  return next;
}

export const activePlan = (store: Store, productId: string, today: string) => store.audiencePlans().filter((x) => x.productId === productId && x.end >= today).at(-1) ?? null;

export const AUDIENCE_USAGE = "audience plan <product> [--start YYYY-MM-DD] [--utm] | audience content <product> | audience calendar <product> | audience status | audience approve <plan> --day N [--note <text>] | audience posted <plan> --day N --url <post link>";

export async function audienceCli(args: readonly string[], ctx: { store: Store; out: (s: string) => void; now: () => Date; interactive: () => boolean }): Promise<number> {
  const [sub, a, ...rest] = args;
  const { store, out } = ctx;
  const f: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) { if (rest[i] === "--utm") { f["--utm"] = "1"; continue; } if (!rest[i].startsWith("--") || rest[i + 1] === undefined) throw new Error(AUDIENCE_USAGE); f[rest[i]] = rest[++i]; }
  const latest = (pid: string) => { const x = store.audiencePlans().filter((y) => y.productId === pid).at(-1); if (!x) throw new Error(`no audience plan for ${pid}: run 'audience plan ${pid}'`); return x; };
  if (sub === "plan") {
    const { plan, reused } = await withLock(store.dir, async () => createPlan(store, String(a), ctx.now(), { start: f["--start"], utm: !!f["--utm"] }));
    out(`${reused ? "unchanged: " : ""}audience plan ${plan.id} for ${plan.productId}: ${plan.start} to ${plan.end}, channels ${plan.channels.join(", ")}${plan.blocked.length ? `; left out (blocked): ${plan.blocked.map((b) => b.channel).join(", ")}` : ""}\n${plan.dir}\nDrafts only: nothing was posted, scheduled or messaged.\n`);
    return 0;
  }
  if (sub === "content") { const x = latest(String(a)); out(`${x.files.filter((y) => y.name.startsWith("content-")).map((y) => path.join(x.dir, y.name)).join("\n")}\n`); return 0; }
  if (sub === "calendar") { const x = latest(String(a)); out(fs.readFileSync(path.join(x.dir, "calendar.md"), "utf8")); return 0; }
  if (sub === "status") {
    const ps = store.audiencePlans(); const today = londonDate(ctx.now());
    out(ps.length ? ps.map((x) => `${x.id} [${x.brand}] ${x.productId} ${x.start}..${x.end} ${today < x.start ? "not started" : today > x.end ? "ended" : `day ${Math.round((Date.parse(today) - Date.parse(x.start)) / 86_400_000) + 1}`}: ${x.days.filter((d) => d.approval).length} approved, ${x.days.filter((d) => d.posted).length} posted of ${x.days.length}`).join("\n") + "\n" : "no audience plans\n");
    return 0;
  }
  if (sub === "approve") { const d = await withLock(store.dir, async () => approveDay(store, String(a), Number(f["--day"]), { note: f["--note"] ?? "", interactive: ctx.interactive() }, ctx.now())); out(`day ${d.day} (${d.channel}, ${d.date}) approved: post it yourself, then 'audience posted ${a} --day ${d.day} --url <post link>'\n`); return 0; }
  if (sub === "posted") { if (!f["--url"]) throw new Error("--url is required"); const d = await withLock(store.dir, async () => recordPosted(store, String(a), Number(f["--day"]), f["--url"], ctx.now())); out(`day ${d.day} recorded as posted: ${d.posted!.url}\n`); return 0; }
  out(`Usage: ${AUDIENCE_USAGE}\n`);
  return 2;
}
