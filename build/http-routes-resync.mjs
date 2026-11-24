// Framework-owned snapshot / resync routes. Auth runs through the SAME engine
// as REST (mayVerb / mayRow / readScope), never a second path.


import { readScopedRow, authorizeRow,                 } from './http-crud-dispatch.mjs';
import { rawRow } from './entity/query.mjs';
import { readSeq, readSince, minSeqForScope, decodeLogRowData } from './committed-log.mjs';

import { scopeOf, tryParseScopeKey } from './scope-handle.mjs';
import { createdTextReducerSeeds, textReducerCheckpoints } from './text-reducer-transport.mjs';

import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';

import { sendJson,                       } from './http-response.mjs';
import { publicEvent } from './event-delivery.mjs';
import { parseEventType } from './event-handle.mjs';
import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';
import { hasAnnotatedTextFields, projectEntitySnapshot } from './entity-snapshot-projection.mjs';
import { projectRowForRecipient } from './entity/projection.mjs';
import { readableFieldNames } from './field-admission.mjs';
import { handleBlobReadRoute } from './http-routes-blobs.mjs';
import {



  reject,
  routeAuthorization,
} from './http-routes-shared.mjs';

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
