// recovery-validation.ts — VALIDATE-THEN-ACTIVATE gates. Every gate runs before
// any mutation: manifest shape, SQLite integrity, recomputed schema identity,
// the migration ledger that EXISTS in the snapshot, and referenced-blob
// availability. Failures abort with the backup and live database untouched.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openSqliteDatabase, type SqliteDatabase } from './sqlite-driver.ts';
import type { IntegrityFinding, IntegrityReport } from './db-adapter.ts';
import {
  BACKUP_FORMAT_VERSION,
  quickCheckOf,
  schemaIdentityOf,
} from './backup/safety.ts';
import type { BackupManifest, BackupMigrationLedgerState } from './backup.ts';
import {
  MIGRATION_LEDGER,
  type RecoveryBlobSeam,
  type RecoveryMigrationValidator,
} from './recovery-types.ts';
import {
  deepEqual,
  integrityCheckOf,
  isValidIsoUtcTimestamp,
  migrationLedgerOf,
  sanitizeError,
  validateLedgerConsistency,
} from './recovery-shared.ts';

export type RecoveryValidatorDeps = {
  readonly blobs: RecoveryBlobSeam | null;
  readonly validateMigrationLedger: RecoveryMigrationValidator | null;
};

export type BackupValidation =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; failures: string[] };

export type RecoveryValidator = {
  validateBackup(backupDir: string): Promise<BackupValidation>;
  validateManifestShape(manifest: BackupManifest): string[];
  validateLedgerShape(ledger: Partial<BackupMigrationLedgerState>): string[];
  validateBlobAvailability(manifest: BackupManifest, backupDir: string): Promise<string[]>;
};

export function createRecoveryValidator(deps: RecoveryValidatorDeps): RecoveryValidator {
  const { blobs, validateMigrationLedger } = deps;

  async function validateBackup(backupDir: string): Promise<BackupValidation> {
    const snapshotPath = path.join(backupDir, 'snapshot.sqlite');
    if (!existsSync(snapshotPath)) return { ok: false, failures: ['backup has no snapshot.sqlite'] };

    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as BackupManifest;
    } catch {
      return { ok: false, failures: ['backup manifest is missing or unreadable'] };
    }
    const shapeFailures = validateManifestShape(manifest);
    if (shapeFailures.length > 0) return { ok: false, failures: shapeFailures };

    const failures: string[] = [];
    let db: SqliteDatabase;
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
      let identity: { platformSchemaIdentity: string; appSchemaIdentity: string[] };
      let ledger: BackupMigrationLedgerState;
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

  function validateManifestShape(manifest: BackupManifest): string[] {
    const failures: string[] = [];
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
    const integrity = manifest.integrityResult as unknown;
    if (!integrity || typeof integrity !== 'object') {
      failures.push('manifest integrityResult is missing');
    } else {
      const ir = integrity as Partial<IntegrityReport>;
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
            typeof (finding as Partial<IntegrityFinding>).severity !== 'string' ||
            typeof (finding as Partial<IntegrityFinding>).message !== 'string'
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
    const ledger = manifest.migrationLedgerState as unknown;
    if (!ledger || typeof ledger !== 'object') {
      failures.push('manifest migrationLedgerState is missing');
    } else {
      failures.push(...validateLedgerShape(ledger as Partial<BackupMigrationLedgerState>));
    }
    return failures;
  }

  function validateLedgerShape(ledger: Partial<BackupMigrationLedgerState>): string[] {
    const failures: string[] = [];
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
          const namespace = (entry as { namespace?: unknown }).namespace;
          if (typeof namespace !== 'string' || namespace.length === 0 || namespace.includes('\0')) {
            failures.push('migration ledger appliedVersions entry is missing a non-empty namespace without NUL bytes');
          }
          const version = (entry as { version?: unknown }).version;
          if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
            failures.push('migration ledger appliedVersions entry is missing a positive integer version');
          }
        }
      }
    }
    return failures;
  }

  async function validateBlobAvailability(manifest: BackupManifest, backupDir: string): Promise<string[]> {
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
    const missing: string[] = [];
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
    const failures: string[] = [];
    for (const generation of generations) {
      try {
        await blobs.verifyBackupGeneration(generation, path.join(backupDir, 'blobs'));
      } catch (err) {
        failures.push(`referenced blob generation '${generation}' is unavailable: ${sanitizeError(err)}`);
      }
    }
    return failures;
  }

  return { validateBackup, validateManifestShape, validateLedgerShape, validateBlobAvailability };
}
