/** Minimal HTTP server (node:http, no framework). */
import http from "node:http";
import type Stripe from "stripe";
import type { Config } from "../config.js";
import type { DB } from "../db.js";
import { createPendingSubscriber, getSubscriberByToken, openTenders, updatePreferences } from "../db.js";
import { exampleSubscriber, renderDigest, renderManageLink } from "../digest.js";
import type { Mailer } from "../mailer.js";
import { createCheckoutUrl, createPortalUrl, handleStripeEvent, verifyStripeEvent } from "../billing.js";
import { sanitizeRegions } from "../regions.js";
import { examplePage, homePage, messagePage, preferencesPage, privacyPage, termsPage } from "./pages.js";
import { log } from "../log.js";

export interface AppDeps { db: DB; cfg: Config; mailer: Mailer; stripe: Stripe | null }

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", // links carry private tokens
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};

function send(res: http.ServerResponse, status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra });
  res.end(body);
}
const redirect = (res: http.ServerResponse, url: string) => { res.writeHead(303, { Location: url, ...SECURITY_HEADERS }); res.end(); };

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// simple per-IP rate limit for signup
const hits = new Map<string, number[]>();
function rateLimited(ip: string, max = 10, windowMs = 3_600_000): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => t > now - windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]+\.[a-z]{2,}$/i;

export function createApp(deps: AppDeps) {
  const { db, cfg, mailer, stripe } = deps;

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /":
          return send(res, 200, homePage(cfg, { cancelled: url.searchParams.has("cancelled") }));
        case "GET /example": {
          const now = new Date();
          const items = openTenders(db, now.toISOString()).slice(0, 6);
          const email = renderDigest(cfg, exampleSubscriber(), items, [], now);
          const html = email.html.replace("<head>", '<head><base target="_blank">');
          return send(res, 200, examplePage(cfg, html, items.length > 0));
        }
        case "GET /privacy": return send(res, 200, privacyPage(cfg));
        case "GET /terms": return send(res, 200, termsPage(cfg));
        case "GET /healthz": {
          const last = db.prepare("SELECT finished_at, ok FROM runs WHERE kind='scan' ORDER BY id DESC LIMIT 1").get() as any;
          return send(res, 200, JSON.stringify({ ok: true, dryRun: cfg.dryRun, lastScan: last ?? null }), "application/json");
        }

        case "POST /signup": {
          const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
          if (rateLimited(ip)) return send(res, 429, messagePage(cfg, "Too many attempts", "<p>Please try again later.</p>"));
          const form = new URLSearchParams((await readBody(req, 20_000)).toString("utf8"));
          const email = (form.get("email") ?? "").trim().toLowerCase();
          const company = (form.get("company") ?? "").trim().slice(0, 120);
          const regions = sanitizeRegions(form.getAll("regions"));
          if (!EMAIL_RE.test(email) || email.length > 200 || !company || form.get("consent") !== "yes") {
            return send(res, 400, messagePage(cfg, "Please check your details", `<p>A valid work email, your company name and agreement to the terms are required.</p><p><a href="/#signup">Go back</a></p>`));
          }
          const sub = createPendingSubscriber(db, email, company, regions);
          if (sub.status === "active") {
            // Don't reveal account existence on-screen; email the owner instead.
            await mailer.send(renderManageLink(cfg, sub)).catch((e) => log.error("manage_link.failed", { error: String(e) }));
            return send(res, 200, messagePage(cfg, "Check your inbox", "<p>We've emailed you a link to continue.</p>"));
          }
          if (!stripe) return send(res, 503, messagePage(cfg, "Payments not configured", "<p>Online payment isn't available yet. Please try again later.</p>"));
          return redirect(res, await createCheckoutUrl(stripe, cfg, sub));
        }
        case "GET /welcome":
          return send(res, 200, messagePage(cfg, "Thank you!", `<p>Your payment is being confirmed by Stripe. Once it's confirmed (usually within a minute) we'll email you a welcome message with your preference and billing links.</p><p>Your first alert will arrive at <strong>7:00am</strong> on the next morning.</p><p>If no welcome email arrives within an hour, check your spam folder or contact <a href="mailto:${cfg.contactEmail}">${cfg.contactEmail}</a>.</p>`));

        case "GET /preferences": {
          const sub = getSubscriberByToken(db, url.searchParams.get("token") ?? "");
          if (!sub) return send(res, 404, messagePage(cfg, "Link not recognised", "<p>This link is invalid or has expired.</p>"));
          return send(res, 200, preferencesPage(cfg, sub));
        }
        case "POST /preferences": {
          const form = new URLSearchParams((await readBody(req, 20_000)).toString("utf8"));
          const sub = getSubscriberByToken(db, form.get("token") ?? "");
          if (!sub) return send(res, 404, messagePage(cfg, "Link not recognised", "<p>This link is invalid or has expired.</p>"));
          updatePreferences(db, sub.id, sanitizeRegions(form.getAll("regions")), form.get("emails") === "on");
          return send(res, 200, preferencesPage(cfg, getSubscriberByToken(db, sub.token)!, true));
        }

        case "GET /unsubscribe": {
          const token = url.searchParams.get("token") ?? "";
          const sub = getSubscriberByToken(db, token);
          if (!sub) return send(res, 404, messagePage(cfg, "Link not recognised", "<p>This link is invalid or has expired.</p>"));
          return send(res, 200, messagePage(cfg, "Stop daily emails?", `<form method="post" action="/unsubscribe?token=${encodeURIComponent(token)}"><p>You'll stop receiving TenderScout alert emails.</p><button class="btn" type="submit">Stop emails</button></form><p class="small" style="margin-top:18px">Stopping emails does not cancel billing. To cancel your subscription, use <a href="/billing?token=${encodeURIComponent(token)}">billing &amp; cancellation</a>.</p>`));
        }
        case "POST /unsubscribe": { // also handles RFC 8058 one-click from mail clients
          await readBody(req, 5_000).catch(() => Buffer.alloc(0));
          const sub = getSubscriberByToken(db, url.searchParams.get("token") ?? "");
          if (!sub) return send(res, 404, messagePage(cfg, "Link not recognised", "<p>This link is invalid or has expired.</p>"));
          updatePreferences(db, sub.id, sub.regions, false);
          log.info("subscriber.unsubscribed", { subscriber: sub.id });
          return send(res, 200, messagePage(cfg, "You've been unsubscribed", `<p>You won't receive any more alert emails.</p><p><a href="/preferences?token=${encodeURIComponent(sub.token)}">Turn emails back on</a> · <a href="/billing?token=${encodeURIComponent(sub.token)}">Cancel subscription / billing</a></p>`));
        }

        case "GET /billing": {
          const sub = getSubscriberByToken(db, url.searchParams.get("token") ?? "");
          if (!sub) return send(res, 404, messagePage(cfg, "Link not recognised", "<p>This link is invalid or has expired.</p>"));
          const portal = stripe ? await createPortalUrl(stripe, cfg, sub) : null;
          if (!portal) return send(res, 200, messagePage(cfg, "Billing", `<p>No billing account found for this subscription. Contact <a href="mailto:${cfg.contactEmail}">${cfg.contactEmail}</a>.</p>`));
          return redirect(res, portal);
        }

        case "POST /webhooks/stripe": {
          if (!stripe) return send(res, 503, "stripe not configured", "text/plain");
          const raw = await readBody(req, 1_000_000);
          let event;
          try {
            event = verifyStripeEvent(stripe, cfg, raw, req.headers["stripe-signature"] as string | undefined);
          } catch (e) {
            log.warn("stripe.webhook.bad_signature", { error: String(e) });
            return send(res, 400, "invalid signature", "text/plain");
          }
          await handleStripeEvent(db, cfg, mailer, event);
          return send(res, 200, JSON.stringify({ received: true }), "application/json");
        }
        default:
          return send(res, 404, messagePage(cfg, "Page not found", `<p><a href="/">Go to the homepage</a></p>`));
      }
    } catch (e) {
      log.error("http.error", { route, error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) send(res, 500, messagePage(cfg, "Something went wrong", "<p>Please try again in a moment.</p>"));
    }
  };
}

export function startServer(deps: AppDeps): http.Server {
  const server = http.createServer(createApp(deps));
  server.listen(deps.cfg.port, () => log.info("http.listening", { port: deps.cfg.port, dryRun: deps.cfg.dryRun }));
  return server;
}
