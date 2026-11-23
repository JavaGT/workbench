// directory-lock.ts — OS-backed ownership lock for an adapter-owned directory
// (epic scope#23, S1/A2; consideration #9).
//
// MECHANISM: the adapter owns a directory by holding a sidecar SQLite lock
// database (`lock.sqlite`) in BEGIN EXCLUSIVE for the process lifetime. SQLite's
// rollback-journal RESERVED lock is the authority: while the owner holds the
// uncommitted exclusive transaction, a second process cannot acquire RESERVED
// and fails at BEGIN EXCLUSIVE with SQLITE_BUSY (after a short busy window).
// The OS releases the held lock automatically when the owning process dies — a
// crash cannot strand the directory, and no kill(pid,0) liveness probing is
// involved. The `{ pid, startedAt }` row is informational only.
//
// DELIBERATELY NOT WAL: in WAL mode BEGIN EXCLUSIVE defers contention to the
// first write, so two processes could both hold the transaction open. The lock
// database stays in rollback-journal (DELETE) mode so the exclusive transaction
// contends at begin.
//
// A PID-file-only design is explicitly rejected here (stale PID files on crash
// require probing to recover); the held transaction needs no recovery.

import { openSqliteDatabase } from './sqlite-driver.mjs';

export const DB_OWNED_ERROR_CODE = 'WB_DB_OWNED';

// Distinct, fail-loud error for directory ownership contention. The second
// process gets THIS — never a raw SQLITE_BUSY — so callers can distinguish
// "already owned" from transient SQLite busy.
export class DirectoryOwnedError extends Error {
           code = DB_OWNED_ERROR_CODE;
  constructor(lockFile        ) {
    super(
      `database directory is already owned by another process (${DB_OWNED_ERROR_CODE}): ${lockFile}`,
    );
    this.name = 'DirectoryOwnedError';
  }
}









// SQLITE_BUSY (5) / SQLITE_LOCKED (6) mean the lock is contended: another
// process holds the exclusive transaction. Any other error is a real failure
// and propagates unchanged.
function isContentionError(err         )          {
  if (!(err instanceof Error)) return false;
  const sqlite = err                                                          ;
  if (typeof sqlite.errcode === 'number') {
    if (sqlite.errcode === 5 || sqlite.errcode === 6) return true;
  }
  if (typeof sqlite.errno === 'number') {
    if (sqlite.errno === 5 || sqlite.errno === 6) return true;
  }
  if (sqlite.code === 'SQLITE_BUSY' || sqlite.code === 'SQLITE_LOCKED') return true;
  return /database is (locked|busy)/i.test(err.message);
}

// Acquire the OS-backed ownership lock for a directory. Creates the sidecar
// lock database if needed, records the diagnostics row, then holds a BEGIN
// EXCLUSIVE transaction for the process lifetime. Throws DirectoryOwnedError
// when another live process already owns the directory.
export function acquireDirectoryLock(lockFile        )                {
  const db = openSqliteDatabase(lockFile);
  const pid = process.pid;
  const startedAt = new Date().toISOString();
  try {
    // Short busy window: ownership is binary — if the exclusive transaction
    // cannot be taken almost immediately, another process owns the directory.
    db.exec('PRAGMA busy_timeout = 250');
    // The lock database must contend on the rollback-journal RESERVED lock.
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, startedAt TEXT NOT NULL)');
    // Diagnostics row — committed so it is visible to an observer, but purely
    // informational: it is NEVER consulted for liveness.
    db.prepare('DELETE FROM owner').run();
    db.prepare('INSERT INTO owner (pid, startedAt) VALUES (?, ?)').run(pid, startedAt);
    // The held BEGIN EXCLUSIVE is the ownership authority. Never COMMIT; the
    // transaction stays open until release() or process death (the OS then
    // drops the lock). A contender's write OR begin contends here and fails
    // with SQLITE_BUSY after the short window above.
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best-effort close on the failure path */
    }
    if (isContentionError(err)) throw new DirectoryOwnedError(lockFile);
    throw err;
  }
  return {
    pid,
    startedAt,
    release() {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* lock already released */
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
