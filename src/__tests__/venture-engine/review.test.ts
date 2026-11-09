import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invoiceHtml } from "../../venture-engine/blueprints/invoice-template.js";
import { main } from "../../venture-engine/cli.js";
import { decideApproval } from "../../venture-engine/engine.js";
import { buildProduct, confirmationCode, markLive, requestLaunch, signOff, type Product } from "../../venture-engine/products.js";
import { adoptEdits, formatReview, MAX_PASSES, reviewAll, reviewProduct } from "../../venture-engine/review.js";
import { sha256, Store } from "../../venture-engine/store.js";
import type { Venture } from "../../venture-engine/types.js";

const NOW = new Date("2026-11-09T10:00:00Z");
let DIR = "";
let store: Store;
let realFetch: typeof fetch;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vr-"));
  store = new Store(path.join(DIR, ".automaton-ventures"));
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access in a test"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

const venture = (id: string, title: string, problem: string, expId?: string): Venture => ({
  id, status: "built", decisions: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  experiments: expId ? [{ id: expId, iteration: 1, hypothesis: "h", assets: [], checks: [], verified: true, evidence: [], createdAt: NOW.toISOString() }] : [],
  opportunity: { id: `opp-${id.slice(4)}`, kind: "digital-product", title, problem, audience: "freelancers", offer: `A pack for ${problem}.`, estimates: { demand: 0.7, feasibility: 0.8, risk: 0.1, costUsd: 0 }, score: 0.78, createdAt: NOW.toISOString(), source: "fixture (test only)" },
});
const invoicing = () => venture("ven-9e27315f", "Template pack: freelance invoicing for freelancers", "getting paid on time with clear terms");
/** A generic venture whose outline (as a model might write it) contains the given extra bullets. */
const genericWith = (extra: string[]) => {
  const v = venture("ven-0000000a", "Wedding budget tracker for couples", "keeping wedding costs under control", "exp-0000000a");
  const sections = ["Set the total budget", "Split it into 8 categories", "Get 3 quotes per supplier", "Track deposits", "Review every month", "Handle overspends"]
    .map((h, i) => `## ${i + 1}. ${h}\n\n- Step ${i + 1}: write the agreed amount for ${h.toLowerCase()}\n- Check it against the total every Sunday evening\n- Keep the receipt photo in the shared folder\n${i === 0 ? extra.map((e) => `- ${e}\n`).join("") : ""}`);
  return { v, outline: `# Wedding budget tracker\n\n${sections.join("\n")}` };
};
const setup = (vs: Venture[], outlines: Record<string, string> = {}) => {
  store.saveVentures(vs);
  for (const v of vs) for (const e of v.experiments) if (outlines[v.id]) fs.writeFileSync(path.join(store.assetDir(v.id, e.id), "product-outline.md"), outlines[v.id], { mode: 0o600 });
};
const dirOf = (p: Product) => path.join(store.dir, "ventures", p.ventureId, p.id);
const filesHash = (p: Product) => sha256(fs.readdirSync(dirOf(p)).sort().map((n) => n + fs.readFileSync(path.join(dirOf(p), n), "utf8")).join("\n"));
const portfolio = () => fs.readFileSync(path.join(store.dir, "portfolio.json"));
const approve = (id: string) => { const p = store.products().find((x) => x.id === id)!; return signOff(store, id, { confirm: confirmationCode(p), price: `${p.currency} ${p.price}`, note: "read qa-report.md; price OK", interactive: true }, NOW); };
const edit = (p: Product, name: string, change: (t: string) => string) => { const f = path.join(dirOf(p), name); fs.chmodSync(f, 0o600); fs.writeFileSync(f, change(fs.readFileSync(f, "utf8"))); };
/** Replaces a stored file and its recorded hash together, as an older build would have produced. */
const rewriteAsBuilt = (p: Product, name: string, text: string) => {
  fs.chmodSync(path.join(dirOf(p), name), 0o600);
  fs.writeFileSync(path.join(dirOf(p), name), text);
  store.saveProducts(store.products().map((x) => (x.id === p.id ? { ...x, files: x.files.map((f) => (f.name === name ? { ...f, sha256: sha256(text), bytes: Buffer.byteLength(text) } : f)) } : x)));
};

describe("review: nothing to repair", () => {
  it("a current, intact product passes; only the price and legal/tax/financial wording go to the owner; sign-off clears them", () => {
    setup([invoicing()]);
    const p = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    const r = reviewProduct(store, p.id, NOW);
    expect(r.repairedAs).toBeNull();
    expect(r.fixed).toEqual([]);
    expect(r.passed).toEqual(expect.arrayContaining(["files-unchanged", "links", "no-misleading-claims", "sensitive-advice", "price-consistency", "calculator-integrity"]));
    expect(r.ownerDecisions[0]).toBe("confirm the proposed price GBP 12 (an untested hypothesis)");
    expect(r.ownerDecisions.slice(1).every((d) => d.startsWith("legal/tax/financial wording to approve: "))).toBe(true);
    expect(r.ownerDecisions.length).toBe(1 + p.review.length);
    approve(p.id);
    expect(reviewProduct(store, p.id, NOW).ownerDecisions).toEqual([]);
    expect(store.products()).toHaveLength(1);
  });
});

describe("review: safe deterministic repairs become a new version", () => {
  it("missing files and changed generated files are regenerated; the old version and venture data stay byte-identical", () => {
    setup([invoicing()]);
    const v1 = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    fs.rmSync(path.join(dirOf(v1), "client-register.csv"));
    edit(v1, "qa-report.md", (t) => t + "\nnoise\n");
    const before = { v1: filesHash(v1), record: JSON.stringify(store.products()[0]), portfolio: portfolio() };
    const r = reviewProduct(store, v1.id, NOW);
    expect(r.stopped).toBeNull();
    expect(r.repairedAs).toMatchObject({ version: 2, previous: v1.id, status: "ready", price: 12, currency: "GBP" });
    expect(r.fixed.join("\n")).toMatch(/files-present failed .*client-register\.csv/);
    expect(filesHash(v1)).toBe(before.v1);
    expect(JSON.stringify(store.products()[0])).toBe(before.record);
    expect(portfolio().equals(before.portfolio)).toBe(true);
    expect(reviewProduct(store, r.repairedAs!.id, NOW).repairedAs).toBeNull(); // the repaired version is clean
  });

  it("an older version (invoice without the calculator) is upgraded from the reviewed blueprint", () => {
    setup([invoicing()]);
    const v1 = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    const old = invoiceHtml().replace(/<script>[\s\S]*?<\/script>\n/, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]+>\n/, "");
    rewriteAsBuilt(v1, "invoice-template.html", old);
    const r = reviewProduct(store, store.products()[0].id, NOW);
    expect(r.fixed.join("\n")).toMatch(/blueprint improved since version 1: regenerated invoice-template\.html/);
    expect(fs.readFileSync(path.join(dirOf(r.repairedAs!), "invoice-template.html"), "utf8")).toMatch(/function invoiceTotals/);
    expect(fs.readFileSync(path.join(dirOf(v1), "invoice-template.html"), "utf8")).toBe(old);
  });

  it("a modified calculator (security/calculation risk) is detected and replaced by the reviewed one", () => {
    setup([invoicing()]);
    const v1 = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    const html = fs.readFileSync(path.join(dirOf(v1), "invoice-template.html"), "utf8");
    rewriteAsBuilt(v1, "invoice-template.html", html.replace("var MAX_DIGITS = 12;", "var MAX_DIGITS = 12; fetch('/x');"));
    const r = reviewProduct(store, store.products()[0].id, NOW);
    expect(r.fixed.join("\n")).toMatch(/no-scripts-or-external-resources failed/);
    expect(r.fixed.join("\n")).toMatch(/calculator-integrity failed/);
    expect(r.repairedAs!.checks.every((c) => c.passed)).toBe(true);
  });

  it("an inconsistent price (landing page vs record) is regenerated consistently", () => {
    setup([invoicing()]);
    const v1 = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    const landing = fs.readFileSync(path.join(dirOf(v1), "landing.html"), "utf8");
    rewriteAsBuilt(v1, "landing.html", landing.split("£12").join("£15"));
    const r = reviewProduct(store, store.products()[0].id, NOW);
    expect(r.fixed.join("\n")).toMatch(/price-consistency failed/);
    expect(fs.readFileSync(path.join(dirOf(r.repairedAs!), "landing.html"), "utf8")).toContain("Proposed price: <strong>£12</strong>");
  });

  it("text fixes: an external link in a model-written outline becomes plain text, then QA passes", () => {
    const { v, outline } = genericWith(["Compare prices on [the comparison site](https://example.com/compare) before booking"]);
    setup([v], { [v.id]: outline });
    const v1 = buildProduct(store, v.id, { now: NOW });
    expect(v1.status).toBe("needs-work");
    const r = reviewProduct(store, v1.id, NOW);
    expect(r.stopped).toBeNull();
    expect(r.fixed.join("\n")).toMatch(/guide\.md: external links turned into plain text/);
    expect(r.passes).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(dirOf(r.repairedAs!), "guide.md"), "utf8")).toContain("Compare prices on the comparison site before booking");
    expect(r.repairedAs!.status).toBe("ready");
  });
});

describe("review: uncertain or unfixable issues go to the owner; nothing is guessed", () => {
  it("a misleading claim is never rewritten automatically: the review stops and lists it", () => {
    const { v, outline } = genericWith(["We guarantee you will stay within budget"]);
    setup([v], { [v.id]: outline });
    const v1 = buildProduct(store, v.id, { now: NOW });
    const r = reviewProduct(store, v1.id, NOW);
    expect(r.repairedAs).toBeNull();
    expect(r.stopped).toMatch(/still fail .* nothing was written/);
    expect(r.ownerDecisions.join("\n")).toMatch(/no-misleading-claims: .*guaranteed outcome/);
    expect(store.products()).toHaveLength(1);
  });

  it("unfinished content that no deterministic fix can complete stops within the pass limit", () => {
    const { v, outline } = genericWith(["TODO write the vendor section"]);
    setup([v], { [v.id]: outline });
    const v1 = buildProduct(store, v.id, { now: NOW });
    const r = reviewProduct(store, v1.id, NOW);
    expect(r.repairedAs).toBeNull();
    expect(r.passes).toBeLessThanOrEqual(MAX_PASSES);
    expect(r.ownerDecisions.join("\n")).toMatch(/cannot be fixed automatically: complete-content/);
    expect(store.products()).toHaveLength(1);
  });

  it("a live product is never repaired automatically: problems are reported only", () => {
    setup([invoicing()]);
    const p = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    approve(p.id);
    decideApproval(store, requestLaunch(store, p.id, NOW).id, true, NOW);
    markLive(store, p.id, "https://example.com/kit", NOW);
    fs.chmodSync(path.join(dirOf(p), "start-here.md"), 0o600);
    fs.appendFileSync(path.join(dirOf(p), "start-here.md"), "\nchanged\n");
    const r = reviewProduct(store, p.id, NOW);
    expect(r.repairedAs).toBeNull();
    expect(r.ownerDecisions.join("\n")).toMatch(/files-unchanged[\s\S]*is live: repairs are not applied automatically/);
    expect(store.products()).toHaveLength(1);
  });

  it("a sign-off no longer counts after the reviewed wording or price changes", () => {
    setup([invoicing()]);
    const p = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    approve(p.id);
    store.saveProducts(store.products().map((x) => ({ ...x, price: 15 })));
    expect(() => requestLaunch(store, p.id, NOW)).toThrow(/no current owner sign-off/);
  });
});

describe("customisations are never overwritten", () => {
  it("an edited landing page and payment terms are flagged, not regenerated; review-all (unattended) writes nothing", () => {
    setup([invoicing()]);
    const v1 = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    edit(v1, "landing.html", (t) => t.replace(/<h1>[^<]*<\/h1>/, "<h1>Invoicing for UK freelance designers</h1>"));
    edit(v1, "payment-terms.md", (t) => t.replace("payable within [[14]] days", "payable within [[7]] days"));
    const before = filesHash(v1);
    for (const r of [reviewProduct(store, v1.id, NOW), ...reviewAll(store, NOW)]) {
      expect(r.repairedAs).toBeNull();
      expect(r.stopped).toMatch(/customised files need an owner decision: nothing was regenerated/);
      expect(r.ownerDecisions[0]).toMatch(/^customised since the build: (payment-terms\.md, landing\.html|landing\.html, payment-terms\.md)\. Keep the edits as a new version: 'product adopt prd-[0-9a-f]{8}'; or regenerate/);
    }
    expect(store.products()).toHaveLength(1);
    expect(filesHash(v1)).toBe(before);
  });

  it("adopt keeps the edits as a new immutable version; later repairs and blueprint updates keep them", () => {
    setup([invoicing()]);
    const v1 = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    edit(v1, "landing.html", (t) => t.replace(/<h1>[^<]*<\/h1>/, "<h1>Invoicing for UK freelance designers</h1>"));
    const before = filesHash(v1);
    const v2 = adoptEdits(store, v1.id, NOW);
    expect(v2).toMatchObject({ version: 2, previous: v1.id, status: "ready", customised: ["landing.html"] });
    expect(v2.checks.every((c) => c.passed)).toBe(true);
    expect(fs.readFileSync(path.join(dirOf(v2), "landing.html"), "utf8")).toContain("<h1>Invoicing for UK freelance designers</h1>");
    expect(JSON.parse(fs.readFileSync(path.join(dirOf(v2), "tracking-plan.json"), "utf8")).product).toBe(v2.id); // generated for the new version
    expect(filesHash(v1)).toBe(before);
    expect(reviewProduct(store, v2.id, NOW)).toMatchObject({ repairedAs: null, fixed: [], stopped: null }); // adopted content is not "outdated"
    fs.rmSync(path.join(dirOf(v2), "invoice-tracker.csv")); // a later repair keeps the adopted landing page
    const r = reviewProduct(store, v2.id, NOW);
    expect(r.fixed.join("\n")).toMatch(/kept the owner's adopted files unchanged: landing\.html/);
    expect(fs.readFileSync(path.join(dirOf(r.repairedAs!), "landing.html"), "utf8")).toContain("<h1>Invoicing for UK freelance designers</h1>");
    expect(r.repairedAs!.customised).toEqual(["landing.html"]);
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).toMatch(/"kind":"product-adopted"/);
  });

  it("adopt refuses unsafe or inconsistent edits: an external form, a changed price, unfinished text, missing files", () => {
    setup([invoicing()]);
    const cases: [(p: Product) => void, RegExp][] = [
      [(p) => edit(p, "landing.html", (t) => t.replace('action="#signup"', 'action="https://forms.example.com/f/abc"')), /links: .*external links are not allowed[\s\S]*never adopted/],
      [(p) => edit(p, "landing.html", (t) => t.replace('href="#top"', 'href="https://example.com/"')), /links: /],
      [(p) => edit(p, "landing.html", (t) => t.split("£12").join("£9")), /price-consistency/],
      [(p) => edit(p, "reminder-emails.md", (t) => t + "\nTODO add a fifth email\n"), /complete-content/],
      [(p) => fs.rmSync(path.join(dirOf(p), "start-here.md")), /missing files cannot be adopted/],
      [() => undefined, /no edited files to adopt/],
    ];
    for (const [damage, why] of cases) {
      const p = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
      damage(p);
      const count = store.products().length;
      expect(() => adoptEdits(store, p.id, NOW)).toThrow(why);
      expect(store.products()).toHaveLength(count); // nothing written
    }
    const flagged = store.products()[0];
    edit(flagged, "landing.html", (t) => t.replace('action="#signup"', 'action="https://forms.example.com/f/abc"'));
    expect(reviewProduct(store, flagged.id, NOW).ownerDecisions[0]).toMatch(/\(not possible until these pass: links: /);
  });

  it("--discard-edits regenerates on request, says so, and keeps the edited version unchanged", () => {
    setup([invoicing()]);
    const v1 = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    edit(v1, "landing.html", (t) => t.replace(/<h1>[^<]*<\/h1>/, "<h1>My own headline</h1>"));
    const before = filesHash(v1);
    const r = reviewProduct(store, v1.id, NOW, { discardEdits: true });
    expect(r.fixed.join("\n")).toMatch(/owner edits discarded on request \(landing\.html\); they remain in prd-/);
    expect(fs.readFileSync(path.join(dirOf(r.repairedAs!), "landing.html"), "utf8")).not.toContain("My own headline");
    expect(r.repairedAs!.customised).toEqual([]);
    expect(filesHash(v1)).toBe(before);
  });
});

describe("sign-off: exact items, confirmation code, price, interactive terminal", () => {
  it("refuses without a terminal, with a stale or wrong code, a wrong price, or changed files; records approvals", () => {
    setup([invoicing()]);
    const p = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    const code = confirmationCode(p);
    const ok = { confirm: code, price: "GBP 12", note: "read qa-report.md; price OK", interactive: true };
    expect(() => signOff(store, p.id, { ...ok, interactive: false }, NOW)).toThrow(/interactive terminal: automated jobs, scripts and timers cannot sign off/);
    expect(() => signOff(store, p.id, { ...ok, confirm: "00000000" }, NOW)).toThrow(/confirmation code does not match/);
    for (const price of ["GBP 15", "USD 12", "12", ""]) expect(() => signOff(store, p.id, { ...ok, price }, NOW), price).toThrow(/price not confirmed/);
    edit(p, "payment-terms.md", (t) => t + "\nextra\n");
    expect(() => signOff(store, p.id, ok, NOW)).toThrow(/files changed since the build/);
    edit(p, "payment-terms.md", (t) => t.replace("\nextra\n", ""));
    const done = signOff(store, p.id, { ...ok, price: "GBP 12.00" }, NOW);
    expect(done.signOff).toMatchObject({ code, items: 1 + p.review.length, note: "read qa-report.md; price OK" });
    expect(fs.readFileSync(path.join(store.dir, "audit.jsonl"), "utf8")).toMatch(new RegExp(`"kind":"product-signed-off","product":"${p.id}","code":"${code}","items":${1 + p.review.length},"price":"GBP 12"`));
    // the code from an earlier version or earlier content is stale for the new version
    const v2 = buildProduct(store, "ven-9e27315f", { now: NOW, previous: store.products()[0] });
    expect(confirmationCode(v2)).not.toBe(code);
    expect(() => signOff(store, v2.id, ok, NOW)).toThrow(/confirmation code does not match/);
    // editing files after sign-off blocks the launch request
    edit(done, "start-here.md", (t) => t + "\nlater edit\n");
    expect(() => requestLaunch(store, p.id, NOW)).toThrow(/files changed since the build and sign-off/);
  });
});

describe("review-all and CLI", () => {
  it("customised file: review flags, adopt refuses an unsafe edit, discard-edits repairs; sign-off is two-step and needs a terminal", async () => {
    setup([invoicing()]);
    const v1 = buildProduct(store, "ven-9e27315f", { now: NOW, currency: "GBP" });
    let out = "", tty = false;
    const cli = async (...a: string[]) => { out = ""; return main(a, { home: DIR, out: (s) => { out += s; }, now: () => NOW, model: null, isInteractive: () => tty }); };
    edit(v1, "landing.html", (t) => t.replace('action="#signup"', 'action="https://forms.example.com/f/abc"'));
    expect(await cli("product", "review-all")).toBe(1);
    expect(out).toMatch(/STOPPED: customised files need an owner decision: nothing was regenerated/);
    expect(await cli("product", "adopt", v1.id)).toBe(1); expect(out).toMatch(/edits not adopted \(nothing was written\)/);
    expect(await cli("product", "review", v1.id, "--discard-edits")).toBe(0);
    expect(out).toMatch(/repaired as (prd-[0-9a-f]{8}) \(version 2\)/);
    const v2 = store.products()[1];
    expect(await cli("product", "sign-off", v2.id)).toBe(0);
    expect(out).toMatch(/^Items to approve for prd-[0-9a-f]{8} .*\n  1\. Proposed price: GBP 12 \(an untested hypothesis\)\n  2\. /);
    const code = /--confirm ([0-9a-f]{8})/.exec(out)![1];
    expect(code).toBe(confirmationCode(v2));
    const args = ["product", "sign-off", v2.id, "--confirm", code, "--price", "GBP 12", "--note", "read qa-report.md; price OK"];
    expect(await cli(...args)).toBe(1); expect(out).toMatch(/interactive terminal/); // unattended: refused
    expect(await cli("product", "sign-off", v2.id, "--confirm", code, "--note", "x y z")).toBe(1); expect(out).toMatch(/--price is required/);
    tty = true;
    expect(await cli(...args)).toBe(0);
    expect(out).toMatch(/signed off: \d+ item\(s\) approved, including the proposed price GBP 12 \(code [0-9a-f]{8}/);
    expect(await cli("product", "review-all")).toBe(0);
    expect(out).toMatch(/NEEDS OWNER DECISION \(0\)/);
    expect(fs.existsSync(path.join(store.dir, "run.lock"))).toBe(false);
  });
});
