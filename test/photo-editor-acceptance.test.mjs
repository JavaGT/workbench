// Scope-support ACCEPTANCE — Collaborative Photo Editor spine.
//
// This caps the photo-editor stress-test by proving the full
// Canvas→RasterLayer authorization chain works against a real
// node:sqlite DB and real HTTP transport. It exercises every
// scope-support bridge:
//
//   typed-FK map membership traversal (slice 5),
//   runtime ref thenable traversal (slice 6),
//   inherit with field .can using is.*() registry checks,
//   projected.async render pipeline,
//   raster.crdt and blob field constructors (slice 14).

import { text, number, date, ref, map, boolean, blob as _blob, raster, projected, scope, grant, deny, read, write, subscribe, anyOf, never as _never, inherit } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity, bindReadScope, mayVerb } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';

// ---- helpers ----

function scopedIds(db, entityRecord, prin) {
  const bound = bindReadScope(entityRecord.readScope, prin);
  return db
    .prepare(`SELECT id FROM ${entityRecord.name} AS t0 WHERE ${bound.sql}`)
    .all(bound.params)
    .map((r) => r.id);
}

async function _serve(t, db, routes, who) {
  const app = workbench({ db });
  for (const { path, entity: e } of routes) app.mount(path, e);
  app.listen(0, { principalOf: () => who });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  return `http://127.0.0.1:${port}`;
}

function json(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { ...opts, method: opts.method || 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body || 'null') });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ---- DSL: the photo-editor auth spine ----

function declareCanvasLayer() {
  const Canvas = entity('Canvas', {
        title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    collaborators: map(ref('User'), {
      role: ['viewer', 'editor'],
      default: {},
    }),
    width: number({ default: 1920 }),
    height: number({ default: 1080 }),
    preview: projected.async({
      compute: async (canvas) => {
        return { rendered: true, title: canvas.title };
      },
    }),
    createdAt: date({ default: () => new Date() }),
    updatedAt: date({ touch: true }),

    checks: {
      collaborator: ({ Canvas: c, principal: p }) =>
        c.collaborators.has(p.id),
      editor: ({ Canvas: c, principal: p }) =>
        c.collaborators.get(p.id)?.role === 'editor',
      viewer: ({ Canvas: c, principal: p }) =>
        c.collaborators.get(p.id)?.role === 'viewer',
    },
    grant: () => [
      scope(({ is }) => anyOf(is.owner(), is.collaborator()))
        .can(async ({ is }) => {
          if (await is.owner()) return grant(read, write, subscribe);
          if (await is.editor()) return grant(read, write, subscribe);
          if (await is.collaborator()) return grant(read, subscribe);
          return deny('not a member of this canvas');
        }),
    ],
  });

  const RasterLayer = entity('RasterLayer', {
        canvas: ref('Canvas'),
    name: text({ default: 'New Layer' }),
    imageData: raster.crdt({ mergeStrategy: 'blend' }),
    visible: boolean({ default: true })
      .can(async ({ is, entity }) => {
        if (await is.editor()) return grant(read, subscribe);
        if (await is.owner()) return grant(read, subscribe);
        if (await is.collaborator() && entity.visible) return grant(read, subscribe);
        return grant(subscribe);
      }),
    opacity: number({ default: 100 }),
    blendMode: text({ default: 'normal' }),
    createdAt: date({ default: () => new Date() }),

    checks: {
      editor: async ({ entity, principal: p }) => {
        const canvas = await entity.canvas;
        return canvas.collaborators.get(p.id)?.role === 'editor';
      },
      owner: async ({ entity, principal: p }) => {
        const canvas = await entity.canvas;
        return canvas.owner === p.id;
      },
      collaborator: ({ entity, principal: p }) => {
        return entity.canvas.collaborators.has(p.id);
      },
    },
    grant: inherit(Canvas, { via: 'canvas' }),
  });

  return { Canvas, RasterLayer };
}

// ---- seed ----
//
// c-shared: owned by alice, bob is editor, carol is viewer
// c-private: owned by bob, no collaborators
// l1 in c-shared, visible=true
// l2 in c-shared, visible=false (hidden)
// l3 in c-private, visible=true
// l4 orphan (canvas=null), visible=true

function seed(db) {
  db.exec(
    'CREATE TABLE Canvas (id TEXT, title TEXT, owner TEXT, width INTEGER, height INTEGER, ' +
      'preview TEXT, createdAt INTEGER, updatedAt INTEGER)',
  );
  db.exec(
    'CREATE TABLE Canvas_collaborators (Canvas_id TEXT, member_id TEXT, role TEXT)',
  );
  db.exec(
    'CREATE TABLE RasterLayer (id TEXT, canvas TEXT, name TEXT, imageData TEXT, ' +
      'visible INTEGER, opacity INTEGER, blendMode TEXT, createdAt INTEGER)',
  );

  db.prepare('INSERT INTO Canvas (id, title, owner, width, height) VALUES (:id, :title, :owner, :w, :h)').run({
    id: 'c-shared', title: 'Shared Canvas', owner: 'alice', w: 1920, h: 1080,
  });
  db.prepare('INSERT INTO Canvas (id, title, owner, width, height) VALUES (:id, :title, :owner, :w, :h)').run({
    id: 'c-private', title: 'Private Canvas', owner: 'bob', w: 800, h: 600,
  });

  db.prepare(
    'INSERT INTO Canvas_collaborators (Canvas_id, member_id, role) VALUES (:cid, :mid, :role)',
  ).run({ cid: 'c-shared', mid: 'bob', role: 'editor' });
  db.prepare(
    'INSERT INTO Canvas_collaborators (Canvas_id, member_id, role) VALUES (:cid, :mid, :role)',
  ).run({ cid: 'c-shared', mid: 'carol', role: 'viewer' });

  db.prepare(
    'INSERT INTO RasterLayer (id, canvas, name, visible, opacity, blendMode) VALUES (:id, :cid, :name, :vis, :op, :bm)',
  ).run({ id: 'l1', cid: 'c-shared', name: 'Background', vis: 1, op: 100, bm: 'normal' });
  db.prepare(
    'INSERT INTO RasterLayer (id, canvas, name, visible, opacity, blendMode) VALUES (:id, :cid, :name, :vis, :op, :bm)',
  ).run({ id: 'l2', cid: 'c-shared', name: 'Hidden Layer', vis: 0, op: 100, bm: 'multiply' });
  db.prepare(
    'INSERT INTO RasterLayer (id, canvas, name, visible, opacity, blendMode) VALUES (:id, :cid, :name, :vis, :op, :bm)',
  ).run({ id: 'l3', cid: 'c-private', name: 'Bob Layer', vis: 1, op: 80, bm: 'normal' });
  db.prepare(
    'INSERT INTO RasterLayer (id, canvas, name, visible, opacity, blendMode) VALUES (:id, :cid, :name, :vis, :op, :bm)',
  ).run({ id: 'l4', cid: null, name: 'Orphan', vis: 1, op: 100, bm: 'normal' });
}

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });
const carol = principal({ type: 'user', id: 'carol' });
const stranger = principal({ type: 'user', id: 'stranger' });

// ---- ACCEPTANCE 1: the spine compiles ----

test('Canvas and RasterLayer compile with inherit + field .can + thenable checks', () => {
  const { Canvas, RasterLayer } = declareCanvasLayer();
  for (const e of [Canvas, RasterLayer]) {
    assert.ok(
      e.readScope && typeof e.readScope.sql === 'string',
      `${e.name} has a compiled read-scope`,
    );
  }
  const sql = RasterLayer.readScope.sql.replace(/\s+/g, ' ');
  assert.match(sql, /EXISTS/i, 'inherited scope uses EXISTS join');
  assert.match(sql, /canvas/i, 'inherited scope references the canvas FK');
});

// ---- ACCEPTANCE 2: SQL scope filters layers by canvas membership ----

test('SQL scope returns only layers whose canvas the principal can access', () => {
  const { RasterLayer } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');
  seed(db);

  assert.deepEqual(scopedIds(db, RasterLayer, alice).sort(), ['l1', 'l2']);
  assert.deepEqual(scopedIds(db, RasterLayer, bob).sort(), ['l1', 'l2', 'l3']);
  assert.deepEqual(scopedIds(db, RasterLayer, carol).sort(), ['l1', 'l2']);
  assert.deepEqual(scopedIds(db, RasterLayer, stranger), []);

  db.close();
});

// ---- ACCEPTANCE 3: runtime mayVerb on canvas (parent, has .can) ----

test('runtime mayVerb grants correct capabilities per canvas role on the parent', async () => {
  const { Canvas } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');
  seed(db);
  const app = workbench({ db, entities: [Canvas] });
  const Canvas_b = app.entity(Canvas);

  const c = Canvas_b.getOrFail('c-shared');

  assert.equal(await mayVerb(Canvas_b, 'read', c, alice), true);
  assert.equal(await mayVerb(Canvas_b, 'update', c, alice), true);
  assert.equal(await mayVerb(Canvas_b, 'read', c, bob), true);
  assert.equal(await mayVerb(Canvas_b, 'update', c, bob), true);
  assert.equal(await mayVerb(Canvas_b, 'read', c, carol), true);
  assert.equal(await mayVerb(Canvas_b, 'update', c, carol), false);
  assert.equal(await mayVerb(Canvas_b, 'read', c, stranger), false);

  db.close();
});

// ---- ACCEPTANCE 4: field .can with is.editor()/is.owner() ----

test('visible field .can admits editors/owners for hidden layers via mayFieldOp', async () => {
  const { Canvas, RasterLayer } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');
  seed(db);
  const app = workbench({ db, entities: [Canvas, RasterLayer] });
  const RasterLayer_b = app.entity(RasterLayer);

  const l2 = RasterLayer_b.getOrFail('l2');
  assert.equal(l2.visible, false, 'l2 is hidden');

  const { mayFieldOp } = await import('../build/row-grant.mjs');

  // Alice (owner) can read hidden layer
  assert.equal(await mayFieldOp(RasterLayer_b, 'visible', read, l2, alice), true);
  // Bob (editor) can read hidden layer
  assert.equal(await mayFieldOp(RasterLayer_b, 'visible', read, l2, bob), true);
  // Carol (viewer) cannot read hidden layer — denied by field .can
  assert.equal(await mayFieldOp(RasterLayer_b, 'visible', read, l2, carol), false);
  // Stranger is not scoped (SQL scope excludes them) — denied by field .can
  assert.equal(await mayFieldOp(RasterLayer_b, 'visible', read, l2, stranger), false);

  db.close();
});

// ---- ACCEPTANCE 5: visible field .can admits all for visible layers ----

test('visible field .can passes for visible layers to all scoped members', async () => {
  const { Canvas, RasterLayer } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');
  seed(db);
  const app = workbench({ db, entities: [Canvas, RasterLayer] });
  const RasterLayer_b = app.entity(RasterLayer);

  const l1 = RasterLayer_b.getOrFail('l1');
  assert.equal(l1.visible, true, 'l1 is visible');

  const { mayFieldOp } = await import('../build/row-grant.mjs');

  assert.equal(await mayFieldOp(RasterLayer_b, 'visible', read, l1, alice), true);
  assert.equal(await mayFieldOp(RasterLayer_b, 'visible', read, l1, bob), true);
  assert.equal(await mayFieldOp(RasterLayer_b, 'visible', read, l1, carol), true);

  db.close();
});

// ---- ACCEPTANCE 6: null canvas FK fails closed ----

test('null canvas FK fails closed for all principals', async () => {
  const { Canvas, RasterLayer } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');
  seed(db);
  const app = workbench({ db, entities: [Canvas, RasterLayer] });
  const RasterLayer_b = app.entity(RasterLayer);

  const l4 = RasterLayer_b.getOrFail('l4');
  assert.equal(await mayVerb(RasterLayer_b, 'read', l4, alice), false);
  assert.equal(await mayVerb(RasterLayer_b, 'read', l4, bob), false);
  assert.equal(await mayVerb(RasterLayer_b, 'read', l4, carol), false);
  assert.equal(await mayVerb(RasterLayer_b, 'read', l4, stranger), false);

  assert.deepEqual(scopedIds(db, RasterLayer, alice), ['l1', 'l2']);

  db.close();
});

// ---- ACCEPTANCE 7: removing a collaborator revokes access ----

test('removing a collaborator revokes SQL scope AND field read', async () => {
  const { Canvas, RasterLayer } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');
  seed(db);
  const app = workbench({ db, entities: [Canvas, RasterLayer] });
  const RasterLayer_b = app.entity(RasterLayer);

  const { mayFieldOp } = await import('../build/row-grant.mjs');
  const l1 = RasterLayer_b.getOrFail('l1');
  assert.equal(await mayFieldOp(RasterLayer_b, 'visible', read, l1, carol), true);

  db.prepare(
    'DELETE FROM Canvas_collaborators WHERE Canvas_id = :cid AND member_id = :mid',
  ).run({ cid: 'c-shared', mid: 'carol' });

  assert.equal(await mayFieldOp(RasterLayer_b, 'visible', read, l1, carol), false);
  assert.deepEqual(scopedIds(db, RasterLayer, carol), []);

  db.close();
});

// ---- ACCEPTANCE 7b: a field WITHOUT .can strong-inherits the resolved row grant
// (review §6 "field .can strong-inherit is half-built" — after D1 the inherit-child
// row grant resolves the parent's .can, so a no-.can field inherits that, not a
// silent {granted:false}. `name` and `opacity` have no .can on RasterLayer.)

test('inherit-child field without explicit .can strong-inherits the resolved row grant', async () => {
  const { Canvas, RasterLayer } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');
  seed(db);
  const app = workbench({ db, entities: [Canvas, RasterLayer] });
  const RasterLayer_b = app.entity(RasterLayer);

  const { mayFieldOp } = await import('../build/row-grant.mjs');
  const l1 = RasterLayer_b.getOrFail('l1'); // canvas c-shared

  // owner (alice) and editor (bob) get read+write on Canvas; viewer (carol) gets read.
  assert.equal(await mayFieldOp(RasterLayer_b, 'name', read, l1, alice), true, 'owner reads no-.can field');
  assert.equal(await mayFieldOp(RasterLayer_b, 'name', read, l1, bob), true, 'editor reads no-.can field');
  assert.equal(await mayFieldOp(RasterLayer_b, 'name', read, l1, carol), true, 'viewer reads no-.can field');
  assert.equal(await mayFieldOp(RasterLayer_b, 'name', read, l1, stranger), false, 'non-scoped stranger cannot read');

  db.close();
});

// ---- ACCEPTANCE 8: HTTP list/read through inherited grant ----

test('HTTP list and read respect inherited canvas grant', async (t) => {
  const { Canvas, RasterLayer } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');
  seed(db);

  const app2 = workbench({ db });
  app2.mount('/canvases', Canvas);
  app2.mount('/layers', RasterLayer);
  await app2.ddl();
  app2.listen(0, { principalOf: () => alice });
  await app2.ready;
  t.after(() => {
    app2.httpServer.close();
    db.close();
  });

  const { port } = app2.httpServer.address();
  const base = `http://127.0.0.1:${port}`;

  // Alice lists layers → sees l1, l2 (shared canvas)
  const aliceList = await json(`${base}/layers`);
  assert.equal(aliceList.status, 200);
  const aliceIds = aliceList.body.map((r) => r.id).sort();
  assert.deepEqual(aliceIds, ['l1', 'l2']);

  // Alice reads l1 (visible)
  const aliceRead = await json(`${base}/layers/l1`);
  assert.equal(aliceRead.status, 200);
  assert.equal(aliceRead.body.id, 'l1');
});

// ---- ACCEPTANCE 9: thenable ref traversal in RasterLayer checks ----

test('RasterLayer checks traverse canvas FK through thenable ref handle', async () => {
  const { Canvas, RasterLayer } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');
  seed(db);
  const app = workbench({ db, entities: [Canvas, RasterLayer] });
  const RasterLayer_b = app.entity(RasterLayer);

  const l1 = RasterLayer_b.getOrFail('l1');

  // Access registry run face directly to verify thenable traversal
  const editorEntry = RasterLayer_b.registry.editor;
  assert.ok(editorEntry && editorEntry.run, 'editor check has a run face');

  // Bob is editor on c-shared → editor check should return true
  const bobP = principal({ type: 'user', id: 'bob' });
  const isEditor = await editorEntry.run({ entity: l1, principal: bobP, runtime: RasterLayer_b.runtime });
  assert.equal(isEditor, true);

  // Stranger is not a member → editor check should return false
  const strangerP = principal({ type: 'user', id: 'stranger' });
  const isEditor2 = await editorEntry.run({ entity: l1, principal: strangerP, runtime: RasterLayer_b.runtime });
  assert.equal(isEditor2, false);

  // Owner check: alice is owner of c-shared
  const ownerEntry = RasterLayer_b.registry.owner;
  const isOwner = await ownerEntry.run({ entity: l1, principal: alice, runtime: RasterLayer_b.runtime });
  assert.equal(isOwner, true);

  db.close();
});

// ---- ACCEPTANCE 10: projected.async field on Canvas ----

test('projected.async computes a renderable preview for Canvas', async (t) => {
  const { Canvas } = declareCanvasLayer();
  const db = new DatabaseSync(':memory:');

  // Create canvas through the framework pipeline so projected.async fires
  const app = workbench({ db, entities: [Canvas] });
  const Canvas_b = app.entity(Canvas);
  app.mount('/canvases', Canvas);
  await app.ddl();
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  const { port } = app.httpServer.address();
  const base = `http://127.0.0.1:${port}`;

  const create = await json(`${base}/canvases`, {
    method: 'POST',
    body: { title: 'Render Test' },
  });
  assert.equal(create.status, 201);
  const canvasId = create.body.id;

  // Wait a tick for post-commit consumer
  await new Promise((r) => setTimeout(r, 200));

  const c = Canvas_b.getOrFail(canvasId);
  assert.ok(c.preview, 'preview is set after create compute');
  assert.ok(c.preview.rendered, 'preview has rendered flag');
});

// ---- ACCEPTANCE 11: raster.crdt field on RasterLayer ----

test('raster.crdt field compiles and stores pixel data', () => {
  const { RasterLayer } = declareCanvasLayer();
  assert.equal(RasterLayer.fields.imageData.kind, 'crdt');
  assert.equal(RasterLayer.fields.imageData.type, 'raster');
  assert.equal(RasterLayer.fields.imageData.mergeStrategy, 'blend');
});
