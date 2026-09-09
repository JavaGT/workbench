








export const FAILURE_CATEGORIES = Object.freeze([
  'invalid-input',
  'denied',
  'unknown-action',
  'not-found',
  'not-acceptable',
  'conflict',
  'internal',
]         );












/**
 * A deliberate authorization denial at an internal seam. The status and
 * optional code preserve the direct-caller contract; `failure` lets every
 * transport normalize the same denial through the shared outcome grammar.
 */






export function forbidden(message = 'forbidden', code         )                 {
  const error = new Error(message)                  ;
  Object.defineProperty(error, 'status', { value: 403, enumerable: true });
  if (code !== undefined) Object.defineProperty(error, 'code', { value: code, enumerable: true });
  Object.defineProperty(error, 'failure', { value: failure('denied', message), enumerable: true });
  return error;
}

const failureCategories = new Set                 (FAILURE_CATEGORIES);

function isPlainRecord(value         )                                   {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value         , ancestors               = new Set())          {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('failure details must be JSON-safe');
  }

  ancestors.add(value);
  let clone         ;
  if (Array.isArray(value)) {
    clone = value.map((item) => cloneJsonValue(item, ancestors));
  } else if (isPlainRecord(value)) {
    const record                          = {};
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

function isJsonRecord(value         )          {
  if (!isPlainRecord(value)) return false;
  try {
    cloneJsonValue(value);
    return true;
  } catch {
    return false;
  }
}

export function failure(
  category                 ,
  message        ,
  details                                    ,
)                   {
  if (!failureCategories.has(category)) {
    throw new TypeError(`unknown failure category '${category}'`);
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('failure message must be a non-empty string');
  }

  const result                                                           = { category, message };
  if (details !== undefined) {
    if (!isPlainRecord(details)) {
      throw new TypeError('failure details must be a record');
    }
    result.details = cloneJsonValue(details)                           ;
  }
  return Object.freeze(result);
}

export function failureOutcome(workbenchFailure                  )                 {
  if (!isWorkbenchFailure(workbenchFailure)) {
    throw new TypeError('failureOutcome requires a WorkbenchFailure');
  }
  return Object.freeze({ ok: false, failure: workbenchFailure });
}

export function isWorkbenchFailure(value         )                            {
  return Boolean(
    value
    && typeof value === 'object'
    && value !== null
    && failureCategories.has((value                    ).category)
    && typeof (value                    ).message === 'string'
    && (value                    ).message.length > 0
    && ((value                    ).details === undefined || isJsonRecord((value                    ).details)),
  );
}

export function sanitizeUnexpectedFailure(_value          )                   {
  return failure('internal', 'Internal error.');
}

// Older kernel seams still use status-bearing errors to mark deliberate
// validation and authorization failures. Keep their normalization here until
// those producers emit WorkbenchFailure directly.
const categoryByLegacyStatus = new Map                         ([
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









export function failureFromError(error         )                   {
  if (isWorkbenchFailure(error)) return error;
  if (isWorkbenchFailure((error               )?.failure)) return (error               ).failure                    ;

  const e = error                                  ;
  const legacyCategory = e && categoryByLegacyStatus.get(e.status          );
  if (legacyCategory) {
    return failure(
      legacyCategory,
      String(e?.message || 'Request failed.'),
      e?.details                                                 ,
    );
  }

  if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) {
    return failure('conflict', 'The requested change conflicts with existing data.');
  }

  return sanitizeUnexpectedFailure(error);
}
