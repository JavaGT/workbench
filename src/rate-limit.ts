// rate-limit.mjs — per-key fixed-window rate limiters.
// Buckets keyed by floor(now / windowMs) and bounded in O(1) via LRUCache.

import { LRUCache } from 'lru-cache';

const DEFAULT_MAX_BUCKETS = 10_000;

type RateBucket = { window: number; count: number };
type BucketCheck = { allowed: boolean; retryAfterMs: number; limit: number };

export type RateLimitScope = 'ip' | 'session';

export type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
  limit: number;
  scope: RateLimitScope;
};

export type RateLimitOptions = {
  ip: { windowMs: number; max: number };
  session?: { windowMs: number; max: number } | null;
  // Optional raised window for trusted local peers (loopback/private-network
  // addresses — the operator's own machine). When present, a trusted peer is
  // capped by `local` instead of `ip`/`session`, so self-hosted / dev traffic
  // (e.g. Vite's per-module asset fetches) does not trip the production edge
  // budget. Remote (public) peers ALWAYS use `ip`/`session` — never `local`.
  // Absent by default: no behavior change.
  local?: { windowMs: number; max: number } | null;
  now?: () => number;
};

// The generic keyed fixed-window limiter (S5/A4). Keys an arbitrary string to
// its own bucket with max hits per window — the engine the denial log keys per
// (actor, reasonCode). Exists alongside the request limiter so transports and
// the denial log share one bucketing implementation.
export type KeyedRateLimitResult = { allowed: boolean; retryAfterMs: number; limit: number };

export interface KeyedRateLimiter {
  check(key: string): KeyedRateLimitResult;
}

export type KeyedRateLimitOptions = {
  windowMs: number;
  max: number;
  now?: () => number;
};

function checkBucket(buckets: LRUCache<string, RateBucket>, key: string, windowMs: number, max: number, now: () => number): BucketCheck {
  const currentWindow = Math.floor(now() / windowMs);

  let bucket = buckets.get(key);
  if (!bucket || bucket.window !== currentWindow) {
    bucket = { window: currentWindow, count: 0 };
    buckets.set(key, bucket);
  }

  const allowed = bucket.count < max;
  if (allowed) bucket.count++;
  const nextWindowStart = (currentWindow + 1) * windowMs;
  const retryAfterMs = nextWindowStart - now();
  return { allowed, retryAfterMs, limit: max };
}

export function createRateLimiter(
  { ip: { windowMs: ipWindowMs, max: ipMax }, session = null, local = null, now = Date.now }: RateLimitOptions = {} as RateLimitOptions,
): { check(input: { ip: string; sessionId?: string }): RateLimitResult } {
  const ipBuckets = new LRUCache<string, RateBucket>({ max: DEFAULT_MAX_BUCKETS });
  const sessionBuckets = new LRUCache<string, RateBucket>({ max: DEFAULT_MAX_BUCKETS });
  const sessionWindowMs = session?.windowMs;
  const sessionMax = session?.max;
  const localWindowMs = local?.windowMs;
  const localMax = local?.max;

  function check({ ip, sessionId }: { ip: string; sessionId?: string }): RateLimitResult {
    // Trusted local peers (loopback/private-network addresses — the operator's
    // own machine in a single-node self-hosted deployment) may be given a
    // raised `local` window so genuine local load (dev module graphs, etc.)
    // never exhausts the production per-IP budget. Remote peers map to the
    // configured `ip`/`session` caps unchanged. No `local` window configured →
    // everyone uses `ip`/`session` (backward compatible).
    const trusted = localMax != null && isTrustedLocalPeer(ip);
    const ipResult = checkBucket(
      ipBuckets, ip,
      trusted ? localWindowMs! : ipWindowMs,
      trusted ? localMax : ipMax,
      now,
    );

    if (!ipResult.allowed) {
      return { ...ipResult, scope: 'ip' };
    }

    if (session && sessionId) {
      const sessionResult = checkBucket(
        sessionBuckets, sessionId,
        trusted ? localWindowMs! : sessionWindowMs!,
        trusted ? localMax : sessionMax!,
        now,
      );
      if (!sessionResult.allowed) {
        return { ...sessionResult, scope: 'session' };
      }
    }

    return { ...ipResult, scope: 'ip' };
  }

  return { check };
}

/**
 * Classify a peer IP as "trusted local" — loopback or private-network address.
 * Covers the address forms Node's HTTP server reports for a local peer:
 * `127.0.0.1`, `::1`, the IPv4-mapped `::ffff:127.0.0.1`, RFC1918 private
 * ranges (`10/8`, `172.16/12`, `192.168/16`), and the IPv6 unique-local
 * (`fc00::/7`) and link-local (`fe80::/10`) ranges. Public / remote addresses
 * return false, so the production edge budget is never weakened for them.
 */
export function isTrustedLocalPeer(ip: string): boolean {
  if (!ip) return false;
  // Strip an IPv4-mapped IPv6 prefix so `::ffff:192.168.1.5` classifies as IPv4.
  let address = ip.toLowerCase();
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) address = mapped[1];
  if (address.includes(':')) {
    // IPv6: exact loopback, unique-local (fc00::/7), link-local (fe80::/10),
    // or the IPv4-compatible `::127.0.0.1` / `::1`.
    if (address === '::1' || address === '::') return true;
    if (address.startsWith('fc') || address.startsWith('fd')) return true; // fc00::/7
    if (address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb')) return true; // fe80::/10
    if (address.startsWith('::ffff:')) return true; // defensive: mapped 127 already handled, treat any mapped as-is
    if (address.startsWith('::')) return true; // ::/128 prefix covers ::1 and ::0.0.0.0 (unspecified/compat)
    return false;
  }
  // IPv4: loopback 127/8, private RFC1918 + link-local.
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 127) return true; // 127/8 loopback
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  return false;
}

// A generic single-key bucket family: one bucket per arbitrary string key, max
// hits per window. The denial log uses max=1 so exactly one representative per
// window survives a flood.
export function createKeyedRateLimiter(
  { windowMs, max, now = Date.now }: KeyedRateLimitOptions = {} as KeyedRateLimitOptions,
): KeyedRateLimiter {
  const buckets = new LRUCache<string, RateBucket>({ max: DEFAULT_MAX_BUCKETS });

  function check(key: string): KeyedRateLimitResult {
    return checkBucket(buckets, key, windowMs, max, now);
  }

  return Object.freeze({ check });
}
