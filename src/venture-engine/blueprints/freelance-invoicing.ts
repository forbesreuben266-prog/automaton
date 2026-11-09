/**
 * Blueprint: freelance invoicing kit. A complete, editable pack: printable invoice, invoice tracker and client
 * register (CSV, opens in any spreadsheet), payment-terms wording, reminder emails, a workflow checklist and setup
 * instructions. Currency-neutral; no country-specific legal or tax claims (see DISCLAIMER).
 */

import { type Blueprint, csv, DISCLAIMER, type ProductFile, words } from "./common.js";

const INVOICE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice [[Invoice number]]</title>
<style>
body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111;line-height:1.4}
h1{font-size:1.8rem;margin:0}.muted{color:#555}.row{display:flex;justify-content:space-between;gap:2rem;margin:1.5rem 0}
table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{border-bottom:1px solid #ccc;padding:.4rem;text-align:left}td.n,th.n{text-align:right}
[contenteditable]{outline:1px dashed #9ab;outline-offset:2px}.tot td{font-weight:600}.note{font-size:.9rem}
@media print{[contenteditable]{outline:none}.howto{display:none}}
</style></head><body>
<p class="howto muted"><small>How to use: click any dashed field to edit it in your browser, then print to PDF (Ctrl/Cmd + P). Or open this file in a text editor and replace each [[field]]. Dashed outlines do not print.</small></p>
<div class="row"><div><h1 contenteditable="true">INVOICE</h1><p class="muted" contenteditable="true">[[Your name or business name]]<br>[[Your address]]<br>[[Your email]]<br>[[Business or tax registration number, if you have one]]</p></div>
<div><p><strong>Invoice number:</strong> <span contenteditable="true">[[Invoice number, e.g. 2026-014]]</span><br><strong>Issue date:</strong> <span contenteditable="true">[[Issue date]]</span><br><strong>Due date:</strong> <span contenteditable="true">[[Due date]]</span><br><strong>Purchase order:</strong> <span contenteditable="true">[[Client PO number, if any]]</span></p></div></div>
<p><strong>Bill to:</strong><br><span contenteditable="true">[[Client company name]]<br>[[Client contact name]]<br>[[Client billing address]]</span></p>
<table><thead><tr><th>Description</th><th class="n">Quantity</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>
<tr><td contenteditable="true">[[Work item, e.g. Website copy, 5 pages]]</td><td class="n" contenteditable="true">[[1]]</td><td class="n" contenteditable="true">[[Rate]]</td><td class="n" contenteditable="true">[[Amount]]</td></tr>
<tr><td contenteditable="true">[[Work item]]</td><td class="n" contenteditable="true">[[Qty]]</td><td class="n" contenteditable="true">[[Rate]]</td><td class="n" contenteditable="true">[[Amount]]</td></tr>
<tr><td contenteditable="true">[[Work item]]</td><td class="n" contenteditable="true">[[Qty]]</td><td class="n" contenteditable="true">[[Rate]]</td><td class="n" contenteditable="true">[[Amount]]</td></tr>
</tbody><tfoot>
<tr><td colspan="3" class="n">Subtotal</td><td class="n" contenteditable="true">[[Subtotal]]</td></tr>
<tr><td colspan="3" class="n" contenteditable="true">[[Tax name and rate, or delete this row]]</td><td class="n" contenteditable="true">[[Tax amount]]</td></tr>
<tr><td colspan="3" class="n" contenteditable="true">[[Deposit already paid, or delete this row]]</td><td class="n" contenteditable="true">[[Deposit amount]]</td></tr>
<tr class="tot"><td colspan="3" class="n">Total due ([[Currency]])</td><td class="n" contenteditable="true">[[Total due]]</td></tr>
</tfoot></table>
<p><strong>Payment details:</strong> <span contenteditable="true">[[Bank name, account name, account number or IBAN, sort code or SWIFT, or your payment link]]</span><br>
<strong>Payment reference:</strong> please quote <span contenteditable="true">[[Invoice number]]</span>.</p>
<p class="note" contenteditable="true">Payment terms: payment is due within [[number]] days of the issue date, by [[Due date]]. [[Your late-payment terms, as agreed in your contract; see payment-terms.md]]</p>
<p class="note" contenteditable="true">Thank you for your business. Questions about this invoice: [[Your email or phone]].</p>
</body></html>
`;

const files = (): ProductFile[] => [
  { name: "start-here.md", template: false, description: "Start here: what is included and a 20-minute setup", text: `# Freelance invoicing kit: start here

This kit gives you a complete, repeatable invoicing routine: one invoice template, one tracker, one client register,
ready-to-adapt payment terms and reminder emails, and a checklist for each stage.

## What is included

| File | What it is | Open it with |
|---|---|---|
| \`invoice-template.html\` | Printable invoice with editable fields | Any web browser (edit, then print to PDF) or a text editor |
| \`invoice-tracker.csv\` | One row per invoice: amounts, due dates, reminders, payment | Excel, Google Sheets, Numbers or LibreOffice |
| \`client-register.csv\` | One row per client: billing contact, agreed terms, deposit, PO rules | Any spreadsheet |
| \`payment-terms.md\` | Wording to adapt for quotes and contracts | Any text editor or word processor |
| \`reminder-emails.md\` | Four reminder emails, from friendly to final notice | Copy into your email |
| \`invoicing-checklist.md\` | What to do before work, at delivery, after sending and when overdue | Print it or tick it on screen |

## 20-minute setup

1. Open \`client-register.csv\` in your spreadsheet and add one row for each current client. Delete the example row.
2. Open \`invoice-template.html\` in your browser. Click the dashed fields and fill in your own details once.
   Save a copy as your master invoice (print to PDF or save the edited file under a new name).
3. Choose an invoice numbering scheme, for example \`2026-001\`, \`2026-002\`, and never reuse a number.
4. Read \`payment-terms.md\`, choose the wording that fits how you work, and add it to your next quote or contract.
5. Open \`invoice-tracker.csv\`, delete the example row, and add every invoice you have not yet been paid for.
6. Put a 15-minute weekly slot in your calendar to go through \`invoicing-checklist.md\` section 4 (overdue invoices).

## Using the tracker

- Dates: use the format YYYY-MM-DD so that rows sort correctly.
- Status: use one of Draft, Sent, Paid, Overdue, Disputed.
- To total unpaid invoices, filter Status to Sent and Overdue and add up the Amount column, or add your own
  formula in a new column. The CSV ships without formulas on purpose, so it opens safely everywhere.
- To keep a backup, save a copy each month (for example \`invoice-tracker-2026-11.csv\`).

## Important

${DISCLAIMER}
` },
  { name: "invoice-template.html", template: true, description: "Printable invoice with editable fields (browser: edit, then print to PDF)", text: INVOICE_HTML },
  { name: "invoice-tracker.csv", template: true, description: "Invoice tracker: amounts, due dates, reminders and payments", text: csv([
    ["Invoice number", "Client", "Project", "Issue date", "Due date", "Amount", "Currency", "Status", "Reminder 1 sent", "Reminder 2 sent", "Final notice sent", "Date paid", "Notes"],
    ["EXAMPLE-001", "Example Client Ltd", "Brochure copywriting", "2026-01-05", "2026-01-19", 450, "GBP", "Paid", "", "", "", "2026-01-18", "Example row: delete it when you add your own invoices"],
  ]) },
  { name: "client-register.csv", template: true, description: "Client register: billing contact, agreed terms, deposit and PO rules", text: csv([
    ["Client", "Billing contact", "Billing email", "Billing address", "Payment terms (days)", "Deposit (%)", "Purchase order required", "Invoice by email or portal", "Agreed late-payment terms", "Notes"],
    ["Example Client Ltd", "Sam Example", "accounts@example.com", "1 Example Street, Example Town", 14, 30, "No", "Email", "As in contract dated 2026-01-02", "Example row: delete it when you add your own clients"],
  ]) },
  { name: "payment-terms.md", template: true, description: "Payment-terms wording to adapt for your quotes and contracts", text: `# Payment terms you can adapt

Put your terms in writing before work starts (in the quote or contract), then repeat the key points on every invoice.
Choose the options that fit how you work and replace each [[field]].

## 1. When payment is due

> Invoices are payable within [[14]] days of the invoice date.

Common choices are 7, 14 or 30 days. Shorter terms are easier to agree at the start than to change later.

## 2. Deposit for larger projects

> For projects expected to take longer than [[two weeks]] or to cost more than [[amount]], a deposit of [[30]]% is
> payable before work starts. The deposit is deducted from the final invoice.

## 3. Staged payments

> Projects longer than [[one month]] are invoiced in stages: [[40]]% at the start, [[30]]% at [[milestone]] and the
> remaining [[30]]% on delivery.

## 4. How to pay

> Payment by bank transfer to the account shown on the invoice, quoting the invoice number as the reference.

## 5. Late payment

> If an invoice is not paid by its due date, [[describe what you have agreed: for example a reminder schedule, a
> late-payment charge, or pausing further work until the account is up to date]].

Many countries have rules about charging interest or fees on late business payments, and some set specific rates or
compensation amounts. Check what applies where you and your client are based before you put a figure in your terms.

## 6. Questions about an invoice

> Please raise any question about an invoice within [[7]] days of receiving it, so that it can be resolved before
> the due date.

## 7. Pausing work

> If an invoice is more than [[14]] days overdue, work on the project may be paused until it is paid.

## Important

${DISCLAIMER}
` },
  { name: "reminder-emails.md", template: true, description: "Four reminder emails, from a friendly note to a final notice", text: `# Payment reminder emails

Send them in order. Keep them short, factual and friendly, and always attach the invoice again.
Record each one in \`invoice-tracker.csv\` (columns Reminder 1 sent, Reminder 2 sent, Final notice sent).

## 1. Three days before the due date

Subject: Invoice [[Invoice number]] due on [[Due date]]

Hi [[Client contact name]],

A quick note that invoice [[Invoice number]] for [[Amount]] is due on [[Due date]]. I have attached it again for
convenience. Payment details are on the invoice; please quote [[Invoice number]] as the reference.

Thank you,
[[Your name]]

## 2. One day after the due date

Subject: Invoice [[Invoice number]] is now due

Hi [[Client contact name]],

Invoice [[Invoice number]] for [[Amount]] was due yesterday, [[Due date]]. If it has already been paid, thank you,
and please ignore this email. If not, could you let me know when payment is planned?

Thank you,
[[Your name]]

## 3. Seven days overdue

Subject: Overdue: invoice [[Invoice number]] ([[Amount]])

Hi [[Client contact name]],

Invoice [[Invoice number]] for [[Amount]] is now seven days overdue. Could you confirm the payment date, or tell me
if there is a problem with the invoice that I can help to resolve? I have attached it again.

Kind regards,
[[Your name]]

## 4. Final notice (21 days or more overdue)

Subject: Final notice: invoice [[Invoice number]]

Hi [[Client contact name]],

Invoice [[Invoice number]] for [[Amount]] is now [[number]] days overdue, despite my reminders on [[dates]].
Please arrange payment by [[date, at least 7 days from today]]. As set out in our agreed terms, [[the step you
agreed, for example pausing further work]] will apply if it remains unpaid.

If something is preventing payment, please reply and we can agree a plan.

Regards,
[[Your name]]

## Important

${DISCLAIMER}
` },
  { name: "invoicing-checklist.md", template: false, description: "Checklist for each stage: before work, at delivery, after sending, overdue", text: `# Invoicing checklist

## 1. Before work starts

- [ ] Agree the price, scope and payment terms in writing (see \`payment-terms.md\`)
- [ ] Add the client to \`client-register.csv\` with the billing contact and email
- [ ] Ask whether the client needs a purchase order number on invoices
- [ ] Ask for a deposit if the project is long or large
- [ ] Note who approves invoices and how they want to receive them

## 2. When the work is delivered

- [ ] Send the invoice on the same day the work is delivered
- [ ] Use the next number in your sequence and never reuse a number
- [ ] Check client name, PO number, amounts, currency and due date before sending
- [ ] Attach the invoice as a PDF and put the invoice number in the email subject
- [ ] Add the invoice to \`invoice-tracker.csv\` with status Sent

## 3. After sending

- [ ] Ask the client to confirm they received the invoice
- [ ] Put the due date in your calendar
- [ ] Send reminder 1 three days before the due date (\`reminder-emails.md\`)

## 4. When an invoice is overdue (weekly, 15 minutes)

- [ ] Filter the tracker for status Sent with a due date in the past and set them to Overdue
- [ ] Send reminder 2 one day after the due date
- [ ] Send reminder 3 after seven days and phone the billing contact if you can
- [ ] Send the final notice after 21 days and apply only the steps you agreed in writing
- [ ] Record every reminder and conversation in the Notes column

## 5. When you are paid

- [ ] Set the status to Paid and add the date paid
- [ ] Send a short thank-you and confirm the account is clear
- [ ] Review whether this client's terms (deposit, days) should change next time

## Important

${DISCLAIMER}
` },
];

export const freelanceInvoicing: Blueprint = {
  id: "freelance-invoicing",
  defaultPrice: 12,
  matches: (o) => /\binvoic(e|es|ing)\b/.test(words(o)),
  productName: () => "Freelance invoicing kit",
  pitch: (i) => ({
    headline: "A complete invoicing routine for freelancers, ready in 20 minutes",
    subheadline: `For ${i.opportunity.audience}: ${i.opportunity.problem.replace(/\.$/, "")}. An editable invoice, a tracker, payment-terms wording, reminder emails and a step-by-step checklist.`,
    benefits: [
      "Send a clear, professional invoice the day the work is delivered",
      "See every unpaid invoice and its due date in one tracker",
      "Use reminder emails that move from friendly to firm, in a set order",
      "Agree payment terms and deposits in writing before work starts",
    ],
    faq: [
      { q: "What do I need to use it?", a: "A web browser and any spreadsheet program (Excel, Google Sheets, Numbers or LibreOffice). No accounts or software to install." },
      { q: "Does it work in my country and currency?", a: "The files are currency-neutral and contain no country-specific rules. Check local rules on tax and late payment before relying on any wording." },
      { q: "Is this legal or tax advice?", a: "No. It is a practical toolkit for organising invoicing. Ask a qualified adviser about anything legal or tax-related." },
    ],
  }),
  files: () => files(),
};

