// workbench-client-errors.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
export class WorkbenchFailureError extends Error {
  constructor(workbenchFailure) {
    if (!isWorkbenchFailure(workbenchFailure)) {
      throw new TypeError('WorkbenchFailureError requires a canonical WorkbenchFailure');
    }
    super(workbenchFailure.message);
    this.name = 'WorkbenchFailureError';
    this.failure = workbenchFailure;
  }
}
// ---------------------------------------------------------------------------
// createLiveStore — client SDK store: LiveList cache + optimistic dispatch + overlays.
// ---------------------------------------------------------------------------
/**
 * Shared HTTP response decoder.
 * The HTTP status is authoritative. Bodies are values on success, even when an
 * entity happens to contain an `ok` field of its own.
 */
export const FAILURE_CATEGORIES = new Set([
  'invalid-input',
  'denied',
  'unknown-action',
  'not-found',
  'not-acceptable',
  'conflict',
  'internal',
]);
export function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = (isArray ? value : Object.values(value))
    .every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}
export function isJsonRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && isJsonValue(value);
}
export function isWorkbenchFailure(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && FAILURE_CATEGORIES.has(value.category)
    && typeof value.message === 'string'
    && value.message.length > 0
    && (value.details === undefined || isJsonRecord(value.details)),
  );
}
export function clientFailure(category, message, details) {
  return { category, message, ...(details === undefined ? {} : { details }) };
}
export function normalizeFailure(value) {
  if (isWorkbenchFailure(value)) return value;
  const raw = value?.message ?? value?.error ?? value;
  const message = typeof raw === 'string'
    ? raw
    : raw && typeof raw === 'object' && typeof raw.message === 'string'
      ? raw.message
      : String(raw);
  return clientFailure('internal', message);
}
export async function decodeResult(res) {
  if (res.status === 204) {
    return { ok: true, httpStatus: 204, value: undefined };
  }
  if (!res.ok) {
    let body;
    try {
      body = typeof res.json === 'function' ? await res.json() : null;
    } catch {
      body = null;
    }
    if (body?.ok === false && isWorkbenchFailure(body.failure)) {
      return { ok: false, httpStatus: res.status, failure: body.failure };
    }
    return { ok: false, httpStatus: res.status, error: 'http ' + res.status };
  }
  return { ok: true, httpStatus: res.status, value: await res.json() };
}
