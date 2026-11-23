import { type DbHandle } from './driver.ts';
import { frameworkTableNamesWithoutAuthCompile } from './framework-table-names.ts';

// The shared table-safety guard for transaction-bound capabilities that reach
// explicitly declared application-owned tables: erasure preparation writes and
// reads, and the protected-artefact store. ONE guard — a second copy of this
// logic beside the erasure capability would be the exact seam where the two
// paths drift (AGENTS.md: singular system).

const PACKAGE_TABLES = new Set(frameworkTableNamesWithoutAuthCompile.map((name) => name.toLowerCase()));

export type TableGuardFail = (message: string) => never;

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// Resolve a declared application table to its qualified `main."Table"` SQL name
// inside the caller's transaction, refusing anything that is not an explicitly
// allowlisted canonical application-owned table: Workbench package tables,
// shadowed temp tables, views, non-canonical or sqlite_ names, and (for writes)
// tables whose triggers or foreign keys could escape the bounded authority.
// `operation` names the failing path in the error message ('reads' | 'writes').
export function applicationTable(
  db: DbHandle,
  table: unknown,
  allowedTables: ReadonlySet<string>,
  operation: 'reads' | 'writes',
  fail: TableGuardFail,
): string {
  if (typeof table !== 'string' || table.length === 0) {
    fail(`application ${operation} table must be a non-empty string`);
  }
  if (!allowedTables.has(table)) {
    fail(`application ${operation} cannot access undeclared table '${table}'`);
  }
  if (db.prepare('SELECT 1 FROM sqlite_temp_master WHERE lower(name) = lower(?)').get(table)) {
    fail(`application ${operation} cannot access shadowed table '${table}'`);
  }
  const stored = db.prepare("SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type IN ('table', 'view')").get(table);
  if (stored?.type !== 'table') fail(`application ${operation} require table '${table}'`);
  const tableRow = db.prepare("SELECT name, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type = 'table'").get(table) as { name?: unknown; sql?: unknown } | undefined;
  const canonical: string = typeof tableRow?.name === 'string' ? tableRow.name : '';
  if (canonical !== table
    || (canonical.startsWith('_') && !/^_[A-Za-z][A-Za-z0-9_]*$/.test(canonical))
    || canonical.toLowerCase().startsWith('sqlite_')
    || PACKAGE_TABLES.has(canonical.toLowerCase())) {
    fail(`application ${operation} cannot access undeclared table '${table}'`);
  }
  const name = identifier(canonical);
  // SQLite classifies a VIRTUAL TABLE as `type = 'table'`, but writing one runs
  // the virtual-table module and fans out to its UNDECLARED shadow tables
  // (FTS5 _data/_idx/_content/... are the common case). The bounded-write
  // authority names ONE table; a virtual table is never a valid target for it.
  // Reads are unaffected (this guard's write contract is the boundary).
  if (operation === 'writes'
    && typeof tableRow?.sql === 'string'
    && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(tableRow.sql)) {
    fail(`application ${operation} cannot access virtual table '${table}'`);
  }
  if (operation === 'writes' && (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE").get(canonical)
    || db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE").get(canonical))) {
    fail(`application ${operation} cannot access triggered table '${table}'`);
  }
  if (operation === 'writes') {
    if (db.prepare(`PRAGMA foreign_key_list(${name})`).get()) {
      fail(`application ${operation} cannot access foreign-key table '${table}'`);
    }
    const tables = [
      ...db.prepare("SELECT 'main' AS schema, name FROM sqlite_master WHERE type = 'table'").all(),
      ...db.prepare("SELECT 'temp' AS schema, name FROM sqlite_temp_master WHERE type = 'table'").all(),
    ];
    for (const candidate of tables) {
      if (db.prepare(`PRAGMA ${candidate.schema}.foreign_key_list(${identifier(candidate.name as string)})`).all()
        .some((fk) => (fk.table as string | undefined)?.toLowerCase() === canonical.toLowerCase())) {
        fail(`application ${operation} cannot access referenced table '${table}'`);
      }
    }
  }
  return `main.${name}`;
}
