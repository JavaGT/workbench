// recovery-types.ts — public vocabulary and constants for the recovery loop.
// Leaf module: depends only on the backup/migration type surfaces, never on a
// sibling recovery module. Keeps the dependency DAG strictly layered.

import { MIGRATION_LEDGER_TABLE } from './migration-ledger.mjs';







// ---- constants ------------------------------------------------------------

// The owned-directory vocabulary (kept in sync with sqlite-adapter.ts's
// MANAGED_SUBDIRECTORIES — the S1 section's directory-guard tests pin it):
// backups/ + quarantine/ live here, recycle/ is S1/A6's, blobs/ + staging/ are
// the blob store's. The physical database filename is derived the same way the
// adapter derives it.
export const RECOVERY_DATA_FILENAME = 'data.sqlite';
export const BACKUPS_DIR = 'backups';
export const QUARANTINE_DIR = 'quarantine';
export const RECOVERY_MANAGED_SUBDIRECTORIES = Object.freeze(['blobs', 'staging', 'backups', 'quarantine', 'recycle']         );
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





















































                             






              










// ---- CLI-facing types ----------------------------------------------------







