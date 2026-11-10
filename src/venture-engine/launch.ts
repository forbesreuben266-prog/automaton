/**
 * Launch packages and launch readiness for approved products (signed off or live). Built only from the product's own
 * checked files and records: no invented features, testimonials or results; prices, Payhip listings, campaigns and
 * live products are never changed.
 *
 *   launch prepare <product>    writes launch/<lch-id>/: <product>.zip + zip-manifest.json (verified), listing.md,
 *                               cover.svg (editable, text only) + cover-spec.md, marketing.md (3 messages, each for
 *                               Facebook and LinkedIn), launch-checklist.md. A rerun with unchanged inputs returns the
 *                               existing package.
 *   launch status               every non-archived product: stage, readiness score, next action.
 *   launch checklist <product>  the live checklist with each criterion's state.
 *
 * Publishing, listing, uploading and posting stay with the owner; recorded publication needs evidence (a post link).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { contentHash, PLATFORM_MAX, type Campaign } from "./campaign.js";
import { stopReason, withLock } from "./control.js";
import { overlap } from "./evaluate.js";
import { readPitch } from "./marketing.js";
import { changedFiles, misleadingClaims, reviewHash, type Product } from "./products.js";
import { ensurePrivateDir, newId, sha256, type Store } from "./store.js";
import type { Asset } from "./types.js";
import { makeZip, verifyZip, zipManifest } from "./zip.js";

export interface LaunchPackage { readonly id: string; readonly productId: string; readonly version: number; readonly inputHash: string; readonly createdAt: string; readonly dir: string; readonly zip: string; readonly files: readonly Asset[]; readonly duplicates: readonly string[] }
export interface Criterion { readonly id: string; readonly label: string; readonly weight: number; readonly state: "done" | "todo" | "blocked"; readonly detail: string; readonly command?: string }
export interface Readiness { readonly productId: string; readonly name: string; readonly stage: string; readonly score: number; readonly criteria: readonly Criterion[]; readonly next: Criterion | null }

const LINK = "[[link to your Payhip page]]";
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
const sym = (c: string) => (c === "GBP" ? "£" : c === "EUR" ? "€" : "$");
export const approved = (p: Product) => p.status === "live" || (p.status === "ready" && !!p.signOff && p.signOff.reviewHash === reviewHash(p));
const productCampaigns = (store: Store, p: Product) => store.campaigns().filter((c: Campaign) => c.productId === p.id);
const blockerFor = (store: Store, ...scopes: string[]) => (store.operations().blockers ?? []).find((b) => scopes.includes(b.scope));

/** Transparent launch-readiness: each criterion is a recorded fact (or a missing one); score = weighted share done. */
export function launchReadiness(store: Store, p: Product): Readiness {
  let intact = false; try { intact = changedFiles(store, p).length === 0; } catch { intact = false; }
  const approvals = store.approvals().filter((a) => a.ventureId === p.ventureId && a.action === "launch-public");
  const camps = productCampaigns(store, p);
  const posts = camps.flatMap((c) => c.posts.map((x) => ({ c, x })));
  const approvedPosts = posts.filter(({ c, x }) => (x.status === "approved" && x.decision?.contentHash === contentHash(x, c.productUrl)) || x.status === "published");
  const published = posts.filter(({ x }) => x.status === "published" && x.published);
  const pkg = store.launches().filter((l) => l.productId === p.id).at(-1);
  const orders = store.orders().filter((o) => o.productId === p.id);
  const periods = p.validation.length;
  const signed = !!p.signOff && p.signOff.reviewHash === reviewHash(p);
  const blockedPublishing = approvedPosts.length > 0 && approvedPosts.every(({ c, x }) => blockerFor(store, x.platform, c.id, x.id));
  const pb = approvedPosts.map(({ c, x }) => blockerFor(store, x.platform, c.id, x.id)).find(Boolean);
  const C = (id: string, label: string, weight: number, done: boolean, detail: string, command?: string, blocked = false): Criterion => ({ id, label, weight, state: done ? "done" : blocked ? "blocked" : "todo", detail, command });
  const criteria: Criterion[] = [
    C("quality", "Product files intact and every QA check passed", 10, intact && p.checks.every((c) => c.passed), intact ? `${p.checks.filter((c) => c.passed).length}/${p.checks.length} checks passed` : "files changed or missing since the build", `product review ${p.id}`),
    C("sign-off", "Owner sign-off of content and price", 10, signed || p.status === "live", signed ? `signed off ${p.signOff!.at.slice(0, 10)}` : "no current sign-off", `product sign-off ${p.id}`),
    C("launch-approved", "Launch approved by the owner", 10, p.status === "live" || approvals.some((a) => a.status === "approved"), approvals.length ? `launch request ${approvals.at(-1)!.status}` : "no launch request", approvals.some((a) => a.status === "pending") ? `approve ${approvals.find((a) => a.status === "pending")!.id}` : `product request-launch ${p.id}`),
    C("package", "Launch package prepared (verified ZIP, listing, cover, marketing, checklist)", 10, !!pkg && pkg.version === p.version, pkg ? `${pkg.id} (${pkg.createdAt.slice(0, 10)})` : "not prepared", `launch prepare ${p.id}`),
    C("listing-live", "Payhip listing live and recorded (product mark-live)", 20, !!p.live, p.live ? p.live.url : "no live URL recorded: create the listing yourself, then record it", `product mark-live ${p.id} --url <your Payhip URL>`),
    C("campaign", "Campaign drafted with the live product URL", 10, camps.some((c) => !!p.live && c.productUrl === p.live.url), camps.length ? `${camps.length} campaign(s)` : "no campaign", p.live ? `campaign create ${p.id} --url ${p.live.url}` : undefined),
    C("posts-approved", "At least one post approved", 10, approvedPosts.length > 0, `${approvedPosts.length} approved or published post(s)`, camps[0] ? `campaign show ${camps[0].id}` : undefined),
    C("post-published", "At least one post published, with its link recorded as evidence", 10, published.length > 0, published.length ? `${published.length} published post(s) with links` : blockedPublishing ? `blocked: ${pb!.reason}` : "no publication recorded", camps[0] ? `campaign published ${camps[0].id} <post> --url <post link>` : undefined, blockedPublishing),
    C("sales-recorded", "Verified sales recorded from Payhip", 10, orders.length > 0 || periods > 0, orders.length ? `${orders.length} order(s) recorded` : periods ? `${periods} period(s) recorded` : "none recorded (unknown, not zero)", `sales record ${p.id} --order <ref> --date YYYY-MM-DD --gross X --source "Payhip orders"`),
  ];
  const total = criteria.reduce((a, c) => a + c.weight, 0);
  const score = Math.round((100 * criteria.filter((c) => c.state === "done").reduce((a, c) => a + c.weight, 0)) / total);
  const stage = orders.length || periods ? "selling" : p.live ? (published.length ? "marketing" : "live") : approvals.some((a) => a.status === "approved") ? "launch approved" : signed ? "approved" : "draft awaiting approval";
  return { productId: p.id, name: p.name, stage, score, criteria, next: criteria.find((c) => c.state === "todo" && c.command) ?? null };
}

function faq(landing: string): { q: string; a: string }[] {
  const dl = /<dl class="faq">([\s\S]*?)<\/dl>/.exec(landing)?.[1] ?? "";
  return [...dl.matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => ({ q: unescape(m[1]), a: unescape(m[2]) }));
}

const wrap = (s: string, max: number) => { const out: string[] = []; let line = ""; for (const w of s.split(/\s+/)) { if ((line + " " + w).trim().length > max) { if (line) out.push(line); line = w; } else line = (line + " " + w).trim(); } if (line) out.push(line); return out; };
const x = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** An editable cover (plain SVG text, no scripts, links or external fonts). */
export function coverSvg(name: string, headline: string, fileCount: number, brand = "Avenor Studio"): string {
  const title = wrap(name, 22).slice(0, 3), sub = wrap(headline, 40).slice(0, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="960" viewBox="0 0 1280 960" role="img" aria-label="${x(name)} cover">
  <rect width="1280" height="960" fill="#f6f4ef"/>
  <rect x="64" y="64" width="1152" height="832" rx="28" fill="#ffffff" stroke="#1f2a44" stroke-width="4"/>
  <rect x="64" y="64" width="1152" height="120" rx="28" fill="#1f2a44"/>
  <text x="112" y="140" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="#ffffff" font-weight="700">${x(brand)}</text>
${title.map((l, i) => `  <text x="112" y="${300 + i * 96}" font-family="Helvetica, Arial, sans-serif" font-size="84" fill="#1f2a44" font-weight="700">${x(l)}</text>`).join("\n")}
${sub.map((l, i) => `  <text x="112" y="${330 + title.length * 96 + i * 52}" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="#3d4a66">${x(l)}</text>`).join("\n")}
  <text x="112" y="836" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#1f2a44">${fileCount} editable files · instant download</text>
</svg>
`;
}

export function marketingMessages(p: Product, landing: string): { theme: string; facebook: string; linkedin: string }[] {
  const pitch = readPitch(landing);
  const url = p.live?.url ?? LINK;
  const price = `${sym(p.currency)}${p.price}`;
  const inside = pitch.inside.filter((i) => !/^start here/i.test(i));
  const b = (i: number) => pitch.benefits[i % pitch.benefits.length];
  return [
    { theme: "the problem it solves", facebook: `${pitch.headline}.\n\n${b(0)}.\n${b(1)}.\n\n${p.name}: ${price}, one-off, instant download 👉 ${url}`,
      linkedin: `${pitch.headline}.\n\n${pitch.offer}\n\n${pitch.benefits.map((y) => `• ${y}`).join("\n")}\n\n${p.name}, ${price} one-off: ${url}` },
    { theme: "what is inside", facebook: `What's inside the ${p.name} (${price}):\n\n${inside.slice(0, 5).map((y) => `✅ ${y}`).join("\n")}\n\nInstant download 👉 ${url}`,
      linkedin: `What is inside the ${p.name}:\n\n${inside.map((y) => `• ${y}`).join("\n")}\n\nEditable files; no software to install. ${price}: ${url}` },
    { theme: "how it helps day to day", facebook: `${b(2)}.\n\nThe ${p.name} gives you a ready routine, so you are not starting from scratch each time.\n\n${price} 👉 ${url}`,
      linkedin: `A practical routine beats a blank page.\n\n${b(2)}. ${b(3)}.\n\nThe ${p.name} turns that into a set of editable files you can start using today. ${price}, one-off: ${url}` },
  ];
}

function checklistText(r: Readiness, pkgDir: string | null): string {
  const mark = (c: Criterion) => (c.state === "done" ? "[x]" : c.state === "blocked" ? "[!]" : "[ ]");
  return `# Launch checklist: ${r.name} (${r.productId})

Stage: **${r.stage}**. Launch readiness: **${r.score}/100** (weighted share of the criteria below that are done; each is a recorded fact).
${pkgDir ? `Package folder: ${pkgDir}\n` : ""}
${r.criteria.map((c, i) => `${i + 1}. ${mark(c)} ${c.label} (weight ${c.weight}): ${c.detail}${c.state !== "done" && c.command ? `\n   - \`${c.command}\`` : ""}`).join("\n")}

Steps that are always yours: create or update the Payhip listing and upload the ZIP; publish or schedule posts in each
platform's own tool; record the post link with 'campaign published'; record each order with 'sales record'.
[!] = blocked by an outside blocker you recorded ('operations blockers').
`;
}

/** Prepares (or returns the unchanged existing) launch package for an approved product. */
export function prepareLaunch(store: Store, productId: string, now: Date): { pkg: LaunchPackage; reused: boolean } {
  const why = stopReason(store.dir);
  if (why) throw new Error(`STOP is set (${why}): nothing was prepared`);
  const p = store.products().find((y) => y.id === productId);
  if (!p) throw new Error(`no product ${productId}`);
  if (!approved(p)) throw new Error(`${productId} is ${p.status}${p.status === "ready" ? " without a current sign-off" : ""}: launch packages are prepared only for approved products (product sign-off, or live)`);
  const changed = changedFiles(store, p);
  if (changed.length) throw new Error(`${productId}: files changed since the build (${changed.join(", ")}); review it first`);
  const read = store.reader(store.assetDir(p.ventureId, p.id));
  const landing = read("landing.html") ?? "";
  const existingPosts = productCampaigns(store, p).flatMap((c) => c.posts.map((y) => ({ id: y.id, text: y.text })));
  const inputHash = sha256(JSON.stringify({ files: p.files.map((f) => [f.name, f.sha256]), price: p.price, currency: p.currency, url: p.live?.url ?? null, posts: existingPosts.map((y) => y.id) }));
  const last = store.launches().filter((l) => l.productId === p.id).at(-1);
  if (last && last.inputHash === inputHash && fs.existsSync(path.join(last.dir, last.zip))) return { pkg: last, reused: true };

  const entries = p.deliverables.map((n) => ({ name: n, data: Buffer.from(read(n) ?? "", "utf8") }));
  const manifest = zipManifest(entries);
  const zip = makeZip(entries);
  const problems = verifyZip(zip, manifest);
  if (problems.length) throw new Error(`ZIP failed verification: ${problems.join("; ")}`);
  const pitch = readPitch(landing);
  const msgs = marketingMessages(p, landing);
  const texts = msgs.flatMap((m) => [{ where: `${m.theme} (Facebook)`, t: m.facebook, max: PLATFORM_MAX.facebook }, { where: `${m.theme} (LinkedIn)`, t: m.linkedin, max: PLATFORM_MAX.linkedin }]);
  const bad = texts.flatMap((y) => [...misleadingClaims(y.t).map((w) => `${y.where}: ${w}`), ...(y.t.length > y.max ? [`${y.where}: ${y.t.length} > ${y.max} characters`] : []), ...(y.t.replaceAll(p.live?.url ?? "\u0000", "").match(/https?:\/\/|www\./) ? [`${y.where}: a link other than the product URL`] : [])]);
  if (bad.length) throw new Error(`marketing messages failed their checks: ${bad.join("; ")}`);
  const duplicates = texts.flatMap((y) => existingPosts.filter((e) => overlap(y.t, e.text) >= 0.6).map((e) => `${y.where} is very similar to existing post ${e.id}: use only one of them`));

  const id = newId("lch");
  const dir = path.join(store.dir, "launch", id);
  ensurePrivateDir(path.dirname(dir)); ensurePrivateDir(dir);
  const files: Asset[] = [];
  const write = store.writer(dir, files);
  const zipName = `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "product"}-v${p.version}.zip`;
  fs.writeFileSync(path.join(dir, zipName), zip, { mode: 0o600, flag: "wx" });
  files.push({ name: zipName, bytes: zip.length, sha256: createHash("sha256").update(zip).digest("hex") });
  write("zip-manifest.json", JSON.stringify({ archive: zipName, bytes: zip.length, sha256: files[0].sha256, files: manifest }, null, 2) + "\n");
  const qs = faq(landing);
  write("listing.md", `# Payhip listing: ${p.name}

Prepared from the product's checked files. ${p.live ? `The live listing is ${p.live.url}: compare and update it yourself if anything differs; nothing was changed on Payhip.` : "Create the listing yourself on Payhip after the launch is approved; nothing was created or changed."}

**Title:** ${p.name}

**Subtitle:** ${pitch.headline}

**Price:** ${p.currency} ${p.price}, one-off (the signed-off price; this package does not change it)

**Description:**

${pitch.offer}

**Benefits:**

${pitch.benefits.map((y) => `- ${y}`).join("\n")}

**What is inside (${p.deliverables.length} files):**

${pitch.inside.map((y) => `- ${y}`).join("\n")}

**FAQ:**

${qs.map((q) => `- **${q.q}** ${q.a}`).join("\n") || "- (no FAQ on the product page)"}

These files help you organise your work. They are not legal, tax or financial advice.

**File to upload:** ${zipName} (${zip.length} bytes, SHA-256 ${files[0].sha256.slice(0, 16)}…), contents in zip-manifest.json.
**Cover:** cover.svg (editable; export to PNG or JPG before uploading).
`);
  write("cover.svg", coverSvg(p.name, pitch.headline, p.deliverables.length));
  write("cover-spec.md", `# Cover: ${p.name}

cover.svg is a plain, editable SVG (1280 x 960) made from the product name and headline; no scripts, links or external fonts.
Open it in a browser, Inkscape, Figma or Canva; change colours or text; export PNG or JPG for Payhip.

- Text used: "${p.name}", "${pitch.headline}", "${p.deliverables.length} editable files · instant download"
- Do not add ratings, reviews, sales numbers, "best-selling" badges or results: none exist.
- Optional extra images: real screenshots of the files (the tracker in a spreadsheet, the printed invoice or checklist).
`);
  write("marketing.md", `# Marketing messages: ${p.name}

Drafts only: nothing was posted, scheduled or approved. ${p.live ? `Each links to the live product: ${p.live.url}.` : `Replace ${LINK} with the live URL once it exists.`}
To use one, add it to a campaign and approve it there ('campaign revise' or 'campaign create'), then publish it yourself and record the link.
${duplicates.length ? `\n**Similar to existing posts (avoid posting both):**\n\n${duplicates.map((d) => `- ${d}`).join("\n")}\n` : "\nNone of these repeats an existing campaign post.\n"}
${msgs.map((m, i) => `## Message ${i + 1}: ${m.theme}

### Facebook (${m.facebook.length} of ${PLATFORM_MAX.facebook} characters)

\`\`\`text
${m.facebook}
\`\`\`

### LinkedIn (${m.linkedin.length} of ${PLATFORM_MAX.linkedin} characters)

\`\`\`text
${m.linkedin}
\`\`\``).join("\n\n")}
`);
  const pkg: LaunchPackage = { id, productId: p.id, version: p.version, inputHash, createdAt: now.toISOString(), dir, zip: zipName, files, duplicates };
  store.saveLaunches([...store.launches(), pkg]);
  write("launch-checklist.md", checklistText(launchReadiness(store, p), dir));
  const done = { ...pkg, files };
  store.saveLaunches(store.launches().map((l) => (l.id === id ? done : l)));
  store.audit({ kind: "launch-prepared", launch: id, product: p.id, version: p.version, zip: zipName, zipSha256: files[0].sha256, duplicates: duplicates.length }, now);
  return { pkg: done, reused: false };
}

export const LAUNCH_USAGE = "launch prepare <product> | launch status | launch checklist <product>";

export async function launchCli(args: readonly string[], ctx: { store: Store; out: (s: string) => void; now: () => Date }): Promise<number> {
  const [sub, a, ...rest] = args;
  const { store, out } = ctx;
  if (rest.length) throw new Error(LAUNCH_USAGE);
  if (sub === "prepare") {
    const { pkg, reused } = await withLock(store.dir, async () => prepareLaunch(store, String(a), ctx.now()));
    out(`${reused ? "unchanged since the last package: " : ""}launch package ${pkg.id} for ${pkg.productId} (version ${pkg.version})\n${pkg.dir}\n${pkg.files.map((f) => `  ${f.name}`).join("\n")}\n${pkg.duplicates.length ? `note: ${pkg.duplicates.length} message(s) are similar to existing posts (see marketing.md)\n` : ""}Nothing was published, listed, uploaded, scheduled or changed.\n`);
    return 0;
  }
  if (sub === "status") {
    const ps = store.products().filter((p) => p.status !== "archived" && !store.products().some((x) => x.previous === p.id));
    if (!ps.length) { out("no products\n"); return 0; }
    for (const p of ps) { const r = launchReadiness(store, p); out(`${p.id} ${p.name}: ${r.stage}, readiness ${r.score}/100${r.next ? `; next: ${r.next.label} (${r.next.command})` : ""}\n`); }
    return 0;
  }
  if (sub === "checklist") {
    const p = store.products().find((y) => y.id === a);
    if (!p) throw new Error(`no product ${a ?? ""}`);
    out(checklistText(launchReadiness(store, p), store.launches().filter((l) => l.productId === p.id).at(-1)?.dir ?? null));
    return 0;
  }
  out(`Usage: ${LAUNCH_USAGE}\n`);
  return 2;
}
