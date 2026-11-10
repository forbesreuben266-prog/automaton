import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiReadiness, MOCK_IDEAS, MOCK_PRODUCT, mockModel, normalizeCsv, productPrompt, validateIdeas, validateSpec, worksheetHtml } from "../../venture-engine/ai-factory.js";
import { csv } from "../../venture-engine/blueprints/common.js";
import { parseCsv } from "../../venture-engine/products.js";
import { EXTRA_CONCEPTS } from "../../venture-engine/blueprints/toolkit.js";
import { createCampaign, decidePost } from "../../venture-engine/campaign.js";
import { main } from "../../venture-engine/cli.js";
import { DEFAULT_CONFIG, stop, type EngineConfig } from "../../venture-engine/control.js";
import { decideApproval } from "../../venture-engine/engine.js";
import { runAiFactory } from "../../venture-engine/factory.js";
import { fakeModel } from "../../venture-engine/model.js";
import { runDaily } from "../../venture-engine/operations.js";
import { buildProduct, confirmationCode, htmlSafety, markLive, requestLaunch, reviewHash, signOff } from "../../venture-engine/products.js";
import { reviewProduct } from "../../venture-engine/review.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";
import { makeZip, readZip, verifyZip, zipManifest } from "../../venture-engine/zip.js";

const T0 = new Date("2026-11-09T10:00:00Z");
const NOW = new Date("2026-11-10T09:00:00Z");
const URL = "https://payhip.com/b/t1JqT";
let DIR = "";
let store: Store;
let realFetch: typeof fetch;
let fetches = 0;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "va-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch; fetches = 0;
  globalThis.fetch = (() => { fetches += 1; throw new Error("network access in a test"); }) as typeof fetch;
  EXTRA_CONCEPTS.length = 0;
});
afterEach(() => { globalThis.fetch = realFetch; EXTRA_CONCEPTS.length = 0; fs.rmSync(DIR, { recursive: true, force: true }); });

const answers = (ideas: unknown, product: unknown) => (p: string) => JSON.stringify(/PURPOSE: ideas/.test(p) ? ideas : product);
const claude: EngineConfig = { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, provider: "claude", name: "claude-sonnet-5-5", paidUsageApproved: true, maxGbpPerRun: 1 } };
const writeConfig = (c: EngineConfig) => fs.writeFileSync(path.join(store.dir, "config.json"), JSON.stringify(c), { mode: 0o600 });
let out = "";
const cli = async (model: ReturnType<typeof fakeModel> | null, ...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model }); };
const live = () => {
  const v: Venture = { id: "ven-9e27315f", status: "built", experiments: [], decisions: [], createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
    opportunity: { id: "opp-00000001", kind: "digital-product", title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms", audience: "freelancers", offer: "A template pack.", estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: T0.toISOString(), source: "fixture" } };
  store.saveVentures([v]);
  let p = buildProduct(store, v.id, { now: T0, currency: "GBP", price: 12 });
  p = signOff(store, p.id, { confirm: confirmationCode(p), price: "GBP 12", note: "checked", interactive: true }, T0);
  decideApproval(store, requestLaunch(store, p.id, T0).id, true, T0); markLive(store, p.id, URL, T0);
  const c = createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: T0 });
  for (const x of c.posts.filter((y) => y.platform === "facebook")) decidePost(store, c.id, x.id, { approve: true, note: "checked", interactive: true }, T0);
  return store.products()[0];
};

describe("AI factory with the mock model: the complete pipeline", () => {
  it("ideas -> scoring -> product -> QA -> ZIP -> listing, 3 drafts, image brief, review package; labelled as a demonstration", async () => {
    const m = mockModel();
    const { run, scores } = await runAiFactory(store, DEFAULT_CONFIG, NOW, { client: m, mock: true, paidApproved: false });
    expect(m.prompts).toHaveLength(2);
    expect(run).toMatchObject({ status: "review-ready", mode: "mock-demo", concept: "mock-freelance-capacity-planner", model: "mock", modelCalls: 2, failedChecks: [] });
    expect(scores.find((s) => s.name === "Freelance tax deadline planner")?.excluded).toMatch(/legal, tax or financial advice/);
    const p = store.products().find((x) => x.id === run.productId)!;
    expect(p).toMatchObject({ name: "Freelance capacity planner", status: "ready", price: 7, currency: "GBP", signOff: null, live: null });
    expect(p.deliverables).toEqual(["start-here.md", "capacity-planning-guide.md", "rescheduling-and-declining.md", "weekly-capacity-worksheet.html", "project-pipeline.csv", "time-log.csv"]);
    const read = (n: string) => fs.readFileSync(path.join(run.dir, n), "utf8");
    expect(read("review-package.md")).toMatch(/MOCK DEMONSTRATION[\s\S]*READY FOR YOUR REVIEW[\s\S]*\| usefulness \| 0\.8 \| 0\.3 \| ai-inference \|[\s\S]*Verified evidence: none\n- AI inference: usefulness, monetisation\n- Owner assumptions: simplicity\n- Unknown: demandEvidence, competition[\s\S]*zip-integrity \| pass[\s\S]*not-near-duplicate \| pass[\s\S]*listing-consistency \| pass/);
    expect(read("listing.md")).toMatch(/MOCK DEMONSTRATION[\s\S]*\*\*Feature summary:\*\* 6 files: an offline HTML worksheet, CSV trackers, Markdown guides[\s\S]*\*\*Images:\*\* none were created/);
    expect(read("marketing-drafts.md").match(/^## (Facebook|LinkedIn|Instagram) /gm)).toHaveLength(3);
    expect(read("image-brief.md")).toMatch(/No images were created/);
    const s = JSON.parse(read("summary.json"));
    expect(s).toMatchObject({ mode: "mock-demo", demonstration: true, imagesCreated: false, published: false, approved: false, evidence: { verified: [], demand: "unverified" } });
    expect(fetches).toBe(0);
  });

  it("the ZIP extracts to exactly the deliverables, with recorded sizes and SHA-256; tampering is detected", async () => {
    const { run } = await runAiFactory(store, DEFAULT_CONFIG, NOW, { client: mockModel(), mock: true, paidApproved: false });
    const zip = fs.readFileSync(path.join(run.dir, run.zip!));
    const manifest = JSON.parse(fs.readFileSync(path.join(run.dir, "zip-manifest.json"), "utf8"));
    expect(verifyZip(zip, manifest.files)).toEqual([]);
    const p = store.products().find((x) => x.id === run.productId)!;
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(p.deliverables);
    for (const e of entries) expect(e.data.toString("utf8")).toBe(fs.readFileSync(path.join(store.dir, "ventures", p.ventureId, p.id, e.name), "utf8"));
    expect(entries.map((e) => e.name)).not.toContain("landing.html");
    const bad = Buffer.from(zip); bad[bad.indexOf("Capacity planning") + 2] ^= 1;
    expect(verifyZip(bad, manifest.files).length).toBeGreaterThan(0);
    expect(verifyZip(zip, [...manifest.files, { name: "extra.md", bytes: 1, sha256: "0" }])).toEqual(["missing from archive: extra.md"]);
    expect(() => makeZip([{ name: "../evil.md", data: Buffer.from("x") }])).toThrow(/unsafe file name/);
    expect(() => makeZip([{ name: "/etc/passwd", data: Buffer.from("x") }])).toThrow(/unsafe/);
    expect(() => makeZip([{ name: "a.md", data: Buffer.from("x") }, { name: "a.md", data: Buffer.from("y") }])).toThrow(/duplicate/);
    expect(verifyZip(makeZip([{ name: "a.md", data: Buffer.from("x") }]), zipManifest([{ name: "a.md", data: Buffer.from("x") }]))).toEqual([]);
  });

  it("the generated HTML worksheet is offline and script-free; AI concepts rebuild identically on product review", async () => {
    const { run } = await runAiFactory(store, DEFAULT_CONFIG, NOW, { client: mockModel(), mock: true, paidApproved: false });
    const html = worksheetHtml(MOCK_PRODUCT.files[2] as Parameters<typeof worksheetHtml>[0]);
    expect(htmlSafety("weekly-capacity-worksheet.html", html, false)).toEqual([]);
    expect(html).toMatch(/default-src 'none'/); expect(html).not.toMatch(/<script|https?:/);
    EXTRA_CONCEPTS.length = 0; // a new process: the CLI reloads stored AI concepts
    expect(await cli(null, "product", "review", run.productId!)).toBe(0);
    expect(out).toMatch(/FIXED AUTOMATICALLY \(0\)[\s\S]*PASSED \(12\)/);
  });
});

describe("AI factory: invalid answers, unavailable providers, cost safety", () => {
  it("invalid model answers fail the run; nothing is generated in their place (no catalogue fallback)", async () => {
    for (const [ideas, product, why] of [
      ["not json at all", MOCK_PRODUCT, /ideas were unusable/],
      [{ ideas: [{ ...MOCK_IDEAS.ideas[0], demandEvidence: "strong: 40% of freelancers want this" }] }, MOCK_PRODUCT, /ideas were unusable/],
      [MOCK_IDEAS, { ...MOCK_PRODUCT, files: [{ name: "../x.md", kind: "markdown", description: "x", template: false, content: "y".repeat(300) }] }, /product was unusable.*safe lowercase name/],
      [MOCK_IDEAS, { ...MOCK_PRODUCT, headline: "Guaranteed results for every freelancer" }, /product was unusable.*misleading claims/],
      [MOCK_IDEAS, { ...MOCK_PRODUCT, files: MOCK_PRODUCT.files.filter((f) => f.kind === "csv").concat({ ...MOCK_PRODUCT.files[4], name: "third.csv", rows: [["a", "b", "c", "d", "e", "f", "g", "h", "extra content"]] } as typeof MOCK_PRODUCT.files[4]).map((f) => ({ ...f, rows: [["a", "b", "c", "d", "e", "f", "g", "h", "extra content"]] })) }, /too few usable files/],
    ] as [unknown, unknown, RegExp][]) {
      const s = new Store(fs.mkdtempSync(path.join(DIR, "s-")));
      const raw = typeof ideas === "string" ? () => ideas as string : answers(ideas, product);
      const { run } = await runAiFactory(s, DEFAULT_CONFIG, NOW, { client: fakeModel(raw), mock: false, paidApproved: false });
      expect(run.status).toBe("ai-failed");
      expect(run.reason).toMatch(why);
      expect(s.products()).toEqual([]);
      expect(s.ventures()).toEqual([]);
    }
    expect(validateIdeas({ ideas: [{ ...MOCK_IDEAS.ideas[0], name: "The number one bestseller planner" }] })).toBeNull();
    expect(validateSpec({ ...MOCK_PRODUCT, files: [] })).toMatchObject({ problems: expect.arrayContaining(["files: 3 to 8 files"]) });
  });

  it("provider unavailable: a clear refusal, preflight says why, no call, nothing generated", async () => {
    expect(await cli(null, "factory", "run", "--ai")).toBe(1);
    expect(out).toMatch(/AI mode is unavailable: no model provider is configured[\s\S]*Nothing was generated/);
    expect(await cli(null, "factory", "preflight")).toBe(1);
    expect(out).toMatch(/AI provider: none\nready: no[\s\S]*No network call or token was used/);
    writeConfig(claude);
    expect(await cli(null, "factory", "preflight")).toBe(1);
    expect(out).toMatch(/AI provider: claude \(claude-sonnet-5-5\)\nready: no\n- no API key file[\s\S]*worst-case cost of one AI factory run: £0\.\d+ \(2 calls\)/);
    expect(out).not.toMatch(/sk-ant/);
    expect(store.factoryRuns()).toEqual([]); expect(fetches).toBe(0);
  });

  it("no accidental paid calls: a paid provider needs approval in config AND --paid AND a budget that fits", async () => {
    const paid = fakeModel(answers(MOCK_IDEAS, MOCK_PRODUCT), { paid: true });
    await expect(runAiFactory(store, claude, NOW, { client: paid, mock: false, paidApproved: false })).rejects.toThrow(/is paid: it needs config.json model.paidUsageApproved = true AND 'factory run --ai --paid'/);
    writeConfig(claude);
    expect(await cli(paid, "factory", "run", "--ai")).toBe(1); expect(out).toMatch(/is paid: run 'factory run --ai --paid' only after you approve the cost/);
    writeConfig({ ...claude, model: { ...claude.model, paidUsageApproved: false } });
    expect(await cli(paid, "factory", "run", "--ai", "--paid")).toBe(1); expect(out).toMatch(/not ready: paid usage is not approved/);
    expect(paid.prompts).toEqual([]);
    expect(store.factoryRuns()).toEqual([]);
  });

  it("budget exceeded: refused before any call when the worst-case cost exceeds model.maxGbpPerRun", async () => {
    const paid = fakeModel(answers(MOCK_IDEAS, MOCK_PRODUCT), { paid: true });
    const tight: EngineConfig = { ...claude, model: { ...claude.model, maxGbpPerRun: 0.01 } };
    await expect(runAiFactory(store, tight, NOW, { client: paid, mock: false, paidApproved: true })).rejects.toThrow(/budget: a factory run can cost up to £0\.\d+, more than model.maxGbpPerRun \(£0\.01\)\. No call was made/);
    expect(paid.prompts).toEqual([]);
    expect(aiReadiness(store, tight, NOW).reasons.join(" ")).toMatch(/more than model.maxGbpPerRun/);
  });

  it("an approved paid run makes at most 2 calls; a failing call stops the run", async () => {
    const paid = fakeModel(answers(MOCK_IDEAS, MOCK_PRODUCT), { paid: true });
    const { run } = await runAiFactory(store, claude, NOW, { client: paid, mock: false, paidApproved: true });
    expect(run).toMatchObject({ status: "review-ready", mode: "ai", modelCalls: 2 });
    expect(paid.prompts).toHaveLength(2);
    const s2 = new Store(fs.mkdtempSync(path.join(DIR, "s-")));
    const broken = fakeModel(() => new Error("HTTP 529 overloaded"), { paid: true });
    const r2 = await runAiFactory(s2, claude, NOW, { client: broken, mock: false, paidApproved: true });
    expect(r2.run).toMatchObject({ status: "ai-failed", modelCalls: 1 });
    expect(broken.prompts).toHaveLength(1);
  });
});

describe("AI factory: limits, duplicates, failed QA and preservation", () => {
  it("STOP blocks AI runs; one run per day per mode (rerun returns it); the same idea is never made twice", async () => {
    stop(store.dir, "pause", NOW);
    await expect(runAiFactory(store, DEFAULT_CONFIG, NOW, { client: mockModel(), mock: true, paidApproved: false })).rejects.toThrow(/STOP is set/);
    fs.unlinkSync(path.join(store.dir, "STOP"));
    const a = await runAiFactory(store, DEFAULT_CONFIG, NOW, { client: mockModel(), mock: true, paidApproved: false });
    const m = mockModel();
    const b = await runAiFactory(store, DEFAULT_CONFIG, NOW, { client: m, mock: true, paidApproved: false });
    expect(b.reused).toBe(true); expect(b.run.id).toBe(a.run.id); expect(m.prompts).toEqual([]);
    const c = await runAiFactory(store, DEFAULT_CONFIG, new Date("2026-11-11T09:00:00Z"), { client: mockModel(), mock: true, paidApproved: false });
    expect(c.run.concept).toBe("mock-client-feedback-tracker"); // the capacity planner is excluded as already made
    expect(c.scores.find((s) => s.concept === "mock-freelance-capacity-planner")?.excluded).toMatch(/already made|too similar/);
  });

  it("failed QA marks the run needs-repair (never review-ready)", async () => {
    const thin = { ...MOCK_PRODUCT, files: MOCK_PRODUCT.files.map((f) => (f.kind === "markdown" ? { ...f, content: `${f.content}\n- TODO finish this section later\n` } : f)) };
    const { run } = await runAiFactory(store, DEFAULT_CONFIG, NOW, { client: fakeModel(answers(MOCK_IDEAS, thin)), mock: false, paidApproved: false });
    expect(run.status).toBe("needs-repair");
    expect(run.failedChecks).toContain("complete-content");
    expect(fs.readFileSync(path.join(run.dir, "review-package.md"), "utf8")).toMatch(/NEEDS REPAIR/);
  });

  it("preserves the live product, its campaign and approvals; publishes, approves and lists nothing; daily report shows status", async () => {
    const p = live();
    const before = ["products.json", "campaigns.json", "approvals.json"].map((n) => fs.readFileSync(path.join(store.dir, n), "utf8"));
    const liveRecord = store.products()[0];
    const { run } = await runAiFactory(store, DEFAULT_CONFIG, NOW, { client: mockModel(), mock: true, paidApproved: false });
    expect(store.products().find((x) => x.id === p.id)).toEqual(liveRecord);
    expect(reviewHash(store.products().find((x) => x.id === p.id)!)).toBe(liveRecord.signOff!.reviewHash);
    expect(fs.readFileSync(path.join(store.dir, "campaigns.json"), "utf8")).toBe(before[1]);
    expect(fs.readFileSync(path.join(store.dir, "approvals.json"), "utf8")).toBe(before[2]);
    expect(store.products().find((x) => x.id === run.productId)).toMatchObject({ signOff: null, live: null });
    const r = runDaily(store, DEFAULT_CONFIG, NOW).report;
    expect(r.status).toBe("ok");
    expect(r.factory.at(-1)).toMatchObject({ id: run.id, mode: "mock-demo", status: "review-ready", productStatus: "ready, awaiting your review and sign-off" });
    expect(r.aiProvider).toMatchObject({ provider: "none", ready: false });
    expect(r.actions.some((a) => a.ref === run.id && /MOCK DEMONSTRATION/.test(a.text))).toBe(true);
    expect(fetches).toBe(0);
  });

  it("CLI: --ai --mock runs the labelled demonstration; bad flag combinations are refused", async () => {
    expect(await cli(null, "factory", "run", "--ai", "--mock")).toBe(0);
    expect(out).toMatch(/^MOCK DEMONSTRATION: the built-in mock model, not real AI\.\nfactory run fct-[0-9a-f]{8} \(2026-11-10, mock-demo\): review-ready/);
    for (const a of [["--ai", "--offline"], ["--mock"], ["--ai", "--mock", "--paid"], ["--offline", "--paid"]]) expect(await cli(null, "factory", "run", ...a)).toBe(1);
  });
});

describe("CSV reliability (regression: fct-9cdd3785, charge-register.csv)", () => {
  const H = ["Date", "Client", "Charge", "Amount", "Paid", "Notes"];
  const ok = (x: ReturnType<typeof normalizeCsv>) => { if ("problem" in x) throw new Error(x.problem); return x; };

  it("quoted commas, quotes and line breaks inside cells are written and read back exactly (the factory writes the CSV)", () => {
    const rows = [["2026-02-01", "Example Ltd, London", "Design \"phase 1\"", 120, "No", "Line one\nline two"]];
    const n = ok(normalizeCsv({ header: H, rows }));
    expect(n.repairs).toEqual([]);
    const back = parseCsv(csv([n.header, ...n.rows]));
    expect(back).toEqual([H, rows[0].map(String)]);
  });

  it("safe repairs: null and missing cells, booleans, short rows, empty extra cells, object rows, duplicate names, CSV text", () => {
    const n = ok(normalizeCsv({ header: [...H.slice(0, 5), "Paid"], rows: [["2026-02-01", "A", "Logo", 50, null], ["2026-02-02", "B", "Site", 90, true, "", "", ""], { Date: "2026-02-03", Client: "C", Charge: "Copy", Amount: 30 }] }));
    expect(n.header).toEqual(["Date", "Client", "Charge", "Amount", "Paid", "Paid (2)"]);
    expect(n.rows).toEqual([["2026-02-01", "A", "Logo", 50, "", ""], ["2026-02-02", "B", "Site", 90, "Yes", ""], ["2026-02-03", "C", "Copy", 30, "", ""]]);
    expect(n.repairs.join("; ")).toMatch(/duplicate column name[\s\S]*missing cell[\s\S]*empty extra cells dropped[\s\S]*objects were mapped/);
    const t = ok(normalizeCsv({ content: 'Client,Notes\r\n"Example, Ltd","said ""yes""\nlater"\r\n' }));
    expect(t.rows).toEqual([["Example, Ltd", 'said "yes"\nlater']]);
  });

  it("unsafe cases are problems, never silently fixed: content beyond the columns, oversized cells, no rows, bad header", () => {
    expect(normalizeCsv({ header: H, rows: [[...H.map(() => "x"), "data that would shift"]] })).toMatchObject({ problem: expect.stringMatching(/content beyond the 6 columns/) });
    expect(normalizeCsv({ header: H, rows: [["x".repeat(501)]] })).toMatchObject({ problem: expect.stringMatching(/longer than 500/) });
    expect(normalizeCsv({ header: H, rows: [] })).toMatchObject({ problem: expect.stringMatching(/at least one example row/) });
    expect(normalizeCsv({ header: ["Only"], rows: [["x"]] })).toMatchObject({ problem: expect.stringMatching(/2 to 16 column names/) });
    expect(normalizeCsv({ header: H, rows: [[{ nested: 1 }]] })).toMatchObject({ problem: expect.stringMatching(/text or numbers/) });
  });

  it("reproduction: a short-row charge register is repaired and the paid run is not wasted (review-ready, repairs listed)", async () => {
    const charge = { name: "charge-register.csv", kind: "csv", description: "Charges per client", template: true, header: H,
      rows: [["2026-02-01", "Example Ltd", "Design, phase 1", 120, "No"], ["2026-02-03", "Example Studio", "Copy edits", 45, "Yes", "Paid by transfer, thank you"]] };
    const product = { ...MOCK_PRODUCT, files: [...MOCK_PRODUCT.files, charge] };
    expect("problems" in validateSpec(product)).toBe(false);
    const { run } = await runAiFactory(store, DEFAULT_CONFIG, NOW, { client: fakeModel(answers(MOCK_IDEAS, product)), mock: false, paidApproved: false });
    expect(run).toMatchObject({ status: "review-ready", modelCalls: 2 });
    const review = fs.readFileSync(path.join(run.dir, "review-package.md"), "utf8");
    expect(review).toMatch(/model-output-complete \| pass \| every file the model wrote was usable; safe repairs: charge-register\.csv: row 1: 1 missing cell\(s\) left empty/);
    expect(fs.existsSync(path.join(run.dir, "model-answers.json"))).toBe(true);
  });

  it("reproduction: an unrepairable CSV is left out and the run is needs-repair (never review-ready); answers are kept", async () => {
    const charge = { name: "charge-register.csv", kind: "csv", description: "Charges", template: true, header: H, rows: [["2026-02-01", "A", "B", 1, "No", "", "unexpected extra value"]] };
    const { run } = await runAiFactory(store, DEFAULT_CONFIG, NOW, { client: fakeModel(answers(MOCK_IDEAS, { ...MOCK_PRODUCT, files: [...MOCK_PRODUCT.files, charge] })), mock: false, paidApproved: false });
    expect(run.status).toBe("needs-repair");
    expect(run.failedChecks).toEqual(["model-output-complete"]);
    const p = store.products().find((x) => x.id === run.productId)!;
    expect(p.deliverables).not.toContain("charge-register.csv");
    expect(fs.readFileSync(path.join(run.dir, "review-package.md"), "utf8")).toMatch(/NEEDS REPAIR[\s\S]*model-output-complete \| FAIL \| left out \(could not be repaired safely\): charge-register\.csv: row 1 has 7 cells with content beyond the 6 columns/);
    const kept = JSON.parse(fs.readFileSync(path.join(run.dir, "model-answers.json"), "utf8"));
    expect(kept.product.files.at(-1).name).toBe("charge-register.csv");
  });

  it("a failed product answer is kept on disk; no automatic retry is made", async () => {
    const m = fakeModel(answers(MOCK_IDEAS, { ...MOCK_PRODUCT, files: [] }), { paid: true });
    const { run } = await runAiFactory(store, claude, NOW, { client: m, mock: false, paidApproved: true });
    expect(run.status).toBe("ai-failed");
    expect(m.prompts).toHaveLength(2); // ideas + product, nothing more
    expect(JSON.parse(fs.readFileSync(path.join(run.dir, "model-answers.json"), "utf8")).product.files).toEqual([]);
  });

  it("the prompt states the strict CSV rules with an example", () => {
    const p = productPrompt(MOCK_IDEAS.ideas[0] as Parameters<typeof productPrompt>[0], 4000);
    expect(p).toMatch(/EXACTLY as many items as "header"[\s\S]*Use "" for an empty cell, never null[\s\S]*Never write CSV text[\s\S]*"rows":\[\["Example Ltd"/);
  });
});

