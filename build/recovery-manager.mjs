// recovery-manager.ts — assembles the recovery loop from its cohesive parts.
// It binds the write coordinator, wires validation/activation/probe factories,
// and drives the two validate-then-activate operations (live swap and fresh
// directory restore). No file-level policy lives here: that belongs to the
// sub-modules this coordinator composes.

import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { getLog } from './log.mjs';
import {
  createQuarantineMover,
  isCompleteBackupDir,
  isDirectory,
  writeDiagnostic,
} from './backup/safety.mjs';
import {
  BACKUPS_DIR,
  QUARANTINE_DIR,
  RECOVERY_DATA_FILENAME,
  RECOVERY_MANAGED_SUBDIRECTORIES,
  STAGE_PREFIX,





} from './recovery-types.mjs';
import {
  ensurePrivateDirectory,
  recoveryToken,
  sanitizeError,
  validateBackupId,
  validationReason,
} from './recovery-shared.mjs';
import { createRecoveryValidator } from './recovery-validation.mjs';
import { createRecoveryActivator } from './recovery-activation.mjs';
import { createRecoveryProbe } from './recovery-probe.mjs';

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

  // Quarantine policy is the shared authority's — the same mover, diagnostic
  // writer and completeness check backup.ts uses. Only recovery's stale-stage
  // sweep and its wording stay local (in the probe sub-module).
  const moveToQuarantine = createQuarantineMover(quarantineDir);
  const validator = createRecoveryValidator({ blobs, validateMigrationLedger });
  const activator = createRecoveryActivator({ blobs, quarantineDir, root, dataFilename, now });
  const probeManager = createRecoveryProbe({ source, root, dataFile, backupsDir, quarantineDir, moveToQuarantine, now });

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
    const validation = await validator.validateBackup(backupDir);
    if (!validation.ok) {
      return { ok: false, status: 'rejected', backupId, reason: validationReason(backupId, validation.failures), validation: validation.failures };
    }

    // STAGE + CENSUS before the swap. The staged file is a faithful copy of the
    // fully-validated snapshot; the census runs on those bytes so a failing
    // census can never leave a half-activated database in the owned directory.
    // Verified blob generations are materialized into the owned directory's
    // blob layout BEFORE the census so the census sees the restored bytes.
    const stagePath = path.join(root, `${STAGE_PREFIX}${recoveryToken(now)}`);
    // Assigned in the try below; every path that reaches the return has a real
    // census (the catch always returns).
    let census                      ;
    try {
      if (faults?.beforeStage) faults.beforeStage();
      copyFileSync(path.join(backupDir, 'snapshot.sqlite'), stagePath);
      const staged = activator.quickCheckFile(stagePath);
      if (!staged.ok) throw new Error(`staged restore failed integrity verification: ${staged.reason}`);
      await activator.materializeRestoredBlobs(validation.manifest, backupDir, root);
      census = await activator.runCensus(stagePath, validation.manifest, root);
      if (!census.schema.ok) throw new Error(`schema census failed: ${census.schema.findings.join('; ')}`);
      if (!census.blobs.ok) throw new Error(`blob census failed: ${census.blobs.reason ?? 'referenced blob generations unavailable'}`);
    } catch (err) {
      return activator.quarantineFailedAttempt(backupId, stagePath, 'stage', [], err);
    }

    // ACTIVATE — the coordinator-serialized swap: quarantine the damaged
    // database, then atomically rename the fully-censused staged file into
    // place. A crash at any point leaves the old database quarantined and never
    // a half-written data.sqlite.
    let quarantinedDatabase                = null;
    try {
      await writeCoordinator.run(() => {
        if (faults?.beforeQuarantine) faults.beforeQuarantine();
        quarantinedDatabase = activator.quarantineDatabaseFiles();
        if (faults?.beforeRename) faults.beforeRename();
        renameSync(stagePath, dataFile);
      });
    } catch (err) {
      return activator.quarantineFailedAttempt(
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

    const validation = await validator.validateBackup(backupDir);
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
    const stagePath = path.join(target, `${STAGE_PREFIX}${recoveryToken(now)}`);
    // Assigned in the try below; every path that reaches the return has a real
    // census (the catch always returns).
    let census                      ;
    try {
      copyFileSync(path.join(backupDir, 'snapshot.sqlite'), stagePath);
      const staged = activator.quickCheckFile(stagePath);
      if (!staged.ok) throw new Error(`fresh restore failed integrity verification: ${staged.reason}`);
      await activator.materializeRestoredBlobs(validation.manifest, backupDir, target);
      census = await activator.runCensus(stagePath, validation.manifest, target);
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
    probe: probeManager.probe,
    list: probeManager.list,
    reconcile: probeManager.reconcileNow,
    recover,
    recoverIntoFreshDirectory,
    root,
  });
}
