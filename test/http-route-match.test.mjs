import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchRoute } from '../build/http-route-match.mjs';

const routes = [
  { method: 'GET', path: '/docs/:id', name: 'read' },
  { method: 'GET', path: '/docs/feed', name: 'feed' },
  { method: 'POST', path: '/docs', name: 'create' },
  { method: 'GET', path: '/users/:userId/docs/:docId', name: 'nested' },
];

test('matchRoute returns the matching route and decoded params', () => {
  const match = matchRoute(routes, 'GET', '/users/alice%20a/docs/doc%2F1');

  assert.equal(match.route.name, 'nested');
  assert.deepEqual(match.params, { userId: 'alice a', docId: 'doc/1' });
});

test('matchRoute prefers the most specific path for the requested method', () => {
  const match = matchRoute(routes, 'GET', '/docs/feed');

  assert.equal(match.route.name, 'feed');
  assert.deepEqual(match.params, {});
});

test('matchRoute reports known path with unsupported method', () => {
  const match = matchRoute(routes, 'PUT', '/docs/feed');

  assert.equal(match.route, null);
  assert.equal(match.params, null);
  assert.equal(match.pathMatched, true);
});

test('matchRoute reports unknown path separately from method mismatch', () => {
  const match = matchRoute(routes, 'GET', '/missing');

  assert.equal(match.route, null);
  assert.equal(match.params, null);
  assert.equal(match.pathMatched, false);
});

test('matchRoute does not match longer or shorter paths', () => {
  assert.equal(matchRoute(routes, 'GET', '/docs/feed/extra').pathMatched, false);
  assert.equal(matchRoute(routes, 'GET', '/docs').route, null);
});

test('matchRoute rejects malformed percent-encoding cleanly', () => {
  const match = matchRoute(routes, 'GET', '/docs/%ZZ');
  assert.equal(match.route, null);
  assert.equal(match.params, null);
  assert.equal(match.pathMatched, false);
});

test('matchRoute returns consistent fresh params across repeated cached lookups', () => {
  const first = matchRoute(routes, 'GET', '/users/alice/docs/d1');
  const second = matchRoute(routes, 'GET', '/users/bob/docs/d2');
  assert.deepEqual(first.params, { userId: 'alice', docId: 'd1' });
  assert.deepEqual(second.params, { userId: 'bob', docId: 'd2' });
});
