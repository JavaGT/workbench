export type FailureCategory =
  | 'invalid-input'
  | 'denied'
  | 'unknown-action'
  | 'not-found'
  | 'not-acceptable'
  | 'conflict'
  | 'internal';

export const FAILURE_CATEGORIES = Object.freeze([
  'invalid-input',
  'denied',
  'unknown-action',
  'not-found',
  'not-acceptable',
  'conflict',
  'internal',
] as const);

export interface WorkbenchFailure {
  readonly category: FailureCategory;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface FailureOutcome {
  readonly ok: false;
  readonly failure: WorkbenchFailure;
}

/**
 * A deliberate authorization denial at an internal seam. The status and
 * optional code preserve the direct-caller contract; `failure` lets every
 * transport normalize the same denial through the shared outcome grammar.
 */
export interface ForbiddenError extends Error {
  readonly status: 403;
  readonly code?: string;
  readonly failure: WorkbenchFailure;
}

export function forbidden(message = 'forbidden', code?: string): ForbiddenError {
  const error = new Error(message) as ForbiddenError;
  Object.defineProperty(error, 'status', { value: 403, enumerable: true });
  if (code !== undefined) Object.defineProperty(error, 'code', { value: code, enumerable: true });
  Object.defineProperty(error, 'failure', { value: failure('denied', message), enumerable: true });
  return error;
}

const failureCategories = new Set<FailureCategory>(FAILURE_CATEGORIES);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value: unknown, ancestors: Set<unknown> = new Set()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('failure details must be JSON-safe');
  }

  ancestors.add(value);
  let clone: unknown;
  if (Array.isArray(value)) {
    clone = value.map((item) => cloneJsonValue(item, ancestors));
  } else if (isPlainRecord(value)) {
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      record[key] = cloneJsonValue(item, ancestors);
    }
    clone = record;
  } else {
    ancestors.delete(value);
    throw new TypeError('failure details must be JSON-safe');
  }
  ancestors.delete(value);
  return Object.freeze(clone);
}

function isJsonRecord(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  try {
    cloneJsonValue(value);
    return true;
  } catch {
    return false;
  }
}

export function failure(
  category: FailureCategory,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): WorkbenchFailure {
  if (!failureCategories.has(category)) {
    throw new TypeError(`unknown failure category '${category}'`);
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('failure message must be a non-empty string');
  }

  const result: WorkbenchFailure & { details?: Record<string, unknown> } = { category, message };
  if (details !== undefined) {
    if (!isPlainRecord(details)) {
      throw new TypeError('failure details must be a record');
    }
    result.details = cloneJsonValue(details) as Record<string, unknown>;
  }
  return Object.freeze(result);
}

export function failureOutcome(workbenchFailure: WorkbenchFailure): FailureOutcome {
  if (!isWorkbenchFailure(workbenchFailure)) {
    throw new TypeError('failureOutcome requires a WorkbenchFailure');
  }
  return Object.freeze({ ok: false, failure: workbenchFailure });
}

export function isWorkbenchFailure(value: unknown): value is WorkbenchFailure {
  return Boolean(
    value
    && typeof value === 'object'
    && value !== null
    && failureCategories.has((value as WorkbenchFailure).category)
    && typeof (value as WorkbenchFailure).message === 'string'
    && (value as WorkbenchFailure).message.length > 0
    && ((value as WorkbenchFailure).details === undefined || isJsonRecord((value as WorkbenchFailure).details)),
  );
}

export function sanitizeUnexpectedFailure(_value?: unknown): WorkbenchFailure {
  return failure('internal', 'Internal error.');
}

// Older kernel seams still use status-bearing errors to mark deliberate
// validation and authorization failures. Keep their normalization here until
// those producers emit WorkbenchFailure directly.
const categoryByLegacyStatus = new Map<number, FailureCategory>([
  [400, 'invalid-input'],
  [401, 'denied'],
  [403, 'denied'],
  [404, 'not-found'],
  [405, 'invalid-input'],
  [409, 'conflict'],
  [413, 'invalid-input'],
  [415, 'invalid-input'],
  [429, 'conflict'],
  [503, 'conflict'],
]);

interface StatusError {
  status?: unknown;
  message?: unknown;
  code?: unknown;
  details?: unknown;
  failure?: WorkbenchFailure;
}

export function failureFromError(error: unknown): WorkbenchFailure {
  if (isWorkbenchFailure(error)) return error;
  if (isWorkbenchFailure((error as StatusError)?.failure)) return (error as StatusError).failure as WorkbenchFailure;

  const e = error as StatusError | null | undefined;
  const legacyCategory = e && categoryByLegacyStatus.get(e.status as number);
  if (legacyCategory) {
    return failure(
      legacyCategory,
      String(e?.message || 'Request failed.'),
      e?.details as Readonly<Record<string, unknown>> | undefined,
    );
  }

  if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) {
    return failure('conflict', 'The requested change conflicts with existing data.');
  }

  return sanitizeUnexpectedFailure(error);
}
