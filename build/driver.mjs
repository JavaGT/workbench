// driver.mjs — the db driver contract (seam-review §2.1, priority #7).
//
// CONTRACT: a workbench db driver is a SYNCHRONOUS EMBEDDED single-writer handle
// with this shape:
//
//   {
//     prepare(sql) -> { run(...args), get(...args), all(...args) },
//     exec(sql),
//     txn(fn)            -> async; BEGIN IMMEDIATE / await fn() / COMMIT, ROLLBACK on throw,
//     exclusiveTxn(fn)   -> sync; BEGIN EXCLUSIVE / fn() / COMMIT inside the try so a
//                          failing COMMIT still ROLLBACKs
//                         (the exclusive-upgrade lane — e.g. package schema migrations),
//     readSnapshotTxn(fn)-> async; BEGIN (deferred) / await fn() / COMMIT in a finally,
//                         never ROLLBACK — a read-only consistent snapshot that does NOT
//                         take the write lock,
//     begin(),       commit(),       rollback(),       // sync primitives for callers
//                                                   // that cannot use the callback form
//     upsert({ table, keyColumns, columns, values }),
//   }
//
// - `prepare` returns a statement whose `run` returns `{ changes }`, whose `get`
//   returns `undefined` when no row matches, and whose `all` returns an array.
//   BOTH `:name` named params and `?` positional params must work.
// - The driver is SYNCHRONOUS and EMBEDDED (node:sqlite DatabaseSync, a file,
//   :memory:, or a sync libSQL bridge). ASYNC / NETWORK drivers are OUT OF
//   CONTRACT: the writeQueue + in-transaction admission rely on single-writer
//   semantics — commitEvents brackets `await`s (projection consumers, blob adopt,
//   admission, effect recursion) inside ONE open BEGIN..COMMIT, and an async
//   driver would yield the writer mutex mid-transaction, letting a second
//   dispatch interleave inside the same txn and breaking the single-writer
//   kernel. There is no async driver path; do not add one.
//
// The framework never calls `BEGIN`/`COMMIT`/`ROLLBACK` literals or hand-rolled
// upsert SQL itself. Call sites go through the dispatcher functions below
// (`txn`, `exclusiveTxn`, `readSnapshotTxn`, `begin`, `commit`, `rollback`,
// `upsert`), which route to the driver's own methods when present and otherwise
// fall back to the SQLite defaults implemented here. Those three transaction
// modes are the ONLY transaction shapes the framework may use — the standard
// immediate txn, the exclusive-upgrade lane, and the read-only consistent
// snapshot — and driver.ts is the only module that issues BEGIN/COMMIT/ROLLBACK
// literals. That fallback is what lets a raw node:sqlite DatabaseSync
// (the shape ~29 test files pass straight to createServer) work unchanged: it is
// a valid driver because wrapDriver attaches the defaults to it.

// Type-only import: db-adapter.ts imports DbHandle from this module, so a
// runtime import would cycle. ReadMirrorDescription is erased at emit.


// Loose, Workbench-like db surface. A conforming driver may provide its own
// txn/upsert; a raw handle falls back to the SQLite defaults wrapped here.

























// ---- SQLite default implementations (the fallback + the wrapped-handle body) ----

// Prepared statements are immutable SQL programs tied to one database handle.
// Keep one per handle and SQL text so the commit loop does not recompile its
// fixed statements for every action. The WeakMap lets a closed database and its
// statements become collectible together; custom drivers still use their own
// prepare implementation through the same helper.
const preparedStatements = new WeakMap                              ();

export function prepareCached           (db                                     , sql        )            {
  let statements = preparedStatements.get(db          );
  if (!statements) {
    statements = new Map();
    preparedStatements.set(db          , statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement             ;
}

// COMMIT inside the try: a failing COMMIT still attempts ROLLBACK so a
// transaction that could not be committed does not stay open with uncertain
// state. The commit-loop writer relies on single-writer semantics — leaving an
// uncommitted txn behind would be a durability hazard.
async function sqliteTxn(db          , fn               )                   {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back or txn unusable */
    }
    throw err;
  }
}

// Exclusive-upgrade lane: BEGIN EXCLUSIVE / fn() / COMMIT inside the try so a
// failing COMMIT still attempts ROLLBACK — the same shape as sqliteTxn but with
// the exclusive variant. Used by the package schema migrations where deferred
// would break the one-lane ruling. Synchronous: the migration lane's body has
// no awaits.
function sqliteExclusiveTxn(db          , fn               )          {
  db.exec('BEGIN EXCLUSIVE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back or txn unusable */
    }
    throw err;
  }
}

// Read-only consistent snapshot: BEGIN (deferred, no write lock) / await fn /
// COMMIT in a finally. Never ROLLBACKs — a capture error still releases the read
// transaction and propagates to the caller, which decides what a failed capture
// means (e.g. a denied snapshot). Deferred must stay deferred: this mode runs
// BEFORE authorization awaits and must not take the write lock.
async function sqliteReadSnapshotTxn(db          , fn               )                   {
  db.exec('BEGIN');
  try {
    return await fn();
  } finally {
    db.exec('COMMIT');
  }
}

function sqliteBegin(db          ) {
  db.exec('BEGIN IMMEDIATE');
}
function sqliteCommit(db          ) {
  db.exec('COMMIT');
}
function sqliteRollback(db          ) {
  db.exec('ROLLBACK');
}

// ONE upsert helper covering both idioms the codebase used to carry
// (ON CONFLICT ... DO UPDATE and INSERT OR REPLACE). All three former call sites
// target tables with a composite PRIMARY KEY and NO foreign keys / triggers, so
// REPLACE's delete-then-reinsert cascade was never depended upon — ON CONFLICT
// DO UPDATE (in-place update, no delete) is semantically equivalent and is the
// single upsert path now.
function sqliteUpsert(
  db          ,
  { table, keyColumns, columns = [], values }               ,
) {
  const allCols = [...keyColumns, ...columns];
  const placeholders = allCols.map((c) => ':' + c).join(', ');
  const conflictTarget = keyColumns.join(', ');
  const setClause = columns.length
    ? columns.map((c) => `${c} = excluded.${c}`).join(', ')
    : null;
  const sql =
    `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders})` +
    ` ON CONFLICT(${conflictTarget})` +
    (setClause ? ` DO UPDATE SET ${setClause}` : ' DO NOTHING');
  db.prepare(sql).run(values);
}

// ---- Dispatchers: route to the driver's own method or the SQLite fallback ----
// A raw handle (no txn/upsert attached) falls through to the SQLite defaults;
// a wrapped app.db (helpers attached by wrapDriver) calls the attached method;
// a conforming custom driver calls its own implementation. All three uniform.

export async function txn(db          , fn               )                   {
  if (typeof db.txn === 'function') return db.txn(fn);
  return sqliteTxn(db, fn);
}

export function exclusiveTxn(db          , fn               )          {
  if (typeof db.exclusiveTxn === 'function') return db.exclusiveTxn(fn);
  return sqliteExclusiveTxn(db, fn);
}

export async function readSnapshotTxn(db          , fn               )                   {
  if (typeof db.readSnapshotTxn === 'function') return db.readSnapshotTxn(fn);
  return sqliteReadSnapshotTxn(db, fn);
}

export function begin(db          ) {
  if (typeof db.begin === 'function') {
    db.begin();
    return;
  }
  sqliteBegin(db);
}

export function commit(db          ) {
  if (typeof db.commit === 'function') {
    db.commit();
    return;
  }
  sqliteCommit(db);
}

export function rollback(db          ) {
  if (typeof db.rollback === 'function') {
    db.rollback();
    return;
  }
  sqliteRollback(db);
}

export function upsert(db          , opts               ) {
  if (typeof db.upsert === 'function') {
    db.upsert(opts);
    return;
  }
  sqliteUpsert(db, opts);
}

// ---- Connection PRAGMA layer (S1/A2) ------------------------------------
// THE single source of truth for connection PRAGMAs. The SQLite default adapter
// runs these fail-closed at open (it does NOT rely on wrapDriver's bootstrap);
// wrapDriver applies the same list under a thin try/catch for raw-handle test
// callers. Exactly one module declares the PRAGMA SQL — change them here only.

export const CONNECTION_PRAGMA_SQL                    = Object.freeze([
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
]);

// Fail-closed application: any PRAGMA error propagates. Used by the sqlite
// adapter at open, where a silent catch would leave a connection misconfigured.
export function applyConnectionPragmas(db                                )       {
  for (const sql of CONNECTION_PRAGMA_SQL) db.exec(sql);
}

// The WAL starvation-guard checkpoint (scope#2727): wal_checkpoint(RESTART) run
// with busy_timeout 0 — saved and restored — so a reader pinning the WAL
// answers busy immediately instead of stalling the shared connection's event
// loop for the connection's full busy_timeout. Returns the checkpoint row;
// busy=1 means a reader still pins the WAL and the caller defers to its next
// poll. Lives here because the PRAGMA layer has exactly one declaring module.
export function walCheckpointRestart(db


 )                                {
  const { timeout } = db.prepare('PRAGMA busy_timeout').get()                       ;
  db.exec('PRAGMA busy_timeout = 0');
  try {
    return db.prepare('PRAGMA wal_checkpoint(RESTART)').get()                                 ;
  } finally {
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
  }
}

// ---- attachDriverHelpers: attach the SQLite default txn/upsert surface ----
// The adapter needs the driver contract helpers WITHOUT wrapDriver's PRAGMA
// bootstrap (it runs the centralized layer itself, fail-closed). `this` inside
// the arrow closures is lexical, so we bind to the handle explicitly by closure
// (not `this`).
export function attachDriverHelpers(dbOrDriver          )           {
  dbOrDriver.txn = (fn) => sqliteTxn(dbOrDriver, fn);
  dbOrDriver.exclusiveTxn = (fn) => sqliteExclusiveTxn(dbOrDriver, fn);
  dbOrDriver.readSnapshotTxn = (fn) => sqliteReadSnapshotTxn(dbOrDriver, fn);
  dbOrDriver.begin = () => sqliteBegin(dbOrDriver );
  dbOrDriver.commit = () => sqliteCommit(dbOrDriver );
  dbOrDriver.rollback = () => sqliteRollback(dbOrDriver );
  dbOrDriver.upsert = (opts) => sqliteUpsert(dbOrDriver , opts);
  return dbOrDriver;
}

// ---- wrapDriver: attach the SQLite defaults (and thin PRAGMA bootstrap) to a
// raw handle, or pass a conforming custom driver through untouched. The driver
// IS the raw handle with helpers attached (object expansion, not a wrapper
// proxy), so `app.db.prepare` keeps working — entity code and tests reach it
// everywhere.
//
// A conforming custom driver (already provides txn AND upsert) owns its own
// bootstrap, so NO PRAGMAs run for it — it may not even be SQLite. PRAGMAs run
// only on the default path (raw DatabaseSync or a bare object) and are guarded
// so a mock/stub db without a working .exec is a no-op. This path is a THIN
// back-compat bootstrap for raw-handle callers: the PRAGMA SQL itself lives in
// CONNECTION_PRAGMA_SQL above, and the sqlite adapter does not rely on it.
export function wrapDriver(dbOrDriver                             )                              {
  if (dbOrDriver == null) return dbOrDriver;
  const isConformingDriver =
    typeof dbOrDriver.txn === 'function' && typeof dbOrDriver.upsert === 'function';
  if (isConformingDriver) return dbOrDriver;
  attachDriverHelpers(dbOrDriver);
  if (typeof dbOrDriver.exec === 'function') {
    try {
      applyConnectionPragmas(dbOrDriver);
    } catch {
      /* mock/stub db — no-op */
    }
  }
  return dbOrDriver;
}

// ---- Read-mirror description builder (S1/A5) -------------------------------
// The ONE builder for controlled read-mirror descriptions. It pins the literal
// mode (`mode=ro`) and the `readOnly: true` contract flag; it never carries a
// write path. Opening these descriptions (src/read-mirror.ts) enforces
// read-only at the engine AND via a query-class rejector — belt and suspenders.
export function buildReadMirrorDescription(dbFile        )                        {
  return {
    kind: 'read-mirror',
    mode: 'read-only',
    readOnly: true,
    connectionString: `file:${dbFile}?mode=ro`,
  };
}

// ---- Shared-state PRAGMA seam (S1/A5) ------------------------------------
// The maintenance seam is the SOLE route for toggling shared-state PRAGMAs on
// the shared connection (S1/B1 consumes it). A raw `PRAGMA foreign_keys`
// toggle anywhere else is forbidden: CONNECTION_PRAGMA_SQL pins the connection
// defaults, and the helpers here restore `foreign_keys = ON` in a finally even
// when the maintenance body throws. driver.ts is the only module allowed to
// issue this toggle (the write-coordinator red-line test enforces that).
export function setForeignKeys(db          , enabled         )       {
  db.exec(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
}

// Serialized wiring lives in src/maintenance.ts (the write coordinator turn);
// this is the raw PRAGMA bracket, kept here so driver.ts stays the single
// source of the statement text. The body may be sync OR async; the result is
// assimilated through Promise.resolve so `foreign_keys` stays OFF while the
// body is still running (an async body that yields must not see enforcement
// re-enabled under it), and the restore runs on every exit path — fulfilled,
// rejected, a synchronous throw, or a thenable whose `then` getter throws.
export function withForeignKeysDisabled   (db          , fn                      )                 {
  setForeignKeys(db, false);
  let value                ;
  try {
    value = fn();
  } catch (err) {
    setForeignKeys(db, true);
    throw err;
  }
  const restore = () => setForeignKeys(db, true);
  // Assimilate through Promise.resolve so a throwing `then` getter is routed
  // into a rejected promise instead of escaping un-restored. The surrounding
  // try/catch is defensive: even if Promise.resolve itself threw synchronously,
  // the restore to `foreign_keys = ON` still runs before the error escapes.
  try {
    return Promise.resolve(value).then(
      (resolved) => {
        restore();
        return resolved;
      },
      (err) => {
        restore();
        throw err;
      },
    );
  } catch (err) {
    restore();
    throw err;
  }
}
