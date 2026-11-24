import { randomUUID } from 'node:crypto';
import { mayRow } from './row-grant.ts';
import { projectAnnotatedTextCaretSnapshot } from './annotated-text-snapshot.ts';
import { scopeOf } from './scope-handle.ts';
import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.ts';

interface CaretConnection {
  id: unknown;
  principal: unknown;
  closed: boolean;
  send(message: unknown): void;
}

interface CaretEntityRecord {
  name: string;
  fields: Record<string, any>;
  scopeFilter(principal: unknown): { sql: string; params: Record<string, unknown> };
  hydrate?: (raw: unknown, principal: unknown) => unknown;
}

interface CaretFanout {
  hasCaretInterest(conn: CaretConnection, scope: string, field: string): boolean;
  recipients(scope: string, field: string): Iterable<[CaretConnection, unknown]>;
  setOnCaretInterestChange?: (callback: (conn: CaretConnection, scope: string, removedFields: string[]) => void) => void;
  setOnCaretInterestAdded?: (callback: (conn: CaretConnection, scope: string, addedFields: string[]) => void) => void;
}

interface CaretSlot {
  connection: CaretConnection;
  entity: string;
  id: string;
  field: string;
  presence: string;
  generation: number;
  recipients: Set<CaretConnection>;
  /** The source's last published location, replayed to late-joining recipients. */
  lastValue: { offset: number; selection?: { from: number; to: number } } | null;
}

interface CaretSelection {
  from: number;
  to: number;
}

interface CaretUpdateMessage {
  type: 'caret.update';
  entity: string;
  id: string;
  field: string;
  offset: number;
  selection?: CaretSelection;
}

interface CaretClearMessage {
  type: 'caret.clear';
  entity: string;
  id: string;
  field: string;
}

type MayVerb = (entityRecord: unknown, verb: string, row: unknown, principal: unknown) => Promise<boolean>;

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

function parse(message: unknown): CaretUpdateMessage {
  if (!message || typeof message !== 'object' || Array.isArray(message)) invalid('Invalid caret message.');
  const record = message as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const base = ['entity', 'field', 'id', 'offset', 'type'];
  const withSelection = ['entity', 'field', 'id', 'offset', 'selection', 'type'];
  if ((keys.length !== base.length && keys.length !== withSelection.length)
    || keys.some((key, index) => key !== (keys.length === withSelection.length ? withSelection[index] : base[index]))
    || record.type !== 'caret.update' || typeof record.entity !== 'string' || typeof record.id !== 'string'
    || typeof record.field !== 'string' || !Number.isSafeInteger(record.offset) || (record.offset as number) < 0) {
    invalid('Invalid caret message.');
  }
  if (record.selection !== undefined) {
    const selection = record.selection as Record<string, unknown>;
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).length !== 2 || !Object.hasOwn(selection, 'from') || !Object.hasOwn(selection, 'to')
      || !Number.isSafeInteger(selection.from) || !Number.isSafeInteger(selection.to)
      || (selection.from as number) < 0 || (selection.to as number) < 0) {
      invalid('Invalid caret message.');
    }
  }
  return message as CaretUpdateMessage;
}

function parseClear(message: unknown): CaretClearMessage {
  if (!message || typeof message !== 'object' || Array.isArray(message)) invalid('Invalid caret message.');
  const record = message as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const required = ['entity', 'field', 'id', 'type'];
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index]) ||
    record.type !== 'caret.clear' || typeof record.entity !== 'string' || typeof record.id !== 'string' || typeof record.field !== 'string') {
    invalid('Invalid caret message.');
  }
  return message as CaretClearMessage;
}

export function createAnnotatedTextCaretLive({ db, resolveEntity, mayVerb, fanout, delay = null }: {
  db: { prepare(sql: string): { get(...args: unknown[]): any; all(...args: unknown[]): any[]; run(...args: unknown[]): { changes: number } } };
  resolveEntity: (name: string) => CaretEntityRecord | null | undefined;
  mayVerb: MayVerb;
  fanout: CaretFanout;
  delay?: number | (() => Promise<unknown>) | null;
}): { update: (conn: CaretConnection, message: unknown) => Promise<void>; clear: (conn: CaretConnection, message: unknown) => Promise<void>; removeConnection: (conn: CaretConnection, scope?: string | null) => Promise<void> } {
  const slots = new Map<string, CaretSlot>();
  const key = (conn: CaretConnection, entity: string, id: string, field: string) => `${conn.id}\0${entity}\0${id}\0${field}`;

  async function rowFor(entity: CaretEntityRecord, id: string, principal: unknown): Promise<{ raw: Record<string, unknown>; row: unknown } | null> {
    const { sql, params } = entity.scopeFilter(principal);
    const raw = db.prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${sql} AND t0.id = :id`).get({ ...params, id }) as Record<string, unknown> | undefined;
    if (!raw) return null;
    const row = entity.hydrate ? entity.hydrate(raw, principal) : raw;
    return await mayRow(entity, 'subscribe', row, principal, mayVerb) ? { raw, row } : null;
  }

  // Authorize ONE recipient against a document row that was loaded once for the
  // whole broadcast. The full row is never re-read per recipient: a payload-free
  // scope-visibility probe keeps the per-principal row-scope half of the grant,
  // hydrate redacts per principal, and mayRow runs the capability half. The same
  // check is cheap enough to repeat immediately before delivery, so a revoke or
  // deletion landing during the projection window still retracts instead of
  // delivering on stale access. hydrate receives a shallow copy because it may
  // project from (and mutate) its input and the raw row is now shared.
  function authorizeSharedRow(entity: CaretEntityRecord, id: string, raw: Record<string, unknown>, principal: unknown): unknown | null {
    const { sql, params } = entity.scopeFilter(principal);
    const visible = db.prepare(`SELECT 1 AS visible FROM ${entity.name} AS t0 WHERE ${sql} AND t0.id = :id LIMIT 1`).get({ ...params, id });
    if (!visible) return null;
    const row = entity.hydrate ? entity.hydrate({ ...raw }, principal) : raw;
    return row ?? null;
  }

  async function update(conn: CaretConnection, message: unknown): Promise<void> {
    const input = parse(message);
    const entity = resolveEntity(input.entity);
    const descriptor = entity?.fields?.[input.field];
    if (!entity || !descriptor || descriptor.kind !== 'annotatedText' || !getAnnotatedTextCompiledMetadata(descriptor)?.caret) invalid('Invalid caret message.');
    const scope = scopeOf(entity.name, input.id).key;
    if (!fanout.hasCaretInterest(conn, scope, input.field)) invalid('Caret subscription is required.');
    const slotKey = key(conn, entity.name, input.id, input.field);

    // Allocate/fence the slot generation BEFORE any async rowFor / projection.
    // A clear, disconnect, or newer update during the async gap bumps the
    // generation, so this batch's results cannot be delivered as stale.
    const isNewSlot = !slots.has(slotKey);
    const slot = slots.get(slotKey) ?? { connection: conn, entity: entity.name, id: input.id, field: input.field, presence: randomUUID(), generation: 0, recipients: new Set<CaretConnection>(), lastValue: null };
    slots.set(slotKey, slot);
    const generation = ++slot.generation;
    slot.lastValue = { offset: input.offset, ...(input.selection === undefined ? {} : { selection: input.selection }) };

    const source = await rowFor(entity, input.id, conn.principal);
    if (slots.get(slotKey) !== slot || slot.generation !== generation) {
      invalid('Caret update is denied.');
    }
    if (!source) {
      if (slots.get(slotKey) === slot && slot.generation === generation) {
        await retract(slotKey);
      }
      invalid('Caret update is denied.');
    }

    // Presence is stable: same connection/entity/id/field session keeps the
    // same opaque presence until clear or disconnect. A newer update upserts
    // the same presence with a new projected location; clear retracts it.

    // The source's public display label is carried on every upsert so a
    // recipient can attribute the caret without re-resolving the opaque
    // presence token. Empty when the app does not supply one on the principal.
    const sourcePrincipal = conn.principal as { id?: unknown; attributes?: Record<string, unknown> } | null | undefined;
    const sourceName = typeof sourcePrincipal?.attributes?.displayName === 'string' ? sourcePrincipal.attributes.displayName : '';

    // Test-only seam: inject a delay at this point so overlapping async
    // operations can race during the projection window.
    if (delay !== null) {
      const p = typeof delay === 'function' ? delay() : new Promise((resolve) => setTimeout(resolve, delay));
      await p;
      if (slots.get(slotKey) !== slot || slot.generation !== generation) {
        invalid('Caret update is denied.');
      }
    }

    // Reveal the source connection's OWN presence once per slot so the client
    // can decide "self" by presence match. Two tabs of the same principal share
    // sourceId but never the connection-scoped presence token, so each marks
    // only its own marker as self.
    if (isNewSlot && !conn.closed && slots.get(slotKey) === slot && slot.generation === generation && fanout.hasCaretInterest(conn, scope, input.field)) {
      try {
        conn.send({ type: 'annotated-text-caret', version: 1, entity: entity.name, id: input.id, field: input.field, change: { op: 'own', presence: slot.presence } });
      } catch {
        // A closed source socket must not fail the update; fanout below already
        // skips closed recipients.
      }
    }

    // The document row was loaded ONCE for this broadcast (the source's
    // rowFor above). Every recipient is projected and delivered concurrently
    // against that shared row — no serial chain of full row reads and awaits
    // across all subscribers.
    const recipients = [...fanout.recipients(scope, input.field)];
    const caret = { offset: input.offset, ...(input.selection === undefined ? {} : { selection: input.selection }) };
    await Promise.all(recipients.map(async ([recipient]) => {
      const maySubscribe = (row: unknown) => mayRow(entity, 'subscribe', row, recipient.principal, mayVerb);
      const retract = () => {
        if (slot.recipients.delete(recipient) && !recipient.closed) {
          recipient.send({ type: 'annotated-text-caret', version: 1, entity: entity.name, id: input.id, field: input.field, change: { op: 'remove', presence: slot.presence } });
        }
      };
      const stillCurrent = () => slots.get(slotKey) === slot && slot.generation === generation && !recipient.closed && fanout.hasCaretInterest(recipient, scope, input.field);

      let row = authorizeSharedRow(entity, input.id, source.raw, recipient.principal);
      if (row === null || !(await maySubscribe(row))) {
        retract();
        return;
      }
      try {
        const projected = await projectAnnotatedTextCaretSnapshot({ db, entity, row, principal: recipient.principal, fieldName: input.field, descriptor, caret, presence: slot.presence });
        const value = Object.freeze({
          ...projected,
          name: sourceName,
          // Attribution only: the source principal's stable id, carried on every
          // frame so a recipient can attribute the marker to its author. "Self"
          // is decided by the connection-scoped presence token (`own`), never by
          // comparing sourceId — two tabs of one principal share the id.
          sourceId: typeof sourcePrincipal?.id === 'string' ? sourcePrincipal.id : '',
        });
        if (!stillCurrent()) return;
        // Re-authorize immediately before delivery: a subscription/row revoke
        // that landed during the projection window must not deliver on stale
        // access. The scope probe re-reads committed state, so a deleted row is
        // caught without a second full document-row load.
        row = authorizeSharedRow(entity, input.id, source.raw, recipient.principal);
        if (row === null || !(await maySubscribe(row))) {
          retract();
          return;
        }
        recipient.send({ type: 'annotated-text-caret', version: 1, entity: entity.name, id: input.id, field: input.field, change: { op: 'upsert', value } });
        slot.recipients.add(recipient);
      } catch {
        if (!stillCurrent()) return;
        retract();
      }
    }));
  }

  /** Re-project an existing slot's last value for a late-joining recipient
   *  (same authorization + projection path as a live update). */
  async function replayCaretTo(slot: CaretSlot, recipient: CaretConnection): Promise<void> {
    const entity = resolveEntity(slot.entity);
    const descriptor = entity?.fields?.[slot.field];
    if (!entity || !descriptor || descriptor.kind !== 'annotatedText' || !getAnnotatedTextCompiledMetadata(descriptor)?.caret) return;
    const replaySlotKey = key(slot.connection, slot.entity, slot.id, slot.field);
    const recipientState = await rowFor(entity, slot.id, recipient.principal);
    if (!recipientState || recipient.closed) return;
    const sourcePrincipal = slot.connection.principal as { id?: unknown; attributes?: Record<string, unknown> } | null | undefined;
    const sourceName = typeof sourcePrincipal?.attributes?.displayName === 'string' ? sourcePrincipal.attributes.displayName : '';
    let value;
    try {
      const projected = await projectAnnotatedTextCaretSnapshot({ db, entity, row: recipientState.row, principal: recipient.principal, fieldName: slot.field, descriptor, caret: { offset: slot.lastValue!.offset, ...(slot.lastValue!.selection === undefined ? {} : { selection: slot.lastValue!.selection }) }, presence: slot.presence });
      value = Object.freeze({
        ...projected,
        name: sourceName,
        sourceId: typeof sourcePrincipal?.id === 'string' ? sourcePrincipal.id : '',
      });
    } catch {
      return;
    }
    try {
      // Re-validate immediately before delivery, mirroring the live update path:
      // the slot must still be live, the recipient still interested, and its row
      // access must still grant subscribe. A revocation that landed during the
      // projection window must not deliver on stale access.
      if (slots.get(replaySlotKey) !== slot || recipient.closed || !fanout.hasCaretInterest(recipient, scopeOf(slot.entity, slot.id).key, slot.field)) return;
      if (!(await rowFor(entity, slot.id, recipient.principal))) {
        if (!recipient.closed) {
          recipient.send({ type: 'annotated-text-caret', version: 1, entity: slot.entity, id: slot.id, field: slot.field, change: { op: 'remove', presence: slot.presence } });
        }
        slot.recipients.delete(recipient);
        return;
      }
      recipient.send({ type: 'annotated-text-caret', version: 1, entity: slot.entity, id: slot.id, field: slot.field, change: { op: 'upsert', value } });
      slot.recipients.add(recipient);
    } catch {
      return;
    }
  }

  function retract(slotKey: string): void {
    const slot = slots.get(slotKey);
    if (!slot) return;
    slots.delete(slotKey);
    slot.lastValue = null;
    ++slot.generation;
    // Fix 4: deliver remove to every previously tracked recipient regardless
    // of current authorization. A remove has only opaque presence; it must
    // reach the recipient without re-evaluating row authorization.
    for (const recipient of slot.recipients) {
      if (!recipient.closed) {
        recipient.send({ type: 'annotated-text-caret', version: 1, entity: slot.entity, id: slot.id, field: slot.field, change: { op: 'remove', presence: slot.presence } });
      }
    }
  }

  async function clear(conn: CaretConnection, message: unknown): Promise<void> {
    const input = parseClear(message);
    // A clear fans out removes to tracked recipients, so it must carry the
    // same declared caret interest and source row authorization as an update
    // (a caller cannot clear presence it never had a right to set).
    const entity = resolveEntity(input.entity);
    const descriptor = entity?.fields?.[input.field];
    if (!entity || !descriptor || descriptor.kind !== 'annotatedText' || !getAnnotatedTextCompiledMetadata(descriptor)?.caret) invalid('Invalid caret message.');
    const scope = scopeOf(entity.name, input.id).key;
    if (!fanout.hasCaretInterest(conn, scope, input.field)) invalid('Caret subscription is required.');
    if (!(await rowFor(entity, input.id, conn.principal))) invalid('Caret clear is denied.');
    // Allocate/fence even on clear so a concurrent stale update cannot
    // resurrect after the slot is removed. If no slot exists, creating a
    // throwaway slot with a new generation still prevents delayed updates.
    const slotKey = key(conn, input.entity, input.id, input.field);
    if (!slots.has(slotKey)) {
      const slot = { connection: conn, entity: input.entity, id: input.id, field: input.field, presence: randomUUID(), generation: 0, recipients: new Set<CaretConnection>(), lastValue: null };
      ++slot.generation;
      slots.set(slotKey, slot);
    }
    // Remove the slot and invalidate its generation; any future stale
    // update will see a missing slot (generation mismatch).
    await retract(slotKey);
  }

  async function removeConnection(conn: CaretConnection, scope: string | null = null): Promise<void> {
    const sourceKeys = [...slots.keys()].filter((slotKey) => {
      const slot = slots.get(slotKey);
      if (!slot || slot.connection !== conn) return false;
      if (scope !== null) {
        try { return scope === scopeOf(slot.entity, slot.id).key; } catch { return false; }
      }
      return true;
    });
    for (const slotKey of sourceKeys) {
      await retract(slotKey);
    }
    // Fix 5: remove dead recipient references and retract tokens for this
    // connection on every slot it was a recipient of.
    for (const [, slot] of slots) {
      if (scope !== null) {
        try { if (scope !== scopeOf(slot.entity, slot.id).key) continue; } catch { continue; }
      }
      if (slot.recipients.has(conn) && !conn.closed) {
        conn.send({ type: 'annotated-text-caret', version: 1, entity: slot.entity, id: slot.id, field: slot.field, change: { op: 'remove', presence: slot.presence } });
      }
      slot.recipients.delete(conn);
    }
  }

  // Fix 3: narrow caret transport hook for subscription replacement/removal.
  // When a subscription is replaced (new interest) or removed, the fanout
  // fires this callback with the removed caret fields so we retract tokens.
  fanout.setOnCaretInterestChange?.((conn, scope, removedFields) => {
    for (const [slotKey, slot] of [...slots]) {
      try { if (scope !== scopeOf(slot.entity, slot.id).key) continue; } catch { continue; }
      if (!removedFields.includes(slot.field)) continue;
      if (slot.connection === conn) {
        retract(slotKey);
        continue;
      }
      if (!slot.recipients.has(conn)) continue;
      if (!conn.closed) {
        conn.send({ type: 'annotated-text-caret', version: 1, entity: slot.entity, id: slot.id, field: slot.field, change: { op: 'remove', presence: slot.presence } });
      }
      slot.recipients.delete(conn);
    }
  });

  // A late-joining caret subscriber learns the CURRENT presence state for the
  // fields it now cares about: re-project each existing slot's last value for
  // the new connection (same authorization + projection path as a live update).
  fanout.setOnCaretInterestAdded?.((conn, scope, addedFields) => {
    for (const [, slot] of [...slots]) {
      try { if (scope !== scopeOf(slot.entity, slot.id).key) continue; } catch { continue; }
      if (!addedFields.includes(slot.field)) continue;
      if (slot.connection === conn || conn.closed || !slot.lastValue) continue;
      void replayCaretTo(slot, conn).catch(() => {});
    }
  });

  return { update, clear, removeConnection };
}
