// Framework-owned browser SDK endpoint, served from public/ and build/.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


import {                                           reject } from './http-routes-shared.mjs';

// Framework-owned browser SDK endpoint: `GET /workbench.mjs` serves the client
// side of the /events live protocol. Resolved relative to the repo root (this
// module sits one directory deep in both src/ and build/, and import.meta.url
// resolves to the emitted copy in build/), never process.cwd(). Only engaged
// when a db is present (the live kernel is running); a db-less app has no live
// protocol and falls through. Returns true when handled; false to fall through.
// The two emitted annotated-text leaves are served from build/; the browser
// SDK surface is hand-maintained under public/.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_SDK_PATH = join(root, 'public', 'workbench-client.mjs');
const ANNOTATED_TEXT_SDK_PATH = join(root, 'build', 'annotated-text.mjs');
const TEXT_EDIT_SDK_PATH = join(root, 'public', 'workbench-text-edit.mjs');
const ANNOTATED_TEXT_SNAPSHOT_SDK_PATH = join(root, 'public', 'workbench-annotated-text-snapshot.mjs');
const ANNOTATED_TEXT_SNAPSHOT_INTERNAL_SDK_PATH = join(root, 'public', 'workbench-annotated-text-snapshot-internal.mjs');
const ANNOTATED_TEXT_REDACTION_COORDS_SDK_PATH = join(root, 'public', 'workbench-annotated-text-redaction-coords.mjs');
const ANNOTATED_TEXT_ACTION_SDK_PATH = join(root, 'build', 'annotated-text-action-builder.mjs');
const ANNOTATED_TEXT_EDITOR_SDK_PATH = join(root, 'public', 'workbench-annotated-text-editor.mjs');
const ANNOTATED_TEXT_CONTINUOUS_SDK_PATH = join(root, 'public', 'workbench-annotated-text-continuous.mjs');
const UI_BINDINGS_SDK_PATH = join(root, 'public', 'workbench-ui-bindings.mjs');

// The split browser SDK modules. The barrel at /workbench.mjs imports these by
// exact relative path; each is served from public/ under the same strict
// allowlist. The names are closed (never derived from req.url), so a path like
// /workbench-client-../../etc/passwd cannot resolve to an arbitrary file.
const CLIENT_SDK_SPLIT_FILES = Object.freeze([
  'workbench-client-annotated-http-ops-1.mjs',
  'workbench-client-annotated-http-ops-2.mjs',
  'workbench-client-annotated-http-ops-3.mjs',
  'workbench-client-annotated-http.mjs',
  'workbench-client-auth.mjs',
  'workbench-client-core.mjs',
  'workbench-client-delivery-http.mjs',
  'workbench-client-delivery-ops-1.mjs',
  'workbench-client-delivery-ops-2.mjs',
  'workbench-client-delivery-ops-3.mjs',
  'workbench-client-delivery-ops-4.mjs',
  'workbench-client-delivery-ops-5.mjs',
  'workbench-client-delivery.mjs',
  'workbench-client-errors.mjs',
  'workbench-client-live-channel.mjs',
  'workbench-client-live-list-methods-1.mjs',
  'workbench-client-live-list-methods-2.mjs',
  'workbench-client-live-list.mjs',
  'workbench-client-live-store-ops-1.mjs',
  'workbench-client-live-store-ops-2.mjs',
  'workbench-client-live-store-ops-3.mjs',
  'workbench-client-live-store.mjs',
  'workbench-client-live-sync-methods.mjs',
  'workbench-client-live-sync.mjs',
  'workbench-client-replica.mjs',
  'workbench-client-scope-store.mjs',
  'workbench-client-vendor-idb.mjs',
  'workbench-client-vendor-msgpackr.mjs',
  'workbench-client-vendor-xstate.mjs',
]);
const CLIENT_SDK_SPLIT_PATHS = new Map(
  CLIENT_SDK_SPLIT_FILES.map((file) => [`/${file}`, join(root, 'public', file)]),
);

export function handleClientSdkRoute(
  app                                 ,
  req                  ,
  res                  ,
)          {
  if (req.method !== 'GET') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/workbench-annotated-text.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-text-edit.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(TEXT_EDIT_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-snapshot.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_SNAPSHOT_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-continuous.mjs') {
    if (!app || !app.db) return false;
    // Browser port of the blockless continuous family (issue #33). Its imports
    // already name the browser SDK paths (./workbench-annotated-text.mjs,
    // ./workbench-annotated-text-family.mjs), so no rewrite is needed.
    const body = readFileSync(ANNOTATED_TEXT_CONTINUOUS_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-snapshot-internal.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_SNAPSHOT_INTERNAL_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-redaction-coords.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_REDACTION_COORDS_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-action.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_ACTION_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-annotated-text-editor.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(ANNOTATED_TEXT_EDITOR_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname === '/workbench-ui-bindings.mjs') {
    if (!app || !app.db) return false;
    const body = readFileSync(UI_BINDINGS_SDK_PATH);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  const splitPath = CLIENT_SDK_SPLIT_PATHS.get(url.pathname);
  if (splitPath !== undefined) {
    if (!app || !app.db) return false;
    const body = readFileSync(splitPath);
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (url.pathname !== '/workbench.mjs') return false;
  if (!app || !app.db) return false;
  let body        ;
  try {
    body = readFileSync(CLIENT_SDK_PATH);
  } catch {
    reject(res, 404, 'not found');
    return true;
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
  return true;
}
