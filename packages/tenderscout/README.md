# TenderScout UK

Daily 7:00am (Europe/London) email alerts of UK government **cleaning** contracts, sold at £29/month via Stripe.
Self-contained workspace package inside Automaton: own SQLite DB, does not touch the agent runtime.

## Data sources (official, free, Open Government Licence)
- **Find a Tender** OCDS API: `/api/1.0/ocdsReleasePackages` (UK-wide, above threshold, includes Procurement Act 2023 notices)
- **Contracts Finder** OCDS API: `/Published/Notices/OCDS/Search` (England, lower value)

Filter: cleaning CPV codes (909xxxxx subset, 98341130) + title keywords; excludes products, pest control, drains and street sweeping.
Deduped across platforms. Expired, cancelled and awarded notices are dropped.

## Commands
```
pnpm install && pnpm --filter @conway/tenderscout build
node dist/cli.js start          # website + scheduler (production)
node dist/cli.js scan --days 30 # seed the DB
node dist/cli.js sample --regions SE,LDN   # write a sample digest to data/outbox
node dist/cli.js daily          # one scan+send pass (if you prefer external cron)
node dist/cli.js stats
pnpm test
```

## How it runs itself
| Step | Mechanism |
|---|---|
| Signup | `/` form → pending subscriber → Stripe Checkout (subscription) |
| Payment | Signed webhook `POST /webhooks/stripe`. Access starts only on `paid` / `invoice.paid` |
| Onboarding | Welcome email sent once on activation |
| Changes / cancel | `customer.subscription.updated/deleted` → past_due / cancelled; Stripe Customer Portal at `/billing?token=` |
| Daily | 07:00 UK: scan → per-subscriber digest. Retries at +15/+45/+120 min; catches up on restart before noon |
| No duplicates | one `email_log` row per subscriber per day; 'sent' is never resent; a crash mid-send is not retried, the admin is alerted |
| Alerts | Source failure, failed or stuck delivery, crash → email to `TS_ADMIN_EMAIL` |
| Preferences | `/preferences?token=`; one-click unsubscribe (RFC 8058 `List-Unsubscribe-Post`) |
| GDPR | Cancelled accounts are purged after `TS_RETENTION_DAYS`, abandoned signups after 30 days |

Stripe webhook events to enable: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
