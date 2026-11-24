// Shared contract and helpers for the framework-owned HTTP route families.
//
// Every family in src/http-routes-*.ts speaks this one typed app/request
// contract and reuses these reject/body/authorization helpers. The families are
// siblings behind the src/http-framework-routes.ts barrel; no family owns a
// second auth engine, a second response envelope, or a second body reader.

import type { EntityRecord } from './row-grant.ts';
import { sendJson, type HttpResponseLike } from './http-response.ts';
import { failureForHttpError, sendFailure, type SendJson } from './http-failure.ts';
import type { CrudAppLike, CrudEntity } from './http-crud-dispatch.ts';
import type { BlobStore } from './blob-store.ts';
import { createAuthorizationAdapter, type AuthorizationAdapter } from './authorization-adapter.ts';
import type { Principal } from './principal.ts';
import { requireUser, type Gate } from './route-gate.ts';
import { BodyError, readRequestBody } from './http-body.ts';

export interface FrameworkRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  aborted?: boolean;
  destroyed?: boolean;
  raw?: FrameworkRequest;
  principal?: Principal;
}

export interface FrameworkJobs {
  registerWorker(secret: unknown): unknown;
  authenticate(bearer: string | null): string | null;
  // Mutation entry points are coordinated (return a Promise) when the queue was
  // built with the app's write coordinator — the routes await them.
  claim(workerId: string, options?: { kind?: string; scope?: string }): unknown;
  heartbeat(jobId: string, workerId: string): boolean | Promise<boolean>;
  updateProgress(options: { jobId: string; workerId: string; progress: unknown; stage: unknown }): unknown;
  submitResult(jobId: string, workerId: string, body: unknown): unknown;
  cancelJob(options: { jobId: string; workerId: string }): unknown;
  [key: string]: unknown;
}

export interface ScopeAnchor {
  entity: string;
  id: string;
  row?: Record<string, unknown>;
}

export interface ScopeAccess {
  status?: 403 | 404;
  direct: boolean;
  anchor?: ScopeAnchor;
}

export interface FrameworkApp extends CrudAppLike {
  entities?: ReadonlyMap<string, CrudEntity>;
  resolveScope?: (scope: string) => unknown | Promise<unknown>;
  scopeSnapshot?: (scope: string, principal: Principal, anchor: ScopeAnchor) => unknown | Promise<unknown>;
  jobs?: FrameworkJobs;
  blobs?: Partial<BlobStore> & {
    upload?: (options: { bytes: Buffer; mime: string }) => unknown;
    maxBytes?: number;
  };
  blobMaxBytes?: number;
  // The one platform write coordinator: blob-metadata writes enter through it.
  writeCoordinator?: { run<T>(fn: () => T | Promise<T>): Promise<T> };
  [key: string]: unknown;
}

export function reject(res: HttpResponseLike, status: number, message: string, details?: unknown): void {
  const workbenchFailure = failureForHttpError({ status, message, details });
  sendFailure(sendJson as unknown as SendJson, res, workbenchFailure, { status });
}

// The ONE authorization adapter every framework route consults (S5/A2). The
// app stashes the injected adapter at listen time (serve.ts); with none
// injected, field-admission falls back to the framework row-grant engine — the
// default adapter's own implementation — unchanged.
export function routeAuthorization(app: FrameworkApp): AuthorizationAdapter | null {
  return (app as { _authorization?: AuthorizationAdapter | null })._authorization ?? null;
}

export function firstHeaderString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function toUint8ArrayChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new TypeError('streamed blob chunk must be Uint8Array');
}

// Adapt a Node IncomingMessage (or EventEmitter test double) into a
// backpressure-aware AsyncIterable<Uint8Array> WITHOUT calling req.destroy() on
// early return (such as a mid-stream 413 BlobTooLargeError), so the HTTP
// response flushes cleanly while unread request bytes drain.
export function requestBodyAsyncIterable(req: FrameworkRequest): {
  stream: AsyncIterable<Uint8Array>;
  drain: () => void;
} {
  const raw = (req.raw ?? req) as FrameworkRequest & {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  const drain = () => {
    try { raw.resume?.(); } catch {}
  };

  if (typeof raw.on !== 'function' && typeof raw[Symbol.asyncIterator] === 'function') {
    const stream = (async function* iterateNative() {
      for await (const chunk of raw as AsyncIterable<unknown>) {
        yield toUint8ArrayChunk(chunk);
      }
    })();
    return { stream, drain };
  }

  const stream = (async function* iterateEvents() {
    if (raw.aborted || raw.destroyed) {
      throw new BodyError('request body was aborted', 400);
    }
    const queue: Uint8Array[] = [];
    let done = false;
    let streamError: unknown = null;
    let notify: (() => void) | null = null;
    const wake = () => {
      const fn = notify;
      notify = null;
      fn?.();
    };
    const onData = (chunk: unknown) => {
      try {
        queue.push(toUint8ArrayChunk(chunk));
        raw.pause?.();
      } catch (err) {
        streamError = err;
      }
      wake();
    };
    const onEnd = () => { done = true; wake(); };
    const onError = (err: unknown) => { streamError = err; wake(); };
    const onAborted = () => { streamError = new BodyError('request body was aborted', 400); wake(); };
    const onClose = () => {
      if (!done && streamError === null) {
        streamError = new BodyError('request body closed before completion', 400);
        wake();
      }
    };

    raw.on('data', onData as never);
    raw.on('end', onEnd as never);
    raw.on('error', onError as never);
    raw.on('aborted', onAborted as never);
    raw.on('close', onClose as never);
    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (streamError !== null) throw streamError;
        if (done) break;
        raw.resume?.();
        await new Promise<void>((resolve) => { notify = resolve; });
      }
    } finally {
      raw.off?.('data', onData as never);
      raw.off?.('end', onEnd as never);
      raw.off?.('error', onError as never);
      raw.off?.('aborted', onAborted as never);
      raw.off?.('close', onClose as never);
    }
  })();
  return { stream, drain };
}

// The framework default for these routes when the app injects no adapter. It is
// the same adapter implementation REST dispatch falls back to, so an un-injected
// server keeps its row-grant behavior.
export const DEFAULT_QUERY_AUTHORIZATION: AuthorizationAdapter = createAuthorizationAdapter();

// The ONE admission engine each read route consults: an app-injected adapter is
// final; with none, the framework default above runs (S5/A2).
export function queryAuthorization(app: FrameworkApp): AuthorizationAdapter {
  return routeAuthorization(app) ?? DEFAULT_QUERY_AUTHORIZATION;
}

// The first default-on layer. The gate is evaluated by the adapter, so a custom
// principal denial is an indistinguishable 401 here just as it is in REST.
export async function admitQueryGate(
  authorization: AuthorizationAdapter,
  gate: Gate,
  principal: Principal,
): Promise<boolean> {
  const decision = await authorization.admit({ category: 'principal', operation: 'read', principal, gate });
  return decision.admitted;
}

// The second default-on layer: post-filter a page through the SAME row admission
// REST list uses. A row the adapter denies is omitted, identically to a denied
// row being absent from a REST list response.
export async function admitQueryRows(
  authorization: AuthorizationAdapter,
  entity: CrudEntity,
  rows: readonly Record<string, unknown>[],
  principal: Principal,
): Promise<Record<string, unknown>[]> {
  const admitted: Record<string, unknown>[] = [];
  for (const stored of rows) {
    const row = typeof entity.deserializeRow === 'function'
      ? entity.deserializeRow({ ...stored })
      : stored;
    const decision = await authorization.admit({
      category: 'entity',
      verb: 'list',
      principal,
      entity: entity as unknown as EntityRecord,
      row,
      resourceId: (stored as { id?: unknown }).id as string | undefined,
    });
    if (decision.admitted) admitted.push(stored);
  }
  return admitted;
}

// The per-entity read route gate (default-on requireUser). An allowAnonymous
// declaration relaxes only admission; the row grant still runs downstream.
export function entityReadGate(entity: CrudEntity): Gate {
  const gate = (entity as { gate?: Record<string, unknown> }).gate?.read;
  return (typeof gate === 'function' ? gate : requireUser()) as Gate;
}

// Read a JSON object body, replying with the standard error envelope and
// returning null when the body is refused.
export async function readJsonObjectBody(
  req: FrameworkRequest,
  res: HttpResponseLike,
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await readRequestBody(req, { jsonOnly: true });
  } catch (err) {
    if (err instanceof BodyError) {
      reject(res, err.status, err.message);
      return null;
    }
    throw err;
  }
  if (body === null || body === undefined) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    reject(res, 400, 'request body must be a JSON object');
    return null;
  }
  return body as Record<string, unknown>;
}

