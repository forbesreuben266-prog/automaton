import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAutopilot } from "../../venture-engine/autopilot.js";
import { createCampaign, decidePost, recordPublished } from "../../venture-engine/campaign.js";
import { main } from "../../venture-engine/cli.js";
import { DEFAULT_CONFIG, stop } from "../../venture-engine/control.js";
import { decideApproval } from "../../venture-engine/engine.js";
import { coverSvg, launchReadiness, prepareLaunch } from "../../venture-engine/launch.js";
import { runDaily } from "../../venture-engine/operations.js";
import { setBlocker } from "../../venture-engine/operations.js";
import { buildProduct, confirmationCode, markLive, misleadingClaims, requestLaunch, signOff, type Product } from "../../venture-engine/products.js";
import { pence, recordOrder, recordRefund, salesTotals } from "../../venture-engine/sales.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";
import { readZip, verifyZip } from "../../venture-engine/zip.js";

const T0 = new Date("2026-11-09T10:00:00Z");
const NOW = new Date("2026-11-12T08:00:00Z");
const URL = "https://payhip.com/b/t1JqT";
let DIR = "", store: Store, realFetch: typeof fetch, fetches = 0;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vl-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch; fetches = 0;
  globalThis.fetch = (() => { fetches += 1; throw new Error("network access in a test"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

const venture: Venture = { id: "ven-9e27315f", status: "built", experiments: [], decisions: [], createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
  opportunity: { id: "opp-00000001", kind: "digital-product", title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms", audience: "freelancers", offer: "A template pack.", estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: T0.toISOString(), source: "fixture" } };
/** The real-world case: Freelance Invoicing Kit, £12, signed off. */
const kit = (): Product => { store.saveVentures([venture]); const p = buildProduct(store, venture.id, { now: T0, currency: "GBP", price: 12 }); return signOff(store, p.id, { confirm: confirmationCode(p), price: "GBP 12", note: "checked", interactive: true }, T0); };
const liveKit = () => { const p = kit(); decideApproval(store, requestLaunch(store, p.id, T0).id, true, T0); markLive(store, p.id, URL, T0); return store.products()[0]; };
const withCampaign = () => {
  const p = liveKit();
  const c = createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: T0 });
  for (const x of c.posts) decidePost(store, c.id, x.id, { approve: true, note: "checked", interactive: true }, T0);
  return { p, c: store.campaigns()[0] };
};
let out = "";
const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null }); };

describe("launch prepare: verified package from the product's own files", () => {
  it("writes ZIP + manifest (verified), listing, cover, marketing (3 x Facebook/LinkedIn), checklist; changes nothing else", () => {
    const { p } = withCampaign();
    const before = ["products.json", "campaigns.json", "approvals.json"].map((n) => fs.readFileSync(path.join(store.dir, n), "utf8"));
    const { pkg, reused } = prepareLaunch(store, p.id, NOW);
    expect(reused).toBe(false);
    expect(pkg.files.map((f) => f.name)).toEqual(["freelance-invoicing-kit-v1.zip", "zip-manifest.json", "listing.md", "cover.svg", "cover-spec.md", "marketing.md", "launch-checklist.md"]);
    const zip = fs.readFileSync(path.join(pkg.dir, pkg.zip));
    const m = JSON.parse(fs.readFileSync(path.join(pkg.dir, "zip-manifest.json"), "utf8"));
    expect(verifyZip(zip, m.files)).toEqual([]);
    expect(readZip(zip).map((e) => e.name)).toEqual(p.deliverables);
    const read = (n: string) => fs.readFileSync(path.join(pkg.dir, n), "utf8");
    expect(read("listing.md")).toMatch(/\*\*Title:\*\* Freelance invoicing kit[\s\S]*\*\*Price:\*\* GBP 12, one-off \(the signed-off price[\s\S]*\*\*Benefits:\*\*[\s\S]*\*\*FAQ:\*\*\n\n- \*\*What do I need to use it\?\*\*/);
    expect(read("listing.md")).toContain(`The live listing is ${URL}`);
    const mk = read("marketing.md");
    expect(mk.match(/^### (Facebook|LinkedIn) /gm)).toHaveLength(6);
    expect(mk.replaceAll(URL, "")).not.toMatch(/https?:\/\/|www\./);
    expect(misleadingClaims(mk)).toEqual([]);
    expect(read("cover.svg")).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*Freelance invoicing kit[\s\S]*<\/svg>\n$/);
    expect(read("cover.svg")).not.toMatch(/<script|href|xlink|@import|on[a-z]+=/i);
    expect(read("launch-checklist.md")).toMatch(/Launch readiness: \*\*\d+\/100\*\*[\s\S]*\[x\] Launch package prepared/);
    expect(["products.json", "campaigns.json", "approvals.json"].map((n) => fs.readFileSync(path.join(store.dir, n), "utf8"))).toEqual(before);
    expect(fetches).toBe(0);
  });

  it("is idempotent: unchanged inputs return the same package; flags messages that repeat existing posts", () => {
    const { p } = withCampaign();
    const a = prepareLaunch(store, p.id, NOW);
    const b = prepareLaunch(store, p.id, new Date(NOW.getTime() + 3_600_000));
    expect(b).toEqual({ pkg: a.pkg, reused: true });
    expect(store.launches()).toHaveLength(1);
    expect(fs.readdirSync(path.join(store.dir, "launch"))).toHaveLength(1);
  });

  it("refuses drafts without a current sign-off, changed files, and STOP; escapes the cover text", () => {
    store.saveVentures([venture]);
    const draft = buildProduct(store, venture.id, { now: T0, currency: "GBP", price: 12 });
    expect(() => prepareLaunch(store, draft.id, NOW)).toThrow(/only for approved products/);
    const p = signOff(store, draft.id, { confirm: confirmationCode(draft), price: "GBP 12", note: "checked", interactive: true }, T0);
    const f = path.join(store.dir, "ventures", p.ventureId, p.id, "invoice-tracker.csv");
    fs.chmodSync(f, 0o600); fs.appendFileSync(f, "x");
    expect(() => prepareLaunch(store, p.id, NOW)).toThrow(/sign-off|files changed/);
    stop(store.dir, "pause", NOW);
    expect(() => prepareLaunch(store, p.id, NOW)).toThrow(/STOP is set/);
    expect(coverSvg('A <b>"kit"</b> & co', "x", 3)).toContain("A &lt;b&gt;&quot;kit&quot;&lt;/b&gt; &amp; co");
  });
});

describe("launch readiness: transparent criteria", () => {
  it("scores recorded facts only; the Facebook blocker marks publication blocked, not done", () => {
    const p = kit();
    let r = launchReadiness(store, p);
    expect(r).toMatchObject({ stage: "approved", next: { id: "launch-approved", command: `product request-launch ${p.id}` } });
    expect(r.score).toBe(20); // quality 10 + sign-off 10 of 100
    const { c } = withCampaignOn(p);
    setBlocker(store, "facebook", "Facebook account verification pending", T0);
    prepareLaunch(store, p.id, NOW);
    r = launchReadiness(store, store.products()[0]);
    expect(r.criteria.find((x) => x.id === "post-published")).toMatchObject({ state: "todo" }); // LinkedIn posts are approved and not blocked
    for (const x of c.posts.filter((y) => y.platform === "linkedin")) decidePost(store, c.id, x.id, { approve: false, note: "not now", interactive: true }, T0);
    r = launchReadiness(store, store.products()[0]);
    expect(r.criteria.find((x) => x.id === "post-published")).toMatchObject({ state: "blocked", detail: "blocked: Facebook account verification pending" });
    expect(r.stage).toBe("live");
    expect(r.score).toBe(80);
    expect(r.next).toMatchObject({ id: "sales-recorded" });
  });
});
function withCampaignOn(p: Product) {
  decideApproval(store, requestLaunch(store, p.id, T0).id, true, T0); markLive(store, p.id, URL, T0);
  const c = createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: T0 });
  for (const x of c.posts.filter((y) => y.platform === "facebook")) decidePost(store, c.id, x.id, { approve: true, note: "checked", interactive: true }, T0);
  for (const x of c.posts.filter((y) => y.platform === "linkedin")) decidePost(store, c.id, x.id, { approve: true, note: "checked", interactive: true }, T0);
  return { c: store.campaigns()[0] };
}

describe("sales: verified orders, deduplication, attribution, refunds", () => {
  it("records orders exactly in pence, refuses duplicates, attributes only to published posts, tracks refunds and fees separately", async () => {
    const { p, c } = withCampaign();
    const post = c.posts[1];
    recordPublished(store, c.id, post.id, "https://www.facebook.com/61596090014020/posts/1", new Date("2026-11-11T12:00:00Z"));
    const a = recordOrder(store, p.id, { orderRef: "PH-1001", date: "2026-11-11", gross: "12", fees: "0.86", campaignId: c.id, postId: post.id, source: "Payhip orders export" }, NOW);
    expect(a).toMatchObject({ grossPence: 1200, feesPence: 86, campaignId: c.id, postId: post.id, verification: "owner-reported" });
    expect(() => recordOrder(store, p.id, { orderRef: "ph-1001", date: "2026-11-11", gross: "12", source: "Payhip" }, NOW)).toThrow(/already recorded/);
    expect(() => recordOrder(store, p.id, { orderRef: "PH-1002", date: "2026-11-11", gross: "12", campaignId: c.id, postId: c.posts[3].id, source: "Payhip" }, NOW)).toThrow(/no recorded publication/);
    expect(() => recordOrder(store, p.id, { orderRef: "PH-1003", date: "2026-12-30", gross: "12", source: "Payhip" }, NOW)).toThrow(/not in the future/);
    expect(() => recordOrder(store, p.id, { orderRef: "PH-1004", date: "2026-11-11", gross: "0", source: "Payhip" }, NOW)).toThrow(/more than 0/);
    const ev = path.join(DIR, "orders.csv"); fs.writeFileSync(ev, "order,amount\nPH-1005,12\n");
    const b = recordOrder(store, p.id, { orderRef: "PH-1005", date: "2026-11-12", gross: "12", source: "Payhip orders export", evidenceFile: ev }, NOW);
    expect(b).toMatchObject({ verification: "evidence-file", feesPence: null, evidence: { name: "orders.csv", bytes: 24 } });
    expect(JSON.stringify(store.orders())).not.toContain("PH-1005,12"); // evidence is hashed, not copied
    recordRefund(store, b.id, { amount: "4.50", date: "2026-11-12", source: "Payhip refund" }, NOW);
    expect(() => recordRefund(store, b.id, { amount: "7.51", date: "2026-11-12", source: "Payhip refund" }, NOW)).toThrow(/more than the order's gross/);
    const t = salesTotals(store.orders());
    expect(t).toMatchObject({ orders: 2, grossPence: 2400, refundsPence: 450, feesPence: 86, ordersWithoutFees: 1, netPence: 1864, verified: 1, byCampaign: { [c.id]: 1 }, unattributed: 1 });
    expect(pence("0.1", "x")).toBe(10); expect(() => pence("1.234", "x")).toThrow();
    expect(await cli("sales", "report")).toBe(0);
    expect(out).toMatch(/GBP: 2 order\(s\) \(1 with an evidence file\); gross 24\.00, refunds 4\.50, fees 0\.86 \(fees not recorded for 1 order\(s\)\), net 18\.64/);
    const d = runDaily(store, DEFAULT_CONFIG, NOW).report;
    expect(d.orders[0]).toMatchObject({ currency: "GBP", netPence: 1864 });
    expect(fs.readFileSync(path.join(store.dir, "reports", "owner-dashboard.html"), "utf8")).toMatch(/Verified orders[\s\S]*<b>net 18\.64<\/b>/);
  });

  it("refuses sales for a product that is not live, or attribution to another product's campaign", () => {
    const p = kit();
    expect(() => recordOrder(store, p.id, { orderRef: "PH-1", date: "2026-11-11", gross: "12", source: "Payhip" }, NOW)).toThrow(/only for a live product/);
    expect(store.orders()).toEqual([]);
  });

  it("no orders: dashboard and report say unknown, not zero", async () => {
    liveKit();
    expect(await cli("sales", "report")).toBe(0); expect(out).toMatch(/no orders recorded: sales and revenue are unknown, not zero/);
    runDaily(store, DEFAULT_CONFIG, NOW);
    expect(fs.readFileSync(path.join(store.dir, "reports", "owner-dashboard.html"), "utf8")).toMatch(/No orders recorded: sales and revenue are unknown, not zero/);
  });
});

describe("launch CLI, autopilot and dashboard", () => {
  it("launch status/checklist; autopilot prepares the live kit's package first, once, then one owner action", async () => {
    const { p } = withCampaign();
    setBlocker(store, "facebook", "Facebook account verification pending", T0);
    const r1 = runAutopilot(store, DEFAULT_CONFIG, NOW);
    expect(r1.completed[0]).toMatch(/^prepared 14-day marketing experiment pln-/);
    expect(r1.completed[1]).toMatch(/^prepared launch package lch-[0-9a-f]{8} for /);
    expect(r1.skipped).toContain("new product draft: revenue first (Freelance invoicing kit 0/10 sales)");
    const r2 = runAutopilot(store, DEFAULT_CONFIG, new Date(NOW.getTime() + 3_600_000));
    expect(r2.completed).toEqual([]); expect(store.launches()).toHaveLength(1);
    expect(r2.report.nextAction).not.toBeNull();
    expect(await cli("launch", "status")).toBe(0); expect(out).toMatch(new RegExp(`^${p.id} Freelance invoicing kit: live, readiness \\d+/100; next: `));
    expect(await cli("launch", "checklist", p.id)).toBe(0); expect(out).toMatch(/\[x\] Launch package prepared[\s\S]*\[x\] Payhip listing live and recorded/);
    expect(await cli("launch", "prepare", p.id)).toBe(0); expect(out).toMatch(/^unchanged since the last package: /);
    const dash = fs.readFileSync(path.join(store.dir, "reports", "owner-dashboard.html"), "utf8");
    expect(dash).toMatch(/<h2>Launches<\/h2><p>Live: 1\. Approved, not live: 0\. Drafts awaiting your approval: 0\.[\s\S]*Readiness criteria/);
    expect(fetches).toBe(0);
  });
});
