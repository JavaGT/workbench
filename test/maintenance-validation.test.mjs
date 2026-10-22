import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench from '../build/index.mjs';
import { maintenanceDefaults } from '../build/application-runtime.mjs';
import { blobRetentionDefaults } from '../build/blob-retention.mjs';

const invalidOptions = [
  ['blobReapIntervalMs', 0],
  ['blobReapIntervalMs', -1],
  ['blobReapIntervalMs', Number.NaN],
  ['blobReapIntervalMs', Number.POSITIVE_INFINITY],
  ['blobReapTtlMs', -1],
  ['blobReapTtlMs', Number.NaN],
  ['blobReapTtlMs', Number.POSITIVE_INFINITY],
  ['logRetentionDays', -1],
  ['logRetentionDays', Number.NaN],
  ['logRetentionDays', Number.POSITIVE_INFINITY],
  ['logRetentionDays', '30'],
  ['logRetentionIntervalMs', 0],
  ['logRetentionIntervalMs', -1],
  ['logRetentionIntervalMs', Number.NaN],
  ['logRetentionIntervalMs', Number.POSITIVE_INFINITY],
];

for (const [name, value] of invalidOptions) {
  test(`maintenance rejects invalid ${name}: ${String(value)}`, () => {
    assert.throws(() => workbench({ [name]: value }), new RegExp(name));
  });
}

test('maintenance accepts zero blob TTL and fractional retention days', async () => {
  const app = workbench({
    blobReapIntervalMs: 1,
    blobReapTtlMs: 0,
    logRetentionDays: 0.5,
    logRetentionIntervalMs: 1,
  });

  assert.deepEqual(app._maintenance, {
    blobReapIntervalMs: 1,
    blobReapTtlMs: 0,
    logRetentionDays: 0.5,
    logRetentionIntervalMs: 1,
    resultDataRetentionDays: maintenanceDefaults.resultDataRetentionDays,
    payloadCompressionMinBytes: maintenanceDefaults.payloadCompressionMinBytes,
    // S6/A5: the named retention policies + low-disk headroom default in when
    // they are not configured — the single TTL source, no scattered literals.
    // An explicit legacy scalar folds INTO the abandoned-upload policy (the
    // scalar is its alias and can never diverge), so blobReapTtlMs: 0 also
    // writes abandonedUploadTtlMs: 0.
    blobRetention: { ...blobRetentionDefaults, abandonedUploadTtlMs: 0 },
    blobLowDiskHeadroomBytes: maintenanceDefaults.blobLowDiskHeadroomBytes,
  });
  await app.shutdown();
});
