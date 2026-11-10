import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCampaign, decidePost, recordPublished, recordResults, type Campaign } from "../../venture-engine/campaign.js";
import { main } from "../../venture-engine/cli.js";
import { DEFAULT_CONFIG, stop } from "../../venture-engine/control.js";
import { decideApproval } from "../../venture-engine/engine.js";
import { londonDate, renderReport, runDaily, setBlocker, systemdUnits, type DailyReport } from "../../venture-engine/operations.js";
import { buildProduct, confirmationCode, markLive, recordValidation, requestLaunch, signOff, type Product } from "../../venture-engine/products.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const BUILT = new Date("2026-11-09T10:00:00Z");
const RUN = new Date("2026-11-12T08:00:00Z"); // 08:00 GMT in London
const URL = "https://payhip.com/b/t1JqT";
let DIR = "";
let store: Store;
let realFetch: typeof fetch;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vo-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access in a test"); }) as typeof fetch; // the daily run may never reach the network
});
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

const venture: Venture = { id: "ven-9e27315f", status: "built", experiments: [], decisions: [], createdAt: BUILT.toISOString(), updatedAt: BUILT.toISOString(),
  opportunity: { id: "opp-00000001", kind: "digital-product", title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms", audience: "freelancers", offer: "A template pack.", estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: BUILT.toISOString(), source: "fixture (test only)" } };
const signed = (): Product => {
  store.saveVentures([venture]);
  const p = buildProduct(store, venture.id, { now: BUILT, currency: "GBP" });
  return signOff(store, p.id, { confirm: confirmationCode(p), price: "GBP 12", note: "read qa-report.md; price OK", interactive: true }, BUILT);
};
const goLive = (p: Product) => { decideApproval(store, requestLaunch(store, p.id, BUILT).id, true, BUILT); markLive(store, p.id, URL, BUILT); };
/** The owner's situation: campaign from 10 November, the three Facebook posts approved, LinkedIn posts still drafts. */
const campaign = (p: Product): Campaign => {
  const c = createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: BUILT });
  for (const x of c.posts.filter((y) => y.platform === "facebook")) decidePost(store, c.id, x.id, { approve: true, note: "checked", interactive: true }, BUILT);
  return store.campaigns()[0];
};
const daily = (now = RUN) => runDaily(store, DEFAULT_CONFIG, now);
const records = () => ["products.json", "campaigns.json", "approvals.json", "portfolio.json", "config.json"].map((n) => { try { return fs.readFileSync(path.join(store.dir, n), "utf8"); } catch { return null; } });
const refs = (xs: DailyReport["actions"]) => xs.map((x) => `P${x.priority} ${x.ref}: ${x.text}`).join("\n");
let out = "";
const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => RUN, model: null }); };

describe("operations daily: what it reports", () => {
  it("with no data: reports unknowns (never zero sales), writes the md and json report and an audit entry", () => {
    const { report, files } = daily();
    expect(report.status).toBe("ok");
    expect(report.date).toBe("2026-11-12");
    expect(report.sales).toEqual([]);
    expect(report.limitations.join("\n")).toMatch(/No sales, revenue or visits have been recorded: they are unknown, not zero[\s\S]*No campaigns are recorded/);
    expect(files.map((f) => path.basename(f))).toEqual(["daily-2026-11-12.md", "daily-2026-11-12.json"]);
    for (const f of files) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(files[0])).mode & 0o777).toBe(0o700);
    const md = fs.readFileSync(files[0], "utf8");
    expect(md).toMatch(/Sales and revenue: not recorded/);
    expect(md).not.toMatch(/revenue (GBP )?0\b|0 sales/);
    expect(JSON.parse(fs.readFileSync(files[1], "utf8"))).toMatchObject({ schema: 1, date: "2026-11-12", timezone: "Europe/London", status: "ok" });
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).toMatch(/"kind":"operations-daily","date":"2026-11-12","status":"ok"/);
  });

  it("lists draft posts for approval and approved posts that are due, overdue or upcoming but not recorded as published", () => {
    const c = campaign(signed());
    const { report } = daily();
    const fb = c.posts.filter((x) => x.platform === "facebook");
    expect(report.campaigns[0].posts.filter((x) => x.platform === "facebook").map((x) => x.state)).toEqual(["approved, 1 day(s) overdue, not recorded as published", "approved, due in 1 day(s)", "approved, due in 3 day(s)"]);
    expect(refs(report.actions)).toContain(`P1 ${c.id} ${fb[0].id} (facebook, 2026-11-11): approved, 1 day(s) overdue, not recorded as published: publish it yourself on facebook (or reschedule), then record the link; the product must be marked live first`);
    expect(refs(report.actions)).toMatch(new RegExp(`P2 ${c.id} ${fb[1].id} .*make sure it is scheduled in Meta Business Suite`));
    expect(report.approvals.filter((x) => x.text.startsWith("draft post"))).toHaveLength(4); // the LinkedIn drafts
    expect(report.approvals.find((x) => x.ref.includes("2026-11-10"))?.priority).toBe(1); // already due
    expect(refs(report.blocked)).toContain(`product ${c.productId} is not marked live, so no post can be recorded as published`);
    expect(refs(report.approvals)).not.toMatch(/sign-off/); // signed off; a launch request is the next approval
    expect(refs(report.approvals)).toMatch(/signed off but no launch has been requested/);
  });

  it("a recorded outside blocker (Facebook verification) moves the Facebook posts to Blocked instead of actions", () => {
    const c = campaign(signed());
    setBlocker(store, "facebook", "Facebook account verification pending", BUILT);
    const { report } = daily();
    expect(report.blocked.filter((x) => x.text.includes("Facebook account verification pending"))).toHaveLength(3);
    expect(report.actions.some((x) => x.ref.includes("facebook"))).toBe(false);
    expect(report.campaigns[0].posts.find((x) => x.platform === "facebook")!.state).toMatch(/\(blocked\)$/);
    expect(store.campaigns()).toEqual([c]); // still approved and unpublished: nothing changed
    expect(renderReport(report)).toMatch(/## Blocked[\s\S]*blocked: Facebook account verification pending \(since 2026-11-09\)[\s\S]*operations unblock facebook/);
  });

  it("re-approval is asked for when an approved post's text no longer matches its approval", () => {
    const c = campaign(signed());
    const raw = JSON.parse(fs.readFileSync(path.join(store.dir, "campaigns.json"), "utf8"));
    raw[0].posts[1].text += " Edited.";
    store.saveCampaigns(raw);
    const { report } = daily();
    expect(report.approvals.some((x) => x.ref.startsWith(`${c.id} ${c.posts[1].id}`) && x.text.includes("approve it again"))).toBe(true);
  });

  it("live product: asks for sales records when none exist and reports recorded numbers exactly when they do", () => {
    const p = signed(); goLive(p);
    let r = daily().report;
    expect(r.sales).toEqual([{ productId: p.id, periods: 0, verifiedPeriods: 0, lastPeriodEnd: null, visits: null, signups: null, sales: null, revenue: null, currency: "GBP" }]);
    expect(refs(r.actions)).toMatch(/no visits or sales recorded yet: read them from your Payhip dashboard/);
    recordValidation(store, p.id, { periodStart: "2026-11-09", periodEnd: "2026-11-10", visits: 40, signups: 3, sales: 2, revenue: 24, source: "Payhip sales report" }, new Date("2026-11-11T09:00:00Z"));
    r = daily().report;
    expect(r.sales[0]).toMatchObject({ periods: 1, visits: 40, signups: 3, sales: 2, revenue: 24, lastPeriodEnd: "2026-11-10" });
    expect(renderReport(r)).toContain("visits 40, signups 3, sales 2, revenue GBP 24");
  });

  it("published posts: asks for results after two days; reports recorded engagement only", () => {
    const p = signed(); goLive(p);
    const c = campaign(store.products()[0]);
    const fb = c.posts.find((x) => x.platform === "facebook")!;
    recordPublished(store, c.id, fb.id, "https://www.facebook.com/61596090014020/posts/1", new Date("2026-11-11T12:00:00Z"));
    let r = daily(new Date("2026-11-13T08:00:00Z")).report;
    expect(refs(r.actions)).toMatch(new RegExp(`${fb.id} .*published 2 day\\(s\\) ago: record its numbers`));
    expect(r.engagement[0]).toEqual({ campaignId: c.id, postsWithResults: 0, impressions: null, clicks: null });
    recordResults(store, c.id, fb.id, { periodStart: "2026-11-11", periodEnd: "2026-11-12", impressions: 120, reactions: 4, comments: 1, shares: 0, clicks: 7, source: "Meta Business Suite insights" }, new Date("2026-11-13T07:00:00Z"));
    r = daily(new Date("2026-11-13T08:00:00Z")).report;
    expect(r.engagement[0]).toMatchObject({ postsWithResults: 1, impressions: 120, clicks: 7 });
    expect(r.actions.some((x) => x.ref.includes(fb.id))).toBe(false);
  });

  it("missing or inconsistent data: a campaign whose product is missing, and changed product files, are problems", () => {
    const p = signed();
    const c = campaign(p);
    fs.chmodSync(path.join(store.dir, "ventures", p.ventureId, p.id, "landing.html"), 0o600);
    fs.appendFileSync(path.join(store.dir, "ventures", p.ventureId, p.id, "landing.html"), "<!-- edit -->");
    store.saveCampaigns([{ ...c, productId: "prd-00000000" }]);
    const { report } = daily();
    expect(refs(report.problems)).toContain(`P1 ${c.id}: its product prd-00000000 is missing from products.json`);
    expect(refs(report.problems)).toMatch(new RegExp(`P1 ${p.id}: files changed or missing since the build: landing\\.html`));
    expect(report.products[0].filesIntact).toBe(false);
  });
});

describe("operations daily: runs, failures and timezone", () => {
  it("a corrupt record makes a PARTIAL run: the other sections and the report are still produced, the CLI exits 1", async () => {
    signed();
    fs.writeFileSync(path.join(store.dir, "campaigns.json"), "{ not json", { mode: 0o600 });
    expect(await cli("operations", "daily")).toBe(1);
    expect(out).toMatch(/Run status: \*\*PARTIAL\*\*[\s\S]*## Errors\n\n- campaigns and posts: /);
    const r = JSON.parse(fs.readFileSync(path.join(store.dir, "reports", "daily-2026-11-12.json"), "utf8")) as DailyReport;
    expect(r.status).toBe("partial");
    expect(r.products).toHaveLength(1);
    expect(fs.existsSync(path.join(store.dir, "run.lock"))).toBe(false);
  });

  it("a FAILED run (report folder unusable) exits 1 with the reason and writes no report", async () => {
    fs.symlinkSync(os.tmpdir(), path.join(store.dir, "reports"));
    expect(await cli("operations", "daily")).toBe(1);
    expect(out).toMatch(/^error: .*reports must be your own real directory/);
    const audit = path.join(store.dir, "audit.jsonl");
    expect(fs.existsSync(audit) && fs.readFileSync(audit, "utf8").includes("operations-daily")).toBe(false);
  });

  it("duplicate runs on the same day replace that day's report with identical content (idempotent) and are each audited", () => {
    campaign(signed());
    const a = daily(); const first = fs.readFileSync(a.files[1], "utf8");
    const b = daily(new Date(RUN.getTime() + 3_600_000));
    expect(b.files).toEqual(a.files);
    const strip = (s: string) => ({ ...JSON.parse(s), generatedAt: "-" });
    expect(strip(fs.readFileSync(b.files[1], "utf8"))).toEqual(strip(first));
    expect(fs.readdirSync(path.join(store.dir, "reports")).sort()).toEqual(["daily-2026-11-12.json", "daily-2026-11-12.md"]);
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8").match(/"kind":"operations-daily"/g)).toHaveLength(2);
  });

  it("uses the UK calendar date in summer (BST) and winter (GMT); the timer is 08:00 Europe/London", () => {
    expect(londonDate(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01"); // 00:30 BST
    expect(londonDate(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31"); // 23:30 GMT
    expect(londonDate(new Date("2026-03-29T00:30:00Z"))).toBe("2026-03-29"); // before the change to BST
    expect(londonDate(new Date("2026-10-24T23:30:00Z"))).toBe("2026-10-25"); // 00:30 BST, the day the clocks go back
    expect(path.basename(daily(new Date("2026-06-30T23:30:00Z")).files[0])).toBe("daily-2026-07-01.md");
    const u = systemdUnits();
    expect(u).toMatch(/OnCalendar=\*-\*-\* 08:00:00 Europe\/London/);
    expect(u).toMatch(/Type=oneshot[\s\S]*TimeoutStartSec=300[\s\S]*NoNewPrivileges=yes[\s\S]*RestrictAddressFamilies=AF_UNIX/);
    expect(u).toMatch(/Persistent=true/);
    expect(u).not.toMatch(/User=root|sudo|--paid|API_KEY|token/i);
  });
});

describe("operations daily: safeguards", () => {
  it("changes no business record, publishes, approves or schedules nothing, and makes no network call", async () => {
    const p = signed(); goLive(p);
    campaign(store.products()[0]);
    await cli("config"); // the CLI creates config.json with safe defaults on first use (existing behaviour)
    const before = records();
    expect(await cli("operations", "daily")).toBe(0);
    expect(records()).toEqual(before);
    expect(store.campaigns()[0].posts.map((x) => x.status)).toEqual(["draft", "approved", "draft", "approved", "draft", "approved", "draft"]);
    expect(store.approvals().every((a) => a.status !== "pending")).toBe(true);
    expect(out).toContain("Nothing was published, scheduled, sent, bought, approved, priced, reworded or deleted; no network or model calls were made.");
    expect(fs.readdirSync(store.dir).filter((n) => !["reports", "ventures"].includes(n)).sort()).toEqual(["approvals.json", "audit.jsonl", "campaigns.json", "config.json", "dashboard.html", "portfolio.json", "products.json"]);
    expect(out).not.toMatch(/sk-ant|password|cookie/i);
  });

  it("while STOP is set it reports, but skips maintenance; a run in progress blocks a second run", async () => {
    stop(store.dir, "owner pause", RUN);
    const { report } = daily();
    expect(report.completed[0]).toBe("maintenance skipped: STOP is set");
    expect(fs.existsSync(path.join(store.dir, "dashboard.html"))).toBe(false);
    expect(refs(report.problems)).toMatch(/P1 STOP: STOP is set/);
    fs.writeFileSync(path.join(store.dir, "run.lock"), String(process.pid));
    expect(await cli("operations", "daily")).toBe(1);
    expect(out).toMatch(/another run is in progress/);
    fs.unlinkSync(path.join(store.dir, "run.lock"));
  });

  it("CLI: --json output, blockers, unit templates and usage", async () => {
    expect(await cli("operations", "block", "facebook", "--reason", "Facebook account verification pending")).toBe(0);
    expect(out).toMatch(/blocked facebook: Facebook account verification pending \(reporting only/);
    expect(await cli("operations", "blockers")).toBe(0); expect(out).toMatch(/^facebook: Facebook account verification pending/);
    expect(await cli("operations", "block", "Bad Scope!", "--reason", "x y z")).toBe(1);
    expect(await cli("operations", "daily", "--json")).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ schema: 1, status: "ok", date: "2026-11-12" });
    expect(await cli("operations", "unblock", "facebook")).toBe(0); expect(out).toBe("unblocked facebook\n");
    expect(await cli("operations", "unit")).toBe(0); expect(out).toMatch(/automaton-daily\.timer/);
    expect(await cli("operations", "daily", "--paid")).toBe(1);
    expect(await cli("operations")).toBe(2); expect(out).toMatch(/operations daily \[--json\]/);
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).toMatch(/operations-blocker-set[\s\S]*operations-blocker-cleared/);
  });
});
