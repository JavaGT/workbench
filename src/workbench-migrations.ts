// workbench-migrations.mjs — package-owned migration lane, re-homed into the
// reserved `workbench` namespace of the shared namespaced ledger (S2/A4,
// workbench#90).
//
// Sol ruling (issue JavaGT/scope#184, comment 5175490719): the authoring
// checkpoint deduplication must be performed by a versioned, idempotent
// migration owned by the Workbench package and run automatically from
// app.prepareSchema. The application-supplied migration lane is NOT reused:
// Scope passes an empty list, and the `workbench` namespace is package-owned
// (reserved), so no app migration can impersonate this lane. The whole lane
// runs inside ONE BEGIN EXCLUSIVE transaction — a failure rolls every
// migration of the lane back together (no partial lane state), matching the
// Sol ruling. Each `up` remains safe to re-apply against a rolled-back state
// and to run against an already-canonical schema (fresh DBs emit the canonical
// shape, so v1/v4 skip; v2/v3/v5 detect and skip or no-op).

import {
  runLedgerMigrations,
  ensureMigrationTable,
  ledgerRows,
  type Migration,
  type MigrationRunOptions,
} from './migration-ledger.ts';
import type { DbHandle } from './driver.ts';
import { actionReceiptHistoryIndexDDL } from './committed-log.ts';
import { restoreTextFamily, serializeCompactTextFamilyCheckpoint } from './annotated-text-continuous.ts';

// The package version that supplies the lane, recorded per ledger row. Keep in
// sync with package.json when releasing.
const WORKBENCH_PACKAGE_VERSION = '0.1.3';
export const WORKBENCH_SUPPLIED_BY = `workbench@${WORKBENCH_PACKAGE_VERSION}`;

const PREFIX_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tableExists(db: DbHandle, name: string) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(name));
}

function rebuildAuthoringFamily(db: DbHandle, prefix: string) {
  if (PREFIX_IDENTIFIER.test(prefix) === false) {
    throw new Error(`invalid authoring stream table prefix: ${prefix}`);
  }
  if (!tableExists(db, `${prefix}_authoring_stream`) || !tableExists(db, `${prefix}_authoring_lease`)) {
    throw new Error(`incomplete authoring stream table family: ${prefix}`);
  }
  // A canonical family (already the post-dedup shape) must be skipped, not
  // rebuilt: the migration is a legacy-shape upgrader and a fresh DB's data
  // must survive v1 untouched.
  const positionColumns = new Set(
    db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name as string)
  );
  const hasCanonicalPosition = positionColumns.has('checkpoint_id') && !positionColumns.has('family_checkpoint');
  if (hasCanonicalPosition) return;
  // Fail-closed validation: a legacy family must be complete before any clear
  // or rebuild. A partial/unrecognized family is refused and rolls back, rather
  // than being silently reconstructed. The checkpoint table is NOT required for
  // the legacy shape — the whole point of this migration is to create it.
  const required = ['snapshot_position', 'split', 'snapshot', 'group', 'position'];
  const missing = required.filter((table) => !tableExists(db, `${prefix}_authoring_${table}`));
  if (missing.length > 0) {
    throw new Error(`incomplete authoring stream table family: ${prefix} missing ${missing.join(', ')}`);
  }
  // Dependent ephemeral rows first. The lease owns every authoring row; the
  // snapshot/split/group/position rows reference leases, positions, snapshots
  // and checkpoints — clear in dependency-safe order, then rebuild.
  for (const table of ['snapshot_position', 'split', 'snapshot', 'group', 'position', 'checkpoint']) {
    if (tableExists(db, `${prefix}_authoring_${table}`)) {
      db.exec(`DELETE FROM ${prefix}_authoring_${table}`);
    }
  }
  // Drop child tables referencing position/snapshot before the parents.
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_snapshot_position`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_split`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_snapshot`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_group`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_position`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_checkpoint`);
  // Recreate the canonical shape: checkpoint holds the payload once, position
  // references it. The lease table is preserved so clients re-bootstrap.
  db.exec(
    `CREATE TABLE ${prefix}_authoring_checkpoint (
       id TEXT PRIMARY KEY,
       lease_id TEXT NOT NULL,
       family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)),
       created_at TEXT NOT NULL,
       FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE
     );
     CREATE TABLE ${prefix}_authoring_position (
       token TEXT PRIMARY KEY,
       lease_id TEXT NOT NULL,
       issued_fence INTEGER NOT NULL,
       checkpoint_id TEXT NOT NULL,
       visible_at_issue INTEGER NOT NULL DEFAULT 1,
       redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions)),
       created_at TEXT NOT NULL,
       FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE,
       FOREIGN KEY (checkpoint_id) REFERENCES ${prefix}_authoring_checkpoint(id) ON DELETE RESTRICT
     );
     CREATE INDEX idx_${prefix}_authoring_position_lease ON ${prefix}_authoring_position (lease_id, issued_fence);
     CREATE TABLE ${prefix}_authoring_snapshot (
       id TEXT PRIMARY KEY,
       lease_id TEXT NOT NULL,
       fence INTEGER NOT NULL,
       issued_at TEXT NOT NULL,
       acknowledged_at TEXT,
       FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE
     );
     CREATE INDEX idx_${prefix}_authoring_snapshot_lease ON ${prefix}_authoring_snapshot (lease_id, fence);
     CREATE TABLE ${prefix}_authoring_snapshot_position (
       snapshot_id TEXT NOT NULL,
       position_token TEXT NOT NULL,
       PRIMARY KEY (snapshot_id, position_token),
       FOREIGN KEY (snapshot_id) REFERENCES ${prefix}_authoring_snapshot(id) ON DELETE CASCADE,
       FOREIGN KEY (position_token) REFERENCES ${prefix}_authoring_position(token) ON DELETE CASCADE
     );
     CREATE INDEX idx_${prefix}_authoring_snapshot_position_token ON ${prefix}_authoring_snapshot_position (position_token, snapshot_id);`
  );
}

// v4: annotated-text `_membership` tables move from annotation_id PRIMARY KEY
// (one row per annotation) to PRIMARY KEY (annotation_id, start_point) so an
// exclusive 'one'-cardinality apply can store a trimmed annotation's left and
// right remnants as separate rows. A canonical family is skipped untouched;
// a legacy shape is rebuilt and its rows copied over (each annotation has one
// row today, so the composite key introduces no duplicate collision).
function rebuildMembershipFamily(db: DbHandle, prefix: string) {
  if (PREFIX_IDENTIFIER.test(prefix) === false) {
    throw new Error(`invalid annotated-text membership table prefix: ${prefix}`);
  }
  if (!tableExists(db, `${prefix}_membership`) || !tableExists(db, `${prefix}_annotation`)) {
    throw new Error(`incomplete annotated-text table family: ${prefix}`);
  }
  const columns = db.prepare(`PRAGMA table_info(${prefix}_membership)`).all().map((r) => ({ name: r.name as string, pk: r.pk as number }));
  const pkColumns = columns.filter((c) => c.pk > 0).map((c) => c.name);
  if (columns.some((column) => column.name === 'range_id') && columns.some((column) => column.name === 'ordinal')) return;
  const hasCanonicalShape = pkColumns.length === 2 && pkColumns.includes('annotation_id') && pkColumns.includes('start_point');
  if (hasCanonicalShape) return;
  if (pkColumns.length !== 1 || pkColumns[0] !== 'annotation_id') {
    throw new Error(`unrecognized annotated-text membership table shape: ${prefix}`);
  }
  const tmp = `${prefix}_membership_v4`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(`CREATE TABLE ${tmp} (
    annotation_id TEXT NOT NULL,
    start_point TEXT NOT NULL CHECK (json_valid(start_point)),
    end_point TEXT NOT NULL CHECK (json_valid(end_point)),
    PRIMARY KEY (annotation_id, start_point),
    FOREIGN KEY (annotation_id) REFERENCES ${prefix}_annotation(id) ON DELETE CASCADE
  )`);
  db.exec(`INSERT INTO ${tmp} (annotation_id, start_point, end_point) SELECT annotation_id, start_point, end_point FROM ${prefix}_membership`);
  db.exec(`DROP TABLE ${prefix}_membership`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${prefix}_membership`);
}

// v6 repairs databases that successfully ran v4 after annotated-text's
// membership schema had already moved on. v4's intermediate rows retain the
// endpoints but have no document/range identity, so rebuild them through the
// canonical range table and assign stable ordinals from their legacy rowid.
function repairIntermediateMembershipFamily(db: DbHandle, prefix: string) {
  if (!PREFIX_IDENTIFIER.test(prefix)) throw new Error(`invalid annotated-text membership table prefix: ${prefix}`);
  const membership = `${prefix}_membership`;
  const annotation = `${prefix}_annotation`;
  if (!tableExists(db, membership) || !tableExists(db, annotation)) return;
  const columns = new Set(db.prepare(`PRAGMA table_info(${membership})`).all().map((row) => row.name as string));
  const hasCanonicalColumns = ['range_id', 'document_id', 'ordinal'].every((column) => columns.has(column));
  if (hasCanonicalColumns && !columns.has('start_point') && !columns.has('end_point')) return;
  if (!columns.has('start_point') || !columns.has('end_point')) return;
  // A mixed table is repaired from its endpoint columns. The range/document/
  // ordinal columns may be stale or partial, so endpoints are the only
  // deterministic source of truth; orphan rows are intentionally dropped by
  // the annotation join below rather than creating unverifiable relationships.

  const documentForeignKey = db.prepare(`PRAGMA foreign_key_list(${annotation})`).all()
    .find((row) => row.from === 'document_id') as { table?: string } | undefined;
  const documentTable = documentForeignKey?.table;
  if (!documentTable || !PREFIX_IDENTIFIER.test(documentTable)) {
    throw new Error(`annotated-text annotation document foreign key unavailable: ${prefix}`);
  }
  const range = `${prefix}_range`;
  if (!tableExists(db, range)) {
    db.exec(`CREATE TABLE ${range} (
      id INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL,
      start_point TEXT NOT NULL CHECK (json_valid(start_point)),
      end_point TEXT NOT NULL CHECK (json_valid(end_point)),
      UNIQUE (document_id, start_point, end_point),
      UNIQUE (id, document_id),
      FOREIGN KEY (document_id) REFERENCES ${documentTable}(id) ON DELETE CASCADE
    )`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_annotation_document ON ${annotation} (id, document_id)`);
  db.exec(`INSERT OR IGNORE INTO ${range} (document_id, start_point, end_point)
    SELECT annotation.document_id, membership.start_point, membership.end_point
    FROM ${membership} AS membership
    JOIN ${annotation} AS annotation ON annotation.id = membership.annotation_id`);

  const tmp = `${membership}_v6`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(`CREATE TABLE ${tmp} (
    annotation_id TEXT NOT NULL,
    range_id INTEGER NOT NULL,
    document_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (annotation_id, range_id),
    UNIQUE (annotation_id, ordinal),
    FOREIGN KEY (annotation_id, document_id) REFERENCES ${annotation}(id, document_id) ON DELETE CASCADE,
    FOREIGN KEY (range_id, document_id) REFERENCES ${range}(id, document_id) ON DELETE CASCADE
  )`);
  db.exec(`INSERT INTO ${tmp} (annotation_id, range_id, document_id, ordinal)
    SELECT membership.annotation_id, range.id, annotation.document_id,
      ROW_NUMBER() OVER (PARTITION BY membership.annotation_id ORDER BY membership.rowid) - 1
    FROM ${membership} AS membership
    JOIN ${annotation} AS annotation ON annotation.id = membership.annotation_id
    JOIN ${range} AS range ON range.document_id = annotation.document_id
      AND range.start_point = membership.start_point
      AND range.end_point = membership.end_point`);
  db.exec(`DROP TABLE ${membership}; ALTER TABLE ${tmp} RENAME TO ${membership}`);
}

function addMissingColumns(db: DbHandle, table: string, columns: ReadonlyArray<readonly [string, string]>): void {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name as string));
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function ensureBlobStoreColumns(db: DbHandle): void {
  if (!tableExists(db, 'BlobStore')) return;
  addMissingColumns(db, 'BlobStore', [
    ['replacedBy', 'TEXT'],
    ['replacedAt', 'TEXT'],
    ['cleanupError', 'TEXT'],
    ['cleanupAttempts', 'INTEGER NOT NULL DEFAULT 0'],
  ]);
}

function ensurePendingBlobColumns(db: DbHandle): void {
  if (!tableExists(db, '_PendingBlob')) return;
  addMissingColumns(db, '_PendingBlob', [
    ['resourceId', 'TEXT'],
    ['claimedAt', 'TEXT'],
    ['finalizedAt', 'TEXT'],
    ['deletedAt', 'TEXT'],
    ['deleteActionId', 'TEXT'],
    ['recoveryFailure', 'TEXT'],
  ]);
  const legacyRows = db.prepare('SELECT pendingKey, scopeId FROM _PendingBlob WHERE resourceId IS NULL').all();
  for (const row of legacyRows) {
    const prefix = `${row.scopeId}/`;
    const suffixLength = 1 + 64 + '.pending'.length;
    const pendingKey = row.pendingKey as string;
    if (typeof row.scopeId !== 'string' || !pendingKey.startsWith(prefix) || pendingKey.length <= prefix.length + suffixLength) {
      throw new Error(`cannot recover pending blob resource identity for '${row.pendingKey}'`);
    }
    const resourceId = pendingKey.slice(prefix.length, -suffixLength);
    db.prepare('UPDATE _PendingBlob SET resourceId = ? WHERE pendingKey = ? AND resourceId IS NULL').run(resourceId, pendingKey);
  }
}

function ensureActionReceiptColumns(db: DbHandle): void {
  if (!tableExists(db, '_ActionReceipt')) return;
  addMissingColumns(db, '_ActionReceipt', [
    ['historyOrder', 'INTEGER'],
    ['actionType', 'TEXT'],
    ['actionData', 'TEXT'],
    ['principalKey', 'TEXT'],
    ['sessionId', 'TEXT'],
    ['operation', "TEXT NOT NULL DEFAULT 'action'"],
    ['resultData', 'TEXT'],
    ['historyRootActionId', 'TEXT'],
    ['historyTargetActionId', 'TEXT'],
    ['historyOutcome', 'TEXT'],
  ]);
  db.exec(`UPDATE _ActionReceipt SET historyOrder = (
    SELECT COUNT(*) FROM _ActionReceipt AS earlier
    WHERE earlier.scope = _ActionReceipt.scope
      AND (earlier.committedAt < _ActionReceipt.committedAt
        OR (earlier.committedAt = _ActionReceipt.committedAt AND earlier.actionId <= _ActionReceipt.actionId))
  ) WHERE historyOrder IS NULL`);
  db.exec(actionReceiptHistoryIndexDDL());
}

function ensureJobColumns(db: DbHandle): void {
  if (!tableExists(db, '_Job')) return;
  addMissingColumns(db, '_Job', [
    ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['availableAt', 'INTEGER'],
    ['progress', 'INTEGER NOT NULL DEFAULT 0'],
    ['stage', 'TEXT'],
    ['scope', 'TEXT'],
    ['principalKey', 'TEXT'],
    ['operations', 'TEXT'],
  ]);
}

function ensureAuthEntityColumns(db: DbHandle): void {
  if (tableExists(db, 'User')) {
    addMissingColumns(db, 'User', [
      ['failedLoginAttempts', 'INTEGER DEFAULT 0'],
      ['lockedUntil', 'INTEGER'],
    ]);
  }
  if (tableExists(db, 'TwoFactor')) {
    addMissingColumns(db, 'TwoFactor', [
      ['totpFailedAttempts', 'INTEGER DEFAULT 0'],
      ['totpLockedUntil', 'INTEGER'],
    ]);
  }
}

export const WORKBENCH_MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    namespace: 'workbench',
    name: 'authoring-stream-family-rebuild',
    version: 1,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_position'").all()) {
        const name = row.name as string;
        if (!name.endsWith('_authoring_position')) continue;
        const prefix = name.slice(0, -'_authoring_position'.length);
        rebuildAuthoringFamily(db, prefix);
      }
    },
  },
  {
    // v2: purge authoring state produced by the defective pre-issue defect
    // (checkpointId footgun). A split-created right-block frame could inherit
    // the source position's checkpoint while carrying the post-split family,
    // leaving positions that resolve to the wrong family checkpoint and leases
    // whose retained bytes undercount checkpoint row metadata. Durable document
    // state and the committed log are untouched: clients re-bootstrap recovery
    // authoritative tokens for the same document, exactly as v1 does after its
    // legacy rebuild.
    namespace: 'workbench',
    name: 'authoring-defective-checkpoint-purge',
    version: 2,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_lease'").all()) {
        const name = row.name as string;
        if (!name.endsWith('_authoring_lease')) continue;
        const prefix = name.slice(0, -'_authoring_lease'.length);
        if (PREFIX_IDENTIFIER.test(prefix) === false) {
          throw new Error(`invalid authoring stream table prefix: ${prefix}`);
        }
        const required = ['stream', 'snapshot_position', 'snapshot', 'position', 'checkpoint'];
        const missing = required.filter((table) => !tableExists(db, `${prefix}_authoring_${table}`));
        if (missing.length > 0) {
          throw new Error(`incomplete authoring stream table family: ${prefix} missing ${missing.join(', ')}`);
        }
        // Invalidate the whole ephemeral family once, child-first. Removing
        // streams cascades leases after every lease-owned row is already gone.
        for (const table of ['snapshot_position', 'snapshot', 'position', 'checkpoint']) {
          db.exec(`DELETE FROM ${prefix}_authoring_${table}`);
        }
        db.exec(`DELETE FROM ${prefix}_authoring_stream`);
      }
    },
  },
  {
    // v3: bind redaction-aware public offsets to their canonical intervals.
    namespace: 'workbench',
    name: 'authoring-redaction-column',
    version: 3,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_position'").all()) {
        const name = row.name as string;
        const columns = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name as string));
        if (!columns.has('redactions')) db.exec(`ALTER TABLE ${row.name} ADD COLUMN redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions))`);
      }
    },
  },
  {
    // v4: rebuild annotated-text `_membership` tables from the legacy one-row-per-
    // annotation shape (annotation_id PRIMARY KEY) to a composite
    // (annotation_id, start_point) primary key so an exclusive 'one'-cardinality
    // apply can persist a trimmed annotation's left AND right remnants as
    // multiple rows. The DDL emits the canonical shape for fresh databases; this
    // migration only reshapes legacy tables and copies their existing rows
    // (one per annotation today) over unchanged.
    namespace: 'workbench',
    name: 'membership-composite-primary-key',
    version: 4,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_membership'").all()) {
        const name = row.name as string;
        if (!name.endsWith('_membership')) continue;
        rebuildMembershipFamily(db, name.slice(0, -'_membership'.length));
      }
    },
  },
  {
    // v5: position frames only need a compact immutable frontier basis; the
    // previous ephemeral rows retained a complete CRDT checkpoint per edit.
    // Purge those frames so connected clients re-bootstrap, then compact each
    // durable continuous-text checkpoint to the operation-registry v2 form.
    // Historical committed events are intentionally untouched.
    namespace: 'workbench',
    name: 'authoring-compact-checkpoints',
    version: 5,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_lease'").all()) {
        const name = row.name as string;
        const prefix = name.slice(0, -'_authoring_lease'.length);
        if (!PREFIX_IDENTIFIER.test(prefix)) throw new Error(`invalid authoring stream table prefix: ${prefix}`);
        for (const table of ['snapshot_position', 'snapshot', 'position', 'checkpoint']) {
          if (tableExists(db, `${prefix}_authoring_${table}`)) db.exec(`DELETE FROM ${prefix}_authoring_${table}`);
        }
        if (tableExists(db, `${prefix}_authoring_stream`)) db.exec(`DELETE FROM ${prefix}_authoring_stream`);

        const stateTable = `${prefix}_state`;
        if (!tableExists(db, stateTable)) continue;
        const select = db.prepare(`SELECT document_id, family_checkpoint FROM ${stateTable}`);
        const update = db.prepare(`UPDATE ${stateTable} SET family_checkpoint = ? WHERE document_id = ?`);
        for (const state of select.all()) {
          const raw = JSON.parse(state.family_checkpoint as string);
          // Legacy block families contain a `blocks` member and are owned by
          // their older migration lane; only blockless continuous families are
          // compacted here.
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.hasOwn(raw, 'blocks')) continue;
          update.run(serializeCompactTextFamilyCheckpoint(restoreTextFamily(raw)), state.document_id);
        }
      }
    },
  },
  {
    // v6: repair the intermediate v4 membership shape produced before the
    // canonical range/document/ordinal schema landed. v4 is immutable because
    // applied migration checksums are part of the ledger contract.
    namespace: 'workbench',
    name: 'membership-range-schema-repair',
    version: 6,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_membership'").all()) {
        const name = row.name as string;
        if (name.endsWith('_membership')) repairIntermediateMembershipFamily(db, name.slice(0, -'_membership'.length));
      }
    },
  },
  {
    // v7: move the legacy additive column upgrades formerly run ad-hoc on every
    // boot inside executeFrameworkDDL into the versioned, transactional
    // package migration lane. Fresh databases already include every column in
    // CREATE TABLE IF NOT EXISTS, so v7 is an idempotent no-op on fresh DBs and
    // an atomic one-time upgrade on legacy DBs.
    namespace: 'workbench',
    name: 'framework-legacy-column-upgrades',
    version: 7,
    up(db) {
      ensureJobColumns(db);
      ensureActionReceiptColumns(db);
      ensureAuthEntityColumns(db);
      ensurePendingBlobColumns(db);
      ensureBlobStoreColumns(db);
    },
  },
]);

// The reserved `workbench` lane is internal-only via internal.ts.
// `ensureWorkbenchMigrationTable` now ensures the shared namespaced ledger
// table; `appliedWorkbenchVersion` reads the `workbench` namespace of it.

export function ensureWorkbenchMigrationTable(db: DbHandle): void {
  // Alias of the shared namespaced-ledger ensure: the workbench lane lives in
  // the same `_SchemaMigration` table as every other namespace.
  ensureMigrationTable(db);
}

export function appliedWorkbenchVersion(db: DbHandle): number {
  return ledgerRows(db)
    .filter((row) => row.namespace.toLowerCase() === 'workbench')
    .reduce((max, row) => Math.max(max, row.version), 0);
}

export function runWorkbenchMigrations(db: DbHandle, options: MigrationRunOptions = {}) {
  // The runner handles the read-only "nothing pending" fast path itself: it
  // validates checksums and resolves order before opening the exclusive
  // transaction, so an already-applied lane that has not been mutated skips
  // BEGIN EXCLUSIVE entirely. The whole lane is one transaction when it does
  // run (Sol ruling 5175490719).
  runLedgerMigrations(db, WORKBENCH_MIGRATIONS, {
    ...options,
    suppliedBy: options.suppliedBy ?? WORKBENCH_SUPPLIED_BY,
    singleTransaction: true,
    allowReserved: true,
  });
}
