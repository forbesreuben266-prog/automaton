import type { DB } from "./db.js";
import { upsertTenders, closeTenders } from "./db.js";
import { fetchReleases, normalizeAll, SOURCES, type Fetcher, type SourceKey, fetchJson } from "./sources/ocds.js";
import { isCleaningRelevant, isOpen } from "./filter.js";
import { log } from "./log.js";

export interface ScanResult {
  ok: boolean;              // at least one source succeeded
  sourcesOk: SourceKey[];
  errors: { source: SourceKey; error: string }[];
  fetched: number;
  relevant: number;
  inserted: number;
  updated: number;
  duplicates: number;
}

export async function scan(db: DB, opts: { lookbackDays: number; now?: Date; fetcher?: Fetcher }): Promise<ScanResult> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - opts.lookbackDays * 86_400_000);
  const result: ScanResult = { ok: false, sourcesOk: [], errors: [], fetched: 0, relevant: 0, inserted: 0, updated: 0, duplicates: 0 };
  const run = db.prepare("INSERT INTO runs (kind) VALUES ('scan')").run();

  for (const source of Object.keys(SOURCES) as SourceKey[]) {
    try {
      const releases = await fetchReleases(source, from, now, opts.fetcher ?? fetchJson);
      const tenders = normalizeAll(source, releases);
      const relevant = tenders.filter((t) => isCleaningRelevant(t));
      // open notices are inserted; closed ones (cancelled/awarded) only update rows we already hold
      const toStore = relevant.filter((t) => isOpen(t.status, t.deadline, now));
      const closed = relevant.filter((t) => !isOpen(t.status, t.deadline, now));
      closeTenders(db, closed.map((t) => t.id), closed.map((t) => t.fingerprint));
      const r = upsertTenders(db, toStore);
      result.fetched += tenders.length;
      result.relevant += relevant.length;
      result.inserted += r.inserted;
      result.updated += r.updated;
      result.duplicates += r.duplicates;
      result.sourcesOk.push(source);
      log.info("scan.source.ok", { source, fetched: tenders.length, relevant: relevant.length, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ source, error: msg });
      log.error("scan.source.failed", { source, error: msg });
    }
  }
  result.ok = result.sourcesOk.length > 0;
  db.prepare("UPDATE runs SET finished_at=datetime('now'), ok=?, detail=? WHERE id=?")
    .run(result.errors.length === 0 ? 1 : 0, JSON.stringify(result), run.lastInsertRowid);
  return result;
}
