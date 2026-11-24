// Outbox tests (#183) — durable client mutations through the shipped client
// (createLocalStore over the local log + BroadcastChannel relay).
//
// Covered: offline edit → reconnect → converge; server reject on resend rolls
// the placeholder back with a visible failure; cross-tab single-resend
// coherence; per-scope ordering under the batch flusher; per-kind conflict
// behavior per docs/conflict-merge-policy.md; the stale-cursor rule
// (SPEC §7.1 hard-fail re-bootstrap never truncates queued actions).
import 'fake-indexeddb/auto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore, OutboxEntry } from '../public/workbench-local-store.mjs';
import { openLocalLog } from '../public/workbench-local-log.mjs';
import { makeFakeChannel } from './fixtures/fake-transport.mjs';
import { makeCrudServer } from './fixtures/fake-crud-server.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _dbSeq = 1;
function freshDbName() {
  return `test-outbox-${_dbSeq++}`;
}

/** Poll until `probe()` is true, with a generous cap. */
async function waitFor(probe, { timeoutMs = 4000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  assert.ok(probe(), 'waitFor condition not met in time');
}

/**
 * Web Locks stand-in mirroring the helper in local-store.test.mjs: one
 * exclusive lock; requests queue until the holder releases.
 * (Local copy — the shared fixture file is outside this lane's ownership.)
 */
function makeLockCoordinator() {
  let held = false;
  const waiters = [];
  return {
    request(_name, callback) {
      return new Promise((resolve, reject) => {
        const acquire = () => {
          held = true;
          Promise.resolve(callback({ mode: 'exclusive' })).then(() => {
            held = false;
            resolve();
            waiters.shift()?.();
          }, reject);
        };
        if (held) waiters.push(acquire);
        else acquire();
      });
    },
  };
}

/**
 * A CRUD transport with an offline gate. `online = false` rejects like a
 * dead socket; `online = true` delegates to the fake server.
 */
function makeGatedTransport(server) {
  const calls = []; // non-GET requests that reached the server
  const gate = { online: true };
  const fetch = async (url, opts = {}) => {
    if (!gate.online) throw new TypeError('fetch failed: offline');
    const method = (opts.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      calls.push({
        method,
        url: String(url),
        actionId: opts.headers?.['x-workbench-action-id'] ?? null,
        body: typeof opts.body === 'string' ? opts.body : null,
      });
    }
    return server.fetch(url, opts);
  };
  return { gate, calls, fetch };
}

const OUTBOX_TUNING = { retryBaseMs: 5, retryMaxMs: 40 };

function makeStore({ db = freshDbName(), server, kinds, locks: _locks, seedRows } = {}) {
  server ??= makeCrudServer({ kinds });
  for (const [id, row] of Object.entries(seedRows ?? {})) {
    server.state.rows.set(id, { ...row });
    server.state.revisions.set(id, 1);
  }
  const transport = makeGatedTransport(server);
  const channel = makeFakeChannel();
  server.onCommit = (envelope) => channel.emit(envelope);
  const make = (overrides = {}) => createLocalStore({
    baseUrl: 'http://test',
    name: 'Todo',
    path: '/todos',
    local: { name: overrides.db ?? db, outbox: OUTBOX_TUNING },
    channel: overrides.channel ?? channel,
    fetchImpl: overrides.fetch ?? transport.fetch,
    locks: overrides.locks,
  });
  return { server, transport, channel, make, db };
}

function pendingCount(store) {
  return store.outbox().filter((row) => row.status === 'queued' || row.status === 'sending').length;
}

// ---------------------------------------------------------------------------
// Unit: OutboxEntry
// ---------------------------------------------------------------------------

describe('OutboxEntry', () => {
  it('transitions queued → sending → committed; the first observable outcome settles dispatch', async () => {
    const entry = new OutboxEntry({ actionId: 'a1', entity: 'Todo', kind: 'update', rowId: '1', targetScope: 'Todo:1' });
    const { settlement, completion } = entry.promises();
    assert.equal(entry.pending, true);

    assert.equal(entry.markSending(), true);
    assert.equal(entry.attempts, 1);
    assert.equal(entry.markQueued(), true); // transport-grade failure settles dispatch as queued
    assert.deepEqual(await settlement, { status: 'queued', actionId: 'a1' });
    assert.equal(entry.markSending(), true);
    entry.markCommitted({ seq: 7, row: { id: '1', title: 'x' } });
    assert.equal(entry.terminal, true);
    assert.equal(entry.markSending(), false, 'terminal entries never restart');

    assert.deepEqual(await completion, { status: 'committed', seq: 7, row: { id: '1', title: 'x' } });
  });

  it('rejected entries keep their failure; toRow/fromRow round-trips', async () => {
    const entry = new OutboxEntry({ actionId: 'a2', entity: 'Todo', kind: 'create', payload: { title: 'x' } });
    entry.markSending();
    entry.markRejected({ category: 'denied', message: 'forbidden' });
    const row = entry.toRow();
    assert.equal(row.log, 'outbox');
    assert.deepEqual(row.failure, { category: 'denied', message: 'forbidden' });
    const revived = OutboxEntry.fromRow(row);
    assert.deepEqual(revived.toRow(), row);
    assert.equal(revived.terminal, true);
  });

  it('abandon settles a waiting dispatch as queued without a terminal lie', async () => {
    const entry = new OutboxEntry({ actionId: 'a3', entity: 'Todo', kind: 'update', rowId: '1', targetScope: 'Todo:1' });
    const { settlement, completion } = entry.promises();
    entry.abandon();
    assert.deepEqual(await settlement, { status: 'queued', actionId: 'a3' });
    assert.deepEqual(await completion, { status: 'abandoned' });
  });

  it('omits the row id until the store assigns one (autoIncrement key)', () => {
    const entry = new OutboxEntry({ actionId: 'a4', entity: 'Todo', kind: 'create' });
    assert.equal('id' in entry.toRow(), false);
    entry.id = 12;
    assert.equal(entry.toRow().id, 12);
  });
});

// ---------------------------------------------------------------------------
// Offline edit → reconnect → converge
// ---------------------------------------------------------------------------

describe('offline → reconnect → converge', () => {
  it('an offline edit queues durably, keeps its placeholder, and converges after reconnect', async () => {
    const { server, transport, make, db } = makeStore({
      seedRows: { 1: { id: '1', title: 'original' } },
    });
    const store = await make();
    const list = store.subscribe('1', {});
    await list.ready;
    assert.deepEqual(list.state, { id: '1', title: 'original' });

    transport.gate.online = false;
    const result = await store.update('1', { title: 'offline edit' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'queued');
    assert.ok(result.actionId, 'queued results carry the durable actionId');

    // The placeholder is visible immediately (immediate memory apply).
    assert.equal(store.overlayFor('1').title, 'offline edit');
    assert.equal(list.state.title, 'original', 'the list only folds committed events');

    // The entry is durable in the SAME local log — no second store.
    const log = await openLocalLog(db);
    const rows = await log.outboxEntries(0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'queued');
    assert.equal(rows[0].actionId, result.actionId);
    assert.deepEqual(JSON.parse(rows[0].body), { id: '1', title: 'offline edit' });
    log.close();

    // Reconnect → resend the SAME actionId → converge through ingest.
    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    await waitFor(() => list.state.title === 'offline edit');
    await waitFor(() => store.overlayStatusFor('1') === null, { timeoutMs: 2000 })
      .catch(() => assert.fail('placeholder should resolve via ingest, not the ack'));
    assert.deepEqual(server.state.requests.map((r) => r.actionId), [result.actionId]);

    // A committed outbox op is undoable like any other committed op.
    const undo = await store.undo(result.opId);
    assert.equal(undo.ok, true);
    await waitFor(() => list.state.title === 'original');
    assert.equal(server.state.requests.filter((r) => r.method === 'PATCH').length, 2);

    store.close();
  });

  it('a lost response after commit is retried with the same actionId and deduped server-side', async () => {
    const { server, transport, make } = makeStore({
      seedRows: { 1: { id: '1', title: 'start' } },
    });
    const serverFetch = server.fetch;
    let firstAttempt = true;
    const lossyFetch = async (url, opts) => {
      if (firstAttempt && (opts.method ?? 'GET').toUpperCase() === 'PATCH') {
        firstAttempt = false;
        await serverFetch(url, opts); // the server commits…
        throw new TypeError('response lost'); // …but the response never arrives
      }
      return transport.fetch(url, opts);
    };
    transport.gate.online = true;
    const store = await make({ fetch: lossyFetch });
    const list = store.subscribe('1', {});
    await list.ready;

    const result = await store.update('1', { title: 'committed once' });
    assert.equal(result.status, 'queued', 'a lost response is queued, not rolled back');
    const actionId = result.actionId;

    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    await waitFor(() => list.state.title === 'committed once');
    // The handler ran exactly once: the resend hit the (scope, actionId)
    // receipt and replayed instead of applying again.
    assert.equal(server.state.handlerRuns.get(actionId), 1);
    assert.equal(server.state.requests.filter((r) => r.actionId === actionId).length, 2);
    store.close();
  });

  it('completion comes from the authoritative log delta when the response is lost', async () => {
    const { server, transport, make } = makeStore({
      seedRows: { 1: { id: '1', title: 'start' } },
    });
    const serverFetch = server.fetch;
    let firstAttempt = true;
    const lossyFetch = async (url, opts) => {
      if (firstAttempt && (opts.method ?? 'GET').toUpperCase() === 'PATCH') {
        firstAttempt = false;
        await serverFetch(url, opts); // the server commits and emits the event…
        throw new TypeError('response lost'); // …but the response never arrives
      }
      return transport.fetch(url, opts);
    };
    transport.gate.online = true;
    const store = await make({ fetch: lossyFetch });
    const list = store.subscribe('1', {});
    await list.ready;

    let committedRow = null;
    const off = store.onOutbox((rows) => {
      const found = rows.find((r) => r.status === 'committed');
      if (found) committedRow = found;
    });

    const result = await store.update('1', { title: 'delta-settled' });
    assert.equal(result.status, 'queued', 'a lost response is queued, not committed');
    await waitFor(() => pendingCount(store) === 0);
    await waitFor(() => list.state.title === 'delta-settled');

    const deltaSeq = server.state.scopeSeqs.get('Todo:1');
    assert.ok(deltaSeq >= 1);
    assert.equal(committedRow.committedSeq, deltaSeq,
      'the entry completed on the committed log delta — no response evidence existed');
    off();
    store.close();
  });

  it('an offline create converges; its real id arrives only on completion', async () => {
    const { server, transport, make } = makeStore({});
    const store = await make();
    transport.gate.online = false;
    const result = await store.create({ title: 'while offline' });
    assert.equal(result.status, 'queued');
    assert.equal(result.id, undefined, 'a queued create has no row id yet');
    assert.equal(store.pendingCreates()[0]?.optimistic.title, 'while offline');

    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    assert.equal(server.state.rows.size, 1);
    const created = [...server.state.rows.values()][0];
    assert.equal(created.title, 'while offline');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Server rejects on resend → visible rollback
// ---------------------------------------------------------------------------

describe('reject on resend', () => {
  it('a revoked grant rolls the placeholder back with a visible durable failure', async () => {
    const { server, transport, make } = makeStore({
      seedRows: { 1: { id: '1', title: 'original' } },
    });
    const store = await make();
    const list = store.subscribe('1', {});
    await list.ready;

    transport.gate.online = false;
    const result = await store.update('1', { title: 'while revoked' });
    assert.equal(result.status, 'queued');

    server.state.revoked = true; // the grant died while we were offline
    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);

    // Visible failure, never a silent drop: the entry stays durably rejected.
    const [rejected] = store.outbox();
    assert.equal(rejected.status, 'rejected');
    assert.deepEqual(rejected.failure, { category: 'denied', message: 'forbidden' });

    // The placeholder rolled back to the authoritative state.
    await waitFor(() => store.overlayStatusFor('1') === null);
    assert.equal(list.state.title, 'original');
    assert.equal(server.state.rows.get('1').title, 'original', 'the server never applied it');

    // Dismissing acknowledges the failure.
    assert.equal(await store.dismissOutbox(rejected.id), true);
    assert.deepEqual(store.outbox(), []);
    void result;
    store.close();
  });

  it('validation changed offline → the resend is rejected as invalid input', async () => {
    const { server, transport, make } = makeStore({
      seedRows: { 1: { id: '1', title: 'original' } },
    });
    const store = await make();
    const list = store.subscribe('1', {});
    await list.ready;

    transport.gate.online = false;
    await store.update('1', { title: '' }); // legal then, illegal now
    server.state.validate = () => 'title must not be empty';

    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    const [entry] = store.outbox();
    assert.equal(entry.status, 'rejected');
    assert.equal(entry.failure.category, 'invalid-input');
    await waitFor(() => store.overlayStatusFor('1') === null);
    assert.equal(list.state.title, 'original');
    store.close();
  });

  it('a 4xx with no interpretable failure body still rejects (fail-closed, no infinite resend)', async () => {
    const { server, transport, make } = makeStore({
      seedRows: { 1: { id: '1', title: 'original' } },
    });
    const store = await make();
    await store.subscribe('1', {}).ready;

    transport.gate.online = false;
    await store.remove('1');
    server.state.rows.delete('1'); // the row vanished while we were offline
    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    const [entry] = store.outbox();
    assert.equal(entry.status, 'rejected');
    assert.equal(transport.calls.filter((c) => c.method === 'DELETE').length, 1,
      'a rejection is terminal — the server saw exactly one resend, no retry storm');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Cross-tab coherence
// ---------------------------------------------------------------------------

describe('cross-tab outbox coherence', () => {
  it('exactly one tab resends; the follower observes the queue and converges', async () => {
    const db = freshDbName();
    const { server, transport, make } = makeStore({
      db,
      seedRows: { 1: { id: '1', title: 'shared' } },
    });
    const locks = makeLockCoordinator();
    const leaderChannel = makeFakeChannel();
    const followerChannel = makeFakeChannel();
    server.onCommit = (envelope) => leaderChannel.emit(envelope);

    const leader = await make({ locks, channel: leaderChannel });
    const follower = await make({ locks, channel: followerChannel });
    const leaderList = leader.subscribe('1', {});
    const followerList = follower.subscribe('1', {});
    await Promise.all([leaderList.ready, followerList.ready]);

    // The follower edits while the whole tab fleet is offline.
    transport.gate.online = false;
    const followerSeen = [];
    const offFollower = follower.onOutbox((rows) => followerSeen.push(rows.map((r) => r.status)));
    const result = await follower.update('1', { title: 'from follower' });
    assert.equal(result.status, 'queued');
    assert.equal(transport.calls.length, 0, 'offline: nothing sent yet');
    assert.ok(followerSeen.some((statuses) => statuses.includes('queued')), 'followers observe queued entries');

    // Reconnect: the LEADER sends, exactly once, with the follower's actionId.
    transport.gate.online = true;
    await waitFor(() => transport.calls.filter((c) => c.method === 'PATCH').length === 1);
    await waitFor(() => pendingCount(leader) === 0 && pendingCount(follower) === 0);
    assert.equal(transport.calls.filter((c) => c.method === 'PATCH').length, 1, 'exactly one resend');
    assert.equal(transport.calls[0].actionId, result.actionId);
    await waitFor(() => followerList.state.title === 'from follower');
    assert.equal(leaderList.state.title, 'from follower');
    offFollower();
    leader.close();
    follower.close();
  });

  it("a follower's rejected resend rolls the follower's placeholder back too", async () => {
    const db = freshDbName();
    const { server, transport, make } = makeStore({
      db,
      seedRows: { 1: { id: '1', title: 'shared' } },
    });
    const locks = makeLockCoordinator();
    const leaderChannel = makeFakeChannel();
    const followerChannel = makeFakeChannel();
    server.onCommit = (envelope) => leaderChannel.emit(envelope);

    const leader = await make({ locks, channel: leaderChannel });
    const follower = await make({ locks, channel: followerChannel });
    const followerList = follower.subscribe('1', {});
    await followerList.ready;

    transport.gate.online = false;
    await follower.update('1', { title: 'doomed edit' });
    assert.equal(follower.overlayFor('1').title, 'doomed edit');

    server.state.revoked = true;
    transport.gate.online = true;
    await waitFor(() => pendingCount(follower) === 0);
    const [entry] = follower.outbox();
    assert.equal(entry.status, 'rejected');
    assert.deepEqual(entry.failure, { category: 'denied', message: 'forbidden' });
    await waitFor(() => follower.overlayStatusFor('1') === null, { timeoutMs: 2000 })
      .catch(() => assert.fail('placeholder should roll back from the shared outcome'));
    assert.equal(followerList.state.title, 'shared');
    leader.close();
    follower.close();
  });

  it('leadership handoff resends queued entries with the SAME actionIds', async () => {
    const db = freshDbName();
    const { server, transport, make } = makeStore({
      db,
      seedRows: { 1: { id: '1', title: 'shared' } },
    });
    const locks = makeLockCoordinator();
    const leaderChannel = makeFakeChannel();
    const followerChannel = makeFakeChannel();
    server.onCommit = (envelope) => leaderChannel.emit(envelope);

    const leader = await make({ locks, channel: leaderChannel });
    const follower = await make({ locks, channel: followerChannel });
    await leader.subscribe('1', {}).ready;
    await follower.subscribe('1', {}).ready;

    transport.gate.online = false;
    const result = await follower.update('1', { title: 'survives handoff' });
    assert.equal(result.status, 'queued');

    leader.close(); // the leader dies; the follower must take over
    transport.gate.online = true;
    await waitFor(() => transport.calls.filter((c) => c.method === 'PATCH').length === 1);
    assert.equal(transport.calls[0].actionId, result.actionId, 'the takeover resends the same actionId');
    await waitFor(() => pendingCount(follower) === 0);
    await waitFor(() => follower.overlayFor('1')?.title === 'survives handoff');
    follower.close();
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('batch flusher ordering', () => {
  it('a batch of queued edits reaches the server in per-scope enqueue order', async () => {
    const { server, transport, make } = makeStore({
      seedRows: {
        1: { id: '1', title: 'one' },
        2: { id: '2', title: 'two' },
      },
    });
    const store = await make();
    const list1 = store.subscribe('1', {});
    const list2 = store.subscribe('2', {});
    await Promise.all([list1.ready, list2.ready]);

    transport.gate.online = false;
    const results = [];
    results.push(await store.update('1', { title: '1st' }));
    results.push(await store.update('1', { title: '2nd' }));
    results.push(await store.update('2', { title: 'other scope' }));
    results.push(await store.update('1', { title: '3rd' }));
    assert.ok(results.every((r) => r.status === 'queued'));

    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    await waitFor(() => list1.state.title === '3rd');

    const patches = server.state.requests.filter((r) => r.method === 'PATCH');
    const rowOne = patches.filter((r) => r.body.id === '1').map((r) => r.body.title);
    const rowTwo = patches.filter((r) => r.body.id === '2').map((r) => r.body.title);
    assert.deepEqual(rowOne, ['1st', '2nd', '3rd'], 'per-scope order holds across a batched flush');
    assert.deepEqual(rowTwo, ['other scope']);
    // Cross-scope chains may interleave; each scope stays ordered.
    const positions = patches.map((r) => r.body.title);
    assert.ok(
      positions.indexOf('1st') < positions.indexOf('2nd') && positions.indexOf('2nd') < positions.indexOf('3rd'),
      'enqueue order preserved within the scope',
    );
    assert.equal(server.state.rows.get('1').title, '3rd');
    assert.equal(server.state.rows.get('2').title, 'other scope');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Per-kind conflict behavior (M1, docs/conflict-merge-policy.md)
// ---------------------------------------------------------------------------

describe('per-kind conflict behavior on resend', () => {
  it('value: the resent whole value replaces — last commit wins, silent', async () => {
    const { server, transport, make } = makeStore({
      kinds: { title: 'value' },
      seedRows: { 1: { id: '1', title: 'start' } },
    });
    const store = await make();
    const list = store.subscribe('1', {});
    await list.ready;

    transport.gate.online = false;
    await store.update('1', { title: 'mine' });
    // A concurrent writer commits while our edit is queued.
    server.remoteUpdate('1', { title: 'theirs' });
    await waitFor(() => list.state.title === 'theirs');

    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    await waitFor(() => list.state.title === 'mine');
    assert.equal(server.state.rows.get('1').title, 'mine', 'whole-value replace: our commit is later, it wins');
    assert.equal(transport.calls.filter((c) => c.method === 'PATCH').length, 1, 'one resend, same bytes');
    store.close();
  });

  it('map: the resent member add merges with concurrent member writes', async () => {
    const { server, transport, make } = makeStore({
      kinds: { members: 'map' },
      seedRows: { 1: { id: '1', members: { bob: 'editor' } } },
    });
    const store = await make();
    const list = store.subscribe('1', {});
    await list.ready;

    transport.gate.online = false;
    await store.update('1', { members: { added: [{ member: 'alice', role: 'viewer' }] } });
    server.remoteMapUpdate('1', 'members', { added: [{ member: 'carol', role: 'admin' }] });
    await waitFor(() => 'carol' in (list.state.members ?? {}));

    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    await waitFor(() => 'alice' in (list.state.members ?? {}));
    assert.deepEqual(list.state.members, { bob: 'editor', carol: 'admin', alice: 'viewer' },
      'map kind merges across members; the resend does not clobber carol');
    store.close();
  });

  it('ordered: the resent insert coexists with a concurrent insert (distinct ids)', async () => {
    const { server, transport, make } = makeStore({
      kinds: { steps: 'ordered' },
      seedRows: { 1: { id: '1', steps: ['a'] } },
    });
    const store = await make();
    const list = store.subscribe('1', {});
    await list.ready;

    transport.gate.online = false;
    await store.update('1', { steps: { insert: { id: 'c', after: 'a' } } });
    server.remoteOrderedInsert('1', 'steps', 'b', 'a');
    await waitFor(() => (list.state.steps ?? []).includes('b'));

    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    await waitFor(() => (list.state.steps ?? []).includes('c'));
    assert.deepEqual(list.state.steps, ['a', 'c', 'b'],
      'distinct ids coexist — no renumber, no clobber of the concurrent insert');
    store.close();
  });

  it('live tier: a stale expectedRevision fails closed — 409 rejects and rolls back', async () => {
    const { server, transport, make } = makeStore({
      seedRows: { 1: { id: '1', title: 'start' } },
    });
    const store = await make();
    const list = store.subscribe('1', {});
    await list.ready;

    transport.gate.online = false;
    await store.update('1', { title: 'stale edit', expectedRevision: 1 });
    // A concurrent commit advances the row revision past our queued revision.
    server.remoteUpdate('1', { title: 'concurrent' });
    await waitFor(() => list.state.title === 'concurrent');

    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    const [entry] = store.outbox();
    assert.equal(entry.status, 'rejected');
    assert.equal(entry.failure.category, 'conflict');
    assert.match(entry.failure.message, /stale revision/);
    await waitFor(() => store.overlayStatusFor('1') === null);
    assert.equal(list.state.title, 'concurrent', 'fail-closed: the stale placeholder rolled back');
    assert.equal(server.state.rows.get('1').title, 'concurrent', 'the server kept its version');
    store.close();
  });

  it('crdt text ops stay on their own durable text outbox — the CRUD outbox never captures .apply', async () => {
    const { make } = makeStore({});
    const store = await make();
    const result = await store.apply('1', 'body', { op: 'insert', at: 0, text: 'x' });
    assert.equal(result.status, 'outcome-unknown', 'unchanged apply semantics');
    assert.deepEqual(store.outbox(), [], 'the CRUD outbox does not own text ops');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Stale cursor rule (SPEC §7.1) — decided: hard-fail re-bootstrap, queue survives
// ---------------------------------------------------------------------------

describe('stale-cursor rule', () => {
  it('a forced re-bootstrap never truncates queued actions; they replay and converge', async () => {
    const { server, transport, channel, make } = makeStore({
      seedRows: { 1: { id: '1', title: 'start' } },
    });
    const store = await make();
    const list = store.subscribe('1', {});
    await list.ready;
    assert.deepEqual(list.state, { id: '1', title: 'start' });

    transport.gate.online = false;
    const result = await store.update('1', { title: 'queued through re-bootstrap' });
    assert.equal(result.status, 'queued');

    // Concurrent server commit, then a stale-snapshot control forces the
    // SPEC §7.1 hard-fail re-bootstrap (fresh snapshot replaces the base).
    server.remoteUpdate('1', { title: 'concurrent base' });
    await waitFor(() => list.state.title === 'concurrent base');
    channel.resync('Todo', '1', {
      reason: 'recipient-snapshot-required',
      entity: 'Todo',
      id: '1',
      seq: server.state.scopeSeqs.get('Todo:1'),
    });
    await waitFor(() => pendingCount(store) === 1, { timeoutMs: 500 });
    assert.deepEqual(store.outbox().map((r) => r.status), ['queued'],
      'the re-bootstrap replaced the base, never the queue — no silent truncate');

    transport.gate.online = true;
    store.flushOutbox();
    await waitFor(() => pendingCount(store) === 0);
    await waitFor(() => list.state.title === 'queued through re-bootstrap');
    assert.deepEqual(server.state.requests.map((r) => r.actionId), [result.actionId]);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Durability across reloads
// ---------------------------------------------------------------------------

describe('reload durability', () => {
  it('a queued mutation survives store close and resends from a fresh session', async () => {
    const db = freshDbName();
    const first = makeStore({ db, seedRows: { 1: { id: '1', title: 'start' } } });
    const store1 = await first.make();
    const list1 = store1.subscribe('1', {});
    await list1.ready;

    first.transport.gate.online = false;
    const result = await store1.update('1', { title: 'durable edit' });
    assert.equal(result.status, 'queued');
    const actionId = result.actionId;
    store1.close();

    // A brand-new session over the same local log: the queue is durable.
    const second = makeStore({ db, server: first.server, seedRows: { 1: { id: '1', title: 'start' } } });
    second.transport.gate.online = true;
    const store2 = await second.make();
    const list2 = store2.subscribe('1', {});
    await list2.ready;
    await waitFor(() => pendingCount(store2) === 0);
    assert.equal(second.transport.calls[0]?.actionId, actionId, 'the reload resends the same actionId');
    await waitFor(() => list2.state.title === 'durable edit');
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// Local log integration
// ---------------------------------------------------------------------------

describe('outbox rows in the local log', () => {
  it('prune never drops outbox rows — they are live mutations, not history', async () => {
    const db = freshDbName();
    const log = await openLocalLog(db);
    await log.append({
      opId: 'old', seq: 1, scope: 'Todo:1', entity: 'Todo', rowId: '1', kind: 'update',
      type: 'Todo.updated', payload: {}, preimage: null, actionId: 'old-1',
      status: 'committed', source: 'remote', timestamp: 1000,
    });
    await log.outboxAppend({
      actionId: 'queued-1', opId: 'op_1', entity: 'Todo', rowId: '1', kind: 'update',
      payload: { title: 'x' }, body: '{"id":"1","title":"x"}', targetScope: 'Todo:1',
      status: 'queued', attempts: 0, createdAt: 1000, updatedAt: 1000, timestamp: 1000,
    });
    const removed = await log.prune(5000);
    assert.equal(removed, 1, 'the committed history row is pruned');
    const rows = await log.outboxEntries(0);
    assert.equal(rows.length, 1, 'the queued mutation survives');
    assert.equal(rows[0].actionId, 'queued-1');
    log.close();
  });
});
