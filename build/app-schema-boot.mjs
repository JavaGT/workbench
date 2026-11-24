// app-schema-boot.ts — the two seams that turn an app declaration into a
// settled, validated SQLite schema.
//
// 1. `resolveDatabaseInput` discriminates the `db` option (path string, adapter
//    config, conforming adapter, pre-opened adapter, raw node/bun handle) and
//    resolves the blob-root layout the app will use. It never wraps or mutates
//    the handle; the caller owns `wrapDriver`.
// 2. `prepareAppSchema` runs the twelve-phase schema lifecycle in order —
//    declaration graph, DDL roots, side tables, migrations, maintenance,
//    indexes, plugins, validation — over the assembled app facade.
//
// Both seams are here so app.ts stays an assembly facade: the runtime behavior
// is identical, but the DB-input grammar and the boot lifecycle are readable as
// one concern each instead of two islands inside a 1300-line file.

import path from 'node:path';

import {
  openMemoryAdapter,
  openSqliteAdapter,

} from './sqlite-adapter.mjs';




import { runMigrations } from './migrations.mjs';
import { executeFrameworkDDL, generateDDL, generateSideTableDDL, generatedIndexNames } from './ddl.mjs';
import { runWorkbenchMigrations } from './workbench-migrations.mjs';
import { validateSchemaOwnedEntityTable } from './schema-entity-validation.mjs';
import { frameworkTableNames, declaredTableNames } from './schema-table-census.mjs';
import { buildOwnershipCensus } from './schema-census.mjs';
import { validateExactSchema } from './schema-exact-validation.mjs';
import { createSchemaReport } from './schema-report.mjs';
import { createSearchOwnedIndexCapability } from './index-capability.mjs';

import {
  SEARCH_STALENESS_TABLE_NAME,
  DERIVED_RESOURCE_TABLE_NAME,
  SCHEMA_MAINTENANCE_TABLE_NAME,
} from './operational-ledger-ddl.mjs';

// ---------------------------------------------------------------------------
// DB-input discrimination
// ---------------------------------------------------------------------------

// The `db` option may be a DbAdapterConfig (the app opens it via the sqlite
// adapter), a conforming DbAdapter (A1 contract: the app calls its async
// open() at the first boot boundary), a pre-opened adapter result
// (OpenedDatabase-shaped), a raw DatabaseSync/DbHandle, or a string ('<file>' /
// ':memory:'). Raw handles stay the wrapDriver path so tests passing
// DatabaseSync directly work unchanged; configs and strings route through the
// adapter, which owns the directory, locks it, and centralizes the PRAGMA layer.




                                                            











function isDbAdapterConfig(value         )                           {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value                           ;
  if (typeof candidate.prepare === 'function' || typeof candidate.open === 'function') {
    return false;
  }
  // A pre-opened adapter RESULT (handle + close + capabilities) is never a
  // config — even though an OpenedSqliteDatabase also declares `mode`, which
  // would otherwise make the config predicate swallow it here and shadow the
  // pre-opened branch below (review #93 finding 2).
  if (candidate.handle !== undefined && typeof candidate.close === 'function') {
    return false;
  }
  return candidate.mode !== undefined || candidate.directory !== undefined || candidate.name !== undefined;
}

function isDbAdapter(value         )                          {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value                           ;
  return typeof candidate.open === 'function' && typeof candidate.readMirror === 'function';
}

function isOpenedAdapter(value         )                                {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value                           ;
  return (
    candidate.handle !== undefined
    && typeof candidate.close === 'function'
    && candidate.capabilities != null
    && typeof candidate.capabilities === 'object'
  );
}

// Mutual overlap: `a` and `b` overlap when either contains the other. Used to
// refuse a blob root that sits inside the database-owned directory or vice
// versa (S1/A2 managed-path guard).
function pathsOverlap(a        , b        )          {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return ra === rb || ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep);
}

// Refuse a blob root overlapping the adapter-owned directory, in either
// direction. Called BEFORE the adapter opens so a refused configuration never
// leaks the OS-backed ownership lock.
function refuseBlobOverlap(ownedDirectory        , blobRoot               )       {
  if (blobRoot && pathsOverlap(blobRoot, ownedDirectory)) {
    throw new Error(
      `blobs.root '${blobRoot}' overlaps the database-owned directory '${ownedDirectory}'`,
    );
  }
}

// Resolve the blob root (S6/A2 relocation). The DEFAULT is ALWAYS the owned
// directory's managed `blobs/` subdirectory for a file-mode database — never
// the old `process.cwd()/.blobs` default. The guarantee is "inside the
// adapter-owned directory when one exists; beside the db file otherwise". An
// EXPLICIT `blobs.root` is the override, still refused on overlap. Memory
// databases resolve NO disk root at all — they use the in-memory fake byte
// store (S6/A1). Called before the adapter opens so a refusal never leaks the
// OS-backed ownership lock.
function resolveBlobRoot(ownedDirectory        , explicitRoot               )         {
  if (explicitRoot) {
    refuseBlobOverlap(ownedDirectory, explicitRoot);
    return explicitRoot;
  }
  return path.join(ownedDirectory, 'blobs');
}

// The managed staging directory for pending slots (S1/A2 vocabulary: `blobs/`
// and `staging/` are siblings under the owned directory). Only the managed
// DEFAULT uses it; an explicit root keeps the legacy single-root
// `<root>/<id>.pending` layout so existing deployments keep their on-disk files.
function managedStagingRoot(ownedDirectory        , explicitRoot               )                {
  return explicitRoot ? null : path.join(ownedDirectory, 'staging');
}











/**
 * Discriminate the `db` option and resolve the blob-root layout. This is the
 * whole construction guard: a configuration refused here has not opened an
 * adapter, so it cannot strand an OS-backed ownership lock.
 */
export function resolveDatabaseInput(db               , explicitBlobRoot               )                        {
  let openedDb                              = null;
  let openedHere = false;
  let pendingDbAdapter                        = null;
  let blobRoot                = explicitBlobRoot;
  let blobStagingRoot                = null;
  // A custom driver object is none of the recognized adapter/handle shapes but
  // is still a valid `db`: it stays on the wrapDriver path unchanged. The
  // branches below replace this only when they open or unwrap a concrete handle.
  let handle                  = (db !== null && typeof db === 'object') ? db             : null;

  // `db` is opened through the sqlite adapter unless a raw handle was supplied.
  // A string is a path (or ':memory:') the framework opens itself, so an app
  // never imports DatabaseSync just to hand the framework an instance it could
  // have opened from the same string. The adapter owns the directory, holds the
  // OS-backed ownership lock, runs the centralized PRAGMA layer, and checkpoints
  // on close (S1/A2).
  if (typeof db === 'string') {
    if (db === ':memory:') {
      openedDb = openMemoryAdapter();
    } else {
      blobRoot = resolveBlobRoot(path.dirname(db), explicitBlobRoot);
      blobStagingRoot = managedStagingRoot(path.dirname(db), explicitBlobRoot);
      openedDb = openSqliteAdapter({ directory: path.dirname(db), name: path.basename(db), mode: 'file' });
    }
    openedHere = true;
    handle = openedDb.handle;
  } else if (isDbAdapterConfig(db)) {
    if (db.mode === 'memory') {
      openedDb = openMemoryAdapter();
    } else {
      if (db.directory) {
        blobRoot = resolveBlobRoot(db.directory, explicitBlobRoot);
        blobStagingRoot = managedStagingRoot(db.directory, explicitBlobRoot);
      }
      openedDb = openSqliteAdapter({ ...db, mode: db.mode ?? 'file' });
    }
    openedHere = true;
    handle = openedDb.handle;
  } else if (isDbAdapter(db)) {
    // A conforming DbAdapter opens asynchronously (open() →
    // Promise<OpenedDatabase>), so construction cannot yield the handle
    // synchronously. The adapter is kept as the app's lifecycle owner and the
    // open is deferred: the caller's installPendingDb runs it at the first async
    // boundary (prepareSchema / ready / route boot). Adapter-backed apps should
    // await `app.ready` (or call start()/prepareSchema()) before listen() so the
    // transport captures a real db handle.
    pendingDbAdapter = db;
    const adapterRoot = db.root;
    if (adapterRoot === undefined) {
      // FAIL CLOSED: an adapter that does not declare `root` cannot prove it is
      // memory-mode, and silently treating it as memory would hand a
      // FILE-backed database an ephemeral in-memory byte store — a durability
      // regression. The adapter must declare its owned directory (file mode,
      // blobs root under it) or null (memory mode).
      throw new Error(
        'a conforming DbAdapter must declare its `root`: the owned directory for file mode '
          + '(the default blob store roots under it), or null for memory mode',
      );
    }
    if (adapterRoot) {
      blobRoot = resolveBlobRoot(adapterRoot, explicitBlobRoot);
      blobStagingRoot = managedStagingRoot(adapterRoot, explicitBlobRoot);
    }
    handle = null;
  } else if (isOpenedAdapter(db)) {
    openedDb = db;
    // FAIL CLOSED: a pre-opened database that does not declare its `root`
    // cannot prove it is memory-mode. Silently treating it as memory would hand
    // a FILE-backed database an ephemeral in-memory byte store — the same
    // durability regression the adapter guard above refuses.
    if (typeof openedDb.root === 'undefined') {
      throw new Error(
        'a pre-opened database must declare its `root`: the owned directory for file mode '
          + '(the default blob store roots under it), or null for memory mode',
      );
    }
    if (openedDb.root) {
      blobRoot = resolveBlobRoot(openedDb.root, explicitBlobRoot);
      blobStagingRoot = managedStagingRoot(openedDb.root, explicitBlobRoot);
    }
    handle = db.handle;
  } else if (db && typeof (db                                     ).location === 'function') {
    // A raw DatabaseSync / SqliteDatabase handle: classify memory vs file by
    // its location() (:memory: → null). A raw FILE handle has no adapter-owned
    // directory, so the default root sits beside the db file (a relative
    // location makes that dirname cwd-relative). A raw MEMORY handle keeps
    // only an explicit blobs.root (blobRoot is already null otherwise) — the
    // in-memory fake byte store (S6/A1).
    const location = (db                                            ).location();
    if (location != null && location !== '' && location !== ':memory:' && !location.startsWith('file::memory:')) {
      const owned = path.dirname(location);
      blobRoot = resolveBlobRoot(owned, explicitBlobRoot);
      blobStagingRoot = managedStagingRoot(owned, explicitBlobRoot);
    }
    handle = db;
  } else if (db && typeof (db                                     ).filename === 'string') {
    // A raw bun:sqlite Database handle exposes `.filename` rather than `.location()`.
    const filename = (db                                   ).filename;
    if (filename !== '' && filename !== ':memory:' && !filename.startsWith('file::memory:')) {
      const owned = path.dirname(filename);
      blobRoot = resolveBlobRoot(owned, explicitBlobRoot);
      blobStagingRoot = managedStagingRoot(owned, explicitBlobRoot);
    }
    handle = db;
  }

  return { db: handle, openedDb, openedHere, pendingDbAdapter, blobRoot, blobStagingRoot };
}

// ---------------------------------------------------------------------------
// Schema boot lifecycle
// ---------------------------------------------------------------------------



















export function observedSchemaObjects(db                                                                     ) {
  return db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')").all()
    .map((row) => ({
      type: (String(row.type) === 'table' && /^CREATE\s+VIRTUAL\s+TABLE/i.test(String(row.sql ?? '')) ? 'virtual-table' : String(row.type))                                                   ,
      name: String(row.name),
    }));
}

export function schemaObjectKey(object                                                  )         {
  return `${object.type}:${object.name.toLowerCase()}`;
}

function ownerDescription(census                                                      , name        , kind                                                  = 'table')         {
  const entry = census.get(`${kind}:${name.toLowerCase()}`)
    ?? (kind === 'table' ? census.get(`virtual-table:${name.toLowerCase()}`) : undefined);
  return entry ? `${entry.kind} "${entry.owner}" ${kind} "${name}"` : `undeclared ${kind} "${name}"`;
}

function quotedSqlLiteral(value        )         {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Run the twelve schema phases against a settled app. Every phase runs at most
 * once behind app.schemaReady (the caller caches the promise); this function is
 * the single boot algorithm for every transport and for headless tests.
 */
export async function prepareAppSchema({
  app,
  schema,
  declaredMigrations,
  verifyIntegrityOnBoot,
  state,
}                       )               {
  if (!app.db) throw new Error('cannot generate DDL — no db configured on the app');
  // Capture at the lifecycle boundary, rather than construction: callers may
  // alter the database after creating an app but before preparing it.
  state.schemaBeforeLifecycle = new Set(observedSchemaObjects(app.db).map(schemaObjectKey));
  // Phase 3: resolve declarations and validate the global ownership graph
  // before lifecycle DDL can alter the database.
  await app.resolveRoutes();
  state.registryLocked = true;
  const schemaTables = new Map             ((schema?.tables ?? []).map((table     ) => [table.name.toLowerCase(), table]));
  const entityMainTables = new Set([...app.entities.values()].map((entity) => entity.name.toLowerCase()));
  const generatedTables = new Set(declaredTableNames([...app.entities.values()]).map((name) => name.toLowerCase()));
  const registeredEntities = new Map([...app.entities.values()].map((entity) => [entity.name.toLowerCase(), entity]));
  const generatedIndexes = new Map();
  for (const entity of app.entities.values()) {
    for (const [fieldName, field] of Object.entries(entity.fields ?? {})                        ) {
      if (field?.physical !== true || field?.kind !== 'value' || field.type !== 'ref') continue;
      // String refs remain logical for compatibility with declarations whose
      // target is supplied outside this app. A string self ref is closed.
      const targetName = field.target?.name ?? (field.target === entity.name ? entity.name : null);
      if (!targetName) continue;
      const target = registeredEntities.get(String(targetName).toLowerCase());
      if (!target) {
        throw new Error(`entity '${entity.name}' field '${fieldName}' references unregistered Workbench entity '${String(targetName)}'`);
      }
      const targetSchema = schemaTables.get(target.name.toLowerCase());
      if (targetSchema) {
        const id = targetSchema.columns.find((column     ) => column.name.toLowerCase() === 'id');
        if (!id || String(id.type).toLowerCase() !== 'text' || id.primaryKey !== true) {
          throw new Error(`entity '${entity.name}' field '${fieldName}' ref target '${target.name}' must have a TEXT id primary key`);
        }
      }
    }
    for (const indexName of generatedIndexNames(entity)) {
      const key = indexName.toLowerCase();
      const prior = generatedIndexes.get(key);
      if (prior) throw new Error(`duplicate generated index '${indexName}' from ${entity.name} and ${prior}`);
      generatedIndexes.set(key, entity.name);
    }
  }
  for (const table of schema?.tables ?? []) {
    const name = table.name.toLowerCase();
    if (frameworkTableNames.some((frameworkName) => frameworkName.toLowerCase() === name)) {
      throw new Error(`schema table "${table.name}" conflicts with a framework table`);
    }
    if (generatedTables.has(name) && !entityMainTables.has(name)) {
      throw new Error(`schema table "${table.name}" conflicts with a generated entity side table`);
    }
  }
  const ownership = buildOwnershipCensus({
    schemaDeclarations: schema ? [schema] : [],
    entities: [...app.entities.values()],
    plugins: app.searchPlugins.ids().map((id        ) => {
      const plugin               = app.searchPlugins.get(id) ;
      return { id: plugin.id, ownedObjects: plugin.ownedObjects.map(({ kind, name }) => ({ kind, name })) };
    }),
  });
  if (ownership.errors.length > 0) throw new Error(ownership.errors[0].message);

  // Phase 4: framework bases. Phase 5 follows with ordinary/schema-owned
  // roots and entity roots, before any supporting storage or migrations.
  executeFrameworkDDL(app.db);
  if (schema) schema.prepare(app.db, { skipMigrations: true, skipIndexes: true });
  const seen = new Set();
  for (const entity of app.entities.values()) {
    if (!seen.has(entity.name)) {
      seen.add(entity.name);
      const declaration = schemaTables.get(entity.name.toLowerCase());
      if (declaration) {
        // The schema owns this root table; its Workbench side tables are
        // deliberately deferred to phase 6 below.
      } else {
        const root = generateDDL(entity)[0];
        if (root) app.db.exec(root);
      }
    }
  }

  // Phase 6: entity-generated supporting tables. These cannot precede
  // their roots, including roots declared by an application schema.
  for (const entity of app.entities.values()) {
    for (const sql of generateSideTableDDL(entity)) app.db.exec(sql);
  }

  // Phase 7: both migration lanes are transactional by contract. SQLite
  // itself refuses VACUUM in this lane; foreign_keys changes belong to the
  // explicit maintenance seam rather than a migration callback.
  await runWorkbenchMigrations(app.db);
  if (declaredMigrations.length) runMigrations(app.db, declaredMigrations);

  // Phase 8: non-transactional maintenance resumes after transactional
  // migrations. It has its own durable ledger and makes no atomicity claim.
  await app.schemaMaintenance.run();

  // Phase 9: indexes and declared constraints are installed only after
  // migrations can add/reshape their backing columns.
  if (schema) schema.prepare(app.db, { skipMigrations: true });
  if (schema) {
    for (const sql of schema.triggerDdl) app.db.exec(sql);
  }
  for (const entity of app.entities.values()) {
    for (const sql of generateDDL(entity).filter((statement) => /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement))) app.db.exec(sql);
  }

  // Phase 10: plugin-owned derived resources. CREATE IF NOT EXISTS makes a
  // settled reboot non-destructive, including declared triggers.
  if (schema) {
    for (const sql of schema.virtualTableDdl) app.db.exec(sql);
  }
  app.searchStaleness.engage(app.db);
  app.searchReconcile.engage(app.db);
  for (const id of app.searchPlugins.ids()) {
    const plugin               = app.searchPlugins.get(id) ;
    for (const object of plugin.ownedObjects) {
      const existing = app.db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE lower(name) = lower(?) AND type = ?",
      ).get(object.name, object.kind === 'virtual-table' ? 'table' : object.kind);
      if (!existing) for (const sql of object.ddl) app.db.exec(sql);
    }
  }
  await app.derivedResources.prepareAll();
  // Bind only after every plugin-owned object has been lifecycle-created
  // and the declaration census has succeeded. Plugin callbacks receive
  // this narrow capability, never the database handle.
  if (app.searchPlugins.size > 0) {
    app.searchPlugins.bindIndex(createSearchOwnedIndexCapability({
      db: app.db,
      census: ownership.census,
      writeCoordinator: app.writeCoordinator,
      fenceOf: (id) => app.searchPlugins.stateOf(id).fence,
    }));
  }
  for (const id of app.searchPlugins.ids()) {
    const prepared = await app.searchPlugins.prepare(id);
    if (!prepared.ok) throw new Error(`plugin "${id}" preparation failed: ${prepared.lastError?.message ?? 'unknown error'}`);
  }
  app.clock.add({
    name: 'search-reconcile', intervalMs: 1_000,
    fn: () => void app.searchReconcile.reconcileBatches().catch((err         ) => app.log.warn('system', 'search reconcile drain failed', { err })),
  });

  // Phase 11: reconcile stale derived resources before validation/admission.
  await app.derivedResources.reconcileBatches();
  await app.searchReconcile.reconcileBatches();

  // Phase 12: exact declaration drift, foreign-key consistency, and the
  // SQLite integrity check all run over the settled schema, never rows.
  for (const entity of app.entities.values()) {
    const declaration = schemaTables.get(entity.name.toLowerCase());
    if (declaration) {
      validateSchemaOwnedEntityTable(app.db, entity, declaration, {
        schemaName: schema?.name,
        census: ownership.census,
      });
    }
  }
  const settledOwnership = buildOwnershipCensus({
    schemaDeclarations: schema ? [schema] : [],
    entities: [...app.entities.values()],
    plugins: app.searchPlugins.ids().map((id        ) => {
      const plugin               = app.searchPlugins.get(id) ;
      return { id: plugin.id, ownedObjects: plugin.ownedObjects.map(({ kind, name }) => ({ kind, name })) };
    }),
    observed: observedSchemaObjects(app.db)
      .filter((object) => state.schemaBeforeLifecycle?.has(schemaObjectKey(object)) ?? true),
  });
  // Migrations intentionally own their DDL imperatively, and derived
  // resources may create SQLite artifacts lazily. They are lifecycle
  // participants when introduced during this boot, but an object that
  // predates the boot still has to be declared by the normal census.
  const settledCensus = new Map(settledOwnership.census);
  for (const object of observedSchemaObjects(app.db)) {
    const key = schemaObjectKey(object);
    if (state.schemaBeforeLifecycle?.has(key) || settledCensus.has(key)) continue;
    settledCensus.set(key, {
      kind: 'framework', owner: 'lifecycle', objectKind: object.type, name: object.name,
    });
  }
  state.latestSchemaReport = createSchemaReport(app.db, settledCensus);
  if (settledOwnership.errors.length > 0) throw new Error(settledOwnership.errors[0].message);
  // Census validation fails closed on a declared object absent from the live
  // schema — EXCEPT the three framework operational ledgers, which are
  // declared by OPERATIONAL_LEDGER_DDL but materialized lazily on first use.
  // A bridge that never fired legitimately leaves its table uncreated, so those
  // entries are checked only when actually present. Every other census entry
  // (schema, entity, plugin, framework DDL) must exist. Names come from the one
  // DDL source, never literals here.
  const presentSchemaObjects = new Set(observedSchemaObjects(app.db).map(schemaObjectKey));
  const lazyLedgerTables = new Set(
    [SEARCH_STALENESS_TABLE_NAME, DERIVED_RESOURCE_TABLE_NAME, SCHEMA_MAINTENANCE_TABLE_NAME]
      .map((name) => name.toLowerCase()),
  );
  const validationCensus = new Map(
    [...settledCensus].filter(([key, entry]) =>
      presentSchemaObjects.has(key)
      || !(entry.kind === 'framework' && entry.objectKind === 'table' && lazyLedgerTables.has(entry.name.toLowerCase()))),
  );
  const exactErrors = validateExactSchema(app.db, validationCensus, schema ? [schema] : [], { validateCensus: true })
    // A schema-owned entity root may legitimately carry a trigger that
    // belongs to a registered derived-resource plugin (A2 ownership).
    .filter((error) => settledCensus.get(`trigger:${error.name.toLowerCase()}`)?.kind !== 'plugin');
  if (exactErrors.length > 0) throw new Error(exactErrors[0].message);
  const foreignKeyErrors = app.db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyErrors.length > 0) {
    const violation = foreignKeyErrors[0]                           ;
    throw new Error(`${ownerDescription(settledCensus, String(violation.table))} has a foreign key violation`);
  }
  // Full per-table `PRAGMA integrity_check(table)` is O(DB size) and therefore
  // opt-in on cold boot (`verifyIntegrityOnBoot: true`); the fast foreign-key
  // check above and the adapter's fail-closed `PRAGMA quick_check` at open still
  // run by default. When enabled, run it once per census relation so a failure
  // always names its declared owner without exposing table data, skipping
  // lazily created tables that have not been materialized yet.
  if (verifyIntegrityOnBoot) {
    const presentObjects = new Set(observedSchemaObjects(app.db).map(schemaObjectKey));
    for (const entry of settledCensus.values()) {
      if (entry.objectKind !== 'table' && entry.objectKind !== 'virtual-table') continue;
      if (!presentObjects.has(schemaObjectKey({ type: entry.objectKind, name: entry.name }))) continue;
      const findings = app.db.prepare(`PRAGMA integrity_check(${quotedSqlLiteral(entry.name)})`).all()
        .flatMap((row                         ) => Object.values(row).filter((value)                  => typeof value === 'string' && value !== 'ok'));
      if (findings.length > 0) {
        throw new Error(`${ownerDescription(settledOwnership.census, entry.name, entry.objectKind)} failed SQLite integrity_check: ${findings[0]}`);
      }
    }
  }
  return app;
}
