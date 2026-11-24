// recovery-shared.ts — pure, dependency-free helpers shared by every recovery
// sub-module. Depends only on recovery-types.ts and external/backup surfaces;
// no sibling recovery module. The canonical read-only file probe lives here so
// both the manager and the public barrel resolve to one implementation.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { openSqliteDatabase, type SqliteDatabase } from './sqlite-driver.ts';
import { canonicalStringify } from './canonical-json.ts';
import {
  compareLedgerEntry,
  createMessageSanitizer,
  formatTimestamp,
  isValidBackupId,
  readMigrationLedger,
} from './backup/safety.ts';
import type { IntegrityFinding, IntegrityReport } from './db-adapter.ts';
import type { LedgerEntry } from './migration-ledger.ts';
import type { BackupManifest, BackupMigrationLedgerState } from './backup.ts';
import {
  MAX_RECOVERY_DIAGNOSTIC_ERROR_LENGTH,
  MIGRATION_LEDGER,
  type RecoveryProbeResult,
} from './recovery-types.ts';

// Canonical diagnostic redaction shared by validation, activation and probe.
export const { sanitizeError } = createMessageSanitizer(MAX_RECOVERY_DIAGNOSTIC_ERROR_LENGTH);

// Canonical-equality for the manifest comparison surfaces. Arrays keep their
// order (schema identity is ordered), while object KEY order is insignificant:
// a ledger read back from SQLite can insert keys in a different order than the
// manifest writer did, and JSON.stringify would report a false mismatch.
export function deepEqual(a: unknown, b: unknown): boolean {
  try {
    return canonicalStringify(a) === canonicalStringify(b);
  } catch {
    return false;
  }
}

export function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function recoveryToken(now: () => Date): string {
  return `${formatTimestamp(now())}-${randomBytes(6).toString('hex')}`;
}

export function freshQuarantineDir(quarantineDir: string, now: () => Date): string {
  const base = recoveryToken(now);
  let target = path.join(quarantineDir, base);
  let suffix = 0;
  while (existsSync(target)) {
    suffix += 1;
    target = path.join(quarantineDir, `${base}.q${suffix}`);
  }
  return target;
}

export function findStaleStageFiles(root: string, stagePrefix: string): string[] {
  try {
    return readdirSync(root).filter((entry) => entry.startsWith(stagePrefix));
  } catch {
    return [];
  }
}

// ---- the canonical read-only file probe -----------------------------------

// Non-throwing health probe for a database FILE. Opens the file (read-write,
// like the backup manager's snapshot inspection — a read-only WAL open without
// a -shm can block) and runs the fast quick scan. Reports `ok: false` with a
// plain reason and the integrity findings when the file cannot be opened or is
// corrupt — including a corrupt WAL, which fails at open. Sidecars are NOT
// removed here: a healthy live database may have a connection using them, and
// removing them would damage that connection. A missing file is healthy (a
// brand-new owned directory has nothing to recover).
export function probeDatabaseFile(dbFilePath: string): RecoveryProbeResult {
  if (!existsSync(dbFilePath)) {
    return { ok: true, checkedAt: new Date().toISOString() };
  }
  let db: SqliteDatabase;
  try {
    db = openSqliteDatabase(dbFilePath);
  } catch (err) {
    return { ok: false, reason: 'the database file could not be opened — it is corrupt or damaged', findings: [sanitizeError(err)] };
  }
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
    const findings: string[] = [];
    for (const row of rows) {
      if (row.quick_check !== 'ok') findings.push(row.quick_check);
    }
    if (findings.length === 0) return { ok: true, checkedAt: new Date().toISOString() };
    return { ok: false, reason: 'the database failed integrity verification — it is corrupt or damaged', findings };
  } catch (err) {
    return { ok: false, reason: 'the database could not be read — it is corrupt or damaged', findings: [sanitizeError(err)] };
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort close on the probe failure path */
    }
  }
}

// ---- validation helpers used by more than one sub-module ------------------

// Manifests record timestamps as the canonical UTC ISO-8601 instant the
// backup side writes (`Date.prototype.toISOString()`: YYYY-MM-DDTHH:mm:ss.sssZ).
// Both the format AND the round-trip must hold: `Date.parse` normalizes
// impossible dates (2026-02-30T00:00:00.000Z silently becomes March 2) and
// lenient forms ('yesterday', no-millis, +00:00), so re-serializing the
// parsed instant must reproduce the recorded string exactly.
export function isValidIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) return false;
  return new Date(instant).toISOString() === value;
}

export function validateBackupId(backupId: unknown): string | null {
  // `isValidBackupId` is the shared crash-safety authority's id grammar.
  if (!isValidBackupId(backupId)) {
    return 'invalid backupId — expected <ISO-timestamp>-<hex> (e.g. 2026-01-01T00-00-00.000Z-abcd1234ef567890)';
  }
  return null;
}

export function validationReason(backupId: string, failures: readonly string[]): string {
  return `backup '${backupId}' could not be restored: ${failures.join('; ')}`;
}

export function validateLedgerConsistency(ledger: BackupMigrationLedgerState): string[] {
  const failures: string[] = [];
  const versions = ledger.appliedVersions;
  if (!Array.isArray(versions)) return failures;
  let previous: LedgerEntry | null = null;
  for (const entry of versions) {
    if (!entry || typeof entry !== 'object' || typeof entry.namespace !== 'string' || !Number.isInteger(entry.version)) {
      failures.push('migration ledger records a malformed applied version');
      continue;
    }
    if (previous !== null && compareLedgerEntry(previous, entry) >= 0) {
      failures.push('migration ledger appliedVersions is not strictly ascending by (namespace, version) (duplicate or out of order)');
    }
    previous = { namespace: entry.namespace, version: entry.version };
  }
  const max = versions.reduce((highest, entry) => {
    const version = typeof entry === 'object' && entry !== null ? (entry as { version?: unknown }).version : undefined;
    return typeof version === 'number' && version > highest ? version : highest;
  }, 0);
  if (typeof ledger.maxVersion === 'number' && ledger.maxVersion !== max) {
    failures.push(`migration ledger maxVersion ${ledger.maxVersion} does not match the highest applied version ${max}`);
  }
  return failures;
}

// ---- sqlite-snapshot-side helpers -----------------------------------------

// Shared crash-safety recomputations (quickCheckOf, schemaIdentityOf, and
// verified blob containment) now live in ./backup/safety.ts — the one authority
// the backup manifest and this validator both call. Only recovery's stricter
// PRAGMA integrity_check stays local.
export function integrityCheckOf(db: SqliteDatabase): IntegrityReport {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const findings: IntegrityFinding[] = [];
    for (const row of rows) {
      if (row.integrity_check !== 'ok') findings.push({ severity: 'error', message: row.integrity_check });
    }
    return { ok: findings.length === 0, checkedAt: new Date().toISOString(), findings };
  } catch (err) {
    // A corrupt file can open (node:sqlite opens lazily) and only fail on the
    // first statement — report that as an integrity failure, not a throw.
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      findings: [{ severity: 'error', message: sanitizeError(err) }],
    };
  }
}

// The manifest is untrusted input: enforce the ONE DECLARED ledger table name
// before the shared recomputation, with recovery's own error wording (review
// #83). readMigrationLedger in backup/safety.ts does the actual read.
export function migrationLedgerOf(db: SqliteDatabase, manifest: BackupManifest): BackupMigrationLedgerState {
  const declaredTable = manifest.migrationLedgerState?.table ?? MIGRATION_LEDGER;
  if (declaredTable !== MIGRATION_LEDGER) {
    throw new Error(
      `manifest declares an unsupported migration ledger table '${declaredTable}' — only '${MIGRATION_LEDGER}' is restored`,
    );
  }
  return readMigrationLedger(db);
}
