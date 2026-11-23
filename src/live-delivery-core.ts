// LIVE DELIVERY CORE — package-private transport-neutral committed event delivery core.
//
// One subscription = one async stream of committed events, re-authorised per batch.
// The core reads committed events via _Log/readSince, projects them through the
// injected projector, and delivers them to the subscriber's async deliver callback.
// The subscriber's in-memory cursor advances only after successful delivery.
// wake(scope) is a payloadless hint to re-check for new events.
//
// Each subscription owns an opaque record and cursor. Multiple subscriptions on the
// same scope are independent — they cannot share or replace each other's cursor.
// Per-subscription dirty/generation loop ensures that a wake arriving during an
// active read/delivery triggers a second canonical reread before quiescence.
//
// After close() or removeSub, the active flag prevents any further delivery —
// closed subscriptions cannot project, deliver, or advance their cursor.
//
// Cursor safety: the cursor is advanced only after a successful delivery callback.
// If delivery rejects, the subscription is removed, the cursor is NOT advanced,
// and a resubscribe starting from the same after cursor will re-deliver the event.
// If the WebSocket closes during delivery, the same invariant applies — the
// subscriber's deliver callback should reject (or the subscription is removed by
// the owning LiveConnection's abort signal), so the cursor never advances for an
// undelivered event.
//
// Empty projection: when projectRecipient returns an empty array for all events
// in a batch, the cursor IS advanced (the events were successfully processed, just
// nothing needed to be sent to the client). This is correct for filter-only
// projectors that suppress certain event types — the consumer has acknowledged
// them and should not re-deliver on reconnect.

import { readSeq, readSince } from './committed-log.ts';
import type { LogEvent } from './committed-log.ts';
import { prepareCached } from './driver.ts';
import { readRevision } from './live-revision.ts';
import { readDeletedRowAnchor } from './deleted-row-anchor.ts';
import { EventKind, parseEventType } from './event-handle.ts';
import { mayRow } from './row-grant.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { tryParseScopeKey } from './scope-handle.ts';
import type { ScopeHandle } from './scope-handle.ts';
import type { Principal } from './principal.ts';
import { anonymous, principalKeyOf } from './principal.ts';
import type { FrameworkLog } from './log.ts';
import type { LiveDatabase, LiveEntityRecord, MayVerb, RevocationListener, RevocationResourceScope } from './live-fanout.ts';
import { normalizeRevocationScope } from './live-fanout.ts';
import { createCollectionSubscription } from './collection-subscription.ts';
import type { CollectionSubscription } from './collection-subscription.ts';
import { collectionDeliveryEnvelope } from './live-delivery-envelope.ts';
import type { CompiledSubscriptionRule, SubscriptionRule } from './subscription-rule.ts';

let nextSubId = 1;

function generateSubId(): number {
  return nextSubId++;
}

function deniedError(scope: string): Error & { code?: string } {
  const error = new Error(`subscribe authorization denied for scope '${scope}'`);
  (error as { code?: string }).code = 'live-delivery-revoked';
  return error;
}

export interface CoreProjectContext {
  readonly entity: LiveEntityRecord;
  readonly event: Readonly<Record<string, unknown>>;
  readonly principal: Principal;
  readonly row: Record<string, unknown> | null | undefined;
  readonly scope: string;
  readonly document: unknown;
}

export interface LiveDeliveryCoreOptions {
  db: LiveDatabase;
  entities: Map<string, LiveEntityRecord> | ((name: string) => LiveEntityRecord | undefined);
  mayVerb: MayVerb | null;
  authorization?: AuthorizationAdapter | null;
  projectRecipient: (ctx: CoreProjectContext) => unknown | Promise<unknown>;
  createProjectRecipient?: () => (ctx: CoreProjectContext) => unknown | Promise<unknown>;
  scopeVisible?: (ctx: { entity: LiveEntityRecord; principal: Principal; scope: ScopeHandle }) => boolean;
  log?: FrameworkLog | null;
}

interface CoreSub {
  entityRec: LiveEntityRecord;
  principal: Principal;
  deliver: (batch: unknown[]) => unknown | Promise<unknown>;
  revoke: (() => void) | null;
  signal: AbortSignal | undefined;
  cursor: number;
  pending: boolean;
  dirty: boolean;
  paused: boolean;
  scope: string;
  active: boolean;
  document: unknown;
  projectRecipient: (ctx: CoreProjectContext) => unknown | Promise<unknown>;
  activation?: Promise<number>;
  resyncEnvelope?: unknown;
  collection?: CollectionSubscription;
  collectionInitialized?: boolean;
  // Set of PENDING revocation events this subscription has been woken by (canonical
  // keys). A SET, not a single marker: multiple distinct revocations published
  // before the next catchUp are all retained and each gets a re-authorization
  // attempt — the later one never collapses the earlier (workbench#75 review
  // finding 5). Consumed (cleared) at each catchUp; a non-empty set also marks
  // the catchUp as revocation-driven so its denial is never re-published.
  revokeWakes: Set<string>;
  _abortHandler?: () => void;
}

export interface CoreSubscribeInput {
  principal: Principal;
  scope: string;
  after?: number;
  signal?: AbortSignal;
  deliver: (batch: unknown[]) => unknown | Promise<unknown>;
  revoke?: (() => void) | null;
  paused?: boolean;
  allowTerminal?: boolean;
  document?: unknown;
  rule?: SubscriptionRule | CompiledSubscriptionRule;
}

export interface CoreActivation {
  activate(): Promise<number | undefined>;
  // Explicit non-terminal teardown for one subscription: detaches without
  // invoking the transport revoke. The connection and its other scopes stay
  // alive. Terminal removal (abort, error, auth denial, close) goes through
  // the core's removeSub path instead, which detaches then revokes once.
  // Absent on admission-denial shims that installed no subscription.
  unsubscribe?(): void;
}

export type CoreBootstrapResult =
  | { kind: 'snapshot'; snapshot: unknown; cursor: number }
  | { kind: 'revoked' };

export type CoreCatchupResult =
  | { kind: 'catchup'; envelopes: unknown[]; cursor: number | undefined }
  | { kind: 'revoked' };

export interface LiveDeliveryCore {
  bootstrap(input: { principal: Principal; scope: string; snapshot: (ctx: { principal: Principal; scope: string }) => unknown | Promise<unknown> }): Promise<CoreBootstrapResult>;
  catchup(input: { principal: Principal; scope: string; after?: number; document?: unknown }): Promise<CoreCatchupResult>;
  subscribe(input: CoreSubscribeInput): Promise<CoreActivation | undefined>;
  wake(scope: string): void;
  resync(scope: string, envelope: unknown): void;
  resyncScope(scope: string, envelope: unknown | ((scope: string) => unknown)): void;
  resyncEntity(entityName: string, envelopeForScope: (scope: string) => unknown, filter?: (scope: string) => boolean): void;
  // S5/A5 revocation contract (spec item 4): register a listener (S4/S6
  // adapters) notified on every revocation; returns an unsubscribe.
  onRevocation(listener: RevocationListener): () => void;
  // Publish a revocation for a principal + resource scope (see the contract in
  // live-fanout.mjs). The descriptor is normalized and validated first — a
  // malformed scope (unknown category, empty key, non-canonical principal key,
  // invalid entity scope syntax) throws RevocationScopeError before any listener
  // fires (finding 4). The publisher is wired into the MUTATION paths that
  // invalidate grants: a committed deletion (terminal removal) and every
  // delivery-time reauthorization denial publish through this seam, exactly once
  // per invalidation, and immediately re-authorize the AFFECTED subscriptions
  // (matching by scope key or principal key) — event-driven, so a revoked
  // reader's feed ends without waiting for the next event batch. An app mutation
  // handler (membership removal, principal status change) calls this directly.
  revoke(principal: Principal, resourceScope: RevocationResourceScope): void;
  close(): void;
  snapshot(input: { principal: Principal; scope: string }): Record<string, unknown>;
  exceedsCatchupLimit(scope: string, after: number, limit: number): boolean;
}

export type LiveScope =
  | Readonly<{ kind: 'resource'; entity: LiveEntityRecord; handle: ScopeHandle }>
  | Readonly<{ kind: 'collection'; entity: LiveEntityRecord }>;

// Classifies the two live revision key shapes. Collection delivery is added by
// #103; carrying its identity here keeps cursor and recovery callers from
// accidentally parsing a collection key as a row scope.
export function classifyLiveScope(
  scope: string,
  resolveEntity: (name: string) => LiveEntityRecord | undefined | null,
): LiveScope | null {
  const handle = tryParseScopeKey(scope);
  if (handle) {
    const entity = resolveEntity(handle.entity);
    return entity?.tier === 'live' ? Object.freeze({ kind: 'resource', entity, handle }) : null;
  }
  const entity = resolveEntity(scope);
  return entity?.tier === 'live' ? Object.freeze({ kind: 'collection', entity }) : null;
}

export function createLiveDeliveryCore({ db, entities, mayVerb, authorization, projectRecipient, createProjectRecipient, scopeVisible = () => true, log = null }: LiveDeliveryCoreOptions): LiveDeliveryCore {
  if (!db) throw new Error('live-delivery-core: db is required');
  if (!entities) throw new Error('live-delivery-core: entities is required');
  if (!mayVerb) throw new Error('live-delivery-core: mayVerb is required');
  if (typeof projectRecipient !== 'function') throw new Error('live-delivery-core: projectRecipient must be a function');

  const resolveEntity = typeof entities === 'function' ? entities : (name: string) => entities.get(name);
  const subs = new Map<number, CoreSub>();
  const byScope = new Map<string, Set<number>>();
  let closed = false;
  // S5/A5 revocation contract: registered listeners (S4/S6 adapters) are fired
  // exactly once per published revocation, and the affected subscriptions are
  // re-authorized immediately (event-driven, not per-batch).
  const revocationListeners: RevocationListener[] = [];
  // Exactly-once dedup for ENTITY-scope revocations published from the delivery
  // path (a committed deletion or a reauthorization denial): keyed by scope +
  // the last observed seq, so concurrent deliveries of the SAME invalidation
  // publish exactly once. A later invalidation (new events) gets a new key and
  // publishes again; entries are pruned when the scope is reauthorized.
  const publishedRevocations = new Map<string, true>();

  // ---- Wake-burst shared committed-batch read --------------------------------
  //
  // Every subscription on a scope re-runs readSince for its own cursor; a
  // scope with many subscribers decodes the same committed payloads once per
  // subscriber per wake (profiled at ~65% of the keystroke fanout path).
  // Committed _Log rows are append-only within an event-loop turn, so a read
  // of (scope, cursor) at committed cursor L is reproducible while L is
  // unchanged. Entries are invalidated TWO ways so a later mutation can never
  // be served stale:
  //   1. turn-scoped — the entry dies at the end of the event-loop turn it was
  //      filled in (setImmediate), so an erasure-directive rewrite (which does
  //      not change seq values), a retention prune of the tail, or any
  //      later-turn commit finds no entry;
  //   2. max-seq-validated — a hit additionally requires the scope's committed
  //      MAX(seq) (a _Log primary-key index seek) to equal the fill-time value,
  //      so an append that commits mid-turn (between the fill and a later
  //      subscription's read) misses and re-reads. This holds whether or not
  //      the appender maintains _Cursor.
  // The shared event objects are handed to each subscription's catchUp, which
  // already treats them as read-only (per-event project context is a frozen
  // shallow copy). Only frame-identical projection OUTPUT depends on decoder
  // purity, which the one log-row decoder guarantees.
  const sharedReads = new Map<string, { events: LogEvent[]; maxSeq: number; turn: number }>();
  const reauthRows = new Map<string, { raw: Record<string, unknown> | undefined; maxSeq: number; turn: number }>();
  const SHARED_READ_MAX_ENTRIES = 128;

  // Turn bookkeeping: every cache entry is stamped with the turn it was filled
  // in and dies when the turn ends. ONE shared setImmediate advances the turn
  // and clears both maps — no per-entry timers.
  let readTurn = 0;
  let turnEndScheduled = false;
  function scheduleTurnEnd(): void {
    if (turnEndScheduled) return;
    turnEndScheduled = true;
    setImmediate(() => {
      turnEndScheduled = false;
      readTurn += 1;
      sharedReads.clear();
      reauthRows.clear();
    });
  }

  function sharedReadMaxSeq(scope: string): number {
    const row = prepareCached<{ get(params: Record<string, unknown>): { maxSeq?: number | null } | undefined }>(
      db as never,
      'SELECT MAX(seq) AS maxSeq FROM _Log WHERE scope = :scope',
    ).get({ scope });
    return typeof row?.maxSeq === 'number' ? row.maxSeq : 0;
  }

  // maxSeq is the committed MAX(seq) snapshot taken by the caller immediately
  // before the read (one probe per catchUp iteration, shared by the batch read
  // and the reauthorization row). A hit requires an unchanged turn AND an
  // unchanged maxSeq; population is cheap enough (Map set, shared timer) that
  // no subscriber-count gating is needed — one-shot catch-up storms and wake
  // bursts reuse the cache alike.
  function readSinceShared(scope: string, cursor: number, maxSeq: number): LogEvent[] {
    const key = `${scope}\u0000${cursor}`;
    const hit = sharedReads.get(key);
    if (hit && hit.turn === readTurn && hit.maxSeq === maxSeq) return hit.events;
    const events = readSince(db as never, scope, cursor);
    sharedReads.set(key, { events, maxSeq, turn: readTurn });
    if (sharedReads.size > SHARED_READ_MAX_ENTRIES) {
      const oldest = sharedReads.keys().next().value;
      if (oldest !== undefined) sharedReads.delete(oldest);
    }
    scheduleTurnEnd();
    return events;
  }

  // The canonical key a subscription keys a revocation event on — a distinct
  // wake set entry per distinct revocation (category-prefixed so an entity
  // scope and a principal key that happen to share a spelling never collapse).
  function revocationKey(resourceScope: RevocationResourceScope): string {
    return resourceScope.category === 'entity'
      ? `entity:${resourceScope.key}`
      : `principal:${resourceScope.key}`;
  }

  // Does a subscription fall inside a published revocation's resource scope?
  // entity scope ⇒ its scope key equals the key; principal scope ⇒ its
  // principal's key equals the key.
  function revocationMatches(sub: CoreSub, resourceScope: RevocationResourceScope): boolean {
    if (resourceScope.category === 'entity') return sub.scope === resourceScope.key;
    return principalKeyOf(sub.principal) === resourceScope.key;
  }

  // Publish a revocation: fire the registered listeners once, then immediately
  // wake every affected subscription so it re-reads + re-authorizes NOW (no wait
  // for the next event batch). A woken subscription that then fails
  // reauthorization is terminated; it retains the revocation key in its wake set
  // so its termination does not re-publish (exactly-once per revocation event).
  // Each DISTINCT revocation event is added to a subscription's wake set — two
  // revocations published before its next catchUp are both re-authorized, never
  // collapsed into the last one (finding 5).
  function publishRevocation(principal: Principal, resourceScope: RevocationResourceScope): void {
    const key = revocationKey(resourceScope);
    for (const listener of revocationListeners) {
      try { listener(principal, resourceScope); } catch { /* per-listener isolation */ }
    }
    for (const [subId, sub] of [...subs.entries()]) {
      if (!sub.active || !revocationMatches(sub, resourceScope)) continue;
      if (sub.revokeWakes.has(key)) continue;
      sub.revokeWakes.add(key);
      if (sub.paused) {
        sub.dirty = true;
      } else if (sub.pending) {
        sub.dirty = true;
      } else {
        catchUp(subId).catch(() => {});
      }
    }
  }

  function onRevocation(listener: RevocationListener): () => void {
    revocationListeners.push(listener);
    return () => {
      const idx = revocationListeners.indexOf(listener);
      if (idx !== -1) revocationListeners.splice(idx, 1);
    };
  }

  // The public revocation seam (spec item 4): normalize + validate the descriptor
  // FIRST (finding 4 — a malformed descriptor throws RevocationScopeError before
  // any listener fires or any subscription is woken), then publish. Every
  // mutation/admission path that invalidates a grant routes through this one
  // function — the delivery-time reauthorization denials and committed deletions
  // in catchUp below, and any app mutation handler that calls revoke() directly.
  function revoke(principal: Principal, resourceScope: RevocationResourceScope): void {
    if (closed) return;
    publishRevocation(principal, normalizeRevocationScope(principal, resourceScope));
  }

  // Exactly-once entity-scope publish keyed on the observed state: scope + the
  // last seq read in the failing catchUp batch (null when nothing was read).
  // Concurrent deliveries of the same invalidation share the key and only the
  // first publishes; a later invalidation has a new seq and publishes again.
  function publishRevocationForScope(scope: string, lastSeq: number | null): void {
    const dedupKey = lastSeq === null ? scope : `${scope}\u0000${lastSeq}`;
    if (publishedRevocations.has(dedupKey)) return;
    publishedRevocations.set(dedupKey, true);
    revoke(anonymous, { category: 'entity', key: scope });
  }

  // A successful reauthorization means the grant exists again: the scope's old
  // invalidation keys are stale and must not suppress a FUTURE invalidation.
  function prunePublishedRevocations(scope: string): void {
    if (publishedRevocations.has(scope)) publishedRevocations.delete(scope);
    const prefix = `${scope}\u0000`;
    for (const key of [...publishedRevocations.keys()]) {
      if (key.startsWith(prefix)) publishedRevocations.delete(key);
    }
  }

  function entityRecord(name: string): LiveEntityRecord {
    const record = resolveEntity(name);
    if (!record) throw new Error(`unknown entity '${name}'`);
    return record;
  }

  function isLiveEntity(entityRec: LiveEntityRecord): boolean {
    return entityRec.tier === 'live';
  }

  function deliveryCursor(entityRec: LiveEntityRecord, scope: string): number {
    return isLiveEntity(entityRec) ? readRevision(db as never, scope) : readSeq(db, scope);
  }

  async function authorizeSnapshot(principal: Principal, scope: string): Promise<boolean> {
    const handle = tryParseScopeKey(scope);
    if (!handle) throw new Error(`invalid scope '${scope}'`);
    let entityRec: LiveEntityRecord;
    try {
      entityRec = entityRecord(handle.entity);
    } catch {
      log?.error?.('live', 'entity not found', { scope, entity: handle.entity });
      return false;
    }
    const auth = reauthFor(entityRec, principal, handle);
    if (!auth || !(await checkMayRow(entityRec, auth.row, principal))) {
      log?.error?.('live', 'bootstrap denied', { scope });
      return false;
    }
    return true;
  }

  async function bootstrap({ principal, scope, snapshot }: { principal: Principal; scope: string; snapshot: (ctx: { principal: Principal; scope: string }) => unknown | Promise<unknown> }): Promise<CoreBootstrapResult> {
    if (closed) throw new Error('live-delivery-core is closed');
    if (typeof snapshot !== 'function') throw new Error('live delivery bootstrap requires a snapshot function');
    if (!(await authorizeSnapshot(principal, scope))) return { kind: 'revoked' };
    // Close can land on the awaited authorization await. Recheck so a closed
    // core never returns recipient state.
    if (closed) throw new Error('live-delivery-core is closed');
    // A materializer may await recipient authorization. If a commit interleaves,
    // reject rather than return a snapshot/cursor pair from different states.
    const handle = tryParseScopeKey(scope)!;
    const before = deliveryCursor(entityRecord(handle.entity), scope);
    const value = await snapshot({ principal, scope });
    const cursor = deliveryCursor(entityRecord(handle.entity), scope);
    // A materializer is a synchronous read projection. Letting it commit while
    // materializing would make its returned state and cursor incomparable.
    if (cursor !== before) throw new Error('live delivery snapshot function must not change its committed cursor');
    // Authorization can await application policy. Recheck after the synchronous
    // snapshot/cursor pair so a revocation during the first check never returns
    // recipient state; a later committed change is caught up from this cursor.
    if (!(await authorizeSnapshot(principal, scope))) return { kind: 'revoked' };
    if (closed) throw new Error('live-delivery-core is closed');
    return { kind: 'snapshot', snapshot: value, cursor };
  }

  function snapshot({ principal, scope }: { principal: Principal; scope: string }): Record<string, unknown> {
    const handle = tryParseScopeKey(scope);
    if (!handle) throw new Error(`invalid scope '${scope}'`);
    const entityRec = entityRecord(handle.entity);
    const auth = reauthFor(entityRec, principal, handle);
    if (!auth) throw deniedError(scope);
    return auth.row;
  }

  function exceedsCatchupLimit(scope: string, after: number, limit: number): boolean {
    const row = db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = :scope AND seq > :after')
      .get({ scope, after });
    return Number(row?.count ?? 0) > limit;
  }

  // ---- Wake-burst shared reauthorization row ---------------------------------
  //
  // reauthFor runs once per subscription per batch and its SELECT materializes
  // the full row (a 4k-word document body, profiled at ~27% of the remaining
  // fanout path) for every subscriber. For HISTORY-tier entities the shared
  // by-PK row fetch below reuses the same two-way invalidation as the
  // committed-batch read: turn-scoped plus MAX(seq)-validated. That rides one
  // invariant of the delivery core: a history-tier row change is applied in the
  // SAME transaction as its scope's committed events, so MAX(seq) unchanged
  // within a turn implies the row is unchanged. Visibility (scopeFilter) stays
  // per-principal and runs as a payload-free probe; hydrate stays per-principal
  // and receives a fresh shallow copy, so a hydrate that mutates its input
  // cannot contaminate the shared row. Live-tier entities keep the original
  // single-query path: their rows change transactionally with _LiveRevision
  // bumps, which MAX(seq) over _Log cannot observe.
  function reauthRowShared(entityRec: LiveEntityRecord, handle: ScopeHandle, maxSeq: number): Record<string, unknown> | undefined {
    const key = `${entityRec.name}\u0000${handle.id}`;
    const hit = reauthRows.get(key);
    if (hit && hit.turn === readTurn && hit.maxSeq === maxSeq) return hit.raw;
    const raw = db.prepare(`SELECT * FROM ${entityRec.name} WHERE id = :id`).get({ id: handle.id }) as Record<string, unknown> | undefined;
    reauthRows.set(key, { raw, maxSeq, turn: readTurn });
    if (reauthRows.size > SHARED_READ_MAX_ENTRIES) {
      const oldest = reauthRows.keys().next().value;
      if (oldest !== undefined) reauthRows.delete(oldest);
    }
    scheduleTurnEnd();
    return raw;
  }

  // maxSeq: the caller's MAX(seq) snapshot (catchUp's iteration probe). When
  // absent — one-shot admission paths — the row fetch is direct and uncached.
  function reauthFor(entityRec: LiveEntityRecord, principal: Principal, handle: ScopeHandle, allowDeletedAnchor = false, maxSeq?: number): { row: Record<string, unknown>; terminal: boolean } | null {
    try {
      if (!scopeVisible({ entity: entityRec, principal, scope: handle })) return null;
      const { sql: where, params: scopeParams } = entityRec.scopeFilter(principal);
      let current: Record<string, unknown> | undefined;
      if (isLiveEntity(entityRec)) {
        current = db.prepare(`SELECT * FROM ${entityRec.name} AS t0 WHERE ${where} AND t0.id = :id`).get({ ...scopeParams, id: handle.id }) as Record<string, unknown> | undefined;
      } else {
        const shared = maxSeq === undefined
          ? db.prepare(`SELECT * FROM ${entityRec.name} WHERE id = :id`).get({ id: handle.id }) as Record<string, unknown> | undefined
          : reauthRowShared(entityRec, handle, maxSeq);
        if (shared) {
          const visible = db.prepare(`SELECT 1 AS visible FROM ${entityRec.name} AS t0 WHERE ${where} AND t0.id = :id LIMIT 1`).get({ ...scopeParams, id: handle.id });
          if (visible) current = shared;
        }
      }
      const anchored = allowDeletedAnchor && !current
        ? readDeletedRowAnchor(db as Parameters<typeof readDeletedRowAnchor>[0], entityRec.name, handle.id)
        : undefined;
      const raw = current ?? (anchored && typeof anchored === 'object' && !Array.isArray(anchored)
        ? anchored as Record<string, unknown>
        : undefined);
      if (!raw) return null;
      // When hydrate is explicitly declared as a non-function (undefined/null),
      // fail closed — no raw row fallback. When hydrate is absent (compiled
      // entities without bind), use the raw row directly.
      if ('hydrate' in entityRec && typeof entityRec.hydrate !== 'function') return null;
      // A shallow copy isolates the shared cached row from hydrate mutation.
      const hydrateInput = isLiveEntity(entityRec) ? raw : { ...raw };
      const row = typeof entityRec.hydrate === 'function' ? entityRec.hydrate(hydrateInput, principal) : hydrateInput;
      if (row === null || row === undefined) return null;
      return { row, terminal: allowDeletedAnchor && !current };
    } catch (err) {
      log?.error?.('live', 'reauthFor failed', { scope: handle.key, err: String(err) });
      return null;
    }
  }

  async function checkMayRow(entityRec: LiveEntityRecord, row: Record<string, unknown>, principal: Principal): Promise<boolean> {
    try {
      // Re-authorization goes through the injected authorization adapter (S5/A2)
      // when one is wired — the SAME seam subscribe-time admission uses — so a
      // policy adapter owns both ends of the live path (the ticket's single-path
      // requirement). Without an adapter the framework row-grant runs, unchanged.
      if (authorization) {
        const decision = await authorization.admit({
          category: 'entity',
          verb: 'subscribe',
          operation: 'subscribe',
          principal,
          entity: entityRec as never,
          row,
          resourceId: (row as { id?: unknown } | null | undefined)?.id as string | null | undefined,
        });
        return decision.admitted;
      }
      return await mayRow(entityRec as never, 'subscribe', row, principal, mayVerb as never);
    } catch {
      return false;
    }
  }

  function isTerminalRemoval(event: { eventType?: unknown; type?: unknown }, entityName: string): boolean {
    try {
      const type = event.eventType ?? event.type;
      const handle = parseEventType(type as string);
      return handle.entity === entityName && handle.kind === EventKind.removed;
    } catch {
      return false;
    }
  }

  // Shared internal detach: marks the subscription inactive, detaches its abort
  // listener, and removes it from the registries. Both lifecycle paths share it
  // — an explicit per-scope unsubscribe detaches without any transport revoke,
  // while the terminal path (removeSub) follows detach with revoke exactly once.
  function detachSub(subId: number): CoreSub | undefined {
    const sub = subs.get(subId);
    if (!sub) return undefined;
    sub.active = false;
    sub.collection?.close();
    if (sub.signal && typeof sub.signal.removeEventListener === 'function') {
      try { sub.signal.removeEventListener('abort', sub._abortHandler as () => void); } catch { /* ignore */ }
    }
    subs.delete(subId);
    const set = byScope.get(sub.scope);
    if (set) {
      set.delete(subId);
      if (set.size === 0) byScope.delete(sub.scope);
    }
    return sub;
  }

  // Singular terminal lifecycle: every terminal removal path (read/projection/
  // delivery error, terminal removal, abort, close) flows through here. It
  // detaches then invokes the transport revoke exactly once so SSE ends and its
  // capacity releases. The subs.get guard makes later removals, aborts, and
  // close() calls no-ops, so nothing double-releases.
  function removeSub(subId: number): void {
    const sub = detachSub(subId);
    if (!sub) return;
    try { sub.revoke?.(); } catch { /* transport lifecycle callbacks are isolated */ }
  }

  async function catchUp(subId: number): Promise<void> {
    const sub = subs.get(subId);
    if (!sub || !sub.active) return;
    if (sub.paused) {
      sub.dirty = true;
      return;
    }
    sub.pending = true;
    try {
      // The number of re-authorization iterations owed to consumed revocation
      // keys in THIS catchUp invocation. A subscription woken by two distinct
      // revocations re-authorizes once per key (finding 5); while owed
      // iterations remain the catchUp is "revocation-driven", so a denial is
      // never re-published (the denial is the manifestation of a published
      // revocation — exactly once per revocation event).
      let revocationsOwed = 0;
      while (true) {
        if (!sub.active) return;
        sub.dirty = false;
        // Consume the pending revocation wake set. Distinct revocation events
        // are retained (a set, never a single marker that collapses into the
        // last one); each owned key below buys one re-authorization iteration.
        const pendingRevocations = [...sub.revokeWakes];
        sub.revokeWakes.clear();
        revocationsOwed += pendingRevocations.length;
        const revocationDriven = revocationsOwed > 0;
        if (sub.collection) {
          const revision = readRevision(db as never, sub.scope);
          if (!sub.collectionInitialized || revision !== sub.cursor) {
            try {
              await sub.collection.notify();
            } catch (err) {
              log?.error?.('live', 'collection delivery failed', { scope: sub.scope, err: String(err) });
              removeSub(subId);
              throw err;
            }
            if (!sub.active) return;
            sub.collectionInitialized = true;
            sub.cursor = revision;
          }
          revocationsOwed -= 1;
          if (sub.dirty || revocationsOwed > 0) continue;
          return;
        }
        const handle = tryParseScopeKey(sub.scope);
        if (!handle) { removeSub(subId); log?.error?.('live', 'invalid scope', { scope: sub.scope }); throw new Error(`invalid scope '${sub.scope}'`); }
        if (isLiveEntity(sub.entityRec)) {
          // Live-tier rows have no _Log history. A revision says only that the
          // current authorized state changed, so this projects the newest row
          // once instead of reconstructing intermediate mutations.
          const revision = readRevision(db as never, sub.scope);
          const resyncEnvelope = sub.resyncEnvelope;
          const auth = reauthFor(sub.entityRec, sub.principal, handle, true);
          if (auth) prunePublishedRevocations(sub.scope);
          if (!auth || !(await checkMayRow(sub.entityRec, auth.row, sub.principal))) {
            if (!revocationDriven) publishRevocationForScope(sub.scope, revision || null);
            removeSub(subId); log?.error?.('live', 'reauth denied', { scope: sub.scope }); return;
          }
          if (!sub.active) return;
          if (revision === sub.cursor && !resyncEnvelope) {
            revocationsOwed -= 1;
            if (sub.dirty || revocationsOwed > 0) continue;
            return;
          }
          const batch: unknown[] = resyncEnvelope ? [resyncEnvelope] : [];
          if (revision !== sub.cursor) {
            const event = Object.freeze({
              scope: sub.scope,
              seq: revision,
              eventType: `${sub.entityRec.name}.${auth.terminal ? 'removed' : 'updated'}`,
              type: `${sub.entityRec.name}.${auth.terminal ? 'removed' : 'updated'}`,
              committedAt: new Date().toISOString(),
            });
            try {
              const projected = await sub.projectRecipient(Object.freeze({
                entity: sub.entityRec,
                event,
                principal: sub.principal,
                // The anchor proves deletion-time admission but is never current
                // state: terminal output is an absence projection only.
                row: auth.terminal ? null : auth.row,
                scope: sub.scope,
                document: sub.document ?? null,
              }));
              if (!Array.isArray(projected)) throw new Error('projectRecipient must return an array');
              batch.push(...projected);
            } catch (err) {
              log?.error?.('live', 'projectRecipient threw', { scope: sub.scope, seq: revision, err: String(err) });
              removeSub(subId);
              throw new Error(`projectRecipient threw for scope '${sub.scope}' seq ${revision}`);
            }
          }
          if (batch.length > 0) {
            try {
              await sub.deliver(batch);
            } catch (err) {
              log?.error?.('live', 'delivery callback threw', { scope: sub.scope, err: String(err) });
              removeSub(subId);
              throw new Error(`delivery callback threw for scope '${sub.scope}'`);
            }
            if (resyncEnvelope && sub.resyncEnvelope === resyncEnvelope) sub.resyncEnvelope = null;
          }
          if (!sub.active) return;
          sub.cursor = revision;
          if (auth.terminal) {
            if (!revocationDriven) publishRevocationForScope(sub.scope, revision || null);
            removeSub(subId);
            return;
          }
          revocationsOwed -= 1;
          if (sub.dirty || revocationsOwed > 0) continue;
          return;
        }
        // One committed MAX(seq) snapshot for this iteration, taken in the
        // same synchronous stretch as both shared reads it validates.
        const maxSeq = sharedReadMaxSeq(sub.scope);
        let events: Array<{ seq: number } & Readonly<Record<string, unknown>>>;
        try {
          events = readSinceShared(sub.scope, sub.cursor, maxSeq) as unknown as Array<{ seq: number } & Readonly<Record<string, unknown>>>;
        } catch (err) {
          log?.error?.('live', 'readSince failed', { scope: sub.scope, cursor: sub.cursor, err: String(err) });
          removeSub(subId);
          throw new Error(`readSince failed for scope '${sub.scope}'`);
        }
        const auth = reauthFor(sub.entityRec, sub.principal, handle, false, maxSeq);
        // A successful reauthorization means the grant exists again — stale
        // invalidation dedup keys for this scope must not suppress a FUTURE
        // invalidation.
        if (auth) prunePublishedRevocations(sub.scope);
        // A removal deletes its authorization subject, so it cannot be
        // re-authorized against a current row. Without that row, only terminal
        // removals for this entity may be projected; other committed rows in
        // the catch-up batch stay fail-closed. The terminal subscription is
        // then removed without acknowledging withheld events.
        const terminalRemoval = !auth && events.length > 0 && events.every((event) => isTerminalRemoval(event as { eventType?: unknown; type?: unknown }, sub.entityRec.name));
        const deliverableEvents = auth
          ? events
          : terminalRemoval ? events : [];
        if (!auth && !terminalRemoval) {
          // Reauthorization denied at delivery time: the admission path where a
          // grant-invalidating mutation manifests. Publish the revocation
          // exactly once for this observed state (deduped per scope + seq) —
          // unless this wake already WAS a published revocation — so listeners
          // hear it and the OTHER affected subscriptions are re-authorized
          // immediately.
          if (!revocationDriven) publishRevocationForScope(sub.scope, events.length > 0 ? events[events.length - 1].seq : null);
          removeSub(subId); log?.error?.('live', 'reauth denied', { scope: sub.scope }); return;
        }
        if (auth && !(await checkMayRow(sub.entityRec, auth.row, sub.principal))) {
          if (!revocationDriven) publishRevocationForScope(sub.scope, events.length > 0 ? events[events.length - 1].seq : null);
          removeSub(subId); log?.error?.('live', 'mayRow denied', { scope: sub.scope }); return;
        }
        if (!sub.active) return;
        const resyncEnvelope = sub.resyncEnvelope;
        if (events.length === 0 && !resyncEnvelope) {
          revocationsOwed -= 1;
          if (sub.dirty || revocationsOwed > 0) continue;
          return;
        }
        const batch: unknown[] = resyncEnvelope ? [resyncEnvelope] : [];
        for (const event of deliverableEvents) {
          if (!sub.active) return;
          const ctx = Object.freeze({
            entity: sub.entityRec,
            event: Object.freeze({ ...event }),
            principal: sub.principal,
            row: auth?.row,
            scope: sub.scope,
            document: sub.document ?? null,
          });
          let projected: unknown;
          try {
            projected = await sub.projectRecipient(ctx);
          } catch (err) {
            log?.error?.('live', 'projectRecipient threw', { scope: sub.scope, seq: event.seq, err: String(err) });
            removeSub(subId);
            throw new Error(`projectRecipient threw for scope '${sub.scope}' seq ${event.seq}`);
          }
          if (!sub.active) return;
          if (!Array.isArray(projected)) {
            log?.error?.('live', 'projectRecipient must return an array', { scope: sub.scope, seq: event.seq });
            removeSub(subId);
            throw new Error(`projectRecipient must return an array for scope '${sub.scope}' seq ${event.seq}`);
          }
          batch.push(...projected);
        }
        if (!sub.active) return;
        // Cursor advances only after successful delivery. If the deliver callback
        // rejects (e.g. WebSocket closed), the subscription is removed, cursor
        // stays at the previous value, and a resubscribe re-delivers the event.
        if (batch.length > 0) {
          try {
            await sub.deliver(batch);
          } catch (err) {
            log?.error?.('live', 'delivery callback threw', { scope: sub.scope, err: String(err) });
            removeSub(subId);
            throw new Error(`delivery callback threw for scope '${sub.scope}'`);
          }
          if (resyncEnvelope && sub.resyncEnvelope === resyncEnvelope) sub.resyncEnvelope = null;
        }
        if (!sub.active) return;
        if (terminalRemoval) {
          // The authorization subject is gone. A terminal removal is the only
          // allowed output, and this subscription cannot acknowledge unrelated
          // earlier events that were withheld by the fail-closed filter.
          // THE MUTATION PATH (workbench#75 review BLOCKER): a committed
          // deletion invalidates every subscription's grant on this scope.
          // Publish the revocation exactly once per (scope, removal seq) —
          // the synchronous dedup guards concurrent deliveries of the same
          // removal, and a revocation-woken catchUp (revocationDriven) skips
          // because its publish already happened — before delivering the
          // terminal removal, so S4/S6 listeners hear the deletion immediately.
          if (!revocationDriven) publishRevocationForScope(sub.scope, events[events.length - 1].seq);
          sub.cursor = events[events.length - 1].seq;
          removeSub(subId);
          return;
        }
        // Advance cursor past the last event we processed (even if projection
        // returned empty — the events were acknowledged).
        if (events.length > 0) sub.cursor = events[events.length - 1].seq;
        revocationsOwed -= 1;
        if (sub.dirty || revocationsOwed > 0) continue;
        return;
      }
    } catch (err) {
      // If we're the outermost catchUp (not a re-entrant dirty wake), re-throw.
      // If this was a re-entrant call from the finally block, we need to make
      // sure the error is not silently swallowed — the subscriber will learn
      // about it via the promise from subscribe() or the removal.
      const sub = subs.get(subId);
      if (sub) {
        // The sub is still active but the loop aborted — remove it.
        removeSub(subId);
      }
      throw err;
    } finally {
      const sub = subs.get(subId);
      if (sub) {
        sub.pending = false;
        if (sub.active && sub.dirty) {
          catchUp(subId).catch(() => {
            // nested catchUp failure — subscription already removed
          });
        }
      }
    }
  }

  async function subscribe({ principal, scope, after = 0, signal, deliver, revoke = null, paused = false, allowTerminal = false, document = null, rule }: CoreSubscribeInput): Promise<CoreActivation | undefined> {
    if (closed) throw new Error('live-delivery-core is closed');
    if (signal?.aborted) return;
    const parsedHandle = tryParseScopeKey(scope);
    const liveScope = parsedHandle ? null : classifyLiveScope(scope, resolveEntity);
    if (!parsedHandle && !liveScope) {
      log?.error?.('live', 'invalid scope', { scope });
      throw new Error(`invalid scope '${scope}'`);
    }
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
      throw new Error(`after must be a nonnegative safe integer, got ${after}`);
    }
    if (typeof deliver !== 'function') {
      throw new Error('deliver must be a function');
    }
    const entityRec = parsedHandle ? entityRecord(parsedHandle.entity) : liveScope!.entity;
    const isCollection = !parsedHandle;
    if (isCollection && !rule) throw new Error(`collection scope '${scope}' requires a rule`);
    const handle = parsedHandle;
    let auth = handle ? reauthFor(entityRec, principal, handle) : null;
    if (!isCollection && !auth) {
      const terminalAuth = isLiveEntity(entityRec) ? reauthFor(entityRec, principal, parsedHandle!, true) : null;
      const unread = allowTerminal && !isLiveEntity(entityRec) ? readSince(db as never, scope, after) : [];
      if (terminalAuth && terminalAuth.terminal && readRevision(db as never, scope) > after) {
        auth = terminalAuth;
      } else if (unread.length > 0 && unread.every((event) => isTerminalRemoval(event, entityRec.name))) {
        // A catch-up may begin immediately after deletion. Only a fully
        // contiguous suffix of this anchor's terminal removals is safe to
        // deliver without a current authorization row.
      } else {
        log?.error?.('live', 'subscribe denied', { scope });
        throw deniedError(scope);
      }
    }
    if (auth && !(await checkMayRow(entityRec, auth.row, principal))) {
      log?.error?.('live', 'subscribe denied', { scope });
      throw deniedError(scope);
    }
    // Close can land on the awaited admission await. Recheck before insertion
    // so a closed core never installs a stranded subscription.
    if (closed) throw new Error('live-delivery-core is closed');
    const subId = generateSubId();
    const sub: CoreSub = {
      entityRec,
      principal,
      deliver,
      revoke,
      signal,
      cursor: after,
      pending: false,
      dirty: false,
      paused,
      scope,
      active: true,
      document,
      projectRecipient: createProjectRecipient?.() ?? projectRecipient,
      revokeWakes: new Set(),
    };
    if (isCollection) {
      sub.collection = createCollectionSubscription({
        db,
        entity: entityRec,
        principal,
        rule: rule!,
        mayVerb: mayVerb!,
        authorization,
        // S3/A7: the wire envelope for a collection refresh is the shared
        // `state`/`state-invalidate` grammar — never the storage-tier
        // `collection` shape. The change's revision is read at delivery time
        // so the envelope's seq names the revision the rows were projected at.
        deliver: (change) => sub.deliver([collectionDeliveryEnvelope(change, {
          entityName: entityRec.name,
          revision: readRevision(db as never, sub.scope),
        })]),
      });
      sub.collectionInitialized = false;
    }
    subs.set(subId, sub);
    let set = byScope.get(scope);
    if (!set) { set = new Set(); byScope.set(scope, set); }
    set.add(subId);
    if (signal) {
      const handler = () => { removeSub(subId); };
      sub._abortHandler = handler;
      signal.addEventListener('abort', handler, { once: true });
      if (signal.aborted) {
        removeSub(subId);
        throw new Error('subscription aborted');
      }
    }
    async function activate(): Promise<number | undefined> {
      const current = subs.get(subId);
      if (!current || !current.active) return;
      if (!current.activation) {
        current.activation = (async () => {
          current.paused = false;
          try {
            await catchUp(subId);
          } catch (err) {
            removeSub(subId);
            throw err;
          }
          return current.cursor;
        })();
      }
      return current.activation;
    }
    if (paused) return { activate, unsubscribe: () => detachSub(subId) };
    if (closed) {
      removeSub(subId);
      throw new Error('live-delivery-core is closed');
    }
    await activate();
  }

  async function wake(scope: string): Promise<void> {
    if (closed) return;
    const set = byScope.get(scope);
    if (!set) return;
    for (const subId of set) {
      const sub = subs.get(subId);
      if (!sub || !sub.active) continue;
      if (sub.paused) {
        sub.dirty = true;
        continue;
      }
      if (sub.pending) {
        sub.dirty = true;
      } else {
        catchUp(subId).catch(() => {});
      }
    }
  }

  function resync(scope: string, envelope: unknown): void {
    if (closed) return;
    const set = byScope.get(scope);
    if (!set) return;
    for (const subId of [...set]) {
      const sub = subs.get(subId);
      if (!sub || !sub.active) continue;
      sub.resyncEnvelope = envelope;
      sub.dirty = true;
      if (!sub.paused && !sub.pending) catchUp(subId).catch(() => {});
    }
  }

  function resyncScope(scope: string, envelopeOrFactory: unknown | ((scope: string) => unknown)): void {
    if (closed) return;
    const set = byScope.get(scope);
    if (!set || set.size === 0) return;
    const envelope = typeof envelopeOrFactory === 'function'
      ? (envelopeOrFactory as (scope: string) => unknown)(scope)
      : envelopeOrFactory;
    resync(scope, envelope);
  }

  function resyncEntity(entityName: string, envelopeForScope: (scope: string) => unknown, filter?: (scope: string) => boolean): void {
    if (closed) return;
    const matchedScopes = new Set<string>();
    for (const sub of subs.values()) {
      if (!sub.active || sub.entityRec.name !== entityName) continue;
      if (filter && !filter(sub.scope)) continue;
      matchedScopes.add(sub.scope);
    }
    for (const scope of matchedScopes) {
      resync(scope, envelopeForScope(scope));
    }
  }

  function close(): void {
    closed = true;
    // Revoke every active subscription so transport skins (SSE ends its
    // response only via revoke) release their connections. Marking inactive
    // without revoking left sockets open and pinned server.close() forever.
    for (const subId of [...subs.keys()]) {
      removeSub(subId);
    }
    subs.clear();
    byScope.clear();
    publishedRevocations.clear();
    sharedReads.clear();
    reauthRows.clear();
  }

  async function catchup({ principal, scope, after = 0, document = null }: { principal: Principal; scope: string; after?: number; document?: unknown }): Promise<CoreCatchupResult> {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error(`after must be a nonnegative safe integer, got ${after}`);
    }
    const authorized = await authorizeSnapshot(principal, scope);
    // Close can land on the awaited admission await. Recheck so a closed core
    // never installs the paused catch-up subscription.
    if (closed) throw new Error('live-delivery-core is closed');
    if (!authorized) {
      const handle = tryParseScopeKey(scope);
      const entityRec = handle ? resolveEntity(handle.entity) : null;
      const terminalAuth = entityRec && handle && isLiveEntity(entityRec)
        ? reauthFor(entityRec, principal, handle, true)
        : null;
      const unread = entityRec && !isLiveEntity(entityRec) ? readSince(db as never, scope, after) : [];
      if (terminalAuth?.terminal && readRevision(db as never, scope) > after && await checkMayRow(entityRec!, terminalAuth.row, principal)) {
        // The deletion anchor authorizes exactly one terminal absence delivery.
      } else if (!entityRec || unread.length === 0 || !unread.every((event) => isTerminalRemoval(event, entityRec.name))) {
        return { kind: 'revoked' };
      }
    }
    const controller = new AbortController();
    const envelopes: unknown[] = [];
    let revoked = false;
    let activation: CoreActivation | undefined;
    try {
      activation = await subscribe({
        principal,
        scope,
        after,
        signal: controller.signal,
        paused: true,
        deliver: async (batch: unknown[]) => { envelopes.push(...batch); },
        revoke: () => { revoked = true; },
        allowTerminal: true,
        document,
      });
    } catch (error) {
      controller.abort();
      if ((error as { code?: unknown } | null | undefined)?.code === 'live-delivery-revoked') return { kind: 'revoked' };
      throw error;
    }
    try {
      const cursor = await activation!.activate();
      // A terminal removal delivers its removal envelope first and only then
      // revokes through the one removal path (the row is gone, so the stream
      // legitimately ends). That post-delivery revoke must not turn a delivered
      // catch-up into a revocation — only a revoke that delivered nothing is a
      // genuine revocation (admission/reauth denial before any envelope).
      return revoked && envelopes.length === 0 ? { kind: 'revoked' } : { kind: 'catchup', envelopes, cursor };
    } finally {
      controller.abort();
    }
  }

  return { bootstrap, catchup, subscribe, wake, resync, resyncScope, resyncEntity, onRevocation, revoke, close, snapshot, exceedsCatchupLimit };
}
