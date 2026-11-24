// recovery-types.ts — public vocabulary and constants for the recovery loop.
// Leaf module: depends only on the backup/migration type surfaces, never on a
// sibling recovery module. Keeps the dependency DAG strictly layered.

import { MIGRATION_LEDGER_TABLE } from './migration-ledger.ts';
import type {
  BackupWriteCoordinator,
  BackupManifest,
  BackupMigrationLedgerState,
} from './backup.ts';
import type { MaterializedBlobFile } from './backup/safety.ts';

// ---- constants ------------------------------------------------------------

// The owned-directory vocabulary (kept in sync with sqlite-adapter.ts's
// MANAGED_SUBDIRECTORIES — the S1 section's directory-guard tests pin it):
// backups/ + quarantine/ live here, recycle/ is S1/A6's, blobs/ + staging/ are
// the blob store's. The physical database filename is derived the same way the
// adapter derives it.
export const RECOVERY_DATA_FILENAME = 'data.sqlite';
export const BACKUPS_DIR = 'backups';
export const QUARANTINE_DIR = 'quarantine';
export const RECOVERY_MANAGED_SUBDIRECTORIES = Object.freeze(['blobs', 'staging', 'backups', 'quarantine', 'recycle'] as const);
// Staged copies of a snapshot waiting for the atomic swap. A leftover under
// this prefix in the owned directory means a restore crashed mid-swap.
export const STAGE_PREFIX = 'data.sqlite.recovering-';

// The ONE DECLARED migration ledger table name (kept in sync with backup.ts's
// manifest type and migration-ledger.ts's MIGRATION_LEDGER_TABLE). This is the
// ONLY name a restore accepts: it is interpolated into SQL, and the manifest is
// untrusted input, so a manifest-chosen table name is refused (review #83).
export const MIGRATION_LEDGER = MIGRATION_LEDGER_TABLE;

export const MAX_RECOVERY_DIAGNOSTIC_ERROR_LENGTH = 500;

// ---- public types ---------------------------------------------------------

// The pluggable blob-generation seam (S6 declares + implements the concrete
// census). The backup side (`BackupBlobSource`) materializes generations INTO
// the backup; the recovery side verifies those bytes pre-activation, materializes
// them into the target's blob layout, and censuses the live/fresh blob store
// before a restore may be complete.
export type RecoveryBlobSeam = {
  // Verify the backup actually holds verified bytes for one referenced
  // generation. Throws when the generation's bytes are missing or unverifiable
  // → the restore aborts with the backup left untouched.
  verifyBackupGeneration?(generation: string, backupBlobsDir: string): Promise<void> | void;
  // Materialize one verified generation's bytes from the backup's blobs/ into
  // the target's blob-store layout (`destBlobDir` — the target's `blobs/`
  // subdirectory, the same layout the backup side materialized into). Returns
  // the files written (name + size) so recovery can verify the bytes actually
  // landed. Required whenever a backup references generations: verification
  // alone leaves the target with no bytes for the census to see.
  materializeRestoreGeneration?(
    generation: string,
    backupBlobsDir: string,
    destBlobDir: string,
  ): Promise<readonly MaterializedBlobFile[]> | readonly MaterializedBlobFile[];
  // Post-restore blob census: confirm every referenced generation is available
  // in the live blob store of `targetRoot` (the owned directory, or the fresh
  // directory in a fresh restore) before the app is allowed to serve. Throws →
  // the restore is not marked complete (fail closed). S6 provides the concrete
  // census; absent a seam, a backup referencing generations is refused.
  censusAfterRestore?(generations: readonly string[], targetRoot: string): Promise<void> | void;
};

// The migration-ledger validation seam (S1/A4 spec 1: "declared schema identity
// matches the ledger that EXISTS"). ScopeSchemaVersion is Scope-owned until S8,
// so the LIBRARY cannot know the app's declared identity — this seam lets the
// app/Scope assert its declared schema against the ledger the backup actually
// holds. The default validation checks internal consistency + that the snapshot
// recomputes to exactly the manifest's recorded ledger (never a fresh-reset
// assumption).
export type RecoveryMigrationValidator = (
  ledger: BackupMigrationLedgerState,
  manifest: BackupManifest,
) => void | Promise<void>;

// The recovery source: the owned directory plus (for activation) the ONE write
// coordinator that serializes writes to that directory's database. An opened
// sqlite adapter satisfies this shape (`root`, `writeCoordinator`, and the
// read-only `probeRecovery` hook). For a corrupt database the adapter cannot be
// opened (its fail-closed quick_check throws), so a recovery manager may be
// built over a plain `{ root }` source — the manager probes the file directly.
export type RecoverySource = {
  readonly root: string;
  // The physical database filename under root; defaults to the adapter's
  // derived name ('data.sqlite').
  readonly dataFilename?: string;
  // OWNERSHIP BINDING (mirrors backup): REQUIRED for activation. The swap runs
  // through this coordinator; `createRecoveryManager` asserts the passed
  // coordinator is EXACTLY this object.
  readonly writeCoordinator?: BackupWriteCoordinator;
  // Optional read-only adapter-provided probe (sqlite-adapter.ts's recover
  // wiring). The manager uses it when present, else probes the file itself.
  probeRecovery?(): RecoveryProbeResult;
};

export type RecoveryManagerOptions = {
  readonly source: RecoverySource;
  // The ONE platform write coordinator (write-queue.ts) — MUST be the exact
  // coordinator the source declares as its owner (`source.writeCoordinator`).
  readonly writeCoordinator: BackupWriteCoordinator;
  // The pluggable blob seam (S6 implements). Optional; a backup that references
  // blob generations refuses without it (its bytes cannot be verified).
  readonly blobs?: RecoveryBlobSeam | null;
  // Optional declared-identity ledger validator (see RecoveryMigrationValidator).
  readonly validateMigrationLedger?: RecoveryMigrationValidator | null;
  readonly now?: () => Date;
  // Crash-injection seams used by the restore-swap durability tests: throwing
  // from a hook aborts the recovery at that point. The swap must remain
  // crash-safe — data.sqlite is never partially written, and every leftover is
  // quarantined. Never used in production.
  readonly faults?: RecoveryFaultInjection;
};

// Crash-injection seams for the restore-swap durability tests (S1/A4 test list
// `recovery-swap.test.mjs`). Not a production surface.
export type RecoveryFaultInjection = {
  readonly beforeStage?: () => void;
  readonly beforeQuarantine?: () => void;
  readonly beforeRename?: () => void;
};

// The read-only health probe result. `probe()` folds this into the explicit
// 'recovery-required' state; `probeDatabaseFile` is the canonical non-throwing
// file probe the sqlite adapter's `probeRecovery` hook delegates to.
export type RecoveryProbeResult =
  | Readonly<{ ok: true; checkedAt: string }>
  | Readonly<{ ok: false; reason: string; findings: readonly string[] }>;

export type RecoveryListing = Readonly<{
  readonly backupId: string;
  readonly directory: string;
  readonly manifest: BackupManifest;
  readonly createdAt: string;
}>;

// The explicit startup state (spec 3: stop and explain plainly, return an
// explicit 'recovery required' state; NO automatic destructive fallback). The
// healthy branch is `{ ok: true }`; the damaged branch carries a plain-language
// reason plus the available backups, which are listed but never auto-selected.
export type RecoveryState =
  | Readonly<{ ok: true; checkedAt: string }>
  | Readonly<{
      ok: false;
      state: 'recovery-required';
      reason: string;
      findings: readonly string[];
      interruptedRecovery: boolean;
      backups: readonly RecoveryListing[];
    }>;

export type RecoveryCensus = {
  readonly schema: Readonly<{ ok: boolean; findings: readonly string[] }>;
  readonly blobs: Readonly<{ ok: boolean; reason?: string }>;
};

export type RecoveryResult =
  | Readonly<{
      ok: true;
      status: 'restored';
      backupId: string;
      // The owned directory now holds the restored database.
      directory: string;
      // The quarantine dir holding the previous (damaged) database, or null
      // when there was none to quarantine.
      quarantinedDatabase: string | null;
      census: RecoveryCensus;
    }>
  | Readonly<{
      ok: false;
      status: 'rejected' | 'failed';
      backupId: string;
      // Plain-language explanation for the operator.
      reason: string;
      // Structured validation findings (status 'rejected').
      validation?: readonly string[];
      // Quarantine dirs retained on a failed activation (never overwritten).
      quarantined?: readonly string[];
      census?: RecoveryCensus;
    }>;

export type FreshRecoveryResult =
  | Readonly<{ ok: true; status: 'restored'; backupId: string; directory: string; census: RecoveryCensus }>
  | Readonly<{
      ok: false;
      status: 'rejected' | 'failed';
      backupId: string;
      reason: string;
      validation?: readonly string[];
      census?: RecoveryCensus;
    }>;

export type RecoveryManager = {
  // Read-only health probe → the explicit recovery-required state with a
  // plain-language explanation. Never mutates, never auto-selects a backup.
  probe(): RecoveryState;
  // Recoverable (complete) backups, newest first.
  list(): readonly RecoveryListing[];
  // Quarantine crash leftovers: incomplete backup dirs and stale recovery stage
  // files (an interrupted swap). Failures on individual entries are logged and
  // skipped — one broken leftover must not stop the sweep.
  reconcile(): Readonly<{ quarantined: readonly string[] }>;
  // Validate-then-activate restore into the owned directory (coordinator-
  // serialized swap; census-before-serve).
  recover(options: { backupId: string }): Promise<RecoveryResult>;
  // Restore into a FRESH directory (test-strategy requirement) + the full
  // schema + blob census before serving. Refuses a non-empty target.
  recoverIntoFreshDirectory(options: { backupId: string; directory: string }): Promise<FreshRecoveryResult>;
  readonly root: string;
};

// ---- CLI-facing types ----------------------------------------------------

export type RecoveryCliAction =
  | Readonly<{ action: 'probe' }>
  | Readonly<{ action: 'list' }>
  | Readonly<{ action: 'recover'; backupId: string }>;

export type RecoveryCliArgs = Readonly<{ dir?: string; action: RecoveryCliAction; help: boolean }>;
