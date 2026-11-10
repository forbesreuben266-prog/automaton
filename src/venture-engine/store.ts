/**
 * Private, persistent portfolio: one folder (mode 700) owned by the operator, JSON files written atomically (mode 600,
 * links refused), an append-only audit log, and one asset folder per venture. Builders can write only plain file names
 * inside their venture's asset folder.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ApprovalRequest, Asset, Venture } from "./types.js";

const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);
export const newId = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex")}`;
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_ASSET_BYTES = 512 * 1024;

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(dir);
  if (s.isSymbolicLink() || !s.isDirectory() || s.uid !== uid()) throw new Error(`${dir} must be your own real directory (no link)`);
  if ((s.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function readJson<T>(file: string, fallback: T): T {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
  try { const s = fs.fstatSync(fd); if (!s.isFile() || s.uid !== uid()) throw new Error(`${path.basename(file)}: must be your own regular file`); return JSON.parse(fs.readFileSync(fd, "utf8")) as T; }
  finally { fs.closeSync(fd); }
}
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

export class Store {
  constructor(readonly dir: string) { ensurePrivateDir(dir); ensurePrivateDir(path.join(dir, "ventures")); }
  ventures(): Venture[] { return readJson<Venture[]>(path.join(this.dir, "portfolio.json"), []); }
  saveVentures(v: readonly Venture[]): void { writeJson(path.join(this.dir, "portfolio.json"), v); }
  approvals(): ApprovalRequest[] { return readJson<ApprovalRequest[]>(path.join(this.dir, "approvals.json"), []); }
  saveApprovals(a: readonly ApprovalRequest[]): void { writeJson(path.join(this.dir, "approvals.json"), a); }
  /** Product builds (see products.ts); kept apart from portfolio.json so that building never rewrites venture records. */
  products<T = import("./products.js").Product>(): T[] { return readJson<T[]>(path.join(this.dir, "products.json"), []); }
  saveProducts(p: readonly unknown[]): void { writeJson(path.join(this.dir, "products.json"), p); }
  /** Marketing campaigns (see campaign.ts): drafts, approvals, published links and verified results. */
  campaigns<T = import("./campaign.js").Campaign>(): T[] { return readJson<T[]>(path.join(this.dir, "campaigns.json"), []); }
  saveCampaigns(c: readonly unknown[]): void { writeJson(path.join(this.dir, "campaigns.json"), c); }
  /** Daily operations notes (see operations.ts): owner-recorded outside blockers, used for reporting only. */
  operations(): { blockers?: import("./operations.js").Blocker[] } { return readJson(path.join(this.dir, "operations.json"), {}); }
  saveOperations(o: { blockers?: readonly unknown[] }): void { writeJson(path.join(this.dir, "operations.json"), o); }
  /** Product factory runs (see factory.ts): one record per run, with its concept, product and status. */
  factoryRuns<T = import("./factory.js").FactoryRun>(): T[] { return readJson<T[]>(path.join(this.dir, "factory.json"), []); }
  saveFactoryRuns(r: readonly unknown[]): void { writeJson(path.join(this.dir, "factory.json"), r); }
  /** Concepts written by the AI factory (rendered files included), so the toolkit blueprint can rebuild them. */
  aiConcepts<T = import("./blueprints/toolkit.js").Concept>(): T[] { return readJson<T[]>(path.join(this.dir, "ai-concepts.json"), []); }
  saveAiConcepts(c: readonly unknown[]): void { writeJson(path.join(this.dir, "ai-concepts.json"), c); }
  /** Launch packages (see launch.ts): one record per prepared package. */
  launches<T = import("./launch.js").LaunchPackage>(): T[] { return readJson<T[]>(path.join(this.dir, "launches.json"), []); }
  saveLaunches(l: readonly unknown[]): void { writeJson(path.join(this.dir, "launches.json"), l); }
  /** Verified orders recorded by the owner (see sales.ts): no customer details, only order references and amounts. */
  orders<T = import("./sales.js").Order>(): T[] { return readJson<T[]>(path.join(this.dir, "sales.json"), []); }
  saveOrders(o: readonly unknown[]): void { writeJson(path.join(this.dir, "sales.json"), o); }
  state(): { cycles: number; seed: number; day?: string; cyclesToday?: number } { return readJson(path.join(this.dir, "state.json"), { cycles: 0, seed: 1 }); }
  saveState(s: { cycles: number; seed: number; day?: string; cyclesToday?: number }): void { writeJson(path.join(this.dir, "state.json"), s); }
  audit(entry: Record<string, unknown>, now: Date): void {
    const fd = fs.openSync(path.join(this.dir, "audit.jsonl"), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, JSON.stringify({ at: now.toISOString(), ...entry }) + "\n"); } finally { fs.closeSync(fd); }
  }

  /** The asset folder of one experiment: ventures/<venture>/<experiment>/ (created private). */
  assetDir(ventureId: string, experimentId: string): string {
    for (const n of [ventureId, experimentId]) if (!/^[a-z]+-[0-9a-f]{8}$/.test(n)) throw new Error(`not an id: ${n}`);
    const d = path.join(this.dir, "ventures", ventureId, experimentId);
    ensurePrivateDir(path.join(this.dir, "ventures", ventureId)); ensurePrivateDir(d);
    return d;
  }
  /** A writer confined to one asset folder: plain names, size cap, exclusive create (never overwrites, never follows links). */
  writer(dir: string, written: Asset[]): (name: string, text: string) => void {
    return (name, text) => {
      if (!NAME.test(name)) throw new Error(`asset name not allowed: ${name.slice(0, 40)}`);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > MAX_ASSET_BYTES) throw new Error(`asset ${name}: ${bytes} bytes; the limit is ${MAX_ASSET_BYTES}`);
      if (written.length >= 20) throw new Error("at most 20 assets per experiment");
      fs.writeFileSync(path.join(dir, name), text, { mode: 0o600, flag: "wx" });
      written.push({ name, bytes, sha256: sha256(text) });
    };
  }
  reader(dir: string): (name: string) => string | null {
    return (name) => {
      if (!NAME.test(name)) return null;
      let fd: number;
      try { fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return null; }
      try { const s = fs.fstatSync(fd); return s.isFile() && s.size <= MAX_ASSET_BYTES ? fs.readFileSync(fd, "utf8") : null; } finally { fs.closeSync(fd); }
    };
  }
}
