import { DatabaseSync } from 'node:sqlite';
import { text, boolean, ref, map, scope, grant, read, write, subscribe, inherit, entity, generateDDL, executeFrameworkDDL, principal, anonymous, anyOf, bindReadScope } from '../build/internal.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

let db;
test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
});

test.afterEach(() => {
  db.close();
});

test('dual-face conformance: ref-role owner check (SQL eq = runtime ===)', async () => {
  const Doc = entity('Doc', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });

  for (const sql of generateDDL(Doc)) db.exec(sql);

  db.prepare(`INSERT INTO Doc (id, body, owner) VALUES ('r1', 'a', 'alice')`).run();
  db.prepare(`INSERT INTO Doc (id, body, owner) VALUES ('r2', 'b', 'bob')`).run();

  const scopes = [];
  const runtimes = [];

  for (const rowId of ['r1', 'r2']) {
    const row = db.prepare(`SELECT * FROM Doc AS t0 WHERE id = :id`).get({ id: rowId });
    for (const p of [principal({ type: 'user', id: 'alice' }), principal({ type: 'user', id: 'bob' }), anonymous]) {
      const bound = Doc.readScope ? bindReadScope(Doc.readScope, p) : null;
      let sqlResult = false;
      if (bound) {
        const sqlRow = db.prepare(`SELECT id FROM Doc AS t0 WHERE id = :id AND ${bound.sql}`).get({ id: rowId, ...bound.params });
        sqlResult = sqlRow !== undefined;
      }

      const entry = Doc.registry.owner;
      const runResult = entry?.run ? Boolean(entry.run({ entity: row, principal: p })) : false;

      scopes.push(sqlResult);
      runtimes.push(runResult);
    }
  }

  assert.deepStrictEqual(scopes, runtimes, 'SQL scope and runtime check must agree for every (row,principal)');
});

test('dual-face conformance: anyOf scope (published OR author)', async () => {
  const Doc = entity('Doc', {
    body: text(),
    published: boolean(),
    author: ref('User', { role: 'author' }),
    grant: () => [
      scope(({ is, fields }) => anyOf(
        fields.published.is(true),
        is.author(),
      )).can(async ({ is: _is }) => grant(read)),
    ],
  });

  for (const sql of generateDDL(Doc)) db.exec(sql);

  db.prepare(`INSERT INTO Doc (id, body, published, author) VALUES ('r1', 'a', 1, 'alice')`).run();
  db.prepare(`INSERT INTO Doc (id, body, published, author) VALUES ('r2', 'b', 1, 'bob')`).run();
  db.prepare(`INSERT INTO Doc (id, body, published, author) VALUES ('r3', 'c', 0, 'alice')`).run();
  db.prepare(`INSERT INTO Doc (id, body, published, author) VALUES ('r4', 'd', 0, 'bob')`).run();
  db.prepare(`INSERT INTO Doc (id, body, published, author) VALUES ('r5', 'e', 0, 'eve')`).run();

  const scopes = [];
  const runtimes = [];

  for (const rowId of ['r1', 'r2', 'r3', 'r4', 'r5']) {
    const row = db.prepare(`SELECT * FROM Doc AS t0 WHERE id = :id`).get({ id: rowId });
    for (const p of [principal({ type: 'user', id: 'alice' }), principal({ type: 'user', id: 'bob' }), anonymous]) {
      const bound = Doc.readScope ? bindReadScope(Doc.readScope, p) : null;
      let sqlResult = false;
      if (bound) {
        const sqlRow = db.prepare(`SELECT id FROM Doc AS t0 WHERE id = :id AND ${bound.sql}`).get({ id: rowId, ...bound.params });
        sqlResult = sqlRow !== undefined;
      }

      const published = Boolean(row.published);
      const author = Doc.registry.author?.run?.({ entity: row, principal: p }) ?? false;
      const runResult = Boolean(published) || Boolean(author);

      scopes.push(sqlResult);
      runtimes.push(runResult);
    }
  }

  assert.deepStrictEqual(scopes, runtimes, 'anyOf SQL scope and runtime must agree');
});

test('dual-face conformance: map-role check NOT in scope does not drift', async () => {
  const Doc = entity('Doc', {
    body: text(),
    owner: ref('User', { role: 'owner' }),
    collaborators: map(ref('User'), { role: ['editor'] }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });

  for (const sql of generateDDL(Doc)) db.exec(sql);

  db.prepare(`INSERT INTO Doc (id, body, owner) VALUES ('r1', 'a', 'alice')`).run();

  const row = db.prepare(`SELECT * FROM Doc AS t0 WHERE id = :id`).get({ id: 'r1' });
  const p = principal({ type: 'user', id: 'bob' });

  // The map-role 'editor' has NO harvest face — using is.editor() in scope must throw
  assert.throws(() => {
    Doc.registry.editor.harvest();
  }, /harvest|undefined|not a function/i, 'map-role check must not have a harvest face');

  // Insert a membership row so runtime check returns true
  db.prepare(`INSERT INTO Doc_collaborators (Doc_id, member_id, role) VALUES ('r1', 'bob', 'editor')`).run();

  // Runtime check passing: bob IS an editor
  const editorResult = Boolean(Doc.registry.editor.run({ entity: row, principal: p, runtime: { db } }));
  assert.equal(editorResult, true, 'bob should be an editor via runtime check');

  // Owner check: bob is NOT the owner
  const ownerResult = Boolean(Doc.registry.owner.run({ entity: row, principal: p, runtime: { db } }));
  assert.equal(ownerResult, false);

  // The scope DOES NOT consult map-role — only owner. So scope denies bob.
  const bound = bindReadScope(Doc.readScope, p);
  const sqlRow = db.prepare(`SELECT id FROM Doc AS t0 WHERE id = :id AND ${bound.sql}`).get({ id: 'r1', ...bound.params });
  assert.equal(sqlRow, undefined, 'scope should deny bob (not owner)');
});

test('dual-face conformance: inherit child scope', async () => {
  const Doc = entity('Doc', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is: _is }) => grant(read)),
    ],
  });

  for (const sql of generateDDL(Doc)) db.exec(sql);

  const parentEntity = { name: 'Doc', scopeAst: Doc.scopeAst, registry: Doc.registry, fields: { id: text(), owner: ref('User', { role: 'owner' }) }, grant: Doc.grant };
  const Comment = entity('Comment', {
    body: text(),
    doc: ref('Doc', { required: true }),
    grant: inherit(parentEntity, { via: 'doc' }),
  });

  for (const sql of generateDDL(Comment)) db.exec(sql);

  db.prepare(`INSERT INTO Doc (id, body, owner) VALUES ('d1', 'a', 'alice')`).run();
  db.prepare(`INSERT INTO Doc (id, body, owner) VALUES ('d2', 'b', 'bob')`).run();
  db.prepare(`INSERT INTO Comment (id, body, doc) VALUES ('c1', 'hi', 'd1')`).run();
  db.prepare(`INSERT INTO Comment (id, body, doc) VALUES ('c2', 'yo', 'd2')`).run();

  const scopes = [];
  const runtimes = [];

  for (const commentId of ['c1', 'c2']) {
    const row = db.prepare(`SELECT * FROM Comment WHERE id = :id`).get({ id: commentId });
    const p = principal({ type: 'user', id: 'alice' });

    const bound = bindReadScope(Comment.readScope, p);
    const sqlRow = db.prepare(`SELECT id FROM Comment AS t0 WHERE id = :id AND ${bound.sql}`).get({ id: commentId, ...bound.params });
    const sqlResult = sqlRow !== undefined;

    const parentRow = db.prepare(`SELECT * FROM Doc AS t0 WHERE id = :id`).get({ id: row.doc });
    const runResult = Boolean(Doc.registry.owner.run({ entity: parentRow, principal: p }));

    scopes.push(sqlResult);
    runtimes.push(runResult);
  }

  assert.deepStrictEqual(scopes, runtimes, 'inherit scope SQL and parent runtime check must agree');
});
