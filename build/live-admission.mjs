// Subscribe-time admission: validate the subscribe message, bind read scope,
// run 'subscribe' authorization (through the injected authorization adapter
// when one is wired, else the framework row-grant), and return an admission
// decision.
//
// Pure authorization logic — no socket I/O, no subscription side effects.
// The caller applies the subscribe confirmation (addSubscription + send).
//
// Exported for use by live-connection.mjs only.


import { anonymous } from './principal.mjs';
import { mayRow } from './row-grant.mjs';

import { validatePaceSelection } from './field-pace.mjs';

import { scopeOf, tryParseScopeKey } from './scope-handle.mjs';
import { failure } from './outcome.mjs';

import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';

import { compileSubscriptionRule } from './subscription-rule.mjs';


const MAX_SUBS_PER_CONN = 256;
const MAX_COLLECTION_SUBS_PER_CONN = 32;
const MAX_ID_LEN = 256;

function hasAnnotatedText(entity                  )          {
  return Object.values(entity.fields ?? {}).some((field) => field?.kind === 'annotatedText');
}






export function parseSubscribeMsg(msg         )                             {
  if (typeof msg !== 'object' || msg === null) return null;
  const message = msg                           ;

  if (typeof message.scope === 'string' && (message.scope          ).length > 0) {
    const scope = message.scope          ;
    const hasExplicitInterest = message.interest && typeof message.interest === 'object' && !Array.isArray(message.interest);
    const interest                          = hasExplicitInterest ? { ...(message.interest                           ) } : {};

    if (!hasExplicitInterest) {
      const handle = tryParseScopeKey(scope);
      if (handle) {
        interest.entity = handle.entity;
        interest.id = handle.id;
      } else if (message.rule !== undefined || message.collectionRule !== undefined) {
        // A bare entity scope is collection identity (#102). It is only accepted
        // with a declarative rule; generic scope subscriptions remain disabled.
        interest.entity = scope;
        interest.rule = message.rule ?? message.collectionRule;
      }
    }

    if (interest.fields !== undefined && interest.fields !== null) {
      if (typeof interest.fields !== 'object' || interest.fields === null || Array.isArray(interest.fields) || typeof interest.fields === 'function') {
        interest.fields = null;
      } else {
        for (const [, value] of Object.entries(interest.fields)) {
          if (typeof value === 'function') { interest.fields = null; break; }
        }
      }
    }

    return { scope, interest };
  }

  if (typeof message.entity === 'string' && message.id !== undefined) {
    const handle = scopeOf(message.entity, message.id);
    const interest                          = { entity: handle.entity, id: handle.id };
    if (message.fields !== undefined && message.fields !== null) interest.fields = message.fields;
    if (message.pace !== undefined && message.pace !== null) interest.pace = message.pace;
    if (message.carets !== undefined && message.carets !== null) interest.carets = message.carets;
    return { scope: handle.key, interest };
  }

  return null;
}

// Validate interest fields and pace against the resolved entity schema.
// Returns { fields, pace } or throws on invalid input.
function buildInterest(interest                         , entity                  )                                                                                             {
  let fields                              = null;
  if (interest.fields !== undefined && interest.fields !== null) {
    if (typeof interest.fields !== 'object' || interest.fields === null || Array.isArray(interest.fields)) {
      throw new Error('Invalid fields interest.');
    }
    if (typeof interest.fields === 'function') {
      throw new Error('Fields interest must be data, not a closure.');
    }
    for (const [key, value] of Object.entries(interest.fields)) {
      if (typeof value === 'function') {
        throw new Error('Fields interest must be data, not a closure.');
      }
      if (!entity.fields || !(key in entity.fields)) {
        // Inference prevention (S5/A3): never distinguish an existing-but-absent
        // from a genuinely-unknown field name in the failure — a field name in
        // the error would let a principal probe which fields exist.
        throw new Error('Unknown field in interest.');
      }
      if (hasAnnotatedText(entity) && entity.fields[key]?.kind === 'ephemeral') {
        throw new Error('Ephemeral interest is unavailable for annotated-text entities.');
      }
      if (value !== true) {
        throw new Error('Coordinate narrowing is not supported.');
      }
    }
    fields = interest.fields                        ;
  }

  let pace                     = null;
  if (interest.pace !== undefined && interest.pace !== null) {
    pace = validatePaceSelection('ephemeral', interest.pace                                         );
  }

  let carets                  = null;
  if (interest.carets !== undefined && interest.carets !== null) {
    const candidate = interest.carets            ;
    if (!Array.isArray(candidate) || candidate.length > 16 || new Set(candidate).size !== candidate.length) {
      throw new Error('Invalid annotated-text caret interest.');
    }
    for (const field of candidate) {
      if (typeof field !== 'string' || entity.fields?.[field]?.kind !== 'annotatedText') {
        throw new Error('Invalid annotated-text caret interest.');
      }
      const descriptor = entity.fields?.[field];
      if (!getAnnotatedTextCompiledMetadata(descriptor)?.caret) {
        throw new Error('Invalid annotated-text caret interest.');
      }
    }
    carets = candidate;
  }

  return { fields, pace, carets };
}















export async function authorizeSubscription(
  msg         ,
  conn          ,
  {
    resolveEntity,
    mayVerb,
    authorization,
    db,
    fanout,
  }





   ,
)                                 {
  const normalized = parseSubscribeMsg(msg);
  if (!normalized) {
    return { admitted: false, failure: failure('invalid-input', 'Subscribe requires entity and id, or a scope.') };
  }

  const { scope, interest } = normalized;
  const entityName = interest.entity;
  const id = interest.id;
  const collectionRule = interest.rule ?? interest.collectionRule;

  if (typeof entityName !== 'string' || (id === undefined && collectionRule === undefined)) {
    return { admitted: false, failure: failure('invalid-input', 'Scope-level subscriptions are not configured; use entity and id.') };
  }

  const isCollection = id === undefined;
  if (isCollection && scope !== entityName) {
    return { admitted: false, failure: failure('invalid-input', 'Collection scope must be its resource kind.') };
  }

  const idStr = isCollection ? '' : String(id);
  if (idStr.length > MAX_ID_LEN) {
    return { admitted: false, failure: failure('invalid-input', 'Subscribe id is too long.') };
  }
  if (!isCollection && fanout.subscriptionCount(conn) >= MAX_SUBS_PER_CONN && !fanout.hasSubscription(conn, entityName, idStr)) {
    return { admitted: false, failure: failure('conflict', 'Too many subscriptions are active.') };
  }
  const collectionCount = fanout.collectionSubscriptionCount(conn);
  // A collection scope already held is a REPLACE, not a new subscription — the
  // entity path already exempts same-scope replacement from its cap (above) and
  // fan-out replaces in place. Direct-WS clients must not be forced to
  // unsubscribe first just to refresh a rule at the cap (#253).
  if (isCollection && collectionCount >= MAX_COLLECTION_SUBS_PER_CONN && !fanout.hasSubscription(conn, scope)) {
    return { admitted: false, failure: failure('conflict', 'Too many collection subscriptions are active.') };
  }
  if (!resolveEntity || !mayVerb || !db) {
    throw new Error('Live subscription admission dependencies are unavailable.');
  }
  const entity = resolveEntity(entityName);
  if (!entity) {
    return { admitted: false, failure: failure('denied', 'Forbidden.') };
  }

  const principal            = conn.principal ?? anonymous;
  const { sql: where, params: scopeParams } = entity.scopeFilter(principal);
  const row = isCollection
    ? db.prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} LIMIT 1`).get(scopeParams)
    : db.prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} AND t0.id = :id`).get({ ...scopeParams, id: idStr });
  // An empty collection is still a valid, scope-authorized subscription. A row
  // that exists but falls outside the scope filter is indistinguishable from it.
  if (!row && !isCollection) return { admitted: false, failure: failure('denied', 'Forbidden.') };
  {
    const hydrated = row && (entity.hydrate ? entity.hydrate(row, principal) : row);
    // Subscribe admission runs through the injected authorization adapter
    // (S5/A2) when one is wired — the SAME seam REST dispatch and the route
    // gate consult — so an app policy adapter owns live admission too (the
    // ticket's single-path requirement). Without an adapter the framework
    // row-grant runs, unchanged.
    const allowed = !hydrated || (authorization
      ? (await authorization.admit({
          category: 'entity',
          verb: 'subscribe',
          operation: 'subscribe',
          principal,
          entity: entity         ,
          row: hydrated,
          resourceId: idStr,
        })).admitted
      : await mayRow(entity         , 'subscribe', hydrated, principal, mayVerb         ));
    if (!allowed) {
      return { admitted: false, failure: failure('denied', 'Forbidden.') };
    }
  }

  // Entity-specific validation happens only after row authorization. Otherwise
  // different validation errors reveal which entity names and fields exist.
  let fields                             ;
  let pace                    ;
  let carets                 ;
  try {
    if (isCollection) {
      // Compile during registration, never on a later refresh. This is both the
      // SQL injection boundary and the no-JS-filter fallback guarantee.
      const compiled                           = compileSubscriptionRule(collectionRule, entity);
      interest.rule = compiled;
    }
    ({ fields, pace, carets } = buildInterest(interest, entity));
  } catch (err) {
    return { admitted: false, failure: failure('invalid-input', (err                        ).message || 'Invalid fields or pace selection.') };
  }

  return { admitted: true, scope, entityName, id, idStr, fields, pace, carets, interest };
}

export const normalizeSubscribeMsg = parseSubscribeMsg;
