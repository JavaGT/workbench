// Phase 1 — the server-side mutation handler (SPEC §7).
//
// The server runs one handler for every action: resolve scope → authorize
// (outside the transaction) → open transaction → dedupe by action id → run the
// handler → assign each emitted event a per-scope monotonic sequence number →
// append to the durable log → commit → fan out. This test pins the in-memory
// kernel of that shape; persistence (node:sqlite) is the engaged seam added
// later WITHOUT changing this shape (persistence opt-in by engaged seam).
//
// Key invariants under test:
//  - dedupe by action id is idempotent: a re-sent action returns its stored
//    events WITHOUT re-running the handler (no duplicate state change).
//  - each event in a scope gets a strictly increasing sequence number, starting
//    at 1, monotonic per scope and independent across scopes.
//  - authorization runs before the log is touched; a denied action appends
//    nothing.
//
// Source of truth: SPEC §7, §7.1. The log is the single durable record (one
// reconciliation path); there is no second apply path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer, action as _action } from '../build/internal.mjs';

// A minimal handler registry: an action type maps to a handler that returns the
// events it emits. The handler is pure here (no I/O) so the test pins the
// pipeline shape, not a storage backend.
function blogServer() {
  return createServer({
    handlers: {
      'post.publish': ({ payload }) => [
        { type: 'post.published', scope: payload.postId, data: { at: payload.at } },
      ],
    },
    // authorize is the grant engine seam; here a simple allow/deny by principal.
    authorize: ({ principal }) => principal.id !== 'banned',
  });
}

test('dispatching an action runs its handler and appends the emitted events to the log', () => {
  const server = blogServer();
  const result = server.dispatch({
    actionId: 'a1', type: 'post.publish',
    payload: { postId: 'p1', at: 10 }, principal: { id: 'u1' },
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'post.published');
  assert.equal(server.log.length, 1);
});

test('each event gets a per-scope monotonic sequence number starting at 1', () => {
  const server = blogServer();
  const r1 = server.dispatch({ actionId: 'a1', type: 'post.publish', payload: { postId: 'p1', at: 1 }, principal: { id: 'u1' } });
  const r2 = server.dispatch({ actionId: 'a2', type: 'post.publish', payload: { postId: 'p1', at: 2 }, principal: { id: 'u1' } });
  assert.equal(r1.events[0].seq, 1);
  assert.equal(r2.events[0].seq, 2);
});

test('sequence numbers are independent across scopes', () => {
  const server = blogServer();
  const r1 = server.dispatch({ actionId: 'a1', type: 'post.publish', payload: { postId: 'p1', at: 1 }, principal: { id: 'u1' } });
  const r2 = server.dispatch({ actionId: 'a2', type: 'post.publish', payload: { postId: 'p2', at: 1 }, principal: { id: 'u1' } });
  assert.equal(r1.events[0].seq, 1, 'first event in scope p1');
  assert.equal(r2.events[0].seq, 1, 'first event in scope p2 — independent counter');
});

test('dedupe by action id is idempotent: a re-sent action returns stored events without re-running', () => {
  let runs = 0;
  const server = createServer({
    handlers: { 'post.publish': ({ payload }) => { runs += 1; return [{ type: 'post.published', scope: payload.postId, data: {} }]; } },
    authorize: () => true,
  });
  const first = server.dispatch({ actionId: 'a1', type: 'post.publish', payload: { postId: 'p1' }, principal: { id: 'u1' } });
  const second = server.dispatch({ actionId: 'a1', type: 'post.publish', payload: { postId: 'p1' }, principal: { id: 'u1' } });
  assert.equal(runs, 1, 'handler runs exactly once for a re-sent action id');
  assert.equal(server.log.length, 1, 'no duplicate events appended');
  assert.deepEqual(second.events.map((e) => e.seq), first.events.map((e) => e.seq), 're-send returns the same stored events');
});

test('a denied action appends nothing to the log and reports the denial', () => {
  const server = blogServer();
  const result = server.dispatch({
    actionId: 'a1', type: 'post.publish',
    payload: { postId: 'p1', at: 1 }, principal: { id: 'banned' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'denied');
  assert.equal(server.log.length, 0, 'authorization runs before the log is touched');
});

test('createServer with no authorize is a load-time error (fail-closed, no default-open)', () => {
  // authorize is the action-side authorization seam. There is NO default — a
  // default `() => true` would admit every action (fail OPEN), the opposite of
  // the route gate's default-on requireUser(). Authorization is always an
  // explicit function (AGENTS: never a magic default); omitting it is a
  // load-time error, never a silently-permissive server.
  assert.throws(
    () => createServer({ handlers: { x: () => [] } }),
    /authorize/i,
    'a server with no authorize function must throw at construction',
  );
});

test('dispatching an unknown action type returns a stable failure', () => {
  const server = blogServer();
  const result = server.dispatch({
    actionId: 'a1', type: 'nope', payload: {}, principal: { id: 'u1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'unknown-action');
});
