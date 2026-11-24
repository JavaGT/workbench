// session.mjs — session/auth wiring (SPEC §3, §572, §660).
//
// The principal a request carries is built SERVER-SIDE from its session. The
// client sends only an opaque session token in a cookie; the identity (type, id)
// is looked up in the Session table and constructed by the framework. The client
// cannot supply its own identity — a forged or unknown token is `anonymous`, and
// the default-on route gate then denies it (fail closed).
//
// This is the source of the `principalOf(req)` function the HTTP transport calls
// per request — the SAME admission path as the bare `() => anonymous` default it
// replaces, never a second auth path. When an app is constructed with a db
// (`workbench({ db })`), session hydration becomes the default principal source.

import { principal, anonymous, isPrincipalStatus, type Principal, type PrincipalType, type PrincipalStatus } from '../principal.ts';
import { config } from '../config.ts';
import { createHash } from 'node:crypto';

// The minimal request shape session hydration reads: the raw `Cookie` header
// (node:http exposes the string) and the `Authorization` header for Bearer keys.
// The transport types the full request; this is the fail-closed subset.
interface RequestLike {
  headers?: { cookie?: string; authorization?: string };
}

// The SQLite statement/db surface session hydration uses. The concrete driver
// (better-sqlite3-shaped) satisfies this structurally; a broken db still fails
// closed because every lookup happens inside the try/catch below.
interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqlDb {
  prepare(sql: string): SqlStatement;
}

// The Session row projected by the ONE resolver. `principalType` is validated
// by principal() against the closed union; `createdAt` by sessionCreatedAtMs;
// `status` (when the table exposes it) by the closed status guard. A corrupt
// stored row therefore resolves to anonymous, never to an admitted identity.
export interface SessionLookupRow {
  id: string;
  principalType: string;
  principalId: string;
  createdAt: unknown;
  status?: unknown;
}

export type SessionRowResolver = (plainToken: string) => SessionLookupRow | null;

// Build the single session-row resolver for a db. It probes for a `status`
// column once, then resolves a plain token by SHA-256 hash with a legacy raw
// token fallback. auth/routes.ts and sessionPrincipalOf BOTH use this resolver,
// so session lookup has one authority — one hash/legacy rule and one fail-closed
// behavior — instead of two copies that can drift apart.
export function sessionRowResolver(db: SqlDb): SessionRowResolver {
  let hasStatusColumn = false;
  try {
    db.prepare('SELECT status FROM Session LIMIT 0');
    hasStatusColumn = true;
  } catch {
    hasStatusColumn = false;
  }
  const select = hasStatusColumn
    ? 'SELECT id, principalType, principalId, createdAt, status FROM Session WHERE token = ?'
    : 'SELECT id, principalType, principalId, createdAt FROM Session WHERE token = ?';
  return (plainToken) => {
    if (typeof plainToken !== 'string' || plainToken.length === 0) return null;
    try {
      // Prepare per request so a broken db fails CLOSED each time rather than at
      // construction. Look up the SHA-256 hash first (the canonical at-rest form
      // written by Session.create); fall back to a raw lookup ONLY when the token
      // is not itself a 64-hex digest — a stolen stored hash can never be
      // replayed as a cookie.
      const stmt = db.prepare(select);
      const tokenHash = hashSessionToken(plainToken);
      let row = stmt.get(tokenHash) as SessionLookupRow | null | undefined;
      if (!row && !SHA256_HEX_RE.test(plainToken)) {
        row = stmt.get(plainToken) as SessionLookupRow | null | undefined;
      }
      return row ?? null;
    } catch {
      return null;
    }
  };
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

// The ONE session-duration default (sourced from config.ts, the same value
// resolveConfig()/app.config use). Both session seams read it: auth/routes.ts
// for the cookie Max-Age and /sessions listing, and sessionPrincipalOf for the
// expiry admission check. A framework default change cannot desynchronize them.
export const DEFAULT_SESSION_DURATION_MS = config.sessionDurationMs;

// Hash an opaque session token before storing in `Session.token` or querying
// against it. Storing only SHA-256 digests prevents a read-only DB compromise
// from yielding usable session cookies.
export function hashSessionToken(token: string): string {
  return sha256hex(token);
}

// The session cookie name. The cookie value is an opaque token; it never carries
// identity, only a key into the Session table.
export const SESSION_COOKIE = 'sid';

// Parse a raw `Cookie` request header (`name=value; name2=value2`) into a
// name→value map. Values are url-decoded. A missing/empty header is an empty map.
// Zero-dependency: node:http exposes the raw header string, nothing parses it.
// Malformed percent-escapes are skipped (fail closed) — never throw 500 (cso M1).
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    const value = pair.slice(eq + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding — skip this cookie (fail closed, anonymous)
    }
  }
  return cookies;
}

export interface SessionCookieOptions {
  secure?: boolean;
  env?: string;
  /** Cookie lifetime in seconds (emits `Max-Age=<seconds>`). */
  maxAge?: number;
  /** Cookie lifetime in milliseconds (converted to `Max-Age=<seconds>` when `maxAge` is absent). */
  ttlMs?: number;
}

// Build the `Set-Cookie` header value for a session token. Fail-closed defaults:
// HttpOnly (never readable by client JS), SameSite=Lax (CSRF-resistant), Secure
// (TLS-only), Path=/. `secure` may be dropped for a non-TLS context (local dev /
// tests over plain http); HttpOnly and SameSite are never dropped.
// cso M2: In production, secure:false is refused — tokens must be TLS-only.
export function sessionCookie(
  token: string,
  { secure = true, env = config.env, maxAge, ttlMs }: SessionCookieOptions = {},
): string {
  if (env === 'production' && !secure) {
    throw new Error('sessionCookie secure:false is not permitted in production');
  }
  const attributes = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (typeof maxAge === 'number' && Number.isFinite(maxAge) && maxAge >= 0) {
    attributes.push(`Max-Age=${Math.floor(maxAge)}`);
  } else if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0) {
    attributes.push(`Max-Age=${Math.floor(ttlMs / 1000)}`);
  }
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

// Read the opaque session token from the request's `sid` cookie, or undefined
// when there is none. Pure (no DB): the rate-limit stack reads this to key a
// per-session window cheaply and BEFORE principal hydration (eng-review: rate
// limiting rejects a flood before any DB lookup or write lock). The token is the
// stable per-session key — a single client cannot rotate another user's token,
// and the IP gate (which runs first) is the non-spoofable base that holds when no
// cookie is present. sessionPrincipalOf reuses this same read.
//
// Fail closed on duplicate `sid` cookies (#218): if a request carries more than
// one `sid=...` pair (e.g. cookie-jar smuggling / subdomain shadow cookie),
// reject the ambiguous header and yield `undefined` (→ anonymous).
export function sessionTokenOf(req: RequestLike): string | undefined {
  const header = req.headers?.cookie;
  if (!header) return undefined;
  let count = 0;
  let value: string | undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== SESSION_COOKIE) continue;
    count += 1;
    if (count > 1) return undefined;
    const raw = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  if (count !== 1 || !value) return undefined;
  return value;
}

function sessionCreatedAtMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value !== 'string') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const parsed = Date.parse(value);
  // Date.parse normalizes impossible dates (for example February 30). Stored
  // ISO dates must round-trip exactly so corrupt values cannot gain admission.
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

// Build the `principalOf(req)` function for a given db. It reads the session
// cookie, looks the token up in the Session table, and constructs the principal
// SERVER-SIDE from the stored identity. Any failure — no cookie, no token, no
// matching row, or a malformed stored type — yields `anonymous` (fail closed).
//
// Status threading (S5/A1): when the Session row exposes a `status` cell, it is
// carried onto the principal so the audit/diagnostic context can tell a revoked
// session from a disabled one. The FAIL-CLOSED rule is untouched: the
// forged/unknown-token path still returns the canonical `anonymous` (always
// `'active'`), so an unauthenticated caller never learns a real status — the
// two-valued admission collapse happens at the A2 seam, not here.
export function sessionPrincipalOf(db: SqlDb, { durationMs = DEFAULT_SESSION_DURATION_MS, now = Date.now }: { durationMs?: number; now?: () => number } = {}): (req: RequestLike) => Principal {
  // Use the SAME row resolver auth/routes.ts uses. The identity comes entirely
  // from the server-side Session row; the client supplied only the opaque token.
  const resolveSession = sessionRowResolver(db);
  return (req) => {
    const token = sessionTokenOf(req);
    if (!token) return anonymous;
    try {
      const row = resolveSession(token);
      if (!row) return anonymous;
      // Session cleanup reclaims expired rows eventually; authorization must not
      // wait for that scheduler. Validate timestamps in JavaScript because SQLite
      // affinity can compare corrupt text values as greater than numeric bounds.
      const checkedAt = now();
      const createdAt = sessionCreatedAtMs(row.createdAt);
      if (
        !Number.isFinite(checkedAt) ||
        !Number.isFinite(durationMs) ||
        durationMs < 0 ||
        createdAt === null ||
        createdAt > checkedAt ||
        checkedAt - createdAt >= durationMs
      ) {
        return anonymous;
      }
      // A link session's principalId IS the share token (auth-entities.mjs). The
      // linkHolder check reads `principal.attributes.token`, so a link principal
      // must carry it here — otherwise scope binds the token param to NULL and
      // the link principal reads nothing (fail-closed by accident, not by the
      // token match the session was minted to grant).
      const attributes = row.principalType === 'link' ? { token: row.principalId } : {};
      // Thread the stored status when present; principal() defaults to 'active'.
      // The DB cell is an `unknown` — narrow it through the closed-union guard
      // (never a bare assertion). SQL NULL / absent cell → no status → the
      // 'active' default applies; a present-but-corrupt status fails closed
      // (→ anonymous), exactly as principal()'s own closed-union check did.
      let storedStatus: PrincipalStatus | undefined;
      if (row.status != null) {
        if (!isPrincipalStatus(row.status)) return anonymous;
        storedStatus = row.status;
      }
      // principal() re-validates the closed type union, so a corrupt stored type
      // throws here and is caught below → anonymous (fail closed).
      return principal({
        type: row.principalType as PrincipalType,
        id: row.principalId,
        attributes,
        status: storedStatus,
      });
    } catch {
      return anonymous;
    }
  };
}

// Entity/role identifier patterns for ApiKey scope attributes. Kept strict so
// neither HTTP creation nor Bearer hydration accepts malformed strings, and
// framework auth entities can never be targeted by an ApiKey.
const API_KEY_ENTITY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const API_KEY_ROLE_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_API_KEY_ENTITIES = new Set([
  'User',
  'Session',
  'Inbox',
  'Credential',
  'Invitation',
  'ApiKey',
  'TwoFactor',
]);

export function isValidApiKeyEntityName(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_ENTITY_NAME_RE.test(value);
}

export function isReservedApiKeyEntityName(entityName: string): boolean {
  return RESERVED_API_KEY_ENTITIES.has(entityName);
}

export function isValidApiKeyRole(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_ROLE_RE.test(value);
}

function apiKeyExpiresAtMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

// Build an apiKey principal resolver from a Bearer token. Reads the
// `Authorization: Bearer <token>` header, hashes the token, looks up the ApiKey
// row by tokenHash, checks expiration, and returns an apiKey principal.
// Any failure — no header, no matching row, expired, malformed timestamp, or
// malformed/unscoped scope attributes — yields `anonymous` (fail closed). The
// resolution runs through the SAME authorization engine as session principals
// — no second auth path.
export function apiKeyPrincipalOf(db: SqlDb): (req: RequestLike) => Principal {
  return (req) => {
    const auth = (req.headers?.authorization ?? '').trim();
    if (!auth) return anonymous;
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return anonymous;
    const token = match[1];
    if (!token) return anonymous;
    try {
      const tokenHash = sha256hex(token);
      const row = db.prepare('SELECT * FROM ApiKey WHERE tokenHash = ? LIMIT 1').get(tokenHash) as ApiKeyRow | null | undefined;
      if (!row || typeof row.id !== 'string' || row.id.length === 0) return anonymous;
      // Expiration: an expired or malformed expiresAt fails closed to anonymous
      // (a non-numeric string would otherwise compare false against Date.now()).
      if (row.expiresAt != null) {
        const expiresAt = apiKeyExpiresAtMs(row.expiresAt);
        const checkedAt = Date.now();
        if (expiresAt === null || !Number.isFinite(checkedAt) || expiresAt <= checkedAt) {
          return anonymous;
        }
      }
      // Validate stored scope/role attributes fail-closed so corrupt or forged
      // rows cannot inject malformed identifiers, framework entities, or an
      // unscoped role onto principal.attributes.
      let entityName: string | undefined;
      if (row.entityName != null) {
        if (!isValidApiKeyEntityName(row.entityName) || isReservedApiKeyEntityName(row.entityName)) {
          return anonymous;
        }
        entityName = row.entityName;
      }
      let role: string | undefined;
      if (row.role != null) {
        if (!isValidApiKeyRole(row.role) || entityName === undefined) {
          return anonymous;
        }
        role = row.role;
      }
      return principal({
        type: 'apiKey',
        id: row.id,
        attributes: {
          entityName,
          role,
        },
      });
    } catch {
      return anonymous;
    }
  };
}

// The ApiKey row projected by the Bearer lookup. `expiresAt` is an epoch-ms
// value the driver may store as a number or a numeric string; comparing it here
// keeps a corrupt value from granting admission.
interface ApiKeyRow {
  id?: string | null;
  expiresAt?: unknown;
  entityName?: string | null;
  role?: string | null;
}
