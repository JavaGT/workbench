// login-challenge.mjs — pending-login challenge store for the second-factor
// step of a password login (the TOTP authenticate route).
//
// Mirror of the passkey challenge lifecycle (passkey.mjs createChallengeStore:
// bounded Map + TTL sweep, with optional SQLite persistence) for the
// login-continuation ceremony, with the properties that ceremony needs:
//   - user-bound: each challenge records the user it was issued for, and the
//     authenticate route derives the user FROM the challenge claim — a client
//     never names a user to finish a login.
//   - attempt-counted: at most maxAttempts failed second-factor submissions
//     before the challenge is destroyed and the login must start over.
//   - single-use: a successful settle deletes the challenge.
//   - short-lived: 5-minute TTL, swept by an unref'd interval like the passkey
//     store.
//   - bounded: hard maxSize cap with expired-first then oldest eviction to
//     resist memory exhaustion.
//   - optionally durable: pass `{ db }` to persist challenges in SQLite so
//     pending logins survive restarts.
//
// ONE settlement protocol, no parallel path: a challenge moves
//   available → reserved (exclusive claim) → finalized (deleted) or released
//   (back to available, or deleted when expired). `reserve` is the ONLY way a
//   consumer acquires a challenge, and `finalize` / `release` / `fail` are the
//   ONLY ways it settles one — there is no separate get+consume route. The
//   authenticate route reserves before any SQL, settles the claim only after
//   the transaction outcome is CONFIRMED, and builds its response only after
//   finalization.
//
// Reserved challenges are never swept or reopened by a later request: a
// reservation made before nominal expiry may settle after it, and the sweep
// skips reserved entries (only release/fail re-check the TTL).
//
// Deliberately NOT the passkey challengeStore — that store's lifecycle is the
// WebAuthn ceremony (issued anonymously, consumed once, no attempt count), so a
// login challenge that reused it would inherit the wrong guarantees.

import crypto from 'node:crypto';
import { generateChallenge } from './passkey.mjs';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_SIZE = 10_000;


















// A reserved challenge's settlement handle. Opaque to consumers: the route
// reads only `userId` (identity is derived from the claim, never the request),
// and the store verifies the claim's token against the CURRENT reservation
// before finalize/release/fail touch anything.







// The stored record: the public entry plus the reservation state. `reservedBy`
// holds the per-reservation token when the challenge is claimed, null when it
// is available.









// generateLoginChallenge(length) → base64url-encoded random bytes. 32 bytes
// (256 bits) makes the challenge cryptographically unguessable. Both ceremonies
// draw from the ONE challenge generator (passkey.ts); the name stays exported
// for callers that import the login-specific seam directly.
export function generateLoginChallenge(length = 32)         {
  return generateChallenge(length);
}

function ensureLoginChallengeTable(db           )       {
  const ddl = `
    CREATE TABLE IF NOT EXISTS _LoginChallenge (
      challenge TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      created INTEGER NOT NULL,
      reservedBy TEXT
    );
    CREATE INDEX IF NOT EXISTS idx__LoginChallenge_created ON _LoginChallenge (created);
  `;
  if (typeof db.exec === 'function') {
    db.exec(ddl);
  } else {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS _LoginChallenge (
        challenge TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        created INTEGER NOT NULL,
        reservedBy TEXT
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx__LoginChallenge_created ON _LoginChallenge (created)').run();
  }
}

// createLoginChallengeStore(ttlMs, maxAttempts, now, options) → { set, get,
// reserve, finalize, release, fail, size, destroy }.
//
// A bounded store with TTL-based expiry, user binding, and attempt counting.
// `now` is a clock seam (defaults to Date.now) so tests can drive expiry
// deterministically instead of sleeping. Passing `{ db }` backs the store with
// SQLite so pending challenges survive restarts and remain bounded.
export function createLoginChallengeStore(
  ttlMs = DEFAULT_TTL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now               = Date.now,
  options                             = {},
) {
  const maxSize = Number.isInteger(options.maxSize) && (options.maxSize          ) > 0
    ? (options.maxSize          )
    : DEFAULT_MAX_SIZE;
  const db = options.db ?? null;

  if (db) {
    ensureLoginChallengeTable(db);

    const sweepExpiredSql = () => {
      const cutoff = now() - ttlMs;
      db.prepare('DELETE FROM _LoginChallenge WHERE reservedBy IS NULL AND created < ?').run(cutoff);
    };

    const cleanup = setInterval(() => {
      try {
        sweepExpiredSql();
      } catch {
        // Ignore cleanup failures if db was closed.
      }
    }, 60_000);
    cleanup.unref();

    return {
      set(userId        )         {
        sweepExpiredSql();
        const countRow = db.prepare('SELECT COUNT(*) AS n FROM _LoginChallenge').get()                 ;
        if (countRow.n >= maxSize) {
          const excess = countRow.n - maxSize + 1;
          db.prepare(`
            DELETE FROM _LoginChallenge
            WHERE challenge IN (
              SELECT challenge FROM _LoginChallenge
              WHERE reservedBy IS NULL
              ORDER BY created ASC
              LIMIT ?
            )
          `).run(excess);
          const afterRow = db.prepare('SELECT COUNT(*) AS n FROM _LoginChallenge').get()                 ;
          if (afterRow.n >= maxSize) {
            db.prepare(`
              DELETE FROM _LoginChallenge
              WHERE challenge IN (
                SELECT challenge FROM _LoginChallenge
                ORDER BY created ASC
                LIMIT ?
              )
            `).run(afterRow.n - maxSize + 1);
          }
        }
        const challenge = generateLoginChallenge();
        db.prepare(
          'INSERT INTO _LoginChallenge (challenge, userId, attempts, created, reservedBy) VALUES (?, ?, 0, ?, NULL)',
        ).run(challenge, userId, now());
        return challenge;
      },
      get(challenge        )                             {
        const row = db.prepare(
          'SELECT userId, attempts, created, reservedBy FROM _LoginChallenge WHERE challenge = ?',
        ).get(challenge)                               ;
        if (!row) return null;
        if (row.reservedBy !== null) return null;
        if (now() - row.created > ttlMs) {
          db.prepare('DELETE FROM _LoginChallenge WHERE challenge = ? AND reservedBy IS NULL').run(challenge);
          return null;
        }
        return { userId: row.userId, attempts: row.attempts, created: row.created };
      },
      reserve(challengeId        )                             {
        const current = now();
        const row = db.prepare(
          'SELECT userId, attempts, created, reservedBy FROM _LoginChallenge WHERE challenge = ?',
        ).get(challengeId)                               ;
        if (!row) return null;
        if (row.reservedBy !== null) return null;
        if (current - row.created > ttlMs) {
          db.prepare('DELETE FROM _LoginChallenge WHERE challenge = ? AND reservedBy IS NULL').run(challengeId);
          return null;
        }
        if (row.attempts >= maxAttempts) {
          db.prepare('DELETE FROM _LoginChallenge WHERE challenge = ? AND reservedBy IS NULL').run(challengeId);
          return null;
        }
        const token = crypto.randomBytes(16).toString('hex');
        const res = db.prepare(
          'UPDATE _LoginChallenge SET reservedBy = ? WHERE challenge = ? AND reservedBy IS NULL',
        ).run(token, challengeId);
        if (Number(res.changes) !== 1) return null;
        return { challenge: challengeId, userId: row.userId, createdAt: row.created, token };
      },
      finalize(claim                     )          {
        const row = db.prepare(
          'SELECT reservedBy FROM _LoginChallenge WHERE challenge = ?',
        ).get(claim.challenge)                                             ;
        if (!row) return false;
        if (row.reservedBy !== claim.token) {
          db.prepare('DELETE FROM _LoginChallenge WHERE challenge = ?').run(claim.challenge);
          return false;
        }
        db.prepare('DELETE FROM _LoginChallenge WHERE challenge = ?').run(claim.challenge);
        return true;
      },
      release(claim                     )          {
        const row = db.prepare(
          'SELECT created, reservedBy FROM _LoginChallenge WHERE challenge = ?',
        ).get(claim.challenge)                                                              ;
        if (!row) return false;
        if (row.reservedBy !== claim.token) return false;
        if (now() - row.created > ttlMs) {
          db.prepare('DELETE FROM _LoginChallenge WHERE challenge = ?').run(claim.challenge);
          return true;
        }
        db.prepare('UPDATE _LoginChallenge SET reservedBy = NULL WHERE challenge = ? AND reservedBy = ?')
          .run(claim.challenge, claim.token);
        return true;
      },
      fail(claim                     )          {
        const row = db.prepare(
          'SELECT attempts, created, reservedBy FROM _LoginChallenge WHERE challenge = ?',
        ).get(claim.challenge)                                                                                ;
        if (!row) return false;
        if (row.reservedBy !== claim.token) return false;
        const nextAttempts = row.attempts + 1;
        if (nextAttempts >= maxAttempts || now() - row.created > ttlMs) {
          db.prepare('DELETE FROM _LoginChallenge WHERE challenge = ?').run(claim.challenge);
          return false;
        }
        db.prepare('UPDATE _LoginChallenge SET attempts = ?, reservedBy = NULL WHERE challenge = ? AND reservedBy = ?')
          .run(nextAttempts, claim.challenge, claim.token);
        return true;
      },
      size()         {
        sweepExpiredSql();
        const row = db.prepare('SELECT COUNT(*) AS n FROM _LoginChallenge').get()                 ;
        return row.n;
      },
      destroy() {
        clearInterval(cleanup);
      },
    };
  }

  const store = new Map                         ();

  function sweepExpired()       {
    const current = now();
    for (const [challenge, entry] of store) {
      if (entry.reservedBy === null && current - entry.created > ttlMs) {
        store.delete(challenge);
      }
    }
  }

  function evictIfFull()       {
    if (store.size < maxSize) return;
    sweepExpired();
    if (store.size < maxSize) return;
    // Evict oldest unreserved entries first (Map preserves insertion order).
    for (const [challenge, entry] of store) {
      if (store.size < maxSize) break;
      if (entry.reservedBy === null) {
        store.delete(challenge);
      }
    }
    // If still at capacity (all reserved), evict oldest entries.
    for (const challenge of store.keys()) {
      if (store.size < maxSize) break;
      store.delete(challenge);
    }
  }

  // Periodic cleanup sweeps EXPIRED AVAILABLE entries every 60 seconds. A
  // reserved challenge is never swept: the reservation holder may settle after
  // nominal expiry, and only release/fail re-check the TTL.
  const cleanup = setInterval(sweepExpired, 60_000);
  cleanup.unref();

  // The live available record for a challenge, or null. Reserved entries are
  // invisible here — they belong to a claim until settled.
  function getAvailable(challenge        )                         {
    const entry = store.get(challenge);
    if (!entry) return null;
    if (entry.reservedBy !== null) return null;
    if (now() - entry.created > ttlMs) {
      store.delete(challenge);
      return null;
    }
    return entry;
  }

  return {
    set(userId        )         {
      evictIfFull();
      const challenge = generateLoginChallenge();
      store.set(challenge, { userId, attempts: 0, created: now(), reservedBy: null });
      return challenge;
    },
    get(challenge        )                             {
      return getAvailable(challenge);
    },
    reserve(challengeId        )                             {
      const entry = store.get(challengeId);
      if (!entry) return null; // unknown or already settled
      if (entry.reservedBy !== null) return null; // already reserved
      if (now() - entry.created > ttlMs) {
        store.delete(challengeId);
        return null;
      }
      if (entry.attempts >= maxAttempts) {
        // Exhausted — defensive (fail deletes at the cap).
        store.delete(challengeId);
        return null;
      }
      const token = crypto.randomBytes(16).toString('hex');
      entry.reservedBy = token;
      return { challenge: challengeId, userId: entry.userId, createdAt: entry.created, token };
    },
    finalize(claim                     )          {
      const entry = store.get(claim.challenge);
      if (!entry) return false;
      if (entry.reservedBy !== claim.token) {
        // Claim mismatch: fail closed and invalidate — never release.
        store.delete(claim.challenge);
        return false;
      }
      store.delete(claim.challenge);
      return true;
    },
    release(claim                     )          {
      const entry = store.get(claim.challenge);
      if (!entry) return false;
      if (entry.reservedBy !== claim.token) return false; // mismatch — leave untouched
      if (now() - entry.created > ttlMs) {
        store.delete(claim.challenge);
        return true;
      }
      entry.reservedBy = null;
      return true;
    },
    fail(claim                     )          {
      const entry = store.get(claim.challenge);
      if (!entry) return false;
      if (entry.reservedBy !== claim.token) return false; // mismatch — leave untouched
      entry.attempts += 1;
      if (entry.attempts >= maxAttempts || now() - entry.created > ttlMs) {
        store.delete(claim.challenge);
        return false;
      }
      entry.reservedBy = null;
      return true;
    },
    size()         {
      sweepExpired();
      return store.size;
    },
    destroy() {
      clearInterval(cleanup);
      store.clear();
    },
  };
}

// The public type of a login challenge store. Named so consumers (authRoutes'
// `loginChallengeStore` option) can type the seam without importing the factory.


// The default singleton login challenge store — used by the built-in auth
// routes. Module-level so a login challenge survives in the single process that
// issued it (the framework is single-node; an in-memory store is the right
// durability for a 5-minute handoff that already depends on the issuer).
export const loginChallengeStore = createLoginChallengeStore();
