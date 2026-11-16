import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import Stripe from "stripe";
import { loadConfig, assertPaymentSafety, type Config } from "../src/config.js";
import { openDb, createPendingSubscriber, getSubscriberById, openTenders, type DB } from "../src/db.js";
import { isCleaningRelevant, isOpen } from "../src/filter.js";
import { regionFromNuts, regionFromPostcode, matchesRegions, sanitizeRegions, resolveRegion } from "../src/regions.js";
import { normalizeAll, fingerprint } from "../src/sources/ocds.js";
import { scan } from "../src/scanner.js";
import { sendDigests, runDaily } from "../src/jobs.js";
import { renderDigest } from "../src/digest.js";
import { handleStripeEvent, mapStatus } from "../src/billing.js";
import { createApp } from "../src/web/server.js";
import type { Mailer } from "../src/mailer.js";
import type { Email } from "../src/digest.js";

process.env.TS_LOG_SILENT = "1";
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/releases.json"), "utf8"));
const NOW = new Date("2026-11-16T20:00:00Z");

class MemMailer implements Mailer {
  live = false;
  sent: Email[] = [];
  failNext = 0;
  async send(e: Email) {
    if (this.failNext > 0) { this.failNext--; throw new Error("SMTP down"); }
    this.sent.push(e);
  }
}

function testCfg(over: Record<string, string> = {}): Config {
  return loadConfig({ TS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ts-")), TS_BASE_URL: "https://tenderscout.test",
    TS_ADMIN_EMAIL: "admin@example.com", STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_ID: "price_123", ...over } as any);
}

/** Fake fetcher serving fixture releases, split into 2 pages to exercise pagination. */
function fixtureFetcher(fail: string[] = []) {
  return async (url: string) => {
    const src = url.includes("find-tender") ? "fts" : "cf";
    if (fail.includes(src)) throw new Error(`${src} unavailable`);
    const all = FIX[src];
    const page2 = url.includes("cursor=2");
    const half = Math.ceil(all.length / 2);
    return { releases: page2 ? all.slice(half) : all.slice(0, half), links: page2 ? {} : { next: `${url}&cursor=2` } };
  };
}

function activeSub(db: DB, email: string, regions: string[]) {
  const s = createPendingSubscriber(db, email, "Co", regions);
  db.prepare("UPDATE subscribers SET status='active' WHERE id=?").run(s.id);
  return getSubscriberById(db, s.id)!;
}

describe("relevance filter", () => {
  it("includes cleaning CPVs and titles, excludes products/pest/drains", () => {
    expect(isCleaningRelevant({ title: "Office Cleaning Services", description: "", cpv: [] })).toBe(true);
    expect(isCleaningRelevant({ title: "Lot 2", description: "", cpv: ["90919200"] })).toBe(true);
    expect(isCleaningRelevant({ title: "Window cleaning", description: "", cpv: ["90911300"] })).toBe(true);
    expect(isCleaningRelevant({ title: "Supply of cleaning products", description: "", cpv: ["39830000"] })).toBe(false);
    expect(isCleaningRelevant({ title: "Pest control services", description: "", cpv: ["90922000"] })).toBe(false);
    expect(isCleaningRelevant({ title: "Gully and drain cleaning", description: "", cpv: ["90470000"] })).toBe(false);
    expect(isCleaningRelevant({ title: "Clean Air Zone signage", description: "", cpv: ["34928470"] })).toBe(false);
    expect(isCleaningRelevant({ title: "Marketing services", description: "", cpv: ["79342000"] })).toBe(false);
    expect(isCleaningRelevant({ title: "Total FM", description: "including office cleaning services", cpv: ["79993000"] })).toBe(true);
  });
  it("treats past deadlines and cancelled notices as closed", () => {
    expect(isOpen("active", "2026-11-01T00:00:00Z", NOW)).toBe(false);
    expect(isOpen("cancelled", null, NOW)).toBe(false);
    expect(isOpen("active", null, NOW)).toBe(true);
  });
});

describe("regions", () => {
  it("maps NUTS/ITL codes, postcodes and names", () => {
    expect(regionFromNuts("UKM66")).toEqual(["SCO"]);
    expect(regionFromNuts("TLI41")).toEqual(["LDN"]);
    expect(regionFromNuts("UK")).toEqual(["UK"]);
    expect(regionFromPostcode("SY2 6LG")).toEqual(["WAL"]);
    expect(regionFromPostcode("M1 1AA")).toEqual(["NW"]);
    expect(resolveRegion({ region: "South East" })).toEqual(["SE"]);
  });
  it("matches subscriber regions; national/unstated go to everyone", () => {
    expect(matchesRegions(["SE"], ["SE", "LDN"])).toBe(true);
    expect(matchesRegions(["SCO"], ["SE"])).toBe(false);
    expect(matchesRegions(["UK"], ["SE"])).toBe(true);
    expect(matchesRegions([], ["SE"])).toBe(true);
    expect(matchesRegions(["SCO"], ["ALL"])).toBe(true);
    expect(sanitizeRegions(["SE", "BOGUS"])).toEqual(["SE"]);
    expect(sanitizeRegions([])).toEqual(["ALL"]);
  });
});

describe("OCDS normalisation (real fixture data)", () => {
  const fts = normalizeAll("fts", FIX.fts);
  it("extracts title, buyer, region, value, deadline and official URL", () => {
    const fife = fts.find((t) => t.title === "Provision of Window Cleaning Services")!;
    expect(fife.buyer).toBe("Fife Council");
    expect(fife.regions).toEqual(["SCO"]);
    expect(fife.valueAmount).toBe(280000);
    expect(fife.deadline).toBe("2026-12-02T12:00:00.000Z");
    expect(fife.url).toBe("https://www.find-tender.service.gov.uk/Notice/103830-2026");
  });
  it("uses expression-of-interest deadline for Procurement Act notices", () => {
    const star = fts.find((t) => t.title.startsWith("STAR Housing"))!;
    expect(star.deadlineKind).toBe("eoi");
    expect(star.deadline).toBeTruthy();
  });
  it("drops overseas-only notices", () => {
    expect(fts.find((t) => t.title.includes("British Council Thailand"))).toBeUndefined();
  });
  it("uses buyer location when delivery is UK-wide", () => {
    const newcastle = fts.find((t) => t.title.includes("Window and High Level Cleaning"))!;
    expect(newcastle.regions).toEqual(["NE"]);
  });
  it("fingerprint ignores reference prefixes", () => {
    expect(fingerprint("CA18601 - Cheetham CE Community Academy Tender for Cleaning Services", "Cheetham CE Academy"))
      .toBe(fingerprint("Cheetham CE Community Academy Tender for Cleaning Services", "Cheetham CE Academy"));
  });
  it("CF notices link to Contracts Finder", () => {
    const cf = normalizeAll("cf", FIX.cf);
    expect(cf.every((t) => t.url.startsWith("https://www.contractsfinder.service.gov.uk/Notice/"))).toBe(true);
  });
});

describe("scanner", () => {
  let db: DB;
  beforeEach(() => { db = openDb(":memory:"); });

  it("stores relevant open tenders, dedupes across sources, is idempotent", async () => {
    const r1 = await scan(db, { lookbackDays: 3, now: NOW, fetcher: fixtureFetcher() });
    expect(r1.ok).toBe(true);
    expect(r1.errors).toEqual([]);
    expect(r1.duplicates).toBeGreaterThanOrEqual(1); // Cheetham etc. appear on both FTS and CF
    const open = openTenders(db, NOW.toISOString());
    expect(open.length).toBeGreaterThan(5);
    expect(open.every((t) => !t.deadline || t.deadline > NOW.toISOString())).toBe(true);
    const fps = open.map((t) => t.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
    expect(open.filter((t) => t.title.includes("Cheetham")).length).toBe(1);
    const r2 = await scan(db, { lookbackDays: 3, now: NOW, fetcher: fixtureFetcher() });
    expect(r2.inserted).toBe(0);
    expect(openTenders(db, NOW.toISOString()).length).toBe(open.length);
  });

  it("reports a failed source but keeps the other", async () => {
    const r = await scan(db, { lookbackDays: 3, now: NOW, fetcher: fixtureFetcher(["cf"]) });
    expect(r.ok).toBe(true);
    expect(r.errors.map((e) => e.source)).toEqual(["cf"]);
  });

  it("excludes expired tenders when time passes", async () => {
    await scan(db, { lookbackDays: 3, now: NOW, fetcher: fixtureFetcher() });
    expect(openTenders(db, "2030-01-01T00:00:00Z").filter((t) => t.deadline).length).toBe(0);
  });
});

describe("digest delivery", () => {
  let db: DB; let cfg: Config; let mailer: MemMailer;
  beforeEach(async () => {
    db = openDb(":memory:"); cfg = testCfg(); mailer = new MemMailer();
    await scan(db, { lookbackDays: 3, now: NOW, fetcher: fixtureFetcher() });
  });

  it("sends once per subscriber per day, never duplicates on re-run", async () => {
    activeSub(db, "a@x.co.uk", ["ALL"]);
    const r1 = await sendDigests(db, cfg, mailer, NOW);
    expect(r1.sent).toBe(1);
    const r2 = await sendDigests(db, cfg, mailer, NOW);
    expect(r2.sent).toBe(0);
    expect(mailer.sent.length).toBe(1);
    expect(mailer.sent[0].html).toContain("find-tender.service.gov.uk/Notice/");
    expect(mailer.sent[0].headers?.["List-Unsubscribe"]).toContain("/unsubscribe?token=");
  });

  it("filters by region and only sends new tenders next day; no-results email is helpful", async () => {
    const sco = activeSub(db, "s@x.co.uk", ["SCO"]);
    await sendDigests(db, cfg, mailer, NOW);
    const first = mailer.sent[0];
    expect(first.html).toContain("Fife Council");
    expect(first.html).not.toContain("Rathfern Primary"); // London
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    await sendDigests(db, cfg, mailer, tomorrow);
    const second = mailer.sent[1];
    expect(second.subject).toMatch(/No new cleaning contracts/);
    expect(second.html).toContain("still open");
    expect(sco.id).toBeTruthy();
  });

  it("does not send to pending, past_due or unsubscribed users", async () => {
    createPendingSubscriber(db, "p@x.co.uk", "Co", ["ALL"]);
    const s = activeSub(db, "u@x.co.uk", ["ALL"]);
    db.prepare("UPDATE subscribers SET emails_enabled=0 WHERE id=?").run(s.id);
    const d = activeSub(db, "d@x.co.uk", ["ALL"]);
    db.prepare("UPDATE subscribers SET status='past_due' WHERE id=?").run(d.id);
    expect((await sendDigests(db, cfg, mailer, NOW)).sent).toBe(0);
  });

  it("retries failures without duplicating, and never auto-retries 'sending'", async () => {
    activeSub(db, "a@x.co.uk", ["ALL"]);
    const b = activeSub(db, "b@x.co.uk", ["ALL"]);
    mailer.failNext = 1;
    const r1 = await sendDigests(db, cfg, mailer, NOW);
    expect(r1.failed).toBe(1); expect(r1.sent).toBe(1);
    const r2 = await sendDigests(db, cfg, mailer, NOW);
    expect(r2.sent).toBe(1); expect(r2.failed).toBe(0);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(2);
    expect(mailer.sent.length).toBe(2);
    // simulate crash mid-send for b tomorrow
    const tomorrow = "2026-11-17";
    db.prepare("INSERT INTO email_log (subscriber_id, digest_date, status, attempts) VALUES (?, ?, 'sending', 1)").run(b.id, tomorrow);
    const r3 = await sendDigests(db, cfg, mailer, new Date("2026-11-17T07:00:00Z"));
    expect(r3.stuck).toBe(1);
    expect(mailer.sent.filter((m) => m.to === "b@x.co.uk").length).toBe(1);
  });

  it("runDaily alerts admin and skips sending when all sources fail", async () => {
    const db2 = openDb(":memory:");
    activeSub(db2, "a@x.co.uk", ["ALL"]);
    const r = await runDaily(db2, cfg, mailer, { now: NOW, fetcher: fixtureFetcher(["fts", "cf"]) });
    expect(r.digest).toBeNull();
    expect(mailer.sent.some((m) => m.to === "admin@example.com" && m.subject.includes("ALERT"))).toBe(true);
    expect(mailer.sent.some((m) => m.to === "a@x.co.uk")).toBe(false);
  });

  it("escapes HTML in tender data", () => {
    const sub = activeSub(db, "e@x.co.uk", ["ALL"]);
    const e = renderDigest(cfg, sub, [{ id: "x", source: "fts", fingerprint: "f", title: "<script>x</script>", buyer: "B", regions: [], location_label: "L",
      description: "", value_amount: null, value_currency: null, deadline: null, deadline_kind: null, published: null, url: "https://www.find-tender.service.gov.uk/Notice/1", status: "active", first_seen: "" }], [], NOW);
    expect(e.html).not.toContain("<script>x");
  });
});

describe("billing", () => {
  let db: DB; let cfg: Config; let mailer: MemMailer;
  beforeEach(() => { db = openDb(":memory:"); cfg = testCfg(); mailer = new MemMailer(); });
  const ev = (id: string, type: string, object: any) => ({ id, type, data: { object } }) as any;

  it("refuses live Stripe keys unless explicitly allowed", () => {
    expect(() => assertPaymentSafety(testCfg({ STRIPE_SECRET_KEY: "sk_live_x" }))).toThrow(/LIVE/);
    expect(() => assertPaymentSafety(testCfg({ STRIPE_SECRET_KEY: "sk_live_x", TS_ALLOW_LIVE_PAYMENTS: "true" }))).not.toThrow();
  });

  it("activates only when payment is confirmed, sends one welcome", async () => {
    const s = createPendingSubscriber(db, "a@x.co.uk", "Co", ["SE"]);
    await handleStripeEvent(db, cfg, mailer, ev("evt_1", "checkout.session.completed", { mode: "subscription", payment_status: "unpaid", client_reference_id: s.id, customer: "cus_1", subscription: "sub_1" }));
    expect(getSubscriberById(db, s.id)!.status).toBe("pending");
    await handleStripeEvent(db, cfg, mailer, ev("evt_2", "invoice.paid", { customer: "cus_1", parent: { subscription_details: { subscription: "sub_1" } } }));
    expect(getSubscriberById(db, s.id)!.status).toBe("active");
    await handleStripeEvent(db, cfg, mailer, ev("evt_3", "customer.subscription.updated", { object: "subscription", id: "sub_1", customer: "cus_1", status: "active", metadata: { subscriber_id: s.id } }));
    expect(mailer.sent.filter((m) => m.subject.startsWith("Welcome")).length).toBe(1);
  });

  it("handles past_due, cancellation and duplicate events", async () => {
    const s = createPendingSubscriber(db, "a@x.co.uk", "Co", ["SE"]);
    await handleStripeEvent(db, cfg, mailer, ev("evt_1", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: s.id, customer: "cus_1", subscription: "sub_1" }));
    expect(getSubscriberById(db, s.id)!.status).toBe("active");
    await handleStripeEvent(db, cfg, mailer, ev("evt_2", "customer.subscription.updated", { object: "subscription", id: "sub_1", customer: "cus_1", status: "past_due" }));
    expect(getSubscriberById(db, s.id)!.status).toBe("past_due");
    await handleStripeEvent(db, cfg, mailer, ev("evt_3", "customer.subscription.deleted", { object: "subscription", id: "sub_1", customer: "cus_1", status: "canceled" }));
    expect(getSubscriberById(db, s.id)!.status).toBe("cancelled");
    await handleStripeEvent(db, cfg, mailer, ev("evt_1", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: s.id }));
    expect(getSubscriberById(db, s.id)!.status).toBe("cancelled"); // replayed event ignored
    expect(mapStatus("incomplete")).toBe("pending");
  });
});

describe("web server", () => {
  let db: DB; let cfg: Config; let mailer: MemMailer; let base: string; let server: http.Server;
  const stripe = new Stripe("sk_test_123");
  beforeEach(async () => {
    db = openDb(":memory:"); cfg = testCfg(); mailer = new MemMailer();
    await scan(db, { lookbackDays: 3, now: NOW, fetcher: fixtureFetcher() });
    server = http.createServer(createApp({ db, cfg, mailer, stripe }));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    return () => server.close();
  });

  it("serves the public pages", async () => {
    for (const p of ["/", "/example", "/privacy", "/terms", "/healthz"]) {
      const r = await fetch(base + p);
      expect(r.status, p).toBe(200);
    }
    const home = await (await fetch(base + "/")).text();
    expect(home).toContain("£29");
    expect(home).toContain('action="/signup"');
    expect(await (await fetch(base + "/example")).text()).toContain("Notice/");
  });

  it("rejects invalid signups", async () => {
    const r = await fetch(base + "/signup", { method: "POST", body: new URLSearchParams({ email: "bad", company: "x" }), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.status).toBe(400);
  });

  it("creates a Stripe Checkout session for valid signups", async () => {
    const spy = vi.spyOn(stripe.checkout.sessions, "create").mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/test" } as any);
    const body = new URLSearchParams([["email", "new@x.co.uk"], ["company", "New Ltd"], ["regions", "SE"], ["regions", "LDN"], ["consent", "yes"]]);
    const r = await fetch(base + "/signup", { method: "POST", body, redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/test");
    const args = spy.mock.calls[0][0] as any;
    expect(args.mode).toBe("subscription");
    expect(args.line_items[0].price).toBe("price_123");
    const row = db.prepare("SELECT status, regions FROM subscribers WHERE email='new@x.co.uk'").get() as any;
    expect(row.status).toBe("pending");
    expect(JSON.parse(row.regions)).toEqual(["SE", "LDN"]);
  });

  it("verifies webhook signatures", async () => {
    const s = createPendingSubscriber(db, "w@x.co.uk", "Co", ["ALL"]);
    const payload = JSON.stringify({ id: "evt_w", object: "event", type: "checkout.session.completed",
      data: { object: { mode: "subscription", payment_status: "paid", client_reference_id: s.id, customer: "cus_w", subscription: "sub_w" } } });
    const bad = await fetch(base + "/webhooks/stripe", { method: "POST", body: payload, headers: { "stripe-signature": "t=1,v1=bad" } });
    expect(bad.status).toBe(400);
    expect(getSubscriberById(db, s.id)!.status).toBe("pending");
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test" });
    const ok = await fetch(base + "/webhooks/stripe", { method: "POST", body: payload, headers: { "stripe-signature": sig } });
    expect(ok.status).toBe(200);
    expect(getSubscriberById(db, s.id)!.status).toBe("active");
  });

  it("supports preferences and one-click unsubscribe", async () => {
    const s = activeSub(db, "p@x.co.uk", ["ALL"]);
    expect((await fetch(`${base}/preferences?token=bogus`)).status).toBe(404);
    const page = await (await fetch(`${base}/preferences?token=${s.token}`)).text();
    expect(page).not.toContain("p@x.co.uk"); // masked
    await fetch(base + "/preferences", { method: "POST", body: new URLSearchParams([["token", s.token], ["regions", "WAL"], ["emails", "on"]]), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(getSubscriberById(db, s.id)!.regions).toEqual(["WAL"]);
    const u = await fetch(`${base}/unsubscribe?token=${s.token}`, { method: "POST", body: "List-Unsubscribe=One-Click" });
    expect(u.status).toBe(200);
    expect(getSubscriberById(db, s.id)!.emails_enabled).toBe(0);
  });
});
