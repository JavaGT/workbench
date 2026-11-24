// workbench-client-annotated-http.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { install0 } from './workbench-client-annotated-http-ops-1.mjs';
import { install1 } from './workbench-client-annotated-http-ops-2.mjs';
import { install2 } from './workbench-client-annotated-http-ops-3.mjs';

export function createAnnotatedTextHttpSession({ baseUrl, context, historySession, fetchImpl, eventSourceFactory, createActionId, onRecoveryDelayed, onFoldApplied, carets, typingBurstIdleMs = 75, typingBurstMaxMs = 150 }) {
  const S = {
  baseUrl,
  context,
  historySession,
  fetchImpl,
  eventSourceFactory,
  createActionId,
  onRecoveryDelayed,
  onFoldApplied,
  carets,
  typingBurstIdleMs,
  typingBurstMaxMs,
  };
  install0(S);
  install1(S);
  install2(S);
return Object.freeze(S.annotatedSurface);
}
