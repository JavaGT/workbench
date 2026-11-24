// schema-exact-validation.ts — S2/A3 exact schema validator: post-migration
// drift detection against the live SQLite schema (epic scope#23, S2
// considerations #6/#7/#9).
//
// Where the A1/A2 phases verify that declarations are well-formed and that
// every database object has exactly one declared owner, THIS phase compares
// every declared object against the live schema via PRAGMAs: columns (name,
// declared type/affinity, nullability, defaults including the parenthesised
// expression form), primary-key order, foreign keys (referenced table,
// columns, referenced columns, ON UPDATE / ON DELETE actions), indexes
// (unique, partial, collation, columns, expression terms), declared triggers,
// and virtual tables plus their shadow tables. Each drift is reported with a
// DISTINCT code and names the owning schema/plugin and the object — never row
// or table contents.
//
// The module is read-only over the database handle and is intended to run as a
// post-migration lifecycle phase (A5 wires it), so it always validates the
// settled schema rather than a half-migrated one.
//
// Ownership attribution comes from the S2/A2 global census (schema-census.ts).
// An object observed in the live schema that no participant owns is undeclared
// drift; an object owned by a participant OTHER than the one whose declaration
// is being validated is a conflicting-ownership drift (consideration #8/#9).

import { censusKey, classifyObservedObject,                                                   } from './schema-census.mjs';









































function folded(name        )         {
  return name.toLowerCase();
}

function quoteIdent(name        )         {
  return `"${name.replace(/"/g, '""')}"`;
}

// SQLite storage-affinity rules (the declared-type grammar of CREATE TABLE).
// `text`/`varchar`/`CLOB` all store as TEXT affinity, `int`/`INTEGER` as
// INTEGER, and so on — the exact validator compares affinities, not spellings.
function affinityOf(type                    )         {
  const t = (type ?? '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t.includes('BLOB') || t === '') return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

// SQLite strips balanced outer parentheses from DEFAULT expressions when it
// stores dflt_value (DEFAULT (strftime(...)) is stored as strftime(...)).
// Strip them on both sides so the parenthesised declaration matches.
function stripOuterParens(text        )         {
  let value = text;
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let closesAtEnd = false;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          closesAtEnd = i === value.length - 1;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    value = value.slice(1, -1);
  }
  return value;
}

// Collapse whitespace, uppercase all characters outside single-quoted string
// literals, and strip double-quoted identifier quoting — so SQLite's stored
// form and the declaration's form compare equal regardless of case, spacing,
// or quoting. String-literal contents (e.g. strftime format strings) are
// preserved verbatim.
function normaliseSql(text        )         {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  let out = '';
  let inString = false;
  let inIdentifier = false;
  for (let i = 0; i < collapsed.length; i += 1) {
    const ch = collapsed[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (collapsed[i + 1] === "'") {
          out += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (inIdentifier) {
      if (ch === '"') {
        inIdentifier = false;
        continue;
      }
      out += ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inIdentifier = true;
      continue;
    }
    out += ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch;
  }
  return out;
}

function normaliseDefault(value                                                 )         {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  return normaliseSql(stripOuterParens(text.trim()));
}

// The default a declaration compiles into CREATE TABLE, in stored form.
function declaredDefault(column                                                           )                {
  if (column.defaultExpression !== undefined) return column.defaultExpression;
  if (column.default === undefined) return null;
  return typeof column.default === 'number' ? String(column.default) : `'${column.default.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Live-schema readers (PRAGMAs only — never table contents)
// ---------------------------------------------------------------------------

























function indexSqlTermsAndWhere(db               , indexName        , xinfoTerms                                )                                            {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND lower(name) = lower(?)").get(indexName);
  const sql = row == null ? '' : String(row.sql ?? '');
  if (sql === '') {
    // Auto-indexes (origin 'u'/'pk' from UNIQUE/PK constraints) have no stored
    // SQL — derive their terms from PRAGMA index_xinfo column names instead.
    return { terms: xinfoTerms.map((term) => (term.name === null ? '' : normaliseSql(quoteIdent(term.name)))), where: null };
  }
  const open = sql.indexOf('(');
  if (open < 0) return { terms: [], where: null };
  let depth = 0;
  let close = -1;
  for (let i = open; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return { terms: [], where: null };
  const inner = sql.slice(open + 1, close);
  const terms           = [];
  let termDepth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inString) {
      if (ch === "'") {
        if (inner[i + 1] === "'") i += 1;
        else inString = false;
      }
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '(') termDepth += 1;
    else if (ch === ')') termDepth -= 1;
    else if (ch === ',' && termDepth === 0) {
      terms.push(normaliseSql(inner.slice(start, i)));
      start = i + 1;
    }
  }
  terms.push(normaliseSql(inner.slice(start)));
  const where = sql.slice(close + 1).match(/^\s+WHERE\s+(.+?)\s*;?\s*$/i);
  return { terms, where: where === null ? null : normaliseSql(where[1]) };
}

function readLiveIndexes(db               , tableName        )              {
  return db.prepare(`PRAGMA index_list(${quoteIdent(tableName)})`).all().map((row) => {
    const name = String(row.name);
    const terms = db.prepare(`PRAGMA index_xinfo(${quoteIdent(name)})`).all()
      .filter((term) => (term.key          ) === 1)
      .sort((a, b) => (a.seqno          ) - (b.seqno          ))
      .map((term) => ({
        name: term.name === null ? null : String(term.name),
        descending: term.desc          ,
        collation: String(term.coll),
      }));
    const sql = indexSqlTermsAndWhere(db, name, terms);
    return {
      name,
      unique: row.unique === 1,
      origin: String(row.origin),
      partial: row.partial === 1,
      where: sql.where,
      sqlTerms: sql.terms,
      terms,
    };
  });
}

function readLiveForeignKeys(db               , tableName        )                   {
  const groups = new Map                        ();
  for (const row of db.prepare(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`).all()) {
    const id = row.id          ;
    let group = groups.get(id);
    if (group === undefined) {
      group = {
        table: String(row.table),
        columns: [],
        referencedColumns: [],
        onUpdate: String(row.on_update).toUpperCase(),
        onDelete: String(row.on_delete).toUpperCase(),
      };
      groups.set(id, group);
    }
    group.columns[row.seq          ] = String(row.from);
    group.referencedColumns[row.seq          ] = String(row.to);
  }
  return [...groups.values()];
}

function foreignKeyKey(foreignKey                                                                                     )         {
  return JSON.stringify([
    folded(foreignKey.table),
    foreignKey.columns.map(folded),
    foreignKey.referencedColumns.map(folded),
  ]);
}

// ---------------------------------------------------------------------------
// Ordinary tables
// ---------------------------------------------------------------------------

function declaredIndexTerms(index                                                                 )           {
  return [
    ...(index.columns ?? []).map((column) => normaliseSql(quoteIdent(column))),
    ...(index.expression ?? []).map((term) => normaliseSql(term)),
  ];
}

function declaredIndexCollations(
  table                                           ,
  index                                                                 ,
)           {
  const columns = new Map(table.columns.map((column) => [folded(column.name), column]));
  const expressionCollation = (expression        )         => {
    const match = expression.match(/\s+COLLATE\s+("(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_]*)\s*(?:ASC|DESC)?\s*\)*\s*$/i);
    return match === null ? 'BINARY' : match[1].replace(/^"|"$/g, '').replaceAll('""', '');
  };
  return [
    ...(index.columns ?? []).map((name) => columns.get(folded(name))?.collation ?? 'BINARY'),
    ...(index.expression ?? []).map(expressionCollation),
  ];
}

function validateColumns(db               , owner        , table                                           , push      )       {
  const live = db.prepare(`PRAGMA table_xinfo(${quoteIdent(table.name)})`).all();
  const declared = new Map(table.columns.map((column) => [folded(column.name), column]));
  for (const column of live) {
    const name = String(column.name);
    const expected = declared.get(folded(name));
    if (expected === undefined) {
      push('extra-column', 'schema', owner, 'column', name, `of table "${table.name}" is extra (not declared)`);
      continue;
    }
    if ((column.hidden          ) !== 0) {
      push('extra-column', 'schema', owner, 'column', name, `of table "${table.name}" is hidden or generated (not declared)`);
      continue;
    }
    const liveType = column.type === null ? '' : String(column.type);
    if (affinityOf(liveType) !== affinityOf(expected.type)) {
      push('changed-type', 'schema', owner, 'column', name, `of table "${table.name}" has type "${liveType}" but is declared "${expected.type ?? '(none)'}"`);
    }
    if ((column.notnull === 1) !== Boolean(expected.notNull)) {
      push('changed-nullability', 'schema', owner, 'column', name, `of table "${table.name}" has nullability differing from its declaration`);
    }
    if (normaliseDefault(column.dflt_value                                                   ) !== normaliseDefault(declaredDefault(expected))) {
      push('changed-default', 'schema', owner, 'column', name, `of table "${table.name}" has a default differing from its declaration`);
    }
  }
  for (const column of table.columns) {
    if (!live.some((row) => folded(String(row.name)) === folded(column.name))) {
      push('missing-column', 'schema', owner, 'column', column.name, `of table "${table.name}" is declared but absent from the live schema`);
    }
  }
}

function validatePrimaryKey(db               , owner        , table                                           , push      )       {
  const live = db.prepare(`PRAGMA table_xinfo(${quoteIdent(table.name)})`).all()
    .filter((column) => (column.pk          ) > 0)
    .sort((a, b) => (a.pk          ) - (b.pk          ))
    .map((column) => String(column.name));
  const declared = (table.primaryKey ?? table.columns.filter((column) => column.primaryKey).map((column) => column.name)).map((name) => String(name));
  if (JSON.stringify(live.map(folded)) !== JSON.stringify(declared.map(folded))) {
    push('pk-mismatch', 'schema', owner, 'table', table.name,
      `has primary key [${live.join(', ')}] but is declared [${declared.join(', ')}]`);
  }
}

function validateForeignKeys(db               , owner        , table                                           , push      )       {
  const live = readLiveForeignKeys(db, table.name);
  const matched = new Set        ();
  for (const foreignKey of table.foreignKeys ?? []) {
    const declaredShape = {
      table: foreignKey.references.table,
      columns: [...foreignKey.columns],
      referencedColumns: [...foreignKey.references.columns],
    };
    const liveIndex = live.findIndex((candidate) => foreignKeyKey(candidate) === foreignKeyKey(declaredShape));
    if (liveIndex < 0) {
      push('fk-mismatch', 'schema', owner, 'table', table.name,
        `declares a foreign key on (${foreignKey.columns.join(', ')}) referencing "${foreignKey.references.table}" (${foreignKey.references.columns.join(', ')}) that is not present in the live schema`);
      continue;
    }
    matched.add(liveIndex);
    const onUpdate = (foreignKey.onUpdate ?? 'no action').toUpperCase();
    const onDelete = (foreignKey.onDelete ?? 'no action').toUpperCase();
    const liveFk = live[liveIndex];
    if (liveFk.onUpdate !== onUpdate || liveFk.onDelete !== onDelete) {
      push('wrong-fk-action', 'schema', owner, 'table', table.name,
        `foreign key on (${foreignKey.columns.join(', ')}) referencing "${foreignKey.references.table}" has live actions ON UPDATE ${liveFk.onUpdate} / ON DELETE ${liveFk.onDelete}, declared ON UPDATE ${onUpdate} / ON DELETE ${onDelete}`);
    }
  }
  live.forEach((foreignKey, index) => {
    if (!matched.has(index)) {
      push('extra-fk', 'schema', owner, 'table', table.name,
        `has a foreign key on (${foreignKey.columns.join(', ')}) referencing "${foreignKey.table}" (${foreignKey.referencedColumns.join(', ')}) that is not declared`);
    }
  });
}

function validateIndexes(db               , owner        , table                                           , push      )       {
  const live = readLiveIndexes(db, table.name).filter((index) => index.origin !== 'pk');
  const matched = new Set        ();
  for (const index of table.indexes ?? []) {
    const liveIndex = live.find((candidate) => folded(candidate.name) === folded(index.name));
    if (liveIndex === undefined) {
      push('missing-index', 'schema', owner, 'table', table.name, `is missing declared index "${index.name}"`);
      continue;
    }
    matched.add(liveIndex.name);
    const expectedTerms = declaredIndexTerms(index);
    const expectedCollations = declaredIndexCollations(table, index);
    const termsMatch = expectedTerms.length === liveIndex.sqlTerms.length
      && expectedTerms.every((term, position) => term === liveIndex.sqlTerms[position]);
    const collationsMatch = expectedCollations.length === liveIndex.terms.length
      && expectedCollations.every((collation, position) => folded(collation) === folded(liveIndex.terms[position].collation));
    if (liveIndex.origin !== 'c' || liveIndex.unique !== Boolean(index.unique)
      || liveIndex.partial !== (index.where !== undefined)
      || liveIndex.where !== (index.where === undefined ? null : normaliseSql(index.where))
      || !termsMatch || !collationsMatch) {
      push('index-mismatch', 'schema', owner, 'table', table.name, `index "${index.name}" does not match its declaration`);
    }
  }
  for (const constraint of table.unique ?? []) {
    const expectedTerms = constraint.columns.map((name) => normaliseSql(quoteIdent(name)));
    const liveIndex = live.findIndex((candidate) => candidate.origin === 'u'
      && expectedTerms.length === candidate.sqlTerms.length
      && expectedTerms.every((term, position) => term === candidate.sqlTerms[position]));
    if (liveIndex < 0) {
      push('missing-index', 'schema', owner, 'table', table.name,
        `is missing the auto-index for declared UNIQUE (${constraint.columns.join(', ')})`);
      continue;
    }
    matched.add(live[liveIndex].name);
  }
  for (const index of live) {
    if (!matched.has(index.name)) {
      push('extra-index', 'schema', owner, 'table', table.name, `has extra index "${index.name}"`);
    }
  }
}

// Trigger policy (S2 consideration #9): an observed trigger on the table is
// declared drift only if it is owned by NO participant; a trigger owned by a
// participant other than the validating schema (or a plugin) is a
// conflicting-ownership drift. A trigger declared by this table's declaration
// and owned by this schema (or a plugin) is permitted.
function validateTriggers(db               , census                                  , owner        , table                                           , push      )       {
  const declared = new Set((table.triggers ?? []).map((trigger) => folded(trigger.name)));
  for (const trigger of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND lower(tbl_name) = lower(?)").all(table.name)) {
    const name = String(trigger.name);
    const censusEntry = census.get(censusKey('trigger', name));
    const ownedByDeclarant = censusEntry !== undefined
      && (censusEntry.kind === 'plugin' || (censusEntry.kind === 'schema' && folded(censusEntry.owner) === folded(owner)));
    if (!declared.has(folded(name))) {
      if (censusEntry !== undefined && !ownedByDeclarant) {
        push('conflicting-ownership', 'schema', owner, 'trigger', name,
          `of table "${table.name}" is owned by ${censusEntry.kind} "${censusEntry.owner}", not schema "${owner}" or a plugin`);
      } else {
        push('extra-trigger', 'schema', owner, 'trigger', name, `of table "${table.name}" is undeclared`);
      }
      continue;
    }
    if (censusEntry !== undefined && !ownedByDeclarant) {
      push('conflicting-ownership', 'schema', owner, 'trigger', name,
        `of table "${table.name}" is declared by this schema but owned by ${censusEntry.kind} "${censusEntry.owner}"`);
    }
  }
}

function validateTable(db               , census                                  , owner        , table                                           , push      )       {
  const censusEntry = census.get(censusKey('table', table.name));
  if (censusEntry !== undefined && !(censusEntry.kind === 'schema' && folded(censusEntry.owner) === folded(owner))) {
    push('conflicting-ownership', 'schema', owner, 'table', table.name,
      `is owned by ${censusEntry.kind} "${censusEntry.owner}", not schema "${owner}"`);
    return;
  }
  const live = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND lower(name) = lower(?)").get(table.name);
  if (live == null) {
    push('missing-table', 'schema', owner, 'table', table.name, 'is declared but absent from the live schema');
    return;
  }
  if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(String(live.sql ?? ''))) {
    push('table-kind', 'schema', owner, 'table', table.name, 'is a virtual table but is declared as an ordinary table');
    return;
  }
  validateColumns(db, owner, table, push);
  validatePrimaryKey(db, owner, table, push);
  validateForeignKeys(db, owner, table, push);
  validateIndexes(db, owner, table, push);
  validateTriggers(db, census, owner, table, push);
}

// ---------------------------------------------------------------------------
// Virtual tables + shadow tables
// ---------------------------------------------------------------------------

function validateVirtualTable(db               , census                                  , schemaName        , virtualTable                                                  , push      )       {
  const pluginId = virtualTable.ownerPluginId;
  const censusEntry = census.get(censusKey('virtual-table', virtualTable.name));
  if (censusEntry !== undefined && !(censusEntry.kind === 'plugin' && folded(censusEntry.owner) === folded(pluginId))) {
    push('conflicting-ownership', 'schema', schemaName, 'virtual-table', virtualTable.name,
      `is owned by ${censusEntry.kind} "${censusEntry.owner}", not plugin "${pluginId}"`);
    return;
  }
  const live = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND lower(name) = lower(?)").get(virtualTable.name);
  if (live == null) {
    push('missing-table', 'plugin', pluginId, 'virtual-table', virtualTable.name, 'is declared but absent from the live schema');
    return;
  }
  if (!/^CREATE\s+VIRTUAL\s+TABLE/i.test(String(live.sql ?? ''))) {
    push('table-kind', 'plugin', pluginId, 'virtual-table', virtualTable.name, 'exists as an ordinary table but is declared as a virtual table');
    return;
  }
  for (const shadow of virtualTable.shadowTables) {
    const shadowLive = db.prepare("SELECT type FROM sqlite_schema WHERE type = 'table' AND lower(name) = lower(?)").get(shadow);
    if (shadowLive == null) {
      push('missing-table', 'plugin', pluginId, 'shadow-table', shadow,
        `of virtual table "${virtualTable.name}" is declared but absent from the live schema`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Validate every object declared by the given schema declarations against the
// live SQLite schema. Returns all drift diagnostics (each with a distinct
// code); never throws and never reads table contents. The census supplies
// ownership attribution so undeclared and conflicting-ownership objects are
// told apart.
export function validateExactSchema(
  db               ,
  census                                  ,
  schemas                                    ,
  options                     = {},
)                              {
  const errors                     = [];
  const push       = (code, ownerKind, owner, objectKind, name, detail) => {
    errors.push({
      code,
      message: `${ownerKind} "${owner}" ${objectKind} "${name}" ${detail}`,
      ownerKind,
      owner,
      objectKind,
      name,
    });
  };
  for (const schema of schemas) {
    for (const table of schema.tables) validateTable(db, census, schema.name, table, push);
    for (const virtualTable of schema.virtualTables) validateVirtualTable(db, census, schema.name, virtualTable, push);
  }
  if (options.validateCensus) {
    for (const entry of census.values()) {
      const type = entry.objectKind === 'virtual-table' || entry.objectKind === 'shadow-table' ? 'table' : entry.objectKind;
      const live = db.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND lower(name) = lower(?)').get(type, entry.name);
      const objectKind = entry.objectKind === 'table' ? 'table' : entry.objectKind;
      const ownerKind = entry.kind;
      const owner = entry.owner;
      if (live == null) {
        push('missing-object', ownerKind, owner, objectKind, entry.name, 'is declared by the lifecycle census but absent from the live schema');
      } else if (entry.objectKind === 'virtual-table' && !/^CREATE\s+VIRTUAL\s+TABLE/i.test(String(live.sql ?? ''))) {
        push('object-kind', ownerKind, owner, 'virtual-table', entry.name, 'is declared as a virtual table but exists as an ordinary table');
      } else if (entry.objectKind === 'table' && /^CREATE\s+VIRTUAL\s+TABLE/i.test(String(live.sql ?? ''))) {
        push('object-kind', ownerKind, owner, 'table', entry.name, 'is declared as an ordinary table but exists as a virtual table');
      }
    }
    const observed = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')").all()
      .map((row) => ({
        type: (String(row.type) === 'table' && /^CREATE\s+VIRTUAL\s+TABLE/i.test(String(row.sql ?? '')) ? 'virtual-table' : String(row.type))              ,
        name: String(row.name),
      }                        ));
    for (const object of observed) {
      if (classifyObservedObject(object, census).kind === 'undeclared') {
        push('undeclared-object', 'undeclared', 'undeclared', object.type, object.name, 'exists in the live schema but is absent from the lifecycle census');
      }
    }
  }
  return errors;
}
