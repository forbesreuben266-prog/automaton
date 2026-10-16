/**
 * Single-instance lock
 *
 * Spend limits are check-then-record against state.db. Two runtimes sharing
 * one database could both pass a check before either records its spend, so
 * only one runtime may run per database. The lock is an exclusive SQLite
 * lock on `<dbPath>.lock`, held for the life of the process. The OS releases
 * it when the process exits or crashes, so there is no stale lock to clean
 * up. Failing to acquire it means refusing to start.
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceLockError";
  }
}

export interface InstanceLock {
  readonly path: string;
  release(): void;
}

export function instanceLockPath(dbPath: string): string {
  return `${dbPath}.lock`;
}

export function acquireInstanceLock(dbPath: string): InstanceLock {
  const lockPath = instanceLockPath(dbPath);
  let db: Database.Database | undefined;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    db = new Database(lockPath, { timeout: 0 });
    db.pragma("locking_mode = EXCLUSIVE");
    // The first write takes the exclusive lock; EXCLUSIVE locking mode keeps
    // it until the connection closes.
    db.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS instance_lock (pid INTEGER); COMMIT;");
  } catch (err: any) {
    try {
      db?.close();
    } catch {
      // ignore
    }
    throw new InstanceLockError(
      `Another Automaton runtime is using ${dbPath} (lock ${lockPath} is held), or the lock could not be acquired: ${err?.message ?? err}. Refusing to start.`,
    );
  }

  let held = true;
  return {
    path: lockPath,
    release() {
      if (!held) return;
      held = false;
      db!.close();
    },
  };
}
