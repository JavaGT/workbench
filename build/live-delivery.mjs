// Live Delivery — singular public seam for the Deliver loop (SPEC §8).
//
// One factory: createWebSocketLiveDelivery(httpServer, opts) →
//   { count, close, createConsumer, wake }
//
// Owns: the committed-event delivery core (live-delivery-core), the shared
// envelope builder, and the consumer seam the kernel registers. The WebSocket
// upgrade, connection lifecycle, ephemeral fan-out, and caret presence are
// delegated to the extracted transport (live-delivery-websocket) over this
// seam's own core — one committed authority, transport is a skin.
//
// The committed post-commit consumer (createConsumer) only wakes core; the core
// re-reads the _Log, re-authorises, projects, and delivers to WebSocket
// subscribers. The ephemeral fan-out remains distinct for non-_Log events and
// pacing; there is one committed authority (core).
//
// wake(scope) is exposed for callers (e.g. serve.mjs job-event bridge) that
// need to trigger core delivery without going through the post-commit consumer.
//
// Internals (live-fanout, live-connection, live-admission, websocket) stay
// private implementation of this seam — callers do not import them for wiring.



import { createLiveDeliveryCore } from './live-delivery-core.mjs';

import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';
import { createLiveDeliveryWebSocket } from './live-delivery-websocket.mjs';
import { projectRowForRecipient } from './entity/projection.mjs';
import { readableFieldNames } from './field-admission.mjs';






/**
 * Create the Live Delivery subsystem and attach it to an HTTP server.
 *
 * @param {import('node:http').Server} httpServer
 * @param {object} [options]
 * @param {string} [options.path='/events']
 * @param {Function|null} [options.mayVerb] — same engine REST uses
 * @param {Function} [options.principalOf] — same principal resolver HTTP uses
 * @param {object|null} [options.db]
 * @param {Function|null} [options.resolveEntity] — name → entity record
 * @param {Function} [options.ready] — resolves when protocol admission is safe
 * @param {object|null} [options.log] — application-owned structured logger
 * @returns {{ count: Function, close: Function, createConsumer: Function, wake: Function, core: LiveDeliveryCore }}
 */
export function createWebSocketLiveDelivery(httpServer        , {
  path = '/events',
  mayVerb = null,
  authorization = null,
  principalOf = (() => ({ type: 'anonymous', id: null })             ),
  db = null,
  resolveEntity = null,
  ready = () => Promise.resolve(),
  log = null,
}








  = {}) {
  // Stateless fallback is retained for callers that do not subscribe through
  // the core. Stateful builders are created per subscription below.
  const envelopeBuilder = createLiveEnvelopeBuilder();

  const projectRecipient = async (ctx                    , builder                                              ) => {
    let readableFields                                 ;
    let row = ctx.row;
    if (row) {
      readableFields = await readableFieldNames(ctx.entity         , row, ctx.principal, authorization);
      row = await projectRowForRecipient(ctx.entity         , row, ctx.principal, { readable: readableFields, authorization });
    }
    return builder.buildEnvelope({ ...ctx, row, readableFields }                                                          );
  };

  // Committed-event delivery core — the single authority for committed events.
  // Each subscription gets its own stateful builder for delta/reducer parity
  // after recipient read projection has confined fields to readable data.
  const core                   = createLiveDeliveryCore({
    db: db                ,
    entities: resolveEntity ? (name        ) => resolveEntity(name)                                 : new Map(),
    mayVerb,
    authorization,
    projectRecipient: (ctx) => projectRecipient(ctx, envelopeBuilder),
    createProjectRecipient: () => {
      const builder = createLiveEnvelopeBuilder();
      return (ctx) => projectRecipient(ctx, builder);
    },
    log,
  });

  // The WebSocket transport is a pure upgrade skin over the SAME core. It owns
  // its own ephemeral fan-out and caret presence; the committed authority stays
  // here with the envelope builder.
  const wsTransport = createLiveDeliveryWebSocket(httpServer, {
    path,
    core,
    principalOf,
    resolveEntity,
    mayVerb,
    authorization,
    db,
    ready,
    log,
  });

  function count()         {
    return wsTransport.count();
  }

  async function close()                {
    core.close();
    envelopeBuilder.clear();
    await wsTransport.close();
  }

  function wake(scope        )       {
    core.wake(scope);
  }

  /**
   * Post-commit consumer for the durable pipeline. Only wakes the core — the
   * core re-reads _Log, re-authorises, projects, and delivers. No longer emits
   * directly through the fan-out (the fan-out is for non-_Log events only).
   */
  function createConsumer()                                                       {
    const woken = new Set        ();
    return async (events) => {
      woken.clear();
      for (const ev of events) {
        if (!ev.scope) continue;
        if (woken.has(ev.scope)) continue;
        woken.add(ev.scope);
        core.wake(ev.scope);
      }
    };
  }

  return {
    count,
    close,
    createConsumer,
    wake,
    // The one committed authority behind this transport. Published so a second
    // transport skin (e.g. createBunServerHandlers) can reuse it instead of
    // building a second core over an already-listening app.
    core,
  };
}

/** @deprecated Use createWebSocketLiveDelivery — same function. */
export const createLiveServer = createWebSocketLiveDelivery;
