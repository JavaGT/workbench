import {
  brotliCompress,
  brotliCompressSync,
  constants as zlibConstants,
  gzip,
  gzipSync,
} from 'node:zlib';
import { promisify } from 'node:util';
import type { ServerResponse } from 'node:http';

import { getLog } from './log.ts';

const DOUBLE_RESPONSE_WARNING_CODE = 'WB_DOUBLE_RESPONSE';
const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export const DEFAULT_COMPRESSION_THRESHOLD = 1024;

export type ContentEncoding = 'br' | 'gzip';

export interface HttpResponseLike {
  headersSent?: boolean;
  writableEnded?: boolean;
  destroyed?: boolean;
  req?: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
  } | null;
  getHeader?(name: string): unknown;
  // Loose enough for node:http ServerResponse overloads and test doubles.
  writeHead(status: number, ...rest: unknown[]): unknown;
  end(...args: unknown[]): unknown;
}

export function responseHasStarted(res: HttpResponseLike): boolean {
  return Boolean(res.headersSent || res.writableEnded || res.destroyed);
}

export function warnLateResponse(
  res: HttpResponseLike,
  operation: string,
  cause?: Error | unknown,
): void {
  const req = res.req;
  const method = req?.method ?? 'UNKNOWN';
  const url = req?.url ?? 'UNKNOWN_URL';
  const state = [
    `headersSent=${Boolean(res.headersSent)}`,
    `writableEnded=${Boolean(res.writableEnded)}`,
    `destroyed=${Boolean(res.destroyed)}`,
  ].join(', ');
  const causeMessage =
    cause instanceof Error ? `${cause.name}: ${cause.message}`
    : cause ? String(cause)
    : undefined;
  process.emitWarning(
    new Error(
      `Attempted to write response after it had already started in ${operation} ` +
      `for ${method} ${url} (${state})${causeMessage ? ` — cause: ${causeMessage}` : ''}`,
    ),
    { code: DOUBLE_RESPONSE_WARNING_CODE, type: 'DoubleResponseWarning' },
  );
}

export function canWriteResponse(
  res: HttpResponseLike,
  operation: string,
  cause?: Error | unknown,
): boolean {
  if (!responseHasStarted(res)) return true;
  warnLateResponse(res, operation, cause);
  return false;
}

/**
 * Negotiate `br` or `gzip` from a client's `Accept-Encoding` header per RFC 9110.
 * Respects q-values (`q=0` disables an encoding) and prefers `br` over `gzip`
 * on equal quality.
 */
export function negotiateEncoding(
  acceptEncoding: string | string[] | undefined,
): ContentEncoding | null {
  if (!acceptEncoding) return null;
  const raw = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
  if (!raw.trim()) return null;

  let brQ = -1;
  let gzipQ = -1;
  let wildcardQ = -1;

  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(';');
    const coding = parts[0]!.trim().toLowerCase();
    let q = 1;
    let validQ = true;
    for (let i = 1; i < parts.length; i += 1) {
      const [k, v] = parts[i]!.split('=');
      if (k?.trim().toLowerCase() === 'q') {
        const parsed = Number(v?.trim());
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          validQ = false;
        } else {
          q = parsed;
        }
      }
    }
    if (!validQ) continue;
    if (coding === 'br') brQ = Math.max(brQ, q);
    else if (coding === 'gzip' || coding === 'x-gzip') gzipQ = Math.max(gzipQ, q);
    else if (coding === '*') wildcardQ = Math.max(wildcardQ, q);
  }

  const effectiveBr = brQ >= 0 ? brQ : wildcardQ;
  const effectiveGzip = gzipQ >= 0 ? gzipQ : wildcardQ;

  if (effectiveBr <= 0 && effectiveGzip <= 0) return null;
  if (effectiveBr >= effectiveGzip && effectiveBr > 0) return 'br';
  if (effectiveGzip > 0) return 'gzip';
  return null;
}

/**
 * Merge a Vary token into an existing Vary header value without duplicates.
 */
export function mergeVaryHeader(existing: unknown, token: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      parts.push(trimmed);
    }
  };
  if (Array.isArray(existing)) {
    for (const item of existing) add(String(item));
  } else if (typeof existing === 'string' && existing.trim()) {
    add(existing);
  }
  add(token);
  return parts.join(', ');
}

export interface CompressPayloadOptions {
  threshold?: number;
}

export interface CompressedPayload {
  body: Buffer;
  encoding: ContentEncoding | null;
}

const BROTLI_OPTIONS = Object.freeze({
  params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
  },
});

const GZIP_OPTIONS = Object.freeze({ level: 6 });

export function compressPayloadSync(
  data: Buffer | string,
  acceptEncoding: string | string[] | undefined,
  options: CompressPayloadOptions = {},
): CompressedPayload {
  const threshold = options.threshold ?? DEFAULT_COMPRESSION_THRESHOLD;
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  if (raw.length < threshold) return { body: raw, encoding: null };
  const encoding = negotiateEncoding(acceptEncoding);
  if (!encoding) return { body: raw, encoding: null };
  const body = encoding === 'br'
    ? brotliCompressSync(raw, BROTLI_OPTIONS)
    : gzipSync(raw, GZIP_OPTIONS);
  return { body, encoding };
}

export async function compressPayloadAsync(
  data: Buffer | string,
  acceptEncoding: string | string[] | undefined,
  options: CompressPayloadOptions = {},
): Promise<CompressedPayload> {
  const threshold = options.threshold ?? DEFAULT_COMPRESSION_THRESHOLD;
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  if (raw.length < threshold) return { body: raw, encoding: null };
  const encoding = negotiateEncoding(acceptEncoding);
  if (!encoding) return { body: raw, encoding: null };
  const body = encoding === 'br'
    ? await brotliCompressAsync(raw, BROTLI_OPTIONS)
    : await gzipAsync(raw, GZIP_OPTIONS);
  return { body, encoding };
}

function hasHeader(headers: Record<string, unknown>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return true;
  }
  return false;
}

function findHeaderKey(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === lower);
}

export interface SendJsonHeaders {
  [key: string]: unknown;
}

export interface SendJsonOptions {
  operation?: string;
  cause?: Error | unknown;
  compress?: boolean;
  compressionThreshold?: number;
}

export function sendJson(
  res: HttpResponseLike,
  status: number,
  body: unknown,
  headers: SendJsonHeaders = {},
  options: SendJsonOptions = {},
): boolean {
  if (!canWriteResponse(res, options.operation ?? 'sendJson', options.cause)) return false;
  // JSON.stringify returns the value `undefined` for an `undefined` body —
  // treat that as an EMPTY response (status only, no payload) instead of
  // letting Buffer.byteLength(undefined) throw mid-request.
  const payload = JSON.stringify(body) ?? '';
  const responseHeaders: Record<string, unknown> = {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  };

  const allowCompress = options.compress !== false
    && status >= 200
    && status !== 204
    && status !== 304
    && res.req?.method !== 'HEAD'
    && !hasHeader(responseHeaders, 'content-encoding')
    && !res.getHeader?.('content-encoding');

  if (allowCompress) {
    const acceptEncoding = res.req?.headers?.['accept-encoding'];
    const compressed = compressPayloadSync(payload, acceptEncoding, {
      threshold: options.compressionThreshold,
    });
    if (compressed.encoding) {
      responseHeaders['content-encoding'] = compressed.encoding;
      responseHeaders['content-length'] = compressed.body.length;
      const existingVaryKey = findHeaderKey(responseHeaders, 'vary');
      const existingVary = existingVaryKey
        ? responseHeaders[existingVaryKey]
        : res.getHeader?.('vary');
      if (existingVaryKey && existingVaryKey !== 'vary') {
        delete responseHeaders[existingVaryKey];
      }
      responseHeaders['vary'] = mergeVaryHeader(existingVary, 'Accept-Encoding');
      res.writeHead(status, responseHeaders);
      res.end(compressed.body);
      return true;
    }
  }

  responseHeaders['content-length'] = Buffer.byteLength(payload);
  res.writeHead(status, responseHeaders);
  res.end(payload);
  return true;
}

export interface StreamSourceLike {
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
    };
  } | null;
  headers?: { entries(): Iterable<[string, string]> };
  status?: number;
}

export interface PumpWebStreamOptions {
  buffering?: boolean;
  defaultStatus?: number;
  defaultContentType?: string;
  onEnd?: () => void;
}

function waitForResponseDrain(nodeRes: ServerResponse): Promise<void> {
  if (nodeRes.destroyed || nodeRes.writableEnded) {
    return Promise.reject(new Error('response stream closed'));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      nodeRes.off('drain', onDrain);
      nodeRes.off('close', onClose);
      nodeRes.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('response stream closed')); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    nodeRes.once('drain', onDrain);
    nodeRes.once('close', onClose);
    nodeRes.once('error', onError);
  });
}

/**
 * Shared backpressure-aware stream pump used by `res.stream()` in both
 * `serve.ts` (`app.use` prefix handlers) and `http-handler-chain.ts`
 * (`router()` handlers).
 *
 * - Respects `nodeRes.write(chunk)` backpressure by awaiting `'drain'` with
 *   `'close'` / `'error'` abort safety.
 * - Cancels the upstream reader on client disconnect or error.
 * - Sets `x-accel-buffering: no` when `buffering === false` (the default).
 */
export async function pumpWebStreamToResponse(
  nodeRes: ServerResponse,
  webResponse: unknown,
  options: PumpWebStreamOptions = {},
): Promise<void> {
  const buffering = options.buffering ?? false;
  const defaultStatus = options.defaultStatus ?? 200;
  const source = webResponse as StreamSourceLike | null | undefined;
  const isBareStream = webResponse instanceof ReadableStream;
  const isResponse = !isBareStream && (
    typeof source?.body?.getReader === 'function'
    || (Boolean(webResponse) && typeof source?.body === 'object')
  );
  const body = isResponse ? source?.body : webResponse;
  const headers: Record<string, string> = {};
  if (isResponse && source?.headers) {
    for (const [key, value] of source.headers.entries()) {
      headers[key.toLowerCase()] = value;
    }
  }
  if (!('content-type' in headers) && !isResponse && options.defaultContentType) {
    headers['content-type'] = options.defaultContentType;
  }
  if (buffering === false) {
    headers['x-accel-buffering'] = 'no';
  }
  if (!nodeRes.headersSent) {
    const status = isResponse && Number.isFinite(source?.status as number)
      ? (source?.status as number)
      : defaultStatus;
    nodeRes.writeHead(status, headers);
  }

  const streamBody = body as StreamSourceLike['body'] | null | undefined;
  if (!streamBody || typeof streamBody.getReader !== 'function') {
    if (!nodeRes.writableEnded && !nodeRes.destroyed) nodeRes.end();
    options.onEnd?.();
    return;
  }

  const reader = streamBody.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  nodeRes.once('close', onAbort);
  nodeRes.once('error', onAbort);

  try {
    while (true) {
      if (nodeRes.destroyed || nodeRes.writableEnded) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (nodeRes.destroyed || nodeRes.writableEnded) break;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      const accepted = nodeRes.write(chunk);
      if (accepted === false) {
        await waitForResponseDrain(nodeRes);
      }
    }
    if (!nodeRes.writableEnded && !nodeRes.destroyed) {
      nodeRes.end();
    }
  } catch (err) {
    if (!nodeRes.destroyed) {
      getLog().warn('system', 'res.stream pump failed', { err });
      nodeRes.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    nodeRes.off('close', onAbort);
    nodeRes.off('error', onAbort);
    try { await reader.cancel(); } catch { /* reader already released */ }
    options.onEnd?.();
  }
}

interface CommittedEvent {
  scope?: string;
  seq?: number;
}

export function committedEventHeaders(
  result: { events?: readonly CommittedEvent[] } | null | undefined,
  actionId: string,
  scope: string | null = null,
): Record<string, string> {
  const events = Array.isArray(result?.events) ? result.events : [];
  const relevantEvents = scope ? events.filter((event) => event.scope === scope) : events;
  const seq = relevantEvents.reduce(
    (max, event) => Number.isFinite(event.seq) ? Math.max(max, event.seq as number) : max,
    -Infinity,
  );
  return {
    'x-workbench-action-id': actionId,
    ...(Number.isFinite(seq) ? { 'x-workbench-seq': String(seq) } : {}),
  };
}

export function projectedCursorHeaders(
  cursors: readonly { field: string; lastSeq: number }[] | null | undefined,
): Record<string, string> {
  if (!cursors || cursors.length === 0) return {};
  const headers: Record<string, string> = {};
  for (const { field, lastSeq } of cursors) {
    headers[`x-workbench-projected-${field}`] = String(lastSeq);
  }
  return headers;
}
