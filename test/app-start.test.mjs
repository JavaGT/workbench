import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity,
  date,
  grant,
  principal,
  read,
  subscribe,
  text,
  write,
} from '../build/index.mjs';
import { LiveChannel } from '../public/workbench-client.mjs';
import { executeDDL, executeFrameworkDDL } from '../build/ddl.mjs';

function startNote() {
  return entity('StartNote', {
    body: text(),
    grant: () => grant(read, write, subscribe),
  });
}

const user = principal({ type: 'user', id: 'start-user' });

test('app.start boots schema and dispatch without opening an HTTP socket', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote());
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  const first = app.start();
  const second = app.start();

  assert.equal(first, second, 'concurrent starts share one boot promise');
  assert.equal(app.ready, first, 'headless readiness is the start promise');
  await first;

  assert.equal(app.httpServer, undefined, 'start does not bind HTTP');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'StartNote'").get());

  const result = await app.dispatch({
    actionId: 'headless-create',
    type: 'StartNote.create',
    payload: { body: 'headless' },
    principal: user,
  });
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT body FROM StartNote').get().body, 'headless');
  assert.equal(app.start(), first, 'a completed start keeps the same readiness promise');
});

test('app.start is idempotent and unstarted database release closes the handle', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });

  assert.equal(app.start, app.start);
  assert.equal(app.releaseUnstartedDatabase(), app);
  assert.throws(() => db.prepare('SELECT 1'), /database is not open/i);
  await assert.rejects(app.start(), /database was released/i);
});

test('unstarted database release fails after startup', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  t.after(() => db.close());

  await app.start();
  assert.throws(() => app.releaseUnstartedDatabase(), /only valid before application startup/i);
  await app.shutdown();
});

test('generated create preserves a caller-owned id through commit and projection', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote());
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  await app.start();
  const result = await app.dispatch({
    actionId: 'caller-owned-create',
    type: 'StartNote.create',
    payload: { id: 'theme-client-1', body: 'stable identity' },
    principal: user,
  });

  assert.equal(result.ok, true);
  assert.equal(result.events[0].data.id, 'theme-client-1');
  const row = db.prepare('SELECT id, body FROM StartNote WHERE id = ?').get('theme-client-1');
  assert.equal(row.id, 'theme-client-1');
  assert.equal(row.body, 'stable identity');
});

test('generated update rejects an id-only payload without committing an event', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote());
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  await app.start();
  await app.dispatch({
    actionId: 'empty-update-create',
    type: 'StartNote.create',
    payload: { id: 'empty-update-note', body: 'unchanged' },
    principal: user,
  });
  const result = await app.dispatch({
    actionId: 'empty-update',
    type: 'StartNote.update',
    payload: { id: 'empty-update-note' },
    principal: user,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.match(result.failure.message, /at least one field/i);
  assert.equal(result.events, undefined);
  assert.equal(db.prepare('SELECT body FROM StartNote WHERE id = ?').get('empty-update-note').body, 'unchanged');
});

test('generated CRUD owns audit timestamps and rejects immutable field updates', async (t) => {
  const db = new DatabaseSync(':memory:');
  const AuditNote = entity('AuditNote', {
    projectId: text({ immutable: true }),
    body: text(),
    createdAt: date({ readonly: true, default: () => new Date('2000-01-01T00:00:00.000Z') }),
    updatedAt: date({ touch: true, default: () => new Date('2000-01-01T00:00:00.000Z') }),
    grant: () => grant(read, write, subscribe),
  });
  const app = workbench({ db }).mount('/audit-notes', AuditNote);
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  await app.start();
  const created = await app.dispatch({
    actionId: 'audit-create',
    type: 'AuditNote.create',
    payload: { id: 'audit-note', projectId: 'project-a', body: 'before' },
    principal: user,
  });
  assert.equal(created.ok, true);
  const initial = db.prepare('SELECT * FROM AuditNote WHERE id = ?').get('audit-note');
  assert.equal(initial.projectId, 'project-a');
  const initialAuditTime = new Date('2000-01-01T00:00:00.000Z').getTime();
  assert.equal(initial.createdAt, initialAuditTime);
  assert.equal(initial.updatedAt, initialAuditTime);

  const reparented = await app.dispatch({
    actionId: 'audit-reparent',
    type: 'AuditNote.update',
    payload: { id: 'audit-note', projectId: 'project-b' },
    principal: user,
  });
  assert.equal(reparented.ok, false);
  assert.equal(reparented.failure.category, 'invalid-input');
  assert.match(reparented.failure.message, /immutable/i);
  assert.equal(db.prepare('SELECT projectId FROM AuditNote WHERE id = ?').get('audit-note').projectId, 'project-a');

  const updated = await app.dispatch({
    actionId: 'audit-update',
    type: 'AuditNote.update',
    payload: { id: 'audit-note', body: 'after' },
    principal: user,
  });
  assert.equal(updated.ok, true);
  const final = db.prepare('SELECT * FROM AuditNote WHERE id = ?').get('audit-note');
  assert.equal(final.createdAt, initial.createdAt);
  assert.notEqual(final.updatedAt, initial.updatedAt);
});

test('generated create validates a server-owned default before committing it', async (t) => {
  const db = new DatabaseSync(':memory:');
  const InvalidDefault = entity('InvalidDefault', {
    label: text({ readonly: true, default: () => 42 }),
    grant: () => grant(read, write, subscribe),
  });
  const app = workbench({ db }).mount('/invalid-defaults', InvalidDefault);
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  await app.start();
  const result = await app.dispatch({
    actionId: 'invalid-default-create',
    type: 'InvalidDefault.create',
    payload: { id: 'invalid-default' },
    principal: user,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.match(result.failure.message, /InvalidDefault\.label.*text/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InvalidDefault').get().count, 0);
});

test('headless start without a database still assembles the application kernel', async () => {
  const app = workbench().mount('/start-notes', startNote());
  await app.start();

  assert.ok(app.kernel);
  assert.equal(app.httpServer, undefined);
  await app.shutdown();
});

test('a headless start makes the transport choice final', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote());
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  await app.start();
  assert.throws(
    () => app.listen(0),
    /already started without HTTP/i,
    'live delivery must be engaged before the kernel snapshots its consumers',
  );
  assert.equal(app.httpServer, undefined);
});

test('listen engages live delivery before the singular application start', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote());
  let channel;
  t.after(async () => {
    channel?.close();
    await app.shutdown();
    db.close();
  });

  app.listen(0, { principalOf: () => user });
  const started = app.start();
  assert.equal(started, app.ready, 'HTTP and headless callers observe one boot promise');
  await app.ready;
  const created = await app.dispatch({
    actionId: 'after-listen-create',
    type: 'StartNote.create',
    payload: { body: 'after listen' },
    principal: user,
  });
  const id = created.events[0].data.id;
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  channel = new LiveChannel(origin);

  let resolveEvent;
  const delivered = new Promise((resolve) => { resolveEvent = resolve; });
  await channel.subscribe('StartNote', id, (envelope) => resolveEvent(envelope));
  await app.dispatch({
    actionId: 'after-listen-update',
    type: 'StartNote.update',
    payload: { id, body: 'live now' },
    principal: user,
  });

  const envelope = await Promise.race([
    delivered,
    new Promise((_, reject) => setTimeout(() => reject(new Error('live delivery timed out')), 1000)),
  ]);
  assert.equal(envelope.event.type, 'StartNote.updated');
  assert.equal(envelope.event.data.body, 'live now');
});

test('live subscriptions wait for the same application readiness barrier as HTTP requests', async (t) => {
  let releaseRoutes;
  let markRoutesStarted;
  const routesReleased = new Promise((resolve) => { releaseRoutes = resolve; });
  const routesStarted = new Promise((resolve) => { markRoutesStarted = resolve; });
  const SlowLiveNote = entity('SlowLiveStartNote', {
    body: text(),
    grant: () => grant(read, write, subscribe),
    routes: async (router) => {
      markRoutesStarted();
      await routesReleased;
      router.resource();
    },
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/slow-live-notes', SlowLiveNote);
  executeFrameworkDDL(db);
  executeDDL(app.entities.get('SlowLiveStartNote'), db);
  db.prepare('INSERT INTO SlowLiveStartNote (id, body) VALUES (?, ?)').run('n1', 'ready later');

  let channel;
  t.after(async () => {
    channel?.close();
    releaseRoutes?.();
    await app.shutdown();
    db.close();
  });

  app.listen(0, { principalOf: () => user });
  await routesStarted;
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  channel = new LiveChannel(origin);
  const subscription = channel.subscribe('SlowLiveStartNote', 'n1', () => {});

  const early = await Promise.race([
    subscription.then(() => 'settled', () => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
  assert.equal(early, 'pending', 'the live protocol must not enter before startup completes');

  releaseRoutes();
  await app.ready;
  const acknowledged = await subscription;
  assert.equal(typeof acknowledged.currentSeq, 'number');
});

test('headless shutdown is safe and start remains unavailable after shutdown', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote());
  await app.start();
  await app.shutdown();

  await assert.rejects(app.start(), /shut down/i);
  db.close();
});

test('shutdown is available before start and permanently closes the application', async () => {
  const app = workbench().mount('/start-notes', startNote());

  assert.equal(typeof app.shutdown, 'function');
  await app.shutdown();

  await assert.rejects(app.start(), /shut down/i);
});

test('listen rejects a second transport instead of leaking another server', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote()).listen(0);
  t.after(async () => {
    await app.shutdown();
    db.close();
  });
  await app.ready;

  assert.throws(() => app.listen(0), /already listening/i);
});

test('shutdown is concurrent-safe, closes live delivery, and drains accepted writes', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote());
  await app.start();

  let releaseWrite;
  const heldWrite = app.writeQueue.run(() => new Promise((resolve) => { releaseWrite = resolve; }));
  let liveCloseCount = 0;
  app.live = { close() { liveCloseCount += 1; } };
  let hookCount = 0;
  app.onShutdown('count-once', () => { hookCount += 1; });

  const first = app.shutdown();
  const second = app.shutdown();
  assert.equal(first, second, 'concurrent shutdown calls share one promise');

  let settled = false;
  first.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'shutdown waits for an accepted write');
  await assert.rejects(app.writeQueue.run(() => undefined), /closed/i);

  releaseWrite();
  await heldWrite;
  await first;
  assert.equal(liveCloseCount, 1);
  assert.equal(hookCount, 1);
  db.close();
});

test('shutdown closes idle HTTP keep-alive connections after stopping ingress', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote()).listen(0);
  const agent = new Agent({ keepAlive: true });
  t.after(() => {
    agent.destroy();
    db.close();
  });
  await app.ready;

  let socket;
  await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${app.httpServer.address().port}/missing`, { agent }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('socket', (value) => { socket = value; });
    req.on('error', reject);
    req.end();
  });
  assert.ok(socket && !socket.destroyed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(Object.values(agent.freeSockets).flat().includes(socket), 'request socket is idle');

  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  await app.shutdown();
  await socketClosed;
  assert.equal(app.httpServer.listening, false);
  assert.equal(socket.destroyed, true);
});

test('an HTTP bind failure rejects the singular ready promise and closes acquired owners', async (t) => {
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, resolve);
  });
  t.after(() => new Promise((resolve) => occupied.close(resolve)));

  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/start-notes', startNote());
  let clockStops = 0;
  const stopClock = app.clock.stop;
  app.clock.stop = () => {
    clockStops += 1;
    stopClock();
  };
  app.listen(occupied.address().port);
  const ready = app.ready;
  assert.equal(ready, app.start());
  await assert.rejects(ready, (err) => err?.code === 'EADDRINUSE');
  assert.equal(app.httpServer.listening, false);
  assert.equal(app.writeQueue.closed, true, 'failed startup closes mutation admission');
  assert.equal(clockStops, 1, 'failed startup releases the application clock');
  await assert.rejects(app.start(), (err) => err?.code === 'EADDRINUSE' || /shut down/i.test(err?.message ?? ''));
  db.close();
});

test('a synchronous listen argument failure still exposes failed readiness and cleans up', async () => {
  const app = workbench().mount('/start-notes', startNote());

  const invalidPort = (err) => err?.code === 'ERR_SOCKET_BAD_PORT';
  assert.throws(() => app.listen(-1), invalidPort);
  assert.ok(app.ready, 'readiness exists before Node begins binding the socket');
  await assert.rejects(app.ready, invalidPort);
  assert.equal(app.writeQueue.closed, true);
});

test('a route-resolution failure cleans up a headless application', async () => {
  const BrokenNote = entity('BrokenStartNote', {
    body: text(),
    grant: () => grant(read, write),
    routes: () => {
      throw new Error('broken route declaration');
    },
  });
  const app = workbench().mount('/broken-notes', BrokenNote);
  let clockStops = 0;
  const stopClock = app.clock.stop;
  app.clock.stop = () => {
    clockStops += 1;
    stopClock();
  };

  const started = app.start();
  await assert.rejects(started, /broken route declaration/);

  assert.equal(app.writeQueue.closed, true);
  assert.equal(clockStops, 1);
  assert.equal(app.start(), started, 'the original failed readiness remains observable');
});

test('shutdown requested during asynchronous boot waits for its safe stop point', async () => {
  let releaseRoutes;
  let markRoutesStarted;
  const routesReleased = new Promise((resolve) => { releaseRoutes = resolve; });
  const routesStarted = new Promise((resolve) => { markRoutesStarted = resolve; });
  const SlowNote = entity('SlowStartNote', {
    body: text(),
    grant: () => grant(read, write, subscribe),
    routes: async (router) => {
      markRoutesStarted();
      await routesReleased;
      router.resource();
    },
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/slow-notes', SlowNote).listen(0);
  await routesStarted;

  const stopped = app.shutdown();
  let settled = false;
  stopped.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'shutdown waits for route resolution already in progress');

  releaseRoutes();
  await app.ready;
  await stopped;
  assert.equal(app.httpServer.listening, false);
  await assert.rejects(app.start(), /shut down/i);
  db.close();
});

test('shutdown immediately after listen settles startup even before the listening event', async () => {
  const app = workbench().mount('/start-notes', startNote()).listen(0);

  const stopped = app.shutdown();
  await Promise.all([app.ready, stopped]);

  assert.equal(app.httpServer.listening, false);
});

test('closing the raw HTTP server before its listening event cancels startup cleanly', async () => {
  const app = workbench().mount('/start-notes', startNote()).listen(0);

  app.httpServer.close();
  await app.ready;

  assert.equal(app.httpServer.listening, false);
  assert.equal(app.writeQueue.closed, true);
  await assert.rejects(app.start(), /shut down/i);
});
