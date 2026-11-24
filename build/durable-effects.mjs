import { effectEntries } from './effect-compiler.mjs';
import { parseEventType } from './event-handle.mjs';

import { sweepBehindCursor, upsertConsumerCursor } from './consumer-cursor.mjs';

import { txn } from './driver.mjs';
import { getLog } from './log.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';
import { decodeLogRowData,                 } from './committed-log.mjs';

const CONSUMER = 'effect.durable';






























                                                           



function isDurableEffectDeclaration(effect         )                                     {
  return !!effect && typeof effect === 'object' && typeof (effect                         ).durable === 'string';
}

function resolveTriggerEventType(handle         )         {
  const candidate = handle                                                          ;
  if (candidate && typeof candidate === 'object' && candidate.brand === 'event-handle' && typeof candidate.type === 'string') {
    return candidate.type;
  }
  if (candidate && typeof candidate === 'object' && candidate.brand === 'state-transition-handle' && typeof candidate.type === 'string') {
    return candidate.type;
  }
  throw new Error(`durable effect trigger '${String(handle)}' must be a typed event handle. Strings are not accepted.`);
}

export function buildDurableEffectsRegistry(entities                                                         )                                    {
  const registry = new Map                              ();
  for (const entityRecord of entities ?? []) {
    if (!entityRecord.effects) continue;
    const entries = effectEntries(entityRecord.effects, { sourceEntityName: entityRecord.name });
    // S3/A8 review #2 (JavaGT/workbench#114): a live-tier entity may not
    // declare durable effects. entity/compile.ts already refuses this at
    // declaration compile; this registration-time guard covers raw records
    // that skipped entity compilation, so a live entity can never slip a
    // durable effect into the registry that the live lane will silently skip.
    if (entityRecord.tier === 'live') {
      const durable = entries.filter(([, effect]) => isDurableEffectDeclaration(effect));
      if (durable.length > 0) {
        throw new Error(
          `live entity '${entityRecord.name}' cannot declare durable effects — live mutations write no ` +
            '_Log row, so a durable effect job could never be anchored to its triggering event. ' +
            'Move the durable work to a history-tier entity.',
        );
      }
    }
    for (const [triggerHandle, effect] of entries) {
      if (!isDurableEffectDeclaration(effect)) continue;
      const eventType = resolveTriggerEventType(triggerHandle);
      if (!registry.has(eventType)) registry.set(eventType, []);
      registry.get(eventType) .push({ sourceEntity: entityRecord.name, effect });
    }
  }
  return registry;
}

// A scope handle is `Entity:id`; the id itself may contain ':' (or '%' or any
// other text). The historical `scope.replace(':', ':')` was a no-op, leaving the
// segments ambiguous: a (scope, seq, kind) tuple could collide with another.
// Keep the canonical format byte-identical for ordinary ids (so existing job
// ids and recovery cursors stay stable) and percent-encode ONLY segments that
// could blur a boundary. Entity names cannot contain ':' by grammar; a kind
// with ':' is encoded too, because it is the right-most segment.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function encodeIdSegment(value        )         {
  return SAFE_SEGMENT.test(value) ? value : encodeURIComponent(value);
}

export function durableJobId(ev                  , kind        )         {
  const colon = ev.scope.indexOf(':');
  const scope = colon <= 0
    ? ev.scope
    : `${ev.scope.slice(0, colon)}:${encodeIdSegment(ev.scope.slice(colon + 1))}`;
  return `durable-effect:${scope}:${ev.seq}:${encodeIdSegment(kind)}`;
}

function durablePayload(ev                  , effect                          )                                                                                                            {
  const delta = ev.data ?? {};
  const origin = { id: tryParseScopeKey(ev.scope)?.id };
  const data = typeof effect.with === 'function' ? effect.with({ delta, origin }) : (effect.with ?? {});
  return {
    event: {
      type: ev.type,
      scope: ev.scope,
      seq: ev.seq,
      actionId: ev.actionId,
    },
    data,
  };
}

async function enqueueDurableEffectsForEvent(ev                  , effects                               , jobs      ) {
  for (const { effect } of effects) {
    // Await each enqueue: when the queue is coordinated, the write lands on a
    // microtask within the current turn, and a failure must propagate to the
    // enclosing transaction so it ROLLS BACK (never a dropped, unhandled
    // rejection).
    await jobs.enqueue({
      id: durableJobId(ev, effect.durable),
      kind: effect.durable,
      payload: durablePayload(ev, effect),
    });
  }
}

async function enqueueDurableEffectsAndAdvance(db          , ev                  , effects                               , jobs      )                {
  await txn(db, async () => {
    await enqueueDurableEffectsForEvent(ev, effects, jobs);
    upsertConsumerCursor(db, { consumer: CONSUMER, scope: ev.scope, lastSeq: ev.seq });
  });
}

export function createDurableEffectsConsumer({ durableEffectsRegistry, jobs }


 )                                                                                             {
  if (!jobs || !durableEffectsRegistry || durableEffectsRegistry.size === 0) return null;
  return async (events, { db }) => {
    const blockedScopes = new Set        ();
    for (const ev of events) {
      if (typeof ev.seq !== 'number') continue;
      if (blockedScopes.has(ev.scope)) continue;
      const effects = durableEffectsRegistry.get(ev.type);
      if (!effects || effects.length === 0) continue;
      try {
        await enqueueDurableEffectsAndAdvance(db, ev, effects, jobs);
      } catch (err) {
        // A later event must not advance this scope past a failed effect.
        // Unrelated scopes can continue and reconciliation will retry this one.
        blockedScopes.add(ev.scope);
        getLog().warn('system', 'durable effect enqueue failed', { err, scope: ev.scope, seq: ev.seq });
      }
    }
  };
}

function rowToEvent(row            )                                                                          {
  let handle                                 ;
  try {
    handle = parseEventType(row.eventType          );
  } catch {
    handle = undefined;
  }
  const ev                   = {
    type: row.eventType          ,
    scope: row.scope          ,
    seq: row.seq          ,
    actionId: row.actionId          ,
    committedAt: row.committedAt          ,
    // One log-row decoder (Finding 1): v16 rows go through the strict stored
    // parser here too — durable-effect recovery never sees last-key-wins data.
    data: decodeLogRowData(row)                                  ,
  };
  return handle ? Object.freeze({ ...ev, handle }) : Object.freeze(ev);
}

export async function reconcileDurableEffects(db          , { durableEffectsRegistry, jobs }


 )                                {
  if (!jobs || !durableEffectsRegistry || durableEffectsRegistry.size === 0) return { enqueued: 0 };
  let enqueued = 0;
  await sweepBehindCursor(db, CONSUMER, async (row) => {
    const ev = rowToEvent(row                         );
    const effects = durableEffectsRegistry.get(ev.type);
    if (!effects || effects.length === 0) return 'skip';
    try {
      await enqueueDurableEffectsAndAdvance(db, ev, effects, jobs);
      enqueued += effects.length;
      return 'done';
    } catch (err) {
      getLog().warn('system', 'durable effect recovery failed', { err, scope: ev.scope, seq: ev.seq });
      return 'block';
    }
  });
  return { enqueued };
}
