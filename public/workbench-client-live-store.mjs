// workbench-client-live-store.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { install0 } from './workbench-client-live-store-ops-1.mjs';
import { install1 } from './workbench-client-live-store-ops-2.mjs';
import { install2 } from './workbench-client-live-store-ops-3.mjs';

export function createLiveStore({ baseUrl, name, path, channel, fetchImpl, replicaState, sendMutation }) {
  const S = {
  baseUrl,
  name,
  path,
  channel,
  fetchImpl,
  replicaState,
  sendMutation,
  };
  install0(S);
  install1(S);
  install2(S);
return S.store;
}
