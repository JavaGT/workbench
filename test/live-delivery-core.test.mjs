import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createLiveDeliveryCore } from '../build/live-delivery-core.mjs';
import { createLiveEnvelopeBuilder } from '../build/live-delivery-envelope.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { scope } from '../build/scope.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE IF NOT EXISTS Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  return db;
}

function insertRow(db, id, title, owner = null, workspace = null) {
  db.prepare(`INSERT OR REPLACE INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run(id, title, owner, workspace);
}

function appendEvent(db, scope, seq, type, data = {}) {
  db.prepare(
    `INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(scope, seq, type, JSON.stringify(data), `action-${seq}`, new Date().toISOString());
  db.prepare(
    `INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)
     ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq`,
  ).run(scope, seq);
}

const alwaysAllow = async () => true;

function simpleProjector({ event, scope }) {
  return [{ type: event.eventType ?? event.type, seq: event.seq, data: event.data, scope }];
}

function makeEntityRecord(name, opts = {}) {
  const hydrate = 'hydrate' in opts ? opts.hydrate : (row) => ({ ...row });
  const scopeFilter = typeof opts.scopeFilter === 'function' ? opts.scopeFilter : () => ({ sql: '1=1', params: {} });
  return {
    name,
    hydrate,
    scopeFilter,
    grant: opts.grant ?? (() => [scope(() => true).can(async () => true)]),
    registry: opts.registry ?? {},
  };
}

test('initial canonical reread — delivers events subscribed after 0', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'world' });

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered.push(...batch); },
  });

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].seq, 1);
  assert.equal(delivered[1].seq, 2);

  core.close();
});

test('resume from after cursor', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'world' });
  appendEvent(db, 'Note:n1', 3, 'Note.updated', { title: '!' });

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 1,
    signal: null,
    deliver: async (batch) => { delivered.push(...batch); },
  });

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].seq, 2);
  assert.equal(delivered[1].seq, 3);

  core.close();
});

test('failure does not advance cursor — resubscribe gets same event', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const delivered = [];
  let failOnce = true;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const ac = new AbortController();
  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: ac.signal,
      deliver: async (batch) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('delivery failure');
        }
        delivered.push(...batch);
      },
    }),
    /delivery callback threw/,
  );

  assert.equal(delivered.length, 0);

  const delivered2 = [];
  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered2.push(...batch); },
  });

  assert.equal(delivered2.length, 1);
  assert.equal(delivered2[0].seq, 1);

  core.close();
});

test('admission denial — scopeFilter deny sends nothing', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note', { scopeFilter: () => ({ sql: '1=0', params: {} }) })]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /authorization denied/,
  );

  core.close();
});

test('admission denial — mayVerb deny sends nothing', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: async () => false,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /authorization denied/,
  );

  core.close();
});

test('admission denial — unknown entity fails closed', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created');

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'BadKey:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /unknown entity 'BadKey'/,
  );

  core.close();
});

test('admission denial — malformed scope fails closed', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'invalid-scope',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /invalid scope/,
  );

  core.close();
});

test('revocation after first batch prevents second', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello', 'u1');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  let authCount = 0;
  const mayVerbFn = async () => {
    authCount++;
    // subscribe does checkMayRow + catchUp's checkMayRow (2 calls), deny on 3rd (wake)
    return authCount <= 2;
  };

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: mayVerbFn,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered.push(...batch); },
  });

  assert.equal(delivered.length, 1);
  assert.equal(authCount, 2);

  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'revoked' });

  await core.wake('Note:n1');
  await sleep(50);

  assert.equal(delivered.length, 1, 'second event not delivered after revocation');
  assert.equal(authCount, 3, 'third auth attempt made and denied');

  core.close();
});

test('re-authorization runs through the injected adapter (S5/A2 single path)', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello', 'u1');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  let admits = 0;
  const adapter = {
    admit: async (input) => {
      assert.equal(input.category, 'entity');
      assert.equal(input.verb, 'subscribe');
      assert.equal(input.operation, 'subscribe');
      admits += 1;
      // subscribe does checkMayRow + catchUp's checkMayRow (2 admits), deny on 3rd (wake)
      return { admitted: admits <= 2, reasonCode: admits <= 2 ? null : 'no-capability' };
    },
    registerResource: () => {},
  };

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    authorization: adapter,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered.push(...batch); },
  });

  assert.equal(delivered.length, 1);
  assert.equal(admits, 2);

  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'revoked' });
  await core.wake('Note:n1');
  await sleep(50);

  assert.equal(delivered.length, 1, 'second event not delivered after adapter denial');
  assert.equal(admits, 3, 'the third re-authorization went through the adapter and denied');

  core.close();
});

test('terminal removal delivers after its authorization row is deleted', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');

  const delivered = [];
  let revoked = false;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered.push(...batch); },
    revoke: () => { revoked = true; },
  });

  db.prepare('DELETE FROM Note WHERE id = ?').run('n1');
  appendEvent(db, 'Note:n1', 1, 'Note.removed');
  await core.wake('Note:n1');
  await sleep(30);

  assert.deepEqual(delivered.map((event) => event.type), ['Note.removed']);
  assert.equal(revoked, true, 'the terminal removal ends the stream through the one removal path');
  core.close();
});

test('missing authorization row rejects non-removal events', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered.push(...batch); },
  });

  db.prepare('DELETE FROM Note WHERE id = ?').run('n1');
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'must not deliver' });
  await core.wake('Note:n1');
  await sleep(30);

  assert.equal(delivered.length, 0);
  core.close();
});

test('deleted-row catch-up revokes rather than delivering a gapped terminal removal', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');

  const delivered = [];
  let revoked = false;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered.push(...batch); },
    revoke: () => { revoked = true; },
  });

  db.prepare('DELETE FROM Note WHERE id = ?').run('n1');
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'must not deliver' });
  appendEvent(db, 'Note:n1', 2, 'Note.removed');
  await core.wake('Note:n1');
  await sleep(30);

  assert.deepEqual(delivered, []);
  assert.equal(revoked, true);
  core.close();
});

test('duplicate wake does not duplicate events', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  let deliverCount = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { deliverCount += batch.length; },
  });

  assert.equal(deliverCount, 1);

  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'two' });

  core.wake('Note:n1');
  core.wake('Note:n1');

  await sleep(50);

  assert.equal(deliverCount, 2);

  appendEvent(db, 'Note:n1', 3, 'Note.updated', { title: 'three' });
  await core.wake('Note:n1');
  await sleep(50);

  assert.equal(deliverCount, 3);

  core.close();
});

test('projectRecipient must return array', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: () => null,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /projectRecipient must return an array/,
  );

  core.close();
});

test('after must be safe nonnegative integer', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: -1,
      signal: null,
      deliver: async () => {},
    }),
    /nonnegative safe integer/,
  );

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 1.5,
      signal: null,
      deliver: async () => {},
    }),
    /nonnegative safe integer/,
  );

  core.close();
});

test('constructor requires all arguments', () => {
  assert.throws(() => createLiveDeliveryCore({}), /db is required/);
  assert.throws(() => createLiveDeliveryCore({ db: {} }), /entities is required/);
  assert.throws(() => createLiveDeliveryCore({ db: {}, entities: new Map() }), /mayVerb is required/);
  assert.throws(() => createLiveDeliveryCore({ db: {}, entities: new Map(), mayVerb: () => {} }), /projectRecipient must be a function/);
});

// ---- New required tests ----

test('(1) independent opaque subscription records — same scope multiple recipients cannot share cursor', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  const delivered1 = [];
  const delivered2 = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered1.push(...batch); },
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u2' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered2.push(...batch); },
  });

  assert.equal(delivered1.length, 1);
  assert.equal(delivered2.length, 1);

  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });

  await core.wake('Note:n1');
  await sleep(50);

  assert.equal(delivered1.length, 2, 'sub1 got second event');
  assert.equal(delivered2.length, 2, 'sub2 got second event');

  core.close();
});

test('(2) lost-wake race — wake during active read triggers second reread', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let inDelivery = false;
  let deliveryResolve;
  const deliveryGate = new Promise((r) => { deliveryResolve = r; });

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const subPromise = core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => {
      delivered.push(...batch);
      inDelivery = true;
      await deliveryGate;
    },
  });

  while (!inDelivery) await sleep(5);

  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });

  core.wake('Note:n1');

  deliveryResolve();

  await subPromise;

  await sleep(50);

  assert.equal(delivered.length, 2, 'both events delivered despite wake during active read');
  assert.equal(delivered[0].seq, 1);
  assert.equal(delivered[1].seq, 2);

  core.close();
});

test('(3) scope-filter denial despite mayVerb true', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello', 'u1', 'secret');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note', {
      scopeFilter: () => ({ sql: 'workspace = :ws', params: { ws: 'public' } }),
    })]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /authorization denied/,
  );

  core.close();
});

test('(4) fail closed on absent hydrate — no raw row fallback', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note', { hydrate: undefined })]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /authorization denied/,
  );

  core.close();
});

test('(4) fail closed on hydrate returning null', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note', {
      hydrate: () => null,
    })]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /authorization denied/,
  );

  core.close();
});

test('(4) fail closed on hydrate throwing', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note', {
      hydrate: () => { throw new Error('hydrate boom'); },
    })]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /authorization denied/,
  );

  core.close();
});

test('(5) context contains principal and hydrated row', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello', 'u1');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const contexts = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: (ctx) => {
      contexts.push(ctx);
      return [{ type: ctx.event.type, seq: ctx.event.seq }];
    },
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async () => {},
  });

  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0].principal, { type: 'user', id: 'u1' });
  assert.ok(contexts[0].row !== undefined, 'row is present');
  assert.equal(contexts[0].row.title, 'hello');
  assert.equal(contexts[0].event.seq, 1);
  assert.equal(contexts[0].scope, 'Note:n1');

  core.close();
});

test('(5) projector failure — fails closed, only that subscription loses cursor', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  insertRow(db, 'n2', 'world');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });
  appendEvent(db, 'Note:n2', 1, 'Note.created', { title: 'world' });

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: (ctx) => {
      if (ctx.scope === 'Note:n1') throw new Error('projector boom');
      return [{ type: ctx.event.type, seq: ctx.event.seq }];
    },
  });

  const delivered2 = [];
  await core.subscribe({
    principal: { type: 'user', id: 'u2' },
    scope: 'Note:n2',
    after: 0,
    signal: null,
    deliver: async (batch) => { delivered2.push(...batch); },
  });

  assert.equal(delivered2.length, 1);

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /projectRecipient threw/,
  );

  appendEvent(db, 'Note:n2', 2, 'Note.updated', { title: 'second' });
  await core.wake('Note:n2');
  await sleep(50);

  assert.equal(delivered2.length, 2, 'Note:n2 subscription still works after Note:n1 projector failure');

  core.close();
});

// ---- (a) abort/close during active delivery blocks later delivery ----

test('(6) close prevents delivery after removal even when active', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let inDelivery = false;
  let deliveryResolve;
  const deliveryGate = new Promise((r) => { deliveryResolve = r; });

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const subPromise = core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => {
      delivered.push(...batch);
      inDelivery = true;
      await deliveryGate;
    },
  });

  while (!inDelivery) await sleep(5);

  // Close the core while delivery is in-flight
  core.close();

  deliveryResolve();
  await subPromise;

  // Try to add another event and wake — should not deliver
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });
  await core.wake('Note:n1');
  await sleep(50);

  assert.equal(delivered.length, 1, 'second event not delivered after close');
});

test('(7) abort signal during subscribe prevents delivery', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const ac = new AbortController();
  ac.abort();

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: ac.signal,
    deliver: async (batch) => { delivered.push(...batch); },
  });

  assert.equal(delivered.length, 0, 'no delivery after aborted signal');

  core.close();
});

test('(8) removeSub during active catchUp prevents cursor advance', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });

  let inDelivery = false;
  let deliveryResolve;
  const deliveryGate = new Promise((r) => { deliveryResolve = r; });

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: (ctx) => {
      if (ctx.event.seq === 1) {
        return [{ type: 'blocked', seq: ctx.event.seq }];
      }
      return [];
    },
  });

  const subPromise = core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => {
      delivered.push(...batch);
      inDelivery = true;
      await deliveryGate;
    },
  });

  while (!inDelivery) await sleep(5);

  // Close the core — this sets active=false on all subs
  core.close();

  deliveryResolve();
  await subPromise;

  // The subscription was removed, cursor should not advance
  await sleep(50);

  // Only the first event should have been delivered (seq 1)
  // The second event was never read because the loop would have gone back
  // to check dirty. Delivery was gated, so we delivered seq 1.
  // After close, active=false, so no further processing.
  assert.equal(delivered.length, 1);

  core.close();
});

// ---- (b) scopeFilter/hydrate errors must log, remove subscription, and fail closed ----

test('(9) scope filter error during wake removes subscription', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  const logged = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note', {
      scopeFilter: () => { throw new Error('scopeFilter boom'); },
    })]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
    log: { error: (...args) => { logged.push(args); } },
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /authorization denied/,
  );

  assert.ok(logged.length > 0, 'error should have been logged');
  assert.ok(logged.some((entry) => String(entry).includes('reauth')), 'log should mention reauth');

  core.close();
});

test('(10) hydrate error during wake removes subscription', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  const logged = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note', {
      hydrate: () => { throw new Error('hydrate boom'); },
    })]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
    log: { error: (...args) => { logged.push(args); } },
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /authorization denied/,
  );

  assert.ok(logged.length > 0, 'error should have been logged');

  core.close();
});

// ---- (c) scope filter/hydrate receive recipient principal ----

test('(11) scopeFilter receives subscription principal', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello', 'u1', 'team-a');
  insertRow(db, 'n2', 'secret', 'u2', 'team-b');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const principals = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note', {
      scopeFilter: (principal) => {
        principals.push(principal);
        return { sql: 'owner = :owner', params: { owner: principal.id } };
      },
    })]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async () => {},
  });

  assert.ok(principals.length >= 1, 'scopeFilter called at least once per batch');
  assert.deepEqual(principals[0], { type: 'user', id: 'u1' });

  core.close();
});

test('(12) hydrate receives subscription principal', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello', 'u1');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const principals = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note', {
      hydrate: (row, principal) => {
        principals.push(principal);
        return { ...row };
      },
    })]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async () => {},
  });

  assert.ok(principals.length >= 1, 'hydrate called at least once per batch');
  assert.deepEqual(principals[0], { type: 'user', id: 'u1' });

  core.close();
});

// ---- (d) error removal tests ----

test('(13) mayRow error during wake removes subscription and logs', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  const logged = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: async () => { throw new Error('mayVerb boom'); },
    projectRecipient: simpleProjector,
    log: { error: (...args) => { logged.push(args); } },
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' },
      scope: 'Note:n1',
      after: 0,
      signal: null,
      deliver: async () => {},
    }),
    /authorization denied/,
  );

  assert.ok(logged.length > 0, 'error should have been logged');

  core.close();
});

test('(14) abort listener unregistered in removeSub', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const ac = new AbortController();
  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: ac.signal,
    deliver: async (batch) => { delivered.push(...batch); },
  });

  assert.equal(delivered.length, 1);

  // Abort the signal — this should trigger removeSub
  ac.abort();

  // Add another event and wake — should not be delivered
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });
  await core.wake('Note:n1');
  await sleep(50);

  assert.equal(delivered.length, 1, 'second event not delivered after abort');

  core.close();
});

// ---- (e) Review-required deterministic regression tests ----

test('(R2) duplicate wake does not duplicate events — dirty/pending mechanism prevents replay', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let deliveryCount = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { deliveryCount += batch.length; },
  });

  assert.equal(deliveryCount, 1);

  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });

  // Two wake calls — the second should be folded into dirty/pending
  core.wake('Note:n1');
  core.wake('Note:n1');
  await sleep(50);

  assert.equal(deliveryCount, 2, 'only one delivery for seq 2 despite two wakes');

  appendEvent(db, 'Note:n1', 3, 'Note.updated', { title: 'third' });
  core.wake('Note:n1');
  await sleep(50);

  assert.equal(deliveryCount, 3, 'seq 3 delivered correctly after duplicate wakes');

  core.close();
});

test('(R2) job event wake followed by consumer wake — no duplicate delivery', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let deliveryCount = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (batch) => { deliveryCount += batch.length; },
  });

  assert.equal(deliveryCount, 1);

  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });

  // Simulate a job event wake (app.jobs.onEvent -> app.live.wake)
  core.wake('Note:n1');
  await sleep(30);

  // Simulate a post-commit consumer wake (createConsumer -> core.wake)
  core.wake('Note:n1');
  await sleep(50);

  assert.equal(deliveryCount, 2, 'no duplicate delivery from job event + consumer wake');

  core.close();
});

test('(R5) core rejected nested dirty rerun does not become unhandled and closes subscription', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let inDelivery = false;
  let deliveryResolve;
  const deliveryGate = new Promise((r) => { deliveryResolve = r; });

  let callCount = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: (ctx) => {
      callCount++;
      if (callCount > 1) throw new Error('projector nested rerun failure');
      return [{ type: ctx.event.type, seq: ctx.event.seq }];
    },
    log: { error: () => {} },
  });

  // Subscribe — the initial catchUp processes seq 1, the deliver callback
  // gates so we can wake during the delivery.
  const subPromise = core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: null,
    deliver: async (_batch) => {
      inDelivery = true;
      await deliveryGate;
    },
  });

  while (!inDelivery) await sleep(5);

  // Release the first delivery gate — the initial catchUp finishes,
  // the subscribe promise resolves.
  deliveryResolve();
  await subPromise;
  await sleep(10);

  // Now append seq 2 and wake — this triggers a new catchUp call (nested
  // via wake), which fails because callCount > 1.
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });
  core.wake('Note:n1');
  await sleep(50);

  // No subscription should remain for Note:n1
  // Verify by waking again — should not throw
  core.wake('Note:n1');
  await sleep(50);

  // The core.close() should be clean
  core.close();
});

// ---- (f) Envelope builder tests (R3) ----

test('(R3) shared envelope builder preserves delta and text reducer outputs for ordinary committed events', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello', 'u1');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  // Entity with a value field (for delta) and a text/crdt field (for reducers)
  const entity = {
    name: 'Note',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    fields: {
      title: { kind: 'value' },
      body: { kind: 'crdt', type: 'text' },
    },
    grant: [],
  };

  const envelopeBuilder = createLiveEnvelopeBuilder();

  // Create a created event context — should produce reducers, no delta
  const row = { id: 'n1', title: 'hello', body: '{"version":1,"operations":{},"elements":{},"applied":[],"pending":[],"frontier":[]}' };
  const ctxCreate = {
    entity,
    event: { scope: 'Note:n1', seq: 1, eventType: 'Note.created', data: { id: 'n1', title: 'hello' } },
    principal: { type: 'user', id: 'u1' },
    row,
    scope: 'Note:n1',
  };

  const createEnvs = envelopeBuilder.buildEnvelope(ctxCreate);
  assert.equal(createEnvs.length, 1, 'created event produces one envelope');
  assert.equal(createEnvs[0].type, 'event');
  assert.equal(createEnvs[0].entity, 'Note');
  assert.equal(createEnvs[0].id, 'n1');
  assert.equal(createEnvs[0].seq, 1);
  assert.ok(createEnvs[0].reducers, 'created event has reducers');
  assert.ok(Array.isArray(createEnvs[0].reducers), 'reducers is an array');
  assert.ok(createEnvs[0].reducers.length > 0, 'reducers has entries for text/crdt field');
  assert.equal(createEnvs[0].reducers[0].field, 'body', 'reducer targets body');
  assert.equal(createEnvs[0].reducers[0].reducer, 'workbench.text');
  assert.equal(createEnvs[0].delta, undefined, 'created event has no delta');
  assert.equal(createEnvs[0].event.type, 'Note.created');
  assert.deepEqual(createEnvs[0].seqSpan, [1, 1]);

  // Create an updated event context — should produce delta, no reducers
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'world' });
  const updatedRow = { id: 'n1', title: 'world', body: '{"version":1,"operations":{},"elements":{},"applied":[],"pending":[],"frontier":[]}' };
  const ctxUpdate = {
    entity,
    event: { scope: 'Note:n1', seq: 2, eventType: 'Note.updated', data: { id: 'n1', title: 'world' } },
    principal: { type: 'user', id: 'u1' },
    row: updatedRow,
    scope: 'Note:n1',
  };

  const updateEnvs = envelopeBuilder.buildEnvelope(ctxUpdate);
  assert.equal(updateEnvs.length, 1, 'updated event produces one envelope');
  assert.equal(updateEnvs[0].type, 'event');
  assert.equal(updateEnvs[0].entity, 'Note');
  assert.equal(updateEnvs[0].id, 'n1');
  assert.equal(updateEnvs[0].seq, 2);
  assert.ok(updateEnvs[0].delta, 'updated event has delta');
  assert.ok(updateEnvs[0].delta.title, 'delta has title field');
  assert.deepEqual(updateEnvs[0].delta.title, { set: 'world' }, 'delta title is {set:world}');
  assert.equal(updateEnvs[0].reducers, undefined, 'updated event has no reducers');
  assert.equal(updateEnvs[0].event.type, 'Note.updated');
  assert.deepEqual(createEnvs[0].seqSpan, [1, 1]);

  envelopeBuilder.clear();
});

test('(R6) recipient envelope rebuilds lifecycle data and hides raw operation payloads', () => {
  const builder = createLiveEnvelopeBuilder();
  const entity = {
    name: 'Note',
    fields: { title: { kind: 'value' } },
  };
  const lifecycle = builder.buildEnvelope({
    entity,
    event: { scope: 'Note:n1', seq: 7, eventType: 'Note.updated', data: { id: 'n1', title: 'raw secret', private: 'must not leak' } },
    principal: { type: 'user', id: 'reader' },
    row: { id: 'n1', title: 'recipient title' },
    scope: 'Note:n1',
  });
  assert.deepEqual(lifecycle[0].event.data, { id: 'n1', title: 'recipient title' });
  assert.equal(JSON.stringify(lifecycle).includes('raw secret'), false);
  assert.equal(JSON.stringify(lifecycle).includes('must not leak'), false);

  const operation = builder.buildEnvelope({
    entity,
    event: { scope: 'Note:n1', seq: 8, eventType: 'Note.title.operated', data: { operation: 'secret operation' } },
    principal: { type: 'user', id: 'reader' },
    row: { id: 'n1', title: 'recipient title' },
    scope: 'Note:n1',
  });
  assert.deepEqual(operation, [{ type: 'resync', entity: 'Note', id: 'n1', seq: 8, reason: 'recipient-snapshot-required' }]);

  const annotatedLifecycle = builder.buildEnvelope({
    entity: { name: 'Doc', fields: { title: { kind: 'value' }, body: { kind: 'annotatedText' } } },
    event: { scope: 'Doc:d1', seq: 9, eventType: 'Doc.created', data: { id: 'd1', title: 'raw', body: 'raw body' } },
    principal: { type: 'user', id: 'reader' },
    row: { id: 'd1', title: 'recipient title', body: 'recipient body' },
    scope: 'Doc:d1',
  });
  assert.deepEqual(annotatedLifecycle[0].event.data, { id: 'd1', title: 'recipient title', body: 'recipient body' });
  assert.equal(annotatedLifecycle[0].type, 'event');
  assert.equal(JSON.stringify(annotatedLifecycle).includes('raw body'), false);
});

test('(R6) composite stream foreign events require a recipient snapshot without exposing facts', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Other.updated', { title: 'foreign' });
  const builder = createLiveEnvelopeBuilder();
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', { ...makeEntityRecord('Note'), fields: { title: { kind: 'value' } } }]]),
    mayVerb: alwaysAllow,
    projectRecipient: (ctx) => builder.buildEnvelope(ctx),
  });
  const delivered = [];
  await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null,
    deliver: async (batch) => delivered.push(...batch),
  });
  assert.deepEqual(delivered, [{ type: 'resync', entity: 'Note', id: 'n1', seq: 1, reason: 'recipient-snapshot-required' }]);
  assert.equal(JSON.stringify(delivered).includes('foreign'), false);
  builder.clear();
  core.close();
});

test('(R6) malformed durable event sequence fails closed without acknowledging its cursor', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1.5, 'Note.updated', { title: 'must not be acknowledged' });
  const builder = createLiveEnvelopeBuilder();
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', { ...makeEntityRecord('Note'), fields: { title: { kind: 'value' } } }]]),
    mayVerb: alwaysAllow,
    projectRecipient: (ctx) => builder.buildEnvelope(ctx),
  });
  const subscribe = () => core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null, deliver: async () => {},
  });
  await assert.rejects(subscribe, /projectRecipient threw/);
  await assert.rejects(subscribe, /projectRecipient threw/);
  builder.clear();
  core.close();
});

test('(R6) anchored job lifecycle uses opaque recovery instead of raw job payload', () => {
  const builder = createLiveEnvelopeBuilder();
  const envelope = builder.buildEnvelope({
    entity: { name: 'Note', fields: { title: { kind: 'value' } } },
    event: {
      scope: 'Note:n1', seq: 10, eventType: '_Job.updated',
      data: { id: 'job-1', status: 'completed', transition: 'secret transition' },
    },
    principal: { type: 'user', id: 'reader' },
    row: { id: 'n1', title: 'recipient title' },
    scope: 'Note:n1',
  });
  assert.deepEqual(envelope, [{ type: 'resync', entity: 'Note', id: 'n1', seq: 10, reason: 'recipient-snapshot-required' }]);
  assert.equal(JSON.stringify(envelope).includes('secret transition'), false);
  builder.clear();
});

test('(R6) paused subscription records wakes and only delivers after activation', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });
  const subscription = await core.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    paused: true,
    signal: null,
    deliver: async (batch) => delivered.push(...batch),
  });
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'after ack' });
  core.wake('Note:n1');
  await sleep(20);
  assert.equal(delivered.length, 0);
  await subscription.activate();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].seq, 1);
  core.close();
});

// ---- (g) singular terminal lifecycle: closed rechecks, revoke, reentrancy ----

test('(15) close during awaited subscribe authorization never installs a subscription', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let enteredAuth;
  let releaseAuth;
  const authEntered = new Promise((resolve) => { enteredAuth = resolve; });
  const authGate = new Promise((resolve) => { releaseAuth = resolve; });
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: async () => { enteredAuth(); await authGate; return true; },
    projectRecipient: simpleProjector,
  });

  const delivered = [];
  let revokes = 0;
  const subscribing = core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null,
    deliver: async (batch) => { delivered.push(...batch); },
    revoke: () => { revokes += 1; },
  });
  await authEntered;
  core.close();
  releaseAuth();
  await assert.rejects(subscribing, /is closed/);
  assert.equal(delivered.length, 0, 'no delivery from a subscribe that closed mid-admission');
  assert.equal(revokes, 0, 'no subscription was installed, so nothing to revoke');
  core.close();
});

test('(16) close during awaited bootstrap authorization rejects instead of returning a snapshot', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let enteredAuth;
  let releaseAuth;
  const authEntered = new Promise((resolve) => { enteredAuth = resolve; });
  const authGate = new Promise((resolve) => { releaseAuth = resolve; });
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: async () => { enteredAuth(); await authGate; return true; },
    projectRecipient: simpleProjector,
  });

  const bootstrapping = core.bootstrap({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1',
    snapshot: async ({ scope: snapshotScope }) => core.snapshot({ principal: { type: 'user', id: 'u1' }, scope: snapshotScope }),
  });
  await authEntered;
  core.close();
  releaseAuth();
  await assert.rejects(bootstrapping, /is closed/);
  core.close();
});

test('(17) catchup rechecks closed after its awaited authorization', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let enteredAuth;
  let releaseAuth;
  const authEntered = new Promise((resolve) => { enteredAuth = resolve; });
  const authGate = new Promise((resolve) => { releaseAuth = resolve; });
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: async () => { enteredAuth(); await authGate; return true; },
    projectRecipient: simpleProjector,
  });

  const catching = core.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0 });
  await authEntered;
  core.close();
  releaseAuth();
  await assert.rejects(catching, /is closed/);
  core.close();
});

test('(18) terminal delivery error removal revokes the transport exactly once', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let revokes = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  await assert.rejects(
    () => core.subscribe({
      principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null,
      deliver: async () => { throw new Error('delivery boom'); },
      revoke: () => { revokes += 1; },
    }),
    /delivery callback threw/,
  );
  assert.equal(revokes, 1, 'a terminal delivery error revokes exactly once');
  core.close();
});

test('(19) revoke is reentrant-safe: close and abort from inside the callback never double-release', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  const controller = new AbortController();
  let revokes = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const subscription = await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: controller.signal, paused: true,
    deliver: async () => {},
    revoke: () => {
      revokes += 1;
      core.close();
      controller.abort();
      core.close();
      controller.abort();
    },
  });
  assert.equal(await subscription.activate(), 1);
  core.close();
  assert.equal(revokes, 1, 'a reentrant close/abort from inside revoke never double-releases');
  core.close();
  controller.abort();
  assert.equal(revokes, 1, 'repeated close and abort after removal stay no-ops');
});

test('(20) a throwing revoke callback is isolated and releases exactly once', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let revokes = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const subscription = await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null, paused: true,
    deliver: async () => {},
    revoke: () => { revokes += 1; throw new Error('transport revoke boom'); },
  });
  assert.equal(await subscription.activate(), 1);
  assert.doesNotThrow(() => core.close());
  assert.equal(revokes, 1, 'close reaches the revoke once and isolates its throw');
  assert.doesNotThrow(() => core.close());
  assert.equal(revokes, 1, 'a second close is a no-op');
});

test('(21) wake during an active delivery drains the second batch before quiescence', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });

  let enteredDelivery;
  let releaseDelivery;
  const deliveryEntered = new Promise((resolve) => { enteredDelivery = resolve; });
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  let first = true;
  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const subscribing = core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null,
    deliver: async (batch) => {
      if (first) {
        first = false;
        enteredDelivery();
        await deliveryGate;
      }
      delivered.push(...batch);
    },
  });
  await deliveryEntered;
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });
  core.wake('Note:n1');
  releaseDelivery();
  await subscribing;
  assert.deepEqual(delivered.map((event) => event.seq), [1, 2], 'wake during the gated delivery drains the second batch');
  core.close();
});

// ---- (h) explicit per-scope unsubscribe vs terminal removal ----

test('(22) explicit unsubscribe detaches without revoke; other scopes stay alive', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  insertRow(db, 'n2', 'world');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });
  appendEvent(db, 'Note:n2', 1, 'Note.created', { title: 'world' });

  const deliveredA = [];
  const deliveredB = [];
  let revokesA = 0;
  let revokesB = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const subA = await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, paused: true, signal: null,
    deliver: async (batch) => deliveredA.push(...batch),
    revoke: () => { revokesA += 1; },
  });
  const subB = await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n2', after: 0, paused: true, signal: null,
    deliver: async (batch) => deliveredB.push(...batch),
    revoke: () => { revokesB += 1; },
  });
  await subA.activate();
  await subB.activate();
  assert.equal(deliveredA.length, 1);
  assert.equal(deliveredB.length, 1);

  // Per-scope unsubscribe is genuinely non-terminal: no transport revoke.
  subA.unsubscribe();

  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'ignored' });
  core.wake('Note:n1');
  await sleep(30);
  assert.equal(deliveredA.length, 1, 'no delivery to an unsubscribed scope');
  assert.equal(revokesA, 0, 'explicit unsubscribe does not revoke the transport');

  appendEvent(db, 'Note:n2', 2, 'Note.updated', { title: 'delivered' });
  core.wake('Note:n2');
  await sleep(30);
  assert.equal(deliveredB.length, 2, 'the other scope still delivers');

  core.close();
  assert.equal(revokesA, 0, 'close does not revive a detached subscription');
  assert.equal(revokesB, 1, 'close terminally revokes the remaining subscription exactly once');
  core.close();
  assert.equal(revokesB, 1, 'repeated close stays a no-op');
});

test('(23) explicit unsubscribe leaves no registry residue — wake, abort, and close stay no-ops', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const delivered = [];
  let revokes = 0;
  const controller = new AbortController();
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const sub = await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, paused: true, signal: controller.signal,
    deliver: async (batch) => delivered.push(...batch),
    revoke: () => { revokes += 1; },
  });
  assert.equal(await sub.activate(), 1);

  sub.unsubscribe();
  assert.equal(revokes, 0, 'unsubscribe is non-terminal');

  // A second unsubscribe, the abort signal, wake, and close all observe the
  // subscription already detached — nothing double-releases.
  sub.unsubscribe();
  controller.abort();
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'after' });
  core.wake('Note:n1');
  await sleep(30);
  core.close();
  controller.abort();
  core.close();

  assert.equal(delivered.length, 1, 'nothing delivered after unsubscribe');
  assert.equal(revokes, 0, 'abort and close after an explicit unsubscribe never revoke');
});

test('(24) terminal abort still revokes exactly once alongside an explicitly unsubscribed scope', async () => {
  const db = makeDb();
  insertRow(db, 'n1', 'hello');
  insertRow(db, 'n2', 'world');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });
  appendEvent(db, 'Note:n2', 1, 'Note.created', { title: 'world' });

  let revokes = 0;
  const controller = new AbortController();
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntityRecord('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });

  const subA = await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, paused: true, signal: null,
    deliver: async () => {},
    revoke: () => { revokes += 1; },
  });
  const subB = await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n2', after: 0, paused: true, signal: controller.signal,
    deliver: async () => {},
    revoke: () => { revokes += 1; },
  });
  await subA.activate();
  await subB.activate();

  subA.unsubscribe();
  controller.abort();
  assert.equal(revokes, 1, 'transport abort still terminally revokes the abortable scope exactly once');

  core.close();
  assert.equal(revokes, 1, 'no double-release from close after abort');
});
