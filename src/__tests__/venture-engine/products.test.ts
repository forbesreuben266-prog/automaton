import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csvCell, DISCLAIMER } from "../../venture-engine/blueprints/common.js";
import { main } from "../../venture-engine/cli.js";
import { decideApproval, runCycle } from "../../venture-engine/engine.js";
import { digitalProduct } from "../../venture-engine/kinds/digital-product.js";
import { fakeModel } from "../../venture-engine/model.js";
import { archiveProduct, buildProduct, checkProduct, confirmationCode, markLive, parseCsv, parseOutline, productReport, qa, realDecision, recordValidation, requestLaunch, signOff, type Product } from "../../venture-engine/products.js";
import { Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const NOW = new Date("2026-11-09T10:00:00Z");
const LATER = new Date("2026-11-20T10:00:00Z");
let DIR = "";
let store: Store;
let realFetch: typeof fetch;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vp-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access in a test"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

/** Test fixture shaped like the VPS venture ven-9e27315f (freelance invoicing). Not the real record. */
const invoicingVenture = (status: Venture["status"] = "built"): Venture => ({
  id: "ven-9e27315f", status, experiments: [], decisions: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  opportunity: { id: "opp-00000001", kind: "digital-product", title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms", audience: "freelancers",
    offer: "A template pack that helps freelancers with getting paid on time with clear terms.", estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: NOW.toISOString(), source: "fixture (test only)" },
});
const dirOf = (p: Product) => path.join(store.dir, "ventures", p.ventureId, p.id);
const read = (p: Product, n: string) => fs.readFileSync(path.join(dirOf(p), n), "utf8");
const portfolioBytes = () => fs.readFileSync(path.join(store.dir, "portfolio.json"));
/** The owner's approval, as typed at an interactive terminal. */
const approve = (id: string) => { const p = store.products().find((x) => x.id === id)!; return signOff(store, id, { confirm: confirmationCode(p), price: `${p.currency} ${p.price}`, note: "read qa-report.md; price OK", interactive: true }, NOW); };

describe("product build: freelance invoicing (first test case)", () => {
  it("builds a complete, editable kit, a landing page and a tracking plan that pass every check", () => {
    store.saveVentures([invoicingVenture()]);
    const before = portfolioBytes();
    const p = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    expect(p.blueprint).toBe("freelance-invoicing");
    expect(p.status).toBe("ready");
    expect(p.checks.filter((c) => !c.passed)).toEqual([]);
    expect(p.checks.map((c) => c.name)).toEqual(["files-present", "links", "no-scripts-or-external-resources", "complete-content", "csv-formula-safety", "no-misleading-claims", "sensitive-advice", "landing-page", "tracking-plan", "instructions"]);
    expect(p.deliverables).toEqual(["start-here.md", "invoice-template.html", "invoice-tracker.csv", "client-register.csv", "payment-terms.md", "reminder-emails.md", "invoicing-checklist.md"]);
    expect(p.files.map((f) => f.name)).toEqual([...p.deliverables, "landing.html", "tracking-plan.json", "qa-report.md"]);
    for (const f of p.files) expect(fs.statSync(path.join(dirOf(p), f.name)).mode & 0o777).toBe(0o600);
    const tracker = parseCsv(read(p, "invoice-tracker.csv"));
    expect(tracker[0]).toContain("Due date");
    expect(new Set(tracker.filter((r) => r.length > 1).map((r) => r.length)).size).toBe(1);
    const landing = read(p, "landing.html");
    expect(landing).toContain("Proposed price: <strong>£12</strong>");
    expect(landing).toContain('data-conversion="signup"');
    expect(landing).toContain('data-conversion="preorder"');
    expect(landing).toMatch(/Pre-launch preview/);
    expect(landing).not.toMatch(/<script|https?:\/\//i);
    expect(JSON.parse(read(p, "tracking-plan.json")).status).toMatch(/no data/);
    expect(read(p, "qa-report.md")).toMatch(/\| sensitive-advice \| pass \|/);
    expect(p.review.length).toBeGreaterThan(0);
    expect(portfolioBytes().equals(before)).toBe(true); // building never rewrites venture records
    expect(store.products()).toHaveLength(1);
  });

  it("files are usable: the invoice is editable and calculates offline (one CSP-locked script); CSVs open safely; every file is explained", () => {
    store.saveVentures([invoicingVenture()]);
    const p = buildProduct(store, "ven-9e27315f", { now: NOW });
    const inv = read(p, "invoice-template.html");
    expect(inv).toMatch(/contenteditable="true"/);
    expect(inv).toMatch(/@media print/);
    expect(inv.match(/<script/g)).toHaveLength(1);
    expect(inv).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
    expect(inv).not.toMatch(/\son[a-z]+=|<script src|https?:\/\//i);
    expect(p.checks.find((c) => c.name === "no-scripts-or-external-resources")!.detail).toMatch(/invoice-template\.html: one inline calculator, no network or storage APIs, CSP-locked by hash/);
    for (const n of p.deliverables.filter((x) => x !== "start-here.md")) expect(read(p, "start-here.md")).toContain(n);
    expect(read(p, "payment-terms.md")).toContain(DISCLAIMER);
    expect(read(p, "reminder-emails.md").match(/^## \d\./gm)).toHaveLength(4);
    expect(p.templates).toEqual(["invoice-template.html", "invoice-tracker.csv", "client-register.csv", "payment-terms.md", "reminder-emails.md"]);
  });
});

describe("product build: generic blueprint (any venture)", () => {
  it("a thin, placeholder outline gives an honest 'needs-work' product instead of padded content", async () => {
    await runCycle({ store, kinds: [digitalProduct], now: () => NOW, limits: { maxActiveVentures: 5, maxNewVenturesPerCycle: 2, maxIterationsPerVenture: 3, maxCyclesPerRun: 10, spendLimitUsd: 0 } });
    const v = store.ventures().find((x) => !/invoic/i.test(x.opportunity.title))!;
    const p = buildProduct(store, v.id, { now: NOW });
    expect(p.blueprint).toBe("generic");
    expect(p.status).toBe("needs-work");
    expect(p.checks.find((c) => c.name === "complete-content")!.detail).toMatch(/concrete points/);
    expect(read(p, "guide.md")).not.toMatch(/Key points to write/);
  });

  it("a model-written outline (fake model, no network) gives a complete generic product", async () => {
    const opps = JSON.stringify({ opportunities: [{ title: "Wedding budget tracker for couples", problem: "keeping wedding costs under control", audience: "engaged couples", offer: "A template pack to plan and track every wedding cost.", format: "template pack", demand: 0.8, risk: 0.1, rationale: "x" }] });
    const content = JSON.stringify({ headline: "Plan every cost before you book", subheadline: "A clear system for engaged couples.", benefits: ["See every cost in one sheet", "Set a limit per category", "Track deposits and due dates"],
      sections: ["Set the total budget", "Split it into 8 categories", "Get 3 quotes per supplier", "Track deposits", "Review every month", "Handle overspends"].map((h, i) => ({ heading: h, bullets: [`Step ${i + 1}: write the agreed amount for ${h.toLowerCase()}`, "Check it against the total every Sunday evening", "Keep the receipt photo in the shared folder"] })) });
    const model = fakeModel((pr) => (pr.includes("Propose") ? opps : pr.includes("Write the content") ? content : pr.includes("Critique") ? JSON.stringify({ score: 0.9, weaknesses: [] }) : new Error("unexpected")));
    await runCycle({ store, kinds: [digitalProduct], now: () => NOW, model, maxModelCallsPerCycle: 10, limits: { maxActiveVentures: 5, maxNewVenturesPerCycle: 1, maxIterationsPerVenture: 3, maxCyclesPerRun: 10, spendLimitUsd: 0 } });
    const v = store.ventures()[0];
    const p = buildProduct(store, v.id, { now: NOW, price: 7.5 });
    expect(p.blueprint).toBe("generic");
    expect(p.checks.filter((c) => !c.passed)).toEqual([]);
    expect(p.status).toBe("ready");
    expect(parseCsv(read(p, "action-tracker.csv"))).toHaveLength(19);
    expect(read(p, "landing.html")).toContain("Proposed price: <strong>$7.50</strong>");
  });

  it("parseOutline drops placeholder points and empty sections", () => {
    expect(parseOutline("# T\n\n## 1. A\n\n- Key points to write\n- Example\n\n## 2. B\n\n- Send invoices on the day work is delivered\n")).toEqual([{ heading: "B", bullets: ["Send invoices on the day work is delivered"] }]);
  });
});

describe("product QA detects real problems", () => {
  const good = () => {
    store.saveVentures([invoicingVenture()]);
    return buildProduct(store, "ven-9e27315f", { now: NOW });
  };
  const run = (files: Record<string, string>, templates: string[] = []) => {
    const names = Object.keys(files);
    return qa((n) => files[n] ?? null, names.map((n) => ({ name: n, template: templates.includes(n) })), null).checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
  };
  it("each detector fires on a crafted bad package", () => {
    const p = good();
    const base: Record<string, string> = Object.fromEntries(p.files.filter((f) => f.name !== "qa-report.md").map((f) => [f.name, read(p, f.name)]));
    const tmpl = p.templates as string[];
    expect(run(base, tmpl)).toEqual([]);
    const fails = (patch: Record<string, string>, check: string, re: RegExp) => {
      const f = run({ ...base, ...patch }, tmpl).find((x) => x.startsWith(check));
      expect(f, `${check} should fail`).toBeDefined();
      expect(f!).toMatch(re);
    };
    fails({ "reminder-emails.md": "" }, "files-present", /reminder-emails\.md/);
    fails({ "landing.html": base["landing.html"].replace('href="#preorder"', 'href="#nowhere"') }, "links", /no such anchor/);
    fails({ "landing.html": base["landing.html"].replace('href="#top"', 'href="https://example.com"') }, "links", /external links are not allowed/);
    fails({ "invoicing-checklist.md": base["invoicing-checklist.md"] + "\n[next](missing-file.md)\n" }, "links", /file not in the package/);
    fails({ "landing.html": base["landing.html"].replace("</body>", "<script>alert(1)</script></body>") }, "no-scripts-or-external-resources", /landing\.html/);
    fails({ "invoicing-checklist.md": base["invoicing-checklist.md"] + "\n- TODO write the rest\n" }, "complete-content", /unfinished text/);
    fails({ "invoicing-checklist.md": base["invoicing-checklist.md"] + "\nCall [[Client]]\n" }, "complete-content", /fill-in field in a file that is not a template/);
    fails({ "invoicing-checklist.md": base["invoicing-checklist.md"] + "\n## 6. Empty section\n" }, "complete-content", /empty section/);
    fails({ "client-register.csv": base["client-register.csv"] + "only,three,cells\r\n" }, "complete-content", /row 3 has 3 cells/);
    fails({ "invoice-tracker.csv": base["invoice-tracker.csv"].replace("Example Client Ltd", "=HYPERLINK(\"x\")") }, "csv-formula-safety", /formulas/);
    for (const [claim, why] of [["We guarantee you will be paid on time.", /guaranteed outcome/], ["Used by 5,000 freelancers.", /invented customer numbers/], ["The best-selling invoicing kit.", /ranking/],
      ["Only 3 left at this price!", /scarcity/], ["Earn £5,000 more each month.", /income claim/], ['"This kit changed how I work completely" - Sarah', /testimonial/], ["Get paid 40% faster.", /statistic/], ["Completely risk-free.", /risk-free/]] as [string, RegExp][]) {
      fails({ "start-here.md": base["start-here.md"] + `\n${claim}\n` }, "no-misleading-claims", why);
    }
    fails({ "invoicing-checklist.md": base["invoicing-checklist.md"].replace(DISCLAIMER, "General information.") + "\n- [ ] Charge statutory interest on every late invoice\n" }, "sensitive-advice", /without the disclaimer/);
    fails({ "payment-terms.md": base["payment-terms.md"] + "\nYou are legally entitled to charge 8% interest.\n" }, "sensitive-advice", /states a legal or financial position as fact/);
    fails({ "landing.html": base["landing.html"].replace("untested price hypothesis", "great price") }, "landing-page", /price labelled as a hypothesis/);
    fails({ "landing.html": base["landing.html"].replace('data-conversion="signup"', "") }, "landing-page", /signup action/);
    fails({ "start-here.md": base["start-here.md"].replace(/`reminder-emails\.md`/g, "the emails file") }, "instructions", /reminder-emails\.md/);
    fails({ "tracking-plan.json": "{}" }, "tracking-plan", /conversion actions/);
  });
  it("csvCell neutralises formulas and quotes separators", () => {
    expect(csvCell("=1+1")).toBe("'=1+1"); expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)"); expect(csvCell("-x")).toBe("'-x"); expect(csvCell("-12.5")).toBe("-12.5");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});

describe("failed products can be improved or archived without corrupting records", () => {
  it("check detects changed or deleted files; improve makes a new version and keeps the old one intact; archive keeps files", () => {
    store.saveVentures([invoicingVenture()]);
    const v1 = buildProduct(store, "ven-9e27315f", { now: NOW });
    fs.appendFileSync(path.join(dirOf(v1), "payment-terms.md"), "\nTODO\n");
    const c1 = checkProduct(store, v1.id, NOW);
    expect(c1.status).toBe("needs-work");
    expect(c1.checks.find((c) => c.name === "files-unchanged")!.detail).toMatch(/payment-terms\.md/);
    fs.rmSync(path.join(dirOf(v1), "client-register.csv"));
    expect(checkProduct(store, v1.id, NOW).checks.find((c) => c.name === "files-present")!.detail).toMatch(/client-register\.csv/);
    const portfolio = portfolioBytes();
    const v2 = buildProduct(store, "ven-9e27315f", { now: LATER, previous: store.products()[0], price: 15 });
    expect(v2).toMatchObject({ version: 2, previous: v1.id, status: "ready", price: 15 });
    expect(store.products().find((x) => x.id === v1.id)!.files).toEqual(v1.files); // the old record keeps its files and hashes
    expect(fs.existsSync(path.join(dirOf(v1), "start-here.md"))).toBe(true);
    const a = archiveProduct(store, v1.id, "superseded by version 2", LATER);
    expect(a).toMatchObject({ status: "archived", archivedReason: "superseded by version 2" });
    expect(fs.readdirSync(dirOf(v1)).length).toBeGreaterThan(5); // nothing deleted
    expect(() => archiveProduct(store, v1.id, "again", LATER)).toThrow(/already archived/);
    expect(() => archiveProduct(store, v2.id, "", LATER)).toThrow(/reason/);
    expect(portfolioBytes().equals(portfolio)).toBe(true);
    expect(store.products()).toHaveLength(2);
  });
});

describe("launch gate and real validation: no evidence can be invented", () => {
  const live = () => {
    store.saveVentures([invoicingVenture()]);
    const p = buildProduct(store, "ven-9e27315f", { now: NOW });
    expect(() => markLive(store, p.id, "https://example.com/kit", NOW)).toThrow(/no approved launch/);
    expect(() => recordValidation(store, p.id, { periodStart: "2026-11-09", periodEnd: "2026-11-09", visits: 1, signups: 0, sales: 0, revenue: 0, source: "hosting dashboard" }, NOW)).toThrow(/not live/);
    expect(() => requestLaunch(store, p.id, NOW)).toThrow(/no current owner sign-off/);
    expect(() => signOff(store, p.id, { confirm: confirmationCode(p), price: "USD 12", note: "", interactive: true }, NOW)).toThrow(/note/);
    approve(p.id);
    const req = requestLaunch(store, p.id, NOW);
    expect(req).toMatchObject({ action: "launch-public", status: "pending", ventureId: "ven-9e27315f" });
    expect(req.summary).toMatch(/Approving does not publish anything/);
    expect(requestLaunch(store, p.id, NOW).id).toBe(req.id); // no duplicate requests
    expect(store.ventures()[0].status).toBe("awaiting-launch-approval");
    expect(() => markLive(store, p.id, "https://example.com/kit", NOW)).toThrow(/no approved launch/);
    decideApproval(store, req.id, true, NOW);
    expect(() => markLive(store, p.id, "http://example.com/kit", NOW)).toThrow(/https/);
    expect(() => markLive(store, p.id, "https://user:pw@example.com/kit", NOW)).toThrow(/credentials/);
    const l = markLive(store, p.id, "https://example.com/kit", NOW);
    expect(l.status).toBe("live");
    expect(store.ventures()[0].status).toBe("launched");
    return l;
  };

  it("a needs-work product cannot be proposed for launch", async () => {
    await runCycle({ store, kinds: [digitalProduct], now: () => NOW });
    const p = buildProduct(store, store.ventures().find((x) => !/invoic/i.test(x.opportunity.title))!.id, { now: NOW });
    expect(p.status).toBe("needs-work");
    expect(() => requestLaunch(store, p.id, NOW)).toThrow(/only a product that passed every check/);
  });

  it("records are refused before going live, in the future, overlapping, inconsistent or unsourced", () => {
    const p = live();
    const base = { periodStart: "2026-11-10", periodEnd: "2026-11-16", visits: 120, signups: 6, sales: 1, revenue: 12, source: "hosting dashboard and payment provider export" };
    expect(() => recordValidation(store, p.id, { ...base, periodStart: "2026-11-01" }, LATER)).toThrow(/before the product went live/);
    expect(() => recordValidation(store, p.id, { ...base, periodEnd: "2026-12-01" }, LATER)).toThrow(/future/);
    expect(() => recordValidation(store, p.id, { ...base, signups: 500 }, LATER)).toThrow(/signups cannot exceed visits/);
    expect(() => recordValidation(store, p.id, { ...base, sales: 0 }, LATER)).toThrow(/revenue without sales/);
    expect(() => recordValidation(store, p.id, { ...base, source: "me" }, LATER)).toThrow(/--source/);
    expect(() => recordValidation(store, p.id, { ...base, visits: 1.5 }, LATER)).toThrow(/whole number/);
    recordValidation(store, p.id, base, LATER);
    expect(() => recordValidation(store, p.id, { ...base, periodStart: "2026-11-15", periodEnd: "2026-11-18" }, LATER)).toThrow(/overlaps/);
  });

  it("evidence files are hashed (not copied); real numbers reach the engine; reports keep real and simulated apart", () => {
    const p = live();
    expect(productReport(store, store.products()[0])).toMatch(/none recorded: no customer activity is known/);
    expect(realDecision(store.products()[0])).toMatch(/no results recorded yet/);
    const ev = path.join(DIR, "form-export.csv");
    fs.writeFileSync(ev, "date,submissions\n2026-11-10,3\n2026-11-11,3\n");
    const link = path.join(DIR, "link.csv"); fs.symlinkSync(ev, link);
    expect(() => recordValidation(store, p.id, { periodStart: "2026-11-10", periodEnd: "2026-11-16", visits: 60, signups: 6, sales: 0, revenue: 0, source: "form provider export", evidenceFile: link }, LATER)).toThrow(/links are not followed/);
    const r1 = recordValidation(store, p.id, { periodStart: "2026-11-10", periodEnd: "2026-11-16", visits: 60, signups: 6, sales: 0, revenue: 0, source: "form provider export", evidenceFile: ev }, LATER);
    expect(r1).toMatchObject({ verification: "evidence-file", evidence: { name: "form-export.csv", bytes: fs.statSync(ev).size } });
    expect(r1.evidence!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const r2 = recordValidation(store, p.id, { periodStart: "2026-11-17", periodEnd: "2026-11-19", visits: 50, signups: 1, sales: 1, revenue: 12, source: "hosting dashboard; payment provider" }, LATER);
    expect(r2.verification).toBe("owner-reported");
    expect(store.ventures()[0].experiments).toEqual([]); // this fixture has no experiment, so nothing is mirrored (and nothing crashes)
    const rep = productReport(store, store.products()[0]);
    expect(rep).toMatch(/REAL EVIDENCE[\s\S]*2 period\(s\): 1 verified by evidence file, 1 owner-reported only[\s\S]*visits 110, signups 7 \(6\.4%\), sales 1, revenue USD 12/);
    expect(rep).toMatch(/decision \(pre-registered rules, real evidence only\): continue: 1 sale/);
    expect(rep).toMatch(/SIMULATED \(engine estimates; not customer or financial data\)/);
    expect(fs.readdirSync(dirOf(p))).not.toContain("form-export.csv"); // not copied
  });

  it("with a real venture record, recorded results feed the engine's own actual evidence (cumulative)", async () => {
    await runCycle({ store, kinds: [digitalProduct], now: () => NOW });
    const v = store.ventures()[0];
    store.saveVentures(store.ventures().map((x) => (x.id === v.id ? { ...x, opportunity: { ...x.opportunity, title: "Template pack: freelance invoicing for freelancers", problem: "getting paid on time with clear terms" } } : x)));
    const p = buildProduct(store, v.id, { now: NOW });
    expect(p.status).toBe("ready");
    approve(p.id);
    decideApproval(store, requestLaunch(store, p.id, NOW).id, true, NOW);
    markLive(store, p.id, "https://example.com/kit", NOW);
    recordValidation(store, p.id, { periodStart: "2026-11-10", periodEnd: "2026-11-12", visits: 40, signups: 2, sales: 0, revenue: 0, source: "hosting dashboard" }, LATER);
    recordValidation(store, p.id, { periodStart: "2026-11-13", periodEnd: "2026-11-15", visits: 70, signups: 3, sales: 1, revenue: 12, source: "hosting dashboard; payment provider" }, LATER);
    const acts = store.ventures().find((x) => x.id === v.id)!.experiments.flatMap((x) => x.evidence).filter((e) => e.kind === "actual");
    expect(acts.at(-1)!.metrics).toEqual({ visitors: 110, signups: 5, sales: 1, revenueUsd: 12 });
    expect(acts.at(-1)!.source).toMatch(/cumulative of 2 owner-recorded period/);
  });
});

describe("CLI", () => {
  it("product build / list / report / archive work offline; bad input is refused; nothing is published", async () => {
    store.saveVentures([invoicingVenture()]);
    let out = "";
    const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null }); };
    expect(await cli("product", "build", "ven-9e27315f", "--price", "12.00", "--currency", "GBP")).toBe(0);
    expect(out).toMatch(/v1 ready +freelance-invoicing GBP 12 +10\/10 checks/);
    const id = store.products()[0].id;
    expect(await cli("product", "list")).toBe(0); expect(out).toContain(id);
    expect(await cli("product", "report", id)).toBe(0); expect(out).toMatch(/no customer activity is known/);
    expect(await cli("product", "check", id)).toBe(0); expect(out).toMatch(/pass files-unchanged/);
    expect(await cli("product", "build", "ven-9e27315f", "--price", "-1")).toBe(1); expect(out).toMatch(/--price/);
    expect(await cli("product", "build", "ven-9e27315f", "--currency", "JPY")).toBe(1); expect(out).toMatch(/currency/);
    expect(await cli("product", "build", "ven-9e27315f", "--bogus", "x")).toBe(1); expect(out).toMatch(/unknown option/);
    expect(await cli("product", "record", id, "--period", "2026-11-09..2026-11-09", "--visits", "1", "--signups", "0", "--sales", "0", "--revenue", "0", "--source", "hosting dashboard")).toBe(1); expect(out).toMatch(/not live/);
    expect(await cli("product", "archive", id, "--reason", "test")).toBe(0);
    expect(await cli("product")).toBe(2); expect(out).toMatch(/Usage: product build/);
    expect(fs.existsSync(path.join(store.dir, "run.lock"))).toBe(false);
  });
});
