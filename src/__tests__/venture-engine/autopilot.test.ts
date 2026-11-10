import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOCK_IDEAS, MOCK_PRODUCT } from "../../venture-engine/ai-factory.js";
import { REVIEW_BACKLOG_LIMIT, runAutopilot } from "../../venture-engine/autopilot.js";
import { EXTRA_CONCEPTS } from "../../venture-engine/blueprints/toolkit.js";
import { createCampaign, decidePost } from "../../venture-engine/campaign.js";
import { main } from "../../venture-engine/cli.js";
import { DEFAULT_CONFIG, stop } from "../../venture-engine/control.js";
import { decideApproval } from "../../venture-engine/engine.js";
import { recoverRun, runAiFactory } from "../../venture-engine/factory.js";
import { fakeModel } from "../../venture-engine/model.js";
import { runDaily } from "../../venture-engine/operations.js";
import { buildProduct, confirmationCode, markLive, requestLaunch, signOff } from "../../venture-engine/products.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const T0 = new Date("2026-11-09T10:00:00Z");
const NOW = new Date("2026-11-10T08:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const URL = "https://payhip.com/b/t1JqT";
let DIR = "", store: Store, realFetch: typeof fetch, fetches = 0;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vp-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch; fetches = 0;
  globalThis.fetch = (() => { fetches += 1; throw new Error("network access in a test"); }) as typeof fetch;
  EXTRA_CONCEPTS.length = 0;
});
afterEach(() => { globalThis.fetch = realFetch; EXTRA_CONCEPTS.length = 0; fs.rmSync(DIR, { recursive: true, force: true }); });

const live = () => {
  const v: Venture = { id: "ven-9e27315f", status: "built", experiments: [], decisions: [], createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
    opportunity: { id: "opp-00000001", kind: "digital-product", title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms", audience: "freelancers", offer: "A template pack.", estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: T0.toISOString(), source: "fixture" } };
  store.saveVentures([v]);
  let p = buildProduct(store, v.id, { now: T0, currency: "GBP", price: 12 });
  p = signOff(store, p.id, { confirm: confirmationCode(p), price: "GBP 12", note: "checked", interactive: true }, T0);
  decideApproval(store, requestLaunch(store, p.id, T0).id, true, T0); markLive(store, p.id, URL, T0);
  const c = createCampaign(store, p.id, { url: URL, start: "2026-11-10", now: T0 });
  for (const x of c.posts.filter((y) => y.platform === "facebook")) decidePost(store, c.id, x.id, { approve: true, note: "checked", interactive: true }, T0);
};
/** A failed AI run whose saved answer is broken in a way the current local repairs fix (a short CSV row). */
const failedRunWithAnswers = async () => {
  const bad = { ...MOCK_PRODUCT, files: MOCK_PRODUCT.files.map((f) => (f.kind === "csv" ? { ...f, rows: [["x"]] } : f)) };
  const m = fakeModel((p) => JSON.stringify(/PURPOSE: ideas/.test(p) ? MOCK_IDEAS : { ...bad, files: [] }));
  const { run } = await runAiFactory(store, DEFAULT_CONFIG, T0, { client: m, mock: false, paidApproved: false });
  expect(run.status).toBe("ai-failed");
  // simulate the saved answer being repairable now (the earlier validator rejected it)
  fs.chmodSync(path.join(run.dir, "model-answers.json"), 0o600);
  fs.writeFileSync(path.join(run.dir, "model-answers.json"), JSON.stringify({ ideas: MOCK_IDEAS, product: bad }));
  return run;
};
const records = () => ["products.json", "campaigns.json", "approvals.json"].map((n) => fs.readFileSync(path.join(store.dir, n), "utf8"));

describe("autopilot: bounded offline daily workflow", () => {
  it("recovers a failed AI run from saved answers (no model call), prepares one offline draft, writes report and owner dashboard", async () => {
    live();
    const failed = await failedRunWithAnswers();
    const liveBefore = records();
    const r = runAutopilot(store, DEFAULT_CONFIG, NOW);
    expect(r.completed).toEqual([
      expect.stringMatching(new RegExp(`^recovered ${failed.id} from its saved answers as fct-[0-9a-f]{8} \\(review-ready, product prd-[0-9a-f]{8}\\); no model call$`)),
      expect.stringMatching(/^prepared 14-day marketing experiment pln-[0-9a-f]{8} for Freelance invoicing kit /),
      expect.stringMatching(/^prepared launch package lch-[0-9a-f]{8} for prd-[0-9a-f]{8} \(Freelance invoicing kit\): verified ZIP, listing, cover, marketing, checklist$/),
    ]);
    expect(r.skipped).toContain("new product draft: revenue first (Freelance invoicing kit 0/10 sales)");
    const recovered = store.factoryRuns().find((x) => x.recoveredFrom === failed.id)!;
    expect(recovered).toMatchObject({ modelCalls: 0, status: "review-ready" });
    expect(fs.readFileSync(path.join(recovered.dir, "review-package.md"), "utf8")).toMatch(/safe repairs: project-pipeline\.csv: row 1: 7 missing cell\(s\) left empty/);
    expect(r.report.completed.filter((c) => c.startsWith("autopilot: "))).toHaveLength(3);
    expect(r.report.summary).toMatch(/^Automaton completed \d+ task\(s\)\. \d+ item\(s\) need you/);
    expect(r.report.nextAction).not.toBeNull();
    const dash = fs.readFileSync(path.join(store.dir, "reports", "owner-dashboard.html"), "utf8");
    expect(dash).toMatch(/Needs you[\s\S]*Automaton completed[\s\S]*autopilot: recovered[\s\S]*Products[\s\S]*Campaigns[\s\S]*Recorded sales[\s\S]*Not recorded: sales and revenue are unknown, not zero[\s\S]*Spending[\s\S]*No paid AI usage recorded/);
    expect(dash).not.toMatch(/<script|https?:\/\/(?!payhip\.com\/b\/t1JqT)|sk-ant/);
    expect(records()[1]).toBe(liveBefore[1]); // campaign untouched
    expect(records()[2]).toBe(liveBefore[2]); // approvals untouched
    expect(store.products().filter((p) => p.signOff).map((p) => p.status)).toEqual(["live"]); // nothing new approved
    expect(fetches).toBe(0);
  });

  it("is idempotent the same day and bounded by the review backlog; never runs AI itself", async () => {
    runAutopilot(store, DEFAULT_CONFIG, NOW);
    const again = runAutopilot(store, DEFAULT_CONFIG, new Date(NOW.getTime() + 3_600_000));
    expect(again.completed).toEqual([]);
    expect(again.skipped).toContain("new product draft: one was already prepared today");
    runAutopilot(store, DEFAULT_CONFIG, day(1));
    const blocked = runAutopilot(store, DEFAULT_CONFIG, day(2));
    expect(blocked.skipped.join(" ")).toMatch(new RegExp(`${REVIEW_BACKLOG_LIMIT} factory product\\(s\\) already wait for your review`));
    expect(store.products()).toHaveLength(REVIEW_BACKLOG_LIMIT);
    expect(store.factoryRuns().every((x) => x.mode === "offline-template" && (x.modelCalls ?? 0) === 0)).toBe(true);
  });

  it("STOP: prepares nothing, still reports", () => {
    stop(store.dir, "pause", NOW);
    const r = runAutopilot(store, DEFAULT_CONFIG, NOW);
    expect(r.completed).toEqual([]);
    expect(r.skipped[0]).toMatch(/STOP is set/);
    expect(store.factoryRuns()).toEqual([]);
    expect(fs.existsSync(path.join(store.dir, "reports", "owner-dashboard.html"))).toBe(true);
  });

  it("unresolved failures are reported clearly (no saved answers: needs approval for a new call)", async () => {
    const m = fakeModel(() => "not json");
    const { run } = await runAiFactory(store, DEFAULT_CONFIG, T0, { client: m, mock: false, paidApproved: false });
    fs.rmSync(path.join(run.dir, "model-answers.json"), { force: true });
    expect(() => recoverRun(store, NOW, run.id)).toThrow(/no saved model answers[\s\S]*needs your approval/);
    const d = runDaily(store, DEFAULT_CONFIG, T0).report;
    expect(d.problems.some((p) => p.ref === run.id && /cannot be recovered; a new AI run needs your approval/.test(p.text))).toBe(true);
    expect(m.prompts).toHaveLength(1); // nothing retried
  });
});

describe("factory recover", () => {
  it("rebuilds once, from saved answers only; refuses twice, non-failed runs, still-broken answers and STOP", async () => {
    const failed = await failedRunWithAnswers();
    const d0 = runDaily(store, DEFAULT_CONFIG, NOW).report;
    expect(d0.actions.some((a) => a.command === `factory recover ${failed.id}`)).toBe(true);
    let out = "";
    expect(await main(["factory", "recover", failed.id], { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null })).toBe(0);
    expect(out).toMatch(/recovered fct-[0-9a-f]{8} locally \(no model call\) as fct-[0-9a-f]{8}: review-ready/);
    expect(() => recoverRun(store, NOW, failed.id)).toThrow(/already recovered/);
    const ok = store.factoryRuns().find((x) => x.recoveredFrom === failed.id)!;
    expect(() => recoverRun(store, NOW, ok.id)).toThrow(/only ai-failed runs/);
    const m2 = fakeModel((p) => JSON.stringify(/PURPOSE: ideas/.test(p) ? MOCK_IDEAS : { ...MOCK_PRODUCT, files: [] }));
    const s2run = (await runAiFactory(store, DEFAULT_CONFIG, day(3), { client: m2, mock: false, paidApproved: false })).run;
    expect(() => recoverRun(store, NOW, s2run.id)).toThrow(/still unusable after local repairs/);
    stop(store.dir, "pause", NOW);
    expect(() => recoverRun(store, NOW, s2run.id)).toThrow(/STOP is set/);
  });
});

describe("owner dashboard and spending", () => {
  it("shows ledger spending when paid usage was recorded, and the daily timer command is unchanged", () => {
    fs.writeFileSync(path.join(store.dir, "ledger.json"), JSON.stringify({ version: 1, currency: "GBP", capGbp: 10, createdAt: T0.toISOString(), entries: [] }), { mode: 0o600 });
    const r = runDaily(store, DEFAULT_CONFIG, NOW).report;
    expect(r.spending).toMatchObject({ committedGbp: 0, capGbp: 10, requests: 0 });
    expect(fs.readFileSync(path.join(store.dir, "reports", "owner-dashboard.html"), "utf8")).toMatch(/Paid AI \(local ledger estimate\): £0 committed of the £10 cap/);
    let out = "";
    return main(["operations", "unit"], { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null }).then(() => expect(out).toMatch(/ExecStart=\/usr\/bin\/env node %h\/automaton\/dist\/venture-engine\/main\.js operations daily\n/));
  });
});
