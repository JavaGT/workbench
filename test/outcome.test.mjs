import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAILURE_CATEGORIES,
  failure,
  failureOutcome,
  forbidden,
  isWorkbenchFailure,
  sanitizeUnexpectedFailure,
} from '../build/index.mjs';
import { failureFromError } from '../build/outcome.mjs';

test('failure categories are the six stable public categories', () => {
  assert.deepEqual(FAILURE_CATEGORIES, [
    'invalid-input',
    'denied',
    'unknown-action',
    'not-found',
    'conflict',
    'internal',
  ]);
});

test('failure creates the exact transport-neutral failure shape', () => {
  assert.deepEqual(failure('not-found', 'Project not found.', { projectId: 'p1' }), {
    category: 'not-found',
    message: 'Project not found.',
    details: { projectId: 'p1' },
  });
});

test('failure rejects categories outside the public grammar', () => {
  assert.throws(() => failure('unauthorized', 'No.'), /unknown failure category/);
});

test('failure rejects details that are not a structured record', () => {
  for (const details of [null, 'retry later', 3, true, ['not', 'a', 'record']]) {
    assert.throws(
      () => failure('conflict', 'Try again.', details),
      /failure details must be a record/,
    );
  }
});

test('failure details must be JSON-safe and are detached from caller mutation', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const details of [
    { value: 1n },
    { value: undefined },
    { value: Number.NaN },
    { value: new Date() },
    cyclic,
  ]) {
    assert.throws(() => failure('conflict', 'Try again.', details), /JSON-safe/);
  }

  const source = { retry: { afterMs: 10 }, causes: ['busy'] };
  const result = failure('conflict', 'Try again.', source);
  source.retry.afterMs = 99;
  source.causes.push('later');
  assert.deepEqual(result.details, { retry: { afterMs: 10 }, causes: ['busy'] });
  assert.equal(Object.isFrozen(result.details.retry), true);
  assert.equal(Object.isFrozen(result.details.causes), true);
});

test('failureOutcome creates the exact public failure result', () => {
  assert.deepEqual(failureOutcome(failure('denied', 'Forbidden.')), {
    ok: false,
    failure: { category: 'denied', message: 'Forbidden.' },
  });
});

test('forbidden creates one typed 403 error for direct and HTTP callers', () => {
  const error = forbidden();
  assert.equal(error.message, 'forbidden');
  assert.equal(error.status, 403);
  assert.deepEqual(error.failure, { category: 'denied', message: 'forbidden' });

  const historyError = forbidden('history.forbidden', 'history.forbidden');
  assert.equal(historyError.status, 403);
  assert.equal(historyError.code, 'history.forbidden');
  assert.deepEqual(failureFromError(historyError), { category: 'denied', message: 'history.forbidden' });
});

test('isWorkbenchFailure recognizes only complete canonical failures', () => {
  assert.equal(isWorkbenchFailure({ category: 'conflict', message: 'Already exists.' }), true);
  assert.equal(isWorkbenchFailure({ category: 'conflict', message: 'Already exists.', details: {} }), true);

  for (const value of [
    null,
    'failure',
    {},
    { category: 'other', message: 'No.' },
    { category: 'conflict', message: '' },
    { category: 'conflict', message: 'No.', details: [] },
  ]) {
    assert.equal(isWorkbenchFailure(value), false);
  }
});

test('sanitizeUnexpectedFailure never exposes the original exception', () => {
  assert.deepEqual(sanitizeUnexpectedFailure(new Error('database password leaked')), {
    category: 'internal',
    message: 'Internal error.',
  });
});

test('failureFromError preserves deliberate transport-neutral failures', () => {
  const deliberate = failure('conflict', 'Already exists.');
  assert.equal(failureFromError(deliberate), deliberate);
});

test('failureFromError normalizes legacy status-bearing kernel errors', () => {
  assert.deepEqual(
    failureFromError({ status: 403, message: 'Forbidden.' }),
    { category: 'denied', message: 'Forbidden.' },
  );
});

test('failureFromError maps only known SQLite constraints to conflict', () => {
  assert.deepEqual(failureFromError(Object.assign(new Error('duplicate'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })), {
    category: 'conflict',
    message: 'The requested change conflicts with existing data.',
  });
});

test('failureFromError sanitizes unexpected errors', () => {
  assert.deepEqual(failureFromError(new Error('database password leaked')), {
    category: 'internal',
    message: 'Internal error.',
  });
});
