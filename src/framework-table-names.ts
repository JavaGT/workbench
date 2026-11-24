// Lightweight package-table census for security-sensitive code that cannot
// import the auth compile graph without introducing an initialization cycle.
// This module is ALSO the reserved-framework-namespace registry: it derives the
// framework-owned object names (tables, indexes, triggers, virtual tables) so
// schema/entity/plugin declarations can be refused pre-touch when they claim a
// name the framework reserves (S2/A2, consideration #5).
import { frameworkLogDDL } from './committed-log.ts';
import { deletedRowAnchorTableDDL } from './deleted-row-anchor.ts';
import { MIGRATION_DDL } from './migrations.ts';
import { OPERATIONAL_LEDGER_DDL } from './operational-ledger-ddl.ts';

const AUTH_TABLE_NAMES = ['User', 'Session', 'Inbox', 'Credential', 'Invitation', 'ApiKey', 'TwoFactor'];

// The one generated object of the always-registered auth entities that boot-time
// schema validation must reject before the auth compile graph is available:
// Session's schedule index. Its name is produced by generateDDL(Session) in the
// census; it is declared here ONCE so the leaf registry can reserve it without
// importing that graph (the cycle this module used to have with ddl.ts).
const AUTH_COMPILED_OBJECT_NAMES = ['idx_Session_schedule_createdAt'] as const;

// ---------------------------------------------------------------------------
// Framework DDL declarations — the leaf authority for the reserved namespace.
//
// These strings used to be emitted by `generateFrameworkDDL()` in ddl.ts, and
// this module imported that function to derive its registry. ddl.ts also calls
// `defineSqliteSchema` at module top level, so the import made the two modules
// mutually initializing. The declarations now live HERE (no ddl.ts import, no
// schema compiler); ddl.ts is the executor that appends the cursor schema DDL
// compiled from FRAMEWORK_CURSOR_SCHEMA_SPEC. Everything that must know which
// names the package owns derives them from these declarations.
// ---------------------------------------------------------------------------

export const FRAMEWORK_DDL_BEFORE_CURSORS: readonly string[] = Object.freeze([
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
  // _Log, _Cursor, and their index are owned by committed-log.ts.
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
]);

// Cursor tables for post-commit consumer tracking. The declaration is kept as
// plain data here so the census can name them without compiling a schema;
// ddl.ts compiles this exact spec with defineSqliteSchema and injects its DDL
// BETWEEN the two declaration halves below.
export const FRAMEWORK_CURSOR_SCHEMA_SPEC = {
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
};

export const FRAMEWORK_CURSOR_TABLE_NAMES: readonly string[] = Object.freeze(
  FRAMEWORK_CURSOR_SCHEMA_SPEC.tables.map((table) => table.name),
);

export const FRAMEWORK_DDL_AFTER_CURSORS: readonly string[] = Object.freeze([
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
]);

// The ordered framework DDL list. The DDL executor passes the compiled cursor
// DDL; the census passes none and names the cursor tables from the spec above.
export function frameworkDdlDeclarations(cursorDdl: readonly string[] = []): string[] {
  return [...FRAMEWORK_DDL_BEFORE_CURSORS, ...cursorDdl, ...FRAMEWORK_DDL_AFTER_CURSORS];
}

// One source for the DDL entries the reserved-name and table censuses scan.
// Returns a fresh array so callers may append their own entries without
// mutating the declarations (which stay frozen).
export function frameworkDeclarationEntries(): DdlEntry[] {
  return [
    ...frameworkDdlDeclarations().map((sql): DdlEntry => ({ source: 'framework DDL', sql })),
    { source: 'migration DDL', sql: MIGRATION_DDL },
    ...OPERATIONAL_LEDGER_DDL.map((sql): DdlEntry => ({ source: 'operational ledger DDL', sql })),
  ];
}
const CREATE_TABLE_NAME = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:]]|[^\]])+]|[A-Za-z_][A-Za-z0-9_]*)/iy;

// The physical object kinds a CREATE statement can declare. 'virtual-table' is
// a virtual table (a table in sqlite_master, but declared via CREATE VIRTUAL
// TABLE); it shares SQLite's relation namespace with tables and indexes.
export type ObjectKind = 'table' | 'index' | 'trigger' | 'virtual-table';

// A derived set of owned object names, grouped by kind.
export interface OwnedObjectSet {
  tables: string[];
  indexes: string[];
  triggers: string[];
  virtualTables: string[];
}

// CREATE [UNIQUE|VIRTUAL|TEMP] INDEX|TABLE|TRIGGER [IF NOT EXISTS] <name>.
const CREATE_OBJECT_NAME = /CREATE\s+(?:(UNIQUE|VIRTUAL|TEMP)\s+)?(INDEX|TABLE|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:]]|[^\]])+]|[A-Za-z_][A-Za-z0-9_]*)/iy;

function unquoteIdentifier(name: string): string {
  if (name.startsWith('"')) return name.slice(1, -1).replaceAll('""', '"');
  if (name.startsWith('`')) return name.slice(1, -1).replaceAll('``', '`');
  if (name.startsWith('[')) return name.slice(1, -1).replaceAll(']]', ']');
  return name;
}

function objectKindLabel(kind: keyof OwnedObjectSet): string {
  if (kind === 'virtualTables') return 'virtual table';
  return kind.slice(0, -1);
}

// Collect object names from DDL entries for the requested kinds, skipping SQL
// comments and quoted regions (the same scanner contract as
// collectTableNamesFromDdl, generalized to indexes/triggers/virtual tables).
// Within one call, a name repeated for the same kind is a hard error (a
// participant cannot declare one object twice).
export function collectObjectNamesFromDdl(
  entries: readonly DdlEntry[],
  kinds: { tables?: boolean; indexes?: boolean; triggers?: boolean; virtualTables?: boolean } = {},
): OwnedObjectSet {
  const want = {
    tables: kinds.tables ?? false,
    indexes: kinds.indexes ?? false,
    triggers: kinds.triggers ?? false,
    virtualTables: kinds.virtualTables ?? false,
  };
  const out: OwnedObjectSet = { tables: [], indexes: [], triggers: [], virtualTables: [] };
  const seen = new Map<string, string>();
  const push = (kind: keyof OwnedObjectSet, name: string, source: string): void => {
    const key = `${kind}\u0000${name.toLowerCase()}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(`duplicate ${objectKindLabel(kind)} declaration: ${name} (from ${prior} and ${source})`);
    }
    seen.set(key, source);
    out[kind].push(name);
  };
  for (const { source, sql } of entries) {
    const uncommented = stripSqlComments(sql);
    for (let index = 0; index < uncommented.length;) {
      const quote = uncommented[index];
      if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
        const closing = quote === '[' ? ']' : quote;
        index += 1;
        while (index < uncommented.length) {
          if (uncommented[index] === closing) {
            if (uncommented[index + 1] === closing) index += 2;
            else { index += 1; break; }
          } else index += 1;
        }
        continue;
      }
      CREATE_OBJECT_NAME.lastIndex = index;
      const match = CREATE_OBJECT_NAME.exec(uncommented);
      if (!match || (index > 0 && /[A-Za-z0-9_]/.test(uncommented[index - 1]))) {
        index += 1;
        continue;
      }
      const modifier = match[1];
      const keyword = match[2];
      const name = unquoteIdentifier(match[3]);
      if (keyword === 'TABLE') {
        if (modifier === 'VIRTUAL') {
          if (want.virtualTables) push('virtualTables', name, source);
        } else if (want.tables) {
          push('tables', name, source);
        }
      } else if (keyword === 'INDEX') {
        if (want.indexes) push('indexes', name, source);
      } else if (want.triggers) {
        push('triggers', name, source);
      }
      index = CREATE_OBJECT_NAME.lastIndex;
    }
  }
  return out;
}

export function stripSqlComments(sql: string): string {
  let result = '';
  let quote: string | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote === '[') {
      if (character === ']' && sql[index + 1] === ']') {
        result += ']]'; index += 1;
      } else {
        result += character;
        if (character === ']') quote = null;
      }
    } else if (quote) {
      if (character === quote && sql[index + 1] === quote) {
        result += quote + quote; index += 1;
      } else {
        result += character;
        if (character === quote) quote = null;
      }
    } else if (character === '-' && sql[index + 1] === '-') {
      while (index + 1 < sql.length && sql[index + 1] !== '\n') index += 1;
    } else if (character === '/' && sql[index + 1] === '*') {
      result += ' ';
      index += 1;
      while (index + 1 < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        if (sql[index] === '\n') result += '\n';
        index += 1;
      }
      if (index + 1 < sql.length) index += 1;
    } else {
      result += character;
      if (character === "'" || character === '"' || character === '`' || character === '[') quote = character;
    }
  }
  return result;
}

export interface DdlEntry {
  source: string;
  sql: string;
}

export function collectTableNamesFromDdl(entries: DdlEntry[]): string[] {
  const seen = new Map<string, string>();
  const names: string[] = [];
  for (const { source, sql } of entries) {
    const uncommented = stripSqlComments(sql);
    for (let index = 0; index < uncommented.length;) {
      const quote = uncommented[index];
      if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
        const closing = quote === '[' ? ']' : quote;
        index += 1;
        while (index < uncommented.length) {
          if (uncommented[index] === closing) {
            if (uncommented[index + 1] === closing) index += 2;
            else { index += 1; break; }
          } else index += 1;
        }
        continue;
      }
      CREATE_TABLE_NAME.lastIndex = index;
      const match = CREATE_TABLE_NAME.exec(uncommented);
      if (!match || (index > 0 && /[A-Za-z0-9_]/.test(uncommented[index - 1]))) {
        index += 1;
        continue;
      }
      const name = unquoteIdentifier(match[1]);
      const lower = name.toLowerCase();
      if (seen.has(lower)) {
        throw new Error(`duplicate framework table declaration: ${name} (from ${seen.get(lower)} and ${source})`);
      }
      seen.set(lower, source);
      names.push(name);
      index = CREATE_TABLE_NAME.lastIndex;
    }
  }
  return names;
}

export const frameworkTableNamesWithoutAuthCompile = Object.freeze([
  ...new Set([
    ...collectTableNamesFromDdl(frameworkDeclarationEntries().map((entry) => ({ source: entry.source, sql: entry.sql }))),
    ...FRAMEWORK_CURSOR_TABLE_NAMES,
    ...AUTH_TABLE_NAMES,
  ]),
]) as readonly string[];

// The reserved-framework-namespace registry (S2/A2, consideration #5): every
// object name the package may physically create — framework DDL tables and
// indexes, the cursor-schema tables, the migration table, and the auth entity
// main tables. All of it is derived from the declarations in THIS leaf module,
// so sqlite-schema.ts, the census and the DDL executor share one authority.
// Folded lower-case, like all SQLite identifier comparisons. The FULL registry
// (adding the auth entities' generated indexes/triggers, which require the auth
// compile graph) is extended in schema-table-census.ts.
export const frameworkReservedNamesWithoutAuthCompile: ReadonlySet<string> = Object.freeze(
  (() => {
    const all = collectObjectNamesFromDdl(frameworkDeclarationEntries(), {
      tables: true, indexes: true, triggers: true, virtualTables: true,
    });
    return new Set([
      ...all.tables,
      ...all.indexes,
      ...all.triggers,
      ...all.virtualTables,
      ...FRAMEWORK_CURSOR_TABLE_NAMES,
      ...AUTH_TABLE_NAMES,
      ...AUTH_COMPILED_OBJECT_NAMES,
    ].map((name) => name.toLowerCase()));
  })(),
);
