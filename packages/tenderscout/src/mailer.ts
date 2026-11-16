/**
 * Email delivery. Dry-run (default) writes emails to the outbox folder instead of sending.
 * Live mode uses any SMTP provider (Postmark, Resend, Brevo, SES, Mailgun, Microsoft 365...).
 */
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { Config } from "./config.js";
import type { Email } from "./digest.js";

export interface Mailer {
  readonly live: boolean;
  send(email: Email): Promise<void>;
}

export class OutboxMailer implements Mailer {
  readonly live = false;
  constructor(private dir: string) {}
  async send(email: Email): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const safe = email.to.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
    const base = path.join(this.dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${safe}`);
    fs.writeFileSync(`${base}.html`, email.html);
    fs.writeFileSync(`${base}.txt`, `To: ${email.to}\nSubject: ${email.subject}\n${Object.entries(email.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${email.text}`);
  }
}

export class SmtpMailer implements Mailer {
  readonly live = true;
  private transport;
  constructor(private cfg: Config) {
    this.transport = nodemailer.createTransport({
      host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure,
      auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
    });
  }
  async send(email: Email): Promise<void> {
    await this.transport.sendMail({
      from: this.cfg.smtp.from, replyTo: this.cfg.contactEmail, to: email.to,
      subject: email.subject, html: email.html, text: email.text, headers: email.headers,
    });
  }
}

export function createMailer(cfg: Config): Mailer {
  if (cfg.dryRun) return new OutboxMailer(cfg.outboxDir);
  if (!cfg.smtp.host) throw new Error("TS_DRY_RUN=false but SMTP_HOST is not set");
  return new SmtpMailer(cfg);
}
