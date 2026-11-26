// Node HTTP/SSE skin for public LiveDelivery. Applications mount this handler
// directly; it never receives raw log rows or application projection callbacks.


import { Packr } from 'msgpackr';




import { envelopeDiagnostics } from './event-delivery.mjs';
import { compressPayloadAsync, mergeVaryHeader } from './http-response.mjs';

const JSON_LIMIT = 1024 * 1024;
export const DEFAULT_BOOTSTRAP_LIMIT = 64 * 1024 * 1024;

function requestUrl(req                 )      {
  return new URL(req.url ?? '/', 'http://workbench.local');
}

function reject(res                , status        , message        )       {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

function scopeFrom(url     )                {
  const scope = url.searchParams.get('scope');
  if (typeof scope !== 'string' || scope.length === 0 || scope.length > 512) return null;
  return scope;
}

function afterFrom(url     )                      {
  const raw = url.searchParams.get('after');
  if (raw === null) return 0;
  if (/^(0|[1-9][0-9]*)$/.test(raw)) {
    const after = Number(raw);
    return Number.isSafeInteger(after) ? after : null;
  }
  try {
    // Aggregate cursors are {anchor, aggregate}; composite-patch cursors
    // (#122 delta delivery) are {anchor, composite}. Both are two-field
    // nonnegative-cursor shapes — accept either, preserving the exact shape
    // so the delivery seam's cursor agreement holds.
    const cursor = JSON.parse(raw)                                                                  ;
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || !Number.isSafeInteger(cursor.anchor) || (cursor.anchor          ) < 0
      || Object.keys(cursor).length !== 2) return null;
    if (Number.isSafeInteger(cursor.aggregate) && (cursor.aggregate          ) >= 0) {
      return Object.freeze({ anchor: cursor.anchor          , aggregate: cursor.aggregate           });
    }
    if (Number.isSafeInteger(cursor.composite) && (cursor.composite          ) >= 0) {
      return Object.freeze({ anchor: cursor.anchor          , composite: cursor.composite           });
    }
    return null;
  } catch {
    return null;
  }
}

// An optional declarative collection rule, URL-encoded as JSON (`rule=`), so
// an EventSource can subscribe a live collection with the same rule grammar a
// WebSocket subscribe message carries. Absent → undefined; present but not a
// JSON object → null (the caller rejects the request).
function ruleFrom(url     )          {
  const raw = url.searchParams.get('rule');
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw)           ;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Stateless standard MessagePack encoder that omits undefined properties so
// decoded objects match JSON.stringify/JSON.parse shapes strictly. `skipValues`
// is supported at runtime in msgpackr 2.1.4 though omitted from its index.d.ts.
const bootstrapPackr = new Packr({
  useRecords: false,
  skipValues: [undefined],
  structuredClone: false,
}                                          );

function acceptsMsgpack(acceptHeader                               )          {
  const raw = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader;
  if (!raw) return false;
  for (const part of raw.toLowerCase().split(',')) {
    const [mediaType, ...params] = part.trim().split(';');
    if (mediaType !== 'application/x-msgpack' && mediaType !== 'application/msgpack') continue;
    let q = 1;
    for (const param of params) {
      const [key, val] = param.trim().split('=');
      if (key === 'q') {
        const parsed = Number(val);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (q > 0) return true;
  }
  return false;
}

// Bootstraps and catch-ups are one-time page-load responses: a document's
// recipient view plus (for unredacted recipients) its family checkpoint seed.
// Those legitimately reach tens of MB on large transcripts. Per-keystroke SSE
// frames stay at JSON_LIMIT so folds cannot silently demote to resync.
async function writeBootstrapPayload(
  req                 ,
  res                ,
  value         ,
  maxBytes = JSON_LIMIT,
)                {
  const wantMsgpack = acceptsMsgpack(req.headers.accept);
  const body = wantMsgpack ? bootstrapPackr.pack(value) : JSON.stringify(value);
  const compressed = await compressPayloadAsync(body, req.headers['accept-encoding']);
  if (compressed.body.length > maxBytes) throw new Error('live delivery response exceeds limit');
  const headers                                  = {
    'content-type': wantMsgpack ? 'application/x-msgpack' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': compressed.body.length,
  };
  if (compressed.encoding) {
    headers['content-encoding'] = compressed.encoding;
    headers['vary'] = mergeVaryHeader(res.getHeader('vary'), 'Accept-Encoding');
  }
  res.writeHead(200, headers);
  res.end(compressed.body);
}

// Wait for an SSE frame to drain (backpressure) or the response to close.
function waitForDrain(res                )                {
  return new Promise      ((resolve, reject) => {
    const onDrain = () => { res.off('close', onClose); resolve(); };
    const onClose = () => { res.off('drain', onDrain); reject(new Error('live delivery stream closed')); };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/**
 * Bind a public LiveDelivery to conventional Node HTTP routes.
 *
 * `GET {path}/bootstrap?scope=<scope>&mode=snapshot|catchup&after=<cursor>`
 * returns a package-owned recipient snapshot/catch-up result. `GET
 * {path}/events?scope=<scope>&after=<cursor>` is an SSE stream whose data
 * frames are arrays of recipient envelopes. Return false for unrelated routes.
 */
export function createLiveDeliveryHttpHandler({
  delivery,
  principalOf,
  path = '/live-delivery',
  maxSubscriptions = 100,
  bootstrapLimit = DEFAULT_BOOTSTRAP_LIMIT,
  log = null,
}






 ) {
  if (!delivery || typeof delivery.bootstrap !== 'function' || typeof delivery.catchup !== 'function' || typeof delivery.subscribe !== 'function') {
    throw new TypeError('delivery must be a LiveDelivery');
  }
  if (typeof principalOf !== 'function') throw new TypeError('principalOf is required');
  if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('path must be an absolute path');
  if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 1) throw new TypeError('maxSubscriptions must be a positive safe integer');
  if (!Number.isSafeInteger(bootstrapLimit) || bootstrapLimit < 1) throw new TypeError('bootstrapLimit must be a positive safe integer');

  let subscriptions = 0;

  return async function handleLiveDelivery(req                 , res                )                   {
    const url = requestUrl(req);

    // Authoring ack endpoint
    if (url.pathname === `${path}/authoring/ack`) {
      if (req.method !== 'POST') { reject(res, 405, 'method not allowed'); return true; }
      let body         ;
      try {
        const { readRequestBody } = await import('./http-body.mjs');
        body = await readRequestBody(req                                                    , { jsonOnly: true });
      } catch {
        reject(res, 400, 'invalid body');
        return true;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reject(res, 400, 'invalid ack request');
        return true;
      }
      const ack = body                           ;
      if (ack.version !== 1 ||
          typeof ack.entity !== 'string' || typeof ack.field !== 'string' || typeof ack.documentId !== 'string' ||
          typeof ack.stream !== 'string' || typeof ack.lease !== 'string' || typeof ack.snapshot !== 'string') {
        reject(res, 400, 'invalid ack request');
        return true;
      }
      let principal           ;
      // Demo-only principal hint (viewAs) is carried in the ack body alongside the
      // document identity; the real sessionPrincipalOf ignores it.
      try { principal = await principalOf(req, { viewAs: ack.viewAs ?? null }); } catch { reject(res, 403, 'access denied'); return true; }
      if (!principal || typeof principal !== 'object') { reject(res, 403, 'access denied'); return true; }
      const documentIdentity = { entity: ack.entity          , field: ack.field          , documentId: ack.documentId           };
      const document = delivery.resolveAnnotatedTextDocument ? delivery.resolveAnnotatedTextDocument(documentIdentity) : null;
      if (!document) { reject(res, 404, 'document not found'); return true; }
      const result = await delivery.acknowledgeAuthoringSnapshot({ document, principal, stream: ack.stream          , lease: ack.lease          , snapshot: ack.snapshot           });
       if (!result) { reject(res, 409, 'acknowledgement rejected'); return true; }
      const { sendJson } = await import('./http-response.mjs');
      sendJson(res, 200, { ok: true, acknowledgedThrough: result.acknowledgedThrough });
      return true;
    }

    if (url.pathname !== `${path}/bootstrap` && url.pathname !== `${path}/events`) return false;
    if (req.method !== 'GET') {
      reject(res, 405, 'method not allowed');
      return true;
    }
    const scope = scopeFrom(url);
    const after = afterFrom(url);
    const rule = ruleFrom(url);
    if (rule === null) {
      reject(res, 400, 'invalid live delivery rule');
      return true;
    }
    // Protocol negotiation forwarding (#159): the client advertises
    // `snapshot-patch/v1` capabilities and presents its projection token on
    // every bootstrap/catchup/subscribe call. The delivery seam already
    // accepts both; without forwarding them here the delta lane is
    // unreachable over HTTP/SSE and every edit falls back to a full snapshot.
    const capabilities = url.searchParams.has('capabilities')
      ? url.searchParams.get('capabilities') .split(',').map((capability) => capability.trim()).filter((capability) => capability.length > 0)
      : undefined;
    const projectionToken = url.searchParams.get('projectionToken') ?? undefined;
    const documentIdentity = url.searchParams.has('documentId') ? {
      entity: url.searchParams.get('entity'), field: url.searchParams.get('field'), documentId: url.searchParams.get('documentId'),
    } : null;
    const resolvedDocument = documentIdentity ? delivery.resolveAnnotatedTextDocument?.(documentIdentity                                                         ) : null;
    const document                               = resolvedDocument && url.searchParams.has('authoringClient')
      ? { ...resolvedDocument, clientNonce: url.searchParams.get('authoringClient') }
      : resolvedDocument;
    const effectiveScope = document?.scope ?? scope;
    if (!effectiveScope || after === null || (documentIdentity && (!document || (scope !== null && scope !== effectiveScope)))) {
      reject(res, 400, 'invalid live delivery request');
      return true;
    }
    let principal           ;
    try { principal = await principalOf(req); } catch { reject(res, 403, 'access denied'); return true; }
    if (!principal || typeof principal !== 'object') { reject(res, 403, 'access denied'); return true; }

    let releaseStream                      = null;
    try {
      if (url.pathname === `${path}/bootstrap`) {
        const mode = url.searchParams.get('mode');
        if (mode === 'snapshot') {
          // The delivery seam creates the snapshot from its recipient-hydrated row.
          const result = await delivery.bootstrap({ principal, scope: effectiveScope, document, capabilities });
          await writeBootstrapPayload(req, res, result, bootstrapLimit);
        } else if (mode === 'catchup') {
          const result = await delivery.catchup({ principal, scope: effectiveScope, after, document, capabilities, projectionToken });
          // A small event count can still contain a large recipient envelope.
          // Replace oversized replay with the same paired opaque recovery.
          const encoded = JSON.stringify(result);
          await writeBootstrapPayload(req, res, Buffer.byteLength(encoded) > JSON_LIMIT
            ? await delivery.bootstrap({ principal, scope: effectiveScope, document, capabilities })
            : result, bootstrapLimit);
        } else {
          reject(res, 400, 'invalid live delivery mode');
        }
        return true;
      }

      // Reserve before any await so concurrent upgrades cannot race the cap.
      if (subscriptions >= maxSubscriptions) { reject(res, 503, 'live delivery capacity reached'); return true; }
      subscriptions += 1;
      const controller = new AbortController();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        subscriptions -= 1;
        controller.abort();
      };
      releaseStream = release;
      // IncomingMessage 'close' also fires after a fully read request body;
      // only the response lifecycle represents an SSE stream cancellation.
      // The principal resolves once here; principal-snapshot streams remain
      // attached through the delivery's own reauthorization seam, which runs
      // on every replacement/resync drain and tears the stream down via revoke
      // when the host no longer admits the principal.
      res.once('close', release);
      let revoked = false;
      const activation = await delivery.subscribe({
        principal,
        scope: effectiveScope,
        document,
        after,
        rule: rule         ,
        signal: controller.signal,
        revoke: () => { revoked = true; release(); if (res.headersSent && !res.writableEnded) res.end(); },
        capabilities,
        projectionToken,
        deliver: async (envelopes) => {
          if (controller.signal.aborted) throw new Error('live delivery stream closed');
          const payload = JSON.stringify(envelopes);
          if (Buffer.byteLength(payload) > JSON_LIMIT) {
            // An SSE frame cannot carry the whole batch. Demote a state-carrying
            // batch to `state-invalidate` (resnapshot-required) — the kind-
            // consistent recovery control for a live replacement — and log a
            // content-free diagnostic (kind + revision only) so an oversized
            // delivery is diagnosable without leaking row content.
            const last = envelopes.at(-1)                                ;
            const frame = JSON.stringify([{
              type: envelopes.some((envelope) => (envelope                      )?.type === 'state') ? 'state-invalidate' : 'resync',
              seq: last?.seq ?? after,
              reason: 'recipient-snapshot-required',
            }]);
            log?.warn?.('live', 'delivery frame exceeds transport limit', {
              scope: effectiveScope,
              envelope: envelopeDiagnostics(last),
            });
            if (!res.write(`data: ${frame}\n\n`)) {
              await waitForDrain(res);
            }
            return;
          }
          if (!res.write(`data: ${payload}\n\n`)) {
            await waitForDrain(res);
          }
        },
      });
      // Public delivery reports an admission denial through revoke rather than
      // exposing raw authorization errors. Before streaming starts we can map
      // that terminal outcome to ordinary HTTP authorization semantics.
      if (revoked) {
        release();
        reject(res, 403, 'access denied');
        return true;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      await activation.activate();
      if (revoked && !res.writableEnded) res.end();
      return true;
    } catch (error) {
      log?.error?.('live', 'HTTP live delivery request failed', {
        path: url.pathname,
        mode: url.searchParams.get('mode') ?? null,
        scope: url.searchParams.get('scope') ?? null,
        entity: url.searchParams.get('entity') ?? null,
        field: url.searchParams.get('field') ?? null,
        documentId: url.searchParams.get('documentId') ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      releaseStream?.();
      // Surface the underlying framework error (message only, no stack) so a
      // client's bootstrap failure is diagnosable instead of an opaque 400.
      const denied = (error                                         )?.code === 'live-delivery-revoked';
      const detail = !denied && error instanceof Error && typeof error.message === 'string'
        ? `live delivery unavailable: ${error.message}`
        : 'live delivery unavailable';
      if (url.pathname === `${path}/events`) {
        if (!res.headersSent) reject(res, denied ? 403 : 400, detail);
        else if (!res.writableEnded) res.end();
      } else if (!res.headersSent) {
        reject(res, denied ? 403 : 400, detail);
      }
      return true;
    }
  };
}
