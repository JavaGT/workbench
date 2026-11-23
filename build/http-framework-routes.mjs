// Framework-owned HTTP routes — snapshot, multi-snapshot, events-since, blob
// upload, job queue, and the browser SDK endpoint.
//
// These are NOT mounted routes: they are framework defaults intercepted before
// route matching in the request handler, like /health. Auth runs through the
// SAME engine as REST (mayVerb / mayRow / readScope), not a second path.
//
// Exports: handleResyncRoute, handleBlobUploadRoute, handleBlobReadRoute,
// handleJobRoute, handleClientSdkRoute.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { dirname, join } from 'node:path';

import { fileURLToPath } from 'node:url';

import { sendJson,                       } from './http-response.mjs';
import { failureForHttpError, sendFailure,               } from './http-failure.mjs';
import { readScopedRow, authorizeRow,                                   } from './http-crud-dispatch.mjs';
import { rawRow } from './entity/query.mjs';
import { readSeq, readSince, minSeqForScope, decodeLogRowData } from './committed-log.mjs';

import { BodyError, readRawBody, readRequestBody } from './http-body.mjs';
import { scopeOf, tryParseScopeKey } from './scope-handle.mjs';
import { createdTextReducerSeeds, textReducerCheckpoints } from './text-reducer-transport.mjs';
import { BlobTooLargeError } from './fs-blobs.mjs';
import { DEFAULT_BLOB_MAX_BYTES,                                   } from './blob-store.mjs';
import { serveAuthorizedBlob } from './authorized-blob-read.mjs';

/**
 * Locate the owning scope of a deleted annotated-text document by decoding its
 * committed events through the strict log-row decoder (Finding 2, round 3).
 * Replaces the previous raw `json_extract(eventData, '$.id')` lookup, which
 * bypassed v16 validation: a tampered v16 row now throws instead of silently
 * mismatching. Newest-first, matching the prior query's ordering.
 */
function findRetiredAnnotatedDocumentScope(db                                                                                                  , documentId        )                     {
  const rows = db.prepare('SELECT scope, seq, eventType, eventData FROM _Log ORDER BY rowid DESC')
    .all()                                                                                   ;
  for (const row of rows) {
    let data         ;
    try {
      data = decodeLogRowData(row         );
    } catch {
      // A tampered v16 row must not silently mismatch — rethrow so the tamper
      // surfaces rather than serving a wrong scope for a deleted document.
      throw new Error('retired annotated document lookup hit a tampered v16 event');
    }
    if (data && typeof data === 'object' && !Array.isArray(data)
      && (data                    ).id === documentId
      && typeof row.scope === 'string') {
      return row.scope;
    }
  }
  return undefined;
}

import { publicEvent } from './event-delivery.mjs';
import { parseEventType } from './event-handle.mjs';
import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';
import { hasAnnotatedTextFields, projectEntitySnapshot } from './entity-snapshot-projection.mjs';
import { projectRowForRecipient } from './entity/projection.mjs';
import { mayReadField, readableFieldNames } from './field-admission.mjs';
import {
  createAuthorizationAdapter,



} from './authorization-adapter.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { anonymous, collapseForAdmission,                } from './principal.mjs';
import { failure } from './outcome.mjs';
import { requireUser } from './route-gate.mjs';
import {
  compileQueryContract,
  executeQueryPage,
  QueryScopedReadError,


} from './query-scoped-read.mjs';

import { hybridSearch,                           } from './search-plugin.mjs';
import { searchStalenessOf } from './search-response.mjs';




















                                             



































function reject(res                  , status        , message        , details          )       {
  const workbenchFailure = failureForHttpError({ status, message, details });
  sendFailure(sendJson                       , res, workbenchFailure, { status });
}

// The ONE authorization adapter every framework route consults (S5/A2). The
// app stashes the injected adapter at listen time (serve.ts); with none
// injected, field-admission falls back to the framework row-grant engine — the
// default adapter's own implementation — unchanged.
function routeAuthorization(app              )                              {
  return (app                                                    )._authorization ?? null;
}

// The CRDT-text reducer checkpoints this principal may receive. A CRDT
// checkpoint is the canonical document, so it is gated on field-READ admission
// exactly like the projected value: a CRDT text field the principal cannot
// read carries no checkpoint to any recipient (spec 3a — an unreadable field
// never reaches any projection surface).
async function admittedTextReducerCheckpoints(
  entity            ,
  storedRow                                                                 ,
  principal           ,
  authorization                             ,
)                             {
  const checkpoints = textReducerCheckpoints(entity, storedRow);
  if (checkpoints.length === 0 || !storedRow) return checkpoints;
  const materialized = entity.deserializeRow({ ...storedRow });
  const readable = await readableFieldNames(entity         , materialized, principal, authorization);
  return checkpoints.filter((seed) => readable.has(seed.field));
}

// routes — resolved at request time from `/snapshot/:entity/:id`,
// `/snapshots?scope=...`, and `/events-since/:entity/:id`. The entity table IS
// the snapshot (scope's proven shape); the committed `_Log` is the RESYNC
// source. Authorization runs the SAME mayVerb('read') engine as REST `read`
// (the viewer bar), after the same readScope row filter — one auth engine, no
// second path (SPEC §7, §7.1).
//
// Returns true when the request was handled (the caller short-circuits); false
// when the path is not a framework resync route (fall through to matchRoute).
export async function handleResyncRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                              ,
)                   {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg[0] === 'blobs' && seg.length === 4) {
    return handleBlobReadRoute(app, req, res, principal);
  }
  const isSnapshot = seg[0] === 'snapshot';
  const isEventsSince = seg[0] === 'events-since';
  const isSnapshots = seg[0] === 'snapshots' && seg.length === 1;
  if (!isSnapshot && !isEventsSince && !isSnapshots) return false;
  if (!app || !app.entities || !app.db) return false;

  if (!principal || principal.id == null) {
    reject(res, 401, 'unauthorized');
    return true;
  }

  // Authorized multi-snapshot bootstrap (issue #184): GET /snapshots?scope=...
  if (isSnapshots) return bulkSnapshotRoute(app, principal, res, url.searchParams);

  // Scope-level requests: GET /snapshot?scope=project:p1 etc.
  const scopeParam = url.searchParams.get('scope');
  if (scopeParam) {
    if (isSnapshot) return snapshotScopeRoute(app, scopeParam, principal, res);
    const cursor = Number(url.searchParams.get('cursor') ?? 0);
    return eventsSinceScopeRoute(app, scopeParam, principal, res, cursor);
  }

  // Per-entity requests: GET /snapshot/:entity/:id or /events-since/:entity/:id
  if (seg.length !== 3) { reject(res, 404, 'not found'); return true; }
  const [, entityName, id] = seg;
  const entity = app.entities.get(entityName);
  if (!entity) { reject(res, 404, 'not found'); return true; }
  if (isSnapshot) return snapshotRoute(app, entity, id, principal, res);
  // events-since needs the owning scope to replay the committed log; the
  // snapshot capture derives it itself.
  const scopeKey = resolveEntityScopeKey(app, entity, id);
  const cursor = Number(url.searchParams.get('cursor') ?? 0);
  return eventsSinceRoute(app, entity, scopeKey, id, principal, res, cursor);
}

// The scope a row's snapshot and stream are keyed on. Usually `Entity:id`;
// an annotated-text document is owned by its parent row's scope, and a retired
// (deleted) document is located by decoding its committed events.
function resolveEntityScopeKey(app              , entity            , id        )         {
  const db = app.db ;
  const row = hasAnnotatedTextFields(entity) ? rawRow(db, entity.name, id) : null;
  const annotatedEntry = Object.entries(entity.fields).find(([, field]) => field.kind === 'annotatedText');
  const [, descriptor] = annotatedEntry ?? [];
  const retiredScope = !row && descriptor
    ? findRetiredAnnotatedDocumentScope(db, id)
    : undefined;
  return descriptor
    ? (row ? resolveAnnotatedTextOwningScope(descriptor, entity.fields, row).key : (retiredScope                      ) ?? scopeOf(entity.name, id).key)
    : scopeOf(entity.name, id).key;
}

// One per-scope snapshot capture — the single bootstrap engine, parameterized
// by scope set (issue #184): snapshotRoute serves ONE scope through it and
// bulkSnapshotRoute serves many. Every capture runs the same row grant + field
// read admission + recipient projection, so a bulk response is authz-equivalent
// to N single-snapshot requests for the same principal.


              




async function captureEntitySnapshot(
  app              ,
  entity            ,
  id        ,
  principal           ,
)                           {
  const db = app.db ;
  const scopeKey = resolveEntityScopeKey(app, entity, id);
  // Read the row + the scope cursor in ONE synchronous block — no await between
  // them — then authorize. A concurrent dispatch commit cannot split the pair
  // (eng-review Tier-1 #2): the cursor is captured alongside the row, before the
  // async mayVerb yields. The pair we authorize is the pair we return.
  const row = readScopedRow(app, entity, id, principal);
  const { sql: where, params } = entity.scopeFilter(principal);
  const storedRow = db.prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} AND t0.id = :id`)
    .get({ ...params, id });
  const lastSeq = readSeq(db, scopeKey);
  const auth = await authorizeRow(app, entity, 'read', id, principal, row, { authorization: routeAuthorization(app) ?? undefined });
  if (auth.status) return { ok: false, status: auth.status };
  let snapshot                         ;
  try {
    snapshot = await projectEntitySnapshot({ db, entity, row: auth.row , principal, authorization: routeAuthorization(app) });
    // Projection can await policy checks. Do not pair facts assembled across a
    // concurrent scope mutation with the cursor captured before those checks.
    if (hasAnnotatedTextFields(entity) && readSeq(db, scopeKey) !== lastSeq) {
      return { ok: false, status: 'raced' };
    }
  } catch {
    return { ok: false, status: 403 };
  }
  const reducers = await admittedTextReducerCheckpoints(entity, storedRow                                                , principal, routeAuthorization(app));
  return { ok: true, snapshot, seq: lastSeq, reducers };
}

async function snapshotRoute(
  app              ,
  entity            ,
  id        ,
  principal           ,
  res                  ,
)                   {
  const capture = await captureEntitySnapshot(app, entity, id, principal);
  if (!capture.ok) {
    const status = capture.status === 'raced' ? 403 : capture.status;
    reject(res, status, status === 404 ? 'not found' : 'forbidden');
    return true;
  }
  sendJson(res, 200, {
    snapshot: capture.snapshot,
    seq: capture.seq,
    reducers: capture.reducers,
  });
  return true;
}

// Authorized multi-snapshot bootstrap (issue #184): `GET
// /snapshots?scope=<Entity:id>&scope=...` returns the SAME per-scope snapshots
// LiveList already understands — each `results` entry is exactly a
// `GET /snapshot/:entity/:id` response body — plus the per-scope cursors the
// client sets BEFORE starting its per-scope streams (SPEC §7.1 bootstrap
// ordering; the endpoint itself starts no stream). One bootstrap engine,
// parameterized by scope set: every entry runs through captureEntitySnapshot,
// so the response rows are exactly the union of the per-scope compiled-scope
// rows for the requesting principal — withheld fields stay withheld, and no
// trailer metadata ever bypasses a per-scope grant. A scope the principal
// cannot read is ABSENT from `results` and `cursors`: the 404-equivalent
// denial, contributing no rows and no cursor.
//
// Fail closed (#189 version skew): an unknown query parameter, a malformed
// scope key, an unknown entity, or an over-budget scope set rejects the WHOLE
// request with 400 — a partial success could be silently folded, an error
// forces the client's re-bootstrap.
const MAX_BULK_SCOPES = 256;
// A single bootstrap may legitimately reach several MB (annotated-text
// documents). The multi-snapshot response is capped so a very large workspace
// fails closed (503, content-free) into per-scope fetches instead of pinning
// the process with an unbounded serialization.
const BULK_RESPONSE_LIMIT = 32 * 1024 * 1024;

async function bulkSnapshotRoute(
  app              ,
  principal           ,
  res                  ,
  searchParams                 ,
)                   {
  for (const key of new Set(searchParams.keys())) {
    if (key !== 'scope') { reject(res, 400, 'unknown query parameter'); return true; }
  }
  const requested = searchParams.getAll('scope');
  if (requested.length === 0) { reject(res, 400, 'scope parameter required'); return true; }
  if (requested.length > MAX_BULK_SCOPES) { reject(res, 400, 'too many scopes'); return true; }
  const targets                                                           = [];
  for (const scope of requested) {
    const handle = tryParseScopeKey(scope);
    const entity = handle ? app.entities .get(handle.entity) : undefined;
    if (!handle || !entity) { reject(res, 400, `unknown scope '${scope}'`); return true; }
    targets.push({ scope, entity, id: handle.id });
  }
  const entries = new Map                                                                                         ();
  const cursors = new Map                ();
  for (const target of targets) {
    if (entries.has(target.scope)) continue;
    const capture = await captureEntitySnapshot(app, target.entity, target.id, principal);
    if (capture.ok) {
      entries.set(target.scope, { snapshot: capture.snapshot, seq: capture.seq, reducers: capture.reducers });
      cursors.set(target.scope, capture.seq);
      continue;
    }
    if (capture.status === 'raced') {
      // Never pair a stale capture with its cursor, and never spell a race as a
      // denial (the row exists). Fail the whole request; the client re-bootstraps.
      reject(res, 503, 'snapshot changed while capturing');
      return true;
    }
  }
  const body = {
    results: Object.fromEntries(entries),
    cursors: Object.fromEntries(cursors),
  };
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > BULK_RESPONSE_LIMIT) {
    reject(res, 503, 'bulk snapshot exceeds response budget');
    return true;
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
  return true;
}

async function snapshotScopeRoute(
  app              ,
  scope        ,
  principal           ,
  res                  ,
)                   {
  // The cursor is read as the LAST synchronous step before responding — after
  // every await that can yield to a concurrent dispatch commit (authorizeScope,
  // and the app-supplied async scopeSnapshot aggregation) — never before. A
  // custom scopeSnapshot callback may read fresh state at its own resolution
  // time (it is not required to derive purely from the pre-authorized anchor
  // row), so the cursor paired with it must be captured at that same moment;
  // reading it any earlier risks returning a snapshot from one epoch next to a
  // cursor from an older one (Wave 3.7 Contract 4 detail).
  const access = await authorizeScope(app, scope, principal);
  if (access.status) {
    reject(res, access.status, access.status === 404 ? 'not found' : 'forbidden');
    return true;
  }
  const anchor = access.anchor ;
  if (access.direct) {
    const lastSeq = readSeq(app.db , scope);
    const storedRow = rawRow(app.db , anchor.entity, anchor.id);
    const entity = app.entities .get(anchor.entity) ;
    try {
      const snapshot = await projectEntitySnapshot({ db: app.db, entity, row: anchor.row , principal, authorization: routeAuthorization(app) });
      if (readSeq(app.db , scope) !== lastSeq) throw new Error('snapshot changed while projecting');
      sendJson(res, 200, {
        snapshot,
        cursors: { [scope]: lastSeq },
        reducers: await admittedTextReducerCheckpoints(entity, storedRow                                                , principal, routeAuthorization(app)),
      });
    } catch {
      reject(res, 403, 'forbidden');
    }
    return true;
  }
  // A custom scope may aggregate several rows, but its resolver must first map
  // it to one normal entity row that owns authorization. The callback receives
  // that already-authorized anchor; it is a data projection hook, never a
  // second authorization engine.
  const scopeSnapshot = typeof app.scopeSnapshot === 'function'
    ? await app.scopeSnapshot(scope, principal, anchor)
    : null;
  if (scopeSnapshot !== null && scopeSnapshot !== undefined) {
    // An aggregate callback has no recipient annotated-text grammar. Never let
    // it become an unprojected alternate delivery path for an annotated entity.
    const lastSeq = readSeq(app.db , scope);
    const entity = app.entities .get(anchor.entity) ;
    if (hasAnnotatedTextFields(entity)) {
      reject(res, 403, 'forbidden');
      return true;
    }
    const storedAnchor = rawRow(app.db , anchor.entity, anchor.id);
    sendJson(res, 200, {
      snapshot: scopeSnapshot,
      cursors: { [scope]: lastSeq },
      reducers: await admittedTextReducerCheckpoints(entity, storedAnchor                                                , principal, routeAuthorization(app)),
    });
    return true;
  }
  reject(res, 404, 'not found');
  return true;
}

async function eventsSinceScopeRoute(
  app              ,
  scope        ,
  principal           ,
  res                  ,
  cursor        ,
)                   {
  const access = await authorizeScope(app, scope, principal);
  if (access.status) {
    reject(res, access.status, access.status === 404 ? 'not found' : 'forbidden');
    return true;
  }
  const anchor = access.anchor ;
  const entity = app.entities .get(anchor.entity) ;
  // A custom aggregate has no annotated-text recipient grammar. Deny before
  // retention handling so it cannot acquire a transport-specific disposition.
  if (hasAnnotatedTextFields(entity) && !access.direct) {
    reject(res, 403, 'forbidden');
    return true;
  }
  const minSeq = minSeqForScope(app.db                        , scope);
  if (minSeq !== null && cursor + 1 < minSeq) {
    sendJson(res, 200, { resync: 'stale', reason: 'cursor-behind-retention' });
    return true;
  }
  const rows = readSince(app.db                        , scope, cursor);
  // The T5b snapshot reader is the only recipient grammar for annotated text.
  // Historical operation facts cannot cross replay until a projected event
  // grammar exists, so force the client through that reader instead.
  if (hasAnnotatedTextFields(entity)) {
    if (rows.length > 0) {
      sendJson(res, 200, { resync: 'stale', reason: 'annotated-text-snapshot-required' });
      return true;
    }
  }
  const envelopes = createLiveEnvelopeBuilder({ stateful: false });
  const events = []             ;
  // Field-read admission (S5/A3): the catch-up envelopes derive their lifecycle
  // data from the anchor row, so the row is projected to exactly the readable
  // field subset FIRST and the readable set is handed to the envelope builder —
  // an unreadable field never appears in any recipient lifecycle payload.
  const authorization = routeAuthorization(app);
  let envelopeRow = anchor.row;
  let readableFields                                 ;
  if (anchor.row) {
    const materialized = entity.deserializeRow({ ...anchor.row });
    readableFields = await readableFieldNames(entity         , materialized, principal, authorization);
    envelopeRow = await projectRowForRecipient(entity         , materialized, principal, { readable: readableFields, authorization });
  }
  for (const r of rows) {
    const record = r                                                                                                                      ;
    const built = envelopes.buildEnvelope({
      entity: entity         ,
      event: {
        scope: record.scope          ,
        seq: record.seq          ,
        eventType: record.eventType          ,
        actionId: record.actionId          ,
        committedAt: record.committedAt          ,
      },
      principal,
      row: envelopeRow,
      scope,
      ...(readableFields ? { readableFields } : {}),
    });
    const recovery = built.find((envelope) => envelope.type === 'resync');
    if (recovery) {
      sendJson(res, 200, { resync: 'stale', reason: recovery.reason });
      return true;
    }
    for (const envelope of built) if (envelope.event) events.push(envelope.event);
  }
  sendJson(res, 200, { scope, cursor, events });
  return true;
}

async function authorizeScope(app              , scope        , principal           )                       {
  const handle = tryParseScopeKey(scope);
  const directEntity = handle ? app.entities?.get(handle.entity) : null;
  let anchor                                        = directEntity ? { entity: handle .entity, id: handle .id } : null;
  let direct = Boolean(directEntity);

  if (!anchor) {
    if (typeof app.resolveScope !== 'function') return { status: 404, direct: false };
    const resolved = await app.resolveScope(scope)                                                         ;
    anchor = resolved && typeof resolved.entity === 'string' && resolved.id != null
      ? { entity: resolved.entity, id: String(resolved.id) }
      : null;
    direct = false;
  }
  if (!anchor || typeof anchor.entity !== 'string' || anchor.id == null) {
    return { status: 404, direct: false };
  }
  const entity = app.entities?.get(anchor.entity);
  if (!entity) return { status: 404, direct: false };

  const row = readScopedRow(app, entity, String(anchor.id), principal);
  const auth = await authorizeRow(app, entity, 'read', String(anchor.id), principal, row, { authorization: routeAuthorization(app) ?? undefined });
  if (auth.status) return { status: auth.status, direct };
  return {
    anchor: { entity: anchor.entity, id: String(anchor.id), row: auth.row },
    direct,
  };
}

async function eventsSinceRoute(
  app              ,
  entity            ,
  scopeKey        ,
  documentId        ,
  principal           ,
  res                  ,
  cursor        ,
)                   {
  // events-since authorizes against the CURRENT row, falling back to the
  // deleted-row history anchor when the row is gone (Wave 3.7 Contract 1): an
  // owner who held read+subscribe at the moment of deletion can still resync
  // the tail of that scope's history (its own `Note.removed` event included).
  // Fail closed either way: an out-of-scope or genuinely-nonexistent row, or
  // a deleted row the principal never held a grant on, yields 404.
  const auth = await authorizeRow(app, entity, 'read', documentId, principal, null, { allowDeletedAnchor: true, authorization: routeAuthorization(app) ?? undefined });
  if (auth.status) {
    reject(res, auth.status, auth.status === 404 ? 'not found' : 'forbidden');
    return true;
  }
  // A deleted annotated document has no recipient snapshot to recover from.
  // Its historical row grant permits only an opaque terminal disposition, not
  // replay of the canonical events that preceded deletion. This wins over
  // retention because a stale response would demand an impossible snapshot.
  if (auth.historical && hasAnnotatedTextFields(entity)) {
    const last = (app.db .prepare('SELECT MAX(seq) AS seq FROM _Log WHERE scope = ?').get(scopeKey)                                 )?.seq ?? 0;
    sendJson(res, 200, { resync: 'deleted', seq: Math.max(readSeq(app.db , scopeKey), last          ) });
    return true;
  }
  const minSeq = minSeqForScope(app.db                        , scopeKey);
  // The client wants events > cursor; the first wanted is cursor+1. If that is
  // older than the oldest RETAINED event, the gap can never be filled → HARD-FAIL.
  // Never a silent truncate (SPEC §3.6 — the single non-negotiable property).
  if (minSeq !== null && cursor + 1 < minSeq) {
    sendJson(res, 200, { resync: 'stale', reason: 'cursor-behind-retention' });
    return true;
  }
  const rows = readSince(app.db                        , scopeKey, cursor);
  // Do not selectively redact event.data: annotated-text events also carry
  // canonical family facts in reducers and framework metadata. A nonempty
  // replay is terminally redirected to the recipient-projected snapshot.
  if (hasAnnotatedTextFields(entity) && rows.length > 0) {
    sendJson(res, 200, { resync: 'stale', reason: 'annotated-text-snapshot-required' });
    return true;
  }
  const events = rows.map((r         ) => {
    const record = r                                                                                                                      ;
    let handle;
    try {
      handle = parseEventType(record.eventType          );
    } catch {
      return null;
    }
    // A direct entity stream may only replay events whose declared entity is
    // the admitted entity. Never serialize a foreign event before this check:
    // its payload may contain an inaccessible row's body or generated id.
    if (handle.entity !== entity.name) return null;
    const data = record.data ?? null;
    const reducers = createdTextReducerSeeds(entity, { type: record.eventType          , data: data ?? undefined });
    return publicEvent({ type: record.eventType, scope: record.scope, seq: record.seq, data: data                                  , actionId: record.actionId, committedAt: record.committedAt, ...(reducers ? { reducers } : {}) });
  });
  if (events.some((event) => event === null)) {
    sendJson(res, 200, { resync: 'stale', reason: 'recipient-snapshot-required' });
    return true;
  }
  sendJson(res, 200, { events });
  return true;
}

// Framework-owned blob upload endpoint (spec #2, eng-review Walk 1b, #287). NOT
// a mounted route: `POST /blobs` streams the request body directly to the byte
// store's pending slot OUTSIDE the write coordinator (computing md5+sha256 on
// the way past and enforcing `maxBytes` mid-stream), then acquires the write
// coordinator ONLY for the sub-millisecond SQLite metadata INSERT, returning
// { id, md5, sha256, size, mime }. A rolled-back dispatch leaves it pending for
// the reaper. Route-gate fail-closed: anonymous → 401. Returns true when
// handled; false to fall through to matchRoute.




function firstHeaderString(value                               )         {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function toUint8ArrayChunk(chunk         )             {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new TypeError('streamed blob chunk must be Uint8Array');
}

// Adapt a Node IncomingMessage (or EventEmitter test double) into a
// backpressure-aware AsyncIterable<Uint8Array> WITHOUT calling req.destroy() on
// early return (such as a mid-stream 413 BlobTooLargeError), so the HTTP
// response flushes cleanly while unread request bytes drain.
function requestBodyAsyncIterable(req                  )


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

function resolveBlobUploadMaxBytes(
  app              ,
  options                         ,
)         {
  const candidates = [options?.maxBytes, app.blobs?.maxBytes, app.blobMaxBytes];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return DEFAULT_BLOB_MAX_BYTES;
}

export async function handleBlobUploadRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                              ,
  options                         ,
)                   {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/blobs' || req.method !== 'POST') return false;
  if (!app || !app.blobs) return false;
  // route gate (requireUser) — fail closed for anonymous, same as a mounted route.
  if (!principal || principal.id == null) {
    reject(res, 401, 'unauthorized');
    return true;
  }

  const maxBytes = resolveBlobUploadMaxBytes(app, options);
  const rawReq = req.raw ?? req;
  const declaredLengthHeader = firstHeaderString(rawReq.headers['content-length']);
  const declaredLength = declaredLengthHeader ? Number(declaredLengthHeader) : NaN;
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
    try { rawReq.resume?.(); } catch {}
    reject(res, 413, `blob exceeds ${maxBytes} bytes`);
    return true;
  }

  const mime = (firstHeaderString(rawReq.headers['content-type']) || 'application/octet-stream')
    .split(';')[0]
    .trim() || 'application/octet-stream';
  const coordinator = app.writeCoordinator;
  const blobs = app.blobs;

  // Streaming upload path (#287): stream chunks directly to disk + hash
  // OUTSIDE app.writeCoordinator.run(...), then acquire the coordinator ONLY
  // for the sub-millisecond SQLite metadata row insert.
  if (typeof blobs.stagePendingStream === 'function' && typeof blobs.recordPending === 'function') {
    const blobId = randomUUID();
    const { stream, drain } = requestBodyAsyncIterable(req);
    let attested                                                     ;
    try {
      attested = await blobs.stagePendingStream(blobId, stream, { maxBytes });
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        drain();
        reject(res, 413, err.message);
        return true;
      }
      if (err instanceof BodyError) {
        reject(res, err.status, err.message);
        return true;
      }
      throw err;
    }
    let meta              ;
    try {
      const register = () => blobs.recordPending (blobId, attested, { mime });
      meta = coordinator ? await coordinator.run(register) : register();
    } catch (err) {
      try { blobs.removePendingSlot?.(blobId); } catch {}
      throw err;
    }
    sendJson(res, 201, meta);
    return true;
  }

  if (typeof blobs.writePendingStream === 'function') {
    const blobId = randomUUID();
    const { stream, drain } = requestBodyAsyncIterable(req);
    let attested                                                     ;
    try {
      attested = await blobs.writePendingStream(blobId, stream, {
        maxBytes,
        mime,
        ...(coordinator ? { coordinate:    (fn                      ) => coordinator.run(fn) } : {}),
      });
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        drain();
        reject(res, 413, err.message);
        return true;
      }
      if (err instanceof BodyError) {
        reject(res, err.status, err.message);
        return true;
      }
      throw err;
    }
    sendJson(res, 201, {
      id: blobId,
      md5: attested.md5,
      sha256: attested.sha256,
      size: attested.byteLength,
      mime,
    });
    return true;
  }

  // Legacy fallback for minimal test doubles implementing only upload().
  if (typeof blobs.upload !== 'function') return false;
  let bytes        ;
  try {
    bytes = await readRawBody(rawReq         , maxBytes);
  } catch (err) {
    if (err instanceof BodyError) {
      reject(res, err.status, err.message);
      return true;
    }
    throw err;
  }
  const meta = coordinator
    ? await coordinator.run(() => blobs.upload ({ bytes, mime }))
    : blobs.upload({ bytes, mime });
  sendJson(res, 201, meta);
  return true;
}

// Per-app cache of the compiled SQL scopeFilter AuthorizationAdapter used by
// handleBlobReadRoute (`GET`/`HEAD /blobs/:entity/:id/:field`).
const blobReadAdapters = new WeakMap                                                                    ();

function getEntityBlobAdapter(app              , entity            , fieldName        )


  {
  let entry = blobReadAdapters.get(app);
  if (!entry) {
    entry = {
      adapter: createAuthorizationAdapter({ db: app.db                               }),
      registered: new Set        (),
    };
    blobReadAdapters.set(app, entry);
  }
  const resourceName = `${entity.name}.${fieldName}`;
  if (!entry.registered.has(resourceName)) {
    const entityLike = entity                                 ;
    if (entityLike.readScope && entityLike.scopeAst) {
      entry.adapter.registerResource({
        category: 'blob',
        name: resourceName,
        entity: entityLike,
        db: app.db                              ,
      });
      entry.registered.add(resourceName);
    }
  }
  return { adapter: entry.adapter, resourceName };
}

function sendOpaqueBlobReadForbidden(res                  , isHead         )       {
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
    sendJson                       ,
    res,
    failure('denied', 'forbidden'),
    { status: 403, headers: { 'cache-control': 'private, no-store' } },
  );
}

// Framework-owned authorized blob media route (#287):
// `GET`/`HEAD /blobs/:entity/:id/:field`.
//
// Evaluates the owning entity's compiled SQL `scopeFilter` (including
// `membership()` and `inherit(...)` grants) plus row/field `.can` read
// admission via the single authorization seam, then serves bytes via
// `serveAuthorizedBlob` (`200`, `206 Partial Content`, `416`, `HEAD`,
// `ETag`, `Accept-Ranges: bytes`, `Cache-Control: private, no-store`,
// backpressure-safe streaming via `pumpWebStreamToResponse`). Every denial,
// missing entity/field, missing row, or missing blob fails closed with an
// opaque `403`.
export async function handleBlobReadRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                   ,
)                   {
  const method = (req.method ?? '').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg.length !== 4 || seg[0] !== 'blobs') return false;
  if (!app || !app.entities || !app.db || !app.blobs) return false;
  const isHead = method === 'HEAD';

  let entityName        ;
  let id        ;
  let fieldName        ;
  try {
    entityName = decodeURIComponent(seg[1] );
    id = decodeURIComponent(seg[2] );
    fieldName = decodeURIComponent(seg[3] );
  } catch {
    sendOpaqueBlobReadForbidden(res, isHead);
    return true;
  }

  const entity = app.entities.get(entityName);
  const descriptor = entity?.fields?.[fieldName]                                  ;
  if (!entity || !descriptor || descriptor.blob !== true) {
    sendOpaqueBlobReadForbidden(res, isHead);
    return true;
  }

  const blobs = app.blobs;
  if (typeof blobs.stat !== 'function' || typeof blobs.readRangeStream !== 'function') {
    sendOpaqueBlobReadForbidden(res, isHead);
    return true;
  }

  const effectivePrincipal            = principal ?? req.principal ?? anonymous;
  const storedRow = rawRow(app.db, entity.name, id)                                       ;
  const { adapter: entityBlobAdapter, resourceName } = getEntityBlobAdapter(app, entity, fieldName);
  const appAuthz = routeAuthorization(app);

  // Compose the compiled SQL `blob` scopeFilter admission with row/field read
  // capability admission (`.can` / `inherit(...)` / field access). If an app
  // explicitly registered a `blob` policy on its custom `_authorization`
  // adapter, honor it directly.
  const routeBlobAuthorize                       = {
    registerResource: (input) => entityBlobAdapter.registerResource(input),
    admit: async (input) => {
      if (input.category !== 'blob') return entityBlobAdapter.admit(input);
      if (appAuthz) {
        const customByField = await appAuthz.admit({ ...input, resourceName: fieldName });
        if (customByField.reasonCode !== 'no-resource') return customByField;
        const customByQualified = await appAuthz.admit({ ...input, resourceName });
        if (customByQualified.reasonCode !== 'no-resource') return customByQualified;
      }
      const scopeDecision = await entityBlobAdapter.admit({
        ...input,
        resourceName,
        entity: entity                                 ,
        db: app.db                              ,
      });
      if (!scopeDecision.admitted || !storedRow) return scopeDecision;
      const collapsed = collapseForAdmission(input.principal);
      const materialized = entity.deserializeRow({ ...storedRow });
      const fieldAllowed = await mayReadField(
        entity         ,
        fieldName,
        materialized,
        collapsed,
        appAuthz,
      );
      if (!fieldAllowed) {
        return Object.freeze({
          ...scopeDecision,
          admitted: false,
          reasonCode: 'no-capability'         ,
        });
      }
      return scopeDecision;
    },
  };

  let resolvedBlobId                = null;
  const resolveAdoptedBlobId = ()                => {
    if (!storedRow) return null;
    const rawId = storedRow[fieldName];
    return typeof rawId === 'string' && rawId.length > 0 ? rawId : null;
  };

  await serveAuthorizedBlob({
    req,
    res: res                             ,
    principal: effectivePrincipal,
    resource: storedRow ?? null,
    field: resourceName,
    authorize: routeBlobAuthorize,
    entity: entity                                 ,
    db: app.db                              ,
    stat: () => {
      const blobId = resolveAdoptedBlobId();
      if (!blobId) return null;
      const meta = blobs.stat (blobId);
      if (!meta || meta.status !== 'adopted') return null;
      // Confirm the final byte slot exists without reading bytes into RAM so
      // HEAD also fails closed with opaque 403 when bytes are missing on disk.
      if (typeof blobs.readRange === 'function') {
        blobs.readRange(blobId, [0, 0]);
      }
      resolvedBlobId = blobId;
      return { size: meta.size, mime: meta.mime, sha256: meta.sha256 };
    },
    readStream: (range, options)           => {
      const blobId = resolvedBlobId ?? resolveAdoptedBlobId();
      if (!blobId) throw new Error('blob not found');
      return blobs.readRangeStream (blobId, range, options);
    },
  });
  return true;
}

// Framework-owned job-queue endpoints (spec #5, Walk 2). NOT mounted routes: the
// worker / job API is a framework default, intercepted before route matching (like
// /blobs, /health, /snapshot). Auth is its OWN path — a per-worker bearer token,
// constant-time compared + revocable (cso: never the shared secret, which is used
// only at /workers/register). These routes are anonymous w.r.t. the route gate — a
// worker is not a logged-in principal; the bearer IS the credential. Workers are
// non-browser clients (no Origin/Referer) so they pass the foreign-only CSRF guard.
// Returns true when handled; false to fall through to matchRoute.
export async function handleJobRoute(
  app                                 ,
  req                  ,
  res                  ,
)                   {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'POST' || !app?.jobs) return false;
  const jobs = app.jobs;

  // Bearer extraction: `Authorization: Bearer <workerId>.<token>`.
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim() || null;

  if (url.pathname === '/workers/register') {
    let body         ;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { reject(res, err.status, err.message); return true; }
      throw err;
    }
    const w = jobs.registerWorker((body                        ).secret);
    if (!w) { reject(res, 401, 'invalid shared secret'); return true; }
    sendJson(res, 200, w);
    return true;
  }

  if (url.pathname === '/jobs/claim') {
    const workerId = jobs.authenticate(bearer);
    if (!workerId) { reject(res, 401, 'unauthorized'); return true; }
    let body         ;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { reject(res, err.status, err.message); return true; }
      throw err;
    }
    if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
      reject(res, 400, 'request body must be a JSON object');
      return true;
    }
    const bodyRecord = (body ?? {})                                       ;
    if (bodyRecord.kind != null && typeof bodyRecord.kind !== 'string') {
      reject(res, 400, 'kind must be a string');
      return true;
    }
    if (bodyRecord.scope != null && typeof bodyRecord.scope !== 'string') {
      reject(res, 400, 'scope must be a string');
      return true;
    }
    const queryKind = url.searchParams.get('kind') || undefined;
    const queryScope = url.searchParams.get('scope') || undefined;
    const kind = queryKind || (bodyRecord.kind ? bodyRecord.kind : undefined);
    const scope = queryScope || (bodyRecord.scope ? bodyRecord.scope : undefined);
    const claimOpts = kind !== undefined || scope !== undefined
      ? { ...(kind !== undefined ? { kind } : {}), ...(scope !== undefined ? { scope } : {}) }
      : undefined;
    const job = await jobs.claim(workerId, claimOpts);
    if (!job) { res.writeHead(204); res.end(); return true; } // no queued work
    sendJson(res, 200, job);
    return true;
  }

  const hb = url.pathname.match(/^\/jobs\/([^/]+)\/heartbeat$/);
  if (hb) {
    const workerId = jobs.authenticate(bearer);
    if (!workerId) { reject(res, 401, 'unauthorized'); return true; }
    const ok = await jobs.heartbeat(hb[1], workerId);
    if (!ok) { reject(res, 403, 'not the owning worker or job not running'); return true; }
    sendJson(res, 200, { ok: true });
    return true;
  }

  const pg = url.pathname.match(/^\/jobs\/([^/]+)\/progress$/);
  if (pg) {
    const workerId = jobs.authenticate(bearer);
    if (!workerId) { reject(res, 401, 'unauthorized'); return true; }
    let body         ;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { reject(res, err.status, err.message); return true; }
      throw err;
    }
    const bodyRecord = body                                           ;
    const updated = await jobs.updateProgress({ jobId: pg[1], workerId, progress: bodyRecord.progress, stage: bodyRecord.stage });
    if (!updated) { reject(res, 403, 'not the owning worker or job not in progress'); return true; }
    const progress = updated                                                                           ;
    sendJson(res, 200, { id: progress.id, progress: progress.progress, stage: progress.stage, status: progress.status });
    return true;
  }

  const rs = url.pathname.match(/^\/jobs\/([^/]+)\/result$/);
  if (rs) {
    const workerId = jobs.authenticate(bearer);
    if (!workerId) { reject(res, 401, 'unauthorized'); return true; }
    let body         ;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { reject(res, err.status, err.message); return true; }
      throw err;
    }
    let result                                          ;
    try { result = await jobs.submitResult(rs[1], workerId, body)                                            ; }
    catch (err) { reject(res, 400, (err         ).message); return true; }
    if (!result?.accepted) { reject(res, 403, 'not the owning worker or job not in progress'); return true; }
    sendJson(res, 200, result);
    return true;
  }

  const cn = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
  if (cn) {
    const workerId = jobs.authenticate(bearer);
    if (!workerId) { reject(res, 401, 'unauthorized'); return true; }
    const cancelled = await jobs.cancelJob({ jobId: cn[1], workerId })                                                                                                  ;
    if (!cancelled) { reject(res, 404, 'job not found'); return true; }
    if (cancelled.forbidden) { reject(res, 403, 'not the owning worker'); return true; }
    if (cancelled.terminal) { reject(res, 400, 'job already terminal — cannot cancel'); return true; }
    sendJson(res, 200, { id: cancelled.id, status: cancelled.status });
    return true;
  }

  return false;
}

// Framework-owned browser SDK endpoint: `GET /workbench.mjs` serves the client
// side of the /events live protocol. Resolved relative to the repo root (this
// module sits one directory deep in both src/ and build/, and import.meta.url
// resolves to the emitted copy in build/), never process.cwd(). Only engaged
// when a db is present (the live kernel is running); a db-less app has no live
// protocol and falls through. Returns true when handled; false to fall through.
// The two emitted annotated-text leaves are served from build/; the browser
// SDK surface is hand-maintained under public/.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_SDK_PATH = join(root, 'public', 'workbench-client.mjs');
const ANNOTATED_TEXT_SDK_PATH = join(root, 'build', 'annotated-text.mjs');
const TEXT_EDIT_SDK_PATH = join(root, 'public', 'workbench-text-edit.mjs');
const ANNOTATED_TEXT_SNAPSHOT_SDK_PATH = join(root, 'public', 'workbench-annotated-text-snapshot.mjs');
const ANNOTATED_TEXT_SNAPSHOT_INTERNAL_SDK_PATH = join(root, 'public', 'workbench-annotated-text-snapshot-internal.mjs');
const ANNOTATED_TEXT_REDACTION_COORDS_SDK_PATH = join(root, 'public', 'workbench-annotated-text-redaction-coords.mjs');
const ANNOTATED_TEXT_ACTION_SDK_PATH = join(root, 'build', 'annotated-text-action-builder.mjs');
const ANNOTATED_TEXT_EDITOR_SDK_PATH = join(root, 'public', 'workbench-annotated-text-editor.mjs');
const ANNOTATED_TEXT_CONTINUOUS_SDK_PATH = join(root, 'public', 'workbench-annotated-text-continuous.mjs');

export function handleClientSdkRoute(
  app                                 ,
  req                  ,
  res                  ,
)          {
  if (req.method !== 'GET') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/workbench-annotated-text.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-text-edit.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(TEXT_EDIT_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-snapshot.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_SNAPSHOT_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-continuous.mjs') {
    if (!app || !app.db) return false;
    // Browser port of the blockless continuous family (issue #33). Its imports
    // already name the browser SDK paths (./workbench-annotated-text.mjs,
    // ./workbench-annotated-text-family.mjs), so no rewrite is needed.
    const body = readFileSync(ANNOTATED_TEXT_CONTINUOUS_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-snapshot-internal.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_SNAPSHOT_INTERNAL_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-redaction-coords.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_REDACTION_COORDS_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-action.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_ACTION_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-editor.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_EDITOR_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname !== '/workbench.mjs') return false;
  if (!app || !app.db) return false;
  let body        ;
  try {
    body = readFileSync(CLIENT_SDK_PATH);
  } catch {
    reject(res, 404, 'not found');
    return true;
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
  return true;
}

// ---------------------------------------------------------------------------
// Query / query-family / search HTTP routes (#312)
// ---------------------------------------------------------------------------
//
// Three framework-owned POST endpoints (intercepted before matchRoute, like
// /snapshot and /blobs) that expose the library query and search surfaces over
// HTTP:
//
//   POST /query/:entity           — an authorized query-scoped read page
//   POST /query-families/:name    — a registered query family page
//   POST /search                  — FTS / vector / hybrid search
//
// Authorization is the SAME engine as every other transport: the entity's
// default-on `read` route gate (requireUser unless the declaration names
// allowAnonymous), then the compiled row grant inside the query/search
// execution. There is no second auth path, and the request principal is already
// collapsed for admission by the transport.

// The per-entity read route gate (default-on requireUser). An allowAnonymous
// declaration relaxes only admission; the row grant still runs downstream.
function entityReadGate(entity            )                                  {
  const gate = (entity                                      ).gate?.read;
  return (typeof gate === 'function' ? gate : requireUser())                                   ;
}

// The standard page JSON. `count`/`filteredTotal` are omitted unless the
// request asked for `includeCount`; `total` unless it asked for `includeTotal`.
function queryPageBody(page           )                          {
  return {
    rows: page.rows,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    revision: page.revision,
    ...(page.count !== undefined ? { count: page.count, filteredTotal: page.filteredTotal } : {}),
    ...(page.total !== undefined ? { total: page.total } : {}),
  };
}

// Read a JSON object body, replying with the standard error envelope and
// returning null when the body is refused.
async function readJsonObjectBody(
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

// Compile the request contract against the mounted entity and execute it in one
// read snapshot. The body's pagination/count options are lifted out of the
// contract (compileQueryContract accepts only contract keys); an unknown
// property therefore surfaces as a 400 validation error, not a silent ignore.
function executeQueryScopedRead(
  db         ,
  entity            ,
  principal         ,
  body                         ,
)            {
  const queryEntity = entity                          ;
  const compiled = compileQueryContract({
    entity: entity.name,
    filters: body.filters         ,
    where: body.where         ,
    expression: body.expression         ,
    sort: body.sort         ,
    pageSize: body.pageSize         ,
  }, queryEntity);
  return executeQueryPage(db         , queryEntity, principal, compiled, {
    cursor: (body.cursor ?? null)         ,
    offset: body.offset                      ,
    maxOffset: body.maxOffset                      ,
    includeCount: body.includeCount === true,
    includeTotal: body.includeTotal === true,
    hydrate: body.hydrate                       ,
  });
}

// POST /query/:entity — an authorized query-scoped read page.
export async function handleQueryRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                              ,
)                   {
  if (req.method !== 'POST') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg[0] !== 'query' || seg.length !== 2) return false;
  if (!app || !app.entities || !app.db) { reject(res, 404, 'not found'); return true; }

  let entityName        ;
  try {
    entityName = decodeURIComponent(seg[1] );
  } catch {
    reject(res, 404, 'not found');
    return true;
  }
  // Case-sensitive lookup against the app's compiled entities.
  const entity = app.entities.get(entityName);
  if (!entity) { reject(res, 404, 'not found'); return true; }

  const admitted = collapseForAdmission(principal ?? anonymous);
  if (!entityReadGate(entity)(admitted)) { reject(res, 401, 'unauthorized'); return true; }

  const body = await readJsonObjectBody(req, res);
  if (body === null) return true;

  try {
    const page = executeQueryScopedRead(app.db, entity, admitted, body);
    sendJson(res, 200, queryPageBody(page));
  } catch (err) {
    if (err instanceof QueryScopedReadError) {
      reject(res, 400, err.message);
      return true;
    }
    throw err;
  }
  return true;
}

// POST /query-families/:name — a registered query family page. The host
// entity's read gate (falling back to requireUser) decides admission; the
// family's compiled host/catalog/element grants decide row visibility.
export async function handleQueryFamilyRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                              ,
)                   {
  if (req.method !== 'POST') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg[0] !== 'query-families' || seg.length !== 2) return false;
  if (!app || !app.db) { reject(res, 404, 'not found'); return true; }

  let familyName        ;
  try {
    familyName = decodeURIComponent(seg[1] );
  } catch {
    reject(res, 404, 'not found');
    return true;
  }
  const registry = (app                                           ).queryFamilies;
  const family = registry?.get(familyName);
  if (!registry || !family) { reject(res, 404, 'not found'); return true; }

  const admitted = collapseForAdmission(principal ?? anonymous);
  const hostGate = (family.host                                                 ).gate?.read;
  const gate = (typeof hostGate === 'function' ? hostGate : requireUser())                                   ;
  if (!gate(admitted)) { reject(res, 401, 'unauthorized'); return true; }

  const body = await readJsonObjectBody(req, res);
  if (body === null) return true;

  try {
    const page = registry.execute(familyName, app.db         , admitted, body);
    sendJson(res, 200, queryPageBody(page));
  } catch (err) {
    if (err instanceof QueryScopedReadError) {
      reject(res, 400, err.message);
      return true;
    }
    throw err;
  }
  return true;
}



function resolveSearchMode(body                         )                    {
  if (body.mode !== undefined) {
    return body.mode === 'fts' || body.mode === 'vector' || body.mode === 'hybrid' ? body.mode : null;
  }
  if (body.sources !== undefined && body.sources !== null && typeof body.sources === 'object') return 'hybrid';
  if (body.vector !== undefined) return 'vector';
  return 'fts';
}

// A vector query object. A `query` object wins verbatim (it may carry model,
// vector, scope, or scopeId); otherwise the flat `vector`/`model` fields form
// the plugin's `{ model, vector }` query shape.
function vectorQueryOf(body                         )                          {
  if (body.query !== undefined && body.query !== null && typeof body.query === 'object' && !Array.isArray(body.query)) {
    return body.query                           ;
  }
  const query                          = {};
  if (body.vector !== undefined) query.vector = body.vector;
  if (body.model !== undefined) query.model = body.model;
  return query;
}

function searchScope(body                         )                          {
  const scope                          = {};
  if (body.limit !== undefined) scope.limit = body.limit;
  if (body.scopeId !== undefined) scope.scopeId = body.scopeId;
  if (body.scope !== undefined) scope.scope = body.scope;
  return scope;
}

// POST /search — FTS5, Float32 vector, or hybrid RRF retrieval over the app's
// registered search registry. Fail closed: requireUser admission, unknown index
// → 404, malformed payload → 400. Results carry the registry-derived staleness
// stamp, never a plugin-supplied one.
export async function handleSearchRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                              ,
)                   {
  if (req.method !== 'POST') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/search') return false;
  if (!app) { reject(res, 404, 'not found'); return true; }

  const registry = (app                                                                             ).searchRegistry
    ?? (app                                            ).searchPlugins;
  if (!registry || (typeof (registry                  ).search !== 'function' && typeof (registry                  ).hybridSearch !== 'function')) {
    reject(res, 404, 'search is not engaged');
    return true;
  }

  const admitted = collapseForAdmission(principal ?? anonymous);
  if (!requireUser()(admitted         )) { reject(res, 401, 'unauthorized'); return true; }

  const body = await readJsonObjectBody(req, res);
  if (body === null) return true;

  const mode = resolveSearchMode(body);
  if (mode === null) { reject(res, 400, 'unknown search mode'); return true; }
  const registryHasIndex = (index         )          => {
    if (typeof index !== 'string' || index.length === 0) return false;
    const has = (registry                  ).has;
    return typeof has === 'function' ? has.call(registry, index) : true;
  };

  if (mode === 'hybrid') {
    const sources = (body.sources ?? {})                           ;
    const sourceId = (value         )                     => {
      if (typeof value === 'string' && value.length > 0) return value;
      if (value && typeof value === 'object') {
        const record = value                           ;
        if (typeof record.index === 'string') return record.index;
        if (typeof record.pluginId === 'string') return record.pluginId;
      }
      return undefined;
    };
    const ftsIndex = sourceId(sources.fts);
    const vectorIndex = sourceId(sources.vector);
    if (!ftsIndex || !vectorIndex) {
      reject(res, 400, 'hybrid search requires sources.fts and sources.vector');
      return true;
    }
    if (!registryHasIndex(ftsIndex) || !registryHasIndex(vectorIndex)) {
      reject(res, 404, 'unknown search index');
      return true;
    }
    const weights = (body.weights ?? {})                           ;
    const ftsSource = sources.fts                                       ;
    const vectorSource = sources.vector                                       ;
    const ftsQuery = ftsSource?.query ?? body.query;
    const vectorQuery = vectorSource?.query ?? vectorQueryOf(body);
    const shared = {
      principal: admitted,
      fts: {
        pluginId: ftsIndex,
        index: ftsIndex,
        query: ftsQuery,
        ...(weights.fts !== undefined ? { weight: weights.fts } : {}),
      },
      vector: {
        pluginId: vectorIndex,
        index: vectorIndex,
        query: vectorQuery,
        ...(weights.vector !== undefined ? { weight: weights.vector } : {}),
      },
      ...(body.k !== undefined ? { k: body.k } : {}),
      ...searchScope(body),
    };
    try {
      const result = typeof (registry                  ).hybridSearch === 'function'
        ? await (registry                  ).hybridSearch (shared)
        : await hybridSearch({ registry: registry                        , ...shared }         );
      sendJson(res, 200, {
        ok: result.ok,
        mode: 'hybrid',
        staleness: result.staleness,
        hits: result.hits ?? [],
        totalCandidates: result.totalCandidates,
        k: result.k,
        cancelled: result.cancelled === true,
        timedOut: result.timedOut === true,
      });
    } catch (err) {
      reject(res, 400, err instanceof Error ? err.message : 'invalid hybrid search request');
      return true;
    }
    return true;
  }

  const index = body.index;
  if (typeof index !== 'string' || index.length === 0) {
    reject(res, 400, 'index is required');
    return true;
  }
  if (!registryHasIndex(index)) { reject(res, 404, 'unknown search index'); return true; }

  const request = {
    query: mode === 'vector' ? vectorQueryOf(body) : body.query,
    principal: admitted,
    ...searchScope(body),
  };
  try {
    const outcome = await (registry                  ).search(index, request);
    if (!outcome.ok && !outcome.cancelled && !outcome.timedOut && outcome.lastError) {
      reject(res, 400, outcome.lastError.message ?? 'invalid search request');
      return true;
    }
    sendJson(res, 200, {
      ok: outcome.ok,
      mode,
      index,
      generation: outcome.generation,
      staleness: searchStalenessOf(outcome.state),
      hits: outcome.result?.hits ?? [],
      cancelled: outcome.cancelled === true,
      timedOut: outcome.timedOut === true,
      ...(outcome.lastError ? { error: outcome.lastError.message } : {}),
    });
  } catch (err) {
    reject(res, 400, err instanceof Error ? err.message : 'invalid search request');
    return true;
  }
  return true;
}
