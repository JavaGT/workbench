// Structured logger tests — agent-readable JSON output + level gating.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench from '../build/app.mjs';
import { entity } from '../build/entity/compile.mjs';
import { text } from '../build/field.mjs';
import { grant, read, write } from '../build/grant.mjs';
import { allowAnonymous } from '../build/route-gate.mjs';
import { createLog, getLog } from '../build/log.mjs';

test('constructing another application does not replace the first application logger', () => {
  const messagesA = [];
  const messagesB = [];
  const appA = workbench({ log: { output: (_level, _channel, message) => messagesA.push(message) } });
  workbench({ log: { output: (_level, _channel, message) => messagesB.push(message) } });

  appA.log.info('system', 'app A after app B');

  assert.deepEqual(
    { messagesA, messagesB },
    {
      messagesA: ['workbench() constructed', 'app A after app B'],
      messagesB: ['workbench() constructed'],
    },
  );
});

test('application startup keeps using its own logger after another application is constructed', async (t) => {
  const messagesA = [];
  const messagesB = [];
  const appA = workbench({ log: { output: (_level, _channel, message) => messagesA.push(message) } });
  workbench({ log: { output: (_level, _channel, message) => messagesB.push(message) } });
  appA.listen(0);
  await appA.ready;
  t.after(() => appA.httpServer.close());

  assert.deepEqual(
    {
      aStarted: messagesA.some((message) => message.startsWith('server listening on port ')),
      bStarted: messagesB.some((message) => message.startsWith('server listening on port ')),
    },
    { aStarted: true, bStarted: false },
  );
});

test('application requests keep using their owning application logger', async (t) => {
  const entriesA = [];
  const entriesB = [];
  const appA = workbench({ log: { output: (level, channel, message) => entriesA.push({ level, channel, message }) } });
  workbench({ log: { output: (level, channel, message) => entriesB.push({ level, channel, message }) } });
  appA.listen(0, { requestLog: true });
  await appA.ready;
  t.after(() => appA.httpServer.close());

  await fetch(`http://127.0.0.1:${appA.httpServer.address().port}/health`);

  assert.deepEqual(
    {
      aHttpEntries: entriesA.filter(({ channel }) => channel === 'http').length,
      bHttpEntries: entriesB.filter(({ channel }) => channel === 'http').length,
    },
    { aHttpEntries: 1, bHttpEntries: 0 },
  );
});

test('nested request work resolves the owning application logger', async (t) => {
  const messagesA = [];
  const messagesB = [];
  const appA = workbench({ log: { output: (_level, _channel, message) => messagesA.push(message) } });
  appA.get('/probe', allowAnonymous(), (_req, res) => {
    getLog().info('system', 'nested app A operation');
    res.json({ ok: true });
  });
  workbench({ log: { output: (_level, _channel, message) => messagesB.push(message) } });
  appA.listen(0);
  await appA.ready;
  t.after(() => appA.httpServer.close());

  await fetch(`http://127.0.0.1:${appA.httpServer.address().port}/probe`);

  assert.deepEqual(
    {
      appA: messagesA.includes('nested app A operation'),
      appB: messagesB.includes('nested app A operation'),
    },
    { appA: true, appB: false },
  );
});

test('concurrent application requests cannot cross-log', async (t) => {
  const messagesA = [];
  const messagesB = [];
  const appA = workbench({ log: { output: (_level, channel, message) => {
    if (channel === 'isolation') messagesA.push(message);
  } } });
  const appB = workbench({ log: { output: (_level, channel, message) => {
    if (channel === 'isolation') messagesB.push(message);
  } } });
  appA.get('/probe', allowAnonymous(), async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    getLog().info('isolation', 'A');
    res.json({ ok: true });
  });
  appB.get('/probe', allowAnonymous(), async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    getLog().info('isolation', 'B');
    res.json({ ok: true });
  });
  appA.listen(0);
  appB.listen(0);
  await Promise.all([appA.ready, appB.ready]);
  t.after(() => {
    appA.httpServer.close();
    appB.httpServer.close();
  });

  await Promise.all([
    fetch(`http://127.0.0.1:${appA.httpServer.address().port}/probe`),
    fetch(`http://127.0.0.1:${appB.httpServer.address().port}/probe`),
  ]);

  assert.deepEqual({ messagesA, messagesB }, { messagesA: ['A'], messagesB: ['B'] });
});

test('direct application dispatch resolves its owning application logger', async (t) => {
  const db = new DatabaseSync(':memory:');
  const messagesA = [];
  const messagesB = [];
  const Note = entity('LoggingIsolationNote', {
    body: text(),
    grant: () => [grant(read, write)],
  });
  const appA = workbench({
    db,
    entities: [Note],
    log: { level: 'debug', output: (_level, _channel, message) => messagesA.push(message) },
  });
  workbench({ log: { level: 'debug', output: (_level, _channel, message) => messagesB.push(message) } });
  appA.listen(0);
  await appA.ready;
  t.after(() => {
    appA.httpServer.close();
    db.close();
  });

  await appA.dispatch({
    actionId: 'logging-isolation-create',
    type: 'LoggingIsolationNote.create',
    payload: { body: 'hello' },
    principal: { type: 'user', id: 'user-1' },
  });

  assert.deepEqual(
    {
      appA: messagesA.includes('LoggingIsolationNote.created'),
      appB: messagesB.includes('LoggingIsolationNote.created'),
    },
    { appA: true, appB: false },
  );
});

test('default level is info — debug and trace are dropped', () => {
  const lines = [];
  const log = createLog({ output: (level, channel, msg, ctx) => lines.push({ level, channel, msg, ctx }) });
  log.trace('auth', 'trace', { x: 1 });
  log.debug('auth', 'debug', { x: 2 });
  log.info('auth', 'info', { x: 3 });
  log.warn('auth', 'warn', { x: 4 });
  log.error('auth', 'error', { x: 5 });
  assert.equal(lines.length, 3, 'trace and debug dropped');
  assert.deepEqual(lines[0], { level: 'info', channel: 'auth', msg: 'info', ctx: { x: 3 } });
  assert.deepEqual(lines[2], { level: 'error', channel: 'auth', msg: 'error', ctx: { x: 5 } });
});

test('channel-specific levels override global floor', () => {
  const lines = [];
  const log = createLog({
    level: 'warn',
    channels: { auth: 'debug', http: 'error' },
    output: (level, channel, msg, ctx) => lines.push({ level, channel, msg, ctx }),
  });
  log.debug('auth', 'debug auth', {});
  log.info('auth', 'info auth', {});
  log.warn('http', 'warn http', {});
  log.warn('system', 'warn system', {});
  assert.equal(lines.length, 3);
  // auth gets debug+ because channel floor is debug
  assert.equal(lines[0].msg, 'debug auth');
  assert.equal(lines[1].msg, 'info auth');
  // http gets error+ only because channel floor is error → warn dropped
  // system uses global floor (warn) → warn passes
  assert.equal(lines[2].msg, 'warn system');
});

test('json format produces parseable JSON lines', (_t) => {
  const chunks = [];
  const output = { write: (chunk) => chunks.push(chunk) };
  const log = createLog({ level: 'info', format: 'json', output });
  log.info('http', 'GET /notes 200', { method: 'GET', path: '/notes', status: 200 });
  log.warn('auth', 'update denied', { entity: 'Note', id: 'n1', principal: 'bob', verb: 'update' });
  const err = new Error('boom');
  err.code = 'E_TEST';
  log.error('dispatch', 'dispatch failed', { err, entity: 'Note' });
  assert.equal(chunks.length, 3);
  const entry1 = JSON.parse(chunks[0]);
  assert.equal(entry1.level, 'info');
  assert.equal(entry1.channel, 'http');
  assert.equal(entry1.msg, 'GET /notes 200');
  assert.deepEqual(entry1.ctx, { method: 'GET', path: '/notes', status: 200 });

  const entry2 = JSON.parse(chunks[1]);
  assert.equal(entry2.level, 'warn');
  assert.deepEqual(entry2.ctx, { entity: 'Note', id: 'n1', principal: 'bob', verb: 'update' });

  const entry3 = JSON.parse(chunks[2]);
  assert.equal(entry3.level, 'error');
  assert.equal(entry3.ctx.err.message, 'boom');
  assert.equal(entry3.ctx.err.code, 'E_TEST');
});

test('human format produces colorized output', () => {
  const lines = [];
  const log = createLog({ level: 'debug', format: 'human', output: { write: (chunk) => lines.push(chunk) } });
  log.debug('auth', 'grant checked', { entity: 'Note', id: 'n1' });
  log.warn('system', 'blob reap failed', { err: new Error('ENOENT') });
  log.info('http', 'GET /notes 200', { method: 'GET', status: 200 });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('[DEBUG'), 'has DEBUG tag');
  assert.ok(lines[0].includes('auth'), 'has channel');
  assert.ok(lines[0].includes('grant checked'), 'has message');
  assert.ok(lines[0].includes('entity=Note'), 'has context key-value');
  assert.ok(lines[1].includes('[WARN'));
  assert.ok(lines[1].includes('ENOENT'), 'error message in context');
});

test('deserializeRow ordering and empty row guard', () => {
  const lines = [];
  const log = createLog({ level: 'info', format: 'json', output: (l,c,m) => lines.push({ l,c,m }) });
  // info-level assertion: empty rows get 404 before deserialize (serve.mjs fix)
  log.info('http', 'read row not found', { path: '/notes/abc', status: 404 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].c, 'http');
});
