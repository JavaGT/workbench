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

import { router } from '../app.ts';
import { allowAnonymous, requireUser } from '../route-gate.ts';
import { createInvitationApi } from './invitation.ts';
import { sessionCookie, sessionTokenOf, SESSION_COOKIE } from './session.ts';
import { config, type WorkbenchConfig } from '../config.ts';
import { verifyTotp, verifyBackupCode } from './totp.ts';
import { loginChallengeStore } from './login-challenge.ts';
import { evaluateLockout, nextFailedAttemptCount, loginLockoutDecision, totpLockoutDecision } from './lockout.ts';
import { txn, begin, commit, rollback, type DbHandle } from '../driver.ts';
import { serializeField } from '../field-strategy.ts';
import {
  generateChallenge,
  challengeStore,
  verifyRegistration,
  verifyAuthentication,
  rpConfig,
  parseClientDataJSON,
} from './passkey.ts';

import type { ResponseFacade } from '../http-response-factory.ts';
import type { Principal } from '../principal.ts';

// ---- Structural types --------------------------------------------------------
// The router's handler chain dispatches `(req, res, next)` where req carries the
// parsed body/params/query and the server-side principal (http-handler-chain.mjs),
// res is the response facade, and next forwards an error to the error renderer.
// The entity facades (User, Session, ...) are compiled bindings from the untyped
// entity layer, so they stay `any`; the request surface is pinned here.

export interface AuthRoutesOptions {
  secure?: boolean;
  identifyBy?: string[];
  entities?: Record<string, any> | null;
  db?: DbHandle | null;
}

interface AuthRequest {
  body: Record<string, unknown> | null | undefined;
  params: Record<string, string>;
  query: Record<string, string>;
  principal: Principal;
  headers: { cookie?: string; authorization?: string };
}

type AuthResponse = ResponseFacade;
type AuthNext = (err?: unknown) => void;

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
export function authRoutes({ secure = config.env === 'production', identifyBy = ['username'], entities, db: maybeDb }: AuthRoutesOptions = {}) {
  if (!entities || !maybeDb) {
    throw new Error('authRoutes requires entities and db options');
  }
  // Bind the guarded driver to a const so the nested function declarations
  // below — which TypeScript does not narrow across their declaration
  // boundary — see a non-null, fully-typed handle.
  const db: DbHandle = maybeDb;
  const { User, Session, Credential, Invitation, ApiKey, TwoFactor } = entities;
  const { createInvitation, acceptInvitation, rejectInvitation, listInvitationsForUser } = createInvitationApi({ Invitation });
  const s = router();
  const identityFields = Array.isArray(identifyBy) && identifyBy.length > 0 ? identifyBy : ['username'];

  // Invitation response builder — shared by create and list routes.
  const INVITATION_FIELDS = ['token', 'targetEntity', 'targetId', 'role', 'targetUser', 'maxUses', 'useCount', 'expiresAt', 'createdBy', 'createdAt'];
  function invitationResponse(inv: { [key: string]: unknown }) {
    return Object.fromEntries(INVITATION_FIELDS.map(f => [f, inv[f]]));
  }

  // TOTP backup-code verification helper — shared by disable and authenticate routes.
  function verifyTotpOrBackupCode(twoFactor: { secret: string; backupCodes?: string | null }, token: string): { isValid: boolean; usedBackup: boolean; backupCodes: string[] } {
    const backupCodes = JSON.parse(twoFactor.backupCodes || '[]');
    const isTotpValid = verifyTotp(twoFactor.secret, token);
    const isBackupValid = verifyBackupCode(backupCodes, token);
    return { isValid: isTotpValid || isBackupValid, usedBackup: isBackupValid, backupCodes };
  }

  // The shared outcome of settling one second-factor token (the disable and
  // authenticate routes each settle inside their own driver transaction):
  //   - 'ok'      — the token was valid; the TOTP fence was reset and a backup
  //                 code's removal was persisted in the caller's transaction.
  //   - 'invalid' — a failed non-backup attempt; the failed-attempt/lockout
  //                 counters were advanced in the caller's transaction.
  //   - 'locked'  — the TOTP fence is active and the token is not a backup code;
  //                 nothing was written and the caller rejects with 429.
  type SecondFactorOutcome =
    | { kind: 'ok'; usedBackup: boolean }
    | { kind: 'invalid' }
    | { kind: 'locked'; retryAfterMs: number };

  // The ONE TOTP failed-attempt write, shared by authenticate/disable (via
  // settleSecondFactor) and by the verify route — a single normalization, not
  // three inline copies that can drift. A failed token advances the counter and
  // optionally arms a lock; an EXPIRED lock's stale timestamp is cleared along
  // with the restart so the series re-accumulates from 0 instead of instantly
  // relocking (or being frozen at 1 and never re-locking) on the next token.
  function recordTotpFailure(
    row: { id: unknown; totpFailedAttempts: number | null | undefined; totpLockedUntil: unknown },
    resetAttempts: boolean,
  ): void {
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
  function settleSecondFactor(row: any, token: string): SecondFactorOutcome {
    const verdict = evaluateLockout(row.totpFailedAttempts, row.totpLockedUntil);
    const { isValid, usedBackup, backupCodes } = verifyTotpOrBackupCode(row, token);
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
    // Valid: clear the TOTP fence; a backup code's one-time consumption is
    // persisted here, inside the caller's transaction.
    db.prepare('UPDATE TwoFactor SET totpFailedAttempts = 0, totpLockedUntil = NULL WHERE id = ?')
      .run(row.id);
    if (usedBackup) {
      db.prepare('UPDATE TwoFactor SET backupCodes = ? WHERE id = ?')
        .run(JSON.stringify(backupCodes), row.id);
    }
    return { kind: 'ok', usedBackup };
  }

  function findIdentity(credential: unknown, next: AuthNext): { user: any; failed: boolean } {
    for (const name of identityFields) {
      const field = User[name];
      if (!field) {
        next({ status: 500, message: `identifyBy references unknown User field '${name}'` });
        return { failed: true, user: null };
      }
      // Email is one identity regardless of case (#7602): a re-cased credential
      // previously matched nothing and was reported as bad credentials. Fold the
      // typed address and each stored address; refuse an ambiguous fold rather
      // than silently picking one of two case-variant accounts.
      if (name === 'email') {
        const typedEmail = typeof credential === 'string' ? credential.trim().toLowerCase() : '';
        if (typedEmail) {
          const matches = User.findAll().filter(
            (candidate: any) => typeof candidate.email === 'string' && candidate.email.trim().toLowerCase() === typedEmail,
          );
          if (matches.length > 1) {
            next({ status: 409, message: 'This email matches more than one account; ask the server administrator to resolve it' });
            return { failed: true, user: null };
          }
          if (matches.length === 1) return { user: matches[0], failed: false };
        }
        continue;
      }
      const user = User.findOne(field.is(credential));
      if (user) return { user, failed: false };
    }
    return { user: null, failed: false };
  }

  function createSessionResponse(user: { id: string; username: string }, res: AuthResponse) {
    const session = Session.create({ userId: user.id });
    res.setHeader('set-cookie', sessionCookie(session.token, { secure }));
    res.status(201).json({ user: { id: user.id, username: user.username } });
  }

  // Registration and login are distinct principal-minting intents. Registration
  // creates exactly one identity; login never creates an unknown identity.
  s.post('/register', allowAnonymous(), async (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return next({ status: 400, message: 'username and password are required' });
    }
    const found = findIdentity(username, next);
    if (found.failed) return;
    if (found.user) return next({ status: 409, message: 'account already exists' });
    const user = User.create({ [identityFields[0]]: username, password });
    createSessionResponse(user, res);
  });

  s.post('/login', allowAnonymous(), async (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return next({ status: 400, message: 'username and password are required' });
    }
    const found = findIdentity(username, next);
    if (found.failed) return;
    const user = found.user;
    if (!user) return next({ status: 401, message: 'bad credentials' });
    {
      // Lockout check — before password verification so scrypt is skipped
      // when the account is locked. A non-existent user has no lockout state.
      // A lock that has expired must not let the stale failed-attempt counter
      // instantly relock the next wrong password, so the count restarts at 0.
      const verdict = evaluateLockout(user.failedLoginAttempts, user.lockedUntil);
      if (verdict.locked) {
        return next({ status: 403, message: 'account locked', details: { retryAfterMs: verdict.retryAfterMs } });
      }
      if (!user.password.verify(password)) {
        // Failed attempt: increment counter and optionally lock the account.
        const attempts = nextFailedAttemptCount(verdict.resetAttempts, user.failedLoginAttempts);
        const decision = loginLockoutDecision({ attempts });
        if (decision) {
          db.prepare('UPDATE User SET failedLoginAttempts = ?, lockedUntil = ? WHERE id = ?')
            .run(attempts, decision.lockedUntil, user.id);
        } else {
          // Clearing the expired lock's stale timestamp along with the counter
          // so the series re-accumulates from 0 instead of being frozen at 1
          // (which would let the account bypass re-locking entirely).
          db.prepare('UPDATE User SET failedLoginAttempts = ?, lockedUntil = ? WHERE id = ?')
            .run(attempts, verdict.resetAttempts ? null : user.lockedUntil, user.id);
        }
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
      const challenge = loginChallengeStore.set(user.id);
      return res.json({ requiresTotp: true, challenge, userId: user.id });
    }
    createSessionResponse(user, res);
  });

  // logout: inherits the default-on `requireUser` gate, so a caller without a
  // valid session is denied at the gate before reaching here. Read the opaque
  // sid token from the cookie, delete that Session row, and clear the cookie
  // with the SAME attributes plus Max-Age=0 so the browser drops it. 204.
  s.post('/logout', async (req: AuthRequest, res: AuthResponse) => {
    const token = sessionTokenOf(req);
    if (token) {
      const row = Session.findOne(Session.token.is(token));
      if (row) Session.delete(row.id);
    }
    // Max-Age=0 expires the cookie immediately; the attributes match login so
    // the browser scopes the deletion to the same cookie (Path/Domain match).
    res.setHeader('set-cookie', `${sessionCookie('', { secure })}; Max-Age=0`);
    res.sendStatus(204);
  });

  // GET /auth/me — return the authenticated user's public profile from the
  // active session. requireUser() rejects anonymous callers. The response
  // includes all User fields: id, username, email, displayName, name, image,
  // phone, bio. Null fields are omitted from the response.
  s.get('/me', requireUser(), (req: AuthRequest, res: AuthResponse) => {
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
  // the current password against the stored hash before setting the new one.
  // 204 on success; 400 if the body is incomplete, 401 if wrong current pw.
  s.post('/change-password', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) {
      return next({ status: 400, message: 'currentPassword and newPassword are required' });
    }
    const user = User.getOrFail(req.principal.id);
    if (!user || !user.password.verify(currentPassword)) {
      return next({ status: 401, message: 'current password is incorrect' });
    }
    // Re-digest the new password through the hash field strategy rather than
    // going through the entity action-dispatch pipeline (which needs authz
    // gate resolution). This matches the existing pattern for framework-internal
    // auth mutations — TOTP disable uses raw SQL at auth-routes.mjs:494).
    const serialized = serializeField({ kind: 'hash', type: 'hash' }, newPassword);
    db.prepare('UPDATE User SET password = ? WHERE id = ?').run(serialized, user.id);
    res.sendStatus(204);
  });

  // ---- Passkey (WebAuthn) routes -------------------------------------------

  const rp = rpConfig(config as WorkbenchConfig & { rp?: { name?: string; id?: string; origin?: string } });

  // GET /auth/passkey/challenge — issue a new challenge for a WebAuthn ceremony.
  // allowAnonymous: anyone may request a challenge (the ceremony itself proves
  // identity). Returns { challenge, rp: { name, id } }.
  s.get('/passkey/challenge', allowAnonymous(), (_req: AuthRequest, res: AuthResponse) => {
    const challenge = generateChallenge();
    challengeStore.set(challenge);
    res.json({ challenge, rp: { name: rp.name, id: rp.id } });
  });

  // POST /auth/passkey/register — enroll a new passkey credential.
  // requireUser: the caller must have an existing session (password login first,
  // then enroll passkey). The credential's userId is the requesting principal's
  // id — a passkey is always bound to the authenticated user who registered it.
  s.post('/passkey/register', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const credential = (req.body ?? {}).credential as Parameters<typeof verifyRegistration>[1] | null | undefined;
    if (!credential || !credential.response?.clientDataJSON || !credential.response?.attestationObject) {
      return next({ status: 400, message: 'credential with clientDataJSON and attestationObject is required' });
    }

    // Extract and consume the challenge from clientDataJSON
    let clientData;
    try {
      clientData = parseClientDataJSON(credential.response.clientDataJSON);
    } catch (err) {
      const e = err as { message?: string };
      return next({ status: 400, message: `invalid clientDataJSON: ${e.message}` });
    }
    const entry = challengeStore.consume(String(clientData.challenge));
    if (!entry) {
      return next({ status: 400, message: 'unknown or expired challenge' });
    }

    let result;
    try {
      result = verifyRegistration(String(clientData.challenge), credential, rp);
    } catch (err) {
      const e = err as { message?: string };
      return next({ status: 400, message: `registration failed: ${e.message}` });
    }

    const userId = req.principal.id;
    Credential.create({
      credentialId: result.credentialId,
      publicKey: result.publicKey,
      userId,
      signCount: result.signCount,
      name: credential.name || 'Passkey',
      transports: Array.isArray(credential.transports) ? credential.transports.join(',') : '',
      backedUp: credential.backedUp ? 1 : 0,
      createdAt: new Date(),
    });
    res.status(201).json({ ok: true });
  });

  // POST /auth/passkey/authenticate — sign in with a passkey.
  // allowAnonymous: the caller proves identity by demonstrating possession of the
  // private key. On successful verification, the framework mints a Session and
  // sets the `sid` cookie — the same authentication pathway as password login.
  s.post('/passkey/authenticate', allowAnonymous(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const credential = (req.body ?? {}).credential as Parameters<typeof verifyAuthentication>[1] | null | undefined;
    if (!credential || !credential.response?.clientDataJSON || !credential.response?.authenticatorData || !credential.response?.signature) {
      return next({ status: 400, message: 'credential with clientDataJSON, authenticatorData, and signature is required' });
    }

    // Extract and consume the challenge from clientDataJSON
    let clientData;
    try {
      clientData = parseClientDataJSON(credential.response.clientDataJSON);
    } catch (err) {
      const e = err as { message?: string };
      return next({ status: 400, message: `invalid clientDataJSON: ${e.message}` });
    }
    const entry = challengeStore.consume(String(clientData.challenge));
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

    let result;
    try {
      result = verifyAuthentication(String(clientData.challenge), credential, storedCredential, rp);
    } catch (err) {
      const e = err as { message?: string };
      return next({ status: 401, message: `authentication failed: ${e.message}` });
    }

    // Update the counter (replay protection). The unstored query API is the
    // same trust class the login/lookup paths already use.
    db.prepare('UPDATE Credential SET signCount = ? WHERE id = ?').run(result.signCount, storedCredential.id);

    // Look up the user
    const user = User.getOrFail(storedCredential.userId);
    const session = Session.create({ userId: user.id });
    res.setHeader('set-cookie', sessionCookie(session.token, { secure }));
    res.status(201).json({ user: { id: user.id, username: user.username } });
  });

  // DELETE /auth/passkey/:credentialId — remove a passkey credential.
  // requireUser: only an authenticated user can remove their own credential.
  s.delete('/passkey/:credentialId', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
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
  s.get('/passkey', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const userId = req.principal.id;
    Credential.findAll(Credential.userId.is(userId))
      .sort(Credential.createdAt, 'desc')
      .then((rows: any[]) => {
        res.json(rows.map((c) => ({
          credentialId: c.credentialId,
          name: c.name,
          createdAt: c.createdAt,
          backedUp: c.backedUp,
          transports: c.transports ? c.transports.split(',').filter(Boolean) : [],
        })));
      }, (err: unknown) => next({ status: 500, message: (err as { message?: string }).message }));
  });

  // ---- Invitation routes ---------------------------------------------------

  // POST /auth/invitation/create — create an invitation.
  // requireUser: only an authenticated user may invite. The creator is the
  // requesting principal. Body: { targetEntity, targetId, role, targetUser?,
  // maxUses?, expiresAt? }. Returns the invitation with its token.
  s.post('/invitation/create', requireUser(), async (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
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
      const e = err as { status?: unknown; message?: string };
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // POST /auth/invitation/:token/accept — accept an invitation by token.
  // requireUser: an anonymous caller cannot accept. Validates the token,
  // grants membership on the target entity. Returns { targetEntity, targetId, role }.
  s.post('/invitation/:token/accept', requireUser(), async (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { token } = req.params;
    try {
      const result = await acceptInvitation(token, req.principal);
      res.json(result);
    } catch (err) {
      const e = err as { status?: unknown; message?: string };
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // POST /auth/invitation/:token/reject — reject a direct invitation.
  // requireUser: an anonymous caller cannot reject. Removes the direct
  // invitation row if the rejecting user matches the target.
  s.post('/invitation/:token/reject', requireUser(), async (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { token } = req.params;
    try {
      await rejectInvitation(token, req.principal);
      res.sendStatus(204);
    } catch (err) {
      const e = err as { status?: unknown; message?: string };
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // GET /auth/invitation — list pending invitations for the current user.
  // Open link tokens are bearer secrets and are never disclosed by this list.
  s.get('/invitation', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    try {
      const invitations = listInvitationsForUser(req.principal);
      res.json(invitations.map((inv) => invitationResponse(inv)));
    } catch (err) {
      const e = err as { status?: unknown; message?: string };
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // ---- API Key routes -------------------------------------------------------

  // POST /auth/api-key/create — mint a new API key. The plain token is returned
  // ONCE in the response body and never stored. Only the SHA-256 hash is stored.
  // requireUser: only an authenticated user may create keys.
  s.post('/api-key/create', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { name, entityName, role, expiresAt } = req.body ?? {};
    if (!name) {
      return next({ status: 400, message: 'name is required' });
    }
    try {
      const result = ApiKey.create({
        name,
        entityName: entityName ?? null,
        role: role ?? null,
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
      const e = err as { status?: unknown; message?: string };
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // GET /auth/api-key — list the current user's API keys (prefix + name only,
  // no hashes, no plain tokens).
  // requireUser: an anonymous caller cannot list keys.
  s.get('/api-key', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    try {
      const userId = req.principal.id;
      ApiKey.findAll(ApiKey.createdBy.is(userId))
        .sort(ApiKey.createdAt, 'desc')
        .then((rows: any[]) => {
          res.json(rows.map((k) => ({
            id: k.id,
            prefix: k.prefix,
            name: k.name,
            entityName: k.entityName,
            role: k.role,
            expiresAt: k.expiresAt,
            createdAt: k.createdAt,
          })));
        }, (err: unknown) => next({ status: 500, message: (err as { message?: string }).message }));
    } catch (err) {
      const e = err as { status?: unknown; message?: string };
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // DELETE /auth/api-key/:id — revoke (delete) an API key. Only the key's
  // creator may revoke it.
  // requireUser: an anonymous caller cannot revoke keys.
  s.delete('/api-key/:id', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { id } = req.params;
    try {
      const key = ApiKey.getOrFail(id);
      if (String(key.createdBy) !== String(req.principal.id)) {
        return next({ status: 403, message: 'not your key' });
      }
      ApiKey.delete(id);
      res.sendStatus(204);
    } catch (err) {
      const e = err as { status?: unknown; message?: string };
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
  s.get('/totp', requireUser(), (req: AuthRequest, res: AuthResponse) => {
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(req.principal.id));
    if (!twoFactor) return res.json({ enrolled: false, enabled: false });
    return res.json({ enrolled: true, enabled: twoFactor.enabled === 1 });
  });

  // POST /auth/totp/enroll — enroll in TOTP two-factor authentication.
  // requireUser: only an authenticated user can enroll. Generates a secret
  // (base32-encoded), backup codes, and a TwoFactor row. Returns the secret
  // URI (for QR code) and backup codes ONCE — they are never stored in plaintext.
  s.post('/totp/enroll', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const userId = req.principal.id;
    // One enrollment per user — reject if already enrolled.
    const existing = TwoFactor.findOne(TwoFactor.userId.is(userId));
    if (existing) {
      return next({ status: 409, message: 'TOTP already enrolled' });
    }
    const user = User.getOrFail(userId);
    try {
      const result = TwoFactor.create({ userId, username: user.username });
      res.status(201).json({
        secret: result.secret,
        uri: result.uri,
        backupCodes: result.backupCodes,
      });
    } catch (err) {
      const e = err as { status?: unknown; message?: string };
      return next({ status: e.status ?? 500, message: e.message });
    }
  });

  // POST /auth/totp/verify — verify a TOTP token against the stored secret.
  // requireUser: only an authenticated user can verify. On the first successful
  // verify after enrollment, sets enabled=1 and verifiedAt=now. Returns
  // { verified: true } or 400.
  s.post('/totp/verify', requireUser(), (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { token } = req.body ?? {};
    if (!token) {
      return next({ status: 400, message: 'token is required' });
    }
    const userId = req.principal.id;
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
    if (!verifyTotp(twoFactor.secret, token as string)) {
      // Failed TOTP attempt: advance the shared counter/lock normalization —
      // the same write authenticate and disable use — so an expired lock's
      // stale fence is cleared and the series re-accumulates from 0.
      recordTotpFailure(twoFactor, verdict.resetAttempts);
      return next({ status: 400, message: 'invalid TOTP token' });
    }
    // Successful TOTP verification: reset counter.
    db.prepare('UPDATE TwoFactor SET totpFailedAttempts = 0, totpLockedUntil = NULL WHERE id = ?')
      .run(twoFactor.id);
    // First successful verification: flip enabled to 1 and set verifiedAt.
    if (twoFactor.enabled === 0) {
      db.prepare('UPDATE TwoFactor SET enabled = 1, verifiedAt = ? WHERE id = ?')
        .run(new Date().toISOString(), twoFactor.id);
    }
    res.json({ verified: true });
  });

  // POST /auth/totp/disable — remove the TOTP enrollment.
  // requireUser: only an authenticated user can disable. Requires a valid TOTP
  // token, a backup code, or the user's password to confirm the action.
  s.post('/totp/disable', requireUser(), async (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { token, password } = req.body ?? {};
    if (!token && !password) {
      return next({ status: 400, message: 'token or password is required' });
    }
    const userId = req.principal.id;
    // Allow password as an alternative to TOTP token.
    if (password) {
      const user = User.getOrFail(userId);
      if (!user.password.verify(password)) {
        return next({ status: 400, message: 'invalid password' });
      }
      // Password verified — proceed to delete.
      const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(userId));
      if (twoFactor) TwoFactor.delete(twoFactor.id);
      return res.sendStatus(204);
    }
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(userId));
    if (!twoFactor) {
      return next({ status: 400, message: 'TOTP not enrolled' });
    }
    const tokenValue = String(token);

    // Verifying the factor, consuming a backup code, and removing the
    // enrollment commit in ONE driver transaction: a valid token can never
    // leave the enrollment half-disabled with a backup code burned.
    type DisableOutcome =
      | { kind: 'ok' }
      | { kind: 'invalid' }
      | { kind: 'locked'; retryAfterMs: number }
      | { kind: 'gone' };
    let outcome: DisableOutcome | undefined;
    try {
      await txn(db, () => {
        // Re-read the enrollment inside the write lock — the authoritative row.
        const row = TwoFactor.findById(twoFactor.id);
        if (!row) {
          outcome = { kind: 'gone' };
          return;
        }
        const settled = settleSecondFactor(row, tokenValue);
        if (settled.kind !== 'ok') {
          outcome = settled;
          return;
        }
        TwoFactor.delete(row.id);
        outcome = { kind: 'ok' };
      });
    } catch (err) {
      const e = err as { status?: unknown; message?: string };
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
    res.sendStatus(204);
  });

  // POST /auth/totp/authenticate — complete login with TOTP 2FA.
  // allowAnonymous: the caller already provided a password via /auth/login, which
  // returned { requiresTotp: true, challenge }. The user is derived FROM the
  // challenge CLAIM (bound server-side to the user who passed the password); a
  // client-supplied userId is never trusted here. The route accepts either a
  // valid TOTP token or an unused backup code, settles the challenge, mints a
  // Session, and sets the sid cookie — the same authentication pathway as
  // password login. TOTP and backup success share ONE response so the response
  // never reveals which factor was used.
  //
  // The challenge lifecycle is the claim protocol in login-challenge.mjs, and
  // this route is its ONLY settlement consumer:
  //   1. reserve the challenge atomically (userId comes only from the claim);
  //   2. enter the write transaction;
  //   3. re-read the TwoFactor row under the write lock;
  //   4. verify the authoritative TOTP / backup-code hashes;
  //   5. valid → reset the fence, remove a used backup code, mint the Session
  //      in the SAME transaction;
  //   6. settle the claim only against the CONFIRMED transaction outcome
  //      (finalize on commit, fail on invalid/locked, release on gone);
  //   7. build the response only after finalization.
  //
  // The driver's callback form (`txn`) cannot tell a confirmed rollback from an
  // ambiguous COMMIT, and the claim settlement depends on that, so this route
  // uses the driver's sync primitives (the documented alternative call style)
  // instead: a successful COMMIT is confirmed; a failed COMMIT followed by a
  // successful ROLLBACK is a confirmed no-commit; a failed ROLLBACK means the
  // transaction's fate is unknown and the claim must be invalidated — never
  // released, so a maybe-committed session cannot be paired with a reusable
  // challenge.
  s.post('/totp/authenticate', allowAnonymous(), async (req: AuthRequest, res: AuthResponse, next: AuthNext) => {
    const { challenge, token } = req.body ?? {};
    if (!challenge || !token) {
      return next({ status: 400, message: 'challenge and token are required' });
    }
    const challengeId = String(challenge);

    // 1. Reserve the challenge atomically. A racing second request for the same
    // challenge is rejected HERE, before any SQL.
    const claim = loginChallengeStore.reserve(challengeId);
    if (!claim) {
      return next({ status: 400, message: 'unknown or expired challenge' });
    }
    const userId = claim.userId;
    const tokenValue = String(token);

    // 2. Enter the write transaction and complete the second factor + mint the
    // Session in it. The backup-code removal (one-time), the fence reset, and
    // the Session row commit together or not at all: a valid backup code is
    // never durably consumed unless the session actually exists, and a second
    // concurrent submission re-reads the code under the write lock and is
    // rejected.
    type AuthenticateOutcome =
      | { kind: 'ok'; session: { token: string }; username: string }
      | { kind: 'invalid' }
      | { kind: 'locked'; retryAfterMs: number }
      | { kind: 'gone' };
    let outcome: AuthenticateOutcome | undefined;
    let commitStatus: 'committed' | 'rolled-back' | 'ambiguous' = 'ambiguous';
    let error: unknown;
    try {
      begin(db);
      // 3. Re-read the enrollment under the write lock — the authoritative row.
      const row = TwoFactor.findOne(TwoFactor.userId.is(userId));
      if (!row || row.enabled !== 1) {
        outcome = { kind: 'gone' };
      } else {
        // 4. Verify against the authoritative hashes.
        const settled = settleSecondFactor(row, tokenValue);
        if (settled.kind !== 'ok') {
          outcome = settled;
        } else {
          // 5. Valid factor: fence reset + one-time code removal already wrote
          // inside this transaction; mint the Session in it too.
          const session = Session.create({ userId });
          const user = User.getOrFail(userId);
          outcome = { kind: 'ok', session, username: user.username };
        }
      }
      commit(db);
      commitStatus = 'committed';
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
      // The driver could not confirm whether the commit landed. Fail closed:
      // invalidate the challenge (never release it) — a session may exist, and
      // the challenge must not be reusable either way.
      loginChallengeStore.finalize(claim);
      return next({ status: 500, message: 'authentication outcome could not be confirmed; please log in again' });
    }
    if (commitStatus === 'rolled-back') {
      // Confirmed no-commit: release the claim, preserving the challenge and
      // the code (both rolled back) for a retry if they are still live.
      loginChallengeStore.release(claim);
      const e = error as { status?: unknown; message?: string };
      return next({ status: e.status ?? 500, message: e.message });
    }
    // Committed.
    if (!outcome) {
      // A confirmed commit with no recorded outcome is defensively unreachable
      // (outcome is always assigned before commit), but if it ever happens a
      // session may exist, so the challenge must not be reusable either way.
      // Fail closed: invalidate the claim (finalize deletes it; a mismatched
      // claim also invalidates) before surfacing the 500 — never return with
      // the challenge left permanently reserved.
      loginChallengeStore.finalize(claim);
      return next({ status: 500, message: 'authentication did not settle' });
    }
    if (outcome.kind === 'locked') {
      // A failed attempt under lockout still consumes one challenge attempt, so
      // the max-attempt cap holds even when the TOTP lockout is active.
      loginChallengeStore.fail(claim);
      return next({ status: 429, message: 'TOTP temporarily locked', details: { retryAfterMs: outcome.retryAfterMs } });
    }
    if (outcome.kind === 'gone') {
      loginChallengeStore.release(claim);
      return next({ status: 400, message: 'TOTP not enabled for this user' });
    }
    if (outcome.kind === 'invalid') {
      // Invalid second factor: consume one challenge attempt, never a backup code.
      loginChallengeStore.fail(claim);
      return next({ status: 400, message: 'invalid token or backup code' });
    }
    // 7. Finalize the claim, then build the response — never before. If the
    // challenge cannot be finalized, fail closed: the session and code are
    // committed, but no cookie is issued and the client gets no session token.
    if (!loginChallengeStore.finalize(claim)) {
      return next({ status: 500, message: 'login challenge could not be finalized' });
    }
    res.setHeader('set-cookie', sessionCookie(outcome.session.token, { secure }));
    res.status(201).json({ user: { id: userId, username: outcome.username } });
  });

  return s;
}

// Re-exported so an app mounting its own auth router can reach the cookie name
// without `workbench/internal` — one public surface (AGENTS: retire the
// internal-import habit). `app.auth()` is the supported path; this export is for
// apps that hand-roll the boundary like `projects/session.mjs`.
export { SESSION_COOKIE };
