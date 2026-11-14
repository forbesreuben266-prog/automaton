import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveDay, createPlan, type AudiencePlan } from "../../venture-engine/audience.js";
import { createCampaign } from "../../venture-engine/campaign.js";
import { main } from "../../venture-engine/cli.js";
import { DEFAULT_CONFIG, stop } from "../../venture-engine/control.js";
import { decideApproval } from "../../venture-engine/engine.js";
import { renderCard } from "../../venture-engine/graphics.js";
import { runDaily, setBlocker } from "../../venture-engine/operations.js";
import { buildProduct, confirmationCode, markLive, requestLaunch, signOff } from "../../venture-engine/products.js";
import { imageInfo } from "../../venture-engine/raster.js";
import { channelPerformance } from "../../venture-engine/revenue.js";
import { connect, DEFAULT_ADAPTERS, enqueue, londonInstant, queue, runQueue, setLive, useScreenshot, type Platform, type PublishAdapter, type PublishRequest, type PublishResult } from "../../venture-engine/social.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const T0 = new Date("2026-11-09T10:00:00Z");
const NOW = new Date("2026-11-14T09:00:00Z");
const URL = "https://payhip.com/b/t1JqT";
const TOKEN = "IGQVJtest-token-abcdefghijklmnopqrstuvwxyz0123456789";
let DIR = "", store: Store, realFetch: typeof fetch, fetches = 0;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vs-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch; fetches = 0;
  globalThis.fetch = (() => { fetches += 1; throw new Error("network access in a test"); }) as typeof fetch; // nothing may reach a platform
});
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

const venture: Venture = { id: "ven-9e27315f", status: "built", experiments: [], decisions: [], createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
  opportunity: { id: "opp-00000001", kind: "digital-product", title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms", audience: "freelancers", offer: "A template pack.", estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: T0.toISOString(), source: "fixture" } };
/** Live kit, Facebook blocked, plan from 2026-11-14: day 2 Instagram (11-15), day 5 Pinterest (11-18), day 7 Instagram (11-20). */
const setup = (): AudiencePlan => {
  store.saveVentures([venture]);
  let p = buildProduct(store, venture.id, { now: T0, currency: "GBP", price: 12 });
  p = signOff(store, p.id, { confirm: confirmationCode(p), price: "GBP 12", note: "checked", interactive: true }, T0);
  decideApproval(store, requestLaunch(store, p.id, T0).id, true, T0); markLive(store, p.id, URL, T0);
  createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: T0 });
  setBlocker(store, "facebook", "Facebook account verification pending", T0);
  const { plan } = createPlan(store, p.id, NOW, { start: "2026-11-14" });
  for (const d of [2, 5, 7]) approveDay(store, plan.id, d, { note: "ok", interactive: true }, NOW);
  return store.audiencePlans()[0];
};
const tokenFile = () => { const f = path.join(DIR, "token.txt"); fs.writeFileSync(f, `${TOKEN}\n`, { mode: 0o600 }); return f; };
/** A verified mock adapter that records requests and answers from a script. */
function mock(answers: ((req: PublishRequest) => PublishResult)[] = []) {
  const calls: PublishRequest[] = [];
  const make = (platform: Platform): PublishAdapter => ({ platform, verified: true, note: "mock (tests only)", async validate() { return { ok: true, detail: "mock" }; },
    async publish(req) { calls.push(req); const a = answers.shift(); return a ? a(req) : { kind: "published", externalId: `${platform}-${calls.length}`, url: platform === "instagram" ? `https://www.instagram.com/p/MOCK${calls.length}/` : `https://www.pinterest.com/pin/${1000 + calls.length}/` }; } });
  return { calls, adapters: { instagram: make("instagram"), pinterest: make("pinterest") } };
}
const goLive = (adapters: Record<Platform, PublishAdapter>) => { connect(store, "instagram", { accountId: "17841400000000000", tokenFile: tokenFile() }, NOW); connect(store, "pinterest", { accountId: "board-123", tokenFile: tokenFile() }, NOW); setLive(store, "instagram", true, { interactive: true, adapters }, NOW); setLive(store, "pinterest", true, { interactive: true, adapters }, NOW); };
const at = (iso: string) => new Date(iso);
let out = "";
const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null }); };

describe("connections: OAuth token from a file, private, never shown", () => {
  it("stores the token with mode 600, prints only a fingerprint, refuses non-token content; adapters are not verified", async () => {
    expect(await cli("social", "connect", "instagram", "--account", "17841400000000000", "--token-file", tokenFile())).toBe(0);
    expect(out).toMatch(/instagram connected: account 17841400000000000, token fingerprint [0-9a-f]{12}\. Live publishing stays off/);
    expect(out).not.toContain(TOKEN);
    const f = path.join(store.dir, "social", "instagram.json");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    const pw = path.join(DIR, "pw.txt"); fs.writeFileSync(pw, "my password 123");
    expect(await cli("social", "connect", "pinterest", "--account", "b1", "--token-file", pw)).toBe(1); expect(out).toMatch(/Passwords are never accepted/);
    expect(await cli("social", "status")).toBe(0);
    expect(out).toMatch(/Instagram: connected \(account 17841400000000000, token fingerprint [0-9a-f]{12}, expiry not given\); live publishing off; adapter not implemented: the official instagram API documentation \(developers\.facebook\.com\)/);
    expect(out).toMatch(/Pinterest: not connected/);
    expect(out).not.toContain(TOKEN);
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).not.toContain(TOKEN);
  });

  it("live mode cannot be turned on with the real (unverified) adapters, nor without a terminal", () => {
    connect(store, "instagram", { accountId: "1784", tokenFile: tokenFile() }, NOW);
    expect(() => setLive(store, "instagram", true, { interactive: true, adapters: DEFAULT_ADAPTERS }, NOW)).toThrow(/cannot be turned on: not implemented/);
    expect(() => setLive(store, "instagram", true, { interactive: false, adapters: mock().adapters }, NOW)).toThrow(/interactive terminal/);
  });
});

describe("queue: approved content only, one item per day", () => {
  it("queues approved Instagram/Pinterest days with a deterministic card at 12:30 UK time; reruns add nothing", () => {
    const plan = setup();
    const r = enqueue(store, plan.id, NOW);
    expect(r.added.map((x) => `${x.day}:${x.platform}:${x.scheduledAt}`)).toEqual(["2:instagram:2026-11-15T12:30:00.000Z", "5:pinterest:2026-11-18T12:30:00.000Z", "7:instagram:2026-11-20T12:30:00.000Z"]);
    expect(r.skipped.join(" ")).toMatch(/day 10: not approved/);
    const ig = r.added[0];
    expect(ig.caption).toMatch(/^.+\n\n.*Link in bio\.\n#freelancer/);
    expect(r.added[1].title).toBeTruthy();
    expect(r.added[1].caption).not.toMatch(/IMAGE BRIEF|LINK:/);
    expect(r.added[1].caption).toMatch(/Freelance invoicing kit/);
    expect(ig.caption).not.toMatch(/CAROUSEL BRIEF|BIO LINK/);
    const png = fs.readFileSync(ig.media.file);
    expect(imageInfo(png)).toEqual({ type: "png", width: 1080, height: 1350 });
    expect(imageInfo(fs.readFileSync(r.added[1].media.file))).toEqual({ type: "png", width: 1000, height: 1500 });
    expect(enqueue(store, plan.id, NOW).added).toEqual([]);
    expect(queue(store)).toHaveLength(3);
    expect(londonInstant("2026-07-01", "12:30")).toBe("2026-07-01T11:30:00.000Z"); // BST
    const a = renderCard({ brand: "B", hook: "H:", body: "Body text", footer: "F", link: URL, width: 400, height: 500 });
    expect(a.equals(renderCard({ brand: "B", hook: "H:", body: "Body text", footer: "F", link: URL, width: 400, height: 500 }))).toBe(true);
  });

  it("accepts a real screenshot (PNG or JPEG) and refuses other files", () => {
    const plan = setup();
    const [it] = enqueue(store, plan.id, NOW).added;
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x46, 0x04, 0x38, 0x03]), Buffer.alloc(20)]);
    const f = path.join(DIR, "shot.jpg"); fs.writeFileSync(f, jpg);
    expect(useScreenshot(store, it.id, f, NOW).media).toMatchObject({ source: "owner-screenshot", type: "jpeg", width: 1080, height: 1350 });
    const bad = path.join(DIR, "x.gif"); fs.writeFileSync(bad, "GIF89a....");
    expect(() => useScreenshot(store, it.id, bad, NOW)).toThrow(/only PNG or JPEG/);
  });
});

describe("runs: dry run by default; mocked publishing", () => {
  it("dry run sends nothing, even with --live, while adapters are unverified", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const r = await runQueue(store, at("2026-11-15T13:00:00Z"), { live: false });
    expect(r.outcomes[0].result).toMatch(/^DRY RUN: would publish day 2 to instagram \(card, 1080x1350\); not sent because: dry run \(no --live\); live publishing is off for instagram; not implemented/);
    const r2 = await runQueue(store, at("2026-11-15T13:00:00Z"), { live: true });
    expect(r2.outcomes[0].result).toMatch(/^DRY RUN: .*not implemented/);
    expect(queue(store).every((x) => x.status === "queued")).toBe(true);
    expect(fetches).toBe(0);
  });

  it("publishes a due item once with a verified (mock) adapter, records the URL in the plan and revenue tracking", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const m = mock(); goLive(m.adapters);
    expect((await runQueue(store, at("2026-11-15T12:00:00Z"), { live: true, adapters: m.adapters })).outcomes).toEqual([]); // not due yet
    const r = await runQueue(store, at("2026-11-15T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(r.outcomes).toEqual([{ item: expect.any(String), platform: "instagram", day: 2, result: "published: https://www.instagram.com/p/MOCK1/ (recorded in the audience plan)" }]);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ platform: "instagram", accountId: "17841400000000000", token: TOKEN, link: URL, media: { type: "png", width: 1080, height: 1350 } });
    expect(store.audiencePlans()[0].days[1].posted).toMatchObject({ url: "https://www.instagram.com/p/MOCK1/" });
    expect(channelPerformance(store).find((c) => c.channel === "instagram")?.posted).toBe(1);
    await runQueue(store, at("2026-11-15T15:00:00Z"), { live: true, adapters: m.adapters });
    expect(m.calls).toHaveLength(1); // no duplicate
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).toMatch(/social-publish-attempt[\s\S]*social-published/);
  });

  it("retries only clearly transient failures (with backoff, at most 3); ambiguous failures need a check and are never retried", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const m = mock([() => ({ kind: "retryable", error: "HTTP 429 rate limited" }), () => ({ kind: "retryable", error: "HTTP 429" }), () => ({ kind: "retryable", error: "HTTP 429" })]);
    goLive(m.adapters);
    let r = await runQueue(store, at("2026-11-15T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(r.outcomes[0].result).toMatch(/^retry later \(1\/3\) at 2026-11-15T12:46:00\.000Z/);
    expect((await runQueue(store, at("2026-11-15T12:40:00Z"), { live: true, adapters: m.adapters })).outcomes).toEqual([]); // backoff respected
    r = await runQueue(store, at("2026-11-15T12:47:00Z"), { live: true, adapters: m.adapters }); expect(r.outcomes[0].result).toMatch(/retry later \(2\/3\)/);
    r = await runQueue(store, at("2026-11-15T14:00:00Z"), { live: true, adapters: m.adapters }); expect(r.outcomes[0].result).toMatch(/^failed: HTTP 429/);
    expect(m.calls).toHaveLength(3);

    const m2 = mock([() => ({ kind: "ambiguous", error: `timeout after the publish request (token ${TOKEN})` })]);
    const r2 = await runQueue(store, at("2026-11-18T12:31:00Z"), { live: true, adapters: m2.adapters });
    expect(r2.outcomes[0].result).toMatch(/^needs-check: timeout after the publish request \(token \[token\]\) \(it may have been published/);
    await runQueue(store, at("2026-11-19T12:31:00Z"), { live: true, adapters: m2.adapters });
    expect(m2.calls).toHaveLength(1);
    const d = runDaily(store, DEFAULT_CONFIG, at("2026-11-19T12:40:00Z")).report;
    expect(d.problems.some((p) => p.priority === 1 && /needs-check.*it may have been published/.test(p.text))).toBe(true);
    expect(JSON.stringify(queue(store))).not.toContain(TOKEN);
  });

  it("cancels items whose approval changed, refuses changed media, respects the daily limit, STOP and expired tokens", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const m = mock(); goLive(m.adapters);
    // approval changed: tamper with day 2's approved hash
    const plans = store.audiencePlans(); store.saveAudiencePlans(plans.map((p) => ({ ...p, days: p.days.map((d) => (d.day === 2 ? { ...d, approval: { ...d.approval!, hash: "x" } } : d)) })));
    let r = await runQueue(store, at("2026-11-15T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(r.outcomes[0].result).toBe("cancelled: approval missing or content changed");
    // changed media
    const pin = queue(store).find((x) => x.platform === "pinterest")!;
    fs.chmodSync(pin.media.file, 0o600); fs.appendFileSync(pin.media.file, "x");
    r = await runQueue(store, at("2026-11-18T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(r.outcomes[0].result).toBe("failed: media file changed since it was queued");
    expect(m.calls).toEqual([]);
    // STOP
    stop(store.dir, "pause", NOW);
    r = await runQueue(store, at("2026-11-20T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(r.outcomes[0].result).toMatch(/STOP is set/);
    fs.unlinkSync(path.join(store.dir, "STOP"));
    // expired token
    connect(store, "instagram", { accountId: "1784", tokenFile: tokenFile(), expiresOn: "2026-11-19" }, NOW);
    r = await runQueue(store, at("2026-11-20T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(r.outcomes[0].result).toMatch(/the instagram token expired on 2026-11-19/);
    expect(m.calls).toEqual([]);
    expect(fetches).toBe(0);
  });

  it("CLI: queue, list, run (dry run), cancel", async () => {
    const plan = setup();
    expect(await cli("social", "queue", plan.id)).toBe(0); expect(out).toMatch(/^3 item\(s\) queued[\s\S]*Nothing was published\./);
    expect(await cli("social", "list")).toBe(0); expect(out.split("\n").filter(Boolean)).toHaveLength(3);
    expect(await cli("social", "run")).toBe(0); expect(out).toMatch(/^DRY RUN \(nothing is sent without --live\)\n  nothing due/);
    const id = queue(store)[0].id;
    expect(await cli("social", "cancel", id)).toBe(0); expect(queue(store)[0].status).toBe("cancelled");
    expect(await cli("social", "live", "pinterest", "on")).toBe(1);
    expect(out).toMatch(/^error: (turning live publishing on needs an interactive terminal|live publishing cannot be turned on: not implemented)/);
    expect(await cli("social", "live", "pinterest", "off")).toBe(0); expect(out).toBe("live publishing off for pinterest\n");
  });
});
