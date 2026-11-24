// Framework-owned job-queue endpoints (worker bearer is its own wire
// credential; worker identity is still a typed machine principal).

import { BodyError, readRequestBody } from './http-body.ts';
import { sendJson, type HttpResponseLike } from './http-response.ts';
import { machinePrincipal, machineAllows, type MachinePrincipal } from './machine-principal.ts';
import { execute } from './operation.ts';
import { type FrameworkApp, type FrameworkRequest, reject } from './http-routes-shared.ts';

// An authenticated worker runs as a typed machine principal — the same
// attributable identity shape the schedule clock and the in-process job seam
// use — instead of an untyped bespoke bearer check. The WIRE protocol is
// UNCHANGED: job functions still receive the workerId string; the machine
// principal is the typed in-process authorization context derived from it.
const WORKER_OPERATIONS: readonly string[] = Object.freeze([execute.operation]);

export function workerMachinePrincipal(
  bearer: string | null,
  jobs: { authenticate(bearer: string): string | null },
): MachinePrincipal | null {
  if (!bearer) return null;
  const workerId = jobs.authenticate(bearer);
  if (typeof workerId !== 'string' || workerId.length === 0) return null;
  const worker = machinePrincipal({ id: workerId, operations: WORKER_OPERATIONS });
  // The typed principal authorizes the worker dispatch through the same closed
  // operation vocabulary; a non-machine identity never reaches the job seam.
  return machineAllows(worker, execute) ? worker : null;
}

// Framework-owned job-queue endpoints (spec #5, Walk 2). NOT mounted routes: the
// worker / job API is a framework default, intercepted before route matching (like
// /blobs, /health, /snapshot). Auth is its OWN path — a per-worker bearer token,
// constant-time compared + revocable (cso: never the shared secret, which is used
// only at /workers/register). These routes are anonymous w.r.t. the route gate — a
// worker is not a logged-in principal; the bearer IS the credential. Workers are
// non-browser clients (no Origin/Referer) so they pass the foreign-only CSRF guard.
// Returns true when handled; false to fall through to matchRoute.
export async function handleJobRoute(
  app: FrameworkApp | null | undefined,
  req: FrameworkRequest,
  res: HttpResponseLike,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'POST' || !app?.jobs) return false;
  const jobs = app.jobs;

  // Bearer extraction: `Authorization: Bearer <workerId>.<token>`.
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim() || null;

  if (url.pathname === '/workers/register') {
    let body: unknown;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { reject(res, err.status, err.message); return true; }
      throw err;
    }
    const w = jobs.registerWorker((body as { secret?: unknown }).secret);
    if (!w) { reject(res, 401, 'invalid shared secret'); return true; }
    sendJson(res, 200, w);
    return true;
  }

  if (url.pathname === '/jobs/claim') {
    const worker = workerMachinePrincipal(bearer, jobs);
    if (!worker) { reject(res, 401, 'unauthorized'); return true; }
    const workerId = worker.id;
    let body: unknown;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { reject(res, err.status, err.message); return true; }
      throw err;
    }
    if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
      reject(res, 400, 'request body must be a JSON object');
      return true;
    }
    const bodyRecord = (body ?? {}) as { kind?: unknown; scope?: unknown };
    if (bodyRecord.kind != null && typeof bodyRecord.kind !== 'string') {
      reject(res, 400, 'kind must be a string');
      return true;
    }
    if (bodyRecord.scope != null && typeof bodyRecord.scope !== 'string') {
      reject(res, 400, 'scope must be a string');
      return true;
    }
    const queryKind = url.searchParams.get('kind') || undefined;
    const queryScope = url.searchParams.get('scope') || undefined;
    const kind = queryKind || (bodyRecord.kind ? bodyRecord.kind : undefined);
    const scope = queryScope || (bodyRecord.scope ? bodyRecord.scope : undefined);
    const claimOpts = kind !== undefined || scope !== undefined
      ? { ...(kind !== undefined ? { kind } : {}), ...(scope !== undefined ? { scope } : {}) }
      : undefined;
    const job = await jobs.claim(workerId, claimOpts);
    if (!job) { res.writeHead(204); res.end(); return true; } // no queued work
    sendJson(res, 200, job);
    return true;
  }

  const hb = url.pathname.match(/^\/jobs\/([^/]+)\/heartbeat$/);
  if (hb) {
    const worker = workerMachinePrincipal(bearer, jobs);
    if (!worker) { reject(res, 401, 'unauthorized'); return true; }
    const workerId = worker.id;
    const ok = await jobs.heartbeat(hb[1], workerId);
    if (!ok) { reject(res, 403, 'not the owning worker or job not running'); return true; }
    sendJson(res, 200, { ok: true });
    return true;
  }

  const pg = url.pathname.match(/^\/jobs\/([^/]+)\/progress$/);
  if (pg) {
    const worker = workerMachinePrincipal(bearer, jobs);
    if (!worker) { reject(res, 401, 'unauthorized'); return true; }
    const workerId = worker.id;
    let body: unknown;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { reject(res, err.status, err.message); return true; }
      throw err;
    }
    const bodyRecord = body as { progress?: unknown; stage?: unknown };
    const updated = await jobs.updateProgress({ jobId: pg[1], workerId, progress: bodyRecord.progress, stage: bodyRecord.stage });
    if (!updated) { reject(res, 403, 'not the owning worker or job not in progress'); return true; }
    const progress = updated as { id?: unknown; progress?: unknown; stage?: unknown; status?: unknown };
    sendJson(res, 200, { id: progress.id, progress: progress.progress, stage: progress.stage, status: progress.status });
    return true;
  }

  const rs = url.pathname.match(/^\/jobs\/([^/]+)\/result$/);
  if (rs) {
    const worker = workerMachinePrincipal(bearer, jobs);
    if (!worker) { reject(res, 401, 'unauthorized'); return true; }
    const workerId = worker.id;
    let body: unknown;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { reject(res, err.status, err.message); return true; }
      throw err;
    }
    let result: { accepted: boolean } | null | undefined;
    try { result = await jobs.submitResult(rs[1], workerId, body) as { accepted: boolean } | null | undefined; }
    catch (err) { reject(res, 400, (err as Error).message); return true; }
    if (!result?.accepted) { reject(res, 403, 'not the owning worker or job not in progress'); return true; }
    sendJson(res, 200, result);
    return true;
  }

  const cn = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
  if (cn) {
    const worker = workerMachinePrincipal(bearer, jobs);
    if (!worker) { reject(res, 401, 'unauthorized'); return true; }
    const workerId = worker.id;
    const cancelled = await jobs.cancelJob({ jobId: cn[1], workerId }) as { forbidden?: unknown; terminal?: unknown; id?: unknown; status?: unknown } | null | undefined;
    if (!cancelled) { reject(res, 404, 'job not found'); return true; }
    if (cancelled.forbidden) { reject(res, 403, 'not the owning worker'); return true; }
    if (cancelled.terminal) { reject(res, 400, 'job already terminal — cannot cancel'); return true; }
    sendJson(res, 200, { id: cancelled.id, status: cancelled.status });
    return true;
  }

  return false;
}
