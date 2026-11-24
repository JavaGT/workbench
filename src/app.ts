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

import { listen as serveListen } from './serve.ts';
import {
  maintenanceDefaults,
  startApplication,
  validateMaintenanceOptions,
} from './application-runtime.ts';
import { buildReadMirrorDescription, wrapDriver } from './driver.ts';
import { SQLITE_DATA_FILENAME, type OpenedSqliteDatabase } from './sqlite-adapter.ts';
import {
  resolveDatabaseInput,
  prepareAppSchema,
  type BoundDbAdapter,
  type DatabaseInput,
  type SchemaBootState,
} from './app-schema-boot.ts';
import type { ByteStore } from './fs-blobs.ts';
import type { JobQueueOptions } from './job-queue.ts';
import type { CreateLogOptions } from './log.ts';
import type { SchemaMaintenanceStep } from './schema-maintenance.ts';
import type { DerivedResource } from './derived-resource.ts';
import type { SqliteSchemaDescription } from './sqlite-schema.ts';
import type { Migration } from './migrations.ts';
import type { WorkbenchOptions as PublicWorkbenchOptions } from '../index.d.ts';
import { validateMigrations } from './migrations.ts';
import { createBlobStore } from './blob-store.ts';
import { memoryBlobs } from './memory-blobs.ts';
import { createBlobSeams } from './blob-seams.ts';
import { retentionMs } from './blob-retention.ts';
import { createRecycleManager, recycleManagerBinSeam } from './backup/recycle.ts';
import { createJobQueue } from './job-queue.ts';
import { createSearchPluginRegistry, type SearchPlugin } from './search-plugin.ts';
import { ensureQueryInvalidationHub } from './http-framework-routes.ts';
import { createQueryFamilyRegistry, type QueryFamilyRegistry } from './query-family.ts';
import { createSearchStalenessBridge } from './search-staleness.ts';
import { createSearchReconcileEngine } from './search-reconcile.ts';
import { createPostCommitEffectRunner } from './post-commit-effects.ts';
import { createClock } from './clock.ts';
import { createWriteQueue } from './write-queue.ts';
import { createMaintenanceSeam } from './maintenance.ts';
import { createSchemaMaintenanceRunner } from './schema-maintenance.ts';
import { attachStorageEnvelopePolicy } from './storage-envelope.ts';
import { createDerivedResourceRegistry } from './derived-resource.ts';
import { createPrincipalSnapshotTransaction } from './principal-snapshot-transaction.ts';
import { prepareGracefulShutdown } from './lifecycle.ts';
import { createLog, withLog } from './log.ts';
import { serveStatic, type ServeStaticOptions } from './views.ts';
import { authRoutes } from './auth/routes.ts';
import { attachApplicationLiveDelivery } from './application-live-delivery.ts';
import { User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor } from './auth/entities.ts';
import { config, resolveConfig } from './config.ts';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { makeMountable } from './router.ts';

/**
 * The minimal registry `POST /search` executes (issue #312). The framework's
 * own `searchPlugins` registry satisfies `search(id, request)`; a custom
 * registry may additionally provide `hybridSearch(request)` for fused
 * retrieval. `has`/`ids` let the route distinguish an unknown index (404) from
 * a bad payload (400) before executing.
 */
export interface SearchRegistry {
  search(index: string, request: any): any;
  hybridSearch?(request: any): any;
  has?(index: string): boolean;
  ids?(): readonly string[];
}

interface WorkbenchOptions {
  db?: DatabaseInput;
  schema?: SqliteSchemaDescription;
  entities?: readonly unknown[];
  actions?: readonly unknown[];
  /**
   * Registered query families (issue #312). `POST /query-families/:name` runs
   * the family's compiled host/catalog/element grants over the same
   * authorization engine as the REST layer. A family may also be registered
   * after construction through the chainable `app.queryFamily(declaration)`.
   */
  queryFamilies?: QueryFamilyRegistry;
  /**
   * The search registry the framework's `POST /search` route executes (issue
   * #312). Defaults to the app's own `searchPlugins` registry; an app may supply
   * a custom registry with `search`/`hybridSearch`. The chainable
   * `app.search(registry)` overrides it after construction.
   */
  search?: SearchRegistry;
  blobs?: ByteStore | { root?: string };
  requireEnv?: readonly string[];
  migrations?: readonly Migration[];
  maintenanceSteps?: readonly SchemaMaintenanceStep[];
  derivedResources?: readonly DerivedResource[];
  jobs?: Omit<Partial<JobQueueOptions>, 'db'> & Pick<JobQueueOptions, 'sharedSecret'>;
  log?: CreateLogOptions;
  port?: number;
  env?: string;
  session?: { durationMs?: number };
  viewsDir?: string;
  resolveScope?: (scope: string) => { entity: string; id: string | number } | null | Promise<{ entity: string; id: string | number } | null>;
  scopeSnapshot?: (scope: string, principal: unknown, anchor: { entity: string; id: string; row: Record<string, unknown> }) => unknown | Promise<unknown>;
  history?: unknown;
  blobReapIntervalMs?: number;
  blobReapTtlMs?: number;
  logRetentionDays?: number;
  logRetentionIntervalMs?: number;
  resultDataRetentionDays?: number;
  payloadCompressionMinBytes?: number;
  blobRetention?: Partial<typeof maintenanceDefaults.blobRetention>;
  blobLowDiskHeadroomBytes?: number;
  operationalConsumers?: readonly unknown[];
  blobLifecycle?: unknown;
  blobRecycle?: { root: string };
  annotatedTextAdmission?: import('./annotated-text-admission.ts').AnnotatedTextAdmissionDeclaration;
  /**
   * Run full per-table `PRAGMA integrity_check(table)` over every settled
   * census relation during cold boot. Defaults to `false` to avoid O(DB size)
   * full-table scans on every startup; `PRAGMA foreign_key_check` and the
   * adapter's fail-closed `PRAGMA quick_check` at open still run by default.
   */
  verifyIntegrityOnBoot?: boolean;
}

type PublicWorkbenchOptionsAreCovered = Exclude<keyof PublicWorkbenchOptions, keyof WorkbenchOptions> extends never ? true : false;
const publicWorkbenchOptionsAreCovered: PublicWorkbenchOptionsAreCovered = true;
void publicWorkbenchOptionsAreCovered;

function isByteStore(value: ByteStore | { root?: string }): value is ByteStore {
  return typeof (value as { writePending?: unknown }).writePending === 'function';
}

// router(opts) — a mini-app mounted bare into a parent app with
// `app.mount(path, router)`. `{ mergeParams: true }` lets a child read a parent
// path param. A router resolves its routes relative to its own base ('/') and is
// re-based when mounted.
export function router(options: any = {}) {
  const mergeParams = options.mergeParams === true;
  const surface = makeMountable({ mergeParams });
  // A router is a reusable declaration blueprint. Each parent application
  // resolves a private instance with that application's entity registry, so a
  // cached route can never retain another application's database-bound facade.
  surface.resolveFor = async (entityOf: any) => {
    const instance = makeMountable({ mergeParams, entityOf });
    instance.declarations.push(...surface.declarations);
    await instance.resolveRoutes();
    return instance.routes;
  };
  return surface;
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
  queryFamilies,
  search,
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
  annotatedTextAdmission,
  verifyIntegrityOnBoot = false,
}: WorkbenchOptions = {}) {
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
    ? blobOpts.root as string
    : null;
  let blobRoot: string | null = explicitBlobRoot;
  let blobStagingRoot: string | null = null;
  let openedDb: OpenedSqliteDatabase | null = null;
  let openedHere = false;
  let pendingDbAdapter: BoundDbAdapter | null = null;
  let installPendingDb: (() => Promise<unknown>) | null = null;
  // Schema boot state is shared between this facade (entity registration lock,
  // schema report accessor) and the boot module that advances it.
  const bootState: SchemaBootState = {
    registryLocked: false,
    schemaBeforeLifecycle: null,
    latestSchemaReport: null,
  };
  try {
    // DB-input discrimination (path / adapter / raw node+bun handle) and the
    // blob-root layout are one focused seam in app-schema-boot.ts. A bad
    // configuration is refused before an adapter can strand its ownership lock.
    const resolvedInput = resolveDatabaseInput(db ?? null, explicitBlobRoot);
    openedDb = resolvedInput.openedDb;
    openedHere = resolvedInput.openedHere;
    pendingDbAdapter = resolvedInput.pendingDbAdapter;
    blobRoot = resolvedInput.blobRoot;
    blobStagingRoot = resolvedInput.blobStagingRoot;
    db = resolvedInput.db;
    // Wrap the raw handle with the driver contract helpers (txn/begin/commit/
    // rollback/upsert) and run the thin PRAGMA bootstrap. A conforming custom
    // driver (already providing txn+upsert) is passed through untouched — it owns
    // its own bootstrap. The driver IS the raw handle with helpers attached, so
    // `app.db.prepare` keeps working — entity code and tests reach it everywhere.
    // One construction path: a bare-string app gets the same treatment as a
    // pre-built handle. (seam-review §2.1, priority #7.)
    if (db) db = wrapDriver(db);

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
    const runtime = {
      db,
      batch(...args: any[]) {
        return app.batch(...args);
      },
      entityOf(value: any) {
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
        if (!existing && bootState.registryLocked) {
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
    const app: any = makeMountable({ entityOf: runtime.entityOf });
    app.actions = Object.freeze([...actions]);
    app.operationalConsumers = Object.freeze([...operationalConsumers]);
    app.dispatch = async () => {
      throw new Error('application is not started; call start() before dispatching');
    };
    app.batch = async () => {
      throw new Error('application is not started; call start() before batching');
    };
    app.entity = runtime.entityOf;
    app.register = (...declared: any[]) => {
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
    app.registerSearchPlugin = (plugin: SearchPlugin) => {
      app.searchPlugins.register(plugin);
      // Bind the CURRENT handle when one exists. An adapter-backed app's db is
      // null until the deferred open lands; installPendingDb binds every
      // registered plugin to the handle when that open completes, so a plugin
      // registered before start() still gets a bound reader after ready.
      if (app.db) app.searchPlugins.bindSource(app.db);
      return app;
    };
    // Registered query families (#312): the same compiled host/catalog/element
    // grants the library API runs, reached through `POST /query-families/:name`.
    // `app.queryFamilies` is always present (an empty registry by default) so the
    // HTTP route can answer 404 for an unregistered family instead of failing on
    // a missing dependency. `app.queryFamily(declaration)` is the chainable
    // registration seam (fail-closed: the registry refuses duplicate names and a
    // malformed declaration at registration time).
    app.queryFamilies = queryFamilies ?? createQueryFamilyRegistry();
    app.queryFamily = (declaration: unknown) => {
      app.queryFamilies.register(declaration);
      return app;
    };
    // Query invalidation is a read-side post-commit signal. Install the ONE hub
    // during construction so buildKernel (startApplication) sees it and engages
    // the single kernel consumer descriptor before any dispatch is possible.
    // There is no transport-side dispatch observer to keep in sync.
    ensureQueryInvalidationHub(app);
    // The search registry `POST /search` executes (#312). Defaults to the app's
    // own plugin registry — the same registry the search lifecycle binds and
    // materializes — so an app that registered plugins needs no extra wiring.
    // `app.search(registry)` swaps in a host-provided registry (its `search` and
    // optional `hybridSearch` are what the route calls).
    app.searchRegistry = search ?? app.searchPlugins;
    app.search = (registry: SearchRegistry) => {
      app.searchRegistry = registry;
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
    // Application-owned commit-time admission for annotated-text mutations.
    // The kernel compiles it from the declared annotation families; without a
    // declaration the commit path stays byte-identical.
    app._annotatedTextAdmission = annotatedTextAdmission;
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
      blobRetention: blobRetention as typeof maintenanceDefaults.blobRetention,
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
    const attachHandleResources = (handle: any): void => {
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
        let opening: Promise<unknown> | null = null;
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
                (opened as OpenedSqliteDatabase).writeCoordinator = app.writeCoordinator;
                const handle = wrapDriver(opened.handle);
                if (!handle) throw new Error('database adapter opened without a handle');
                runtime.db = handle;
                app.db = handle;
                app._dbAdapter = opened;
                app._isManagedPath = (opened as OpenedSqliteDatabase).isManagedPath;
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
      app.resolveRoutes = (...args: unknown[]) => installPendingDb!().then(() => originalResolveRoutes(...args));
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
    (workbench as any).router = router;

    // Auto-create tables for mounted entities. Runs during `app.ready` before
    // traffic, after routes resolve and before the kernel starts. The method stays
    // callable for server-only/tests that prepare schema without listening, but it
    // is the same cached path `app.ready` uses — not a second DDL algorithm. An
    // adapter-backed app resolves its deferred open here first (A1 contract).
    app.schemaReport = () => bootState.latestSchemaReport;
    app.prepareSchema = async () => withLog(app.log, async () => {
      if (installPendingDb) await installPendingDb();
      if (!app.schemaReady) {
        app.schemaReady = prepareAppSchema({
          app,
          schema,
          declaredMigrations,
          verifyIntegrityOnBoot,
          state: bootState,
        });
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
    app.attachLiveDelivery = (options: any) => {
      const result = attachApplicationLiveDelivery(app, options);
      // S5/A5 revocation → S4/A2 bridge wiring (review #109 finding 2): every
      // revocation the live-delivery core publishes (a committed deletion, a
      // delivery-time reauthorization denial, or an app mutation's explicit
      // revoke) is fenced + recorded as a high-priority rebuild directive in
      // the staleness ledger. The listener is registered after the core exists
      // (attachApplicationLiveDelivery builds it), so the live reader and the
      // search index are invalidated by the SAME published revocation.
      const core = (app._applicationLiveDelivery as any)?.core;
      if (core && typeof core.onRevocation === 'function') {
        core.onRevocation(app.searchStaleness.onRevocation);
      }
      return result;
    };

    app.listen = (portOrOptionsOrCallback: any, optionsOrCallback: any) => {
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
    app.static = (prefix: any, dir: any, options: ServeStaticOptions = {}) => app.use(prefix, serveStatic(dir, {
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
    app.auth = function auth(options: any = {}) {
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
      } as any));
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
