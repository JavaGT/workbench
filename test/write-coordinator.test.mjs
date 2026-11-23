// write-coordinator.test.mjs — the platform write-coordinator red-line (epic
// scope#23, S1/A5).
//
// ONE coordinator owns every platform write (entity, live-state, operational
// queue, plugin index, migration, blob metadata). The documented exception is
// ONLY the migrations stop-the-world boot transaction — it is explicitly NOT a
// second mutex. The job-queue's mutations are NOT an exception: they are
// multi-statement read-then-write sequences, so they route through the
// coordinator (only registerWorker's genuinely single-statement INSERT stays
// outside). This suite proves:
//   1. no module outside driver.ts (+ the documented migrations boot phase and
//      the directory-lock sidecar) issues BEGIN/COMMIT literals, with
//      SAVEPOINT/ROLLBACK TO/RELEASE and CREATE TRIGGER bodies excluded;
//   2. entity, live-state, plugin-index, job-queue, operational-consumer, blob
//      upload/discard/reap, and both migration lanes all enter through the one
//      coordinator (observed owned during the write) or are the documented
//      boot-lane exception;
//   3. blob metadata never issues its own transaction control (adopt runs in
//      the caller's coordinated transaction).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

import workbench, {
  entity,
  everyone,
  executeDDL,
  executeFrameworkDDL,
  grant,
  map,
  read,
  ref,
  scope,
  text,
  write,
} from '../build/internal.mjs';
import { operationalConsumer, defineOperationalEvent } from '../build/index.mjs';
import { declaredBlobField } from '../build/server.mjs';
import { createBlobStore } from '../build/blob-store.mjs';
import { handleBlobUploadRoute } from '../build/http-framework-routes.mjs';
import { createSearchOwnedIndexCapability } from '../build/index-capability.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// ---- static audit helpers -------------------------------------------------

function walkTs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkTs(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

// Transaction-control literals issued via exec/prepare on a connection. The
// literal must be the statement's leading keyword. SAVEPOINT/RELEASE never
// match; ROLLBACK TO (savepoint rollback) is excluded after matching.
const TRANSACTION_LITERAL = /(?:exec|prepare)\s*\(\s*[`'"]\s*(BEGIN|COMMIT|ROLLBACK)\b([^`'"]*)/g;

// Allowed modules: driver.ts (the transaction authority), migrations.ts (the
// documented stop-the-world boot lane — uses the driver dispatchers), and
// directory-lock.ts (the sidecar ownership lock database, which holds a
// BEGIN EXCLUSIVE but NEVER COMMITs — not a data-connection transaction).
const TRANSACTION_ALLOWLIST = new Set([
  join(SRC, 'driver.ts'),
  join(SRC, 'migrations.ts'),
  join(SRC, 'directory-lock.ts'),
]);

function transactionLiteralHits(file) {
  const source = stripTsComments(readFileSync(file, 'utf8'));
  const hits = [];
  for (const match of source.matchAll(TRANSACTION_LITERAL)) {
    const line = source.slice(0, match.index).split('\n').length;
    const literal = match[1];
    const rest = match[2] ?? '';
    if (literal === 'ROLLBACK' && /\bTO\b/i.test(rest)) continue; // savepoint rollback — excluded
    hits.push({ line, literal, raw: match[0] });
  }
  return hits;
}

test('transaction-control audit: BEGIN/COMMIT literals live only in the authority + documented exceptions', () => {
  const violations = [];
  const perModule = new Map();
  for (const file of walkTs(SRC)) {
    const hits = transactionLiteralHits(file);
    if (hits.length === 0) continue;
    perModule.set(file, hits);
    if (!TRANSACTION_ALLOWLIST.has(file)) {
      violations.push({ file, hits });
    }
  }

  assert.deepEqual(
    violations.map((v) => v.file),
    [],
    `BEGIN/COMMIT literals outside driver.ts + the documented exceptions: ${JSON.stringify(violations)}`,
  );

  // The write categories never open transactions of their own — their writes
  // ride the coordinator (or the caller's coordinated txn):
  const jobQueue = join(SRC, 'job-queue.ts');
  assert.equal(perModule.has(jobQueue), false, 'job-queue.ts issues no transaction literals (mutations route through the coordinator)');
  const blobStore = join(SRC, 'blob-store.ts');
  assert.equal(perModule.has(blobStore), false, 'blob-store.ts issues no transaction literals (metadata rides the caller\'s coordinated turn)');

  // The exclusion proof:
  const savepointModule = join(SRC, 'annotated-text-authoring-stream.ts');
  assert.equal(perModule.has(savepointModule), false, 'savepoint module: only SAVEPOINT/ROLLBACK TO/RELEASE, excluded by the audit');
  const triggerModule = join(SRC, 'annotated-text-field.ts');
  assert.equal(perModule.has(triggerModule), false, 'trigger module: CREATE TRIGGER ... BEGIN ... END bodies, excluded by the audit');

  // The authority itself holds the literals, and the boot lane uses the
  // dispatchers (no literals of its own):
  assert.ok(perModule.has(join(SRC, 'driver.ts')), 'driver.ts is the transaction authority');
  assert.equal(perModule.has(join(SRC, 'migrations.ts')), false, 'migrations.ts uses begin/commit/rollback dispatchers, not literals');

  // directory-lock holds its exclusive lock on the sidecar lock db and never
  // COMMITs a data transaction:
  const lockHits = perModule.get(join(SRC, 'directory-lock.ts')) ?? [];
  assert.ok(lockHits.some((h) => h.literal === 'BEGIN'), 'directory-lock holds a BEGIN EXCLUSIVE');
  assert.ok(lockHits.every((h) => h.literal !== 'COMMIT'), 'directory-lock never issues COMMIT');
});

// Strip // and /* */ comments so a source-module mention of a forbidden toggle
// in prose does not count as issuing it. Only statements carry the toggle.
function stripTsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('a raw PRAGMA foreign_keys toggle exists only in driver.ts', () => {
  const violators = [];
  for (const file of walkTs(SRC)) {
    const source = stripTsComments(readFileSync(file, 'utf8'));
    if (/PRAGMA\s+foreign_keys/.test(source) && file !== join(SRC, 'driver.ts')) {
      violators.push(file);
    }
  }
  assert.deepEqual(violators, [], 'the shared-state foreign_keys toggle is the maintenance seam\'s, and only driver.ts declares it');
});

// ---- coordinator routing (behavioral) -------------------------------------

function instrumentCoordinator(app) {
  const original = app.writeCoordinator.run.bind(app.writeCoordinator);
  const turns = [];
  app.writeCoordinator.run = (fn) => original(() => {
    turns.push({ owned: app.writeCoordinator.owned });
    return fn();
  });
  return turns;
}

function redlineApp() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1'), ('u2')");
  const Project = entity('RedlineProject', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeDDL(Project, db);
  db.exec("INSERT INTO RedlineProject (id, owner) VALUES ('p1', 'u1')");
  const Doc = entity('RedlineDoc', {
    project: ref('RedlineProject', { physical: true }),
    owner: ref('User', { role: 'owner' }),
    title: text(),
    // A side-table strategy field: writes to RedlineDoc_collaborators via the
    // strategy projection inside the coordinated dispatch (plugin-index lane).
    collaborators: map(ref('User'), { role: ['editor'] }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeDDL(Doc, db);
  const app = workbench({ db, entities: [Project, Doc] });
  return { db, app, Doc };
}

test('entity, live-state, and plugin-index writes enter through the one coordinator', async () => {
  const { db, app } = redlineApp();
  await app.start();
  await app.ready;

  const turns = instrumentCoordinator(app);
  const before = turns.length;

  const result = await app.dispatch({
    actionId: 'create', type: 'RedlineDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1', title: 'hello world' },
    principal: { id: 'u1' },
  });
  assert.equal(result.ok, true, result.failure?.message);

  const added = turns.slice(before);
  assert.ok(added.length > 0, 'the dispatch took at least one coordinated write turn');
  assert.ok(added.every((t) => t.owned === true), 'every write category ran inside the coordinator (owned)');

  // Entity write landed.
  assert.ok(db.prepare("SELECT 1 FROM RedlineDoc WHERE id = 'd1'").get(), 'entity row written');

  // Live-state write landed: the committed log is the platform\'s live
  // delivery substrate, appended inside the same coordinated dispatch.
  const logRow = db.prepare("SELECT * FROM _Log WHERE eventType = 'RedlineDoc.created'").get();
  assert.ok(logRow, 'committed-log (live-state) event written');

  // Plugin-index write landed: the map side-table strategy projection ran
  // inside a coordinated dispatch and wrote the membership side table.
  const memberAdd = await app.dispatch({
    actionId: 'member-add', type: 'RedlineDoc.collaborators.add',
    payload: { owner: 'd1', member: 'u2', role: 'editor' },
    principal: { id: 'u1' },
  });
  assert.equal(memberAdd.ok, true, memberAdd.failure?.message);
  const sideTableRow = db.prepare('SELECT * FROM RedlineDoc_collaborators').get();
  assert.ok(sideTableRow, 'plugin-index side table written');
  assert.equal(sideTableRow.RedlineDoc_id, 'd1');
  assert.equal(sideTableRow.member_id, 'u2');
  assert.ok(turns.length > added.length, 'the plugin-index write took its own coordinated turn');

  await app.shutdown();
  db.close();
});

test('owned-index statements are census-authorized, atomic, fenced, and host-executed inside the coordinator', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE SearchIndex (id TEXT PRIMARY KEY, value TEXT); CREATE TABLE Source (id TEXT PRIMARY KEY); CREATE TABLE _Log (id TEXT PRIMARY KEY); CREATE TABLE OtherPluginIndex (id TEXT PRIMARY KEY); CREATE VIRTUAL TABLE SearchFts USING fts5(value);');
  const app = workbench({ db });
  let fence = 4;
  const census = new Map([
    ['table:searchindex', { kind: 'plugin', owner: 'notes', objectKind: 'table', name: 'SearchIndex' }],
    ['table:searchaudit', { kind: 'plugin', owner: 'notes', objectKind: 'table', name: 'SearchAudit' }],
    ['trigger:searchindex_audit', { kind: 'plugin', owner: 'notes', objectKind: 'trigger', name: 'SearchIndex_audit' }],
    // An FTS shadow artifact has the same plugin attribution as its declared virtual table.
    ['table:searchindex_data', { kind: 'sqlite-artifact', owner: 'notes', objectKind: 'shadow-table', name: 'SearchIndex_data' }],
    ['table:source', { kind: 'entity', owner: 'Source', objectKind: 'table', name: 'Source' }],
    ['virtual-table:searchfts', { kind: 'plugin', owner: 'notes', objectKind: 'virtual-table', name: 'SearchFts' }],
    ...db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'SearchFts_%'").all()
      .map((row) => [`table:${row.name.toLowerCase()}`, { kind: 'sqlite-artifact', owner: 'notes', objectKind: 'shadow-table', name: row.name }]),
  ]);
  const executionOwnership = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    executionOwnership.push(app.writeCoordinator.owned);
    return prepare(sql);
  };
  const index = createSearchOwnedIndexCapability({
    db: app.db,
    census,
    writeCoordinator: app.writeCoordinator,
    fenceOf: () => fence,
    maxStatements: 2,
    maxRows: 20,
  })('notes');

  // A plugin callback runs outside the coordinator; invoking its capability is
  // what schedules the host-owned statement execution inside it.
  assert.equal(app.writeCoordinator.owned, false);
  await index.write({ expectedFence: 4, statements: [{ sql: 'INSERT INTO SearchIndex VALUES (?, ?)', params: ['a', 'one'] }] });
  assert.ok(executionOwnership.every(Boolean), 'only host statement execution observed a coordinator-owned turn');

  await assert.rejects(
    index.write({ expectedFence: 4, statements: [
      { sql: 'INSERT INTO SearchIndex VALUES (?, ?)', params: ['b', 'two'] },
      { sql: 'INSERT INTO SearchIndex VALUES (?, ?)', params: ['a', 'duplicate'] },
    ] }),
    /UNIQUE/,
  );
  assert.equal(db.prepare("SELECT 1 FROM SearchIndex WHERE id = 'b'").get(), undefined, 'a failed batch rolls back every statement');

  await assert.rejects(
    index.write({ expectedFence: 4, statements: [{ sql: `INSERT INTO SearchIndex VALUES ${Array.from({ length: 21 }, (_, i) => `('c${i}', 'three')`).join(', ')}` }] }),
    /batch limit/,
  );
  assert.equal(db.prepare("SELECT 1 FROM SearchIndex WHERE id = 'c'").get(), undefined, 'a row-limit breach rolls back its statement');

  db.exec(`CREATE TABLE SearchAudit (id TEXT PRIMARY KEY, value TEXT);
    CREATE TRIGGER SearchIndex_audit AFTER INSERT ON SearchIndex BEGIN
      INSERT INTO SearchAudit VALUES (new.id || '-1', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-2', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-3', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-4', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-5', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-6', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-7', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-8', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-9', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-10', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-11', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-12', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-13', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-14', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-15', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-16', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-17', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-18', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-19', new.value);
      INSERT INTO SearchAudit VALUES (new.id || '-20', new.value);
    END;`);
  await assert.rejects(
    index.write({ expectedFence: 4, statements: [{ sql: "INSERT INTO SearchIndex VALUES ('triggered', 'no')" }] }),
    /batch limit/,
  );
  assert.equal(db.prepare("SELECT 1 FROM SearchIndex WHERE id = 'triggered'").get(), undefined, 'a trigger-driven row-limit breach rolls back the source row');
  assert.equal(db.prepare("SELECT 1 FROM SearchAudit WHERE id = 'triggered-1'").get(), undefined, 'a trigger-driven row-limit breach rolls back every trigger row');

  fence = 5;
  const moved = await index.write({ expectedFence: 4, statements: [{ sql: 'INSERT INTO SearchIndex VALUES (?, ?)', params: ['moved', 'no'] }] });
  assert.equal(moved.changes, 0, 'a moved fence executes zero statements');
  assert.equal(db.prepare("SELECT 1 FROM SearchIndex WHERE id = 'moved'").get(), undefined);

  assert.deepEqual(index.query({ sql: 'SELECT id, value FROM SearchIndex' }).map((row) => ({ ...row })), [{ id: 'a', value: 'one' }]);
  await index.write({ expectedFence: 5, statements: [{ sql: 'INSERT INTO SearchFts (value) VALUES (?)', params: ['needle'] }] });
  assert.equal(index.query({ sql: "SELECT value FROM SearchFts WHERE SearchFts MATCH 'needle'" })[0].value, 'needle', 'FTS shadow artifacts inherit census ownership');
  const ftsAuxiliary = index.query({ sql: "SELECT bm25(SearchFts), highlight(SearchFts, 0, '<', '>'), snippet(SearchFts, 0, '[', ']', '...', 5) FROM SearchFts WHERE SearchFts MATCH 'needle'" });
  assert.equal(ftsAuxiliary.length, 1, 'FTS5 auxiliary functions are explicitly allowed');
  assert.ok(index.query({ sql: '/* owned comment */ SELECT id FROM SearchIndex' }).length > 0, 'comments do not prevent an owned statement from running');
  await assert.rejects(async () => index.query({ sql: '/* comment */ SELECT id FROM SearchIndex UNION SELECT id FROM Source' }), /not authorized|authorization|prohibited/i, 'compound SQL cannot smuggle an unowned read');
  assert.ok(index.query({ sql: 'SELECT * FROM SearchFts_data' }).length > 0, 'census-owned FTS shadow tables remain reachable');
  for (const sql of [
    'SELECT * FROM Source',
    'SELECT * FROM _Log',
    'SELECT * FROM sqlite_schema',
    'SELECT * FROM OtherPluginIndex',
    "INSERT INTO Source VALUES ('s')",
    'PRAGMA user_version',
    'PRAGMA data_version = 1',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'CREATE TABLE denied (id TEXT)',
    'ALTER TABLE SearchIndex RENAME TO renamed',
    'DROP TABLE SearchIndex',
    "ATTACH DATABASE ':memory:' AS other",
    'DETACH DATABASE other',
    'CREATE TEMP TABLE denied_temp (id TEXT)',
  ]) {
    const operation = /^(SELECT|PRAGMA)/.test(sql)
      ? () => index.query({ sql })
      : () => index.write({ expectedFence: 5, statements: [{ sql }] });
    await assert.rejects(async () => operation(), /not authorized|authorization|prohibited|owned-index/i, `${sql} must be refused by SQLite's authorizer`);
  }
  await assert.rejects(async () => index.query({ sql: 'SELECT sqlite_version()' }), /not authorized|authorization|prohibited/i, 'an unallowlisted function is refused');
  if (typeof globalThis.Bun === 'undefined') {
    await assert.rejects(async () => index.query({ sql: 'SELECT load_extension(?)', params: ['/tmp/denied'] }), /not authorized|authorization|prohibited/i, 'loading extensions is refused');
  }
  db.close();
});

test('job-queue mutations enter through the coordinator per entry point; registration stays single-statement', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, jobs: { sharedSecret: 'secret', pollIntervalMs: 9999 } });
  await app.prepareSchema();

  const turns = instrumentCoordinator(app);

  const assertCoordinated = (label) => {
    const before = turns.length;
    return () => {
      const added = turns.slice(before);
      assert.ok(added.length > 0, `${label} took a coordinated write turn`);
      assert.ok(added.every((t) => t.owned === true), `${label} ran inside the coordinator (owned)`);
    };
  };

  const afterEnqueue = assertCoordinated('enqueue');
  await app.jobs.enqueue({ kind: 'k', payload: { x: 1 }, id: 'j1' });
  afterEnqueue();

  const afterClaim = assertCoordinated('claim');
  const claimed = await app.jobs.claim('worker-1', { kind: 'k' });
  assert.equal(claimed?.id, 'j1');
  afterClaim();

  const afterHeartbeat = assertCoordinated('heartbeat');
  assert.equal(await app.jobs.heartbeat('j1', 'worker-1'), true);
  afterHeartbeat();

  const afterProgress = assertCoordinated('updateProgress');
  assert.ok(await app.jobs.updateProgress({ jobId: 'j1', workerId: 'worker-1', progress: 50, stage: 'half' }));
  afterProgress();

  const afterResult = assertCoordinated('submitResult');
  const submitted = await app.jobs.submitResult('j1', 'worker-1', { status: 'completed', output: { done: true } });
  assert.equal(submitted.accepted, true);
  afterResult();

  const afterReap = assertCoordinated('reap');
  await app.jobs.reap();
  afterReap();

  // registerWorker is the genuinely single-statement INSERT — the one queue
  // write that stays outside the coordinator (no turn).
  const beforeRegister = turns.length;
  const registered = app.jobs.registerWorker('secret');
  assert.ok(registered && registered.workerId, 'a worker registered');
  assert.equal(turns.length, beforeRegister, 'registerWorker (single-statement INSERT) takes no coordinator turn');

  const afterCancel = assertCoordinated('cancelJob');
  const cancelled = await app.jobs.cancelJob({ jobId: 'j1', workerId: 'worker-1' });
  assert.ok(cancelled && cancelled.terminal === true, 'the completed job is terminal');
  const queued = await app.jobs.enqueue({ kind: 'k', id: 'j2' });
  const cancelledQueued = await app.jobs.cancelJob({ jobId: queued.id });
  assert.equal(cancelledQueued.status, 'cancelled', 'a queued job is cancelled');
  afterCancel();

  db.close();
});

test('app migrations run as the stop-the-world boot lane — outside the coordinator', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    migrations: [{
      namespace: 'app',
      name: 'boot-lane',
      version: 1,
      up(d) {
        d.exec('CREATE TABLE boot_lane_migration (id INTEGER PRIMARY KEY)');
        d.exec('INSERT INTO boot_lane_migration VALUES (1)');
      },
    }],
  });

  const turns = instrumentCoordinator(app);
  await app.prepareSchema();
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'boot_lane_migration'").get(), 'the migration applied at boot');
  assert.equal(
    turns.length,
    0,
    'the boot migration lane does not take a coordinator turn — it runs stop-the-world before the app serves (documented exception)',
  );
  db.close();
});

test('the lifecycle census still rejects a table that predates boot', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Intruder (id INTEGER PRIMARY KEY)');
  const app = workbench({ db });

  await assert.rejects(() => app.prepareSchema(), /observed table "Intruder" is not declared/);
  db.close();
});

test('the workbench package migration lane runs stop-the-world — outside the coordinator', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });

  const turns = instrumentCoordinator(app);
  await app.prepareSchema();

  // runWorkbenchMigrations runs at boot even for a fresh db: the exclusive
  // lane applies every version and records it in the reserved workbench
  // namespace of the shared namespaced ledger.
  const row = db.prepare("SELECT MAX(version) AS v FROM _SchemaMigration WHERE namespace = 'workbench'").get();
  assert.ok(row && Number(row.v) >= 1, `the package migration ledger recorded applied versions (v=${row.v})`);
  assert.equal(
    turns.length,
    0,
    'the workbench migration lane does not take a coordinator turn — the same documented stop-the-world boot exception',
  );
  db.close();
});

test('a failing migration rolls back atomically — no partial boot state', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    migrations: [{
      namespace: 'app',
      name: 'doomed',
      version: 1,
      up(d) {
        d.exec('CREATE TABLE doomed_migration (id INTEGER PRIMARY KEY)');
        throw new Error('migration failed mid-way');
      },
    }],
  });
  await assert.rejects(() => app.prepareSchema(), /migration app@1 failed/);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'doomed_migration'").get(),
    undefined,
    'the migration transaction rolled back the table it created before failing',
  );
  db.close();
});

test('blob metadata writes enter through the caller\'s coordinated transaction — never its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-blob-redline-'));
  try {
    const db = new DatabaseSync(':memory:');
    const store = createBlobStore({ db, root: dir });
    db.exec('CREATE TABLE BlobStore (id TEXT PRIMARY KEY, status TEXT)');
    db.prepare('INSERT INTO BlobStore (id, status) VALUES (?, ?)').run('b1', 'pending');

    const callerStatements = [];
    const callerHandle = {
      prepare(sql) {
        callerStatements.push(sql);
        return db.prepare(sql);
      },
    };

    const result = store.adopt(callerHandle, 'b1');
    assert.equal(result.adopted, 1, 'the adopt UPDATE landed');
    assert.ok(callerStatements.some((sql) => /UPDATE BlobStore SET status/.test(sql)), 'the metadata UPDATE went through the CALLER\'s handle (its coordinated transaction)');
    assert.ok(callerStatements.every((sql) => !/\b(BEGIN|COMMIT|ROLLBACK)\b/.test(sql)), 'the caller handle received no transaction control from the blob store');

    const row = db.prepare("SELECT status FROM BlobStore WHERE id = 'b1'").get();
    assert.equal(row.status, 'adopted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- blob upload / discard / reap routing --------------------------------

function fakeBlobRequest(body) {
  const req = new EventEmitter();
  req.url = 'http://localhost/blobs';
  req.method = 'POST';
  req.headers = { 'content-type': 'application/octet-stream' };
  req.pause = () => {};
  req.resume = () => {};
  setImmediate(() => {
    req.emit('data', body);
    req.emit('end');
  });
  return req;
}

function fakeResponse() {
  return {
    statusCode: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(payload) {
      this.payload = payload;
    },
  };
}

function assertCoordinatedTurns(turns, label, startIndex) {
  const added = turns.slice(startIndex);
  assert.ok(added.length > 0, `${label} took at least one coordinated write turn`);
  assert.ok(added.every((t) => t.owned === true), `${label} ran inside the coordinator (owned)`);
}

test('blob upload via the /blobs route, reap via sweepBlobs, and discard via sweepPendingBlobs all enter through the coordinator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-blob-coordinator-'));
  try {
    const db = new DatabaseSync(':memory:');
    const app = workbench({
      db,
      blobs: { root: dir },
      blobLifecycle: {
        fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })],
        pendingTtlMs: 0,
        adoptedRecoveryTtlMs: 60_000,
      },
      blobReapIntervalMs: 1_000_000, // keep the timed reapers inert during this test
    });
    await app.start();
    assert.ok(app.sweepBlobs && app.sweepPendingBlobs, 'boot engaged the blob + pending-blob reapers');

    const turns = instrumentCoordinator(app);

    // upload — the framework-owned POST /blobs route must route the metadata
    // write through the coordinator (never a direct store write outside it).
    const beforeUpload = turns.length;
    const handled = await handleBlobUploadRoute(app, fakeBlobRequest(Buffer.from('hello blob')), fakeResponse(), { id: 'u1' });
    assert.equal(handled, true, 'the /blobs route handled the upload');
    const pending = db.prepare("SELECT id FROM BlobStore WHERE status = 'pending'").get();
    assert.ok(pending, 'the upload metadata row landed');
    assertCoordinatedTurns(turns, 'blob upload', beforeUpload);

    // reap — app.sweepBlobs wraps blobs.reap in the coordinator and sweeps
    // the stale orphan the route just uploaded.
    db.prepare('UPDATE BlobStore SET createdAt = ? WHERE id = ?').run(
      new Date(Date.now() - 2 * 3600_000).toISOString(), pending.id,
    );
    const beforeReap = turns.length;
    await app.sweepBlobs();
    assert.equal(db.prepare('SELECT 1 FROM BlobStore WHERE id = ?').get(pending.id), undefined, 'the stale orphan was reaped');
    assertCoordinatedTurns(turns, 'blob reap', beforeReap);

    // discard — sweepPendingBlobs wraps the pending-blob lifecycle reap (which
    // calls blobs.discardPending) in the coordinator.
    app.blobs.upload({ bytes: Buffer.from('to discard'), id: 'b2' });
    db.prepare(`INSERT INTO _PendingBlob (pendingKey, blobId, claimTokenHash, principalKey, resourceId, contentDigest, byteLength, status, scopeId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run('scope/resource.pending', 'b2', 'claimhash', 'u1', 'resource', 'digest', 10, 'scope', new Date(Date.now() - 60_000).toISOString());
    const beforeDiscard = turns.length;
    await app.sweepPendingBlobs();
    assert.equal(db.prepare('SELECT 1 FROM BlobStore WHERE id = ?').get('b2'), undefined, 'the pending blob was discarded');
    assertCoordinatedTurns(turns, 'blob discard', beforeDiscard);

    await app.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- operational consumer writes ----------------------------------------

test('operational consumer writes enter through the coordinator', async () => {
  const db = new DatabaseSync(':memory:');
  const Note = entity('Note', { title: text(), grant: () => grant(read, write) });
  const delivered = [];
  const app = workbench({
    db,
    entities: [Note],
    operationalConsumers: [operationalConsumer({
      name: 'search.index',
      declarationVersion: 'v1',
      projectionId: 'search.v1',
      effectId: 'index.v1',
      event: defineOperationalEvent({
        eventType: 'Note.created',
        fields: ['id', 'title'],
        project: (fields, _metadata) => ({ id: fields.id, title: fields.title }),
      }),
      idempotencyKey: ({ metadata }) => `search:${metadata.committedEventId}`,
      handle: async (delivery) => {
        delivered.push(delivery);
        return { kind: 'ack' };
      },
    })],
  });
  await app.start();

  // Seed a durable event the consumer must process on the next reconcile.
  db.prepare(`INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, 'Note.created', ?, 'seed-action', '2026-07-26T00:00:00.000Z')`)
    .run('Note:n2', 1, JSON.stringify({ id: 'n2', title: 'seed' }));

  const turns = instrumentCoordinator(app);
  const before = turns.length;
  // The framework runs the reconcile sweep inside a coordinated turn (boot
  // reconcile path) — the writes it performs (declaration, failure/cursor
  // rows) must observe owned=true.
  await app.writeCoordinator.run(() => app.reconcileOperationalConsumers());

  assert.equal(delivered.length, 1, 'the seeded event was delivered by the reconcile');
  const added = turns.slice(before);
  assert.ok(added.length > 0, 'operational consumer reconcile took coordinated write turns');
  assert.ok(added.every((t) => t.owned === true), 'operational consumer writes ran inside the coordinator');
  assert.ok(
    db.prepare("SELECT 1 FROM _ConsumerCursor WHERE consumer = 'operational:search.index'").get(),
    'the ack advanced the consumer cursor',
  );
  assert.ok(
    db.prepare("SELECT 1 FROM _OperationalConsumerDeclaration WHERE name = 'search.index'").get(),
    'the consumer declaration row landed',
  );

  await app.shutdown();
  db.close();
});
