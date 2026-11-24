import 'fake-indexeddb/auto';
import { describe, it, before as _before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openLocalLog } from '../public/workbench-local-log.mjs';

const DB_NAME = 'test-workbench-local-log';

describe('openLocalLog', () => {
  after(async () => {
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(DB_NAME);
      r.onsuccess = resolve;
      r.onerror = reject;
    });
  });

  it('opens a database and returns append/entriesSince/head/prune', async () => {
    const log = await openLocalLog(DB_NAME);
    assert.equal(typeof log.append, 'function');
    assert.equal(typeof log.entriesSince, 'function');
    assert.equal(typeof log.head, 'function');
    assert.equal(typeof log.prune, 'function');
    assert.equal(typeof log.close, 'function');
  });

  it('append returns the entry with assigned id', async () => {
    const log = await openLocalLog(DB_NAME);
    const entry = await log.append({
      opId: 'op_1',
      seq: 1,
      scope: 'scope_a',
      entity: 'Todo',
      rowId: 'abc123',
      kind: 'create',
      type: 'Todo.create',
      payload: { title: 'Buy milk' },
      preimage: null,
      actionId: 'uuid-1',
      status: 'committed',
      source: 'local',
      timestamp: 1000,
    });
    assert.ok(typeof entry.id === 'number');
    assert.equal(entry.opId, 'op_1');
    assert.equal(entry.scope, 'scope_a');
    assert.equal(entry.seq, 1);
  });

  it('append rejects when the transaction aborts after the request succeeds', async () => {
    const dbName = 'test-workbench-local-log-abort';
    const log = await openLocalLog(dbName);
    const originalAdd = IDBObjectStore.prototype.add;
    let abortedAfterSuccess = false;

    IDBObjectStore.prototype.add = function (...args) {
      const request = originalAdd.apply(this, args);
      request.addEventListener('success', () => {
        queueMicrotask(() => {
          abortedAfterSuccess = true;
          request.transaction.abort();
        });
      });
      return request;
    };

    try {
      await assert.rejects(
        log.append({
          opId: 'abort', seq: 1, scope: 'scope_abort', entity: 'E', rowId: 'r',
          kind: 'create', type: 'E.create', payload: {}, preimage: null,
          actionId: 'abort-1', status: 'committed', source: 'local', timestamp: 1000,
        }),
        /abort/i,
      );
      assert.equal(abortedAfterSuccess, true, 'the request succeeded before the abort');
      const entries = await log.entriesSince('scope_abort', 0);
      assert.equal(entries.length, 0, 'the aborted append left no durable row');
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
      log.close();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(`workbench:local:${dbName}`);
        request.onsuccess = resolve;
        request.onerror = reject;
      });
    }
  });

  it('entriesSince returns entries for a scope with seq > cursor, ordered by seq', async () => {
    const log = await openLocalLog(DB_NAME);
    await log.append({ opId:'a', seq:1, scope:'s1', entity:'E', rowId:'r1', kind:'create', type:'E.create', payload:{}, preimage:null, actionId:'a1', status:'committed', source:'local', timestamp:1000 });
    await log.append({ opId:'b', seq:2, scope:'s1', entity:'E', rowId:'r1', kind:'update', type:'E.update', payload:{x:1}, preimage:{x:0}, actionId:'a2', status:'committed', source:'local', timestamp:2000 });
    await log.append({ opId:'c', seq:3, scope:'s1', entity:'E', rowId:'r1', kind:'update', type:'E.update', payload:{x:2}, preimage:{x:1}, actionId:'a3', status:'committed', source:'local', timestamp:3000 });
    await log.append({ opId:'d', seq:1, scope:'s2', entity:'E', rowId:'r2', kind:'create', type:'E.create', payload:{}, preimage:null, actionId:'a4', status:'committed', source:'local', timestamp:4000 });

    let entries = await log.entriesSince('s1', 0);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].opId, 'a');
    assert.equal(entries[2].opId, 'c');

    entries = await log.entriesSince('s1', 1);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].opId, 'b');

    entries = await log.entriesSince('s1', 3);
    assert.equal(entries.length, 0);
  });

  it('entriesSince returns nothing for a scope with no entries', async () => {
    const log = await openLocalLog(DB_NAME);
    const entries = await log.entriesSince('nonexistent', 0);
    assert.equal(entries.length, 0);
  });

  it('head returns max seq for a scope', async () => {
    const log = await openLocalLog(DB_NAME);
    await log.append({ opId:'x', seq:5, scope:'scope_h', entity:'E', rowId:'r', kind:'update', type:'E.update', payload:{}, preimage:null, actionId:'h1', status:'committed', source:'remote', timestamp:5000 });
    await log.append({ opId:'y', seq:7, scope:'scope_h', entity:'E', rowId:'r', kind:'update', type:'E.update', payload:{}, preimage:null, actionId:'h2', status:'committed', source:'remote', timestamp:7000 });

    const head = await log.head('scope_h');
    assert.equal(head, 7);
  });

  it('head returns 0 for a scope with no entries', async () => {
    const log = await openLocalLog(DB_NAME);
    const head = await log.head('no-scope');
    assert.equal(head, 0);
  });

  it('prune removes entries older than a timestamp', async () => {
    const log = await openLocalLog(DB_NAME);
    await log.append({ opId:'old', seq:1, scope:'scope_prune', entity:'E', rowId:'r', kind:'create', type:'E.create', payload:{}, preimage:null, actionId:'p1', status:'committed', source:'local', timestamp:1000 });
    await log.append({ opId:'mid', seq:2, scope:'scope_prune', entity:'E', rowId:'r', kind:'update', type:'E.update', payload:{}, preimage:null, actionId:'p2', status:'committed', source:'local', timestamp:2000 });
    await log.append({ opId:'new', seq:3, scope:'scope_prune', entity:'E', rowId:'r', kind:'update', type:'E.update', payload:{}, preimage:null, actionId:'p3', status:'committed', source:'local', timestamp:3000 });

    const removed = await log.prune(1500);
    assert.ok(removed >= 1);

    const entries = await log.entriesSince('scope_prune', 0);
    assert.ok(entries.every(e => e.timestamp >= 1500), 'all remaining entries should be >= 1500');
  });

  it('reopen returns existing entries (persistence)', async () => {
    let log = await openLocalLog(DB_NAME);
    await log.append({ opId:'persist', seq:1, scope:'scope_persist', entity:'E', rowId:'r', kind:'create', type:'E.create', payload:{}, preimage:null, actionId:'persist1', status:'committed', source:'local', timestamp:1000 });
    log.close();

    log = await openLocalLog(DB_NAME);
    const entries = await log.entriesSince('scope_persist', 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].opId, 'persist');
  });
});
