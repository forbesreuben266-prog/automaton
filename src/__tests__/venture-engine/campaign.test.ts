import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { campaignStatus, createCampaign, decidePost, exportHandoff, PLATFORM_MAX, recordPublished, recordResults, revisePost, type Campaign } from "../../venture-engine/campaign.js";
import { main } from "../../venture-engine/cli.js";
import { decideApproval } from "../../venture-engine/engine.js";
import { buildProduct, confirmationCode, markLive, misleadingClaims, requestLaunch, signOff, type Product } from "../../venture-engine/products.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const NOW = new Date("2026-11-09T10:00:00Z");
const LATER = new Date("2026-11-20T10:00:00Z");
const URL = "https://payhip.com/b/AbC12";
let DIR = "";
let store: Store;
let realFetch: typeof fetch;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vc-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access in a test"); }) as typeof fetch; // nothing may reach a platform
});
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

const venture: Venture = { id: "ven-9e27315f", status: "built", experiments: [], decisions: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  opportunity: { id: "opp-00000001", kind: "digital-product", title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms", audience: "freelancers", offer: "A template pack.", estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: NOW.toISOString(), source: "fixture (test only)" } };
const signedProduct = (): Product => {
  store.saveVentures([venture]);
  const p = buildProduct(store, venture.id, { now: NOW, currency: "GBP" });
  return signOff(store, p.id, { confirm: confirmationCode(p), price: "GBP 12", note: "read qa-report.md; price OK", interactive: true }, NOW);
};
const goLive = (p: Product, url = URL) => { decideApproval(store, requestLaunch(store, p.id, NOW).id, true, NOW); markLive(store, p.id, url, NOW); };
const me = { interactive: true };

describe("campaign create: verified product, real Payhip URL, platform-specific seven-day drafts", () => {
  it("creates 7 drafts (LinkedIn days 1,3,5,7; Facebook days 2,4,6) that contain only checked product details and the URL", () => {
    const p = signedProduct();
    const products = fs.readFileSync(path.join(store.dir, "products.json"), "utf8");
    const c = createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: NOW });
    expect(c.id).toMatch(/^cmp-[0-9a-f]{8}$/);
    expect(c.posts.map((x) => `${x.day}:${x.platform}:${x.date}`)).toEqual(["1:linkedin:2026-11-10", "2:facebook:2026-11-11", "3:linkedin:2026-11-12", "4:facebook:2026-11-13", "5:linkedin:2026-11-14", "6:facebook:2026-11-15", "7:linkedin:2026-11-16"]);
    for (const x of c.posts) {
      expect(x.status).toBe("draft");
      expect(x.text).toContain(URL);
      expect(x.text.replaceAll(URL, "")).not.toMatch(/https?:\/\/|www\./);
      expect(misleadingClaims(x.text)).toEqual([]);
      expect(x.text).not.toMatch(/testimonial|\d[\d,]* (customers|users|freelancers|sales)|guarantee/i);
      expect(x.text.length).toBeLessThanOrEqual(PLATFORM_MAX[x.platform]);
      expect(x.text).toMatch(/not legal, tax or financial advice/);
    }
    expect(c.posts[0].text).toContain("A complete invoicing routine for freelancers, ready in 20 minutes");
    expect(c.posts.some((x) => x.text.includes("£12"))).toBe(true);
    expect(fs.readFileSync(path.join(store.dir, "products.json"), "utf8")).toBe(products); // product records untouched
    expect(store.campaigns()).toHaveLength(1);
    expect(campaignStatus(c)).toMatch(/7 draft, 0 approved, 0 rejected, 0 published \(nothing is published automatically\)[\s\S]*results: none recorded \(no engagement is known\)/);
  });

  it("refuses without a current sign-off, without a real Payhip URL, for unchecked or edited products, or a past start", () => {
    store.saveVentures([venture]);
    const unsigned = buildProduct(store, venture.id, { now: NOW, currency: "GBP" });
    expect(() => createCampaign(store, unsigned.id, { url: URL, now: NOW })).toThrow(/no current owner sign-off/);
    const p = signOff(store, unsigned.id, { confirm: confirmationCode(unsigned), price: "GBP 12", note: "read it all", interactive: true }, NOW);
    for (const bad of ["", "http://payhip.com/b/AbC12", "https://payhip.com.evil.com/b/AbC12", "https://example.com/b/AbC12", "https://payhip.com/b/", "https://payhip.com/b/AbC12?ref=x"])
      expect(() => createCampaign(store, p.id, { url: bad, now: NOW }), bad).toThrow(/Payhip product link/);
    expect(() => createCampaign(store, p.id, { url: URL, start: "2026-11-01", now: NOW })).toThrow(/not in the past/);
    const f = path.join(store.dir, "ventures", p.ventureId, p.id, "landing.html");
    fs.chmodSync(f, 0o600); fs.appendFileSync(f, "\n<!-- edited -->\n");
    expect(() => createCampaign(store, p.id, { url: URL, now: NOW })).toThrow(/files changed since the build/);
    store.saveProducts(store.products().map((x) => ({ ...x, status: "needs-work" as const })));
    expect(() => createCampaign(store, p.id, { url: URL, now: NOW })).toThrow(/is needs-work/);
    expect(store.campaigns()).toEqual([]);
  });
});

describe("approval, publishing record and verified results", () => {
  const ready = (): { p: Product; c: Campaign } => { const p = signedProduct(); return { p, c: createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: NOW }) }; };

  it("posts are approved or rejected one at a time, only at an interactive terminal; decisions are audited", () => {
    const { c } = ready();
    expect(() => decidePost(store, c.id, c.posts[0].id, { approve: true, note: "", interactive: false }, NOW)).toThrow(/interactive terminal: automated jobs cannot decide/);
    expect(decidePost(store, c.id, c.posts[0].id, { approve: true, note: "", ...me }, NOW).status).toBe("approved");
    expect(() => decidePost(store, c.id, c.posts[1].id, { approve: false, note: "", ...me }, NOW)).toThrow(/short note/);
    expect(decidePost(store, c.id, c.posts[1].id, { approve: false, note: "too salesy", ...me }, NOW).status).toBe("rejected");
    expect(campaignStatus(store.campaigns()[0])).toMatch(/5 draft, 1 approved, 1 rejected, 0 published[\s\S]*day 2 2026-11-11 facebook rejected .*\(too salesy\)/);
    const audit = fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8");
    expect(audit).toMatch(/"kind":"campaign-post-approved".*"interactive":true/);
    expect(audit).toMatch(/"kind":"campaign-post-rejected"/);
  });

  it("a published link can be recorded only for an approved, unchanged post, after the approved launch at the same URL", () => {
    const { p, c } = ready();
    const [li, fb] = c.posts;
    decidePost(store, c.id, li.id, { approve: true, note: "", ...me }, NOW);
    expect(() => recordPublished(store, c.id, li.id, "https://www.linkedin.com/posts/me_123", NOW)).toThrow(/not live: .*approved launch/);
    goLive(p);
    expect(() => recordPublished(store, c.id, fb.id, "https://www.facebook.com/me/posts/1", NOW)).toThrow(/is draft: only an approved post/);
    for (const bad of ["http://www.linkedin.com/posts/x", "https://www.facebook.com/x", "https://linkedin.com.evil.com/x", "not a url"])
      expect(() => recordPublished(store, c.id, li.id, bad, NOW), bad).toThrow(/--url/);
    // an approval no longer counts if the post text changed afterwards
    store.saveCampaigns(store.campaigns().map((x) => ({ ...x, posts: x.posts.map((y) => (y.id === li.id ? { ...y, text: y.text + " Extra claim." } : y)) })));
    expect(() => recordPublished(store, c.id, li.id, "https://www.linkedin.com/posts/me_123", NOW)).toThrow(/only an approved post/);
    store.saveCampaigns(store.campaigns().map((x) => ({ ...x, posts: x.posts.map((y) => (y.id === li.id ? { ...y, text: y.text.replace(" Extra claim.", "") } : y)) })));
    const done = recordPublished(store, c.id, li.id, "https://www.linkedin.com/posts/me_123", NOW);
    expect(done).toMatchObject({ status: "published", published: { url: "https://www.linkedin.com/posts/me_123" } });
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).toMatch(/"kind":"campaign-post-published".*"by":"owner"/);
  });

  it("a campaign whose URL differs from the product's live URL cannot record publications", () => {
    const { p, c } = ready();
    decidePost(store, c.id, c.posts[0].id, { approve: true, note: "", ...me }, NOW);
    goLive(p, "https://payhip.com/b/OtHeR9");
    expect(() => recordPublished(store, c.id, c.posts[0].id, "https://www.linkedin.com/posts/x", NOW)).toThrow(/is not the product's live URL/);
    expect(() => createCampaign(store, p.id, { url: URL, now: NOW })).toThrow(/is live at https:\/\/payhip\.com\/b\/OtHeR9/);
  });

  it("results: only for published posts, verified periods, consistent numbers, a source; evidence hashed, never invented", () => {
    const { p, c } = ready();
    const li = c.posts[0];
    const base = { periodStart: "2026-11-10", periodEnd: "2026-11-16", impressions: 420, reactions: 12, comments: 3, shares: 2, clicks: 9, source: "LinkedIn post analytics" };
    expect(() => recordResults(store, c.id, li.id, base, LATER)).toThrow(/not published/);
    decidePost(store, c.id, li.id, { approve: true, note: "", ...me }, NOW);
    goLive(p);
    recordPublished(store, c.id, li.id, "https://www.linkedin.com/posts/me_123", new Date("2026-11-10T09:00:00Z"));
    expect(() => recordResults(store, c.id, li.id, { ...base, periodStart: "2026-11-09" }, LATER)).toThrow(/before the post was published/);
    expect(() => recordResults(store, c.id, li.id, { ...base, periodEnd: "2026-12-01" }, LATER)).toThrow(/future/);
    expect(() => recordResults(store, c.id, li.id, { ...base, impressions: 0 }, LATER)).toThrow(/interactions without impressions/);
    expect(() => recordResults(store, c.id, li.id, { ...base, source: "me" }, LATER)).toThrow(/--source/);
    expect(() => recordResults(store, c.id, li.id, { ...base, clicks: -1 }, LATER)).toThrow(/whole number/);
    const ev = path.join(DIR, "linkedin-export.csv"); fs.writeFileSync(ev, "date,impressions\n2026-11-10,420\n");
    const r = recordResults(store, c.id, li.id, { ...base, evidenceFile: ev }, LATER);
    expect(r).toMatchObject({ verification: "evidence-file", evidence: { name: "linkedin-export.csv" } });
    expect(() => recordResults(store, c.id, li.id, { ...base, periodStart: "2026-11-15", periodEnd: "2026-11-18" }, LATER)).toThrow(/overlaps/);
    expect(campaignStatus(store.campaigns()[0])).toMatch(/verified results \(owner-recorded from platform analytics\): impressions 420, reactions 12, comments 3, shares 2, clicks 9/);
  });
});

describe("revise and export (Meta Business Suite handoff)", () => {
  const ready = (): { p: Product; c: Campaign } => { const p = signedProduct(); return { p, c: createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: NOW }) }; };
  const better = `Still building invoices from scratch? Freelance invoicing kit: an invoice that adds up its own totals, a tracker for every unpaid invoice and reminder emails. £12, one-off: ${URL}`;

  it("a revision of an approved post becomes a new draft needing approval; the old version is kept; checks still apply", () => {
    const { c } = ready();
    const fb = c.posts[1];
    decidePost(store, c.id, fb.id, { approve: true, note: "", ...me }, NOW);
    const r = revisePost(store, c.id, fb.id, better, LATER);
    expect(r).toMatchObject({ status: "draft", decision: null, text: better });
    expect(r.history).toEqual([{ at: LATER.toISOString(), text: fb.text, status: "approved", decision: expect.objectContaining({ note: "" }) }]);
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).toMatch(/"kind":"campaign-post-revised".*"previousStatus":"approved"/);
    for (const [text, why] of [
      [`We guarantee you will be paid on time. ${URL}`, /guaranteed outcome/],
      [`Great kit, see https://example.com and ${URL}`, /link other than the campaign URL/],
      ["Great kit, no link", /must contain the campaign URL/],
      [`${"x".repeat(PLATFORM_MAX.facebook)} ${URL}`, /over 600 for facebook/],
      [better, /same as the current text/],
    ] as [string, RegExp][]) expect(() => revisePost(store, c.id, fb.id, text, LATER), text.slice(0, 30)).toThrow(why);
  });

  it("export lists the platform's posts with exact text, the real URL and which are ready; it schedules nothing", () => {
    const { c } = ready();
    const [, fb2, , fb4] = c.posts;
    decidePost(store, c.id, fb2.id, { approve: true, note: "", ...me }, NOW);
    revisePost(store, c.id, fb4.id, better, NOW);
    const doc = exportHandoff(store.campaigns()[0], "facebook");
    expect(doc).toMatch(/^# Meta Business Suite handoff: facebook posts for campaign cmp-/);
    expect(doc).toMatch(/Status: 1 of 3 facebook post\(s\) approved and ready to schedule\. This document schedules nothing/);
    expect(doc.match(/^## Day [246], /gm)).toHaveLength(3);
    expect(doc).not.toMatch(/linkedin/i);
    expect(doc).toContain("APPROVED: ready to schedule");
    expect(doc).toContain("DRAFT: approve it in Automaton before scheduling");
    expect(doc).toContain("```text\n" + better + "\n```");
    expect(doc.split(URL).length - 1).toBeGreaterThanOrEqual(4);
    expect(doc).toMatch(/campaign published cmp-[0-9a-f]{8} pst-[0-9a-f]{8} --url <link of the published post>/);
    expect(doc).not.toMatch(/password|cookie|token/i);
  });
});

describe("CLI", () => {
  it("create, review, approve (terminal only), published, record, show", async () => {
    const p = signedProduct();
    let out = "", tty = false;
    const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null, isInteractive: () => tty }); };
    expect(await cli("campaign", "create", p.id, "--url", "https://example.com/x")).toBe(1); expect(out).toMatch(/Payhip product link/);
    expect(await cli("campaign", "create", p.id, "--url", URL, "--start", "2026-11-10")).toBe(0);
    expect(out).toMatch(/7 draft[\s\S]*Drafts only/);
    const c = store.campaigns()[0];
    expect(await cli("campaign", "post", c.id, c.posts[0].id)).toBe(0); expect(out).toContain(URL);
    expect(await cli("campaign", "approve", c.id, c.posts[0].id)).toBe(1); expect(out).toMatch(/interactive terminal/);
    tty = true;
    expect(await cli("campaign", "approve", c.id, c.posts[0].id)).toBe(0); expect(out).toMatch(/approved: publish it yourself on linkedin/);
    expect(await cli("campaign", "reject", c.id, c.posts[1].id, "--note", "rewrite the opening")).toBe(0);
    goLive(store.products()[0]);
    expect(await cli("campaign", "published", c.id, c.posts[0].id, "--url", "https://www.linkedin.com/posts/me_1")).toBe(0);
    expect(out).toMatch(/nothing was posted by Automaton/);
    expect(await cli("campaign", "record", c.id, c.posts[0].id, "--period", "2026-11-09..2026-11-09", "--impressions", "50", "--reactions", "2", "--comments", "0", "--shares", "0", "--clicks", "1", "--source", "LinkedIn post analytics")).toBe(0);
    expect(await cli("campaign", "show", c.id)).toBe(0);
    expect(out).toMatch(/5 draft, 0 approved, 1 rejected, 1 published[\s\S]*impressions 50/);
    expect(await cli("campaign", "list")).toBe(0); expect(out).toMatch(/1\/7 published/);
    const tf = path.join(DIR, "post.txt"); fs.writeFileSync(tf, `Reworded for Facebook. Freelance invoicing kit, £12: ${URL}\n`);
    expect(await cli("campaign", "revise", c.id, c.posts[3].id, "--text-file", tf)).toBe(0); expect(out).toMatch(/now a DRAFT and needs your approval again/);
    expect(await cli("campaign", "export", c.id, "--platform", "facebook")).toBe(0); expect(out).toMatch(/Meta Business Suite handoff/);
    expect(await cli("campaign", "export", c.id, "--platform", "facebook", "--save")).toBe(0);
    const saved = out.split("\n")[0];
    expect(saved).toMatch(/facebook-handoff-\d{8}t\d{6}\.md$/);
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600);
    expect(await cli("campaign", "export", c.id, "--platform", "myspace")).toBe(1); expect(out).toMatch(/--platform: facebook or linkedin/);
    expect(await cli("campaign")).toBe(2); expect(out).toMatch(/Usage: campaign create/);
  });
});
