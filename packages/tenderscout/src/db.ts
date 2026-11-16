/**
 * SQLite storage (better-sqlite3, same engine as Automaton) in its own DB file,
 * so TenderScout never touches Automaton's state.db.
 */
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Tender } from "./types.js";

export type DB = BetterSqlite3.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenders (
  id TEXT PRIMARY KEY,               -- source:ocid
  source TEXT NOT NULL,
  ocid TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  alt_key TEXT,
  title TEXT NOT NULL,
  buyer TEXT NOT NULL,
  regions TEXT NOT NULL,             -- JSON array of region codes
  location_label TEXT NOT NULL,
  description TEXT NOT NULL,
  value_amount REAL,
  value_currency TEXT,
  deadline TEXT,
  deadline_kind TEXT,
  published TEXT,
  url TEXT NOT NULL,
  cpv TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenders_fp ON tenders(fingerprint);
CREATE INDEX IF NOT EXISTS idx_tenders_alt ON tenders(alt_key);
CREATE INDEX IF NOT EXISTS idx_tenders_deadline ON tenders(deadline);

CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  company TEXT NOT NULL DEFAULT '',
  regions TEXT NOT NULL DEFAULT '["ALL"]',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | past_due | cancelled
  emails_enabled INTEGER NOT NULL DEFAULT 1,
  token TEXT NOT NULL UNIQUE,                -- secret for preference/unsubscribe links
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  welcomed INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS email_log (
  subscriber_id TEXT NOT NULL,
  digest_date TEXT NOT NULL,                 -- YYYY-MM-DD (UK)
  status TEXT NOT NULL,                      -- sending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subscriber_id, digest_date)
);

CREATE TABLE IF NOT EXISTS sent_items (
  subscriber_id TEXT NOT NULL,
  tender_fp TEXT NOT NULL,
  digest_date TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, tender_fp)
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  ok INTEGER,
  detail TEXT
);
`;

export function openDb(dbPath: string): DB {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export const newId = () => crypto.randomUUID();
export const newToken = () => crypto.randomBytes(24).toString("base64url");

// ---------- tenders ----------

export interface UpsertResult { inserted: number; updated: number; duplicates: number }

export function upsertTenders(db: DB, tenders: Tender[]): UpsertResult {
  const res: UpsertResult = { inserted: 0, updated: 0, duplicates: 0 };
  const byId = db.prepare("SELECT id FROM tenders WHERE id = ?");
  const byFp = db.prepare("SELECT id FROM tenders WHERE (fingerprint = @fp OR (alt_key IS NOT NULL AND alt_key = @alt)) AND id != @id");
  const ins = db.prepare(`INSERT INTO tenders
    (id, source, ocid, fingerprint, alt_key, title, buyer, regions, location_label, description,
     value_amount, value_currency, deadline, deadline_kind, published, url, cpv, status)
    VALUES (@id,@source,@ocid,@fingerprint,@altKey,@title,@buyer,@regions,@locationLabel,@description,
     @valueAmount,@valueCurrency,@deadline,@deadlineKind,@published,@url,@cpv,@status)`);
  const upd = db.prepare(`UPDATE tenders SET title=@title, buyer=@buyer, regions=@regions,
    location_label=@locationLabel, description=@description, value_amount=@valueAmount,
    value_currency=@valueCurrency, deadline=@deadline, deadline_kind=@deadlineKind, url=@url, cpv=@cpv, status=@status,
    updated_at=datetime('now') WHERE id=@id`);
  db.transaction(() => {
    for (const t of tenders) {
      const row = { ...t, regions: JSON.stringify(t.regions), cpv: t.cpv.join(",") };
      if (byId.get(t.id)) { upd.run(row); res.updated++; continue; }
      if (byFp.get({ fp: t.fingerprint, alt: t.altKey, id: t.id })) { res.duplicates++; continue; } // same notice on another platform
      ins.run(row); res.inserted++;
    }
  })();
  return res;
}

export function closeTenders(db: DB, ids: string[], fingerprints: string[]) {
  const st = db.prepare("UPDATE tenders SET status='complete', updated_at=datetime('now') WHERE id=? OR fingerprint=?");
  db.transaction(() => ids.forEach((id, i) => st.run(id, fingerprints[i])))();
}

export interface TenderRow {
  id: string; source: string; fingerprint: string; title: string; buyer: string;
  regions: string[]; location_label: string; description: string; value_amount: number | null;
  value_currency: string | null; deadline: string | null; deadline_kind: string | null; published: string | null; url: string;
  status: string; first_seen: string;
}

export function openTenders(db: DB, nowIso: string): TenderRow[] {
  const rows = db.prepare(`SELECT * FROM tenders
     WHERE status IN ('active','planned') AND (deadline IS NULL OR deadline > ?)
     ORDER BY (deadline IS NULL), deadline ASC`).all(nowIso) as any[];
  return rows.map((r) => ({ ...r, regions: JSON.parse(r.regions) }));
}

// ---------- subscribers ----------

export interface Subscriber {
  id: string; email: string; company: string; regions: string[]; status: string;
  emails_enabled: number; token: string; stripe_customer_id: string | null;
  stripe_subscription_id: string | null; welcomed: number;
}

const toSub = (r: any): Subscriber | undefined => (r ? { ...r, regions: JSON.parse(r.regions) } : undefined);

export const getSubscriberByToken = (db: DB, token: string) =>
  toSub(db.prepare("SELECT * FROM subscribers WHERE token = ?").get(token));
export const getSubscriberById = (db: DB, id: string) =>
  toSub(db.prepare("SELECT * FROM subscribers WHERE id = ?").get(id));
export const getSubscriberByEmail = (db: DB, email: string) =>
  toSub(db.prepare("SELECT * FROM subscribers WHERE email = ?").get(email));
export const getSubscriberByStripe = (db: DB, customerId?: string | null, subId?: string | null) =>
  toSub(db.prepare(`SELECT * FROM subscribers WHERE (stripe_subscription_id = ? AND ? IS NOT NULL)
     OR (stripe_customer_id = ? AND ? IS NOT NULL) LIMIT 1`).get(subId ?? null, subId ?? null, customerId ?? null, customerId ?? null));

export function createPendingSubscriber(db: DB, email: string, company: string, regions: string[]): Subscriber {
  const existing = getSubscriberByEmail(db, email);
  if (existing) {
    db.prepare("UPDATE subscribers SET company=?, regions=?, consent_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(company, JSON.stringify(regions), existing.id);
    return getSubscriberById(db, existing.id)!;
  }
  const id = newId();
  db.prepare(`INSERT INTO subscribers (id, email, company, regions, token, consent_at)
     VALUES (?,?,?,?,?,datetime('now'))`).run(id, email, company, JSON.stringify(regions), newToken());
  return getSubscriberById(db, id)!;
}

export function setSubscriberStatus(db: DB, id: string, status: string, stripe?: { customer?: string | null; subscription?: string | null }) {
  db.prepare(`UPDATE subscribers SET status=?,
      stripe_customer_id=COALESCE(?, stripe_customer_id),
      stripe_subscription_id=COALESCE(?, stripe_subscription_id),
      cancelled_at=CASE WHEN ?='cancelled' THEN datetime('now') ELSE NULL END,
      updated_at=datetime('now') WHERE id=?`)
    .run(status, stripe?.customer ?? null, stripe?.subscription ?? null, status, id);
}

export function updatePreferences(db: DB, id: string, regions: string[], emailsEnabled: boolean) {
  db.prepare("UPDATE subscribers SET regions=?, emails_enabled=?, updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify(regions), emailsEnabled ? 1 : 0, id);
}

export const activeRecipients = (db: DB): Subscriber[] =>
  (db.prepare("SELECT * FROM subscribers WHERE status='active' AND emails_enabled=1").all() as any[]).map((r) => toSub(r)!);

/** UK GDPR storage limitation: remove personal data of long-cancelled/abandoned signups. */
export function purgeOldData(db: DB, retentionDays: number): number {
  const cutoff = `-${retentionDays} days`;
  return db.transaction(() => {
    const ids = (db.prepare(`SELECT id FROM subscribers WHERE
        (status='cancelled' AND cancelled_at < datetime('now', ?)) OR
        (status='pending' AND created_at < datetime('now', '-30 days'))`).all(cutoff) as any[]).map((r) => r.id);
    for (const id of ids) {
      db.prepare("DELETE FROM sent_items WHERE subscriber_id=?").run(id);
      db.prepare("DELETE FROM email_log WHERE subscriber_id=?").run(id);
      db.prepare("DELETE FROM subscribers WHERE id=?").run(id);
    }
    db.prepare("DELETE FROM tenders WHERE deadline < datetime('now', '-90 days')").run();
    return ids.length;
  })();
}
