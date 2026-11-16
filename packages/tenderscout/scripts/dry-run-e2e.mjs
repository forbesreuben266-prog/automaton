// Dry-run end-to-end demo: fake signup -> signed Stripe webhook -> activation. Needs `serve` running with STRIPE_WEBHOOK_SECRET=whsec_demo on port 3123.
import Stripe from "stripe";
import Database from "better-sqlite3";
import crypto from "node:crypto";
const db = new Database("./data/tenderscout.db");
const id = crypto.randomUUID(), token = crypto.randomBytes(24).toString("base64url");
db.prepare("INSERT INTO subscribers (id,email,company,regions,token,consent_at) VALUES (?,?,?,?,?,datetime('now'))").run(id, "demo-cleaner@example.com", "Demo Cleaning Ltd", JSON.stringify(["SE","LDN"]), token);
const stripe = new Stripe("sk_test_demo_not_real");
const payload = JSON.stringify({ id: "evt_demo_1", object: "event", type: "checkout.session.completed", data: { object: { object: "checkout.session", mode: "subscription", payment_status: "paid", client_reference_id: id, customer: "cus_demo", subscription: "sub_demo" } } });
const post = (sig) => fetch("http://localhost:3123/webhooks/stripe", { method: "POST", body: payload, headers: { "stripe-signature": sig, "content-type": "application/json" } });
console.log("forged signature ->", (await post("t=1,v1=forged")).status, db.prepare("SELECT status FROM subscribers WHERE id=?").get(id).status);
console.log("valid signature  ->", (await post(stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_demo" }))).status, db.prepare("SELECT status FROM subscribers WHERE id=?").get(id).status);
for (const p of ["/", "/example", "/privacy", "/terms", `/preferences?token=${token}`, "/healthz"]) console.log(p.split("?")[0], (await fetch("http://localhost:3123" + p)).status);
