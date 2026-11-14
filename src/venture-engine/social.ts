/**
 * Social publishing for owner-approved audience-plan content (Instagram and Pinterest), through official platform
 * APIs only. No passwords, cookies or browser automation: an account is connected with an OAuth access token the
 * owner obtained from the platform's own developer tools, saved in a private file and never printed.
 *
 *   social connect <platform> --account <id> --token-file <file> [--expires YYYY-MM-DD]
 *   social disconnect <platform> | social status
 *   social queue <plan> [--day N]          approved, unposted Instagram/Pinterest days -> queue (with a rendered card)
 *   social media <item> --file <png|jpg>   use a real product screenshot instead of the card
 *   social list | social cancel <item>
 *   social run [--live]                    publishes due items: DRY RUN unless --live AND live mode is on
 *   social live <platform> on|off          interactive terminal only; refused until the platform adapter is verified
 *
 * Safety: only content whose owner approval still matches its text is published; one queue item per plan day
 * (idempotency key); at most maxPostsPerDay per platform; STOP stops everything; a failure after the publishing request
 * was sent is "needs-check" and never retried automatically (it may have been published); only clearly transient,
 * pre-publication failures are retried, at most 3 times with backoff. Every step is audited.
 *
 * The Instagram and Pinterest adapters are NOT implemented yet: their official documentation could not be reached from
 * this environment, and endpoints are not guessed. Until they are implemented and verified, live mode cannot be turned
 * on and runs are dry runs.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHANNEL_INFO, recordPosted, type AudiencePlan, type PlanDay } from "./audience.js";
import { DEFAULT_BRAND } from "./brands.js";
import { stopReason, withLock } from "./control.js";
import { renderCard } from "./graphics.js";
import { londonDate, TIMEZONE } from "./operations.js";
import { imageInfo } from "./raster.js";
import { ensurePrivateDir, newId, sha256, type Store } from "./store.js";

export const PLATFORMS = ["instagram", "pinterest"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const MAX_ATTEMPTS = 3;
const BACKOFF_MIN = [15, 60, 240];

// ---------------------------------------------------------------- adapters

export interface PublishRequest { readonly platform: Platform; readonly accountId: string; readonly token: string; readonly caption: string; readonly title: string | null; readonly link: string; readonly media: { readonly file: string; readonly type: "png" | "jpeg"; readonly sha256: string; readonly width: number; readonly height: number } }
export type PublishResult =
  | { readonly kind: "published"; readonly externalId: string; readonly url: string }
  | { readonly kind: "retryable"; readonly error: string }   // definitely not published (for example rate limited before the request was accepted)
  | { readonly kind: "ambiguous"; readonly error: string }   // the publishing request may have succeeded
  | { readonly kind: "failed"; readonly error: string };     // definitely not published; needs the owner (bad token, rejected media)
export interface PublishAdapter {
  readonly platform: Platform;
  /** True only after the adapter was implemented and checked against the platform's official documentation. */
  readonly verified: boolean;
  readonly note: string;
  validate(accountId: string, token: string): Promise<{ ok: boolean; detail: string }>;
  publish(req: PublishRequest): Promise<PublishResult>;
}
const pending = (platform: Platform, docs: string): PublishAdapter => ({
  platform, verified: false,
  note: `not implemented: the official ${platform} API documentation (${docs}) could not be reached from this environment, so no endpoint is guessed`,
  async validate() { return { ok: false, detail: `the ${platform} adapter is not implemented yet` }; },
  async publish() { return { kind: "failed", error: `the ${platform} adapter is not implemented yet: nothing was sent` }; },
});
export const DEFAULT_ADAPTERS: Readonly<Record<Platform, PublishAdapter>> = {
  instagram: pending("instagram", "developers.facebook.com"),
  pinterest: pending("pinterest", "developers.pinterest.com"),
};

// ---------------------------------------------------------------- connections and settings (private files)

export interface Connection { readonly platform: Platform; readonly accountId: string; readonly tokenSha256: string; readonly expiresOn: string | null; readonly connectedAt: string }
interface Settings { live: Record<Platform, boolean>; maxPostsPerDay: number; postTime: string }
const DEFAULT_SETTINGS: Settings = { live: { instagram: false, pinterest: false }, maxPostsPerDay: 1, postTime: "12:30" };
const dirOf = (store: Store) => { const d = path.join(store.dir, "social"); ensurePrivateDir(d); return d; };
/** Path for reading only: does not create the folder (the daily report reads the queue). */
const at = (store: Store, name: string) => path.join(store.dir, "social", name);
function readPrivate(file: string): string | null {
  let fd: number; try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return null; }
  try { const s = fs.fstatSync(fd); if (!s.isFile() || (s.mode & 0o077) !== 0) throw new Error(`${path.basename(file)} must be a regular file with mode 600`); return fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
}
function writePrivate(file: string, text: string): void { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" }); fs.renameSync(tmp, file); }
const platform = (s: string | undefined): Platform => { if (!PLATFORMS.includes(s as Platform)) throw new Error(`platform: ${PLATFORMS.join(" or ")}`); return s as Platform; };
export const settings = (store: Store): Settings => { const t = readPrivate(at(store, "settings.json")); return t ? { ...DEFAULT_SETTINGS, ...JSON.parse(t) } : DEFAULT_SETTINGS; };
export const connection = (store: Store, p: Platform): (Connection & { token: string }) | null => { const t = readPrivate(at(store, `${p}.json`)); return t ? JSON.parse(t) : null; };

/** Saves an OAuth access token read from a file (never from the command line, never printed). */
export function connect(store: Store, p: Platform, r: { accountId: string; tokenFile: string; expiresOn?: string }, now: Date): Connection {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(r.accountId)) throw new Error("--account: the platform account or board id (letters, digits, _ . : -)");
  if (r.expiresOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(r.expiresOn)) throw new Error("--expires: YYYY-MM-DD");
  let fd: number; try { fd = fs.openSync(r.tokenFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw new Error("--token-file: cannot open the file (links are not followed)"); }
  let token: string;
  try { const s = fs.fstatSync(fd); if (!s.isFile() || s.size > 8192) throw new Error("--token-file: a regular file up to 8 KB"); token = fs.readFileSync(fd, "utf8").trim(); } finally { fs.closeSync(fd); }
  if (!/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(token)) throw new Error("--token-file: must contain only the access token (one line). Passwords are never accepted");
  const c: Connection = { platform: p, accountId: r.accountId, tokenSha256: sha256(token), expiresOn: r.expiresOn ?? null, connectedAt: now.toISOString() };
  writePrivate(path.join(dirOf(store), `${p}.json`), JSON.stringify({ ...c, token }) + "\n");
  store.audit({ kind: "social-connected", platform: p, account: r.accountId, tokenFingerprint: c.tokenSha256.slice(0, 12), expiresOn: c.expiresOn }, now);
  return c;
}
export function disconnect(store: Store, p: Platform, now: Date): boolean {
  const f = at(store, `${p}.json`);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f); store.audit({ kind: "social-disconnected", platform: p }, now); return true;
}
export function setLive(store: Store, p: Platform, on: boolean, a: { interactive: boolean; adapters: Readonly<Record<Platform, PublishAdapter>> }, now: Date): void {
  if (on) {
    if (!a.interactive) throw new Error("turning live publishing on needs an interactive terminal");
    if (!a.adapters[p].verified) throw new Error(`live publishing cannot be turned on: ${a.adapters[p].note}`);
    if (!connection(store, p)) throw new Error(`${p} is not connected ('social connect ${p} ...')`);
  }
  const s = settings(store);
  writePrivate(path.join(dirOf(store), "settings.json"), JSON.stringify({ ...s, live: { ...s.live, [p]: on } }, null, 2) + "\n");
  store.audit({ kind: "social-live", platform: p, on }, now);
}

// ---------------------------------------------------------------- queue

export type QueueStatus = "queued" | "retry-wait" | "published" | "needs-check" | "failed" | "cancelled";
export interface QueueItem {
  readonly id: string; readonly brand: string; readonly key: string; readonly planId: string; readonly day: number; readonly platform: Platform;
  readonly approvedHash: string; readonly scheduledAt: string; readonly caption: string; readonly title: string | null; readonly link: string;
  readonly media: { readonly file: string; readonly source: "card" | "owner-screenshot"; readonly type: "png" | "jpeg"; readonly sha256: string; readonly width: number; readonly height: number };
  readonly status: QueueStatus; readonly attempts: number; readonly nextAttemptAt: string | null; readonly lastError: string | null;
  readonly externalId: string | null; readonly url: string | null; readonly createdAt: string; readonly updatedAt: string;
}
const queueFile = (store: Store) => path.join(dirOf(store), "queue.json");
export const queue = (store: Store): QueueItem[] => { const t = readPrivate(at(store, "queue.json")); return t ? JSON.parse(t) : []; };
const saveQueue = (store: Store, q: readonly QueueItem[]) => writePrivate(queueFile(store), JSON.stringify(q, null, 1) + "\n");
export const CARD_SIZE: Readonly<Record<Platform, { width: number; height: number }>> = { instagram: { width: 1080, height: 1350 }, pinterest: { width: 1000, height: 1500 } };

/** A London wall-clock time on a date, as a UTC instant (handles GMT/BST). */
export function londonInstant(date: string, hhmm: string): string {
  for (const off of [0, 1]) {
    const d = new Date(`${date}T${hhmm}:00.000Z`); d.setUTCHours(d.getUTCHours() - off);
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    if (f === hhmm && londonDate(d) === date) return d.toISOString();
  }
  throw new Error(`no London time ${hhmm} on ${date}`);
}

/** The text to publish, taken from the approved day's content (caption, or Pinterest title and description). */
export function postText(d: PlanDay): { caption: string; title: string | null } {
  const sect = (name: string) => new RegExp(`(?:^|\\n)${name}[^\\n]*:\\n([\\s\\S]*?)(?=\\n\\n[A-Z]{2,}[A-Z ]*(?: \\([^)\\n]*\\))?:|$)`).exec(d.text)?.[1].trim() ?? null;
  if (d.channel === "instagram") { const c = sect("CAPTION"); if (!c) throw new Error(`day ${d.day}: no caption in the approved content`); return { caption: c, title: null }; }
  if (d.channel === "pinterest") { const t = sect("PIN TITLE"), c = sect("DESCRIPTION"); if (!t || !c) throw new Error(`day ${d.day}: no pin title or description in the approved content`); return { caption: c, title: t }; }
  throw new Error(`day ${d.day} is a ${d.channel} post: only Instagram and Pinterest are published automatically`);
}

const approvedNow = (d: PlanDay) => !!d.approval && d.approval.hash === d.hash && sha256(d.text) === d.hash;

/** Queues approved, unposted Instagram/Pinterest days of a plan (one item per day; reruns add nothing). */
export function enqueue(store: Store, planId: string, now: Date, opts: { day?: number } = {}): { added: QueueItem[]; skipped: string[] } {
  const why = stopReason(store.dir); if (why) throw new Error(`STOP is set (${why}): nothing was queued`);
  const plan = store.audiencePlans().find((x) => x.id === planId) as AudiencePlan | undefined;
  if (!plan) throw new Error(`no audience plan ${planId}`);
  const product = store.products().find((x) => x.id === plan.productId);
  const q = queue(store), added: QueueItem[] = [], skipped: string[] = [];
  const s = settings(store);
  for (const d of plan.days.filter((x) => (opts.day === undefined || x.day === opts.day) && PLATFORMS.includes(x.channel as Platform))) {
    const key = sha256(`${plan.id}:${d.day}`);
    if (q.some((x) => x.key === key && x.status !== "cancelled")) { skipped.push(`day ${d.day}: already queued`); continue; }
    if (d.posted) { skipped.push(`day ${d.day}: already posted (${d.posted.url})`); continue; }
    if (!approvedNow(d)) { skipped.push(`day ${d.day}: not approved (or changed since approval): 'audience approve ${plan.id} --day ${d.day}'`); continue; }
    const { caption, title } = postText(d);
    const id = newId("soc"), p = d.channel as Platform;
    const png = renderCard({ brand: DEFAULT_BRAND.name, hook: d.text.split("\n").find((l) => l.endsWith(":") && !/^[A-Z ()0-9]+:$/.test(l))?.trim() ?? "From the checklist:", body: d.tip.charAt(0).toUpperCase() + d.tip.slice(1),
      footer: `From the ${product?.name ?? "kit"}${d.cta === "buy" && product ? ` · ${product.currency === "GBP" ? "£" : ""}${product.price}` : ""}`, link: plan.url, ...CARD_SIZE[p] });
    const mdir = path.join(dirOf(store), "media"); ensurePrivateDir(mdir);
    const file = path.join(mdir, `${id}.png`); fs.writeFileSync(file, png, { mode: 0o600, flag: "wx" });
    const stamp = now.toISOString();
    const item: QueueItem = { id, brand: DEFAULT_BRAND.id, key, planId: plan.id, day: d.day, platform: p, approvedHash: d.hash, scheduledAt: londonInstant(d.date, s.postTime), caption, title, link: plan.url,
      media: { file, source: "card", type: "png", sha256: createHash("sha256").update(png).digest("hex"), ...CARD_SIZE[p] }, status: "queued", attempts: 0, nextAttemptAt: null, lastError: null, externalId: null, url: null, createdAt: stamp, updatedAt: stamp };
    added.push(item);
  }
  if (added.length) { saveQueue(store, [...q, ...added]); for (const x of added) store.audit({ kind: "social-queued", item: x.id, plan: x.planId, day: x.day, platform: x.platform, scheduledAt: x.scheduledAt }, now); }
  return { added, skipped };
}

const mediaHash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Replaces an item's card with a real screenshot supplied by the owner (PNG or JPEG, at most 8 MB). */
export function useScreenshot(store: Store, itemId: string, file: string, now: Date): QueueItem {
  const q = queue(store), it = q.find((x) => x.id === itemId);
  if (!it) throw new Error(`no queue item ${itemId}`);
  if (!["queued", "retry-wait"].includes(it.status)) throw new Error(`${itemId} is ${it.status}`);
  let fd: number; try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw new Error("--file: cannot open the file (links are not followed)"); }
  let b: Buffer; try { const s = fs.fstatSync(fd); if (!s.isFile() || !s.size || s.size > 8 * 1024 * 1024) throw new Error("--file: a PNG or JPEG up to 8 MB"); b = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  const info = imageInfo(b);
  const dest = path.join(dirOf(store), "media", `${itemId}-screenshot.${info.type === "png" ? "png" : "jpg"}`);
  fs.writeFileSync(dest, b, { mode: 0o600, flag: "wx" });
  const next: QueueItem = { ...it, media: { file: dest, source: "owner-screenshot", type: info.type, sha256: mediaHash(b), width: info.width, height: info.height }, updatedAt: now.toISOString() };
  saveQueue(store, q.map((x) => (x.id === itemId ? next : x)));
  store.audit({ kind: "social-media-replaced", item: itemId, type: info.type, width: info.width, height: info.height, sha256: next.media.sha256 }, now);
  return next;
}

export function cancel(store: Store, itemId: string, now: Date): QueueItem {
  const q = queue(store), it = q.find((x) => x.id === itemId);
  if (!it) throw new Error(`no queue item ${itemId}`);
  if (it.status === "published") throw new Error(`${itemId} is already published (${it.url}); remove it on the platform itself if needed`);
  const next = { ...it, status: "cancelled" as const, updatedAt: now.toISOString() };
  saveQueue(store, q.map((x) => (x.id === itemId ? next : x)));
  store.audit({ kind: "social-cancelled", item: itemId }, now);
  return next;
}

export interface RunOutcome { readonly item: string; readonly platform: Platform; readonly day: number; readonly result: string }

/** Publishes due items. Dry run unless live is requested AND enabled for the platform AND its adapter is verified. */
export async function runQueue(store: Store, now: Date, opts: { live: boolean; adapters?: Readonly<Record<Platform, PublishAdapter>> }): Promise<{ dryRun: boolean; outcomes: RunOutcome[] }> {
  const adapters = opts.adapters ?? DEFAULT_ADAPTERS;
  const why = stopReason(store.dir);
  if (why) return { dryRun: !opts.live, outcomes: [{ item: "-", platform: "instagram", day: 0, result: `STOP is set (${why}): nothing was published` }] };
  const s = settings(store), today = londonDate(now), outcomes: RunOutcome[] = [];
  let q = queue(store);
  const save = (it: QueueItem) => { q = q.map((x) => (x.id === it.id ? it : x)); saveQueue(store, q); };
  const plans = store.audiencePlans();
  for (const it of q.filter((x) => (x.status === "queued" && x.scheduledAt <= now.toISOString()) || (x.status === "retry-wait" && (x.nextAttemptAt ?? "") <= now.toISOString())).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
    const out = (result: string) => outcomes.push({ item: it.id, platform: it.platform, day: it.day, result });
    const plan = plans.find((x) => x.id === it.planId), d = plan?.days.find((x) => x.day === it.day);
    if (!plan || !d) { save({ ...it, status: "cancelled", lastError: "plan or day no longer exists", updatedAt: now.toISOString() }); out("cancelled: plan or day no longer exists"); continue; }
    if (d.posted) { save({ ...it, status: "cancelled", lastError: "already recorded as posted", updatedAt: now.toISOString() }); out(`cancelled: already posted (${d.posted.url})`); continue; }
    if (!approvedNow(d) || d.hash !== it.approvedHash) { save({ ...it, status: "cancelled", lastError: "approval missing or content changed since it was queued", updatedAt: now.toISOString() }); out("cancelled: approval missing or content changed"); continue; }
    const publishedToday = q.filter((x) => x.platform === it.platform && x.status === "published" && londonDate(new Date(x.updatedAt)) === today).length;
    if (publishedToday >= s.maxPostsPerDay) { out(`waiting: daily limit of ${s.maxPostsPerDay} ${it.platform} post(s) reached`); continue; }
    let media: Buffer; try { media = fs.readFileSync(it.media.file); } catch { save({ ...it, status: "failed", lastError: "media file missing", updatedAt: now.toISOString() }); out("failed: media file missing"); continue; }
    if (mediaHash(media) !== it.media.sha256) { save({ ...it, status: "failed", lastError: "media file changed since it was queued", updatedAt: now.toISOString() }); out("failed: media file changed since it was queued"); continue; }
    const conn = connection(store, it.platform), adapter = adapters[it.platform];
    const blockers: string[] = [];
    if (!opts.live) blockers.push("dry run (no --live)");
    if (!s.live[it.platform]) blockers.push(`live publishing is off for ${it.platform}`);
    if (!adapter.verified) blockers.push(adapter.note);
    if (!conn) blockers.push(`${it.platform} is not connected`);
    else if (conn.expiresOn && conn.expiresOn < today) blockers.push(`the ${it.platform} token expired on ${conn.expiresOn}`);
    if (blockers.length) { out(`DRY RUN: would publish day ${it.day} to ${it.platform} (${it.media.source}, ${it.media.width}x${it.media.height}); not sent because: ${blockers.join("; ")}`); continue; }
    store.audit({ kind: "social-publish-attempt", item: it.id, platform: it.platform, attempt: it.attempts + 1 }, now);
    let r: PublishResult;
    try { r = await adapter.publish({ platform: it.platform, accountId: conn!.accountId, token: conn!.token, caption: it.caption, title: it.title, link: it.link, media: { file: it.media.file, type: it.media.type, sha256: it.media.sha256, width: it.media.width, height: it.media.height } }); }
    catch (e) { r = { kind: "ambiguous", error: `adapter error: ${(e as Error).message}` }; }
    const err = (m: string) => m.replace(conn!.token, "[token]").slice(0, 300);
    if (r.kind === "published") {
      save({ ...it, status: "published", attempts: it.attempts + 1, externalId: r.externalId, url: r.url, lastError: null, updatedAt: now.toISOString() });
      try { recordPosted(store, it.planId, it.day, r.url, now); out(`published: ${r.url} (recorded in the audience plan)`); }
      catch (e) { out(`published: ${r.url}; could not record it in the plan: ${(e as Error).message}`); }
      store.audit({ kind: "social-published", item: it.id, platform: it.platform, externalId: r.externalId, url: r.url }, now);
    } else if (r.kind === "retryable" && it.attempts + 1 < MAX_ATTEMPTS) {
      const next = new Date(now.getTime() + BACKOFF_MIN[it.attempts] * 60_000).toISOString();
      save({ ...it, status: "retry-wait", attempts: it.attempts + 1, nextAttemptAt: next, lastError: err(r.error), updatedAt: now.toISOString() });
      out(`retry later (${it.attempts + 1}/${MAX_ATTEMPTS}) at ${next}: ${err(r.error)}`);
    } else {
      const status: QueueStatus = r.kind === "ambiguous" ? "needs-check" : "failed";
      save({ ...it, status, attempts: it.attempts + 1, lastError: err(r.error), updatedAt: now.toISOString() });
      out(`${status}: ${err(r.error)}${status === "needs-check" ? " (it may have been published: check the account before re-queueing)" : ""}`);
      store.audit({ kind: `social-${status}`, item: it.id, error: err(r.error) }, now);
    }
  }
  return { dryRun: !opts.live, outcomes };
}

export function socialStatus(store: Store, now: Date, adapters: Readonly<Record<Platform, PublishAdapter>> = DEFAULT_ADAPTERS): string {
  const s = settings(store), q = queue(store), today = londonDate(now);
  return PLATFORMS.map((p) => {
    const c = connection(store, p), a = adapters[p];
    const days = c?.expiresOn ? Math.round((Date.parse(c.expiresOn) - Date.parse(today)) / 86_400_000) : null;
    return `${CHANNEL_INFO[p].label}: ${c ? `connected (account ${c.accountId}, token fingerprint ${c.tokenSha256.slice(0, 12)}${c.expiresOn ? `, expires ${c.expiresOn}${days !== null && days < 7 ? ` (in ${days} day(s): renew it)` : ""}` : ", expiry not given"})` : "not connected"}; live publishing ${s.live[p] ? "ON" : "off"}; adapter ${a.verified ? "verified" : a.note}; queue: ${["queued", "retry-wait", "published", "needs-check", "failed"].map((st) => `${q.filter((x) => x.platform === p && x.status === st).length} ${st}`).join(", ")}`;
  }).join("\n") + `\nPosting time ${s.postTime} UK, at most ${s.maxPostsPerDay} post(s) per platform per day. Tokens are never shown.\n`;
}

export const SOCIAL_USAGE = "social connect <instagram|pinterest> --account <id> --token-file <file> [--expires YYYY-MM-DD] | social disconnect <platform> | social status | social queue <plan> [--day N] | social media <item> --file <png|jpg> | social list | social cancel <item> | social run [--live] | social live <platform> on|off";

export async function socialCli(args: readonly string[], ctx: { store: Store; out: (s: string) => void; now: () => Date; interactive: () => boolean; adapters?: Readonly<Record<Platform, PublishAdapter>> }): Promise<number> {
  const [sub, a, ...rest] = args;
  const { store, out } = ctx;
  const adapters = ctx.adapters ?? DEFAULT_ADAPTERS;
  const f: Record<string, string> = {};
  const all = sub === "run" ? [a, ...rest].filter((x) => x !== undefined) as string[] : sub === "live" ? [] : rest;
  for (let i = 0; i < all.length; i++) { if (all[i] === "--live") { f["--live"] = "1"; continue; } if (!all[i].startsWith("--") || all[i + 1] === undefined) throw new Error(SOCIAL_USAGE); f[all[i]] = all[++i]; }
  const locked = <T>(fn: () => T | Promise<T>) => withLock(store.dir, async () => fn());
  if (sub === "connect") { const c = await locked(() => connect(store, platform(a), { accountId: f["--account"] ?? "", tokenFile: f["--token-file"] ?? "", expiresOn: f["--expires"] }, ctx.now())); out(`${c.platform} connected: account ${c.accountId}, token fingerprint ${c.tokenSha256.slice(0, 12)}. Live publishing stays off. Delete the token file you used.\n`); return 0; }
  if (sub === "disconnect") { const ok = await locked(() => disconnect(store, platform(a), ctx.now())); out(ok ? `${a} disconnected (token deleted from Automaton; revoke it on the platform too)\n` : `${a} was not connected\n`); return 0; }
  if (sub === "status") { out(socialStatus(store, ctx.now(), adapters)); return 0; }
  if (sub === "queue") { const r = await locked(() => enqueue(store, String(a), ctx.now(), { day: f["--day"] ? Number(f["--day"]) : undefined })); out(`${r.added.length} item(s) queued${r.added.map((x) => `\n  ${x.id} day ${x.day} ${x.platform} at ${x.scheduledAt} (${x.media.source} ${x.media.width}x${x.media.height})`).join("")}${r.skipped.map((x) => `\n  skipped ${x}`).join("")}\nNothing was published.\n`); return 0; }
  if (sub === "media") { const it = await locked(() => useScreenshot(store, String(a), f["--file"] ?? "", ctx.now())); out(`${it.id} will use your screenshot (${it.media.type} ${it.media.width}x${it.media.height})\n`); return 0; }
  if (sub === "list") { const q = queue(store); out(q.length ? q.map((x) => `${x.id} ${x.platform} plan ${x.planId} day ${x.day} ${x.scheduledAt} ${x.status}${x.url ? ` ${x.url}` : ""}${x.lastError ? ` (${x.lastError})` : ""}`).join("\n") + "\n" : "queue is empty\n"); return 0; }
  if (sub === "cancel") { const it = await locked(() => cancel(store, String(a), ctx.now())); out(`${it.id} cancelled\n`); return 0; }
  if (sub === "live") { const on = rest[0] === "on"; if (!["on", "off"].includes(rest[0] ?? "")) throw new Error("social live <platform> on|off"); await locked(() => setLive(store, platform(a), on, { interactive: ctx.interactive(), adapters }, ctx.now())); out(`live publishing ${on ? "ON" : "off"} for ${a}\n`); return 0; }
  if (sub === "run") {
    const r = await locked(() => runQueue(store, ctx.now(), { live: !!f["--live"], adapters }));
    out(`${r.dryRun ? "DRY RUN (nothing is sent without --live)" : "LIVE RUN"}\n${r.outcomes.map((o) => `  ${o.item} ${o.platform} day ${o.day}: ${o.result}`).join("\n") || "  nothing due"}\n`);
    return r.outcomes.some((o) => /^(failed|needs-check)/.test(o.result)) ? 1 : 0;
  }
  out(`Usage: ${SOCIAL_USAGE}\n`);
  return 2;
}
