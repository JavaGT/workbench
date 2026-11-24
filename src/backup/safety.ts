// backup/safety.ts — the ONE authority for the crash-safety invariants shared by
// backup.ts and recovery.ts: layout/id, completeness, quarantine, quick_check,
// schema identity, blob containment, listing, ledger and diagnostic hygiene.
// Both loops import these exact functions; differing wording is parameterized.

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { frameworkTableNames } from '../schema-table-census.ts';
import { MIGRATION_LEDGER_TABLE, type LedgerEntry } from '../migration-ledger.ts';
import type { SqliteDatabase } from '../sqlite-driver.ts';
import type { IntegrityFinding, IntegrityReport } from '../db-adapter.ts';

// ---- layout identity -------------------------------------------------------
// The manifest version BOTH loops check; backup.ts re-exports it publicly.
export const BACKUP_FORMAT_VERSION = 1 as const;

// `backups/<timestamp>-<id>/`; validating the id stops separators/'..' escaping backups/.
export const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-([0-9a-f]+)$/;

export function isValidBackupId(value: unknown): value is string {
  return typeof value === 'string' && BACKUP_NAME.test(value);
}

export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

export function parseBackupTimestamp(name: string): Date | null {
  const match = BACKUP_NAME.exec(name);
  if (!match) return null;
  const [datePart, timePart] = match[1].split('T');
  const parsed = new Date(`${datePart}T${timePart.replace(/-/g, ':')}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---- completeness, listing + quarantine -----------------------------------
// The manifest is written LAST: a parsed 'complete' manifest means complete.
export function isCompleteBackupDir(dir: string): boolean {
  try {
    if (!existsSync(path.join(dir, 'snapshot.sqlite'))) return false;
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      status?: unknown;
      formatVersion?: unknown;
    };
    return manifest.formatVersion === BACKUP_FORMAT_VERSION && manifest.status === 'complete';
  } catch {
    return false;
  }
}

type ManifestLike = { readonly formatVersion?: unknown; readonly status?: unknown };

export function readCompleteManifest<M extends ManifestLike>(dir: string): M | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as M;
    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION || manifest.status !== 'complete') return null;
    return manifest;
  } catch {
    return null;
  }
}

export type CompleteBackupListing<M> = Readonly<{
  readonly backupId: string;
  readonly directory: string;
  readonly manifest: M;
  readonly createdAt: string;
}>;

export function listCompleteBackups<M extends ManifestLike & { readonly createdAt: string }>(
  backupsDir: string,
): readonly CompleteBackupListing<M>[] {
  return readdirSync(backupsDir)
    .filter((entry) => isDirectory(path.join(backupsDir, entry)))
    .map((entry) => {
      const dir = path.join(backupsDir, entry);
      const manifest = readCompleteManifest<M>(dir);
      return manifest === null ? null : { backupId: entry, directory: dir, manifest, createdAt: manifest.createdAt };
    })
    .filter((entry): entry is CompleteBackupListing<M> => entry !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type SafetyDiagnostic = Readonly<{
  readonly at: string;
  readonly stage: string;
  readonly error: string;
  readonly detail?: Record<string, unknown>;
}>;

export function writeDiagnostic(dir: string, diagnostic: SafetyDiagnostic): void {
  writeFileSync(path.join(dir, 'diagnostic.json'), `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
}

// Suffix + rename policy, bound to each loop's own quarantine/ directory.
export function createQuarantineMover(quarantineDir: string): (dir: string) => string {
  return (dir: string): string => {
    let target = path.join(quarantineDir, path.basename(dir));
    let suffix = 0;
    while (existsSync(target)) {
      suffix += 1;
      target = path.join(quarantineDir, `${path.basename(dir)}.q${suffix}`);
    }
    renameSync(dir, target);
    return target;
  };
}

export type QuarantineSweepOptions = Readonly<{
  readonly backupsDir: string;
  readonly diagnosticError: string;
  readonly moveToQuarantine: (dir: string) => string;
  readonly now: () => Date;
  readonly onFailure: (err: unknown, dir: string) => void;
}>;

// Crash leftovers move to quarantine/; recovery adds its stage sweep after this.
export function quarantineIncompleteBackups(options: QuarantineSweepOptions): string[] {
  const quarantined: string[] = [];
  for (const entry of readdirSync(options.backupsDir)) {
    const dir = path.join(options.backupsDir, entry);
    if (!isDirectory(dir)) continue;
    if (isCompleteBackupDir(dir)) continue;
    try {
      if (!existsSync(path.join(dir, 'diagnostic.json'))) {
        writeDiagnostic(dir, {
          at: options.now().toISOString(),
          stage: 'quarantine',
          error: options.diagnosticError,
          detail: { dir: entry },
        });
      }
      quarantined.push(options.moveToQuarantine(dir));
    } catch (err) {
      options.onFailure(err, dir);
    }
  }
  return quarantined;
}

// ---- sqlite snapshot recomputations ---------------------------------------
export type QuickCheckOptions = Readonly<{
  // Backup lets errors propagate; recovery supplies a sanitizer instead.
  readonly describeError?: (err: unknown) => string;
}>;

export function quickCheckOf(db: SqliteDatabase, options: QuickCheckOptions = {}): IntegrityReport {
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
    const findings: IntegrityFinding[] = [];
    for (const row of rows) {
      if (row.quick_check !== 'ok') findings.push({ severity: 'error', message: row.quick_check });
    }
    return { ok: findings.length === 0, checkedAt: new Date().toISOString(), findings };
  } catch (err) {
    if (!options.describeError) throw err;
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      findings: [{ severity: 'error', message: options.describeError(err) }],
    };
  }
}

export type SchemaIdentity = Readonly<{ platformSchemaIdentity: string; appSchemaIdentity: string[] }>;

// One fingerprint over framework tables, one per app table; ledger handled separately.
export function schemaIdentityOf(db: SqliteDatabase): SchemaIdentity {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
    .all() as Array<{ name: string; sql: string }>;
  const sqlByName = new Map(rows.map((row) => [row.name, row.sql]));
  const framework = new Set(frameworkTableNames);
  const platformTables = frameworkTableNames.filter((name) => sqlByName.has(name)).slice().sort();
  const platformSchemaIdentity = sha256hex(platformTables.map((name) => `${name}:${sqlByName.get(name)!}`).join('\n'));
  const appSchemaIdentity = rows
    .filter((row) => !framework.has(row.name) && row.name !== MIGRATION_LEDGER_TABLE)
    .map((row) => `${row.name}:${sha256hex(row.sql)}`)
    .sort();
  return { platformSchemaIdentity, appSchemaIdentity };
}

// The ledger that EXISTS in a snapshot; only the ONE declared table name can
// ever be interpolated into SQL, so untrusted manifest names cannot reach it.
export function readMigrationLedger(
  db: SqliteDatabase,
  table: typeof MIGRATION_LEDGER_TABLE = MIGRATION_LEDGER_TABLE,
): {
  readonly table: typeof MIGRATION_LEDGER_TABLE;
  readonly appliedVersions: readonly LedgerEntry[];
  readonly maxVersion: number;
} {
  if (table !== MIGRATION_LEDGER_TABLE) {
    throw new Error(`unsupported migration ledger table '${table}' — only '${MIGRATION_LEDGER_TABLE}' is restored`);
  }
  const hasTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATION_LEDGER_TABLE));
  if (!hasTable) return { table: MIGRATION_LEDGER_TABLE, appliedVersions: [], maxVersion: 0 };
  const rows = db
    .prepare(`SELECT namespace, version FROM ${MIGRATION_LEDGER_TABLE} ORDER BY namespace, version`)
    .all() as Array<{ namespace: string; version: number }>;
  const appliedVersions = rows
    .map((row) => ({ namespace: row.namespace, version: Number(row.version) }))
    .sort(compareLedgerEntry);
  const maxVersion = appliedVersions.reduce((max, entry) => Math.max(max, entry.version), 0);
  return { table: MIGRATION_LEDGER_TABLE, appliedVersions, maxVersion };
}

// Case-insensitive namespace identity, then version.
export function compareLedgerEntry(a: LedgerEntry, b: LedgerEntry): number {
  const aNamespace = a.namespace.toLowerCase();
  const bNamespace = b.namespace.toLowerCase();
  if (aNamespace !== bNamespace) return aNamespace < bNamespace ? -1 : 1;
  return a.version - b.version;
}

// ---- verified materialization ---------------------------------------------
export type MaterializedBlobFile = Readonly<{ readonly name: string; readonly size: number }>;
export type MaterializationVerification = Readonly<{ ok: true } | { ok: false; reason: string }>;
export type VerifyMaterializationOptions = Readonly<{ readonly directoryLabel?: string }>;

// lstat + realpath containment: no symlink, in the dir or its parents, can
// launder an outside file as a verified blob byte.
export function verifyMaterialization(
  generation: string,
  destBlobDir: string,
  report: readonly MaterializedBlobFile[] | undefined,
  options: VerifyMaterializationOptions = {},
): MaterializationVerification {
  const label = options.directoryLabel ?? 'blob directory';
  if (!Array.isArray(report)) {
    return { ok: false, reason: `materialize for ${generation} did not report the files it wrote` };
  }
  if (report.length === 0) {
    return { ok: false, reason: `materialize for ${generation} reported no files — its bytes were not written` };
  }
  let realBlobDir: string;
  try {
    realBlobDir = realpathSync(destBlobDir);
  } catch {
    return { ok: false, reason: `materialize for ${generation} ran before the ${label} existed` };
  }
  for (const entry of report) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) {
      return { ok: false, reason: `materialize for ${generation} reported a malformed file entry` };
    }
    const name = entry.name;
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
      return { ok: false, reason: `materialize for ${generation} reported a path outside the ${label}` };
    }
    const entryPath = path.join(destBlobDir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      const link = lstatSync(entryPath);
      if (link.isSymbolicLink()) {
        return { ok: false, reason: `materialize for ${generation} reported a symlink, which cannot be a verified blob byte: ${name}` };
      }
      const resolved = realpathSync(entryPath);
      if (resolved !== realBlobDir && !resolved.startsWith(realBlobDir + path.sep)) {
        return { ok: false, reason: `materialize for ${generation} resolved outside the ${label}: ${name}` };
      }
      stat = statSync(resolved);
    } catch {
      return { ok: false, reason: `materialize for ${generation} reported a file that was not written: ${name}` };
    }
    if (!stat.isFile()) {
      return { ok: false, reason: `materialize for ${generation} reported a non-file entry: ${name}` };
    }
    if (stat.size !== entry.size) {
      return { ok: false, reason: `materialize for ${generation} reported ${entry.size} bytes but ${name} is ${stat.size} bytes` };
    }
  }
  return { ok: true };
}

// ---- diagnostic hygiene ----------------------------------------------------
const MAX_REDACTED_TOKEN_LENGTH = 128;

// Control chars collapsed, long content tokens redacted, result bounded — the
// same forensics-without-data policy, with each module's own public max length.
export function createMessageSanitizer(maxLength: number): {
  readonly sanitizeMessage: (value: string) => string;
  readonly sanitizeError: (err: unknown) => string;
} {
  function sanitizeMessage(value: string): string {
    const singleLine = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    const redacted = singleLine.replace(
      new RegExp(`\\S{${MAX_REDACTED_TOKEN_LENGTH + 1},}`, 'g'),
      (run) => `<redacted-${run.length}>`,
    );
    return redacted.slice(0, maxLength);
  }
  function sanitizeError(err: unknown): string {
    if (err instanceof Error) return sanitizeMessage(err.message);
    if (typeof err === 'string') return sanitizeMessage(err);
    return sanitizeMessage(String(err));
  }
  return { sanitizeMessage, sanitizeError };
}
