// middleware.mjs — the baked-in default behaviors the framework applies to every
// response (SPEC §3). The app mounts none of this by hand; if it had to, that
// would be a leak (AGENTS.md → Defaults). Each default here is fail-closed and
// needs no per-app knowledge.

import { config } from './config.mjs';
import { getLog } from './log.mjs';
import { failureForHttpError, failureResponse } from './http-failure.mjs';
import { canWriteResponse,                       } from './http-response.mjs';
import { isWorkbenchFailure } from './outcome.mjs';

// Security headers set on EVERY response — including 401/404/500. These are the
// safe-without-per-app-knowledge defaults: stop MIME sniffing, deny framing
// (clickjacking), and never leak the URL in a referrer. Policies that need
// per-app input (CSP, HSTS) are deliberately NOT baked in — they are app
// declarations, not framework defaults, and a wrong default there breaks apps.
const SECURITY_HEADERS                                   = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-dns-prefetch-control': 'off',
});

// Apply the security headers to a response before its head is written. Idempotent
// and unconditional — every exit path runs through here.
export const applySecurityHeaders = (res                                                                        ) =>
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => res.setHeader(name, value));

// Trusted proxy configuration — fail closed (false) by default.
// When enabled, reverse-proxy forwarding headers (`X-Forwarded-Host`,
// `X-Forwarded-Proto`, `X-Forwarded-For`) are honored ONLY when the immediate
// TCP peer (`req.socket.remoteAddress`) is trusted.


function normalizeIp(ip        )         {
  const trimmed = ip.trim();
  if (trimmed.toLowerCase().startsWith('::ffff:')) {
    return trimmed.slice(7);
  }
  return trimmed;
}

function parseIpv4(ip        )                {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function matchesProxyEntry(ip        , entry        )          {
  const normalizedIp = normalizeIp(ip);
  const trimmedEntry = entry.trim();
  if (!trimmedEntry) return false;
  const slash = trimmedEntry.indexOf('/');
  if (slash !== -1) {
    const baseIp = parseIpv4(normalizeIp(trimmedEntry.slice(0, slash)));
    const targetIp = parseIpv4(normalizedIp);
    const prefix = Number(trimmedEntry.slice(slash + 1));
    if (baseIp === null || targetIp === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }
    if (prefix === 0) return true;
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (baseIp & mask) === (targetIp & mask);
  }
  const normalizedEntry = normalizeIp(trimmedEntry);
  return normalizedIp.toLowerCase() === normalizedEntry.toLowerCase()
    || ip.trim().toLowerCase() === trimmedEntry.toLowerCase();
}

export function isTrustedProxy(
  ip                           ,
  trustedProxies                 = false,
)          {
  if (!trustedProxies) return false;
  if (trustedProxies === true) return true;
  if (!ip) return false;
  const trimmed = ip.trim();
  if (!trimmed) return false;
  const normalized = normalizeIp(trimmed);
  if (typeof trustedProxies === 'function') {
    return Boolean(trustedProxies(normalized) || (normalized !== trimmed && trustedProxies(trimmed)));
  }
  if (Array.isArray(trustedProxies)) {
    return trustedProxies.some((entry) => typeof entry === 'string' && matchesProxyEntry(trimmed, entry));
  }
  return false;
}

function firstHeaderToken(value                               )                     {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]?.trim();
  return first || undefined;
}











// Resolve the effective client IP for rate limiting. Fail closed when
// `trustedProxies` is false (default) or the immediate peer is not trusted:
// ignore `X-Forwarded-For` and return `req.socket.remoteAddress`. When the peer
// IS trusted, walk `X-Forwarded-For` right-to-left skipping trusted proxies and
// return the first untrusted hop (falling back to the leftmost hop if every hop
// is trusted, e.g. `trustedProxies: true`).
export function resolveClientIp(
  req                     ,
  trustedProxies                 = false,
)                     {
  const remoteAddress = req.socket?.remoteAddress;
  if (!isTrustedProxy(remoteAddress, trustedProxies)) {
    return remoteAddress;
  }
  const raw = req.headers?.['x-forwarded-for'];
  const headerText = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof headerText !== 'string' || !headerText.trim()) {
    return remoteAddress;
  }
  const hops = headerText.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
  if (hops.length === 0) return remoteAddress;

  for (let i = hops.length - 1; i >= 0; i -= 1) {
    if (!isTrustedProxy(hops[i], trustedProxies)) {
      return hops[i];
    }
  }
  return hops[0];
}

// Same-origin verification — the ONE implementation used by both transports:
// the REST CSRF guard (serve.mjs) and the WebSocket upgrade handshake (live-delivery.mjs).
// A single mechanism so the two can never drift (AGENTS.md → no second auth path).
//
// `sameOriginAsHost` returns the verdict of ONE header against the request Host:
//   null  — header absent (caller decides the fallback)
//   true  — present and same-origin
//   false — present and foreign OR unparseable (fail closed)
export function sameOriginAsHost(headerValue                    , host                    )                 {
  if (!headerValue) return null; // absent — caller falls back / allows
  try {
    return new URL(headerValue).host === host;
  } catch {
    return false; // present but unparseable → treat as foreign (fail closed)
  }
}

function sameOriginWithExpected(
  headerValue                    ,
  host                    ,
  proto                    ,
)                 {
  if (!headerValue) return null;
  if (!proto) return sameOriginAsHost(headerValue, host);
  if (!host) return false;
  const normalizedProto = proto.toLowerCase();
  if (normalizedProto !== 'http' && normalizedProto !== 'https') return false;
  try {
    const actual = new URL(headerValue);
    const expected = new URL(`${normalizedProto}://${host}`);
    if (expected.pathname !== '/' || expected.search !== '' || expected.hash !== '') {
      return false;
    }
    return actual.origin === expected.origin;
  } catch {
    return false;
  }
}


















// The composed same-origin admission used by state-changing transports. An
// Origin header, when present, is authoritative; a Referer is the fallback;
// neither present → a non-browser client (no CSRF/CSWSH vector) is allowed.
// Browsers ALWAYS attach Origin to a cross-origin WebSocket handshake, so an
// absent Origin cannot be a cross-site attack — the allow is safe.
// When `trustedProxies` trusts the immediate peer, `X-Forwarded-Host` and
// `X-Forwarded-Proto` determine the expected origin; otherwise they are ignored.
export function isSameOriginRequest(
  req                       ,
  options                    = {},
)          {
  const trusted = isTrustedProxy(req.socket?.remoteAddress, options.trustedProxies ?? false);
  const host = trusted
    ? (firstHeaderToken(req.headers['x-forwarded-host']) ?? req.headers.host)
    : req.headers.host;
  const proto = trusted ? firstHeaderToken(req.headers['x-forwarded-proto']) : undefined;

  const origin = sameOriginWithExpected(req.headers.origin, host, proto);
  if (origin !== null) return origin;   // Origin present → its verdict stands
  const referer = sameOriginWithExpected(req.headers.referer, host, proto);
  if (referer !== null) return referer; // no Origin; Referer present → its verdict
  return true;                          // neither present → non-browser client, allow
}

// The single error renderer — the SPEC §3 "4-argument JSON error handler". It is
// the ONE place an error becomes a client response, so the dev/prod and
// deliberate/unexpected decisions are all made in one spot.
//
// Deliberate failures reach here either as a stable WorkbenchFailure or as the
// older `{ status, message }` handler form. Both are client-visible by intent.
//   * an UNEXPECTED exception — a thrown Error with no numeric `status` — is a
//     failure the handler did not anticipate. It is opaque in production (no
//     stack and no internal message) in every environment. The useful detail is
//     retained in the server log instead of being sent to the browser.
//
// `env` is server-owned (a listen option, defaulting to config.env) — never
// client-controlled.
export function renderError(res                  , err         , { env = config.env } = {})       {
  if (!canWriteResponse(res, 'renderError', err)) return;
  const normalized = failureForHttpError(err);
  const errRecord = err                                           ;
  const canonicalInput = isWorkbenchFailure(err) || isWorkbenchFailure(errRecord.failure);
  const deliberate = canonicalInput || normalized.category !== 'internal';
  if (!deliberate) {
    getLog().error('http', 'request failed', { err, env });
  }
  const { status, body } = failureResponse(normalized, {
    status: typeof errRecord.status === 'number' ? errRecord.status : undefined,
  });
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
