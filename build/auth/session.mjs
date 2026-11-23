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

import { principal, anonymous, isPrincipalStatus,                                                          } from '../principal.mjs';
import { config } from '../config.mjs';
import { createHash } from 'node:crypto';

// The minimal request shape session hydration reads: the raw `Cookie` header
// (node:http exposes the string) and the `Authorization` header for Bearer keys.
// The transport types the full request; this is the fail-closed subset.




// The SQLite statement/db surface session hydration uses. The concrete driver
// (better-sqlite3-shaped) satisfies this structurally; a broken db still fails
// closed because every lookup happens inside the try/catch below.










// The Session row projected by the hydration lookup. `type` is validated by
// principal() against the closed union; `createdAt` is validated by
// sessionCreatedAtMs; `status` (when the table exposes it) is validated by
// principal() against the closed status union. A corrupt stored row therefore
// resolves to anonymous.







function sha256hex(s        )         {
  return createHash('sha256').update(s).digest('hex');
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

// Hash an opaque session token before storing in `Session.token` or querying
// against it. Storing only SHA-256 digests prevents a read-only DB compromise
// from yielding usable session cookies.
export function hashSessionToken(token        )         {
  return sha256hex(token);
}

// The session cookie name. The cookie value is an opaque token; it never carries
// identity, only a key into the Session table.
export const SESSION_COOKIE = 'sid';

// Parse a raw `Cookie` request header (`name=value; name2=value2`) into a
// name→value map. Values are url-decoded. A missing/empty header is an empty map.
// Zero-dependency: node:http exposes the raw header string, nothing parses it.
// Malformed percent-escapes are skipped (fail closed) — never throw 500 (cso M1).
export function parseCookies(header                           )                         {
  const cookies                         = {};
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










// Build the `Set-Cookie` header value for a session token. Fail-closed defaults:
// HttpOnly (never readable by client JS), SameSite=Lax (CSRF-resistant), Secure
// (TLS-only), Path=/. `secure` may be dropped for a non-TLS context (local dev /
// tests over plain http); HttpOnly and SameSite are never dropped.
// cso M2: In production, secure:false is refused — tokens must be TLS-only.
export function sessionCookie(
  token        ,
  { secure = true, env = config.env, maxAge, ttlMs }                       = {},
)         {
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
export function sessionTokenOf(req             )                     {
  const header = req.headers?.cookie;
  if (!header) return undefined;
  let count = 0;
  let value                    ;
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

function sessionCreatedAtMs(value         )                {
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
export function sessionPrincipalOf(db       , { durationMs = config.sessionDurationMs, now = Date.now }                                              = {})                                  {
  // A Session table may or may not have a `status` column yet (downstream
  // tickets add it for revoked/disabled sessions). Probe ONCE at construction:
  // a table WITHOUT the column keeps resolving exactly as before (existing
  // deployments), while a table WITH it threads status into the principal.
  // Fail closed — a probe failure just means no status column, and a corrupt
  // stored status is still rejected by principal()'s closed-union check
  // (→ anonymous).
  let hasStatusColumn = false;
  try {
    db.prepare('SELECT status FROM Session LIMIT 0');
    hasStatusColumn = true;
  } catch {
    hasStatusColumn = false;
  }
  const select = hasStatusColumn
    ? 'SELECT principalType AS type, principalId AS id, createdAt, status FROM Session WHERE token = ?'
    : 'SELECT principalType AS type, principalId AS id, createdAt FROM Session WHERE token = ?';

  return (req) => {
    const token = sessionTokenOf(req);
    if (!token) return anonymous;
    try {
      // The lookup is prepared per request rather than at construction so a
      // broken db fails CLOSED (anonymous) on each request instead of throwing at
      // listen time. The identity comes entirely from the server-side Session
      // row; the client supplied only the token. principal() re-validates the
      // closed type union, so a corrupt stored type is anonymous too.
      //
      // Look up by SHA-256 hash first (the canonical at-rest representation
      // written by Session.create). Fall back to a raw lookup ONLY when the
      // incoming token is not itself a 64-hex SHA-256 digest — this preserves
      // legacy/test fixtures that insert short plaintext tokens directly while
      // ensuring a stolen Session.token hash from a DB dump can never be
      // replayed as a cookie.
      const stmt = db.prepare(select);
      const tokenHash = hashSessionToken(token);
      let row = stmt.get(tokenHash)                                 ;
      if (!row && !SHA256_HEX_RE.test(token)) {
        row = stmt.get(token)                                 ;
      }
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
      const attributes = row.type === 'link' ? { token: row.id } : {};
      // Thread the stored status when present; principal() defaults to 'active'.
      // The DB cell is an `unknown` — narrow it through the closed-union guard
      // (never a bare assertion). SQL NULL / absent cell → no status → the
      // 'active' default applies; a present-but-corrupt status fails closed
      // (→ anonymous), exactly as principal()'s own closed-union check did.
      let storedStatus                             ;
      if (row.status != null) {
        if (!isPrincipalStatus(row.status)) return anonymous;
        storedStatus = row.status;
      }
      return principal({ type: row.type, id: row.id, attributes, status: storedStatus });
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

export function isValidApiKeyEntityName(value         )                  {
  return typeof value === 'string' && API_KEY_ENTITY_NAME_RE.test(value);
}

export function isReservedApiKeyEntityName(entityName        )          {
  return RESERVED_API_KEY_ENTITIES.has(entityName);
}

export function isValidApiKeyRole(value         )                  {
  return typeof value === 'string' && API_KEY_ROLE_RE.test(value);
}

function apiKeyExpiresAtMs(value         )                {
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
export function apiKeyPrincipalOf(db       )                                  {
  return (req) => {
    const auth = (req.headers?.authorization ?? '').trim();
    if (!auth) return anonymous;
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return anonymous;
    const token = match[1];
    if (!token) return anonymous;
    try {
      const tokenHash = sha256hex(token);
      const row = db.prepare('SELECT * FROM ApiKey WHERE tokenHash = ? LIMIT 1').get(tokenHash)                                ;
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
      let entityName                    ;
      if (row.entityName != null) {
        if (!isValidApiKeyEntityName(row.entityName) || isReservedApiKeyEntityName(row.entityName)) {
          return anonymous;
        }
        entityName = row.entityName;
      }
      let role                    ;
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






