/**
 * Local spending ledger for paid model calls (GBP). This is the ENGINE'S OWN accounting, not a provider-enforced cap:
 * the owner should also set a spend limit or prepaid credit with the provider.
 *
 * Rules (fail closed):
 *  - The total cap is fixed when the ledger is created, at most HARD_CAP_GBP; it can be lowered, never raised.
 *  - Before every request, the maximum possible cost is RESERVED and written to disk (fsync) before the request is
 *    sent; the request is refused if committed + reservation would exceed the cap.
 *  - After a response, the reservation is settled at the cost computed from the reported usage.
 *  - If the outcome is unknown (timeout, network error, crash, missing usage), the full reservation stays counted.
 *  - A reservation is released only when the request provably was not sent.
 *  - Every change is made under an exclusive lock file (so separate processes cannot both spend the same headroom),
 *    written atomically (temp file + fsync + rename + directory fsync), and appended to ledger.journal. If ledger.json
 *    is missing or unreadable while the journal exists, the ledger refuses to start instead of resetting to £0.
 *  - Limits it cannot enforce: someone with the owner's account can delete both files or use another data folder.
 *    That is why the provider-side spend limit is the real cap.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HARD_CAP_GBP = 10;

/** Standard first-party list prices (USD per million tokens). Haiku uses its higher (>100K-token prompt) tier to stay conservative. */
export const PRICES_USD_PER_MTOK: Readonly<Record<string, { readonly input: number; readonly output: number }>> = Object.freeze({
  "claude-opus-5-5": Object.freeze({ input: 4, output: 20 }),
  "claude-sonnet-5-5": Object.freeze({ input: 2, output: 10 }),
  "claude-haiku-5-5": Object.freeze({ input: 0.5, output: 2.5 }),
});
/** Conservative conversion: £1 per $1 (the real rate is lower) and 20% UK VAT on top. Not configurable. */
export const USD_TO_GBP = 1.0;
export const TAX_MULTIPLIER = 1.2;

export type EntryStatus = "reserved" | "settled" | "unknown" | "released";
export interface LedgerEntry {
  readonly id: string; readonly at: string; readonly model: string; readonly purpose: string; readonly status: EntryStatus;
  readonly reservedGbp: number; readonly actualGbp: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly note: string;
}
interface LedgerFile { readonly version: 1; readonly currency: "GBP"; readonly capGbp: number; readonly createdAt: string; readonly entries: readonly LedgerEntry[] }
export class LedgerRefused extends Error {}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

export class Ledger {
  private readonly file: string;
  private readonly journal: string;
  private readonly lockFile: string;
  constructor(private readonly dir: string, capGbp: number, now: Date) {
    this.file = path.join(dir, "ledger.json");
    this.journal = path.join(dir, "ledger.journal");
    this.lockFile = path.join(dir, "ledger.lock");
    if (!Number.isFinite(capGbp) || capGbp <= 0 || capGbp > HARD_CAP_GBP) throw new LedgerRefused(`the total budget must be more than 0 and at most £${HARD_CAP_GBP}`);
    this.locked(() => {
      const cur = this.read();
      if (!cur) {
        if (fs.existsSync(this.journal)) throw new LedgerRefused("ledger.json is missing but ledger.journal shows earlier paid usage; restore ledger.json (the ledger never resets itself)");
        this.write({ version: 1, currency: "GBP", capGbp, createdAt: now.toISOString(), entries: [] }, "created");
      } else if (capGbp > cur.capGbp) throw new LedgerRefused(`the ledger's total budget is £${cur.capGbp}; it can be lowered but never raised (asked for £${capGbp})`);
      else if (capGbp < cur.capGbp) this.write({ ...cur, capGbp }, `cap lowered to ${capGbp}`);
    });
  }
  /** Exclusive cross-process lock (O_EXCL). A lock left by a dead process is replaced; a live holder makes this call fail. */
  private locked<T>(fn: () => T): T {
    const take = () => { const fd = fs.openSync(this.lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); };
    try { take(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(this.lockFile, "utf8"));
      let alive = false; try { if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
      if (alive) throw new LedgerRefused(`the ledger is in use by process ${pid}`);
      fs.unlinkSync(this.lockFile); take();
    }
    try { return fn(); } finally { try { fs.unlinkSync(this.lockFile); } catch { /* already gone */ } }
  }
  private read(): LedgerFile | null {
    let fd: number;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.uid !== uid()) throw new LedgerRefused("ledger.json must be your own regular file");
      const v = JSON.parse(fs.readFileSync(fd, "utf8")) as LedgerFile;
      if (v.version !== 1 || v.currency !== "GBP" || !Array.isArray(v.entries) || !(v.capGbp > 0 && v.capGbp <= HARD_CAP_GBP)) throw new LedgerRefused("ledger.json is not a valid ledger");
      return v;
    } finally { fs.closeSync(fd); }
  }
  private write(v: LedgerFile, what: string): void {
    const j = fs.openSync(this.journal, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(j, JSON.stringify({ what, capGbp: v.capGbp, committedGbp: Ledger.committed(v.entries), entries: v.entries.length }) + "\n"); fs.fsyncSync(j); } finally { fs.closeSync(j); }
    const tmp = `${this.file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, JSON.stringify(v, null, 1) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    const d = fs.openSync(this.dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  }
  private get(): LedgerFile { const v = this.read(); if (!v) throw new LedgerRefused("ledger.json is missing"); return v; }

  /** Committed spend: settled costs plus every reservation whose outcome is pending or unknown. */
  static committed(entries: readonly LedgerEntry[]): number {
    return r4(entries.reduce((a, e) => a + (e.status === "settled" ? (e.actualGbp ?? e.reservedGbp) : e.status === "released" ? 0 : e.reservedGbp), 0));
  }
  totals(): { capGbp: number; committedGbp: number; remainingGbp: number; settledGbp: number; unknownGbp: number; requests: number } {
    const v = this.get();
    const committed = Ledger.committed(v.entries);
    return { capGbp: v.capGbp, committedGbp: committed, remainingGbp: r4(Math.max(0, v.capGbp - committed)),
      settledGbp: r4(v.entries.filter((e) => e.status === "settled").reduce((a, e) => a + (e.actualGbp ?? 0), 0)),
      unknownGbp: r4(v.entries.filter((e) => e.status === "unknown" || e.status === "reserved").reduce((a, e) => a + e.reservedGbp, 0)), requests: v.entries.filter((e) => e.status !== "released").length };
  }
  entries(): readonly LedgerEntry[] { return this.get().entries; }

  /** Reserves the maximum cost (durably) or refuses. sessionCapGbp optionally limits this session's spend further. */
  reserve(maxGbp: number, meta: { model: string; purpose: string; sessionStartCommittedGbp?: number; sessionCapGbp?: number }, now: Date): string {
    if (!Number.isFinite(maxGbp) || maxGbp <= 0) throw new LedgerRefused("the request's maximum cost cannot be bounded");
    return this.locked(() => {
      const v = this.get();
      const committed = Ledger.committed(v.entries);
      if (committed + maxGbp > v.capGbp) throw new LedgerRefused(`budget: £${committed} committed of £${v.capGbp}; this request could cost up to £${r4(maxGbp)}`);
      if (meta.sessionCapGbp !== undefined && committed - (meta.sessionStartCommittedGbp ?? 0) + maxGbp > meta.sessionCapGbp) throw new LedgerRefused(`session budget: up to £${meta.sessionCapGbp} for this run`);
      const id = `req-${randomBytes(6).toString("hex")}`;
      this.write({ ...v, entries: [...v.entries, { id, at: now.toISOString(), model: meta.model, purpose: meta.purpose.slice(0, 40), status: "reserved", reservedGbp: r4(maxGbp), actualGbp: null, usage: null, note: "" }] }, `reserve ${id}`);
      return id;
    });
  }
  private update(id: string, change: (e: LedgerEntry) => LedgerEntry): void {
    this.locked(() => {
      const v = this.get();
      const e = v.entries.find((x) => x.id === id);
      if (!e) throw new LedgerRefused(`no ledger entry ${id}`);
      if (e.status !== "reserved") throw new LedgerRefused(`${id} is already ${e.status}`);
      const next = change(e);
      this.write({ ...v, entries: v.entries.map((x) => (x.id === id ? next : x)) }, `${next.status} ${id}`);
    });
  }
  settle(id: string, actualGbp: number, usage: { inputTokens: number; outputTokens: number }): void {
    if (!Number.isFinite(actualGbp) || actualGbp < 0) { this.unknown(id, "the reported usage could not be costed"); return; }
    this.update(id, (e) => ({ ...e, status: "settled", actualGbp: r4(actualGbp), usage, note: actualGbp > e.reservedGbp ? "ACTUAL COST EXCEEDED THE RESERVATION" : "" }));
  }
  unknown(id: string, note: string): void { this.update(id, (e) => ({ ...e, status: "unknown", note: note.slice(0, 160) })); }
  release(id: string, note: string): void { this.update(id, (e) => ({ ...e, status: "released", note: note.slice(0, 160) })); }
}
