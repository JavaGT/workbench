// Shared contract and helpers for the framework-owned HTTP route families.
//
// Every family in src/http-routes-*.ts speaks this one typed app/request
// contract and reuses these reject/body/authorization helpers. The families are
// siblings behind the src/http-framework-routes.ts barrel; no family owns a
// second auth engine, a second response envelope, or a second body reader.


import { sendJson,                       } from './http-response.mjs';
import { failureForHttpError, sendFailure,               } from './http-failure.mjs';


import { createAuthorizationAdapter,                           } from './authorization-adapter.mjs';

import { requireUser,           } from './route-gate.mjs';
import { BodyError, readRequestBody } from './http-body.mjs';



















                                             



































export function reject(res                  , status        , message        , details          )       {
  const workbenchFailure = failureForHttpError({ status, message, details });
  sendFailure(sendJson                       , res, workbenchFailure, { status });
}

// The ONE authorization adapter every framework route consults (S5/A2). The
// app stashes the injected adapter at listen time (serve.ts); with none
// injected, field-admission falls back to the framework row-grant engine — the
// default adapter's own implementation — unchanged.
export function routeAuthorization(app              )                              {
  return (app                                                    )._authorization ?? null;
}

export function firstHeaderString(value                               )         {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function toUint8ArrayChunk(chunk         )             {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new TypeError('streamed blob chunk must be Uint8Array');
}

// Adapt a Node IncomingMessage (or EventEmitter test double) into a
// backpressure-aware AsyncIterable<Uint8Array> WITHOUT calling req.destroy() on
// early return (such as a mid-stream 413 BlobTooLargeError), so the HTTP
// response flushes cleanly while unread request bytes drain.
export function requestBodyAsyncIterable(req                  )


  {
  const raw = (req.raw ?? req)

   ;
  const drain = () => {
    try { raw.resume?.(); } catch {}
  };

  if (typeof raw.on !== 'function' && typeof raw[Symbol.asyncIterator] === 'function') {
    const stream = (async function* iterateNative() {
      for await (const chunk of raw                          ) {
        yield toUint8ArrayChunk(chunk);
      }
    })();
    return { stream, drain };
  }

  const stream = (async function* iterateEvents() {
    if (raw.aborted || raw.destroyed) {
      throw new BodyError('request body was aborted', 400);
    }
    const queue               = [];
    let done = false;
    let streamError          = null;
    let notify                      = null;
    const wake = () => {
      const fn = notify;
      notify = null;
      fn?.();
    };
    const onData = (chunk         ) => {
      try {
        queue.push(toUint8ArrayChunk(chunk));
        raw.pause?.();
      } catch (err) {
        streamError = err;
      }
      wake();
    };
    const onEnd = () => { done = true; wake(); };
    const onError = (err         ) => { streamError = err; wake(); };
    const onAborted = () => { streamError = new BodyError('request body was aborted', 400); wake(); };
    const onClose = () => {
      if (!done && streamError === null) {
        streamError = new BodyError('request body closed before completion', 400);
        wake();
      }
    };

    raw.on('data', onData         );
    raw.on('end', onEnd         );
    raw.on('error', onError         );
    raw.on('aborted', onAborted         );
    raw.on('close', onClose         );
    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() ;
        }
        if (streamError !== null) throw streamError;
        if (done) break;
        raw.resume?.();
        await new Promise      ((resolve) => { notify = resolve; });
      }
    } finally {
      raw.off?.('data', onData         );
      raw.off?.('end', onEnd         );
      raw.off?.('error', onError         );
      raw.off?.('aborted', onAborted         );
      raw.off?.('close', onClose         );
    }
  })();
  return { stream, drain };
}

// The framework default for these routes when the app injects no adapter. It is
// the same adapter implementation REST dispatch falls back to, so an un-injected
// server keeps its row-grant behavior.
export const DEFAULT_QUERY_AUTHORIZATION                       = createAuthorizationAdapter();

// The ONE admission engine each read route consults: an app-injected adapter is
// final; with none, the framework default above runs (S5/A2).
export function queryAuthorization(app              )                       {
  return routeAuthorization(app) ?? DEFAULT_QUERY_AUTHORIZATION;
}

// The first default-on layer. The gate is evaluated by the adapter, so a custom
// principal denial is an indistinguishable 401 here just as it is in REST.
export async function admitQueryGate(
  authorization                      ,
  gate      ,
  principal           ,
)                   {
  const decision = await authorization.admit({ category: 'principal', operation: 'read', principal, gate });
  return decision.admitted;
}

// The second default-on layer: post-filter a page through the SAME row admission
// REST list uses. A row the adapter denies is omitted, identically to a denied
// row being absent from a REST list response.
export async function admitQueryRows(
  authorization                      ,
  entity            ,
  rows                                    ,
  principal           ,
)                                     {
  const admitted                            = [];
  for (const stored of rows) {
    const row = typeof entity.deserializeRow === 'function'
      ? entity.deserializeRow({ ...stored })
      : stored;
    const decision = await authorization.admit({
      category: 'entity',
      verb: 'list',
      principal,
      entity: entity                           ,
      row,
      resourceId: (stored                    ).id                      ,
    });
    if (decision.admitted) admitted.push(stored);
  }
  return admitted;
}

// The per-entity read route gate (default-on requireUser). An allowAnonymous
// declaration relaxes only admission; the row grant still runs downstream.
export function entityReadGate(entity            )       {
  const gate = (entity                                      ).gate?.read;
  return (typeof gate === 'function' ? gate : requireUser())        ;
}

// Read a JSON object body, replying with the standard error envelope and
// returning null when the body is refused.
export async function readJsonObjectBody(
  req                  ,
  res                  ,
)                                          {
  let body         ;
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
  return body                           ;
}

