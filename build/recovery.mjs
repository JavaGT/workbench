// recovery.ts — S1/A4 restore + quarantine (epic scope#23, library/API + tests
// only — no scheduler, no timer, no cron). Part of JavaGT/scope#576.
//
// CONTRACT: `createRecoveryManager` produces a manager whose
// `recover({ backupId })` performs VALIDATE-THEN-ACTIVATE against the backup
// layout `backups/<timestamp>-<id>/` produced by the S1/A3 backup manager
// (snapshot.sqlite + manifest.json + blobs/). Recovery is the only path that
// installs a database file into the owned directory. It validates EVERYTHING
// before activating, quarantines the damaged database (and any failed attempt)
// into `quarantine/<timestamp>-<id>/`, and never marks a restore complete until
// a full schema + blob census passes.
//
// VALIDATE-THEN-ACTIVATE (owner decision #1): the live database is NEVER
// replaced until the chosen backup has passed every gate — manifest shape
// (formatVersion, status 'complete', encryption 'none'), SQLite integrity_check,
// recomputed schema identity vs the manifest, the migration ledger that EXISTS
// in the snapshot (never a fresh-reset assumption; ScopeSchemaVersion stays
// Scope-owned until S8), and referenced-blob availability. Any failure aborts
// with the backup left untouched.
//
// STOP-AND-ASK DEFAULT (owner decision #1): `probe()` returns an explicit
// 'recovery-required' state with a plain-language explanation when the live
// database is damaged, and lists the available backups — it NEVER auto-selects
// one. `recover()` requires an explicit backupId; there is NO code path that
// falls back to an older backup. Interactive prompting belongs to the Operator
// (Scope) in S8, not here. The CLI entry (`scripts/recover.mjs`,
// `--recover <backupId>` / `--list-backups`) drives the same library API.
//
// COORDINATOR-SERIALIZED REPLACEMENT (acceptance): the quarantine + atomic swap
// runs inside the platform write coordinator turn — recovery never restores
// over a live database without that serialization. `createRecoveryManager`
// verifies at construction that the coordinator it is given is the source's
// declared owner (`source.writeCoordinator`); an unbound or foreign-coordinator
// source is refused, exactly like `createBackupManager` (a swap that is not
// serialized against live writes can clobber a database in use).
//
// CRASH SAFETY: the swap is [copy snapshot → staged `data.sqlite.<token>`] →
// [quarantine live data.sqlite + -wal + -shm TOGETHER] → [atomic rename stage →
// data.sqlite]. A crash at any point never leaves a half-written data.sqlite:
// the quarantine moves the damaged database out of the way as a whole (a stale
// WAL/shm sidecar can never pair with the restored file), and the final rename
// is atomic. The full census runs on the staged bytes BEFORE the swap, so a
// failing census leaves the live database and the backup untouched. A crash
// DURING blob materialization into the LIVE target leaves a byte-without-sidecar
// partial in the owned root's persistent blobs/ directory — the manager only
// quarantines the staged database file, never that directory — and the blob
// seam REPAIRS the leftover on the next attempt: it re-materializes the missing
// digest sidecar once the byte final verifies as the generation's own bytes
// (see the seam contract), so a crashed restore never permanently blocks a
// later restore of the same generations.
//
// DIRECTORY PRESERVATION (spec 5): recovery's swap and fresh-directory restore
// never wipe `backups/`, `quarantine/`, or `recycle/` (owned by S1/A3/A4/A6).
// The adapter teardown removes only the db file, -wal/-shm, and lock sidecar —
// a dev/reset path must clear database state, never recovery/backup material.
//
// The blob seam is DELIBERATELY pluggable (S6 owns blob enumeration and
// materialization): this module DECLARES the S6 blob-generation interface
// (`RecoveryBlobSeam`) and only calls into it. Without a seam, a backup that
// references blob generations refuses fail-closed (its bytes cannot be
// verified), mirroring the backup manager's no-seam rule. Verification ALONE is
// never enough: the seam must ALSO materialize the verified generations into
// the target's blob layout before the census runs, or the census would see
// missing bytes (fresh target) or stale bytes (live restore).

import { openSqliteDatabase,                     } from './sqlite-driver.mjs';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { getLog } from './log.mjs';
import { canonicalStringify } from './canonical-json.mjs';
import { createWriteQueue } from './write-queue.mjs';
import { MIGRATION_LEDGER_TABLE } from './migration-ledger.mjs';







// The crash-safety authority is shared with the backup loop: layout/id
// validation, completeness, quarantine sweep, quick_check, schema identity and
// verified blob containment all resolve to these exact functions.
import {
  BACKUP_FORMAT_VERSION,
  compareLedgerEntry,
  createMessageSanitizer,
  createQuarantineMover,
  formatTimestamp,
  isCompleteBackupDir,
  isDirectory,
  isValidBackupId,
  listCompleteBackups,
  quarantineIncompleteBackups,
  quickCheckOf,
  readMigrationLedger,
  schemaIdentityOf,
  verifyMaterialization,
  writeDiagnostic,

} from './backup/safety.mjs';

// The owned-directory vocabulary (kept in sync with sqlite-adapter.ts's
// MANAGED_SUBDIRECTORIES — the S1 section's directory-guard tests pin it):
// backups/ + quarantine/ live here, recycle/ is S1/A6's, blobs/ + staging/ are
// the blob store's. The physical database filename is derived the same way the
// adapter derives it.
export const RECOVERY_DATA_FILENAME = 'data.sqlite';
const BACKUPS_DIR = 'backups';
const QUARANTINE_DIR = 'quarantine';
const RECOVERY_MANAGED_SUBDIRECTORIES = Object.freeze(['blobs', 'staging', 'backups', 'quarantine', 'recycle']         );
// Staged copies of a snapshot waiting for the atomic swap. A leftover under
// this prefix in the owned directory means a restore crashed mid-swap.
const STAGE_PREFIX = 'data.sqlite.recovering-';

// The ONE DECLARED migration ledger table name (kept in sync with backup.ts's
// manifest type and migration-ledger.ts's MIGRATION_LEDGER_TABLE). This is the
// ONLY name a restore accepts: it is interpolated into SQL, and the manifest is
// untrusted input, so a manifest-chosen table name is refused (review #83).
const MIGRATION_LEDGER = MIGRATION_LEDGER_TABLE;

export const MAX_RECOVERY_DIAGNOSTIC_ERROR_LENGTH = 500;
const { sanitizeError } = createMessageSanitizer(MAX_RECOVERY_DIAGNOSTIC_ERROR_LENGTH);

// Canonical-equality for the manifest comparison surfaces. Arrays keep their
// order (schema identity is ordered), while object KEY order is insignificant:
// a ledger read back from SQLite can insert keys in a different order than the
// manifest writer did, and JSON.stringify would report a false mismatch.
function deepEqual(a         , b         )          {
  try {
    return canonicalStringify(a) === canonicalStringify(b);
  } catch {
    return false;
  }
}

// ---- public types ---------------------------------------------------------

// The pluggable blob-generation seam (S6 declares + implements the concrete
// census). The backup side (`BackupBlobSource`) materializes generations INTO
// the backup; the recovery side verifies those bytes pre-activation, materializes
// them into the target's blob layout, and censuses the live/fresh blob store
// before a restore may be complete.



      


                                                    











                                                                               





// The migration-ledger validation seam (S1/A4 spec 1: "declared schema identity
// matches the ledger that EXISTS"). ScopeSchemaVersion is Scope-owned until S8,
// so the LIBRARY cannot know the app's declared identity — this seam lets the
// app/Scope assert its declared schema against the ledger the backup actually
// holds. The default validation checks internal consistency + that the snapshot
// recomputes to exactly the manifest's recorded ledger (never a fresh-reset
// assumption).





// The recovery source: the owned directory plus (for activation) the ONE write
// coordinator that serializes writes to that directory's database. An opened
// sqlite adapter satisfies this shape (`root`, `writeCoordinator`, and the
// read-only `probeRecovery` hook). For a corrupt database the adapter cannot be
// opened (its fail-closed quick_check throws), so a recovery manager may be
// built over a plain `{ root }` source — the manager probes the file directly.
















                                                          










                 




// Crash-injection seams for the restore-swap durability tests (S1/A4 test list
// `recovery-swap.test.mjs`). Not a production surface.






// The read-only health probe result. `probe()` folds this into the explicit
// 'recovery-required' state; `probeDatabaseFile` is the canonical non-throwing
// file probe the sqlite adapter's `probeRecovery` hook delegates to.











// The explicit startup state (spec 3: stop and explain plainly, return an
// explicit 'recovery required' state; NO automatic destructive fallback). The
// healthy branch is `{ ok: true }`; the damaged branch carries a plain-language
// reason plus the available backups, which are listed but never auto-selected.





















































                             






              










// ---- the canonical read-only file probe -----------------------------------

// Non-throwing health probe for a database FILE. Opens the file (read-write,
// like the backup manager's snapshot inspection — a read-only WAL open without
// a -shm can block) and runs the fast quick scan. Reports `ok: false` with a
// plain reason and the integrity findings when the file cannot be opened or is
// corrupt — including a corrupt WAL, which fails at open. Sidecars are NOT
// removed here: a healthy live database may have a connection using them, and
// removing them would damage that connection. A missing file is healthy (a
// brand-new owned directory has nothing to recover).
export function probeDatabaseFile(dbFilePath        )                      {
  if (!existsSync(dbFilePath)) {
    return { ok: true, checkedAt: new Date().toISOString() };
  }
  let db                ;
  try {
    db = openSqliteDatabase(dbFilePath);
  } catch (err) {
    return { ok: false, reason: 'the database file could not be opened — it is corrupt or damaged', findings: [sanitizeError(err)] };
  }
  try {
    const rows = db.prepare('PRAGMA quick_check').all()                                  ;
    const findings           = [];
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

// ---- manager --------------------------------------------------------------

export function createRecoveryManager(options                        )                  {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createRecoveryManager requires an options object');
  }
  const source = options.source;
  if (!source || typeof source.root !== 'string' || source.root.length === 0) {
    throw new TypeError('recovery manager requires a FILE-mode source with an owned directory (root)');
  }
  if (!options.writeCoordinator || typeof options.writeCoordinator.run !== 'function') {
    throw new TypeError('recovery manager requires the single write coordinator (writeCoordinator.run) for the coordinated swap');
  }
  const writeCoordinator = options.writeCoordinator;
  // COORDINATOR OWNERSHIP (acceptance: never restore over a live database
  // without coordinator-serialized replacement). Shape is not proof — the swap
  // must run through the ONE coordinator that serializes writes to this
  // directory's database, so the source must declare its owner and the passed
  // coordinator must be exactly it.
  if (source.writeCoordinator === undefined) {
    throw new TypeError(
      'recovery manager requires the source to declare the write coordinator that owns it: bind source.writeCoordinator to the coordinator that serializes writes to this database (an unbound source cannot prove its swap excludes writes)',
    );
  }
  if (source.writeCoordinator !== writeCoordinator) {
    throw new TypeError(
      'recovery manager refuses a foreign write coordinator: the passed writeCoordinator is not the source\'s declared owner (source.writeCoordinator) — its swap would not be serialized against writes to this database',
    );
  }
  const blobs = options.blobs ?? null;
  if (
    blobs !== null &&
    (typeof blobs.verifyBackupGeneration !== 'function' &&
      typeof blobs.materializeRestoreGeneration !== 'function' &&
      typeof blobs.censusAfterRestore !== 'function')
  ) {
    throw new TypeError(
      'recovery blobs source must expose verifyBackupGeneration(generation, backupBlobsDir), materializeRestoreGeneration(generation, backupBlobsDir, destBlobDir), and/or censusAfterRestore(generations, targetRoot)',
    );
  }
  const validateMigrationLedger = options.validateMigrationLedger ?? null;
  if (validateMigrationLedger !== null && typeof validateMigrationLedger !== 'function') {
    throw new TypeError('recovery validateMigrationLedger must be a function');
  }
  const faults = options.faults;
  const now = options.now ?? (() => new Date());

  const root = path.resolve(source.root);
  const dataFilename = source.dataFilename ?? RECOVERY_DATA_FILENAME;
  const dataFile = path.join(root, dataFilename);
  const backupsDir = path.join(root, BACKUPS_DIR);
  const quarantineDir = path.join(root, QUARANTINE_DIR);

  // The recovery manager owns the same managed layout the adapter creates, so
  // it works over a directory that has never been opened (the CLI, and the
  // corrupt-db stop-and-ask path where the adapter refuses to open).
  for (const dir of [root, ...RECOVERY_MANAGED_SUBDIRECTORIES.map((name) => path.join(root, name))]) {
    ensurePrivateDirectory(dir);
  }

  function recoveryToken()         {
    return `${formatTimestamp(now())}-${randomBytes(6).toString('hex')}`;
  }

  function freshQuarantineDir()         {
    const base = recoveryToken();
    let target = path.join(quarantineDir, base);
    let suffix = 0;
    while (existsSync(target)) {
      suffix += 1;
      target = path.join(quarantineDir, `${base}.q${suffix}`);
    }
    return target;
  }

  // Quarantine policy is the shared authority's — the same mover, diagnostic
  // writer and completeness check backup.ts uses. Only recovery's stale-stage
  // sweep and its wording stay local.
  const moveToQuarantine = createQuarantineMover(quarantineDir);

  function list()                             {
    return listCompleteBackups                (backupsDir);
  }

  // Quarantine sweep (mirrors backup.ts's reconcile): crash leftovers (a dir
  // without a valid complete manifest) and stale recovery stage files move to
  // quarantine/. Failures on individual entries are logged and skipped.
  function reconcileNow()                            {
    const quarantined = quarantineIncompleteBackups({
      backupsDir,
      diagnosticError: 'incomplete backup directory quarantined by recovery reconcile',
      moveToQuarantine,
      now,
      onFailure: (err, dir) =>
        getLog().warn('system', 'recovery reconcile failed to quarantine an incomplete backup', { error: sanitizeError(err), dir }),
    });
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith(STAGE_PREFIX)) continue;
      const file = path.join(root, entry);
      try {
        if (isDirectory(file)) continue;
        const target = freshQuarantineDir();
        mkdirSync(target, { mode: 0o700 });
        writeDiagnostic(target, {
          at: now().toISOString(),
          stage: 'quarantine',
          error: 'interrupted recovery stage file quarantined by recovery reconcile',
          detail: { file: entry },
        });
        renameSync(file, path.join(target, entry));
        quarantined.push(target);
      } catch (err) {
        getLog().warn('system', 'recovery reconcile failed to quarantine a stale stage file', { error: sanitizeError(err), file });
      }
    }
    return { quarantined };
  }

  function findStaleStageFiles()           {
    try {
      return readdirSync(root).filter((entry) => entry.startsWith(STAGE_PREFIX));
    } catch {
      return [];
    }
  }

  function probe()                {
    const staleStage = findStaleStageFiles();
    const interruptedRecovery = staleStage.length > 0;
    if (!existsSync(dataFile)) {
      if (interruptedRecovery) {
        return {
          ok: false,
          state: 'recovery-required',
          reason:
            'an earlier restore was interrupted before the database was installed — the recovered copy is in quarantine and the database file is missing. Run reconcile() to quarantine the leftover, then restore from a backup explicitly.',
          findings: staleStage,
          interruptedRecovery,
          backups: list(),
        };
      }
      // A missing main file is healthy ONLY when no WAL/shm sidecars were left
      // behind. An orphan sidecar means a crash between file deletion and
      // sidecar cleanup (or a partial quarantine): opening the adapter would
      // replay a WAL with no database and fail closed at boot, so report the
      // damaged state here instead of a false healthy probe.
      const orphanSidecars = ['-wal', '-shm']
        .map((suffix) => `${dataFile}${suffix}`)
        .filter((file) => existsSync(file));
      if (orphanSidecars.length > 0) {
        return {
          ok: false,
          state: 'recovery-required',
          reason:
            'the database file is missing but its SQLite WAL/shm sidecars remain — the database was left damaged by an interrupted shutdown or cleanup. Reconcile or restore from a backup explicitly.',
          findings: orphanSidecars,
          interruptedRecovery,
          backups: list(),
        };
      }
      return { ok: true, checkedAt: new Date().toISOString() };
    }
    const probeResult = source.probeRecovery ? source.probeRecovery() : probeDatabaseFile(dataFile);
    if (probeResult.ok) return { ok: true, checkedAt: probeResult.checkedAt };

    const backups = list();
    const reason =
      `${probeResult.reason}. The application has stopped rather than risk data loss.` +
      (interruptedRecovery ? ' An interrupted recovery attempt was also found.' : '') +
      (backups.length > 0
        ? ` Restore from one of ${backups.length} available backup(s) — use the --recover <backupId> CLI entry or the programmatic recover() API.`
        : ' No backups are available to restore from.') +
      ' No backup was selected automatically.';
    return {
      ok: false,
      state: 'recovery-required',
      reason,
      findings: probeResult.findings,
      interruptedRecovery,
      backups,
    };
  }

  function validateBackupId(backupId         )                {
    if (!isValidBackupId(backupId)) {
      return 'invalid backupId — expected <ISO-timestamp>-<hex> (e.g. 2026-01-01T00-00-00.000Z-abcd1234ef567890)';
    }
    return null;
  }

  function validationReason(backupId        , failures                   )         {
    return `backup '${backupId}' could not be restored: ${failures.join('; ')}`;
  }

  // ---- the validation gates (ALL before any mutation) ----------------------

  async function validateBackup(
    backupDir        ,
  )                                                                                      {
    const snapshotPath = path.join(backupDir, 'snapshot.sqlite');
    if (!existsSync(snapshotPath)) return { ok: false, failures: ['backup has no snapshot.sqlite'] };

    let manifest                ;
    try {
      manifest = JSON.parse(readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'))                  ;
    } catch {
      return { ok: false, failures: ['backup manifest is missing or unreadable'] };
    }
    const shapeFailures = validateManifestShape(manifest);
    if (shapeFailures.length > 0) return { ok: false, failures: shapeFailures };

    const failures           = [];
    let db                ;
    try {
      db = openSqliteDatabase(snapshotPath);
    } catch (err) {
      return { ok: false, failures: [`backup snapshot could not be opened: ${sanitizeError(err)}`] };
    }
    try {
      const integrity = integrityCheckOf(db);
      for (const finding of integrity.findings) failures.push(`backup snapshot failed integrity_check: ${finding}`);
      // RECOMPUTE the integrity the manifest recorded (the backup side records
      // a quick_check report) and require it to match the manifest — an
      // integrityResult that the snapshot does not reproduce (removed,
      // falsified, or stale) fails closed (issue #82 contract, review #83).
      const recordedIntegrity = quickCheckOf(db, { describeError: sanitizeError });
      if (recordedIntegrity.ok !== manifest.integrityResult.ok) {
        failures.push('snapshot integrity does not match the manifest integrityResult');
      }
      // The snapshot must recompute to EXACTLY the identities the manifest
      // recorded when the backup was taken — a drifted or tampered snapshot is
      // not the backup the manifest describes. A corrupt snapshot can throw at
      // the recompute queries themselves; any throw is a validation failure,
      // never a restore.
      let identity                                                                 ;
      let ledger                            ;
      try {
        identity = schemaIdentityOf(db);
        ledger = migrationLedgerOf(db, manifest);
      } catch (err) {
        failures.push(`backup snapshot could not be validated: ${sanitizeError(err)}`);
        return { ok: false, failures };
      }
      if (identity.platformSchemaIdentity !== manifest.platformSchemaIdentity) {
        failures.push('snapshot schema identity does not match the manifest (platform)');
      }
      if (!deepEqual(identity.appSchemaIdentity, manifest.appSchemaIdentity)) {
        failures.push('snapshot schema identity does not match the manifest (app)');
      }
      // The migration ledger that EXISTS in the snapshot (never a fresh-reset
      // assumption) must match the manifest AND be internally consistent.
      if (!deepEqual(ledger, manifest.migrationLedgerState)) {
        failures.push('snapshot migration ledger does not match the manifest');
      }
      failures.push(...validateLedgerConsistency(manifest.migrationLedgerState));
      if (validateMigrationLedger) {
        try {
          await validateMigrationLedger(manifest.migrationLedgerState, manifest);
        } catch (err) {
          failures.push(`migration ledger rejected by the declared schema identity: ${sanitizeError(err)}`);
        }
      }
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort close on the validation path */
      }
    }
    if (failures.length > 0) return { ok: false, failures };

    const blobFailures = await validateBlobAvailability(manifest, backupDir);
    if (blobFailures.length > 0) return { ok: false, failures: blobFailures };
    return { ok: true, manifest };
  }

  // Manifests record timestamps as the canonical UTC ISO-8601 instant the
  // backup side writes (`Date.prototype.toISOString()`: YYYY-MM-DDTHH:mm:ss.sssZ).
  // Both the format AND the round-trip must hold: `Date.parse` normalizes
  // impossible dates (2026-02-30T00:00:00.000Z silently becomes March 2) and
  // lenient forms ('yesterday', no-millis, +00:00), so re-serializing the
  // parsed instant must reproduce the recorded string exactly.
  function isValidIsoUtcTimestamp(value         )                  {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const instant = Date.parse(value);
    if (Number.isNaN(instant)) return false;
    return new Date(instant).toISOString() === value;
  }

  function validateManifestShape(manifest                )           {
    const failures           = [];
    if (typeof manifest !== 'object' || manifest === null) return ['manifest is not an object'];
    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
      failures.push(`unsupported backup formatVersion ${JSON.stringify(manifest.formatVersion)} (expected ${BACKUP_FORMAT_VERSION})`);
    }
    if (manifest.status !== 'complete') {
      failures.push(`backup is not complete (status ${JSON.stringify(manifest.status)})`);
    }
    if (manifest.encryption !== 'none') {
      failures.push(
        `backup declares encryption ${JSON.stringify(manifest.encryption)} — the platform restores only volume-encrypted (encryption 'none') backups`,
      );
    }
    // Issue #82 manifest contract: validate EVERY enumerated field (types +
    // content), never a subset. A manifest that omits or falsifies a recorded
    // identity/integrity field must not restore (review #83).
    if (typeof manifest.platformSchemaIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.platformSchemaIdentity)) {
      failures.push('manifest platformSchemaIdentity is not a valid schema fingerprint (64 lowercase hex)');
    }
    if (
      !Array.isArray(manifest.appSchemaIdentity) ||
      manifest.appSchemaIdentity.some((id) => typeof id !== 'string' || id.length === 0)
    ) {
      failures.push('manifest appSchemaIdentity is not an array of non-empty strings');
    }
    if (!isValidIsoUtcTimestamp(manifest.createdAt)) {
      failures.push('manifest createdAt is not a valid ISO-8601 UTC timestamp');
    }
    if (!isValidIsoUtcTimestamp(manifest.completedAt)) {
      failures.push('manifest completedAt is not a valid ISO-8601 UTC timestamp');
    }
    if (
      !Array.isArray(manifest.blobGenerations) ||
      manifest.blobGenerations.some((generation) => typeof generation !== 'string' || generation.length === 0)
    ) {
      failures.push('manifest blobGenerations is not an array of generation ids');
    }
    const integrity = manifest.integrityResult           ;
    if (!integrity || typeof integrity !== 'object') {
      failures.push('manifest integrityResult is missing');
    } else {
      const ir = integrity                            ;
      if (typeof ir.ok !== 'boolean') failures.push('manifest integrityResult.ok is not a boolean');
      if (!isValidIsoUtcTimestamp(ir.checkedAt)) {
        failures.push('manifest integrityResult.checkedAt is not a valid ISO-8601 UTC timestamp');
      }
      if (!Array.isArray(ir.findings)) {
        failures.push('manifest integrityResult.findings is not an array');
      } else {
        for (const finding of ir.findings) {
          if (
            !finding ||
            typeof finding !== 'object' ||
            typeof (finding                             ).severity !== 'string' ||
            typeof (finding                             ).message !== 'string'
          ) {
            failures.push('manifest integrityResult contains a malformed finding');
            break;
          }
        }
        if (ir.ok === true && ir.findings.length > 0) {
          failures.push('manifest integrityResult is contradictory: records ok:true together with findings');
        }
      }
      if (manifest.status === 'complete' && ir.ok !== true) {
        failures.push('manifest records a failed integrity check for a complete backup');
      }
    }
    const ledger = manifest.migrationLedgerState           ;
    if (!ledger || typeof ledger !== 'object') {
      failures.push('manifest migrationLedgerState is missing');
    } else {
      failures.push(...validateLedgerShape(ledger                                       ));
    }
    return failures;
  }

  function validateLedgerShape(ledger                                     )           {
    const failures           = [];
    // The ledger table name is interpolated into SQL when the snapshot is
    // validated — the ONE DECLARED name only, never a manifest-chosen table
    // (review #83). The SQL seam itself re-enforces this before building any
    // statement; this shape check rejects other names up front.
    if (typeof ledger.table !== 'string' || ledger.table.length === 0) {
      failures.push('migration ledger table is not a string');
    } else if (ledger.table !== MIGRATION_LEDGER) {
      failures.push(
        `migration ledger declares an unsupported ledger table '${ledger.table}' — only '${MIGRATION_LEDGER}' is restored`,
      );
    }
    if (typeof ledger.maxVersion !== 'number' || !Number.isSafeInteger(ledger.maxVersion)) {
      failures.push('migration ledger maxVersion is not an integer');
    }
    if (!Array.isArray(ledger.appliedVersions)) {
      failures.push('migration ledger appliedVersions is not an array');
    } else {
      for (const entry of ledger.appliedVersions) {
        if (!entry || typeof entry !== 'object') {
          failures.push('migration ledger appliedVersions contains a non-object entry');
        } else {
          const namespace = (entry                           ).namespace;
          if (typeof namespace !== 'string' || namespace.length === 0 || namespace.includes('\0')) {
            failures.push('migration ledger appliedVersions entry is missing a non-empty namespace without NUL bytes');
          }
          const version = (entry                         ).version;
          if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
            failures.push('migration ledger appliedVersions entry is missing a positive integer version');
          }
        }
      }
    }
    return failures;
  }

  function validateLedgerConsistency(ledger                            )           {
    const failures           = [];
    const versions = ledger.appliedVersions;
    if (!Array.isArray(versions)) return failures;
    let previous                     = null;
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
      const version = typeof entry === 'object' && entry !== null ? (entry                         ).version : undefined;
      return typeof version === 'number' && version > highest ? version : highest;
    }, 0);
    if (typeof ledger.maxVersion === 'number' && ledger.maxVersion !== max) {
      failures.push(`migration ledger maxVersion ${ledger.maxVersion} does not match the highest applied version ${max}`);
    }
    return failures;
  }

  async function validateBlobAvailability(manifest                , backupDir        )                    {
    const generations = manifest.blobGenerations;
    if (!Array.isArray(generations)) return ['manifest blobGenerations is not an array'];
    if (generations.length === 0) return [];
    if (!blobs || typeof blobs.verifyBackupGeneration !== 'function') {
      return [
        'backup references blob generations but no recovery blob seam was supplied — the referenced bytes cannot be verified before activation (S6 provides the concrete census); refusing to restore',
      ];
    }
    // Verification alone is never enough: the seam must ALSO materialize the
    // verified bytes into the target's blob layout before the census runs, and
    // census the result. A seam missing any of the three refuses fail-closed,
    // like the no-seam rule (review #83).
    const missing           = [];
    if (typeof blobs.materializeRestoreGeneration !== 'function') {
      missing.push('materializeRestoreGeneration(generation, backupBlobsDir, destBlobDir)');
    }
    if (typeof blobs.censusAfterRestore !== 'function') {
      missing.push('censusAfterRestore(generations, targetRoot)');
    }
    if (missing.length > 0) {
      return [
        `backup references blob generations but the recovery blob seam is incomplete — missing ${missing.join(', ')} — the referenced bytes cannot be restored into and censused in the target (S6 provides the concrete seam); refusing to restore`,
      ];
    }
    const failures           = [];
    for (const generation of generations) {
      try {
        await blobs.verifyBackupGeneration(generation, path.join(backupDir, 'blobs'));
      } catch (err) {
        failures.push(`referenced blob generation '${generation}' is unavailable: ${sanitizeError(err)}`);
      }
    }
    return failures;
  }

  // ---- activation ----------------------------------------------------------

  // Move the live database files (data.sqlite + its -wal/-shm sidecars)
  // TOGETHER into a fresh quarantine/<timestamp>-<id>/ directory. Moving the
  // sidecars with the main file is what keeps a stale WAL from ever pairing
  // with the restored database. Orphan sidecars (a crash of a PREVIOUS
  // quarantine left them behind) are swept the same way. Returns the quarantine
  // dir, or null when nothing existed.
  function quarantineDatabaseFiles()                {
    const existing = [dataFilename, `${dataFilename}-wal`, `${dataFilename}-shm`]
      .map((name) => path.join(root, name))
      .filter((file) => existsSync(file));
    if (existing.length === 0) return null;
    const dir = freshQuarantineDir();
    mkdirSync(dir, { recursive: false, mode: 0o700 });
    chmodSync(dir, 0o700);
    try {
      for (const file of existing) {
        renameSync(file, path.join(dir, path.basename(file)));
      }
    } catch (err) {
      // A partial move (e.g. the -wal resisted) must NOT proceed to rename a
      // new db over a stale sidecar — abort and let the caller quarantine the
      // stage. The next recovery attempt sweeps whatever remained.
      getLog().error('system', 'recovery failed to quarantine the damaged database', { error: sanitizeError(err) });
      throw err;
    }
    writeDiagnostic(dir, {
      at: now().toISOString(),
      stage: 'quarantine',
      error: 'damaged database quarantined before restore',
      detail: { files: existing.map((file) => path.basename(file)) },
    });
    getLog().warn('system', 'damaged database quarantined before restore', { quarantine: dir });
    return dir;
  }

  // Fail-closed path for a failed activation: move any leftover stage file into
  // a fresh quarantine dir with a diagnostic, and log. The damaged database (if
  // already quarantined) is never touched.
  function quarantineFailedAttempt(
    backupId        ,
    stagePath        ,
    phase                        ,
    quarantinedSoFar                   ,
    err         ,
  )                 {
    const quarantined = [...quarantinedSoFar];
    try {
      if (existsSync(stagePath)) {
        const target = freshQuarantineDir();
        mkdirSync(target, { mode: 0o700 });
        writeDiagnostic(target, {
          at: now().toISOString(),
          stage: 'quarantine',
          error: 'failed recovery attempt quarantined',
          detail: { backupId, phase, file: path.basename(stagePath) },
        });
        renameSync(stagePath, path.join(target, path.basename(stagePath)));
        quarantined.push(target);
      }
    } catch (quarantineErr) {
      getLog().error('system', 'recovery failed closed and could not be fully quarantined', {
        error: sanitizeError(quarantineErr),
        backupId,
      });
    }
    getLog().error('system', 'recovery failed closed', { error: sanitizeError(err), backupId, phase });
    return {
      ok: false,
      status: 'failed',
      backupId,
      reason: `restore of backup '${backupId}' failed at ${phase}: ${sanitizeError(err)}`,
      quarantined,
    };
  }

  // Materialize every referenced generation's verified bytes from the backup's
  // blobs/ into the target's blob-store layout BEFORE the census runs — without
  // this a real S6 census would see missing bytes in a fresh target, or stale
  // bytes in a live restore, and could never honestly confirm the restored
  // store (review #83). Each write is verified against disk (lstat + realpath
  // containment, mirroring the backup side), so a seam that lies about writing
  // fails the restore. A crash DURING this step into the LIVE target leaves a
  // byte-without-sidecar partial in the owned root's persistent blobs/
  // directory (the manager quarantines only the staged database file, never
  // that directory); the blob seam REPAIRS it on the next attempt — it
  // re-materializes the missing digest sidecar once the byte final verifies as
  // the generation's own bytes, and treats an already-complete generation as a
  // no-op — so a crash leftover can never permanently block a later restore of
  // that generation (see the seam contract). A fresh-restore failure removes
  // the whole disposable target, crash leftovers included.
  async function materializeRestoredBlobs(manifest                , backupDir        , targetRoot        )                {
    const generations = manifest.blobGenerations;
    if (generations.length === 0) return;
    if (!blobs || typeof blobs.materializeRestoreGeneration !== 'function') {
      throw new Error(
        'backup references blob generations but the recovery blob seam cannot materialize them into the target blob store — refusing (S6 provides the concrete materializer)',
      );
    }
    const backupBlobsDir = path.join(backupDir, 'blobs');
    const destBlobDir = path.join(targetRoot, 'blobs');
    for (const generation of generations) {
      const report = await blobs.materializeRestoreGeneration(generation, backupBlobsDir, destBlobDir);
      const verified = verifyMaterialization(generation, destBlobDir, report, { directoryLabel: 'target blob directory' });
      if (!verified.ok) throw new Error(verified.reason);
    }
  }

  // The full schema + blob census run on the staged bytes BEFORE the swap
  // (census-before-serve): a failing census leaves the live database and the
  // backup untouched — nothing is marked complete until the census passes.
  async function runCensus(dbFilePath        , manifest                , targetRoot        )                          {
    const schema = schemaCensusOf(dbFilePath, manifest);
    let blobsOutcome                          = { ok: true };
    if (manifest.blobGenerations.length > 0) {
      if (!blobs || typeof blobs.censusAfterRestore !== 'function') {
        blobsOutcome = {
          ok: false,
          reason: 'backup references blob generations but no recovery blob census seam was supplied — the live blob store cannot be verified (S6 provides the concrete census)',
        };
      } else {
        try {
          await blobs.censusAfterRestore(manifest.blobGenerations, targetRoot);
        } catch (err) {
          blobsOutcome = { ok: false, reason: `blob census failed: ${sanitizeError(err)}` };
        }
      }
    }
    return { schema, blobs: blobsOutcome };
  }

  function schemaCensusOf(dbFilePath        , manifest                )                           {
    const findings           = [];
    let db                ;
    try {
      db = openSqliteDatabase(dbFilePath);
    } catch (err) {
      return { ok: false, findings: [`restored database could not be opened: ${sanitizeError(err)}`] };
    }
    try {
      const integrity = integrityCheckOf(db);
      for (const finding of integrity.findings) findings.push(`restored database failed integrity_check: ${finding}`);
      let identity                                                                 ;
      let ledger                            ;
      try {
        identity = schemaIdentityOf(db);
        ledger = migrationLedgerOf(db, manifest);
      } catch (err) {
        findings.push(`restored database could not be validated: ${sanitizeError(err)}`);
        return { ok: false, findings };
      }
      if (identity.platformSchemaIdentity !== manifest.platformSchemaIdentity) {
        findings.push('restored schema identity does not match the backup manifest (platform)');
      }
      if (!deepEqual(identity.appSchemaIdentity, manifest.appSchemaIdentity)) {
        findings.push('restored schema identity does not match the backup manifest (app)');
      }
      if (!deepEqual(ledger, manifest.migrationLedgerState)) {
        findings.push('restored migration ledger does not match the backup manifest');
      }
      findings.push(...validateLedgerConsistency(manifest.migrationLedgerState));
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort close on the census path */
      }
      // The staged/restored file is OURS (freshly written) — removing the
      // sidecars a read-write inspection leaves behind is safe and keeps the
      // owned directory to exactly the database file.
      for (const sidecar of ['-shm', '-wal']) {
        try {
          rmSync(`${dbFilePath}${sidecar}`, { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
    return { ok: findings.length === 0, findings };
  }

  function quickCheckFile(filePath        )                                               {
    let db                ;
    try {
      db = openSqliteDatabase(filePath);
    } catch (err) {
      return { ok: false, reason: sanitizeError(err) };
    }
    try {
      const rows = db.prepare('PRAGMA quick_check').all()                                  ;
      for (const row of rows) {
        if (row.quick_check !== 'ok') return { ok: false, reason: row.quick_check };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: sanitizeError(err) };
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort close on the quick-check path */
      }
      for (const sidecar of ['-shm', '-wal']) {
        try {
          rmSync(`${filePath}${sidecar}`, { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  }

  async function recover(options                      )                          {
    const backupId = options.backupId;
    const idError = validateBackupId(backupId);
    if (idError) {
      return { ok: false, status: 'rejected', backupId, reason: idError, validation: [idError] };
    }
    const backupDir = path.join(backupsDir, backupId);
    if (!isDirectory(backupDir)) {
      const missing = `backup '${backupId}' was not found in backups/`;
      return { ok: false, status: 'rejected', backupId, reason: missing, validation: [missing] };
    }

    // A directory that is not a provably-complete backup (a crash leftover, a
    // partial attempt, or an unknown format) is quarantined — never restored,
    // never picked up. This is the partial/invalid-dir handling; a completed
    // manifest dir proceeds to validation and, on failure, is left untouched.
    if (!isCompleteBackupDir(backupDir)) {
      try {
        if (!existsSync(path.join(backupDir, 'diagnostic.json'))) {
          writeDiagnostic(backupDir, {
            at: now().toISOString(),
            stage: 'quarantine',
            error: 'incomplete backup directory quarantined by recovery',
            detail: { backupId },
          });
        }
        const quarantined = moveToQuarantine(backupDir);
        getLog().warn('system', 'incomplete backup quarantined by recovery', { backupId, quarantined });
        const reason = `backup '${backupId}' is incomplete (no valid complete manifest) and was quarantined — restore it is not possible`;
        return { ok: false, status: 'rejected', backupId, reason, validation: [reason], quarantined: [quarantined] };
      } catch (err) {
        const reason = `backup '${backupId}' is incomplete and could not be quarantined: ${sanitizeError(err)}`;
        return { ok: false, status: 'rejected', backupId, reason, validation: [reason] };
      }
    }

    // VALIDATE — everything, before any mutation. Any failure aborts with the
    // backup left untouched (the live database too).
    const validation = await validateBackup(backupDir);
    if (!validation.ok) {
      return { ok: false, status: 'rejected', backupId, reason: validationReason(backupId, validation.failures), validation: validation.failures };
    }

    // STAGE + CENSUS before the swap. The staged file is a faithful copy of the
    // fully-validated snapshot; the census runs on those bytes so a failing
    // census can never leave a half-activated database in the owned directory.
    // Verified blob generations are materialized into the owned directory's
    // blob layout BEFORE the census so the census sees the restored bytes.
    const stagePath = path.join(root, `${STAGE_PREFIX}${recoveryToken()}`);
    // Assigned in the try below; every path that reaches the return has a real
    // census (the catch always returns).
    let census                 ;
    try {
      if (faults?.beforeStage) faults.beforeStage();
      copyFileSync(path.join(backupDir, 'snapshot.sqlite'), stagePath);
      const staged = quickCheckFile(stagePath);
      if (!staged.ok) throw new Error(`staged restore failed integrity verification: ${staged.reason}`);
      await materializeRestoredBlobs(validation.manifest, backupDir, root);
      census = await runCensus(stagePath, validation.manifest, root);
      if (!census.schema.ok) throw new Error(`schema census failed: ${census.schema.findings.join('; ')}`);
      if (!census.blobs.ok) throw new Error(`blob census failed: ${census.blobs.reason ?? 'referenced blob generations unavailable'}`);
    } catch (err) {
      return quarantineFailedAttempt(backupId, stagePath, 'stage', [], err);
    }

    // ACTIVATE — the coordinator-serialized swap: quarantine the damaged
    // database, then atomically rename the fully-censused staged file into
    // place. A crash at any point leaves the old database quarantined and never
    // a half-written data.sqlite.
    let quarantinedDatabase                = null;
    try {
      await writeCoordinator.run(() => {
        if (faults?.beforeQuarantine) faults.beforeQuarantine();
        quarantinedDatabase = quarantineDatabaseFiles();
        if (faults?.beforeRename) faults.beforeRename();
        renameSync(stagePath, dataFile);
      });
    } catch (err) {
      return quarantineFailedAttempt(
        backupId,
        stagePath,
        'activation',
        quarantinedDatabase === null ? [] : [quarantinedDatabase],
        err,
      );
    }

    getLog().info('system', 'database restored from backup', { backupId, quarantine: quarantinedDatabase });
    return {
      ok: true,
      status: 'restored',
      backupId,
      directory: root,
      quarantinedDatabase,
      census,
    };
  }

  async function recoverIntoFreshDirectory(options                                         )                               {
    const backupId = options.backupId;
    const idError = validateBackupId(backupId);
    if (idError) {
      return { ok: false, status: 'rejected', backupId, reason: idError, validation: [idError] };
    }
    const backupDir = path.join(backupsDir, backupId);
    if (!isDirectory(backupDir)) {
      const missing = `backup '${backupId}' was not found in backups/`;
      return { ok: false, status: 'rejected', backupId, reason: missing, validation: [missing] };
    }

    // Same partial/invalid-dir handling as recover(): never restore a dir that
    // cannot prove it is a complete backup.
    if (!isCompleteBackupDir(backupDir)) {
      try {
        if (!existsSync(path.join(backupDir, 'diagnostic.json'))) {
          writeDiagnostic(backupDir, {
            at: now().toISOString(),
            stage: 'quarantine',
            error: 'incomplete backup directory quarantined by recovery',
            detail: { backupId },
          });
        }
        const quarantined = moveToQuarantine(backupDir);
        getLog().warn('system', 'incomplete backup quarantined by recovery', { backupId, quarantined });
        const reason = `backup '${backupId}' is incomplete (no valid complete manifest) and was quarantined — restore it is not possible`;
        return { ok: false, status: 'rejected', backupId, reason, validation: [reason] };
      } catch (err) {
        const reason = `backup '${backupId}' is incomplete and could not be quarantined: ${sanitizeError(err)}`;
        return { ok: false, status: 'rejected', backupId, reason, validation: [reason] };
      }
    }

    const validation = await validateBackup(backupDir);
    if (!validation.ok) {
      return { ok: false, status: 'rejected', backupId, reason: validationReason(backupId, validation.failures), validation: validation.failures };
    }

    // A fresh restore never touches an existing directory: it must not be able
    // to overwrite anything, so a non-empty target (or one already holding a
    // database) is refused. An empty/missing target is disposable — on failure
    // the whole freshly-created directory is removed (fail closed).
    const target = path.resolve(options.directory);
    if (existsSync(target) && readdirSync(target).length > 0) {
      const busy = 'the target directory is not empty — a fresh restore refuses to touch a non-empty directory';
      return { ok: false, status: 'rejected', backupId, reason: busy, validation: [busy] };
    }
    if (existsSync(path.join(target, dataFilename))) {
      const busy = `the target directory already contains a database (${dataFilename})`;
      return { ok: false, status: 'rejected', backupId, reason: busy, validation: [busy] };
    }

    ensurePrivateDirectory(target);
    for (const sub of RECOVERY_MANAGED_SUBDIRECTORIES) {
      ensurePrivateDirectory(path.join(target, sub));
    }

    const targetData = path.join(target, dataFilename);
    const stagePath = path.join(target, `${STAGE_PREFIX}${recoveryToken()}`);
    // Assigned in the try below; every path that reaches the return has a real
    // census (the catch always returns).
    let census                 ;
    try {
      copyFileSync(path.join(backupDir, 'snapshot.sqlite'), stagePath);
      const staged = quickCheckFile(stagePath);
      if (!staged.ok) throw new Error(`fresh restore failed integrity verification: ${staged.reason}`);
      await materializeRestoredBlobs(validation.manifest, backupDir, target);
      census = await runCensus(stagePath, validation.manifest, target);
      if (!census.schema.ok) throw new Error(`schema census failed: ${census.schema.findings.join('; ')}`);
      if (!census.blobs.ok) throw new Error(`blob census failed: ${census.blobs.reason ?? 'referenced blob generations unavailable'}`);
      renameSync(stagePath, targetData);
    } catch (err) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* the disposable fresh directory is removed best-effort */
      }
      return { ok: false, status: 'failed', backupId, reason: `fresh restore of backup '${backupId}' failed: ${sanitizeError(err)}`, census };
    }

    getLog().info('system', 'database restored into a fresh directory', { backupId, directory: target });
    return { ok: true, status: 'restored', backupId, directory: target, census };
  }

  return Object.freeze({
    probe,
    list,
    reconcile: reconcileNow,
    recover,
    recoverIntoFreshDirectory,
    root,
  });
}

// ---- sqlite-snapshot-side helpers -----------------------------------------

// Shared crash-safety recomputations (quickCheckOf, schemaIdentityOf, and
// verified blob containment) now live in ./backup/safety.ts — the one authority
// the backup manifest and this validator both call. Only recovery's stricter
// PRAGMA integrity_check stays local.
function integrityCheckOf(db                )                  {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all()                                      ;
    const findings                     = [];
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
function migrationLedgerOf(db                , manifest                )                             {
  const declaredTable = manifest.migrationLedgerState?.table ?? MIGRATION_LEDGER;
  if (declaredTable !== MIGRATION_LEDGER) {
    throw new Error(
      `manifest declares an unsupported migration ledger table '${declaredTable}' — only '${MIGRATION_LEDGER}' is restored`,
    );
  }
  return readMigrationLedger(db);
}

// ---- CLI ------------------------------------------------------------------








export function parseRecoveryCliArgs(argv                   )                  {
  let dir                    ;
  let action                    = { action: 'probe' };
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      const value = argv[index + 1];
      if (value === undefined) throw new TypeError('--dir requires a directory path');
      dir = value;
      index += 1;
    } else if (arg === '--recover') {
      const value = argv[index + 1];
      if (value === undefined) throw new TypeError('--recover requires a backupId');
      action = { action: 'recover', backupId: value };
      index += 1;
    } else if (arg === '--list-backups') {
      action = { action: 'list' };
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new TypeError(`unknown recovery CLI argument: ${arg}`);
    }
  }
  return { dir, action, help };
}

export const RECOVERY_CLI_USAGE = [
  'usage:',
  '  node scripts/recover.mjs --dir <owned-directory> [--list-backups]',
  '  node scripts/recover.mjs --dir <owned-directory> --recover <backupId>',
  '  node scripts/recover.mjs --dir <owned-directory>',
  '',
  'with no action, probes the database and prints the recovery state',
  '(an explicit "recovery required" explanation is printed when the database',
  'is corrupt; available backups are listed but never auto-selected).',
].join('\n');

// Programmatic CLI entry: returns the process exit code (0 = ok, 1 = recovery
// required / restore failed, 2 = usage error). The Operator (Scope, S8) drives
// the same recover() API for interactive prompting.
export async function runRecoveryCli(argv                   )                  {
  let parsed                 ;
  try {
    parsed = parseRecoveryCliArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(RECOVERY_CLI_USAGE);
    return 2;
  }
  if (parsed.help || !parsed.dir) {
    console.log(RECOVERY_CLI_USAGE);
    return parsed.help ? 0 : 2;
  }

  const writeCoordinator = createWriteQueue();
  // The write queue's declared `run<T>(fn: () => T): Promise<T>` is
  // structurally wider than the coordinator contract's
  // `run<T>(fn: () => Promise<T> | T): Promise<T>`; the platform bridges the
  // two at untyped seams (app.ts wires app.writeCoordinator the same way), so
  // the CLI bridges here. One object, one shape at runtime.
  const source                 = { root: parsed.dir, writeCoordinator: writeCoordinator                           };
  const manager = createRecoveryManager({ source, writeCoordinator: writeCoordinator                           });

  if (parsed.action.action === 'list') {
    const backups = manager.list();
    if (backups.length === 0) {
      console.log('no backups available');
      return 0;
    }
    console.log(`${backups.length} backup(s) available:`);
    for (const backup of backups) {
      console.log(`  ${backup.backupId}  created ${backup.createdAt}`);
    }
    return 0;
  }

  if (parsed.action.action === 'recover') {
    const result = await manager.recover({ backupId: parsed.action.backupId });
    if (result.ok) {
      console.log(`restored backup ${result.backupId} into ${result.directory}`);
      return 0;
    }
    console.error(result.reason);
    return 1;
  }

  const state = manager.probe();
  if (state.ok) {
    console.log('database OK — no recovery required');
    return 0;
  }
  console.error(state.reason);
  if (state.backups.length > 0) {
    console.error(`${state.backups.length} backup(s) available (restore explicitly, never automatically):`);
    for (const backup of state.backups) {
      console.error(`  ${backup.backupId}  created ${backup.createdAt}`);
    }
  }
  return 1;
}

// ---- small fs helpers -----------------------------------------------------

function ensurePrivateDirectory(dir        )       {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
