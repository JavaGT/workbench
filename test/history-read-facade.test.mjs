import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createHistoryReader,
  createLiveDelivery as _createLiveDelivery,
  readCommittedCursor as _readCommittedCursor,
} from '../build/server.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { read, grant, subscribe, text, everyone } from '../build/index.mjs';
import { entity } from '../build/internal.mjs';
import { scope } from '../build/scope.mjs';

function appendEvent(db, scope, seq, type, data = {}) {
  db.prepare(`
    INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(scope, seq, type, JSON.stringify(data), `action-${seq}`, '2026-07-26T00:00:00.000Z');
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq')
    .run(scope, seq);
}

function simpleProjector({ event, scope }) {
  const data = event.data && typeof event.data === 'object'
    ? Object.fromEntries(Object.entries(event.data).filter(([k]) => k !== '__workbench'))
    : event.data;
  return [{ type: event.eventType ?? event.type, seq: event.seq, data, scope }];
}

function noteEntity() {
  return {
    name: 'Note',
    fields: { title: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
}

// A fully compiled entity (registry + scopeFilter + hydrate) so the framework
// row-grant engine can evaluate it as the default authorization.
function compiledNote() {
  return entity('Note', {
    title: text(),
    grant: () => [scope(everyone()).can(() => grant(read, subscribe))],
  });
}

function makeReader(db, entities, mayVerb) {
  return createHistoryReader({
    db,
    entities: entities instanceof Map ? entities : new Map(entities.map((e) => [e.name, e])),
    mayVerb: mayVerb ?? (async () => true),
    projectRecipient: simpleProjector,
  });
}

test('authorized owner can read history', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'test' });
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'updated' });

  const reader = makeReader(db, [noteEntity()]);
  const result = await reader.readCommittedHistory({ scope: 'Note:n1', principal: { type: 'user', id: 'u1' } });
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].type, 'Note.created');
  assert.equal(result.events[1].type, 'Note.updated');
  assert.equal(result.hasMore, false);
  db.close();
});

test('stranger gets 403/forbidden', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'test' });

  const reader = makeReader(db, [noteEntity()], async () => false);
  await assert.rejects(
    reader.readCommittedHistory({ scope: 'Note:n1', principal: { type: 'user', id: 'stranger' } }),
    { code: 'history.forbidden' },
  );
  db.close();
});

test('zero-event scope returns empty array', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');

  const reader = makeReader(db, [noteEntity()]);
  const result = await reader.readCommittedHistory({ scope: 'Note:n1', principal: { type: 'user', id: 'u1' } });
  assert.deepEqual(result.events, []);
  assert.equal(result.hasMore, false);
  db.close();
});

test('sinceSeq filtering works', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'first' });
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'second' });
  appendEvent(db, 'Note:n1', 3, 'Note.updated', { title: 'third' });

  const reader = makeReader(db, [noteEntity()]);
  const result = await reader.readCommittedHistory({ scope: 'Note:n1', principal: { type: 'user', id: 'u1' }, sinceSeq: 1 });
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].seq, 2);
  assert.equal(result.events[1].seq, 3);
  db.close();
});

test('limit pagination works', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  for (let i = 1; i <= 5; i++) {
    appendEvent(db, 'Note:n1', i, 'Note.updated', { seq: i });
  }

  const reader = makeReader(db, [noteEntity()]);
  const result = await reader.readCommittedHistory({ scope: 'Note:n1', principal: { type: 'user', id: 'u1' }, limit: 2 });
  assert.equal(result.events.length, 2);
  assert.equal(result.hasMore, true);
  db.close();
});

test('multi-scope emission order is correct', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'test2');
  // Events from different scopes
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'n1-first' });
  appendEvent(db, 'Note:n2', 1, 'Note.created', { title: 'n2-first' });
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'n1-second' });

  const reader = makeReader(db, [noteEntity()]);
  const result = await reader.readCommittedHistory({ scope: 'Note:n1', principal: { type: 'user', id: 'u1' } });
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].seq, 1);
  assert.equal(result.events[1].seq, 2);
  db.close();
});

test('annotated-text scopes are forbidden', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE AnnotatedDoc (id TEXT PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO AnnotatedDoc (id, body) VALUES (?, ?)').run('1', 'secret');
  appendEvent(db, 'AnnotatedDoc:1', 1, 'AnnotatedDoc.created', { body: 'secret' });

  const reader = createHistoryReader({
    db,
    entities: new Map([['AnnotatedDoc', {
      name: 'AnnotatedDoc',
      fields: { body: { kind: 'value' } },
      grant: () => [scope(() => true).can(() => grant(read, subscribe))],
      scopeFilter: () => ({ sql: '1=1', params: {} }),
      hydrate: (row) => ({ ...row }),
    }]]),
    mayVerb: async () => true,
    projectRecipient: simpleProjector,
    privateHistoryScopes: new Set(['AnnotatedDoc']),
  });

  await assert.rejects(
    reader.readCommittedHistory({ scope: 'AnnotatedDoc:1', principal: { type: 'user', id: 'u1' } }),
    { code: 'history.forbidden' },
  );
  db.close();
});

test('annotated-text scopes deny reads from the declaration-derived private scopes set, not field scraping', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE AnnotatedDoc (id TEXT PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO AnnotatedDoc (id, body) VALUES (?, ?)').run('1', 'secret');
  appendEvent(db, 'AnnotatedDoc:1', 1, 'AnnotatedDoc.created', { body: 'secret' });

  const reader = createHistoryReader({
    db,
    entities: new Map([['AnnotatedDoc', {
      name: 'AnnotatedDoc',
      fields: { body: { kind: 'value' } }, // NOT an annotatedText field; the declared scope set denies it
      grant: () => [scope(() => true).can(() => grant(read, subscribe))],
      scopeFilter: () => ({ sql: '1=1', params: {} }),
      hydrate: (row) => ({ ...row }),
    }]]),
    mayVerb: async () => true,
    projectRecipient: simpleProjector,
    privateHistoryScopes: new Set(['AnnotatedDoc']),
  });

  await assert.rejects(
    reader.readCommittedHistory({ scope: 'AnnotatedDoc:1', principal: { type: 'user', id: 'u1' } }),
    { code: 'history.forbidden' },
  );
  db.close();
});

test('receipt lookup returns metadata', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'test' });
  db.prepare(
    'INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, actionType, operation) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:n1', 'action-1', '2026-07-26T00:00:00.000Z', JSON.stringify([{ scope: 'Note:n1', seq: 1 }]), 'Note.created', 'action');

  const reader = makeReader(db, [noteEntity()]);
  const receipt = await reader.readReceipt({ scope: 'Note:n1', actionId: 'action-1', principal: { type: 'user', id: 'u1' } });
  assert.ok(receipt);
  assert.equal(receipt.actionId, 'action-1');
  assert.equal(receipt.scope, 'Note:n1');
  assert.ok(Array.isArray(receipt.eventRefs));
  assert.equal('principalKey' in receipt, false);
  assert.equal('sessionId' in receipt, false);
  db.close();
});

test('receipt lookup returns null for unknown action', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');

  const reader = makeReader(db, [noteEntity()]);
  const receipt = await reader.readReceipt({ scope: 'Note:n1', actionId: 'nonexistent', principal: { type: 'user', id: 'u1' } });
  assert.equal(receipt, null);
  db.close();
});

test('receipt lookup works with framework-default authorization (no mayVerb/projectRecipient)', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'test' });
  db.prepare(
    'INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, actionType, operation) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:n1', 'action-1', '2026-07-26T00:00:00.000Z', JSON.stringify([{ scope: 'Note:n1', seq: 1 }]), 'Note.created', 'action');

  const reader = createHistoryReader({ db, entities: new Map([['Note', compiledNote()]]) });
  const receipt = await reader.readReceipt({ scope: 'Note:n1', actionId: 'action-1', principal: { type: 'user', id: 'u1' } });
  assert.ok(receipt);
  assert.equal(receipt.actionId, 'action-1');
  assert.equal(receipt.scope, 'Note:n1');
  db.close();
});

test('receipt lookup returns null for unknown action with default authorization', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');

  const reader = createHistoryReader({ db, entities: new Map([['Note', compiledNote()]]) });
  const receipt = await reader.readReceipt({ scope: 'Note:n1', actionId: 'missing', principal: { type: 'user', id: 'u1' } });
  assert.equal(receipt, null);
  db.close();
});

test('default authorization denies receipt reads on a grantless entity', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'test' });
  db.prepare(
    'INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, actionType, operation) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:n1', 'action-1', '2026-07-26T00:00:00.000Z', JSON.stringify([{ scope: 'Note:n1', seq: 1 }]), 'Note.created', 'action');

  const reader = createHistoryReader({
    db,
    entities: new Map([['Note', {
      name: 'Note',
      fields: { title: { kind: 'value' } },
      grant: null,
      scopeFilter: () => ({ sql: '1=1', params: {} }),
      hydrate: (row) => ({ ...row }),
    }]]),
  });
  await assert.rejects(
    reader.readReceipt({ scope: 'Note:n1', actionId: 'action-1', principal: { type: 'user', id: 'u1' } }),
    { code: 'history.forbidden' },
  );
  db.close();
});

test('readCommittedHistory requires a projectRecipient at call time', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'test' });

  const reader = createHistoryReader({ db, entities: new Map([['Note', compiledNote()]]) });
  await assert.rejects(
    reader.readCommittedHistory({ scope: 'Note:n1', principal: { type: 'user', id: 'u1' } }),
    /projectRecipient/,
  );
  db.close();
});

test('events are projected (no raw private facts)', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, secret TEXT)');
  db.prepare('INSERT INTO Note (id, title, secret) VALUES (?, ?, ?)').run('n1', 'visible', 'hidden-secret');
  // Event contains private data in __workbench metadata
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'visible', __workbench: { secret: 'hidden-secret', internal: 'metadata' } });

  const reader = makeReader(db, [noteEntity()]);
  const result = await reader.readCommittedHistory({ scope: 'Note:n1', principal: { type: 'user', id: 'u1' } });
  assert.equal(result.events.length, 1);
  assert.equal(JSON.stringify(result.events).includes('hidden-secret'), false);
  assert.equal(JSON.stringify(result.events).includes('__workbench'), false);
  assert.equal(JSON.stringify(result.events).includes('internal'), false);
  db.close();
});

test('history reader is exported from server.mjs', () => {
  assert.equal(typeof createHistoryReader, 'function');
});

test('history reader is exposed in the public server contract', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'test');
  const reader = createHistoryReader({
    db,
    entities: new Map([['Note', noteEntity()]]),
    mayVerb: async () => true,
    projectRecipient: simpleProjector,
  });
  assert.ok(reader);
  assert.equal(typeof reader.readCommittedHistory, 'function');
  assert.equal(typeof reader.readReceipt, 'function');
  db.close();
});

test('projector omits secret eventData from result', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, secret TEXT)');
  db.prepare('INSERT INTO Note (id, title, secret) VALUES (?, ?, ?)').run('n1', 'visible', 'hidden-secret');
  // Event data contains a secret field that a careful projector should omit
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'visible', secret: 'hidden-secret', email: 'test@example.com' });

  const safeProjector = ({ event, scope }) => {
    const { secret: _secret, ...safe } = event.data || {};
    return [{ type: event.eventType ?? event.type, seq: event.seq, data: safe, scope }];
  };

  const reader = createHistoryReader({
    db,
    entities: new Map([['Note', noteEntity()]]),
    mayVerb: async () => true,
    projectRecipient: safeProjector,
  });
  const result = await reader.readCommittedHistory({ scope: 'Note:n1', principal: { type: 'user', id: 'u1' } });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].data.title, 'visible');
  assert.equal(result.events[0].data.secret, undefined);
  assert.equal(JSON.stringify(result.events).includes('hidden-secret'), false);
  db.close();
});
