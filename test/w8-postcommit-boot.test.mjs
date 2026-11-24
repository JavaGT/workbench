// w8-postcommit-boot.test.mjs — Wave 8 focused verification.
//
// 1. the live post-commit fan-out never opens a nested BEGIN IMMEDIATE when the
//    operational consumer's follow-up sweep and search-staleness both checkpoint
//    cursors on one connection;
// 2. cursor-backed boot reconcilers fail closed before the app serves, while
//    genuinely best-effort maintenance stays warn-only;
// 3. writeQueue.close() has a finite, testable deadline even with a wedged write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench from '../build/app.mjs';
import { entity, text, grant, read, write, subscribe, principal, defineOperationalEvent, operationalConsumer } from '../build/index.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import {
  createSearchPluginRegistry,
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
} from '../build/search-plugin.mjs';
import { SEARCH_STALENESS_CURSOR } from '../build/search-staleness.mjs';

const NOTE_TYPE = 'Note.created';

function noteEntity() {
  return entity('Note', {
    title: text(),
    secret: text(),
    grant: () => grant(read, write, subscribe),
  });
}

function freshApp({ log } = {}) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [noteEntity()], ...(log ? { log } : {}) });
  return { db, app };
}

function cursorOf(db, consumer, scope) {
  const row = db.prepare('SELECT lastSeq FROM _ConsumerCursor WHERE consumer = ? AND scope = ?').get(consumer, scope);
  return row?.lastSeq;
}

// A minimal registered search plugin: registering one constructs the app's
// search-staleness bridge, which engages the cursor-backed post-commit consumer.
function registerSearch(app) {
  const registry = createSearchPluginRegistry();
  registry.register({
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: 'w8-notes',
    version: '1.0.0',
    ownedObjects: [],
    sourceInterests: [{ entity: 'Note' }],
    stalenessKey: (change) => (change.entity === 'Note' ? `Note:${change.rowId}` : null),
    prepare: () => {},
    validate: () => {},
    reconcile: () => ({ counts: { documents: 0 } }),
    rebuild: () => ({ counts: { documents: 0 } }),
    search: () => ({ hits: [] }),
  });
  const plugin = registry.get('w8-notes');
  assert.ok(plugin, 'the plugin registry holds the registered source');
  app.registerSearchPlugin(plugin);
}

test('concurrent operational + search-staleness post-commit fan-out never nests a transaction and advances both cursors', async (t) => {
  const lines = [];
  const { db, app } = freshApp({
    log: {
      level: 'warn',
      format: 'json',
      output: (level, channel, msg, ctx) => lines.push({ level, channel, msg, ctx }),
    },
  });
  t.after(async () => { await app.shutdown(); db.close(); });

  const delivered = [];
  let nestedApp;
  const nestedDispatchConsumer = operationalConsumer({
    name: 'w8.nested.dispatch',
    declarationVersion: 'v1',
    projectionId: 'w8.nested.v1',
    effectId: 'w8.nested.index.v1',
    event: defineOperationalEvent({
      eventType: NOTE_TYPE,
      fields: ['id', 'title'],
      project: (fields, metadata) => ({ id: fields.id, title: fields.title, event: metadata.committedEventId }),
    }),
    idempotencyKey: ({ metadata }) => `w8-nested:${metadata.committedEventId}`,
    handle: async (delivery) => {
      delivered.push(delivery.payload.id);
      if (delivered.length === 1) {
        // A nested dispatch re-enters the same write-queue turn. Its post-commit
        // hook arms the operational follow-up while search-staleness is also
        // checkpointing — the exact interleaving that used to raise
        // ERR_SQLITE_ERROR 'cannot start a transaction within a transaction'.
        const nested = await nestedApp.dispatch({
          actionId: 'w8-nested-action',
          type: 'Note.create',
          payload: { id: 'nested-note', title: 'nested', secret: 'hidden' },
          principal: principal({ type: 'user', id: 'u1' }),
        });
        assert.equal(nested.ok, true);
      }
      return { kind: 'ack' };
    },
  });
  app.operationalConsumers = [nestedDispatchConsumer];
  nestedApp = app;
  registerSearch(app);
  app.mount('/notes', app.entity('Note'));
  app.listen(0);
  await app.ready;

  const outcome = await app.dispatch({
    actionId: 'w8-outer-action',
    type: 'Note.create',
    payload: { id: 'outer-note', title: 'outer', secret: 'hidden' },
    principal: principal({ type: 'user', id: 'u1' }),
  });
  assert.equal(outcome.ok, true);

  const logged = JSON.stringify(lines);
  assert.equal(logged.includes('cannot start a transaction'), false, `post-commit fan-out nested a transaction: ${logged}`);
  assert.deepEqual(delivered, ['outer-note', 'nested-note']);

  assert.equal(cursorOf(db, 'operational:w8.nested.dispatch', 'Note:outer-note'), 1);
  assert.equal(cursorOf(db, 'operational:w8.nested.dispatch', 'Note:nested-note'), 1);
  assert.equal(cursorOf(db, SEARCH_STALENESS_CURSOR, 'Note:outer-note'), 1);
  assert.equal(cursorOf(db, SEARCH_STALENESS_CURSOR, 'Note:nested-note'), 1);
});

test('a cursor-backed boot reconciler failure fails closed before serving', async (t) => {
  const lines = [];
  const { db, app } = freshApp({
    log: {
      level: 'info',
      format: 'json',
      output: (level, channel, msg, ctx) => lines.push({ level, channel, msg, ctx }),
    },
  });
  t.after(async () => { await app.shutdown().catch(() => {}); db.close(); });

  // The email seam installs this cursor-backed reconciler on the app before the
  // kernel picks it up for boot; inject a failure at the same seam.
  app._reconcileEmailDelivery = async () => { throw new Error('injected email recovery failure'); };

  await assert.rejects(
    app.start(),
    (err) => {
      assert.match(err.message, /boot reconciliation failed/);
      assert.match(err.message, /email: injected email recovery failure/);
      return true;
    },
  );
  assert.equal(app._startFailed, true, 'the singular boot promise is marked failed');
  assert.equal(
    lines.some((line) => /server listening|application started/.test(line.msg)),
    false,
    'a failed reconciliation must not reach the serving log line',
  );
});

test('best-effort blob recycle assembly failure stays warn-only at boot', async (t) => {
  const lines = [];
  const { db, app } = freshApp({
    log: {
      level: 'info',
      format: 'json',
      output: (level, channel, msg, ctx) => lines.push({ level, channel, msg, ctx }),
    },
  });
  t.after(async () => { await app.shutdown(); db.close(); });

  app.assembleBlobRecycleSeam = () => { throw new Error('injected recycle assembly failure'); };
  await app.start();

  assert.ok(
    lines.some((line) => line.level === 'warn' && /blob recycle seam assembly failed/.test(line.msg)),
    'maintenance degradation is still reported',
  );
  assert.equal(
    lines.some((line) => /server listening|application started/.test(line.msg)),
    true,
    'best-effort maintenance does not block serving',
  );
});

test('writeQueue.close({ timeoutMs }) rejects within the deadline for a wedged write, and resolves for a finished one', async (t) => {
  // Object form, bounded even though the in-flight write never settles.
  const wedged = createWriteQueue();
  let releaseWedge;
  const wedge = new Promise((resolve) => { releaseWedge = resolve; });
  wedged.run(() => wedge);
  t.after(() => releaseWedge?.());

  const started = Date.now();
  await assert.rejects(
    wedged.close({ timeoutMs: 30 }),
    (err) => err.status === 503 && /close timed out/.test(err.message),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 15, `close rejected too early: ${elapsed}ms`);
  assert.ok(elapsed < 300, `close did not respect its deadline: ${elapsed}ms`);

  // The configured default deadline is used when no override is passed.
  const defaultWedged = createWriteQueue({ closeTimeoutMs: 30 });
  let releaseDefault;
  defaultWedged.run(() => new Promise((resolve) => { releaseDefault = resolve; }));
  t.after(() => releaseDefault?.());
  const defaultStarted = Date.now();
  await assert.rejects(defaultWedged.close(), (err) => err.status === 503);
  assert.ok(Date.now() - defaultStarted < 300, 'configured default close deadline is finite');

  // A write that settles before the deadline still closes cleanly (number form),
  // and no new outer writes are admitted afterwards.
  const healthy = createWriteQueue();
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const running = healthy.run(() => gate);
  const closing = healthy.close(1000);
  finish();
  await running;
  await closing;
  assert.equal(healthy.closed, true);
  await assert.rejects(healthy.run(() => 'nope'), (err) => err.status === 503);
});
