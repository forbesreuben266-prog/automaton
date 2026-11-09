import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../venture-engine/cli.js";
import { draftPack, generateMarketing, readPitch, SHORT_POST_MAX } from "../../venture-engine/marketing.js";
import { archiveProduct, buildProduct, misleadingClaims, type Product } from "../../venture-engine/products.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const NOW = new Date("2026-11-09T10:00:00Z");
let DIR = "";
let store: Store;
let realFetch: typeof fetch;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vm-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access in a test"); }) as typeof fetch; // proves no request is made
});
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

const venture = (id: string, title: string, problem: string): Venture => ({
  id, status: "built", experiments: [], decisions: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  opportunity: { id: `opp-${id.slice(4)}`, kind: "digital-product", title, problem, audience: "freelancers", offer: `A pack for ${problem}.`, estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: NOW.toISOString(), source: "fixture (test only)" },
});
const invoicing = () => { store.saveVentures([venture("ven-9e27315f", "Template pack: freelance invoicing for freelancers", "getting paid on time with clear terms")]); return buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" }); };
const dirOf = (p: Product) => path.join(store.dir, "ventures", p.ventureId, p.id);
const snapshot = (p: Product) => ({ files: fs.readdirSync(dirOf(p)).sort().map((n) => fs.readFileSync(path.join(dirOf(p), n), "utf8")).join("\n"), products: fs.readFileSync(path.join(store.dir, "products.json"), "utf8"), portfolio: fs.readFileSync(path.join(store.dir, "portfolio.json"), "utf8") });

describe("marketing pack: drafts from the product's own details", () => {
  it("writes 3 social posts, an email, a pitch and a 7-day plan, using only the product's landing-page content", () => {
    const p = invoicing();
    const before = snapshot(p);
    const m = generateMarketing(store, p.id, NOW);
    expect(m.id).toMatch(/^mkt-[0-9a-f]{8}$/);
    expect(m.files.map((f) => f.name)).toEqual(["social-posts.md", "email.md", "pitch.md", "seven-day-plan.md", "pack.json"]);
    for (const f of m.files) expect(fs.statSync(path.join(m.dir, f.name)).mode & 0o777).toBe(0o600);
    const read = (n: string) => fs.readFileSync(path.join(m.dir, n), "utf8");
    const posts = read("social-posts.md");
    expect(posts.match(/^## Post \d/gm)).toHaveLength(3);
    expect(posts).toContain("A complete invoicing routine for freelancers, ready in 20 minutes");
    expect(posts).toContain("£12");
    for (const s of posts.split(/^## Post \d \(short[^\n]*\n\n/m).slice(1)) expect(s.split("\n")[0].length).toBeLessThanOrEqual(SHORT_POST_MAX);
    expect(read("email.md")).toMatch(/\*\*Subject options\*\*[\s\S]*Hi \[\[first name\]\],[\s\S]*\[\[unsubscribe link\]\]/);
    expect(read("email.md")).toMatch(/Send only to people who agreed to hear from you/);
    expect(read("pitch.md")).toMatch(/\*\*One line:\*\* A complete invoicing routine/);
    expect(read("seven-day-plan.md").match(/^\| [1-7] \|/gm)).toHaveLength(7);
    expect(read("seven-day-plan.md")).toMatch(/no paid ads, no cold messages, nothing automated/);
    expect(JSON.parse(read("pack.json"))).toMatchObject({ pack: m.id, product: p.id, version: 1, status: "drafts only: nothing posted, sent or scheduled" });
    expect(snapshot(p)).toEqual(before); // product files and all records untouched
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).toMatch(/"kind":"marketing-pack"/);
  });

  it("invents nothing: no testimonials, customer or sales numbers, guarantees or links; carries the disclaimer for legal/tax topics", () => {
    const p = invoicing();
    const m = generateMarketing(store, p.id, NOW);
    for (const f of m.files.filter((x) => x.name.endsWith(".md"))) {
      const t = fs.readFileSync(path.join(m.dir, f.name), "utf8");
      expect(misleadingClaims(t), f.name).toEqual([]);
      expect(t, f.name).not.toMatch(/https?:\/\/|www\.|testimonial|\d[\d,]* (customers|users|freelancers|sales)|guarantee/i);
    }
    expect(fs.readFileSync(path.join(m.dir, "email.md"), "utf8")).toMatch(/not legal, tax or financial advice/);
  });

  it("each run makes a new pack; earlier packs are never overwritten", () => {
    const p = invoicing();
    const a = generateMarketing(store, p.id, NOW);
    const first = fs.readFileSync(path.join(a.dir, "email.md"), "utf8");
    const b = generateMarketing(store, p.id, NOW);
    expect(b.id).not.toBe(a.id);
    expect(fs.readFileSync(path.join(a.dir, "email.md"), "utf8")).toBe(first);
  });
});

describe("marketing pack: refusals", () => {
  it("refuses unknown, unchecked, archived or edited products and drafts that would contain a misleading claim", () => {
    expect(() => generateMarketing(store, "prd-00000000", NOW)).toThrow(/no product/);
    const p = invoicing();
    store.saveProducts(store.products().map((x) => ({ ...x, status: "needs-work" as const })));
    expect(() => generateMarketing(store, p.id, NOW)).toThrow(/is needs-work/);
    store.saveProducts(store.products().map((x) => ({ ...x, status: "ready" as const })));
    const f = path.join(dirOf(p), "landing.html");
    const original = fs.readFileSync(f, "utf8");
    fs.chmodSync(f, 0o600);
    fs.writeFileSync(f, original.replace(/<h1>[^<]*<\/h1>/, "<h1>Guaranteed payment for every invoice</h1>"));
    expect(() => generateMarketing(store, p.id, NOW)).toThrow(/landing\.html changed since the build/);
    fs.writeFileSync(f, original);
    archiveProduct(store, p.id, "superseded", NOW);
    expect(() => generateMarketing(store, p.id, NOW)).toThrow(/is archived/);
    expect(fs.readdirSync(path.join(store.dir, "ventures", p.ventureId)).filter((n) => n.startsWith("mkt-"))).toEqual([]);
    // the claim check itself: a pitch that says "guaranteed" is never drafted
    const pitch = { ...readPitch(original), headline: "We guarantee you will be paid on time" };
    expect(draftPack({ name: "x", review: [] }, pitch).flatMap((d) => misleadingClaims(d.text))).toContain("guaranteed outcome");
  });

  it("readPitch refuses a landing page without the required details", () => {
    expect(() => readPitch("<html><body><h1>T</h1></body></html>")).toThrow(/no offer/);
  });
});

describe("CLI", () => {
  it("product marketing <id> saves the pack and says nothing was posted or sent", async () => {
    const p = invoicing();
    let out = "";
    const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null }); };
    expect(await cli("product", "marketing", p.id)).toBe(0);
    expect(out).toMatch(/^marketing pack mkt-[0-9a-f]{8} for prd-[0-9a-f]{8} \(drafts only: nothing posted, sent or scheduled\)\n/);
    expect(out).toMatch(/social-posts\.md[\s\S]*seven-day-plan\.md/);
    expect(await cli("product", "marketing")).toBe(1); expect(out).toMatch(/product marketing <product>/);
    expect(fs.existsSync(path.join(store.dir, "run.lock"))).toBe(false);
  });
});
