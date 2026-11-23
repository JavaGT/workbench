import { generateDDL } from './ddl.ts';
import { collectTableNamesFromDdl } from './schema-table-census.ts';
import { openSqliteDatabase, type SqliteDatabase } from './sqlite-driver.ts';

function quoteIdent(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new Error('SQLite identifier must be a non-empty string without NUL bytes');
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexXinfoRow {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface TableXinfoRow {
  cid: number;
  name: string;
  type: string | null;
  notnull: number;
  dflt_value: string | number | Uint8Array | null;
  pk: number;
  hidden: number;
}

export interface SqliteIndexTerm {
  sequence: number;
  columnId: number;
  name: string | null;
  descending: boolean;
  collation: string;
  key: true;
}

export interface SqliteIndexDescription {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  sql: string | null;
  columns: Array<string | null>;
  terms: SqliteIndexTerm[];
}

export interface SqliteForeignKeyDescription {
  table: string;
  columns: Array<string | undefined>;
  referencedColumns: Array<string | undefined>;
  onUpdate: string;
  onDelete: string;
  match: string;
}

export interface SqliteColumnDescription {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | number | Uint8Array | null;
  primaryKeyPosition: number;
  hidden: number;
}

export interface SqliteTableDescription {
  name: string;
  sql: string;
  virtual: boolean;
  withoutRowid: boolean;
  strict: boolean;
  columns: SqliteColumnDescription[];
  primaryKey: string[];
  foreignKeys: SqliteForeignKeyDescription[];
  indexes: SqliteIndexDescription[];
}

export interface SqliteStorageDescription {
  tableNames: string[];
  tables: SqliteTableDescription[];
}

function describeIndexes(db: SqliteDatabase, tableName: string): SqliteIndexDescription[] {
  const rows = db.prepare(`PRAGMA index_list(${quoteIdent(tableName)})`).all() as unknown as IndexListRow[];
  return rows
    .map((row) => {
      const terms = db
        .prepare(`PRAGMA index_xinfo(${quoteIdent(row.name)})`)
        .all() as unknown as IndexXinfoRow[];
      const termEntries = terms
        .filter((term) => term.key === 1)
        .sort((a, b) => a.seqno - b.seqno)
        .map((term) => ({
          sequence: term.seqno,
          columnId: term.cid,
          name: term.name,
          descending: term.desc === 1,
          collation: term.coll,
          key: true as const,
        }));
      const schema = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get(row.name) as { sql: string | null } | undefined;
      return {
        name: row.name,
        unique: row.unique === 1,
        origin: row.origin,
        partial: row.partial === 1,
        sql: schema?.sql ?? null,
        columns: termEntries.map((term) => term.name),
        terms: termEntries,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function describeForeignKeys(db: SqliteDatabase, tableName: string): SqliteForeignKeyDescription[] {
  const groups = new Map<number, SqliteForeignKeyDescription>();
  for (const row of db.prepare(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`).all() as unknown as ForeignKeyRow[]) {
    let group = groups.get(row.id);
    if (group === undefined) {
      group = {
        table: row.table,
        columns: [],
        referencedColumns: [],
        onUpdate: row.on_update,
        onDelete: row.on_delete,
        match: row.match,
      };
      groups.set(row.id, group);
    }
    group.columns[row.seq] = row.from;
    group.referencedColumns[row.seq] = row.to;
  }
  return [...groups.values()].sort((a, b) => {
    const aKey = JSON.stringify([a.table, a.columns, a.referencedColumns, a.onUpdate, a.onDelete, a.match]);
    const bKey = JSON.stringify([b.table, b.columns, b.referencedColumns, b.onUpdate, b.onDelete, b.match]);
    return aKey.localeCompare(bKey);
  });
}

function describeTable(db: SqliteDatabase, tableName: string): SqliteTableDescription {
  const schema = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string | null } | undefined;
  if (schema === undefined) throw new Error(`SQLite table '${tableName}' does not exist`);
  const sql = schema.sql ?? '';
  const columns = db
    .prepare(`PRAGMA table_xinfo(${quoteIdent(tableName)})`)
    .all() as unknown as TableXinfoRow[];
  const columnDescriptions = columns
    .sort((a, b) => a.cid - b.cid)
    .map((column) => ({
      name: column.name,
      type: String(column.type).toUpperCase(),
      notNull: column.notnull === 1,
      defaultValue: column.dflt_value ?? null,
      primaryKeyPosition: column.pk,
      hidden: column.hidden,
    }));
  return {
    name: tableName,
    sql,
    virtual: /^CREATE\s+VIRTUAL\s+TABLE/i.test(sql),
    withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(sql),
    strict: /(?:,|\))\s*STRICT\s*$/i.test(sql),
    columns: columnDescriptions,
    primaryKey: columnDescriptions
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
      .map((column) => column.name),
    foreignKeys: describeForeignKeys(db, tableName),
    indexes: describeIndexes(db, tableName),
  };
}

export function describeSqliteStorage(db: SqliteDatabase, tableNames: readonly string[]): SqliteStorageDescription {
  if (!Array.isArray(tableNames)) throw new Error('tableNames must be an array');
  if (!tableNames.every((name) => typeof name === 'string' && name.length > 0)) {
    throw new Error('tableNames must contain only non-empty strings');
  }
  const names = [...tableNames].sort((a, b) => a.localeCompare(b));
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error('tableNames must not contain duplicates');
  }
  return deepFreeze({
    tableNames: names,
    tables: names.map((name) => describeTable(db, name)),
  });
}

export function describeEntityStorage(entity: { name: string; fields?: unknown }): SqliteStorageDescription {
  const ddl = generateDDL(entity);
  const tableNames = collectTableNamesFromDdl(
    ddl.map((sql: string) => ({ source: `entity ${entity.name}`, sql })),
  );
  const db = openSqliteDatabase(':memory:');
  try {
    for (const sql of ddl) db.exec(sql);
    return describeSqliteStorage(db, tableNames);
  } finally {
    db.close();
  }
}
