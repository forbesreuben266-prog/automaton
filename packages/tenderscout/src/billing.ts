/**
 * Stripe Checkout (subscription mode) + signature-verified webhooks + Customer Portal.
 * Paid access is ONLY granted from verified webhook events confirming payment.
 */
import Stripe from "stripe";
import type { Config } from "./config.js";
import { assertPaymentSafety } from "./config.js";
import type { DB, Subscriber } from "./db.js";
import { getSubscriberById, getSubscriberByStripe, setSubscriberStatus } from "./db.js";
import { renderWelcome } from "./digest.js";
import type { Mailer } from "./mailer.js";
import { log } from "./log.js";

export function createStripe(cfg: Config): Stripe | null {
  if (!cfg.stripe.secretKey) return null;
  assertPaymentSafety(cfg);
  return new Stripe(cfg.stripe.secretKey);
}

export async function createCheckoutUrl(stripe: Stripe, cfg: Config, sub: Subscriber): Promise<string> {
  if (!cfg.stripe.priceId) throw new Error("STRIPE_PRICE_ID not set");
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: cfg.stripe.priceId, quantity: 1 }],
    ...(sub.stripe_customer_id ? { customer: sub.stripe_customer_id } : { customer_email: sub.email }),
    client_reference_id: sub.id,
    metadata: { subscriber_id: sub.id },
    subscription_data: { metadata: { subscriber_id: sub.id } },
    allow_promotion_codes: true,
    success_url: `${cfg.baseUrl}/welcome`,
    cancel_url: `${cfg.baseUrl}/?cancelled=1#signup`,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

export async function createPortalUrl(stripe: Stripe, cfg: Config, sub: Subscriber): Promise<string | null> {
  if (!sub.stripe_customer_id) return null;
  const s = await stripe.billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: `${cfg.baseUrl}/preferences?token=${encodeURIComponent(sub.token)}` });
  return s.url;
}

/** Map Stripe subscription status to ours. */
export function mapStatus(s: string): string {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid" || s === "paused") return "past_due";
  if (s === "canceled" || s === "incomplete_expired") return "cancelled";
  return "pending"; // incomplete
}

const idOf = (x: unknown): string | null => (typeof x === "string" ? x : (x as any)?.id ?? null);

async function activate(db: DB, cfg: Config, mailer: Mailer, sub: Subscriber, stripeIds: { customer?: string | null; subscription?: string | null }) {
  setSubscriberStatus(db, sub.id, "active", stripeIds);
  const fresh = getSubscriberById(db, sub.id)!;
  if (!fresh.welcomed) {
    try {
      await mailer.send(renderWelcome(cfg, fresh));
      db.prepare("UPDATE subscribers SET welcomed=1 WHERE id=?").run(sub.id);
    } catch (e) {
      log.error("welcome.send_failed", { subscriber: sub.id, error: String(e) });
    }
  }
  log.info("subscriber.activated", { subscriber: sub.id });
}

function findSub(db: DB, obj: any): Subscriber | undefined {
  const metaId = obj?.metadata?.subscriber_id
    ?? obj?.subscription_details?.metadata?.subscriber_id
    ?? obj?.parent?.subscription_details?.metadata?.subscriber_id
    ?? obj?.client_reference_id;
  return (metaId && getSubscriberById(db, metaId))
    || getSubscriberByStripe(db, idOf(obj?.customer), idOf(obj?.subscription) ?? idOf(obj?.parent?.subscription_details?.subscription) ?? (obj?.object === "subscription" ? obj.id : null));
}

/** Process a verified event. Idempotent: each event id is processed at most once. */
export async function handleStripeEvent(db: DB, cfg: Config, mailer: Mailer, event: Stripe.Event): Promise<void> {
  if (db.prepare("SELECT 1 FROM stripe_events WHERE id=?").get(event.id)) return;
  const obj: any = event.data.object;
  const sub = findSub(db, obj);
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (!sub || obj.mode !== "subscription") break;
      const ids = { customer: idOf(obj.customer), subscription: idOf(obj.subscription) };
      if (obj.payment_status === "paid") await activate(db, cfg, mailer, sub, ids);
      else setSubscriberStatus(db, sub.id, sub.status === "active" ? "active" : "pending", ids); // wait for invoice.paid
      break;
    }
    case "invoice.paid": {
      if (sub && sub.status !== "cancelled") {
        await activate(db, cfg, mailer, sub, {
          customer: idOf(obj.customer),
          subscription: idOf(obj.subscription) ?? idOf(obj.parent?.subscription_details?.subscription),
        });
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (!sub) break;
      const status = event.type === "customer.subscription.deleted" ? "cancelled" : mapStatus(obj.status);
      const ids = { customer: idOf(obj.customer), subscription: obj.id };
      if (status === "active") await activate(db, cfg, mailer, sub, ids);
      else setSubscriberStatus(db, sub.id, status === "pending" && sub.status === "active" ? "active" : status, ids);
      log.info("subscriber.status", { subscriber: sub.id, status });
      break;
    }
    default:
      break;
  }
  if (!sub && /^(customer\.subscription|checkout\.session|invoice\.paid)/.test(event.type)) {
    log.warn("stripe.event.unmatched", { type: event.type, id: event.id });
  }
  db.prepare("INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)").run(event.id, event.type);
}

export function verifyStripeEvent(stripe: Stripe, cfg: Config, rawBody: Buffer, signature: string | undefined): Stripe.Event {
  if (!cfg.stripe.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  if (!signature) throw new Error("Missing Stripe-Signature header");
  return stripe.webhooks.constructEvent(rawBody, signature, cfg.stripe.webhookSecret);
}
