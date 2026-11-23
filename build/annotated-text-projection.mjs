// Annotated-text projection handlers — extracted from src/entity/projection.ts
// so entity projection stays focused on generic row materialization while
// annotatedText owns its initialization, imported-range seeding, operated-event
// reducers (text.apply/replace, annotation apply/update/remove, region.edit),
// retirement, and removal cleanup.

import { serializeField, resolveStrategy } from './field-strategy.mjs';
import * as eventHandle from './event-handle.mjs';
import { assertWellFormedText, canonicalTextOp } from './annotated-text.mjs';
import {
  applyTextOperation as applyContinuousTextOperation,
  compactTextFamilyCheckpoint,
  importTextToFamily,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  restoreTextFamilySerialized,
  serializeCompactTextFamilyCheckpoint,
} from './annotated-text-continuous.mjs';
import { resolveDeclarationMeasurementExtension } from './annotated-text-field.mjs';
import { annotationRangeRows, attachAnnotationRange, canonicalEndpointJSON, loadAnnotationImages } from './annotated-text-storage.mjs';
import { normalizeOperatedEvent,                                                       } from './annotated-text-operated-event.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
  reduceRegionPostimage,
  regionDeclarationFingerprint,
  regionImageFromStored,
  REGION_POSTIMAGE_DISAGREES,


} from './annotated-text-region-reducer.mjs';
import { assertStructuralEndpoint } from './annotated-text-family.mjs';
import { invalidateAnnotatedTextSnapshotCache } from './annotated-text-snapshot.mjs';
import { frozenJsonSnapshot } from './frozen-json.mjs';

import { rawRow } from './entity/query.mjs';




















































































function isTextRevision(value         )                        {
  const record = value                           ;
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(record).sort().join() === 'frontier,structuralRevision' &&
    Number.isSafeInteger(record.structuralRevision          ) && (record.structuralRevision          ) >= 1 &&
    Array.isArray(record.frontier);
}

/** Event types contributed by annotatedText fields to an entity projection. */
export function annotatedTextProjectionEventTypes(name        , fields        )           {
  return Object.entries(fields)
    .filter(([, descriptor]) => descriptor.kind === 'annotatedText')
    .flatMap(([fieldName]) => [
      eventHandle.native(name, fieldName, 'operated').type,
      eventHandle.native(name, fieldName, 'retired').type,
    ]);
}

/** Reject creating a document whose id has been permanently retired. */
export function assertAnnotatedTextNotRetired(db    , name        , fields        , documentId         )       {
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind === 'annotatedText' && db.prepare(`SELECT 1 FROM ${name}_${fieldName}_retired WHERE document_id = ?`).get(documentId)) {
      throw new Error(`${name}.${fieldName} document id is permanently retired`);
    }
  }
}

/** Tear down protected-target FK edges before deleting a document row. */
export function cleanupAnnotatedTextProtectedTargets(db    , name        , fields        , documentId         )       {
  if (!documentId) return;
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'annotatedText') continue;
    const prefix = `${name}_${fieldName}`;
    db.prepare(
      `DELETE FROM ${prefix}_annotation_protected_target
       WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)
          OR target_annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`,
    ).run(documentId, documentId);
    if (typeof documentId === 'string') invalidateAnnotatedTextSnapshotCache(db, prefix, documentId);
  }
}

export function initializeAnnotatedText({ name, fields, event, db, row, asyncSeed = false }






 )                       {
  const metadata = event.data?.__workbench?.annotatedText;
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'annotatedText') continue;
    const imported = metadata?.[fieldName]                                     ;
    const initialBlockId = imported?.initialBlockId;
    if (!imported || imported.version !== 1 || typeof imported.actor !== 'string' || !/^[0-9a-f]{32}$/.test(imported.actor) ||
        !Array.isArray(imported.blocks) || imported.blocks.length === 0 || typeof initialBlockId !== 'string' || initialBlockId.length === 0 ||
        imported.blocks[0]?.id !== initialBlockId) {
      throw new Error(`${name}.${fieldName} created event is missing initial block metadata`);
    }
    const prefix = `${name}_${fieldName}`;
    for (const [blockIndex, importedBlock] of imported.blocks.entries()) {
      if (!importedBlock || typeof importedBlock !== 'object' || Array.isArray(importedBlock) ||
          (Object.keys(importedBlock).length < 3 || Object.keys(importedBlock).length > 6) ||
          typeof importedBlock.id !== 'string' || importedBlock.id.length === 0 || typeof importedBlock.text !== 'string' ||
          (importedBlock.fields !== null && (!importedBlock.fields || typeof importedBlock.fields !== 'object' || Array.isArray(importedBlock.fields)))) {
        throw new Error(`${name}.${fieldName} created event has invalid imported block ${blockIndex}`);
      }
      for (const key of Object.keys(importedBlock)) if (!['id', 'text', 'fields', 'measurements'].includes(key)) throw new Error(`${name}.${fieldName} created event has unknown imported block key '${key}'`);
      assertWellFormedText(importedBlock.text);
      if (importedBlock.text.length === 0 && imported.blocks.some((candidate) => candidate.fields !== null)) throw new Error(`${name}.${fieldName} created event has an empty imported block`);
    }
    const fullText = imported.blocks.map((importedBlock) => importedBlock.text).join('\n');
    const family = importTextToFamily(row.id          , imported.actor, fullText);
    const checkpoint = serializeCompactTextFamilyCheckpoint(family);
    const state = db.prepare(`SELECT * FROM ${prefix}_state WHERE document_id = ?`).get(row.id);
    if (state) {
      let expected = false;
      try {
        expected = state.structure_version === 1
          && JSON.stringify(compactTextFamilyCheckpoint(restoreTextFamilySerialized(String(state.family_checkpoint)))) === checkpoint;
      } catch {
        expected = false;
      }
      if (!expected) throw new Error(`${name}.${fieldName} created projection conflicts with existing initialization`);
      continue;
    }
    db.prepare(`INSERT INTO ${prefix}_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)`)
      .run(row.id, checkpoint);
    const measurementByFamily = new Map();
    for (const importedBlock of imported.blocks) {
      const importedMeasurements = importedBlock.measurements ?? [];
      if (!Array.isArray(importedMeasurements)) throw new Error(`${name}.${fieldName} created event imported measurements are invalid`);
      for (const measurement of importedMeasurements) {
        if (!measurement || typeof measurement !== 'object' || Object.keys(measurement).length !== 4 || typeof measurement.id !== 'string' || typeof measurement.family !== 'string' || !Number.isSafeInteger(measurement.formatVersion) || !Object.hasOwn(measurement, 'payload')) throw new Error(`${name}.${fieldName} created event imported measurement is invalid`);
        if (measurementByFamily.has(measurement.family)) throw new Error(`${name}.${fieldName} created event has duplicate measurement family`);
        measurementByFamily.set(measurement.family, measurement);
      }
    }
    for (const [measurementFamily, measurement] of measurementByFamily) {
      const config = descriptor.measurements .find((entry) => entry.measurementName === measurementFamily);
      const extension = config && resolveDeclarationMeasurementExtension(config);
      if (!config || measurement.formatVersion !== config.formatVersion || !extension) throw new Error(`${name}.${fieldName} created event measurement declaration mismatch`);
      let payload;
      try { payload = frozenJsonSnapshot(measurement.payload); } catch { throw new Error(`${name}.${fieldName} created event measurement payload is not JSON`); }
      try { if (extension.validate({ version: 1, formatVersion: config.formatVersion, blockText: fullText, payload }) !== undefined) throw new Error('returned a value'); } catch { throw new Error(`${name}.${fieldName} created event measurement validation failed`); }
      db.prepare(`INSERT INTO ${prefix}_measurement (id, document_id, family, format_version, payload) VALUES (?, ?, ?, ?, ?)`).run(measurement.id, row.id, measurementFamily, config.formatVersion, JSON.stringify(payload));
    }
    if (imported.ranges !== undefined) {
      const ranges = imported.ranges;
      if (asyncSeed) {
        return Promise.resolve(
          seedImportedAnnotationRangesAsync({ name, fieldName, prefix, descriptor, db, row, family, fullText, ranges }),
        ).then(() => {
          invalidateAnnotatedTextSnapshotCache(db, prefix, row.id          );
        });
      }
      seedImportedAnnotationRanges({ name, fieldName, prefix, descriptor, db, row, family, fullText, ranges });
    }
    invalidateAnnotatedTextSnapshotCache(db, prefix, row.id          );
  }
}

const ANNOTATED_SEED_YIELD_EVERY = 250;
function yieldToEventLoop()                {
  return new Promise((resolve) => setImmediate(resolve));
}












function projectImportedRange(args                             , index        , range                         )       {
  const { name, fieldName, prefix, descriptor, db, row, family, fullText } = args;
  const frontier = family.checkpoint.frontier;
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw new Error(`${name}.${fieldName} created event imported range ${index} is invalid`);
  }
  const allowedRange = new Set(['annotationId', 'family', 'start', 'end', 'fields']);
  for (const key of Object.keys(range)) {
    if (!allowedRange.has(key)) throw new Error(`${name}.${fieldName} created event imported range ${index} has unknown key '${key}'`);
  }
  const { annotationId, family: rangeFamily, start, end } = range;
  if (typeof annotationId !== 'string' || annotationId.length === 0) {
    throw new Error(`${name}.${fieldName} created event imported range ${index} annotationId must be a non-empty string`);
  }
  if (typeof rangeFamily !== 'string' || rangeFamily.length === 0) {
    throw new Error(`${name}.${fieldName} created event imported range ${index} family must be a non-empty string`);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start          ) < 0 || (end          ) <= (start          ) || (end          ) > fullText.length) {
    throw new Error(`${name}.${fieldName} created event imported range ${index} offsets are invalid`);
  }
  const declared = descriptor.annotations?.find((entry) => entry.annotationName === rangeFamily);
  if (!declared) throw new Error(`${name}.${fieldName} created event imported range ${index} family '${rangeFamily}' is not declared`);
  const fieldEntries = Object.entries(declared.fields);
  const supplied = (range.fields ?? {})                           ;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new Error(`${name}.${fieldName} created event imported range ${index} fields must be a non-array object`);
  }
  const suppliedNames = Object.keys(supplied).sort();
  const unknownFields = suppliedNames.filter((key) => !fieldEntries.some(([fName]) => fName === key));
  if (unknownFields.length > 0) {
    throw new Error(`${name}.${fieldName} created event imported range ${index} fields has unknown field(s) '${unknownFields.join("', '")}'`);
  }
  const missingRequired = fieldEntries
    .filter(([fName, field]) => !field.optional && field.nullable !== true && !Object.hasOwn(supplied, fName))
    .map(([fName]) => fName);
  if (missingRequired.length > 0) {
    throw new Error(`${name}.${fieldName} created event imported range ${index} fields is missing required field(s) '${missingRequired.join("', '")}'`);
  }
  const storedFields = fieldEntries.map(([declaredName, field]) => {
    if (!Object.hasOwn(supplied, declaredName)) return null;
    const value = supplied[declaredName];
    if (value === null && field.nullable === true) return null;
    const strategy = resolveStrategy(field.kind);
    const validation = strategy.validate(value, field);
    if (validation !== true || (typeof field.validate === 'function' && field.validate(value) !== true)) {
      throw new Error(`${name}.${fieldName} created event imported range ${index} field '${declaredName}' failed validation`);
    }
    return serializeField(field, value);
  });
  let startEndpoint;
  let endEndpoint;
  try {
    startEndpoint = resolveOffsetToEndpoint(family, start          , frontier, 'right');
    endEndpoint = resolveOffsetToEndpoint(family, end          , frontier, 'right');
  } catch (error) {
    throw new Error(`${name}.${fieldName} created event imported range ${index} offsets cannot be resolved: ${(error         ).message}`);
  }
  db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`)
    .run(annotationId, row.id, row[descriptor.project ], row[descriptor.owner ], rangeFamily);
  if (fieldEntries.length) {
    const names = fieldEntries.map(([declaredName]) => declaredName);
    db.prepare(`INSERT INTO ${prefix}_annotation_${rangeFamily} (annotation_id, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`)
      .run(annotationId, ...storedFields);
  }
  attachAnnotationRange(db, prefix, row.id          , annotationId          , startEndpoint, endEndpoint, 0);
}

function seedImportedAnnotationRanges(args                                                                          )       {
  for (const [index, range] of args.ranges.entries()) {
    projectImportedRange(args, index, range);
  }
}

async function seedImportedAnnotationRangesAsync(args                                                                          )                {
  for (const [index, range] of args.ranges.entries()) {
    projectImportedRange(args, index, range);
    if (index % ANNOTATED_SEED_YIELD_EVERY === ANNOTATED_SEED_YIELD_EVERY - 1) {
      await yieldToEventLoop();
    }
  }
}

/**
 * Handle annotatedText native events (`retired` and `operated`). Returns true
 * when the event was handled by an annotatedText field, false otherwise.
 */
export function applyAnnotatedTextNativeEvent({ name, fields, handle, event, db }





 )          {
  if (handle.kind !== eventHandle.EventKind.native) return false;
  const descriptor = fields[handle.field];
  if (descriptor?.kind !== 'annotatedText') return false;
  if (handle.nativeName === 'retired') {
    const data = event.data;
    if (!data || data.version !== 1 || typeof data.id !== 'string' || !data.id || typeof data.generation !== 'string' || !data.generation || typeof data.retiredAt !== 'string') {
      throw new Error(`${name}.${handle.field}.retired has invalid facts`);
    }
    const existing = db.prepare(`SELECT generation FROM ${name}_${handle.field}_retired WHERE document_id = ?`).get(data.id);
    if (existing && existing.generation !== data.generation) throw new Error(`${name}.${handle.field}.retired generation conflicts`);
    db.prepare(`INSERT OR IGNORE INTO ${name}_${handle.field}_retired (document_id, generation, retired_at) VALUES (?, ?, ?)`).run(data.id, data.generation, data.retiredAt);
    invalidateAnnotatedTextSnapshotCache(db, `${name}_${handle.field}`, data.id);
    return true;
  }
  if (handle.nativeName === 'operated') {
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.id !== 'string' || data.id.length === 0) {
      throw new Error(`${name}.${handle.field}.operated event has no data`);
    }
    const canonical = normalizeOperatedEvent(data, { entity: name, field: handle.field });
    applyCanonicalAnnotatedTextOperation({ name, handle, db, descriptor, canonical });
    return true;
  }
  return false;
}

function canonicalToReplayPayload(canonical                        )                   {
  const version = canonical.wireVersion === 14 ? 14 : 16;
  let operation                               ;
  switch (canonical.kind) {
    case 'text.apply':
      operation = Object.freeze({ kind: 'text.apply', operation: canonical.operation });
      break;
    case 'text.replace':
      operation = Object.freeze({ kind: 'text.replace', operations: [...canonical.operations]                                   });
      break;
    case 'annotation.apply-range':
      operation = Object.freeze({
        kind: 'annotation.apply-range',
        annotation: canonical.annotation                                       ,
        selection: canonical.selection,
      });
      break;
    case 'annotation.remove':
      operation = Object.freeze({ kind: 'annotation.remove', annotationId: canonical.annotationId });
      break;
    case 'annotation.update':
      operation = Object.freeze({
        kind: 'annotation.update',
        annotation: canonical.annotation                                       ,
        selection: canonical.selection,
        ...(canonical.historyAuthored ? { authored: 'history' } : {}),
      });
      break;
    default:
      throw new Error('region.edit replayed events are applied from the canonical event, never through the replay payload');
  }
  return Object.freeze({
    id: canonical.id,
    version,
    before: canonical.before                           ,
    after: canonical.after                           ,
    operation,
    facts: canonical.facts                            ,
  })                    ;
}

export function applyCanonicalAnnotatedTextOperation({ name, handle, db, descriptor, canonical }





 ) {
  const prefix = `${name}_${handle.field}`;
  switch (canonical.kind) {
    case 'text.apply':
    case 'text.replace':
    case 'annotation.apply-range':
    case 'annotation.remove':
      projectFromCanonical({ name, handle, db, descriptor, canonical });
      break;
    case 'annotation.update':
      projectBlocklessAnnotationUpdate({ name, handle, db, descriptor, data: canonicalToReplayPayload(canonical) });
      break;
    case 'region.edit':
      projectRegionEdit({ name, handle, db, descriptor, canonical });
      break;
    default: throw new Error(`${name}.${handle.field}.operated event has unknown operation kind`);
  }
  invalidateAnnotatedTextSnapshotCache(db, prefix, canonical.id);
}

function projectFromCanonical({ name, handle, db, descriptor, canonical }





 ) {
  const data = canonicalToReplayPayload(canonical);
  switch (canonical.kind) {
    case 'text.apply': return projectBlocklessTextApply({ name, handle, db, descriptor, data });
    case 'text.replace': return projectBlocklessTextReplace({ name, handle, db, descriptor, data });
    case 'annotation.apply-range': return projectBlocklessAnnotationApplyRange({ name, handle, db, descriptor, data });
    case 'annotation.remove': return projectBlocklessAnnotationRemove({ name, handle, db, data });
    default: throw new Error(`${name}.${handle.field}.operated event has unknown operation kind`);
  }
}

function projectBlocklessTextApply({ name, handle, db, descriptor, data }                                                                                                                       ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'text.apply' || !Array.isArray(operation.operation) ||
      !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v${data.version} text.apply event has invalid data`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v14 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v14 event conflicts with projection state`);
  let canonical;
  try { canonical = canonicalTextOp(operation.operation); } catch { throw new Error(`${name}.${handle.field}.operated v14 text operation is invalid`); }
  if (JSON.stringify(canonical) !== JSON.stringify(operation.operation) || JSON.stringify(canonical[4]) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v14 text operation is not canonical or has the wrong frontier`);
  let next;
  try { next = applyContinuousTextOperation(current, canonical); } catch { throw new Error(`${name}.${handle.field}.operated v14 text operation is not applicable to prior state`); }
  if (JSON.stringify(data.after.frontier) !== JSON.stringify(next.checkpoint.frontier)) throw new Error(`${name}.${handle.field}.operated v${data.version} family does not match the operation`);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`).run(data.after.structuralRevision, serializeCompactTextFamilyCheckpoint(next), data.id);
  applyEmptiedAnnotationDispositions({ name, handle, db, prefix, data });
  applyAnnotationUpdateFacts({ name, handle, db, prefix, descriptor, data });
  if (f.annotation !== null) {
    if (!f.selectedRange) throw new Error(`${name}.${handle.field}.operated paste has no selected range`);
    const annotation = f.annotation;
    if (db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ?`).get(annotation.id)) {
      throw new Error(`${name}.${handle.field}.operated paste annotation already exists`);
    }
    projectBlocklessAnnotationApplyRange({ name, handle, db, descriptor, data: {
      ...data,
      version: 14,
      before: data.after,
      operation: {
        kind: 'annotation.apply-range',
        annotation,
        selection: {
          startOffset: projectEndpointToOffset(next, assertStructuralEndpoint(f.selectedRange.start)),
          endOffset: projectEndpointToOffset(next, assertStructuralEndpoint(f.selectedRange.end)),
        },
      },
    } });
  }
}

function projectBlocklessTextReplace({ name, handle, db, descriptor, data }                                                                                                                       ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  if (!operation || operation.kind !== 'text.replace' || !Array.isArray(operation.operations) || operation.operations.length !== 2 ||
      !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v${data.version} text.replace event has invalid data`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v14 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v14 event conflicts with projection state`);
  let next = current;
  for (const raw of operation.operations) {
    let canonical;
    try { canonical = canonicalTextOp(raw); } catch { throw new Error(`${name}.${handle.field}.operated v14 replace operation is invalid`); }
    if (JSON.stringify(canonical[4]) !== JSON.stringify(next.checkpoint.frontier)) throw new Error(`${name}.${handle.field}.operated v14 replace operation has the wrong frontier`);
    try { next = applyContinuousTextOperation(next, canonical); } catch { throw new Error(`${name}.${handle.field}.operated v14 replace operation is not applicable to prior state`); }
  }
  if (JSON.stringify(data.after.frontier) !== JSON.stringify(next.checkpoint.frontier)) throw new Error(`${name}.${handle.field}.operated v${data.version} family does not match the replace`);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`).run(data.after.structuralRevision, serializeCompactTextFamilyCheckpoint(next), data.id);
  applyEmptiedAnnotationDispositions({ name, handle, db, prefix, data });
  applyAnnotationUpdateFacts({ name, handle, db, prefix, descriptor, data });
}

function applyEmptiedAnnotationDispositions({ name, handle, db, prefix, data }                                                                                             ) {
  for (const emptied of data.facts.emptiedAnnotations) {
    if (!emptied || typeof emptied !== 'object' || typeof emptied.annotationId !== 'string' || !emptied.disposition ||
        typeof emptied.disposition !== 'object' || (emptied.disposition.kind !== 'orphaned' && emptied.disposition.kind !== 'deleted')) throw new Error(`${name}.${handle.field}.operated v14 emptied annotation is invalid`);
    const annotation = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(emptied.annotationId, data.id);
    if (!annotation) throw new Error(`${name}.${handle.field}.operated v14 emptied annotation does not exist`);
    if (emptied.disposition.kind === 'orphaned') {
      db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(emptied.annotationId);
      db.prepare(`INSERT INTO ${prefix}_annotation_orphan_state (annotation_id, saved_quote, last_range) VALUES (?, ?, ?)`)
        .run(emptied.annotationId, typeof emptied.disposition.savedQuote === 'string' ? emptied.disposition.savedQuote : '', JSON.stringify(emptied.disposition.lastRange ?? null));
    } else {
      deleteAnnotatedTextAnnotation(db, prefix, emptied.annotationId);
    }
  }
}

function applyAnnotationUpdateFacts({ name, handle, db, prefix, descriptor, data }                                                                                                                                       ) {
  const updates = data.facts.annotationUpdates           ;
  if (!Array.isArray(updates)) throw new Error(`${name}.${handle.field}.operated v${data.version} annotation updates are invalid`);
  const declarations = descriptor.annotations ?? [];
  for (const update of updates) {
    if (!update || typeof update !== 'object' || Array.isArray(update) || typeof (update       ).annotationId !== 'string' || !(update       ).annotationId
      || !(update       ).fields || typeof (update       ).fields !== 'object' || Array.isArray((update       ).fields)) {
      throw new Error(`${name}.${handle.field}.operated v${data.version} annotation update is invalid`);
    }
    const { annotationId, fields } = update                                                             ;
    const stored = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(annotationId, data.id)                                              ;
    if (!stored) throw new Error(`${name}.${handle.field}.operated v${data.version} annotation update target does not exist`);
    const declaration = (declarations              ).find((entry) => entry.annotationName === stored.family);
    const behavior = declaration?.editOverlap;
    if (!behavior || typeof behavior !== 'object' || behavior.kind !== 'fields' || !behavior.fields || typeof behavior.fields !== 'object') {
      throw new Error(`${name}.${handle.field}.operated v${data.version} annotation update family declares no field-patch overlap behavior`);
    }
    for (const key of Object.keys(fields)) {
      if (!Object.hasOwn(declaration.fields ?? {}, key)) throw new Error(`${name}.${handle.field}.operated v${data.version} annotation update writes an undeclared field`);
    }
    const typedRow = db.prepare(`SELECT * FROM ${prefix}_annotation_${stored.family} WHERE annotation_id = ?`).get(annotationId)                                       ;
    if (!typedRow) throw new Error(`${name}.${handle.field}.operated v${data.version} annotation typed row is missing`);
    const fieldNames = Object.keys(fields);
    if (fieldNames.length === 0) throw new Error(`${name}.${handle.field}.operated v${data.version} annotation update carries no fields`);
    let values           ;
    try {
      values = fieldNames.map((fieldName) => serializeField(declaration.fields[fieldName], (fields                           )[fieldName]));
    } catch {
      throw new Error(`${name}.${handle.field}.operated v${data.version} annotation update value is invalid`);
    }
    db.prepare(`UPDATE ${prefix}_annotation_${stored.family} SET ${fieldNames.map((f) => `${f} = ?`).join(', ')} WHERE annotation_id = ?`).run(...values, annotationId);
  }
}

/**
 * Sync `_membership` rows for ONLY the annotations whose range sequence changed
 * between stored state and `postimageRanges`. Unchanged annotations keep their
 * existing `_membership` rows untouched — a fields-only update performs zero
 * membership writes, and a range update touches only the affected annotation(s)
 * (plus any exclusive-trimmed neighbors).
 */
function syncChangedAnnotationMemberships(
  db    ,
  prefix        ,
  documentId        ,
  postimageRanges                                ,
  existingRows                                                                                   ,
)       {
  const storedByAnnotation = new Map                                 ();
  for (const row of existingRows ?? annotationRangeRows(db, prefix, documentId)) {
    let entries = storedByAnnotation.get(row.annotation_id);
    if (!entries) {
      entries = [];
      storedByAnnotation.set(row.annotation_id, entries);
    }
    entries.push([row.start_point, row.end_point]);
  }
  const nextByAnnotation = new Map                                                                                     ();
  for (const entry of postimageRanges) {
    const annotationId = entry.annotationId          ;
    let entries = nextByAnnotation.get(annotationId);
    if (!entries) {
      entries = [];
      nextByAnnotation.set(annotationId, entries);
    }
    entries.push({
      start: entry.start,
      end: entry.end,
      startJson: canonicalEndpointJSON(entry.start),
      endJson: canonicalEndpointJSON(entry.end),
    });
  }
  const allAnnotationIds = new Set        ([...storedByAnnotation.keys(), ...nextByAnnotation.keys()]);
  const deleteStmt = db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`);
  for (const annotationId of allAnnotationIds) {
    const prev = storedByAnnotation.get(annotationId) ?? [];
    const next = nextByAnnotation.get(annotationId) ?? [];
    if (prev.length === next.length
      && prev.every((pair, index) => pair[0] === next[index].startJson && pair[1] === next[index].endJson)) {
      continue;
    }
    deleteStmt.run(annotationId);
    for (let ordinal = 0; ordinal < next.length; ordinal += 1) {
      attachAnnotationRange(db, prefix, documentId, annotationId, next[ordinal].start, next[ordinal].end, ordinal);
    }
  }
}

function projectBlocklessAnnotationApplyRange({ name, handle, db, descriptor, data }                                                                                                                       ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'annotation.apply-range' || !operation.annotation || !operation.selection ||
      !f.annotation || !f.selectedRange || !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v14 annotation.apply-range event has invalid data`);
  const annOp = operation.annotation;
  const annFact = f.annotation;
  if (JSON.stringify(Object.keys(annOp).sort()) !== JSON.stringify(Object.keys(annFact).sort()) ||
      annOp.id !== annFact.id || annOp.family !== annFact.family ||
      JSON.stringify(annOp.fields) !== JSON.stringify(annFact.fields) ||
      JSON.stringify(annOp.protectedTargetIds ?? []) !== JSON.stringify(annFact.protectedTargetIds ?? []) ||
      typeof annOp.id !== 'string' || typeof annOp.family !== 'string' ||
      !annOp.fields || typeof annOp.fields !== 'object' || Array.isArray(annOp.fields)) throw new Error(`${name}.${handle.field}.operated v14 annotation facts do not match the operation`);
  if (f.selectedRange.annotationId !== annOp.id) throw new Error(`${name}.${handle.field}.operated v14 selected range does not match the annotation`);
  const selection = operation.selection                                                  ;
  for (const entry of f.ranges) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.annotationId !== 'string' || !entry.annotationId ||
        !entry.start || typeof entry.start !== 'object' || Array.isArray(entry.start) ||
        !entry.end || typeof entry.end !== 'object' || Array.isArray(entry.end)) {
      throw new Error(`${name}.${handle.field}.operated v14 annotation range is invalid`);
    }
  }
  const appliedRanges = f.ranges.filter((entry     ) => entry.annotationId === annOp.id);
  if (appliedRanges.length !== 1 ||
      JSON.stringify(appliedRanges[0].start) !== JSON.stringify(f.selectedRange.start) ||
      JSON.stringify(appliedRanges[0].end) !== JSON.stringify(f.selectedRange.end)) {
    throw new Error(`${name}.${handle.field}.operated v14 selected range does not match the annotation`);
  }
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v14 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v14 event conflicts with projection state`);
  if (JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.after.frontier) ||
      data.after.structuralRevision !== data.before.structuralRevision) throw new Error(`${name}.${handle.field}.operated v14 annotation apply must not change the text family`);
  const row = rawRow(db, name, data.id);
  if (!row) throw new Error(`${name}.${handle.field}.operated v14 document row is missing`);
  const declared = descriptor.annotations .find((entry) => entry.annotationName === annOp.family);
  if (!declared) throw new Error(`${name}.${handle.field}.operated v14 annotation family is not declared`);
  const declaredCardinality = 'cardinality' in declared ? declared.cardinality : undefined;
  const targetIds = (annOp.protectedTargetIds ?? [])            ;
  if (Array.isArray(targetIds) && targetIds.some((id, index, ids) => typeof id !== 'string' || (index > 0 && ids[index - 1] >= id))) throw new Error(`${name}.${handle.field}.operated v14 protected targets are invalid`);
  for (const targetId of targetIds) {
    const target = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(targetId, data.id);
    if (!target) throw new Error(`${name}.${handle.field}.operated v14 protected target does not exist`);
  }
  const existingAnnotation = db.prepare(`SELECT family FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(annOp.id, data.id);
  if (existingAnnotation && existingAnnotation.family !== annOp.family) throw new Error(`${name}.${handle.field}.operated v14 annotation family cannot change`);
  const fieldNames = Object.keys(declared.fields);
  const suppliedFieldNames = Object.keys(annOp.fields).sort();
  if (suppliedFieldNames.length !== fieldNames.length || [...fieldNames].sort().some((fieldName, index) => suppliedFieldNames[index] !== fieldName)) {
    throw new Error(`${name}.${handle.field}.operated v14 annotation fields disagree with declaration`);
  }
  const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${annOp.family} WHERE annotation_id = ?`).get(annOp.id);
  const values = fieldNames.map((fieldName) => {
    if (!Object.hasOwn(annOp.fields , fieldName)) throw new Error(`${name}.${handle.field}.operated v14 annotation is missing field '${fieldName}'`);
    const field = declared.fields[fieldName];
    const strategy = resolveStrategy(field.kind);
    const validation = strategy.validate(annOp.fields [fieldName], field);
    if (validation !== true || (typeof field.validate === 'function' && field.validate(annOp.fields [fieldName]) !== true)) throw new Error(`${name}.${handle.field}.operated v14 annotation field '${fieldName}' failed validation`);
    return serializeField(field, annOp.fields [fieldName]);
  });
  for (const entry of f.ranges) {
    if (entry.annotationId !== annOp.id &&
        !db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(entry.annotationId, data.id)) {
      throw new Error(`${name}.${handle.field}.operated v14 annotation range names an unknown annotation`);
    }
  }
  const familyByAnnotationId = new Map                ();
  for (const familyRow of db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(data.id)) {
    familyByAnnotationId.set(String(familyRow.id), String(familyRow.family));
  }
  if (!existingAnnotation) familyByAnnotationId.set(annOp.id, annOp.family);
  if (!Number.isSafeInteger(selection.startOffset) || !Number.isSafeInteger(selection.endOffset)) {
    throw new Error(`${name}.${handle.field}.operated v14 annotation selection is invalid`);
  }
  const startOffset = selection.startOffset          ;
  const endOffset = selection.endOffset          ;
  const postimageRanges = f.ranges                                                                                                                                       ;
  const selectedRange = f.selectedRange                                    ;
  for (const entry of postimageRanges) {
    let start        ;
    let end        ;
    try {
      start = projectEndpointToOffset(current, entry.start);
      end = projectEndpointToOffset(current, entry.end);
    } catch {
      throw new Error(`${name}.${handle.field}.operated v14 annotation range is not projectable`);
    }
    if (start >= end) throw new Error(`${name}.${handle.field}.operated v14 annotation range must be forward and non-empty`);
  }
  const currentRangeRows = annotationRangeRows(db, prefix, data.id);
  const currentRanges = currentRangeRows.map((entry) => ({
    annotationId: entry.annotation_id,
    start: JSON.parse(entry.start_point),
    end: JSON.parse(entry.end_point),
  }));
  const selectedStart = projectEndpointToOffset(current, selectedRange.start);
  const selectedEnd = projectEndpointToOffset(current, selectedRange.end);
  if (selectedStart !== startOffset || selectedEnd !== endOffset || selectedStart >= selectedEnd) {
    throw new Error(`${name}.${handle.field}.operated v14 selected range disagrees with the semantic operation`);
  }
  const expectedRanges = [];
  for (const entry of currentRanges) {
    if (entry.annotationId === annOp.id) continue;
    if (declaredCardinality === 'one' && familyByAnnotationId.get(entry.annotationId) === annOp.family) {
      const start = projectEndpointToOffset(current, entry.start);
      const end = projectEndpointToOffset(current, entry.end);
      if (end > selectedStart && start < selectedEnd) {
        if (start < selectedStart) expectedRanges.push({
          annotationId: entry.annotationId,
          start: entry.start,
          end: resolveOffsetToEndpoint(current, selectedStart, current.checkpoint.frontier, 'left'),
        });
        if (end > selectedEnd) expectedRanges.push({
          annotationId: entry.annotationId,
          start: resolveOffsetToEndpoint(current, selectedEnd, current.checkpoint.frontier, 'right'),
          end: entry.end,
        });
        continue;
      }
    }
    expectedRanges.push(entry);
  }
  expectedRanges.push(selectedRange);
  const rangeSignatures = (entries       ) => entries.map((entry) => JSON.stringify([
    entry.annotationId,
    canonicalEndpointJSON(entry.start),
    canonicalEndpointJSON(entry.end),
  ]));
  if (JSON.stringify(rangeSignatures(postimageRanges)) !== JSON.stringify(rangeSignatures(expectedRanges))) {
    throw new Error(`${name}.${handle.field}.operated v14 annotation range postimage disagrees with the semantic operation`);
  }
  if (!existingAnnotation) db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`)
    .run(annOp.id, data.id, row[descriptor.project          ], row[descriptor.owner          ], annOp.family);
  if (fieldNames.length) {
    if (stored) {
      db.prepare(`UPDATE ${prefix}_annotation_${annOp.family} SET ${fieldNames.map((fieldName) => `${fieldName} = ?`).join(', ')} WHERE annotation_id = ?`).run(...values, annOp.id);
    } else {
      db.prepare(`INSERT INTO ${prefix}_annotation_${annOp.family} (annotation_id, ${fieldNames.join(', ')}) VALUES (?, ${fieldNames.map(() => '?').join(', ')})`).run(annOp.id, ...values);
    }
  }
  db.prepare(`DELETE FROM ${prefix}_annotation_protected_target WHERE annotation_id = ? OR target_annotation_id = ?`).run(annOp.id, annOp.id);
  for (const targetId of targetIds) db.prepare(`INSERT INTO ${prefix}_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)`).run(annOp.id, targetId);
  syncChangedAnnotationMemberships(db, prefix, data.id          , f.ranges, currentRangeRows);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ? WHERE document_id = ?`).run(data.after.structuralRevision, data.id);
}

// Semantic atomic annotation.update (#174): one history step replacing an
// EXISTING annotation's fields (and optionally its single range). Modifies ONLY
// affected annotations' `_membership` rows (zero writes for fields-only updates).
function projectBlocklessAnnotationUpdate({ name, handle, db, descriptor, data }                                                                                                                       ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'annotation.update' || !operation.annotation || !f.annotation ||
      !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v${data.version} annotation.update event has invalid data`);
  const historyAuthored = (operation                          ).authored === 'history';
  if (operation.selection !== null &&
      (!operation.selection || typeof operation.selection !== 'object' ||
       !Number.isSafeInteger((operation.selection                             ).startOffset) ||
       !Number.isSafeInteger((operation.selection                           ).endOffset))) {
    throw new Error(`${name}.${handle.field}.operated v14 annotation selection is invalid`);
  }
  const annOp = operation.annotation;
  const annFact = f.annotation;
  if (JSON.stringify(Object.keys(annOp).sort()) !== JSON.stringify(Object.keys(annFact).sort()) ||
      annOp.id !== annFact.id || annOp.family !== annFact.family ||
      JSON.stringify(annOp.fields) !== JSON.stringify(annFact.fields) ||
      JSON.stringify(annOp.protectedTargetIds ?? []) !== JSON.stringify(annFact.protectedTargetIds ?? []) ||
      typeof annOp.id !== 'string' || typeof annOp.family !== 'string' ||
      !annOp.fields || typeof annOp.fields !== 'object' || Array.isArray(annOp.fields)) throw new Error(`${name}.${handle.field}.operated v14 annotation facts do not match the operation`);
  for (const entry of f.ranges) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.annotationId !== 'string' || !entry.annotationId ||
        !entry.start || typeof entry.start !== 'object' || Array.isArray(entry.start) ||
        !entry.end || typeof entry.end !== 'object' || Array.isArray(entry.end)) {
      throw new Error(`${name}.${handle.field}.operated v14 annotation range is invalid`);
    }
  }
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v14 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v14 event conflicts with projection state`);
  if (JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.after.frontier) ||
      data.after.structuralRevision !== data.before.structuralRevision) throw new Error(`${name}.${handle.field}.operated v14 annotation update must not change the text family`);
  const row = rawRow(db, name, data.id);
  if (!row) throw new Error(`${name}.${handle.field}.operated v14 document row is missing`);
  const existingAnnotation = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(annOp.id, data.id);
  if (!existingAnnotation) throw new Error(`${name}.${handle.field}.operated v14 annotation to update does not exist`);
  if (existingAnnotation.family !== annOp.family) throw new Error(`${name}.${handle.field}.operated v14 annotation family cannot change`);
  const declared = descriptor.annotations .find((entry) => entry.annotationName === annOp.family);
  if (!declared) throw new Error(`${name}.${handle.field}.operated v14 annotation family is not declared`);
  const fieldNames = Object.keys(declared.fields);
  const suppliedFieldNames = Object.keys(annOp.fields).sort();
  if (suppliedFieldNames.length !== fieldNames.length || [...fieldNames].sort().some((fieldName, index) => suppliedFieldNames[index] !== fieldName)) {
    throw new Error(`${name}.${handle.field}.operated v14 annotation fields disagree with declaration`);
  }
  const targetIds = (annOp.protectedTargetIds ?? [])            ;
  if (Array.isArray(targetIds) && targetIds.some((id, index, ids) => typeof id !== 'string' || (index > 0 && ids[index - 1] >= id))) throw new Error(`${name}.${handle.field}.operated v14 protected targets are invalid`);
  const liveEdges = (db.prepare(`SELECT target_annotation_id FROM ${prefix}_annotation_protected_target WHERE annotation_id = ? ORDER BY target_annotation_id`).all(annOp.id)                                           ).map((edge) => edge.target_annotation_id);
  if (JSON.stringify(liveEdges) !== JSON.stringify(targetIds)) throw new Error(`${name}.${handle.field}.operated v14 annotation update must not change protected targets`);
  const values = fieldNames.map((fieldName) => {
    if (!Object.hasOwn(annOp.fields , fieldName)) throw new Error(`${name}.${handle.field}.operated v14 annotation is missing field '${fieldName}'`);
    const field = declared.fields[fieldName];
    const strategy = resolveStrategy(field.kind);
    const validation = strategy.validate(annOp.fields [fieldName], field);
    if (validation !== true || (typeof field.validate === 'function' && field.validate(annOp.fields [fieldName]) !== true)) throw new Error(`${name}.${handle.field}.operated v14 annotation field '${fieldName}' failed validation`);
    return serializeField(field, annOp.fields [fieldName]);
  });
  for (const entry of f.ranges) {
    if (!db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(entry.annotationId, data.id)) {
      throw new Error(`${name}.${handle.field}.operated v14 annotation range names an unknown annotation`);
    }
  }
  const postimageRanges = f.ranges                                                                                                                                       ;
  const appliedRanges = postimageRanges.filter((entry) => entry.annotationId === annOp.id);
  if (appliedRanges.length !== 1) throw new Error(`${name}.${handle.field}.operated v14 updated annotation must keep exactly one range`);
  for (const entry of postimageRanges) {
    let start        ;
    let end        ;
    try {
      start = projectEndpointToOffset(current, entry.start);
      end = projectEndpointToOffset(current, entry.end);
    } catch {
      throw new Error(`${name}.${handle.field}.operated v14 annotation range is not projectable`);
    }
    if (start >= end) throw new Error(`${name}.${handle.field}.operated v14 annotation range must be forward and non-empty`);
  }
  const currentRangeRows = annotationRangeRows(db, prefix, data.id);
  const currentRanges = currentRangeRows.map((entry) => ({
    annotationId: entry.annotation_id,
    start: JSON.parse(entry.start_point),
    end: JSON.parse(entry.end_point),
  }));
  const selectedRange = appliedRanges[0];
  let fieldsOnlyUnchanged = false;
  if (historyAuthored) {
    // History-authored compensation restores captured verbatim images.
  } else if (operation.selection !== null) {
    const selection = operation.selection                                              ;
    const selectedStart = projectEndpointToOffset(current, selectedRange.start);
    const selectedEnd = projectEndpointToOffset(current, selectedRange.end);
    if (selectedStart !== selection.startOffset || selectedEnd !== selection.endOffset || selectedStart >= selectedEnd) {
      throw new Error(`${name}.${handle.field}.operated v14 selected range disagrees with the semantic operation`);
    }
    const declaredCardinality = 'cardinality' in declared ? declared.cardinality : undefined;
    const familyByAnnotationId = declaredCardinality === 'one'
      ? new Map(
        (db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(data.id)                                         )
          .map((familyRow) => [String(familyRow.id), String(familyRow.family)]),
      )
      : null;
    const expectedRanges = [];
    for (const entry of currentRanges) {
      if (entry.annotationId === annOp.id) continue;
      if (declaredCardinality === 'one' && familyByAnnotationId?.get(entry.annotationId) === annOp.family) {
        const start = projectEndpointToOffset(current, entry.start);
        const end = projectEndpointToOffset(current, entry.end);
        if (end > selectedStart && start < selectedEnd) {
          if (start < selectedStart) expectedRanges.push({
            annotationId: entry.annotationId,
            start: entry.start,
            end: resolveOffsetToEndpoint(current, selectedStart, current.checkpoint.frontier, 'left'),
          });
          if (end > selectedEnd) expectedRanges.push({
            annotationId: entry.annotationId,
            start: resolveOffsetToEndpoint(current, selectedEnd, current.checkpoint.frontier, 'right'),
            end: entry.end,
          });
          continue;
        }
      }
      expectedRanges.push(entry);
    }
    expectedRanges.push(selectedRange);
    const rangeSignatures = (entries       ) => entries.map((entry) => JSON.stringify([
      entry.annotationId,
      canonicalEndpointJSON(entry.start),
      canonicalEndpointJSON(entry.end),
    ]));
    if (JSON.stringify(rangeSignatures(postimageRanges)) !== JSON.stringify(rangeSignatures(expectedRanges))) {
      throw new Error(`${name}.${handle.field}.operated v14 annotation range postimage disagrees with the semantic operation`);
    }
  } else {
    const rangeSignatures = (entries       ) => entries.map((entry) => JSON.stringify([
      entry.annotationId,
      canonicalEndpointJSON(entry.start),
      canonicalEndpointJSON(entry.end),
    ]));
    if (JSON.stringify(rangeSignatures(postimageRanges)) !== JSON.stringify(rangeSignatures(currentRanges))) {
      throw new Error(`${name}.${handle.field}.operated v14 fields-only update must not move ranges`);
    }
    fieldsOnlyUnchanged = true;
  }
  if (fieldNames.length) {
    const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${annOp.family} WHERE annotation_id = ?`).get(annOp.id);
    if (!stored) throw new Error(`${name}.${handle.field}.operated v14 annotation typed row is missing`);
    db.prepare(`UPDATE ${prefix}_annotation_${annOp.family} SET ${fieldNames.map((fieldName) => `${fieldName} = ?`).join(', ')} WHERE annotation_id = ?`).run(...values, annOp.id);
  }
  if (!fieldsOnlyUnchanged) {
    syncChangedAnnotationMemberships(db, prefix, data.id          , f.ranges, currentRangeRows);
  }
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ? WHERE document_id = ?`).run(data.after.structuralRevision, data.id);
}

function projectBlocklessAnnotationRemove({ name, handle, db, data }                                                                             ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'annotation.remove' || typeof operation.annotationId !== 'string' ||
      !Array.isArray(f.removedAnnotationIds) || f.removedAnnotationIds.length !== 1 || f.removedAnnotationIds[0] !== operation.annotationId ||
      !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v14 annotation.remove event has invalid data`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v14 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v14 event conflicts with projection state`);
  if (JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.after.frontier) ||
      data.after.structuralRevision !== data.before.structuralRevision) throw new Error(`${name}.${handle.field}.operated v14 annotation remove must not change the text family`);
  const annotation = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(operation.annotationId, data.id);
  if (!annotation) throw new Error(`${name}.${handle.field}.operated v14 annotation to remove does not exist`);
  deleteAnnotatedTextAnnotation(db, prefix, operation.annotationId);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ? WHERE document_id = ?`).run(data.after.structuralRevision, data.id);
}

function regionDeclarations(descriptor                              )                      {
  return (descriptor.annotations ?? []).map((entry) => {
    const record = entry








     ;
    const access = record.access;
    const isProtecting = typeof record.protects === 'string';
    return {
      annotationName: String(record.annotationName ?? ''),
      fields: record.fields,
      empty: record.empty,
      cardinality: record.cardinality,
      kind: typeof record.kind === 'string' ? record.kind : undefined,
      protects: typeof record.protects === 'string' ? record.protects : null,
      placeholder: typeof record.placeholder === 'string' ? record.placeholder : null,
      accessPolicySource: isProtecting
        ? (typeof access === 'function' ? Function.prototype.toString.call(access) : null)
        : null,
    };
  });
}

function applyRegionTextOperations(family                                                , text                             ) {
  if (text.kind === 'none') return family;
  if (text.kind === 'delete' || text.kind === 'insert') {
    const canonical = canonicalTextOp(text.operation);
    return applyContinuousTextOperation(family, canonical);
  }
  let next = family;
  for (const raw of text.operations) {
    next = applyContinuousTextOperation(next, canonicalTextOp(raw));
  }
  return next;
}

function projectRegionEdit({ name, handle, db, descriptor, canonical }





 ) {
  const prefix = `${name}_${handle.field}`;
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(canonical.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v16 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== canonical.before.structuralRevision
    || JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(canonical.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v16 event conflicts with projection state`);
  }
  const declarations = regionDeclarations(descriptor);
  const stored = loadAnnotationImages(db, { prefix, documentId: canonical.id, declarations });
  const images                          = stored.map((image) => (
    regionImageFromStored(image, declarations.find((entry) => entry.annotationName === image.family))
  ));
  const namedIds = canonical.transitions.map((transition) => (
    transition.kind === 'create' ? transition.annotation.id : transition.annotationId
  ));
  const closure = computeAffectedClosure({
    annotations: images,
    family: current,
    from: canonical.from,
    to: canonical.to,
    namedIds,
  });
  if (digestAffectedClosure(closure) !== canonical.beforeDigest
    || JSON.stringify(closure.map((image) => image.id)) !== JSON.stringify(canonical.affectedIds)) {
    throw new Error(REGION_POSTIMAGE_DISAGREES);
  }
  if (canonical.declarationFingerprint !== regionDeclarationFingerprint(declarations)
    || JSON.stringify(closure) !== JSON.stringify(canonical.witnessBefore)) {
    throw new Error('region witness disagrees with operated event');
  }
  let afterFamily;
  try {
    afterFamily = applyRegionTextOperations(current, canonical.text);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v16 text operation is not applicable to prior state`);
  }
  if (JSON.stringify(afterFamily.checkpoint.frontier) !== JSON.stringify(canonical.after.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v16 family does not match the operation`);
  }
  let postimage;
  try {
    postimage = reduceRegionPostimage({
      beforeFamily: current,
      afterFamily,
      beforeAnnotations: closure,
      region: { from: canonical.from, to: canonical.to },
      transitions: canonical.transitions,
      declarations,
      expectedBeforeDigest: canonical.beforeDigest,
      declarationFingerprint: regionDeclarationFingerprint(declarations),
    });
  } catch {
    throw new Error(REGION_POSTIMAGE_DISAGREES);
  }
  if (postimage.afterDigest !== canonical.afterDigest) throw new Error(REGION_POSTIMAGE_DISAGREES);
  const emptiedFromFacts = (canonical.facts.emptiedAnnotations             ).map((entry) => JSON.stringify(entry));
  const emptiedFromWitness = postimage.emptied.map((entry) => JSON.stringify({
    annotationId: entry.annotationId,
    disposition: {
      kind: entry.disposition.kind,
      family: entry.disposition.family,
      savedQuote: entry.disposition.savedQuote,
      lastRange: entry.disposition.lastRange,
    },
  }));
  if (JSON.stringify(postimage.annotations) !== JSON.stringify(canonical.witnessAfter)
    || JSON.stringify(emptiedFromFacts.slice().sort()) !== JSON.stringify(emptiedFromWitness.slice().sort())) {
    throw new Error('region witness disagrees with operated event');
  }

  const beforeById = new Map(closure.map((image) => [image.id, image]));
  const afterById = new Map(postimage.annotations.map((image) => [image.id, image]));
  const row = rawRow(db, name, canonical.id);
  if (!row) throw new Error(`${name}.${handle.field}.operated v16 document row is missing`);

  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`)
    .run(canonical.after.structuralRevision, serializeCompactTextFamilyCheckpoint(afterFamily), canonical.id);

  for (const emptied of postimage.emptied) {
    if (emptied.disposition.kind === 'deleted' && !afterById.has(emptied.annotationId)) {
      deleteAnnotatedTextAnnotation(db, prefix, emptied.annotationId);
    } else if (emptied.disposition.kind === 'orphaned') {
      db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(emptied.annotationId);
      db.prepare(`INSERT INTO ${prefix}_annotation_orphan_state (annotation_id, saved_quote, last_range) VALUES (?, ?, ?)`)
        .run(emptied.annotationId, emptied.disposition.savedQuote ?? '', JSON.stringify(emptied.disposition.lastRange ?? null));
    }
  }
  for (const image of postimage.annotations) {
    const existing = beforeById.get(image.id);
    if (!existing) {
      db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`)
        .run(image.id, canonical.id, row[descriptor.project          ], row[descriptor.owner          ], image.family);
      const fieldNames = Object.keys(image.fields);
      if (fieldNames.length) {
        const values = fieldNames.map((fieldName) => serializeField(descriptor.annotations .find((entry) => entry.annotationName === image.family) .fields[fieldName], image.fields[fieldName]));
        db.prepare(`INSERT INTO ${prefix}_annotation_${image.family} (annotation_id, ${fieldNames.join(', ')}) VALUES (?, ${fieldNames.map(() => '?').join(', ')})`)
          .run(image.id, ...values);
      }
    }
    db.prepare(`DELETE FROM ${prefix}_annotation_protected_target WHERE annotation_id = ?`).run(image.id);
    for (const targetId of image.protectedTargetIds) {
      db.prepare(`INSERT INTO ${prefix}_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)`).run(image.id, targetId);
    }
    db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(image.id);
    for (const membership of image.memberships) {
      attachAnnotationRange(db, prefix, canonical.id, image.id, membership.start, membership.end, membership.ordinal);
    }
  }
}

function deleteAnnotatedTextAnnotation(db    , prefix        , annotationId        ) {
  db.prepare(`DELETE FROM ${prefix}_annotation_protected_target WHERE annotation_id = ? OR target_annotation_id = ?`).run(annotationId, annotationId);
  db.prepare(`DELETE FROM ${prefix}_annotation WHERE id = ?`).run(annotationId);
}
