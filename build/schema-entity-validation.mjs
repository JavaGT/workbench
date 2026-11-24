import { storedColumnsOf,                             } from './field-strategy.mjs';
import { quoteIdent } from './sqlite-schema.mjs';
import { censusKey,                  } from './schema-census.mjs';

function folded(name        )         {
  return name.toLowerCase();
}

function defaultValue(column                   )                {
  if (column.defaultExpression !== undefined) return column.defaultExpression;
  if (column.default === undefined) return null;
  return typeof column.default === 'number' ? String(column.default) : `'${column.default.replace(/'/g, "''")}'`;
}

















function entityColumns(entity              )                              {
  const columns = new Map                                                   ([['id', { type: 'TEXT', notNull: false, primaryKey: true }]]);
  for (const [name, field] of Object.entries(entity.fields ?? {})) {
    for (const column of storedColumnsOf(name, field                          )) {
      columns.set(column.name, { type: column.type, notNull: !(field.nullable || field.optional) });
    }
  }
  return columns                               ;
}

function fail(entity              , message        )        {
  throw new Error(`schema-owned entity table "${entity.name}" ${message}`);
}









function canonicalForeignKey(foreignKey                 )         {
  return JSON.stringify([
    foreignKey.table.toLowerCase(),
    foreignKey.columns.map((column) => column.toLowerCase()),
    foreignKey.referencedColumns.map((column) => String(column).toLowerCase()),
    foreignKey.onDelete.toUpperCase(),
    foreignKey.onUpdate.toUpperCase(),
  ]);
}

function isIdentifierCharacter(character        )          {
  return character !== '' && ((character.codePointAt(0) ?? 0) > 0x7f || /[A-Z0-9_$]/i.test(character));
}

function hasSqlKeyword(sql        , keyword        )          {
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) index += 1;
          else break;
        }
        index += 1;
      }
      if (index === sql.length) return true;
      continue;
    }
    if (character === '[') {
      index = sql.indexOf(']', index + 1);
      if (index < 0) return true;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      const newline = sql.slice(index + 2).search(/[\r\n]/);
      if (newline < 0) return false;
      index += newline + 1;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      index = sql.indexOf('*/', index + 2);
      if (index < 0) return true;
      index += 1;
      continue;
    }
    if (sql.slice(index, index + keyword.length).toUpperCase() === keyword
      && !isIdentifierCharacter(sql[index - 1] ?? '')
      && !isIdentifierCharacter(sql[index + keyword.length] ?? '')) return true;
  }
  return false;
}

function hasUnsupportedTableClause(sql        )          {
  return ['ASC', 'CHECK', 'COLLATE', 'CONFLICT', 'DEFERRABLE', 'DESC', 'MATCH', 'STRICT', 'WITHOUT'].some((keyword) => hasSqlKeyword(sql, keyword));
}








































// S2 consideration #9 trigger ownership: a schema-owned entity table permits
// a trigger declared by its schema, or a trigger attributed to a plugin by the
// S2/A2 census. App schema preparation supplies that census; the declaration
// fallback keeps this validator usable in isolated tests and tools. A5 consumes
// the same census for the post-migration exact-schema validation phase.





export function validateSchemaOwnedEntityTable(db        , entity              , declaration                  , options                           )       {
  const master = db.prepare("SELECT type, sql FROM sqlite_schema WHERE lower(name) = lower(?)").all(declaration.name);
  if (master.length !== 1 || master[0].type !== 'table') fail(entity, 'must exist as a real table');
  if (/^CREATE\s+VIRTUAL\s+TABLE/i.test((master[0].sql ?? '')          )) fail(entity, 'must not be virtual');
  if (hasUnsupportedTableClause((master[0].sql ?? '')          )) fail(entity, 'must not contain unsupported constraints or table options');
  const temp = db.prepare("SELECT type FROM sqlite_temp_schema WHERE lower(name) = lower(?)").all(declaration.name);
  if (temp.length > 0) fail(entity, 'must not have a TEMP shadow');
  const declaredTriggers = new Set((declaration.triggers ?? []).map((trigger) => folded(trigger.name)));
  for (const schema of ['sqlite_schema', 'sqlite_temp_schema']) {
    const triggers = db.prepare(`SELECT name FROM ${schema} WHERE type = 'trigger' AND lower(tbl_name) = lower(?)`).all(declaration.name);
    for (const trigger of triggers) {
      const name = String(trigger.name);
      if (options?.census) {
        const owner = options.census.get(censusKey('trigger', name));
        const ownedBySchema = declaredTriggers.has(folded(name))
          && owner?.kind === 'schema' && folded(owner.owner) === folded(options.schemaName ?? '');
        const ownedByPlugin = owner?.kind === 'plugin';
        if (!ownedBySchema && !ownedByPlugin) {
          if (owner === undefined && !declaredTriggers.has(folded(name))) fail(entity, `has undeclared trigger "${name}"`);
          fail(entity, `has trigger "${name}" not owned by schema "${options.schemaName ?? '(none)'}" or a plugin`);
        }
      } else if (!declaredTriggers.has(folded(name))) {
        fail(entity, `has undeclared trigger "${name}"`);
      }
    }
  }

  const actual = db.prepare(`PRAGMA table_xinfo(${quoteIdent(declaration.name)})`).all();
  if (actual.some((column) => column.hidden !== 0)) fail(entity, 'must not contain hidden or generated columns');
  const declared = new Map(declaration.columns.map((column) => [column.name.toLowerCase(), column]));
  const logical = entityColumns(entity);
  const actualNames = new Set(actual.map((column) => (column.name          ).toLowerCase()));
  if (actualNames.size !== actual.length || actualNames.size !== declared.size) fail(entity, 'has undeclared or missing columns');

  for (const [name, required] of logical) {
    const column = declared.get(name.toLowerCase());
    if (!column) fail(entity, `is missing declared entity column "${name}"`);
    if (String(column.type).toUpperCase() !== required.type) fail(entity, `declares "${name}" with incompatible type`);
    if (name !== 'id' && Boolean(column.notNull) !== required.notNull) fail(entity, `declares "${name}" with incompatible nullability`);
  }
  for (const column of actual) {
    const expected = declared.get((column.name          ).toLowerCase());
    if (!expected) fail(entity, `has undeclared column "${column.name}"`);
    if (column.name !== expected.name || String(column.type).toUpperCase() !== expected.type .toUpperCase()
      || (column.notnull === 1) !== Boolean(expected.notNull)
      || (column.dflt_value ?? null) !== defaultValue(expected)) fail(entity, `column "${column.name}" does not match its declaration`);
  }
  const id = actual.find((column) => (column.name          ).toLowerCase() === 'id');
  if (!id || id.name !== 'id' || String(id.type).toUpperCase() !== 'TEXT' || id.pk !== 1 || id.dflt_value !== null) {
    fail(entity, 'must declare id as TEXT PRIMARY KEY without a default');
  }

  const primaryKey = actual.filter((column) => (column.pk          ) > 0).sort((a, b) => (a.pk          ) - (b.pk          )).map((column) => column.name          );
  const expectedPrimaryKey = declaration.primaryKey ?? declaration.columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (JSON.stringify(primaryKey) !== JSON.stringify(expectedPrimaryKey)) fail(entity, 'primary key does not match its declaration');

  const expectedFks = (declaration.foreignKeys ?? []).map((foreignKey) => canonicalForeignKey({
    table: foreignKey.references.table, columns: foreignKey.columns, referencedColumns: foreignKey.references.columns,
    onDelete: foreignKey.onDelete ?? 'NO ACTION', onUpdate: foreignKey.onUpdate ?? 'NO ACTION',
  })).sort();
  const actualFks = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(declaration.name)})`).all().reduce((groups, row) => {
    const group = groups.get(row.id) ?? { table: row.table          , columns: []            , referencedColumns: []            , onDelete: row.on_delete          , onUpdate: row.on_update           };
    group.columns[row.seq          ] = row.from          ;
    group.referencedColumns[row.seq          ] = row.to          ;
    groups.set(row.id, group);
    return groups;
  }, new Map                          ());
  if (JSON.stringify([...actualFks.values()].map(canonicalForeignKey).sort()) !== JSON.stringify(expectedFks)) fail(entity, 'foreign keys do not match its declaration');

  const expectedIndexes = new Map((declaration.indexes ?? []).map((index) => [index.name.toLowerCase(), index]));
  const actualIndexes = db.prepare(`PRAGMA index_list(${quoteIdent(declaration.name)})`).all();
  for (const index of actualIndexes) {
    if (index.origin === 'pk') continue;
    const expected = expectedIndexes.get((index.name          ).toLowerCase());
    if (!expected || index.origin !== 'c' || (index.unique === 1) !== Boolean(expected.unique) || index.partial !== 0) fail(entity, `has unexpected index "${index.name}"`);
    const columns = db.prepare(`PRAGMA index_xinfo(${quoteIdent(index.name          )})`).all().filter((term) => term.key === 1).sort((a, b) => (a.seqno          ) - (b.seqno          ));
    if (columns.some((term) => term.name === null || term.desc !== 0 || term.coll !== 'BINARY')
      || JSON.stringify(columns.map((term) => term.name)) !== JSON.stringify(expected.columns)) fail(entity, `index "${index.name}" does not match its declaration`);
    expectedIndexes.delete((index.name          ).toLowerCase());
  }
  if (expectedIndexes.size > 0) fail(entity, `is missing index "${[...expectedIndexes.values()][0].name}"`);
}
