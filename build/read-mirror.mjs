// read-mirror.ts — the controlled read-mirror opener (epic scope#23, S1/A5).
//
// A read mirror is a read-only view over the writer's database for external
// readers (e.g. Scope's separate libsql connection in prisma.ts — the
// pre-cutover consumer S8 replaces with the framework description). The
// DESCRIPTION is produced by the app/adapter (buildReadMirrorDescription);
// THIS module opens it, enforcing read-only at two layers:
//
//   1. the ENGINE layer — the description pins `mode=ro` (SQLite opens the
//      connection read-only; the opener also passes `readOnly: true` and sets
//      `PRAGMA query_only = ON` as a second engine guard), and
//   2. the QUERY-CLASS REJECTOR — every statement is classified before it
//      reaches the engine; write / DDL / PRAGMA-mutating statements are
//      refused with a clear error.
//
// Belt-and-suspenders on purpose: even a consumer that bypasses the rejector
// and opens the connectionString itself is still read-only at the engine, so
// the rejection is enforced, not merely documented. The mirror never exposes
// write authority or a write path — no txn/begin/commit/upsert surface.

import { openSqliteDatabase,                      } from './sqlite-driver.mjs';




// Clear, distinguishable error for a refused statement. `code` lets a consumer
// branch without parsing the message; `kind` names the offending statement
// class.
export class ReadMirrorError extends Error {
           code = 'WB_READ_MIRROR_REFUSED';
           kind                         ;
  constructor(kind                                          , detail        ) {
    super(`read-mirror connection refused ${kind} statement: ${detail}`);
    this.name = 'ReadMirrorError';
    this.kind = kind;
  }
}

const READ_LEADING = new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN']);
const WRITE_LEADING = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT']);
const DDL_LEADING = new Set(['CREATE', 'ALTER', 'DROP', 'VACUUM', 'ATTACH', 'DETACH', 'REINDEX', 'TRUNCATE']);
const TRANSACTION_LEADING = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END']);
const PRAGMA_LEADING = new Set(['PRAGMA']);

// Read-only PRAGMAs a mirror consumer may issue. Everything else is refused
// fail-closed. `= value` forms are refused regardless of name (an assignment
// is a mutation of shared connection state).
const READ_ONLY_PRAGMAS = new Set([
  'table_info',
  'table_list',
  'table_xinfo',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'database_list',
  'function_list',
  'collation_list',
  'module_list',
  'pragma_list',
  'compile_options',
  'encoding',
  'page_count',
  'page_size',
  'freelist_count',
  'schema_version',
  'data_version',
  'quick_check',
  'integrity_check',
]);

// Scan one statement, returning the words that appear at parenthesis depth 0
// (outside string literals and comments) and the number of top-level
// statement separators (`;` outside quotes/comments). Words inside a CTE body
// or subquery (depth > 0) are invisible to classification, so
// `WITH c AS (...) INSERT ...` classifies as a write while
// `WITH c AS (INSERT ...) SELECT ...` classifies as a read.
function scanStatement(sql        )                                          {
  const words           = [];
  let statements = 1;
  let depth = 0;
  let index = 0;
  const n = sql.length;
  while (index < n) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? n : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? n : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      index += 1;
      while (index < n) {
        if (sql[index] === closing) {
          if (sql[index + 1] === closing) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth = depth > 0 ? depth - 1 : 0;
      index += 1;
      continue;
    }
    if (char === ';' && depth === 0) {
      statements += 1;
      index += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index));
      if (match) {
        words.push(match[0].toUpperCase());
        index += match[0].length;
        continue;
      }
    }
    index += 1;
  }
  return { words, statements };
}

function pragmaNameOf(sql        )                {
  const { words } = scanStatement(sql);
  const pragmaIndex = words.indexOf('PRAGMA');
  if (pragmaIndex === -1) return null;
  return words[pragmaIndex + 1]?.toLowerCase() ?? null;
}

function isPragmaAssignment(sql        )          {
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? sql.length : newline;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            index += 1;
            continue;
          }
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '=') return true;
  }
  return false;
}

// Classify a statement's intent by its top-level leading keywords. WRITE/DDL/
// PRAGMA/transaction win over READ so `EXPLAIN INSERT`, `WITH c AS (...)
// DELETE`, and `CREATE ...` are never misread as reads — the whole statement
// must be scanned before the read verdict. Unknown-leading statements are
// refused fail-closed.
export function classifyReadMirrorStatement(sql        )                          {
  const { words } = scanStatement(sql);
  let sawRead = false;
  for (const word of words) {
    if (WRITE_LEADING.has(word)) return 'write';
    if (DDL_LEADING.has(word)) return 'ddl';
    if (PRAGMA_LEADING.has(word)) return 'pragma';
    if (TRANSACTION_LEADING.has(word)) return 'transaction';
    if (READ_LEADING.has(word)) sawRead = true;
  }
  return sawRead ? 'read' : 'refuse';
}

function refuse(kind                                          , sql        )        {
  const snippet = sql.length > 60 ? `${sql.slice(0, 57)}...` : sql;
  throw new ReadMirrorError(kind, `'${snippet}' is not a read-only mirror statement`);
}

function assertReadOnlyStatement(sql        )       {
  const { statements } = scanStatement(sql);
  if (statements > 1) {
    throw new ReadMirrorError(
      'refuse',
      'a read-mirror call accepts exactly one statement (multi-statement strings are refused)',
    );
  }
  const kind = classifyReadMirrorStatement(sql);
  if (kind === 'read') return;
  if (kind === 'transaction') {
    // Transaction control cannot mutate (the engine connection is mode=ro), and
    // a mirror consumer may want a consistent snapshot read — so BEGIN/COMMIT
    // pass through to the engine, which still refuses any write that slips in.
    return;
  }
  if (kind === 'pragma') {
    const name = pragmaNameOf(sql);
    if (name && READ_ONLY_PRAGMAS.has(name) && !isPragmaAssignment(sql)) return;
    refuse('pragma', sql);
  }
  refuse(kind, sql);
}

// The opened read-mirror surface. `prepare`/`exec` are rejector-wrapped and
// `close` releases the underlying read-only connection. The raw engine handle
// is deliberately NOT exposed: a mirror consumer gets exactly the
// rejector-wrapped surface and no way to reach an unrestricted prepare/exec.
// Engine-level read-only enforcement is proven by opening the description's
// `mode=ro` connectionString directly (a consumer that bypasses the rejector
// is still read-only at the engine).






export function openReadMirror(description                       )                   {
  if (!description || typeof description !== 'object') {
    throw new TypeError('openReadMirror requires a controlled read-mirror description');
  }
  if (description.kind !== 'read-mirror' || description.mode !== 'read-only' || description.readOnly !== true) {
    throw new TypeError(
      'openReadMirror refuses a description that is not a pinned read-only mirror (readOnly: true, mode: read-only)',
    );
  }
  // Engine layer 1: mode=ro via the connectionString plus the readOnly option.
  // Engine layer 2: query_only pins the connection so even a statement the
  // rejector does not recognize cannot write.
  const raw = openSqliteDatabase(description.connectionString, { readOnly: true });
  raw.exec('PRAGMA query_only = ON');
  const handle                   = {
    prepare(sql        )                  {
      assertReadOnlyStatement(sql);
      return raw.prepare(sql);
    },
    exec(sql        )          {
      assertReadOnlyStatement(sql);
      return raw.exec(sql);
    },
    close()       {
      raw.close();
    },
  };
  return handle;
}
