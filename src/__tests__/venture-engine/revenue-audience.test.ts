import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveDay, CHANNEL_INFO, createPlan, EXPERIMENT_DAYS, recordPosted, tipsFrom } from "../../venture-engine/audience.js";
import { runAutopilot } from "../../venture-engine/autopilot.js";
import { brandOf, DEFAULT_BRAND } from "../../venture-engine/brands.js";
import { createCampaign, decidePost } from "../../venture-engine/campaign.js";
import { main } from "../../venture-engine/cli.js";
import { DEFAULT_CONFIG, stop } from "../../venture-engine/control.js";
import { decideApproval } from "../../venture-engine/engine.js";
import { runDaily, setBlocker } from "../../venture-engine/operations.js";
import { buildProduct, confirmationCode, markLive, misleadingClaims, requestLaunch, signOff } from "../../venture-engine/products.js";
import { channelPerformance, experimentResult, goals, recordCost, recordMetric, scoreOpportunities } from "../../venture-engine/revenue.js";
import { recordOrder, recordRefund } from "../../venture-engine/sales.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const T0 = new Date("2026-11-09T10:00:00Z");
const NOW = new Date("2026-11-10T09:00:00Z");
const at = (d: string) => new Date(`${d}T12:00:00Z`);
const URL = "https://payhip.com/b/t1JqT";
let DIR = "", store: Store, realFetch: typeof fetch, fetches = 0;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vr-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch; fetches = 0;
  globalThis.fetch = (() => { fetches += 1; throw new Error("network access in a test"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

const venture: Venture = { id: "ven-9e27315f", status: "built", experiments: [], decisions: [], createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
  opportunity: { id: "opp-00000001", kind: "digital-product", title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms", audience: "freelancers", offer: "A template pack.", estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: T0.toISOString(), source: "fixture" } };
/** Freelance Invoicing Kit, £12, live at the real Payhip URL, with the approved Facebook campaign and the Facebook blocker. */
const live = () => {
  store.saveVentures([venture]);
  let p = buildProduct(store, venture.id, { now: T0, currency: "GBP", price: 12 });
  p = signOff(store, p.id, { confirm: confirmationCode(p), price: "GBP 12", note: "checked", interactive: true }, T0);
  decideApproval(store, requestLaunch(store, p.id, T0).id, true, T0); markLive(store, p.id, URL, T0);
  const c = createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: T0 });
  for (const x of c.posts.filter((y) => y.platform === "facebook")) decidePost(store, c.id, x.id, { approve: true, note: "checked", interactive: true }, T0);
  setBlocker(store, "facebook", "Facebook account verification pending", T0);
  return store.products()[0];
};
const snapshot = () => ["products.json", "campaigns.json", "approvals.json", "sales.json"].map((n) => { try { return fs.readFileSync(path.join(store.dir, n), "utf8"); } catch { return null; } });
let out = "";
const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null }); };

describe("audience plan: a 14-day organic experiment for the live kit", () => {
  it("one primary action per day, Facebook left out (blocker kept), distinct educational steps from the kit's own files, only the real link", () => {
    const p = live();
    const before = snapshot();
    const { plan, reused } = createPlan(store, p.id, NOW);
    expect(reused).toBe(false);
    expect(plan).toMatchObject({ brand: "avenor-studio", start: "2026-11-11", end: "2026-11-24", url: URL, blocked: [{ channel: "facebook", reason: "Facebook account verification pending" }] });
    expect(plan.channels).toEqual(["linkedin", "instagram", "tiktok", "youtube-shorts", "pinterest"]);
    expect(plan.days).toHaveLength(EXPERIMENT_DAYS);
    const perDay = new Map<string, Set<string>>();
    for (const d of plan.days) { const s = perDay.get(d.date) ?? new Set(); expect(s.has(d.channel)).toBe(false); s.add(d.channel); perDay.set(d.date, s); }
    expect(new Set(plan.days.map((d) => d.date)).size).toBe(EXPERIMENT_DAYS);
    expect(new Set(plan.days.map((d) => d.tip)).size).toBe(EXPERIMENT_DAYS);
    const tips = tipsFrom(store, p);
    for (const d of plan.days) {
      expect(tips).toContain(d.tip);
      expect(misleadingClaims(d.text)).toEqual([]);
      expect(d.text.replaceAll(URL, "")).not.toMatch(/https?:\/\/|www\./);
      expect(d.text).toContain(URL);
      if (CHANNEL_INFO[d.channel].kind === "video") expect(d.text).toMatch(/SCRIPT[\s\S]*STORYBOARD[\s\S]*SHOT LIST[\s\S]*NO VIDEO HAS BEEN PRODUCED/);
    }
    expect(plan.days.filter((d) => d.cta === "buy").map((d) => d.day)).toEqual([5, 10, 14]);
    expect(plan.files.map((f) => f.name)).toEqual(["plan.md", "calendar.md", "calendar.csv", "content-linkedin.md", "content-instagram.md", "content-tiktok.md", "content-youtube-shorts.md", "content-pinterest.md", "plan.json"]);
    expect(fs.readFileSync(path.join(plan.dir, "plan.md"), "utf8")).toMatch(/Audience segments \(hypotheses to test, not research findings\)[\s\S]*Facebook: left out\*\*, blocked \(Facebook account verification pending\)[\s\S]*Unknown is not zero/);
    expect(snapshot()).toEqual(before); // products, campaign, approvals, sales untouched
    expect(store.operations().blockers).toEqual([expect.objectContaining({ scope: "facebook" })]);
    expect(fetches).toBe(0);
  });

  it("idempotent; a later plan avoids repeating earlier steps; --utm links carry parameters; refuses non-live products and STOP", () => {
    const p = live();
    const a = createPlan(store, p.id, NOW);
    expect(createPlan(store, p.id, new Date(NOW.getTime() + 3_600_000))).toEqual({ plan: a.plan, reused: true });
    const b = createPlan(store, p.id, NOW, { start: "2026-11-25", utm: true });
    const overlap = b.plan.days.filter((d) => a.plan.days.some((x) => x.tip === d.tip)).length;
    expect(overlap).toBeLessThan(EXPERIMENT_DAYS);
    expect(b.plan.days[0].text).toContain(`${URL}?utm_source=linkedin&utm_medium=social&utm_campaign=${b.plan.id}`);
    store.saveVentures([...store.ventures(), { ...venture, id: "ven-00000002", status: "built" }]);
    const draft = buildProduct(store, "ven-00000002", { now: T0, currency: "GBP", price: 12 });
    expect(() => createPlan(store, draft.id, NOW)).toThrow(/live product page/);
    stop(store.dir, "pause", NOW);
    expect(() => createPlan(store, p.id, NOW, { start: "2026-12-01" })).toThrow(/STOP is set/);
  });

  it("approval needs a terminal; a post is recorded only with its own link on the planned channel, on or after its date, once", async () => {
    const { plan } = createPlan(store, live().id, NOW);
    expect(() => approveDay(store, plan.id, 1, { note: "", interactive: false }, NOW)).toThrow(/interactive terminal/);
    expect(() => recordPosted(store, plan.id, 1, "https://www.linkedin.com/posts/x", at("2026-11-11"))).toThrow(/not approved/);
    approveDay(store, plan.id, 1, { note: "ok", interactive: true }, NOW);
    expect(() => recordPosted(store, plan.id, 1, "https://www.linkedin.com/posts/x", NOW)).toThrow(/planned for 2026-11-11/);
    expect(() => recordPosted(store, plan.id, 1, "https://www.tiktok.com/@x/video/1", at("2026-11-11"))).toThrow(/link on LinkedIn/);
    recordPosted(store, plan.id, 1, "https://www.linkedin.com/posts/x", at("2026-11-11"));
    expect(() => recordPosted(store, plan.id, 1, "https://www.linkedin.com/posts/y", at("2026-11-11"))).toThrow(/already recorded/);
    expect(await cli("audience", "status")).toBe(0); expect(out).toMatch(new RegExp(`${plan.id} \\[avenor-studio\\] .* not started: 1 approved, 1 posted of 14`));
  });
});

describe("revenue: verified attribution only", () => {
  it("records measurements and orders; conversion only for comparable data; unknown is not zero; costs give net contribution", () => {
    const p = live();
    const { plan } = createPlan(store, p.id, NOW);
    const d = (s: string) => at(s);
    expect(() => recordMetric(store, { planId: plan.id, channel: "linkedin", date: "2026-11-11", source: "LinkedIn analytics" }, d("2026-11-12"))).toThrow(/at least one of --clicks or --visits/);
    expect(() => recordMetric(store, { planId: plan.id, channel: "facebook", date: "2026-11-11", clicks: "3", source: "x analytics" }, d("2026-11-12"))).toThrow(/not in plan/);
    recordMetric(store, { planId: plan.id, channel: "linkedin", date: "2026-11-11", clicks: "14", visits: "9", source: "Payhip dashboard + LinkedIn analytics" }, d("2026-11-12"));
    expect(() => recordMetric(store, { planId: plan.id, channel: "linkedin", date: "2026-11-11", clicks: "1", source: "again" }, d("2026-11-12"))).toThrow(/already recorded/);
    recordMetric(store, { planId: plan.id, channel: "pinterest", date: "2026-11-15", clicks: "0", source: "Pinterest analytics" }, d("2026-11-16"));
    recordOrder(store, p.id, { orderRef: "PH-2001", date: "2026-11-11", gross: "12", fees: "0.86", planId: plan.id, channel: "linkedin", source: "Payhip orders export" }, d("2026-11-12"));
    expect(() => recordOrder(store, p.id, { orderRef: "PH-2002", date: "2026-11-11", gross: "12", planId: plan.id, channel: "facebook", source: "Payhip" }, d("2026-11-12"))).toThrow(/not a channel of plan/);
    expect(() => recordOrder(store, p.id, { orderRef: "PH-2003", date: "2026-11-10", gross: "12", planId: plan.id, source: "Payhip" }, d("2026-11-12"))).toThrow(/before plan .* started/);
    recordCost(store, { date: "2026-11-12", amount: "3.50", description: "Canva Pro day pass", channel: "pinterest", source: "receipt email" }, d("2026-11-12"));
    expect(() => recordCost(store, { date: "2026-11-12", amount: "3.50", description: "canva pro day pass", source: "receipt" }, d("2026-11-12"))).toThrow(/already recorded/);
    const rows = Object.fromEntries(channelPerformance(store).map((r) => [r.channel, r]));
    expect(rows.linkedin).toMatchObject({ clicks: 14, visits: 9, orders: 1, grossPence: 1200, netPence: 1114, conversion: "11.1% (1 order(s) / 9 recorded visit(s), same days)" });
    expect(rows.pinterest).toMatchObject({ clicks: 0, visits: null, costPence: 350, conversion: "not measurable (no recorded visits)" });
    expect(rows.tiktok).toMatchObject({ clicks: null, visits: null, orders: 0 });
    expect(experimentResult(store, plan.id, "2026-11-12")).toMatchObject({ status: "running (day 2 of 14)", orders: 1, visits: 9, clicks: 14, conclusion: "not yet measured: the experiment is still running" });
    expect(experimentResult(store, plan.id, "2026-11-30").conclusion).toBe("not measurable: no post was recorded as published");
  });

  it("first-10-sales goal counts verified orders, excluding fully refunded ones", async () => {
    const p = live();
    expect(goals(store)).toEqual([{ productId: p.id, name: "Freelance invoicing kit", target: 10, sales: 0, withEvidence: 0, remaining: 10 }]);
    const a = recordOrder(store, p.id, { orderRef: "PH-1", date: "2026-11-10", gross: "12", source: "Payhip" }, NOW);
    recordOrder(store, p.id, { orderRef: "PH-2", date: "2026-11-10", gross: "12", source: "Payhip" }, NOW);
    recordRefund(store, a.id, { amount: "12", date: "2026-11-10", source: "Payhip refund" }, NOW);
    expect(goals(store)[0]).toMatchObject({ sales: 1, remaining: 9 });
    expect(await cli("revenue", "goals")).toBe(0); expect(out).toMatch(/Freelance invoicing kit \(prd-[0-9a-f]{8}\): 1\/10 verified sales/);
    expect(await cli("revenue", "report")).toBe(0); expect(out).toMatch(/gross 24\.00, refunds 12\.00, fees 0\.00 \(fees not recorded for 2 order\(s\): net is an upper bound\), net 12\.00; marketing costs 0\.00; net contribution 12\.00/);
  });

  it("no data: revenue report and dashboard say unknown / not measured, never zero sales", async () => {
    live();
    expect(await cli("revenue", "report")).toBe(0); expect(out).toMatch(/no orders recorded: revenue unknown, not zero[\s\S]*clicks unknown, visits unknown/);
    runDaily(store, DEFAULT_CONFIG, NOW);
    const dash = fs.readFileSync(path.join(store.dir, "reports", "owner-dashboard.html"), "utf8");
    expect(dash).toMatch(/Freelance invoicing kit: 0 of 10 first sales[\s\S]*<td>unknown<\/td>[\s\S]*0 = recorded as zero\. unknown = never recorded\. not measurable/);
  });
});

describe("opportunities score (offline)", () => {
  it("separates hypotheses from validated findings; only recorded orders or measurements validate", async () => {
    const p = live();
    let s = scoreOpportunities(store);
    const kit = s.find((x) => x.name === "Freelance invoicing kit")!;
    expect(kit.validatedFactors).toEqual([]);
    expect(s.filter((x) => x.source === "offline catalogue concept").map((x) => x.name)).toEqual(expect.arrayContaining(["Client onboarding kit", "Proposal and quote kit", "Project tracking kit"]));
    recordOrder(store, p.id, { orderRef: "PH-9", date: "2026-11-10", gross: "12", source: "Payhip" }, NOW);
    s = scoreOpportunities(store, [{ name: "Tax calculator", factors: { problem: 0.9 }, evidence: "a friend said so" }]);
    expect(s.find((x) => x.name === "Freelance invoicing kit")!.validatedFactors).toEqual(["willingnessToPay", "evidenceQuality"]);
    expect(s.find((x) => x.name === "Tax calculator")!).toMatchObject({ source: "owner idea", validatedFactors: [] });
    expect(await cli("opportunities", "score")).toBe(0);
    expect(out).toMatch(/OPPORTUNITIES \(offline; no research, scraping or paid calls\)[\s\S]*Saved: .*scores-2026-11-10\.json/);
    expect(fetches).toBe(0);
  });
});

describe("autopilot and brands", () => {
  it("revenue first: prepares the experiment once, no new product drafts while short of 10 sales, idempotent same day", () => {
    const p = live();
    const before = snapshot();
    const r1 = runAutopilot(store, DEFAULT_CONFIG, NOW);
    expect(r1.completed[0]).toMatch(/^prepared 14-day marketing experiment pln-[0-9a-f]{8} for Freelance invoicing kit \(2026-11-11 to 2026-11-24; channels linkedin, instagram, tiktok, youtube-shorts, pinterest\)/);
    expect(r1.skipped).toContain("new product draft: revenue first (Freelance invoicing kit 0/10 sales)");
    const r2 = runAutopilot(store, DEFAULT_CONFIG, new Date(NOW.getTime() + 3_600_000));
    expect(r2.completed).toEqual([]);
    expect(store.audiencePlans()).toHaveLength(1);
    expect(store.factoryRuns()).toEqual([]);
    expect(snapshot()).toEqual(before);
    const tomorrow = runDaily(store, DEFAULT_CONFIG, at("2026-11-11")).report;
    expect(tomorrow.nextAction).toMatchObject({ priority: 1, ref: `${store.audiencePlans()[0].id} day 1`, text: "approve today's LinkedIn content (interactive terminal)" });
    expect(tomorrow.revenue?.goals[0]).toMatchObject({ sales: 0, target: 10 });
    expect(brandOf(store.audiencePlans()[0])).toBe(DEFAULT_BRAND.id);
    expect(brandOf(p as { brand?: string })).toBe("avenor-studio"); // existing records default to Avenor Studio, unmigrated
    expect(fetches).toBe(0);
  });
});
