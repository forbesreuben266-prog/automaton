/**
 * The printable invoice of the freelance invoicing kit, with automatic totals.
 *
 * One inline calculator script (no network, no storage, no HTML injection), locked by a Content-Security-Policy that
 * allows only this exact script (by hash) and blocks every network request. Arithmetic is exact (BigInt, decimal
 * strings): line amount = quantity x rate, rounded half-up to the cent; tax = subtotal x optional rate, rounded
 * half-up; total due = subtotal + tax - optional deposit. Invalid input is flagged, never guessed. Without JavaScript
 * the totals can be typed by hand. Empty rows, the instructions and unused tax/deposit rows are hidden when printing.
 */

import { createHash } from "node:crypto";

export const INVOICE_LINES = 8;

/** The calculator. Runs in the browser; tests run invoiceTotals in a sandbox without a document. */
export const INVOICE_CALC_JS = `(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  var MAX_DIGITS = 12;
  function parse(v, maxDecimals) {
    var s = String(v == null ? "" : v).trim().replace(/[\\s,]/g, "");
    if (s === "") return null;
    var m = /^(\\d+)(?:\\.(\\d+))?$/.exec(s);
    if (!m || m[1].length > MAX_DIGITS || (m[2] || "").length > maxDecimals) return { error: true };
    var dec = m[2] || "";
    return { n: BigInt(m[1] + dec), scale: dec.length };
  }
  function pow10(k) { var p = BigInt(1); for (var i = 0; i < k; i++) p = p * BigInt(10); return p; }
  function divRound(num, den) { return (num * BigInt(2) + den) / (den * BigInt(2)); }
  function centsOf(x) { return x.scale <= 2 ? x.n * pow10(2 - x.scale) : divRound(x.n, pow10(x.scale - 2)); }
  function invoiceTotals(lines, taxRate, deposit) {
    var errors = [], sub = BigInt(0), out = [];
    lines.forEach(function (l, i) {
      var q = parse(l.qty, 4), r = parse(l.rate, 4);
      if (q === null && r === null) { out.push(null); return; }
      if (q === null || r === null || q.error || r.error) { errors.push("Line " + (i + 1) + ": enter both a quantity and a rate as plain numbers (no minus sign, at most 4 decimals)."); out.push("invalid"); return; }
      var c = divRound(q.n * r.n * BigInt(100), pow10(q.scale + r.scale));
      out.push(c); sub = sub + c;
    });
    var t = parse(taxRate, 3), tax = BigInt(0);
    if (t && (t.error || t.n > BigInt(100) * pow10(t.scale))) { errors.push("Tax rate: a percentage from 0 to 100, or leave it empty."); t = null; }
    if (t) tax = divRound(sub * t.n, BigInt(100) * pow10(t.scale));
    var d = parse(deposit, 2), dep = BigInt(0);
    if (d && d.error) { errors.push("Deposit: an amount with at most 2 decimals (no minus sign), or leave it empty."); d = null; }
    if (d) dep = centsOf(d);
    var total = sub + tax - dep;
    if (total < BigInt(0)) errors.push("The deposit is larger than the subtotal plus tax: check the amounts.");
    return { lines: out, subtotal: sub, tax: tax, deposit: dep, total: total, taxUsed: !!t, depositUsed: !!d && dep > BigInt(0), errors: errors };
  }
  function fmt(c) {
    var neg = c < BigInt(0), a = neg ? -c : c, s = a.toString();
    while (s.length < 3) s = "0" + s;
    var whole = s.slice(0, -2), out = "";
    while (whole.length > 3) { out = "," + whole.slice(-3) + out; whole = whole.slice(0, -3); }
    return (neg ? "-" : "") + whole + out + "." + s.slice(-2);
  }
  root.invoiceTotals = invoiceTotals;
  root.invoiceFormat = fmt;
  if (typeof document === "undefined") return;
  function q(sel) { return document.querySelector(sel); }
  function text(el) { return el ? el.textContent.replace(/\\[\\[[^\\]]*\\]\\]/g, "").trim() : ""; }
  function update() {
    var rows = Array.prototype.slice.call(document.querySelectorAll("tr.line"));
    var r = invoiceTotals(rows.map(function (row) { return { qty: row.querySelector(".qty").value, rate: row.querySelector(".rate").value }; }), q("#tax-rate").value, q("#deposit").value);
    rows.forEach(function (row, i) {
      var c = r.lines[i], cell = row.querySelector(".amount");
      cell.textContent = c === null ? "" : c === "invalid" ? "check" : fmt(c);
      row.classList.toggle("invalid", c === "invalid");
      row.classList.toggle("unused", c === null && !text(row.querySelector(".desc")));
    });
    q("#subtotal").textContent = fmt(r.subtotal);
    q("#tax").textContent = fmt(r.tax);
    q("#deposit-out").textContent = r.depositUsed ? "-" + fmt(r.deposit) : fmt(BigInt(0));
    q("#total").textContent = fmt(r.total);
    q("tr.tax-row").classList.toggle("unused", !r.taxUsed);
    q("tr.deposit-row").classList.toggle("unused", !r.depositUsed);
    var cur = q("#currency").value.trim().toUpperCase();
    q("#currency-out").textContent = /^[A-Z]{3}$/.test(cur) ? cur : "";
    var list = q("#errors");
    while (list.firstChild) list.removeChild(list.firstChild);
    r.errors.forEach(function (e) { var li = document.createElement("li"); li.textContent = e; list.appendChild(li); });
    q(".problems").hidden = r.errors.length === 0;
  }
  Array.prototype.forEach.call(document.querySelectorAll(".computed"), function (el) { el.removeAttribute("contenteditable"); });
  q(".nojs").hidden = true;
  // Money boxes show two decimals once edited (120 -> 120.00); invalid text is left as typed and flagged.
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el.classList || !(el.classList.contains("rate") || el.id === "deposit")) return;
    var x = parse(el.value, 2);
    if (x && !x.error) { el.value = fmt(centsOf(x)).replace(/,/g, ""); update(); }
  });
  document.addEventListener("input", update);
  update();
})();`;

/** CSP source for the inline script: its SHA-256, base64. */
export const scriptHash = (js: string) => `sha256-${createHash("sha256").update(js, "utf8").digest("base64")}`;

const line = () => `<tr class="line"><td class="desc" contenteditable="true">[[Work item, e.g. Website copy, 5 pages]]</td><td class="n"><input class="qty" inputmode="decimal" aria-label="Quantity" placeholder="0"></td><td class="n"><input class="rate" inputmode="decimal" aria-label="Rate" placeholder="0.00"></td><td class="n amount computed" contenteditable="true"></td></tr>`;

export function invoiceHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src '${scriptHash(INVOICE_CALC_JS)}'; base-uri 'none'; form-action 'none'">
<title>Invoice [[Invoice number]]</title>
<style>
body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111;line-height:1.4}
h1{font-size:1.8rem;margin:0}.muted{color:#555}.row{display:flex;justify-content:space-between;gap:2rem;margin:1.5rem 0}
table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{border-bottom:1px solid #ccc;padding:.4rem;text-align:left;vertical-align:top}td.n,th.n{text-align:right}
input{font:inherit;width:6rem;text-align:right;border:1px solid #9ab;border-radius:.2rem;padding:.1rem .3rem;background:#fff}
input.small{width:4rem}[contenteditable]{outline:1px dashed #9ab;outline-offset:2px}
.tot td{font-weight:600}.note{font-size:.9rem}.howto,.nojs{background:#eef4f8;padding:.5rem .8rem;border-radius:.3rem}
tr.invalid td{background:#fde8e8}.problems{border:2px solid #c00;padding:.3rem .8rem;margin:1rem 0}.problems:not([hidden]){display:block}
@page{margin:15mm}
@media print{body{margin:0;max-width:none}.howto,.nojs{display:none}[contenteditable]{outline:none}
input{border:none;padding:0;background:none;-webkit-appearance:none;appearance:none}input::placeholder{color:transparent}
tr.unused,.screen-only{display:none}tr{break-inside:avoid}:focus{outline:none;box-shadow:none}}
</style></head><body>
<div class="howto"><small><strong>How to use:</strong> click a dashed field to edit it, and type quantities and rates in the boxes:
line amounts, subtotal, tax and total due are calculated for you. Tax and deposit are optional: leave them empty if they do not
apply. Then print to PDF (Ctrl/Cmd + P). Instructions, empty lines and unused rows do not print.</small></div>
<p class="nojs"><small>Automatic totals need JavaScript, which is switched off in this browser: type the amounts and totals into the dashed boxes yourself.</small></p>
<div class="row"><div><h1 contenteditable="true">INVOICE</h1><p class="muted" contenteditable="true">[[Your name or business name]]<br>[[Your address]]<br>[[Your email]]<br>[[Business or tax registration number, if you have one]]</p></div>
<div><p><strong>Invoice number:</strong> <span contenteditable="true">[[Invoice number, e.g. 2026-014]]</span><br><strong>Issue date:</strong> <span contenteditable="true">[[Issue date]]</span><br><strong>Due date:</strong> <span contenteditable="true">[[Due date]]</span><br><strong>Purchase order:</strong> <span contenteditable="true">[[Client PO number, if any]]</span><br><strong>Currency:</strong> <input id="currency" class="small" maxlength="3" aria-label="Currency code" placeholder="GBP"></p></div></div>
<p><strong>Bill to:</strong><br><span contenteditable="true">[[Client company name]]<br>[[Client contact name]]<br>[[Client billing address]]</span></p>
<table><thead><tr><th>Description</th><th class="n">Quantity</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>
${Array.from({ length: INVOICE_LINES }, line).join("\n")}
</tbody><tfoot>
<tr><td colspan="3" class="n">Subtotal</td><td class="n computed" id="subtotal" contenteditable="true"></td></tr>
<tr class="tax-row"><td colspan="3" class="n"><span contenteditable="true">[[Tax name, e.g. VAT or GST]]</span> at <input id="tax-rate" class="small" inputmode="decimal" aria-label="Tax rate in percent" placeholder="0">%<span class="screen-only"> (optional: only if you charge tax)</span></td><td class="n computed" id="tax" contenteditable="true"></td></tr>
<tr class="deposit-row"><td colspan="3" class="n">Less deposit already paid<span class="screen-only"> (optional) <input id="deposit" inputmode="decimal" aria-label="Deposit already paid" placeholder="0.00"></span></td><td class="n computed" id="deposit-out" contenteditable="true"></td></tr>
<tr class="tot"><td colspan="3" class="n">Total due <span id="currency-out"></span></td><td class="n computed" id="total" contenteditable="true"></td></tr>
</tfoot></table>
<div class="problems" hidden><strong>Check these before sending:</strong><ul id="errors"></ul></div>
<p><strong>Payment details:</strong> <span contenteditable="true">[[Bank name, account name, account number or IBAN, sort code or SWIFT, or your payment link]]</span><br>
<strong>Payment reference:</strong> please quote <span contenteditable="true">[[Invoice number]]</span>.</p>
<p class="note" contenteditable="true">Payment terms: payment is due within [[number]] days of the issue date, by [[Due date]]. [[Your late-payment terms, as agreed in your contract; see payment-terms.md]]</p>
<p class="note" contenteditable="true">Thank you for your business. Questions about this invoice: [[Your email or phone]].</p>
<script>${INVOICE_CALC_JS}</script>
</body></html>
`;
}
