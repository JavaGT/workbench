// Regression coverage for issue #313 — round-2 core/authz bugfixes and
// composable inherit refinement. One focused file so the whole wave can be
// run under both `node --test` and `bun test`.
//
//   #249 virtual tables cannot be bounded-write targets
//   #246 single-column UNIQUE declarations on entity()
//   #237 explicit null is not an optional value unless opted in
//   #235 duplicate ref roles fail closed at compile time
//   #240 shared-clock runners forward sync + async errors
//   #253 same-scope collection resubscribe is exempt from the cap
//   composable inherit(Parent, { via }).where(...).can(...)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  boolean, entity, grant, deny, everyone, inherit, principal, read, ref,
  scope, subscribe, text, write,
} from '../build/index.mjs';
import { applicationTable } from '../build/application-table-guard.mjs';
import { validateMutation } from '../build/field-strategy.mjs';
import { createClockRunner } from '../build/clock-runner.mjs';
import { authorizeSubscription } from '../build/live-admission.mjs';
import { bindReadScope } from '../build/scope-sql.mjs';
import { mayVerb } from '../build/row-grant.mjs';

const fail = (message) => { throw new Error(message); };

// ---- #249: virtual tables are not bounded-write targets --------------------

test('#249 — application-table guard rejects FTS5 virtual tables for writes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE SearchFts USING fts5(content)');
    db.exec('CREATE TABLE Ordinary (id TEXT PRIMARY KEY)');

    assert.throws(
      () => applicationTable(db, 'SearchFts', new Set(['SearchFts']), 'writes', fail),
      /virtual table/,
      'an FTS5 table is type=table in sqlite_master but writing it fans out to undeclared shadow tables',
    );
    assert.equal(
      applicationTable(db, 'Ordinary', new Set(['Ordinary']), 'writes', fail),
      'main."Ordinary"',
      'ordinary declared tables are still writable',
    );
    assert.equal(
      applicationTable(db, 'SearchFts', new Set(['SearchFts']), 'reads', fail),
      'main."SearchFts"',
      'the bounded-read contract is unchanged',
    );
  } finally {
    db.close();
  }
});

// ---- #246: single-column UNIQUE constraints --------------------------------

test('#246 — unique: [field] and field-level unique:true emit UNIQUE indexes and reject duplicates', () => {
  const Account = entity('Account', {
    email: text({ unique: true }),
    handle: text(),
    tenant: text(),
    unique: ['handle', ['tenant', 'email']],
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
  });

  const ddl = Account.generateDDL();
  assert.match(ddl.join('\n'), /CREATE UNIQUE INDEX IF NOT EXISTS "idx_Account_unique_email" ON "Account" \("email"\)/);
  assert.match(ddl.join('\n'), /CREATE UNIQUE INDEX IF NOT EXISTS "idx_Account_unique_handle" ON "Account" \("handle"\)/);
  assert.match(ddl.join('\n'), /CREATE UNIQUE INDEX IF NOT EXISTS "idx_Account_unique_tenant_email" ON "Account" \("tenant", "email"\)/);

  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of ddl) db.exec(sql);
    db.prepare('INSERT INTO Account (id, email, handle, tenant) VALUES (?, ?, ?, ?)').run('a', 'a@example.test', 'alice', 't1');
    assert.throws(
      () => db.prepare('INSERT INTO Account (id, email, handle, tenant) VALUES (?, ?, ?, ?)').run('b', 'a@example.test', 'bob', 't1'),
      /UNIQUE constraint failed/,
      'the generated index enforces uniqueness in SQLite',
    );
  } finally {
    db.close();
  }
});

test('#246 — the existing multi-column indexes slot is unchanged', () => {
  const Pair = entity('Pair', {
    left: text(), right: text(),
    indexes: [{ fields: ['left', 'right'], unique: true }],
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  assert.match(
    Pair.generateDDL().join('\n'),
    /CREATE UNIQUE INDEX IF NOT EXISTS "idx_Pair_unique_left_right" ON "Pair" \("left", "right"\)/,
  );
  assert.throws(
    () => entity('BadSingle', {
      a: text(),
      indexes: [{ fields: ['a'], unique: true }],
      grant: () => [scope(() => everyone()).can(() => grant(read))],
    }),
    /at least two/,
    'composite-only `indexes` keeps its contract; single columns use `unique`',
  );
});

// ---- #237: absent vs explicit null -----------------------------------------

test('#237 — validateMutation rejects explicit null for non-nullable optional scalars', () => {
  const Note = entity('NullSemantics', {
    plain: text({ optional: true }),
    nullable: text({ optional: true, nullable: true }),
    defaulted: text({ optional: true, default: null }),
    owner: ref('User', { optional: true }),
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });

  assert.deepEqual(validateMutation(Note, { plain: 'value' }), { plain: 'value' }, 'absence is allowed');
  assert.throws(() => validateMutation(Note, { plain: null }), /expected a text value/);
  assert.throws(() => validateMutation(Note, { owner: null }), /expected a ref value/, 'optional refs are not implicitly nullable');
  assert.deepEqual(validateMutation(Note, { nullable: null }), { nullable: null });
  assert.deepEqual(validateMutation(Note, { defaulted: null }), { defaulted: null });
});

// ---- #235: duplicate ref roles ---------------------------------------------

test('#235 — two ref fields declaring the same role fail closed at compile time', () => {
  assert.throws(
    () => entity('DuplicateRole', {
      first: ref('User', { role: 'owner', readonly: true }),
      second: ref('User', { role: 'owner' }),
      grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read) : deny('no'))],
    }),
    /both declare role 'owner'/,
  );

  assert.doesNotThrow(
    () => entity('DistinctRoles', {
      owner: ref('User', { role: 'owner', readonly: true }),
      editor: ref('User', { role: 'editor' }),
      grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read) : deny('no'))],
    }),
    'distinct roles still compile',
  );
});

// ---- #240: shared-clock error forwarding -----------------------------------

test('#240 — the shared-clock path forwards sync throws and async rejections to onError', async () => {
  let fire;
  const clock = {
    add({ fn }) {
      fire = fn;
      return { remove() { fire = undefined; } };
    },
  };

  const syncErrors = [];
  const syncRunner = createClockRunner({
    clock, intervalMs: 10, name: 'sync-tick',
    fn: () => { throw new Error('sync boom'); },
    onError: (err) => syncErrors.push(err.message),
  });
  fire(1);
  assert.deepEqual(syncErrors, ['sync boom'], 'a synchronous throw must not be silently swallowed');
  syncRunner.stop();

  let asyncError;
  const asyncRunner = createClockRunner({
    clock, intervalMs: 10, name: 'async-tick',
    fn: () => Promise.reject(new Error('async boom')),
    onError: (err) => { asyncError = err; },
  });
  fire(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asyncError?.message, 'async boom', 'an async rejection must reach the same error sink');
  asyncRunner.stop();
});

// ---- #253: same-scope collection replacement at the cap --------------------

test('#253 — same-scope collection resubscribe is admitted at the 32-subscription cap', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, rank INTEGER); INSERT INTO Note VALUES ('a', 'A', 1)");
    const note = {
      name: 'Note',
      fields: { title: { kind: 'value' }, rank: { kind: 'value' } },
      scopeFilter: () => ({ sql: '1=1', params: {} }),
    };
    const rule = { resourceKind: 'Note', select: ['title', 'rank'], sort: [{ field: 'rank' }], boundedResultPolicy: { limit: 2 } };
    const held = new Set(['Note']);
    for (let i = 0; i < 31; i += 1) held.add(`Held${i}`);
    const deps = {
      resolveEntity: (name) => (name === 'Note' ? note : null),
      mayVerb: async () => true,
      db,
      authorization: { admit: async () => ({ admitted: true }) },
      fanout: {
        subscriptionCount: () => 0,
        collectionSubscriptionCount: () => 32,
        hasSubscription: (_conn, scope) => held.has(scope),
      },
    };
    const conn = { principal: principal({ type: 'user', id: 'u1' }) };

    const replacement = await authorizeSubscription({ scope: 'Note', rule }, conn, deps);
    assert.equal(replacement.admitted, true, 'a scope already held is replaced, not added');
    assert.ok('sql' in replacement.interest.rule);

    const fresh = await authorizeSubscription({ scope: 'Other', rule }, conn, deps);
    assert.equal(fresh.admitted, false);
    assert.match(fresh.failure.message, /Too many collection subscriptions/);
  } finally {
    db.close();
  }
});

// ---- composable inherit(Parent, { via }) refinement ------------------------

test('inherit(Parent, { via }).where(...).can(...) ANDs the scope and intersects capabilities', async () => {
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    archived: boolean(),
    grant: () => [scope(({ is }) => is.owner()).can(
      async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('not the owner'),
    )],
  });
  const Artefact = entity('Artefact', {
    project: ref('Project', { required: true }),
    reviewer: ref('User', { role: 'reviewer' }),
    draft: boolean(),
    grant: inherit(Project, { via: 'project' })
      .where(({ fields }) => fields.draft.is(true))
      .can(async ({ is }) => (await is.reviewer()) ? grant(read, subscribe) : deny('not the reviewer')),
  });

  // SQL half: parent EXISTS AND child draft predicate, one bound principal id.
  const sql = bindReadScope(Artefact.readScope, principal({ type: 'user', id: 'u1' }));
  assert.match(sql.sql, /EXISTS \(SELECT 1 FROM Project/);
  assert.match(sql.sql, /t0\.draft = :p\d+_val/, 'the child predicate is present in the WHERE fragment');
  assert.equal(Object.keys(sql.params).filter((key) => key.endsWith('_principalId')).length, 1);

  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, owner TEXT, archived INTEGER)');
    db.exec('CREATE TABLE Artefact (id TEXT PRIMARY KEY, project TEXT, reviewer TEXT, draft INTEGER)');
    db.exec("INSERT INTO Project VALUES ('p1', 'u1', 0), ('p2', 'u2', 0)");
    db.exec("INSERT INTO Artefact VALUES ('a1', 'p1', 'u1', 1), ('a2', 'p1', 'u1', 0), ('a3', 'p2', 'u1', 1)");

    const bound = bindReadScope(Artefact.readScope, principal({ type: 'user', id: 'u1' }));
    const visible = db.prepare(`SELECT id FROM Artefact AS t0 WHERE ${bound.sql}`).all(bound.params).map((row) => row.id);
    assert.deepEqual(visible, ['a1'], 'only rows whose parent is owned AND that are drafts are visible');

    // Runtime half: child .can refines the parent's capabilities.
    const app = workbench({ db, entities: [Project, Artefact] });
    await app.start();
    const artefact = app.entity(Artefact);
    const row = artefact.findById('a1');
    assert.equal(await mayVerb(artefact, 'read', row, principal({ type: 'user', id: 'u1' })), true);
    assert.equal(
      await mayVerb(artefact, 'write', row, principal({ type: 'user', id: 'u1' })),
      false,
      'the parent grants write, but the child refinement keeps read/subscribe only',
    );
    assert.equal(
      await mayVerb(artefact, 'read', row, principal({ type: 'user', id: 'stranger' })),
      false,
      'a non-reviewer is denied even on a scope-visible row',
    );
    assert.equal(
      await mayVerb(artefact, 'read', artefact.findById('a3'), principal({ type: 'user', id: 'u1' })),
      false,
      'a reviewer cannot re-grant access to a row whose parent denied it',
    );
  } finally {
    db.close();
  }
});

test('plain inherit(Parent, { via }) keeps its original shape (no refinement)', () => {
  const Project = entity('PlainProject', {
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read) : deny('no'))],
  });
  const Child = entity('PlainChild', {
    project: ref('PlainProject', { required: true }),
    grant: inherit(Project, { via: 'project' }),
  });
  assert.deepEqual(Object.keys(Child.grant).filter((key) => key !== 'where' && key !== 'can').sort(), ['inherit', 'via']);
  assert.match(Child.readScope.sql, /EXISTS \(SELECT 1 FROM PlainProject/);
  assert.doesNotMatch(Child.readScope.sql, /1 = 1 AND/);
});
