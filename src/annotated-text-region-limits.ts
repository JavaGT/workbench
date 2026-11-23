// Closed cardinality and payload limits for v10 region.edit / v16 replay
// (scope#992 rev 2 Finding 10; #148 rev 2 V16 grammar). Checked before hashing
// or allocation, then re-checked by the operated-event normalizer. Exceeding a
// limit throws ValidationError with code `annotated-text-region-limit` and
// performs no writes.

import { createHash } from 'node:crypto';

import { ValidationError } from './field-strategy.ts';

export const REGION_REPLACEMENT_MAX_UTF8_BYTES = 1024 * 1024;
export const REGION_AFFECTED_ANNOTATION_MAX = 4096;
export const REGION_MEMBERSHIP_MAX = 8192;
export const REGION_TRANSITION_MAX = 4096;
export const REGION_PROTECTED_EDGE_MAX = 8192;
export const REGION_PREREQUISITE_MAX = 8192;
export const REGION_DESCRIPTOR_MAX_UTF8_BYTES = 2 * 1024 * 1024;

// V16 durable witness bounds (#148 rev 2 "V16 durable grammar"). The event-byte
// ceiling applies to the complete `_Log.eventData` UTF-8 text; the string and
// depth ceilings apply to every nested scalar. Cardinality ceilings reuse the
// region limits above and are enforced per complete witness side.
export const REGION_V16_MAX_EVENT_BYTES = 2 * 1024 * 1024;
export const REGION_V16_MAX_STRING_BYTES = 1024 * 1024;
export const REGION_V16_MAX_DEPTH = 32;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export const ANNOTATED_TEXT_REGION_LIMIT = 'annotated-text-region-limit';
export const ANNOTATED_TEXT_STALE = 'annotated-text-stale';

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function regionLimitError(reason: string): ValidationError {
  return new ValidationError(reason, { code: ANNOTATED_TEXT_REGION_LIMIT });
}

export function regionStaleError(reason: string): ValidationError {
  return new ValidationError(reason, { code: ANNOTATED_TEXT_STALE });
}

export function assertSha256Digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw regionLimitError(`${label} must be a lowercase 64-character SHA-256 hex digest`);
  }
  return value;
}

/**
 * Canonical digest input: 32-bit big-endian length + UTF-8 bytes per field.
 * Delimiter-ambiguous JSON and caller-supplied raw bytes are rejected.
 */
export function lengthPrefixedUtf8Digest(fields: readonly string[]): string {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    if (typeof field !== 'string') throw regionLimitError('digest field must be UTF-8 text');
    const bytes = Buffer.from(field, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length, 0);
    chunks.push(header, bytes);
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

export function sha256Utf8(value: string): string {
  return lengthPrefixedUtf8Digest([value]);
}
