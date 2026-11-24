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
import { frameworkTableNames } from '../schema-table-census.mjs';
import { MIGRATION_LEDGER_TABLE,                  } from '../migration-ledger.mjs';



// ---- layout identity -------------------------------------------------------
// The manifest version BOTH loops check; backup.ts re-exports it publicly.
export const BACKUP_FORMAT_VERSION = 1         ;

// `backups/<timestamp>-<id>/`; validating the id stops separators/'..' escaping backups/.
export const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-([0-9a-f]+)$/;

export function isValidBackupId(value         )                  {
  return typeof value === 'string' && BACKUP_NAME.test(value);
}

export function formatTimestamp(date      )         {
  return date.toISOString().replace(/:/g, '-');
}

export function parseBackupTimestamp(name        )              {
  const match = BACKUP_NAME.exec(name);
  if (!match) return null;
  const [datePart, timePart] = match[1].split('T');
  const parsed = new Date(`${datePart}T${timePart.replace(/-/g, ':')}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isDirectory(p        )          {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sha256hex(value        )         {
  return createHash('sha256').update(value).digest('hex');
}

// ---- completeness, listing + quarantine -----------------------------------
// The manifest is written LAST: a parsed 'complete' manifest means complete.
export function isCompleteBackupDir(dir        )          {
  try {
    if (!existsSync(path.join(dir, 'snapshot.sqlite'))) return false;
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))


     ;
    return manifest.formatVersion === BACKUP_FORMAT_VERSION && manifest.status === 'complete';
  } catch {
    return false;
  }
}



export function readCompleteManifest                        (dir        )           {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))     ;
    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION || manifest.status !== 'complete') return null;
    return manifest;
  } catch {
    return null;
  }
}








export function listCompleteBackups                                                         (
  backupsDir        ,
)                                      {
  return readdirSync(backupsDir)
    .filter((entry) => isDirectory(path.join(backupsDir, entry)))
    .map((entry) => {
      const dir = path.join(backupsDir, entry);
      const manifest = readCompleteManifest   (dir);
      return manifest === null ? null : { backupId: entry, directory: dir, manifest, createdAt: manifest.createdAt };
    })
    .filter((entry)                                    => entry !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}








export function writeDiagnostic(dir        , diagnostic                  )       {
  writeFileSync(path.join(dir, 'diagnostic.json'), `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
}

// Suffix + rename policy, bound to each loop's own quarantine/ directory.
export function createQuarantineMover(quarantineDir        )                          {
  return (dir        )         => {
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









// Crash leftovers move to quarantine/; recovery adds its stage sweep after this.
export function quarantineIncompleteBackups(options                        )           {
  const quarantined           = [];
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





export function quickCheckOf(db                , options                    = {})                  {
  try {
    const rows = db.prepare('PRAGMA quick_check').all()                                  ;
    const findings                     = [];
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



// One fingerprint over framework tables, one per app table; ledger handled separately.
export function schemaIdentityOf(db                )                 {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
    .all()                                        ;
  const sqlByName = new Map(rows.map((row) => [row.name, row.sql]));
  const framework = new Set(frameworkTableNames);
  const platformTables = frameworkTableNames.filter((name) => sqlByName.has(name)).slice().sort();
  const platformSchemaIdentity = sha256hex(platformTables.map((name) => `${name}:${sqlByName.get(name) }`).join('\n'));
  const appSchemaIdentity = rows
    .filter((row) => !framework.has(row.name) && row.name !== MIGRATION_LEDGER_TABLE)
    .map((row) => `${row.name}:${sha256hex(row.sql)}`)
    .sort();
  return { platformSchemaIdentity, appSchemaIdentity };
}

// The ledger that EXISTS in a snapshot; only the ONE declared table name can
// ever be interpolated into SQL, so untrusted manifest names cannot reach it.
export function readMigrationLedger(
  db                ,
  table                                = MIGRATION_LEDGER_TABLE,
)



  {
  if (table !== MIGRATION_LEDGER_TABLE) {
    throw new Error(`unsupported migration ledger table '${table}' — only '${MIGRATION_LEDGER_TABLE}' is restored`);
  }
  const hasTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATION_LEDGER_TABLE));
  if (!hasTable) return { table: MIGRATION_LEDGER_TABLE, appliedVersions: [], maxVersion: 0 };
  const rows = db
    .prepare(`SELECT namespace, version FROM ${MIGRATION_LEDGER_TABLE} ORDER BY namespace, version`)
    .all()                                                 ;
  const appliedVersions = rows
    .map((row) => ({ namespace: row.namespace, version: Number(row.version) }))
    .sort(compareLedgerEntry);
  const maxVersion = appliedVersions.reduce((max, entry) => Math.max(max, entry.version), 0);
  return { table: MIGRATION_LEDGER_TABLE, appliedVersions, maxVersion };
}

// Case-insensitive namespace identity, then version.
export function compareLedgerEntry(a             , b             )         {
  const aNamespace = a.namespace.toLowerCase();
  const bNamespace = b.namespace.toLowerCase();
  if (aNamespace !== bNamespace) return aNamespace < bNamespace ? -1 : 1;
  return a.version - b.version;
}

// ---- verified materialization ---------------------------------------------




// lstat + realpath containment: no symlink, in the dir or its parents, can
// launder an outside file as a verified blob byte.
export function verifyMaterialization(
  generation        ,
  destBlobDir        ,
  report                                             ,
  options                               = {},
)                              {
  const label = options.directoryLabel ?? 'blob directory';
  if (!Array.isArray(report)) {
    return { ok: false, reason: `materialize for ${generation} did not report the files it wrote` };
  }
  if (report.length === 0) {
    return { ok: false, reason: `materialize for ${generation} reported no files — its bytes were not written` };
  }
  let realBlobDir        ;
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
    let stat                             ;
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
export function createMessageSanitizer(maxLength        )


  {
  function sanitizeMessage(value        )         {
    const singleLine = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    const redacted = singleLine.replace(
      new RegExp(`\\S{${MAX_REDACTED_TOKEN_LENGTH + 1},}`, 'g'),
      (run) => `<redacted-${run.length}>`,
    );
    return redacted.slice(0, maxLength);
  }
  function sanitizeError(err         )         {
    if (err instanceof Error) return sanitizeMessage(err.message);
    if (typeof err === 'string') return sanitizeMessage(err);
    return sanitizeMessage(String(err));
  }
  return { sanitizeMessage, sanitizeError };
}
