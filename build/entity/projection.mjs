import { getLog } from '../log.mjs';
import { serializeField, flattenStruct, resolveStrategy } from '../field-strategy.mjs';
import * as eventHandle from '../event-handle.mjs';
import { captureDeletedRowAnchor } from '../deleted-row-anchor.mjs';
import { CASCADE_DESCENDANT } from './removal-cascade.mjs';
import { applyTextOp, assertWellFormedText, canonicalTextOp, createTextState, restoreTextCheckpoint, textCheckpoint } from '../annotated-text.mjs';
import {
  applyTextOperation as applyContinuousTextOperation,
  compactTextFamilyCheckpoint,
  importTextToFamily,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  restoreTextFamilySerialized,
  serializeCompactTextFamilyCheckpoint,
  textFamilyCheckpoint as continuousTextFamilyCheckpoint,
} from '../annotated-text-continuous.mjs';
import { resolveDeclarationMeasurementExtension } from '../annotated-text-field.mjs';
import { annotationRangeRows, attachAnnotationRange, canonicalEndpointJSON, loadAnnotationImages } from '../annotated-text-storage.mjs';
import { normalizeOperatedEvent,                                                       } from '../annotated-text-operated-event.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
  reduceRegionPostimage,
  regionDeclarationFingerprint,
  regionImageFromStored,
  REGION_POSTIMAGE_DISAGREES,


} from '../annotated-text-region-reducer.mjs';
import { frozenJsonSnapshot } from '../frozen-json.mjs';
import { markAnnotatedEntityProjection } from '../annotated-text-history.mjs';


import { annotatedTextDeniedPlaceholder, readableFieldNames } from '../field-admission.mjs';

import { rawRow } from './query.mjs';























































































/** Quote a column identifier for generated SQL — entity fields may collide
 *  with SQLite reserved words ('order', 'group', …), which otherwise breaks
 *  the generated INSERT/UPDATE/preimage statements. */
const quoteColumn = (column        )         => `"${column.replace(/"/g, '""')}"`;

function isTextRevision(value         )                        {
  const record = value                           ;
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(record).sort().join() === 'frontier,structuralRevision' &&
    Number.isSafeInteger(record.structuralRevision          ) && (record.structuralRevision          ) >= 1 &&
    Array.isArray(record.frontier);
}

function initializeAnnotatedText({ name, fields, event, db, row, asyncSeed = false }                                                                                           )                       {
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
    // Import validation translates legacy concatenated-block offsets before
    // they reach the event. Keep the projection's text construction identical
    // to that canonicalization so endpoint resolution sees the same LF runs.
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
    // Blockless measurements are DOCUMENT-scoped (the table has no block_id and
    // enforces one row per (document_id, family)); merge the per-block imported
    // measurements across blocks, rejecting a duplicate family.
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
        return seedImportedAnnotationRangesAsync({ name, fieldName, prefix, descriptor, db, row, family, fullText, ranges });
      }
      seedImportedAnnotationRanges({ name, fieldName, prefix, descriptor, db, row, family, fullText, ranges });
    }
  }
}

// Seed create-source annotation ranges (issue #216) in the SAME create
// transaction as the text family: one `_annotation` row, its `_annotation_{family}`
// field row, and one `_membership` row. Endpoints use the membership-valid
// affinity — END = right, START = right (the document-root start resolves to
// left automatically) — matching the runtime range-apply semantics.
//
// A long diarised import can carry thousands of ranges. The projection runs
// synchronously inside the dispatch transaction, so the synchronous seeding
// would otherwise block the event loop for the whole import (health checks /
// worker heartbeats / lease extensions all freeze). `seedImportedAnnotationRangesAsync`
// (used by the projection's `applyAsync`) yields to the event loop every few
// ranges so the server stays responsive; the synchronous path is unchanged.
const ANNOTATED_SEED_YIELD_EVERY = 250;
function yieldToEventLoop()                {
  return new Promise((resolve) => setImmediate(resolve));
}












// One imported range: validate it, resolve its endpoint anchors, and write the
// annotation row, its family field row, and its range membership — all within
// the enclosing create transaction. Shared by the synchronous and the yielding
// seeding loops so the per-range behaviour stays identical in both paths.
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
  // Absent optional/nullable fields are the optional contract — they store as
  // SQL NULL below. Unknown supplied keys and missing required fields still
  // fail closed (scope#3000: the exact-name equality rejected absent
  // optional fields and broke every import that omitted them).
  const unknownFields = suppliedNames.filter((key) => !fieldEntries.some(([fieldName]) => fieldName === key));
  if (unknownFields.length > 0) {
    throw new Error(`${name}.${fieldName} created event imported range ${index} fields has unknown field(s) '${unknownFields.join("', '")}'`);
  }
  const missingRequired = fieldEntries
    .filter(([fieldName, field]) => !field.optional && field.nullable !== true && !Object.hasOwn(supplied, fieldName))
    .map(([fieldName]) => fieldName);
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
    // Release the event loop every ANNOTATED_SEED_YIELD_EVERY ranges so a long
    // import never freezes health checks / heartbeats in one unbounded block.
    if (index % ANNOTATED_SEED_YIELD_EVERY === ANNOTATED_SEED_YIELD_EVERY - 1) {
      await yieldToEventLoop();
    }
  }
}

function applyAnnotatedTextOperation({ name, fields, handle, event, db }                                                                                                     ) {
  if (handle.kind !== eventHandle.EventKind.native || handle.nativeName !== 'operated') return false;
  const descriptor = fields[handle.field];
  if (descriptor?.kind !== 'annotatedText') return false;
  const data = event.data;
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error(`${name}.${handle.field}.operated event has no data`);
  }
  const canonical = normalizeOperatedEvent(data, { entity: name, field: handle.field });
  return applyCanonicalAnnotatedTextOperation({ name, handle, db, descriptor, canonical });
}

// Map a normalized canonical event to the loose reducer payload the v13/v14
// replay reducers consume. The payload is derived ONLY from the canonical
// boundary produced by normalizeOperatedEvent — the raw wire envelope is never
// passed to a reducer, so replay has exactly one path. v15 region.edit is
// applied directly from the canonical event and never goes through this map.
function canonicalToReplayPayload(canonical                        )                   {
  const version = canonical.wireVersion === 13 ? 13 : canonical.wireVersion === 14 ? 14 : 15;
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

// Reducers consume the canonical event. They do not pick a kind from the wire
// version — v13/v14 keep their existing family-proof checks, v15 uses the
// shared region postimage reducer.
export function applyCanonicalAnnotatedTextOperation({ name, handle, db, descriptor, canonical }





 ) {
  switch (canonical.kind) {
    case 'text.apply':
    case 'text.replace':
    case 'annotation.apply-range':
    case 'annotation.remove':
      return projectFromCanonical({ name, handle, db, descriptor, canonical });
    case 'annotation.update': return projectBlocklessAnnotationUpdate({ name, handle, db, descriptor, data: canonicalToReplayPayload(canonical) });
    case 'region.edit': return projectRegionEdit({ name, handle, db, descriptor, canonical });
    default: throw new Error(`${name}.${handle.field}.operated event has unknown operation kind`);
  }
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


function projectBlocklessTextApply({ name, handle, db, descriptor, data }                                                                                                          ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'text.apply' || !Array.isArray(operation.operation) ||
      (data.version === 13 && !f.family) || !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v${data.version} text.apply event has invalid data`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v13 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 event conflicts with projection state`);
  let canonical;
  try { canonical = canonicalTextOp(operation.operation); } catch { throw new Error(`${name}.${handle.field}.operated v13 text operation is invalid`); }
  if (JSON.stringify(canonical) !== JSON.stringify(operation.operation) || JSON.stringify(canonical[4]) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 text operation is not canonical or has the wrong frontier`);
  let next;
  try { next = applyContinuousTextOperation(current, canonical); } catch { throw new Error(`${name}.${handle.field}.operated v13 text operation is not applicable to prior state`); }
  if ((data.version === 13 && JSON.stringify(continuousTextFamilyCheckpoint(next)) !== JSON.stringify(f.family)) ||
      JSON.stringify(data.after.frontier) !== JSON.stringify(next.checkpoint.frontier)) throw new Error(`${name}.${handle.field}.operated v${data.version} family does not match the operation`);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`).run(data.after.structuralRevision, serializeCompactTextFamilyCheckpoint(next), data.id);
  applyEmptiedAnnotationDispositions({ name, handle, db, prefix, data });
  applyAnnotationUpdateFacts({ name, handle, db, prefix, descriptor, data });
}

function projectBlocklessTextReplace({ name, handle, db, descriptor, data }                                                                                                          ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'text.replace' || !Array.isArray(operation.operations) || operation.operations.length !== 2 ||
      (data.version === 13 && !f.family) || !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v${data.version} text.replace event has invalid data`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v13 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 event conflicts with projection state`);
  let next = current;
  for (const raw of operation.operations) {
    let canonical;
    try { canonical = canonicalTextOp(raw); } catch { throw new Error(`${name}.${handle.field}.operated v13 replace operation is invalid`); }
    if (JSON.stringify(canonical[4]) !== JSON.stringify(next.checkpoint.frontier)) throw new Error(`${name}.${handle.field}.operated v13 replace operation has the wrong frontier`);
    try { next = applyContinuousTextOperation(next, canonical); } catch { throw new Error(`${name}.${handle.field}.operated v13 replace operation is not applicable to prior state`); }
  }
  if ((data.version === 13 && JSON.stringify(continuousTextFamilyCheckpoint(next)) !== JSON.stringify(f.family)) ||
      JSON.stringify(data.after.frontier) !== JSON.stringify(next.checkpoint.frontier)) throw new Error(`${name}.${handle.field}.operated v${data.version} family does not match the replace`);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`).run(data.after.structuralRevision, serializeCompactTextFamilyCheckpoint(next), data.id);
  applyEmptiedAnnotationDispositions({ name, handle, db, prefix, data });
  applyAnnotationUpdateFacts({ name, handle, db, prefix, descriptor, data });
}

function applyEmptiedAnnotationDispositions({ name, handle, db, prefix, data }                                                                                             ) {
  for (const emptied of data.facts.emptiedAnnotations) {
    if (!emptied || typeof emptied !== 'object' || typeof emptied.annotationId !== 'string' || !emptied.disposition ||
        typeof emptied.disposition !== 'object' || (emptied.disposition.kind !== 'orphaned' && emptied.disposition.kind !== 'deleted')) throw new Error(`${name}.${handle.field}.operated v13 emptied annotation is invalid`);
    const annotation = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(emptied.annotationId, data.id);
    if (!annotation) throw new Error(`${name}.${handle.field}.operated v13 emptied annotation does not exist`);
    if (emptied.disposition.kind === 'orphaned') {
      db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(emptied.annotationId);
      db.prepare(`INSERT INTO ${prefix}_annotation_orphan_state (annotation_id, saved_quote, last_range) VALUES (?, ?, ?)`)
        .run(emptied.annotationId, typeof emptied.disposition.savedQuote === 'string' ? emptied.disposition.savedQuote : '', JSON.stringify(emptied.disposition.lastRange ?? null));
    } else {
      deleteAnnotatedTextAnnotation(db, prefix, emptied.annotationId);
    }
  }
}

/**
 * Edited-word field patches on a text event (Decision 0025 policy 4). Each
 * entry carries the COMPLETE post-patch field record; the projector validates
 * it against the family's declaration (behavior + field names + value
 * serialization) and writes the typed row. Ranges are untouched — the patch
 * rides the text operation whose overlap motivated it, so one undo step
 * reverses both.
 */
function applyAnnotationUpdateFacts({ name, handle, db, prefix, descriptor, data }                                                                                                                          ) {
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

function projectBlocklessAnnotationApplyRange({ name, handle, db, descriptor, data }                                                                                                          ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'annotation.apply-range' || !operation.annotation || !operation.selection ||
      !f.annotation || !f.selectedRange || !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v13 annotation.apply-range event has invalid data`);
  const annOp = operation.annotation;
  const annFact = f.annotation;
  if (JSON.stringify(Object.keys(annOp).sort()) !== JSON.stringify(Object.keys(annFact).sort()) ||
      annOp.id !== annFact.id || annOp.family !== annFact.family ||
      JSON.stringify(annOp.fields) !== JSON.stringify(annFact.fields) ||
      JSON.stringify(annOp.protectedTargetIds ?? []) !== JSON.stringify(annFact.protectedTargetIds ?? []) ||
      typeof annOp.id !== 'string' || typeof annOp.family !== 'string' ||
      !annOp.fields || typeof annOp.fields !== 'object' || Array.isArray(annOp.fields)) throw new Error(`${name}.${handle.field}.operated v13 annotation facts do not match the operation`);
  if (f.selectedRange.annotationId !== annOp.id) throw new Error(`${name}.${handle.field}.operated v13 selected range does not match the annotation`);
  const selection = operation.selection                                                  ;
  // The plan's `ranges` facts are the authoritative postimage of the document's
  // membership relation: every existing range is carried forward, trimmed (an
  // exclusive 'one'-family apply), or replaced. Validate the WHOLE postimage
  // up front (fail closed with zero writes on a malformed event), and require
  // the applied annotation to own exactly the one selected range.
  for (const entry of f.ranges) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.annotationId !== 'string' || !entry.annotationId ||
        !entry.start || typeof entry.start !== 'object' || Array.isArray(entry.start) ||
        !entry.end || typeof entry.end !== 'object' || Array.isArray(entry.end)) {
      throw new Error(`${name}.${handle.field}.operated v13 annotation range is invalid`);
    }
  }
  const appliedRanges = f.ranges.filter((entry     ) => entry.annotationId === annOp.id);
  if (appliedRanges.length !== 1 ||
      JSON.stringify(appliedRanges[0].start) !== JSON.stringify(f.selectedRange.start) ||
      JSON.stringify(appliedRanges[0].end) !== JSON.stringify(f.selectedRange.end)) {
    throw new Error(`${name}.${handle.field}.operated v13 selected range does not match the annotation`);
  }
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v13 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 event conflicts with projection state`);
  if (JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.after.frontier) ||
      data.after.structuralRevision !== data.before.structuralRevision) throw new Error(`${name}.${handle.field}.operated v13 annotation apply must not change the text family`);
  if (data.version === 13 && JSON.stringify(continuousTextFamilyCheckpoint(current)) !== JSON.stringify(f.family)) throw new Error(`${name}.${handle.field}.operated v13 annotation family does not match the document`);
  const row = rawRow(db, name, data.id);
  if (!row) throw new Error(`${name}.${handle.field}.operated v13 document row is missing`);
  const declared = descriptor.annotations .find((entry) => entry.annotationName === annOp.family);
  if (!declared) throw new Error(`${name}.${handle.field}.operated v13 annotation family is not declared`);
  const declaredCardinality = 'cardinality' in declared ? declared.cardinality : undefined;
  const targetIds = (annOp.protectedTargetIds ?? [])            ;
  if (Array.isArray(targetIds) && targetIds.some((id, index, ids) => typeof id !== 'string' || (index > 0 && ids[index - 1] >= id))) throw new Error(`${name}.${handle.field}.operated v13 protected targets are invalid`);
  for (const targetId of targetIds) {
    const target = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(targetId, data.id);
    if (!target) throw new Error(`${name}.${handle.field}.operated v13 protected target does not exist`);
  }
  const existingAnnotation = db.prepare(`SELECT family FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(annOp.id, data.id);
  if (existingAnnotation && existingAnnotation.family !== annOp.family) throw new Error(`${name}.${handle.field}.operated v13 annotation family cannot change`);
  const fieldNames = Object.keys(declared.fields);
  // Fail closed: the annotation's field payload must EXACTLY match the declared
  // schema — unknown keys (including on a zero-field family) are rejected, so
  // the durable row can never silently drop or ignore attacker-supplied fields.
  const suppliedFieldNames = Object.keys(annOp.fields).sort();
  if (suppliedFieldNames.length !== fieldNames.length || [...fieldNames].sort().some((fieldName, index) => suppliedFieldNames[index] !== fieldName)) {
    throw new Error(`${name}.${handle.field}.operated v13 annotation fields disagree with declaration`);
  }
  // Everything below validates the FULL postimage (typed fields, protected
  // edges, membership, exclusivity) BEFORE the first annotation, typed-row,
  // protection-edge, or membership write; a forged event fails closed with zero
  // writes across every projection table.
  const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${annOp.family} WHERE annotation_id = ?`).get(annOp.id);
  const values = fieldNames.map((fieldName) => {
    if (!Object.hasOwn(annOp.fields , fieldName)) throw new Error(`${name}.${handle.field}.operated v13 annotation is missing field '${fieldName}'`);
    const field = declared.fields[fieldName];
    const strategy = resolveStrategy(field.kind);
    const validation = strategy.validate(annOp.fields [fieldName], field);
    if (validation !== true || (typeof field.validate === 'function' && field.validate(annOp.fields [fieldName]) !== true)) throw new Error(`${name}.${handle.field}.operated v13 annotation field '${fieldName}' failed validation`);
    return serializeField(field, annOp.fields [fieldName]);
  });
  for (const entry of f.ranges) {
    if (entry.annotationId !== annOp.id &&
        !db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(entry.annotationId, data.id)) {
      throw new Error(`${name}.${handle.field}.operated v13 annotation range names an unknown annotation`);
    }
  }
  // Fail closed on a forged postimage: an exclusive 'one'-cardinality family
  // must never carry overlapping ranges. Overlap is judged in the current
  // family's offset space (the same space the planner trims in); a stale-basis
  // or malformed endpoint throws and rejects the WHOLE event before any row is
  // written or replaced. The applied annotation counts even when this event
  // creates it (its row does not exist in the database yet).
  const familyByAnnotationId = new Map                ();
  for (const familyRow of db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(data.id)) {
    familyByAnnotationId.set(String(familyRow.id), String(familyRow.family));
  }
  if (!existingAnnotation) familyByAnnotationId.set(annOp.id, annOp.family);
  if (!Number.isSafeInteger(selection.startOffset) || !Number.isSafeInteger(selection.endOffset)) {
    throw new Error(`${name}.${handle.field}.operated v13 annotation selection is invalid`);
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
      throw new Error(`${name}.${handle.field}.operated v13 annotation range is not projectable`);
    }
    if (start >= end) throw new Error(`${name}.${handle.field}.operated v13 annotation range must be forward and non-empty`);
  }
  const currentRanges = annotationRangeRows(db, prefix, data.id).map((entry) => ({
    annotationId: entry.annotation_id,
    start: JSON.parse(entry.start_point),
    end: JSON.parse(entry.end_point),
  }));
  const selectedStart = projectEndpointToOffset(current, selectedRange.start);
  const selectedEnd = projectEndpointToOffset(current, selectedRange.end);
  if (selectedStart !== startOffset || selectedEnd !== endOffset || selectedStart >= selectedEnd) {
    throw new Error(`${name}.${handle.field}.operated v13 selected range disagrees with the semantic operation`);
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
    throw new Error(`${name}.${handle.field}.operated v13 annotation range postimage disagrees with the semantic operation`);
  }
  // Validation complete — the writes that follow cannot fail validation.
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
  // Sync the membership relation to the plan's postimage. The applied annotation
  // row (and every other annotation a range names) exists before this write, and
  // ordered links admit the multiple rows a trimmed annotation's left+right
  // remnants require. Writing the WHOLE postimage makes the exclusive trim of
  // another annotation's range durable and replay deterministically from the
  // committed event. When the stored relation already equals the postimage (the
  // common field-only correction: values change, geometry does not), the
  // delete+rewrite is skipped — the rewrite would write back exactly the rows
  // already stored, so the resulting tables and every ordered read of them are
  // identical either way.
  if (!membershipRelationMatchesPostimage(db, prefix, data.id          , f.ranges)) {
    db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`).run(data.id);
    const ordinalByAnnotation = new Map                ();
    for (const entry of f.ranges) {
      const ordinal = ordinalByAnnotation.get(entry.annotationId          ) ?? 0;
      attachAnnotationRange(db, prefix, data.id          , entry.annotationId          , entry.start, entry.end, ordinal);
      ordinalByAnnotation.set(entry.annotationId          , ordinal + 1);
    }
  }
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ? WHERE document_id = ?`).run(data.after.structuralRevision, data.id);
}

// True when the stored membership relation of one document already equals the
// plan's range postimage: the same (annotation_id, ordinal, start, end) rows.
// `annotationRangeRows` returns the relation grouped by annotation with
// ascending ordinals — exactly the rows and per-annotation ordinals the
// postimage rewrite would write — so a full match proves the rewrite is a
// no-op on stored state. The postimage array itself may interleave annotations
// in any order, so equality is compared per annotation, not row-for-row.
// Any mismatch (count, annotation set, ordinal, or canonical endpoint text)
// fails closed into the whole-postimage rewrite.
function membershipRelationMatchesPostimage(db    , prefix        , documentId        , ranges                                                               )          {
  const expected = new Map                                 ();
  for (const entry of ranges) {
    let endpoints = expected.get(entry.annotationId);
    if (!endpoints) {
      endpoints = [];
      expected.set(entry.annotationId, endpoints);
    }
    endpoints.push([canonicalEndpointJSON(entry.start), canonicalEndpointJSON(entry.end)]);
  }
  const stored = annotationRangeRows(db, prefix, documentId);
  if (stored.length !== ranges.length) return false;
  let index = 0;
  while (index < stored.length) {
    const annotationId = stored[index].annotation_id;
    const endpoints = expected.get(annotationId);
    if (!endpoints) return false;
    let ordinal = 0;
    while (index < stored.length && stored[index].annotation_id === annotationId) {
      const row = stored[index];
      const pair = endpoints[ordinal];
      if (!pair || row.ordinal !== ordinal || row.start_point !== pair[0] || row.end_point !== pair[1]) return false;
      index += 1;
      ordinal += 1;
    }
    if (endpoints.length !== ordinal) return false;
    expected.delete(annotationId);
  }
  return expected.size === 0;
}

// Semantic atomic annotation.update (#174): one history step replacing an
// EXISTING annotation's fields (and optionally its single range). The whole
// postimage is validated fail-closed before any write; a fields-only update
// (selection null) must carry the CURRENT membership relation verbatim, which
// is what keeps stored endpoint basis anchors untouched.
function projectBlocklessAnnotationUpdate({ name, handle, db, descriptor, data }                                                                                                          ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'annotation.update' || !operation.annotation || !f.annotation ||
      !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v${data.version} annotation.update event has invalid data`);
  // History-authored compensations restore verbatim captured images whose
  // endpoints keep their historical bases — planner-offset recomputation
  // cannot apply to them (decision 0023).
  const historyAuthored = (operation                          ).authored === 'history';
  if (operation.selection !== null &&
      (!operation.selection || typeof operation.selection !== 'object' ||
       !Number.isSafeInteger((operation.selection                             ).startOffset) ||
       !Number.isSafeInteger((operation.selection                           ).endOffset))) {
    throw new Error(`${name}.${handle.field}.operated v13 annotation selection is invalid`);
  }
  const annOp = operation.annotation;
  const annFact = f.annotation;
  if (JSON.stringify(Object.keys(annOp).sort()) !== JSON.stringify(Object.keys(annFact).sort()) ||
      annOp.id !== annFact.id || annOp.family !== annFact.family ||
      JSON.stringify(annOp.fields) !== JSON.stringify(annFact.fields) ||
      JSON.stringify(annOp.protectedTargetIds ?? []) !== JSON.stringify(annFact.protectedTargetIds ?? []) ||
      typeof annOp.id !== 'string' || typeof annOp.family !== 'string' ||
      !annOp.fields || typeof annOp.fields !== 'object' || Array.isArray(annOp.fields)) throw new Error(`${name}.${handle.field}.operated v13 annotation facts do not match the operation`);
  for (const entry of f.ranges) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.annotationId !== 'string' || !entry.annotationId ||
        !entry.start || typeof entry.start !== 'object' || Array.isArray(entry.start) ||
        !entry.end || typeof entry.end !== 'object' || Array.isArray(entry.end)) {
      throw new Error(`${name}.${handle.field}.operated v13 annotation range is invalid`);
    }
  }
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v13 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 event conflicts with projection state`);
  if (JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.after.frontier) ||
      data.after.structuralRevision !== data.before.structuralRevision) throw new Error(`${name}.${handle.field}.operated v13 annotation update must not change the text family`);
  const row = rawRow(db, name, data.id);
  if (!row) throw new Error(`${name}.${handle.field}.operated v13 document row is missing`);
  // The updated annotation must already exist; only its declared-family fields
  // and its own range may move.
  const existingAnnotation = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(annOp.id, data.id);
  if (!existingAnnotation) throw new Error(`${name}.${handle.field}.operated v13 annotation to update does not exist`);
  if (existingAnnotation.family !== annOp.family) throw new Error(`${name}.${handle.field}.operated v13 annotation family cannot change`);
  const declared = descriptor.annotations .find((entry) => entry.annotationName === annOp.family);
  if (!declared) throw new Error(`${name}.${handle.field}.operated v13 annotation family is not declared`);
  const fieldNames = Object.keys(declared.fields);
  const suppliedFieldNames = Object.keys(annOp.fields).sort();
  if (suppliedFieldNames.length !== fieldNames.length || [...fieldNames].sort().some((fieldName, index) => suppliedFieldNames[index] !== fieldName)) {
    throw new Error(`${name}.${handle.field}.operated v13 annotation fields disagree with declaration`);
  }
  // Fail closed on protection drift: an update NEVER changes protected edges,
  // so the carried image must equal the live edge set exactly.
  const targetIds = (annOp.protectedTargetIds ?? [])            ;
  if (Array.isArray(targetIds) && targetIds.some((id, index, ids) => typeof id !== 'string' || (index > 0 && ids[index - 1] >= id))) throw new Error(`${name}.${handle.field}.operated v13 protected targets are invalid`);
  const liveEdges = (db.prepare(`SELECT target_annotation_id FROM ${prefix}_annotation_protected_target WHERE annotation_id = ? ORDER BY target_annotation_id`).all(annOp.id)                                           ).map((edge) => edge.target_annotation_id);
  if (JSON.stringify(liveEdges) !== JSON.stringify(targetIds)) throw new Error(`${name}.${handle.field}.operated v13 annotation update must not change protected targets`);
  // Everything below validates the FULL postimage BEFORE the first write.
  const values = fieldNames.map((fieldName) => {
    if (!Object.hasOwn(annOp.fields , fieldName)) throw new Error(`${name}.${handle.field}.operated v13 annotation is missing field '${fieldName}'`);
    const field = declared.fields[fieldName];
    const strategy = resolveStrategy(field.kind);
    const validation = strategy.validate(annOp.fields [fieldName], field);
    if (validation !== true || (typeof field.validate === 'function' && field.validate(annOp.fields [fieldName]) !== true)) throw new Error(`${name}.${handle.field}.operated v13 annotation field '${fieldName}' failed validation`);
    return serializeField(field, annOp.fields [fieldName]);
  });
  for (const entry of f.ranges) {
    if (!db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(entry.annotationId, data.id)) {
      throw new Error(`${name}.${handle.field}.operated v13 annotation range names an unknown annotation`);
    }
  }
  const postimageRanges = f.ranges                                                                                                                                       ;
  const appliedRanges = postimageRanges.filter((entry) => entry.annotationId === annOp.id);
  if (appliedRanges.length !== 1) throw new Error(`${name}.${handle.field}.operated v13 updated annotation must keep exactly one range`);
  for (const entry of postimageRanges) {
    let start        ;
    let end        ;
    try {
      start = projectEndpointToOffset(current, entry.start);
      end = projectEndpointToOffset(current, entry.end);
    } catch {
      throw new Error(`${name}.${handle.field}.operated v13 annotation range is not projectable`);
    }
    if (start >= end) throw new Error(`${name}.${handle.field}.operated v13 annotation range must be forward and non-empty`);
  }
  const currentRanges = annotationRangeRows(db, prefix, data.id).map((entry) => ({
    annotationId: entry.annotation_id,
    start: JSON.parse(entry.start_point),
    end: JSON.parse(entry.end_point),
  }));
  const selectedRange = appliedRanges[0];
  if (historyAuthored) {
    // A history-authored compensation restores the captured verbatim image:
    // structural validity (already proven above: shapes, existence,
    // projectability, forward non-empty, exactly one own range) is the whole
    // contract — the same trust level a text.apply compensation rides.
  } else if (operation.selection !== null) {
    const selection = operation.selection                                              ;
    const selectedStart = projectEndpointToOffset(current, selectedRange.start);
    const selectedEnd = projectEndpointToOffset(current, selectedRange.end);
    if (selectedStart !== selection.startOffset || selectedEnd !== selection.endOffset || selectedStart >= selectedEnd) {
      throw new Error(`${name}.${handle.field}.operated v13 selected range disagrees with the semantic operation`);
    }
    const declaredCardinality = 'cardinality' in declared ? declared.cardinality : undefined;
    const expectedRanges = [];
    for (const entry of currentRanges) {
      if (entry.annotationId === annOp.id) continue;
      if (declaredCardinality === 'one') {
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
      throw new Error(`${name}.${handle.field}.operated v13 annotation range postimage disagrees with the semantic operation`);
    }
  } else {
    // Fields-only update: the membership relation passes through VERBATIM —
    // this exact-equality check is what preserves endpoint basis anchors
    // (decision 0023) byte-for-byte across a field update.
    const rangeSignatures = (entries       ) => entries.map((entry) => JSON.stringify([
      entry.annotationId,
      canonicalEndpointJSON(entry.start),
      canonicalEndpointJSON(entry.end),
    ]));
    if (JSON.stringify(rangeSignatures(postimageRanges)) !== JSON.stringify(rangeSignatures(currentRanges))) {
      throw new Error(`${name}.${handle.field}.operated v13 fields-only update must not move ranges`);
    }
  }
  // Validation complete — the writes that follow cannot fail validation.
  if (fieldNames.length) {
    const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${annOp.family} WHERE annotation_id = ?`).get(annOp.id);
    if (!stored) throw new Error(`${name}.${handle.field}.operated v13 annotation typed row is missing`);
    db.prepare(`UPDATE ${prefix}_annotation_${annOp.family} SET ${fieldNames.map((fieldName) => `${fieldName} = ?`).join(', ')} WHERE annotation_id = ?`).run(...values, annOp.id);
  }
  db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`).run(data.id);
  const ordinalByAnnotation = new Map                ();
  for (const entry of f.ranges) {
    const ordinal = ordinalByAnnotation.get(entry.annotationId          ) ?? 0;
    attachAnnotationRange(db, prefix, data.id          , entry.annotationId          , entry.start, entry.end, ordinal);
    ordinalByAnnotation.set(entry.annotationId          , ordinal + 1);
  }
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ? WHERE document_id = ?`).run(data.after.structuralRevision, data.id);
}

function projectBlocklessAnnotationRemove({ name, handle, db, data }                                                                             ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'annotation.remove' || typeof operation.annotationId !== 'string' ||
      !Array.isArray(f.removedAnnotationIds) || f.removedAnnotationIds.length !== 1 || f.removedAnnotationIds[0] !== operation.annotationId ||
      !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v13 annotation.remove event has invalid data`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v13 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 event conflicts with projection state`);
  if (JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.after.frontier) ||
      data.after.structuralRevision !== data.before.structuralRevision) throw new Error(`${name}.${handle.field}.operated v13 annotation remove must not change the text family`);
  if (data.version === 13 && JSON.stringify(continuousTextFamilyCheckpoint(current)) !== JSON.stringify(f.family)) throw new Error(`${name}.${handle.field}.operated v13 annotation family does not match the document`);
  const annotation = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(operation.annotationId, data.id);
  if (!annotation) throw new Error(`${name}.${handle.field}.operated v13 annotation to remove does not exist`);
  deleteAnnotatedTextAnnotation(db, prefix, operation.annotationId);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ? WHERE document_id = ?`).run(data.after.structuralRevision, data.id);
}

// Compiled region declarations for replay. Placeholder and the
// authorization-policy source text ride along so the v16 fingerprint covers
// the full ratified declaration contract (Finding 4).
function regionDeclarations(descriptor                 )                      {
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
      // Fail closed on a protecting declaration whose policy function is
      // missing — the fingerprint contract requires its source identity.
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
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v15 document does not exist`);
  const current = restoreTextFamilySerialized(currentRow.family_checkpoint          );
  if (currentRow.structure_version !== canonical.before.structuralRevision
    || JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(canonical.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v15 event conflicts with projection state`);
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
  // V16 replay: re-derive BOTH witness sides through the sole reducer and
  // require exact equality with the stored witness — a sparse or tampered
  // image can never reach projection. V15 rows carry no witness and skip this.
  // The fingerprint comparison here is belt-and-braces; the side-digest
  // coverage inside reduceRegionPostimage is the binding check (Finding 4).
  if (canonical.wireVersion === 16
    && canonical.declarationFingerprint !== regionDeclarationFingerprint(declarations)) {
    throw new Error('region witness disagrees with operated event');
  }
  if (canonical.wireVersion === 16) {
    if (JSON.stringify(closure) !== JSON.stringify(canonical.witnessBefore)) {
      throw new Error('region witness disagrees with operated event');
    }
  }
  let afterFamily;
  try {
    afterFamily = applyRegionTextOperations(current, canonical.text);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v15 text operation is not applicable to prior state`);
  }
  if (JSON.stringify(afterFamily.checkpoint.frontier) !== JSON.stringify(canonical.after.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v15 family does not match the operation`);
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
      // V16 side digests cover the declaration fingerprint (Finding 4): a
      // mismatched declaration fails the digest comparison, not just the
      // outer fingerprint equality.
      ...(canonical.wireVersion === 16
        ? { declarationFingerprint: regionDeclarationFingerprint(declarations) }
        : {}),
    });
  } catch {
    throw new Error(REGION_POSTIMAGE_DISAGREES);
  }
  if (postimage.afterDigest !== canonical.afterDigest) throw new Error(REGION_POSTIMAGE_DISAGREES);
  // V16 after-side witness: the replay-derived postimage must equal the stored
  // complete after closure, image for image (already canonically ordered), and
  // facts.emptiedAnnotations must agree with the reducer-derived dispositions.
  if (canonical.wireVersion === 16) {
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
  }

  const beforeById = new Map(closure.map((image) => [image.id, image]));
  const afterById = new Map(postimage.annotations.map((image) => [image.id, image]));
  const row = rawRow(db, name, canonical.id);
  if (!row) throw new Error(`${name}.${handle.field}.operated v15 document row is missing`);

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

function buildProjectedComputeRow(storedRow     , fields        )      {
  const row = { ...storedRow };
  for (const [fName, desc] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(row, fName)) {
      try {
        row[fName] = resolveStrategy(desc.kind).deserialize?.(row[fName], desc) ?? row[fName];
      } catch {}
    }
  }
  return row;
}








// The single recipient read projection (S5/A3 — field-read admission path).
// Given a materialized row, return exactly the field subset the principal can
// READ: unreadable fields are OMITTED, and an unreadable annotated-text field
// REDACTS to the explicit restricted placeholder (the existing recipient
// projection's wire shape — no canonical document facts are loaded). `id`
// always survives so the row stays addressable. This is the ONE source the
// live-delivery envelopes, the snapshot call site, and (via A2's HTTP wiring)
// the REST read path consume — a field the principal cannot read never reaches
// any recipient projection.
export async function projectRowForRecipient(
  entity                     ,
  row                        ,
  principal         ,
  options                                = {},
)               {
  if (!row || typeof row !== 'object') return (row ?? {})       ;
  const readable = options.readable ?? (await readableFieldNames(entity         , row, principal, options.authorization));
  const projected      = {};
  if (Object.prototype.hasOwnProperty.call(row, 'id')) projected.id = row.id;
  const fields = (entity?.fields ?? {})          ;
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (readable.has(fieldName)) {
      if (Object.prototype.hasOwnProperty.call(row, fieldName)) projected[fieldName] = row[fieldName];
    } else if (descriptor?.kind === 'annotatedText') {
      projected[fieldName] = annotatedTextDeniedPlaceholder();
    }
  }
  return projected;
}

export function createEntityProjection({ name, fields, verbs, storedComputedFields, sideTableStrategyEntries, conditionalHistory = false, conditionalCreateHistory = false }







 ) {
  const eventTypes = [
    verbs.created.type,
      verbs.updated.type,
      verbs.removed.type,
      ...Object.entries(fields)
        .filter(([, descriptor]) => descriptor.kind === 'crdt' && descriptor.type === 'text')
        .map(([fieldName]) => eventHandle.native(name, fieldName, 'applied').type),
      ...Object.entries(fields)
        .filter(([, descriptor]) => descriptor.kind === 'annotatedText')
        .flatMap(([fieldName]) => [eventHandle.native(name, fieldName, 'operated').type, eventHandle.native(name, fieldName, 'retired').type]),
      ...sideTableStrategyEntries.flatMap(({ strategy, fields: strategyFields }) =>
        strategy.eventTypes(name, strategyFields)),
  ];

  // Annotated-text bulk materialization (esp. a large create with thousands of
  // imported ranges) would otherwise run synchronously inside the dispatch
  // transaction, freezing the event loop for the whole import. `asyncSeed`
  // selects a yielding seeding loop that periodically releases the event loop;
  // `applyAsync` is the async surface the dispatch awaits, while `apply` keeps
  // its synchronous, non-yielding behaviour for hot edits and private-fact
  // replay (no behavioural change there).
  function applyProjection(event           , db    , asyncSeed         )                       {
    const table = name;
      const handle = event.handle;
      if (handle?.brand !== 'event-handle' || handle.entity !== name) return;
      for (const { strategy, fields: strategyFields } of sideTableStrategyEntries) {
        if (strategy.projectionApply({ entityName: name, fieldEntries: strategyFields, handle, event: event                              , db })) return;
      }
      if (handle.kind === eventHandle.EventKind.native && handle.nativeName === 'retired') {
        const descriptor = fields[handle.field];
        if (descriptor?.kind !== 'annotatedText') return;
        const data = event.data;
        if (!data || data.version !== 1 || typeof data.id !== 'string' || !data.id || typeof data.generation !== 'string' || !data.generation || typeof data.retiredAt !== 'string') throw new Error(`${name}.${handle.field}.retired has invalid facts`);
        const existing = db.prepare(`SELECT generation FROM ${name}_${handle.field}_retired WHERE document_id = ?`).get(data.id);
        if (existing && existing.generation !== data.generation) throw new Error(`${name}.${handle.field}.retired generation conflicts`);
        db.prepare(`INSERT OR IGNORE INTO ${name}_${handle.field}_retired (document_id, generation, retired_at) VALUES (?, ?, ?)`).run(data.id, data.generation, data.retiredAt);
        return;
      }
      if (applyAnnotatedTextOperation({ name, fields, handle, event, db })) return;
      if (handle.kind === eventHandle.EventKind.native && handle.nativeName === 'applied') {
        const descriptor = fields[handle.field];
        if (descriptor?.kind !== 'crdt' || descriptor.type !== 'text') return;
        const id = event.data?.id;
        if (!id) return;
        const current = db.prepare(`SELECT ${handle.field} FROM ${table} WHERE id = ?`).get(id);
        if (!current) return;
        const state = restoreTextCheckpoint(JSON.parse(current[handle.field]          ));
        const next = applyTextOp(state, event.data?.operation);
        db.prepare(`UPDATE ${table} SET ${handle.field} = ? WHERE id = ?`)
          .run(JSON.stringify(textCheckpoint(next)), id);
        getLog().debug('dispatch', `${name}.${handle.field}.applied`, { id });
        return;
      }
      if (handle.kind === eventHandle.EventKind.created) {
        for (const [fieldName, descriptor] of Object.entries(fields)) {
          if (descriptor.kind === 'annotatedText' && db.prepare(`SELECT 1 FROM ${name}_${fieldName}_retired WHERE document_id = ?`).get(event.data?.id)) {
            throw new Error(`${name}.${fieldName} document id is permanently retired`);
          }
        }
        const row                          = {};
        for (const [key, value] of Object.entries(event.data ?? {})) {
          if (key === '__workbench') continue;
          const descriptor = fields[key];
          if (descriptor && descriptor.kind === 'store') continue;
          if (descriptor && descriptor.kind === 'struct') {
            Object.assign(row, flattenStruct(key, descriptor, value));
            continue;
          }
          if (descriptor) {
            row[key] = serializeField(descriptor, value);
          } else {
            row[key] = value;
          }
        }
        for (const [fieldName, descriptor] of Object.entries(fields)) {
          if (descriptor.kind === 'crdt' && descriptor.type === 'text') {
            row[fieldName] = JSON.stringify(textCheckpoint(createTextState()));
          }
        }
        for (const [fieldName, { compute }] of storedComputedFields) {
          try {
            const computeRow = buildProjectedComputeRow(row, fields);
            const result = compute (computeRow);
            row[fieldName] = resolveStrategy('computed').serialize (result);
          } catch {
            throw new Error(`${name}.${fieldName} computed.stored compute failed`);
          }
        }
        const cols = Object.keys(row);
        if (cols.length > 0) {
          db.prepare(
            `INSERT INTO ${table} (${cols.map(quoteColumn).join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`,
          ).run(row);
          const init = initializeAnnotatedText({ name, fields, event, db, row, asyncSeed });
          if (init instanceof Promise) return init;
          getLog().debug('dispatch', `${name}.created`, { id: row.id ?? event.data?.id });
        }
      } else if (handle.kind === eventHandle.EventKind.updated) {
        if (conditionalHistory) return;
        const { id, ...data } = (event.data ?? {})            ;
        if (!id) return;
        const updates = [];
        const params                          = { id };
        for (const [key, value] of Object.entries(data)) {
          const descriptor = fields[key];
          if (descriptor && descriptor.kind === 'store') continue;
          if (descriptor && descriptor.kind === 'struct') {
            for (const [column, cell] of Object.entries(flattenStruct(key, descriptor, value))) {
              updates.push(`${quoteColumn(column)} = :${column}`);
              params[column] = cell;
            }
            continue;
          }
          const stored = descriptor ? serializeField(descriptor, value) : value;
          updates.push(`${quoteColumn(key)} = :${key}`);
          params[key] = stored;
        }
        if (storedComputedFields.length > 0) {
          const existing = db.prepare(`SELECT * FROM ${table} WHERE id = :id`).get({ id });
          if (existing) {
            const merged = { ...existing };
            for (const [key] of Object.entries(data)) {
              if (Object.prototype.hasOwnProperty.call(fields, key)) {
                merged[key] = Object.prototype.hasOwnProperty.call(params, key) ? params[key] : data[key];
              }
            }
            for (const [fieldName, { compute }] of storedComputedFields) {
              try {
                const computeRow = buildProjectedComputeRow(merged, fields);
                const result = compute (computeRow);
                const stored = resolveStrategy('computed').serialize (result);
                updates.push(`${quoteColumn(fieldName)} = :${fieldName}`);
                params[fieldName] = stored;
              } catch {
                throw new Error(`${name}.${fieldName} computed.stored compute failed`);
              }
            }
          }
        }
        if (updates.length > 0) {
          db.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = :id`).run(params);
          getLog().debug('dispatch', `${name}.updated`, { id: params.id });
        }
      } else if (handle.kind === eventHandle.EventKind.removed) {
        // A cascade root with conditional-create history deletes from its exact
        // private fact. Its descendants have no private facts in that receipt.
        if (conditionalCreateHistory && !event[CASCADE_DESCENDANT]) return;
        const id = event.data?.id;
        // Capture the deleted-row history anchor BEFORE the delete, in the
        // same projection-consumer call (same transaction as the DELETE) —
        // atomic, so a committed removal can never leave the anchor missing.
        const existingRow = id ? rawRow(db, table, id) : undefined;
        if (existingRow) captureDeletedRowAnchor(db                                                 , name, id          , existingRow, event.committedAt          );
        // A protecting annotation's target edge is ON DELETE RESTRICT. The row
        // delete cascades into the annotation rows, so tear down the document's
        // protected-target edges first or removing a document that carries a
        // protecting span fails the FK constraint.
        if (id) {
          for (const [fieldName, descriptor] of Object.entries(fields)) {
            if (descriptor.kind !== 'annotatedText') continue;
            const prefix = `${name}_${fieldName}`;
            db.prepare(
              `DELETE FROM ${prefix}_annotation_protected_target
               WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)
                  OR target_annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`,
            ).run(id, id);
          }
        }
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        getLog().debug('dispatch', `${name}.removed`, { id });
      }
  }

  const projection = {
    eventTypes,
    apply: (event           , db    )       => { applyProjection(event, db, false); },
    applyAsync: async (event           , db    )                => { await applyProjection(event, db, true); },
  };
  if (Object.values(fields).some((field) => field.kind === 'annotatedText')) markAnnotatedEntityProjection(projection);
  return Object.freeze(projection);
}

export function createConditionalHistoryProjection({ name, verbs }                                                           ) {
  return Object.freeze({
    actionType: `${name}.update`,
    eventTypes: [verbs.updated.type],
    privateFact: true,
    replay: false,
    apply: (event           , db    , { privateFact }                                                 ) => {
      const before = privateFact?.before;
      const after = privateFact?.after;
      if (!before || !after || before.id !== after.id || event.data?.id !== before.id) throw new Error(`${name}.update private fact is invalid`);
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name          );
      if (columns.some((column) => !Object.hasOwn(before, column) || !Object.hasOwn(after, column))) throw new Error(`${name}.update private fact is incomplete`);
      const current = rawRow(db, name, before.id);
      if (!current) throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
      if (!columns.every((column) => Object.is(current[column], before[column]))) throw Object.assign(new Error(`${name} update conflicts`), { status: 409 });
      const params                          = {};
      const assignments = columns.filter((column) => column !== 'id').map((column) => {
        params[`after_${column}`] = after[column];
        return `${quoteColumn(column)} = :after_${column}`;
      });
      const preimage = columns.map((column) => {
        params[`before_${column}`] = before[column];
        return `${quoteColumn(column)} IS :before_${column}`;
      });
      const result = db.prepare(`UPDATE ${name} SET ${assignments.join(', ')} WHERE ${preimage.join(' AND ')}`).run(params);
      if (Number(result.changes) !== 1) {
        if (!db.prepare(`SELECT 1 FROM ${name} WHERE id = ?`).get(before.id)) {
          throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
        }
        throw Object.assign(new Error(`${name} update conflicts`), { status: 409 });
      }
    },
  });
}

export function createConditionalCreateHistoryProjection({ name, verbs }                                                           ) {
  const apply = (event           , db    , { privateFact }                                                               ) => {
    const { before, after } = privateFact ?? {};
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name          );
    if (event.type === verbs.created.type) {
      if (before !== null || !after || after.id !== event.data?.id) throw new Error(`${name}.create private fact is invalid`);
      const current = rawRow(db, name, after.id);
      if (!current) throw Object.assign(new Error(`${name}.create projection conflicts`), { status: 409 });
      if (Object.keys(after).length !== columns.length || columns.some((column) => !Object.hasOwn(after, column)) || !columns.every((column) => Object.is(current[column], after[column]))) {
        throw Object.assign(new Error(`${name}.create projection conflicts`), { status: 409 });
      }
    } else {
      if (!before || after !== null || before.id !== event.data?.id || Object.keys(before).length !== columns.length || columns.some((column) => !Object.hasOwn(before, column))) throw new Error(`${name}.remove private fact is invalid`);
      const current = rawRow(db, name, before.id);
      if (!current) throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
      if (!columns.every((column) => Object.is(current[column], before[column]))) throw Object.assign(new Error(`${name} remove conflicts`), { status: 409 });
      captureDeletedRowAnchor(db                                                 , name, before.id          , current, event.committedAt          );
      const predicates = columns.map((column) => `${quoteColumn(column)} IS :${column}`);
      const result = db.prepare(`DELETE FROM ${name} WHERE ${predicates.join(' AND ')}`).run(before);
      if (Number(result.changes) !== 1) throw Object.assign(new Error(`${name} remove conflicts`), { status: 409 });
    }
  };
  return Object.freeze([Object.freeze({
    actionType: `${name}.create`,
    eventTypes: [verbs.created.type],
    privateFact: true,
    replay: false,
    apply,
  }), Object.freeze({
    actionType: `${name}.remove`,
    eventTypes: [verbs.removed.type],
    privateFact: true,
    replay: false,
    apply,
  })]);
}
