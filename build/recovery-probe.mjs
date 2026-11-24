// recovery-probe.ts — read-only health probe, complete-backup listing and the
// crash-leftover quarantine sweep. Stop-and-ask: a damaged database yields an
// explicit 'recovery-required' state; backups are listed, never auto-selected.

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { getLog } from './log.mjs';
import {
  isDirectory,
  listCompleteBackups,
  quarantineIncompleteBackups,
  writeDiagnostic,
} from './backup/safety.mjs';

import {
  STAGE_PREFIX,



} from './recovery-types.mjs';
import {
  findStaleStageFiles,
  freshQuarantineDir,
  probeDatabaseFile,
  sanitizeError,
} from './recovery-shared.mjs';

















export function createRecoveryProbe(deps                   )                {
  const { source, root, dataFile, backupsDir, quarantineDir, moveToQuarantine, now } = deps;

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
        const target = freshQuarantineDir(quarantineDir, now);
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

  function probe()                {
    const staleStage = findStaleStageFiles(root, STAGE_PREFIX);
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

  return { list, reconcileNow, probe };
}
