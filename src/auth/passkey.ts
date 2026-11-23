// passkey.mjs — WebAuthn (passkey) challenge and verification logic.
//
// Zero runtime dependencies: implemented on `node:crypto` only. The framework
// owns challenge issue/verify + credential storage as framework auth entities;
// the app owns the UI (button, prompt, error display).
//
// Registration uses `navigator.credentials.create()` (attestation); login uses
// `navigator.credentials.get()` (assertion). The server issues challenges,
// stores them with TTL + bounded capacity (or optional SQLite persistence), and
// verifies the client's response against the stored challenge + the stored
// credential's public key.
//
//   - generateChallenge() → random bytes, base64url-encoded
//   - challengeStore — bounded in-memory Map with TTL cleanup (+ optional SQLite)
//   - decodeCbor(buf, offset) → complete RFC 8949 CBOR decoder (major types 0–7)
//   - verifyRegistration(challenge, credential, rp) → parses attestation,
//     validates RP ID hash, extracts credential ID + SPKI public key (ES256,
//     RS256, EdDSA)
//   - verifyAuthentication(challenge, credential, storedCredential, rp, options)
//     → validates assertion (UP + UV by default), verifies signature against
//     stored public key (ES256, RS256, EdDSA)
//   - parseClientDataJSON(base64url) → decoded JSON with { challenge, origin, type }
//   - parseAuthenticatorData(buf) → { rpIdHash, flags, signCount }

import crypto from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// ---- RP configuration --------------------------------------------------------
// Sensible defaults; overridable via config.rp per-app.

// The RP identity an app overrides per-app (cfg.rp) and the frozen default.
export interface RpConfig {
  name: string;
  id: string;
  origin: string;
  requireUserVerification?: boolean;
}

const defaultRp: Readonly<RpConfig> = Object.freeze({
  name: 'workbench',
  id: 'localhost',
  origin: 'http://localhost:3000',
});

interface RpOptions {
  rp?: Partial<RpConfig>;
}

// rpConfig(cfg) → frozen { name, id, origin }. Picks per-app overrides from
// cfg.rp; absent keys fall back to the defaultRp. The shape is frozen so no
// later layer can mutate the RP identity.
export function rpConfig(cfg: RpOptions = {}): Readonly<RpConfig> {
  const rp = cfg?.rp ?? {};
  const result: RpConfig = {
    name: rp.name ?? defaultRp.name,
    id: rp.id ?? defaultRp.id,
    origin: rp.origin ?? defaultRp.origin,
  };
  if (typeof rp.requireUserVerification === 'boolean') {
    result.requireUserVerification = rp.requireUserVerification;
  }
  return Object.freeze(result);
}

// ---- challenge generation ----------------------------------------------------

// generateChallenge(length) → base64url-encoded random bytes. The default
// 32 bytes (256 bits of entropy) is the WebAuthn recommendation.
export function generateChallenge(length = 32): string {
  return crypto.randomBytes(length).toString('base64url');
}

// ---- challenge store ---------------------------------------------------------

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_CHALLENGES = 10_000;

interface SqlStatementLike {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqlDbLike {
  exec?(sql: string): unknown;
  prepare(sql: string): SqlStatementLike;
}

// A stored challenge entry: the caller's data plus the creation timestamp the
// TTL sweep and the expiry check read.
export interface ChallengeEntry {
  created: number;
  [key: string]: unknown;
}

export interface ChallengeStore {
  set(challenge: string, data?: Record<string, unknown>): string;
  get(challenge: string): ChallengeEntry | null;
  consume(challenge: string): ChallengeEntry | null;
  size(): number;
  destroy(): void;
}

export interface ChallengeStoreOptions {
  ttlMs?: number;
  maxSize?: number;
  db?: SqlDbLike | null;
  now?: () => number;
}

function ensurePasskeyChallengeTable(db: SqlDbLike): void {
  const ddl = `
    CREATE TABLE IF NOT EXISTS _PasskeyChallenge (
      challenge TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx__PasskeyChallenge_created ON _PasskeyChallenge (created);
  `;
  if (typeof db.exec === 'function') {
    db.exec(ddl);
  } else {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS _PasskeyChallenge (
        challenge TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created INTEGER NOT NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx__PasskeyChallenge_created ON _PasskeyChallenge (created)').run();
  }
}

// createChallengeStore(ttlMsOrOptions, extraOptions) → { set, get, consume,
// size, destroy }. A bounded store with TTL-based expiry: entries older than
// ttlMs are dropped and insertions above maxSize evict expired entries first,
// then oldest entries. `consume` is a single-use read (get + delete) so a
// challenge cannot be replayed. Passing `{ db }` persists challenges in SQLite
// so pending ceremonies survive restarts.
export function createChallengeStore(
  ttlMsOrOptions: number | ChallengeStoreOptions = DEFAULT_CHALLENGE_TTL_MS,
  extraOptions: Omit<ChallengeStoreOptions, 'ttlMs'> = {},
): ChallengeStore {
  const opts: ChallengeStoreOptions = typeof ttlMsOrOptions === 'object' && ttlMsOrOptions !== null
    ? ttlMsOrOptions
    : { ttlMs: ttlMsOrOptions, ...extraOptions };
  const ttlMs = typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
    ? opts.ttlMs
    : DEFAULT_CHALLENGE_TTL_MS;
  const maxSize = Number.isInteger(opts.maxSize) && (opts.maxSize as number) > 0
    ? (opts.maxSize as number)
    : DEFAULT_MAX_CHALLENGES;
  const db = opts.db ?? null;
  const now = opts.now ?? Date.now;

  if (db) {
    ensurePasskeyChallengeTable(db);

    const sweepExpiredSql = () => {
      db.prepare('DELETE FROM _PasskeyChallenge WHERE created < ?').run(now() - ttlMs);
    };

    const cleanup = setInterval(() => {
      try {
        sweepExpiredSql();
      } catch {
        // Ignore if db was closed.
      }
    }, 60_000);
    cleanup.unref();

    return {
      set(challenge, data = {}) {
        sweepExpiredSql();
        const countRow = db.prepare('SELECT COUNT(*) AS n FROM _PasskeyChallenge').get() as { n: number };
        if (countRow.n >= maxSize) {
          const excess = countRow.n - maxSize + 1;
          db.prepare(`
            DELETE FROM _PasskeyChallenge
            WHERE challenge IN (
              SELECT challenge FROM _PasskeyChallenge
              ORDER BY created ASC
              LIMIT ?
            )
          `).run(excess);
        }
        db.prepare(
          'INSERT OR REPLACE INTO _PasskeyChallenge (challenge, data, created) VALUES (?, ?, ?)',
        ).run(challenge, JSON.stringify(data), now());
        return challenge;
      },
      get(challenge) {
        const row = db.prepare(
          'SELECT data, created FROM _PasskeyChallenge WHERE challenge = ?',
        ).get(challenge) as { data: string; created: number } | undefined;
        if (!row) return null;
        if (now() - row.created > ttlMs) {
          db.prepare('DELETE FROM _PasskeyChallenge WHERE challenge = ?').run(challenge);
          return null;
        }
        const parsed = JSON.parse(row.data) as Record<string, unknown>;
        return Object.freeze({ ...parsed, created: row.created });
      },
      consume(challenge) {
        const row = db.prepare(
          'SELECT data, created FROM _PasskeyChallenge WHERE challenge = ?',
        ).get(challenge) as { data: string; created: number } | undefined;
        if (!row) return null;
        const del = db.prepare('DELETE FROM _PasskeyChallenge WHERE challenge = ?').run(challenge);
        if (Number(del.changes) !== 1) return null;
        if (now() - row.created > ttlMs) return null;
        const parsed = JSON.parse(row.data) as Record<string, unknown>;
        return Object.freeze({ ...parsed, created: row.created });
      },
      size() {
        sweepExpiredSql();
        const row = db.prepare('SELECT COUNT(*) AS n FROM _PasskeyChallenge').get() as { n: number };
        return row.n;
      },
      destroy() {
        clearInterval(cleanup);
      },
    };
  }

  const store = new Map<string, ChallengeEntry>();

  function sweepExpired(): void {
    const current = now();
    for (const [challenge, entry] of store) {
      if (current - entry.created > ttlMs) store.delete(challenge);
    }
  }

  function evictIfFull(): void {
    if (store.size < maxSize) return;
    sweepExpired();
    for (const challenge of store.keys()) {
      if (store.size < maxSize) break;
      store.delete(challenge);
    }
  }

  // Periodic cleanup sweeps expired entries every 60 seconds. The interval is
  // unref'd so it doesn't keep the process alive.
  const cleanup = setInterval(sweepExpired, 60_000);
  cleanup.unref();

  return {
    set(challenge, data = {}) {
      if (!store.has(challenge)) evictIfFull();
      store.set(challenge, Object.freeze({ ...data, created: now() }));
      return challenge;
    },
    get(challenge) {
      const entry = store.get(challenge);
      if (!entry) return null;
      if (now() - entry.created > ttlMs) {
        store.delete(challenge);
        return null;
      }
      return entry;
    },
    consume(challenge) {
      const entry = this.get(challenge);
      if (entry) store.delete(challenge);
      return entry;
    },
    size() {
      sweepExpired();
      return store.size;
    },
    destroy() {
      clearInterval(cleanup);
      store.clear();
    },
  };
}

// The default singleton challenge store — used by the built-in auth routes.
export const challengeStore = createChallengeStore();

// ---- base64url helpers -------------------------------------------------------

function base64urlToBuffer(str: string): Buffer {
  // Replace URL-safe chars, pad to multiple of 4.
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// ---- client data JSON --------------------------------------------------------

// parseClientDataJSON(base64urlStr) → decoded JSON object. `clientDataJSON` is
// a base64url-encoded JSON string with { challenge, origin, type, ... }.
export function parseClientDataJSON(base64urlStr: string): Record<string, unknown> {
  const buf = base64urlToBuffer(base64urlStr);
  return JSON.parse(buf.toString('utf-8'));
}

// ---- SHA-256 helper ----------------------------------------------------------

function sha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

// ---- authenticator data parser -----------------------------------------------

// parseAuthenticatorData(authData) → { rpIdHash, flags, signCount }.
// `authData` is a Buffer whose first 37 bytes are the fixed header:
//   bytes 0–31:  SHA-256 of RP ID
//   byte 32:     flags (bit 0: UP, bit 2: UV, bit 6: AT, bit 7: ED)
//   bytes 33–36: sign counter (32-bit big-endian)
export function parseAuthenticatorData(authData: Buffer): { rpIdHash: Buffer; flags: number; signCount: number } {
  if (!Buffer.isBuffer(authData) || authData.length < 37) {
    throw new Error('authenticator data too short (expected at least 37 bytes)');
  }
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  return { rpIdHash, flags, signCount };
}

// ---- complete RFC 8949 CBOR decoder ------------------------------------------
// Supports all CBOR major types 0–7:
//   - major 0: unsigned integer (0..23, u8, u16, u32, u64)
//   - major 1: negative integer (-1 - n)
//   - major 2: byte string (definite & indefinite length)
//   - major 3: text string (definite & indefinite length)
//   - major 4: array (definite & indefinite length)
//   - major 5: map (definite & indefinite length, null-prototype to block __proto__)
//   - major 6: semantic tag ({ tag, value })
//   - major 7: simple values (false, true, null, undefined, simple) and IEEE 754
//              float16 / float32 / float64

const MAX_CBOR_DEPTH = 64;

export interface CborResult {
  value: unknown;
  pos: number;
}

export interface CborTag {
  tag: number;
  value: unknown;
}

function assertBounds(buf: Buffer, end: number): void {
  if (end > buf.length) {
    throw new Error(`truncated CBOR input (needed offset ${end}, length ${buf.length})`);
  }
}

function decodeCborUint(buf: Buffer, offset: number): { len: number; pos: number } {
  assertBounds(buf, offset + 1);
  const ai = buf[offset] & 0x1f;
  if (ai < 24) return { len: ai, pos: offset + 1 };
  if (ai === 24) {
    assertBounds(buf, offset + 2);
    return { len: buf[offset + 1], pos: offset + 2 };
  }
  if (ai === 25) {
    assertBounds(buf, offset + 3);
    return { len: buf.readUInt16BE(offset + 1), pos: offset + 3 };
  }
  if (ai === 26) {
    assertBounds(buf, offset + 5);
    return { len: buf.readUInt32BE(offset + 1), pos: offset + 5 };
  }
  if (ai === 27) {
    assertBounds(buf, offset + 9);
    const hi = buf.readUInt32BE(offset + 1);
    const lo = buf.readUInt32BE(offset + 5);
    return { len: Number((BigInt(hi) << 32n) | BigInt(lo)), pos: offset + 9 };
  }
  throw new Error(`unsupported CBOR additional info: ${ai} at offset ${offset}`);
}

function decodeFloat16(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const frac = bits & 0x03ff;
  if (exp === 0) {
    return sign * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 0x1f) {
    return frac === 0 ? sign * Infinity : NaN;
  }
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

export function decodeCbor(buf: Buffer, offset = 0, depth = 0): CborResult {
  if (depth > MAX_CBOR_DEPTH) {
    throw new Error('CBOR nesting depth exceeded');
  }
  assertBounds(buf, offset + 1);
  const byte = buf[offset];
  const major = byte >> 5;
  const ai = byte & 0x1f;

  switch (major) {
    case 0: { // unsigned integer
      const { len, pos } = decodeCborUint(buf, offset);
      return { value: len, pos };
    }
    case 1: { // negative integer: value = -1 - n
      const { len, pos } = decodeCborUint(buf, offset);
      return { value: -1 - len, pos };
    }
    case 2: { // byte string (definite or indefinite)
      if (ai === 31) {
        const chunks: Buffer[] = [];
        let p = offset + 1;
        while (true) {
          assertBounds(buf, p + 1);
          if (buf[p] === 0xff) {
            return { value: Buffer.concat(chunks), pos: p + 1 };
          }
          if ((buf[p] >> 5) !== 2 || (buf[p] & 0x1f) === 31) {
            throw new Error(`invalid chunk inside indefinite CBOR byte string at offset ${p}`);
          }
          const chunk = decodeCbor(buf, p, depth + 1);
          chunks.push(chunk.value as Buffer);
          p = chunk.pos;
        }
      }
      const { len, pos } = decodeCborUint(buf, offset);
      assertBounds(buf, pos + len);
      return { value: Buffer.from(buf.subarray(pos, pos + len)), pos: pos + len };
    }
    case 3: { // text string (definite or indefinite)
      if (ai === 31) {
        const chunks: string[] = [];
        let p = offset + 1;
        while (true) {
          assertBounds(buf, p + 1);
          if (buf[p] === 0xff) {
            return { value: chunks.join(''), pos: p + 1 };
          }
          if ((buf[p] >> 5) !== 3 || (buf[p] & 0x1f) === 31) {
            throw new Error(`invalid chunk inside indefinite CBOR text string at offset ${p}`);
          }
          const chunk = decodeCbor(buf, p, depth + 1);
          chunks.push(chunk.value as string);
          p = chunk.pos;
        }
      }
      const { len, pos } = decodeCborUint(buf, offset);
      assertBounds(buf, pos + len);
      return { value: buf.subarray(pos, pos + len).toString('utf-8'), pos: pos + len };
    }
    case 4: { // array (definite or indefinite)
      const arr: unknown[] = [];
      if (ai === 31) {
        let p = offset + 1;
        while (true) {
          assertBounds(buf, p + 1);
          if (buf[p] === 0xff) {
            return { value: arr, pos: p + 1 };
          }
          const item = decodeCbor(buf, p, depth + 1);
          arr.push(item.value);
          p = item.pos;
        }
      }
      const { len: count, pos: afterLen } = decodeCborUint(buf, offset);
      let p = afterLen;
      for (let i = 0; i < count; i++) {
        const item = decodeCbor(buf, p, depth + 1);
        arr.push(item.value);
        p = item.pos;
      }
      return { value: arr, pos: p };
    }
    case 5: { // map (definite or indefinite)
      const map: Record<string, unknown> = Object.create(null);
      if (ai === 31) {
        let p = offset + 1;
        while (true) {
          assertBounds(buf, p + 1);
          if (buf[p] === 0xff) {
            return { value: map, pos: p + 1 };
          }
          const key = decodeCbor(buf, p, depth + 1);
          const val = decodeCbor(buf, key.pos, depth + 1);
          map[String(key.value)] = val.value;
          p = val.pos;
        }
      }
      const { len: count, pos: afterLen } = decodeCborUint(buf, offset);
      let p = afterLen;
      for (let i = 0; i < count; i++) {
        const key = decodeCbor(buf, p, depth + 1);
        const val = decodeCbor(buf, key.pos, depth + 1);
        map[String(key.value)] = val.value;
        p = val.pos;
      }
      return { value: map, pos: p };
    }
    case 6: { // semantic tag
      const { len: tag, pos: afterTag } = decodeCborUint(buf, offset);
      const inner = decodeCbor(buf, afterTag, depth + 1);
      return { value: { tag, value: inner.value } satisfies CborTag, pos: inner.pos };
    }
    case 7: { // simple values and IEEE 754 floating-point numbers
      if (ai < 20) return { value: ai, pos: offset + 1 };
      if (ai === 20) return { value: false, pos: offset + 1 };
      if (ai === 21) return { value: true, pos: offset + 1 };
      if (ai === 22) return { value: null, pos: offset + 1 };
      if (ai === 23) return { value: undefined, pos: offset + 1 };
      if (ai === 24) {
        assertBounds(buf, offset + 2);
        return { value: buf[offset + 1], pos: offset + 2 };
      }
      if (ai === 25) {
        assertBounds(buf, offset + 3);
        return { value: decodeFloat16(buf.readUInt16BE(offset + 1)), pos: offset + 3 };
      }
      if (ai === 26) {
        assertBounds(buf, offset + 5);
        return { value: buf.readFloatBE(offset + 1), pos: offset + 5 };
      }
      if (ai === 27) {
        assertBounds(buf, offset + 9);
        return { value: buf.readDoubleBE(offset + 1), pos: offset + 9 };
      }
      throw new Error(`unexpected CBOR simple/break byte 0x${byte.toString(16)} at offset ${offset}`);
    }
    default:
      throw new Error(`unsupported CBOR major type: ${major} (byte 0x${byte.toString(16)} at offset ${offset})`);
  }
}

// ---- attestation object parsing ----------------------------------------------

// The only attestation format this server accepts. `fmt: 'none'` (self
// attestation) carries an empty attStmt, so there is no statement to verify.
// Every other WebAuthn format (packed, tpm, u2f, ...) requires its own
// statement verification; accepting one without verifying it would let a
// client submit unverified, attacker-chosen authenticator material (#245).
// Fail closed: reject every format we do not verify.
const SUPPORTED_ATTESTATION_FMT = 'none';

// parseAttestationObject(base64urlStr) → { fmt, attStmt, authData }.
// Decodes the base64url-encoded CBOR attestation object from the client and
// validates its structure and format before any credential material is trusted.
function parseAttestationObject(base64urlStr: string): { fmt: string; attStmt: Record<string, unknown>; authData: Buffer } {
  const buf = base64urlToBuffer(base64urlStr);
  const { value, pos } = decodeCbor(buf, 0);
  // A second CBOR item (or stray bytes) after the attestation object is
  // malformed input; do not silently ignore the unparsed portion.
  if (pos !== buf.length) {
    throw new Error('attestation object has trailing data');
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw new Error('attestation object is not a CBOR map');
  }
  const { fmt, attStmt, authData } = value as Record<string, unknown>;
  if (!Buffer.isBuffer(authData)) {
    throw new Error('attestation object missing authData byte string');
  }
  // fmt must be a declared, supported string. A missing/malformed fmt or an
  // unsupported format is rejected rather than defaulted into acceptance.
  if (typeof fmt !== 'string' || fmt.length === 0) {
    throw new Error('attestation object missing fmt');
  }
  if (fmt !== SUPPORTED_ATTESTATION_FMT) {
    throw new Error(`unsupported attestation format: ${fmt}`);
  }
  // WebAuthn requires an empty attStmt for 'none'. A non-empty statement is
  // either malformed or an attestation we are not verifying — reject both.
  if (attStmt == null || typeof attStmt !== 'object' || Array.isArray(attStmt) || Buffer.isBuffer(attStmt)) {
    throw new Error('attestation object has malformed attStmt');
  }
  if (Object.keys(attStmt).length !== 0) {
    throw new Error('fmt "none" requires an empty attStmt');
  }
  return { fmt, attStmt: attStmt as Record<string, unknown>, authData };
}

// ---- attested credential data extraction -------------------------------------

// extractAttestedCredentialData(authData, offset) → { credentialId, publicKey }
// authData is the authenticator data Buffer; offset is the start of the attested
// credential data section (byte 37 of the full authData). Extracts the
// credential ID and the COSE-encoded public key.
function extractAttestedCredentialData(authData: Buffer, offset = 37): { credentialId: Buffer; publicKey: Buffer } {
  if (authData.length < offset + 18) {
    throw new Error('attested credential data truncated');
  }
  // AAGUID: 16 bytes
  const aaguidOffset = offset + 16;
  // Credential ID length: 2 bytes big-endian
  const credIdLen = authData.readUInt16BE(aaguidOffset);
  const credIdStart = aaguidOffset + 2;
  if (authData.length < credIdStart + credIdLen + 1) {
    throw new Error('attested credential data missing credentialId or public key');
  }
  const credentialId = Buffer.from(authData.subarray(credIdStart, credIdStart + credIdLen));
  // Remaining bytes: COSE public key
  const coseKeyBuf = authData.subarray(credIdStart + credIdLen);
  const publicKey = decodeCosePublicKey(coseKeyBuf);
  return { credentialId, publicKey };
}

// ---- COSE public key conversion ----------------------------------------------
// Converts a COSE_Key-encoded public key to DER/SPKI format.
// Supported WebAuthn algorithms:
//   - ES256 (alg: -7):   kty=2 (EC2), crv=1 (P-256), x (-2), y (-3)
//   - RS256 (alg: -257): kty=3 (RSA), n (-1), e (-2)
//   - EdDSA (alg: -8):   kty=1 (OKP), crv=6 (Ed25519), x (-2)

export function decodeCosePublicKey(coseBuf: Buffer): Buffer {
  const { value } = decodeCbor(coseBuf, 0);
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('credential public key is not a CBOR map');
  }
  const coseKey = value as Record<string | number, unknown>;
  const kty = coseKey[1];
  const alg = coseKey[3];

  // ES256: EC2 P-256
  if (kty === 2) {
    if (alg != null && alg !== -7) {
      throw new Error(`unsupported EC2 COSE algorithm: ${String(alg)}`);
    }
    if (coseKey[-1] !== 1) throw new Error('COSE key crv is not P-256');
    const x = coseKey[-2];
    const y = coseKey[-3];
    if (!Buffer.isBuffer(x) || x.length !== 32) throw new Error('invalid COSE key x coordinate');
    if (!Buffer.isBuffer(y) || y.length !== 32) throw new Error('invalid COSE key y coordinate');
    const keyObj = crypto.createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: x.toString('base64url'),
        y: y.toString('base64url'),
      },
      format: 'jwk',
    });
    return keyObj.export({ format: 'der', type: 'spki' });
  }

  // RS256: RSA
  if (kty === 3) {
    if (alg != null && alg !== -257) {
      throw new Error(`unsupported RSA COSE algorithm: ${String(alg)}`);
    }
    const n = coseKey[-1];
    const e = coseKey[-2];
    if (!Buffer.isBuffer(n) || n.length < 128) throw new Error('invalid COSE RSA modulus');
    if (!Buffer.isBuffer(e) || e.length === 0) throw new Error('invalid COSE RSA exponent');
    const keyObj = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: n.toString('base64url'),
        e: e.toString('base64url'),
      },
      format: 'jwk',
    });
    return keyObj.export({ format: 'der', type: 'spki' });
  }

  // EdDSA: OKP Ed25519
  if (kty === 1) {
    if (alg != null && alg !== -8) {
      throw new Error(`unsupported OKP COSE algorithm: ${String(alg)}`);
    }
    if (coseKey[-1] !== 6) throw new Error('COSE OKP key crv is not Ed25519');
    const x = coseKey[-2];
    if (!Buffer.isBuffer(x) || x.length !== 32) throw new Error('invalid COSE Ed25519 public key');
    const keyObj = crypto.createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: x.toString('base64url'),
      },
      format: 'jwk',
    });
    return keyObj.export({ format: 'der', type: 'spki' });
  }

  throw new Error(`unsupported COSE key type (kty): ${String(kty)}`);
}

// ---- registration verification -----------------------------------------------

// The client-supplied credential in a WebAuthn ceremony (registration or
// assertion). `response` carries the base64url-encoded ceremony payloads the
// server verifies; the optional metadata (name/transports/backedUp) is stored
// alongside the credential on registration.
interface PublicKeyCredential {
  id?: string;
  rawId?: string;
  type?: string;
  name?: string;
  transports?: string | string[];
  backedUp?: unknown;
  response: {
    clientDataJSON: string;
    attestationObject?: string;
    authenticatorData?: string;
    signature?: string;
    userHandle?: string;
  };
}

// The stored Credential entity row the assertion verifier reads: the credential
// id (base64url), the public key (DER/SPKI, base64url), and the last-seen sign
// counter (replay protection).
interface StoredCredential {
  credentialId: string;
  publicKey: string;
  signCount?: number;
}

export interface VerifyAuthenticationOptions {
  requireUserVerification?: boolean;
}

// verifyRegistration(challenge, credential, rp) → { credentialId, publicKey, signCount }
// Verifies a WebAuthn registration (attestation) response.
//
// credential shape (from client):
//   { id, rawId, response: { clientDataJSON, attestationObject }, type }
//
// Throws on any validation failure (fail closed). On success, returns the
// extracted credential material to store in the Credential entity.
export function verifyRegistration(challenge: string, credential: PublicKeyCredential, rp: Readonly<RpConfig>): { credentialId: string; publicKey: string; signCount: number } {
  // 1. Parse and validate clientDataJSON
  const clientData = parseClientDataJSON(credential.response.clientDataJSON);

  if (clientData.challenge !== challenge) {
    throw new Error('challenge mismatch in clientDataJSON');
  }
  if (clientData.origin !== rp.origin) {
    throw new Error(`origin mismatch: expected ${rp.origin}, got ${clientData.origin}`);
  }
  if (clientData.type !== 'webauthn.create') {
    throw new Error(`invalid clientData type for registration: ${clientData.type}`);
  }

  // 2. Parse attestation object (CBOR)
  const attObj = parseAttestationObject(credential.response.attestationObject!);
  const authData = attObj.authData;

  // 3. Parse authenticator data header
  const parsed = parseAuthenticatorData(authData);

  // 4. Verify RP ID hash
  const expectedRpIdHash = sha256(Buffer.from(rp.id));
  if (!crypto.timingSafeEqual(parsed.rpIdHash, expectedRpIdHash)) {
    throw new Error('RP ID hash mismatch in authenticator data');
  }

  // 5. Verify user present flag (UP, bit 0)
  if (!(parsed.flags & 0x01)) {
    throw new Error('user not present (UP flag not set)');
  }

  // 6. Verify attested credential data is present (AT, bit 6)
  if (!(parsed.flags & 0x40)) {
    throw new Error('attested credential data not present (AT flag not set)');
  }

  // 7. Extract credential ID and public key from attested credential data
  const { credentialId, publicKey } = extractAttestedCredentialData(authData);
  const attestedCredentialId = credentialId.toString('base64url');

  // 8. The client-declared id/rawId must name the SAME credential the
  //    authenticator attested to. Without this comparison a caller could bind
  //    its own key pair to a victim's credential ID and shadow their passkey
  //    (#245). The attested ID is authoritative for storage and uniqueness.
  for (const declared of [credential.id, credential.rawId]) {
    if (typeof declared === 'string' && declared.length > 0 && declared !== attestedCredentialId) {
      throw new Error('credential id does not match attested credential data');
    }
  }

  return {
    credentialId: attestedCredentialId,
    publicKey: publicKey.toString('base64url'),
    signCount: parsed.signCount,
  };
}

// ---- authentication verification ---------------------------------------------

// verifyAuthentication(challenge, credential, storedCredential, rp, options) → { signCount }
// Verifies a WebAuthn assertion response against a stored Credential entity row.
//
// credential shape (from client):
//   { id, rawId, response: { clientDataJSON, authenticatorData, signature, userHandle }, type }
//
// storedCredential shape: { credentialId, publicKey (base64url SPKI), signCount }
//
// Throws on any validation failure; on success returns the new signCount to
// update the stored credential (replay protection). Enforces User Verification
// (UV, bit 0x04) by default for passwordless passkey login; callers may pass
// `{ requireUserVerification: false }` when UV is explicitly optional.
export function verifyAuthentication(
  challenge: string,
  credential: PublicKeyCredential,
  storedCredential: StoredCredential,
  rp: Readonly<RpConfig>,
  options: VerifyAuthenticationOptions = {},
): { signCount: number } {
  const requireUserVerification = options.requireUserVerification ?? rp.requireUserVerification ?? true;

  // 1. Parse and validate clientDataJSON
  const clientData = parseClientDataJSON(credential.response.clientDataJSON);

  if (clientData.challenge !== challenge) {
    throw new Error('challenge mismatch in clientDataJSON');
  }
  if (clientData.origin !== rp.origin) {
    throw new Error(`origin mismatch: expected ${rp.origin}, got ${clientData.origin}`);
  }
  if (clientData.type !== 'webauthn.get') {
    throw new Error(`invalid clientData type for authentication: ${clientData.type}`);
  }

  // 2. Parse authenticator data
  const authData = base64urlToBuffer(credential.response.authenticatorData!);
  const parsed = parseAuthenticatorData(authData);

  // 3. Verify RP ID hash
  const expectedRpIdHash = sha256(Buffer.from(rp.id));
  if (!crypto.timingSafeEqual(parsed.rpIdHash, expectedRpIdHash)) {
    throw new Error('RP ID hash mismatch in authenticator data');
  }

  // 4. Verify user present flag (UP, bit 0) and user verified flag (UV, bit 2)
  if (!(parsed.flags & 0x01)) {
    throw new Error('user not present (UP flag not set)');
  }
  if (requireUserVerification && !(parsed.flags & 0x04)) {
    throw new Error('user verification required (UV flag not set)');
  }

  // 5. Counter check (replay protection). If both are zero (first use of a
  //    fresh credential), allow it. Otherwise the new counter must be strictly
  //    greater.
  const storedCount = storedCredential.signCount ?? 0;
  if (!(parsed.signCount === 0 && storedCount === 0) && parsed.signCount <= storedCount) {
    throw new Error(
      `signature counter not incremented: stored=${storedCount}, received=${parsed.signCount}`,
    );
  }

  // 6. Verify signature over authenticatorData || SHA256(clientDataJSON)
  const clientDataHash = sha256(base64urlToBuffer(credential.response.clientDataJSON));
  const signatureBase = Buffer.concat([authData, clientDataHash]);
  const signature = base64urlToBuffer(credential.response.signature!);

  const publicKey = crypto.createPublicKey({
    key: base64urlToBuffer(storedCredential.publicKey),
    format: 'der',
    type: 'spki',
  });

  const keyType = publicKey.asymmetricKeyType;
  let valid: boolean;
  if (keyType === 'ed25519') {
    valid = crypto.verify(null, signatureBase, publicKey, signature);
  } else if (keyType === 'ec' || keyType === 'rsa') {
    valid = crypto.verify('sha256', signatureBase, publicKey, signature);
  } else {
    throw new Error(`unsupported public key type: ${String(keyType)}`);
  }

  if (!valid) {
    throw new Error('invalid signature on authentication assertion');
  }

  return { signCount: parsed.signCount };
}

// ---- CBOR encoding helpers (for synthetic test builders) ---------------------

function encodeCborHead(major: number, n: number): Buffer {
  const prefix = major << 5;
  if (n < 24) return Buffer.from([prefix | n]);
  if (n < 0x100) return Buffer.from([prefix | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = prefix | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = prefix | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function encodeCborValue(value: unknown): Buffer {
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (value === undefined) return Buffer.from([0xf7]);
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      if (value >= 0) return encodeCborHead(0, value);
      return encodeCborHead(1, -1 - value);
    }
    const b = Buffer.alloc(9);
    b[0] = 0xfb;
    b.writeDoubleBE(value, 1);
    return b;
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([encodeCborHead(2, value.length), value]);
  }
  if (typeof value === 'string') {
    const utf8 = Buffer.from(value, 'utf-8');
    return Buffer.concat([encodeCborHead(3, utf8.length), utf8]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([encodeCborHead(4, value.length), ...value.map(encodeCborValue)]);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const parts = [encodeCborHead(5, entries.length)];
    for (const [k, v] of entries) {
      const numericKey = /^-?\d+$/.test(k) ? Number(k) : k;
      parts.push(encodeCborValue(numericKey), encodeCborValue(v));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`cannot CBOR-encode value of type ${typeof value}`);
}

// ---- synthetic credential builders (for testing) -----------------------------
// These construct minimal authenticatorData sequences for test usage, avoiding
// the need for real hardware. Exported so tests can construct assertions to feed
// through the real verify path.

// buildRpIdHash(rpId) → SHA-256 of the RP ID string.
export function buildRpIdHash(rpId: string): Buffer {
  return sha256(Buffer.from(rpId));
}

// buildAuthenticatorData({ rpIdHash, flags, signCount, credentialId, publicKey })
// → Buffer. Constructs a complete authenticatorData binary from the named parts.
// When credentialId and publicKey are provided, the attested credential data
// section is included (flags should have AT bit 0x40 set).
export function buildAuthenticatorData({ rpIdHash, flags, signCount, credentialId, publicKey }: {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: string;
  publicKey?: string;
}): Buffer {
  const parts = [rpIdHash, Buffer.from([flags])];
  // 4-byte big-endian sign counter
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount, 0);
  parts.push(counter);

  if (credentialId && publicKey) {
    // Attested credential data:
    //   AAGUID: 16 zero bytes
    //   credential id length: 2 bytes big-endian
    //   credential id: raw bytes
    //   public key: COSE-encoded bytes
    const aaguid = Buffer.alloc(16, 0);
    const idBuf = base64urlToBuffer(credentialId);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(idBuf.length, 0);
    const pkBuf = base64urlToBuffer(publicKey);
    parts.push(aaguid, idLen, idBuf, pkBuf);
  }

  return Buffer.concat(parts);
}

// buildClientDataJSON({ challenge, origin, type }) → base64url-encoded string.
export function buildClientDataJSON({ challenge, origin, type }: {
  challenge: string;
  origin: string;
  type: string;
}): string {
  const json = JSON.stringify({ challenge, origin, type });
  return Buffer.from(json, 'utf-8').toString('base64url');
}

// signAssertion(privateKey, authenticatorData, clientDataJSON) → base64url sig.
// Signs authenticatorData || SHA256(clientDataJSON) with the given privateKey
// (supports EC P-256, RSA RS256, and Ed25519 EdDSA).
export function signAssertion(privateKey: KeyObject, authenticatorDataBuf: Buffer, clientDataJSONBase64url: string): string {
  const clientDataHash = sha256(base64urlToBuffer(clientDataJSONBase64url));
  const signatureBase = Buffer.concat([authenticatorDataBuf, clientDataHash]);
  if (privateKey.asymmetricKeyType === 'ed25519') {
    return crypto.sign(null, signatureBase, privateKey).toString('base64url');
  }
  return crypto.sign('sha256', signatureBase, privateKey).toString('base64url');
}

// cosePublicKeyFromKeyPair(keypair) → base64url of COSE-encoded public key.
// Supports EC P-256 (ES256), RSA (RS256), and OKP Ed25519 (EdDSA).
export function cosePublicKeyFromKeyPair(keypair: {
  publicKey: { export(options: { format: 'jwk' }): { kty?: string; crv?: string; x?: string; y?: string; n?: string; e?: string } };
}): string {
  const jwk = keypair.publicKey.export({ format: 'jwk' });
  if (jwk.kty === 'RSA') {
    const n = base64urlToBuffer(jwk.n!);
    const e = base64urlToBuffer(jwk.e!);
    return encodeCborValue({ 1: 3, 3: -257, '-1': n, '-2': e }).toString('base64url');
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    const x = base64urlToBuffer(jwk.x!);
    return encodeCborValue({ 1: 1, 3: -8, '-1': 6, '-2': x }).toString('base64url');
  }
  // Default: EC P-256 (ES256)
  const x = base64urlToBuffer(jwk.x!);
  const y = base64urlToBuffer(jwk.y!);
  return encodeCborValue({ 1: 2, 3: -7, '-1': 1, '-2': x, '-3': y }).toString('base64url');
}

// buildAttestationObject({ fmt, attStmt, authData }) → base64url-encoded CBOR.
// Constructs a CBOR attestation object for test registration.
//   { "fmt": fmt, "attStmt": attStmt, "authData": authData }
export function buildAttestationObject({ fmt = 'none', attStmt = {}, authData }: {
  fmt?: string;
  attStmt?: Record<string, unknown>;
  authData: string | Buffer;
}): string {
  const authDataBuf = typeof authData === 'string' ? base64urlToBuffer(authData) : authData;
  return encodeCborValue({ fmt, attStmt, authData: authDataBuf }).toString('base64url');
}
