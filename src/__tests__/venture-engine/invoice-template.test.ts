import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { INVOICE_CALC_JS, INVOICE_LINES, invoiceHtml, scriptHash } from "../../venture-engine/blueprints/invoice-template.js";
import { htmlSafety } from "../../venture-engine/products.js";

type Totals = { lines: (bigint | null | "invalid")[]; subtotal: bigint; tax: bigint; deposit: bigint; total: bigint; taxUsed: boolean; depositUsed: boolean; errors: string[] };
const sandbox: { invoiceTotals?: (l: { qty: string; rate: string }[], tax: string, dep: string) => Totals; invoiceFormat?: (c: bigint) => string } = {};
vm.runInNewContext(INVOICE_CALC_JS, sandbox); // no document, no network: only the pure functions are defined
const calc = (lines: [string, string][], tax = "", dep = "") => sandbox.invoiceTotals!(lines.map(([qty, rate]) => ({ qty, rate })), tax, dep);
const f = (c: bigint) => sandbox.invoiceFormat!(c);

describe("invoice calculator (exact decimal arithmetic)", () => {
  it("line amounts, subtotal and total due", () => {
    const r = calc([["2", "150"], ["1.5", "40"], ["", ""]]);
    expect(r.lines).toEqual([30000n, 6000n, null]);
    expect([f(r.subtotal), f(r.total), r.errors]).toEqual(["360.00", "360.00", []]);
  });
  it("rounds half-up to the cent without floating-point errors", () => {
    expect(f(calc([["1", "1.005"]]).total)).toBe("1.01"); // 1.005 is 1.00499... as a float
    expect(f(calc([["3", "0.1"]]).total)).toBe("0.30");
    expect(f(calc([["3", "0.125"]]).total)).toBe("0.38");
    expect(f(calc([["1.5", "33.33"]]).total)).toBe("50.00"); // 49.995
    expect(f(calc([["0.3333", "3"]]).total)).toBe("1.00"); // 0.9999
  });
  it("accepts thousands separators and spaces; formats with separators", () => {
    expect(f(calc([["1", "1,250.50"]]).total)).toBe("1,250.50");
    expect(f(calc([[" 2 ", "1 000"]]).total)).toBe("2,000.00");
    expect(f(calc([["999999999999", "9999.9999"]]).total)).toBe("9,999,999,899,990,000.00"); // = 9,999,999,899,990,000.0001: exact, no overflow
    expect(f(0n)).toBe("0.00"); expect(f(5n)).toBe("0.05"); expect(f(-12345n)).toBe("-123.45");
  });
  it("optional tax rate: empty means no tax; rounding half-up; 0-100 only", () => {
    expect(calc([["1", "300"]]).taxUsed).toBe(false);
    const t = calc([["1", "300"]], "20");
    expect([f(t.tax), f(t.total), t.taxUsed]).toEqual(["60.00", "360.00", true]);
    expect(f(calc([["1", "49.99"]], "17.5").tax)).toBe("8.75"); // 8.74825
    expect(f(calc([["1", "100"]], "0").total)).toBe("100.00");
    for (const bad of ["150", "-5", "abc", "1.2345"]) {
      const r = calc([["1", "100"]], bad);
      expect(r.errors.join(" "), bad).toMatch(/Tax rate/);
      expect(f(r.tax)).toBe("0.00"); // an invalid rate is never applied
    }
  });
  it("optional deposit is deducted; larger than the total is flagged; at most 2 decimals", () => {
    const d = calc([["1", "500"]], "20", "150");
    expect([f(d.deposit), f(d.total), d.depositUsed, d.errors]).toEqual(["150.00", "450.00", true, []]);
    const over = calc([["1", "100"]], "", "250");
    expect(f(over.total)).toBe("-150.00");
    expect(over.errors.join(" ")).toMatch(/deposit is larger/);
    expect(calc([["1", "100"]], "", "10.005").errors.join(" ")).toMatch(/Deposit/);
    expect(calc([["1", "100"]], "", "0").depositUsed).toBe(false);
  });
  it("incomplete or invalid lines are flagged and left out of the totals, never guessed", () => {
    for (const [q, r] of [["2", ""], ["", "50"], ["-1", "50"], ["2", "-50"], ["two", "50"], ["1.23456", "1"], ["1e3", "1"]] as [string, string][]) {
      const t = calc([["1", "100"], [q, r]]);
      expect(t.lines[1], `${q} x ${r}`).toBe("invalid");
      expect(f(t.subtotal)).toBe("100.00");
      expect(t.errors[0]).toMatch(/^Line 2: enter both a quantity and a rate/);
    }
  });
  it("no lines at all gives zero totals", () => {
    const r = calc(Array.from({ length: INVOICE_LINES }, () => ["", ""] as [string, string]));
    expect([f(r.subtotal), f(r.total), r.errors]).toEqual(["0.00", "0.00", []]);
  });
});

describe("invoice page safety (QA rules for the one allowed script)", () => {
  const html = invoiceHtml();
  it("the generated invoice passes; the CSP allows exactly this script and no network", () => {
    expect(htmlSafety("invoice-template.html", html, true)).toEqual([]);
    expect(html).toContain(`script-src '${scriptHash(INVOICE_CALC_JS)}'`);
    expect(html).toMatch(/default-src 'none'/);
    expect(html.match(/<tr class="line">/g)).toHaveLength(INVOICE_LINES);
  });
  it("rejects anything outside the narrow allowance", () => {
    const bad = (h: string, re: RegExp, name = "invoice-template.html", template = true) => expect(htmlSafety(name, h, template).join("; ")).toMatch(re);
    bad(html.replace("root.invoiceTotals = invoiceTotals;", 'root.invoiceTotals = invoiceTotals; fetch("/x");'), /uses "fetch"/);
    for (const api of ["localStorage.x=1;", "document.body.innerHTML='';", "new Image();", "window.open('');", "setTimeout(update, 1);", "location.href='x';", "eval('1');"])
      bad(html.replace("root.invoiceFormat = fmt;", `root.invoiceFormat = fmt; ${api}`), /the script uses/);
    bad(html.replace("root.invoiceFormat = fmt;", "root.invoiceFormat = fmt; var x = 1;"), /Content-Security-Policy/); // changed script: hash no longer matches
    bad(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, ""), /Content-Security-Policy/);
    bad(html.replace("default-src 'none'", "default-src *"), /Content-Security-Policy/);
    bad(html.replace("</body>", "<script>1</script></body>"), /at most one inline script/);
    bad(html.replace("</body>", '<script src="x.js"></script></body>'), /at most one inline script/);
    bad(html.replace('<input id="deposit"', '<input onchange="1" id="deposit"'), /outside the one allowed script/);
    bad(html.replace("</body>", '<img src="https://example.com/p.gif"></body>'), /outside the one allowed script/);
    bad(html, /scripts or external resources/, "landing.html", false); // never on the landing page
    bad(html, /scripts or external resources/, "guide.html", false); // never in a non-template file
  });
});

// Real-browser check (Chromium via Playwright, when available): calculation through the DOM, CSP enforcement,
// no network requests, no-JavaScript fallback and the print layout.
let chromium: { launch: () => Promise<any> } | null = null;
try { chromium = createRequire(import.meta.url)("playwright").chromium; } catch { chromium = null; } // optional: not a project dependency
describe.skipIf(!chromium)("invoice in a real browser (Chromium, offline)", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inv-")), "invoice-template.html");
  fs.writeFileSync(file, invoiceHtml());
  const url = `file://${file}`;
  it("calculates as the buyer types, flags problems, makes no network requests, and prints cleanly", async () => {
    const browser = await chromium!.launch();
    try {
      const page = await browser.newPage();
      const requests: string[] = []; const errors: string[] = [];
      page.on("request", (r: any) => requests.push(r.url()));
      page.on("pageerror", (e: Error) => errors.push(e.message));
      page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(url);
      expect(await page.isVisible(".nojs")).toBe(false); // the script ran under the CSP
      const rows = page.locator("tr.line");
      await rows.nth(0).locator(".qty").fill("2"); await rows.nth(0).locator(".rate").fill("150");
      await rows.nth(1).locator(".qty").fill("1.5"); await rows.nth(1).locator(".rate").fill("33.33");
      await page.fill("#tax-rate", "20"); await page.fill("#deposit", "100"); await page.fill("#currency", "gbp");
      const out = async () => page.evaluate(() => ["#subtotal", "#tax", "#deposit-out", "#total", "#currency-out"].map((s) => document.querySelector(s)!.textContent));
      expect(await rows.nth(1).locator(".amount").textContent()).toBe("50.00");
      expect(await out()).toEqual(["350.00", "70.00", "-100.00", "320.00", "GBP"]);
      expect(await page.isVisible(".problems")).toBe(false);
      await rows.nth(0).locator(".rate").dispatchEvent("change");
      expect(await rows.nth(0).locator(".rate").inputValue()).toBe("150.00"); // money shown with two decimals once edited
      expect(await out()).toEqual(["350.00", "70.00", "-100.00", "320.00", "GBP"]);
      await rows.nth(2).locator(".qty").fill("3");
      expect(await page.isVisible(".problems")).toBe(true);
      expect(await page.textContent("#errors")).toMatch(/Line 3: enter both a quantity and a rate/);
      expect(await rows.nth(2).locator(".amount").textContent()).toBe("check");
      await rows.nth(2).locator(".qty").fill("");
      expect(await page.isVisible(".problems")).toBe(false);
      // the CSP blocks network access even for code run in the page
      expect(await page.evaluate(() => fetch("https://example.com/").then(() => "fetched", () => "blocked"))).toBe("blocked");
      expect(requests.filter((u) => !u.startsWith("file://"))).toEqual([]);
      expect(errors.filter((e) => !/Content Security Policy|Failed to fetch/i.test(e))).toEqual([]);
      // print layout
      await page.emulateMedia({ media: "print" });
      const print = await page.evaluate(() => ({
        howto: getComputedStyle(document.querySelector(".howto")!).display,
        unusedRows: Array.from(document.querySelectorAll("tr.line")).filter((r) => getComputedStyle(r).display === "none").length,
        inputBorder: getComputedStyle(document.querySelector(".qty")!).borderTopStyle,
        outline: getComputedStyle(document.querySelector(".desc")!).outlineStyle,
        taxRow: getComputedStyle(document.querySelector("tr.tax-row")!).display,
        guidance: Array.from(document.querySelectorAll(".screen-only")).map((e) => getComputedStyle(e).display),
        printedText: (document.querySelector("tfoot") as HTMLElement).innerText,
      }));
      expect({ ...print, printedText: undefined }).toEqual({ howto: "none", unusedRows: 6, inputBorder: "none", outline: "none", taxRow: "table-row", guidance: ["none", "none"], printedText: undefined });
      expect(print.printedText).not.toMatch(/optional|only if you charge tax/i); // buyer guidance never prints on the client's invoice
      await page.emulateMedia({ media: "screen" }); // edit on screen, as a buyer would, then print again
      await page.fill("#tax-rate", ""); await page.fill("#deposit", "");
      await page.emulateMedia({ media: "print" });
      expect(await page.evaluate(() => [getComputedStyle(document.querySelector("tr.tax-row")!).display, getComputedStyle(document.querySelector("tr.deposit-row")!).display])).toEqual(["none", "none"]);
      const pdf: Buffer = await page.pdf({ format: "A4" });
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect((pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1); // one A4 page
    } finally { await browser.close(); }
  }, 60_000);
  it("without JavaScript: the fallback note shows and totals can be typed by hand", async () => {
    const browser = await chromium!.launch();
    try {
      const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
      await page.goto(url);
      expect(await page.isVisible(".nojs")).toBe(true);
      expect(await page.getAttribute("#total", "contenteditable")).toBe("true");
    } finally { await browser.close(); }
  }, 60_000);
});
