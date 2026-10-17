// migration-ledger.mjs — namespaced host migration ledger (S2/A4, workbench#90).
//
// Replaces the two legacy global integer ledgers (_Migration / _WorkbenchMigration)
// with ONE namespaced ledger table keyed by (namespace, version). Identity is the
// (namespace, version) pair: two namespaces may use the same version number
// without conflict. The `workbench` namespace is package-owned and reserved —
// an application may not register migrations there (consideration #12).
//
// Per migration the ledger records `name`, `checksum` (an immutable fingerprint
// of the migration's canonical source), `appliedAt`, and `suppliedBy` (the
// package/app version that supplied it). An already-applied migration whose
// checksum differs refuses startup (consideration #14). Versions are
// monotonically ordered positive integers per namespace and, when a namespace
// declares more than one, contiguous (consideration #15: a gap requires a
// documented reason; no reason mechanism exists, so a gap is refused). Explicit
// cross-namespace dependencies (`dependencies: ["workbench@5"]`) drive the
// execution order from the dependency graph, never registration order; a cycle
// is an error (consideration #17). No app+schema integer merge exists anywhere
// (consideration #8) — each namespace owns its versions.
//
// Atomicity: each migration's DDL and its ledger-record insert land in ONE
// transaction, so a mid-flight crash or failure rolls BOTH back — no
// half-recorded version. The package lane (runWorkbenchMigrations) instead runs
// its whole lane in a single BEGIN EXCLUSIVE transaction (Sol ruling
// 5175490719) so a failure rolls back every migration of the lane together.
//
// Fresh-reset compatibility (consideration #21): no migration of existing
// _Migration/_WorkbenchMigration rows — a fresh DB starts empty — but checksum
// enforcement is active from the first boot (consideration #14). There is no
// app-version marker dependency (consideration #22): this ledger + the schema
// declarations are the lifecycle record.

import { createHash } from 'node:crypto';
import { begin, commit, rollback, exclusiveTxn,               } from './driver.mjs';
import { foldedMigrationNamespace, migrationIdentityKey } from './migration-identity.mjs';

export const MIGRATION_LEDGER_TABLE = '_SchemaMigration';

// The single reserved, package-owned namespace. Apps must not register here;
// the impersonation check folds case so 'WorkBench' cannot slip through.
export const RESERVED_NAMESPACE = 'workbench';

export const MIGRATION_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
  namespace TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  appliedAt TEXT NOT NULL,
  suppliedBy TEXT,
  PRIMARY KEY (namespace, version)
)`;






















/**
 * A migration attempted SQLite work that cannot participate in the ledger's
 * transaction. A6 maintenance work must use its dedicated maintenance surface
 * instead of being recorded as an atomic migration.
 */
export class NonTransactionalMigrationError extends Error {
           migration                                                   ;
           operation        ;

  constructor(migration           , operation        ) {
    super(`migration ${migration.namespace}@${migration.version} (${migration.name}) requires non-transactional operation: ${operation}`);
    this.name = 'NonTransactionalMigrationError';
    this.migration = Object.freeze({ namespace: migration.namespace, version: migration.version, name: migration.name });
    this.operation = operation;
  }
}

function nonTransactionalOperation(sql        )                {
  const pragmaKeyword = 'PR' + 'AGMA';
  const foreignKeysName = 'foreign_' + 'keys';
  // Match SQLite statements, not words in a string literal or comment. `exec()`
  // may receive a batch, so every statement boundary is significant.
  const statements = sql
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g, '')
    .split(';');
  for (const statement of statements) {
    if (/^\s*VACUUM\b/i.test(statement)) return 'VACUUM';
    if (new RegExp(`^\\s*${pragmaKeyword}\\s+(?:[A-Za-z_][A-Za-z0-9_]*\\.)?${foreignKeysName}\\s*=`, 'i').test(statement)) {
      return `${pragmaKeyword} ${foreignKeysName}`;
    }
  }
  return null;
}

// Do not give transactional migrations the raw handle: SQLite silently ignores
// foreign_keys changes while a transaction is open. Detect the known
// transaction-incompatible operations before they can be falsely ledgered.
function transactionalMigrationDb(db          , migration           )           {
  const guard = (sql        )       => {
    const operation = nonTransactionalOperation(sql);
    if (operation) throw new NonTransactionalMigrationError(migration, operation);
  };
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'exec') {
        return (sql        ) => {
          guard(sql);
          return target.exec(sql);
        };
      }
      if (property === 'prepare') {
        return (sql        ) => {
          guard(sql);
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}












// The ledger state a backup manifests and recovery validates (S1/A3 + S1/A4
// seam, #82/#83): one namespaced lane, not the two legacy tables.






function sha256hex(value        )         {
  return createHash('sha256').update(value).digest('hex');
}

// Dependencies are "namespace@version". The last '@' separates the version so a
// namespace may contain '@' itself; the version must be a positive integer.
const DEPENDENCY_PATTERN = /^(.+)@([1-9]\d*)$/;

export function isReservedNamespace(namespace        )          {
  return foldedMigrationNamespace(namespace) === RESERVED_NAMESPACE;
}

/**
 * Immutable fingerprint of a migration's canonical source: its declared
 * identity plus the literal `up` function source. A migration that declares an
 * explicit `checksum` uses it verbatim (a bundler or transpiler that rewrites
 * function source can pin a stable fingerprint instead).
 */
export function checksumOf(migration           )         {
  if (migration.checksum) return migration.checksum;
  return sha256hex(
    [migration.namespace, migration.name, String(migration.version), migration.up.toString()].join('\u0000'),
  );
}

export function ensureMigrationTable(db          )       {
  db.exec(MIGRATION_DDL);
}

export function ledgerRows(db          )                     {
  ensureMigrationTable(db);
  const rows = db
    .prepare(`SELECT namespace, version, name, checksum, appliedAt, suppliedBy FROM ${MIGRATION_LEDGER_TABLE}`)
    .all()                                  ;
  return rows.map((row) => ({
    namespace: String(row.namespace),
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: String(row.appliedAt),
    suppliedBy: row.suppliedBy == null ? null : String(row.suppliedBy),
  }));
}

/** Per-namespace applied versions, ascending, as a sorted array per namespace. */
export function appliedVersionsByNamespace(db          )                                         {
  const byNamespace = new Map                  ();
  for (const row of ledgerRows(db)) {
    const key = foldedMigrationNamespace(row.namespace);
    const versions = byNamespace.get(key) ?? [];
    versions.push(row.version);
    byNamespace.set(key, versions);
  }
  for (const versions of byNamespace.values()) versions.sort((a, b) => a - b);
  return byNamespace;
}

/**
 * The ledger state that exists in a database (a fresh DB starts empty; the
 * table is never created here — capture must not mutate the snapshot).
 */
export function migrationLedgerStateOf(db          )                       {
  const hasLedger = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATION_LEDGER_TABLE),
  );
  if (!hasLedger) {
    return { table: MIGRATION_LEDGER_TABLE, appliedVersions: [], maxVersion: 0 };
  }
  const rows = db
    .prepare(`SELECT namespace, version FROM ${MIGRATION_LEDGER_TABLE} ORDER BY namespace, version`)
    .all()                                  ;
  const appliedVersions = rows
    .map((row) => ({ namespace: String(row.namespace), version: Number(row.version) }))
    .sort((a, b) => {
      const aNamespace = foldedMigrationNamespace(a.namespace);
      const bNamespace = foldedMigrationNamespace(b.namespace);
      if (aNamespace !== bNamespace) return aNamespace < bNamespace ? -1 : 1;
      return a.version - b.version;
    });
  const maxVersion = appliedVersions.reduce((max, entry) => Math.max(max, entry.version), 0);
  return { table: MIGRATION_LEDGER_TABLE, appliedVersions, maxVersion };
}

/**
 * Declaration-level validation (no DB): reserved-namespace impersonation,
 * positive versions, duplicates within a namespace, dependency syntax, and the
 * per-namespace contiguity policy. Cross-namespace dependencies that name an
 * undeclared namespace are deferred to the runner (they may already be applied).
 */
export function validateMigrations(
  migrations                      ,
  { allowReserved = false }                              = {},
)       {
  const byIdentity = new Map                   ();
  const namesByNamespace = new Map                     ();
  const versionsByNamespace = new Map                  ();
  for (const migration of migrations) {
    if (migration === null || typeof migration !== 'object') {
      throw new Error('migration must be an object');
    }
    if (typeof migration.namespace !== 'string' || migration.namespace.length === 0 || migration.namespace.includes('\0')) {
      throw new Error('migration namespace must be a non-empty string without NUL bytes');
    }
    if (!allowReserved && isReservedNamespace(migration.namespace)) {
      throw new Error(
        `migration "${migration.namespace}@${migration.version}" uses the reserved namespace "${RESERVED_NAMESPACE}" — only the Workbench package may own it`,
      );
    }
    if (typeof migration.name !== 'string' || migration.name.length === 0) {
      throw new Error(`migration in namespace "${migration.namespace}" must declare a name`);
    }
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error(`migration "${migration.namespace}" version must be a positive safe integer`);
    }
    if (typeof migration.up !== 'function') {
      throw new Error(`migration ${migration.namespace}@${migration.version} must declare an up function`);
    }

    const identity = migrationIdentityKey(migration.namespace, migration.version);
    if (byIdentity.has(identity)) {
      throw new Error(`duplicate migration version ${migration.version} in namespace "${migration.namespace}"`);
    }
    byIdentity.set(identity, migration);

    const namespaceKey = foldedMigrationNamespace(migration.namespace);
    const nameKey = foldedMigrationNamespace(migration.name);
    if (!namesByNamespace.has(namespaceKey)) namesByNamespace.set(namespaceKey, new Set());
    if (namesByNamespace.get(namespaceKey) .has(nameKey)) {
      throw new Error(`duplicate migration name "${migration.name}" in namespace "${migration.namespace}"`);
    }
    namesByNamespace.get(namespaceKey) .add(nameKey);

    if (!versionsByNamespace.has(namespaceKey)) versionsByNamespace.set(namespaceKey, []);
    versionsByNamespace.get(namespaceKey) .push(migration.version);

    if (migration.dependencies !== undefined) {
      if (!Array.isArray(migration.dependencies)) {
        throw new Error(`dependencies for migration "${migration.namespace}@${migration.version}" must be an array`);
      }
      const seen = new Set        ();
      for (const dependency of migration.dependencies             ) {
        if (typeof dependency !== 'string' || !DEPENDENCY_PATTERN.test(dependency)) {
          throw new Error(
            `dependency "${String(dependency)}" of migration "${migration.namespace}@${migration.version}" must be "namespace@version"`,
          );
        }
        const depKey = foldedMigrationNamespace(dependency);
        if (seen.has(depKey)) {
          throw new Error(`duplicate dependency "${dependency}" on migration "${migration.namespace}@${migration.version}"`);
        }
        seen.add(depKey);
        const match = DEPENDENCY_PATTERN.exec(dependency) ;
        const depNamespace = match[1];
        const depVersion = Number(match[2]);
        // A dependency on a DECLARED namespace must name a declared version; a
        // dependency on an undeclared namespace may resolve against the applied
        // ledger at run time.
        const declaredInNamespace = migrations.filter((m) => foldedMigrationNamespace(m.namespace) === foldedMigrationNamespace(depNamespace));
        if (declaredInNamespace.length > 0 && !declaredInNamespace.some((m) => m.version === depVersion)) {
          throw new Error(
            `migration "${migration.namespace}@${migration.version}" depends on "${dependency}", which is not a declared version in namespace "${depNamespace}"`,
          );
        }
      }
    }
  }

  // Contiguity policy: a namespace that declares multiple versions must declare
  // every integer between its min and max (consideration #15 — a gap requires a
  // documented reason, and no reason mechanism exists, so a gap is refused).
  for (const [namespaceKey, versions] of versionsByNamespace) {
    if (versions.length < 2) continue;
    const sorted = [...versions].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] !== sorted[index - 1] + 1) {
        throw new Error(
          `migrations in namespace "${namespaceKey}" are not contiguous: gap between versions ${sorted[index - 1]} and ${sorted[index]} (versions must be contiguous per namespace)`,
        );
      }
    }
  }
}

// Topological order: dependencies first, never registration order. Dependencies
// that are already applied impose no ordering constraint. A cycle is refused.
function resolveExecutionOrder(
  migrations                      ,
  appliedByKey                                       ,
)              {
  const migrationByKey = new Map                   ();
  for (const migration of migrations) {
    migrationByKey.set(migrationIdentityKey(migration.namespace, migration.version), migration);
  }

  const unresolvedCount = new Map                ();
  const dependents = new Map                  ();
  for (const migration of migrations) {
    const key = migrationIdentityKey(migration.namespace, migration.version);
    unresolvedCount.set(key, 0);
    dependents.set(key, []);
  }

  for (const migration of migrations) {
    const key = migrationIdentityKey(migration.namespace, migration.version);
    for (const raw of migration.dependencies ?? []) {
      const match = DEPENDENCY_PATTERN.exec(raw) ;
      const depKey = migrationIdentityKey(match[1], Number(match[2]));
      if (depKey === key) {
        throw new Error(`migration "${migration.namespace}@${migration.version}" depends on itself`);
      }
      if (migrationByKey.has(depKey)) {
        dependents.get(depKey) .push(key);
        unresolvedCount.set(key, unresolvedCount.get(key)  + 1);
      } else if (!appliedByKey.has(depKey)) {
        throw new Error(
          `migration "${migration.namespace}@${migration.version}" depends on "${raw}", which is neither declared nor already applied`,
        );
      }
    }
  }

  const ready           = [];
  for (const [key, count] of unresolvedCount) {
    if (count === 0) ready.push(key);
  }

  const byMigration = (a        , b        )         => {
    const ma = migrationByKey.get(a) ;
    const mb = migrationByKey.get(b) ;
    if (foldedMigrationNamespace(ma.namespace) !== foldedMigrationNamespace(mb.namespace)) {
      return foldedMigrationNamespace(ma.namespace) < foldedMigrationNamespace(mb.namespace) ? -1 : 1;
    }
    return ma.version - mb.version;
  };

  const ordered              = [];
  while (ready.length > 0) {
    ready.sort(byMigration);
    const key = ready.shift() ;
    ordered.push(migrationByKey.get(key) );
    for (const dependent of dependents.get(key) ) {
      const remaining = unresolvedCount.get(dependent)  - 1;
      unresolvedCount.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (ordered.length < migrations.length) {
    const blocked = migrations.filter((m) => !ordered.includes(m)).map((m) => `${m.namespace}@${m.version}`);
    throw new Error(`migration dependency cycle detected among: ${blocked.join(', ')}`);
  }
  return ordered;
}








export function runLedgerMigrations(
  db          ,
  migrations                      ,
  options                      = {},
)       {
  validateMigrations(migrations, { allowReserved: options.allowReserved ?? false });
  ensureMigrationTable(db);

  const appliedRows = ledgerRows(db);
  const appliedByKey = new Map                          ();
  for (const row of appliedRows) appliedByKey.set(migrationIdentityKey(row.namespace, row.version), row);

  // A pending lane continues exactly from the applied ledger. Declaration
  // validation catches gaps within this boot; this catches a gap after restart,
  // when old declarations are no longer supplied.
  const pendingByNamespace = new Map                     ();
  const appliedMaxByNamespace = new Map                ();
  for (const row of appliedRows) {
    const namespace = foldedMigrationNamespace(row.namespace);
    appliedMaxByNamespace.set(namespace, Math.max(appliedMaxByNamespace.get(namespace) ?? 0, row.version));
  }
  for (const migration of migrations) {
    if (appliedByKey.has(migrationIdentityKey(migration.namespace, migration.version))) continue;
    const namespace = foldedMigrationNamespace(migration.namespace);
    const pending = pendingByNamespace.get(namespace) ?? [];
    pending.push(migration);
    pendingByNamespace.set(namespace, pending);
  }
  for (const [namespace, pending] of pendingByNamespace) {
    const firstPending = Math.min(...pending.map((migration) => migration.version));
    const maxApplied = appliedMaxByNamespace.get(namespace);
    if (maxApplied !== undefined && firstPending !== maxApplied + 1) {
      throw new Error(
        `migration "${pending[0].namespace}@${firstPending}" leaves a gap after already-applied version ${maxApplied} in namespace "${pending[0].namespace}" — versions must be contiguous per namespace`,
      );
    }
  }

  // Checksum enforcement: an already-applied declared migration whose immutable
  // source changed refuses startup (consideration #14) — before anything runs.
  for (const migration of migrations) {
    const row = appliedByKey.get(migrationIdentityKey(migration.namespace, migration.version));
    if (!row) continue;
    const expected = checksumOf(migration);
    if (row.checksum !== expected) {
      throw new Error(
        `migration "${migration.namespace}@${migration.version}" (${migration.name}) was already applied with a different checksum — its immutable source changed and the ledger refuses to replay it`,
      );
    }
  }

  const ordered = resolveExecutionOrder(migrations, appliedByKey);
  const pending = ordered.filter((m) => !appliedByKey.has(migrationIdentityKey(m.namespace, m.version)));
  if (pending.length === 0) return;

  const now = options.now ?? (() => new Date().toISOString());
  const record = (migration           ) => {
    db.prepare(
      `INSERT INTO ${MIGRATION_LEDGER_TABLE} (namespace, version, name, checksum, appliedAt, suppliedBy) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      migration.namespace,
      migration.version,
      migration.name,
      checksumOf(migration),
      now(),
      migration.suppliedBy ?? options.suppliedBy ?? null,
    );
  };

  if (options.singleTransaction) {
    // One transaction for the entire lane: every migration's work and the
    // ledger records commit or roll back together (Sol ruling 5175490719).
    try {
      exclusiveTxn(db, () => {
        for (const migration of pending) {
          migration.up(transactionalMigrationDb(db, migration));
          record(migration);
        }
      });
    } catch (error) {
      if (error instanceof NonTransactionalMigrationError) options.onNonTransactionalMigration?.(error);
      throw error;
    }
    return;
  }

  for (const migration of pending) {
    begin(db);
    try {
      migration.up(transactionalMigrationDb(db, migration));
      record(migration);
      commit(db);
    } catch (error) {
      try {
        rollback(db);
      } catch {
        /* already rolled back or the transaction is unusable */
      }
      if (error instanceof NonTransactionalMigrationError) {
        options.onNonTransactionalMigration?.(error);
        throw error;
      }
      throw new Error(
        `migration ${migration.namespace}@${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// The public app-facing runner. Refuses the reserved `workbench` namespace and
// applies each pending migration in its own transaction.
export function runMigrations(
  db          ,
  migrations                       = [],
  options                      = {},
)       {
  runLedgerMigrations(db, migrations, { ...options, allowReserved: false });
}
