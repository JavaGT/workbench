// The framework-owned auth battery — the routes `projects/session.mjs` hand-rolls,
// PLUS the Set-Cookie handling that sample omits (the 0→1 auth bug: a client
// following the exemplar is anonymous on every subsequent request because
// `sessionPrincipalOf` reads ONLY the cookie the exemplar never sets).
//
// `.auth()` mounts this router at `/auth`. Auth is the framework's concern, not
// the app's (`auth-entities.mjs:5-7`); following that argument to its conclusion
// means the framework provides the *routes*, not just the entities. The routes
// are built from the SAME public primitives an app would use to write its own
// (`router`, `allowAnonymous`, `User`, `Session`, `sessionCookie`) — there is no
// private second auth path here. An app that needs bespoke login behavior mounts
// its own router instead; this is the smooth default.
//
// The token travels in the fail-closed `sid` cookie, never the JSON body. The
// cookie is HttpOnly (never readable by client JS), SameSite=Lax (CSRF-resistant),
// Path=/, and Secure only in production — plain-http local dev must work, so
// `secure` follows `config.env` (sessionCookie refuses secure:false in
// production, so the dev drop is the only non-TLS path and it cannot leak into
// prod). Login/link mint a principal, so they `allowAnonymous()`; logout inherits
// the default-on `requireUser` gate — you cannot log out a session you don't have.
//
// Passkey (WebAuthn) routes: challenge issue/verify, credential registration,
// assertion verification → session minting, credential list/delete. The ceremony
// split: workbench owns challenge issue/verify + credential storage; the app owns
// the UI (button, prompt, error display).

import { randomBytes, randomUUID } from 'node:crypto';
import { router } from '../app.mjs';
import { admin } from '../grant.mjs';
import { allowAnonymous, requireUser } from '../route-gate.mjs';
import { rowCapabilities } from '../row-grant.mjs';
import { createInvitationApi } from './invitation.mjs';
import {
  sessionCookie,
  sessionTokenOf,
  hashSessionToken,
  sessionRowResolver,
  DEFAULT_SESSION_DURATION_MS,
  SESSION_COOKIE,
  isValidApiKeyEntityName,
  isReservedApiKeyEntityName,
  isValidApiKeyRole,
} from './session.mjs';
import { config,                      } from '../config.mjs';
import { verifyTotpStep, verifyBackupCode } from './totp.mjs';
import { loginChallengeStore as defaultLoginChallengeStore, createLoginChallengeStore } from './login-challenge.mjs';
import { evaluateLockout, nextFailedAttemptCount, loginLockoutDecision, totpLockoutDecision } from './lockout.mjs';
import { txn, begin, commit, rollback,               } from '../driver.mjs';
import { writeQueueForDatabase } from '../pipeline.mjs';
import { hashPasswordAsync, verifyHashAsync } from '../field-strategy.mjs';
import {
  generateChallenge,
  challengeStore as defaultPasskeyChallengeStore,
  createChallengeStore,
  verifyRegistration,
  verifyAuthentication,
  rpConfig,
  parseClientDataJSON,

} from './passkey.mjs';




// ---- Structural types --------------------------------------------------------
// The router's handler chain dispatches `(req, res, next)` where req carries the
// parsed body/params/query and the server-side principal (http-handler-chain.mjs),
// res is the response facade, and next forwards an error to the error renderer.
// The entity facades (User, Session, ...) are compiled bindings from the untyped
// entity layer, so they stay `any`; the request surface is pinned here.
























































function declaredEntityRoles(target                    )              {
  const roles = new Set        ();
  for (const descriptor of Object.values(target.fields ?? {})) {
    if (descriptor?.type === 'ref' && typeof descriptor.role === 'string') {
      roles.add(descriptor.role);
    }
    if (descriptor?.kind === 'store' && descriptor.type === 'map' && Array.isArray(descriptor.roles)) {
      for (const r of descriptor.roles) {
        if (typeof r === 'string') roles.add(r);
      }
    }
  }
  for (const checkName of Object.keys(target.registry ?? {})) {
    roles.add(checkName);
  }
  return roles;
}

async function authorizeScopedApiKey({
  target,
  role,
  principal,
  db,
}




 )                                                                            {
  if (
    !isValidApiKeyEntityName(target.name)
    || typeof target.scopeFilter !== 'function'
    || typeof target.deserializeRow !== 'function'
  ) {
    return { ok: false, status: 403, message: `not authorized to create an API key for entity '${target.name}'` };
  }
  let storedRows                           ;
  try {
    const { sql: where, params: scopeParams } = target.scopeFilter(principal);
    storedRows = db.prepare(`SELECT * FROM ${target.name} AS t0 WHERE ${where}`).all(scopeParams)                             ;
  } catch {
    return { ok: false, status: 403, message: `not authorized to create an API key for entity '${target.name}'` };
  }
  let hasAdmin = false;
  const adminCapabilities = new Set        ();
  for (const storedRow of storedRows) {
    try {
      const row = target.deserializeRow({ ...storedRow });
      const decision = await rowCapabilities(target                                         , row, principal);
      if (decision.granted && decision.capabilities.includes(admin)) {
        hasAdmin = true;
        for (const cap of decision.capabilities) {
          adminCapabilities.add(cap.capability);
        }
      }
    } catch {
      // Fail closed on any row whose grant evaluation throws.
    }
  }
  if (!hasAdmin) {
    return { ok: false, status: 403, message: `admin authority on '${target.name}' is required to create a scoped API key` };
  }
  if (role !== null) {
    const allowedRoles = declaredEntityRoles(target);
    if (!allowedRoles.has(role) && !adminCapabilities.has(role)) {
      return { ok: false, status: 400, message: `role '${role}' is not valid on '${target.name}'` };
    }
  }
  return { ok: true };
}

// The one platform write coordinator, structurally typed so an auth router
// mounted against a raw test db (no coordinator attached) keeps its existing
// synchronous behavior. In a running app `createServer` attaches this exact
// coordinator to the db handle, so `writeQueueForDatabase(db)` is the same
// mutex the kernel's BEGIN IMMEDIATE transactions use.













// A scrypt digest of a random password that was never stored anywhere: the
// login route verifies a miss against it so an unknown identity costs the same
// one async scrypt a known identity's wrong password costs (see the login route).
// The `scrypt:` prefix ensures the decoy check runs native scrypt once and
// never falls through to legacy better-auth scrypt.
const LOGIN_DECOY_HASH =
  'scrypt:57fe0f27ec0e50aae5f5a04d905cb5d5:9e2aeee12a38d92ff7d9c544c79e335c447e6c26390af3468ade7abc44390da2adc3fe72e0674c280b0d0f445284698372a45fe088fa18ac2b52e86abeb56947';

const DEFAULT_MIN_PASSWORD_LENGTH = 8;
const DEFAULT_PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const TOTP_REPLAY_TTL_MS = 120_000; // > 90s (±1 step) window
const TOTP_REPLAY_MAX_ENTRIES = 10_000;
const SAFE_SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseSessionCreatedAtMs(value         )                {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  if (typeof value !== 'string') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const ts = Number(value);
    return Number.isFinite(ts) ? ts : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

// Build the `/auth` router. `secure` follows the app env (true only in
// production) so the same fail-closed cookie attributes apply on login and
// logout, and plain-http dev works. The router is mounted at `/auth` by
// `app.auth()`; the paths below are the suffixes under that mount.
//
// `identifyBy` declares which User field(s) a login credential is matched
// against, in order. Defaults to `['username']` (the built-in shape). An app
// whose users log in by email passes `identifyBy: ['email', 'username']` so a
// posted credential is looked up by email first, then username. The credential
// always travels in the body's `username` slot (kept for backward
// compatibility); only the lookup columns change. Every named field MUST exist
// on the User entity — a typo fails closed at first login with a thrown lookup.
export function authRoutes({
  secure = config.env === 'production',
  identifyBy = ['username'],
  minimumPasswordLength,
  sessionDurationMs = DEFAULT_SESSION_DURATION_MS,
  totpIssuer = 'workbench',
  requireUserVerification = true,
  persistChallenges = false,
  passkeyChallengeStore: suppliedPasskeyStore,
  loginChallengeStore: suppliedLoginStore,
  emailSeam,
  app: emailApp,
  sendPasswordResetEmail,
  passwordResetTtlMs = DEFAULT_PASSWORD_RESET_TTL_MS,
  authorizeApiKey,
  entities,
  db: maybeDb,
}                    = {}) {
  if (!entities || !maybeDb) {
    throw new Error('authRoutes requires entities and db options');
  }
  // Bind the guarded driver to a const so the nested function declarations
  // below — which TypeScript does not narrow across their declaration
  // boundary — see a non-null, fully-typed handle.
  const db           = maybeDb;
  // Every auth write transaction enters through the one coordinator when the
  // db has one: an auth route must never slip a BEGIN IMMEDIATE between the
  // kernel's own transaction steps. Resolve at call time — `.auth()` mounts
  // before the kernel attaches its coordinator to the db handle on boot.
  // A nested call joins the current turn.
  function coordinate   (fn         )                 {
    const coordinator                                   =
      (db                                                          ).writeCoordinator ?? writeQueueForDatabase(db);
    return coordinator ? coordinator.run(fn) : fn();
  }
  const { User, Session, Credential, Invitation, ApiKey, TwoFactor } = entities;
  const { createInvitation, acceptInvitation, rejectInvitation, listInvitationsForUser } = createInvitationApi({ Invitation });
  const passkeyStore                 = suppliedPasskeyStore
    ?? (persistChallenges ? createChallengeStore({ db }) : defaultPasskeyChallengeStore);
  const activeLoginChallengeStore = suppliedLoginStore
    ?? (persistChallenges ? createLoginChallengeStore(undefined, undefined, undefined, { db }) : defaultLoginChallengeStore);
  const s = router();
  const identityFields = Array.isArray(identifyBy) && identifyBy.length > 0 ? identifyBy : ['username'];
  // Password length floor defaults to 8 characters; apps may raise it or pass 0
  // explicitly if they manage their own password policy upstream.
  const passwordFloor = minimumPasswordLength === undefined
    ? DEFAULT_MIN_PASSWORD_LENGTH
    : (Number.isInteger(minimumPasswordLength) && minimumPasswordLength > 0 ? minimumPasswordLength : 0);
  const resetTtlMs = typeof passwordResetTtlMs === 'number' && Number.isFinite(passwordResetTtlMs) && passwordResetTtlMs > 0
    ? passwordResetTtlMs
    : DEFAULT_PASSWORD_RESET_TTL_MS;

  let authIndexesEnsured = false;
  function ensureAuthIndexes()       {
    if (authIndexesEnsured) return;
    authIndexesEnsured = true;
    const statements = [
      'CREATE INDEX IF NOT EXISTS idx_User_email_lower ON User (lower(trim(email)))',
      'CREATE INDEX IF NOT EXISTS idx_User_username ON User (username)',
      'CREATE INDEX IF NOT EXISTS idx_Session_token ON Session (token)',
      'CREATE INDEX IF NOT EXISTS idx_Session_principal ON Session (principalType, principalId)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_Credential_credentialId ON Credential (credentialId)',
    ];
    for (const sql of statements) {
      try {
        db.prepare(sql).run();
      } catch {
        // Table or optional column may not exist in a partial test schema.
      }
    }
  }

  let passwordResetTableEnsured = false;
  function ensurePasswordResetTable()       {
    if (passwordResetTableEnsured) return;
    db.prepare(`
      CREATE TABLE IF NOT EXISTS _PasswordResetToken (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        tokenHash TEXT NOT NULL UNIQUE,
        expiresAt INTEGER NOT NULL,
        usedAt INTEGER,
        createdAt INTEGER NOT NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx__PasswordResetToken_userId ON _PasswordResetToken (userId)').run();
    passwordResetTableEnsured = true;
  }

  function passwordRefusal(password         )                                             {
    if (typeof password !== 'string') return { status: 400, message: 'password must be a string' };
    if (passwordFloor > 0 && password.length < passwordFloor) {
      return { status: 400, message: `password must be at least ${passwordFloor} characters` };
    }
    return null;
  }

  // Invitation response builder — shared by create and list routes.
  const INVITATION_FIELDS = ['token', 'targetEntity', 'targetId', 'role', 'targetUser', 'maxUses', 'useCount', 'expiresAt', 'createdBy', 'createdAt'];
  function invitationResponse(inv                            ) {
    return Object.fromEntries(INVITATION_FIELDS.map(f => [f, inv[f]]));
  }

  // Bounded TOTP replay guard: tracks `(userId, secret, counter)` entries for
  // 120s (> 90s ±1 window) in memory alongside the persistent `lastTotpCounter`
  // column on TwoFactor so replaying the same code within the validity window
  // is rejected.
  const totpReplayMap = new Map                ();

  function totpReplayKey(userId        , secret        , counter        )         {
    return `${userId}:${secret}:${counter}`;
  }

  function sweepTotpReplayMap(now        )       {
    for (const [key, expiresAt] of totpReplayMap) {
      if (expiresAt <= now) totpReplayMap.delete(key);
    }
  }

  function isTotpCounterReplayed(
    userId        ,
    twoFactor                                                     ,
    counter        ,
  )          {
    const now = Date.now();
    if (typeof twoFactor.lastTotpCounter === 'number' && counter <= twoFactor.lastTotpCounter) {
      return true;
    }
    const key = totpReplayKey(userId, twoFactor.secret, counter);
    const exp = totpReplayMap.get(key);
    if (exp !== undefined) {
      if (exp > now) return true;
      totpReplayMap.delete(key);
    }
    return false;
  }

  function recordTotpCounterMemory(userId        , secret        , counter        )       {
    const now = Date.now();
    if (totpReplayMap.size >= TOTP_REPLAY_MAX_ENTRIES) {
      sweepTotpReplayMap(now);
      for (const k of totpReplayMap.keys()) {
        if (totpReplayMap.size < TOTP_REPLAY_MAX_ENTRIES) break;
        totpReplayMap.delete(k);
      }
    }
    totpReplayMap.set(totpReplayKey(userId, secret, counter), now + TOTP_REPLAY_TTL_MS);
  }

  function persistTotpCounterDb(twoFactorId         , counter        )       {
    try {
      db.prepare('UPDATE TwoFactor SET lastTotpCounter = ? WHERE id = ?').run(counter, twoFactorId);
    } catch {
      // Legacy TwoFactor table without lastTotpCounter column — in-memory guard still applies.
    }
  }

  // TOTP backup-code verification helper — shared by disable and authenticate routes.
  function verifyTotpOrBackupCode(
    userId        ,
    twoFactor                                                                                  ,
    token        ,
  )                                                                                               {
    const backupCodes = JSON.parse(twoFactor.backupCodes || '[]');
    const stepResult = verifyTotpStep(twoFactor.secret, token);
    const isTotpValid = stepResult.valid
      && stepResult.counter !== null
      && !isTotpCounterReplayed(userId, twoFactor, stepResult.counter);
    const isBackupValid = verifyBackupCode(backupCodes, token);
    return {
      isValid: isTotpValid || isBackupValid,
      usedBackup: isBackupValid,
      totpCounter: isTotpValid ? stepResult.counter : null,
      backupCodes,
    };
  }

  // The shared outcome of settling one second-factor token (the disable and
  // authenticate routes each settle inside their own driver transaction):
  //   - 'ok'      — the token was valid; the TOTP fence was reset and a backup
  //                 code's removal (or TOTP replay step) was persisted in the
  //                 caller's transaction.
  //   - 'invalid' — a failed non-backup attempt; the failed-attempt/lockout
  //                 counters were advanced in the caller's transaction.
  //   - 'locked'  — the TOTP fence is active and the token is not a backup code;
  //                 nothing was written and the caller rejects with 429.





  // The ONE TOTP failed-attempt write, shared by authenticate/disable (via
  // settleSecondFactor) and by the verify route — a single normalization, not
  // three inline copies that can drift. A failed token advances the counter and
  // optionally arms a lock; an EXPIRED lock's stale timestamp is cleared along
  // with the restart so the series re-accumulates from 0 instead of instantly
  // relocking (or being frozen at 1 and never re-locking) on the next token.
  function recordTotpFailure(
    row                                                                                          ,
    resetAttempts         ,
  )       {
    const attempts = nextFailedAttemptCount(resetAttempts, row.totpFailedAttempts);
    const decision = totpLockoutDecision({ attempts });
    if (decision) {
      db.prepare('UPDATE TwoFactor SET totpFailedAttempts = ?, totpLockedUntil = ? WHERE id = ?')
        .run(attempts, decision.lockedUntil, row.id);
    } else {
      // Clearing the expired lock's stale timestamp along with the counter so
      // the row does not keep a dead lock after the series restarts.
      db.prepare('UPDATE TwoFactor SET totpFailedAttempts = ?, totpLockedUntil = ? WHERE id = ?')
        .run(attempts, resetAttempts ? null : row.totpLockedUntil, row.id);
    }
  }

  // Settle one second-factor token against the authoritative TwoFactor row,
  // INSIDE the caller's driver transaction (`txn`). Re-reading the persisted
  // backupCodes JSON under the write lock is what serializes concurrent
  // submissions of the same code: the second reader sees the code already
  // removed and rejects. A backup code is only removed here — never by a
  // read-only pre-check — so the removal commits atomically with the caller's
  // final write (a minted Session or a deleted enrollment).
  function settleSecondFactor(userId        , row     , token        )                      {
    const verdict = evaluateLockout(row.totpFailedAttempts, row.totpLockedUntil);
    const { isValid, usedBackup, totpCounter, backupCodes } = verifyTotpOrBackupCode(userId, row, token);
    // Only a backup code may lift an ACTIVE lock; a TOTP token — valid or not —
    // is rejected while the lock holds, and the failed-attempt counter is not
    // advanced (the lock itself already throttles).
    if (verdict.locked) {
      if (!usedBackup) {
        return { kind: 'locked', retryAfterMs: verdict.retryAfterMs };
      }
    }
    if (!isValid) {
      // Not locked here (an active lock rejected non-backup tokens above; an
      // expired lock leaves only the stale counter, which must not relock the
      // next invalid token instantly — it counts from 0 instead).
      recordTotpFailure(row, verdict.locked ? false : verdict.resetAttempts);
      return { kind: 'invalid' };
    }
    // Valid: clear the TOTP fence; a backup code's one-time consumption or
    // TOTP replay step is persisted here, inside the caller's transaction.
    db.prepare('UPDATE TwoFactor SET totpFailedAttempts = 0, totpLockedUntil = NULL WHERE id = ?')
      .run(row.id);
    if (usedBackup) {
      db.prepare('UPDATE TwoFactor SET backupCodes = ? WHERE id = ?')
        .run(JSON.stringify(backupCodes), row.id);
    } else if (totpCounter !== null) {
      persistTotpCounterDb(row.id, totpCounter);
    }
    return { kind: 'ok', usedBackup, totpCounter, secret: row.secret };
  }

  function rawPasswordOfUser(userId         )                {
    const row = db.prepare('SELECT password FROM User WHERE id = ?').get(userId)                                      ;
    return typeof row?.password === 'string' ? row.password : null;
  }

  function recordLoginFailure(
    user                                                                                   ,
    resetAttempts         ,
  )       {
    const attempts = nextFailedAttemptCount(resetAttempts, user.failedLoginAttempts);
    const decision = loginLockoutDecision({ attempts });
    if (decision) {
      db.prepare('UPDATE User SET failedLoginAttempts = ?, lockedUntil = ? WHERE id = ?')
        .run(attempts, decision.lockedUntil, user.id);
    } else {
      db.prepare('UPDATE User SET failedLoginAttempts = ?, lockedUntil = ? WHERE id = ?')
        .run(attempts, resetAttempts ? null : user.lockedUntil, user.id);
    }
  }

  function findIdentity(credential         , next          )                                                             {
    ensureAuthIndexes();
    for (const name of identityFields) {
      const field = User[name];
      if (!field) {
        next({ status: 500, message: `identifyBy references unknown User field '${name}'` });
        return { failed: true, user: null, rawPassword: null };
      }
      // Email is one identity regardless of case (#7602): perform a direct
      // indexed SQL lookup (LIMIT 2 to detect ambiguous case-variant duplicates)
      // rather than an O(N) full-table JS scan.
      if (name === 'email') {
        const typedEmail = typeof credential === 'string' ? credential.trim().toLowerCase() : '';
        if (typedEmail) {
          const matches = db.prepare(
            'SELECT * FROM User WHERE lower(trim(email)) = ? LIMIT 2',
          ).all(typedEmail)                             ;
          if (matches.length > 1) {
            next({ status: 409, message: 'This email matches more than one account; ask the server administrator to resolve it' });
            return { failed: true, user: null, rawPassword: null };
          }
          if (matches.length === 1) {
            const rawRow = matches[0];
            const rawPassword = typeof rawRow.password === 'string' ? rawRow.password : null;
            const user = typeof User.hydrate === 'function' ? User.hydrate({ ...rawRow }) : User.findById(rawRow.id);
            return { user, rawPassword, failed: false };
          }
        }
        continue;
      }
      const user = User.findOne(field.is(credential));
      if (user) {
        return { user, rawPassword: rawPasswordOfUser(user.id), failed: false };
      }
    }
    return { user: null, rawPassword: null, failed: false };
  }

  // Session rows resolve through the ONE session-resolution authority in
  // auth/session.ts — the same hashed-token lookup and legacy fallback the
  // request principal resolver uses. No second lookup path lives here.
  const resolveSessionRow = sessionRowResolver(db);
  function findSessionRowByToken(plainToken        )                                       {
    return resolveSessionRow(plainToken);
  }

  function revokeOtherSessions(userId         , req             )       {
    const currentToken = sessionTokenOf(req);
    const currentRow = currentToken ? findSessionRowByToken(currentToken) : null;
    if (currentRow && currentRow.principalType === 'user' && String(currentRow.principalId) === String(userId)) {
      db.prepare("DELETE FROM Session WHERE principalType = 'user' AND principalId = ? AND id != ?")
        .run(String(userId), currentRow.id);
    } else {
      db.prepare("DELETE FROM Session WHERE principalType = 'user' AND principalId = ?")
        .run(String(userId));
    }
  }

  function createSessionResponse(user                                  , res              ) {
    ensureAuthIndexes();
    const session = Session.create({ userId: user.id });
    res.setHeader('set-cookie', sessionCookie(session.token, { secure, ttlMs: sessionDurationMs }));
    res.status(201).json({ user: { id: user.id, username: user.username } });
  }

  // Registration and login are distinct principal-minting intents. Registration
  // creates exactly one identity; login never creates an unknown identity.
  s.post('/register', allowAnonymous(), async (req             , res              , next          ) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return next({ status: 400, message: 'username and password are required' });
    }
    const passwordProblem = passwordRefusal(password);
    if (passwordProblem) return next(passwordProblem);
    const found = findIdentity(username, next);
    if (found.failed) return;
    if (found.user) return next({ status: 409, message: 'account already exists' });
    const primaryField = identityFields[0];
    if (!SAFE_SQL_IDENT_RE.test(primaryField) || !User[primaryField]) {
      return next({ status: 500, message: `identifyBy references unknown User field '${primaryField}'` });
    }
    const hashedPassword = await hashPasswordAsync(password          );
    const id = randomUUID();
    db.prepare(`INSERT INTO User (id, ${primaryField}, password) VALUES (?, ?, ?)`)
      .run(id, String(username), hashedPassword);
    const user = User.getOrFail(id);
    createSessionResponse(user, res);
  });

  s.post('/login', allowAnonymous(), async (req             , res              , next          ) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return next({ status: 400, message: 'username and password are required' });
    }
    const found = findIdentity(username, next);
    if (found.failed) return;
    const user = found.user;
    if (!user) {
      // An unknown identity and a known one with a wrong password must be the
      // SAME answer, byte for byte and in the time it takes to arrive — the
      // login route is unauthenticated, so either difference is an account
      // enumeration oracle. `bad credentials` is that shared answer.
      //
      // The work is equalized too: a known identity pays one async scrypt in
      // `verifyHashAsync` below, so the miss pays one against a hash nobody
      // knows without blocking the event loop.
      await verifyHashAsync(password, LOGIN_DECOY_HASH);
      return next({ status: 401, message: 'bad credentials' });
    }
    {
      const verdict = evaluateLockout(user.failedLoginAttempts, user.lockedUntil);
      const passwordMatches = await verifyHashAsync(password, found.rawPassword);
      if (verdict.locked) {
        return next({ status: 401, message: 'bad credentials' });
      }
      if (!passwordMatches) {
        // Failed attempt: increment counter and optionally lock the account.
        recordLoginFailure(user, verdict.resetAttempts);
        return next({ status: 401, message: 'bad credentials' });
      }
      // Successful login: reset lockout counter.
      db.prepare('UPDATE User SET failedLoginAttempts = 0, lockedUntil = NULL WHERE id = ?')
        .run(user.id);
    }
    // Two-factor check: if the user has an enabled TOTP enrollment, do NOT mint a
    // session yet. Issue a pending-login challenge bound server-side to this user
    // and return it (alongside the userId for display/debug) so the client can
    // prompt for the TOTP token and call /auth/totp/authenticate to complete
    // authentication. The authenticate route derives the user from the challenge
    // — it never trusts a client-supplied userId — so a challenge is the proof
    // the caller passed this user's password.
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(user.id));
    if (twoFactor && twoFactor.enabled === 1) {
      const challenge = activeLoginChallengeStore.set(user.id);
      return res.json({ requiresTotp: true, challenge, userId: user.id });
    }
    createSessionResponse(user, res);
  });

  // logout: inherits the default-on `requireUser` gate, so a caller without a
  // valid session is denied at the gate before reaching here. Read the opaque
  // sid token from the cookie, delete that Session row (by SHA-256 hash), and
  // clear the cookie with the SAME attributes plus Max-Age=0 so the browser
  // drops it. 204.
  s.post('/logout', async (req             , res              ) => {
    const token = sessionTokenOf(req);
    if (token) {
      const row = findSessionRowByToken(token);
      if (row) Session.delete(row.id);
    }
    // Max-Age=0 expires the cookie immediately; the attributes match login so
    // the browser scopes the deletion to the same cookie (Path/Domain match).
    res.setHeader('set-cookie', sessionCookie('', { secure, maxAge: 0 }));
    res.sendStatus(204);
  });

  // GET /auth/sessions — list the current user's active sessions without
  // exposing stored token hashes.
  s.get('/sessions', requireUser(), (req             , res              , next          ) => {
    if (req.principal.type !== 'user') {
      return next({ status: 403, message: 'a user principal is required to list sessions' });
    }
    const currentToken = sessionTokenOf(req);
    const currentRow = currentToken ? findSessionRowByToken(currentToken) : null;
    const rows = db.prepare(
      "SELECT id, createdAt FROM Session WHERE principalType = 'user' AND principalId = ? ORDER BY createdAt DESC",
    ).all(String(req.principal.id))                                             ;
    const now = Date.now();
    const active = rows
      .filter((row) => {
        const createdAt = parseSessionCreatedAtMs(row.createdAt);
        return createdAt !== null && createdAt <= now && now - createdAt < sessionDurationMs;
      })
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        current: currentRow !== null && row.id === currentRow.id,
      }));
    res.json(active);
  });

  // DELETE /auth/sessions/:id — revoke one of the current user's sessions.
  s.delete('/sessions/:id', requireUser(), (req             , res              , next          ) => {
    if (req.principal.type !== 'user') {
      return next({ status: 403, message: 'a user principal is required to revoke a session' });
    }
    const { id } = req.params;
    const row = db.prepare(
      'SELECT id, principalType, principalId FROM Session WHERE id = ? LIMIT 1',
    ).get(id)                                                                          ;
    if (!row) {
      return next({ status: 404, message: 'session not found' });
    }
    if (row.principalType !== 'user' || String(row.principalId) !== String(req.principal.id)) {
      return next({ status: 403, message: 'not your session' });
    }
    const currentToken = sessionTokenOf(req);
    const currentRow = currentToken ? findSessionRowByToken(currentToken) : null;
    Session.delete(row.id);
    if (currentRow && currentRow.id === row.id) {
      res.setHeader('set-cookie', sessionCookie('', { secure, maxAge: 0 }));
    }
    res.sendStatus(204);
  });

  // GET /auth/me — return the authenticated user's public profile from the
  // active session. requireUser() rejects anonymous callers. The response
  // includes all User fields: id, username, email, displayName, name, image,
  // phone, bio. Null fields are omitted from the response.
  s.get('/me', requireUser(), (req             , res              ) => {
    const user = User.getOrFail(req.principal.id);
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        name: user.name,
        image: user.image,
        phone: user.phone,
        bio: user.bio,
      },
    });
  });

  // POST /auth/change-password — update the authenticated user's password.
  // requireUser(): only a valid session may change its own password. Verifies
  // the current password asynchronously against the stored hash before setting
  // the new one, and revokes all other active sessions for that user.
  // 204 on success; 400 if the body is incomplete, 401 if wrong current pw.
  s.post('/change-password', requireUser(), async (req             , res              , next          ) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) {
      return next({ status: 400, message: 'currentPassword and newPassword are required' });
    }
    const passwordProblem = passwordRefusal(newPassword);
    if (passwordProblem) return next(passwordProblem);
    const user = User.getOrFail(req.principal.id);
    const storedPassword = user ? rawPasswordOfUser(user.id) : null;
    if (!user || !(await verifyHashAsync(currentPassword, storedPassword))) {
      return next({ status: 401, message: 'current password is incorrect' });
    }
    const serialized = await hashPasswordAsync(newPassword          );
    db.prepare('UPDATE User SET password = ? WHERE id = ?').run(serialized, user.id);
    revokeOtherSessions(user.id, req);
    res.sendStatus(204);
  });

  // POST /auth/password-reset/request — issue a single-use expiring password
  // reset token (stored SHA-256 hashed) and deliver it via emailSeam when
  // configured. Always returns 200 { ok: true } to prevent account enumeration.
  s.post('/password-reset/request', allowAnonymous(), async (req             , res              , next          ) => {
    const identifier = req.body?.email ?? req.body?.username;
    if (typeof identifier !== 'string' || identifier.trim().length === 0) {
      return next({ status: 400, message: 'email or username is required' });
    }
    ensurePasswordResetTable();
    const found = findIdentity(identifier, next);
    if (found.failed) return;
    let user = found.user;
    if (!user && typeof req.body?.email === 'string' && !identityFields.includes('email')) {
      const normalized = req.body.email.trim().toLowerCase();
      const rows = db.prepare('SELECT * FROM User WHERE lower(trim(email)) = ? LIMIT 2')
        .all(normalized)                             ;
      if (rows.length === 1) {
        user = typeof User.hydrate === 'function' ? User.hydrate({ ...rows[0] }) : User.findById(rows[0].id);
      }
    }
    if (user) {
      const plainToken = randomBytes(32).toString('base64url');
      const tokenHash = hashSessionToken(plainToken);
      const now = Date.now();
      const expiresAt = now + resetTtlMs;
      db.prepare('DELETE FROM _PasswordResetToken WHERE userId = ? AND usedAt IS NULL').run(String(user.id));
      db.prepare(
        'INSERT INTO _PasswordResetToken (id, userId, tokenHash, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)',
      ).run(randomUUID(), String(user.id), tokenHash, expiresAt, now);

      const to = String(user.email || user.username || identifier);
      const emailPayload = {
        to,
        subject: 'Password reset',
        body: `Use this single-use token to reset your password: ${plainToken}`,
      };
      if (emailSeam) {
        try {
          if (emailApp?.jobs && typeof emailSeam.send === 'function') {
            emailSeam.send(emailApp, emailPayload);
          } else if (typeof emailSeam.transport === 'function') {
            await emailSeam.transport(emailPayload);
          }
        } catch {
          // Best-effort post-commit delivery; do not leak delivery failures.
        }
      }
      if (typeof sendPasswordResetEmail === 'function') {
        try {
          await sendPasswordResetEmail({
            user: { id: String(user.id), username: user.username ?? null, email: user.email ?? null },
            to,
            token: plainToken,
            expiresAt,
          });
        } catch {
          // Best-effort delivery; do not leak failures.
        }
      }
    }
    res.status(200).json({ ok: true });
  });

  // POST /auth/password-reset/confirm — validate and atomically consume a
  // single-use reset token, update the user's password asynchronously, clear
  // login lockout, and revoke all existing sessions for that user.
  s.post('/password-reset/confirm', allowAnonymous(), async (req             , res              , next          ) => {
    const token = req.body?.token;
    const newPassword = req.body?.newPassword ?? req.body?.password;
    if (typeof token !== 'string' || token.length === 0 || newPassword == null) {
      return next({ status: 400, message: 'token and newPassword are required' });
    }
    const passwordProblem = passwordRefusal(newPassword);
    if (passwordProblem) return next(passwordProblem);
    ensurePasswordResetTable();

    // Compute scrypt off the SQLite transaction to avoid holding the write lock.
    const hashedPassword = await hashPasswordAsync(newPassword          );
    const tokenHash = hashSessionToken(token);
    const now = Date.now();

    let outcome                          ;

    try {
      await coordinate(() => txn(db, () => {
        const row = db.prepare(
          'SELECT id, userId, expiresAt, usedAt FROM _PasswordResetToken WHERE tokenHash = ? LIMIT 1',
        ).get(tokenHash)                                                                                        ;
        if (!row || row.usedAt !== null || row.expiresAt <= now) {
          outcome = 'invalid';
          return;
        }
        const consumed = db.prepare(
          'UPDATE _PasswordResetToken SET usedAt = ? WHERE id = ? AND usedAt IS NULL',
        ).run(now, row.id);
        if (Number(consumed.changes) !== 1) {
          outcome = 'invalid';
          return;
        }
        db.prepare('UPDATE User SET password = ?, failedLoginAttempts = 0, lockedUntil = NULL WHERE id = ?')
          .run(hashedPassword, row.userId);
        db.prepare("DELETE FROM Session WHERE principalType = 'user' AND principalId = ?")
          .run(row.userId);
        outcome = 'ok';
      }));
    } catch (err) {
      const e = err                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }

    if (outcome !== 'ok') {
      return next({ status: 400, message: 'invalid or expired reset token' });
    }
    res.sendStatus(204);
  });

  // ---- Passkey (WebAuthn) routes -------------------------------------------

  const rp = rpConfig(config                                                                              );

  // GET /auth/passkey/challenge — issue a new challenge for a WebAuthn ceremony.
  // allowAnonymous: anyone may request a challenge (the ceremony itself proves
  // identity). Returns { challenge, rp: { name, id } }.
  s.get('/passkey/challenge', allowAnonymous(), (_req             , res              ) => {
    const challenge = generateChallenge();
    passkeyStore.set(challenge);
    res.json({ challenge, rp: { name: rp.name, id: rp.id } });
  });

  // POST /auth/passkey/register — enroll a new passkey credential.
  // requireUser: the caller must have an existing session (password login first,
  // then enroll passkey). The credential's userId is the requesting principal's
  // id — a passkey is always bound to the authenticated user who registered it.
  // Rejects duplicate credential IDs fail-closed (#245).
  s.post('/passkey/register', requireUser(), (req             , res              , next          ) => {
    ensureAuthIndexes();
    const credential = (req.body ?? {}).credential                                                               ;
    if (!credential || !credential.response?.clientDataJSON || !credential.response?.attestationObject) {
      return next({ status: 400, message: 'credential with clientDataJSON and attestationObject is required' });
    }

    // Extract and consume the challenge from clientDataJSON
    let clientData;
    try {
      clientData = parseClientDataJSON(credential.response.clientDataJSON);
    } catch (err) {
      const e = err                        ;
      return next({ status: 400, message: `invalid clientDataJSON: ${e.message}` });
    }
    const entry = passkeyStore.consume(String(clientData.challenge));
    if (!entry) {
      return next({ status: 400, message: 'unknown or expired challenge' });
    }

    let result;
    try {
      result = verifyRegistration(String(clientData.challenge), credential, rp);
    } catch (err) {
      const e = err                        ;
      return next({ status: 400, message: `registration failed: ${e.message}` });
    }

    // Reject duplicate credential IDs fail-closed (#245).
    const existing = Credential.findOne(Credential.credentialId.is(result.credentialId));
    if (existing) {
      return next({ status: 409, message: 'credential already registered' });
    }

    const userId = req.principal.id;
    // The browser's WebAuthn RegistrationResponseJSON carries no product/device
    // name; the RP's optional `name` is the only source of one (#231). Absent or
    // blank input stays ABSENT (SQL NULL) instead of becoming a fabricated
    // "Passkey" label that makes unrelated credentials indistinguishable; an
    // explicitly supplied name is stored trimmed, so a meaningful label
    // round-trips. Omitting the key (rather than binding null) is what leaves the
    // column NULL — a required-clear would be rejected by validateMutation.
    const suppliedName = typeof credential.name === 'string' ? credential.name.trim() : '';
    try {
      Credential.create({
        credentialId: result.credentialId,
        publicKey: result.publicKey,
        userId,
        signCount: result.signCount,
        ...(suppliedName.length > 0 ? { name: suppliedName } : {}),
        transports: Array.isArray(credential.transports) ? credential.transports.join(',') : '',
        backedUp: credential.backedUp ? 1 : 0,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      const e = err                        ;
      if (e.message && /unique/i.test(e.message)) {
        return next({ status: 409, message: 'credential already registered' });
      }
      return next({ status: 500, message: e.message });
    }
    res.status(201).json({ ok: true });
  });

  // POST /auth/passkey/authenticate — sign in with a passkey.
  // allowAnonymous: the caller proves identity by demonstrating possession of the
  // private key. Enforces User Verification (UV) by default and applies login
  // lockout to prevent brute-force / replay abuse. On successful verification,
  // the framework mints a Session and sets the `sid` cookie.
  s.post('/passkey/authenticate', allowAnonymous(), (req             , res              , next          ) => {
    ensureAuthIndexes();
    const credential = (req.body ?? {}).credential                                                                 ;
    if (!credential || !credential.response?.clientDataJSON || !credential.response?.authenticatorData || !credential.response?.signature) {
      return next({ status: 400, message: 'credential with clientDataJSON, authenticatorData, and signature is required' });
    }

    // Extract and consume the challenge from clientDataJSON
    let clientData;
    try {
      clientData = parseClientDataJSON(credential.response.clientDataJSON);
    } catch (err) {
      const e = err                        ;
      return next({ status: 400, message: `invalid clientDataJSON: ${e.message}` });
    }
    const entry = passkeyStore.consume(String(clientData.challenge));
    if (!entry) {
      return next({ status: 400, message: 'unknown or expired challenge' });
    }

    // Look up the stored credential by credentialId
    const credId = credential.id || credential.rawId;
    if (!credId) {
      return next({ status: 400, message: 'credential id is required' });
    }
    const storedCredential = Credential.findOne(Credential.credentialId.is(credId));
    if (!storedCredential) {
      return next({ status: 400, message: 'unknown credential' });
    }

    const user = User.getOrFail(storedCredential.userId);
    const verdict = evaluateLockout(user.failedLoginAttempts, user.lockedUntil);
    if (verdict.locked) {
      return next({ status: 401, message: 'bad credentials' });
    }

    let result;
    try {
      result = verifyAuthentication(String(clientData.challenge), credential, storedCredential, rp, {
        requireUserVerification,
      });
    } catch (err) {
      recordLoginFailure(user, verdict.resetAttempts);
      const e = err                        ;
      return next({ status: 401, message: `authentication failed: ${e.message}` });
    }

    // Successful authentication: reset lockout counter and update signCount.
    db.prepare('UPDATE User SET failedLoginAttempts = 0, lockedUntil = NULL WHERE id = ?').run(user.id);
    db.prepare('UPDATE Credential SET signCount = ? WHERE id = ?').run(result.signCount, storedCredential.id);

    const session = Session.create({ userId: user.id });
    res.setHeader('set-cookie', sessionCookie(session.token, { secure, ttlMs: sessionDurationMs }));
    res.status(201).json({ user: { id: user.id, username: user.username } });
  });

  // DELETE /auth/passkey/:credentialId — remove a passkey credential.
  // requireUser: only an authenticated user can remove their own credential.
  s.delete('/passkey/:credentialId', requireUser(), (req             , res              , next          ) => {
    const { credentialId } = req.params;
    const stored = Credential.findOne(Credential.credentialId.is(credentialId));
    if (!stored) {
      return next({ status: 404, message: 'credential not found' });
    }
    // Only the owning user can delete their credential
    if (String(stored.userId) !== String(req.principal.id)) {
      return next({ status: 403, message: 'not your credential' });
    }
    Credential.delete(stored.id);
    res.sendStatus(204);
  });

  // GET /auth/passkey — list the current user's passkey credentials.
  // requireUser: an anonymous caller cannot list credentials.
  s.get('/passkey', requireUser(), (req             , res              , next          ) => {
    const userId = req.principal.id;
    Credential.findAll(Credential.userId.is(userId))
      .sort(Credential.createdAt, 'desc')
      .then((rows       ) => {
        res.json(rows.map((c) => ({
          credentialId: c.credentialId,
          name: c.name,
          createdAt: c.createdAt,
          backedUp: c.backedUp,
          transports: c.transports ? c.transports.split(',').filter(Boolean) : [],
        })));
      }, (err         ) => next({ status: 500, message: (err                        ).message }));
  });

  // ---- Invitation routes ---------------------------------------------------

  // POST /auth/invitation/create — create an invitation.
  // requireUser: only an authenticated user may invite. The creator is the
  // requesting principal. Body: { targetEntity, targetId, role, targetUser?,
  // maxUses?, expiresAt? }. Returns the invitation with its token.
  s.post('/invitation/create', requireUser(), async (req             , res              , next          ) => {
    const { targetEntity, targetId, role, targetUser, maxUses, expiresAt } = req.body ?? {};
    if (!targetEntity || !targetId || !role) {
      return next({ status: 400, message: 'targetEntity, targetId, and role are required' });
    }
    try {
      const invitation = await createInvitation({
        targetEntity,
        targetId,
        role,
        targetUser,
        maxUses,
        expiresAt,
        principal: req.principal,
      });
      res.status(201).json(invitationResponse(invitation));
    } catch (err) {
      const e = err                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // POST /auth/invitation/:token/accept — accept an invitation by token.
  // requireUser: an anonymous caller cannot accept. Validates the token,
  // grants membership on the target entity. Returns { targetEntity, targetId, role }.
  s.post('/invitation/:token/accept', requireUser(), async (req             , res              , next          ) => {
    const { token } = req.params;
    try {
      const result = await acceptInvitation(token, req.principal);
      res.json(result);
    } catch (err) {
      const e = err                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // POST /auth/invitation/:token/reject — reject a direct invitation.
  // requireUser: an anonymous caller cannot reject. Removes the direct
  // invitation row if the rejecting user matches the target.
  s.post('/invitation/:token/reject', requireUser(), async (req             , res              , next          ) => {
    const { token } = req.params;
    try {
      await rejectInvitation(token, req.principal);
      res.sendStatus(204);
    } catch (err) {
      const e = err                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // GET /auth/invitation — list pending invitations for the current user.
  // Open link tokens are bearer secrets and are never disclosed by this list.
  s.get('/invitation', requireUser(), (req             , res              , next          ) => {
    try {
      const invitations = listInvitationsForUser(req.principal);
      res.json(invitations.map((inv) => invitationResponse(inv)));
    } catch (err) {
      const e = err                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // ---- API Key routes -------------------------------------------------------

  // POST /auth/api-key/create — mint a new API key. The plain token is returned
  // ONCE in the response body and never stored. Only the SHA-256 hash is stored.
  // requireUser: only an authenticated human user may create keys. Scoped or
  // role-bearing keys fail closed unless the caller holds admin authority on
  // the target entity (or an explicit server-configured authorizeApiKey policy
  // admits the request).
  s.post('/api-key/create', requireUser(), async (req             , res              , next          ) => {
    if (req.principal.type !== 'user' || typeof req.principal.id !== 'string' || req.principal.id.length === 0) {
      return next({ status: 403, message: 'a user principal is required to create an API key' });
    }
    const { name, entityName, role, expiresAt } = req.body ?? {};
    if (name == null || name === '') {
      return next({ status: 400, message: 'name is required' });
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      return next({ status: 400, message: 'name must be a non-empty string' });
    }
    if (expiresAt !== undefined && expiresAt !== null) {
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
        return next({ status: 400, message: 'expiresAt must be a positive finite timestamp' });
      }
    }

    let normalizedEntityName                = null;
    if (entityName !== undefined && entityName !== null) {
      if (!isValidApiKeyEntityName(entityName)) {
        return next({ status: 400, message: 'entityName must be a valid entity identifier' });
      }
      normalizedEntityName = entityName;
    }

    let normalizedRole                = null;
    if (role !== undefined && role !== null) {
      if (!isValidApiKeyRole(role)) {
        return next({ status: 400, message: 'role must be a valid role identifier' });
      }
      normalizedRole = role;
    }

    if (normalizedEntityName !== null || normalizedRole !== null) {
      if (normalizedEntityName === null) {
        return next({ status: 403, message: 'role requires an authorized entityName' });
      }
      if (isReservedApiKeyEntityName(normalizedEntityName)) {
        return next({ status: 403, message: `not authorized to create an API key for entity '${normalizedEntityName}'` });
      }
      const runtime = ApiKey?.runtime;
      if (!runtime || typeof runtime.entityOf !== 'function') {
        return next({ status: 403, message: `not authorized to create an API key for entity '${normalizedEntityName}'` });
      }
      let target                    ;
      try {
        target = runtime.entityOf(normalizedEntityName)                      ;
      } catch {
        return next({ status: 400, message: `unknown entity '${normalizedEntityName}'` });
      }
      if (typeof authorizeApiKey === 'function') {
        let allowed = false;
        try {
          allowed = Boolean(await authorizeApiKey({
            principal: req.principal,
            entityName: normalizedEntityName,
            role: normalizedRole,
          }));
        } catch {
          allowed = false;
        }
        if (!allowed) {
          return next({ status: 403, message: `not authorized to create an API key for entity '${normalizedEntityName}'` });
        }
      } else {
        const verdict = await authorizeScopedApiKey({
          target,
          role: normalizedRole,
          principal: req.principal,
          db,
        });
        if (!verdict.ok) {
          return next({ status: verdict.status, message: verdict.message });
        }
      }
    }

    try {
      const result = ApiKey.create({
        name,
        entityName: normalizedEntityName,
        role: normalizedRole,
        expiresAt: expiresAt ?? null,
        createdBy: req.principal.id,
      });
      res.status(201).json({
        id: result.id,
        prefix: result.prefix,
        name: result.name,
        token: result.plainToken,
      });
    } catch (err) {
      const e = err                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // GET /auth/api-key — list the current user's API keys (prefix + name only,
  // no hashes, no plain tokens).
  // requireUser: an anonymous caller cannot list keys.
  s.get('/api-key', requireUser(), (req             , res              , next          ) => {
    if (req.principal.type !== 'user') {
      return next({ status: 403, message: 'a user principal is required to list API keys' });
    }
    try {
      const userId = req.principal.id;
      ApiKey.findAll(ApiKey.createdBy.is(userId))
        .sort(ApiKey.createdAt, 'desc')
        .then((rows       ) => {
          res.json(rows.map((k) => ({
            id: k.id,
            prefix: k.prefix,
            name: k.name,
            entityName: k.entityName,
            role: k.role,
            expiresAt: k.expiresAt,
            createdAt: k.createdAt,
          })));
        }, (err         ) => next({ status: 500, message: (err                        ).message }));
    } catch (err) {
      const e = err                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // DELETE /auth/api-key/:id — revoke (delete) an API key. Only the key's
  // creator may revoke it.
  // requireUser: an anonymous caller cannot revoke keys.
  s.delete('/api-key/:id', requireUser(), (req             , res              , next          ) => {
    if (req.principal.type !== 'user') {
      return next({ status: 403, message: 'a user principal is required to revoke an API key' });
    }
    const { id } = req.params;
    try {
      const key = ApiKey.getOrFail(id);
      if (String(key.createdBy) !== String(req.principal.id)) {
        return next({ status: 403, message: 'not your key' });
      }
      ApiKey.delete(id);
      res.sendStatus(204);
    } catch (err) {
      const e = err                                          ;
      if (e.message?.includes('not found')) {
        return next({ status: 404, message: 'key not found' });
      }
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // ---- TOTP (two-factor authentication) routes ------------------------------

  // GET /auth/totp — return the current user's TOTP enrollment status.
  // requireUser: an anonymous caller is rejected (401). The response is EXACTLY
  // { enrolled, enabled } — no secret, no backup-code hashes or count, no
  // verifiedAt, no lockout counters, no row id.
  s.get('/totp', requireUser(), (req             , res              ) => {
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(req.principal.id));
    if (!twoFactor) return res.json({ enrolled: false, enabled: false });
    return res.json({ enrolled: true, enabled: twoFactor.enabled === 1 });
  });

  // POST /auth/totp/enroll — enroll in TOTP two-factor authentication.
  // requireUser: only an authenticated user can enroll. Generates a secret
  // (base32-encoded), backup codes, and a TwoFactor row. Returns the secret
  // URI (for QR code) and backup codes ONCE — they are never stored in plaintext.
  s.post('/totp/enroll', requireUser(), (req             , res              , next          ) => {
    const userId = req.principal.id;
    // One enrollment per user — reject if already enrolled.
    const existing = TwoFactor.findOne(TwoFactor.userId.is(userId));
    if (existing) {
      return next({ status: 409, message: 'TOTP already enrolled' });
    }
    const user = User.getOrFail(userId);
    try {
      const result = TwoFactor.create({ userId, username: user.username, issuer: totpIssuer });
      res.status(201).json({
        secret: result.secret,
        uri: result.uri,
        backupCodes: result.backupCodes,
      });
    } catch (err) {
      const e = err                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // POST /auth/totp/verify — verify a TOTP token against the stored secret.
  // requireUser: only an authenticated user can verify. Enforces replay
  // protection within the 90s window. On the first successful verify after
  // enrollment, sets enabled=1 and verifiedAt=now. Returns { verified: true } or 400.
  s.post('/totp/verify', requireUser(), (req             , res              , next          ) => {
    const { token } = req.body ?? {};
    if (!token) {
      return next({ status: 400, message: 'token is required' });
    }
    const userId = String(req.principal.id);
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(userId));
    if (!twoFactor) {
      return next({ status: 400, message: 'TOTP not enrolled' });
    }
    // TOTP lockout check — before token verification. A lock that has expired
    // must not let the stale failed-attempt counter instantly relock the next
    // invalid token, so the count restarts at 0.
    const verdict = evaluateLockout(twoFactor.totpFailedAttempts, twoFactor.totpLockedUntil);
    if (verdict.locked) {
      return next({ status: 429, message: 'TOTP temporarily locked', details: { retryAfterMs: verdict.retryAfterMs } });
    }
    const stepResult = verifyTotpStep(twoFactor.secret, token          );
    if (!stepResult.valid || stepResult.counter === null || isTotpCounterReplayed(userId, twoFactor, stepResult.counter)) {
      // Failed TOTP attempt (or replay): advance the shared counter/lock
      // normalization — the same write authenticate and disable use — so an
      // expired lock's stale fence is cleared and the series re-accumulates from 0.
      recordTotpFailure(twoFactor, verdict.resetAttempts);
      return next({ status: 400, message: 'invalid TOTP token' });
    }
    // Successful TOTP verification: reset counter and record replay step.
    db.prepare('UPDATE TwoFactor SET totpFailedAttempts = 0, totpLockedUntil = NULL WHERE id = ?')
      .run(twoFactor.id);
    persistTotpCounterDb(twoFactor.id, stepResult.counter);
    recordTotpCounterMemory(userId, twoFactor.secret, stepResult.counter);
    // First successful verification: flip enabled to 1 and set verifiedAt.
    if (twoFactor.enabled === 0) {
      db.prepare('UPDATE TwoFactor SET enabled = 1, verifiedAt = ? WHERE id = ?')
        .run(new Date().toISOString(), twoFactor.id);
    }
    res.json({ verified: true });
  });

  // POST /auth/totp/disable — remove the TOTP enrollment and revoke all other
  // active sessions for the user.
  // requireUser: only an authenticated user can disable. Requires a valid TOTP
  // token, a backup code, or the user's password to confirm the action.
  s.post('/totp/disable', requireUser(), async (req             , res              , next          ) => {
    const { token, password } = req.body ?? {};
    if (!token && !password) {
      return next({ status: 400, message: 'token or password is required' });
    }
    const userId = String(req.principal.id);
    // Allow password as an alternative to TOTP token.
    if (password) {
      const user = User.getOrFail(userId);
      const storedPassword = rawPasswordOfUser(user.id);
      if (!(await verifyHashAsync(password, storedPassword))) {
        return next({ status: 400, message: 'invalid password' });
      }
      // Password verified — proceed to delete and revoke other sessions.
      const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(userId));
      if (twoFactor) TwoFactor.delete(twoFactor.id);
      revokeOtherSessions(userId, req);
      return res.sendStatus(204);
    }
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(userId));
    if (!twoFactor) {
      return next({ status: 400, message: 'TOTP not enrolled' });
    }
    const tokenValue = String(token);

    // Verifying the factor, consuming a backup code, removing the enrollment,
    // and revoking other sessions commit in ONE driver transaction: a valid
    // token can never leave the enrollment half-disabled with a backup code burned.





    let outcome                            ;
    try {
      await coordinate(() => txn(db, () => {
        // Re-read the enrollment inside the write lock — the authoritative row.
        const row = TwoFactor.findById(twoFactor.id);
        if (!row) {
          outcome = { kind: 'gone' };
          return;
        }
        const settled = settleSecondFactor(userId, row, tokenValue);
        if (settled.kind !== 'ok') {
          outcome = settled;
          return;
        }
        TwoFactor.delete(row.id);
        revokeOtherSessions(userId, req);
        outcome = { kind: 'ok', totpCounter: settled.totpCounter, secret: settled.secret };
      }));
    } catch (err) {
      const e = err                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }
    if (!outcome) {
      return next({ status: 500, message: 'TOTP disable did not settle' });
    }
    if (outcome.kind === 'locked') {
      return next({ status: 429, message: 'TOTP temporarily locked', details: { retryAfterMs: outcome.retryAfterMs } });
    }
    if (outcome.kind === 'gone') {
      return next({ status: 400, message: 'TOTP not enrolled' });
    }
    if (outcome.kind === 'invalid') {
      return next({ status: 400, message: 'invalid token or backup code' });
    }
    if (outcome.totpCounter !== null) {
      recordTotpCounterMemory(userId, outcome.secret, outcome.totpCounter);
    }
    res.sendStatus(204);
  });

  // POST /auth/totp/authenticate — complete login with TOTP 2FA.
  s.post('/totp/authenticate', allowAnonymous(), async (req             , res              , next          ) => {
    const { challenge, token } = req.body ?? {};
    if (!challenge || !token) {
      return next({ status: 400, message: 'challenge and token are required' });
    }
    const challengeId = String(challenge);

    // 1. Reserve the challenge atomically. A racing second request for the same
    // challenge is rejected HERE, before any SQL.
    const claim = activeLoginChallengeStore.reserve(challengeId);
    if (!claim) {
      return next({ status: 400, message: 'unknown or expired challenge' });
    }
    const userId = String(claim.userId);
    const tokenValue = String(token);

    // 2. Enter the write transaction and complete the second factor + mint the
    // Session in it. The backup-code removal (one-time), the fence reset, the
    // replay counter, and the Session row commit together or not at all.





    let outcome                                 ;
    let commitStatus                                            = 'ambiguous';
    let error         ;
    try {
      await coordinate(() => {
        begin(db);
        // 3. Re-read the enrollment under the write lock — the authoritative row.
        const row = TwoFactor.findOne(TwoFactor.userId.is(userId));
        if (!row || row.enabled !== 1) {
          outcome = { kind: 'gone' };
        } else {
          // 4. Verify against the authoritative hashes + replay guard.
          const settled = settleSecondFactor(userId, row, tokenValue);
          if (settled.kind !== 'ok') {
            outcome = settled;
          } else {
            // 5. Valid factor: fence reset + one-time code removal / replay step
            // already wrote inside this transaction; mint the Session in it too.
            const session = Session.create({ userId });
            const user = User.getOrFail(userId);
            outcome = {
              kind: 'ok',
              session,
              username: user.username,
              totpCounter: settled.totpCounter,
              secret: settled.secret,
            };
          }
        }
        commit(db);
        commitStatus = 'committed';
      });
    } catch (err) {
      error = err;
      try {
        rollback(db);
        commitStatus = 'rolled-back';
      } catch {
        commitStatus = 'ambiguous';
      }
    }

    // 6. Settle the claim against the CONFIRMED transaction outcome.
    if (commitStatus === 'ambiguous') {
      activeLoginChallengeStore.finalize(claim);
      return next({ status: 500, message: 'authentication outcome could not be confirmed; please log in again' });
    }
    if (commitStatus === 'rolled-back') {
      activeLoginChallengeStore.release(claim);
      const e = error                                          ;
      return next({ status: e.status ?? 500, message: e.message });
    }
    // Committed.
    if (!outcome) {
      activeLoginChallengeStore.finalize(claim);
      return next({ status: 500, message: 'authentication did not settle' });
    }
    if (outcome.kind === 'locked') {
      activeLoginChallengeStore.fail(claim);
      return next({ status: 429, message: 'TOTP temporarily locked', details: { retryAfterMs: outcome.retryAfterMs } });
    }
    if (outcome.kind === 'gone') {
      activeLoginChallengeStore.release(claim);
      return next({ status: 400, message: 'TOTP not enabled for this user' });
    }
    if (outcome.kind === 'invalid') {
      activeLoginChallengeStore.fail(claim);
      return next({ status: 400, message: 'invalid token or backup code' });
    }
    if (outcome.totpCounter !== null) {
      recordTotpCounterMemory(userId, outcome.secret, outcome.totpCounter);
    }
    // 7. Finalize the claim, then build the response — never before.
    if (!activeLoginChallengeStore.finalize(claim)) {
      return next({ status: 500, message: 'login challenge could not be finalized' });
    }
    res.setHeader('set-cookie', sessionCookie(outcome.session.token, { secure, ttlMs: sessionDurationMs }));
    res.status(201).json({ user: { id: userId, username: outcome.username } });
  });

  return s;
}

// Re-exported so an app mounting its own auth router can reach the cookie name
// without `workbench/internal` — one public surface (AGENTS: retire the
// internal-import habit). `app.auth()` is the supported path; this export is for
// apps that hand-roll the boundary like `projects/session.mjs`.
export { SESSION_COOKIE };
