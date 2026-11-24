// workbench-client-live-channel.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { LiveSyncSession } from './workbench-client-live-sync.mjs';

// Public façade. The state machine stays private so transport lifecycle details
// do not become package API, while existing LiveChannel consumers retain the
// small subscribe/unsubscribe/close surface.
export class LiveChannel extends LiveSyncSession {}
