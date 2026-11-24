// recovery-cli.ts — the programmatic CLI surface. The Operator (Scope, S8)
// drives the same recover() API for interactive prompting; this module only
// parses arguments and renders results to stdout/stderr.

import { createWriteQueue } from './write-queue.mjs';

import {



} from './recovery-types.mjs';
import { createRecoveryManager } from './recovery-manager.mjs';

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
