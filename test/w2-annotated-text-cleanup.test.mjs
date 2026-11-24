import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  canonicalToWireIntervals,
  coversWholeDocument,
  offsetIntervalsIntersect,
  sortAndMergeIntervals,
} from '../build/annotated-text-ranges.mjs';
import { projectAnnotatedTextForRecipient, authoringRedactionsForRecipient } from '../build/annotated-text-recipient-projection.mjs';
import { tryBuildAnnotatedTextFoldEnvelopes } from '../build/annotated-text-fold-envelope.mjs';
import { normalizeOperatedEvent } from '../build/annotated-text-operated-event.mjs';
import * as plan from '../build/annotated-text-plan.mjs';
import { entity, annotatedText, annotation, protectingAnnotation, everyone, grant, read, ref, scope } from '../build/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'annotated-text-operated', 'v13', 'text-apply.json');

// ---------------------------------------------------------------------------
// Shared redaction geometry (task 2). The canonical interval algorithm lives in
// build/annotated-text-ranges.mjs; both the recipient projection and the
// snapshot visibility evaluator import it, so a hidden span and the coordinate
// table describing it cannot drift apart.
// ---------------------------------------------------------------------------

test('shared redaction geometry: activation, merge and canonical->wire parity', () => {
  // Activation primitives.
  assert.equal(offsetIntervalsIntersect([{ start: 2, end: 8 }], [{ start: 8, end: 12 }]), false);
  assert.equal(offsetIntervalsIntersect([{ start: 2, end: 8 }], [{ start: 7, end: 12 }]), true);
  assert.equal(offsetIntervalsIntersect([], [{ start: 0, end: 4 }]), false);
  assert.equal(coversWholeDocument([{ start: 0, end: 20 }], 20), true);
  assert.equal(coversWholeDocument([{ start: 0, end: 19 }], 20), false);

  // Out-of-order, overlapping and nested denied intervals collapse to one
  // disjoint canonical run, preserving the first interval's placeholder.
  const denied = [
    { start: 10, end: 16, placeholder: '[B]' },
    { start: 2, end: 8, placeholder: '[A]' },
    { start: 6, end: 12, placeholder: '[A]' },
  ];
  const merged = sortAndMergeIntervals(denied.map((interval) => ({ ...interval })));
  assert.deepEqual(merged, [{ start: 2, end: 16, placeholder: '[A]' }]);

  // Hidden widths are subtracted from later canonical starts to get wire
  // positions; this is the forward half shared by rendering and authoring.
  assert.deepEqual(canonicalToWireIntervals(merged), [{ start: 2, end: 16, visibleStart: 2 }]);
  const twoRuns = canonicalToWireIntervals([{ start: 2, end: 6 }, { start: 10, end: 16 }]);
  assert.deepEqual(twoRuns, [
    { start: 2, end: 6, visibleStart: 2 },
    { start: 10, end: 16, visibleStart: 6 },
  ]);
});

const accessDeny = async () => grant();
const Doc = entity('W2Doc', {
  project: ref('P'), owner: ref('U', { role: 'owner' }),
  body: annotatedText({
    project: 'project', owner: 'owner',
    annotations: [
      annotation('sensitive', { empty: 'delete' }),
      protectingAnnotation('confidential', { protects: 'sensitive', placeholder: '[REDACTED]', access: accessDeny }),
    ],
  }),
  grant: [scope(() => everyone()).can(() => grant(read))],
});

test('recipient projection redactions match the shared geometry authority', () => {
  const canonical = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text: 'abcdefghijklmnopqrst',
    annotations: [
      { id: 's1', family: 'sensitive', fields: {} },
      ...['c1', 'c2', 'c3'].map((id) => ({ id, family: 'confidential', fields: {}, protectedTargetIds: ['s1'] })),
    ],
    ranges: [
      { annotationId: 's1', start: 2, end: 18 },
      { annotationId: 'c1', start: 10, end: 16 },
      { annotationId: 'c2', start: 2, end: 8 },
      { annotationId: 'c3', start: 6, end: 12 },
    ],
    measurements: [],
    capabilityHints: [],
  };
  const decisions = {
    version: 1,
    protectors: ['c1', 'c2', 'c3'].map((protectorId) => ({ protectorId, outcome: 'deny' })),
    capabilityHints: [],
  };

  const recipient = projectAnnotatedTextForRecipient(canonical, Doc.fields.body, decisions);

  // The three denied intervals (deliberately unordered and overlapping) merge
  // through the one authority to a single [2,16) canonical interval.
  assert.equal(recipient.text, 'abqrst');
  assert.deepEqual(recipient.redactions, [{ start: 2, end: 2, placeholder: '[REDACTED]' }]);
  assert.deepEqual(authoringRedactionsForRecipient(recipient), [{ visibleStart: 2, start: 2, end: 16 }]);
});

// ---------------------------------------------------------------------------
// Task 1: retired residue is gone; fail-closed rejection stays intact.
// ---------------------------------------------------------------------------

test('v13 operated events fail closed at the fold seam and the single version gate', async () => {
  const foldCtx = {
    event: {
      data: {
        version: 13,
        id: 'd1',
        after: { structuralRevision: 1, frontier: [] },
        before: { structuralRevision: 1, frontier: [] },
        facts: {},
        operation: { kind: 'text.apply', operation: [] },
      },
      eventType: 'W2Doc.body.operated',
      seq: 1,
    },
    principal: null,
    scope: 'P:p1',
  };
  const document = {
    entity: { name: 'W2Doc' },
    documentId: 'd1',
    fieldName: 'body',
    descriptor: { kind: 'annotatedText' },
  };
  // A retired v13 envelope must never produce a fold envelope: the fold falls
  // through to snapshot recovery instead of lowering into the v14 fold branch.
  assert.equal(await tryBuildAnnotatedTextFoldEnvelopes(foldCtx, { db: {}, document }), null);

  const raw = JSON.parse(readFileSync(fixture, 'utf8'));
  assert.throws(
    () => normalizeOperatedEvent(raw, { entity: 'ReplayDoc', field: 'body' }),
    /only operated versions 14 and 16 are replayable/,
  );
});

test('the v14 fold gate still rejects a family-bearing facts bag', async () => {
  const foldCtx = {
    event: {
      data: {
        version: 14,
        id: 'd1',
        after: { structuralRevision: 1, frontier: [] },
        before: { structuralRevision: 1, frontier: [] },
        facts: { family: { id: 'd1' } },
        operation: { kind: 'text.apply', operation: [] },
      },
      eventType: 'W2Doc.body.operated',
      seq: 1,
    },
    principal: null,
    scope: 'P:p1',
  };
  const document = {
    entity: { name: 'W2Doc' },
    documentId: 'd1',
    fieldName: 'body',
    descriptor: { kind: 'annotatedText' },
  };
  assert.equal(await tryBuildAnnotatedTextFoldEnvelopes(foldCtx, { db: {}, document }), null);
});

test('the retired planAnnotationApplyOffsets shim is removed', () => {
  assert.equal(Object.hasOwn(plan, 'planAnnotationApplyOffsets'), false);
});
