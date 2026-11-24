// w3-auth-coat-hardening.test.mjs — focused regression tests for the W3 lane
// "auth coat and write authority":
//   1. Invitation authorities are real principals (principal()/collapseForAdmission)
//      and roles are validated against declared membership roles (fail closed).
//   2. Session duration default and session-row lookup have ONE authority.
//   3. Authenticated HTTP workers carry a typed machinePrincipal; the job wire
//      protocol is unchanged, and handler runs have an optional timeout bound.
//
// These are focused unit + HTTP tests. Run with:
//   node --test --test-timeout=15000 test/w3-auth-coat-hardening.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { principal, anonymous } from '../build/principal.mjs';
import { EventKind } from '../build/event-handle.mjs';
import { config } from '../build/config.mjs';
import workbench from '../build/app.mjs';
import { entity, text, map, ref, membership, read } from '../build/index.mjs';
import { Invitation, User, Session, Credential, ApiKey, TwoFactor } from '../build/auth/entities.mjs';
import { authRoutes } from '../build/auth/routes.mjs';
import {
  DEFAULT_SESSION_DURATION_MS,
  sessionRowResolver,
  sessionPrincipalOf,
  hashSessionToken,
  SESSION_COOKIE,
} from '../build/auth/session.mjs';
import {
  isDeclaredInvitationRole,
  invitationAcceptancePrincipal,
  authorizeInvitationAcceptance,
  admitInvitationAcceptance,
  admitsInvitationRemoval,
} from '../build/auth/invitation-acceptance-authority.mjs';
import { createInvitationApi } from '../build/auth/invitation.mjs';
import { isMachinePrincipal, machinePrincipal } from '../build/machine-principal.mjs';
import { workerMachinePrincipal } from '../build/http-framework-routes.mjs';
import { openSqliteDatabase } from '../build/sqlite-driver.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createJobQueue } from '../build/job-queue.mjs';

// =============================================================================
// 1. Invitation authority hardening
// =============================================================================

test('invitation acceptance authority is a real principal, built through the one constructor', () => {
  const active = principal({ type: 'user', id: 'w3-user-1', attributes: { team: 'core' } });
  const authority = invitationAcceptancePrincipal(active);

  assert.ok(authority, 'an active user yields an authority');
  assert.equal(authority.type, 'user');
  assert.equal(authority.id, 'w3-user-1');
  assert.equal(authority.status, 'active');
  assert.deepEqual(authority.attributes, { team: 'core' });
  assert.ok(Object.isFrozen(authority), 'the minted authority is frozen');
  assert.notEqual(authority, active, 'the authority is its own per-request brand');

  // Non-active and non-user identities collapse / fail closed to no authority.
  assert.equal(invitationAcceptancePrincipal(principal({ type: 'user', id: 'revoked', status: 'revoked' })), null);
  assert.equal(invitationAcceptancePrincipal(principal({ type: 'user', id: 'disabled', status: 'disabled' })), null);
  assert.equal(invitationAcceptancePrincipal(anonymous), null);
  assert.equal(invitationAcceptancePrincipal(principal({ type: 'apiKey', id: 'key-1' })), null);
  assert.equal(invitationAcceptancePrincipal(null), null);
  assert.equal(invitationAcceptancePrincipal({ type: 'user' }), null);
});

test('invitation roles are allowlisted against declared membership roles', () => {
  assert.equal(isDeclaredInvitationRole('member', ['member', 'viewer']), true);
  for (const bad of ['', 'administrator', undefined, null, 7, {}]) {
    assert.equal(isDeclaredInvitationRole(bad, ['member', 'viewer']), false, `role ${String(bad)} must fail closed`);
  }
  assert.equal(isDeclaredInvitationRole('member', []), false);
  assert.equal(isDeclaredInvitationRole('member', null), false);

  const authority = invitationAcceptancePrincipal(principal({ type: 'user', id: 'w3-user-2' }));
  const details = (role) => ({
    targetEntity: 'W3Project',
    fieldName: 'members',
    mapOperation: 'added',
    targetId: 'p1',
    memberId: 'w3-user-2',
    role,
    invitationId: 'inv-1',
    invitationOperation: 'update',
    useCount: 1,
  });
  const mapEvent = {
    handle: { entity: 'W3Project', field: 'members', kind: EventKind.native, nativeName: 'added' },
    data: { owner: 'p1', member: 'w3-user-2', role: 'member' },
  };

  // An undeclared self-authored role never becomes an admission fact, even
  // when the event appears to grant it.
  assert.equal(authorizeInvitationAcceptance(authority, details('administrator'), ['member']), false);
  assert.equal(admitInvitationAcceptance({ event: mapEvent, principal: authority }), false);
  assert.equal(admitsInvitationRemoval(authority, 'inv-1'), false);

  // A declared role admits the exact membership fact and its useCount bump.
  assert.equal(authorizeInvitationAcceptance(authority, details('member'), ['member', 'viewer']), true);
  assert.equal(admitInvitationAcceptance({ event: mapEvent, principal: authority }), true);
  assert.equal(admitInvitationAcceptance({
    event: {
      handle: { entity: 'Invitation', kind: EventKind.updated },
      data: { id: 'inv-1', useCount: 1 },
    },
    principal: authority,
  }), true);
});

test('invitation API still grants declared roles and rejects undeclared ones end-to-end', async () => {
  const Project = entity('W3InvitationProject', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'] }),
    grant: () => [],
  });
  membership(Project, { member: { can: [read] } });

  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Project] });
  await app.prepareSchema();
  app.entity(Project).insert({ id: 'p1', title: 'W3', owner: 'owner-w3' });
  app.listen(0);
  await app.ready;
  app.httpServer.unref();
  const api = createInvitationApi({ Invitation: app.entity(Invitation) });
  const owner = principal({ type: 'user', id: 'owner-w3' });
  const member = principal({ type: 'user', id: 'member-w3' });

  try {
    await assert.rejects(
      api.createInvitation({
        targetEntity: Project.name, targetId: 'p1', role: 'administrator', principal: owner,
      }),
      (error) => error.failure?.category === 'invalid-input',
    );
    const invitation = await api.createInvitation({
      targetEntity: Project.name, targetId: 'p1', role: 'member', principal: owner,
    });
    assert.ok(invitation.token);
    const accepted = await api.acceptInvitation(invitation.token, member);
    assert.deepEqual(
      { entity: accepted.targetEntity, id: accepted.targetId, role: accepted.role },
      { entity: Project.name, id: 'p1', role: 'member' },
    );
  } finally {
    app.httpServer.close();
    db.close();
  }
});

// =============================================================================
// 2. Session resolution / duration unification
// =============================================================================

test('session duration default is one shared value', () => {
  assert.equal(DEFAULT_SESSION_DURATION_MS, config.sessionDurationMs);
  assert.ok(DEFAULT_SESSION_DURATION_MS > 0);
});

async function bootAuthApp(t, opts = {}) {
  const app = workbench({ db: ':memory:' }).auth();
  let basePath = '/auth';
  if (Object.keys(opts).length > 0) {
    const entities = Object.fromEntries(
      [User, Session, Credential, Invitation, ApiKey, TwoFactor]
        .map((decl) => [decl.name, app.entity(decl)]),
    );
    basePath = '/auth-w3';
    app.mount(basePath, authRoutes({ entities, db: app.db, ...opts }));
  }
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  const origin = `http://127.0.0.1:${port}`;
  return { app, origin, authUrl: `${origin}${basePath}` };
}

test('session-row resolution has one authority shared by routes and principal hydration', async (t) => {
  const { app, authUrl } = await bootAuthApp(t);
  const register = await fetch(`${authUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'w3-session-user', password: 'password1234' }),
  });
  assert.equal(register.status, 201);
  const cookie = register.headers.get('set-cookie');
  const plainToken = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))[1];

  // The shared resolver reads the canonical hashed token.
  const resolve = sessionRowResolver(app.db);
  const row = resolve(plainToken);
  assert.ok(row, 'hashed token resolves through the one resolver');
  assert.equal(row.principalType, 'user');
  assert.equal(typeof row.principalId, 'string');
  assert.ok(row.principalId.length > 0);
  assert.equal(resolve(hashSessionToken(plainToken)), null, 'a stored hash cannot replay as a cookie');

  // sessionPrincipalOf uses that same resolver and stays fail-closed.
  const principalOf = sessionPrincipalOf(app.db);
  const hydrated = principalOf({ headers: { cookie: `${SESSION_COOKIE}=${plainToken}` } });
  assert.equal(hydrated.type, 'user');
  assert.equal(hydrated.id, row.principalId);
  assert.equal(principalOf({ headers: { cookie: `${SESSION_COOKIE}=${hashSessionToken(plainToken)}` } }).type, 'anonymous');

  // auth/routes.ts resolves sessions through the same authority, including its
  // legacy raw-token fallback (the /sessions "current" flag uses the lookup).
  app.db.prepare(
    'INSERT INTO Session (id, token, principalType, principalId, createdAt) '
      + 'SELECT ?, ?, principalType, principalId, createdAt FROM Session WHERE token = ?',
  ).run('w3-legacy-session', 'w3-legacy-raw-token', hashSessionToken(plainToken));
  assert.equal(resolve('w3-legacy-raw-token')?.id, 'w3-legacy-session');

  const list = await fetch(`${authUrl}/sessions`, {
    headers: { cookie: `${SESSION_COOKIE}=w3-legacy-raw-token` },
  });
  assert.equal(list.status, 200);
  const sessions = await list.json();
  assert.ok(sessions.some((s) => s.id === 'w3-legacy-session' && s.current === true));
});

// =============================================================================
// 3. Worker machine principal + attempt-bound handler timeout
// =============================================================================

test('an authenticated worker is a typed, unforgeable machine principal', () => {
  const calls = [];
  const jobs = {
    authenticate: (bearer) => {
      calls.push(bearer);
      return bearer === 'valid-bearer' ? 'worker-123' : null;
    },
  };

  const worker = workerMachinePrincipal('valid-bearer', jobs);
  assert.ok(worker);
  assert.ok(isMachinePrincipal(worker), 'worker is a branded machine principal');
  assert.equal(worker.type, 'system');
  assert.equal(worker.id, 'worker-123');
  assert.equal(worker.attributes.source, 'worker-123');
  assert.equal(worker.attributes.machine, true);
  assert.ok(worker.attributes.operations.includes('execute'));

  assert.equal(workerMachinePrincipal('invalid-bearer', jobs), null);
  assert.equal(workerMachinePrincipal(null, jobs), null);
  assert.deepEqual(calls, ['valid-bearer', 'invalid-bearer']);

  // A principal-shaped forgery is denied: the brand cannot be copied.
  const forged = { type: 'system', id: 'worker-123', attributes: { ...worker.attributes } };
  assert.equal(isMachinePrincipal(forged), false);
});

test('job worker HTTP wire protocol is unchanged under machine-principal auth', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    jobs: { sharedSecret: 'w3-worker-secret', leaseMs: 60_000, heartbeatGraceMs: 60_000, reapIntervalMs: 1_000_000 },
  });
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'u1' }) });
  await app.ready;
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const registered = await fetch(`${base}/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: 'w3-worker-secret' }),
  });
  assert.equal(registered.status, 200);
  const { workerId, token } = await registered.json();
  assert.ok(workerId && token);

  const claim = await fetch(`${base}/jobs/claim`, {
    method: 'POST',
    headers: { authorization: `Bearer ${workerId}.${token}` },
  });
  assert.equal(claim.status, 204, 'no queued work — wire protocol unchanged');

  const denied = await fetch(`${base}/jobs/claim`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong.credentials' },
  });
  assert.equal(denied.status, 401);
});

test('handler timeout converts a hung job into an attempt-bounded failure', async () => {
  const db = openSqliteDatabase(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({
    db, sharedSecret: 'w3-timeout-secret', handlerTimeoutMs: 30, maxAttempts: 1, backoffMs: 5,
  });
  const workerPrincipal = machinePrincipal({ id: 'w3-timeout-worker', operations: ['execute'] });
  const worker = queue.work('w3-hang', () => new Promise(() => {}), {
    principal: workerPrincipal, operations: ['execute'], pollIntervalMs: Infinity,
  });

  try {
    const job = queue.enqueue({ kind: 'w3-hang', payload: { n: 1 } });
    const outcome = await worker.once();
    assert.ok(outcome);
    assert.equal(outcome.result.deadLettered, true, 'the timed-out attempt hits the dead-letter bound');

    // A dead-lettered failure stores its reason in _Job.payload (the dedicated
    // output column is only written for a completed result).
    const stored = db.prepare('SELECT status, payload FROM _Job WHERE id = ?').get(job.id);
    assert.equal(stored.status, 'failed');
    assert.match(JSON.parse(stored.payload).error, /exceeded 30ms/);
  } finally {
    worker.stop();
    db.close();
  }
});

test('handler timeout config fails closed on malformed values and supports per-work override', async () => {
  const db = openSqliteDatabase(':memory:');
  executeFrameworkDDL(db);
  try {
    for (const bad of [0, -1, Number.NaN, Infinity, '30']) {
      assert.throws(
        () => createJobQueue({ db, sharedSecret: 's', handlerTimeoutMs: bad }),
        /handlerTimeoutMs/,
      );
    }

    const queue = createJobQueue({ db, sharedSecret: 's', maxAttempts: 1, handlerTimeoutMs: 5_000 });
    const principalForWork = machinePrincipal({ id: 'w3-override-worker', operations: ['execute'] });
    const worker = queue.work('w3-override', () => new Promise(() => {}), {
      principal: principalForWork, operations: ['execute'], pollIntervalMs: Infinity, handlerTimeoutMs: 30,
    });
    try {
      const job = queue.enqueue({ kind: 'w3-override' });
      const outcome = await worker.once();
      assert.equal(outcome.result.deadLettered, true);
      const payload = db.prepare('SELECT payload FROM _Job WHERE id = ?').get(job.id).payload;
      assert.match(JSON.parse(payload).error, /exceeded 30ms/, 'per-work override wins over the queue default');
      assert.throws(
        () => queue.work('w3-bad-override', () => {}, {
          principal: principalForWork, operations: ['execute'], pollIntervalMs: Infinity, handlerTimeoutMs: 0,
        }),
        /handlerTimeoutMs/,
      );
    } finally {
      worker.stop();
    }
  } finally {
    db.close();
  }
});
