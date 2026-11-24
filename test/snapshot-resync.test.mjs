// Priority 1, ★1 — snapshot endpoint + subscribe-since replay + hard-fail.
// The materialized entity table IS the snapshot (scope's proven shape); the
// committed `_Log` is the RESYNC source. A client bootstraps from a snapshot
// (row + per-scope seq), then replays the log from its cursor forward. If the
// client's cursor fell behind the oldest retained event, the server HARD-FAILs —
// `{resync:'stale'}` — forcing a full re-bootstrap. Never a silent truncate
// (eng-review §3.6, the single non-negotiable correctness property; spec #1, D6/D7).

import { text, ref, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity, event } from '../build/internal.mjs';
import { createClient } from '../build/pipeline.mjs';

function ownedNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

function ownedTextNote() {
  return entity('TextNote', {
    body: text.crdt(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

async function harness(t, principalId = 'u1', authorization) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: principalId }), ...(authorization ? { authorization } : {}) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });
  return { app, db, base };
}

function denyEntityRowsAdapter() {
  return {
    async admit(input) {
      return { admitted: input.category !== 'entity', reasonCode: input.category === 'entity' ? 'no-capability' : null };
    },
    registerResource() {},
  };
}

const json = (r) => r.json();

test('injected adapter denial applies to snapshot and events-since', async (t) => {
  const { app, db: _db, base } = await harness(t, 'u1', denyEntityRowsAdapter());
  app.entities.get('Note').insert({ id: 'n1', body: 'hello', owner: 'u1' });
  const snapshot = await fetch(`${base}/snapshot/Note/n1`);
  assert.equal(snapshot.status, 403);
  const events = await fetch(`${base}/events-since/Note/n1?cursor=0`);
  assert.equal(events.status, 403);
});

test('snapshot endpoint returns the materialized row + the per-scope seq, authorized', async (t) => {
  const { app, db: _db, base } = await harness(t);
  // Seed a note owned by u1 via the trusted insert (no _Log append → scope seq 0).
  app.entities.get('Note').insert({ id: 'n1', body: 'hello', owner: 'u1' });

  // A mutation on a DIFFERENT scope advances that scope's cursor, not n1's.
  const created = await json(await fetch(`${base}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'other' }),
  }));
  assert.equal(created.owner, 'u1');

  // n1: no committed events → seq 0; the row is the snapshot.
  const s1 = await json(await fetch(`${base}/snapshot/Note/n1`));
  assert.equal(s1.snapshot.id, 'n1');
  assert.equal(s1.snapshot.body, 'hello');
  assert.equal(s1.seq, 0, 'a seeded row with no events has per-scope seq 0');

  // n2: one created event → seq 1.
  const s2 = await json(await fetch(`${base}/snapshot/Note/${created.id}`));
  assert.equal(s2.snapshot.id, created.id);
  assert.equal(s2.seq, 1, 'the created scope advanced to seq 1');

  // Anonymous → 401 (the route gate, fail closed).
  // (the harness principal is fixed at u1; a readScope miss is the authz path here)
  // A second app as a non-owner sees the row out of scope → 404.
  const db2 = new DatabaseSync(':memory:');
  const other = workbench({ db: db2 });
  other.mount('/notes', ownedNote());
  await other.ddl();
  other.listen(0, { principalOf: () => ({ id: 'u2' }) });
  await other.ready;
  other.entities.get('Note').insert({ id: 'n1', body: 'hello', owner: 'u1' });
  t.after(() => { other.httpServer.close(); db2.close(); });
  const denied = await fetch(`http://127.0.0.1:${other.httpServer.address().port}/snapshot/Note/n1`);
  assert.equal(denied.status, 404, 'a non-owner (out of read scope) gets 404, fail closed');
});

test('events-since returns committed events after the cursor, in seq order', async (t) => {
  const { base } = await harness(t);
  const created = await json(await fetch(`${base}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'v0' }),
  }));
  const id = created.id;
  await fetch(`${base}/notes/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'v1' }),
  });
  await fetch(`${base}/notes/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'v2' }),
  });

  const fromZero = await json(await fetch(`${base}/events-since/Note/${id}?cursor=0`));
  assert.equal(fromZero.events.length, 3);
  assert.deepEqual(fromZero.events.map((e) => e.seq), [1, 2, 3], 'events are in seq order');
  assert.equal(fromZero.events[0].type, 'Note.created');
  assert.equal(fromZero.events[1].type, 'Note.updated');
  assert.equal(fromZero.events[2].type, 'Note.updated');
  assert.equal(fromZero.events[0].scope, `Note:${id}`);

  const fromOne = await json(await fetch(`${base}/events-since/Note/${id}?cursor=1`));
  assert.equal(fromOne.events.length, 2);
  assert.deepEqual(fromOne.events.map((e) => e.seq), [2, 3], 'cursor is exclusive');

  // cursor at/over the head → empty, no events.
  const atHead = await json(await fetch(`${base}/events-since/Note/${id}?cursor=3`));
  assert.equal(atHead.events.length, 0);
});

test('entity events-since strips framework-only event metadata', async (t) => {
  const { app, base } = await harness(t);
  const Note = app.entities.get('Note');
  const result = await app.dispatch({
    actionId: 'private-event', type: 'Note.create', scope: 'Note:n1', principal: { id: 'u1' },
    payload: { id: 'n1', body: 'visible' },
  });
  assert.equal(result.ok, true);
  app.db.prepare('UPDATE _Log SET eventData = ? WHERE scope = ?').run(
    JSON.stringify({ ...result.events[0].data, __workbench: { internal: true } }), 'Note:n1',
  );
  const replay = await json(await fetch(`${base}/events-since/Note/n1?cursor=0`));
  assert.ok(!Object.hasOwn(replay.events[0].data, '__workbench'));
  assert.equal(replay.events[0].data.body, 'visible');
  assert.ok(Note);
});

test('text snapshots and created replay carry reducer sidecars while ordinary rows stay visible', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/text-notes', ownedTextNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const created = await json(await fetch(`${base}/text-notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  }));
  assert.equal(created.body, '');
  assert.equal(created.__textCheckpoints, undefined);
  const id = created.id;
  const operation = ['workbench.text', 1, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1], 1, [], ['insert', ['root'], 'hello']];
  const applied = await json(await fetch(`${base}/text-notes/${id}/body/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation }),
  }));
  assert.equal(applied.body, 'hello');
  assert.equal(applied.__textCheckpoints, undefined);

  const snapshot = await json(await fetch(`${base}/snapshot/TextNote/${id}`));
  assert.equal(snapshot.snapshot.body, 'hello');
  assert.equal(snapshot.snapshot.__textCheckpoints, undefined);
  assert.equal(snapshot.reducers.length, 1);
  assert.deepEqual(Object.keys(snapshot.reducers[0]).sort(), ['checkpoint', 'entity', 'field', 'id', 'reducer', 'version']);
  assert.equal(snapshot.reducers[0].reducer, 'workbench.text');
  assert.ok(snapshot.reducers[0].checkpoint.operations['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1']);

  const history = await json(await fetch(`${base}/events-since/TextNote/${id}?cursor=0`));
  assert.equal(history.events[0].type, 'TextNote.created');
  assert.equal(history.events[0].reducers.length, 1);
  assert.equal(history.events[0].reducers[0].checkpoint.operations['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1'], undefined);
  assert.equal(history.events[1].type, 'TextNote.body.applied');
  assert.equal(history.events[1].reducers, undefined);
});

test('hard-fail on a stale cursor — the log was trimmed past the client cursor', async (t) => {
  const { app, db, base } = await harness(t);
  const created = await json(await fetch(`${base}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'v0' }),
  }));
  await fetch(`${base}/notes/${created.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'v1' }),
  });
  const id = created.id;
  // Retention trimmed the oldest event out of the log (seq 1 is gone, oldest is 2).
  db.prepare(`DELETE FROM _Log WHERE scope = ? AND seq = 1`).run(`Note:${id}`);

  // A client at cursor 0 asks for events > 0. The first wanted seq (1) is older
  // than the oldest retained (2) → HARD-FAIL, never a silent truncate.
  const r = await fetch(`${base}/events-since/Note/${id}?cursor=0`);
  const body = await json(r);
  assert.equal(body.resync, 'stale', 'a cursor behind retention hard-fails');
  assert.equal(body.reason, 'cursor-behind-retention');
  assert.equal(body.events, undefined, 'no partial events on a hard-fail');

  // A current cursor (1) that is still within retention replays normally.
  const ok = await json(await fetch(`${base}/events-since/Note/${id}?cursor=1`));
  assert.equal(ok.events.length, 1, 'cursor inside retention replays');
  assert.equal(ok.events[0].seq, 2);
  // app/db referenced so linters don't complain; db used above for the trim.
  void app;
});

test('createClient folds a resync gap in order and advances the cursor', async (t) => {
  // The client reducer folds committed-event data into snapshot state. The same
  // shape the kernel commits (and events-since returns) is what ingest folds.
  const reduce = (state, ev) => ({ ...state, ...ev.data });

  const client = createClient({
    events: [
      event('Note.created', reduce),
      event('Note.updated', reduce),
      event('Note.removed', () => null),
    ],
  });

  // Bootstrap from a snapshot at seq 1; the cursor is set BEFORE any live event.
  client.bootstrap('Note:n1', { id: 'n1', body: 'v0', owner: 'u1' }, 1);
  assert.equal(client.cursor('Note:n1'), 1);

  // An event at seq 3 arrives (seq 2 is missing) → GAP, do not apply, signal resync.
  const gap = client.ingest({ type: 'Note.updated', scope: 'Note:n1', seq: 3, data: { body: 'v2' } });
  assert.equal(gap.applied, false);
  assert.equal(gap.resync, true);
  assert.equal(client.cursor('Note:n1'), 1, 'the cursor did not advance on a gap');

  // The resync fetch returns the missing events in order; fold each.
  const fetched = [
    { type: 'Note.updated', scope: 'Note:n1', seq: 2, data: { body: 'v1' } },
    { type: 'Note.updated', scope: 'Note:n1', seq: 3, data: { body: 'v2' } },
  ];
  const r2 = client.ingest(fetched[0]);
  const r3 = client.ingest(fetched[1]);
  assert.equal(r2.applied, true);
  assert.equal(r3.applied, true);
  assert.equal(client.cursor('Note:n1'), 3, 'cursor advanced through the gap');
  assert.equal(client.state('Note:n1').body, 'v2');
  void t;
});

test('createClient idempotently skips duplicates and folds the next event once', async () => {
  const reduce = (state, ev) => ({ ...state, ...ev.data });
  const client = createClient({
    events: [event('Note.created', reduce), event('Note.updated', reduce)],
  });
  client.bootstrap('Note:n1', {}, 1);

  // seq 1 was already folded at bootstrap (cursor=1); a redelivery → duplicate skip.
  const dup = client.ingest({ type: 'Note.updated', scope: 'Note:n1', seq: 1, data: { body: 'x' } });
  assert.equal(dup.applied, false);
  assert.equal(dup.duplicate, true);

  // seq 2 is the expected next → fold exactly once, advance.
  const next = client.ingest({ type: 'Note.updated', scope: 'Note:n1', seq: 2, data: { body: 'folded' } });
  assert.equal(next.applied, true);
  assert.equal(client.cursor('Note:n1'), 2);
  assert.equal(client.state('Note:n1').body, 'folded');

  // a second delivery of seq 2 → duplicate skip, not a re-fold.
  const redup = client.ingest({ type: 'Note.updated', scope: 'Note:n1', seq: 2, data: { body: 'changed' } });
  assert.equal(redup.duplicate, true);
  assert.equal(client.state('Note:n1').body, 'folded', 'a duplicate did not re-fold');
});

test('snapshot row + cursor are read atomically — no split pair across the auth await', async (t) => {
  // A read `.can` that parks on a controllable promise, so a dispatch can COMMIT
  // during the auth await. The (row, seq) pair returned must be a consistent
  // snapshot: the cursor must match the row that was read, not advance past it
  // while the auth yields (eng-review Tier-1 #2 — row + cursor in one read).
  let releaseRead;
  let parkOnce = true;
  const yieldingNote = entity('Note', {
        body: text(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) => {
        // Park only on the FIRST .can call (the snapshot read). The commit below
        // rides on the write path, whose dispatch auth is `authorize: () => true`
        // (the in-txn afterProjection admission does not re-enter this `.can`),
        // so it is not blocked by this gate.
        if (parkOnce) {
          parkOnce = false;
          await new Promise((r) => { releaseRead = r; });
        }
        return (await is.owner()) ? grant(read, write, subscribe) : grant(read);
      }),
    ],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', yieldingNote);
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  // Seed n1 at v0 (trusted insert → scope seq 0, no _Log entry).
  app.entities.get('Note').insert({ id: 'n1', body: 'v0', owner: 'u1' });

  // Start the snapshot — it reads the row (body 'v0') then parks inside `.can`.
  const snapP = fetch(`${base}/snapshot/Note/n1`).then((r) => r.json());
  // Wait until the snapshot's `.can` has parked (releaseRead is set).
  for (let i = 0; i < 1000 && !releaseRead; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(releaseRead, 'the snapshot read parked inside the auth .can');

  // Commit an update DURING the auth await: v0 → v1, advancing n1's cursor 0 → 1.
  // (update is a partial merge — owner is preserved, the row stays in scope.)
  await app.writeQueue.run(() => app.kernel.dispatch({
    actionId: 'atomic-split-test-update',
    type: 'Note.update',
    payload: { id: 'n1', body: 'v1' },
    principal: { id: 'u1' },
  }));

  // Release the parked auth — the snapshot resumes and ( bug: reads the cursor
  // AFTER the commit; fix: the cursor was already read with the row, pre-commit ).
  releaseRead();
  const snap = await snapP;

  // The row was captured as 'v0' BEFORE the auth await. The cursor must therefore
  // ALSO be pre-commit (0) — a (v0, seq 1) pair never coexisted. A bug that reads
  // the cursor after the await yields seq 1 (split pair).
  assert.equal(snap.snapshot.body, 'v0', 'row is the pre-commit snapshot');
  assert.equal(snap.seq, 0, 'cursor matches the row — no split pair across the auth await');
});
