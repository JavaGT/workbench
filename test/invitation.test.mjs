// invitation.test.mjs — acceptance tests for the generic invitation flow.
//
// Proves: create (auto-token, link, direct), accept (link increments useCount +
// grants membership, direct removes row), reject (direct only), list, expiry,
// maxUses cap, wrong-user rejection, and full HTTP integration.

import workbench, {
  entity, ref, text, map, membership, read, Invitation, createInvitationApi,
} from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { principal } from '../build/principal.mjs';

const owner = principal({ type: 'user', id: 'owner-1' });
const member = principal({ type: 'user', id: 'member-1' });
const otherUser = principal({ type: 'user', id: 'other-1' });

// ---- Test helpers ----

// Set up a db with Invitation + Project tables for unit-level helper tests.
async function setupDb() {
  const db = new DatabaseSync(':memory:');
  const Project = entity('Project', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'], default: {} }),
  });
  membership(Project, { member: { can: [read] } });
  const app = workbench({ db, entities: [Project, Invitation] });
  await app.prepareSchema();
  for (const id of ['p1', 'p2', 'p3']) {
    db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)')
      .run(id, `Project ${id}`, owner.id);
  }
  app.listen(0);
  await app.ready;
  app.httpServer.unref();
  const closeDatabase = db.close.bind(db);
  Object.defineProperty(db, 'close', {
    configurable: true,
    value() {
      app.httpServer.close();
      closeDatabase();
    },
  });
  const Invitation_b = app.entity(Invitation);
  return {
    db,
    Project: app.entity(Project),
    Invitation: Invitation_b,
    ...createInvitationApi({ Invitation: Invitation_b }),
  };
}

// Set up a full workbench app with auth + Project entity for HTTP tests.
async function setupApp(t) {
  const db = new DatabaseSync(':memory:');

  const Project = entity('Project', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'], default: {} }),
  });

  membership(Project, { member: { can: [read] } });

  const app = workbench({ db, entities: [Project] });
  app.mount('/projects', Project);
  app.auth();

  await app.prepareSchema();
  for (const id of ['p1', 'p2', 'p3']) {
    db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)')
      .run(id, `Test Project ${id}`, owner.id);
  }

  app.listen(0, {
    principalOf: (req) => {
      // Read user identity from a custom header for test control
      const id = req.headers?.['x-test-user'];
      if (!id) return principal({ type: 'anonymous', id: null });
      return principal({ type: 'user', id });
    },
  });
  await app.ready;

  t.after(() => {
    app.httpServer.close();
    db.close();
  });

  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}`, db, app, Project: app.entity(Project) };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = body; }
  return { status: res.status, body: json };
}

// ---- Unit tests (helpers without HTTP) ----

test('create invitation with auto-generated token', async () => {
  const { db, Invitation, createInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      maxUses: 10,
      principal: owner,
    });

    assert.ok(inv, 'invitation created');
    assert.equal(typeof inv.token, 'string', 'token is a string');
    assert.ok(inv.token.length >= 32, 'token is at least 32 chars (base64url of 32 bytes)');
    assert.equal(inv.targetEntity, 'Project');
    assert.equal(inv.targetId, 'p1');
    assert.equal(inv.role, 'member');
    assert.equal(inv.targetUser, null, 'targetUser is null for link invite');
    assert.equal(inv.maxUses, 10);
    assert.equal(inv.useCount, 0);
    assert.equal(inv.expiresAt, null);
    assert.equal(inv.createdBy, 'owner-1');
    assert.ok(inv.createdAt, 'createdAt is set');

    // Can find it by token
    const found = Invitation.findOne(Invitation.token.is(inv.token));
    assert.ok(found, 'can find invitation by token');
    assert.equal(found.id, inv.id);

    const logRows = db.prepare(`
      SELECT actionId, eventType
      FROM _Log
      ORDER BY seq
    `).all();
    assert.deepEqual(logRows.map((row) => row.eventType), ['Invitation.created']);
    assert.equal(logRows[0].actionId.length > 0, true, 'creation has a durable action id');
  } finally {
    db.close();
  }
});

// #247: a Date in the batch action payload used to make canonicalStringify
// throw while writing the committed-log receipt, so createInvitation never
// succeeded. Prove the whole path now works: action → receipt → projection →
// stored row, with a JSON-safe ISO createdAt.
test('#247: createInvitation succeeds through the real committed-log pipeline', async () => {
  const { db, createInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      principal: owner,
    });

    // The committed event projected a real stored row.
    const stored = db.prepare('SELECT * FROM Invitation WHERE id = ?').get(inv.id);
    assert.ok(stored, 'invitation row was written by the committed-log projection');
    assert.equal(stored.token, inv.token);

    // createdAt is a JSON-safe ISO string, not a Date: on the returned row,
    // in storage, and in the persisted action payload.
    assert.equal(typeof inv.createdAt, 'string');
    assert.equal(typeof stored.createdAt, 'string');
    assert.equal(stored.createdAt, new Date(stored.createdAt).toISOString());

    // The committed-log receipt was written for the action, and its actionData
    // is plain JSON (canonicalStringify did not reject a non-JSON-safe value).
    const receipts = db.prepare('SELECT actionId, actionType, actionData FROM _ActionReceipt').all();
    assert.ok(receipts.length > 0, 'a committed-log receipt exists');
    const receipt = receipts.find((row) => String(row.actionData).includes(inv.token));
    assert.ok(receipt, 'the create action has a committed-log receipt');
    assert.ok(receipt.actionId, 'the receipt is bound to a durable action id');
    const actions = JSON.parse(receipt.actionData);
    assert.equal(actions[0].type, 'Invitation.create');
    assert.equal(typeof actions[0].payload.createdAt, 'string');
    assert.equal(actions[0].payload.createdAt, new Date(actions[0].payload.createdAt).toISOString());
  } finally {
    db.close();
  }
});

test('create link-type invitation (no targetUser)', async () => {
  const { db, createInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      principal: owner,
    });

    assert.equal(inv.targetUser, null, 'targetUser is null for link invite');
    assert.equal(inv.maxUses, null, 'maxUses defaults to null (unlimited)');
  } finally {
    db.close();
  }
});

test('create direct invitation (with targetUser)', async () => {
  const { db, createInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
      principal: owner,
    });

    assert.equal(inv.targetUser, 'member-1', 'targetUser is set');
    assert.equal(inv.maxUses, null);
  } finally {
    db.close();
  }
});

test('accept link invitation → increments useCount, grants membership', async () => {
  const { db, Invitation, createInvitation, acceptInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      maxUses: 10,
      principal: owner,
    });

    const result = await acceptInvitation(inv.token, member);

    assert.deepEqual(result, {
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
    });

    // useCount incremented
    const updated = Invitation.findOne(Invitation.token.is(inv.token));
    assert.equal(updated.useCount, 1, 'useCount incremented');

    // Membership row inserted
    const memberRow = db.prepare('SELECT * FROM Project_members WHERE Project_id = ? AND member_id = ?')
      .get('p1', 'member-1');
    assert.ok(memberRow, 'membership row exists');
    assert.equal(memberRow.role, 'member');
  } finally {
    db.close();
  }
});

test('acceptance records membership and invitation lifecycle events in one composed commit', async () => {
  const { db, Invitation, createInvitation, acceptInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      maxUses: 2,
      principal: owner,
    });

    const before = db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count;
    await acceptInvitation(inv.token, member);
    const rows = db.prepare(`
      SELECT actionId, eventType
      FROM _Log
      ORDER BY rowid
      LIMIT -1 OFFSET :before
    `).all({ before });

    assert.deepEqual(rows.map((row) => row.eventType), [
      'Project.members.added',
      'Invitation.updated',
    ]);
    assert.equal(new Set(rows.map((row) => row.actionId)).size, 1);
    assert.equal(Invitation.findOne(Invitation.token.is(inv.token)).useCount, 1);
  } finally {
    db.close();
  }
});

test('accept link invitation → same user twice is idempotent', async () => {
  const { db, Invitation, createInvitation, acceptInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      maxUses: 10,
      principal: owner,
    });

    await acceptInvitation(inv.token, member);

    // Second accept — still works (idempotent membership insert)
    const result = await acceptInvitation(inv.token, member);
    assert.deepEqual(result, { targetEntity: 'Project', targetId: 'p1', role: 'member' });

    const updated = Invitation.findOne(Invitation.token.is(inv.token));
    assert.equal(updated.useCount, 1, 'idempotent replay does not consume another use');
  } finally {
    db.close();
  }
});

test('accept direct invitation → removes invitation row', async () => {
  const { db, Invitation, createInvitation, acceptInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
      principal: owner,
    });

    const result = await acceptInvitation(inv.token, member);

    assert.deepEqual(result, { targetEntity: 'Project', targetId: 'p1', role: 'member' });

    // Invitation row is removed
    const gone = Invitation.findOne(Invitation.token.is(inv.token));
    assert.equal(gone, null, 'direct invitation removed on accept');

    // Membership row inserted
    const memberRow = db.prepare('SELECT * FROM Project_members WHERE Project_id = ? AND member_id = ?')
      .get('p1', 'member-1');
    assert.ok(memberRow, 'membership row exists');
  } finally {
    db.close();
  }
});

test('link invitation reaches maxUses → accept fails with 400', async () => {
  const { db, createInvitation, acceptInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      maxUses: 2,
      principal: owner,
    });

    await acceptInvitation(inv.token, principal({ type: 'user', id: 'u1' }));
    await acceptInvitation(inv.token, principal({ type: 'user', id: 'u2' }));

    // Third accept should fail
    await assert.rejects(
      acceptInvitation(inv.token, principal({ type: 'user', id: 'u3' })),
      (err) => err.message.includes('maximum uses') && err.status === 400,
    );
  } finally {
    db.close();
  }
});

test('expired invitation → accept fails with 400', async () => {
  const { db, createInvitation, acceptInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      expiresAt: Date.now() - 1000, // 1 second in the past
      principal: owner,
    });

    await assert.rejects(
      acceptInvitation(inv.token, member),
      (err) => err.message.includes('expired') && err.status === 400,
    );
  } finally {
    db.close();
  }
});

test('reject direct invitation → removes row', async () => {
  const { db, Invitation, createInvitation, rejectInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
      principal: owner,
    });

    const before = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM _Log').get().seq;
    await rejectInvitation(inv.token, member);

    const gone = Invitation.findOne(Invitation.token.is(inv.token));
    assert.equal(gone, null, 'invitation removed on reject');
    const rows = db.prepare(`
      SELECT eventType
      FROM _Log
      WHERE seq > :before
      ORDER BY seq
    `).all({ before });
    assert.deepEqual(rows.map((row) => row.eventType), ['Invitation.removed']);
  } finally {
    db.close();
  }
});

test('reject direct invitation → wrong user fails with 403', async () => {
  const { db, Invitation, createInvitation, rejectInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
      principal: owner,
    });

    await assert.rejects(
      rejectInvitation(inv.token, otherUser),
      (err) => err.message.includes('different user') && err.status === 403,
    );

    // Invitation still exists
    const still = Invitation.findOne(Invitation.token.is(inv.token));
    assert.ok(still, 'invitation still exists after failed reject');
  } finally {
    db.close();
  }
});

test('cannot reject open link invitation', async () => {
  const { db, createInvitation, rejectInvitation } = await setupDb();
  try {
    const inv = await createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      principal: owner,
    });

    await assert.rejects(
      rejectInvitation(inv.token, member),
      (err) => err.message.includes('cannot reject an open link invitation') && err.status === 400,
    );
  } finally {
    db.close();
  }
});

test('list invitations for user — direct invites', async () => {
  const { db, createInvitation, listInvitationsForUser } = await setupDb();
  try {
    const inv1 = await createInvitation({
      targetEntity: 'Project', targetId: 'p1', role: 'member',
      targetUser: 'member-1', principal: owner,
    });
    const inv2 = await createInvitation({
      targetEntity: 'Project', targetId: 'p2', role: 'member',
      targetUser: 'member-1', principal: owner,
    });
    // Another user's invite — should NOT appear for member-1
    await createInvitation({
      targetEntity: 'Project', targetId: 'p3', role: 'member',
      targetUser: 'other-1', principal: owner,
    });

    const list = listInvitationsForUser(member);
    assert.equal(list.length, 2, 'only member-1 invites returned');
    const tokens = list.map((r) => r.token);
    assert.ok(tokens.includes(inv1.token));
    assert.ok(tokens.includes(inv2.token));
  } finally {
    db.close();
  }
});

test('list invitations for user — hides open link tokens', async () => {
  const { db, createInvitation, listInvitationsForUser } = await setupDb();
  try {
    const linkInv = await createInvitation({
      targetEntity: 'Project', targetId: 'p1', role: 'member',
      principal: owner,
    });
    const directInv = await createInvitation({
      targetEntity: 'Project', targetId: 'p2', role: 'member',
      targetUser: 'member-1', principal: owner,
    });

    const list = listInvitationsForUser(member);
    assert.equal(list.length, 1, 'only the direct invitation is visible');
    const tokens = list.map((r) => r.token);
    assert.ok(!tokens.includes(linkInv.token), 'does not disclose an open-link secret');
    assert.ok(tokens.includes(directInv.token), 'includes direct invite');
  } finally {
    db.close();
  }
});

test('list invitations excludes expired ones', async () => {
  const { db, createInvitation, listInvitationsForUser } = await setupDb();
  try {
    await createInvitation({
      targetEntity: 'Project', targetId: 'p1', role: 'member',
      targetUser: 'member-1', expiresAt: Date.now() - 1000, principal: owner,
    });
    const valid = await createInvitation({
      targetEntity: 'Project', targetId: 'p2', role: 'member',
      targetUser: 'member-1', principal: owner,
    });

    const list = listInvitationsForUser(member);
    assert.equal(list.length, 1, 'only non-expired invite returned');
    assert.equal(list[0].token, valid.token);
  } finally {
    db.close();
  }
});

test('acceptInvitation with nonexistent token → 404', async () => {
  const { db, acceptInvitation } = await setupDb();
  try {
    await assert.rejects(
      acceptInvitation('nonexistent-token', member),
      (err) => err.message.includes('not found') && err.status === 404,
    );
  } finally {
    db.close();
  }
});

// ---- HTTP integration tests ----

test('HTTP: create invitation + accept + verify membership', async (t) => {
  const { origin, db } = await setupApp(t);

  // Create an invitation as owner-1
  const createRes = await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({ targetEntity: 'Project', targetId: 'p1', role: 'member', maxUses: 5 }),
  });
  assert.equal(createRes.status, 201);
  const token = createRes.body.token;
  assert.ok(token, 'token returned');

  // Accept as member-1
  const acceptRes = await fetchJson(`${origin}/auth/invitation/${token}/accept`, {
    method: 'POST',
    headers: { 'x-test-user': 'member-1' },
  });
  assert.equal(acceptRes.status, 200);
  assert.deepEqual(acceptRes.body, {
    targetEntity: 'Project',
    targetId: 'p1',
    role: 'member',
  });

  // Verify membership row exists in DB
  const memberRow = db.prepare('SELECT * FROM Project_members WHERE Project_id = ? AND member_id = ?')
    .get('p1', 'member-1');
  assert.ok(memberRow, 'membership row created');
  assert.equal(memberRow.role, 'member');
});

test('HTTP: accept by wrong user for direct invite → 403', async (t) => {
  const { origin, db } = await setupApp(t);

  // Create a direct invitation for member-1
  const createRes = await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
    }),
  });
  assert.equal(createRes.status, 201);
  const token = createRes.body.token;

  // Try to accept as other-1 (wrong user)
  const acceptRes = await fetchJson(`${origin}/auth/invitation/${token}/accept`, {
    method: 'POST',
    headers: { 'x-test-user': 'other-1' },
  });
  assert.equal(acceptRes.status, 403);
});

test('HTTP: reject direct invitation → 204', async (t) => {
  const { origin } = await setupApp(t);

  const createRes = await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
    }),
  });
  assert.equal(createRes.status, 201);
  const token = createRes.body.token;

  const rejectRes = await fetchJson(`${origin}/auth/invitation/${token}/reject`, {
    method: 'POST',
    headers: { 'x-test-user': 'member-1' },
  });
  assert.equal(rejectRes.status, 204);
});

test('HTTP: list invitations for user', async (t) => {
  const { origin } = await setupApp(t);

  // Create some invitations for member-1
  await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({
      targetEntity: 'Project', targetId: 'p1', role: 'member',
      targetUser: 'member-1',
    }),
  });
  await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({
      targetEntity: 'Project', targetId: 'p2', role: 'member',
      targetUser: 'member-1',
    }),
  });

  const listRes = await fetchJson(`${origin}/auth/invitation`, {
    headers: { 'x-test-user': 'member-1' },
  });
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body), 'returns an array');
  assert.ok(listRes.body.length >= 2, 'at least 2 invitations');
  for (const inv of listRes.body) {
    assert.equal(inv.targetUser, 'member-1', 'each invite is for member-1');
  }
});

test('HTTP: create invitation without required fields → 400', async (t) => {
  const { origin } = await setupApp(t);

  const res = await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({ targetEntity: 'Project' }),
  });
  assert.equal(res.status, 400);
});

test('HTTP: unauthenticated requests are denied (requireUser gate)', async (t) => {
  const { origin } = await setupApp(t);

  // No x-test-user header → anonymous
  const res = await fetchJson(`${origin}/auth/invitation`, {
    headers: { 'content-type': 'application/json' },
  });
  assert.ok(res.status === 401 || res.status === 403, `unauthenticated should be denied, got ${res.status}`);
});
