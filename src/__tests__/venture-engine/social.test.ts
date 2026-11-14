import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveDay, createPlan, type AudiencePlan } from "../../venture-engine/audience.js";
import { createCampaign } from "../../venture-engine/campaign.js";
import { main } from "../../venture-engine/cli.js";
import { DEFAULT_CONFIG, stop } from "../../venture-engine/control.js";
import { decideApproval } from "../../venture-engine/engine.js";
import { cardCanvas, renderCard } from "../../venture-engine/graphics.js";
import { encodeJpeg } from "../../venture-engine/jpeg.js";
import { runDaily, setBlocker } from "../../venture-engine/operations.js";
import { buildProduct, confirmationCode, markLive, requestLaunch, signOff } from "../../venture-engine/products.js";
import { imageInfo } from "../../venture-engine/raster.js";
import { channelPerformance } from "../../venture-engine/revenue.js";
import { instagramAdapter, pinterestAdapter } from "../../venture-engine/social-adapters.js";
import { checkUrl, type Http, type HttpRequest } from "../../venture-engine/social-http.js";
import { cancel, connect, connection, enqueue, londonInstant, queue, realAdapters, refreshConnection, runQueue, setLive, useScreenshot, type Adapters, type Platform, type PublishAdapter, type PublishRequest, type PublishResult } from "../../venture-engine/social.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const T0 = new Date("2026-11-09T10:00:00Z");
const NOW = new Date("2026-11-14T09:00:00Z");
const URL = "https://payhip.com/b/t1JqT";
const MEDIA = "https://media.example.org/avenor/";
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
const file = (name: string, text: string) => { const f = path.join(DIR, name); fs.writeFileSync(f, `${text}\n`, { mode: 0o600 }); return f; };
const tokenFile = () => file("token.txt", TOKEN);
function mock(answers: ((req: PublishRequest) => PublishResult)[] = []) {
  const calls: PublishRequest[] = [];
  const make = (platform: Platform): PublishAdapter => ({ platform, verified: true, note: "mock (tests only)", async validate() { return { ok: true, detail: "mock" }; },
    async publish(req) { calls.push(req); const a = answers.shift(); return a ? a(req) : { kind: "published", externalId: `${platform}-${calls.length}`, url: platform === "instagram" ? `https://www.instagram.com/p/MOCK${calls.length}/` : null }; } });
  return { calls, adapters: { instagram: make("instagram"), pinterest: make("pinterest") } as Adapters };
}
const goLive = (adapters: Adapters) => { connect(store, "instagram", { accountId: "17841400000000000", tokenFile: tokenFile(), mediaBaseUrl: MEDIA }, NOW); connect(store, "pinterest", { accountId: "board-123", tokenFile: tokenFile() }, NOW); setLive(store, "instagram", true, { interactive: true, adapters }, NOW); setLive(store, "pinterest", true, { interactive: true, adapters }, NOW); };
const at = (iso: string) => new Date(iso);
let out = "";
const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null }); };

/** A scripted HTTP layer: answers by "METHOD url-prefix"; records every request. */
function fakeHttp(routes: [string, (r: HttpRequest) => { status: number; body: unknown } | Error][]) {
  const seen: HttpRequest[] = [];
  const http: Http = async (r) => {
    seen.push(r);
    const m = routes.find(([k]) => `${r.method} ${r.url}`.startsWith(k));
    if (!m) throw new Error(`unexpected request ${r.method} ${r.url}`);
    const a = m[1](r);
    if (a instanceof Error) throw a;
    return { status: a.status, body: Buffer.isBuffer(a.body) ? a.body : Buffer.from(typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
  };
  return { http, seen };
}
const IG = "https://graph.instagram.com/v27.0";
const jpeg = () => { const c = encodeJpeg(cardCanvas({ brand: "B", hook: "H:", body: "Body", footer: "F", link: URL, width: 1080, height: 1350 })); const f = path.join(DIR, "card.jpg"); fs.writeFileSync(f, c); return { file: f, buf: c, sha256: createHash("sha256").update(c).digest("hex") }; };
const igReq = (j: ReturnType<typeof jpeg>): PublishRequest => ({ platform: "instagram", accountId: "1784", token: TOKEN, caption: "Caption", title: null, altText: "Alt", link: URL, publicUrl: `${MEDIA}card.jpg`, media: { file: j.file, type: "jpeg", sha256: j.sha256, width: 1080, height: 1350 } });

describe("connections: OAuth token from a file, private, never shown", () => {
  it("stores the token with mode 600, prints only a fingerprint, refuses non-token content and non-https media hosts", async () => {
    expect(await cli("social", "connect", "instagram", "--account", "17841400000000000", "--token-file", tokenFile(), "--media-base-url", MEDIA)).toBe(0);
    expect(out).toMatch(/instagram connected: account 17841400000000000, token fingerprint [0-9a-f]{12}\. Live publishing stays off/);
    expect(out).not.toContain(TOKEN);
    expect(fs.statSync(path.join(store.dir, "social", "instagram.json")).mode & 0o777).toBe(0o600);
    expect(await cli("social", "connect", "pinterest", "--account", "b1", "--token-file", file("pw.txt", "my password 123"))).toBe(1); expect(out).toMatch(/Passwords are never accepted/);
    expect(await cli("social", "connect", "instagram", "--account", "1", "--token-file", tokenFile(), "--media-base-url", "http://media.example.org/")).toBe(1);
    expect(await cli("social", "status")).toBe(0);
    expect(out).toMatch(/Instagram: connected \(account 17841400000000000, token fingerprint [0-9a-f]{12}, expiry not given, media URL https:\/\/media\.example\.org\/avenor\/\); live publishing off; adapter Instagram API with Instagram Login/);
    expect(out).toMatch(/Pinterest: not connected/);
    expect(out + fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).not.toContain(TOKEN);
  });

  it("live mode needs a terminal, a connection and (Instagram) a public media URL; it is off by default", () => {
    const adapters = realAdapters(store);
    expect(() => setLive(store, "instagram", true, { interactive: true, adapters }, NOW)).toThrow(/not connected/);
    connect(store, "instagram", { accountId: "1784", tokenFile: tokenFile() }, NOW);
    expect(() => setLive(store, "instagram", true, { interactive: true, adapters }, NOW)).toThrow(/needs --media-base-url/);
    expect(() => setLive(store, "instagram", true, { interactive: false, adapters }, NOW)).toThrow(/interactive terminal/);
    expect(realAdapters(store).instagram.verified).toBe(true);
    expect(fetches).toBe(0);
  });

  it("refreshes tokens with the documented calls (mocked); the new token replaces the old one and is never shown", async () => {
    connect(store, "instagram", { accountId: "1784", tokenFile: tokenFile(), mediaBaseUrl: MEDIA }, NOW);
    const ig = fakeHttp([["GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=", () => ({ status: 200, body: { access_token: "IGQVJnew-token-zyxwvutsrqponmlkjihgfedcba987654321", token_type: "bearer", expires_in: 5183944 } })]]);
    await expect(refreshConnection(store, "instagram", NOW, ig.http)).rejects.toThrow(/at least 24 hours old/);
    const c = await refreshConnection(store, "instagram", at("2026-11-16T09:00:00Z"), ig.http);
    expect(c).toMatchObject({ expiresOn: "2027-01-15" });
    expect(JSON.stringify(c)).not.toContain("IGQVJnew");
    expect(connection(store, "instagram")!.token).toBe("IGQVJnew-token-zyxwvutsrqponmlkjihgfedcba987654321");
    connect(store, "pinterest", { accountId: "b1", tokenFile: file("p.txt", "pina_access_token_0123456789abcdef"), refreshFile: file("r.txt", "pinr_refresh_token_0123456789abcdef"), clientFile: file("c.txt", "1234567:secretABC") }, NOW);
    const pin = fakeHttp([["POST https://api.pinterest.com/v5/oauth/token", () => ({ status: 200, body: { access_token: "pina_new_access_0123456789abcdef", refresh_token: "pinr_new_refresh_0123456789abcdef", expires_in: 2592000 } })]]);
    await refreshConnection(store, "pinterest", NOW, pin.http);
    expect(pin.seen[0].headers).toMatchObject({ Authorization: `Basic ${Buffer.from("1234567:secretABC").toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" });
    expect(pin.seen[0].body).toBe("grant_type=refresh_token&refresh_token=pinr_refresh_token_0123456789abcdef");
    expect(connection(store, "pinterest")).toMatchObject({ token: "pina_new_access_0123456789abcdef", refreshToken: "pinr_new_refresh_0123456789abcdef", expiresOn: "2026-12-14" });
    expect(() => checkUrl("https://evil.example.com/x")).toThrow(/host not allowed/);
    expect(() => checkUrl("https://user:pw@graph.instagram.com/x")).toThrow(/plain https/);
  });
});

describe("queue: approved content only, one item per day, platform formats", () => {
  it("queues approved days: Instagram JPEG 1080x1350, Pinterest PNG 1000x1500, at 12:30 UK time; reruns add nothing", () => {
    const plan = setup();
    const r = enqueue(store, plan.id, NOW);
    expect(r.added.map((x) => `${x.day}:${x.platform}:${x.media.type}:${x.scheduledAt}`)).toEqual(["2:instagram:jpeg:2026-11-15T12:30:00.000Z", "5:pinterest:png:2026-11-18T12:30:00.000Z", "7:instagram:jpeg:2026-11-20T12:30:00.000Z"]);
    expect(r.skipped.join(" ")).toMatch(/day 10: not approved/);
    const [ig, pin] = r.added;
    expect(ig.caption).toMatch(/^.+\n\n.*Link in bio\.\n#freelancer/); expect(ig.caption).not.toMatch(/CAROUSEL BRIEF|BIO LINK/);
    expect(pin.title!.length).toBeLessThanOrEqual(100); expect(pin.caption).not.toMatch(/IMAGE BRIEF|LINK:/);
    expect(imageInfo(fs.readFileSync(ig.media.file))).toEqual({ type: "jpeg", width: 1080, height: 1350 });
    expect(imageInfo(fs.readFileSync(pin.media.file))).toEqual({ type: "png", width: 1000, height: 1500 });
    expect(ig.media.sha256).toBe(createHash("sha256").update(fs.readFileSync(ig.media.file)).digest("hex"));
    expect(enqueue(store, plan.id, NOW).added).toEqual([]);
    expect(londonInstant("2026-07-01", "12:30")).toBe("2026-07-01T11:30:00.000Z");
    const a = renderCard({ brand: "B", hook: "H:", body: "Body text", footer: "F", link: URL, width: 400, height: 500 });
    expect(a.equals(renderCard({ brand: "B", hook: "H:", body: "Body text", footer: "F", link: URL, width: 400, height: 500 }))).toBe(true);
  });

  it("screenshots: Instagram needs JPEG within 4:5..1.91:1 and 320-1440 wide; Pinterest takes PNG or JPEG", () => {
    const plan = setup();
    const [ig, pin] = enqueue(store, plan.id, NOW).added;
    const j = (w: number, h: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]), Buffer.alloc(20)]);
    const f = path.join(DIR, "shot.jpg"); fs.writeFileSync(f, j(1080, 1350));
    expect(useScreenshot(store, ig.id, f, NOW).media).toMatchObject({ source: "owner-screenshot", type: "jpeg", width: 1080, height: 1350 });
    const tall = path.join(DIR, "tall.jpg"); fs.writeFileSync(tall, j(1080, 1920));
    expect(() => useScreenshot(store, ig.id, tall, NOW)).toThrow(/aspect ratio between 4:5 and 1\.91:1/);
    const png = path.join(DIR, "s.png"); fs.writeFileSync(png, renderCard({ brand: "B", hook: "H:", body: "x", footer: "F", link: URL, width: 1000, height: 1500 }));
    expect(() => useScreenshot(store, ig.id, png, NOW)).toThrow(/JPEG images only/);
    expect(useScreenshot(store, pin.id, png, NOW).media.type).toBe("png");
  });
});

describe("Instagram adapter (official flow, mocked HTTP)", () => {
  const happy = (j: ReturnType<typeof jpeg>, publish: (r: HttpRequest) => { status: number; body: unknown } | Error = () => ({ status: 200, body: { id: "MEDIA1" } }), status = "FINISHED") => fakeHttp([
    [`GET ${IG}/1784/content_publishing_limit?fields=quota_usage,config&access_token=`, () => ({ status: 200, body: { data: [{ quota_usage: 2, config: { quota_total: 50, quota_duration: 86400 } }] } })],
    [`GET ${MEDIA}card.jpg`, () => ({ status: 200, body: j.buf })],
    [`POST ${IG}/1784/media_publish`, publish],
    [`POST ${IG}/1784/media`, () => ({ status: 200, body: { id: "CONT1" } })],
    [`GET ${IG}/CONT1?fields=status_code`, () => ({ status: 200, body: { status_code: status, id: "CONT1" } })],
    [`GET ${IG}/MEDIA1?fields=permalink`, () => ({ status: 200, body: { permalink: "https://www.instagram.com/p/ABC123/", id: "MEDIA1" } })],
  ]);
  it("quota -> public file check -> container -> FINISHED -> media_publish -> permalink", async () => {
    const j = jpeg(), h = happy(j);
    const r = await instagramAdapter({ http: h.http, sleep: async () => {} }).publish(igReq(j));
    expect(r).toEqual({ kind: "published", externalId: "MEDIA1", url: "https://www.instagram.com/p/ABC123/" });
    expect(h.seen.map((x) => `${x.method} ${x.url.split("?")[0]}`)).toEqual([`GET ${IG}/1784/content_publishing_limit`, `GET ${MEDIA}card.jpg`, `POST ${IG}/1784/media`, `GET ${IG}/CONT1`, `POST ${IG}/1784/media_publish`, `GET ${IG}/MEDIA1`]);
    expect(JSON.parse(h.seen[2].body!)).toEqual({ image_url: `${MEDIA}card.jpg`, caption: "Caption", alt_text: "Alt" });
    expect(h.seen[2].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(h.seen[4].body!)).toEqual({ creation_id: "CONT1" });
  });
  it("classifies failures so nothing is double-posted", async () => {
    const j = jpeg();
    const ad = (h: ReturnType<typeof fakeHttp>) => instagramAdapter({ http: h.http, sleep: async () => {}, pollAttempts: 2 }).publish(igReq(j));
    const wrong = fakeHttp([[`GET ${IG}/1784/content_publishing_limit`, () => ({ status: 200, body: { data: [{ quota_usage: 0, config: { quota_total: 50 } }] } })], [`GET ${MEDIA}card.jpg`, () => ({ status: 200, body: "other" })]]);
    expect(await ad(wrong)).toMatchObject({ kind: "failed", error: expect.stringMatching(/not the queued image/) });
    expect(wrong.seen.some((r) => r.method === "POST")).toBe(false);
    const full = fakeHttp([[`GET ${IG}/1784/content_publishing_limit`, () => ({ status: 200, body: { data: [{ quota_usage: 50, config: { quota_total: 50 } }] } })]]);
    expect(await ad(full)).toMatchObject({ kind: "retryable", error: expect.stringMatching(/quota reached \(50\/50/) });
    const bad = fakeHttp([[`GET ${IG}/1784/content_publishing_limit`, () => ({ status: 400, body: { error: { message: "Error validating access token", code: 190 } } })]]);
    expect(await ad(bad)).toMatchObject({ kind: "failed", error: expect.stringMatching(/token is invalid or expired/) });
    expect(await ad(happy(j, () => ({ status: 400, body: { error: { message: "The media is not ready", code: 9007, error_subcode: 2207027 } } })))).toMatchObject({ kind: "retryable" });
    expect(await ad(happy(j, () => ({ status: 400, body: { error: { message: "restricted", code: 25, error_subcode: 2207050 } } })))).toMatchObject({ kind: "failed" });
    expect(await ad(happy(j, () => new Error("socket hang up")))).toMatchObject({ kind: "retryable", error: expect.stringMatching(/still FINISHED/) });
    let n = 0;
    const h = happy(j, () => new Error("timeout"));
    const combined: Http = async (r) => (r.url.startsWith(`${IG}/CONT1?fields=status_code`) ? { status: 200, body: Buffer.from(JSON.stringify({ status_code: n++ === 0 ? "FINISHED" : "PUBLISHED" })) } : h.http(r));
    expect(await instagramAdapter({ http: combined, sleep: async () => {} }).publish(igReq(j))).toMatchObject({ kind: "ambiguous", error: expect.stringMatching(/PUBLISHED: the post is probably live/) });
    expect(await ad(happy(j, undefined, "ERROR"))).toMatchObject({ kind: "failed" });
    expect(await ad(happy(j, undefined, "IN_PROGRESS"))).toMatchObject({ kind: "retryable", error: expect.stringMatching(/not ready/) });
    const none = fakeHttp([]);
    expect(await instagramAdapter({ http: none.http }).publish({ ...igReq(j), media: { ...igReq(j).media, type: "png" } })).toMatchObject({ kind: "failed", error: "Instagram accepts JPEG images only" });
    expect(none.seen).toEqual([]);
  });
  it("validate checks the token's account with /me", async () => {
    const h = fakeHttp([[`GET ${IG}/me?fields=user_id,username&access_token=`, () => ({ status: 200, body: { data: [{ user_id: "1784", username: "avenorstudio" }] } })]]);
    expect(await instagramAdapter({ http: h.http }).validate("1784", TOKEN)).toEqual({ ok: true, detail: "token works for @avenorstudio (1784)" });
    expect((await instagramAdapter({ http: h.http }).validate("999", TOKEN)).ok).toBe(false);
  });
});

describe("Pinterest adapter (official API v5, mocked HTTP)", () => {
  const req = (): PublishRequest => { const f = path.join(DIR, "pin.png"); fs.writeFileSync(f, renderCard({ brand: "B", hook: "H:", body: "x", footer: "F", link: URL, width: 1000, height: 1500 })); return { platform: "pinterest", accountId: "board-123", token: "pina_x", caption: "Description", title: "Title", altText: "Alt", link: URL, publicUrl: null, media: { file: f, type: "png", sha256: "x", width: 1000, height: 1500 } }; };
  it("creates the Pin with the image as base64 on the board; sandbox uses the sandbox host", async () => {
    const h = fakeHttp([["POST https://api.pinterest.com/v5/pins", () => ({ status: 201, body: { id: "987654321", board_id: "board-123" } })]]);
    expect(await pinterestAdapter({ http: h.http, environment: "production" }).publish(req())).toEqual({ kind: "published", externalId: "987654321", url: null });
    const body = JSON.parse(h.seen[0].body!);
    expect(body).toMatchObject({ board_id: "board-123", title: "Title", description: "Description", link: URL, alt_text: "Alt", media_source: { source_type: "image_base64", content_type: "image/png" } });
    expect(Buffer.from(body.media_source.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(h.seen[0].headers).toMatchObject({ Authorization: "Bearer pina_x" });
    const s = fakeHttp([["POST https://api-sandbox.pinterest.com/v5/pins", () => ({ status: 201, body: { id: "1" } })]]);
    expect((await pinterestAdapter({ http: s.http, environment: "sandbox" }).publish(req())).kind).toBe("published");
  });
  it("429 retryable, 401 failed, 5xx or no answer ambiguous; limits checked before sending", async () => {
    const one = (status: number, body: unknown = { code: 1, message: "x" }) => fakeHttp([["POST https://api.pinterest.com/v5/pins", () => ({ status, body })]]);
    expect((await pinterestAdapter({ http: one(429).http, environment: "production" }).publish(req())).kind).toBe("retryable");
    expect(await pinterestAdapter({ http: one(401, { code: 2, message: "Authentication failed." }).http, environment: "production" }).publish(req())).toMatchObject({ kind: "failed", error: expect.stringMatching(/token is invalid or expired/) });
    expect((await pinterestAdapter({ http: one(503).http, environment: "production" }).publish(req())).kind).toBe("ambiguous");
    const down = fakeHttp([["POST https://api.pinterest.com/v5/pins", () => new Error("ECONNRESET")]]);
    expect((await pinterestAdapter({ http: down.http, environment: "production" }).publish(req())).kind).toBe("ambiguous");
    const none = fakeHttp([]);
    expect(await pinterestAdapter({ http: none.http, environment: "production" }).publish({ ...req(), title: "x".repeat(101) })).toMatchObject({ kind: "failed" });
    expect(none.seen).toEqual([]);
  });
});

describe("runs: dry run by default; mocked publishing through the queue", () => {
  it("dry run sends nothing; --live without live mode sends nothing", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const m = mock();
    const r = await runQueue(store, at("2026-11-15T13:00:00Z"), { live: false, adapters: m.adapters });
    expect(r.outcomes[0].result).toMatch(/^DRY RUN: would publish day 2 to instagram \(card, 1080x1350\); not sent because: dry run \(no --live\); live publishing is off for instagram; instagram is not connected/);
    expect((await runQueue(store, at("2026-11-15T13:00:00Z"), { live: true, adapters: m.adapters })).outcomes[0].result).toMatch(/^DRY RUN: .*live publishing is off/);
    expect(m.calls).toEqual([]);
    expect(queue(store).every((x) => x.status === "queued")).toBe(true);
    expect(fetches).toBe(0);
  });

  it("publishes a due item once, gives the public media URL, records the link in the plan and revenue tracking", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const m = mock(); goLive(m.adapters);
    expect((await runQueue(store, at("2026-11-15T12:00:00Z"), { live: true, adapters: m.adapters })).outcomes).toEqual([]);
    const r = await runQueue(store, at("2026-11-15T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(r.outcomes[0].result).toBe("published: https://www.instagram.com/p/MOCK1/ (recorded in the audience plan)");
    expect(m.calls[0]).toMatchObject({ platform: "instagram", accountId: "17841400000000000", token: TOKEN, link: URL, publicUrl: `${MEDIA}${path.basename(queue(store)[0].media.file)}`, media: { type: "jpeg" } });
    expect(store.audiencePlans()[0].days[1].posted).toMatchObject({ url: "https://www.instagram.com/p/MOCK1/" });
    expect(channelPerformance(store).find((c) => c.channel === "instagram")?.posted).toBe(1);
    await runQueue(store, at("2026-11-15T15:00:00Z"), { live: true, adapters: m.adapters });
    expect(m.calls).toHaveLength(1);
    const p = await runQueue(store, at("2026-11-18T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(p.outcomes[0].result).toMatch(/^published as pinterest-2; the platform gave no link: open it and run 'audience posted .* --day 5 --url <link>'/);
    const d = runDaily(store, DEFAULT_CONFIG, at("2026-11-18T13:00:00Z")).report;
    expect(d.actions.some((a) => a.priority === 1 && /pinterest post pinterest-2 was published but its link is not recorded/.test(a.text))).toBe(true);
  });

  it("retries only transient failures (3 attempts with back-off); ambiguous ones need a check and are never retried", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const m = mock([() => ({ kind: "retryable", error: "HTTP 429" }), () => ({ kind: "retryable", error: "HTTP 429" }), () => ({ kind: "retryable", error: "HTTP 429" })]);
    goLive(m.adapters);
    let r = await runQueue(store, at("2026-11-15T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(r.outcomes[0].result).toMatch(/^retry later \(1\/3\) at 2026-11-15T12:46:00\.000Z/);
    expect((await runQueue(store, at("2026-11-15T12:40:00Z"), { live: true, adapters: m.adapters })).outcomes).toEqual([]);
    r = await runQueue(store, at("2026-11-15T12:47:00Z"), { live: true, adapters: m.adapters }); expect(r.outcomes[0].result).toMatch(/retry later \(2\/3\)/);
    r = await runQueue(store, at("2026-11-15T14:00:00Z"), { live: true, adapters: m.adapters }); expect(r.outcomes[0].result).toMatch(/^failed: HTTP 429/);
    const m2 = mock([() => ({ kind: "ambiguous", error: `timeout after the publish request (token ${TOKEN})` })]);
    const r2 = await runQueue(store, at("2026-11-18T12:31:00Z"), { live: true, adapters: m2.adapters });
    expect(r2.outcomes[0].result).toMatch(/^needs-check: timeout after the publish request \(token \[token\]\) \(it may have been published/);
    await runQueue(store, at("2026-11-19T12:31:00Z"), { live: true, adapters: m2.adapters });
    expect(m2.calls).toHaveLength(1);
    expect(runDaily(store, DEFAULT_CONFIG, at("2026-11-19T12:40:00Z")).report.problems.some((p) => p.priority === 1 && /needs-check/.test(p.text))).toBe(true);
    expect(JSON.stringify(queue(store))).not.toContain(TOKEN);
  });

  it("stops before sending on changed approval, changed media, STOP, expired token", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const m = mock(); goLive(m.adapters);
    store.saveAudiencePlans(store.audiencePlans().map((p) => ({ ...p, days: p.days.map((d) => (d.day === 2 ? { ...d, approval: { ...d.approval!, hash: "x" } } : d)) })));
    expect((await runQueue(store, at("2026-11-15T12:31:00Z"), { live: true, adapters: m.adapters })).outcomes[0].result).toBe("cancelled: approval missing or content changed");
    const pin = queue(store).find((x) => x.platform === "pinterest")!;
    fs.chmodSync(pin.media.file, 0o600); fs.appendFileSync(pin.media.file, "x");
    expect((await runQueue(store, at("2026-11-18T12:31:00Z"), { live: true, adapters: m.adapters })).outcomes[0].result).toBe("failed: media file changed since it was queued");
    stop(store.dir, "pause", NOW);
    expect((await runQueue(store, at("2026-11-20T12:31:00Z"), { live: true, adapters: m.adapters })).outcomes[0].result).toMatch(/STOP is set/);
    fs.unlinkSync(path.join(store.dir, "STOP"));
    connect(store, "instagram", { accountId: "1784", tokenFile: tokenFile(), expiresOn: "2026-11-19", mediaBaseUrl: MEDIA }, NOW);
    expect((await runQueue(store, at("2026-11-20T12:31:00Z"), { live: true, adapters: m.adapters })).outcomes[0].result).toMatch(/the instagram token expired on 2026-11-19/);
    expect(m.calls).toEqual([]);
    expect(fetches).toBe(0);
  });

  it("CLI: queue, list (with upload hint), run (dry run), cancel, live refusal without a terminal", async () => {
    const plan = setup();
    expect(await cli("social", "queue", plan.id)).toBe(0); expect(out).toMatch(/^3 item\(s\) queued[\s\S]*Nothing was published\./);
    expect(await cli("social", "list")).toBe(0); expect(out).toMatch(/upload .*\.jpg so that it is public at <your --media-base-url>\/soc-[0-9a-f]{8}\.jpg/);
    expect(await cli("social", "run")).toBe(0); expect(out).toMatch(/^DRY RUN \(nothing is sent without --live\)\n  nothing due/);
    expect(await cli("social", "cancel", queue(store)[0].id)).toBe(0); expect(queue(store)[0].status).toBe("cancelled");
    expect(await cli("social", "live", "pinterest", "on")).toBe(1); expect(out).toMatch(/^error: turning live publishing on needs an interactive terminal/);
    expect(await cli("social", "live", "pinterest", "off")).toBe(0); expect(out).toBe("live publishing off for pinterest\n");
    expect(fetches).toBe(0);
  });
});

describe("crash safety: durable 'publishing' state, restart recovery, never resent", () => {
  const qfile = () => path.join(store.dir, "social", "queue.json");
  it("the item is durably 'publishing' on disk before the external request is made", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const seenOnDisk: string[] = [];
    const m = mock([(req) => { seenOnDisk.push(JSON.parse(fs.readFileSync(qfile(), "utf8")).find((x: { day: number }) => x.day === 2).status); return { kind: "published", externalId: "M1", url: "https://www.instagram.com/p/M1/" }; }]);
    goLive(m.adapters);
    await runQueue(store, at("2026-11-15T12:31:00Z"), { live: true, adapters: m.adapters });
    expect(seenOnDisk).toEqual(["publishing"]);
    expect(queue(store).find((x) => x.day === 2)!.status).toBe("published");
  });

  it("a crash during the request leaves 'publishing'; the next run marks it needs-check and never resends it", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    let atCrash = "";
    const m = mock([() => { atCrash = fs.readFileSync(qfile(), "utf8"); return { kind: "published", externalId: "M1", url: "https://www.instagram.com/p/M1/" }; }]);
    goLive(m.adapters);
    await runQueue(store, at("2026-11-15T12:31:00Z"), { live: true, adapters: m.adapters });
    // Simulate the process dying mid-request: the result was never recorded, only the pre-request state survived.
    fs.writeFileSync(qfile(), atCrash);
    expect(queue(store).find((x) => x.day === 2)!.status).toBe("publishing");
    const before = runDaily(store, DEFAULT_CONFIG, at("2026-11-15T12:40:00Z")).report;
    expect(before.problems.some((p) => p.priority === 1 && /interrupted while publishing: it may be live; it will become needs-check and is never resent/.test(p.text))).toBe(true);
    expect(() => cancel(store, queue(store).find((x) => x.day === 2)!.id, NOW)).toThrow(/was being published when Automaton stopped/);
    const m2 = mock();
    const r = await runQueue(store, at("2026-11-15T13:00:00Z"), { live: true, adapters: m2.adapters });
    expect(r.outcomes[0].result).toBe("needs-check: interrupted while publishing in an earlier run (it may be live: check the account; it will not be resent)");
    expect(m2.calls).toEqual([]);
    const it = queue(store).find((x) => x.day === 2)!;
    expect(it).toMatchObject({ status: "needs-check", lastError: expect.stringMatching(/interrupted while publishing/) });
    // later runs leave it alone; re-queueing the same day is refused while it is needs-check
    await runQueue(store, at("2026-11-16T13:00:00Z"), { live: true, adapters: m2.adapters });
    expect(m2.calls).toEqual([]);
    expect(enqueue(store, plan.id, at("2026-11-16T13:00:00Z")).skipped.join(" ")).toMatch(/day 2: already queued/);
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).toMatch(/"kind":"social-needs-check".*interrupted while publishing/);
  });

  it("recovery also happens while STOP is set (a local state change only; nothing is sent)", async () => {
    const plan = setup(); enqueue(store, plan.id, NOW);
    const q = queue(store); fs.writeFileSync(qfile(), JSON.stringify(q.map((x) => (x.day === 2 ? { ...x, status: "publishing" } : x))));
    stop(store.dir, "pause", NOW);
    const m = mock();
    const r = await runQueue(store, at("2026-11-15T13:00:00Z"), { live: true, adapters: m.adapters });
    expect(r.outcomes.map((o) => o.result)).toEqual([expect.stringMatching(/^needs-check: interrupted/), expect.stringMatching(/STOP is set/)]);
    expect(m.calls).toEqual([]);
    expect(queue(store).find((x) => x.day === 2)!.status).toBe("needs-check");
  });
});

describe("backup privacy", () => {
  it("the daily report flags backups that other users can read, and is quiet once they are private", () => {
    const b = path.join(DIR, "automaton-backups"); fs.mkdirSync(b, { mode: 0o755 }); fs.chmodSync(b, 0o755);
    fs.writeFileSync(path.join(b, "ventures-20261114T090000.tgz"), "x", { mode: 0o644 }); fs.chmodSync(path.join(b, "ventures-20261114T090000.tgz"), 0o644);
    let d = runDaily(store, DEFAULT_CONFIG, NOW).report;
    expect(d.problems.find((p) => p.ref === "backups")).toMatchObject({ priority: 1, text: expect.stringMatching(/^2 backup item\(s\) can be read by other users/), command: "chmod 700 ~/automaton-backups && chmod 600 ~/automaton-backups/*" });
    fs.chmodSync(b, 0o700); fs.chmodSync(path.join(b, "ventures-20261114T090000.tgz"), 0o600);
    d = runDaily(store, DEFAULT_CONFIG, NOW).report;
    expect(d.problems.some((p) => p.ref === "backups")).toBe(false);
  });
});

