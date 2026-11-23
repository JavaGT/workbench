import { generateDDL } from './ddl.mjs';
import { collectTableNamesFromDdl } from './schema-table-census.mjs';
import { openSqliteDatabase,                     } from './sqlite-driver.mjs';

function quoteIdent(name         )         {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new Error('SQLite identifier must be a non-empty string without NUL bytes');
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function deepFreeze   (value   )    {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}




























































































function describeIndexes(db                , tableName        )                           {
  const rows = db.prepare(`PRAGMA index_list(${quoteIdent(tableName)})`).all()                             ;
  return rows
    .map((row) => {
      const terms = db
        .prepare(`PRAGMA index_xinfo(${quoteIdent(row.name)})`)
        .all()                              ;
      const termEntries = terms
        .filter((term) => term.key === 1)
        .sort((a, b) => a.seqno - b.seqno)
        .map((term) => ({
          sequence: term.seqno,
          columnId: term.cid,
          name: term.name,
          descending: term.desc === 1,
          collation: term.coll,
          key: true         ,
        }));
      const schema = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get(row.name)                                      ;
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

function describeForeignKeys(db                , tableName        )                                {
  const groups = new Map                                     ();
  for (const row of db.prepare(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`).all()                              ) {
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

function describeTable(db                , tableName        )                         {
  const schema = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName)                                      ;
  if (schema === undefined) throw new Error(`SQLite table '${tableName}' does not exist`);
  const sql = schema.sql ?? '';
  const columns = db
    .prepare(`PRAGMA table_xinfo(${quoteIdent(tableName)})`)
    .all()                              ;
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

export function describeSqliteStorage(db                , tableNames                   )                           {
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

export function describeEntityStorage(entity                                    )                           {
  const ddl = generateDDL(entity);
  const tableNames = collectTableNamesFromDdl(
    ddl.map((sql        ) => ({ source: `entity ${entity.name}`, sql })),
  );
  const db = openSqliteDatabase(':memory:');
  try {
    for (const sql of ddl) db.exec(sql);
    return describeSqliteStorage(db, tableNames);
  } finally {
    db.close();
  }
}
