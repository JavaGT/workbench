// Framework-owned HTTP routes — thin barrel over the route families.
//
// These are NOT mounted routes: they are framework defaults intercepted before
// route matching in the request handler, like /health. Auth runs through the
// SAME engine as REST (mayVerb / mayRow / readScope), not a second path.
//
// The families are: resync (snapshot / events-since), blobs (upload / authorized
// media), jobs, SDK (including /workbench-annotated-text-action.mjs, whose
// builder is emitted from build/annotated-text-action-builder.mjs), query, and
// search. This barrel keeps every existing import path stable.

export type { FrameworkApp, FrameworkRequest } from './http-routes-shared.ts';
export type { BlobUploadRouteOptions } from './http-routes-blobs.ts';
export { handleResyncRoute } from './http-routes-resync.ts';
export { handleBlobUploadRoute, handleBlobReadRoute } from './http-routes-blobs.ts';
export { workerMachinePrincipal, handleJobRoute } from './http-routes-jobs.ts';
export { handleClientSdkRoute } from './http-routes-sdk.ts';
export {
  handleQueryRoute,
  handleQueryFamilyRoute,
  ensureQueryInvalidationHub,
  handleQueryInvalidationRoute,
} from './http-routes-query.ts';
export { handleSearchRoute } from './http-routes-search.ts';
