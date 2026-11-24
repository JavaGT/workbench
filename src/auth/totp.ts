// totp.mjs — TOTP (Time-based One-Time Password) per RFC 6238.
//
// Zero runtime dependencies: `node:crypto` only. Implements HOTP/TOTP with
// SHA-1 HMAC, dynamic truncation per RFC 4226 §5.3, and a ±1-window tolerance
// (90s). Secret generation uses `node:crypto.randomBytes`; backup codes are
// one-way SHA-256 hashed before storage.
//
//   - generateSecret(username) → { secret, uri } — base32-encoded secret +
//     otpauth:// URI for QR-code display
//   - verifyTotp(secret, token) → boolean — RFC 6238 verification with ±1
//     window tolerance
//   - hotp(secret, counter) → 6-digit token — the underlying HOTP computation
//     (exported for test token generation)
//   - generateBackupCodes(n = 8) → { plainCodes, hashedCodes }
//   - verifyBackupCode(hashedCodes, code) → boolean — SHA-256 compare,
//     one-time use (consumed on success)

import crypto from 'node:crypto';
import { sha256hex } from './session.ts';

// ---- base32 (RFC 4648, no padding) --------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Uint8Array): string {
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

export function base32Decode(str: string): Buffer {
  const cleaned = str.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const result: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`invalid base32 character: "${char}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(result);
}

// ---- HOTP (RFC 4226) / TOTP (RFC 6238) ---------------------------------------

// hotp(secret, counter) — compute a 6-digit HOTP token per RFC 4226 §5.3.
//   - HMAC-SHA1(key=base32Decode(secret), message=8-byte big-endian counter)
//   - Dynamic truncation: offset = last 4 bits of HMAC
//   - P = (hmac[offset..offset+3]) & 0x7fffffff
//   - OTP = P % 10^6, zero-padded to 6 digits
export function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  // Write counter as 8-byte big-endian unsigned integer (RFC 4226 §5.1).
  // Use writeBigUInt64BE for proper 64-bit encoding; a 32-bit counter fits fine.
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 1_000_000;
  return String(otp).padStart(6, '0');
}

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// verifyTotpStep(secret, token, atTime) — verify a 6-digit token against the
// stored base32 secret using constant-time comparison across the current 30s
// window and ±1 adjacent windows (90s tolerance). Returns both validity and the
// matched time-step counter so callers can enforce replay protection.
export function verifyTotpStep(
  secret: string,
  token: string | number,
  atTime: number = Date.now(),
): { valid: boolean; counter: number | null } {
  const raw = String(token).trim();
  if (!/^\d{1,6}$/.test(raw)) return { valid: false, counter: null };
  const candidate = raw.padStart(6, '0');
  const T0 = 0;
  const step = 30;
  const counter = Math.floor((Math.floor(atTime / 1000) - T0) / step);
  let matchedCounter: number | null = null;
  for (let i = -1; i <= 1; i++) {
    const expected = hotp(secret, counter + i);
    if (safeEqualStrings(expected, candidate)) {
      matchedCounter = counter + i;
    }
  }
  return { valid: matchedCounter !== null, counter: matchedCounter };
}

// verifyTotp(secret, token) — verify a 6-digit token against the stored base32
// secret. Accepts the current 30s window AND ±1 adjacent windows (90s tolerance).
// Returns true iff the token matches any of the three windows.
export function verifyTotp(secret: string, token: string | number, atTime: number = Date.now()): boolean {
  return verifyTotpStep(secret, token, atTime).valid;
}

// ---- secret generation --------------------------------------------------------

// generateSecret(username, issuerOrOptions) → { secret, uri }
// Generates 20 random bytes, base32-encodes them (RFC 4648, no padding), and
// builds an otpauth:// URI for QR-code display. The URI uses the standard
// TOTP params: SHA1, 6 digits, 30s period, and a configurable issuer
// (defaulting to 'workbench').
export function generateSecret(
  username = 'user',
  issuerOrOptions?: string | { issuer?: string },
): { secret: string; uri: string } {
  const rawIssuer = typeof issuerOrOptions === 'string'
    ? issuerOrOptions
    : issuerOrOptions?.issuer;
  const issuer = typeof rawIssuer === 'string' && rawIssuer.trim().length > 0
    ? rawIssuer.trim()
    : 'workbench';
  const bytes = crypto.randomBytes(20);
  const secret = base32Encode(bytes);
  const encodedUsername = encodeURIComponent(username);
  const encodedIssuer = encodeURIComponent(issuer);
  const labelIssuer = issuer === 'workbench' ? 'Workbench' : encodedIssuer;
  const uri = `otpauth://totp/${labelIssuer}:${encodedUsername}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}

// ---- backup codes -------------------------------------------------------------

// generateBackupCodes(n = 8) → { plainCodes, hashedCodes }
// Generates n random backup codes. Each code is 16 random bytes → 32 hex chars
// (128 bits of entropy). The plain codes are returned ONCE (for display to the
// user); the hashed codes (SHA-256) are stored for one-way verification.
export function generateBackupCodes(n = 8): { plainCodes: string[]; hashedCodes: string[] } {
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = crypto.randomBytes(16).toString('hex');
    plainCodes.push(code);
    hashedCodes.push(sha256hex(code));
  }
  return { plainCodes, hashedCodes };
}

// verifyBackupCode(hashedCodes, code) → boolean
// Compares the SHA-256 of the input code against all stored hashes in constant
// time via `crypto.timingSafeEqual`. On match, the consumed code is removed
// from the array (one-time use). Returns false if the code is not in the stored
// set. The `hashedCodes` array is MUTATED in place — callers must persist the
// updated array.
export function verifyBackupCode(hashedCodes: string[], code: string): boolean {
  if (typeof code !== 'string' || code.length === 0 || !Array.isArray(hashedCodes)) {
    return false;
  }
  const candidateBuf = Buffer.from(sha256hex(code), 'hex');
  let matchedIdx = -1;
  for (let i = 0; i < hashedCodes.length; i++) {
    const entry = hashedCodes[i];
    if (typeof entry !== 'string' || entry.length !== 64 || !/^[0-9a-f]{64}$/i.test(entry)) {
      continue;
    }
    const entryBuf = Buffer.from(entry, 'hex');
    if (entryBuf.length === candidateBuf.length && crypto.timingSafeEqual(entryBuf, candidateBuf)) {
      matchedIdx = i;
    }
  }
  if (matchedIdx === -1) return false;
  hashedCodes.splice(matchedIdx, 1);
  return true;
}
