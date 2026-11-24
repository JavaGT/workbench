// workbench-client-live-store-ops-3.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
export function install2(S) {
S._listUnsubs = new Map();
S._listChangeUnsubs = new Map();
S._listStatusUnsubs = new Map();
S._actionRoutes = new Map();
S._textSendChains = new Map();
S._textAllocationChains = new Map();
S._textDraftStates = new Map();
S._closed = false;
S.store = {
    subscribe: S._subscribeLiveList,
    /** Cached LiveList for an id, or null — peek without creating a subscription. */
    listFor(id) { return S._listCache.get(id) ?? null; },
    /** Release a list created via subscribe when its last owning binding leaves. */
    release: S.releaseLiveList,
    /** Ids of every cached LiveList — read-only input for collection bindings. */
    listIds() { return [...S._listCache.keys()]; },
    dispatch: S.dispatch,
    create(payload) { return S.dispatch(`${S.name}.create`, payload); },
    update(id, payload) { return S.dispatch(`${S.name}.update`, { id, ...payload }); },
    remove(id) { return S.dispatch(`${S.name}.remove`, { id }); },
    apply(id, field, operation) { return S.dispatch(`${S.name}.${field}.apply`, { id, operation }); },
    text: S.text,
    retryText: S.retryText,
    action: S.action,
    close: S.close,
    overlayFor: S.overlayFor,
    overlayStatusFor: S.overlayStatusFor,
    pendingCreates: S.pendingCreates,
    onRender(cb) {
      S._renderCallbacks.add(cb);
      return () => S._renderCallbacks.delete(cb);
    },
    /** Fine-grained fold records forwarded from every cached LiveList. */
    onChange(cb) {
      S._changeCallbacks.add(cb);
      return () => S._changeCallbacks.delete(cb);
    },
    /** Delivery-status transitions: `(status, id)` for the originating list. */
    onStatusChange(cb) {
      S._statusCallbacks.add(cb);
      return () => S._statusCallbacks.delete(cb);
    },
  };
}
