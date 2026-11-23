// Authorized blob reads (S6/A4): the framework read seam for blob bytes.
//
// The byte store serves bytes by id; this seam decides WHO may read them. It
// runs the S5 authorization adapter's `blob` resource admission — current
// authorization: requesting principal, owning resource, operation, range, and
// the resource-level policy the app registered on the adapter — BEFORE bytes
// are touched. Every failure collapses into ONE generic denial
// (BlobReadDeniedError, a plain 403 'forbidden'): a denied read, a missing
// owning resource, missing bytes, an expired claim — a caller can never
// distinguish "the blob does not exist" from "you may not read it" (S6
// consideration #11), so an unclaimed blob id leaks no existence signal.
// Content hashes are integrity metadata, never authorization tokens (#24).
//
// The seam is a LIBRARY surface the app (Scope, S8) mounts with its own
// resource-level authorization, replacing direct `blobs.readRange` calls. It
// takes an authoritative `read` callback — the app's claim-gated byte reader
// wired to the byte store / pending-blob claim machinery — and owns the
// admission decision, the generic denial, and the read's attribution to the
// requesting principal (a user principal via S5/A1, or a machine principal via
// S5/A5 — the adapter collapses and the seam logs the attributed identity).
// The /blobs upload route remains the only framework write path; this seam
// never writes.

import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';

import { getLog } from './log.ts';
import { failure } from './outcome.ts';
import type {
  AdmissionDecision,
  AdmissionOperation,
  AuthorizationAdapter,
  AuthorizationDb,
  ResourceEntityLike,
} from './authorization-adapter.ts';
import { blobRead as blobReadCategory } from './operation.ts';
import { principalKeyOf, type Principal } from './principal.ts';
import { BlobSlotNotFoundError } from './fs-blobs.ts';
import { pumpWebStreamToResponse, sendJson, type HttpResponseLike } from './http-response.ts';
import { sendFailure, type SendJson } from './http-failure.ts';

export interface ReadBlobArgs {
  /** The requesting principal — a user principal (S5/A1) or a machine principal (S5/A5). The read is attributed to it. */
  readonly principal: Principal;
  /**
   * The OWNING resource row (the entity whose blob field holds the bytes), in
   * stored cell form. Null/absent when the owning row is gone — admission
   * denies ('no-row-scope'), never a distinguishable "blob missing".
   */
  readonly resource: unknown;
  /** The declared blob field; names the resource registered on the adapter. */
  readonly field: string;
  /** The operation category; defaults to the `blob-read` category. */
  readonly operation?: AdmissionOperation;
  /** Optional half-open byte range `[start, end)`; passed through to `read`. */
  readonly range?: [start?: number, end?: number];
  /** The S5 authorization adapter — the ONE admission engine. */
  readonly authorize: AuthorizationAdapter;
  /** Optional entity metadata for compiled SQL `scopeFilter` evaluation. */
  readonly entity?: ResourceEntityLike;
  /** Optional database handle for compiled SQL `scopeFilter` evaluation. */
  readonly db?: AuthorizationDb;
  /**
   * The claim-gated byte reader the app wires to the byte store / pending-blob
   * claim machinery. It runs only AFTER admission; its own failures (missing
   * bytes, a failed digest attestation) surface as the same generic denial.
   */
  readonly read: (range?: [start?: number, end?: number]) => Buffer;
}

// The generic denial every blob-read failure collapses to. HTTP dispatch maps
// it to a generic 403 'forbidden'. `reasonCode` is server-side diagnostics
// only (the closed adapter vocabulary, or 'blob-unavailable' for a byte/
// admission failure) — stored NON-ENUMERABLY so the public error surface
// (status, failure, message, name) is byte-identical for every denial kind: a
// caller can never distinguish denial from absence, and serialization (JSON,
// deepEqual, key enumeration) never carries the reason.
export class BlobReadDeniedError extends Error {
  readonly status = 403;
  readonly failure = failure('denied', 'forbidden');
  constructor(reasonCode: string) {
    super('forbidden');
    this.name = 'BlobReadDeniedError';
    // Internal diagnostic only — non-enumerable so it never reaches a client,
    // never row content, and never distinguishes denied from missing (#11).
    Object.defineProperty(this, 'reasonCode', {
      value: reasonCode,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

async function admitBlobRead({
  principal,
  resource,
  field,
  operation,
  authorize,
  entity,
  db,
}: {
  principal: Principal;
  resource: unknown;
  field: string;
  operation?: AdmissionOperation;
  authorize: AuthorizationAdapter;
  entity?: ResourceEntityLike;
  db?: AuthorizationDb;
}): Promise<{ decision: AdmissionDecision; resourceId: string | null }> {
  const resourceId = resourceIdOf(resource);
  const decision = await authorize.admit({
    category: 'blob',
    principal,
    operation: operation ?? blobReadCategory,
    resourceName: field,
    row: resource,
    resourceId,
    ...(entity ? { entity } : {}),
    ...(db ? { db } : {}),
  });
  if (!decision?.admitted) {
    getLog().debug('auth', 'blob read denied', {
      principal: principalLabel(principal),
      field,
      resourceId,
      reason: decision?.reasonCode,
    });
    throw new BlobReadDeniedError(decision?.reasonCode ?? 'no-blob-access');
  }
  return { decision, resourceId };
}

// The authorized blob read. Admits through the S5 adapter under the `blob`
// resource category (the field names the registered resource; the owning row
// binds the scope), then serves bytes through `read`. BOTH the admission and
// the byte read are attributed to the requesting principal in the auth log,
// and BOTH collapse into the same generic denial — a throwing or malformed
// adapter is never distinguishable from a denial or missing bytes (#11).
export async function readBlob({ principal, resource, field, operation, range, authorize, entity, db, read }: ReadBlobArgs): Promise<Buffer> {
  const resourceId = resourceIdOf(resource);
  try {
    const { decision } = await admitBlobRead({ principal, resource, field, operation, authorize, entity, db });
    const bytes = read(range);
    getLog().debug('auth', 'blob read attributed', {
      principal: principalLabel(principal),
      field,
      resourceId,
      operation: decision.operation?.operation ?? blobReadCategory.operation,
      byteLength: bytes.length,
    });
    return bytes;
  } catch (error) {
    // Every failure — a denied read, a throwing/malformed admission, missing
    // or erased bytes — collapses into ONE generic denial (#11): a caller can
    // never distinguish "the blob does not exist" from "you may not read it".
    // An admission denial rethrows as-is (its internal reason survives for the
    // server log); anything else becomes the byte-unavailability denial.
    if (error instanceof BlobReadDeniedError) throw error;
    getLog().debug('auth', 'blob read unavailable', {
      principal: principalLabel(principal),
      field,
      resourceId,
    });
    throw new BlobReadDeniedError('blob-unavailable');
  }
}

function resourceIdOf(resource: unknown): string | null {
  const id = (resource as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

export interface ReadBlobStreamArgs extends Omit<ReadBlobArgs, 'read'> {
  /**
   * The claim-gated byte STREAM reader the app wires to the byte store /
   * pending-blob claim machinery — the streaming counterpart of
   * {@link ReadBlobArgs.read}. It runs only AFTER admission; a synchronous
   * failure constructing the stream (missing bytes → the typed missing-slot
   * error) surfaces as the same generic denial.
   */
  readonly read: (range?: [start?: number, end?: number]) => Readable;
}

// The authorized blob read, streaming variant (#738 W1): the SAME admit-then-
// serve ordering as {@link readBlob} — admission completes before `read` is
// called, so no chunk can flow through a denied or unadmitted read — and the
// SAME generic-denial collapse. Because `read` constructs the stream
// synchronously, every conforming backend's typed missing-slot error
// (BlobSlotNotFoundError) is thrown HERE, inside the collapse boundary, before
// any streaming starts: a caller sees only the generic 403, never an existence
// signal. Attribution logs at stream construction (byte length is unknowable
// until consumed); cancellation is the stream's own AbortSignal contract, wired
// by the app into its `read` callback, not a seam concern.
export async function readBlobStream({ principal, resource, field, operation, range, authorize, entity, db, read }: ReadBlobStreamArgs): Promise<Readable> {
  const resourceId = resourceIdOf(resource);
  try {
    const { decision } = await admitBlobRead({ principal, resource, field, operation, authorize, entity, db });
    const stream = read(range);
    getLog().debug('auth', 'blob read attributed', {
      principal: principalLabel(principal),
      field,
      resourceId,
      operation: decision.operation?.operation ?? blobReadCategory.operation,
    });
    return stream;
  } catch (error) {
    // Every failure — a denied read, a throwing/malformed admission, missing
    // or erased bytes — collapses into ONE generic denial (#11), identical to
    // the buffered variant: an admission denial rethrows as-is (its internal
    // reason survives for the server log); anything else becomes the
    // byte-unavailability denial. This catches a synchronously throwing stream
    // construction too, so a missing slot denies BEFORE any streaming starts.
    if (error instanceof BlobReadDeniedError) throw error;
    getLog().debug('auth', 'blob read unavailable', {
      principal: principalLabel(principal),
      field,
      resourceId,
    });
    throw new BlobReadDeniedError('blob-unavailable');
  }
}

// ─── RFC 9110 Byte-Range Parser & Authorized HTTP Media Response ────────────

export interface ParsedByteRange {
  readonly kind: 'range';
  /** Inclusive start byte offset (0 <= start <= end < totalSize). */
  readonly start: number;
  /** Inclusive end byte offset (0 <= start <= end < totalSize). */
  readonly end: number;
  /** Byte count of the slice (end - start + 1). */
  readonly length: number;
  /** Formatted RFC 9110 Content-Range header value (`bytes start-end/total`). */
  readonly contentRange: string;
}

export type ParsedByteRangeResult =
  | Readonly<{ kind: 'none' }>
  | Readonly<ParsedByteRange>
  | Readonly<{ kind: 'unsatisfiable'; contentRange: string }>;

/**
 * Parse an HTTP `Range` header per RFC 9110 §14.1.2 for single byte ranges:
 * `bytes=start-end`, `bytes=start-`, and `bytes=-suffix`.
 *
 * Invalid syntax, non-`bytes` units, multi-range lists, zero-byte suffix
 * (`bytes=-0`), inverted bounds, and out-of-bounds starts return
 * `{ kind: 'unsatisfiable', contentRange: 'bytes *\/<totalSize>' }` so callers
 * respond with `416 Range Not Satisfiable`.
 */
export function parseByteRange(
  rangeHeader: string | string[] | null | undefined,
  totalSize: number,
): ParsedByteRangeResult {
  if (!Number.isInteger(totalSize) || totalSize < 0) {
    throw new RangeError('totalSize must be a non-negative integer');
  }
  if (rangeHeader == null) return Object.freeze({ kind: 'none' });
  const raw = (Array.isArray(rangeHeader) ? rangeHeader.join(',') : rangeHeader).trim();
  if (raw.length === 0) return Object.freeze({ kind: 'none' });

  const unsatisfiable = (): ParsedByteRangeResult =>
    Object.freeze({ kind: 'unsatisfiable', contentRange: `bytes */${totalSize}` });

  const unitMatch = /^bytes=(.+)$/i.exec(raw);
  if (!unitMatch) return unsatisfiable();

  const spec = unitMatch[1]!.trim();
  // Reject multi-range lists (comma-separated); single byte-range only.
  if (spec.length === 0 || spec.includes(',')) return unsatisfiable();

  const rangeMatch = /^(\d*)-(\d*)$/.exec(spec);
  if (!rangeMatch) return unsatisfiable();
  const [, firstRaw, lastRaw] = rangeMatch;
  if (!firstRaw && !lastRaw) return unsatisfiable();

  // Any byte range against a 0-byte representation is unsatisfiable (RFC 9110 §14.1.2).
  if (totalSize === 0) return unsatisfiable();

  let start: number;
  let end: number;

  if (!firstRaw) {
    // Suffix range: bytes=-<suffix>
    const suffix = Number(lastRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return unsatisfiable();
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else if (!lastRaw) {
    // Open-ended range: bytes=<start>-
    start = Number(firstRaw);
    if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) return unsatisfiable();
    end = totalSize - 1;
  } else {
    // Bounded range: bytes=<start>-<end>
    start = Number(firstRaw);
    const parsedEnd = Number(lastRaw);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(parsedEnd)) return unsatisfiable();
    if (start < 0 || parsedEnd < start || start >= totalSize) return unsatisfiable();
    end = Math.min(parsedEnd, totalSize - 1);
  }

  return Object.freeze({
    kind: 'range',
    start,
    end,
    length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${totalSize}`,
  });
}

export interface BlobMediaMetadata {
  readonly size: number;
  readonly mime?: string | null;
  readonly sha256?: string | null;
  readonly etag?: string | null;
}

export interface ServeAuthorizedBlobArgs {
  readonly req: {
    readonly method?: string;
    readonly headers: Record<string, string | string[] | undefined>;
  };
  readonly res: ServerResponse;
  readonly principal: Principal;
  readonly resource: unknown;
  readonly field: string;
  readonly operation?: AdmissionOperation;
  readonly authorize: AuthorizationAdapter;
  readonly entity?: ResourceEntityLike;
  readonly db?: AuthorizationDb;
  /**
   * Resolve blob metadata (size, mime, sha256/etag) ONLY after admission has
   * succeeded. Returning null/undefined or throwing collapses to opaque 403.
   */
  readonly stat: () => BlobMediaMetadata | null | undefined;
  /**
   * Construct a readable byte stream for half-open `[start, end)` (or full blob
   * when omitted). Called ONLY for `GET` (never `HEAD`, and never before
   * authorization succeeds).
   */
  readonly readStream: (range?: [start?: number, end?: number], options?: { signal?: AbortSignal }) => Readable;
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | string[] | undefined {
  if (!headers) return undefined;
  if (name in headers) return headers[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function normalizeMetadata(stat: () => BlobMediaMetadata | null | undefined): BlobMediaMetadata | null {
  const meta = stat();
  if (!meta || !Number.isInteger(meta.size) || meta.size < 0) return null;
  return meta;
}

function buildMediaHeaders(
  meta: BlobMediaMetadata,
  contentLength: number,
  contentRange?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'accept-ranges': 'bytes',
    'content-type': (typeof meta.mime === 'string' && meta.mime.trim().length > 0)
      ? meta.mime.trim()
      : 'application/octet-stream',
    'content-length': String(contentLength),
    'cache-control': 'private, no-store',
  };
  const etag = typeof meta.etag === 'string' && meta.etag.length > 0
    ? meta.etag
    : (typeof meta.sha256 === 'string' && meta.sha256.length > 0 ? `"${meta.sha256}"` : null);
  if (etag) headers.etag = etag;
  if (contentRange) headers['content-range'] = contentRange;
  return headers;
}

function sendOpaqueBlobDenial(res: HttpResponseLike, isHead: boolean): void {
  if (isHead) {
    res.writeHead(403, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': '0',
      'cache-control': 'private, no-store',
    });
    res.end();
    return;
  }
  sendFailure(
    sendJson as unknown as SendJson,
    res,
    failure('denied', 'forbidden'),
    { status: 403, headers: { 'cache-control': 'private, no-store' } },
  );
}

function sendRangeNotSatisfiable(res: HttpResponseLike, contentRange: string): void {
  res.writeHead(416, {
    'content-range': contentRange,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-length': '0',
  });
  res.end();
}

/**
 * Authorized HTTP media playback handler (`GET` / `HEAD`) with RFC 9110 byte
 * range support (`200`, `206 Partial Content`, `416 Range Not Satisfiable`) and
 * backpressure-safe streaming via `pumpWebStreamToResponse`.
 *
 * Security invariant: authorization ALWAYS runs before `stat()` or `Range`
 * parsing, and every denial, missing row, missing metadata, or missing byte
 * slot collapses to an identical opaque `403` (never leaking existence or size).
 */
export async function serveAuthorizedBlob({
  req,
  res,
  principal,
  resource,
  field,
  operation,
  authorize,
  entity,
  db,
  stat,
  readStream,
}: ServeAuthorizedBlobArgs): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const isHead = method === 'HEAD';
  const rangeHeader = readHeaderValue(req.headers, 'range');
  const hasRange = rangeHeader != null
    && (Array.isArray(rangeHeader) ? rangeHeader.join(',') : rangeHeader).trim().length > 0;

  // HEAD: authorize + resolve metadata + write headers only (never stream bytes).
  if (isHead) {
    let meta: BlobMediaMetadata | null = null;
    try {
      await admitBlobRead({ principal, resource, field, operation, authorize, entity, db });
      meta = normalizeMetadata(stat);
    } catch {
      sendOpaqueBlobDenial(res, true);
      return;
    }
    if (!meta) {
      sendOpaqueBlobDenial(res, true);
      return;
    }
    const parsed = parseByteRange(rangeHeader, meta.size);
    if (parsed.kind === 'unsatisfiable') {
      sendRangeNotSatisfiable(res, parsed.contentRange);
      return;
    }
    if (parsed.kind === 'range') {
      res.writeHead(206, buildMediaHeaders(meta, parsed.length, parsed.contentRange));
      res.end();
      return;
    }
    res.writeHead(200, buildMediaHeaders(meta, meta.size));
    res.end();
    return;
  }

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once?.('close', onClose);

  try {
    // Full GET (no Range header): stream via readBlobStream + pumpWebStreamToResponse.
    if (!hasRange) {
      let resolvedMeta: BlobMediaMetadata | null = null;
      let nodeStream: Readable;
      try {
        nodeStream = await readBlobStream({
          principal,
          resource,
          field,
          operation,
          authorize,
          entity,
          db,
          read: (range) => {
            resolvedMeta = normalizeMetadata(stat);
            if (!resolvedMeta) throw new BlobSlotNotFoundError();
            return readStream(range, { signal: controller.signal });
          },
        });
      } catch {
        sendOpaqueBlobDenial(res, false);
        return;
      }
      if (!resolvedMeta) {
        nodeStream.destroy();
        sendOpaqueBlobDenial(res, false);
        return;
      }
      const headers = buildMediaHeaders(resolvedMeta, (resolvedMeta as BlobMediaMetadata).size);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      await pumpWebStreamToResponse(
        res,
        { status: 200, headers: new Headers(headers), body: webStream },
        { buffering: false },
      );
      return;
    }

    // Ranged GET: admit FIRST (never leak existence/size via 416), resolve
    // metadata, parse RFC 9110 Range, then stream via readStream + pumpWebStreamToResponse.
    let meta: BlobMediaMetadata | null = null;
    try {
      await admitBlobRead({ principal, resource, field, operation, authorize, entity, db });
      meta = normalizeMetadata(stat);
    } catch {
      sendOpaqueBlobDenial(res, false);
      return;
    }
    if (!meta) {
      sendOpaqueBlobDenial(res, false);
      return;
    }

    const parsed = parseByteRange(rangeHeader, meta.size);
    if (parsed.kind === 'unsatisfiable') {
      sendRangeNotSatisfiable(res, parsed.contentRange);
      return;
    }

    const isPartial = parsed.kind === 'range';
    const rangeTuple: [number, number] | undefined = isPartial ? [parsed.start, parsed.end + 1] : undefined;
    let nodeStream: Readable;
    try {
      nodeStream = readStream(rangeTuple, { signal: controller.signal });
    } catch {
      sendOpaqueBlobDenial(res, false);
      return;
    }

    const status = isPartial ? 206 : 200;
    const headers = isPartial
      ? buildMediaHeaders(meta, parsed.length, parsed.contentRange)
      : buildMediaHeaders(meta, meta.size);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    await pumpWebStreamToResponse(
      res,
      { status, headers: new Headers(headers), body: webStream },
      { buffering: false },
    );
  } finally {
    res.off?.('close', onClose);
  }
}

/** Alias for {@link serveAuthorizedBlob} for HTTP handler ergonomics. */
export const handleAuthorizedBlobRequest = serveAuthorizedBlob;

function principalLabel(principal: Principal): string {
  return principalKeyOf(principal) ?? 'anonymous';
}
