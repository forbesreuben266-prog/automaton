import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../venture-engine/cli.js";
import { HARD_LIMITS, DEFAULT_CONFIG, parseConfig, stop, withLock } from "../../venture-engine/control.js";
import { renderDashboard, totals } from "../../venture-engine/dashboard.js";
import { DEFAULT_LIMITS, decideApproval, recordActual, runCycle, runEngine, type EngineOptions } from "../../venture-engine/engine.js";
import { concreteBullets, overlap } from "../../venture-engine/evaluate.js";
import { digitalProduct } from "../../venture-engine/kinds/digital-product.js";
import { fakeModel, loopbackUrl } from "../../venture-engine/model.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture, VentureKind } from "../../venture-engine/types.js";

let DIR = "";
let store: Store;
const NOW = new Date("2026-11-08T09:00:00Z");
const opts = (extra: Partial<EngineOptions> = {}): EngineOptions => ({ store, kinds: [digitalProduct], now: () => NOW, ...extra });
beforeEach(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ve-")); store = new Store(path.join(DIR, "data")); });
afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));
const v = (id: string): Venture => store.ventures().find((x) => x.id === id)!;
const q = (x: Venture) => x.experiments.at(-1)!.evidence.find((e) => e.kind === "simulated")!.metrics.qualityScore!;
const audit = () => fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8");

const MODEL_OPPS = JSON.stringify({ opportunities: [
  { title: "Wedding budget tracker for couples", problem: "keeping wedding costs under control", audience: "engaged couples", offer: "A template pack to plan and track every wedding cost.", format: "template pack", demand: 0.8, risk: 0.1, rationale: "common need" },
  { title: "Allotment planting calendar", problem: "knowing what to sow and when", audience: "new allotment holders", offer: "A 30-day planner for a first allotment season.", format: "30-day planner", demand: 0.6, risk: 0.1, rationale: "seasonal need" },
  { title: "Dog-sitting handover checklist", problem: "leaving complete care instructions", audience: "dog owners", offer: "A printable checklist for sitters.", format: "printable checklist", demand: 0.7, risk: 0.05, rationale: "recurring need" },
] });
const MODEL_CONTENT = JSON.stringify({ headline: "Plan every cost before you book", subheadline: "A clear system for engaged couples.", benefits: ["See every cost in one sheet", "Set a limit per category", "Track deposits and due dates"],
  sections: ["Set the total budget", "Split it into 8 categories", "Get 3 quotes per supplier", "Track deposits", "Review every month", "Handle overspends"].map((h, i) => ({ heading: h, bullets: [`Step ${i + 1}: write the agreed amount for ${h.toLowerCase()}`, `Check it against the total every Sunday evening`, `Keep the receipt photo in the shared folder`] })) });
const model = (critique = 0.9) => fakeModel((p) => p.includes("Propose") ? MODEL_OPPS : p.includes("Write the content") ? MODEL_CONTENT : p.includes("Critique") ? JSON.stringify({ score: critique, weaknesses: ["add a worked example"] }) : new Error("unexpected"));

describe("evaluation is differentiated and explainable", () => {
  it("helpers: concrete bullets ignore placeholders; overlap measures shared words", () => {
    expect(concreteBullets("- Key points to write\n- Example\n- Set a weekly limit and check it\n- too short")).toBe(1);
    expect(overlap("Printable checklist: moving house for retirees", "Printable checklist: moving house for retirees")).toBe(1);
    expect(overlap("Wedding budget tracker", "Allotment planting calendar")).toBe(0);
  });

  it("template drafts get different, explained scores; specificity grows with each iteration", async () => {
    await runEngine(opts(), 4);
    const all = store.ventures();
    expect(new Set(all.map(q)).size).toBeGreaterThan(1);
    for (const x of all) expect(Object.keys(x.experiments[0].evidence[0].metrics.scores!).sort()).toEqual(["completeness", "fit", "opportunity", "originality", "specificity"]);
    const multi = all.find((x) => x.experiments.length >= 2);
    if (multi) expect(multi.experiments[1].evidence[0].metrics.scores!.specificity).toBeGreaterThan(multi.experiments[0].evidence[0].metrics.scores!.specificity);
  });

  it("the catalogue only combines a problem with audiences it fits", async () => {
    const out = await digitalProduct.generateOpportunities({ seed: 7, avoid: new Set(), count: 30, model: { client: null, budget: { take: () => false } as any, log: () => {} } });
    expect(out.length).toBeGreaterThan(10);
    for (const o of out) expect(o.source).toBe("catalogue");
    expect(out.some((o) => /small landlords for new parents|book club/.test(o.title))).toBe(false);
  });
});

describe("the model interface (fake model; no network)", () => {
  it("with a model: ideas, content and critique come from the model, validated, and marked by source", async () => {
    const m = model();
    const r = await runCycle(opts({ model: m, maxModelCallsPerCycle: 10 }));
    const x = v(r.created[0]);
    expect(x.opportunity.source).toBe("model (fake)");
    expect(["Wedding budget tracker for couples", "Dog-sitting handover checklist"]).toContain(x.opportunity.title);
    const e = x.experiments[0];
    expect(e.evidence[0].source).toContain("content: model");
    expect(e.evidence[0].metrics.scores!.critique).toBe(0.9);
    expect(e.evidence[0].metrics.scores!.specificity).toBe(1);
    expect(e.evidence[0].notes).toContain("critique: add a worked example");
    const html = fs.readFileSync(path.join(store.dir, "ventures", x.id, e.id, "index.html"), "utf8");
    expect(html).toContain("Plan every cost before you book");
    expect(r.modelCalls).toBeLessThanOrEqual(10);
  });

  it("invalid answers, failures, an exhausted budget and paid models all fall back safely and are logged", async () => {
    const bad = fakeModel((p) => p.includes("Propose") ? "not json" : p.includes("Write the content") ? JSON.stringify({ headline: "<script>x</script>".repeat(20) }) : new Error("down"));
    const r = await runCycle(opts({ model: bad, maxModelCallsPerCycle: 10 }));
    expect(v(r.created[0]).opportunity.source).toBe("catalogue");
    expect(v(r.created[0]).experiments[0].evidence[0].source).toContain("content: template");
    expect(audit()).toContain('"kind":"model-invalid"');
    expect(audit()).toContain('"kind":"model-failed"');
    const budgeted = model();
    const r2 = await runCycle(opts({ model: budgeted, maxModelCallsPerCycle: 1 }));
    expect(r2.modelCalls).toBe(1);
    expect(audit()).toContain('"kind":"model-skipped"');
    const paid = fakeModel(() => MODEL_OPPS, { paid: true });
    await runCycle(opts({ model: paid, maxModelCallsPerCycle: 10 }));
    expect(paid.prompts).toEqual([]);
    expect(audit()).toContain("paid provider not approved");
  });

  it("only a loopback model address is accepted", () => {
    expect(loopbackUrl("http://127.0.0.1:11434").port).toBe("11434");
    for (const u of ["http://10.1.1.1:11434", "https://127.0.0.1", "http://api.example.com"]) expect(() => loopbackUrl(u)).toThrow("loopback");
  });
});

describe("the venture lifecycle", () => {
  const rising: VentureKind = { ...digitalProduct };
  it("drafts are built, verified and evaluated; good ones HOLD with a launch request listing the launch requirements", async () => {
    await runEngine(opts({ model: model(), maxModelCallsPerCycle: 20 }), 3);
    const waiting = store.ventures().filter((x) => x.status === "awaiting-launch-approval");
    expect(waiting.length).toBeGreaterThan(0);
    const req = store.approvals().find((a) => a.ventureId === waiting[0].id)!;
    expect(req.action).toBe("launch-public");
    expect(req.summary).toContain("A place to host the static page");
    const e = waiting[0].experiments.at(-1)!;
    expect(e.assets.map((a) => a.name)).toContain("launch-checklist.md");
    expect(store.ventures().flatMap((x) => x.decisions).some((d) => d.kind === "SCALE")).toBe(false);
    void rising;
  });

  it("weak drafts are archived (reversible) without any approval", async () => {
    const weak: VentureKind = { ...digitalProduct, build: async (o, p, it, write) => { write("index.html", "<p>x</p>"); return { contentSource: "template" }; } };
    const r = await runCycle(opts({ kinds: [weak] }));
    await runEngine(opts({ kinds: [weak] }), 3);
    const x = v(r.created[0]);
    expect(x.status).toBe("archived");
    expect(x.decisions.at(-1)).toMatchObject({ kind: "KILL", basis: "simulated" });
    expect(store.approvals().filter((a) => a.ventureId === x.id)).toEqual([]);
  });

  async function launched(): Promise<string> {
    await runEngine(opts({ model: model(), maxModelCallsPerCycle: 20 }), 3);
    const req = store.approvals().find((a) => a.action === "launch-public" && a.status === "pending")!;
    decideApproval(store, req.id, true, NOW);
    await runCycle(opts());
    expect(v(req.ventureId).status).toBe("launched");
    return req.ventureId;
  }

  it("actual evidence only for a launched venture; SCALE / IMPROVE / KILL (approval needed) on real numbers", async () => {
    await runCycle(opts());
    expect(() => recordActual(store, store.ventures()[0].id, { visitors: 1 }, "analytics", NOW)).toThrow("launched venture");
    const id = await launched();
    expect(() => recordActual(store, id, { scores: {} } as any, "analytics", NOW)).toThrow("simulated estimates");
    expect(() => recordActual(store, id, { visitors: 1 }, "", NOW)).toThrow("source:");
    recordActual(store, id, { visitors: 150, signups: 1 }, "web analytics", NOW);
    await runCycle(opts());
    expect(v(id).decisions.at(-1)).toMatchObject({ kind: "IMPROVE", basis: "actual" });
    recordActual(store, id, { visitors: 400, signups: 30, sales: 3, revenueUsd: 27 }, "payment provider", NOW);
    await runCycle(opts());
    expect(v(id).decisions.at(-1)).toMatchObject({ kind: "SCALE", basis: "actual" });
    recordActual(store, id, { visitors: 500, signups: 0 }, "web analytics", NOW);
    const r = await runCycle(opts());
    expect(v(id).status).toBe("awaiting-shutdown-approval");
    decideApproval(store, r.approvalsRequested[0], false, NOW);
    await runCycle(opts());
    expect(v(id).status).toBe("launched"); // a denied shutdown keeps it running
    expect(totals(store.ventures(), store.approvals()).actualRevenueUsd).toBe(27);
    expect(renderDashboard(store.ventures(), store.approvals(), NOW)).toContain("is not customer or financial data");
  });
});

describe("resource limits, stop controls and scheduling", () => {
  it("STOP blocks cycles and ends a run early; resume clears it", async () => {
    stop(store.dir, "maintenance", NOW);
    await expect(runCycle(opts())).rejects.toThrow("stopped");
    let out = ""; const cli = (...a: string[]) => main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW });
    fs.renameSync(store.dir, path.join(DIR, ".automaton-ventures"));
    store = new Store(path.join(DIR, ".automaton-ventures"));
    expect(await cli("resume")).toBe(0); expect(out).toContain("resumed");
    const ke: VentureKind = { ...digitalProduct, generateOpportunities: async (c) => { if (c.seed > 7919) stop(store.dir, "owner pressed stop", NOW); return digitalProduct.generateOpportunities(c); } };
    const rs = await runEngine(opts({ kinds: [ke] }), 5);
    expect(rs.length).toBe(2);
  });

  it("one run at a time; daily cycle budget; spending refused", async () => {
    let inner: Promise<unknown> | null = null;
    await withLock(store.dir, async () => { inner = withLock(store.dir, async () => 1); await expect(inner).rejects.toThrow("another run is in progress"); });
    await runCycle(opts({ maxCyclesPerDay: 1 }));
    await expect(runCycle(opts({ maxCyclesPerDay: 1 }))).rejects.toThrow("daily cycle budget");
    await expect(runCycle(opts({ limits: { ...DEFAULT_LIMITS, spendLimitUsd: 1 as 0 } }))).rejects.toThrow("spending is not supported");
  });

  it("configuration: safe defaults; hard caps and paid providers refused", () => {
    expect(DEFAULT_CONFIG).toMatchObject({ model: { provider: "none" }, schedule: { enabled: false } });
    const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    expect(parseConfig(JSON.stringify(base))).toEqual(base);
    for (const [change, msg] of [
      [{ model: { ...base.model, provider: "anthropic" } }, "must be \"none\", \"ollama\" or \"claude\""],
      [{ limits: { ...base.limits, maxActiveVentures: HARD_LIMITS.maxActiveVentures + 1 } }, "maxActiveVentures"],
      [{ limits: { ...base.limits, spendLimitUsd: 10 } }, "spendLimitUsd must be 0"],
      [{ schedule: { enabled: "yes", maxCyclesPerDay: 6 } }, "schedule.enabled"],
      [{ extra: true }, "unknown key extra"],
    ] as [object, string][]) expect(() => parseConfig(JSON.stringify({ ...base, ...change }))).toThrow(msg);
  });

  it("the CLI: scheduled-run does nothing while the schedule is disabled; run, status, dashboard work", async () => {
    let out = ""; const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null }); };
    expect(await cli("scheduled-run")).toBe(0); expect(out).toContain("schedule is disabled");
    expect(await cli("run", "2")).toBe(0); expect(out).toMatch(/cycle 2:/);
    expect(await cli("status")).toBe(0); expect(out).toContain("stopped: no");
    expect(await cli("schedule-unit")).toBe(0); expect(out).toContain("NoNewPrivileges=yes");
    expect(await cli("dashboard")).toBe(0); expect(fs.statSync(out.trim()).mode & 0o777).toBe(0o600);
    expect(await cli("bogus")).toBe(2);
  });
});

describe("isolation", () => {
  it("imports only its own files and Node built-ins (plus the pinned Anthropic SDK in claude.ts only); the only raw fetch is the loopback-checked local model in the CLI", () => {
    const SRC = path.resolve(__dirname, "../..");
    const DIRS = [path.join(SRC, "venture-engine"), path.join(SRC, "venture-engine", "kinds"), path.join(SRC, "venture-engine", "blueprints")];
    for (const d of DIRS) for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(d, f), "utf8");
      for (const m of src.matchAll(/from "([^"]+)"/g)) expect(/^\.{1,2}\/[a-z/-]+\.js$/.test(m[1]) || /^node:(fs|os|path|crypto)$/.test(m[1]) || (f === "claude.ts" && m[1] === "@anthropic-ai/sdk") || (f === "zip.ts" && m[1] === "node:zlib"), `${f}: ${m[1]}`).toBe(true);
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(/child_process|https?\.request|net\.connect|eval\(|new Function|wallet|solana|viem|broker|placeorder|docker|sudo/i.test(code), f).toBe(false);
      expect((code.match(/\bfetch\(/g) ?? []).length, f).toBe(f === "cli.ts" ? 1 : 0);
    }
    expect(fs.readFileSync(path.join(SRC, "venture-engine", "cli.ts"), "utf8")).toContain("loopbackUrl(url); return fetch(url, init)");
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(SRC).filter((f) => f.endsWith(".ts") && !f.startsWith(DIRS[0] + path.sep) && !f.includes(`${path.sep}__tests__${path.sep}`))) expect(fs.readFileSync(f, "utf8").includes("venture-engine"), path.relative(SRC, f)).toBe(false);
  });
});
