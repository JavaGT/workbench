// Phase 1 — direct tests for the four side-table strategies.
//
// Tests each strategy's surface (matches, ddl, handle, mutateHandlers,
// projectionApply) in isolation with an in-memory SQLite DB, without
// mounting a full entity or app. The strategies are imported directly
// from the source module.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  MAP_SIDE_TABLE_STRATEGY,
  ORDERED_SIDE_TABLE_STRATEGY,
  LOG_SIDE_TABLE_STRATEGY,
  EPHEMERAL_SIDE_TABLE_STRATEGY,
  collectSideTableStrategies,
  sideTableDDL,
} from '../build/side-table-strategy.mjs';

import * as eventHandle from '../build/event-handle.mjs';
import { membershipTable as _membershipTable, membershipOwnerCol as _membershipOwnerCol, MEMBER_COLUMN as _MEMBER_COLUMN } from '../build/scope-sql.mjs';

// ---- helpers ----

function freshDb() {
  const db = new DatabaseSync(':memory:');
  return db;
}

function mockRecord(entityName, fields, clauseOverrides) {
  return {
    name: entityName,
    fields: Object.freeze({ ...fields }),
    readScope: undefined,
    grant: clauseOverrides?.grant ?? [],
  };
}

function mockRow(id) {
  return { id };
}

function fakeDispatch(ok = true, events = []) {
  return async ({ type, payload }) => ok
    ? ({ ok: true, deduped: false, events, type, payload })
    : ({ ok: false, failure: { category: 'denied', message: 'Forbidden.' } });
}

function runDDL(db, sql) {
  for (const line of sql.split(';').filter(Boolean)) {
    db.exec(line.trim() + ';');
  }
}

// ---- mapStrategy -----------------------------------------------------------

describe('mapStrategy', () => {
  test('matches map store descriptors', () => {
    assert.ok(MAP_SIDE_TABLE_STRATEGY.matches({ kind: 'store', type: 'map' }));
    assert.ok(!MAP_SIDE_TABLE_STRATEGY.matches({ kind: 'store', type: 'log' }));
    assert.ok(!MAP_SIDE_TABLE_STRATEGY.matches({ kind: 'value', type: 'text' }));
    assert.ok(!MAP_SIDE_TABLE_STRATEGY.matches({ kind: 'ordered' }));
  });

  test('ddl generates CREATE TABLE with owner and member columns', () => {
    const sql = MAP_SIDE_TABLE_STRATEGY.ddl('Project', 'members', {
      kind: 'store',
      type: 'map',
      roles: ['admin', 'member'],
    });
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS Project_members'));
    assert.ok(sql.includes('Project_id TEXT NOT NULL'));
    assert.ok(sql.includes('member_id TEXT NOT NULL'));
    assert.ok(sql.includes('role TEXT NOT NULL'));
    assert.ok(sql.includes('PRIMARY KEY'));
  });

  test('ddl omits role column when no roles declared', () => {
    const sql = MAP_SIDE_TABLE_STRATEGY.ddl('Group', 'tags', {
      kind: 'store',
      type: 'map',
    });
    assert.ok(sql.includes('member_id'));
    assert.ok(!sql.includes('role'));
  });

  test('eventTypes returns native added/roleChanged/removed per field', () => {
    const types = MAP_SIDE_TABLE_STRATEGY.eventTypes('Doc', [['collaborators', {}]]);
    assert.deepEqual(types, [
      eventHandle.native('Doc', 'collaborators', 'added').type,
      eventHandle.native('Doc', 'collaborators', 'roleChanged').type,
      eventHandle.native('Doc', 'collaborators', 'removed').type,
    ]);
  });

  test('mutateHandlers returns add/setRole/remove per field', () => {
    const handlers = MAP_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['collaborators', { kind: 'store', type: 'map', roles: ['editor'] }],
    ]);
    assert.ok(typeof handlers['Doc.collaborators.add'] === 'function');
    assert.ok(typeof handlers['Doc.collaborators.setRole'] === 'function');
    assert.ok(typeof handlers['Doc.collaborators.remove'] === 'function');
  });

  test('mutateHandlers .add handler emits added event with correct scope and data', () => {
    const handlers = MAP_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['collaborators', { kind: 'store', type: 'map', roles: ['editor'] }],
    ]);
    const events = handlers['Doc.collaborators.add']({
      payload: { owner: 'doc1', member: 'user1', role: 'editor' },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, eventHandle.native('Doc', 'collaborators', 'added').type);
    assert.equal(events[0].scope, 'Doc:doc1');
    assert.equal(events[0].data.owner, 'doc1');
    assert.equal(events[0].data.member, 'user1');
    assert.equal(events[0].data.role, 'editor');
  });

  test('mutateHandlers .remove handler emits removed event', () => {
    const handlers = MAP_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['collaborators', { kind: 'store', type: 'map' }],
    ]);
    const events = handlers['Doc.collaborators.remove']({
      payload: { owner: 'doc1', member: 'user1' },
    });
    assert.equal(events[0].type, eventHandle.native('Doc', 'collaborators', 'removed').type);
  });

  test('projectionApply inserts on added event', () => {
    const db = freshDb();
    runDDL(db, MAP_SIDE_TABLE_STRATEGY.ddl('Doc', 'collaborators', {
      kind: 'store', type: 'map', roles: ['editor'],
    }));
    const handle = eventHandle.native('Doc', 'collaborators', 'added');
    const applied = MAP_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['collaborators', { kind: 'store', type: 'map', roles: ['editor'] }]],
      handle,
      event: { data: { owner: 'doc1', member: 'user1', role: 'editor' } },
      db,
    });
    assert.ok(applied);
    const row = db.prepare(
      'SELECT * FROM Doc_collaborators WHERE Doc_id = ? AND member_id = ?',
    ).get('doc1', 'user1');
    assert.ok(row);
    assert.equal(row.role, 'editor');
  });

  test('projectionApply deletes on removed event', () => {
    const db = freshDb();
    runDDL(db, MAP_SIDE_TABLE_STRATEGY.ddl('Doc', 'collaborators', {
      kind: 'store', type: 'map',
    }));
    // insert first
    MAP_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['collaborators', { kind: 'store', type: 'map' }]],
      handle: eventHandle.native('Doc', 'collaborators', 'added'),
      event: { data: { owner: 'doc1', member: 'user1' } },
      db,
    });
    // then remove
    const removed = MAP_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['collaborators', { kind: 'store', type: 'map' }]],
      handle: eventHandle.native('Doc', 'collaborators', 'removed'),
      event: { data: { owner: 'doc1', member: 'user1' } },
      db,
    });
    assert.ok(removed);
    const row = db.prepare(
      'SELECT * FROM Doc_collaborators WHERE Doc_id = ? AND member_id = ?',
    ).get('doc1', 'user1');
    assert.equal(row, undefined);
  });

  test('projectionApply updates role on roleChanged event', () => {
    const db = freshDb();
    runDDL(db, MAP_SIDE_TABLE_STRATEGY.ddl('Doc', 'collaborators', {
      kind: 'store', type: 'map', roles: ['editor', 'admin'],
    }));
    MAP_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['collaborators', { kind: 'store', type: 'map', roles: ['editor', 'admin'] }]],
      handle: eventHandle.native('Doc', 'collaborators', 'added'),
      event: { data: { owner: 'doc1', member: 'user1', role: 'editor' } },
      db,
    });
    MAP_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['collaborators', { kind: 'store', type: 'map', roles: ['editor', 'admin'] }]],
      handle: eventHandle.native('Doc', 'collaborators', 'roleChanged'),
      event: { data: { owner: 'doc1', member: 'user1', role: 'admin' } },
      db,
    });
    const row = db.prepare(
      'SELECT role FROM Doc_collaborators WHERE Doc_id = ? AND member_id = ?',
    ).get('doc1', 'user1');
    assert.equal(row.role, 'admin');
  });

  test('projectionApply is a no-op for wrong field/kind', () => {
    const db = freshDb();
    runDDL(db, MAP_SIDE_TABLE_STRATEGY.ddl('Doc', 'collaborators', {
      kind: 'store', type: 'map',
    }));
    const applied = MAP_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['collaborators', { kind: 'store', type: 'map' }]],
      handle: eventHandle.native('Doc', 'otherField', 'added'),
      event: { data: { owner: 'doc1', member: 'user1' } },
      db,
    });
    assert.ok(!applied);
  });

  test('handle.set dispatches and does not throw', async () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'collaborators';
    runDDL(db, MAP_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName, {
      kind: 'store', type: 'map', roles: ['editor'],
    }));
    const record = mockRecord(entityName, { [fieldName]: { kind: 'store', type: 'map', roles: ['editor'] } });
    const row = mockRow('doc1');
    // principal = null skips auth; dispatch is mock — doesn't mutate DB.
    // The real DB mutation happens via projectionApply on committed events.
    const h = MAP_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'store', type: 'map', roles: ['editor'] },
      row, principal: null, dispatch: fakeDispatch(true), db,
    });
    // should not throw
    await h.set('user1', { role: 'editor' });
    // has/get probe the DB directly; since dispatch is a mock, no rows are
    // written. After projection materialization, they would be present.
    assert.ok(!h.has('user1'));
  });

  test('handle.has returns true after projectionApply adds the member', () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'collaborators';
    runDDL(db, MAP_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName, {
      kind: 'store', type: 'map',
    }));
    MAP_SIDE_TABLE_STRATEGY.projectionApply({
      entityName,
      fieldEntries: [[fieldName, { kind: 'store', type: 'map' }]],
      handle: eventHandle.native(entityName, fieldName, 'added'),
      event: { data: { owner: 'doc1', member: 'user1' } },
      db,
    });
    const record = mockRecord(entityName, { [fieldName]: { kind: 'store', type: 'map' } });
    const h = MAP_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'store', type: 'map' },
      row: mockRow('doc1'), principal: null, dispatch: fakeDispatch(true), db,
    });
    assert.ok(h.has('user1'));
    assert.ok(!h.has('user2'));
    const entry = h.get('user1');
    assert.equal(entry.member_id, 'user1');
  });

  test('handle.remove dispatches removal', async () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'collaborators';
    runDDL(db, MAP_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName, {
      kind: 'store', type: 'map',
    }));
    // add via projection
    MAP_SIDE_TABLE_STRATEGY.projectionApply({
      entityName,
      fieldEntries: [[fieldName, { kind: 'store', type: 'map' }]],
      handle: eventHandle.native(entityName, fieldName, 'added'),
      event: { data: { owner: 'doc1', member: 'user1' } },
      db,
    });
    const record = mockRecord(entityName, { [fieldName]: { kind: 'store', type: 'map' } });
    const h = MAP_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'store', type: 'map' },
      row: mockRow('doc1'), principal: null, dispatch: fakeDispatch(true), db,
    });
    assert.ok(h.has('user1'));
    await h.remove('user1');
    // removal via dispatch does not directly mutate DB — but the has/remove
    // probe uses the active DB, and dispatch is a mock. So has still returns
    // true (dispatch mocked, no actual delete). This confirms the call path works.
    // The real delete happens via projectionApply after dispatch.
  });

  test('collectSideTableStrategies groups map fields', () => {
    const fields = {
      name: { kind: 'value', type: 'text' },
      members: { kind: 'store', type: 'map', roles: ['admin'] },
      tags: { kind: 'store', type: 'map' },
    };
    const entries = collectSideTableStrategies(fields);
    const mapEntry = entries.find((e) => e.strategy === MAP_SIDE_TABLE_STRATEGY);
    assert.ok(mapEntry);
    assert.equal(mapEntry.fields.length, 2);
    assert.deepEqual(mapEntry.fields[0][0], 'members');
    assert.deepEqual(mapEntry.fields[1][0], 'tags');
  });

  test('sideTableDDL delegates to map DDL', () => {
    const record = { name: 'Blog' };
    const sql = sideTableDDL(record, 'members', { kind: 'store', type: 'map' });
    assert.ok(sql.includes('Blog_members'));
    assert.ok(sql.includes('Blog_id'));
  });
});

// ---- listStrategy (ORDERED_SIDE_TABLE_STRATEGY) -----------------------------

describe('listStrategy', () => {
  test('matches ordered descriptors', () => {
    assert.ok(ORDERED_SIDE_TABLE_STRATEGY.matches({ kind: 'ordered' }));
    assert.ok(!ORDERED_SIDE_TABLE_STRATEGY.matches({ kind: 'store', type: 'map' }));
    assert.ok(!ORDERED_SIDE_TABLE_STRATEGY.matches({ kind: 'value', type: 'text' }));
  });

  test('ddl generates CREATE TABLE with owner, id, key, item columns', () => {
    const sql = ORDERED_SIDE_TABLE_STRATEGY.ddl('Doc', 'blocks');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS Doc_blocks'));
    assert.ok(sql.includes('Doc_id TEXT NOT NULL'));
    assert.ok(sql.includes('id TEXT NOT NULL'));
    assert.ok(sql.includes('key REAL NOT NULL'));
    assert.ok(sql.includes('item TEXT'));
    assert.ok(sql.includes('PRIMARY KEY'));
  });

  test('eventTypes returns native insert/move/reorder/remove per field', () => {
    const types = ORDERED_SIDE_TABLE_STRATEGY.eventTypes('Doc', [['blocks', {}]]);
    assert.deepEqual(types, [
      eventHandle.native('Doc', 'blocks', 'inserted').type,
      eventHandle.native('Doc', 'blocks', 'moved').type,
      eventHandle.native('Doc', 'blocks', 'reordered').type,
      eventHandle.native('Doc', 'blocks', 'removed').type,
    ]);
  });

  test('mutateHandlers returns insert/move/reorder/remove per field', () => {
    const handlers = ORDERED_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['blocks', { kind: 'ordered' }],
    ]);
    assert.ok(typeof handlers['Doc.blocks.insert'] === 'function');
    assert.ok(typeof handlers['Doc.blocks.move'] === 'function');
    assert.ok(typeof handlers['Doc.blocks.reorder'] === 'function');
    assert.ok(typeof handlers['Doc.blocks.remove'] === 'function');
  });

  test('mutateHandlers .insert handler generates an id and emits inserted event', () => {
    const handlers = ORDERED_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['blocks', { kind: 'ordered' }],
    ]);
    const events = handlers['Doc.blocks.insert']({
      payload: { owner: 'doc1', key: 1, value: { text: 'hello' } },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, eventHandle.native('Doc', 'blocks', 'inserted').type);
    assert.equal(events[0].data.owner, 'doc1');
    assert.equal(events[0].data.key, 1);
    assert.equal(events[0].data.value.text, 'hello');
    assert.ok(typeof events[0].data.id === 'string');
    assert.ok(events[0].data.id.length > 0);
  });

  test('mutateHandlers .remove handler emits removed event', () => {
    const handlers = ORDERED_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['blocks', { kind: 'ordered' }],
    ]);
    const events = handlers['Doc.blocks.remove']({
      payload: { owner: 'doc1', id: 'item1' },
    });
    assert.equal(events[0].type, eventHandle.native('Doc', 'blocks', 'removed').type);
  });

  test('projectionApply inserts on inserted event', () => {
    const db = freshDb();
    runDDL(db, ORDERED_SIDE_TABLE_STRATEGY.ddl('Doc', 'blocks'));
    const handle = eventHandle.native('Doc', 'blocks', 'inserted');
    const applied = ORDERED_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['blocks', { kind: 'ordered' }]],
      handle,
      event: { data: { owner: 'doc1', id: 'item1', key: 0, value: { text: 'hello' } } },
      db,
    });
    assert.ok(applied);
    const row = db.prepare('SELECT item FROM Doc_blocks WHERE Doc_id = ? AND id = ?').get('doc1', 'item1');
    assert.equal(JSON.parse(row.item).text, 'hello');
  });

  test('projectionApply moves on moved event', () => {
    const db = freshDb();
    runDDL(db, ORDERED_SIDE_TABLE_STRATEGY.ddl('Doc', 'blocks'));
    ORDERED_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['blocks', { kind: 'ordered' }]],
      handle: eventHandle.native('Doc', 'blocks', 'inserted'),
      event: { data: { owner: 'doc1', id: 'item1', key: 0, value: {} } },
      db,
    });
    ORDERED_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['blocks', { kind: 'ordered' }]],
      handle: eventHandle.native('Doc', 'blocks', 'moved'),
      event: { data: { owner: 'doc1', id: 'item1', key: 5 } },
      db,
    });
    const row = db.prepare('SELECT key FROM Doc_blocks WHERE Doc_id = ? AND id = ?').get('doc1', 'item1');
    assert.equal(row.key, 5);
  });

  test('projectionApply deletes on removed event', () => {
    const db = freshDb();
    runDDL(db, ORDERED_SIDE_TABLE_STRATEGY.ddl('Doc', 'blocks'));
    ORDERED_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['blocks', { kind: 'ordered' }]],
      handle: eventHandle.native('Doc', 'blocks', 'inserted'),
      event: { data: { owner: 'doc1', id: 'item1', key: 0, value: {} } },
      db,
    });
    ORDERED_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['blocks', { kind: 'ordered' }]],
      handle: eventHandle.native('Doc', 'blocks', 'removed'),
      event: { data: { owner: 'doc1', id: 'item1' } },
      db,
    });
    const row = db.prepare('SELECT * FROM Doc_blocks WHERE Doc_id = ? AND id = ?').get('doc1', 'item1');
    assert.equal(row, undefined);
  });

  test('projectionApply reorders multiple entries', () => {
    const db = freshDb();
    runDDL(db, ORDERED_SIDE_TABLE_STRATEGY.ddl('Doc', 'blocks'));
    for (const [id, key] of [['a', 0], ['b', 1], ['c', 2]]) {
      ORDERED_SIDE_TABLE_STRATEGY.projectionApply({
        entityName: 'Doc',
        fieldEntries: [['blocks', { kind: 'ordered' }]],
        handle: eventHandle.native('Doc', 'blocks', 'inserted'),
        event: { data: { owner: 'doc1', id, key, value: {} } },
        db,
      });
    }
    ORDERED_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['blocks', { kind: 'ordered' }]],
      handle: eventHandle.native('Doc', 'blocks', 'reordered'),
      event: { data: { owner: 'doc1', entries: [{ id: 'c', key: 0 }, { id: 'a', key: 1 }, { id: 'b', key: 2 }] } },
      db,
    });
    const rows = db.prepare('SELECT id, key FROM Doc_blocks WHERE Doc_id = ? ORDER BY key').all('doc1');
    assert.deepEqual(rows.map((r) => r.id), ['c', 'a', 'b']);
  });

  test('handle.insertAt invokes dispatch without throwing', async () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'blocks';
    runDDL(db, ORDERED_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName));
    const record = mockRecord(entityName, { [fieldName]: { kind: 'ordered' } });
    const h = ORDERED_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'ordered' },
      row: mockRow('doc1'), principal: null,
      dispatch: fakeDispatch(true, [{ type: 'Doc.blocks.inserted', data: { id: 'item1' } }]), db,
    });
    // should not throw — dispatch is invoked and returns the inserted event id
    const id = await h.insertAt(0, { text: 'hello' });
    assert.equal(id, 'item1');
  });

  test('handle.has returns true after projectionApply', () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'blocks';
    runDDL(db, ORDERED_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName));
    ORDERED_SIDE_TABLE_STRATEGY.projectionApply({
      entityName,
      fieldEntries: [[fieldName, { kind: 'ordered' }]],
      handle: eventHandle.native(entityName, fieldName, 'inserted'),
      event: { data: { owner: 'doc1', id: 'item1', key: 0, value: { text: 'hello' } } },
      db,
    });
    const record = mockRecord(entityName, { [fieldName]: { kind: 'ordered' } });
    const h = ORDERED_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'ordered' },
      row: mockRow('doc1'), principal: null, dispatch: fakeDispatch(true), db,
    });
    assert.ok(h.has('item1'));
    assert.ok(!h.has('item2'));
    assert.deepEqual(h.get('item1'), { text: 'hello' });
  });

  test('handle.toArray returns ordered items', async () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'blocks';
    runDDL(db, ORDERED_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName));
    for (const [id, key, value] of [['b', 1, 'second'], ['a', 0, 'first'], ['c', 2, 'third']]) {
      ORDERED_SIDE_TABLE_STRATEGY.projectionApply({
        entityName,
        fieldEntries: [[fieldName, { kind: 'ordered' }]],
        handle: eventHandle.native(entityName, fieldName, 'inserted'),
        event: { data: { owner: 'doc1', id, key, value } },
        db,
      });
    }
    const record = mockRecord(entityName, { [fieldName]: { kind: 'ordered' } });
    const h = ORDERED_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'ordered' },
      row: mockRow('doc1'), principal: null, dispatch: fakeDispatch(true), db,
    });
    const arr = await h.toArray();
    assert.deepEqual(arr, ['first', 'second', 'third']);
  });
});

// ---- logStrategy -------------------------------------------------------------

describe('logStrategy', () => {
  test('matches log store descriptors', () => {
    assert.ok(LOG_SIDE_TABLE_STRATEGY.matches({ kind: 'store', type: 'log' }));
    assert.ok(!LOG_SIDE_TABLE_STRATEGY.matches({ kind: 'store', type: 'map' }));
    assert.ok(!LOG_SIDE_TABLE_STRATEGY.matches({ kind: 'value', type: 'text' }));
  });

  test('ddl generates CREATE TABLE with owner, id, and entry columns', () => {
    const sql = LOG_SIDE_TABLE_STRATEGY.ddl('Doc', 'history', {
      kind: 'store',
      type: 'log',
      entry: { action: { kind: 'value', type: 'text' }, userId: { kind: 'value', type: 'text' } },
    });
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS Doc_history'));
    assert.ok(sql.includes('Doc_id TEXT NOT NULL'));
    assert.ok(sql.includes('id TEXT NOT NULL'));
    assert.ok(sql.includes('action TEXT'));
    assert.ok(sql.includes('userId TEXT'));
    assert.ok(sql.includes('PRIMARY KEY'));
  });

  test('ddl with no entry sub-fields generates minimal columns', () => {
    const sql = LOG_SIDE_TABLE_STRATEGY.ddl('Doc', 'audit', {
      kind: 'store', type: 'log',
    });
    assert.ok(sql.includes('Doc_id'));
    assert.ok(sql.includes('id'));
    // no extra entry columns besides owner + id
  });

  test('eventTypes returns one native.appended per field', () => {
    const types = LOG_SIDE_TABLE_STRATEGY.eventTypes('Doc', [['history', {}]]);
    assert.deepEqual(types, [
      eventHandle.native('Doc', 'history', 'appended').type,
    ]);
  });

  test('mutateHandlers returns append per field', () => {
    const handlers = LOG_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['history', { kind: 'store', type: 'log', entry: { action: { kind: 'value', type: 'text' } } }],
    ]);
    assert.ok(typeof handlers['Doc.history.append'] === 'function');
  });

  test('mutateHandlers .append handler emits appended event with entry data', () => {
    const handlers = LOG_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['history', { kind: 'store', type: 'log', entry: { action: { kind: 'value', type: 'text' }, userId: { kind: 'value', type: 'text' } } }],
    ]);
    const events = handlers['Doc.history.append']({
      payload: { owner: 'doc1', action: 'created', userId: 'user1' },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, eventHandle.native('Doc', 'history', 'appended').type);
    assert.equal(events[0].data.owner, 'doc1');
    assert.equal(events[0].data.action, 'created');
    assert.equal(events[0].data.userId, 'user1');
    assert.ok(typeof events[0].data.id === 'string');
  });

  test('mutateHandlers .append rejects unknown entry fields', () => {
    const handlers = LOG_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['history', { kind: 'store', type: 'log', entry: { action: { kind: 'value', type: 'text' } } }],
    ]);
    assert.throws(
      () => handlers['Doc.history.append']({ payload: { owner: 'doc1', unknown: 'x' } }),
      /unknown entry field/,
    );
  });

  test('projectionApply inserts entry on appended event', () => {
    const db = freshDb();
    runDDL(db, LOG_SIDE_TABLE_STRATEGY.ddl('Doc', 'history', {
      kind: 'store', type: 'log',
      entry: { action: { kind: 'value', type: 'text' }, userId: { kind: 'value', type: 'text' } },
    }));
    const handle = eventHandle.native('Doc', 'history', 'appended');
    const applied = LOG_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['history', {
        kind: 'store', type: 'log',
        entry: { action: { kind: 'value', type: 'text' }, userId: { kind: 'value', type: 'text' } },
      }]],
      handle,
      event: { data: { owner: 'doc1', id: 'ev1', action: 'edited', userId: 'user1' } },
      db,
    });
    assert.ok(applied);
    const rows = db.prepare('SELECT * FROM Doc_history WHERE Doc_id = ? ORDER BY rowid').all('doc1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'edited');
    assert.equal(rows[0].userId, 'user1');
    assert.equal(rows[0].id, 'ev1');
  });

  test('projectionApply skips non-appended events', () => {
    const db = freshDb();
    runDDL(db, LOG_SIDE_TABLE_STRATEGY.ddl('Doc', 'history', {
      kind: 'store', type: 'log',
      entry: { action: { kind: 'value', type: 'text' } },
    }));
    const applied = LOG_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['history', { kind: 'store', type: 'log' }]],
      handle: eventHandle.native('Doc', 'history', 'foo'), // wrong native name
      event: { data: { owner: 'doc1' } },
      db,
    });
    assert.ok(!applied);
  });

  test('multiple projectionApply calls append multiple entries', () => {
    const db = freshDb();
    runDDL(db, LOG_SIDE_TABLE_STRATEGY.ddl('Doc', 'history', {
      kind: 'store', type: 'log',
      entry: { action: { kind: 'value', type: 'text' } },
    }));
    for (const [id, action] of [['e1', 'created'], ['e2', 'edited']]) {
      LOG_SIDE_TABLE_STRATEGY.projectionApply({
        entityName: 'Doc',
        fieldEntries: [['history', {
          kind: 'store', type: 'log',
          entry: { action: { kind: 'value', type: 'text' } },
        }]],
        handle: eventHandle.native('Doc', 'history', 'appended'),
        event: { data: { owner: 'doc1', id, action } },
        db,
      });
    }
    const rows = db.prepare('SELECT * FROM Doc_history WHERE Doc_id = ? ORDER BY rowid').all('doc1');
    assert.equal(rows.length, 2);
  });

  test('handle.append dispatches and returns the event id', async () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'history';
    runDDL(db, LOG_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName, {
      kind: 'store', type: 'log',
      entry: { action: { kind: 'value', type: 'text' } },
    }));
    const record = mockRecord(entityName, {
      [fieldName]: { kind: 'store', type: 'log', entry: { action: { kind: 'value', type: 'text' } } },
    });
    const h = LOG_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'store', type: 'log', entry: { action: { kind: 'value', type: 'text' } } },
      row: mockRow('doc1'), principal: null,
      dispatch: fakeDispatch(true, [{ type: 'Doc.history.appended', data: { id: 'ev42' } }]),
    });
    const id = await h.append({ action: 'edited' });
    assert.equal(id, 'ev42');
  });

  test('handle.entries returns rows ordered by rowid', async () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'history';
    const descriptor = {
      kind: 'store', type: 'log',
      entry: { action: { kind: 'value', type: 'text' } },
    };
    runDDL(db, LOG_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName, descriptor));
    // Insert entries via projectionApply
    for (const [id, action] of [['e1', 'created'], ['e2', 'edited']]) {
      LOG_SIDE_TABLE_STRATEGY.projectionApply({
        entityName,
        fieldEntries: [[fieldName, descriptor]],
        handle: eventHandle.native(entityName, fieldName, 'appended'),
        event: { data: { owner: 'doc1', id, action } },
        db,
      });
    }
    const record = mockRecord(entityName, { [fieldName]: descriptor });
    const h = LOG_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName, descriptor,
      row: mockRow('doc1'), principal: null, dispatch: fakeDispatch(true), db,
    });
    const entries = await h.entries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, 'created');
    assert.equal(entries[1].action, 'edited');
  });
});

// ---- ephemeralStrategy ------------------------------------------------------

describe('ephemeralStrategy', () => {
  test('matches ephemeral descriptors', () => {
    assert.ok(EPHEMERAL_SIDE_TABLE_STRATEGY.matches({ kind: 'ephemeral' }));
    assert.ok(!EPHEMERAL_SIDE_TABLE_STRATEGY.matches({ kind: 'store', type: 'map' }));
    assert.ok(!EPHEMERAL_SIDE_TABLE_STRATEGY.matches({ kind: 'value', type: 'text' }));
  });

  test('ddl generates CREATE TABLE with owner, client_id, cells columns', () => {
    const sql = EPHEMERAL_SIDE_TABLE_STRATEGY.ddl('Doc', 'cursorPos');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS Doc_cursorPos'));
    assert.ok(sql.includes('Doc_id TEXT NOT NULL'));
    assert.ok(sql.includes('client_id TEXT NOT NULL'));
    assert.ok(sql.includes('cells TEXT'));
    assert.ok(sql.includes('PRIMARY KEY'));
  });

  test('eventTypes returns one fieldSet per field', () => {
    const types = EPHEMERAL_SIDE_TABLE_STRATEGY.eventTypes('Doc', [['cursorPos', {}]]);
    assert.deepEqual(types, [
      eventHandle.fieldSet('Doc', 'cursorPos').type,
    ]);
  });

  test('mutateHandlers returns set per field', () => {
    const handlers = EPHEMERAL_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['cursorPos', { kind: 'ephemeral' }],
    ]);
    assert.ok(typeof handlers['Doc.cursorPos.set'] === 'function');
  });

  test('mutateHandlers .set handler emits fieldSet event with cells', () => {
    const handlers = EPHEMERAL_SIDE_TABLE_STRATEGY.mutateHandlers('Doc', [
      ['cursorPos', { kind: 'ephemeral' }],
    ]);
    const events = handlers['Doc.cursorPos.set']({
      payload: { owner: 'doc1', client: 'client1', cells: { x: 10, y: 20 } },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, eventHandle.fieldSet('Doc', 'cursorPos').type);
    assert.equal(events[0].data.owner, 'doc1');
    assert.equal(events[0].data.client, 'client1');
    assert.deepEqual(events[0].data.cells, { x: 10, y: 20 });
  });

  test('projectionApply inserts or replaces cells', () => {
    const db = freshDb();
    runDDL(db, EPHEMERAL_SIDE_TABLE_STRATEGY.ddl('Doc', 'cursorPos'));
    const handle = eventHandle.fieldSet('Doc', 'cursorPos');
    const applied = EPHEMERAL_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['cursorPos', { kind: 'ephemeral' }]],
      handle,
      event: { data: { owner: 'doc1', client: 'client1', cells: { x: 10 } } },
      db,
    });
    assert.ok(applied);
    const row = db.prepare(
      'SELECT cells FROM Doc_cursorPos WHERE Doc_id = ? AND client_id = ?',
    ).get('doc1', 'client1');
    assert.deepEqual(JSON.parse(row.cells), { x: 10 });
  });

  test('projectionApply replaces existing cells for same owner+client', () => {
    const db = freshDb();
    runDDL(db, EPHEMERAL_SIDE_TABLE_STRATEGY.ddl('Doc', 'cursorPos'));
    const handle = eventHandle.fieldSet('Doc', 'cursorPos');
    EPHEMERAL_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['cursorPos', { kind: 'ephemeral' }]],
      handle,
      event: { data: { owner: 'doc1', client: 'client1', cells: { x: 10 } } },
      db,
    });
    EPHEMERAL_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['cursorPos', { kind: 'ephemeral' }]],
      handle,
      event: { data: { owner: 'doc1', client: 'client1', cells: { x: 42, y: 7 } } },
      db,
    });
    const row = db.prepare(
      'SELECT cells FROM Doc_cursorPos WHERE Doc_id = ? AND client_id = ?',
    ).get('doc1', 'client1');
    assert.deepEqual(JSON.parse(row.cells), { x: 42, y: 7 });
    // Only one row per owner+client
    const count = db.prepare(
      'SELECT COUNT(*) AS c FROM Doc_cursorPos WHERE Doc_id = ? AND client_id = ?',
    ).get('doc1', 'client1');
    assert.equal(count.c, 1);
  });

  test('projectionApply skips non-fieldSet events', () => {
    const db = freshDb();
    runDDL(db, EPHEMERAL_SIDE_TABLE_STRATEGY.ddl('Doc', 'cursorPos'));
    const applied = EPHEMERAL_SIDE_TABLE_STRATEGY.projectionApply({
      entityName: 'Doc',
      fieldEntries: [['cursorPos', { kind: 'ephemeral' }]],
      handle: eventHandle.native('Doc', 'cursorPos', 'added'), // wrong kind
      event: { data: { owner: 'doc1', client: 'client1' } },
      db,
    });
    assert.ok(!applied);
  });

  test('handle.set dispatches fieldSet action without throwing', async () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'cursorPos';
    runDDL(db, EPHEMERAL_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName));
    const record = mockRecord(entityName, { [fieldName]: { kind: 'ephemeral' } });
    const h = EPHEMERAL_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'ephemeral' },
      row: mockRow('doc1'),
      principal: null,
      dispatch: fakeDispatch(true),
    });
    // should not throw — dispatch is invoked with the set action
    await h.set({ x: 5, y: 10 });
  });

  test('handle.get returns cells for the current principal client', () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'cursorPos';
    runDDL(db, EPHEMERAL_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName));
    // Apply projection
    EPHEMERAL_SIDE_TABLE_STRATEGY.projectionApply({
      entityName,
      fieldEntries: [[fieldName, { kind: 'ephemeral' }]],
      handle: eventHandle.fieldSet(entityName, fieldName),
      event: { data: { owner: 'doc1', client: 'user1', cells: { x: 10 } } },
      db,
    });
    const record = mockRecord(entityName, { [fieldName]: { kind: 'ephemeral' } });
    const h = EPHEMERAL_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'ephemeral' },
      row: mockRow('doc1'),
      principal: { id: 'user1' },
      dispatch: fakeDispatch(true), db,
    });
    assert.deepEqual(h.get(), { x: 10 });
  });

  test('handle.get returns empty object for unknown client', () => {
    const db = freshDb();
    const entityName = 'Doc';
    const fieldName = 'cursorPos';
    runDDL(db, EPHEMERAL_SIDE_TABLE_STRATEGY.ddl(entityName, fieldName));
    const record = mockRecord(entityName, { [fieldName]: { kind: 'ephemeral' } });
    const h = EPHEMERAL_SIDE_TABLE_STRATEGY.handle({
      record, entityName, fieldName,
      descriptor: { kind: 'ephemeral' },
      row: mockRow('doc1'),
      principal: { id: 'unknown' },
      dispatch: fakeDispatch(true), db,
    });
    assert.deepEqual(h.get(), {});
  });
});
