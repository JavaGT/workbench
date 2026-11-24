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
//
// IMPLEMENTATION: this file is the thin coordinator/barrel. The machine is
// split into cohesive siblings, strictly layered with no new import cycles:
//   recovery-types.ts     — public vocabulary + constants (leaf)
//   recovery-shared.ts     — pure helpers + canonical file probe (leaf)
//   recovery-validation.ts — validate-then-activate gates
//   recovery-activation.ts — quarantine / materialize / census steps
//   recovery-probe.ts      — read-only probe, listing, reconcile sweep
//   recovery-manager.ts    — createRecoveryManager orchestrator
//   recovery-cli.ts        — programmatic CLI surface
// Only the original public surface is re-exported below; sibling-only helpers
// and constants stay private to their modules. The one extra re-export is the
// shared crash-safety authority's declared layout version: recovery resolves
// its invariants from backup/safety.ts (never a private copy), and pinning that
// binding here keeps the barrel honest to the one-authority contract.

import { BACKUP_FORMAT_VERSION } from './backup/safety.ts';
export { BACKUP_FORMAT_VERSION };

export { RECOVERY_DATA_FILENAME, MAX_RECOVERY_DIAGNOSTIC_ERROR_LENGTH } from './recovery-types.ts';
export type {
  RecoveryBlobSeam,
  RecoveryMigrationValidator,
  RecoverySource,
  RecoveryManagerOptions,
  RecoveryFaultInjection,
  RecoveryProbeResult,
  RecoveryListing,
  RecoveryState,
  RecoveryCensus,
  RecoveryResult,
  FreshRecoveryResult,
  RecoveryManager,
  RecoveryCliAction,
  RecoveryCliArgs,
} from './recovery-types.ts';

export { probeDatabaseFile } from './recovery-shared.ts';
export { createRecoveryManager } from './recovery-manager.ts';
export { parseRecoveryCliArgs, RECOVERY_CLI_USAGE, runRecoveryCli } from './recovery-cli.ts';
