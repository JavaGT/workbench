// The app assembly layer — Todo C (SPEC §3, §4, §6.2; ADR #20).
//
// `workbench()` is the default export: a chainable app. Assembly is TWO-PHASE.
// `app.mount(path, Entity)` RECORDS an ordered mount declaration and returns the
// app synchronously, so the fluent `app.mount(...).mount(...).listen()` chain is
// preserved. The concrete routing table is RESOLVED later by `resolveRoutes()`:
// it invokes each entity's `routes:(r, Entity)=>...` thunk with a route builder
// `r`, whose `r.resource()` declares the five CRUD verbs. The per-verb route
// gate is owned by the entity declaration (`gate: { list: allowAnonymous() }`)
// and resolved once at compile time through resolveRouteGate; `r.resource()`
// takes no gate arg — there is no per-mount override (AGENTS: one authorization
// story, not two places). Resolution is ASYNC — an
// entity's `routes` thunk may be `async` and dynamic-import a child module at
// wiring time (the parent/child lazy mount that breaks an import cycle without a
// second route-building path). The result is an INSPECTABLE routing table: a list
// of { method, path, verb, entity, gate } (CRUD) and { method, path, gate,
// handlers } (imperative) entries.
//
// This is the WIRING that connects a declared entity to its mounted routes with the
// two default-on auth layers intact — the route gate here, the row grant (the SQL
// scope + .can) still running on every verb downstream. There is no second auth
// path: this layer decides route admission, never row visibility.
//
// `.listen(port)` finalizes (resolveRoutes) and then opens the real node:http
// socket; it returns the app synchronously (chainable) and exposes the boot as
// `app.ready`. The server never serves a partial table — resolution completes
// before the request handler is created.

import { listen as serveListen } from './serve.mjs';
import {
  maintenanceDefaults,
  startApplication,
  validateMaintenanceOptions,
} from './application-runtime.mjs';
import { buildReadMirrorDescription, wrapDriver } from './driver.mjs';
import {
  openMemoryAdapter,
  openSqliteAdapter,
  SQLITE_DATA_FILENAME,

} from './sqlite-adapter.mjs';










import { executeFrameworkDDL, generateDDL, generateSideTableDDL, generatedIndexNames } from './ddl.mjs';
import { runMigrations, validateMigrations } from './migrations.mjs';
import { runWorkbenchMigrations } from './workbench-migrations.mjs';
import { validateSchemaOwnedEntityTable } from './schema-entity-validation.mjs';
import { frameworkTableNames, declaredTableNames } from './schema-table-census.mjs';
import { createBlobStore } from './blob-store.mjs';
import { memoryBlobs } from './memory-blobs.mjs';
import { createBlobSeams } from './blob-seams.mjs';
import { retentionMs } from './blob-retention.mjs';
import { createRecycleManager, recycleManagerBinSeam } from './backup/recycle.mjs';
import { createJobQueue } from './job-queue.mjs';
import { createSearchPluginRegistry,                   } from './search-plugin.mjs';
import { createSearchOwnedIndexCapability } from './index-capability.mjs';
import { createSearchStalenessBridge } from './search-staleness.mjs';
import { createSearchReconcileEngine } from './search-reconcile.mjs';
import { createPostCommitEffectRunner } from './post-commit-effects.mjs';
import { createClock } from './clock.mjs';
import { createWriteQueue } from './write-queue.mjs';
import { createMaintenanceSeam } from './maintenance.mjs';
import { createSchemaMaintenanceRunner } from './schema-maintenance.mjs';
import { attachStorageEnvelopePolicy } from './storage-envelope.mjs';
import { createDerivedResourceRegistry } from './derived-resource.mjs';
import { createPrincipalSnapshotTransaction } from './principal-snapshot-transaction.mjs';
import { prepareGracefulShutdown } from './lifecycle.mjs';
import { createLog, withLog } from './log.mjs';
import { serveStatic,                         } from './views.mjs';
import { authRoutes } from './auth/routes.mjs';
import { attachApplicationLiveDelivery } from './application-live-delivery.mjs';
import { User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor } from './auth/entities.mjs';
import { config, resolveConfig } from './config.mjs';
import { buildOwnershipCensus } from './schema-census.mjs';
import { validateExactSchema } from './schema-exact-validation.mjs';
import { createSchemaReport } from './schema-report.mjs';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { makeMountable } from './router.mjs';


































const publicWorkbenchOptionsAreCovered                                   = true;
void publicWorkbenchOptionsAreCovered;

function isByteStore(value                               )                     {
  return typeof (value                              ).writePending === 'function';
}

function observedSchemaObjects(db                                                                     ) {
  return db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')").all()
    .map((row) => ({
      type: (String(row.type) === 'table' && /^CREATE\s+VIRTUAL\s+TABLE/i.test(String(row.sql ?? '')) ? 'virtual-table' : String(row.type))                                                   ,
      name: String(row.name),
    }));
}

function schemaObjectKey(object                                                  )         {
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

// router(opts) — a mini-app mounted bare into a parent app with
// `app.mount(path, router)`. `{ mergeParams: true }` lets a child read a parent
// path param. A router resolves its routes relative to its own base ('/') and is
// re-based when mounted.
export function router(options      = {}) {
  const mergeParams = options.mergeParams === true;
  const surface = makeMountable({ mergeParams });
  // A router is a reusable declaration blueprint. Each parent application
  // resolves a private instance with that application's entity registry, so a
  // cached route can never retain another application's database-bound facade.
  surface.resolveFor = async (entityOf     ) => {
    const instance = makeMountable({ mergeParams, entityOf });
    instance.declarations.push(...surface.declarations);
    await instance.resolveRoutes();
    return instance.routes;
  };
  return surface;
}

// The `db` option may be a DbAdapterConfig (the app opens it via the sqlite
// adapter), a conforming DbAdapter (A1 contract: the app calls its async
// open() at the first boot boundary), a pre-opened adapter result
// (OpenedDatabase-shaped), a raw DatabaseSync/DbHandle, or a string ('<file>' /
// ':memory:'). Raw handles stay the wrapDriver path so ~29 test files passing
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

// A conforming, BOUND adapter (src/db-adapter.ts A1 contract): async open() +
// readMirror(). `createSqliteAdapter(config)` returns exactly this shape — the
// config was captured at creation, so open() takes no argument (a zero-arg
// implementation satisfies the DbAdapter interface's `open(config)`). It is NOT
// a handle and must never reach wrapDriver. Detection is by SHAPE (not a
// registry), so a future non-SQLite backend is expressible without framework
// changes. It cannot be opened synchronously, so workbench defers the open to
// the first boot boundary (see installPendingDb below).




                                                            








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
// the old `process.cwd()/.blobs` default (flagged by the S7 audit and removed
// by this ticket). The guarantee is "inside the adapter-owned directory when
// one exists; beside the db file otherwise" — for a RELATIVE database path the
// owned directory itself is cwd-relative (e.g. db: 'app.db' roots blobs at
// cwd/blobs), which is fine: it is the owned directory's managed subdirectory,
// not an unrelated cwd/.blobs default. An EXPLICIT `blobs.root` is the
// override, still refused on overlap with the owned directory (refuse-vs-place
// preserved from S1/A2). Memory databases resolve NO disk root at all — they
// use the in-memory fake byte store (S6/A1). Called before the adapter opens
// so a refusal never leaks the OS-backed ownership lock.
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

// workbench() — the default export. A chainable app. `.mount(path, Entity)`
// resolves and accumulates routes; `.listen(port, options)` opens a real
// node:http server serving the resolved routing table and returns the app
// (chainable). The server is exposed on `app.httpServer`. `options.principalOf`
// overrides the request→principal source (default: anonymous, fail-closed). Both
// chain.
export default function workbench({
  db,
  schema,
  entities = [],
  actions = [],
  blobs: blobOpts,
  requireEnv = [],
  migrations = [],
  maintenanceSteps = [],
  derivedResources = [],
  jobs: jobOpts,
  log: logOpts,
  port,
  env,
  session,
  viewsDir,
  resolveScope,
  scopeSnapshot,
  history,
  blobReapIntervalMs = maintenanceDefaults.blobReapIntervalMs,
  blobReapTtlMs = maintenanceDefaults.blobReapTtlMs,
  logRetentionDays = maintenanceDefaults.logRetentionDays,
  logRetentionIntervalMs = maintenanceDefaults.logRetentionIntervalMs,
  resultDataRetentionDays = maintenanceDefaults.resultDataRetentionDays,
  payloadCompressionMinBytes = maintenanceDefaults.payloadCompressionMinBytes,
  blobRetention = maintenanceDefaults.blobRetention,
  blobLowDiskHeadroomBytes = maintenanceDefaults.blobLowDiskHeadroomBytes,
  operationalConsumers = [],
  blobLifecycle,
  blobRecycle,
}                   = {}) {
  // envGate (cso #15): fail-closed at app construction — required env vars must be set.
  for (const v of requireEnv) {
    const val = process.env[v];
    if (!val) {
      throw new Error(`missing required env: ${v}`);
    }
  }
  // The blob-root layout the app will use (a conforming injected byte store has
  // no root we can see). Computed once up front so the managed-path guard can
  // refuse an EXPLICIT blobs.root overlap BEFORE the adapter opens — an overlap
  // thrown after opening would leak the OS-backed ownership lock (S1/A2). For a
  // FILE-mode database the DEFAULT is ALWAYS the owned directory's managed
  // `blobs/` (+ `staging/` for pending slots) — the guaranteed placement is
  // "inside the adapter-owned directory when one exists; beside the db file
  // otherwise" (S6/A2 relocation). A relative database path makes that owned
  // directory cwd-relative, so the root is cwd-relative in that case; it is
  // never the retired unrelated cwd/.blobs default. `blobRoot` stays null only
  // for a memory database with no explicit blobs config: those get the
  // in-memory fake byte store (S6/A1).
  const explicitBlobRoot = blobOpts
    && !isByteStore(blobOpts)
    && blobOpts.root
    ? blobOpts.root
    : null;
  let blobRoot                = explicitBlobRoot;
  let blobStagingRoot                = null;
  // `db` is opened through the sqlite adapter unless a raw DatabaseSync/DbHandle
  // was supplied (or a conforming DbAdapter — A1 contract — whose async open is
  // deferred to the first boot boundary). A string is a path (or ':memory:') the
  // framework opens itself, so an app never imports DatabaseSync just to hand
  // the framework an instance it could have opened from the same string. The
  // adapter owns the directory, holds the OS-backed ownership lock, runs the
  // centralized PRAGMA layer, and checkpoints on close (S1/A2).
  //
  // The whole construction is guarded: if any later step (schema validation,
  // migration checks, entity binding, blob store, job queue) throws, an adapter
  // opened HERE is closed again so the refused app cannot strand its ownership
  // lock / database handle (review #81).
  let openedDb                              = null;
  let openedHere = false;
  let pendingDbAdapter                        = null;
  let installPendingDb                                  = null;
  try {
    if (typeof db === 'string') {
      if (db === ':memory:') {
        openedDb = openMemoryAdapter();
      } else {
        blobRoot = resolveBlobRoot(path.dirname(db), explicitBlobRoot);
        blobStagingRoot = managedStagingRoot(path.dirname(db), explicitBlobRoot);
        openedDb = openSqliteAdapter({ directory: path.dirname(db), name: path.basename(db), mode: 'file' });
      }
      openedHere = true;
      db = openedDb.handle;
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
      db = openedDb.handle;
    } else if (isDbAdapter(db)) {
      // A conforming DbAdapter opens asynchronously (open() →
      // Promise<OpenedDatabase>), so construction cannot yield the handle
      // synchronously. The adapter is kept as the app's lifecycle owner and the
      // open is deferred: installPendingDb (below) runs it at the first async
      // boundary (prepareSchema / app.ready / route boot) and installs the
      // handle plus the handle-bound resources. Adapter-backed apps should
      // await `app.ready` (or call start()/prepareSchema()) before listen() so
      // the transport captures a real db handle. The sqlite adapter exposes its
      // owned root (`root`, null for memory) so the blob-root guard still runs
      // before the deferred open.
      pendingDbAdapter = db;
      const adapterRoot = (db                  ).root;
      if (adapterRoot === undefined) {
        // FAIL CLOSED (review #93 finding 1): an adapter that does not declare
        // `root` cannot prove it is memory-mode, and silently treating it as
        // memory would hand a FILE-backed database an ephemeral in-memory byte
        // store — a durability regression. The adapter must declare its owned
        // directory (file mode, blobs root under it) or null (memory mode).
        throw new Error(
          'a conforming DbAdapter must declare its `root`: the owned directory for file mode '
            + '(the default blob store roots under it), or null for memory mode',
        );
      }
      if (adapterRoot) {
        blobRoot = resolveBlobRoot(adapterRoot, explicitBlobRoot);
        blobStagingRoot = managedStagingRoot(adapterRoot, explicitBlobRoot);
      }
      db = null;
    } else if (isOpenedAdapter(db)) {
      openedDb = db;
      // FAIL CLOSED (review #93 finding 2): a pre-opened database that does not
      // declare its `root` cannot prove it is memory-mode. Silently treating it
      // as memory would hand a FILE-backed database an ephemeral in-memory byte
      // store — the same durability regression the adapter guard above refuses.
      // The opened result must declare its owned directory (file mode, the
      // default blob store roots under it) or null (memory mode).
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
      db = db.handle;
    } else if (db && typeof (db                                     ).location === 'function') {
      // A raw DatabaseSync handle: classify memory vs file by its location()
      // (:memory: → null). A raw FILE handle has no adapter-owned directory, so
      // the default root sits beside the db file (a relative location makes that
      // dirname cwd-relative). A raw MEMORY handle keeps only an explicit
      // blobs.root (blobRoot is already null otherwise) — the in-memory fake
      // byte store (S6/A1).
      const location = (db                                            ).location();
      if (location != null) {
        const owned = path.dirname(location);
        blobRoot = resolveBlobRoot(owned, explicitBlobRoot);
        blobStagingRoot = managedStagingRoot(owned, explicitBlobRoot);
      }
    }
    // Wrap the raw handle with the driver contract helpers (txn/begin/commit/
    // rollback/upsert) and run the thin PRAGMA bootstrap. A conforming custom
    // driver (already providing txn+upsert) is passed through untouched — it owns
    // its own bootstrap. The driver IS the raw handle with helpers attached, so
    // `app.db.prepare` keeps working — entity code and tests reach it everywhere.
    // One construction path: a bare-string app gets the same treatment as a
    // pre-built handle. (seam-review §2.1, priority #7.)
    if (db) db = wrapDriver(db);
    // The final ownership census distinguishes objects created by this schema
    // lifecycle from undeclared objects that predate it.
    let schemaBeforeLifecycle                     = null;

    if (schema !== undefined && (!schema || typeof schema.prepare !== 'function' || !Array.isArray(schema.tables))) {
      throw new TypeError('schema must be a SqliteSchemaResult');
    }
    // Namespaced migrations (S2/A4, workbench#90): schema-declared and
    // app-declared migrations share the (namespace, version) ledger; two
    // namespaces may use the same version. validateMigrations fails closed on
    // reserved-namespace impersonation, duplicates, gaps, and dependency
    // syntax before any DDL or migration executes.
    const declaredMigrations = [...migrations, ...(schema?.migrations ?? [])];
    validateMigrations(declaredMigrations);

    const declarationsByName = new Map();
    const bindingsByDeclaration = new Map();
    const bindingsByName = new Map();
    const ownedBindings = new WeakSet();
    let registryLocked = false;
    const runtime = {
      db,
      batch(...args       ) {
        return app.batch(...args);
      },
      entityOf(value     ) {
        if (ownedBindings.has(value)) return value;
        if (value?.runtime) {
          throw new Error(`entity '${value.name ?? 'unknown'}' belongs to a different application`);
        }
        const declaration = typeof value === 'string' ? declarationsByName.get(value) : value;
        if (!declaration || typeof declaration.bind !== 'function') {
          const label = typeof value === 'string' ? `'${value}'` : String(value);
          throw new Error(`entity ${label} is not registered with this application`);
        }
        const existing = declarationsByName.get(declaration.name);
        if (existing && existing !== declaration) {
          throw new Error(`entity name '${declaration.name}' is already registered with a different declaration`);
        }
        if (!existing && registryLocked) {
          throw new Error(`cannot register entity '${declaration.name}' after the application schema is prepared`);
        }
        declarationsByName.set(declaration.name, declaration);
        if (!bindingsByDeclaration.has(declaration)) {
          const bound = declaration.bind(runtime);
          bindingsByDeclaration.set(declaration, bound);
          bindingsByName.set(declaration.name, bound);
          ownedBindings.add(bound);
        }
        return bindingsByDeclaration.get(declaration);
      },
    };
    const app      = makeMountable({ entityOf: runtime.entityOf });
    app.actions = Object.freeze([...actions]);
    app.operationalConsumers = Object.freeze([...operationalConsumers]);
    app.dispatch = async () => {
      throw new Error('application is not started; call start() before dispatching');
    };
    app.batch = async () => {
      throw new Error('application is not started; call start() before batching');
    };
    app.entity = runtime.entityOf;
    app.register = (...declared       ) => {
      for (const declaration of declared.flat()) runtime.entityOf(declaration);
      return app;
    };
    app.register(entities);
    for (const frameworkEntity of [User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor]) {
      if (!declarationsByName.has(frameworkEntity.name)) runtime.entityOf(frameworkEntity);
    }
    app.entities = bindingsByName;
    // The search plugin registry (S4/A1): declarations are validated at
    // registration (duplicate id, unknown owned-object kind, non-compilable
    // source scope, contract-version compatibility). Plugins never receive a
    // raw handle — only a scoped source reader over their declared interests.
    // S2 owns the schema-lifecycle wiring (binding the source + owned-object
    // DDL) in this file; this hunk registers the surface only.
    app.searchPlugins = createSearchPluginRegistry();
    app.registerSearchPlugin = (plugin              ) => {
      app.searchPlugins.register(plugin);
      // Bind the CURRENT handle when one exists. An adapter-backed app's db is
      // null until the deferred open lands; installPendingDb binds every
      // registered plugin to the handle when that open completes, so a plugin
      // registered before start() still gets a bound reader after ready.
      if (app.db) app.searchPlugins.bindSource(app.db);
      return app;
    };
    // The search staleness + invalidation bridge (S4/A2): the durable,
    // coalescible ledger and priority dispatch that turns registered source
    // changes and S5/A5 revocations into post-commit invalidation work. S3 owns
    // the post-commit plumbing in this file that FEEDS the bridge (kernel post-
    // commit consumers call app.searchStaleness.notifySourceChange / register
    // the onRevocation listener); this hunk registers the surface and engages
    // it with the app handle (attachHandleResources below).
    app.searchStaleness = createSearchStalenessBridge({ registry: app.searchPlugins });
    // Coarse recovery scopes (for example `project:p1`) must resolve to a normal
    // entity row. Snapshot, replay, and later live admission can then share the
    // existing row-scope + grant engine instead of trusting transport callbacks.
    app.resolveScope = resolveScope;
    app.scopeSnapshot = scopeSnapshot;
    app._history = history;
    // Per-app config — options override env fallbacks (SPEC §3). `app.config` is
    // the one place a mounted route / transport reads this app's port, env,
    // viewsDir, and session duration instead of the process-wide singleton. An
    // option left absent behaves exactly like the singleton (env-sourced
    // defaults), so an app that sets nothing still runs.
    app.config = resolveConfig({ port, env, session, viewsDir });
    // Logging is an application-owned runtime resource. Constructing another
    // application must not replace the logger used by this one.
    // Callers pass `workbench({ log: { level: 'debug', channels: {...} } })`.
    app.log = createLog(logOpts);
    app.log.info('system', 'workbench() constructed', { db: !!db, jobs: !!jobOpts, migrations: migrations.length });
    // The DB handle is an app-level resource, supplied once at construction and
    // read by every transport (HTTP now, WS /events later) — not a per-transport
    // listen option (DECISIONLOG: the SQLite handle lives on the app because
    // persistence is shared infrastructure; durability still follows the engaged
    // dispatch seam, not this field). An app with no db simply cannot serve
    // DB-backed entity CRUD — fail closed at dispatch. For an adapter-backed app
    // the handle is null until the deferred open installs it (A1 contract).
    app.db = db;
    // When the app opened the database through the adapter, the adapter is the
    // app's lifecycle owner (shutdown checkpoints + closes it) and its managed-
    // path predicate guards static serving below. A conforming DbAdapter (A1
    // contract) fills the same role before its deferred open completes; the
    // opened database replaces it once installed.
    app._dbAdapter = pendingDbAdapter ?? openedDb;
    // Public lifecycle inspection without exposing the application-integrated
    // delivery transport object. The test protocol is the same authority used
    // by the HTTP and WebSocket skins.
    app.delivery = Object.freeze({
      get attached() {
        return Boolean(app._applicationLiveDelivery);
      },
      get test() {
        return app._applicationLiveDelivery?.delivery ?? null;
      },
    });
    app._isManagedPath = pendingDbAdapter
      ? pendingDbAdapter.isManagedPath
      : openedDb ? openedDb.isManagedPath : undefined;
    // The controlled read-mirror description (S1/A5). External readers open it
    // with openReadMirror (read-mirror.ts), which enforces mode=ro at the
    // engine AND via a query-class rejector. The description never carries a
    // write path. A conforming adapter's own readMirror() wins; the default
    // sqlite adapter's opened database is described from its owned directory +
    // the fixed data filename (the physical path is never handed to the app
    // directly). A raw handle has no controlled description — fail closed.
    app.readMirror = () => {
      const adapter = app._dbAdapter;
      if (adapter && typeof adapter.readMirror === 'function') {
        return adapter.readMirror();
      }
      if (openedDb?.mode === 'file' && openedDb.root) {
        return buildReadMirrorDescription(path.join(openedDb.root, SQLITE_DATA_FILENAME));
      }
      if (openedDb?.mode === 'memory') {
        return buildReadMirrorDescription(':memory:');
      }
      throw new Error(
        'readMirror() requires an adapter-backed database — a raw handle has no controlled read-mirror description',
      );
    };
    app.schema = schema;
    app._maintenance = validateMaintenanceOptions({
      blobReapIntervalMs,
      blobReapTtlMs,
      logRetentionDays,
      logRetentionIntervalMs,
      resultDataRetentionDays,
      payloadCompressionMinBytes,
      blobRetention: blobRetention                                            ,
      blobLowDiskHeadroomBytes,
    });
    // The shared clock is the single timer for all framework reapers (schedule,
    // tick, job-queue lease, blob, log-retention, job-worker polls). Created once
    // at app construction so the job queue and later serve.mjs share it. The
    // write queue and principal-snapshot transaction are created here too — the
    // handle-bound resources below need the clock (job queue), and shutdown
    // reads the write queue.
    const clock = createClock();
    app.clock = clock;
    // The one platform write coordinator (S1/A5): every write category enters
    // through `run`. `app.writeCoordinator` is the formal name; `app.writeQueue`
    // is the same object (kept for the transport/kernel seams that already
    // reference it) — one mutex, never a second one.
    app.writeQueue = createWriteQueue();
    app.writeCoordinator = app.writeQueue;
    app.releaseUnstartedDatabase = () => {
      if (app._startPromise || app._startupMode || app._transportAttached || app.httpServer) {
        throw new Error('releaseUnstartedDatabase() is only valid before application startup');
      }
      if (app.writeQueue.running || app.writeQueue.depth > 0) {
        throw new Error('releaseUnstartedDatabase() requires an idle write queue');
      }
      if (app._databaseReleased) return app;

      const owned = app._dbAdapter;
      if (owned && typeof owned.close === 'function') {
        owned.close();
      } else if (app.db && typeof app.db.close === 'function') {
        app.db.close();
      }
      app._databaseReleased = true;
      app._dbAdapter = null;
      app.db = null;
      runtime.db = null;
      return app;
    };
    // Reconciliation materialization (S4/A2 drain) routes through the ONE write
    // coordinator, serializing plugin-owned index writes with authoritative
    // writes (consideration #9).
    app.searchStaleness.bindWriteQueue(app.writeCoordinator);
    // A3's bounded drain uses the same ledger and coordinator as A2. The clock
    // owns retries, so a retained record is retried without an HTTP write path.
    app.searchReconcile = createSearchReconcileEngine({
      registry: app.searchPlugins,
      staleness: app.searchStaleness,
      writeQueue: app.writeCoordinator,
    });
    // OWNERSHIP BINDING (S1/A3 backup, review #82 finding 2): the adapter-opened
    // source declares the SAME coordinator as the app — so a backup manager
    // built over `app.writeCoordinator` + the app's opened source
    // (`createBackupManager({ source: app._dbAdapter, writeCoordinator:
    // app.writeCoordinator })`) works without manual mutation, while a
    // coordinator bound to any DIFFERENT source still refuses at construction.
    // The app opened the db BEFORE this coordinator existed, so the binding
    // fills it in now that the coordinator is real.
    if (openedDb) openedDb.writeCoordinator = app.writeCoordinator;
    // The shared-state PRAGMA maintenance seam (S1/A5): withForeignKeysDisabled
    // runs inside a coordinated write turn and restores foreign_keys = ON even
    // on throw. The app db may arrive later (deferred adapter open), so the
    // seam resolves the handle at call time and fails closed without one.
    app.withForeignKeysDisabled = createMaintenanceSeam(
      () => app.db ?? null,
      app.writeCoordinator,
    ).withForeignKeysDisabled;
    app.schemaMaintenance = createSchemaMaintenanceRunner({
      db: () => app.db ?? null,
      steps: maintenanceSteps,
      writeCoordinator: app.writeCoordinator,
    });
    app.derivedResources = createDerivedResourceRegistry({
      db: () => app.db ?? null,
      writeCoordinator: app.writeCoordinator,
    });
    for (const resource of derivedResources) app.derivedResources.register(resource);
    const principalSnapshotRuntime = createPrincipalSnapshotTransaction(app);
    app.principalSnapshots = { transaction: principalSnapshotRuntime.transaction };
    app._principalSnapshotRuntime = principalSnapshotRuntime;
    // The blob store is an app-level resource, constructed when a db is engaged
    // (blobs are adopted by dispatch commits — no db, no durable kernel, no
    // blobs). With no blobs config, a FILE-mode app's byte store roots under
    // the owned directory's managed `blobs/` + `staging/` pair (S6/A2
    // relocation; the old cwd/.blobs default was retired). The guaranteed
    // placement is "inside the adapter-owned directory when one exists; beside
    // the db file otherwise" — a relative database path makes that directory
    // cwd-relative, which is the owned root, not an unrelated cwd/.blobs
    // default. A MEMORY database gets the in-memory fake byte store (S6/A1).
    // One store, reached by the /blobs upload route AND the kernel's blob
    // adopter — not a second persistence path.
    //
    // SEAM (seam-review §2.2): `blobs` may be either an options bag (`{ root }`,
    // back-compat — the framework builds fsBlobs internally; the root is
    // refused on overlap with the owned directory) OR a conforming byte-store
    // object (e.g. `fsBlobs({...})` or a future `s3Blobs({...})`). Detection is
    // by SHAPE, not type: a byte store exposes `writePending` (the signature
    // method of the byte-store interface); an options bag does not. The
    // framework OWNS metadata + lifecycle; only the byte half swaps.
    //
    // attachHandleResources builds the handle-bound resources (blob store,
    // post-commit effects, job queue). It runs at construction for a
    // synchronously-opened db and is DEFERRED to the open for an adapter-backed
    // app (installPendingDb below).
    const attachHandleResources = (handle     )       => {
      // Gzip storage envelopes (storage-envelope.ts): the handle's write
      // policy travels with the handle so committed-log write/read seams see
      // one storage decision. 0 (the default) attaches nothing — every stored
      // byte is exactly the legacy format.
      attachStorageEnvelopePolicy(
        handle,
        app._maintenance.payloadCompressionMinBytes > 0
          ? { minBytes: app._maintenance.payloadCompressionMinBytes }
          : null,
      );
      // S6/A5 #5: the app's low-disk headroom travels with the store so the
      // /blobs upload route and the pending-blob stage both refuse new uploads
      // below the threshold (fail closed on an undeclaring durable backend).
      const blobStoreOptions = { lowDiskHeadroomBytes: app._maintenance.blobLowDiskHeadroomBytes };
      if (blobOpts && isByteStore(blobOpts)) {
        app.blobs = createBlobStore({ db: handle, bytes: blobOpts, ...blobStoreOptions });
      } else if (blobRoot) {
        // `blobRoot` was already refused (explicit) or resolved to the owned
        // directory's managed `blobs/` before the adapter opened (managed-path
        // guard, S1/A2; relocation, S6/A2). A managed default also carries the
        // owned directory's `staging/` root for pending slots.
        mkdirSync(blobRoot, { recursive: true });
        if (blobStagingRoot) mkdirSync(blobStagingRoot, { recursive: true });
        app.blobs = createBlobStore({
          root: blobRoot,
          ...(blobStagingRoot ? { stagingRoot: blobStagingRoot } : {}),
          db: handle,
          ...blobStoreOptions,
        });
      } else {
        // Memory database with no explicit blobs config: the in-memory fake
        // byte store (S6/A1) — never a disk root, never cwd/.blobs.
        app.blobs = createBlobStore({ db: handle, bytes: memoryBlobs(), ...blobStoreOptions });
      }
      app.postCommitEffects = createPostCommitEffectRunner({ db: handle });
      // The staleness ledger (S4/A2) is engaged with the SAME handle: durable
      // pending-staleness survives restart and re-processes via drain().
      app.searchStaleness.engage(handle);
      app.searchReconcile.engage(handle);
      // The queue routes its multi-statement mutations through the ONE write
      // coordinator (job-queue.ts's writeQueue option); a post-commit consumer
      // calling enqueue from inside a dispatch turn joins that turn.
      if (jobOpts) app.jobs = createJobQueue({ db: handle, clock, ...jobOpts, writeQueue: app.writeCoordinator });
    };
    if (db) attachHandleResources(db);
    // The blob seams (S6/A6, workbench#97): backup, recovery, and recycle all
    // consume the SAME concrete seam over the app's compiled census + blob
    // store. Lazily constructed so the compiled census (kernel) and the
    // handle-bound blob store exist by the time a manager is built. Fails
    // closed without an opened database, blob store, or compiled census.
    app.createBlobSeams = () => {
      if (!app.db) {
        throw new Error('createBlobSeams requires an opened database — await app.ready or call prepareSchema()/start() first');
      }
      if (!app.blobs) {
        throw new Error('createBlobSeams requires the app blob store (app.blobs)');
      }
      if (!app.blobCensus) {
        throw new Error('createBlobSeams requires the compiled blob census (app.blobCensus) — build the kernel first via prepareSchema()/start()');
      }
      return createBlobSeams({ db: app.db, blobs: app.blobs, census: app.blobCensus });
    };
    // The S1/A6 recycle manager (S6/A5 #4): the `blobRecycle: { root }` option
    // constructs the recycle manager over the SAME concrete blob seams the
    // app's createBlobSeams exposes, so binning resolves the exact backup file
    // names the backup materializer wrote. Built lazily (the compiled census +
    // blob store must exist), then surfaced as app.blobRecycleSeam so the
    // reaper AND the pending-blob delete path route replaced/deleted
    // generations through the recycling bin BEFORE live bytes are removed.
    app._blobRecycle = blobRecycle;
    app.createRecycleManager = () => {
      if (!app._blobRecycle) throw new Error('blobRecycle is not configured');
      if (!app.db) {
        throw new Error('createRecycleManager requires an opened database — await app.ready or call prepareSchema()/start() first');
      }
      if (!app.blobs) {
        throw new Error('createRecycleManager requires the app blob store (app.blobs)');
      }
      if (!app.blobCensus) {
        throw new Error('createRecycleManager requires the compiled blob census (app.blobCensus) — build the kernel first via prepareSchema()/start()');
      }
      const seams = app.createBlobSeams();
      return createRecycleManager({
        root: app._blobRecycle.root,
        blobs: seams,
        // The named 'backup-retention' policy (S6/A5 #21) is the single source
        // for how long the bin holds generation copies before the expiry sweep
        // trims them (ms → whole days, floored at the 1-day minimum).
        retentionDays: Math.max(1, Math.round(retentionMs(app._maintenance.blobRetention, 'backup-retention') / 86_400_000)),
      });
    };
    app.assembleBlobRecycleSeam = () => {
      if (!app._blobRecycle || app.blobRecycleSeam) return;
      app.blobRecycleSeam = recycleManagerBinSeam(app.createRecycleManager());
    };
    if (pendingDbAdapter) {
      const adapter = pendingDbAdapter;
      installPendingDb = (() => {
        let opening                          = null;
        return () => {
          if (!opening) {
            // A1 contract: the adapter's open() is awaited (never wrapDriver'd).
            opening = Promise.resolve()
              .then(() => adapter.open())
              .then((opened) => {
                // OWNERSHIP BINDING (S1/A3 backup): the deferred adapter open
                // lands AFTER the write coordinator exists — bind the app's
                // coordinator onto the opened source so an adapter-backed
                // backup manager constructs without manual mutation.
                (opened                        ).writeCoordinator = app.writeCoordinator;
                const handle = wrapDriver(opened.handle);
                if (!handle) throw new Error('database adapter opened without a handle');
                runtime.db = handle;
                app.db = handle;
                app._dbAdapter = opened;
                app._isManagedPath = (opened                        ).isManagedPath;
                // SEARCH PLUGIN BINDING (S4/A1): plugins registered before the
                // deferred open lands had no db to bind at registration time
                // (registerSearchPlugin binds only when app.db exists). Bind
                // every registered plugin to the freshly installed handle now,
                // so a pre-start registration works after ready.
                app.searchPlugins.bindSource(handle);
                attachHandleResources(handle);
                return opened;
              });
            // The open's rejection is surfaced through app.ready /
            // prepareSchema / the boot promise, not as an unhandled rejection.
            opening.catch(() => {});
          }
          return opening;
        };
      })();
      // The boot path (bootApplication) awaits resolveRoutes before deciding
      // whether a db exists; installing the opened handle first makes the boot
      // gate and prepareSchema see a real db handle.
      const originalResolveRoutes = app.resolveRoutes;
      app.resolveRoutes = (...args           ) => installPendingDb ().then(() => originalResolveRoutes(...args));
      app._dbOpen = installPendingDb;
    }
    if (blobLifecycle) {
      if (!db && !pendingDbAdapter) throw new Error('blobLifecycle requires a database');
      app._blobLifecycleOptions = blobLifecycle;
    }
    // The job-queue substrate (spec #5) — a separate seam, opt-in. Built at
    // construction when a db + `jobs` config are engaged (the shared secret is
    // required: createJobQueue throws if absent — fail-closed at construction, like
    // envGate). Reached by the framework-owned /workers + /jobs HTTP routes AND by
    // post-commit consumers that call `app.jobs.enqueue(...)`. No `jobs` config →
    // no queue, no routes, no reaper (zero blast radius).
    prepareGracefulShutdown(app);
    app.port = undefined;
    app.httpServer = undefined;
    app._transportReady = Promise.resolve();

    // Versioned schema migrations (eng-review spec #9, #17). Declared at
    // construction; run at startup pre-traffic during schema preparation AFTER the
    // entity tables exist, so each `up` may ALTER/backfill them. One migration txn
    // = (DDL + namespaced ledger-record bump) atomic; see src/migration-ledger.mjs.
    app.migrations = migrations;

    // Static accessor for the router constructor, so exemplars may write
    // `workbench.router({ mergeParams: true })` alongside the named import.
    // One constructor, two access paths — singular system.
    (workbench       ).router = router;

    // Auto-create tables for mounted entities. Runs during `app.ready` before
    // traffic, after routes resolve and before the kernel starts. The method stays
    // callable for server-only/tests that prepare schema without listening, but it
    // is the same cached path `app.ready` uses — not a second DDL algorithm. An
    // adapter-backed app resolves its deferred open here first (A1 contract).
    let latestSchemaReport                                               = null;
    app.schemaReport = () => latestSchemaReport;
    app.prepareSchema = async () => withLog(app.log, async () => {
      if (installPendingDb) await installPendingDb();
      if (!app.schemaReady) {
        app.schemaReady = (async () => {
          if (!app.db) throw new Error('cannot generate DDL — no db configured on the app');
          // Capture at the lifecycle boundary, rather than construction: callers
          // may alter the database after creating an app but before preparing it.
          schemaBeforeLifecycle = new Set(observedSchemaObjects(app.db).map(schemaObjectKey));
          // Phase 3: resolve declarations and validate the global ownership graph
          // before lifecycle DDL can alter the database.
          await app.resolveRoutes();
          registryLocked = true;
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
              .filter((object) => schemaBeforeLifecycle?.has(schemaObjectKey(object)) ?? true),
          });
          // Migrations intentionally own their DDL imperatively, and derived
          // resources may create SQLite artifacts lazily. They are lifecycle
          // participants when introduced during this boot, but an object that
          // predates the boot still has to be declared by the normal census.
          const settledCensus = new Map(settledOwnership.census);
          for (const object of observedSchemaObjects(app.db)) {
            const key = schemaObjectKey(object);
            if (schemaBeforeLifecycle?.has(key) || settledCensus.has(key)) continue;
            settledCensus.set(key, {
              kind: 'framework', owner: 'lifecycle', objectKind: object.type, name: object.name,
            });
          }
          latestSchemaReport = createSchemaReport(app.db, settledCensus);
          if (settledOwnership.errors.length > 0) throw new Error(settledOwnership.errors[0].message);
          const exactErrors = validateExactSchema(app.db, settledCensus, schema ? [schema] : [])
            // A schema-owned entity root may legitimately carry a trigger that
            // belongs to a registered derived-resource plugin (A2 ownership).
            .filter((error) => settledCensus.get(`trigger:${error.name.toLowerCase()}`)?.kind !== 'plugin');
           if (exactErrors.length > 0) throw new Error(exactErrors[0].message);
          const foreignKeyErrors = app.db.prepare('PRAGMA foreign_key_check').all();
          if (foreignKeyErrors.length > 0) {
            const violation = foreignKeyErrors[0]                           ;
              throw new Error(`${ownerDescription(settledCensus, String(violation.table))} has a foreign key violation`);
          }
          // The global PRAGMA output names pages rather than schema objects. Run
          // it once per census relation so a failure always has its declared
          // owner, without exposing table data in the diagnostic. A declared
          // but not-yet-materialized object (a lazily created operational ledger,
          // e.g. _DerivedResource with no registered derived resources) is not
          // present and has nothing to check — skip it, exactly like the census
          // skips objects that predate the boot.
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
          return app;
        })();
      }
      return app.schemaReady;
    });
    app.ddl = () => app.prepareSchema();

    app.start = () => {
      if (app._databaseReleased) {
        return Promise.reject(new Error('application database was released before startup'));
      }
      return startApplication(app);
    };
    // Live delivery attaches before startup, when the kernel has not yet captured
    // its post-commit consumers. The app owns registry and authorization wiring;
    // callers provide only transport policy and declared aggregate snapshots.
    app.attachLiveDelivery = (options     ) => {
      const result = attachApplicationLiveDelivery(app, options);
      // S5/A5 revocation → S4/A2 bridge wiring (review #109 finding 2): every
      // revocation the live-delivery core publishes (a committed deletion, a
      // delivery-time reauthorization denial, or an app mutation's explicit
      // revoke) is fenced + recorded as a high-priority rebuild directive in
      // the staleness ledger. The listener is registered after the core exists
      // (attachApplicationLiveDelivery builds it), so the live reader and the
      // search index are invalidated by the SAME published revocation.
      const core = (app._applicationLiveDelivery       )?.core;
      if (core && typeof core.onRevocation === 'function') {
        core.onRevocation(app.searchStaleness.onRevocation);
      }
      return result;
    };

    app.listen = (portOrOptionsOrCallback     , optionsOrCallback     ) => {
      // One listen path, Express-compatible overload:
      //   listen()                         → config.port
      //   listen(3000) / listen(3000, cb)  → explicit port
      //   listen(callback)                 → config.port + onListening (NOT port=function)
      //   listen({ principalOf, onListening }) → config.port + options object
      // An explicit port still wins over config/env. PORT env is applied at
      // construction via resolveConfig → app.config.port.
      let port;
      let options = optionsOrCallback ?? {};
      if (typeof portOrOptionsOrCallback === 'function') {
        port = app.config.port;
        options = portOrOptionsOrCallback;
      } else if (
        portOrOptionsOrCallback != null
        && typeof portOrOptionsOrCallback === 'object'
        && !Array.isArray(portOrOptionsOrCallback)
      ) {
        port = app.config.port;
        options = portOrOptionsOrCallback;
      } else {
        port = portOrOptionsOrCallback ?? app.config.port;
      }
      if (app.httpServer) {
        throw new Error('application is already listening');
      }
      if (app._startupMode === 'headless' || (app._startPromise && !app._transportAttached)) {
        throw new Error('application already started without HTTP; create a new app and call listen() before start()');
      }
      app.port = port;
      return withLog(app.log, () => serveListen(app, port, options));
    };
    // Static file serving — a thin alias over the general `app.use` prefix-intercept
    // seam: `app.static('/public', dir)` is exactly
    // `app.use('/public', serveStatic(dir))`. Retained as a readability convenience
    // (the file-serve factory lives in views.mjs); the framework has ONE interceptor
    // mechanism, not two. A missing file falls through to the next declared
    // handler (e.g. a SPA fallback) rather than short-circuiting the request.
    // Optional caller options (cacheControl, precompressed) merge over the
    // framework defaults; the managed-path guard cannot be overridden.
    app.static = (prefix     , dir     , options                     = {}) => app.use(prefix, serveStatic(dir, {
      ...options,
      prefix: prefix.replace(/\/+$/, ''),
      // Refuse to serve anything under the adapter-owned directory (S1/A2).
      isManagedPath: app._isManagedPath,
    }));
    // `.auth()` mounts the framework-owned auth battery at `/auth` — login +
    // logout routes that set/clear the fail-closed `sid` cookie (the Set-Cookie
    // the exemplar omits, which is the whole 0→1 auth bug). Built from the SAME
    // public primitives an app would use to hand-roll its own boundary; an app
    // needing bespoke login mounts its own router instead. Returns the app
    // (chainable). Fail closed: an app with no db cannot serve auth — the routes
    // write User rows and mint Sessions, and sessionPrincipalOf has nothing to
    // look a token up in. Throw at construction (loud), not mid-login (a 500).
    app.auth = function auth(options      = {}) {
      if (!app.db) {
        throw new Error('app.auth() requires a db — registration writes a User row, authentication mints a Session, and the session principal source has nothing to look a token up in without one (fail closed).');
      }
      app._authEngaged = true;
      // `secure` follows THIS app's env, not the process-wide singleton — an app
      // that opts into production cookie behavior does so through `workbench({
      // env: 'production' })`, the one config surface.
      //
      // `identifyBy` declares which User field(s) a login credential matches
      // (in order). Defaults to `['username']`. Pass `['email', 'username']` for
      // email-based login. See `authRoutes` for the full contract.
      const authEntities = Object.fromEntries(
        [User, Session, Credential, Invitation, ApiKey, TwoFactor]
          .map((declaration) => [declaration.name, app.entity(declaration)]),
      );
      app.mount('/auth', authRoutes({
        secure: app.config.env === 'production',
        identifyBy: options.identifyBy,
        minimumPasswordLength: options.minimumPasswordLength,
        entities: authEntities,
        db: app.db,
      }       ));
      // Per-app session duration changes only the schedule metadata. The kernel
      // applies it to the app-bound Session facade, preserving its database-bound
      // query and mutation closures.
      if (app.config.sessionDurationMs !== config.sessionDurationMs) {
        app._sessionSchedule = Object.freeze({
          ...Session.schedule,
          remove: Object.freeze({ ...Session.schedule.remove, delay: app.config.sessionDurationMs }),
        });
      }
      return app;
    };
    if (installPendingDb) {
      // Adapter-backed apps (A1 contract): awaiting `app.ready` installs the
      // deferred open before listen(), so the transport captures a real db
      // handle. startApplication replaces this promise with the full boot when
      // the app starts.
      app.ready = installPendingDb();
    }
    return app;
  } catch (err) {
    // Construction failed after an adapter was opened but before the app (and
    // its shutdown owner) was handed out. Release the OS-backed ownership lock
    // and close the handle so a refused configuration cannot strand its
    // directory (S1/A2). A DEFERRED adapter never opened, so nothing to release.
    if (openedHere && openedDb) {
      try {
        openedDb.close();
      } catch {
        /* best-effort close on the construction-failure path */
      }
    }
    throw err;
  }
}
