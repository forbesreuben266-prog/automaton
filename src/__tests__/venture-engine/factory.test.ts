import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { concept, CONCEPTS, EXTRA_CONCEPTS } from "../../venture-engine/blueprints/toolkit.js";
import { createCampaign, decidePost } from "../../venture-engine/campaign.js";
import { main } from "../../venture-engine/cli.js";
import { DEFAULT_CONFIG, stop, type EngineConfig } from "../../venture-engine/control.js";
import { decideApproval, runEngine } from "../../venture-engine/engine.js";
import { runFactory, scoreConcepts, WEIGHTS } from "../../venture-engine/factory.js";
import { KINDS } from "../../venture-engine/cli.js";
import { runDaily } from "../../venture-engine/operations.js";
import { buildProduct, confirmationCode, generateVersion, markLive, misleadingClaims, qaGenerated, requestLaunch, signOff, type Product } from "../../venture-engine/products.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const T0 = new Date("2026-11-09T10:00:00Z");
const NOW = new Date("2026-11-10T09:00:00Z");
const NEXT_DAY = new Date("2026-11-11T09:00:00Z");
const URL = "https://payhip.com/b/t1JqT";
let DIR = "";
let store: Store;
let realFetch: typeof fetch;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vf-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access in a test"); }) as typeof fetch; // offline mode may never reach the network
  EXTRA_CONCEPTS.length = 0;
});
afterEach(() => { globalThis.fetch = realFetch; EXTRA_CONCEPTS.length = 0; fs.rmSync(DIR, { recursive: true, force: true }); });

const invoicingVenture: Venture = { id: "ven-9e27315f", status: "built", experiments: [], decisions: [], createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
  opportunity: { id: "opp-00000001", kind: "digital-product", title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms", audience: "freelancers", offer: "A template pack.", estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: T0.toISOString(), source: "fixture (test only)" } };
/** The owner's real situation: the invoicing kit is live and its campaign has approved Facebook posts. */
const liveInvoicing = () => {
  store.saveVentures([invoicingVenture]);
  let p: Product = buildProduct(store, invoicingVenture.id, { now: T0, currency: "GBP", price: 12 });
  p = signOff(store, p.id, { confirm: confirmationCode(p), price: "GBP 12", note: "checked", interactive: true }, T0);
  decideApproval(store, requestLaunch(store, p.id, T0).id, true, T0);
  markLive(store, p.id, URL, T0);
  const c = createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: T0 });
  for (const x of c.posts.filter((y) => y.platform === "facebook")) decidePost(store, c.id, x.id, { approve: true, note: "checked", interactive: true }, T0);
  return store.products()[0];
};
const offline = (now = NOW, cfg: EngineConfig = DEFAULT_CONFIG) => runFactory(store, cfg, now, { offline: true });
const pkg = (runDir: string, n: string) => fs.readFileSync(path.join(runDir, n), "utf8");
let out = "";
const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null }); };

describe("factory run --offline: the complete pipeline", () => {
  it("scores, selects, builds a product that passes every QA check, and writes listing, marketing, review package and JSON", () => {
    const { run, reused, scores } = offline();
    expect(reused).toBe(false);
    expect(run).toMatchObject({ status: "review-ready", mode: "offline-template", concept: "client-onboarding-kit", date: "2026-11-10" });
    expect(scores.map((s) => s.concept)).toEqual(["client-onboarding-kit", "proposal-quote-kit", "project-tracking-kit"]);
    const p = store.products().find((x) => x.id === run.productId)!;
    expect(p).toMatchObject({ status: "ready", blueprint: "toolkit", name: "Client onboarding kit", price: 9, currency: "GBP", signOff: null, live: null });
    expect(p.checks.every((c) => c.passed)).toBe(true);
    expect(p.deliverables).toEqual(["start-here.md", "onboarding-checklist.md", "client-intake-questionnaire.md", "welcome-pack.md", "kickoff-call-agenda.md", "onboarding-tracker.csv", "access-checklist.csv"]);
    expect(store.ventures().find((v) => v.id === run.ventureId)?.status).toBe("factory-draft");
    expect(run.files.map((f) => f.name)).toEqual(["client-onboarding-kit.zip", "listing.md", "marketing-drafts.md", "image-brief.md", "zip-manifest.json", "review-package.md", "summary.json"]);
    for (const f of run.files) expect(fs.statSync(path.join(run.dir, f.name)).mode & 0o777).toBe(0o600);
    const review = pkg(run.dir, "review-package.md");
    expect(review).toMatch(/READY FOR YOUR REVIEW[\s\S]*## Concept and customer[\s\S]*## Opportunity score: 0\.56[\s\S]*demandEvidence \| 0 \| 0\.25 \| unknown \| unverified[\s\S]*## Files[\s\S]*onboarding-tracker\.csv[\s\S]*## Automated quality checks[\s\S]*complete-content \| pass[\s\S]*## Price\n\nGBP 9\. GBP 9: below the live GBP 12[\s\S]*## Risks, assumptions and missing information[\s\S]*## Owner approval checklist/);
    expect(pkg(run.dir, "listing.md")).toMatch(/no Payhip listing was created or changed[\s\S]*\*\*Title:\*\* Client onboarding kit[\s\S]*\*\*Price:\*\* GBP 9/);
    const md = pkg(run.dir, "marketing-drafts.md");
    expect(md.match(/^## (Facebook|LinkedIn|Instagram) \(\d+ of \d+ characters\)/gm)).toHaveLength(3);
    expect(misleadingClaims(md)).toEqual([]);
    expect(md).not.toMatch(/https?:\/\/|www\./);
    const s = JSON.parse(pkg(run.dir, "summary.json"));
    expect(s).toMatchObject({ status: "review-ready", mode: "offline-template", evidence: { demand: "unverified", competition: "unknown", sales: "none" }, published: false, approved: false, product: { id: p.id, status: "ready" } });
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("every catalogue concept builds a product that passes the existing QA (no thin or padded content)", () => {
    store.saveVentures(CONCEPTS.map((c, i) => ({ ...invoicingVenture, id: `ven-0000000${i}`, status: "factory-draft" as const, opportunity: { ...invoicingVenture.opportunity, title: c.name, source: `factory:${c.id}` } })));
    for (const v of store.ventures()) {
      const g = generateVersion(store, v.id, { currency: "GBP", price: 9 });
      expect(g.blueprint).toBe("toolkit");
      expect(qaGenerated(g).checks.filter((c) => !c.passed), v.opportunity.title).toEqual([]);
      expect(qaGenerated(g).review, "no legal or financial passages").toEqual([]);
    }
  });

  it("no verified research: demand is unverified (0) and competition unknown for every concept", () => {
    for (const s of scoreConcepts(store, CONCEPTS)) {
      expect(s.factors.demandEvidence).toMatchObject({ value: 0, basis: expect.stringMatching(/^unverified/) });
      expect(s.factors.competition).toMatchObject({ value: 0.5, basis: expect.stringMatching(/^unknown/) });
    }
  });
});

describe("factory: refusals, limits and idempotency", () => {
  it("without --offline it refuses (no model configured, or AI generation unavailable) and generates nothing", async () => {
    expect(() => runFactory(store, DEFAULT_CONFIG, NOW, { offline: false })).toThrow(/use 'factory run --offline'.*nothing was generated/);
    expect(await cli("factory", "run")).toBe(1);
    expect(await cli("factory", "run", "--paid")).toBe(1); expect(out).toMatch(/factory run --offline \| factory run --ai/);
    expect(store.products()).toEqual([]); expect(store.factoryRuns()).toEqual([]);
  });

  it("STOP blocks the factory", () => {
    stop(store.dir, "owner pause", NOW);
    expect(() => offline()).toThrow(/STOP is set \(.*owner pause\)/);
    expect(store.factoryRuns()).toEqual([]);
  });

  it("one run per UK day: a rerun returns the same run and makes no second product", async () => {
    const a = offline();
    const b = offline(new Date(NOW.getTime() + 3_600_000));
    expect(b.reused).toBe(true); expect(b.run).toEqual(a.run);
    expect(store.products()).toHaveLength(1);
    expect(await cli("factory", "run", "--offline")).toBe(0); expect(out).toMatch(/^already ran today: factory run /);
    expect(store.products()).toHaveLength(1);
  });

  it("never makes a duplicate: a concept already made, or too similar to an existing product, is excluded", () => {
    expect(offline().run.concept).toBe("client-onboarding-kit");
    expect(offline(NEXT_DAY).run.concept).toBe("proposal-quote-kit");
    expect(scoreConcepts(store, CONCEPTS).find((s) => s.concept === "client-onboarding-kit")?.excluded).toMatch(/already made in factory run fct-/);
    offline(new Date("2026-11-12T09:00:00Z"));
    const last = offline(new Date("2026-11-13T09:00:00Z"));
    expect(last.run.status).toBe("no-eligible-concept");
    expect(store.products()).toHaveLength(3); // bounded: the catalogue is exhausted, nothing more is made
    liveInvoicing();
    const copy = concept({ ...CONCEPTS[0], id: "invoice-copy", name: "Freelance invoicing kit", problem: "getting paid on time with clear terms" , files: [] });
    expect(scoreConcepts(store, [copy])[0]).toMatchObject({ eligible: false, excluded: expect.stringMatching(/too similar to an existing product/) });
  });

  it("failed quality checks: the run needs repair (never review-ready), its package says so, and the CLI exits 1", async () => {
    const thin = concept({ ...CONCEPTS[0], id: "thin-kit", name: "Thin kit", problem: "a deliberately unfinished test product", ratings: { usefulness: 1, simplicity: 1, monetisation: 1 },
      files: [{ name: "notes.md", template: false, description: "Notes", text: "# Notes\n\n- TODO write this\n" }] });
    EXTRA_CONCEPTS.push(thin);
    expect(await cli("factory", "run", "--offline")).toBe(1);
    const run = store.factoryRuns()[0];
    expect(run).toMatchObject({ status: "needs-repair", concept: "thin-kit" });
    expect(run.failedChecks).toContain("complete-content");
    expect(pkg(run.dir, "review-package.md")).toMatch(/NEEDS REPAIR: not ready for review[\s\S]*complete-content \| FAIL/);
    expect(store.products()[0].status).toBe("needs-work");
  });
});

describe("factory: safeguards and preservation", () => {
  it("preserves the live product, its files and the approved campaign; publishes, approves, lists and sends nothing", async () => {
    const live = liveInvoicing();
    const liveDir = path.join(store.dir, "ventures", live.ventureId, live.id);
    const files = fs.readdirSync(liveDir).map((n) => fs.readFileSync(path.join(liveDir, n), "utf8"));
    const campaigns = fs.readFileSync(path.join(store.dir, "campaigns.json"), "utf8");
    const approvals = fs.readFileSync(path.join(store.dir, "approvals.json"), "utf8");
    expect(await cli("factory", "run", "--offline")).toBe(0);
    expect(store.products().find((p) => p.id === live.id)).toEqual(live);
    expect(fs.readdirSync(liveDir).map((n) => fs.readFileSync(path.join(liveDir, n), "utf8"))).toEqual(files);
    expect(fs.readFileSync(path.join(store.dir, "campaigns.json"), "utf8")).toBe(campaigns);
    expect(fs.readFileSync(path.join(store.dir, "approvals.json"), "utf8")).toBe(approvals); // no approval requested or decided
    const made = store.products().find((p) => p.id !== live.id)!;
    expect(made).toMatchObject({ signOff: null, live: null, status: "ready" });
    expect(store.ventures().find((v) => v.id === invoicingVenture.id)?.status).toBe("launched");
    expect(out).toMatch(/Nothing was published, listed, scheduled, sent, approved or bought/);
  });

  it("the engine's own cycles leave the factory draft alone (not archived, no automatic launch request)", async () => {
    const { run } = offline();
    await runEngine({ store, kinds: KINDS, now: () => NOW, limits: DEFAULT_CONFIG.limits, model: null, maxModelCallsPerCycle: 0, paidApproved: false }, 1);
    const v = store.ventures().find((x) => x.id === run.ventureId)!;
    expect(v.status).toBe("factory-draft");
    expect(v.decisions).toEqual([]);
    expect(store.approvals().filter((a) => a.ventureId === run.ventureId)).toEqual([]);
  });

  it("daily operations lists the new run, the draft awaiting review, and failed validations", () => {
    const { run } = offline();
    const r = runDaily(store, DEFAULT_CONFIG, NOW).report;
    expect(r.factory).toEqual([{ id: run.id, date: "2026-11-10", mode: "offline-template", status: "review-ready", concept: "client-onboarding-kit", productId: run.productId, productStatus: "ready, awaiting your review and sign-off" }]);
    expect(r.actions.some((a) => a.ref === run.id && a.command === `factory show ${run.id}`)).toBe(true);
    expect(r.approvals.some((a) => a.ref === run.productId && /sign-off missing/.test(a.text))).toBe(true);
    EXTRA_CONCEPTS.push(concept({ ...CONCEPTS[0], id: "thin-kit", name: "Thin kit", problem: "a deliberately unfinished test product", ratings: { usefulness: 1, simplicity: 1, monetisation: 1 }, files: [{ name: "notes.md", template: false, description: "Notes", text: "# Notes\n\n- TODO\n" }] }));
    offline(NEXT_DAY);
    const r2 = runDaily(store, DEFAULT_CONFIG, NEXT_DAY).report;
    expect(r2.problems.some((p) => /needs repair: failed .*complete-content/.test(p.text))).toBe(true);
  });

  it("CLI list and show", async () => {
    expect(await cli("factory", "list")).toBe(0); expect(out).toBe("no factory runs\n");
    expect(await cli("factory", "run", "--offline")).toBe(0);
    const id = store.factoryRuns()[0].id;
    expect(await cli("factory", "list")).toBe(0); expect(out).toMatch(new RegExp(`^${id} 2026-11-10 offline-template review-ready client-onboarding-kit prd-`));
    expect(await cli("factory", "show", id)).toBe(0); expect(out).toMatch(/^# Review package: Client onboarding kit/);
    expect(await cli("factory", "show", "fct-00000000")).toBe(1);
    expect(await cli("factory")).toBe(2); expect(out).toMatch(/factory run --offline/);
  });
});
