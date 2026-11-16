#!/usr/bin/env node
/**
 * TenderScout CLI
 *   start                      web server + 07:00 UK daily scheduler (production entrypoint)
 *   serve                      web server only
 *   scan [--days N]            fetch + store tenders now
 *   daily                      run scan + digests once (for external cron instead of `start`)
 *   sample [--regions SE,LDN]  write a sample digest from live data to the outbox (no subscribers needed)
 *   stats                      counts of tenders/subscribers/emails
 *   resolve-stuck DATE --sent|--retry   resolve digests stuck in 'sending' after a crash
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { openDb, openTenders } from "./db.js";
import { createMailer } from "./mailer.js";
import { createStripe } from "./billing.js";
import { scan } from "./scanner.js";
import { runDaily, startScheduler } from "./jobs.js";
import { startServer } from "./web/server.js";
import { renderDigest, exampleSubscriber } from "./digest.js";
import { matchesRegions, sanitizeRegions } from "./regions.js";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const mailer = createMailer(cfg);
  console.error(`[tenderscout] mode: ${cfg.dryRun ? "DRY-RUN (emails written to " + cfg.outboxDir + ")" : "LIVE email"}`);

  switch (cmd) {
    case "start": {
      const stripe = createStripe(cfg);
      startServer({ db, cfg, mailer, stripe });
      startScheduler(db, cfg, mailer);
      break;
    }
    case "serve":
      startServer({ db, cfg, mailer, stripe: createStripe(cfg) });
      break;
    case "scan":
      console.log(JSON.stringify(await scan(db, { lookbackDays: Number(flag("days") ?? cfg.scanLookbackDays) }), null, 2));
      break;
    case "daily":
      console.log(JSON.stringify(await runDaily(db, cfg, mailer), null, 2));
      break;
    case "sample": {
      const regions = sanitizeRegions((flag("regions") ?? "ALL").split(","));
      const now = new Date();
      const items = openTenders(db, now.toISOString()).filter((t) => matchesRegions(t.regions, regions));
      const sub = { ...exampleSubscriber(), regions, email: "sample@example.com" };
      const email = renderDigest(cfg, sub, items, [], now);
      const out = flag("out") ?? path.join(cfg.outboxDir, "sample-digest.html");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, email.html);
      fs.writeFileSync(out.replace(/\.html$/, ".txt"), `Subject: ${email.subject}\n\n${email.text}`);
      console.log(`${items.length} tenders -> ${out}\nSubject: ${email.subject}`);
      break;
    }
    case "stats": {
      const q = (sql: string) => db.prepare(sql).all();
      console.log(JSON.stringify({
        openTenders: openTenders(db, new Date().toISOString()).length,
        tendersBySource: q("SELECT source, COUNT(*) n FROM tenders GROUP BY source"),
        subscribers: q("SELECT status, emails_enabled, COUNT(*) n FROM subscribers GROUP BY status, emails_enabled"),
        emailsLast7Days: q("SELECT digest_date, status, COUNT(*) n FROM email_log WHERE digest_date >= date('now','-7 days') GROUP BY 1,2 ORDER BY 1 DESC"),
        lastRuns: q("SELECT kind, started_at, ok FROM runs ORDER BY id DESC LIMIT 5"),
      }, null, 2));
      break;
    }
    case "resolve-stuck": {
      const date = args[0];
      if (!date || (!args.includes("--sent") && !args.includes("--retry"))) throw new Error("usage: resolve-stuck YYYY-MM-DD --sent|--retry");
      const status = args.includes("--sent") ? "sent" : "failed";
      const r = db.prepare("UPDATE email_log SET status=?, attempts=CASE WHEN ?='failed' THEN 0 ELSE attempts END WHERE digest_date=? AND status='sending'").run(status, status, date);
      console.log(`${r.changes} rows marked ${status}`);
      break;
    }
    default:
      console.log("Commands: start | serve | scan [--days N] | daily | sample [--regions SE,LDN] | stats | resolve-stuck DATE --sent|--retry");
      if (cmd) process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
