// Live fan-out core — scope-keyed subscription registry, delivery-time
// re-authorization, pace buffers, and event delivery.
//
// W5 slice 2: registry is keyed by scope string (e.g. "Entity:id" for
// per-entity, "project:p1" for coarse). The old entity→id→conn map
// is retired — per-entity is a degenerate scope, not a separate path.
//
// W3 slice 2: a foreign-entity event (e.g. a Job event) may ride the ANCHOR
// row's own scope stream (e.g. "Project:p1") when its committedEvent.scope
// equals that anchor's Scope handle key — authz is re-checked against the
// anchor row, never against the foreign entity. Any other entity mismatch
// is still dropped (guards caller bugs on the per-entity path).
//
// This module also owns the shared live-delivery type vocabulary (entity
// records, connections, database, fan-out handles) that the admission,
// connection, core, and public delivery modules all consume.


import { anonymous, principalKeyOf } from './principal.mjs';
import { mayRow } from './row-grant.mjs';
import { PACE_STRATEGIES } from './field-pace.mjs';

import { createDeltaProjector } from './field-delta.mjs';
import { EventKind, parseEventType } from './event-handle.mjs';

import { scopeOf, tryParseScopeKey } from './scope-handle.mjs';

import { createdTextReducerSeeds } from './text-reducer-transport.mjs';
import { publicEvent } from './event-delivery.mjs';

import { readableFieldNames } from './field-admission.mjs';
import { projectRowForRecipient } from './entity/projection.mjs';

// ---- Shared live-delivery type vocabulary ---------------------------------







/** The subset of a compiled entity record the live-delivery seams rely on. */

















// A row read from the SQLite layer. The optional lastSeq keeps the shape
// compatible with cursor.ts's narrow CursorDatabase contract.















/** Structural connection contract — the LiveConnection class satisfies it. */














// ---- Revocation contract (S5/A5, spec item 4) ------------------------------
//
// `resourceScope` is the NORMALIZED revocation descriptor (category + stable
// key) that subscribers and S4/S6 registrations key on:
//
//   - { category: 'entity', key: 'Note:n1' }   — a resource's access revoked;
//     matches live subscriptions on that exact scope key.
//   - { category: 'principal', key: 'user:u1' } — a principal's access revoked;
//     matches every live subscription whose principal key equals the key.
//
// PUBLISHER: revoke() is the single publish surface. The package calls it from
// the mutation/admission paths where a grant is revoked — a committed deletion
// (terminal removal) and delivery-time reauthorization denial (live-delivery-core),
// plus an app's explicit revocation from a mutation handler (membership removal,
// principal status change) — firing the registered listeners exactly once per
// call and immediately re-authorizing the affected subscriptions (event-driven —
// no wait for the next event batch). The descriptor is normalized/validated at
// the seam (normalizeRevocationScope): a malformed descriptor is rejected
// deterministically (RevocationScopeError) before any listener or registry is
// touched.
//
// BOOTSTRAP: bootstrap/catchup always re-authorize against current state
// BEFORE first delivery, so a subscription registered AFTER a revocation still
// receives the revoked state on first delivery — there is no window where a
// revoked reader keeps a live feed.






// Deterministic rejection for a malformed revocation descriptor at the publish
// seam (revoke()). A listener can never observe an ambiguous descriptor it
// would half-match.
export class RevocationScopeError extends Error {
  constructor(message        ) {
    super(message);
    this.name = 'RevocationScopeError';
  }
}

// Normalize + validate a revocation descriptor at the publish seam. Fail closed:
// an unknown category, a non-string/empty key, an entity key that is not valid
// scope syntax (Entity:id), or a principal key that is not the CANONICAL
// principal key of the published principal is rejected deterministically. Both
// the core and the fan-out route every published revocation through this, so the
// two registries agree on exactly which descriptor a key names.
export function normalizeRevocationScope(principal                              , input         )                          {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RevocationScopeError('revoke: resourceScope must be a { category, key } descriptor');
  }
  const { category, key } = input                                         ;
  if (category !== 'entity' && category !== 'principal') {
    throw new RevocationScopeError(`revoke: resourceScope.category must be 'entity' or 'principal' (got '${String(category)}')`);
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new RevocationScopeError('revoke: resourceScope.key must be a non-empty string');
  }
  if (category === 'entity') {
    if (!tryParseScopeKey(key)) {
      throw new RevocationScopeError(`revoke: entity resourceScope.key '${key}' is not valid scope syntax (expected Entity:id)`);
    }
    return { category, key };
  }
  // principal category: the key must be the canonical key of the published
  // principal — a revocation never names an identity the caller did not publish
  // under (an anonymous principal has no key and can never be revoked).
  const canonical = principalKeyOf(principal);
  if (canonical === null || canonical !== key) {
    throw new RevocationScopeError(`revoke: principal resourceScope.key '${key}' is not the canonical key of the published principal (expected '${canonical}')`);
  }
  return { category, key };
}














































// ---- Live fan-out -----------------------------------------------------------

function hasAnnotatedText(entityRecord                  )          {
  return Object.values(entityRecord.fields ?? {}).some((field) => field?.kind === 'annotatedText');
}

// S5/A3 field-read admission on the fan-out path. The committed lifecycle
// payload is projected to the recipient's readable declared field subset
// (projectRowForRecipient — unreadable fields are omitted, an unreadable
// annotated-text field redacts to its explicit placeholder), so an unreadable
// or undeclared field never reaches a subscriber. Native and field-set events
// carry ONE field's operation payload and are gated at the field level by the
// caller (an unreadable field resyncs instead); removed events pass their
// identity payload through untouched.
async function projectRecipientEventData(
  entityRecord                  ,
  committed                      ,
  handle                     ,
  principal           ,
  readableFields                                 ,
  authorization                             ,
)                                               {
  const data = committed.data;
  if (readableFields === undefined) return data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (handle.kind === EventKind.native || handle.kind === EventKind.fieldSet || handle.kind === EventKind.removed) return data;
  return projectRowForRecipient(entityRecord         , data, principal, { readable: readableFields, authorization });
}

// A scope-anchored foreign event (e.g. a _Job.updated riding the anchor's own
// scope stream) carries the FOREIGN entity's payload. Field-read admission is
// computable at this seam only for the anchor row, so a foreign payload field
// is provably readable only when it is a declared readable field of the anchor.
// Matching the committed envelope path's foreign-entity behavior, a payload
// with any field that cannot be proven readable never crosses live delivery —
// the recipient receives an opaque snapshot requirement (resync) instead.
// Returns `undefined` when the payload cannot be safely gated.
async function projectScopeAnchoredRecipientData(
  entityRecord                  ,
  committed                      ,
  principal           ,
  readableFields                                 ,
  authorization                             ,
)                                               {
  const data = committed.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  for (const key of Object.keys(data)) {
    if (key === 'id') continue;
    if (readableFields === undefined || !readableFields.has(key)) return undefined;
  }
  return projectRowForRecipient(entityRecord         , data, principal, { readable: readableFields, authorization });
}

// The recipient's slice of a shared delta. The projector keeps ONE raw baseline
// per scope shared across subscribers; a per-subscriber delta is the shared diff
// filtered to the readable field set — identical to diffing each projected row,
// without corrupting the shared baseline for the other subscribers.
function filterDeltaForRecipient(delta                         , readableFields                     )                          {
  const filtered                          = {};
  for (const [field, value] of Object.entries(delta)) {
    if (readableFields.has(field)) filtered[field] = value;
  }
  return filtered;
}

export function createLiveFanout({ mayVerb = null, authorization = null }                                                                            = {})                   {
  const byScope = new Map                                             (); // Map<scopeKey, Map<conn, SubSpec>>
  const connSubs = new Map                       ();  // Map<conn, Set<scopeKey>>
  const paceBuffers = new Map                         ();
  const annotatedTextByEntity = new WeakMap                 ();
  // One pending snapshot-control per (connection, document) per event-loop turn.
  // Later controls only raise the high-water sequence; the flush emits one message.
  const pendingSnapshotControls = new Map





    ();
  let snapshotControlFlushScheduled = false;
  let snapshotControlFlushTimer                                         = null;
  let onCaretInterestChange                                                                            = null;
  let onCaretInterestAdded                                                                          = null;
  const revocationListeners                       = [];

  function snapshotControlKey(conn          , entity        , id         )         {
    return `${conn.id}\u0000${entity}\u0000${String(id)}`;
  }

  function flushPendingSnapshotControls()       {
    snapshotControlFlushScheduled = false;
    snapshotControlFlushTimer = null;
    for (const pending of pendingSnapshotControls.values()) {
      if (pending.conn.closed) continue;
      pending.conn.send({
        type: 'resync',
        entity: pending.entity,
        id: pending.id,
        seq: pending.seq,
        reason: pending.reason,
      });
    }
    pendingSnapshotControls.clear();
  }

  function queueSnapshotControl(conn          , entity        , id         , seq        , reason        )       {
    const key = snapshotControlKey(conn, entity, id);
    const existing = pendingSnapshotControls.get(key);
    if (!existing) {
      pendingSnapshotControls.set(key, { conn, entity, id, seq, reason });
    } else if (seq > existing.seq) {
      existing.seq = seq;
      existing.reason = reason;
    }
    if (!snapshotControlFlushScheduled) {
      snapshotControlFlushScheduled = true;
      snapshotControlFlushTimer = setImmediate(flushPendingSnapshotControls);
    }
  }

  const deltaProjector = createDeltaProjector();

  function subscriptionCount(conn          )         {
    return connSubs.get(conn)?.size ?? 0;
  }

  function collectionSubscriptionCount(conn          )         {
    return [...(connSubs.get(conn) ?? [])]
      .filter((scope) => Boolean(byScope.get(scope)?.get(conn)?.interest?.rule)).length;
  }

  // hasSubscription(conn, scopeOrEntity, id?) — two-arg form checks by scope
  // key; three-arg form derives the key via Scope handle.
  function hasSubscription(conn          , scopeOrEntity        , id          )          {
    if (arguments.length >= 3) {
      return connSubs.get(conn)?.has(scopeOf(scopeOrEntity, id).key) ?? false;
    }
    return connSubs.get(conn)?.has(scopeOrEntity) ?? false;
  }

  function addSubscription(a                                         , b          , c                                          = null, d                                 = null, e                                 = null)       {
    // The legacy positional form is (entity, id, conn, fields, pace): the same
    // `e` slot carries interest for scope-keyed calls and pace for legacy calls.
    if (typeof a === 'string' && (a.includes(':') || e?.rule)) {
      addSubscriptionScope(a, b, c, d, e ?? {});
      return;
    }
    if (a && (a                       ).brand === 'scope-handle') {
      addSubscriptionScope((a               ).key, b, c, d, e ?? {});
      return;
    }
    addSubscriptionLegacy(
      a          ,
      b           ,
      c                       ,
      d                                           ,
      e                                  ,
    );
  }

  function addSubscriptionScope(scope        , conn          , fields                              = null, pace                     = null, interest                          = {})       {
    let scopeSubs = byScope.get(scope);
    if (!scopeSubs) {
      scopeSubs = new Map();
      byScope.set(scope, scopeSubs);
    }
    const previous = scopeSubs.get(conn);
    if (interest.rule && !previous?.interest?.rule && collectionSubscriptionCount(conn) >= 32) {
      throw new Error('Collection subscription limit exceeded.');
    }
    const nextCarets = (interest.carets                        ) ?? [];
    const previousCarets = (previous?.interest?.carets                        ) ?? [];
    const removedCarets = previousCarets.filter((field) => !nextCarets.includes(field));
    if (removedCarets.length > 0) onCaretInterestChange?.(conn, scope, removedCarets);
    scopeSubs.set(conn, { fields, latch: true, pace, interest });
    // A late-joining caret subscriber must learn the CURRENT presence state for
    // the fields it now cares about; the caret module replays existing slots.
    const addedCarets = nextCarets.filter((field) => !previousCarets.includes(field));
    if (addedCarets.length > 0) onCaretInterestAdded?.(conn, scope, addedCarets);
    let mine = connSubs.get(conn);
    if (!mine) { mine = new Set(); connSubs.set(conn, mine); }
    mine.add(scope);
  }

  function addSubscriptionLegacy(entity        , id         , conn          , fields                                          = null, pace                                 = null)       {
    const handle = scopeOf(entity, id);
    addSubscriptionScope(handle.key, conn, fields, pace, { entity: handle.entity, id: handle.id });
  }

  function removeSubscription(a                                         , b          , c          )       {
    if (typeof a === 'string' && (a.includes(':') || c === undefined)) {
      removeSubscriptionScope(a, b);
      return;
    }
    if (a && (a                       ).brand === 'scope-handle') {
      removeSubscriptionScope((a               ).key, b);
      return;
    }
    removeSubscriptionLegacy(a          , b           , c                       );
  }

  function removeSubscriptionScope(scope        , conn          )       {
    const subs = byScope.get(scope);
    if (subs) {
      const removedCarets = (subs.get(conn)?.interest?.carets                        ) ?? [];
      if (removedCarets.length > 0) onCaretInterestChange?.(conn, scope, removedCarets);
      subs.delete(conn);
      if (subs.size === 0) byScope.delete(scope);
    }
    const mine = connSubs.get(conn);
    if (mine) {
      mine.delete(scope);
      if (mine.size === 0) connSubs.delete(conn);
    }
    // A paced ephemeral buffer must not outlive its subscription: events
    // buffered for (conn, scope) are dropped on removal, so a removed
    // subscriber never receives cells drained after unsubscribe.
    for (const [bufKey, entry] of paceBuffers) {
      if (entry.conn === conn && entry.scope === scope) {
        if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
        paceBuffers.delete(bufKey);
      }
    }
  }

  function removeSubscriptionLegacy(entity        , id         , conn          )       {
    removeSubscriptionScope(scopeOf(entity, id).key, conn);
  }

  function removeAll(conn          )       {
    const mine = connSubs.get(conn);
    if (!mine) return;
    for (const scope of mine) {
      const subs = byScope.get(scope);
      if (subs) {
        const removedCarets = (subs.get(conn)?.interest?.carets                        ) ?? [];
        if (removedCarets.length > 0) onCaretInterestChange?.(conn, scope, removedCarets);
        subs.delete(conn);
        if (subs.size === 0) byScope.delete(scope);
      }
    }
    connSubs.delete(conn);

    for (const [bufKey, entry] of paceBuffers) {
      if (entry.conn === conn) {
        if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
        paceBuffers.delete(bufKey);
      }
    }

  }

  function recipients(scope        , field        )                                          {
    return [...(byScope.get(scope) ?? [])]
      .filter(([conn, spec]) => !conn.closed && ((spec.interest?.carets                        )?.includes(field) ?? false));
  }

  function hasCaretInterest(conn          , scope        , field        )          {
    return ((byScope.get(scope)?.get(conn)?.interest?.carets                        )?.includes(field)) ?? false;
  }

  function setOnCaretInterestChange(callback                                                                           )       {
    onCaretInterestChange = callback;
  }

  function setOnCaretInterestAdded(callback                                                                         )       {
    onCaretInterestAdded = callback;
  }

  function onRevocation(listener                    )             {
    revocationListeners.push(listener);
    return () => {
      const idx = revocationListeners.indexOf(listener);
      if (idx !== -1) revocationListeners.splice(idx, 1);
    };
  }

  // Publish a revocation. Fires the registered listeners exactly once (isolated
  // per listener) and immediately evicts the affected subscriptions from the
  // fan-out registry — matching by scope key (entity scope) or principal key
  // (principal scope) — so a revoked reader receives nothing further. This is
  // the event-driven counterpart to the core's committed revocation path: the
  // fan-out no longer waits for the next emit to re-authorize a revoked reader.
  // The descriptor is normalized/validated first (findings #75-4): a malformed
  // descriptor throws RevocationScopeError before any listener or registry is
  // touched.
  function revoke(principal           , resourceScope                         )       {
    const normalized = normalizeRevocationScope(principal, resourceScope);
    for (const listener of revocationListeners) {
      try { listener(principal, normalized); } catch { /* per-listener isolation */ }
    }
    if (normalized.category === 'entity') {
      const subs = byScope.get(normalized.key);
      if (subs) {
        for (const conn of [...subs.keys()]) removeSubscription(normalized.key, conn);
      }
      return;
    }
    for (const conn of [...connSubs.keys()]) {
      if (conn.closed) continue;
      if (principalKeyOf(conn.principal) === normalized.key) removeAll(conn);
    }
  }

  async function flushPacedBuffer(key        )                {
    const entry = paceBuffers.get(key);
    if (!entry) return;
    const { conn, scope, events, entityRecord, authzRow } = entry;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    paceBuffers.delete(key);
    if (events.length === 0) return;
    if (conn.closed) return;
    // Drain-time liveness: a pace buffer is only drained to a subscription that
    // still exists. Removal clears the buffer directly, but this second check
    // keeps any surviving buffer from delivering to a removed subscriber.
    if (!byScope.get(scope)?.has(conn)) return;

    if (!(await mayRow(entityRecord         , 'subscribe', authzRow, conn.principal ?? anonymous, mayVerb         ))) return;

    // Field-read admission (S5/A3), re-checked at flush time — admission can
    // change between emit and flush, mirroring the mayRow re-check above. An
    // ephemeral field the principal cannot read is never drained to them.
    if (entry.field !== null) {
      const readableFields = await readableFieldNames(entityRecord         , authzRow, conn.principal ?? anonymous, authorization);
      if (!readableFields.has(entry.field)) return;
    }

    const kind = PACE_STRATEGIES.ephemeral;
    const coalescer = entry.by ? kind.coalescers[entry.by] : null;
    const coalesced = coalescer ? events.reduce(coalescer) : events[events.length - 1];
    const reduceSpan = kind.reduceSpan;
    if (!reduceSpan) return;
    const span = reduceSpan(events                                                      );
    const handle = tryParseScopeKey(scope);
    const entityName = handle?.entity ?? scope;
    const idStr = handle?.id ?? scope;
    conn.send({
      type: 'event', entity: entityName, id: idStr,
      seq: span.seq, seqSpan: span.seqSpan, event: publicEvent(coalesced                                     ),
    });
  }

  // Fan-out: forward a committed kernel event to authorized subscribers
  // of the event's scope. One registry, one fan-out path.
  async function emit(entityRecord                  , id         , row                                     , committedEvent                      , { hydrated = false }                         = {})                {
    const name = entityRecord?.name;
    if (!name) return;
    let committed                       = committedEvent;
    if (committed.handle?.brand !== 'event-handle') {
      try {
        committed = { ...committedEvent };
        Object.defineProperty(committed, 'handle', { value: parseEventType(committedEvent.type), enumerable: false });
        Object.freeze(committed);
      } catch { return; }
    }
    const handle = committed.handle                       ;
    // Derive the anchor scope once. Besides avoiding duplicate Scope-handle
    // construction, doing the registry lookup before row hydration/delta work
    // makes an event with no subscribers a cheap no-op.
    const directScope = scopeOf(name, id).key;
    const eventScope = committed.scope ?? directScope;
    const scopeSubs = byScope.get(eventScope);
    if (!scopeSubs) return;

    // Scope-anchored case: a foreign-entity event (e.g. Job.updated) riding
    // the anchor row's own scope stream. The caller deliberately delivers it
    // here, authorized against the anchor row — not a per-entity mismatch.
    let scopeAnchored = false;
    if (handle.entity !== name) {
      if (typeof committed.scope !== 'string' || committed.scope !== directScope) return;
      scopeAnchored = true;
    }

    const removed = row === undefined;

    // Annotated-text operations have no recipient event grammar. Classify them
    // before delta/reducer construction so canonical family facts cannot enter
    // any live envelope; recipients recover through the projected snapshot.
    const isAnnotatedTextOperation = !scopeAnchored
      && eventScope === directScope
      && handle.kind === EventKind.native
      && handle.nativeName === 'operated'
      && entityRecord.fields?.[handle.field]?.kind === 'annotatedText';

    let authzRow                                      = row;
    if (!removed && !hydrated && entityRecord.findById) {
      try { authzRow = entityRecord.findById(String(id), null) ?? row; } catch { authzRow = row; }
    }

    let ephemeralField                = null;
    // Ephemeral-field pacing only makes sense on the per-entity path — a
    // scope-anchored foreign event (e.g. Job.updated) never has a field on
    // the anchor entity's fieldSet grammar, so it can't false-trigger this.
    if (!scopeAnchored && !removed && handle.kind === EventKind.fieldSet) {
      const fd = entityRecord.fields?.[handle.field];
      if (fd?.kind === 'ephemeral') {
        ephemeralField = handle.field;
      }
    }
    let annotatedText = annotatedTextByEntity.get(entityRecord);
    if (annotatedText === undefined) {
      annotatedText = hasAnnotatedText(entityRecord);
      annotatedTextByEntity.set(entityRecord, annotatedText);
    }
    const isAnnotatedTextEphemeral = ephemeralField !== null && annotatedText;

    // Delta projection is per-entity state diffing; a scope-anchored foreign
    // event carries its own data and must not be fed to the anchor's projector.
    const delta = scopeAnchored || isAnnotatedTextOperation || isAnnotatedTextEphemeral
      ? undefined
      : deltaProjector.project(entityRecord         , id, authzRow, committed         );

    for (const [conn, subSpec] of scopeSubs) {
      if (conn.closed) {
        scopeSubs.delete(conn);
        continue;
      }
      const principal = conn.principal ?? anonymous;
      if (!removed && !(await mayRow(entityRecord         , 'subscribe', authzRow, principal, mayVerb         ))) {
        continue;
      }

      // Annotated-text resync must be sent to ALL subscribers regardless of
      // field interest — the subscriber needs to know about the event to
      // maintain its cursor, even if it didn't ask for the ephemeral field.
      if (isAnnotatedTextOperation || isAnnotatedTextEphemeral) {
        const seq = committed.seq          ;
        if (!Number.isSafeInteger(seq) || seq < 0) continue;
        queueSnapshotControl(conn, name, id, seq, 'annotated-text-snapshot-required');
        continue;
      }

      // Field-read admission (S5/A3): the recipient's readable declared field
      // set, computed per subscriber from the committed row. The lifecycle
      // event payload, delta, and reducer seeds below are all confined to this
      // set; an unreadable single-field payload resyncs instead.
      let readableFields                                 ;
      if (!removed && authzRow) {
        readableFields = await readableFieldNames(entityRecord         , authzRow, principal, authorization);
      }

      if (ephemeralField !== null) {
        const fields = subSpec?.fields;
        if (!fields || fields[ephemeralField] !== true) continue;
        // A principal who cannot read the ephemeral field receives none of its
        // cells — ephemeral delivery never carries an unreadable field.
        if (readableFields !== undefined && !readableFields.has(ephemeralField)) continue;
      }

      // A native/field-set event is ONE field's operation payload (text op,
      // annotation facts, ephemeral cells). A principal who cannot read that
      // field must never receive the payload — the safe recipient grammar is
      // the same opaque snapshot recovery the envelope builder emits.
      if (!scopeAnchored && (handle.kind === EventKind.native || handle.kind === EventKind.fieldSet)
          && readableFields !== undefined && !readableFields.has(handle.field)) {
        const seq = committed.seq          ;
        if (!Number.isSafeInteger(seq) || seq < 0) continue;
        queueSnapshotControl(
          conn,
          name,
          id,
          seq,
          annotatedText ? 'annotated-text-snapshot-required' : 'recipient-snapshot-required',
        );
        continue;
      }

      let pace              = { window: 0, by: null };
      if (ephemeralField !== null && subSpec?.pace !== null && subSpec?.pace !== undefined) {
        pace = subSpec.pace;
      }

      if (pace.window === 0) {
        let recipientData                                     ;
        if (scopeAnchored) {
          // Scope-anchored foreign payloads are field-gated like any other
          // payload: a field the recipient cannot prove to read on the anchor
          // stream never reaches them. The only safe output is the same opaque
          // snapshot requirement the committed envelope path emits for a
          // foreign-entity event — never a partial or raw foreign payload.
          recipientData = await projectScopeAnchoredRecipientData(entityRecord, committed, principal, readableFields, authorization);
          if (recipientData === undefined && committed.data && typeof committed.data === 'object' && !Array.isArray(committed.data)) {
            const seq = committed.seq          ;
            if (!Number.isSafeInteger(seq) || seq < 0) continue;
            queueSnapshotControl(conn, name, id, seq, 'recipient-snapshot-required');
            continue;
          }
        } else {
          recipientData = await projectRecipientEventData(entityRecord, committed, handle, principal, readableFields, authorization);
        }
        const recipientEvent = recipientData === committed.data ? committed : { ...committed, data: recipientData };
        // Envelope identity (entity, id) is always the ANCHOR — matching the
        // subscription's scope — even for a scope-anchored foreign event;
        // the nested `event` carries its own type/data (e.g. Job.updated).
        const envelope                          = {
          type: 'event', entity: name, id, seq: committed.seq,
          seqSpan: [committed.seq, committed.seq],
          event: publicEvent(recipientEvent                                     ),
        };
        if (delta !== undefined) {
          envelope.delta = readableFields === undefined ? delta : filterDeltaForRecipient(delta, readableFields);
        }
        const reducers = createdTextReducerSeeds(entityRecord, committed                                                 );
        if (reducers) {
          const readable = readableFields;
          const recipientReducers = readable === undefined ? reducers : reducers.filter((seed) => readable.has(seed.field));
          if (recipientReducers.length > 0) envelope.reducers = recipientReducers;
        }
        conn.send(envelope);
      } else {
        const bufKey = `${conn.id}|${eventScope}|${ephemeralField}`;
        let entry = paceBuffers.get(bufKey);
        if (!entry) {
          entry = {
            conn,
            scope: eventScope,
            field: ephemeralField,
            events: [],
            timer: null,
            by: pace.by,
            entityRecord,
            authzRow,
          };
          paceBuffers.set(bufKey, entry);
        }
        entry.events.push(committed);
        entry.authzRow = authzRow;
        if (entry.timer === null) {
          entry.timer = setTimeout(() => flushPacedBuffer(bufKey), pace.window);
        }
      }
    }
  }

  function close()       {
    byScope.clear();
    connSubs.clear();
    for (const [, entry] of paceBuffers) {
      if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
    }
    paceBuffers.clear();
    pendingSnapshotControls.clear();
    snapshotControlFlushScheduled = false;
    if (snapshotControlFlushTimer !== null) {
      clearImmediate(snapshotControlFlushTimer);
      snapshotControlFlushTimer = null;
    }
    deltaProjector.clear();
  }

  return {
    addSubscription,
    removeSubscription,
    removeAll,
    subscriptionCount,
    collectionSubscriptionCount,
    hasSubscription,
    recipients,
    hasCaretInterest,
    setOnCaretInterestChange,
    setOnCaretInterestAdded,
    onRevocation,
    revoke,
    emit,
    close,
  };
}
