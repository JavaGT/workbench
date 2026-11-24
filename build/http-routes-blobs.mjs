// Framework-owned blob upload and authorized blob media routes.

import { randomUUID } from 'node:crypto';



import { sendJson,                       } from './http-response.mjs';
import { sendFailure,               } from './http-failure.mjs';
import { rawRow } from './entity/query.mjs';

import { BodyError, readRawBody } from './http-body.mjs';
import { collapseForAdmission, anonymous,                } from './principal.mjs';
import { requireUser } from './route-gate.mjs';
import {
  createAuthorizationAdapter,



} from './authorization-adapter.mjs';
import { mayReadField } from './field-admission.mjs';
import { BlobTooLargeError } from './fs-blobs.mjs';
import { DEFAULT_BLOB_MAX_BYTES,                   } from './blob-store.mjs';
import { serveAuthorizedBlob } from './authorized-blob-read.mjs';
import { failure } from './outcome.mjs';
import {


  reject,
  routeAuthorization,
  firstHeaderString,
  requestBodyAsyncIterable,
  DEFAULT_QUERY_AUTHORIZATION,
  admitQueryGate,
} from './http-routes-shared.mjs';

// Framework-owned blob upload endpoint (spec #2, eng-review Walk 1b, #287). NOT
// a mounted route: `POST /blobs` streams the request body directly to the byte
// store's pending slot OUTSIDE the write coordinator (computing md5+sha256 on
// the way past and enforcing `maxBytes` mid-stream), then acquires the write
// coordinator ONLY for the sub-millisecond SQLite metadata INSERT, returning
// { id, md5, sha256, size, mime }. A rolled-back dispatch leaves it pending for
// the reaper. Route-gate fail-closed: anonymous → 401. Returns true when
// handled; false to fall through to matchRoute.




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
  // Route gate (requireUser) through the ONE authorization engine. A custom app
  // adapter owns route admission here exactly as it owns REST/query admission;
  // the identity check alone let an adapter-denied principal upload bytes. Keep
  // the id-less-shape refusal as gate INPUT validation (a malformed pre-#79
  // principal must never count as a user), then let the adapter decide.
  if (!principal || principal.id == null) {
    reject(res, 401, 'unauthorized');
    return true;
  }
  const uploadPrincipal = collapseForAdmission(principal);
  const uploadAuthorization = routeAuthorization(app) ?? DEFAULT_QUERY_AUTHORIZATION;
  if (!await admitQueryGate(uploadAuthorization, requireUser(), uploadPrincipal)) {
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
  // capability admission (`.can` / `inherit(...)` / field access) using AND.
  // A custom `blob` policy on the app adapter is an ADDITIONAL restriction, not
  // an override: an explicit denial wins immediately, but an admitted decision
  // still has to pass the compiled scopeFilter and mayReadField below. Returning
  // an `admitted:true` custom decision directly was a read-bypass seam.
  const routeBlobAuthorize                       = {
    registerResource: (input) => entityBlobAdapter.registerResource(input),
    admit: async (input) => {
      if (input.category !== 'blob') return entityBlobAdapter.admit(input);
      if (appAuthz) {
        const customByField = await appAuthz.admit({ ...input, resourceName: fieldName });
        if (customByField.reasonCode !== 'no-resource' && !customByField.admitted) return customByField;
        const customByQualified = customByField.reasonCode === 'no-resource'
          ? await appAuthz.admit({ ...input, resourceName })
          : null;
        if (customByQualified && customByQualified.reasonCode !== 'no-resource' && !customByQualified.admitted) {
          return customByQualified;
        }
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
