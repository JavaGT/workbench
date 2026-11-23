// ddl.mjs — generate CREATE TABLE statements for compiled entities.
//
// The framework generates NO DDL by default (the app owns its schema). This
// module provides `generateDDL(entity)` which returns an ordered array of SQL
// strings: the main entity table first, then each side-table (map membership,
// log entries, ephemeral cells). The returned SQL is standalone — it may be executed
// against a node:sqlite DatabaseSync handle, or printed and committed to a
// migration file.
//
// Column type mappings (SQLite):
//   text / ref / crdt / hash / json → TEXT
//   date / boolean                  → INTEGER
//   number                          → REAL
//   struct (link)                       → one column per struct cell
//   id                                  → TEXT PRIMARY KEY (caller-owned UUID)
//
// Side-table naming (from scope-sql.mjs):
//   map          → {Entity}_{field} ({Entity}_id, member_id [, role])
//   log          → {Entity}_{field} ({Entity}_id, ...entry sub-fields)
//   ephemeral   → {Entity}_{field} ({Entity}_id, client_id)
import type { DbHandle } from './driver.ts';
import { structCellColumn } from './field-strategy.ts';
import { sideTableDDL } from './side-table-strategy.ts';
import { frameworkLogDDL, actionReceiptHistoryIndexDDL } from './committed-log.ts';
import { defineSqliteSchema } from './sqlite-schema.ts';
import { deletedRowAnchorTableDDL } from './deleted-row-anchor.ts';
import { annotatedTextDDL, annotatedTextAuthoringStreamDDL } from './annotated-text-field.ts';

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function assertIdentifier(name: string, label: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new Error(`${label} must be a non-empty SQL identifier without NUL bytes`);
  }
}

const SUPPORTED_FIELD_TYPES: Record<string, ReadonlySet<string>> = Object.freeze({
  value: new Set(['text', 'boolean', 'date', 'number', 'json', 'vector', 'ref']),
  crdt: new Set(['text', 'raster', 'polyline']),
  hash: new Set(['hash']),
  store: new Set(['map', 'log']),
  ordered: new Set(['list']),
  ephemeral: new Set(['ephemeral']),
  state: new Set(['state']),
  struct: new Set(['link']),
  annotatedText: new Set(['annotatedText']),
});

// A field descriptor as the DDL generator reads it: kind, value type, and the
// option surface that decides storage shape. Kept loose — the descriptor is
// built by field.mjs and consumed by many layers.
interface FieldDescriptorLike {
  kind: string;
  type?: string;
  mode?: string;
  physical?: boolean;
  nullable?: boolean;
  optional?: boolean;
  target?: { name?: string } | string;
  cells?: Record<string, unknown>;
  onRemove?: string;
  indexed?: string;
  [key: string]: unknown;
}

interface ScheduleTriggerLike {
  kind?: string;
  fieldName?: string;
  triggerId?: string;
  whileAst?: unknown;
  [key: string]: unknown;
}

interface DdlEntity {
  name: string;
  // Loose: the DDL layer reads the compiled entity's field map, but typed
  // callers legitimately carry a looser record (e.g. describeEntityStorage).
  fields?: unknown;
  schedule?: Record<string, unknown>;
  indexes?: ReadonlyArray<{ fields: readonly string[]; unique: boolean }>;
}

function fieldsOf(entity: DdlEntity): Readonly<Record<string, FieldDescriptorLike>> | undefined {
  return entity.fields as Readonly<Record<string, FieldDescriptorLike>> | undefined;
}

// Map a field's kind+type to its SQLite column type.
function unknownField(entityName: string, fieldName: string, message: string): never {
  throw new Error(`${message} at ${entityName}.${fieldName}`);
}

function assertSupportedField(entityName: string, fieldName: string, descriptor: FieldDescriptorLike): void {
  if (descriptor === null || typeof descriptor !== 'object') {
    unknownField(entityName, fieldName, 'invalid field descriptor');
  }
  if (descriptor.kind === 'computed') {
    if (descriptor.mode !== 'pull' && descriptor.mode !== 'stored') {
      unknownField(entityName, fieldName, `unknown computed field mode '${String(descriptor.mode)}'`);
    }
    return;
  }
  if (descriptor.kind === 'projected') {
    if (descriptor.mode !== 'async') {
      unknownField(entityName, fieldName, `unknown projected field mode '${String(descriptor.mode)}'`);
    }
    return;
  }
  const supportedTypes = SUPPORTED_FIELD_TYPES[descriptor.kind];
  if (supportedTypes === undefined) {
    unknownField(entityName, fieldName, `unknown field kind '${String(descriptor.kind)}'`);
  }
  if (descriptor.type === undefined || !supportedTypes.has(descriptor.type)) {
    unknownField(
      entityName,
      fieldName,
      `unknown ${descriptor.kind} field type '${String(descriptor.type)}'`,
    );
  }
}

function sqlType(descriptor: FieldDescriptorLike): string {
  const { kind, type } = descriptor;
  if (kind === 'value' || kind === 'store' || kind === 'crdt' || kind === 'hash') {
    switch (type) {
      case 'boolean': return 'INTEGER';
      case 'date': return 'INTEGER';
      case 'number': return 'REAL';
      default: return 'TEXT';
    }
  }
  if (kind === 'struct') return 'TEXT'; // each struct cell is a TEXT column
  return 'TEXT'; // fallback (state, ephemeral, etc.)
}

function isMainTableField(descriptor: FieldDescriptorLike | null | undefined): boolean {
  return descriptor?.kind === 'value'
    || descriptor?.kind === 'crdt'
    || descriptor?.kind === 'hash'
    || descriptor?.kind === 'state'
    || descriptor?.kind === 'projected'
    || (descriptor?.kind === 'computed' && descriptor.mode === 'stored');
}

function collectAstFields(ast: unknown, result: Set<string>, seen = new Set<object>()): void {
  if (ast === null || typeof ast !== 'object' || seen.has(ast)) return;
  seen.add(ast);
  const record = ast as Record<string, unknown>;
  if (typeof record.field === 'string') result.add(record.field);
  for (const value of Object.values(record)) {
    if (typeof value === 'function') continue;
    if (Array.isArray(value)) {
      for (const entry of value) collectAstFields(entry, result, seen);
    } else {
      collectAstFields(value, result, seen);
    }
  }
}

function scheduleIndexNames(entity: DdlEntity): Array<{ name: string; fieldName: string }> {
  const fields = new Set<string>();
  for (const triggerOrTriggers of Object.values(entity.schedule ?? {})) {
    const triggers = (Array.isArray(triggerOrTriggers) ? triggerOrTriggers : [triggerOrTriggers]) as Array<ScheduleTriggerLike | null | undefined>;
    for (const trigger of triggers) {
      if (trigger?.kind === 'schedule.at' || trigger?.kind === 'schedule.after') {
        if (trigger.fieldName) fields.add(trigger.fieldName);
      }
      collectAstFields(trigger?.whileAst, fields);
    }
  }
  return [...fields]
    .filter((fieldName) => isMainTableField(fieldsOf(entity)?.[fieldName]))
    .sort()
    .map((fieldName) => ({ name: `idx_${entity.name}_schedule_${fieldName}`, fieldName }));
}

function scheduleIndexDDL(entity: DdlEntity): string[] {
  return scheduleIndexNames(entity).map(({ name, fieldName }) => (
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ` +
    `ON ${quoteIdent(entity.name)} (${quoteIdent(fieldName)});`
  ));
}

function refIndexes(entity: DdlEntity): Array<{ name: string; fieldName: string }> {
  return Object.entries(fieldsOf(entity) ?? {})
    .filter(([, descriptor]) => physicalRef(entity, descriptor))
    .map(([fieldName]) => ({ name: `idx_${entity.name}_${fieldName}`, fieldName }));
}

function physicalRef(entity: DdlEntity, descriptor: FieldDescriptorLike | null | undefined): boolean {
  const target = descriptor?.target;
  const name = typeof target === 'string' ? undefined : target?.name;
  return descriptor?.physical === true
    && descriptor?.kind === 'value'
    && descriptor.type === 'ref'
    && Boolean(name || target === entity.name);
}

function declaredIndexes(entity: DdlEntity, unique: boolean): Array<{ name: string; fields: readonly string[] }> {
  return (entity.indexes ?? []).filter((index) => index.unique === unique).map(({ fields }) => ({
    name: `idx_${entity.name}_unique_${fields.join('_')}`,
    fields,
  }));
}

function uniqueIndexes(entity: DdlEntity): Array<{ name: string; fields: readonly string[] }> {
  return declaredIndexes(entity, true);
}

function nonUniqueIndexes(entity: DdlEntity): Array<{ name: string; fields: readonly string[] }> {
  return declaredIndexes(entity, false).map(({ fields }) => ({
    name: `idx_${entity.name}_${fields.join('_')}`,
    fields,
  }));
}

export function generatedIndexNames(entity: DdlEntity): string[] {
  return [...refIndexes(entity), ...scheduleIndexNames(entity), ...uniqueIndexes(entity), ...nonUniqueIndexes(entity)].map(({ name }) => name);
}

// Generate the main table DDL for one entity.
function mainTableDDL(entity: DdlEntity): string {
  const cols: string[] = ['id TEXT PRIMARY KEY'];
  const fields = fieldsOf(entity);
  // Unreachable through generateDDL (which returns early for a field-less
  // entity); preserved verbatim for the historical internal contract.
  if (!fields) return cols as unknown as string;

  for (const [name, descriptor] of Object.entries(fields)) {
    // Pull computed fields have no stored column (computed on read).
    if (descriptor.kind === 'computed' && descriptor.mode === 'pull') continue;
    // Fields that are stored in the main table (value, crdt, hash, struct).
    // A text CRDT's declared cell is its canonical JSON checkpoint, not a
    // materialized string plus a hidden second authority.
    if (descriptor.kind === 'value' || descriptor.kind === 'crdt' || descriptor.kind === 'hash' || descriptor.kind === 'state' || descriptor.kind === 'projected' || (descriptor.kind === 'computed' && descriptor.mode === 'stored')) {
      let column = `${quoteIdent(name)} ${sqlType(descriptor)}`;
      if (physicalRef(entity, descriptor) && !(descriptor.nullable || descriptor.optional)) column += ' NOT NULL';
      cols.push(column);
    } else if (descriptor.kind === 'struct') {
      // struct fields (link) flatten to multiple columns
      for (const cellName of Object.keys(descriptor.cells ?? {})) {
        const cell = structCellColumn(name, cellName);
        cols.push(`${quoteIdent(cell)} TEXT`);
      }
    }
    // map / log / ephemeral / store → NOT stored in main table
  }
  for (const [name, descriptor] of Object.entries(fields)) {
    if (!physicalRef(entity, descriptor)) continue;
    const targetValue = descriptor.target;
    const target = (typeof targetValue === 'string' ? undefined : targetValue?.name) ?? (targetValue === entity.name ? entity.name : null);
    if (!target) continue;
    assertIdentifier(target, `${entity.name}.${name} ref target`);
    // Eventful cascades emit child removals before the parent removal, but their
    // projections share one transaction. Defer NO ACTION to that transaction's
    // end so direct SQL cannot bypass lifecycle events while the event stream can.
    const removal = descriptor.onRemove === 'cascade'
      ? ' ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED'
      : ' ON DELETE RESTRICT ON UPDATE NO ACTION';
    cols.push(`FOREIGN KEY (${quoteIdent(name)}) REFERENCES ${quoteIdent(target)} (${quoteIdent('id')})${removal}`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(entity.name)} (\n  ${cols.join(',\n  ')}\n);`;
}

// Generate a complete, ordered sequence of CREATE TABLE statements for one
// compiled entity: the main table, then each side-table.
export function generateDDL(entity: DdlEntity): string[] {
  const statements: string[] = [];
  const fields = fieldsOf(entity);
  if (!fields) return statements;
  assertIdentifier(entity.name, 'entity name');

  for (const [name, descriptor] of Object.entries(fields)) {
    assertIdentifier(name, `${entity.name} field name`);
    assertSupportedField(entity.name, name, descriptor);
  }
  statements.push(mainTableDDL(entity));
  statements.push(...generateSideTableDDL(entity));

  // Preserve the documented main-table/side-table ordering. Indexes are
  // independent trailing statements, which also keeps generated migrations
  // stable for callers that inspect the table statements by position.
  statements.push(...scheduleIndexDDL(entity));
  for (const { name, fieldName } of refIndexes(entity)) {
    statements.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(entity.name)} (${quoteIdent(fieldName)});`);
  }
  for (const { name, fields: indexFields } of uniqueIndexes(entity)) {
    statements.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(entity.name)} (${indexFields.map(quoteIdent).join(', ')});`);
  }
  for (const { name, fields: indexFields } of nonUniqueIndexes(entity)) {
    statements.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(entity.name)} (${indexFields.map(quoteIdent).join(', ')});`);
  }

  return statements;
}

// Supporting tables are independent physical storage. A caller that owns the
// entity's main table may still let Workbench own these tables, but never its
// main-table indexes (those belong to the declaring schema too).
export function generateSideTableDDL(entity: DdlEntity): string[] {
  const statements: string[] = [];
  const fields = fieldsOf(entity);
  if (!fields) return statements;

  for (const [name, descriptor] of Object.entries(fields)) {
    if (descriptor.kind === 'store') {
      if (descriptor.type === 'map' || descriptor.type === 'log') {
        const storeDDL = sideTableDDL(entity, name, descriptor);
        if (storeDDL) statements.push(storeDDL);
      }
    } else if (descriptor.kind === 'ephemeral') {
      const ephemeralDDL = sideTableDDL(entity, name, descriptor);
      if (ephemeralDDL) statements.push(ephemeralDDL);
    } else if (descriptor.kind === 'ordered') {
      const orderedDDL = sideTableDDL(entity, name, descriptor);
      if (orderedDDL) statements.push(orderedDDL);
    } else if (descriptor.indexed === 'fts') {
      const ftsDDL = sideTableDDL(entity, name, descriptor);
      if (ftsDDL) statements.push(ftsDDL);
    } else if (descriptor.kind === 'annotatedText') {
      statements.push(...annotatedTextDDL(entity.name, name, descriptor, fields));
      statements.push(...annotatedTextAuthoringStreamDDL(entity.name, name));
    }
  }

  return statements;
}

// Execute the generated DDL statements against a DatabaseSync handle.
export function executeDDL(entity: DdlEntity, db: DbHandle): void {
  for (const sql of generateDDL(entity)) {
    db.exec(sql);
  }
}

// _ProjectedCursor is a response-staleness counter. _ConsumerCursor is the
// durable per-scope recovery position for post-commit consumers; keeping them
// together does not make their meanings interchangeable.
const FRAMEWORK_CURSOR_SCHEMA = defineSqliteSchema({
  name: 'framework-cursors',
  tables: [
    {
      name: '_ProjectedCursor',
      columns: [
        { name: 'entity', type: 'text', notNull: true },
        { name: 'field', type: 'text', notNull: true },
        { name: 'lastSeq', type: 'integer', notNull: true, default: 0 },
      ],
      primaryKey: ['entity', 'field'],
    },
    {
      name: '_ConsumerCursor',
      columns: [
        { name: 'consumer', type: 'text', notNull: true },
        { name: 'scope', type: 'text', notNull: true },
        { name: 'lastSeq', type: 'integer', notNull: true },
      ],
      primaryKey: ['consumer', 'scope'],
    },
  ],
});

export function frameworkCursorSchema() {
  return FRAMEWORK_CURSOR_SCHEMA;
}

export function generateFrameworkDDL(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS BlobStore (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  md5 TEXT,
  sha256 TEXT,
  size INTEGER,
  mime TEXT,
  createdAt TEXT NOT NULL,
  replacedBy TEXT,
  replacedAt TEXT,
  cleanupError TEXT,
  cleanupAttempts INTEGER NOT NULL DEFAULT 0
);`,
    'CREATE INDEX IF NOT EXISTS idx_blob_status ON BlobStore(status);',
    `CREATE TABLE IF NOT EXISTS _OperationalConsumerDeclaration (
  name TEXT PRIMARY KEY,
  declarationFingerprint TEXT NOT NULL
);`,
    `CREATE TABLE IF NOT EXISTS _OperationalConsumerFailure (
  consumer TEXT NOT NULL,
  scope TEXT NOT NULL,
  committedEventId TEXT NOT NULL,
  declarationFingerprint TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL,
  nextAttemptAt INTEGER,
  PRIMARY KEY (consumer, scope, committedEventId)
);`,
    `CREATE TABLE IF NOT EXISTS _PendingBlob (
  pendingKey TEXT PRIMARY KEY,
  blobId TEXT NOT NULL UNIQUE,
  claimTokenHash TEXT NOT NULL,
  principalKey TEXT NOT NULL,
  resourceId TEXT NOT NULL,
  contentDigest TEXT NOT NULL,
  byteLength INTEGER NOT NULL,
  status TEXT NOT NULL,
  actionId TEXT,
  committedEventId TEXT,
  scopeId TEXT,
  createdAt TEXT NOT NULL,
  claimedAt TEXT,
  finalizedAt TEXT,
  deletedAt TEXT,
  deleteActionId TEXT,
  recoveryFailure TEXT
);`,
    // _Log, _Cursor, and their index are owned by committed-log.mjs.
    ...frameworkLogDDL(),
    `CREATE TABLE IF NOT EXISTS _ScheduleReceipt (
  source TEXT NOT NULL,
  rowId TEXT NOT NULL,
  dueAt INTEGER NOT NULL,
  PRIMARY KEY (source, rowId, dueAt)
);`,
    // Job-queue substrate (spec #5). A job is a unit of work with its own
    // lifecycle (queued/claimed/running/completed/failed), NOT a derived read
    // model — separate seam from the projection registry. Timestamps are ms-epoch
    // INTEGERS so lease/grace comparisons are plain numeric (no ISO-string
    // juggling). _Worker stores only the token HASH (never the raw bearer).
    `CREATE TABLE IF NOT EXISTS _Job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  enqueuedAt INTEGER NOT NULL,
  workerId TEXT,
  claimedAt INTEGER,
  leaseUntil INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  availableAt INTEGER,
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  scope TEXT,
  principalKey TEXT,
  operations TEXT,
  output TEXT
);`,
    `CREATE TABLE IF NOT EXISTS _PrivateActionFact (
  originOrder INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  actionId TEXT NOT NULL,
  committedAt TEXT NOT NULL,
  fact TEXT NOT NULL,
  effects TEXT NOT NULL,
  UNIQUE (scope, actionId)
);`,
    // Erasure prerequisite index (#134, delete-undo design §5): identities-only
    // links from a stored private fact to the entities its restoration depends
    // on (validated v3 annotation prerequisites). Populated only from fully
    // validated facts; no historical backfill. Rows die with their fact (FK
    // cascade) and are additionally swept explicitly at every fact-deletion
    // site so behavior is deterministic even where the pragma is off.
    `CREATE TABLE IF NOT EXISTS _PrivateActionFactDependency (
  scope TEXT NOT NULL,
  actionId TEXT NOT NULL,
  entity TEXT NOT NULL,
  entityId TEXT NOT NULL,
  originOrder INTEGER NOT NULL,
  PRIMARY KEY (originOrder, entity, entityId),
  FOREIGN KEY (originOrder) REFERENCES _PrivateActionFact(originOrder) ON DELETE CASCADE
);`,
    'CREATE INDEX IF NOT EXISTS idx__private_action_fact_dependency_entity ON _PrivateActionFactDependency (entity, entityId);',
    `CREATE TABLE IF NOT EXISTS _PostCommitEffect (
  declarationOrder INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  actionId TEXT NOT NULL,
  file TEXT NOT NULL,
  operation TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  originOrder INTEGER NOT NULL,
  exclusionKey TEXT NOT NULL,
  verification TEXT NOT NULL,
  payload TEXT NOT NULL,
  declaredAt TEXT NOT NULL,
  status TEXT NOT NULL,
  workerId TEXT,
  leaseUntil INTEGER,
  availableAt INTEGER,
  fence INTEGER NOT NULL DEFAULT 0,
  completedAt INTEGER,
  UNIQUE (scope, actionId, file, operation, ordinal)
);`,
    'CREATE INDEX IF NOT EXISTS idx__post_commit_effect_claim ON _PostCommitEffect (status, availableAt, originOrder, ordinal);',
    'CREATE INDEX IF NOT EXISTS idx__post_commit_effect_key_order ON _PostCommitEffect (exclusionKey, originOrder, ordinal);',
    'CREATE INDEX IF NOT EXISTS idx__job_claim ON _Job (status, enqueuedAt);',
    'CREATE INDEX IF NOT EXISTS idx__job_scope_status ON _Job (scope, status, enqueuedAt);',
    // Cursor tables for post-commit consumer tracking — declared via
    // defineSqliteSchema through frameworkCursorSchema().
    ...frameworkCursorSchema().ddl,
    `CREATE TABLE IF NOT EXISTS _Worker (
  id TEXT PRIMARY KEY,
  tokenHash TEXT NOT NULL,
  lastHeartbeat INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  registeredAt INTEGER NOT NULL
);`,
    `CREATE TABLE IF NOT EXISTS _PrincipalSnapshotRevision (
  declaration TEXT NOT NULL,
  principalType TEXT NOT NULL,
  principalId TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (declaration, principalType, principalId)
);`,
    deletedRowAnchorTableDDL(),
  ];
}

export function executeFrameworkDDL(db: DbHandle): void {
  // The receipt-history read index (#124) references _ActionReceipt.historyOrder.
  // Fresh databases receive historyOrder from actionReceiptTableDDL() so the
  // index is created immediately; legacy databases without historyOrder receive
  // the column backfill and index atomically via workbench@7 in
  // runWorkbenchMigrations().
  const historyIndexSql = actionReceiptHistoryIndexDDL();
  for (const sql of generateFrameworkDDL()) {
    if (sql === historyIndexSql) {
      const cols = new Set(db.prepare('PRAGMA table_info(_ActionReceipt)').all().map((r) => r.name));
      if (!cols.has('historyOrder')) continue;
    }
    db.exec(sql);
  }
}
