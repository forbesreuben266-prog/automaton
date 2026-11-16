/**
 * Daily pipeline: scan -> send digests. Idempotent and safe to re-run:
 *  - email_log has one row per (subscriber, UK date); a 'sent' row is never re-sent.
 *  - A row left in 'sending' (crash mid-send) is NOT retried automatically (it may have been delivered);
 *    the admin is alerted instead. This guarantees no duplicate digests.
 *  - 'failed' rows are retried on later passes, up to MAX_ATTEMPTS.
 */
import cronParser from "cron-parser";
import type { Config } from "./config.js";
import type { DB, Subscriber, TenderRow } from "./db.js";
import { activeRecipients, openTenders, purgeOldData } from "./db.js";
import { renderDigest, ukDate } from "./digest.js";
import type { Mailer } from "./mailer.js";
import { scan, type ScanResult } from "./scanner.js";
import type { Fetcher } from "./sources/ocds.js";
import { matchesRegions } from "./regions.js";
import { log } from "./log.js";

const MAX_ATTEMPTS = 3;

// ---------- admin alerts ----------
const lastAlert = new Map<string, number>();
export async function alertAdmin(cfg: Config, mailer: Mailer, subject: string, detail: string): Promise<void> {
  log.error("alert", { subject, detail });
  const now = Date.now();
  if ((lastAlert.get(subject) ?? 0) > now - 3_600_000) return; // max 1 per subject per hour
  lastAlert.set(subject, now);
  if (!cfg.adminEmail) return;
  try {
    await mailer.send({
      to: cfg.adminEmail,
      subject: `[TenderScout ALERT] ${subject}`,
      text: `${subject}\n\n${detail}\n\nTime: ${new Date().toISOString()}\nHost: ${cfg.baseUrl}`,
      html: `<h3>${subject.replace(/</g, "&lt;")}</h3><pre style="white-space:pre-wrap">${detail.replace(/</g, "&lt;")}</pre><p>Time: ${new Date().toISOString()}</p>`,
    });
  } catch (e) {
    log.error("alert.send_failed", { error: String(e) });
  }
}

// ---------- digest ----------
export function selectForSubscriber(db: DB, sub: Subscriber, open: TenderRow[]) {
  const sent = new Set((db.prepare("SELECT tender_fp FROM sent_items WHERE subscriber_id=?").all(sub.id) as any[]).map((r) => r.tender_fp));
  const mine = open.filter((t) => matchesRegions(t.regions, sub.regions));
  return { items: mine.filter((t) => !sent.has(t.fingerprint)), stillOpen: mine.filter((t) => sent.has(t.fingerprint)) };
}

export interface DigestResult { date: string; sent: number; skipped: number; failed: number; stuck: number }

export async function sendDigests(db: DB, cfg: Config, mailer: Mailer, now = new Date()): Promise<DigestResult> {
  const date = ukDate(now);
  const res: DigestResult = { date, sent: 0, skipped: 0, failed: 0, stuck: 0 };
  const open = openTenders(db, now.toISOString());
  const getLog = db.prepare("SELECT status, attempts FROM email_log WHERE subscriber_id=? AND digest_date=?");
  // Claim atomically: insert, or move failed -> sending. Returns changes=0 if someone else holds it.
  const claim = db.prepare(`INSERT INTO email_log (subscriber_id, digest_date, status, attempts) VALUES (?, ?, 'sending', 1)
     ON CONFLICT(subscriber_id, digest_date) DO UPDATE SET status='sending', attempts=attempts+1, updated_at=datetime('now')
     WHERE email_log.status='failed' AND email_log.attempts < ${MAX_ATTEMPTS}`);
  const markSent = db.prepare("UPDATE email_log SET status='sent', item_count=?, error=NULL, updated_at=datetime('now') WHERE subscriber_id=? AND digest_date=?");
  const markFailed = db.prepare("UPDATE email_log SET status='failed', error=?, updated_at=datetime('now') WHERE subscriber_id=? AND digest_date=?");
  const addItem = db.prepare("INSERT OR IGNORE INTO sent_items (subscriber_id, tender_fp, digest_date) VALUES (?,?,?)");

  for (const sub of activeRecipients(db)) {
    const existing = getLog.get(sub.id, date) as { status: string; attempts: number } | undefined;
    if (existing?.status === "sent") { res.skipped++; continue; }
    if (existing?.status === "sending") { res.stuck++; continue; }
    if (claim.run(sub.id, date).changes === 0) { res.skipped++; continue; }

    const { items, stillOpen } = selectForSubscriber(db, sub, open);
    try {
      const email = renderDigest(cfg, sub, items, stillOpen, now);
      email.headers = { ...email.headers, "X-Entity-Ref-ID": `digest-${sub.id}-${date}` };
      await mailer.send(email);
      db.transaction(() => {
        markSent.run(items.length, sub.id, date);
        for (const t of items) addItem.run(sub.id, t.fingerprint, date);
      })();
      res.sent++;
    } catch (e) {
      markFailed.run(String(e instanceof Error ? e.message : e).slice(0, 500), sub.id, date);
      res.failed++;
      log.error("digest.send_failed", { subscriber: sub.id, error: String(e) });
    }
  }
  return res;
}

// ---------- daily pipeline ----------
export interface DailyResult { scan: ScanResult; digest: DigestResult | null }

export async function runDaily(db: DB, cfg: Config, mailer: Mailer, opts: { now?: Date; fetcher?: Fetcher; finalAttempt?: boolean } = {}): Promise<DailyResult> {
  const now = opts.now ?? new Date();
  const scanRes = await scan(db, { lookbackDays: cfg.scanLookbackDays, now, fetcher: opts.fetcher });
  if (scanRes.errors.length) {
    await alertAdmin(cfg, mailer, "Tender scanner source failure", scanRes.errors.map((e) => `${e.source}: ${e.error}`).join("\n"));
  }
  // If every source failed, don't send "no results" emails based on stale data — retry later.
  if (!scanRes.ok && !opts.finalAttempt) return { scan: scanRes, digest: null };

  const digest = await sendDigests(db, cfg, mailer, now);
  log.info("digest.done", { ...digest });
  if (digest.failed || digest.stuck) {
    await alertAdmin(cfg, mailer, "Digest delivery problems",
      `Date ${digest.date}: ${digest.failed} failed (will retry up to ${MAX_ATTEMPTS}x), ${digest.stuck} stuck in 'sending' (NOT auto-retried to avoid duplicates; check your email provider logs, then run: tenderscout resolve-stuck ${digest.date} --sent|--retry).`);
  }
  try { purgeOldData(db, cfg.retentionDays); } catch (e) { log.error("purge.failed", { error: String(e) }); }
  return { scan: scanRes, digest };
}

// ---------- scheduler (07:00 Europe/London, with retry passes) ----------
const RETRY_DELAYS_MIN = [15, 45, 120];

export function nextRunAt(cron: string, tz: string, from = new Date()): Date {
  return cronParser.parseExpression(cron, { tz, currentDate: from }).next().toDate();
}

export function startScheduler(db: DB, cfg: Config, mailer: Mailer): { stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const pass = async (attempt: number) => {
    try {
      const final = attempt >= RETRY_DELAYS_MIN.length;
      const r = await runDaily(db, cfg, mailer, { finalAttempt: final });
      const needRetry = !r.digest || r.digest.failed > 0 || r.scan.errors.length > 0;
      if (needRetry && !final && !stopped) {
        log.warn("daily.retry_scheduled", { inMinutes: RETRY_DELAYS_MIN[attempt] });
        timer = setTimeout(() => pass(attempt + 1), RETRY_DELAYS_MIN[attempt] * 60_000);
        return;
      }
      if (!r.digest) await alertAdmin(cfg, mailer, "Daily digest NOT sent", "All tender sources failed on every retry today.");
    } catch (e) {
      await alertAdmin(cfg, mailer, "Daily job crashed", e instanceof Error ? e.stack ?? e.message : String(e));
    }
    scheduleNext();
  };

  const scheduleNext = () => {
    if (stopped) return;
    const at = nextRunAt(cfg.digestCron, cfg.timezone);
    log.info("scheduler.next_run", { at: at.toISOString() });
    timer = setTimeout(() => pass(0), Math.min(at.getTime() - Date.now(), 2 ** 31 - 1));
  };

  // Catch-up: if we started after today's run time (e.g. restart) and today's digests weren't sent, run now (until noon UK).
  const today = ukDate();
  const ukHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone, hour: "numeric", hour12: false }).format(new Date()));
  const sentToday = (db.prepare("SELECT COUNT(*) c FROM email_log WHERE digest_date=?").get(today) as any).c;
  const lastRun = nextRunAt(cfg.digestCron, cfg.timezone, new Date(Date.now() - 86_400_000));
  if (lastRun.getTime() < Date.now() && ukDate(lastRun) === today && ukHour < 12 && sentToday === 0 && activeRecipients(db).length > 0) {
    log.info("scheduler.catch_up");
    void pass(0);
  } else {
    scheduleNext();
  }
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
