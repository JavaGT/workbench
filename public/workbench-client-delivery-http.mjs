// workbench-client-delivery-http.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { SNAPSHOT_PATCH_CAPABILITY } from './workbench-client-core.mjs';
import { createLiveDeliverySession } from './workbench-client-delivery.mjs';
import { normalizeFailure } from './workbench-client-errors.mjs';

/**
 * Connect the package-owned recovery session to its HTTP/SSE delivery skin.
 * Applications supply their recipient snapshot validator/fold and action
 * sender, never event replay, cursor, or transport recovery callbacks.
 */
export function createLiveDeliveryHttpSession({
  baseUrl,
  scope,
  validateSnapshot,
  fold,
  optimistic,
  sendAction,
  serializeAction,
  sendBatch,
  actionUrl,
  historySession,
  fetchImpl = globalThis.fetch,
  eventSourceFactory = (url, options) => new EventSource(url, options),
  createActionId,
  onRecoveryStart,
  onRecoveryDelayed,
  requestIdentity = null,
}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('baseUrl is required');
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('scope is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (typeof eventSourceFactory !== 'function') throw new TypeError('eventSourceFactory is required');
  if (typeof historySession !== 'string' || historySession.length === 0) throw new TypeError('historySession is required');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/bootstrap`;
  const eventsEndpoint = `${baseUrl.replace(/\/$/, '')}/events`;
  // The action endpoint belongs to the configured Workbench origin, not the
  // browser document origin which may host a separate frontend application.
  const actionEndpoint = actionUrl ?? new URL('/workbench/actions', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();
  const batchActionEndpoint = new URL('/workbench/actions/batch', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();
  const historyEndpoint = new URL('/workbench/history', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();

  async function bootstrap({ after, mode, projectionToken, signal }) {
    const url = new URL(endpoint, globalThis.location?.href ?? 'http://workbench.local');
    if (!requestIdentity) url.searchParams.set('scope', scope);
    for (const [key, value] of Object.entries(requestIdentity ?? {})) url.searchParams.set(key, value);
    url.searchParams.set('mode', mode);
    // Capability advertisement (#156): every bootstrap offers snapshot-patch
    // support. Catch-up presents the held projectionToken so a patch-capable
    // server can serve journal patches; both fields are additive and ignored
    // by legacy servers (byte-identical legacy requests otherwise).
    url.searchParams.set('capabilities', SNAPSHOT_PATCH_CAPABILITY);
    if (mode === 'catchup') {
      url.searchParams.set('after', typeof after === 'object' ? JSON.stringify(after) : String(after));
      if (typeof projectionToken === 'string') url.searchParams.set('projectionToken', projectionToken);
    }
    let response;
    try {
      // The signal is this connection generation's cancellation handle. An
      // aborted request is a retryable transport outcome, exactly like a
      // network failure: it must never masquerade as a terminal verdict.
      response = await fetchImpl(url.toString(), signal ? { credentials: 'include', signal } : { credentials: 'include' });
    } catch {
      return { kind: 'retry' };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'revoked' };
    if (response.status >= 500) return { kind: 'retry' };
    if (!response.ok) throw new Error(`live delivery bootstrap failed with HTTP ${response.status}: ${await response.text()}`);
    const result = await response.json();
    if (!result || typeof result !== 'object' || !['snapshot', 'catchup', 'retry', 'revoked'].includes(result.kind)) {
      throw new Error('live delivery bootstrap returned an invalid response');
    }
    return result;
  }

  function subscribe({ after, deliver, closed, projectionToken: heldToken }) {
    const url = new URL(eventsEndpoint, globalThis.location?.href ?? 'http://workbench.local');
    if (!requestIdentity) url.searchParams.set('scope', scope);
    for (const [key, value] of Object.entries(requestIdentity ?? {})) url.searchParams.set(key, value);
    url.searchParams.set('after', typeof after === 'object' ? JSON.stringify(after) : String(after));
    // Capability advertisement (#156): the stream may carry snapshot-patch
    // envelopes for a patch-capable server. Additive query parameter. The
    // held projection token rides along (#159 round-3) so a host emitting
    // patches over the stream has the recipient's ledger handle.
    url.searchParams.set('capabilities', SNAPSHOT_PATCH_CAPABILITY);
    if (typeof heldToken === 'string' && heldToken.length > 0) url.searchParams.set('projectionToken', heldToken);
    const source = eventSourceFactory(url.toString(), { withCredentials: true });
    let open = true;
    source.onmessage = (message) => {
      if (!open) return;
      let envelopes;
      try { envelopes = JSON.parse(message.data); } catch { source.close(); closed(); return; }
      Promise.resolve(deliver(envelopes)).catch(() => { source.close(); closed(); });
    };
    source.onerror = () => {
      if (!open) return;
      open = false;
      source.close();
      closed();
    };
    return Promise.resolve({ close() { open = false; source.close(); } });
  }

  async function sendHttpAction(action) {
    const historyCommand = action.type === '$history.undo' ? 'undo'
      : action.type === '$history.redo' ? 'redo' : null;
    const historyPayload = action.payload;
    const historyRequest = historyCommand && historyPayload && typeof historyPayload === 'object'
      ? { actionId: action.actionId, command: historyCommand, ...historyPayload,
          ...(requestIdentity ? { document: requestIdentity } : { scope }) }
      : null;
    const response = await fetchImpl(historyRequest ? historyEndpoint : actionEndpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(historyRequest ?? { ...action, ...(requestIdentity ? { document: requestIdentity } : { scope }), clientId: historySession }),
    });
    let receipt;
    try { receipt = await response.json(); } catch {
      if (!response.ok) return { ok: false, failure: normalizeFailure(new Error(`action dispatch failed with HTTP ${response.status}`)) };
      throw new Error(`action dispatch failed with HTTP ${response.status}`);
    }
    if (!response.ok) return receipt?.ok === false ? receipt : { ok: false, failure: receipt };
    if (!receipt || receipt.ok !== true) throw new Error('action dispatch returned an invalid receipt');
    return receipt;
  }

  async function sendHttpBatch(batch) {
    const response = await fetchImpl(batchActionEndpoint, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...batch, ...(requestIdentity ? { document: requestIdentity } : { scope }), clientId: historySession }),
    });
    let receipt;
    try { receipt = await response.json(); } catch {
      if (!response.ok) return { ok: false, failure: normalizeFailure(new Error(`batch dispatch failed with HTTP ${response.status}`)) };
      throw new Error(`batch dispatch failed with HTTP ${response.status}`);
    }
    if (!response.ok) return receipt?.ok === false ? receipt : { ok: false, failure: receipt };
    if (!receipt || receipt.ok !== true || receipt.actionId !== batch.actionId) throw new Error('batch dispatch returned an invalid receipt');
    return receipt;
  }

  let actionTail = Promise.resolve();
  const transportAction = (action) => action.type.startsWith('$history.')
    ? sendHttpAction(action)
    : (sendAction ?? sendHttpAction)(action);
  const session = createLiveDeliverySession({
    bootstrap,
    subscribe,
    validateSnapshot,
    fold,
    optimistic,
    sendAction: (action) => {
      if (!serializeAction?.(action)) return transportAction(action);
      const pending = actionTail.then(() => transportAction(action));
      actionTail = pending.catch(() => {});
      return pending;
    },
    sendBatch: sendBatch ?? sendHttpBatch,
    createActionId,
    onRecoveryStart,
    onRecoveryDelayed,
    isFoldableEcho: (action) => serializeAction?.(action) === true,
  });
  // History commands use the same receipt/snapshot reconciliation path as an
  // application action. The server resolves this authenticated session's
  // current cursor within its write queue; raw revisions never leave it.
  Object.defineProperty(session, 'history', { value: Object.freeze({
    undo: () => session.dispatch('$history.undo', { session: historySession }),
    redo: () => session.dispatch('$history.redo', { session: historySession }),
  }) });
  return session;
}
/**
 * Snapshot-only client for a principal-anchored projection. The package owns
 * its cursor, reconnect, and opaque-resync replacement; hosts receive no event
 * reducer, mutation, optimistic-state, or cursor configuration seam.
 */
export function createPrincipalSnapshotHttpSession({
  baseUrl,
  declaration,
  principal,
  validateSnapshot,
  fetchImpl,
  eventSourceFactory,
}) {
  if (typeof declaration !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(declaration)) {
    throw new TypeError('principal snapshot declaration is invalid');
  }
  if (!principal || !['user', 'link', 'system', 'apiKey'].includes(principal.type)
    || typeof principal.id !== 'string' || principal.id.length === 0) {
    throw new TypeError('principal snapshot principal is invalid');
  }
  if (typeof validateSnapshot !== 'function') throw new TypeError('validateSnapshot is required');
  const scope = `PrincipalSnapshot:${declaration}/${principal.type}/${encodeURIComponent(principal.id)}`;
  const session = createLiveDeliveryHttpSession({
    baseUrl,
    scope,
    validateSnapshot,
    fetchImpl,
    eventSourceFactory,
    historySession: 'principal-snapshot',
    sendAction: async () => { throw new Error('principal snapshot sessions do not dispatch actions'); },
  });
  return Object.freeze({
    get snapshot() { return session.snapshot; },
    get status() { return session.status; },
    get ready() { return session.ready; },
    subscribe(listener) { return session.subscribe(listener); },
    reconnect() { return session.reconnect(); },
    close() { session.close(); },
  });
}
