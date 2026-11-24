// RateLimiter module — RED-GREEN TDD.
// Per-key fixed-window rate limiter (IP + optional session buckets).

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function createLimiter(ip, session, nowFn) {
  const { createRateLimiter } = await import('../build/rate-limit.mjs');
  return createRateLimiter({ ip, session, now: nowFn });
}

test('per-IP fixed window overflows → 429 on N+1 request', async () => {
  let t = 1000;
  const now = () => t;
  
  const limiter = await createLimiter({ windowMs: 1000, max: 3 }, null, now);
  const ip = '192.168.1.1';
  
  // First 3 requests allowed
  for (let i = 1; i <= 3; i++) {
    const result = limiter.check({ ip });
    assert.equal(result.allowed, true, `request ${i} allowed`);
    assert.equal(result.scope, 'ip', `scope is ip`);
    assert.equal(result.limit, 3, `limit reported`);
  }
  
  // 4th request denied
  const denied = limiter.check({ ip });
  assert.equal(denied.allowed, false, '4th request denied');
  assert.equal(denied.scope, 'ip', 'denied by ip scope');
  assert.ok(denied.retryAfterMs > 0, 'retryAfterMs > 0');
  
  // Advance past window → fresh budget
  t += 1500;
  const afterWindow = limiter.check({ ip });
  assert.equal(afterWindow.allowed, true, 'allowed after window rollover');
});

test('per-session limit supplements per-IP', async () => {
  let t = 1000;
  const now = () => t;
  
  const limiter = await createLimiter(
    { windowMs: 1000, max: 10 },
    { windowMs: 1000, max: 2 },
    now,
  );
  const ip = '192.168.1.1';
  const sessionId = 'session-A';
  
  // First 2 requests allowed (session budget)
  for (let i = 1; i <= 2; i++) {
    const result = limiter.check({ ip, sessionId });
    assert.equal(result.allowed, true, `request ${i} allowed`);
  }
  
  // 3rd request denied by session (IP still has budget)
  const denied = limiter.check({ ip, sessionId });
  assert.equal(denied.allowed, false, '3rd request denied');
  assert.equal(denied.scope, 'session', 'denied by session scope');
  assert.equal(denied.limit, 2, 'session limit reported');
});

test('different IPs are independent', async () => {
  let t = 1000;
  const now = () => t;
  
  const limiter = await createLimiter({ windowMs: 1000, max: 2 }, null, now);
  
  // IP A exhausts budget
  limiter.check({ ip: '192.168.1.1' });
  limiter.check({ ip: '192.168.1.1' });
  const aDenied = limiter.check({ ip: '192.168.1.1' });
  assert.equal(aDenied.allowed, false, 'IP A exhausted');
  
  // IP B still has budget
  const bAllowed = limiter.check({ ip: '192.168.1.2' });
  assert.equal(bAllowed.allowed, true, 'IP B independent');
});

test('without session config, only IP applies', async () => {
  let t = 1000;
  const now = () => t;
  
  const limiter = await createLimiter({ windowMs: 1000, max: 2 }, null, now);
  const ip = '192.168.1.1';
  
  const r1 = limiter.check({ ip, sessionId: 'ignored' });
  const r2 = limiter.check({ ip, sessionId: 'ignored' });
  const r3 = limiter.check({ ip, sessionId: 'ignored' });
  
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, false, 'denied by IP, session not consulted');
  assert.equal(r3.scope, 'ip');
});

test('denied request does not consume budget for another IP', async () => {
  let t = 1000;
  const now = () => t;
  
  const limiter = await createLimiter({ windowMs: 1000, max: 1 }, null, now);
  
  // IP A exhausts
  limiter.check({ ip: 'A' });
  limiter.check({ ip: 'A' }); // denied
  
  // IP B should have full budget
  const b1 = limiter.check({ ip: 'B' });
  const b2 = limiter.check({ ip: 'B' });
  
  assert.equal(b1.allowed, true, 'IP B first allowed');
  assert.equal(b2.allowed, false, 'IP B second denied (own budget)');
});

test('window rollover resets budget', async () => {
  let t = 1000;
  const now = () => t;
  
  const limiter = await createLimiter({ windowMs: 1000, max: 1 }, null, now);
  const ip = '192.168.1.1';
  
  limiter.check({ ip }); // uses budget
  const denied = limiter.check({ ip });
  assert.equal(denied.allowed, false, 'denied in same window');
  
  t += 1000; // exactly at next window boundary
  const after = limiter.check({ ip });
  assert.equal(after.allowed, true, 'allowed in new window');
});

test('returns retryAfterMs for denied request', async () => {
  let t = 1000;
  const now = () => t;
  
  const limiter = await createLimiter({ windowMs: 1000, max: 1 }, null, now);
  const ip = '192.168.1.1';
  
  limiter.check({ ip });
  const denied = limiter.check({ ip });
  
  assert.ok(denied.retryAfterMs > 0, 'retryAfterMs positive');
  assert.ok(denied.retryAfterMs <= 1000, 'retryAfterMs <= windowMs');
});

test('session and IP windows roll independently', async () => {
  let t = 1000;
  const now = () => t;
  
  const limiter = await createLimiter(
    { windowMs: 2000, max: 5 },
    { windowMs: 1000, max: 1 },
    now,
  );
  const ip = '192.168.1.1';
  const sessionId = 'session-A';
  
  // Use session budget
  limiter.check({ ip, sessionId });
  const denied = limiter.check({ ip, sessionId });
  assert.equal(denied.allowed, false, 'denied by session');
  assert.equal(denied.scope, 'session');
  
  // Roll session window only (1000ms)
  t += 1000;
  const after = limiter.check({ ip, sessionId });
  assert.equal(after.allowed, true, 'session budget reset');
});

test('isTrustedLocalPeer classifies loopback/private addresses; remote stays remote', async () => {
  const { isTrustedLocalPeer } = await import('../build/rate-limit.mjs');
  // Trusted: loopback + IPv4-mapped + RFC1918 + IPv6 local
  assert.equal(isTrustedLocalPeer('127.0.0.1'), true, 'IPv4 loopback');
  assert.equal(isTrustedLocalPeer('::1'), true, 'IPv6 loopback');
  assert.equal(isTrustedLocalPeer('::ffff:127.0.0.1'), true, 'IPv4-mapped loopback');
  assert.equal(isTrustedLocalPeer('10.1.2.3'), true, 'RFC1918 10/8');
  assert.equal(isTrustedLocalPeer('172.16.0.1'), true, 'RFC1918 172.16/12');
  assert.equal(isTrustedLocalPeer('172.31.255.255'), true, 'RFC1918 172.31');
  assert.equal(isTrustedLocalPeer('192.168.1.5'), true, 'RFC1918 192.168');
  assert.equal(isTrustedLocalPeer('169.254.0.1'), true, 'link-local');
  assert.equal(isTrustedLocalPeer('fc00::1'), true, 'IPv6 unique-local');
  assert.equal(isTrustedLocalPeer('fd12::1'), true, 'IPv6 unique-local fd');
  assert.equal(isTrustedLocalPeer('fe80::1'), true, 'IPv6 link-local');

  // Remote: public addresses stay remote (production edge budget untouched)
  assert.equal(isTrustedLocalPeer('8.8.8.8'), false, 'public IPv4');
  assert.equal(isTrustedLocalPeer('203.0.113.7'), false, 'TEST-NET IPv4');
  assert.equal(isTrustedLocalPeer('172.32.0.1'), false, 'just above 172.16/12');
  assert.equal(isTrustedLocalPeer('2001:4860:4860::8888'), false, 'public IPv6 (Google DNS)');
  assert.equal(isTrustedLocalPeer(''), false, 'empty string');
  assert.equal(isTrustedLocalPeer(undefined), false, 'undefined');
});

test('trusted local peer with a `local` window exceeds the remote cap without 429', async () => {
  let t = 1000;
  const now = () => t;

  // Remote cap of 3; local (trusted) cap of 1000.
  const _limiter = await createLimiter(
    { windowMs: 1000, max: 3 },
    null,
    now,
  );
  // Inject `local` via the options shape the loader passes through.
  // (createLimiter above passes only {ip, session, now}; build a limiter with
  // local explicitly.)
  const { createRateLimiter } = await import('../build/rate-limit.mjs');
  const localLimiter = createRateLimiter({
    ip: { windowMs: 1000, max: 3 },
    local: { windowMs: 1000, max: 1000 },
    now,
  });

  // Trusted peer loops far above the remote cap of 3 — never denied.
  for (let i = 0; i < 50; i++) {
    const r = localLimiter.check({ ip: '127.0.0.1' });
    assert.equal(r.allowed, true, `trusted local request ${i} allowed`);
  }

  // Remote peer on the same limiter still hits the configured cap (3).
  const remoteResults = Array.from({ length: 4 }, () => localLimiter.check({ ip: '8.8.8.8' }));
  assert.deepEqual(remoteResults.map((r) => r.allowed), [true, true, true, false], 'remote peer capped at 3');
});

test('trusted local peer with a `local` window also lifts the session cap', async () => {
  let t = 1000;
  const now = () => t;
  const { createRateLimiter } = await import('../build/rate-limit.mjs');

  const limiter = createRateLimiter({
    ip: { windowMs: 1000, max: 1000 },
    session: { windowMs: 1000, max: 2 },
    local: { windowMs: 1000, max: 1000 },
    now,
  });

  // Trusted local peer + one session: session cap of 2 is lifted to local 1000.
  for (let i = 0; i < 10; i++) {
    const r = limiter.check({ ip: '127.0.0.1', sessionId: 'dev-session' });
    assert.equal(r.allowed, true, `trusted session request ${i} allowed`);
  }

  // Remote peer + same low session cap is still capped at 2.
  const rr = [
    limiter.check({ ip: '8.8.8.8', sessionId: 'remote-session' }),
    limiter.check({ ip: '8.8.8.8', sessionId: 'remote-session' }),
    limiter.check({ ip: '8.8.8.8', sessionId: 'remote-session' }),
  ];
  assert.deepEqual(rr.map((r) => r.allowed), [true, true, false], 'remote session still capped at 2');
});

test('without a `local` window configured, trusted peers keep the ip cap (backward compatible)', async () => {
  let t = 1000;
  const now = () => t;
  const { createRateLimiter } = await import('../build/rate-limit.mjs');

  const limiter = createRateLimiter({
    ip: { windowMs: 1000, max: 2 },
    now,
  });

  const results = [
    limiter.check({ ip: '127.0.0.1' }),
    limiter.check({ ip: '127.0.0.1' }),
    limiter.check({ ip: '127.0.0.1' }),
  ];
  assert.deepEqual(results.map((r) => r.allowed), [true, true, false], 'no local window → ip cap applies even for 127.0.0.1');
});
