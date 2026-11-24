// recovery-activation.ts — the coordinated swap's file-level steps: quarantine
// the damaged database together with its sidecars, materialize verified blob
// generations into the target, and run the full schema + blob census on the
// staged bytes BEFORE activation (census-before-serve).

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openSqliteDatabase,                     } from './sqlite-driver.mjs';
import { getLog } from './log.mjs';
import {
  schemaIdentityOf,
  verifyMaterialization,
  writeDiagnostic,
} from './backup/safety.mjs';

import {



} from './recovery-types.mjs';
import {
  deepEqual,
  freshQuarantineDir,
  integrityCheckOf,
  migrationLedgerOf,
  sanitizeError,
  validateLedgerConsistency,
} from './recovery-shared.mjs';
























export function createRecoveryActivator(deps                       )                    {
  const { blobs, quarantineDir, root, dataFilename, now } = deps;
  const quarantine = () => freshQuarantineDir(quarantineDir, now);

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
    const dir = quarantine();
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
        const target = quarantine();
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

  return {
    quarantineDatabaseFiles,
    quarantineFailedAttempt,
    materializeRestoredBlobs,
    runCensus,
    schemaCensusOf,
    quickCheckFile,
  };
}
