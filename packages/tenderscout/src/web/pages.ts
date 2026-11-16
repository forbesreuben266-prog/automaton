import type { Config } from "../config.js";
import { esc } from "../digest.js";
import { REGIONS } from "../regions.js";

const CSS = `
:root{--navy:#0b3d5c;--teal:#0b7a6f;--ink:#1a2433;--muted:#5b6675;--line:#e3e8ef;--bg:#f6f8fb}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:#fff;line-height:1.6}
a{color:var(--navy)}.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header{background:var(--navy);color:#fff}header .wrap{display:flex;justify-content:space-between;align-items:center;height:60px}
.logo{font-weight:800;font-size:20px;color:#fff;text-decoration:none}.logo span{color:#7fd1c7}
nav a{color:#dbe7ef;text-decoration:none;margin-left:18px;font-size:15px}nav a:hover{color:#fff}
.hero{background:linear-gradient(180deg,var(--navy),#124e72);color:#fff;padding:56px 0 64px}
.hero h1{font-size:clamp(28px,5vw,44px);line-height:1.15;margin:0 0 16px;max-width:760px}
.hero p{font-size:18px;color:#dbe7ef;max-width:640px;margin:0 0 26px}
.btn{display:inline-block;background:var(--teal);color:#fff;padding:13px 22px;border-radius:6px;text-decoration:none;font-weight:600;border:0;font-size:16px;cursor:pointer}
.btn:hover{background:#09665d}.btn.ghost{background:transparent;border:1px solid #9fc3d6;margin-left:8px}
section{padding:56px 0}section.alt{background:var(--bg)}h2{font-size:28px;margin:0 0 10px}.lead{color:var(--muted);margin:0 0 28px;max-width:680px}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:22px}.card h3{margin:0 0 6px;font-size:18px}.card p{margin:0;color:var(--muted)}
.price{max-width:460px;margin:0 auto;text-align:center}.price .amt{font-size:52px;font-weight:800;color:var(--navy)}.price .amt small{font-size:18px;color:var(--muted);font-weight:500}
.price ul{text-align:left;padding-left:20px}
form .row{margin-bottom:16px}label{font-weight:600;display:block;margin-bottom:6px}
input[type=email],input[type=text]{width:100%;padding:11px 12px;border:1px solid #c5cfdb;border-radius:6px;font-size:16px}
.regions{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 14px}.regions label{font-weight:400;display:flex;gap:8px;align-items:flex-start}.check label{font-weight:400;display:block}.check input{margin-right:8px}
.small{font-size:14px;color:var(--muted)}.notice{padding:14px 16px;border-radius:8px;background:#eef7f5;border:1px solid #b9e0d9;margin-bottom:20px}
.notice.warn{background:#fff7ed;border-color:#fed7aa}
details{border-bottom:1px solid var(--line);padding:14px 0}summary{font-weight:600;cursor:pointer}
footer{background:#0a2c42;color:#b7c8d6;padding:28px 0;font-size:14px}footer a{color:#dbe7ef}
.legal h2{font-size:20px;margin-top:28px}.legal{max-width:780px}
.frame{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#f3f5f8}
@media (max-width:640px){nav a{margin-left:12px;font-size:14px}nav .hide-sm{display:none}.btn.ghost{margin:10px 0 0}}
`;

export function layout(cfg: Config, title: string, body: string): string {
  const company = [cfg.companyLegalName, cfg.companyNumber && `Company no. ${cfg.companyNumber}`, cfg.companyAddress].filter(Boolean).map(esc).join(" · ");
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="Daily email alerts of UK government cleaning contracts from official sources. £${cfg.priceGbp}/month.">
<style>${CSS}</style></head><body>
<header><div class="wrap"><a class="logo" href="/">TenderScout <span>UK</span></a>
<nav><a href="/#how" class="hide-sm">How it works</a><a href="/example">Example alert</a><a href="/#pricing">Pricing</a><a href="/#faq" class="hide-sm">FAQ</a></nav></div></header>
<main>${body}</main>
<footer><div class="wrap">
<p>© ${new Date().getFullYear()} ${company}</p>
<p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of service</a> · Contact: <a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a></p>
<p class="small" style="color:#8fa6b8">Tender data from Find a Tender and Contracts Finder. Contains public sector information licensed under the Open Government Licence v3.0. TenderScout UK is an independent service and is not affiliated with the UK Government.</p>
</div></footer></body></html>`;
}

export function regionCheckboxes(selected: string[]): string {
  const all = selected.includes("ALL");
  return `<div class="regions">
<label><input type="checkbox" name="regions" value="ALL" ${all ? "checked" : ""}> <strong>All UK regions</strong></label>
${Object.entries(REGIONS).map(([code, name]) => `<label><input type="checkbox" name="regions" value="${code}" ${!all && selected.includes(code) ? "checked" : ""}> ${esc(name)}</label>`).join("\n")}
</div>`;
}

export function homePage(cfg: Config, opts: { cancelled?: boolean; openCount?: number } = {}): string {
  const faqs: [string, string][] = [
    ["Where do the contracts come from?", "Only official UK government sources: <strong>Find a Tender</strong> (the UK's central procurement platform for higher-value contracts, including Scotland, Wales and Northern Ireland) and <strong>Contracts Finder</strong> (lower-value public contracts in England). Every alert links straight to the official notice."],
    ["What counts as a cleaning contract?", "Notices classified under official cleaning CPV codes (office, school, building, window, washroom and janitorial cleaning) or clearly described as cleaning services. We filter out cleaning products, pest control, drainage and street sweeping."],
    ["When do alerts arrive?", "Every day at 7:00am UK time. If nothing new matches your regions, we send a short ‘no new contracts’ note with any earlier opportunities that are still open, so you know the service is working."],
    ["Can I choose my regions?", "Yes. Pick any of the 12 UK regions (or all of them) at signup and change them at any time from the link in every email. National contracts and notices without a stated location are always included."],
    ["How do I cancel?", "Any time, in two clicks, through the secure Stripe billing portal linked in every email. No phone calls, no notice period. You keep access until the end of the month you've paid for."],
    ["Do you bid for me or guarantee wins?", "No. We find and summarise opportunities; you decide what to bid for and submit through the buyer's official portal. Always check the full notice for requirements and deadlines."],
    ["Will you send me marketing emails?", "No. You'll only receive the alerts you subscribed to and essential account emails. We never sell or share your details."],
  ];
  return layout(cfg, "TenderScout UK – Government cleaning contract alerts", `
<div class="hero"><div class="wrap">
<h1>Win more public-sector cleaning contracts</h1>
<p>Every morning at 7am, get the new UK government cleaning tenders for your regions in one clear email, with direct links to the official notices.</p>
<a class="btn" href="#signup">Start for £${cfg.priceGbp}/month</a><a class="btn ghost" href="/example">See an example alert</a>
</div></div>

<section id="how"><div class="wrap">
<h2>How it works</h2><p class="lead">No searching portals, no missed deadlines.</p>
<div class="grid">
<div class="card"><h3>1. We scan official sources daily</h3><p>Find a Tender and Contracts Finder, the UK's official public procurement platforms.</p></div>
<div class="card"><h3>2. We filter for cleaning work</h3><p>Office, school, NHS, housing, window and washroom cleaning. Duplicates and expired notices are removed.</p></div>
<div class="card"><h3>3. You get one email at 7am</h3><p>Title, buyer, region, value, deadline and a summary for each opportunity, with a link to the official notice.</p></div>
</div></div></section>

<section class="alt"><div class="wrap">
<h2>Who it's for</h2>
<div class="grid">
<div class="card"><h3>Commercial cleaning companies</h3><p>Small and mid-sized firms that want steady public-sector work without paying for a bid team.</p></div>
<div class="card"><h3>Window & specialist cleaners</h3><p>Window, high-level, communal-area and washroom hygiene contracts from councils, schools, NHS trusts and housing associations.</p></div>
<div class="card"><h3>Regional operators</h3><p>Only see contracts in the regions you actually cover.</p></div>
</div></div></section>

<section id="pricing"><div class="wrap price">
<h2>Simple pricing</h2>
<div class="card"><div class="amt">£${cfg.priceGbp}<small>/month</small></div>
<ul><li>Daily 7am cleaning-contract alerts</li><li>Choose any UK regions</li><li>Direct links to official notices</li><li>Cancel any time, online</li></ul>
<a class="btn" href="#signup" style="width:100%">Subscribe</a>
<p class="small">Secure payment by Stripe. No setup fee, no contract.</p></div>
</div></section>

<section id="signup" class="alt"><div class="wrap" style="max-width:720px">
<h2>Start your subscription</h2>
${opts.cancelled ? `<div class="notice warn">Checkout was cancelled and you haven't been charged. You can try again below.</div>` : ""}
<form method="post" action="/signup">
<div class="row"><label for="email">Work email</label><input id="email" type="email" name="email" required maxlength="200" autocomplete="email"></div>
<div class="row"><label for="company">Company name</label><input id="company" type="text" name="company" required maxlength="120" autocomplete="organization"></div>
<div class="row"><label>Regions you cover</label>${regionCheckboxes(["ALL"])}<p class="small">You can change these any time.</p></div>
<div class="row check"><label><input type="checkbox" name="consent" value="yes" required> I agree to the <a href="/terms" target="_blank">Terms</a> and have read the <a href="/privacy" target="_blank">Privacy policy</a>. I understand this is a £${cfg.priceGbp}/month subscription for business use and I'll receive daily alert emails.</label></div>
<button class="btn" type="submit">Continue to secure payment</button>
<p class="small">You'll be taken to Stripe to pay. Alerts start once payment is confirmed.</p>
</form></div></section>

<section id="faq"><div class="wrap" style="max-width:780px">
<h2>FAQ</h2>
${faqs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${a}</p></details>`).join("\n")}
<p style="margin-top:24px">Other questions? Email <a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a>.</p>
</div></section>`);
}

export function messagePage(cfg: Config, title: string, html: string): string {
  return layout(cfg, `${title} – TenderScout UK`, `<section><div class="wrap" style="max-width:720px"><h2>${esc(title)}</h2>${html}</div></section>`);
}

export function examplePage(cfg: Config, emailHtml: string, live: boolean): string {
  return layout(cfg, "Example alert – TenderScout UK", `<section><div class="wrap">
<h2>Example daily alert</h2>
<p class="lead">${live ? "This example is built from real cleaning tenders currently open on the official UK government platforms. Subscribers get one of these every morning at 7am, filtered to their regions." : "Example of the daily alert format."}</p>
<div class="frame"><iframe title="Example alert email" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(emailHtml)}" style="width:100%;height:1400px;border:0;display:block"></iframe></div>
<p style="margin-top:24px"><a class="btn" href="/#signup">Get these alerts for £${cfg.priceGbp}/month</a></p>
</div></section>`);
}

export function preferencesPage(cfg: Config, sub: { token: string; email: string; regions: string[]; emails_enabled: number; status: string }, saved = false): string {
  const masked = sub.email.replace(/^(.)[^@]*(@.*)$/, "$1***$2");
  return messagePage(cfg, "Your alert preferences", `
${saved ? `<div class="notice">Preferences saved.</div>` : ""}
${sub.status !== "active" ? `<div class="notice warn">Your subscription is not currently active (status: ${esc(sub.status)}). Alerts are only sent to active subscriptions.</div>` : ""}
<p class="small">Account: ${esc(masked)}</p>
<form method="post" action="/preferences">
<input type="hidden" name="token" value="${esc(sub.token)}">
<div class="row"><label>Regions</label>${regionCheckboxes(sub.regions)}</div>
<div class="row check"><label><input type="checkbox" name="emails" value="on" ${sub.emails_enabled ? "checked" : ""}> Send me the daily 7am alert email</label></div>
<button class="btn" type="submit">Save preferences</button>
</form>
<p style="margin-top:28px"><a href="/billing?token=${encodeURIComponent(sub.token)}">Manage billing, invoices or cancel subscription →</a></p>`);
}

export function privacyPage(cfg: Config): string {
  return layout(cfg, "Privacy policy – TenderScout UK", `<section><div class="wrap legal">
<h1>Privacy policy</h1><p class="small">Last updated: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</p>
<h2>Who we are</h2><p>TenderScout UK is operated by ${esc(cfg.companyLegalName)}, ${esc(cfg.companyAddress)} (“we”). We are the data controller for personal data processed through this service.${cfg.icoNumber ? ` ICO registration number: ${esc(cfg.icoNumber)}.` : ""} Contact: <a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a>.</p>
<h2>What we collect</h2><ul>
<li><strong>Account details</strong>: your email address, company name and chosen regions.</li>
<li><strong>Billing references</strong>: your Stripe customer and subscription IDs and subscription status. Card details are collected and held by Stripe; we never see or store them.</li>
<li><strong>Service records</strong>: which alerts were sent to you and when, and records of your consent to these terms.</li>
<li><strong>Technical data</strong>: our server may briefly log IP addresses for security and abuse prevention.</li></ul>
<p>We do not use advertising or analytics cookies. Stripe sets its own cookies on its checkout and billing pages.</p>
<h2>Why we use it (lawful bases)</h2><ul>
<li>To provide the subscription you asked for: sending alerts, managing your account and billing (<em>performance of a contract</em>).</li>
<li>To keep the service secure and prevent fraud (<em>legitimate interests</em>).</li>
<li>To keep financial records as required by law (<em>legal obligation</em>).</li></ul>
<p>We do not send marketing emails, and we never sell or share your data for marketing.</p>
<h2>Who we share it with</h2><p>Only service providers who process data on our behalf under contract: Stripe (payments), our email delivery provider and our hosting provider. Some of these may process data outside the UK. Where they do, the transfer is protected by UK adequacy regulations or the ICO's International Data Transfer Agreement or Addendum.</p>
<h2>How long we keep it</h2><p>While your subscription is active, and for ${cfg.retentionDays} days after it ends, after which your account data is deleted automatically. Incomplete signups are deleted after 30 days. Invoices and payment records are kept by Stripe and us for 6 years, as tax law requires.</p>
<h2>Your rights</h2><p>Under UK GDPR you can request access to, correction of, deletion of or a copy of your data, and you can object to or restrict our use of it. Email <a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a>. You can also complain to the Information Commissioner's Office (ico.org.uk, 0303 123 1113).</p>
<h2>Tender data</h2><p>Contract notices come from public UK government sources under the Open Government Licence. They may contain the names of public-sector contact points as published by the buyer.</p>
</div></section>`);
}

export function termsPage(cfg: Config): string {
  return layout(cfg, "Terms of service – TenderScout UK", `<section><div class="wrap legal">
<h1>Terms of service</h1><p class="small">Last updated: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</p>
<h2>1. The service</h2><p>TenderScout UK (operated by ${esc(cfg.companyLegalName)}) sends a daily email listing UK public-sector cleaning contract notices from official government sources (Find a Tender and Contracts Finder), filtered to your chosen regions. The service is for business customers only.</p>
<h2>2. Subscription and payment</h2><p>The subscription costs £${cfg.priceGbp} per month, billed in advance each month by Stripe until you cancel. Alerts start once your first payment is confirmed. We will give you at least 30 days' notice by email of any price change.</p>
<h2>3. Cancellation</h2><p>You can cancel at any time through the billing portal linked in every email. Cancellation takes effect at the end of the current paid month and you keep access until then. We don't refund part months, except where the law requires it.</p>
<h2>4. Accuracy of information</h2><p>We take notices directly from official sources but do not create or check their content. Notices can change, be corrected or be withdrawn by the buyer. Before deciding to bid, always read the full official notice and the buyer's tender documents, including deadlines and requirements. We do not guarantee that every relevant opportunity will be found or that any bid will succeed.</p>
<h2>5. Acceptable use</h2><p>Alerts are for use within your own business. Please don't resell or republish them in bulk.</p>
<h2>6. Liability</h2><p>Nothing in these terms limits liability that cannot legally be limited. Otherwise, we are not liable for lost profits, lost contracts or indirect losses, and our total liability is limited to the fees you paid in the 12 months before the claim.</p>
<h2>7. Changes and suspension</h2><p>We may update these terms with reasonable notice. We may suspend the service if payment fails, and we will resume it once payment succeeds.</p>
<h2>8. Law</h2><p>These terms are governed by the law of England and Wales, and the courts of England and Wales have jurisdiction.</p>
<h2>Contact</h2><p><a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a> · ${esc(cfg.companyAddress)}</p>
</div></section>`);
}
