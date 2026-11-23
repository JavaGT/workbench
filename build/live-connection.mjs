// A live WebSocket connection — socket I/O over `ws`, message routing,
// heartbeat liveness, and the connection lifecycle.
//
// Subscribe-time admission is delegated to live-admission.mjs; subscription
// registration delegates to the injected fanout handle. The transport wiring
// (WebSocket upgrade, CSWSH check, principalOf, heartbeat timer) stays in
// live-delivery-websocket.mjs.

import { DEFAULT_WS_MAX_PAYLOAD,                                    } from './websocket.mjs';
import { authorizeSubscription, parseSubscribeMsg } from './live-admission.mjs';
import { failure, isWorkbenchFailure, sanitizeUnexpectedFailure } from './outcome.mjs';
import { anonymous } from './principal.mjs';






const WS_OPEN = 1;
const WS_CLOSED = 3;

function requestIdOf(msg                         )                              {
  const value = msg?.requestId;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
  return undefined;
}

function rawDataToUtf8(data         )         {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8');
  return Buffer.from(data).toString('utf-8');
}

// Keep a stalled peer from turning the socket write buffer into an unbounded
// per-connection allocation. A peer that exceeds this budget is disconnected
// and can recover through its normal cursor resubscribe.
const DRAIN_TIMEOUT_MS = 30_000;
const CLOSE_HANDSHAKE_GRACE_MS = 250;






















export class LiveConnection {
  #ws                 ;
  #id        ;
  #closed = false;
  #closing = false;
  #alive = true;
  #closePromise                       = null;
  #principal                  ;
  #fanout                  ;
  #core                         ;
  #resolveEntity                                                                ;
  #mayVerb                ;
  #authorization                             ;
  #db                     ;
  #currentSeq                           ;
  #onClose                     ;
  #log                     ;
  #carets                        ;
  #coreAcs                              ;
  #coreActivations                             ;
  #coreGen                     ;
  #maxBufferedBytes        ;

  constructor(ws                 , id        , {
    fanout,
    core = null,
    resolveEntity,
    mayVerb,
    authorization = null,
    db,
    currentSeq,
    onClose,
    log = null,
    carets = null,
    maxPayload = DEFAULT_WS_MAX_PAYLOAD,
    maxBufferedBytes,
  }                       ) {
    this.#ws = ws;
    this.#id = id;
    this.#principal = null;
    this.#fanout = fanout;
    this.#core = core;
    this.#resolveEntity = resolveEntity;
    this.#mayVerb = mayVerb;
    this.#authorization = authorization;
    this.#db = db;
    this.#currentSeq = currentSeq;
    this.#onClose = onClose;
    this.#log = log;
    this.#carets = carets;
    this.#coreAcs = new Map();
    this.#coreActivations = new Map();
    this.#coreGen = new Map();
    this.#maxBufferedBytes = maxBufferedBytes ?? Math.max(4 * 1024 * 1024, maxPayload * 2);

    ws.on('message', (data         , isBinary         ) => {
      if (this.#closing || this.#closed || isBinary) return;
      try {
        const parsed = JSON.parse(rawDataToUtf8(data));
        this.#handleMessage(parsed);
      } catch {
        this.error(failure('invalid-input', 'Invalid JSON.'));
      }
    });

    ws.on('pong', () => {
      this.#alive = true;
    });

    ws.on('error', () => {
      void this.#close({ abrupt: true });
    });

    ws.on('close', () => {
      // Mark closing before cleanup so a departing client is not echoed its
      // own caret retraction; ws has already completed the RFC 6455 close ack.
      this.#closing = true;
      void this.#close({ peerClosed: true });
    });
  }

  get id()         { return this.#id; }
  get closed()          { return this.#closed; }
  get principal()                   { return this.#principal; }
  get isAlive()          { return this.#alive; }

  markAlive()       {
    this.#alive = true;
  }

  ping()       {
    if (this.#closed || this.#closing || this.#ws.readyState !== WS_OPEN) return;
    this.#alive = false;
    try {
      this.#ws.ping();
    } catch {
      void this.#close({ abrupt: true });
    }
  }

  close()                { return this.#close(); }

  terminate()                {
    this.#closing = true;
    return this.#close({ abrupt: true });
  }

  setPrincipal(p           )       {
    this.#principal = p;
  }

  send(data         )       {
    if (this.#closed || this.#closing || this.#ws.readyState !== WS_OPEN) return;
    try {
      const payload = JSON.stringify(data);
      const byteLength = Buffer.byteLength(payload);
      if (this.#ws.bufferedAmount + byteLength > this.#maxBufferedBytes) {
        void this.#close({ abrupt: true });
        return;
      }
      this.#ws.send(payload, (err) => {
        if (err) void this.#close({ abrupt: true });
      });
    } catch {
      void this.#close({ abrupt: true });
    }
  }

  #sendAndWait(data         )                {
    if (this.#closed || this.#closing || this.#ws.readyState !== WS_OPEN) {
      return Promise.reject(new Error('live connection closed'));
    }
    const payload = JSON.stringify(data);
    const byteLength = Buffer.byteLength(payload);
    if (this.#ws.bufferedAmount + byteLength > this.#maxBufferedBytes) {
      const error = new Error('live connection write queue exceeded its byte limit');
      void this.#close({ abrupt: true });
      return Promise.reject(error);
    }

    return new Promise      ((resolve, reject) => {
      let settled = false;
      const finish = (err          ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#ws.off('close', onClose);
        this.#ws.off('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const onClose = () => finish(new Error('live connection closed while draining'));
      const onError = (err       ) => finish(err);
      const timeout = setTimeout(() => {
        void this.#close({ abrupt: true });
        finish(new Error('live connection drain timed out'));
      }, DRAIN_TIMEOUT_MS);
      timeout.unref?.();

      this.#ws.once('close', onClose);
      this.#ws.once('error', onError);
      try {
        this.#ws.send(payload, (err) => {
          if (err) {
            void this.#close({ abrupt: true });
            finish(err);
          } else {
            finish();
          }
        });
      } catch (err) {
        void this.#close({ abrupt: true });
        finish(err);
      }
    });
  }

  error(workbenchFailure         , requestId                  )       {
    const response                          = {
      type: 'error',
      failure: isWorkbenchFailure(workbenchFailure)
        ? workbenchFailure
        : sanitizeUnexpectedFailure(),
    };
    if (requestId !== undefined) response.requestId = requestId;
    this.send(response);
  }

  #handleMessage(msg                         )       {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.error(failure('invalid-input', 'Message must be an object.'));
      return;
    }
    switch (msg.type) {
      case 'subscribe':
        this.#authorizeAndSubscribe(msg).catch((err) => {
          const requestId = requestIdOf(msg);
          this.#log?.error('live', 'subscription admission failed', {
            err,
            connectionId: this.#id,
            ...(requestId === undefined ? {} : { requestId }),
          });
          this.error(sanitizeUnexpectedFailure(), requestId);
        });
        break;
      case 'unsubscribe':
        this.#handleUnsubscribe(msg);
        break;
      case 'caret.update':
        this.#carets?.update(this, msg).catch(() => this.error(failure('invalid-input', 'Invalid caret update.')));
        break;
      case 'caret.clear':
        this.#carets?.clear(this, msg).catch(() => this.error(failure('invalid-input', 'Invalid caret clear.')));
        break;
      default:
        this.error(
          failure('unknown-action', `Unknown message type: ${String(msg.type)}.`),
          requestIdOf(msg),
        );
    }
  }

  // Advance the per-scope ownership generation and return the new value. Every
  // subscribe request claims the newest generation for its scope before its
  // first await, and an explicit unsubscribe advances it again to invalidate any
  // in-flight request. A request that finds the scope at a higher generation
  // after an await is stale and must only detach its own activation/controller.
  #bumpScopeGen(scope        )         {
    const gen = (this.#coreGen.get(scope) ?? 0) + 1;
    this.#coreGen.set(scope, gen);
    return gen;
  }

  #handleUnsubscribe(msg         )       {
    const normalized = parseSubscribeMsg(msg);
    if (normalized) {
      // A per-scope unsubscribe is genuinely non-terminal: detach the core
      // subscription through its explicit handle without any transport revoke,
      // so the connection and its other scopes stay alive. The AbortSignal is
      // reserved for terminal removal (transport abort, error, auth denial,
      // close/shutdown) and is never used here. The generation bump invalidates
      // any still-pending subscribe: it becomes stale and detaches only its own
      // controller when admission completes, never this scope's newer state.
      this.#bumpScopeGen(normalized.scope);
      this.#carets?.removeConnection(this, normalized.scope).catch(() => {});
      this.#fanout.removeSubscription(normalized.scope, this);
      const activation = this.#coreActivations.get(normalized.scope);
      activation?.unsubscribe?.();
      this.#coreActivations.delete(normalized.scope);
      // The controller in the scope map belongs to the winner (or to a request
      // still pending inside core.subscribe). Detaching the winner's activation
      // first removed the core's abort listener, so aborting its controller is
      // an idempotent no-op that cannot trigger a transport revoke — the
      // ordering is what keeps a per-scope unsubscribe genuinely non-terminal.
      // A still-pending request has no subscription installed yet, so aborting
      // its controller simply cancels its in-flight core admission; its own
      // stale branch then completes silently. Every detached controller is
      // aborted exactly once here or by its owning request's stale branch.
      this.#coreAcs.get(normalized.scope)?.abort();
      this.#coreAcs.delete(normalized.scope);
      const response                          = { type: 'unsubscribed', scope: normalized.scope };
      if (normalized.interest.entity) response.entity = normalized.interest.entity;
      if (normalized.interest.id !== undefined) response.id = normalized.interest.id;
      this.send(response);
    }
  }

  async #authorizeAndSubscribe(msg         )                {
    const requestId = requestIdOf(msg                           );
    // Per-scope ownership fence. The generation is claimed before the first
    // await so arrival order decides the winner: a later subscribe for the same
    // scope — and any explicit unsubscribe — supersedes requests still in
    // flight. Every post-await mutation below re-checks ownsScope() and, when
    // stale, detaches only this request's own activation/controller — never the
    // newer owner's state, ack, or fan-out registration.
    const normalized = parseSubscribeMsg(msg);
    const pendingScope = normalized?.scope;
    const scopeGen = pendingScope === undefined ? 0 : this.#bumpScopeGen(pendingScope);
    const ownsScope = () => pendingScope === undefined || this.#coreGen.get(pendingScope) === scopeGen;

    const result = await authorizeSubscription(msg, this, {
      resolveEntity: this.#resolveEntity,
      mayVerb: this.#mayVerb,
      authorization: this.#authorization ?? undefined,
      db: this.#db,
      fanout: this.#fanout,
    });
    if (!result.admitted) {
      // A superseded request reports nothing: its outcome is noise to a client
      // that already moved on to the newer owner.
      if (ownsScope()) this.error(result.failure, requestId);
      return;
    }
    // A newer subscribe or an explicit unsubscribe superseded us during
    // admission. We never installed anything, so detach nothing and send no ack.
    if (!ownsScope()) return;

    const scope = result.scope;
    let activateCore                                             = null;
    let coreSubscription                        = null;
    // This request's OWN controller. The scope map (#coreAcs) holds only the
    // current owner's controller, so a newer same-scope request overwrites the
    // map — this local reference is the only handle a stale request has to
    // cancel exactly its own work. Every branch below that detaches its own
    // subscription also aborts this controller, ordered AFTER the detach so the
    // abort is an idempotent no-op that cannot reach the transport revoke.
    let requestController                         = null;

    // Subscribe to the core for committed-event delivery BEFORE sending the
    // subscribed ack. If core subscription fails, we remove the fanout
    // registration and send only an error — no ack reaches the client.
    if (this.#core) {
      // A resubscribe replaces the previous subscription for this scope. That
      // is non-terminal for the connection: detach the old subscription through
      // its explicit handle instead of aborting, so no revoke error reaches the
      // client. A still-pending older subscribe has no handle yet; the
      // ownership fence below detaches it without revoke when it completes.
      const previousActivation = this.#coreActivations.get(scope);
      if (previousActivation) {
        previousActivation.unsubscribe?.();
        this.#coreActivations.delete(scope);
        this.#fanout.removeSubscription(scope, this);
        // The replaced controller belongs to the previous owner and its abort
        // listener was removed by the detach above, so aborting it is an
        // idempotent no-op that cannot trigger a transport revoke.
        this.#coreAcs.get(scope)?.abort();
      }
      const ac = new AbortController();
      requestController = ac;
      this.#coreAcs.set(scope, ac);
      try {
        coreSubscription = (await this.#core.subscribe({
          principal: this.#principal ?? anonymous,
          scope,
          after: this.#currentSeq(scope),
          rule: result.interest.rule         ,
          signal: ac.signal,
          paused: true,
          deliver: async (batch) => {
            // Envelope-kind parity is inherited from the shared core: every
            // kind the SSE seam presents (`event`/`state`/`state-invalidate`/
            // `resync`) is forwarded verbatim, one frame per envelope. No
            // kind-specific reshaping happens on this transport, so SSE and
            // WebSocket can never diverge on tier/admission/recovery/confirmation.
            if (this.#closed) throw new Error('live connection closed');
            for (const envelope of batch) {
              if (this.#closed) throw new Error('live connection closed');
              await this.#sendAndWait(envelope);
            }
          },
          revoke: () => {
            // A reauthorization failure after acknowledgement is terminal for
            // this recipient — but only while this request still owns the
            // scope. A newer owner or an explicit unsubscribe has (or will
            // have) its own terminal handling; reporting here would clobber the
            // winner. The revoke also advances the generation, so this
            // request's own post-await continuation reports nothing further:
            // terminal reporting has already happened, exactly once.
            if (!ownsScope()) return;
            this.#coreAcs.delete(scope);
            this.#coreActivations.delete(scope);
            this.#fanout.removeSubscription(scope, this);
            ac.abort();
            this.#bumpScopeGen(scope);
            this.error(failure('denied', 'Subscription revoked.'), requestId);
          },
        })) ?? null;
        activateCore = coreSubscription?.activate ?? null;
        if (ac.signal.aborted) return;
        // Register our own activation only while this request still owns the
        // scope; a stale request must never overwrite the winner's entry.
        if (coreSubscription && ownsScope()) this.#coreActivations.set(scope, coreSubscription);
      } catch (err) {
        // The core already removed its own subscription (or never installed
        // one), so the detach no-ops and the abort below is an idempotent
        // no-op that cannot reach the transport revoke. It fires exactly once
        // for this request's controller whether this request is stale or the
        // owner, and never touches a newer winner's controller.
        coreSubscription?.unsubscribe?.();
        ac.abort();
        if (!ownsScope()) return;
        this.#coreAcs.delete(scope);
        this.#coreActivations.delete(scope);
        this.#fanout.removeSubscription(scope, this);
        this.#log?.error?.('live', 'core subscription failed', { scope, err: String(err) });
        this.error(failure('denied', 'Subscription failed.'), requestId);
        return;
      }
      // A newer subscribe or an explicit unsubscribe owns this scope now —
      // detach only our own subscription without revoke, then abort our own
      // controller (an idempotent no-op after the detach). The winner (or
      // connection close) handles terminal teardown. Never leave an active
      // paused subscription.
      if (!ownsScope()) {
        coreSubscription?.unsubscribe?.();
        ac.abort();
        return;
      }
    }

    try {
      // Fanout owns the connection-scoped collection cap. Register before the
      // acknowledgement so the check and registration are one synchronous step.
      this.#fanout.addSubscription(scope, this, result.fields, result.pace, { ...result.interest, carets: result.carets });
    } catch {
      coreSubscription?.unsubscribe?.();
      requestController?.abort();
      this.#coreAcs.delete(scope);
      this.#coreActivations.delete(scope);
      this.error(failure('conflict', 'Too many collection subscriptions are active.'), requestId);
      return;
    }

    const response                          = {
      type: 'subscribed',
      scope,
      currentSeq: this.#currentSeq(scope),
    };
    if (requestId !== undefined) response.requestId = requestId;
    if (result.entityName) response.entity = result.entityName;
    if (result.id !== undefined) response.id = result.id;
    this.send(response);

    if (activateCore) {
      try {
        await activateCore();
      } catch (err) {
        // A core activation rejection only ever surfaces through the core's
        // terminal removal path, whose revoke callback (when this request still
        // owned the scope) already reported and advanced the generation. If we
        // no longer own the generation — a newer owner superseded us, or the
        // revoke already handled terminal reporting — reporting again here
        // would emit a second terminal frame. Detach and abort only this
        // request's own subscription/controller first (both no-ops when the
        // terminal path already ran), so a rejection without a core revoke
        // still aborts this request's own controller exactly once.
        coreSubscription?.unsubscribe?.();
        requestController?.abort();
        if (!ownsScope()) return;
        this.#coreAcs.delete(scope);
        this.#coreActivations.delete(scope);
        this.#fanout.removeSubscription(scope, this);
        this.#log?.error?.('live', 'core activation failed', { scope, err: String(err) });
        this.error(failure('denied', 'Subscription failed.'), requestId);
        return;
      }
    }
    if (!ownsScope()) {
      // Superseded while our activation ran: the winner already detached our
      // activation (or this no-ops), and the detach came first, so aborting our
      // own controller is an idempotent no-op that cannot reach a revoke. No
      // stale cancellation handle outlives the request.
      coreSubscription?.unsubscribe?.();
      requestController?.abort();
      return;
    }
    if (this.#coreAcs.get(scope) === undefined) this.#fanout.removeSubscription(scope, this);
  }

  #close(options                                             )                {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#performClose(options);
    return this.#closePromise;
  }

  async #performClose({ abrupt = false, peerClosed = false } = {})                {
    if (this.#closed) return;
    // Remove the connection from the transport registry synchronously. The
    // returned promise still waits for caret retraction and socket cleanup,
    // but callers observing count() during shutdown must not see a closing
    // connection as live. Do not set #closing until after cleanup: send()
    // drops frames while #closing, and shutdown must flush the caret remove
    // before the socket closes. Peer close already sets #closing first so a
    // departing client is not echoed its own retraction.
    this.#onClose?.();
    await this.#cleanup();
    this.#closing = true;
    this.#closed = true;

    if (abrupt || peerClosed) {
      if (this.#ws.readyState !== WS_CLOSED) {
        try { this.#ws.terminate(); } catch { /* ignore */ }
      }
      return;
    }

    // Server-initiated close: issue a clean RFC 6455 close handshake via `ws`
    // (which flushes any previously queued send() frames such as caret remove
    // before sending the close frame), then wait briefly for the peer's close
    // ack before terminating so shutdown never hangs on unresponsive peers.
    if (this.#ws.readyState === WS_OPEN) {
      await new Promise      ((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#ws.off('close', done);
          this.#ws.off('error', done);
          resolve();
        };
        const timer = setTimeout(() => {
          try { this.#ws.terminate(); } catch { /* ignore */ }
          done();
        }, CLOSE_HANDSHAKE_GRACE_MS);
        timer.unref?.();
        this.#ws.once('close', done);
        this.#ws.once('error', done);
        try {
          this.#ws.close(1000, '');
        } catch {
          try { this.#ws.terminate(); } catch { /* ignore */ }
          done();
        }
      });
    } else if (this.#ws.readyState !== WS_CLOSED) {
      try { this.#ws.terminate(); } catch { /* ignore */ }
    }
  }

  async #cleanup()                {
    for (const ac of this.#coreAcs.values()) {
      ac.abort();
    }
    // Connection teardown is terminal for every in-flight request: advance each
    // scope's generation so a pending subscribe continuation never reports or
    // mutates state on a closed connection.
    for (const scope of [...this.#coreGen.keys()]) {
      this.#bumpScopeGen(scope);
    }
    this.#coreAcs.clear();
    this.#coreActivations.clear();
    this.#fanout.removeAll(this);
    await this.#carets?.removeConnection(this).catch(() => {});
  }
}
