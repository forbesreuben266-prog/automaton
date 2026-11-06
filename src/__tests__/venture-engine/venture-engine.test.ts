import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../venture-engine/cli.js";
import { renderDashboard, totals } from "../../venture-engine/dashboard.js";
import { DEFAULT_LIMITS, decideApproval, recordActual, runCycle, runEngine } from "../../venture-engine/engine.js";
import { digitalProduct } from "../../venture-engine/kinds/digital-product.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture, VentureKind } from "../../venture-engine/types.js";

let DIR = "";
let store: Store;
const NOW = new Date("2026-11-08T09:00:00Z");
const opts = (kinds: VentureKind[] = [digitalProduct]) => ({ store, kinds, now: () => NOW });
beforeEach(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ve-")); store = new Store(path.join(DIR, "data")); });
afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));
const v = (id: string): Venture => store.ventures().find((x) => x.id === id)!;

describe("venture engine: the end-to-end loop (digital products, offline)", () => {
  it("generates and selects opportunities, builds real assets, verifies them and evaluates (simulated)", () => {
    const r = runCycle(opts());
    expect(r.created.length).toBe(DEFAULT_LIMITS.maxNewVenturesPerCycle);
    for (const id of r.created) {
      const x = v(id);
      expect(x.opportunity.score).toBeGreaterThanOrEqual(0.5);
      expect(x.status).toBe("built");
      const e = x.experiments[0];
      expect(e.assets.map((a) => a.name).sort()).toEqual(["experiment.json", "index.html", "pricing.json", "product-outline.md"]);
      expect(e.verified).toBe(true);
      expect(e.checks.every((c) => c.passed)).toBe(true);
      expect(e.evidence).toHaveLength(1);
      expect(e.evidence[0]).toMatchObject({ kind: "simulated" });
      const html = fs.readFileSync(path.join(store.dir, "ventures", id, e.id, "index.html"), "utf8");
      expect(html).toContain("Pre-launch draft");
      expect(html).not.toMatch(/<script|https?:/);
      expect(fs.statSync(path.join(store.dir, "ventures", id, e.id, "index.html")).mode & 0o777).toBe(0o600);
    }
  });

  it("iterates with IMPROVE until quality is reached, then HOLDs and asks to launch; never SCALE on simulated evidence", () => {
    // A module whose simulated quality rises per iteration (0.6, 0.7, 0.8) exercises IMPROVE -> HOLD.
    const rising: VentureKind = { ...digitalProduct, simulate: (o, c, it) => ({ qualityScore: [0.6, 0.7, 0.8][Math.min(it, 3) - 1] }) };
    const r2 = runEngine(opts([rising]), 4).flatMap((r) => r.decisions);
    expect(r2.filter((d) => d.kind === "IMPROVE" && d.basis === "simulated").length).toBeGreaterThan(0);
    expect(store.ventures().some((x) => x.experiments.length === 3 && x.status === "awaiting-launch-approval")).toBe(true);
    fs.rmSync(store.dir, { recursive: true, force: true }); store = new Store(path.join(DIR, "data"));
    const reports = runEngine(opts(), 6);
    const all = [...r2, ...reports.flatMap((r) => r.decisions)];
    expect(all.some((d) => d.kind === "SCALE")).toBe(false);
    const waiting = store.ventures().filter((x) => x.status === "awaiting-launch-approval");
    expect(waiting.length).toBeGreaterThan(0);
    const reqs = store.approvals().filter((a) => a.action === "launch-public" && a.status === "pending");
    expect(reqs.map((a) => a.ventureId).sort()).toEqual(waiting.map((x) => x.id).sort());
    for (const x of store.ventures()) expect(x.experiments.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxIterationsPerVenture);
    expect(store.ventures().filter((x) => !["archived", "shut-down"].includes(x.status)).length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxActiveVentures);
    expect(new Set(store.ventures().map((x) => x.opportunity.title)).size).toBe(store.ventures().length);
  });

  it("low-quality drafts are KILLed by archiving (reversible); failed checks are fed back into the next plan", () => {
    const bad: VentureKind = { ...digitalProduct, id: "digital-product",
      build: (o, p, it, write) => { write("index.html", "<p>broken</p>"); }, simulate: () => ({ qualityScore: 0.3 }) };
    const r1 = runCycle(opts([bad]));
    const id = r1.created[0];
    expect(v(id).experiments[0].verified).toBe(false);
    runCycle(opts([bad]));
    expect(v(id).status).toBe("archived");
    expect(v(id).decisions.at(-1)).toMatchObject({ kind: "KILL", basis: "simulated" });
    expect(store.approvals().filter((a) => a.ventureId === id)).toEqual([]);
  });
});

describe("venture engine: approvals and actual evidence", () => {
  function launchedVenture(): string {
    runEngine(opts(), 6);
    const req = store.approvals().find((a) => a.action === "launch-public" && a.status === "pending")!;
    decideApproval(store, req.id, true, NOW);
    runCycle(opts());
    expect(v(req.ventureId).status).toBe("launched");
    return req.ventureId;
  }

  it("a launch only happens with the owner's approval; a denial returns the venture to built", () => {
    runEngine(opts(), 6);
    const [a, b] = store.approvals().filter((x) => x.status === "pending");
    decideApproval(store, a.id, false, NOW);
    runCycle(opts());
    expect(["built", "awaiting-launch-approval", "archived"]).toContain(v(a.ventureId).status);
    expect(v(a.ventureId).status).not.toBe("launched");
    expect(() => decideApproval(store, a.id, true, NOW)).toThrow("already denied");
    expect(b === undefined || v(b.ventureId).status === "awaiting-launch-approval").toBe(true);
  });

  it("actual evidence can be recorded only for a launched venture, with a source and valid numbers", () => {
    runCycle(opts());
    const draft = store.ventures()[0].id;
    expect(() => recordActual(store, draft, { visitors: 10 }, "analytics", NOW)).toThrow("only be recorded for a launched venture");
    const id = launchedVenture();
    expect(() => recordActual(store, id, { visitors: 10 }, "", NOW)).toThrow("source:");
    expect(() => recordActual(store, id, { visitors: -1 }, "analytics", NOW)).toThrow("non-negative");
    expect(() => recordActual(store, id, { visitors: 5, signups: 9 }, "analytics", NOW)).toThrow("cannot exceed");
    expect(() => recordActual(store, id, { qualityScore: 0.9 } as any, "analytics", NOW)).toThrow();
  });

  it("decisions on actual evidence: SCALE on real profit, IMPROVE on low conversion, KILL needs approval", () => {
    const id = launchedVenture();
    runCycle(opts());
    expect(v(id).decisions.at(-1)).toMatchObject({ kind: "HOLD", basis: "none" });
    recordActual(store, id, { visitors: 150, signups: 1 }, "web analytics", NOW);
    runCycle(opts());
    expect(v(id).decisions.at(-1)).toMatchObject({ kind: "IMPROVE", basis: "actual" });
    recordActual(store, id, { visitors: 400, signups: 30, sales: 3, revenueUsd: 27, costUsd: 0 }, "payment provider", NOW);
    runCycle(opts());
    expect(v(id).decisions.at(-1)).toMatchObject({ kind: "SCALE", basis: "actual" });
    recordActual(store, id, { visitors: 500, signups: 0 }, "web analytics", NOW);
    const r = runCycle(opts());
    expect(v(id).decisions.at(-1)).toMatchObject({ kind: "KILL", basis: "actual" });
    expect(v(id).status).toBe("awaiting-shutdown-approval");
    const req = store.approvals().find((a) => a.id === r.approvalsRequested[0])!;
    expect(req.action).toBe("irreversible-shutdown");
    decideApproval(store, req.id, true, NOW);
    runCycle(opts());
    expect(v(id).status).toBe("shut-down");
  });

  it("totals and the dashboard count only actual results and label simulated estimates", () => {
    const id = launchedVenture();
    recordActual(store, id, { visitors: 50, sales: 1, revenueUsd: 9 }, "payment provider", NOW);
    expect(totals(store.ventures(), store.approvals())).toMatchObject({ actualRevenueUsd: 9, launched: 1 });
    const html = renderDashboard(store.ventures(), store.approvals(), NOW);
    expect(html).toContain("revenue $9");
    expect(html).toContain("is not customer or financial data");
    expect(html).not.toMatch(/<script|https?:/);
  });
});

describe("venture engine: limits, containment and isolation", () => {
  it("refuses spending, out-of-range cycle counts and escaping asset names", () => {
    expect(() => runCycle({ ...opts(), limits: { ...DEFAULT_LIMITS, spendLimitUsd: 5 as 0 } })).toThrow("spending is not supported");
    expect(() => runEngine(opts(), 11)).toThrow("cycles: 1 to 10");
    const escape: VentureKind = { ...digitalProduct, build: (o, p, i, write) => write("../../evil.txt", "x") };
    const r = runCycle(opts([escape]));
    const e = v(r.created[0]).experiments[0];
    expect(e.verified).toBe(false);
    expect(e.checks.find((c) => c.name === "build")!.detail).toContain("asset name not allowed");
    expect(fs.existsSync(path.join(DIR, "evil.txt")) || fs.existsSync(path.join(store.dir, "evil.txt"))).toBe(false);
  });

  it("the CLI drives the loop and records the owner's decisions", async () => {
    let out = "";
    const cli = async (...a: string[]) => { out = ""; const code = await main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW }); return code; };
    expect(await cli("run", "4")).toBe(0);
    expect(out).toMatch(/cycle 4:/);
    expect(await cli("status")).toBe(0);
    expect(out).toContain("actual results (owner-recorded): revenue $0");
    expect(await cli("approvals")).toBe(0);
    expect(await cli("dashboard")).toBe(0);
    expect(fs.statSync(out.trim()).mode & 0o777).toBe(0o600);
    expect(await cli("record", "ven-00000000", "--visitors", "1", "--source", "x")).toBe(1);
    expect(await cli("bogus")).toBe(2);
  });

  it("imports only its own files and Node built-ins; no network, process, money or trading APIs; isolated from other code", () => {
    const SRC = path.resolve(__dirname, "../..");
    const DIRS = [path.join(SRC, "venture-engine"), path.join(SRC, "venture-engine", "kinds")];
    for (const d of DIRS) for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(d, f), "utf8");
      for (const m of src.matchAll(/from "([^"]+)"/g)) expect(/^\.{1,2}\/[a-z/-]+\.js$/.test(m[1]) || /^node:(fs|os|path|crypto)$/.test(m[1]), `${f}: ${m[1]}`).toBe(true);
      for (const m of src.matchAll(/from "(\.\.\/[^"]+)"/g)) expect(d.endsWith("kinds") && /^\.\.\/types\.js$/.test(m[1]), `${f}: ${m[1]}`).toBe(true);
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(/child_process|\bfetch\(|https?\.request|net\.connect|eval\(|new Function|wallet|solana|viem|broker|placeorder|docker|sudo/i.test(code), f).toBe(false);
    }
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(SRC).filter((f) => f.endsWith(".ts") && !f.startsWith(DIRS[0] + path.sep) && !f.includes(`${path.sep}__tests__${path.sep}`))) {
      expect(fs.readFileSync(f, "utf8").includes("venture-engine"), path.relative(SRC, f)).toBe(false);
    }
  });
});
