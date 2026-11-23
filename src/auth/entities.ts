// The framework-provided auth entities: User, Session, Credential, and Inbox.
//
// session.mjs (the binding exemplar) imports these FROM the framework rather than
// declaring them, because authentication is the framework's concern, not the
// app's: the app should not have to hand-roll a user table, a password digest, or
// the session→principal mapping the request pipeline already depends on.
//
//   - User  — username + a one-way hash() password. Served by the generic query
//             API: User.findOne(User.username.is(name)), User.create({...}),
//             user.password.verify(pw), User.findAll().select(...), getOrFail(id).
//   - Session — the minted capability record the request pipeline reads to build
//             a principal. sessionPrincipalOf runs
//             `SELECT principalType, principalId FROM Session WHERE token = ?`,
//             so Session's STORED row is (token, principalType, principalId).
//
// Both carry a fail-closed grant: they are never mounted as request-facing
// entity-CRUD (the exemplar mounts /users and /sessions as imperative routers),
// so their read-scope grants nothing — `never()`/`deny`. The auth layer reaches
// them only through the UNSCOPED, trusted query API, never a request path.

import { randomBytes, createHash } from 'node:crypto';
import { entity } from '../entity/compile.ts';
import { text, hash, ref, date, number } from '../field.ts';
import { scope, type RuntimeGrantClause } from '../scope.ts';
import { never } from '../scope-sql.ts';
import { grant, deny, read, write, subscribe } from '../grant.ts';
import { schedule, schedulerSource } from '../schedule.ts';
import { config } from '../config.ts';
import { generateSecret, generateBackupCodes } from './totp.ts';
import { hashSessionToken } from './session.ts';
import type { Principal } from '../principal.ts';

// The check-execution context the grant `.can` bodies and `checks` functions
// receive: `is` runs a named check and resolves its boolean result. The scope
// predicate half (compiled to SQL) is never awaited; the `.can` half is.
interface IsContext {
  is: Record<string, () => Promise<unknown>>;
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// A framework auth entity is never request-readable: its rows are reached only
// by trusted server code (login lookup, principal hydration), never dispatched
// to a request principal. The most fail-closed valid grant: a never() scope (no
// row is request-visible) whose .can denies every capability.
const notRequestReadable = (which: string): RuntimeGrantClause =>
  scope(() => never()).can(() =>
    deny(`${which} is a framework auth entity, reached only by trusted server ` +
      `code (the unscoped query API), never request-dispatched`));

export const User = entity('User', {
    username: text(),
  password: hash(),
  // Optional profile fields. Apps that need richer identity (e.g. Scope) populate
  // these; apps that only need username+password leave them null. The login route
  // and session/membership layers read only username/password/id, so adding fields
  // here is backward-compatible — existing consumers and tests are unaffected.
  email: text({ optional: true }),
  displayName: text({ optional: true }),
  name: text({ optional: true }),
  image: text({ optional: true }),
  phone: text({ optional: true }),
  bio: text({ optional: true }),

  // Account lockout: `failedLoginAttempts` and `lockedUntil` (epoch ms, null when
  // not locked) are a framework-maintained rate-limit fence on the login route.
  // They are NOT request-visible and never exposed through the entity query API.
  // The login handler checks and updates them; the lockout logic is a pure
  // function in auth/lockout.mjs for testability without standing up HTTP.
  failedLoginAttempts: number({ optional: true }),
           lockedUntil: number({ optional: true }),

  grant: () => [notRequestReadable('User')],
});

const SessionCreatedAt = date();
const sessionExpiryTrigger = schedule.after(SessionCreatedAt, config.sessionDurationMs, { key: 'expiry' });
const sessionExpirySchedulerSource = schedulerSource('Session', 'remove', sessionExpiryTrigger.key!);

// The two session intents are a CLOSED set, each a named whole mapped to the one
// canonical stored row { token, principalType, principalId, createdAt }:
//   - { userId }            -> a user session   (principalType 'user', principalId = userId)
//   - { kind: 'link', token } -> a link session (principalType 'link', principalId = the share token)
// The minted `token` is a fresh, unguessable SESSION token (distinct from a
// link's share token). Anything else is rejected — fail closed. This create
// policy mints server-side cells it owns, so it does not run validateMutation;
// it composes the entity's trusted `insert` core (one write path).
interface SessionMintContext {
  insert(payload: Record<string, unknown>): unknown;
  mintToken(): string;
}

interface SessionPayload {
  userId?: unknown;
  kind?: string;
  token?: unknown;
}

function mintSession(payload: SessionPayload | null | undefined, { insert, mintToken }: SessionMintContext): unknown {
  const plainToken = mintToken();
  const tokenHash = hashSessionToken(plainToken);
  const now = Date.now();
  if (payload && typeof payload.userId !== 'undefined') {
    const row = insert({ token: tokenHash, principalType: 'user', principalId: String(payload.userId), createdAt: now }) as Record<string, unknown>;
    // Return the plain opaque token ONCE for the Set-Cookie header; only the
    // SHA-256 digest is persisted in `Session.token`.
    return { ...row, token: plainToken };
  }
  if (payload && payload.kind === 'link' && typeof payload.token !== 'undefined') {
    // The link principal carries WHICH share granted it: the incoming share
    // token (the grant identity), not the doc id. A fresh session token is minted
    // for the cookie; the share token becomes the principal id.
    const row = insert({ token: tokenHash, principalType: 'link', principalId: String(payload.token), createdAt: now }) as Record<string, unknown>;
    return { ...row, token: plainToken };
  }
  throw new Error(
    `Session.create accepts a closed set of session intents: { userId } for a ` +
      `user session or { kind: 'link', token } for a link session. Received ` +
      `${JSON.stringify(payload)} (fail closed).`,
  );
}

export const Session = entity('Session', {
  // The stored cells are framework-owned and readonly: an app never writes them
  // by hand; the create policy mints them. Declaring them keeps the table schema
  // typed and inspectable (Session.token.is(...) is a first-class handle).
    token: text({ readonly: true }),
  principalType: text({ readonly: true }),
  principalId: text({ readonly: true }),
  createdAt: SessionCreatedAt,

  checks: {
    // This is the sole normal-grant allowance for this otherwise private entity.
    // The source is derived from its declared remove schedule, and durable
    // beforeProjection admission still rechecks its row, due time, and payload.
    expiryReaper: ({ principal }: { principal?: Principal | null }) =>
      principal?.type === 'system' && principal.attributes?.source === sessionExpirySchedulerSource,
  },
  grant: () => [scope(() => never()).can(async ({ is }: IsContext) =>
    (await is.expiryReaper())
      ? grant(write)
      : deny('Session is a framework auth entity, reached only by trusted server code or its declared expiry scheduler'))],
  create: mintSession,
  // Request-time sessionPrincipalOf invalidates expired rows; this schedule
  // only reclaims their storage.
  schedule: {
    remove: sessionExpiryTrigger,
  },
});

// Inbox — the framework's per-user notification store. An app projects rows into
// it via a declared effect (doc.mjs: when a collaborator is added to a Doc, a row
// is created with { recipient: delta.member, doc: entity.id, kind: 'invite' }),
// and a user reads their OWN inbox. Like User/Session it is the framework's
// concern (every collaborative app needs the same per-user notification shape),
// imported FROM workbench, never app-declared.
//
//   - recipient — a User ref carrying the `recipient` role, so the entity
//                 compiler derives is.recipient() and the grant's scope compiles
//                 to `t0.recipient = :principalId`: a user reads ONLY their own
//                 inbox rows (recipient-scoped, fail-closed default-on).
//   - doc       — the Doc the notification is about (a typed FK).
//   - kind      — the notification kind ('invite', ...): a plain text facet.
//
// The grant's SCOPE filters rows to the recipient (compiled to SQL, never run as
// JS, so its is.recipient() is correctly un-awaited); the .can body then confers
// read + subscribe on those already-recipient-scoped rows (a one-shot REST fetch
// and a sustained WS push of new notifications). It needs no is.* call — the row
// is already the principal's own — so it is trivially guard-clean.
export const Inbox = entity('Inbox', {
    recipient: ref('User', { role: 'recipient' }),
  doc: ref('Doc'),
  kind: text(),

  checks: {
    // Effect principals are minted only by the effect compiler after the target's
    // admitsEffects handshake succeeds. Inbox is itself an effect sink, so its
    // row grant must confer the write capability required by the canonical
    // create admission pass; ordinary recipients remain read/subscribe-only.
    effectMutation: ({ principal }: { principal?: Principal | null }) =>
      principal?.type === 'system' && typeof principal.attributes?.effect === 'string',
  },
  grant: () => [scope(({ is }: IsContext) => is.recipient()).can(async ({ is }: IsContext) =>
    (await is.effectMutation()) ? grant(write) : grant(read, subscribe))],
  // Inbox EXISTS to receive projected notifications from other entities' effects
  // (e.g. Doc's collaboratorAdded → Inbox invite row). It admits effect
  // principals — the effect is already bounded to its declared `with` template,
  // and the recipient read-scope above still gates WHO may read a row. Admitting
  // the effect principal here is the target's opt-in to the effect (ADR #6).
  admitsEffects: () => true,
});

// Credential — a WebAuthn passkey stored by the framework. Each Credential row
// binds one authenticator's public key to a User. The authenticator holds the
// private key; the server stores the public key (DER/SubjectPublicKeyInfo,
// base64url-encoded) and verifies assertions.
//
// Like User/Session, Credential is not request-readable: it is reached only by
// the trusted auth routes (passkey register/authenticate), never exposed through
// the request-facing CRUD API. The public key is stored as a base64url string
// — it is never transmitted to any request principal through the entity API.
//
// Fields:
//   - credentialId — the authenticator's credential ID, base64url-encoded (unique).
//   - publicKey    — the public key (DER/SPKI, base64url), used to verify assertions.
//   - userId       — the User this credential authenticates (a typed FK, not
//                    request-visible).
//   - signCount    — the last-seen counter from the authenticator (replay protection).
//   - name         — a human-readable device label (from the RP).
//   - transports   — comma-separated transport hints (e.g. "internal,hybrid").
//   - backedUp     — 1 if the credential is synced (multi-device), 0 if single-device.
//   - createdAt    — timestamp of enrollment.
// Invitation — the framework's generic invitation flow. An invitation grants
// membership on a target entity to the accepting user. Two modes:
//
//   - Link invitation (targetUser is null): anyone with the token can accept.
//     Tracked by maxUses (optional cap) and useCount.
//   - Direct invitation (targetUser is set to a User ref): a specific user is
//     invited. On accept, the invitation row is removed — one-time use.
//
// Like User/Session/Credential, Invitation is not request-readable: it is
// reached only by the trusted auth routes (create/accept/reject/list), never
// exposed through the entity CRUD API. The token is auto-generated by the
// create policy (32 random bytes, base64url) if none is provided.
//
// Fields:
//   - token        — the share token (auto-generated, unique)
//   - targetEntity — which entity this grants access to (e.g. 'Project')
//   - targetId     — which row on that entity (e.g. 'p1')
//   - role         — the membership role to grant (e.g. 'member')
//   - targetUser   — the invited user (null = open link)
//   - maxUses      — max accept count for link invites (null = unlimited)
//   - useCount     — current accept count
//   - expiresAt    — epoch ms expiration (null = never)
//   - createdBy    — the User who created this invitation
//   - createdAt    — timestamp

interface InsertContext {
  insert(payload: Record<string, unknown>): unknown;
}

interface InvitationPayload {
  token?: string;
  targetEntity: string;
  targetId: string;
  role: string;
  targetUser?: unknown;
  maxUses?: unknown;
  expiresAt?: unknown;
  createdBy: unknown;
}

function mintInvitation(payload: InvitationPayload, { insert }: InsertContext): unknown {
  const token = payload.token || randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  return insert({
    token,
    targetEntity: payload.targetEntity,
    targetId: payload.targetId,
    role: payload.role,
    targetUser: payload.targetUser ?? null,
    maxUses: payload.maxUses ?? null,
    useCount: 0,
    expiresAt: payload.expiresAt ?? null,
    createdBy: payload.createdBy,
    createdAt: now,
  });
}

export const Invitation = entity('Invitation', {
          token: text(),
    targetEntity: text(),
        targetId: text(),
            role: text(),
      targetUser: ref('User'),
         maxUses: number(),
        useCount: number(),
       expiresAt: number(),
       createdBy: ref('User'),
       createdAt: date(),

  grant: () => [notRequestReadable('Invitation')],
  create: mintInvitation,
});

export const Credential = entity('Credential', {
      credentialId: text(),
          publicKey: text(),
            userId: ref('User'),
         signCount: number(),
              name: text(),
        transports: text(),
          backedUp: number(),
         createdAt: date(),

  grant: () => [notRequestReadable('Credential')],
});

// ApiKey — a project-scoped bearer-token principal. An ApiKey mints a random
// 32-byte token (base64url), stores only its SHA-256 hash, and exposes the plain
// token ONCE at creation time. The prefix (first 8 chars of the plain token) is
// stored for display. The key resolves to an apiKey principal through the SAME
// authorization engine as user principals — no second auth path.
//
// Like User/Session/Credential/Invitation, ApiKey is not request-readable: it is
// reached only by trusted server code (the Bearer resolution in session.mjs and
// the creation/revocation routes in auth-routes.mjs).
//
// Fields:
//   - tokenHash  — SHA-256 hex digest of the plain token (never stored in plaintext)
//   - prefix     — first 8 base64url chars of the plain token (for display)
//   - name       — a human-readable label for the key
//   - entityName — optional scope: which entity this key is scoped to
//   - role       — optional capabilities role the key confers
//   - createdBy  — the User who created this key
//   - expiresAt  — optional epoch ms expiration
//   - createdAt  — timestamp of creation
interface ApiKeyPayload {
  name: string;
  entityName?: unknown;
  role?: unknown;
  createdBy: unknown;
  expiresAt?: unknown;
}

function mintApiKey(payload: ApiKeyPayload, { insert }: InsertContext): unknown {
  const plainToken = randomBytes(32).toString('base64url');
  const tokenHash = sha256hex(plainToken);
  const prefix = plainToken.slice(0, 8);
  const now = new Date().toISOString();
  const row = insert({
    tokenHash,
    prefix,
    name: payload.name,
    entityName: payload.entityName ?? null,
    role: payload.role ?? null,
    createdBy: payload.createdBy,
    expiresAt: payload.expiresAt ?? null,
    createdAt: now,
  }) as Record<string, unknown>;
  // The plain token is returned ONCE alongside the row and never stored.
  return { ...row, plainToken };
}

export const ApiKey = entity('ApiKey', {
      tokenHash: text(),
         prefix: text(),
           name: text(),
     entityName: text(),
           role: text(),
      createdBy: ref('User'),
      expiresAt: number(),
      createdAt: date(),

  grant: () => [notRequestReadable('ApiKey')],
  create: mintApiKey,
});

// TwoFactor — TOTP two-factor authentication. One enrollment per user (userId is
// unique). The secret is base32-encoded (RFC 4648, no padding), stored readonly
// so it is never exposed through request paths. Backup codes are stored as a JSON
// array of SHA-256 hashes — the plain codes are returned ONCE at enrollment time
// and never stored.
//
// enabled: 0 = enrolled but not verified yet (first successful verify sets it to 1)
// verifiedAt: set on the first successful TOTP verification after enrollment
//
// Like User/Session/Credential/Invitation/ApiKey, TwoFactor is not
// request-readable: it is reached only by trusted server code (the auth routes),
// never exposed through the entity CRUD API.
interface TotpPayload {
  username: string;
  userId: unknown;
  issuer?: string;
}

function enrollTotp(payload: TotpPayload, { insert }: InsertContext): unknown {
  const { secret, uri } = generateSecret(payload.username, payload.issuer);
  const { plainCodes, hashedCodes } = generateBackupCodes(8);
  const row = insert({
    userId: payload.userId,
    secret,
    backupCodes: JSON.stringify(hashedCodes),
    enabled: 0,
    verifiedAt: null,
  }) as Record<string, unknown>;
  return { ...row, secret, uri, backupCodes: plainCodes };
}

export const TwoFactor = entity('TwoFactor', {
       userId: ref('User'),
        secret: text({ readonly: true }),
   backupCodes: text({ readonly: true }),
       enabled: number(),
    verifiedAt: date(),
  // TOTP attempt lockout: `totpFailedAttempts` and `totpLockedUntil` (epoch ms,
  // null when not locked) gate the TOTP verification routes. The lockout is
  // per-user, applies to TOTP tokens only (not backup codes), and resets on
  // successful TOTP verification. The lockout logic is a pure function in
  // auth/lockout.mjs for testability without standing up HTTP.
  totpFailedAttempts: number({ optional: true }),
     totpLockedUntil: number({ optional: true }),
     lastTotpCounter: number({ optional: true }),

  grant: () => [notRequestReadable('TwoFactor')],
  create: enrollTotp,
});
