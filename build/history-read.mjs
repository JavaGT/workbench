import { parseEventType } from './event-handle.mjs';
import { rowToEvent,                                } from './committed-log.mjs';
import { mayRow, mayVerb as rowGrantMayVerb,                                           } from './row-grant.mjs';
import { tryParseScopeKey,                  } from './scope-handle.mjs';
import { publicEvent } from './event-delivery.mjs';

// scope#992 rev 3 §3: the legacy annotated read-privacy scanner is imported
// ONLY here (the history actions()/events() read boundary) and used ONLY from
// the authorize step. Movement code must not import it.
import { assertLegacyAnnotatedHistoryReadable } from './legacy-annotated-history-read-privacy.mjs';
import { forbidden } from './outcome.mjs';




























































function reauthFor(
  entityRec                     ,
  principal                        ,
  handle             ,
  db          ,
  scopeVisible                   ,
)                                          {
  try {
    if (!scopeVisible({ entity: entityRec, principal, scope: handle })) return null;
    const { sql: where, params: scopeParams } = entityRec.scopeFilter(principal);
    const raw = db.prepare(`SELECT * FROM ${entityRec.name} AS t0 WHERE ${where} AND t0.id = :id`).get({ ...scopeParams, id: handle.id });
    if (!raw) return null;
    if ('hydrate' in entityRec && typeof entityRec.hydrate !== 'function') return null;
    const row = typeof entityRec.hydrate === 'function' ? entityRec.hydrate(raw, principal) : raw;
    if (row === null || row === undefined) return null;
    return { row };
  } catch {
    return null;
  }
}

export function createHistoryReader({
  db,
  entities,
  mayVerb = null,
  privateHistoryScopes = null,
  projectRecipient,
  scopeVisible = () => true,
}






 )                {
  if (!db) throw new Error('history reader requires a database');
  if (!entities) throw new Error('history reader requires an entity registry');
  const database = db;
  // Authorization defaults to the framework row-grant engine — the same engine
  // the live-delivery and REST paths use. Apps may still inject their own
  // mayVerb (e.g. to customize authorization for a transport).
  const authorizeVerb                = typeof mayVerb === 'function' ? mayVerb : (entity, verb, row, principal) => rowGrantMayVerb(entity, verb, row, principal);

  const resolveEntity = typeof entities === 'function' ? entities : (name        ) => entities.get(name);
  const denyScopes = privateHistoryScopes ?? new Set        ();

  async function authorize(scope        , principal                        )                                                                            {
    // scope#992 rev 3 §3: the legacy annotated read-privacy scanner is the
    // ONLY annotated denial here; it returns void or throws forbidden(). It
    // has no eligibility/barrier/target/retry/compensation role.
    assertLegacyAnnotatedHistoryReadable(database, scope, denyScopes);
    const handle = tryParseScopeKey(scope);
    if (!handle) throw forbidden('history.forbidden', 'history.forbidden');
    const entityRec = resolveEntity(handle.entity);
    if (!entityRec) throw forbidden('history.forbidden', 'history.forbidden');
    const auth = reauthFor(entityRec, principal, handle, database, scopeVisible);
    if (!auth) throw forbidden('history.forbidden', 'history.forbidden');
    if (!(await mayRow(entityRec, 'subscribe', auth.row, principal, authorizeVerb))) {
      throw forbidden('history.forbidden', 'history.forbidden');
    }
    return { entityRec, row: auth.row };
  }

  async function readCommittedHistory({ scope, principal, sinceSeq = 0, limit = 100 }                     = {})                             {
    if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('scope is required');
    if (!principal || principal.id == null) throw forbidden('history.forbidden', 'history.forbidden');
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) throw new TypeError('sinceSeq must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    // Receipt reads need no projector; history reads do. Require it here so a
    // reader can be constructed for readReceipt alone without an app projector.
    if (typeof projectRecipient !== 'function') throw new Error('history reader requires a projectRecipient function to read committed history');

    const { entityRec, row } = await authorize(scope, principal);

    const effectiveLimit = limit + 1;
    const rows = database.prepare(
      'SELECT * FROM _Log WHERE scope = :scope AND seq > :sinceSeq ORDER BY seq LIMIT :limit',
    ).all({ scope, sinceSeq, limit: effectiveLimit });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const events = rows.map((logRow) => rowToEvent(logRow                         , parseEventType));
    const projected            = [];
    for (const event of events) {
      const safe = publicEvent(event);
      const ctx = Object.freeze({
        entity: entityRec,
        event: Object.freeze({ ...safe }),
        principal,
        row,
        scope,
      });
      const result = projectRecipient(ctx);
      if (!Array.isArray(result)) {
        throw new Error(`projectRecipient must return an array for scope '${scope}' seq ${event.seq}`);
      }
      projected.push(...result);
    }

    return { events: Object.freeze(projected), hasMore };
  }

  async function readReceipt({ scope, actionId, principal }                       )                                 {
    if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('scope is required');
    if (typeof actionId !== 'string' || actionId.length === 0) throw new TypeError('actionId is required');
    if (!principal || principal.id == null) throw forbidden('history.forbidden', 'history.forbidden');

    await authorize(scope, principal);

    const row = database.prepare(
      'SELECT scope, actionId, committedAt, eventRefs, actionType, operation FROM _ActionReceipt WHERE scope = :scope AND actionId = :actionId',
    ).get({ scope, actionId })                                                                                                                                         ;

    if (!row) return null;

    return {
      scope: row.scope,
      actionId: row.actionId,
      committedAt: row.committedAt,
      eventRefs: JSON.parse(row.eventRefs),
      actionType: row.actionType,
      operation: row.operation,
    };
  }

  return Object.freeze({ readCommittedHistory, readReceipt });
}
