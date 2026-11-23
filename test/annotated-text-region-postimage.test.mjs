// Planner/replay agreement and focused region.edit laws (scope#992 W1).
// A plan is serialized as one v16 event, independently seeded, then replayed
// through the production projector. Forged proofs must write nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, parseEventType, read, ref, scope, text, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import {
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  serializeCompactTextFamilyCheckpoint,
  textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { attachAnnotationRange } from '../build/annotated-text-storage.mjs';
import { constructV16RegionEvent } from '../build/annotated-text-operated-event.mjs';
import { planRegionEdit } from '../build/annotated-text-region-plan.mjs';
import { parseRegionEditDescriptor } from '../build/annotated-text-region-descriptor.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
  reduceRegionPostimage,
  REGION_POSTIMAGE_DISAGREES,
} from '../build/annotated-text-region-reducer.mjs';
import { sha256Utf8 } from '../build/annotated-text-region-limits.mjs';

const ACTOR = 'a'.repeat(32);
const EDIT_ACTOR = 'b'.repeat(32);
// v16 binds the witness to the declaration fingerprint, so the planner must
// see the exact descriptors the projector derives from the entity (including
// field-shape identity), not a hand-written stand-in.
function declarations() {
  return declaredEntity().fields.body.annotations.map((entry) => ({
    annotationName: entry.annotationName,
    fields: entry.fields,
    empty: entry.empty,
    cardinality: entry.cardinality,
  }));
}

const externalReferences = defineSqliteSchema({
  name: 'annotated-text-region-postimage',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

function declaredEntity() {
  return entity('ReplayDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('note', { fields: {} }),
        annotation('timing', { fields: { source: text() } }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function installSchema(db) {
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(declaredEntity(), db);
}

function membership(family, start, end, ordinal = 0) {
  return {
    ordinal,
    start: resolveOffsetToEndpoint(family, start, family.checkpoint.frontier, 'left'),
    end: resolveOffsetToEndpoint(family, end, family.checkpoint.frontier, 'right'),
  };
}

function stored(family, {
  id,
  familyName = 'note',
  start,
  end,
  fields = {},
  empty = 'delete',
}) {
  return {
    id,
    family: familyName,
    fields,
    protectedTargetIds: [],
    memberships: [membership(family, start, end)],
    prerequisites: [],
    empty,
    cardinality: 'many',
  };
}

function asImages(annotations) {
  return annotations.map((image) => ({
    id: image.id,
    family: image.family,
    fields: image.fields,
    protectedTargetIds: image.protectedTargetIds,
    memberships: image.memberships,
    orphan: null,
    empty: image.empty,
    cardinality: image.cardinality ?? 'many',
    prerequisites: image.prerequisites,
  }));
}

function coveredIds(family, images, from, to) {
  const ids = [];
  for (const image of images) {
    for (const entry of image.memberships) {
      const start = projectEndpointToOffset(family, entry.start);
      const end = projectEndpointToOffset(family, entry.end);
      if (Math.min(end, to) - Math.max(start, from) > 0) {
        ids.push(image.id);
        break;
      }
    }
  }
  return ids.sort();
}

function descriptorFor(family, { from, to, replacement, annotations, transitions }) {
  const images = asImages(annotations);
  const namedIds = transitions.map((transition) => (
    transition.kind === 'create' ? transition.annotation.id : transition.annotationId
  ));
  const closure = computeAffectedClosure({ annotations: images, family, from, to, namedIds });
  return {
    version: 10,
    kind: 'region.edit',
    id: 'doc-1',
    basis: textFamilyBasis(family),
    from,
    to,
    coveredTextDigest: sha256Utf8(materializeText(family).slice(from, to)),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: coveredIds(family, closure, from, to),
    replacement,
    transitions,
  };
}

function planOf(family, annotations, args) {
  return planRegionEdit({
    descriptor: descriptorFor(family, { ...args, annotations }),
    family,
    structureVersion: 1,
    annotations,
    declarations: declarations(),
    actor: EDIT_ACTOR,
    lamport: 2,
  });
}

const PROJECTION_TABLES = [
  'ReplayDoc',
  'ReplayDoc_body_state',
  'ReplayDoc_body_annotation',
  'ReplayDoc_body_annotation_note',
  'ReplayDoc_body_annotation_timing',
  'ReplayDoc_body_membership',
  'ReplayDoc_body_range',
  'ReplayDoc_body_annotation_orphan_state',
];

function projectedDump(db) {
  const state = {};
  for (const table of PROJECTION_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all()
      .map((row) => Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    state[table] = JSON.stringify(rows);
  }
  return state;
}

function seedPreimage(db, family, annotations) {
  db.exec("INSERT INTO ReplayDoc (id, project, owner) VALUES ('doc-1', 'p1', 'u1')");
  db.prepare('INSERT INTO ReplayDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, ?, ?)')
    .run('doc-1', 1, serializeCompactTextFamilyCheckpoint(family));
  for (const image of annotations) {
    db.prepare('INSERT INTO ReplayDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
      .run(image.id, 'doc-1', 'p1', 'u1', image.family);
    const fieldNames = Object.keys(image.fields);
    if (fieldNames.length) {
      db.prepare(`INSERT INTO ReplayDoc_body_annotation_${image.family} (annotation_id, ${fieldNames.join(', ')}) VALUES (?, ${fieldNames.map(() => '?').join(', ')})`)
        .run(image.id, ...fieldNames.map((name) => image.fields[name]));
    }
    for (const entry of image.memberships) {
      attachAnnotationRange(db, 'ReplayDoc_body', 'doc-1', image.id, entry.start, entry.end, entry.ordinal);
    }
  }
}

function applyOperated(db, event) {
  const projection = workbench({ db, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;
  projection.apply({
    handle: parseEventType('ReplayDoc.body.operated'),
    type: 'ReplayDoc.body.operated',
    data: event,
  }, db);
}

function mintedEvent(plan) {
  return constructV16RegionEvent(plan, {
    owningScope: 'Project:p1', entity: 'ReplayDoc', field: 'body',
    documentId: plan.descriptor.id, actionId: 'a',
  }).event;
}

function replayPlan(plan, family, annotations) {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, annotations);
  applyOperated(db, mintedEvent(plan));
  const dump = projectedDump(db);
  const text = materializeText(family);
  void text;
  const afterText = db.prepare('SELECT family_checkpoint FROM ReplayDoc_body_state WHERE document_id = ?').get('doc-1');
  db.close();
  return { dump, familyCheckpoint: afterText.family_checkpoint };
}

test('one region.edit produces one replayable v16 event', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const event = mintedEvent(plan);
  assert.equal(event.version, 16);
  assert.equal(event.operation.kind, 'region.edit');
  const replayed = replayPlan(plan, family, annotations);
  assert.ok(replayed.familyCheckpoint);
});

test('planner and replay agree on the complete affected closure', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const first = replayPlan(plan, family, annotations);
  const second = replayPlan(plan, family, annotations);
  assert.deepEqual(first.dump, second.dump);
  assert.equal(plan.postimage.annotations[0].id, 'note-1');
  assert.equal(plan.textOperations.kind, 'replace');
});

test('no-text-change region keeps the frontier and emits one operated event', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hello',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  assert.equal(plan.textOperations.kind, 'none');
  assert.deepEqual(plan.after.frontier, family.checkpoint.frontier);
  const event = mintedEvent(plan);
  assert.equal(event.operation.text.kind, 'none');
  replayPlan(plan, family, annotations);
});

test('several logical word edits normalize to one replacement and keep declared IDs', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'the cat sat');
  const annotations = [
    stored(family, { id: 'keep-1', start: 0, end: 3 }),
    stored(family, { id: 'gone-1', start: 4, end: 7 }),
  ];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 11,
    replacement: 'a dog ran',
    transitions: [
      { kind: 'range.set', annotationId: 'keep-1', ranges: [{ start: 0, end: 1 }] },
      { kind: 'remove', annotationId: 'gone-1' },
      {
        kind: 'create',
        annotation: { id: 'new-1', family: 'note', fields: {}, protectedTargetIds: [] },
        ranges: [{ start: 2, end: 5 }],
      },
    ],
  });
  assert.equal(plan.textOperations.kind, 'replace');
  assert.equal(materializeText(plan.afterFamily), 'a dog ran');
  const kept = plan.postimage.annotations.map((image) => image.id).sort();
  assert.deepEqual(kept, ['keep-1', 'new-1']);
  replayPlan(plan, family, annotations);
});

test('insert-only and delete-only replacements share the reducer', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 11 })];
  const deleted = planOf(family, annotations, {
    from: 6,
    to: 11,
    replacement: '',
    transitions: [],
  });
  const inserted = planOf(family, annotations, {
    from: 5,
    to: 5,
    replacement: '!',
    transitions: [],
  });
  assert.equal(deleted.textOperations.kind, 'delete');
  assert.equal(inserted.textOperations.kind, 'insert');
  const replayDeleted = reduceRegionPostimage({
    beforeFamily: family,
    afterFamily: deleted.afterFamily,
    beforeAnnotations: asImages(annotations),
    region: { from: 6, to: 11 },
    transitions: [],
    declarations: declarations(),
    expectedBeforeDigest: deleted.postimage.beforeDigest,
  });
  assert.equal(replayDeleted.afterDigest, deleted.postimage.afterDigest);
});

test('spelling change preserves timing IDs and fields', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, {
    id: 'timing-1',
    familyName: 'timing',
    start: 0,
    end: 5,
    fields: { source: 'original' },
  })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'timing-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const kept = plan.postimage.annotations.find((image) => image.id === 'timing-1');
  assert.ok(kept);
  assert.equal(kept.fields.source, 'original');
  replayPlan(plan, family, annotations);
});

test('inserted timings receive new IDs distinguishable from preserved ones', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, {
    id: 'timing-keep',
    familyName: 'timing',
    start: 6,
    end: 11,
    fields: { source: 'original' },
  })];
  const plan = planOf(family, annotations, {
    from: 5,
    to: 5,
    replacement: ' there',
    transitions: [
      { kind: 'range.set', annotationId: 'timing-keep', ranges: [{ start: 7, end: 12 }] },
      {
        kind: 'create',
        annotation: {
          id: 'timing-new',
          family: 'timing',
          fields: { source: 'interpolated' },
          protectedTargetIds: [],
        },
        ranges: [{ start: 0, end: 6 }],
      },
    ],
  });
  const ids = plan.postimage.annotations.map((image) => image.id).sort();
  assert.deepEqual(ids, ['timing-keep', 'timing-new']);
  const created = plan.postimage.annotations.find((image) => image.id === 'timing-new');
  assert.equal(created.fields.source, 'interpolated');
  replayPlan(plan, family, annotations);
});

test('deleting words removes their explicitly named annotations', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: '',
    transitions: [{ kind: 'remove', annotationId: 'note-1' }],
  });
  assert.equal(plan.postimage.annotations.length, 0);
  assert.equal(plan.postimage.emptied[0].annotationId, 'note-1');
  replayPlan(plan, family, annotations);
});

test('empty replacement over an empty region is rejected', () => {
  assert.throws(
    () => parseRegionEditDescriptor({
      version: 10,
      kind: 'region.edit',
      id: 'doc-1',
      basis: { version: 1, id: 'doc-1', frontier: [] },
      from: 3,
      to: 3,
      coveredTextDigest: sha256Utf8(''),
      affectedClosureDigest: sha256Utf8(''),
      expectedCoveredAnnotationIds: [],
      replacement: '',
      transitions: [],
    }),
    (error) => error.failure?.code === 'annotated-text-no-operation',
  );
});

function forgeAndReplay(mutator) {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const event = structuredClone(mintedEvent(plan));
  mutator(event);
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, annotations);
  const before = projectedDump(db);
  let threw = false;
  try {
    applyOperated(db, event);
  } catch (error) {
    threw = true;
    assert.equal(error.message, REGION_POSTIMAGE_DISAGREES);
  }
  const after = projectedDump(db);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('forged region postimage performed a write');
  }
  assert.equal(threw, true);
  db.close();
}

test('forged after-digest writes nothing', () => {
  forgeAndReplay((event) => { event.operation.afterDigest = '0'.repeat(64); });
});

test('omitted affected ID writes nothing', () => {
  forgeAndReplay((event) => { event.operation.affectedIds = []; });
});

test('altered field writes nothing', () => {
  forgeAndReplay((event) => {
    event.operation.transitions = [{
      kind: 'range.set',
      annotationId: 'note-1',
      ranges: [{ start: 0, end: 4 }],
    }];
  });
});

test('unknown range.set target writes nothing', () => {
  forgeAndReplay((event) => {
    event.operation.transitions = [{
      kind: 'range.set',
      annotationId: 'unknown-note',
      ranges: [{ start: 0, end: 5 }],
    }];
  });
});

test('nested identity permutations have one digest and canonical postimage', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const base = stored(family, { id: 'note-1', start: 0, end: 5 });
  const left = {
    ...base,
    protectedTargetIds: ['target-b', 'target-a'],
    prerequisites: [{ entity: 'User', id: 'user-b' }, { entity: 'Code', id: 'code-a' }],
  };
  const right = {
    ...base,
    protectedTargetIds: [...left.protectedTargetIds].reverse(),
    prerequisites: [...left.prerequisites].reverse(),
  };
  assert.equal(digestAffectedClosure(asImages([left])), digestAffectedClosure(asImages([right])));

  // v16 witness completeness requires every edge to resolve inside its own
  // side's ID set, so the protected targets exist as live annotations here.
  // They sit outside the edited span so both survive as note-1's targets.
  const targets = [
    stored(family, { id: 'target-a', start: 6, end: 8 }),
    stored(family, { id: 'target-b', start: 9, end: 11 }),
  ];
  const plan = planOf(family, [left, ...targets], {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  assert.deepEqual(plan.postimage.annotations[0].protectedTargetIds, ['target-a', 'target-b']);
  assert.deepEqual(plan.postimage.annotations[0].prerequisites, [
    { entity: 'Code', id: 'code-a' },
    { entity: 'User', id: 'user-b' },
  ]);
});
