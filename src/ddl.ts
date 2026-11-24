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
import { fieldShapeError, isMainTableField, storedColumnsOf } from './field-strategy.ts';
import { sideTableDDL } from './side-table-strategy.ts';
import { actionReceiptHistoryIndexDDL } from './committed-log.ts';
import { quoteIdent, defineSqliteSchema } from './sqlite-schema.ts';
import { frameworkDdlDeclarations, FRAMEWORK_CURSOR_SCHEMA_SPEC } from './framework-table-names.ts';
import { annotatedTextDDL, annotatedTextAuthoringStreamDDL } from './annotated-text-field.ts';

function assertIdentifier(name: string, label: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new Error(`${label} must be a non-empty SQL identifier without NUL bytes`);
  }
}

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
  /** Single-column (or tuple) UNIQUE constraints normalized by the compiler. */
  unique?: ReadonlyArray<readonly string[]>;
}

function fieldsOf(entity: DdlEntity): Readonly<Record<string, FieldDescriptorLike>> | undefined {
  return entity.fields as Readonly<Record<string, FieldDescriptorLike>> | undefined;
}

// Map a field's kind+type to its SQLite column type.
function unknownField(entityName: string, fieldName: string, message: string): never {
  throw new Error(`${message} at ${entityName}.${fieldName}`);
}

function assertSupportedField(entityName: string, fieldName: string, descriptor: FieldDescriptorLike): void {
  const reason = fieldShapeError(descriptor);
  if (reason !== null) unknownField(entityName, fieldName, reason);
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
  // Composite unique indexes come from the `indexes` slot; single-column
  // constraints (including field-level `unique: true`) come from `unique`.
  // Both emit the same `CREATE UNIQUE INDEX IF NOT EXISTS` statement shape.
  // Dedupe by canonical field tuple (matching compile.ts) so distinct
  // constraints like ['a', 'b'] and ['a_b'] never silently collapse onto the
  // same SQLite index name; disambiguate colliding index names deterministically.
  const seenTuples = new Set<string>();
  const usedNames = new Set<string>();
  const result: Array<{ name: string; fields: readonly string[] }> = [];
  const add = (fields: readonly string[]) => {
    const tupleKey = [...fields].sort().join('\u0000');
    if (seenTuples.has(tupleKey)) return;
    seenTuples.add(tupleKey);
    const baseName = `idx_${entity.name}_unique_${fields.join('_')}`;
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = `${baseName}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(name.toLowerCase());
    result.push({ name, fields });
  };
  for (const index of entity.indexes ?? []) {
    if (index.unique === true) add(index.fields);
  }
  for (const fields of entity.unique ?? []) add(fields);
  return result;
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
    // Every column name + type comes from the one storage-shape authority.
    // A text CRDT's declared cell is its canonical JSON checkpoint, not a
    // materialized string plus a hidden second authority.
    for (const column of storedColumnsOf(name, descriptor)) {
      let sql = `${quoteIdent(column.name)} ${column.type}`;
      // Only a physical ref is required by its FK; other stored columns keep
      // the historical nullable-by-default shape.
      if (column.name === name && isMainTableField(descriptor)
        && physicalRef(entity, descriptor) && !(descriptor.nullable || descriptor.optional)) {
        sql += ' NOT NULL';
      }
      cols.push(sql);
    }
    // map / log / store / ordered / ephemeral / annotatedText / pull-computed
    // → side tables, field-owned DDL, or read-time only: no main-table column.
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

// The cursor declaration lives in the framework-table-names leaf so the
// reserved-name registry can name it without importing this module (the old
// import was an initialization cycle through this top-level compiler call).
const FRAMEWORK_CURSOR_SCHEMA = defineSqliteSchema(FRAMEWORK_CURSOR_SCHEMA_SPEC);

export function frameworkCursorSchema() {
  return FRAMEWORK_CURSOR_SCHEMA;
}

export function generateFrameworkDDL(): string[] {
  // The DDL strings are declared in the framework-table-names leaf; this is
  // the executor that supplies the compiled cursor DDL for the one seam the
  // leaf cannot compile itself (defineSqliteSchema lives here in ddl.ts).
  return frameworkDdlDeclarations(frameworkCursorSchema().ddl);
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
