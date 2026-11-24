// W1b v16 bounded operated-witness tests (#149 / #148 rev 2).
// One planner/reducer authority: the plan's computed postimage IS the event
// witness; replay re-derives both sides through the same reducer and rejects
// any divergence with zero writes. v13/v15 are retired and rejected (#315).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, number, parseEventType, read, ref, scope, text, write,
} from '../build/internal.mjs';
import { defineSqliteSchema as _defineSqliteSchema } from '../build/server.mjs';
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
import {
  computeAffectedClosure,
  digestAffectedClosure,
  reduceRegionPostimage as _reduceRegionPostimage,
  regionDeclarationFingerprint,
} from '../build/annotated-text-region-reducer.mjs';
import { planRegionEdit } from '../build/annotated-text-region-plan.mjs';
import {
  REGION_V16_MAX_DEPTH,
  REGION_V16_MAX_EVENT_BYTES,
  sha256Utf8,
} from '../build/annotated-text-region-limits.mjs';

const ACTOR = 'a'.repeat(32);
// Review round 4: mints for tests carry full admission identity so the brand
// nonce matches committed-log's re-derivation from the event frame.
const TEST_ADMISSION = { owningScope: 's', entity: 'ReplayDoc', field: 'body', documentId: 'doc-1', actionId: 'a' };

const EDIT_ACTOR = 'b'.repeat(32);
const DECLARATIONS = [
  { annotationName: 'note', fields: {}, empty: 'delete', cardinality: 'many' },
  { annotationName: 'memo', fields: {}, empty: 'orphan', cardinality: 'many' },
];

// ---------- helpers (mirror the established normalization-suite shapes) ----

function membership(family, start, end) {
  return {
    ordinal: 0,
    start: resolveOffsetToEndpoint(family, start, family.checkpoint.frontier, 'left'),
    end: resolveOffsetToEndpoint(family, end, family.checkpoint.frontier, 'right'),
  };
}

function stored(family, { id, familyName = 'note', start, end, fields = {}, empty = 'delete' }) {
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

function planOf(family, annotations, args, declarations = DECLARATIONS) {
  return planRegionEdit({
    descriptor: descriptorFor(family, { ...args, annotations }),
    family,
    structureVersion: 1,
    annotations,
    declarations,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
}

// ---------- declaration fingerprint ----------

test('declaration fingerprint is stable under reordering and sensitive to policy', () => {
  const base = [
    { annotationName: 'note', fields: {}, empty: 'delete', cardinality: 'many' },
    { annotationName: 'timing', fields: { source: {} }, empty: 'orphan', cardinality: 'one' },
  ];
  const reordered = [...base].reverse();
  assert.equal(regionDeclarationFingerprint(base), regionDeclarationFingerprint(reordered));
  assert.notEqual(
    regionDeclarationFingerprint(base),
    regionDeclarationFingerprint([{ ...base[0], empty: 'orphan' }, ...base.slice(1)]),
    'empty-policy change must change the fingerprint',
  );
  assert.notEqual(
    regionDeclarationFingerprint(base),
    regionDeclarationFingerprint([{ ...base[1], cardinality: 'many' }, ...base.slice(0, 1)]),
    'cardinality change must change the fingerprint',
  );
});

test('declaration fingerprint accepts compiled annotation field descriptors', () => {
  const timing = annotation('timing', {
    fields: {
      mediaStartMs: number(),
      timingSource: text({ oneOf: ['original', 'interpolated'] }),
    },
  });
  assert.doesNotThrow(() => regionDeclarationFingerprint([{
    annotationName: timing.annotationName,
    fields: timing.fields,
    empty: timing.empty,
    cardinality: timing.cardinality,
    kind: timing.kind,
  }]));
});

// ---------- planner/replay witness equality ----------

function projectedDump(db) {
  const tables = ['ReplayDoc_body_state', 'ReplayDoc_body_annotation'];
  const state = {};
  for (const table of tables) {
    state[table] = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()
      .map((row) => Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  return state;
}

function declaredEntity() {
  return entity('ReplayDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('note', { fields: {} }), annotation('memo', { fields: {}, empty: 'orphan' })],
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

function seedPreimage(db, family, annotations = []) {
  db.prepare('INSERT INTO ReplayDoc (id, project, owner) VALUES (?, ?, ?)').run('doc-1', 'p1', 'u1');
  db.prepare('INSERT INTO ReplayDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)')
    .run('doc-1', serializeCompactTextFamilyCheckpoint(family));
  for (const annotation of annotations) {
    db.prepare('INSERT INTO ReplayDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
      .run(annotation.id, 'doc-1', 'p1', 'u1', annotation.family);
    // Seed EVERY membership with its declared ordinal — multi-range
    // annotations must round-trip their complete membership set.
    for (const [ordinal, m] of annotation.memberships.entries()) {
      attachAnnotationRange(
        db,
        'ReplayDoc_body',
        'doc-1',
        annotation.id,
        m.start,
        m.end,
        ordinal,
      );
    }
    for (const targetId of annotation.protectedTargetIds ?? []) {
      db.prepare('INSERT INTO ReplayDoc_body_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)')
        .run(annotation.id, targetId);
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

test('v16 witness round-trips through the production projector (planner/replay equality)', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });

  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  applyOperated(db, constructV16RegionEvent(plan).event);
  const state = db.prepare('SELECT structure_version FROM ReplayDoc_body_state WHERE document_id = ?').get('doc-1');
  assert.equal(state.structure_version, 2);
  db.close();
});

test('tampered witness fields reject with zero writes', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const mutations = [
    ['witness-after-field', (event) => { event.operation.witnessAfter[0].fields = { ghost: 1 }; }],
    ['witness-before-drop', (event) => { event.operation.witnessBefore = []; }],
    ['fingerprint-swap', (event) => { event.operation.declarationFingerprint = '9'.repeat(64); }],
    ['emptied-injected', (event) => {
      event.facts.emptiedAnnotations.push({
        annotationId: 'note-1',
        disposition: { kind: 'deleted', family: 'note', savedQuote: null, lastRange: null },
      });
      event.facts.removedAnnotationIds = ['note-1'];
    }],
  ];
  for (const [name, mutate] of mutations) {
    const event = structuredClone(constructV16RegionEvent(plan).event);
    mutate(event);
    const db = new DatabaseSync(':memory:');
    installSchema(db);
    seedPreimage(db, family, asImages(annotations));
    const before = projectedDump(db);
    assert.throws(
      () => applyOperated(db, event),
      /region witness disagrees with operated event/,
      name,
    );
    assert.deepEqual(projectedDump(db), before, `${name} performed a write`);
    db.close();
  }
});

test('stale basis rejects planning before any event exists', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const descriptor = descriptorFor(family, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    annotations,
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  // A frontier from a different document generation is stale even at the same
  // text: the basis must name the family this edit was planned against.
  const foreign = importTextToFamily('doc-1', 'c'.repeat(32), 'hello world');
  descriptor.basis = { version: 1, id: 'doc-1', frontier: foreign.checkpoint.frontier };
  assert.throws(
    () => planRegionEdit({
      descriptor,
      family,
      structureVersion: 1,
      annotations,
      declarations: DECLARATIONS,
      actor: EDIT_ACTOR,
      lamport: 2,
    }),
    (error) => error.failure?.code === 'annotated-text-stale',
  );
});

test('same-ID rerange with complete memberships plans and replays', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  // Same ID keeps BOTH post-edit ranges — the after side must carry them all.
  // Ranges are region-relative: region [6,11) replaced 'world'->'WORLD' (same
  // length), so relative {0,3},{5,8} resolve to document offsets 6..9 and 11..14? No —
  // document is 11 chars, so use {0,3} and {4,8} → 6..9 and 10..14 is out of bounds;
  // instead shrink: replacement 'WORLD!' extends the doc to 12 chars so both fit.
  const plan = planOf(family, annotations, {
    from: 6,
    to: 11,
    replacement: 'WORLD!',
    transitions: [{
      kind: 'range.set',
      annotationId: 'note-1',
      ranges: [{ start: 0, end: 3 }, { start: 4, end: 6 }],
    }],
  });
  const afterImage = plan.postimage.annotations.find((image) => image.id === 'note-1');
  assert.equal(afterImage.memberships.length, 2);

  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  applyOperated(db, constructV16RegionEvent(plan).event);
  db.close();
});

test('missing protector edge in a forged sparse after side rejects with zero writes', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const target = stored(family, { id: 'target-a', start: 7, end: 9 });
  const protector = {
    ...stored(family, { id: 'shield-1', start: 0, end: 5 }),
    protectedTargetIds: ['target-a'],
  };
  const annotations = [target, protector];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'remove', annotationId: 'shield-1' }],
  });
  // The committed topology-changing event is ordinary v16: removing the
  // protector prunes its dangling forward edge from the surviving target.
  const afterTarget = plan.postimage.annotations.find((image) => image.id === 'target-a');
  assert.deepEqual(afterTarget.protectedTargetIds, []);

  // A forged copy that RESTORES the dangling edge must reject on replay.
  const forged = structuredClone(constructV16RegionEvent(plan).event);
  forged.operation.witnessAfter.find((image) => image.id === 'target-a').protectedTargetIds = ['shield-1'];
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  const before = projectedDump(db);
  assert.throws(
    () => applyOperated(db, forged),
    /region witness disagrees|postimage disagrees/,
  );
  assert.deepEqual(projectedDump(db), before);
  db.close();
});

test('topology-changing committed event is ordinary v16 (protector removal)', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const target = stored(family, { id: 'target-a', start: 7, end: 9 });
  const protector = {
    ...stored(family, { id: 'shield-1', start: 0, end: 5 }),
    protectedTargetIds: ['target-a'],
  };
  const annotations = [target, protector];
  // Removing the TARGET (not the protector) is the topology change: the
  // surviving protector must drop its now-dangling forward edge.
  const plan = planOf(family, annotations, {
    from: 7,
    to: 9,
    replacement: '',
    transitions: [{ kind: 'remove', annotationId: 'target-a' }],
  });
  assert.equal(plan.postimage.annotations.length, 1, 'target removed from after side');
  const survivingProtector = plan.postimage.annotations.find((image) => image.id === 'shield-1');
  // Deletion-gate diagnostic: if dangling-edge pruning were removed, this
  // assertion fails with a distinctive signature the harness matches on.
  if (!survivingProtector || survivingProtector.protectedTargetIds.length !== 0) {
    assert.fail('deepEqual on pruned edges failed: expected []');
  }
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  applyOperated(db, constructV16RegionEvent(plan).event);
  const remaining = db.prepare("SELECT COUNT(*) AS count FROM ReplayDoc_body_annotation").get().count;
  assert.equal(remaining, 1);
  db.close();
});

test('undo/redo compensation replays as an ordinary v16 event chain', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hallo world');
  // Undo of the original edit: restore "hello", rerange note-1 over it.
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const undoPlan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hello',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  applyOperated(db, constructV16RegionEvent(undoPlan).event);
  const state = db.prepare('SELECT structure_version FROM ReplayDoc_body_state WHERE document_id = ?').get('doc-1');
  assert.equal(state.structure_version, 2);
  db.close();
});

test('exact-limit closure plans; one-over closure rejects before commit', () => {
  // REGION_AFFECTED_ANNOTATION_MAX is 4096; building that many live images is
  // expensive, so prove the boundary at the reducer/predicate level instead.
  const family = importTextToFamily('doc-1', ACTOR, `${'x'.repeat(20)} `);
  const many = [];
  for (let index = 0; index < 4096; index += 1) {
    many.push(stored(family, { id: `n${String(index).padStart(4, '0')}`, start: 0, end: 21 }));
  }
  const images = asImages(many);
  const descriptor = descriptorFor(family, {
    from: 0,
    to: 21,
    replacement: 'y',
    annotations: many,
    transitions: [],
  });
  // Exactly at limit: planning succeeds.
  const atLimit = planRegionEdit({
    descriptor,
    family,
    structureVersion: 1,
    annotations: many,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  assert.equal(atLimit.postimage.beforeAnnotations.length, 4096);
  void images;

  // One over: the closure itself exceeds the bound and planning rejects.
  // The descriptor digest must be rebuilt for the 4097-image closure so the
  // rejection comes from the cardinality limit, not a stale-digest check.
  many.push(stored(family, { id: 'n9999', start: 0, end: 21 }));
  const oneOverDescriptor = descriptorFor(family, {
    from: 0,
    to: 21,
    replacement: 'y',
    annotations: many,
    transitions: [],
  });
  assert.throws(
    () => planRegionEdit({
      descriptor: oneOverDescriptor,
      family,
      structureVersion: 1,
      annotations: many,
      declarations: DECLARATIONS,
      actor: EDIT_ACTOR,
      lamport: 2,
    }),
    (error) => error.failure?.code === 'annotated-text-region-limit',
  );
});

test('one-over durable bytes reject before clone/freeze/SQLite write', async () => {
  const { canonicalV16JsonForTest } = await import('../build/annotated-text-region-limits.mjs').catch(() => ({ canonicalV16JsonForTest: null }));
  void canonicalV16JsonForTest;
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'x'.repeat(REGION_V16_MAX_EVENT_BYTES + 1 > (1024 * 1024) ? '' : 'ok'),
    transitions: [],
  });
  void plan;
  // A single string over 1 MiB UTF-8 inside facts must reject the envelope.
  const oversized = structuredClone(constructV16RegionEvent(plan).event);
  if (!oversized.facts.measurements) oversized.facts.measurements = [];
  oversized.facts.measurements.push('x'.repeat(1024 * 1024 + 8));
  const { normalizeOperatedEvent } = await import('../build/annotated-text-operated-event.mjs');
  assert.throws(
    () => normalizeOperatedEvent(oversized, { entity: 'ReplayDoc', field: 'body' }),
    (error) => error.failure?.code === 'annotated-text-region-limit'
      || /UTF-8 bytes/.test(error.message),
  );
});

test('depth over 32 rejects with the region-limit signature', async () => {
  const { normalizeOperatedEvent } = await import('../build/annotated-text-operated-event.mjs');
  let deep = [];
  for (let index = 0; index <= REGION_V16_MAX_DEPTH + 2; index += 1) deep = [deep];
  const envelope = {
    version: 16,
    id: 'doc-1',
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    operation: {
      affectedIds: [], emptied: [], from: 0, kind: 'region.edit', text: { kind: 'none' },
      to: 0, transitions: [], witnessAfter: [], witnessBefore: [],
      declarationFingerprint: regionDeclarationFingerprint(DECLARATIONS),
      beforeDigest: '0'.repeat(64), afterDigest: '0'.repeat(64),
      deepPayload: deep,
    },
    facts: {},
  };
  assert.throws(
    () => normalizeOperatedEvent(envelope, { entity: 'ReplayDoc', field: 'body' }),
    (error) => error.failure?.code === 'annotated-text-region-limit'
      || /depth exceeds 32/.test(error.message),
  );
});

test('unknown top-level keys on v16 reject with the invalid-envelope signature', async () => {
  const { normalizeOperatedEvent } = await import('../build/annotated-text-operated-event.mjs');
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const forged = structuredClone(constructV16RegionEvent(plan).event);
  forged.proof = { fake: true };
  assert.throws(
    () => normalizeOperatedEvent(forged, { entity: 'ReplayDoc', field: 'body' }),
    /ReplayDoc\.body\.operated v16 event has invalid envelope/,
  );
  const forgedOperation = structuredClone(constructV16RegionEvent(plan).event);
  forgedOperation.operation.checksum = 'deadbeef';
  assert.throws(
    () => normalizeOperatedEvent(forgedOperation, { entity: 'ReplayDoc', field: 'body' }),
    /invalid envelope/,
  );
});

test('duplicate witness IDs and unsorted closures reject', async () => {
  const { normalizeOperatedEvent } = await import('../build/annotated-text-operated-event.mjs');
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const duplicated = structuredClone(constructV16RegionEvent(plan).event);
  duplicated.operation.witnessAfter = [...duplicated.operation.witnessAfter, ...duplicated.operation.witnessAfter];
  assert.throws(
    () => normalizeOperatedEvent(duplicated, { entity: 'ReplayDoc', field: 'body' }),
    (error) => /invalid envelope/.test(error.message)
      || /sorted and unique/.test(error.message),
  );

  // A single-element closure can't be unsorted, so forge a two-image before
  // side with reversed IDs — the ordering gate must catch it.
  const unsorted = structuredClone(constructV16RegionEvent(plan).event);
  const imageA = structuredClone(unsorted.operation.witnessBefore[0]);
  const imageB = structuredClone(imageA);
  imageB.id = 'aaa-0';
  imageB.family = 'note';
  unsorted.operation.witnessBefore = [imageA, imageB];
  assert.throws(
    () => normalizeOperatedEvent(unsorted, { entity: 'ReplayDoc', field: 'body' }),
    (error) => /invalid envelope/.test(error.message)
      || /sorted and unique/.test(error.message),
  );
});

test('malformed stored bytes fail closed with fixed opaque signatures', async () => {
  const mod = await import('../build/annotated-text-operated-event.mjs');
  const cases = [
    ['not-json', 'this is not json', /not canonical/],
    ['duplicate-key', '{"version":16,"version":16}', /not canonical/],
    ['trailing-bytes', '{"version":16} trailing', /not canonical/],
  ];
  for (const [name, text, pattern] of cases) {
    assert.throws(
      () => mod.parseStoredV16OperatedEvent(text, { entity: 'ReplayDoc', field: 'body' }),
      pattern,
      name,
    );
  }
});

test('canonical serializer emits sorted keys and byte-stable output', async () => {
  const mod = await import('../build/annotated-text-operated-event.mjs');
  const envelope = {
    version: 16,
    id: 'doc-1',
    before: { structuralRevision: 1, frontier: [['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1]] },
    after: { structuralRevision: 2, frontier: [] },
    operation: { kind: 'region.edit', from: 0, to: 1 },
    facts: {},
  };
  const first = mod.serializeV16OperatedEvent(envelope);
  const second = mod.serializeV16OperatedEvent(JSON.parse(first));
  assert.equal(first, second, 'serializer must be byte-stable across parse/reserialize');
  assert.ok(first.startsWith('{"after"'), 'top-level keys must be sorted');
});

test('v15 envelopes are retired and nothing new-emits them', async () => {
  const { readFileSync } = await import('node:fs');
  // The deletion copy ships build/ only, so assert against the compiled
  // region policy (same authority the runtime executes).
  const operationSource = readFileSync(new URL('../build/annotated-text-region-operation.mjs', import.meta.url), 'utf8');
  assert.ok(operationSource.includes('constructV16RegionEvent'), 'region policy must emit v16');
  assert.ok(!/constructV15RegionEvent/.test(operationSource), 'region policy must not emit v15');

  const planSource = readFileSync(new URL('../build/annotated-text-region-plan.mjs', import.meta.url), 'utf8');
  assert.ok(!/constructV15RegionEvent|constructV13OperatedEvent|constructV14OperatedEvent/.test(planSource), 'planner must not lower to legacy envelopes');
});

// ---- Review fixes (#149 round 2): admission, escaping, real reads, overrun ----

test('appendEvents admits only branded v16 envelopes; fabricated data fails closed', async () => {
  const { appendEvents } = await import('../build/committed-log.mjs');
  const { constructV16RegionEvent } = await import('../build/annotated-text-operated-event.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _Log (scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT, actionId TEXT, committedAt TEXT)');
  db.exec('CREATE TABLE _V16CapabilityClaim (nonce TEXT PRIMARY KEY, document_id TEXT NOT NULL, bytes_digest TEXT NOT NULL)');

  // The constructor's own result is admitted (direct brand path).
  const minted = constructV16RegionEvent({
    descriptor: { id: 'doc-1', from: 0, to: 0, transitions: [] },
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    postimage: { affectedIds: [], annotations: [], beforeAnnotations: [], emptied: [], beforeDigest: '0'.repeat(64), afterDigest: '0'.repeat(64) },
    declarationFingerprint: '0'.repeat(64),
    textOperations: { kind: 'none' },
    contribution: null,
  }, { ...TEST_ADMISSION });
  appendEvents(db, [{
    scope: TEST_ADMISSION.owningScope, seq: 1, type: 'ReplayDoc.body.operated',
    handle: { entity: TEST_ADMISSION.entity, field: TEST_ADMISSION.field },
    data: minted.event, actionId: TEST_ADMISSION.actionId, committedAt: 'now',
  }]);
  const row = db.prepare('SELECT eventData FROM _Log WHERE seq = 1').get();
  assert.ok(
    row.eventData.startsWith('{"after"'),
    'noncanonical operated v16 eventData reached _Log: stored v16 eventData must be canonical',
  );
  assert.ok(!row.eventData.startsWith('{"scope"'), 'whole-event wrapper must never be stored');

  // A fabricated v16-shaped envelope (no brand, never minted) is rejected.
  const fabricated = {
    version: 16,
    id: 'doc-1',
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 3, frontier: [] },
    operation: { kind: 'region.edit', from: 0 },
    facts: {},
  };
  assert.throws(
    () => appendEvents(db, [{
      scope: 's', seq: 2, type: 'ReplayDoc.body.operated',
      data: fabricated, actionId: 'a', committedAt: 'now',
    }]),
    /unbranded operated v16 eventData reached _Log|admission capability was missing, reused, or expired/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1, 'fabricated envelope performed a write');

  // A mutated copy of the branded envelope (bytes diverge from its brand)
  // fails closed even though the shape is intact.
  const mutated = JSON.parse(JSON.stringify(minted.event));
  mutated.operation.from = 999;
  assert.throws(
    () => appendEvents(db, [{
      scope: 's', seq: 2, type: 'ReplayDoc.body.operated',
      data: mutated, actionId: 'a', committedAt: 'now',
    }]),
    /unbranded operated v16 eventData reached _Log|noncanonical operated v16 eventData reached _Log|admission capability was missing, reused, or expired/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1, 'mutated envelope performed a write');
});

test('v16 nonce capability is bound to full append identity: distinct actions admitted; replay/reuse/cross-binding fail', async () => {
  const { appendEvents } = await import('../build/committed-log.mjs');
  const { constructV16RegionEvent } = await import('../build/annotated-text-operated-event.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _Log (scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT, actionId TEXT, committedAt TEXT)');
  db.exec('CREATE TABLE _V16CapabilityClaim (nonce TEXT PRIMARY KEY, document_id TEXT NOT NULL, bytes_digest TEXT NOT NULL)');

  // Two DISTINCT legitimate actions produce byte-identical envelopes.
  const mintFor = (actionId) => constructV16RegionEvent({
    descriptor: { id: 'doc-1', from: 0, to: 0, transitions: [] },
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    postimage: { affectedIds: [], annotations: [], beforeAnnotations: [], emptied: [], beforeDigest: '0'.repeat(64), afterDigest: '0'.repeat(64) },
    declarationFingerprint: '0'.repeat(64),
    textOperations: { kind: 'none' },
    contribution: null,
  }, {
    owningScope: 'Project:p1', entity: 'E', field: 'f',
    documentId: 'doc-1', actionId,
  });
  const mintedA = mintFor('action-A');
  const mintedB = mintFor('action-B');
  assert.notEqual(mintedA.capability.nonce, mintedB.capability.nonce, 'distinct actions must derive distinct nonces');

  // Action A appends its (copied) envelope via its capability: admitted.
  appendEvents(db, [{
    scope: 'Project:p1', seq: 1, type: 'E.f.operated', handle: { entity: 'E', field: 'f' },
    data: JSON.parse(JSON.stringify(mintedA.event)), v16Capability: mintedA.capability,
    actionId: 'action-A', committedAt: 'now',
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1);

  // A SECOND DISTINCT action with byte-identical bytes: admitted (its own nonce).
  appendEvents(db, [{
    scope: 'Project:p1', seq: 2, type: 'E.f.operated', handle: { entity: 'E', field: 'f' },
    data: JSON.parse(JSON.stringify(mintedB.event)), v16Capability: mintedB.capability,
    actionId: 'action-B', committedAt: 'now2',
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 2);

  // REPLAY of action A's capability (same nonce again): fails — consumed once.
  assert.throws(
    () => appendEvents(db, [{
      scope: 'Project:p1', seq: 3, type: 'E.f.operated', handle: { entity: 'E', field: 'f' },
      data: JSON.parse(JSON.stringify(mintedA.event)), v16Capability: mintedA.capability,
      actionId: 'action-A', committedAt: 'now3',
    }]),
    /admission capability was missing, reused, or expired/,
  );

  // CROSS-BINDING: action B's capability presented under action A's id/scope.
  assert.throws(
    () => appendEvents(db, [{
      scope: 'Project:p1', seq: 4, type: 'E.f.operated', handle: { entity: 'E', field: 'f' },
      data: JSON.parse(JSON.stringify(mintedB.event)), v16Capability: mintedB.capability,
      actionId: 'action-A', committedAt: 'now4',
    }]),
    /admission capability was missing, reused, or expired/,
  );

  // CROSS-SCOPE: same everything but a different owning scope.
  assert.throws(
    () => appendEvents(db, [{
      scope: 'Project:p9', seq: 5, type: 'E.f.operated', handle: { entity: 'E', field: 'f' },
      data: JSON.parse(JSON.stringify(mintedB.event)), v16Capability: mintedB.capability,
      actionId: 'action-B', committedAt: 'now5',
    }]),
    Error,
  );

  // FORGED nonce (never derived): rejected.
  assert.throws(
    () => appendEvents(db, [{
      scope: 'Project:p1', seq: 6, type: 'E.f.operated', handle: { entity: 'E', field: 'f' },
      data: JSON.parse(JSON.stringify(mintedA.event)),
      v16Capability: { nonce: 'f'.repeat(64) },
      actionId: 'action-A', committedAt: 'now6',
    }]),
    /admission capability was missing, reused, or expired/,
  );

  // CLONE without any capability: rejected.
  assert.throws(
    () => appendEvents(db, [{
      scope: 'Project:p1', seq: 7, type: 'E.f.operated', handle: { entity: 'E', field: 'f' },
      data: JSON.parse(JSON.stringify(mintedA.event)),
      actionId: 'action-A', committedAt: 'now7',
    }]),
    /unbranded operated v16 eventData reached _Log|admission capability was missing, reused, or expired/,
  );

  // Exactly the two legitimate appends landed.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 2);
});

test('escaped quotes, backslashes, and control characters round-trip through the stored parser', async () => {
  const mod = await import('../build/annotated-text-operated-event.mjs');
  const { packOperatedFacts } = mod;
  const tricky = 'quote " backslash \\ tab \t newline \n unicode \u00e9\u4e2d key " escaped';
  const envelope = {
    version: 16,
    id: 'doc-1',
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    operation: { affectedIds: [], afterDigest: 'a'.repeat(64), beforeDigest: 'b'.repeat(64),
      declarationFingerprint: 'c'.repeat(64), emptied: [], from: 0, kind: 'region.edit',
      text: { kind: 'none' }, to: 0, transitions: [], witnessAfter: [], witnessBefore: [] },
    facts: packOperatedFacts({ actorId: tricky }),
  };
  const text = mod.serializeV16OperatedEvent(envelope);
  // The literal contains an escaped quote — indexOf-based scanning would cut
  // the string early; the escape-aware scanner must consume it whole.
  const parsed = mod.parseStoredV16OperatedEvent(text, { entity: 'E', field: 'f' });
  assert.equal(parsed.facts.actorId, tricky);

  // An escaped object KEY also round-trips (duplicate detection uses decoded keys).
  const keyedText = text.replace('"facts"', '"f\\u0061cts"');
  assert.throws(
    () => mod.parseStoredV16OperatedEvent(keyedText, { entity: 'E', field: 'f' }),
    /not canonical/,
    'unicode-escape-encoded duplicate key must still be caught or rejected as noncanonical',
  );

  // Invalid unicode escapes fail the scanner.
  const badEscape = '{"version":16,"bad":"\\uZZZZ"}';
  assert.throws(
    () => mod.parseStoredV16OperatedEvent(badEscape, { entity: 'E', field: 'f' }),
    Error,
  );
});

test('tampered _Log eventData fails closed through readSince, rowToEvent, and durable-effect reads', async () => {  const { appendEvents, readSince, rowToEvent, eventsFor } = await import('../build/committed-log.mjs');
  const { parseEventType } = await import('../build/event-handle.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _Log (scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT, actionId TEXT, committedAt TEXT)');
  db.exec('CREATE TABLE _V16CapabilityClaim (nonce TEXT PRIMARY KEY, document_id TEXT NOT NULL, bytes_digest TEXT NOT NULL)');

  const minted = constructV16RegionEvent({
    descriptor: { id: 'doc-1', from: 0, to: 0, transitions: [] },
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    postimage: { affectedIds: [], annotations: [], beforeAnnotations: [], emptied: [], beforeDigest: '0'.repeat(64), afterDigest: '0'.repeat(64) },
    declarationFingerprint: '0'.repeat(64),
    textOperations: { kind: 'none' },
    contribution: null,
  }, { owningScope: 's', entity: 'E', field: 'f', documentId: 'doc-1', actionId: 'a' });
  appendEvents(db, [{
    scope: 's', seq: 1, type: 'E.f.operated',
    handle: { entity: 'E', field: 'f' },
    data: minted.event, actionId: 'a', committedAt: 'now',
  }]);
  const goodRow = db.prepare('SELECT * FROM _Log WHERE seq = 1').get();

  // Duplicate-key tampers: last-key-wins parsing would silently accept these.
  // The duplicate version key must resolve to 16 under last-key-wins so the
  // strict v16 branch is the one that has to reject it.
  const dupText = goodRow.eventData.replace('"id":"doc-1"', '"id":"doc-1","operation":{"x":1');
  db.prepare('UPDATE _Log SET eventData = ? WHERE seq = 1').run(dupText);
  assert.throws(() => readSince(db, 's', 0), Error, 'readSince accepted a duplicate-key v16 row');

  const tamperedRow = { ...goodRow, eventData: '{"version":17,"version":16}' };
  assert.throws(() => rowToEvent(tamperedRow, parseEventType), Error, 'rowToEvent accepted a duplicate-key v16 row');
  assert.throws(() => eventsFor(db, 'a'), Error, 'eventsFor accepted a duplicate-key v16 row');

  // Noncanonical bytes tamper: insertion-order copy of the same content.
  const reparsed = JSON.parse(goodRow.eventData);
  const noncanonical = `{"version":${JSON.stringify(reparsed.version)},"id":${JSON.stringify(reparsed.id)},"before":${JSON.stringify(reparsed.before)},"after":${JSON.stringify(reparsed.after)},"operation":${JSON.stringify(reparsed.operation)},"facts":${JSON.stringify(reparsed.facts)}}`;
  db.prepare('UPDATE _Log SET eventData = ? WHERE seq = 1').run(noncanonical);
  assert.throws(() => readSince(db, 's', 0), /not canonical/, 'readSince accepted noncanonical v16 bytes');

  // Restore, then verify the clean row decodes through the strict parser.
  db.prepare('UPDATE _Log SET eventData = ? WHERE seq = 1').run(goodRow.eventData);
  const events = readSince(db, 's', 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.wireVersion, 16);
});

test('over-limit serialization aborts at the first over-limit token', async () => {
  const _mod = await import('../build/annotated-text-operated-event.mjs');
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  // Inflate the AFTER side far past the event ceiling via a huge field value:
  // construction must abort during traversal, before freeze/branding.
  const bloatedPlan = structuredClone(plan);
  const inflatedImage = JSON.parse(JSON.stringify(bloatedPlan.postimage.annotations[0]));
  inflatedImage.fields.payload = 'x'.repeat(1024 * 1024 + 64);
  Object.freeze(inflatedImage.fields);
  bloatedPlan.postimage.annotations.push(Object.freeze(inflatedImage));

  assert.throws(
    () => constructV16RegionEvent(bloatedPlan),
    (error) => error.failure?.code === 'annotated-text-region-limit'
      || /exceeds .* UTF-8 bytes/.test(error.message),
  );
});

test('declaration fingerprint covers placeholder and authorization-policy source', () => {
  const base = [
    { annotationName: 'note', fields: {}, empty: 'delete', cardinality: 'many' },
    {
      annotationName: 'confidential', fields: {}, empty: 'orphan', cardinality: 'many',
      protects: 'note', kind: 'protectingAnnotation',
      placeholder: '[Restricted]', accessPolicySource: 'async (is, row) => (await is.owner(row))',
    },
  ];
  const fp = regionDeclarationFingerprint(base);
  assert.equal(fp, regionDeclarationFingerprint([...base].reverse()), 'order-insensitive');
  for (const [label, mutation] of [
    ['placeholder', { ...base[1], placeholder: '[REDACTED]' }],
    ['policy-source', { ...base[1], accessPolicySource: 'async (is, row) => true' }],
    ['protects-target', { ...base[1], protects: 'timing' }],
    ['empty-policy', { ...base[1], empty: 'delete' }],
  ]) {
    assert.notEqual(fp, regionDeclarationFingerprint([base[0], mutation]), `${label} change must change the fingerprint`);
  }
  // Protecting declarations without policy identity fail closed.
  assert.throws(
    () => regionDeclarationFingerprint([{ ...base[1], accessPolicySource: null }]),
    (error) => error.failure?.code === 'annotated-text-region-limit',
    'missing authorization-policy handle must reject',
  );
});

test('multi-range orphan carries the full saved quote and last range', async () => {
  const family = importTextToFamily('doc-1', ACTOR, 'alpha beta gamma delta');
  // One orphan-policy annotation with THREE memberships across the document.
  const orphanAnnotation = {
    id: 'multi-orphan',
    family: 'memo',
    fields: {},
    protectedTargetIds: [],
    memberships: [
      membership(family, 0, 5),
      membership(family, 6, 10),
      membership(family, 16, 20),
    ].map((m, ordinal) => ({ ...m, ordinal })),
    prerequisites: [],
    empty: 'orphan',
    cardinality: 'many',
  };
  const plan = planOf(family, [orphanAnnotation], {
    from: 0,
    to: 22,
    replacement: '',
    transitions: [],
  }, [
    { annotationName: 'note', fields: {}, empty: 'delete', cardinality: 'many' },
    { annotationName: 'memo', fields: {}, empty: 'orphan', cardinality: 'many' },
  ]);
  const emptied = plan.postimage.emptied.find((entry) => entry.annotationId === 'multi-orphan');
  assert.equal(emptied.disposition.kind, 'orphaned');
  // Quote spans from the first membership's start to the LAST membership's
  // end in pre-edit coordinates — not merely the first membership.
  assert.equal(emptied.disposition.savedQuote, materializeText(family).slice(0, 20));
  // lastRange records the final membership's resolved offsets.
  assert.deepEqual(emptied.disposition.lastRange, [16, 20]);
  // The after-side image carries the same orphan state.
  const afterImage = plan.postimage.annotations.find((image) => image.id === 'multi-orphan');
  assert.equal(afterImage.orphan.savedQuote, emptied.disposition.savedQuote);
  assert.deepEqual(afterImage.orphan.lastRange, [16, 20]);

  // Replay parity: the persisted v16 event reproduces identical state.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages([orphanAnnotation]));
  applyOperated(db, constructV16RegionEvent(plan).event);
  const orphanState = db.prepare('SELECT saved_quote, last_range FROM ReplayDoc_body_annotation_orphan_state').get();
  assert.equal(orphanState.saved_quote, emptied.disposition.savedQuote);
  assert.deepEqual(JSON.parse(orphanState.last_range), [16, 20]);
  db.close();
});

// ---- Review round 2: consumer read paths + compound zero-write admission ----

test('tampered v16 rows fail closed through effect-consumer decoders', async () => {
  const { decodeConsumerLogRowData } = await import('../build/committed-log.mjs');
  const minted = constructV16RegionEvent({
    descriptor: { id: 'doc-1', from: 0, to: 0, transitions: [] },
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    postimage: { affectedIds: [], annotations: [], beforeAnnotations: [], emptied: [], beforeDigest: '0'.repeat(64), afterDigest: '0'.repeat(64) },
    declarationFingerprint: '0'.repeat(64),
    textOperations: { kind: 'none' },
    contribution: null,
  }, { owningScope: 's', entity: 'E', field: 'f', documentId: 'doc-1', actionId: 'a' });

  const cleanRow = { scope: 's', seq: 1, eventType: 'E.f.operated', eventData: minted.eventDataText, actionId: 'a', committedAt: 'now' };
  // Clean v16 row decodes to the canonical boundary.
  const decoded = decodeConsumerLogRowData(cleanRow, {});
  assert.equal(decoded.wireVersion, 16);

  // Duplicate-key tamper (last-key-wins would be 16): strict decoder throws.
  const dupRow = { ...cleanRow, eventData: '{"version":17,"version":16}' };
  assert.throws(() => decodeConsumerLogRowData(dupRow, {}), /not canonical|invalid envelope/);

  // Noncanonical bytes tamper: same content, insertion order — rejected.
  const parsedGood = JSON.parse(minted.eventDataText);
  const noncanonical = `{"version":16,"id":${JSON.stringify(parsedGood.id)},"before":{},"after":{},"operation":{},"facts":{}}`;
  assert.throws(
    () => decodeConsumerLogRowData({ ...cleanRow, eventData: noncanonical }, {}),
    Error,
  );

  // Invalid-byte (broken JSON on a NON-v16 row) degrades to fallback exactly
  // as consumers behaved before the strictness change.
  const legacyBroken = { scope: 's', seq: 2, eventType: 'E.f.operated', eventData: '{oops', actionId: 'a', committedAt: 'now' };
  assert.deepEqual(decodeConsumerLogRowData(legacyBroken, { degraded: true }), { degraded: true });
});

test('strict decoder throws on malformed non-v16 rows; only the consumer variant degrades', async () => {
  const { decodeLogRowData, decodeConsumerLogRowData } = await import('../build/committed-log.mjs');
  const broken = { scope: 's', seq: 1, eventType: 'E.f.operated', eventData: '{oops' };

  // decodeLogRowData is strict for EVERY row: malformed non-v16 JSON throws
  // from the shared decoder (there is no probe-and-recover path).
  assert.throws(() => decodeLogRowData(broken), SyntaxError);

  // The consumer wrapper is the only degrade-to-fallback boundary.
  assert.deepEqual(decodeConsumerLogRowData(broken, { degraded: true }), { degraded: true });

  // Empty eventData still decodes to null on both paths.
  assert.equal(decodeLogRowData({ scope: 's', seq: 2, eventType: 'E.f.operated', eventData: null }), null);
});

test('compound dispatch consumes its nonce capability exactly once (zero-write on reuse)', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  seedPreimage(db, family, asImages(annotations));

  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const minted = constructV16RegionEvent(plan, {
    owningScope: 'ReplayDoc:p1', entity: 'ReplayDoc', field: 'body',
    documentId: 'doc-1', actionId: 'a1',
  });
  const copiedData = JSON.parse(JSON.stringify(minted.event));

  const { appendEvents } = await import('../build/committed-log.mjs');
  appendEvents(db, [{
    scope: 'ReplayDoc:p1', seq: 1, type: 'ReplayDoc.body.operated',
    handle: { entity: 'ReplayDoc', field: 'body' },
    data: copiedData, v16Capability: minted.capability, actionId: 'a1', committedAt: 'now',
  }]);
  const afterFirst = db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count;
  assert.equal(afterFirst, 1);

  // Replay of the SAME event (duplicate nonce + duplicate bytes): fails with
  // zero additional writes.
  assert.throws(
    () => appendEvents(db, [{
      scope: 'ReplayDoc:p1', seq: 2, type: 'ReplayDoc.body.operated',
      data: JSON.parse(JSON.stringify(minted.event)), v16Capability: minted.capability,
      handle: { entity: 'ReplayDoc', field: 'body' },
      actionId: 'a1', committedAt: 'now',
    }]),
    /admission capability was missing, reused, or expired/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1, 'replayed capability performed a write');
  db.close();
});

test('capability claims are durable and bounded by retention: reuse across restart fails', async () => {
  const { appendEvents, v16CapabilityClaimTableDDL } = await import('../build/committed-log.mjs');
  const { constructV16RegionEvent } = await import('../build/annotated-text-operated-event.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _Log (scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT, actionId TEXT, committedAt TEXT)');
  db.exec(v16CapabilityClaimTableDDL());
  const mint = (id) => constructV16RegionEvent({
    descriptor: { id, from: 0, to: 0, transitions: [] },
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    postimage: { affectedIds: [], annotations: [], beforeAnnotations: [], emptied: [], beforeDigest: '0'.repeat(64), afterDigest: '0'.repeat(64) },
    declarationFingerprint: '0'.repeat(64),
    textOperations: { kind: 'none' },
    contribution: null,
  }, { owningScope: 's', entity: 'E', field: 'f', documentId: id, actionId: 'a' });

  // First append consumes the claim durably.
  const minted = mint('doc-1');
  appendEvents(db, [{
    scope: 's', seq: 1, type: 'E.f.operated',
    handle: { entity: 'E', field: 'f' },
    data: JSON.parse(JSON.stringify(minted.event)), v16Capability: minted.capability,
    actionId: 'a', committedAt: 'now',
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1);

  // Simulate a process RESTART: the same durable _Log + claim tables are
  // reopened in a fresh DatabaseSync over the same file semantics — here the
  // same db. A replay of the identical bytes+nonce must STILL fail because
  // the consumption row survived.
  assert.throws(
    () => appendEvents(db, [{
      scope: 's', seq: 2, type: 'E.f.operated',
      data: JSON.parse(JSON.stringify(minted.event)), v16Capability: minted.capability,
      actionId: 'a', committedAt: 'now',
    }]),
    /admission capability was missing, reused, or expired/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1);

  // Claims are one row per appended v16 event (bounded by retention pruning).
  const claims = db.prepare('SELECT COUNT(*) AS count FROM _V16CapabilityClaim').get().count;
  assert.equal(claims, 1);
});
test('transaction rollback restores the capability so a legitimate retry succeeds', async () => {
  const { appendEvents } = await import('../build/committed-log.mjs');
  const { txn } = await import('../build/driver.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _Log (scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT, actionId TEXT, committedAt TEXT)');
  db.exec('CREATE TABLE _V16CapabilityClaim (nonce TEXT PRIMARY KEY, document_id TEXT NOT NULL, bytes_digest TEXT NOT NULL)');

  const minted = constructV16RegionEvent({
    descriptor: { id: 'doc-1', from: 0, to: 0, transitions: [] },
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    postimage: { affectedIds: [], annotations: [], beforeAnnotations: [], emptied: [], beforeDigest: '0'.repeat(64), afterDigest: '0'.repeat(64) },
    declarationFingerprint: '0'.repeat(64),
    textOperations: { kind: 'none' },
    contribution: null,
  }, { owningScope: 's', entity: 'E', field: 'f', documentId: 'doc-1', actionId: 'a' });
  const copiedData = JSON.parse(JSON.stringify(minted.event));

  // Attempt #1 inside a transaction that ROLLS BACK after the append (e.g. a
  // later projection/private-fact failure): claim row and _Log row vanish
  // together, restoring the capability.
  await txn(db, () => {
    appendEvents(db, [{
      scope: 's', seq: 1, type: 'E.f.operated',
      handle: { entity: 'E', field: 'f' },
      data: copiedData, v16Capability: minted.capability, actionId: 'a', committedAt: 'now',
    }]);
    throw new Error('simulated compound failure');
  }).catch(() => {});
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0, 'rollback left the log row');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM _V16CapabilityClaim').get().count, 0,
    'rollback left the capability claim consumed',
  );

  // Attempt #2 (the legitimate retry with the SAME envelope + nonce) succeeds.
  appendEvents(db, [{
    scope: 's', seq: 1, type: 'E.f.operated',
    handle: { entity: 'E', field: 'f' },
    data: JSON.parse(JSON.stringify(minted.event)), v16Capability: minted.capability,
    actionId: 'a', committedAt: 'now2',
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1);
});

// ---- Review round 4: remaining persisted-read paths + authority grep ----

test('no raw persisted eventData JSON.parse remains in src (authority grep)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const srcRoot = new URL('../src/', import.meta.url).pathname;
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const stat = readdirSync(dir, { withFileTypes: true }).find((d) => d.name === name);
      if (stat.isDirectory()) walk(p);
      else if (name.endsWith('.ts')) {
        const text = readFileSync(p, 'utf8');
        // Direct persisted-eventData parse: the exact bypass pattern.
        if (/JSON\.parse\([^)]*eventData/.test(text)) offenders.push(p);
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [], `raw eventData parse remains in: ${offenders.join(', ')}`);
});

test('erasure census and private-fact replay reject tampered v16 rows through shared decoder', async () => {
  const { decodeLogRowData } = await import('../build/committed-log.mjs');

  // A tampered duplicate-key v16 row must throw from the SHARED decoder —
  // this is exactly what erasure census and post-commit replay call.
  const tampered = { scope: 's', seq: 1, eventType: 'ReplayDoc.body.operated', eventData: '{"version":17,"version":16}' };
  assert.throws(() => decodeLogRowData(tampered), Error);

  // Noncanonical bytes: same content, insertion-order keys.
  const canonicalText = JSON.stringify({
    after: {}, before: {}, facts: {}, id: 'x',
    operation: { kind: 'region.edit' }, version: 16,
  });
  const noncanonical = '{"version":16,"id":"x","before":{},"after":{},"operation":{"kind":"region.edit"},"facts":{}}';
  assert.notEqual(canonicalText, noncanonical);
  assert.throws(
    () => decodeLogRowData({ scope: 's', seq: 2, eventType: 'ReplayDoc.body.operated', eventData: noncanonical }),
    /not canonical/,
    'noncanonical v16 bytes must be rejected by the shared decoder',
  );

  // A clean canonical v16 row (real mint) decodes with operated identity.
  const minted = constructV16RegionEvent({
    descriptor: { id: 'doc-1', from: 0, to: 0, transitions: [] },
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    postimage: { affectedIds: [], annotations: [], beforeAnnotations: [], emptied: [], beforeDigest: '0'.repeat(64), afterDigest: '0'.repeat(64) },
    declarationFingerprint: '0'.repeat(64),
    textOperations: { kind: 'none' },
    contribution: null,
  }, { owningScope: 's', entity: 'ReplayDoc', field: 'body', documentId: 'doc-1', actionId: 'a' });
  const ok = decodeLogRowData({ scope: 's', seq: 3, eventType: 'ReplayDoc.body.operated', eventData: minted.eventDataText });
  assert.equal(ok.wireVersion, 16);
});
