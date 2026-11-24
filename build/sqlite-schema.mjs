import { begin, commit, rollback,               } from './driver.mjs';
import { runMigrations, validateMigrations } from './migrations.mjs';
import { frameworkReservedNamesWithoutAuthCompile as FRAMEWORK_RESERVED_NAMES } from './framework-table-names.mjs';

const ALLOWED_TYPES = new Set(['text', 'integer', 'real', 'blob']);
const ALLOWED_FK_ACTIONS = new Set(['cascade', 'set null', 'set default', 'restrict', 'no action']);
const ALLOWED_DEFAULT_EXPRESSIONS = new Set([
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
]);
// S2/A1: plugin virtual tables are FTS5-only until S4 ratifies further modules.
const ALLOWED_VIRTUAL_MODULES = new Set(['fts5']);
const ALLOWED_TRIGGER_TIMING = new Set(['before', 'after', 'instead of']);
const ALLOWED_TRIGGER_EVENTS = new Set(['insert', 'update', 'delete']);

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireName(value         , label        )         {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function requireIdentifier(value         , label        )         {
  const name = requireName(value, label);
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`${label} must be an identifier`);
  }
  return name;
}

function folded(name        )         {
  return name.toLowerCase();
}

// The ONE SQL identifier quoting helper, shared with DDL generation and both
// schema validators. Identifiers are always double-quoted and embedded quotes
// doubled; no other module may carry its own spelling of this rule.
export function quoteIdent(name        )         {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function quoteDefault(value                 )         {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`default must be a finite number or string`);
}

function normaliseAction(value         , label        )                     {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ALLOWED_FK_ACTIONS.has(value.toLowerCase())) {
    throw new Error(`invalid ${label} action "${value}"`);
  }
  return value.toUpperCase();
}

// ---------------------------------------------------------------------------
// SQL expression sanity checks.
//
// Declarations ship raw SQL fragments (CHECK, index WHERE, trigger WHEN/body,
// virtual-table options). These are validated before any database is touched:
// well-formed tokens, balanced quotes and parentheses, no comments or parameter
// placeholders, and — where the fragment lives inside one table — bare column
// references resolve to declared columns. This is deliberately a strict-ish
// tokenizer, not a full SQL parser; it keeps ordinary app declarations honest
// without duplicating the SQLite grammar.
// ---------------------------------------------------------------------------

const SQL_EXPRESSION_TOKEN = new RegExp(
  [
    /"(?:[^"]|"")*"/.source,
    /'(?:[^']|'')*'/.source,
    /0[xX][0-9a-fA-F]+/.source,
    /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.source,
    /[A-Za-z_][A-Za-z0-9_]*/.source,
    /<=|>=|!=|<>|==|\|\||->>|->|<<|>>|::|[(),.+\-*/%<>=!~&|^;]/.source,
  ].join('|'),
  'y',
);

const SQL_KEYWORDS = new Set([
  'ABORT', 'ALL', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CAST',
  'COLLATE', 'CONFLICT', 'CROSS', 'CURRENT', 'CURRENT_DATE', 'CURRENT_TIME',
  'CURRENT_TIMESTAMP', 'CURRENT_USER', 'DEFERRED', 'DESC', 'DISTINCT',
  'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXCLUSIVE', 'EXISTS', 'FAIL', 'FALSE',
  'FILTER', 'FIRST', 'FULL', 'GLOB', 'GROUP', 'HAVING', 'IGNORE', 'IMMEDIATE',
  'IN', 'INNER', 'INTERSECT', 'IS', 'ISNULL', 'JOIN', 'KEY', 'LAST', 'LEFT',
  'LIKE', 'LIMIT', 'MATCH', 'NATURAL', 'NO', 'NOT', 'NOTNULL', 'NULL',
  'NULLS', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION',
  'PRECEDING', 'RANGE', 'RECURSIVE', 'REGEXP', 'REPLACE', 'RIGHT', 'ROLLBACK',
  'ROWS', 'SELECT', 'THEN', 'TRUE', 'UNBOUNDED', 'UNION', 'WHEN', 'WHERE',
  'WITH',
]);

const TRAILING_INVALID_PUNCT = new Set([
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '~', '&', '|', '^', '(', ',',
  '.', ';', '<=', '>=', '!=', '<>', '==', '->', '->>', '<<', '>>', '||', '::',
]);

// Keywords that cannot end a boolean expression (they demand a following
// operand/clause) — a WHERE/CHECK ending in one is malformed.
const TRAILING_INVALID_KEYWORDS = new Set([
  'AND', 'AS', 'BETWEEN', 'BY', 'CASE', 'CAST', 'COLLATE', 'ELSE', 'ESCAPE',
  'EXCEPT', 'EXISTS', 'FROM', 'GLOB', 'GROUP', 'HAVING', 'IN', 'INTERSECT',
  'IS', 'LIKE', 'LIMIT', 'MATCH', 'NOT', 'OFFSET', 'OR', 'ORDER', 'REGEXP',
  'SELECT', 'THEN', 'UNION', 'WHEN', 'WHERE', 'WITH',
]);






function checkQuotesBalanced(input        , label        )       {
  let inString = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (ch === "'") {
        if (input[i + 1] === "'") {
          i += 1;
        } else {
          inString = false;
        }
      }
    } else if (ch === "'") {
      inString = true;
    }
  }
  if (inString) throw new Error(`${label} has an unterminated string literal`);
}

function tokenizeSql(input        , label        )             {
  checkQuotesBalanced(input, label);
  const tokens             = [];
  let depth = 0;
  for (let index = 0; index < input.length;) {
    const ch = input[index];
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    // Comment starts are only meaningful outside string literals; a '--' or
    // '/*' inside a quoted string is data, and because string tokens below are
    // consumed whole, those never reach this position.
    if ((ch === '-' && input[index + 1] === '-') || (ch === '/' && input[index + 1] === '*')) {
      throw new Error(`${label} must not contain SQL comments`);
    }
    SQL_EXPRESSION_TOKEN.lastIndex = index;
    const match = SQL_EXPRESSION_TOKEN.exec(input);
    if (match === null || match.index !== index) {
      throw new Error(`${label} contains an invalid token "${ch}"`);
    }
    const text = match[0];
    let kind                  ;
    if (text[0] === '"') kind = 'quoted';
    else if (text[0] === "'") kind = 'string';
    else if (/^[0-9]/.test(text) || /^\.\d/.test(text)) kind = 'number';
    else if (/^[A-Za-z_]/.test(text)) kind = 'identifier';
    else kind = 'punct';
    if (kind === 'punct') {
      if (text === '(') depth += 1;
      if (text === ')') {
        depth -= 1;
        if (depth < 0) throw new Error(`${label} has unbalanced parentheses`);
      }
    }
    tokens.push({ text, kind });
    index += text.length;
  }
  if (depth !== 0) throw new Error(`${label} has unbalanced parentheses`);
  return tokens;
}

// Validate a single SQL expression (CHECK, index WHERE/expression term,
// trigger WHEN). Bare identifiers and quoted identifiers must resolve to a
// declared column unless they are SQL keywords, function names, qualified
// names, or (for triggers) NEW./OLD. pseudo-table references.
function validateSqlExpression(
  input         ,
  knownColumns                              ,
  label        ,
)       {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty SQL expression`);
  }
  const tokens = tokenizeSql(input, label);
  let skipNext = false;
  let depth = 0;
  // Paren frames opened by CAST(...), so the AS between the expression and the
  // type name is allowed while a bare AS (alias) is not an expression operator.
  const castFrames           = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === 'quoted') {
      const next = tokens[i + 1];
      if (next?.kind === 'punct' && next.text === '.') continue;
      const name = token.text.slice(1, -1).replaceAll('""', '"');
      if (!knownColumns.has(folded(name))) {
        throw new Error(`${label} references missing column "${name}"`);
      }
      continue;
    }
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth += 1;
        const previous = tokens[i - 1];
        if (previous?.kind === 'identifier' && previous.text.toUpperCase() === 'CAST') {
          castFrames.push(depth);
        }
      } else if (token.text === ')') {
        if (castFrames.length > 0 && castFrames[castFrames.length - 1] === depth) {
          castFrames.pop();
        }
        depth -= 1;
      }
      continue;
    }
    if (token.kind !== 'identifier') continue;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const upper = token.text.toUpperCase();
    if (SQL_KEYWORDS.has(upper)) {
      if (upper === 'COLLATE') {
        skipNext = true;
        continue;
      }
      if (upper === 'AS') {
        if (castFrames.length > 0 && castFrames[castFrames.length - 1] === depth) {
          skipNext = true;
          continue;
        }
        throw new Error(`${label} uses AS outside a CAST(...) type name (AS is not an expression operator)`);
      }
      continue;
    }
    const next = tokens[i + 1];
    if (next?.kind === 'punct' && (next.text === '(' || next.text === '.')) continue;
    if (!knownColumns.has(folded(token.text))) {
      throw new Error(`${label} references missing column "${token.text}"`);
    }
  }
  const last = tokens[tokens.length - 1];
  if (last.kind === 'punct' && TRAILING_INVALID_PUNCT.has(last.text)) {
    throw new Error(`${label} ends with an invalid token "${last.text}"`);
  }
  if (last.kind === 'identifier' && TRAILING_INVALID_KEYWORDS.has(last.text.toUpperCase())) {
    throw new Error(`${label} ends with an incomplete expression ("${last.text}")`);
  }
}

// Validate a trigger body. Bodies are multi-statement SQL and may reference
// other tables, so only NEW./OLD. column references are checked against the
// declaring table. Statements must be semicolon-terminated and each must be a
// complete, valid statement shape — a known statement verb, no trailing tokens
// after the final ';'.
const TRIGGER_STATEMENT_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH']);

function validateTriggerBody(
  input         ,
  knownColumns                              ,
  label        ,
)       {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} must declare a non-empty trigger body`);
  }
  const tokens = tokenizeSql(input, label);
  const statements               = [];
  let statement             = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'punct' && token.text === ';' && depth === 0) {
      statements.push(statement);
      statement = [];
      continue;
    }
    if (token.kind === 'punct' && token.text === '(') depth += 1;
    else if (token.kind === 'punct' && token.text === ')') depth -= 1;
    statement.push(token);
  }
  if (statements.length === 0) {
    throw new Error(`${label} body must contain at least one statement (terminated by ';')`);
  }
  if (statement.length > 0) {
    throw new Error(`${label} body has trailing tokens after the final ';'`);
  }
  for (const body of statements) {
    const first = body[0];
    if (first === undefined) throw new Error(`${label} body contains an empty statement`);
    if (first.kind !== 'identifier' || !TRIGGER_STATEMENT_VERBS.has(first.text.toUpperCase())) {
      throw new Error(`${label} body statements must begin with SELECT, INSERT, UPDATE, DELETE, or WITH`);
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== 'identifier' || (token.text.toUpperCase() !== 'NEW' && token.text.toUpperCase() !== 'OLD')) {
      continue;
    }
    const dot = tokens[i + 1];
    const column = tokens[i + 2];
    if (!(dot?.kind === 'punct' && dot.text === '.') || column === undefined || (column.kind !== 'identifier' && column.kind !== 'quoted')) {
      throw new Error(`${label} uses ${token.text} without a column reference`);
    }
    const name = column.kind === 'quoted' ? column.text.slice(1, -1).replaceAll('""', '"') : column.text;
    if (!knownColumns.has(folded(name))) {
      throw new Error(`${label} references missing column "${name}"`);
    }
    i += 2;
  }
}

// Validate a raw virtual-table option fragment (e.g. `content='articles'`,
// `tokenize='porter unicode61'`). Options are module vocabulary, not table
// columns, so only well-formedness is checked.
function validateVirtualTableOption(input         , label        )       {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty option`);
  }
  if (input.includes('\0')) throw new Error(`${label} must not contain NUL bytes`);
  const tokens = tokenizeSql(input, label);
  const last = tokens[tokens.length - 1];
  if (last.kind === 'punct' && TRAILING_INVALID_PUNCT.has(last.text)) {
    throw new Error(`${label} ends with an invalid token "${last.text}"`);
  }
}

// ---------------------------------------------------------------------------
// DDL compilation
// ---------------------------------------------------------------------------

function compileTable(table                 )         {
  const lines = table.columns.map((column) => {
    let sql = `  ${quoteIdent(column.name)} ${column.type.toUpperCase()}`;
    if (column.collation !== undefined) sql += ` COLLATE ${column.collation}`;
    if (column.primaryKey) sql += ' PRIMARY KEY';
    if (column.notNull) sql += ' NOT NULL';
    if (column.default !== undefined) sql += ` DEFAULT ${quoteDefault(column.default)}`;
    if (column.defaultExpression !== undefined) sql += ` DEFAULT ${column.defaultExpression}`;
    if (column.check !== undefined) sql += ` CHECK (${column.check})`;
    return sql;
  });

  if (table.primaryKey !== undefined) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(', ')})`);
  }

  for (const constraint of table.unique ?? []) {
    const named = constraint.name !== undefined ? `CONSTRAINT ${quoteIdent(constraint.name)} ` : '';
    lines.push(`  ${named}UNIQUE (${constraint.columns.map(quoteIdent).join(', ')})`);
  }

  for (const constraint of table.check ?? []) {
    const named = constraint.name !== undefined ? `CONSTRAINT ${quoteIdent(constraint.name)} ` : '';
    lines.push(`  ${named}CHECK (${constraint.expression})`);
  }

  for (const foreignKey of table.foreignKeys ?? []) {
    let sql = `  FOREIGN KEY (${foreignKey.columns.map(quoteIdent).join(', ')})`;
    sql += ` REFERENCES ${quoteIdent(foreignKey.references.table)}`;
    sql += ` (${foreignKey.references.columns.map(quoteIdent).join(', ')})`;
    const onDelete = normaliseAction(foreignKey.onDelete, 'ON DELETE');
    const onUpdate = normaliseAction(foreignKey.onUpdate, 'ON UPDATE');
    if (onDelete !== undefined) sql += ` ON DELETE ${onDelete}`;
    if (onUpdate !== undefined) sql += ` ON UPDATE ${onUpdate}`;
    lines.push(sql);
  }

  let sql = `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n${lines.join(',\n')}\n)`;
  if (table.strict) sql += ' STRICT';
  if (table.withoutRowid) sql += ', WITHOUT ROWID';
  return `${sql};`;
}

function compileIndex(tableName        , index                 )         {
  const terms = [
    ...(index.columns ?? []).map(quoteIdent),
    ...(index.expression ?? []),
  ];
  const unique = index.unique ? ' UNIQUE' : '';
  let sql = `CREATE${unique} INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(tableName)} (${terms.join(', ')})`;
  if (index.where !== undefined) sql += ` WHERE ${index.where}`;
  return sql;
}

function compileVirtualTable(virtualTable                        )         {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdent(virtualTable.name)} USING ${virtualTable.module}(${virtualTable.options.join(', ')});`;
}

function compileTrigger(tableName        , trigger                   )         {
  let sql = `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(trigger.name)} ${trigger.timing.toUpperCase()} ${trigger.event.toUpperCase()}`;
  if (trigger.columnNames !== undefined && trigger.columnNames.length > 0) {
    sql += ` OF ${trigger.columnNames.map(quoteIdent).join(', ')}`;
  }
  sql += ` ON ${quoteIdent(tableName)}`;
  if (trigger.when !== undefined) sql += ` WHEN ${trigger.when}`;
  sql += ` BEGIN ${trigger.body} END;`;
  return sql;
}































function validateSpec(input         )       {
  if (input === null || typeof input !== 'object') throw new Error('schema declaration must be an object');
  const spec = input                     ;
  requireName(spec.name, 'schema name');
  if (!Array.isArray(spec.tables)) throw new Error('schema tables must be an array');
  const tables = spec.tables             ;
  if (spec.externalTables !== undefined && !Array.isArray(spec.externalTables)) {
    throw new Error('schema externalTables must be an array');
  }
  const externalTables = (spec.externalTables ?? [])             ;
  if (spec.migrations !== undefined && !Array.isArray(spec.migrations)) {
    throw new Error('schema migrations must be an array');
  }
  const migrations = (spec.migrations ?? [])             ;
  if (spec.virtualTables !== undefined && !Array.isArray(spec.virtualTables)) {
    throw new Error('schema virtualTables must be an array');
  }
  const virtualTables = (spec.virtualTables ?? [])             ;

  const tablesByName = new Map                                                                         ();
  const referencedTablesByName = new Map                                                                         ();
  const indexNameSpace = new Set        ();
  const checkNames = new Set        ();
  const triggerNames = new Set        ();
  const virtualTableNames = new Set        ();
  const shadowTableNames = new Set        ();

  for (const virtualTable of virtualTables) {
    if (virtualTable === null || typeof virtualTable !== 'object') {
      throw new Error('virtual table declaration must be an object');
    }
    const declaration = virtualTable                     ;
    requireName(declaration.name, 'virtual table name');
    const virtualKey = folded(declaration.name          );
    if (virtualTableNames.has(virtualKey)) throw new Error(`duplicate virtual table "${declaration.name}"`);
    if (shadowTableNames.has(virtualKey)) throw new Error(`virtual table "${declaration.name}" collides with a shadow table`);
    const module = requireName(declaration.module, `virtual table "${declaration.name}" module`);
    if (!ALLOWED_VIRTUAL_MODULES.has(module.toLowerCase())) {
      throw new Error(`unknown virtual table module "${module}" for "${declaration.name}"`);
    }
    if (!Array.isArray(declaration.options) || (declaration.options             ).length === 0) {
      throw new Error(`virtual table "${declaration.name}" must declare at least one option`);
    }
    const options = declaration.options             ;
    const seenOptions = new Set        ();
    for (const option of options) {
      validateVirtualTableOption(option, `option in virtual table "${declaration.name}"`);
      const optionKey = folded(option          );
      if (seenOptions.has(optionKey)) throw new Error(`duplicate option "${option}" in virtual table "${declaration.name}"`);
      seenOptions.add(optionKey);
    }
    requireName(declaration.ownerPluginId, `owner plugin for virtual table "${declaration.name}"`);
    if (!Array.isArray(declaration.shadowTables) || (declaration.shadowTables             ).length === 0) {
      throw new Error(`virtual table "${declaration.name}" must declare the shadow tables it owns`);
    }
    // Shadow tables are fts5-internal names attributed to their owning virtual
    // table by the A2 census, so they are deliberately NOT cross-checked
    // against externalTables: an external declaration claims only the tables it
    // names, and a shadow name collision is resolved by the census's
    // owner-declaration lookup rather than rejected here. The virtual table's
    // own name IS checked (below, against external declarations).
    const shadows = declaration.shadowTables             ;
    const seenShadows = new Set        ();
    for (const shadow of shadows) {
      requireName(shadow, `shadow table for virtual table "${declaration.name}"`);
      const shadowKey = folded(shadow          );
      if (seenShadows.has(shadowKey)) throw new Error(`duplicate shadow table "${shadow}" for virtual table "${declaration.name}"`);
      if (shadowTableNames.has(shadowKey)) throw new Error(`duplicate shadow table "${shadow}"`);
      if (virtualTableNames.has(shadowKey)) throw new Error(`shadow table "${shadow}" collides with a virtual table`);
      seenShadows.add(shadowKey);
      shadowTableNames.add(shadowKey);
    }
    virtualTableNames.add(virtualKey);
  }

  for (const externalTable of externalTables) {
    if (externalTable === null || typeof externalTable !== 'object') {
      throw new Error('external table declaration must be an object');
    }
    const declaration = externalTable                      ;
    requireName(declaration.name, 'external table name');
    const externalKey = folded(declaration.name          );
    if (referencedTablesByName.has(externalKey)) throw new Error(`duplicate external table "${declaration.name}"`);
    if (!Array.isArray(declaration.columns) || (declaration.columns             ).length === 0) {
      throw new Error(`external table "${declaration.name}" must declare at least one column`);
    }
    const columnsByName = new Map                 ();
    for (const columnName of declaration.columns             ) {
      requireName(columnName, `column name in external table "${declaration.name}"`);
      const columnKey = folded(columnName          );
      if (columnsByName.has(columnKey)) throw new Error(`duplicate column "${columnName}" in external table "${declaration.name}"`);
      columnsByName.set(columnKey, { name: columnName });
    }
    referencedTablesByName.set(externalKey, { table: externalTable                   , columnsByName });
  }

  // Out-of-band triggers (on external or framework tables) the fixture/app
  // created; declared as schema-owned knowledge for the census. Duplicate
  // names within one schema are a declaration error.
  if (spec.externalTriggers !== undefined && !Array.isArray(spec.externalTriggers)) {
    throw new Error('schema externalTriggers must be an array');
  }
  const externalTriggers = (spec.externalTriggers ?? [])             ;
  const seenExternalTriggers = new Set        ();
  for (const trigger of externalTriggers) {
    if (trigger === null || typeof trigger !== 'object') {
      throw new Error('external trigger declaration must be an object');
    }
    requireName((trigger                ).name, 'external trigger name');
    const triggerKey = folded((trigger                ).name          );
    if (seenExternalTriggers.has(triggerKey)) {
      throw new Error(`duplicate external trigger "${(trigger                ).name}"`);
    }
    seenExternalTriggers.add(triggerKey);
  }

  // Indexes a co-tenant created on external (or framework) tables. The schema
  // never creates or drops them — it only declares their names so the startup
  // census can attribute them instead of reporting them as undeclared drift.
  // String entries are accepted for parity with the other external-declaration
  // surfaces and normalised to `{ name }` on the compiled schema.
  if (spec.externalIndexes !== undefined && !Array.isArray(spec.externalIndexes)) {
    throw new Error('schema externalIndexes must be an array');
  }
  const externalIndexes = (spec.externalIndexes ?? [])             ;
  const seenExternalIndexes = new Set        ();
  for (const index of externalIndexes) {
    const name = typeof index === 'string'
      ? index
      : (index !== null && typeof index === 'object' ? (index                      ).name : undefined);
    requireIdentifier(name, 'external index name');
    if (typeof index !== 'string' && (index                      ).table !== undefined) {
      requireIdentifier((index                      ).table, `table for external index "${name}"`);
    }
    const indexKey = folded(name          );
    if (indexKey.startsWith('sqlite_')) {
      throw new Error(`external index "${name}" uses the reserved sqlite_ prefix`);
    }
    if (FRAMEWORK_RESERVED_NAMES.has(indexKey)) {
      throw new Error(`external index "${name}" uses a framework-reserved name`);
    }
    if (seenExternalIndexes.has(indexKey)) throw new Error(`duplicate external index "${name}"`);
    seenExternalIndexes.add(indexKey);
  }

  // A virtual table claims a real table name, so it must not collide with an
  // external declaration (which claims that name too). Collisions with ordinary
  // declared tables are rejected in the table loop below.
  for (const virtualKey of virtualTableNames) {
    const external = referencedTablesByName.get(virtualKey);
    if (external !== undefined) {
      throw new Error(`virtual table "${external.table.name}" collides with an external table declaration`);
    }
  }

  for (const table of tables) {
    if (table === null || typeof table !== 'object') throw new Error('table declaration must be an object');
    const declaration = table              ;
    requireName(declaration.name, 'table name');
    const tableKey = folded(declaration.name          );
    if (tablesByName.has(tableKey) || referencedTablesByName.has(tableKey)) throw new Error(`duplicate table "${declaration.name}"`);
    if (virtualTableNames.has(tableKey) || shadowTableNames.has(tableKey)) {
      throw new Error(`table "${declaration.name}" collides with a declared virtual table`);
    }
    if (!Array.isArray(declaration.columns) || (declaration.columns             ).length === 0) {
      throw new Error(`table "${declaration.name}" must declare at least one column`);
    }

    const columnsByName = new Map                 ();
    const pendingColumnChecks                                                = [];
    let columnPrimaryKeys = 0;
    for (const column of declaration.columns             ) {
      if (column === null || typeof column !== 'object') throw new Error(`invalid column in table "${declaration.name}"`);
      const col = column               ;
      requireName(col.name, `column name in table "${declaration.name}"`);
      const columnKey = folded(col.name          );
      if (columnsByName.has(columnKey)) throw new Error(`duplicate column "${col.name}" in table "${declaration.name}"`);
      if (typeof col.type !== 'string' || !ALLOWED_TYPES.has(col.type.toLowerCase())) {
        throw new Error(`invalid column type "${col.type}" for column "${col.name}"`);
      }
      if (col.default !== undefined && col.defaultExpression !== undefined) {
        throw new Error(`column "${col.name}" cannot declare both default and defaultExpression`);
      }
      if (col.default !== undefined) quoteDefault(col.default                   );
      if (col.defaultExpression !== undefined && !ALLOWED_DEFAULT_EXPRESSIONS.has(col.defaultExpression          )) {
        throw new Error(`invalid default expression "${col.defaultExpression}" for column "${col.name}"`);
      }
      if (col.collation !== undefined) {
        requireIdentifier(col.collation, `collation for column "${col.name}"`);
      }
      if (col.check !== undefined) {
        pendingColumnChecks.push({
          expression: col.check,
          label: `check on column "${col.name}"`,
        });
      }
      if (col.primaryKey === true) columnPrimaryKeys += 1;
      columnsByName.set(columnKey, col);
    }

    for (const { expression, label } of pendingColumnChecks) {
      validateSqlExpression(expression, columnsByName, label);
    }

    if (columnPrimaryKeys > 1 || (columnPrimaryKeys > 0 && declaration.primaryKey !== undefined)) {
      throw new Error(`table "${declaration.name}" has conflicting primary key declarations`);
    }
    if (declaration.primaryKey !== undefined) {
      validateColumnList(declaration.primaryKey, columnsByName, `primary key on table "${declaration.name}"`);
    }

    if (declaration.strict !== undefined && typeof declaration.strict !== 'boolean') {
      throw new Error(`strict on table "${declaration.name}" must be a boolean`);
    }
    if (declaration.withoutRowid !== undefined && typeof declaration.withoutRowid !== 'boolean') {
      throw new Error(`withoutRowid on table "${declaration.name}" must be a boolean`);
    }
    if (declaration.withoutRowid === true && columnPrimaryKeys === 0 && declaration.primaryKey === undefined) {
      throw new Error(`withoutRowid table "${declaration.name}" must declare a primary key`);
    }

    for (const index of (declaration.indexes ?? [])             ) {
      const idx = index              ;
      requireName(idx.name, `index name on table "${declaration.name}"`);
      const indexKey = folded(idx.name          );
      if (indexNameSpace.has(indexKey)) throw new Error(`duplicate index "${idx.name}"`);
      indexNameSpace.add(indexKey);
      if (idx.columns !== undefined) {
        validateColumnList(idx.columns, columnsByName, `index "${idx.name}"`);
      }
      if (idx.expression !== undefined) {
        if (!Array.isArray(idx.expression) || (idx.expression             ).length === 0) {
          throw new Error(`index "${idx.name}" expression terms must be a non-empty array`);
        }
        for (const term of idx.expression             ) {
          validateSqlExpression(term, columnsByName, `expression in index "${idx.name}"`);
        }
      }
      if (idx.columns === undefined && idx.expression === undefined) {
        throw new Error(`index "${idx.name}" must declare columns or expression terms`);
      }
      if (idx.where !== undefined) {
        validateSqlExpression(idx.where, columnsByName, `partial index "${idx.name}"`);
      }
    }

    for (const constraint of (declaration.unique ?? [])             ) {
      if (constraint === null || typeof constraint !== 'object') {
        throw new Error(`invalid unique constraint on table "${declaration.name}"`);
      }
      const unique = constraint                         ;
      if (unique.name !== undefined) {
        requireName(unique.name, `unique constraint name on table "${declaration.name}"`);
        const uniqueKey = folded(unique.name          );
        if (indexNameSpace.has(uniqueKey)) throw new Error(`duplicate index name "${unique.name}"`);
        indexNameSpace.add(uniqueKey);
      }
      validateColumnList(unique.columns, columnsByName, `unique constraint on table "${declaration.name}"`);
    }

    for (const constraint of (declaration.check ?? [])             ) {
      if (constraint === null || typeof constraint !== 'object') {
        throw new Error(`invalid check constraint on table "${declaration.name}"`);
      }
      const check = constraint                        ;
      if (check.name !== undefined) {
        requireName(check.name, `check constraint name on table "${declaration.name}"`);
        const checkKey = folded(check.name          );
        if (checkNames.has(checkKey)) throw new Error(`duplicate check constraint "${check.name}"`);
        checkNames.add(checkKey);
      }
      validateSqlExpression(check.expression, columnsByName, `check constraint on table "${declaration.name}"`);
    }

    for (const trigger of (declaration.triggers ?? [])             ) {
      if (trigger === null || typeof trigger !== 'object') {
        throw new Error(`invalid trigger on table "${declaration.name}"`);
      }
      const trig = trigger                ;
      requireName(trig.name, `trigger name on table "${declaration.name}"`);
      const triggerKey = folded(trig.name          );
      if (triggerNames.has(triggerKey)) throw new Error(`duplicate trigger "${trig.name}"`);
      triggerNames.add(triggerKey);
      if (typeof trig.timing !== 'string' || !ALLOWED_TRIGGER_TIMING.has(trig.timing.toLowerCase())) {
        throw new Error(`invalid trigger timing "${String(trig.timing)}" for trigger "${trig.name}"`);
      }
      if (typeof trig.event !== 'string' || !ALLOWED_TRIGGER_EVENTS.has(trig.event.toLowerCase())) {
        throw new Error(`invalid trigger event "${String(trig.event)}" for trigger "${trig.name}"`);
      }
      if (trig.columnNames !== undefined) {
        if (trig.event.toLowerCase() !== 'update') {
          throw new Error(`trigger "${trig.name}" declares column names for a non-UPDATE event`);
        }
        validateColumnList(trig.columnNames, columnsByName, `trigger "${trig.name}"`);
      }
      if (trig.when !== undefined) {
        validateSqlExpression(trig.when, columnsByName, `trigger "${trig.name}"`);
      }
      validateTriggerBody(trig.body, columnsByName, `trigger "${trig.name}" on "${declaration.name}"`);
    }

    tablesByName.set(tableKey, { table: table                   , columnsByName });
    referencedTablesByName.set(tableKey, { table: table                   , columnsByName });
  }

  for (const { table, columnsByName } of tablesByName.values()) {
    for (const foreignKey of (table.foreignKeys ?? [])             ) {
      if (foreignKey === null || typeof foreignKey !== 'object' || (foreignKey                   ).references === null || typeof (foreignKey                   ).references !== 'object') {
        throw new Error(`invalid foreign key on table "${table.name}"`);
      }
      const fk = foreignKey                   ;
      validateColumnList(fk.columns, columnsByName, `foreign key on table "${table.name}"`);
      requireName((fk.references                       ).table, `referenced table for foreign key on "${table.name}"`);
      const referenced = referencedTablesByName.get(folded((fk.references                     ).table));
      if (referenced === undefined) {
        throw new Error(`foreign key on table "${table.name}" references missing table "${(fk.references                     ).table}"`);
      }
      validateColumnList((fk.references                         ).columns, referenced.columnsByName, `foreign key reference to table "${referenced.table.name}"`);
      if ((fk.columns             ).length !== ((fk.references                          ).columns).length) {
        throw new Error(`foreign key on table "${table.name}" has mismatched column counts`);
      }
      normaliseAction(fk.onDelete, 'ON DELETE');
      normaliseAction(fk.onUpdate, 'ON UPDATE');
    }
  }

  const migrationVersionsByNamespace = new Map                     ();
  const migrationNames = new Set        ();
  for (const migration of migrations) {
    const m = migration                  ;
    if (migration === null || typeof migration !== 'object' || !Number.isSafeInteger(m.version) || (m.version          ) <= 0) {
      throw new Error('migration version must be a positive safe integer');
    }
    const namespace = requireName(m.namespace, 'migration namespace');
    const name = requireName(m.name, 'migration name');
    const namespaceKey = folded(namespace);
    if (!migrationVersionsByNamespace.has(namespaceKey)) migrationVersionsByNamespace.set(namespaceKey, new Set());
    const versions = migrationVersionsByNamespace.get(namespaceKey) ;
    if (versions.has(m.version          )) throw new Error(`duplicate migration version ${m.version} in namespace "${namespace}"`);
    versions.add(m.version          );
    const nameKey = `${namespaceKey}\u0000${folded(name)}`;
    if (migrationNames.has(nameKey)) throw new Error(`duplicate migration name "${name}" in namespace "${namespace}"`);
    migrationNames.add(nameKey);
    if (m.dependencies !== undefined) {
      if (!Array.isArray(m.dependencies)) throw new Error(`dependencies for migration "${name}" must be an array`);
      const seenDependencies = new Set        ();
      for (const dependency of m.dependencies             ) {
        const dep = requireName(dependency, `dependency of migration "${name}"`);
        const depKey = folded(dep);
        if (seenDependencies.has(depKey)) throw new Error(`duplicate dependency "${dep}" on migration "${name}"`);
        seenDependencies.add(depKey);
      }
    }
    if (typeof m.up !== 'function') throw new Error(`migration ${m.version} must declare an up function`);
  }
}

function validateColumnList(columns         , knownColumns                              , label        )       {
  if (!Array.isArray(columns) || columns.length === 0) throw new Error(`${label} must contain at least one column`);
  const seen = new Set        ();
  for (const name of columns) {
    requireName(name, `column in ${label}`);
    const key = folded(name          );
    if (seen.has(key)) throw new Error(`${label} contains duplicate column "${name}"`);
    if (!knownColumns.has(key)) throw new Error(`${label} references missing column "${name}"`);
    seen.add(key);
  }
}

// ---------------------------------------------------------------------------
// Adoption of app-owned tables
// ---------------------------------------------------------------------------
//
// An app that predates Workbench already owns tables in the same SQLite file.
// The census needs to know they are declared (so boot does not report them as
// undeclared drift), but this schema must never create, alter, or drop them.
// `externalTables` / `externalIndexes` are the declaration surfaces; this is
// the ONE place that reads them out of a live database and produces those
// declarations. Consumers get a one-line call instead of hand-rolled PRAGMA
// SQL, and every name is validated before any declaration is produced.

/** The read-only slice of a database handle adoption needs (PRAGMAs + sqlite_schema). */




/** Declaration-only knowledge produced by adoption. Nothing here is created. */



















// Validate the requested names, read each table's columns from the authoritative
// pragma, then attribute every non-SQLite index on those tables. Unknown tables,
// non-ordinary tables, bad identifiers, and framework-reserved names all fail
// closed here — before a schema can be compiled from the result.
function introspectAdoptedTables(db             , tableNames                   )                        {
  if (db === null || typeof db !== 'object' || typeof db.prepare !== 'function') {
    throw new TypeError('adoptExternalTables requires a database handle with prepare()');
  }
  if (!Array.isArray(tableNames) || tableNames.length === 0) {
    throw new TypeError('adoptExternalTables requires a non-empty array of table names');
  }

  const tables                                                      = [];
  const ownersByFoldedName = new Map                ();
  for (const candidate of tableNames) {
    const name = requireIdentifier(candidate, 'adopted table name');
    const key = folded(name);
    if (key.startsWith('sqlite_')) throw new Error(`adopted table "${name}" uses the reserved sqlite_ prefix`);
    if (FRAMEWORK_RESERVED_NAMES.has(key)) throw new Error(`adopted table "${name}" uses a framework-reserved name`);
    if (ownersByFoldedName.has(key)) throw new Error(`duplicate adopted table "${name}"`);

    const live = db.prepare("SELECT type, sql FROM sqlite_schema WHERE lower(name) = lower(?)").all(name);
    if (live.length === 0) throw new Error(`adopted table "${name}" does not exist in the live schema`);
    if (String(live[0].type) !== 'table' || /^CREATE\s+VIRTUAL\s+TABLE/i.test(String(live[0].sql ?? ''))) {
      throw new Error(`adopted table "${name}" is not an ordinary table`);
    }
    const columns = db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(name)
      .map((row) => requireIdentifier(row.name, `column in adopted table "${name}"`));
    if (columns.length === 0) throw new Error(`adopted table "${name}" has no columns`);

    tables.push(Object.freeze({ name, columns: Object.freeze(columns) }));
    ownersByFoldedName.set(key, name);
  }

  const indexes                                          = [];
  const seenIndexes = new Set        ();
  for (const row of db.prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all()) {
    const owner = ownersByFoldedName.get(folded(String(row.tbl_name ?? '')));
    if (owner === undefined) continue;
    const name = requireIdentifier(row.name, `index on adopted table "${owner}"`);
    const key = folded(name);
    if (key.startsWith('sqlite_')) continue;
    if (FRAMEWORK_RESERVED_NAMES.has(key)) throw new Error(`adopted index "${name}" uses a framework-reserved name`);
    if (seenIndexes.has(key)) throw new Error(`duplicate adopted index "${name}"`);
    seenIndexes.add(key);
    indexes.push(Object.freeze({ name, table: owner }));
  }

  return Object.freeze({
    externalTables: Object.freeze(tables),
    externalIndexes: Object.freeze(indexes),
  });
}

/**
 * Adopt existing app-owned tables as declaration-only knowledge for the
 * Workbench startup census. The tables and their non-SQLite indexes are read
 * from the live schema; this function never mutates it. With `options.name`,
 * returns a complete compiled schema (optionally with `options.tables`); by
 * default returns `{ externalTables, externalIndexes }` for `defineSqliteSchema`.
 */
export function adoptExternalTables(
  db             ,
  tableNames                   ,
  options                             ,
)                                                  {
  if (options?.name !== undefined) {
    return defineSqliteSchema({
      name: options.name,
      tables: options.tables ?? [],
      adoptTables: { db, tables: tableNames },
    });
  }
  return introspectAdoptedTables(db, tableNames);
}

// Explicit declarations win over adopted ones of the same name; the two are
// never allowed to become duplicate census claims. Adoption is additive only.
function mergeAdoptedDeclarations(declared         , adopted                                             )            {
  const merged            = [];
  const seen = new Set        ();
  for (const entry of (Array.isArray(declared) ? declared : [])             ) {
    const name = typeof entry === 'string' ? entry : (entry                             )?.name;
    const key = folded(requireName(name, 'external declaration name'));
    if (seen.has(key)) throw new Error(`duplicate external declaration "${String(name)}"`);
    seen.add(key);
    merged.push(entry);
  }
  for (const entry of adopted) {
    const key = folded(entry.name);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

// The runtime migration ledger is the namespaced (namespace, version) ledger
// (workbench#90). Namespaces are independent, so the same version in two
// namespaces is legitimate; reserved-namespace impersonation and declaration
// errors (duplicates, gaps, dependency syntax) are refused by validateMigrations
// before any DDL or migration executes.















































































































export function defineSqliteSchema(spec                   )                          {
  let input                    = spec;
  if (spec.adoptTables !== undefined) {
    const adoption = spec.adoptTables                           ;
    if (adoption === null || typeof adoption !== 'object') {
      throw new TypeError('adoptTables must be an object with db and tables');
    }
    if (!Array.isArray(adoption.tables)) {
      throw new TypeError('adoptTables.tables must be an array of table names');
    }
    const adopted = introspectAdoptedTables(adoption.db, adoption.tables);
    input = {
      ...spec,
      externalTables: mergeAdoptedDeclarations(spec.externalTables, adopted.externalTables),
      externalIndexes: mergeAdoptedDeclarations(spec.externalIndexes, adopted.externalIndexes),
    };
  }
  validateSpec(input);
  const validated = input                    ;
  const tables = Object.freeze(validated.tables.map((table) => Object.freeze({
    ...table,
    columns: Object.freeze(table.columns.map((column) => Object.freeze({ ...column }))),
    foreignKeys: Object.freeze((table.foreignKeys ?? []).map((foreignKey) => Object.freeze({
      ...foreignKey,
      columns: Object.freeze([...foreignKey.columns]),
      references: Object.freeze({ ...foreignKey.references, columns: Object.freeze([...foreignKey.references.columns]) }),
    }))),
    indexes: Object.freeze((table.indexes ?? []).map((index) => Object.freeze({
      ...index,
      columns: Object.freeze([...(index.columns ?? [])]),
      expression: Object.freeze([...(index.expression ?? [])]),
    }))),
    unique: Object.freeze((table.unique ?? []).map((constraint) => Object.freeze({
      ...constraint,
      columns: Object.freeze([...constraint.columns]),
    }))),
    check: Object.freeze((table.check ?? []).map((constraint) => Object.freeze({ ...constraint }))),
    triggers: Object.freeze((table.triggers ?? []).map((trigger) => Object.freeze({
      ...trigger,
      columnNames: Object.freeze([...(trigger.columnNames ?? [])]),
    }))),
    ...(table.primaryKey === undefined ? {} : { primaryKey: Object.freeze([...table.primaryKey]) }),
  })));
  const externalTables = Object.freeze((validated.externalTables ?? []).map((table) => Object.freeze({
    name: table.name,
    columns: Object.freeze([...table.columns]),
  })));
  const externalTriggers = Object.freeze((validated.externalTriggers ?? []).map((trigger) => Object.freeze({ name: trigger.name })));
  const externalIndexes = Object.freeze((validated.externalIndexes ?? []).map((index) => Object.freeze({
    name: typeof index === 'string' ? index : index.name,
    ...(typeof index === 'string' || index.table === undefined ? {} : { table: index.table }),
  })));
  const virtualTables = Object.freeze((validated.virtualTables ?? []).map((virtualTable) => Object.freeze({
    ...virtualTable,
    options: Object.freeze([...virtualTable.options]),
    shadowTables: Object.freeze([...virtualTable.shadowTables]),
  })));
  const triggers = Object.freeze(
    validated.tables.flatMap((table) => (table.triggers ?? []).map((trigger) => Object.freeze({
      ...trigger,
      columnNames: Object.freeze([...(trigger.columnNames ?? [])]),
    }))),
  );
  const tableDdl = validated.tables.map(compileTable);
  const indexDdl = validated.tables.flatMap((table) => (table.indexes ?? []).map((index) => compileIndex(table.name, index)));
  const virtualTableDdl = virtualTables.map(compileVirtualTable);
  const triggerDdl = validated.tables.flatMap((table) => (table.triggers ?? []).map((trigger) => compileTrigger(table.name, trigger)));
  const ddl = [...tableDdl, ...indexDdl];
  const tableNames = validated.tables.map((table) => table.name);
  const migrations = [...(validated.migrations ?? [])];

  const schema                          = {
    name: validated.name,
    tableNames: Object.freeze(tableNames),
    tables,
    externalTables,
    externalTriggers,
    externalIndexes,
    virtualTables,
    triggers,
    migrations: Object.freeze(migrations),
    ddl: Object.freeze(ddl),
    virtualTableDdl: Object.freeze(virtualTableDdl),
    triggerDdl: Object.freeze(triggerDdl),
    prepare(db, options) {
      // Declaration-level safety before any DDL or migration executes: the
      // namespaced runner (workbench#90) refuses reserved-namespace
      // impersonation and declaration errors even when the caller defers
      // migration execution (skipMigrations) — the app boot path prepares with
      // skipMigrations and then runs the lane directly via runMigrations, so a
      // skip here would let migrations execute unguarded. Always fail closed.
      validateMigrations(migrations);
      if (tableDdl.length > 0) {
        begin(db);
        try {
          for (const sql of tableDdl) db.exec(sql);
          commit(db);
        } catch (error) {
          try { rollback(db); } catch { /* transaction is already unusable */ }
          throw error;
        }
      }
      if (!options?.skipMigrations) runMigrations(db, migrations, options);
      if (!options?.skipIndexes && indexDdl.length > 0) {
        begin(db);
        try {
          for (const sql of indexDdl) db.exec(sql);
          commit(db);
        } catch (error) {
          try { rollback(db); } catch { /* transaction is already unusable */ }
          throw error;
        }
      }
    },
  };
  return Object.freeze(schema);
}
