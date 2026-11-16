/**
 * TenderScout configuration. Everything comes from environment variables.
 * Safe defaults: dry-run ON, live Stripe keys refused unless explicitly allowed.
 */
import fs from "node:fs";
import path from "node:path";

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const bool = (v: string | undefined, def: boolean) =>
  v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase());

export interface Config {
  dryRun: boolean;
  allowLivePayments: boolean;
  dataDir: string;
  dbPath: string;
  outboxDir: string;
  port: number;
  baseUrl: string;
  brandName: string;
  contactEmail: string;
  adminEmail: string;
  companyLegalName: string;
  companyAddress: string;
  companyNumber: string;
  icoNumber: string;
  priceGbp: number;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
  stripe: { secretKey: string; webhookSecret: string; priceId: string };
  digestCron: string;
  timezone: string;
  scanLookbackDays: number;
  retentionDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotEnv(path.resolve(process.cwd(), ".env"));
  const dataDir = path.resolve(env.TS_DATA_DIR || "./data");
  return {
    dryRun: bool(env.TS_DRY_RUN, true),
    allowLivePayments: bool(env.TS_ALLOW_LIVE_PAYMENTS, false),
    dataDir,
    dbPath: env.TS_DB_PATH || path.join(dataDir, "tenderscout.db"),
    outboxDir: env.TS_OUTBOX_DIR || path.join(dataDir, "outbox"),
    port: Number(env.PORT || env.TS_PORT || 3000),
    baseUrl: (env.TS_BASE_URL || "http://localhost:3000").replace(/\/$/, ""),
    brandName: "TenderScout UK",
    contactEmail: env.TS_CONTACT_EMAIL || "hello@example.com",
    adminEmail: env.TS_ADMIN_EMAIL || "",
    companyLegalName: env.TS_COMPANY_LEGAL_NAME || "[Your company legal name]",
    companyAddress: env.TS_COMPANY_ADDRESS || "[Registered address]",
    companyNumber: env.TS_COMPANY_NUMBER || "",
    icoNumber: env.TS_ICO_NUMBER || "",
    priceGbp: 29,
    smtp: {
      host: env.SMTP_HOST || "",
      port: Number(env.SMTP_PORT || 587),
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || "",
      pass: env.SMTP_PASS || "",
      from: env.TS_FROM_EMAIL || "TenderScout UK <alerts@example.com>",
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || "",
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
      priceId: env.STRIPE_PRICE_ID || "",
    },
    digestCron: env.TS_DIGEST_CRON || "0 7 * * *",
    timezone: "Europe/London",
    scanLookbackDays: Number(env.TS_SCAN_LOOKBACK_DAYS || 3),
    retentionDays: Number(env.TS_RETENTION_DAYS || 180),
  };
}

/** Throws if config would charge real cards without explicit approval. */
export function assertPaymentSafety(cfg: Config): void {
  if (cfg.stripe.secretKey.startsWith("sk_live_") && !cfg.allowLivePayments) {
    throw new Error(
      "Refusing to use a LIVE Stripe key. Set TS_ALLOW_LIVE_PAYMENTS=true only once you approve taking real payments.",
    );
  }
}
