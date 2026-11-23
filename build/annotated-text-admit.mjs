// Commit admission for annotated-text operations (issue #33 blockless).
//
// One continuous RGA text per document; annotations are document-scoped
// ranges; authoring positions are document-scoped frames carrying an absolute
// UTF-16 offset basis. This module does NOT write DB rows, mint authoring
// frames, or fold client ops — it admits a validated v9 command and returns the
// blockless operated event/plan.

import { createHash, randomUUID } from 'node:crypto';
import { ValidationError, deserializeField,                      } from './field-strategy.mjs';
import * as eventHandles from './event-handle.mjs';
import { authorizeFieldOp } from './strategy/index.mjs';
import { write } from './grant.mjs';
import {
  restoreTextFamilySerialized,
  textFamilyBasis,
  textFamilyMaxLamport,
  textFamilyVisibleLength,
  createTextFamily,
  insertAnchorForOffset,
  projectEndpointToOffset,

} from './annotated-text-continuous.mjs';
import { frontierDominates, hasTextElement } from './annotated-text.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { resolveStream, resolveLease, resolvePosition } from './annotated-text-authoring-stream.mjs';
import { readSeq } from './committed-log.mjs';
import {
  planAnnotationPaste,
  planAnnotationRemove,
  planAnnotationUpdate,
  planTextOffsetEdit,
  planTextRangeApply,

} from './annotated-text-plan.mjs';
import { mapVisibleOffsetToCanonical,                         } from './annotated-text-recipient-projection.mjs';
import { evaluateAnnotatedTextVisibility } from './annotated-text-snapshot.mjs';


import { rawRow } from './entity/query.mjs';
import { annotationRangeRows, annotationOrphanStates } from './annotated-text-storage.mjs';

























// The v9 edit is validated (shape-checked) before this module runs; the loose
// shape below reflects only the fields this admission reads, across every
// supported and rejected edit kind.


























































































/** Resolve the authoring stream + lease for a v9 command. */
export function assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal }






 )                                                     {
  const stream = resolveStream({ db, prefix, streamToken: command.authoring.stream, documentId: command.id, principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '' })                          ;
  if (!stream) throw new ValidationError(`${name}.${fieldName}.operation authoring stream unavailable`, { code: 'authoring-stream-unavailable' });
  const lease = resolveLease({ db, prefix, leaseToken: command.authoring.lease, streamId: stream.id })                         ;
  if (!lease) throw new ValidationError(`${name}.${fieldName}.operation authoring lease unavailable`, { code: 'authoring-lease-unavailable' });
  return { stream, lease };
}

function loadAnnotations({ db, prefix, compiledMeta, documentId }




 )                     {
  const rows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(documentId);
  if (rows.length === 0) return [];
  const targets = db.prepare(
    `SELECT edge.annotation_id, edge.target_annotation_id FROM ${prefix}_annotation_protected_target AS edge
      JOIN ${prefix}_annotation AS annotation ON annotation.id = edge.annotation_id
     WHERE annotation.document_id = ?
     ORDER BY edge.annotation_id, edge.target_annotation_id`,
  ).all(documentId);
  const targetsByAnnotation = new Map                  ();
  for (const target of targets) {
    const existing = targetsByAnnotation.get(target.annotation_id);
    if (existing) existing.push(target.target_annotation_id);
    else targetsByAnnotation.set(target.annotation_id, [target.target_annotation_id]);
  }
  const presentFamilies = new Set        ();
  for (const row of rows) {
    if (!compiledMeta.annotationHandles[row.family]) {
      throw new ValidationError(`annotated-text unknown annotation family '${row.family}'`);
    }
    presentFamilies.add(row.family);
  }
  const storedByFamily = new Map                                              ();
  for (const familyName of presentFamilies) {
    const declaration = compiledMeta.annotationFields?.[familyName]?.descriptor;
    if (Object.keys(declaration?.fields ?? {}).length === 0) continue;
    const familyRows = db.prepare(
      `SELECT child.* FROM ${prefix}_annotation_${familyName} AS child
        JOIN ${prefix}_annotation AS annotation ON annotation.id = child.annotation_id
       WHERE annotation.document_id = ?`,
    ).all(documentId)                                  ;
    const byId = new Map                                 ();
    for (const stored of familyRows) byId.set(String(stored.annotation_id), stored);
    storedByFamily.set(familyName, byId);
  }
  const annotations                     = [];
  const orphanByAnnotation = annotationOrphanStates(db       , prefix, documentId);
  for (const row of rows) {
    const metadata = compiledMeta.annotationHandles[row.family];
    const declaration = compiledMeta.annotationFields?.[row.family]?.descriptor;
    const stored = storedByFamily.get(row.family)?.get(row.id);
    const fields                          = {};
    for (const [fieldName, field] of Object.entries(declaration?.fields ?? {})) {
      const value = stored?.[fieldName];
      fields[fieldName] = value === undefined ? null : deserializeField(field                   , value);
    }
    // Pre-existing orphans ride the postimage untouched: the projector rewrites
    // orphan rows from the marker, so carry the current orphan state through.
    const orphan = orphanByAnnotation.get(row.id) ?? null;
    annotations.push({
      id: row.id,
      family: row.family,
      empty: metadata.empty,
      cardinality: metadata.cardinality === 'one' ? 'one' : 'many',
      fields,
      protectedTargetIds: targetsByAnnotation.get(row.id) ?? [],
      orphan: orphan === null ? null : { savedQuote: orphan.savedQuote, lastRange: orphan.lastRange === null ? null : [...orphan.lastRange]                     },
    });
  }
  return annotations;
}

function loadRanges({ db, prefix, documentId }



 )                {
  const rows = annotationRangeRows(db       , prefix, documentId);
  return rows.map((row) => ({
    annotationId: row.annotation_id,
    start: JSON.parse(row.start_point),
    end: JSON.parse(row.end_point),
  }));
}

/**
 * Load stored annotation field values for families with field-patch editOverlap
 * behavior (Decision 0025 policy 4). Reuses the already-deserialized fields on
 * `annotations` (no redundant N+1 queries).
 */
function loadAnnotationFields({ compiledMeta, annotations }


 )                                       {
  const fieldPatchFamilies = new Set        ();
  for (const [family, meta] of Object.entries(compiledMeta.annotationHandles                       )) {
    if (meta.editOverlap?.kind === 'fields') fieldPatchFamilies.add(family);
  }
  if (fieldPatchFamilies.size === 0) return new Map();
  const fields = new Map                                 ();
  for (const annotation of annotations) {
    if (!fieldPatchFamilies.has(annotation.family)) continue;
    fields.set(annotation.id, annotation.fields);
  }
  return fields;
}

/** Cross-cutting admission shared by every edit kind. */
async function assertV9AuthoringPrelude(ctx                )                     {
  const { name, fieldName, prefix, descriptor, record, compiledMeta, command, db, scope, principal, actionId } = ctx;
  const row = rawRow(db, name, command.id);
  if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const documentScope = resolveAnnotatedTextOwningScope(descriptor, record.fields, row).key;
  if (scope !== documentScope) throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
  await authorizeFieldOp(record, fieldName, write                     , row, principal);
  const { stream, lease } = assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal });
  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
  if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const family = restoreTextFamilySerialized(state.family_checkpoint);
  const cursor = readSeq(db, documentScope) + 1;
  const token = command.edit?.at?.positionToken ?? command.edit?.from?.positionToken ?? command.edit?.to?.positionToken ?? command.edit?.positionToken;
  const position = token
    ? resolvePosition({ db, prefix, positionToken: token, leaseId: lease.id })
    : null;
  if (token && !position) throw new ValidationError(`${name}.${fieldName}.operation position token unavailable`, { code: 'position-token-unavailable' });
  if (position && !position.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
  let staleInsertOffset                = null;
  if (position) {
    const issuedRedactions = parsedRedactions(position);
    // Validate current visibility before inspecting anchors from a stale basis.
    // A protection change can happen without a change to the text frontier.
    // Uses the lightweight protector-only visibility evaluator instead of full
    // snapshot projection so fully-visible edits never load unrelated annotations.
    assertRedactionsBasesMatch(await currentAuthoringRedactions(ctx, row, family), issuedRedactions, 'position');
    // A stale authoring basis normally means the client's absolute offset is
    // no longer meaningful: require re-bootstrap instead of trusting the raw
    // offset. The narrow exception is a plain insert at a FULLY-VISIBLE
    // position: its original offset can be resolved to a structural anchor at
    // the lease-scoped position checkpoint and re-projected into the current
    // family (see rebaseStaleInsertOffset). Every other edit kind keeps the
    // strict stale rejection.
    if (!samePositionBasis(position.family_checkpoint, family)) {
      if (command.edit.kind === 'text.insert' && issuedRedactions.length === 0) {
        staleInsertOffset = rebaseStaleInsertOffset(position, command.edit.at?.offset, family);
      } else {
        throw new ValidationError(`${name}.${fieldName}.operation authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
      }
    }
  }
  const actor = createHash('sha256').update(`${name}\u0000${fieldName}\u0000${command.id}\u0000${principal?.id ?? ''}\u0000${command.authoring.mutationId}`).digest('hex').slice(0, 32);
  const lamport = textFamilyMaxLamport(family) + 1;
  return Object.freeze({
    name, fieldName, prefix, descriptor, record, compiledMeta, command, row, db, scope, principal, actionId,
    documentScope, stream, lease, state, family, cursor, position, staleInsertOffset, actor, lamport,
  });
}

function assertOffsetInDocument(family                      , offset        , label        )       {
  const length = textFamilyVisibleLength(family);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new ValidationError(`annotated-text ${label} offset ${offset} is outside the document`, { code: 'position-invalid' });
  }
}

// The recipient's wire→canonical offset basis, bound to its authoring
// position frame (the frame's `redactions` column carries the exact authoring
// entries `authoringRedactionsForRecipient` produced at issue time). An empty
// frame (fully-visible recipient) maps as identity.
function parsedRedactions(position                          )                       {
  const raw = position?.redactions;
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function assertRedactionsBasesMatch(primary                      , other                      , label        )       {
  if (primary.length === 0 && other.length === 0) return;
  if (JSON.stringify(primary) !== JSON.stringify(other)) {
    throw new ValidationError(`annotated-text ${label} authoring redaction bases differ; re-bootstrap the snapshot`, { code: 'position-stale' });
  }
}

// The acting principal's CURRENT wire→canonical basis at admit time. Uses the
// lightweight protector-only visibility evaluator so fully-visible documents
// skip loading/projecting unrelated annotations.
async function currentAuthoringRedactions(ctx                , row     , family                      )                                {
  const { db, record, fieldName, descriptor, principal } = ctx;
  let visibility;
  try {
    visibility = await evaluateAnnotatedTextVisibility({
      db, entity: record, row, principal, fieldName, descriptor, family,
    });
  } catch {
    throw new ValidationError(`${ctx.name}.${ctx.fieldName}.operation cannot revalidate the authoring basis; re-bootstrap the snapshot`, { code: 'position-stale' });
  }
  if (visibility.restricted) {
    throw new ValidationError(`${ctx.name}.${ctx.fieldName}.operation authoring redaction bases differ; re-bootstrap the snapshot`, { code: 'position-stale' });
  }
  return visibility.redactions;
}

/**
 * Map a redacted recipient's wire offsets to canonical. A redacted recipient
 * never holds raw canonical offsets (its projection removed the denied text),
 * so every submitted offset is a wire offset against its own frame. A range
 * pins its endpoints to the boundaries facing the range interior; a collapsed
 * point at a placeholder is the affinity-bound gap.
 */
function mapWireRangeToCanonical(fromOffset        , fromAffinity                  , toOffset        , toAffinity                  , redactions                      , isRange         )                               {
  const from = mapVisibleOffsetToCanonical(fromOffset, fromAffinity, redactions, isRange ? 'right' : null);
  const to = isRange
    ? mapVisibleOffsetToCanonical(toOffset, toAffinity, redactions, 'left')
    : from;
  return { from, to };
}

// Fail closed on any mapped edit that would reach hidden text: an endpoint
// strictly inside a denied interval, or a range that contains one (a selection
// spanning the placeholder). Honest wire offsets never trigger these — the
// gate is the corruption wall against forged or future-rotten offsets. The
// containment check is order-insensitive: a forged range whose endpoints pin
// to reversed boundaries (an equal-offset range at a marker with left/right
// affinities spans the hidden interval) maps backwards and is caught here too.
function assertEditLandsInVisibleText(from        , to        , redactions                      , label        )       {
  const strictlyInside = (value        ) => redactions.some((redaction) => redaction.start < value && value < redaction.end);
  if (strictlyInside(from) || strictlyInside(to)) {
    throw new ValidationError(`annotated-text ${label} position maps inside a redacted interval`, { code: 'position-redacted' });
  }
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  if (redactions.some((redaction) => lo <= redaction.start && redaction.end <= hi)) {
    throw new ValidationError(`annotated-text ${label} selection spans a redacted interval`, { code: 'position-redacted' });
  }
}

function positionBasis(serialized        )          {
  const parsed = JSON.parse(serialized);
  if (parsed?.version === 1 && typeof parsed.id === 'string' && Array.isArray(parsed.frontier)) return parsed;
  if (typeof parsed?.id === 'string' && Array.isArray(parsed?.checkpoint?.frontier)) {
    return { version: 1, id: parsed.id, frontier: parsed.checkpoint.frontier };
  }
  throw new ValidationError('annotated-text authoring basis is invalid', { code: 'position-stale' });
}

function samePositionBasis(serialized        , family                      )          {
  return JSON.stringify(positionBasis(serialized)) === JSON.stringify(textFamilyBasis(family));
}

/**
 * Rebase a STALE plain-insert offset into the current family. The raw offset is
 * only meaningful against the family the position frame was issued for, so it
 * is never reused directly. Reconstruct that family from the lease-scoped
 * checkpoint basis by replaying only the operations the basis covers, resolve
 * the original offset to a structural anchor there, then project that anchor
 * into the current family. Fail closed on a missing or ambiguous anchor instead
 * of silently landing the text somewhere else.
 */
function rebaseStaleInsertOffset(position                   , rawOffset                    , family                      )         {
  const stale = (message        )        => {
    throw new ValidationError(`annotated-text authoring position is stale: ${message}; re-bootstrap the snapshot`, { code: 'position-stale' });
  };
  if (!Number.isSafeInteger(rawOffset) || rawOffset === undefined || rawOffset < 0) {
    throw new ValidationError('annotated-text insert offset is invalid', { code: 'position-invalid' });
  }

  const basis = positionBasis(position.family_checkpoint)                                                                       ;
  if (basis.id !== family.id) stale('checkpoint basis names another document');
  const issueFrontier = basis.frontier;
  let dominates = false;
  try {
    dominates = frontierDominates(family.checkpoint.frontier, issueFrontier);
  } catch {
    // malformed basis — fail closed below
  }
  if (!dominates) stale('checkpoint basis is not a prefix of the current family');

  // Replay only the operations covered by the issue-time frontier. Every
  // dependency of a covered operation is covered too, so the replay is exact.
  const currentCheckpoint = family.checkpoint;
  const countersAtIssue = new Map(issueFrontier);
  const covered = ([actor, counter]                  )          => (countersAtIssue.get(actor) ?? 0) >= counter;
  const operations                      = {};
  for (const [key, entry] of Object.entries(currentCheckpoint.operations ?? {})) {
    if (covered((entry       ).op[2])) operations[key] = entry;
  }
  for (const [, entry] of Object.entries(currentCheckpoint.pending ?? {})) {
    if (covered((entry       ).op[2])) stale('checkpoint basis has unresolved operations');
  }
  const issueCheckpoint = {
    version: 2,
    frontier: issueFrontier,
    operations,
    pending: {},
    maxPending: currentCheckpoint.maxPending,
    rebootstrapRequired: false,
  };
  let issueFamily                       ;
  try {
    issueFamily = createTextFamily(family.id, issueCheckpoint);
  } catch {
    stale('checkpoint basis cannot be reconstructed');
  }
  assertOffsetInDocument(issueFamily, rawOffset, 'position at issue');

  // Resolve the original offset to a structural anchor AT ISSUE TIME.
  let anchor     ;
  try {
    anchor = rawOffset === 0 ? ['root'] : insertAnchorForOffset(issueFamily, rawOffset);
  } catch {
    throw new ValidationError('annotated-text insert offset cannot be resolved at issue', { code: 'position-invalid' });
  }
  const anchorKey = anchorKeyOf(anchor);

  // The anchor must still resolve in the CURRENT family.
  if (anchorKey !== 'root' && !hasTextElement(family.checkpoint, anchorKey)) {
    stale('structural anchor is gone');
  }
  let currentOffset         ;
  try {
    currentOffset = anchorKey === 'root'
      ? 0
      : projectEndpointToOffset(family, {
        point: ['point', anchor, 'right'],
        basisFrontier: issueFrontier,
      });
  } catch {
    stale('structural anchor does not resolve in the current family');
  }
  // No ambiguity: re-resolving the rebased offset in the current family must
  // land on the very same anchor; a different anchor means the position is not
  // faithfully rebaseable, so fail closed.
  let resolvedKey         ;
  try {
    const resolved = currentOffset === 0 ? ['root'] : insertAnchorForOffset(family, currentOffset);
    resolvedKey = anchorKeyOf(resolved);
  } catch {
    stale('rebased offset is ambiguous');
  }
  if (resolvedKey !== anchorKey) stale('rebased offset is ambiguous');
  assertOffsetInDocument(family, currentOffset, 'position');
  return currentOffset;
}

function anchorKeyOf(anchor     )         {
  if (anchor[0] === 'root') return 'root';
  const op = anchor[1][0];
  return `${op[0]}:${op[1]}:${anchor[1][1]}`;
}

/** text.insert | text.delete | text.replace */
async function admitTextEdit(ctx                                   )                     {
  const { name, fieldName, command, db, prefix, documentScope, lease, family, state, actor, lamport, edit } = ctx;
  // The prelude either confirms the position's family basis matches the
  // current family, or (for a stale, fully-visible plain insert) rebases the
  // offset to the current family through a structural anchor. For a redacted
  // recipient the offset is a WIRE offset (its frame's redactions are the
  // wire→canonical table); it is mapped before planning so edits land in
  // visible text only.
  const at = (edit.at ?? edit.from) ;
  const offset = edit.kind === 'text.insert' && ctx.staleInsertOffset !== null
    ? ctx.staleInsertOffset
    : at.offset;
  const redactions = parsedRedactions(ctx.position);
  let toOffset = offset;
  let toAffinity                   = 'right';
  if (edit.kind !== 'text.insert') {
    if (!edit.to?.positionToken) throw new ValidationError(`${name}.${fieldName}.operation replacement end position token unavailable`, { code: 'position-token-unavailable' });
    const toPosition = resolvePosition({ db, prefix, positionToken: edit.to.positionToken, leaseId: lease.id })                                       ;
    if (!toPosition) throw new ValidationError(`${name}.${fieldName}.operation replacement end position token unavailable`, { code: 'position-token-unavailable' });
    if (!toPosition.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation replacement end position no longer visible`, { code: 'position-no-longer-visible' });
    if (!samePositionBasis(toPosition.family_checkpoint, family)) {
      throw new ValidationError(`${name}.${fieldName}.operation replacement end authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
    }
    assertRedactionsBasesMatch(redactions, parsedRedactions(toPosition), 'replacement end');
    toOffset = edit.to.offset;
    toAffinity = edit.to.affinity;
  }
  const fromAffinity = at.affinity ?? 'right';
  // A two-ended edit at equal wire offsets is a range only when its endpoints
  // pin to different boundaries (left/right at a marker spans the hidden
  // interval); an insert is always the collapsed affinity-bound gap.
  const isRange = edit.kind !== 'text.insert' && (offset !== toOffset || fromAffinity !== toAffinity);
  const mapped = mapWireRangeToCanonical(offset, fromAffinity, toOffset, toAffinity, redactions, isRange);
  assertEditLandsInVisibleText(mapped.from, mapped.to, redactions, edit.kind === 'text.insert' ? 'position' : 'replacement');
  assertOffsetInDocument(family, mapped.from, 'position');
  if (edit.kind !== 'text.insert') assertOffsetInDocument(family, mapped.to, 'replacement end');
  const annotations = loadAnnotations({ db, prefix, compiledMeta: ctx.compiledMeta, documentId: command.id });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  // Build edit-overlap behaviors from compiled annotation handles (Decision 0025 policy 4).
  const editOverlapByFamily                                      = {};
  for (const [familyName, meta] of Object.entries(ctx.compiledMeta.annotationHandles                       )) {
    if (meta.editOverlap) editOverlapByFamily[familyName] = meta.editOverlap;
  }
  const annotationFields = loadAnnotationFields({ compiledMeta: ctx.compiledMeta, annotations });
  const plannerEdit = edit.kind === 'text.insert'
    ? { kind: 'text.insert', at: { offset: mapped.from, affinity: edit.at .affinity }, text: edit.text }
    : { kind: edit.kind, from: { offset: mapped.from, affinity: edit.from .affinity }, to: { offset: mapped.to, affinity: edit.to .affinity }, text: edit.text };
  let plan;
  try {
    plan = planTextOffsetEdit({
      documentId: command.id, structureVersion: state.structure_version, family, actor, lamport,
      annotations, ranges, edit: plannerEdit       ,
      editOverlapByFamily, annotationFields,
    });
  } catch (error) {
    const err = error                             ;
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/** annotation.apply (document range) */
async function admitTextRangeApply(ctx                                        )                     {
  const { name, fieldName, command, db, prefix, documentScope, lease, family, state, edit, compiledMeta } = ctx;
  const fromToken = edit.from?.positionToken;
  const toToken = edit.to?.positionToken;
  if (!fromToken || !toToken) throw new ValidationError(`${name}.${fieldName}.operation annotation selection tokens unavailable`, { code: 'position-token-unavailable' });
  const fromPos = resolvePosition({ db, prefix, positionToken: fromToken, leaseId: lease.id })                                       ;
  const toPos = resolvePosition({ db, prefix, positionToken: toToken, leaseId: lease.id })                                       ;
  if (!fromPos || !toPos) throw new ValidationError(`${name}.${fieldName}.operation annotation selection tokens unavailable`, { code: 'position-token-unavailable' });
  if (!fromPos.visible_at_issue || !toPos.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation annotation selection position no longer visible`, { code: 'position-no-longer-visible' });
  if (!samePositionBasis(fromPos.family_checkpoint, family) ||
      !samePositionBasis(toPos.family_checkpoint, family)) {
    throw new ValidationError(`${name}.${fieldName}.operation annotation selection authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
  }
  const redactions = parsedRedactions(fromPos);
  assertRedactionsBasesMatch(redactions, parsedRedactions(toPos), 'annotation selection');
  const mapped = mapWireRangeToCanonical(edit.from.offset, edit.from.affinity, edit.to.offset, edit.to.affinity, redactions,
    edit.from.offset !== edit.to.offset || edit.from.affinity !== edit.to.affinity);
  assertEditLandsInVisibleText(mapped.from, mapped.to, redactions, 'annotation selection');
  const familyMeta = compiledMeta.annotationHandles[edit.annotation?.family];
  if (!familyMeta) throw new ValidationError(`${name}.${fieldName}.operation unknown annotation family`, { code: 'position-invalid' });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  const annotations = loadAnnotations({ db, prefix, compiledMeta, documentId: command.id });
  const sameFamilyAnnotationIds = new Set(annotations.filter((candidate) => candidate.family === edit.annotation.family).map((candidate) => candidate.id));
  const annotation = {
    id: edit.annotation.id,
    family: edit.annotation.family,
    empty: familyMeta.empty,
    fields: edit.annotation.fields ?? {},
    protectedTargetIds: Array.isArray(edit.annotation?.protectedTargetIds) ? [...edit.annotation.protectedTargetIds].sort() : [],
  };
  let plan;
  try {
    plan = planTextRangeApply({
      documentId: command.id, structureVersion: state.structure_version, family,
      annotation,
      from: { offset: mapped.from, affinity: edit.from.affinity },
      to: { offset: mapped.to, affinity: edit.to.affinity },
      ranges, actorId: ctx.principal?.id ?? '',
      cardinality: familyMeta.cardinality,
      sameFamilyAnnotationIds,
    });
  } catch (error) {
    const err = error                             ;
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/** annotation.remove (document range) */
async function admitAnnotationRemove(ctx                               )                     {
  const { name, fieldName, command, db, prefix, documentScope, family, state, compiledMeta } = ctx;
  const annotations = loadAnnotations({ db, prefix, compiledMeta, documentId: command.id });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  if (!annotations.some((annotation) => annotation.id === edit_annotationId(command))) {
    throw new ValidationError(`${name}.${fieldName}.operation annotation not found`);
  }
  let plan;
  try {
    plan = planAnnotationRemove({
      documentId: command.id, structureVersion: state.structure_version, family,
      annotationId: edit_annotationId(command)          , annotations, ranges,
    });
  } catch (error) {
    const err = error                             ;
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/**
 * annotation.update (#174): the semantic atomic field (and optionally range)
 * mutation of an EXISTING annotation. One history step; when no range edit is
 * requested the stored endpoint basis anchors pass through untouched.
 */
async function admitTextAnnotationUpdate(ctx                                   )                     {
  const { name, fieldName, command, db, prefix, documentScope, family, state, edit, compiledMeta } = ctx;
  const annotations = loadAnnotations({ db, prefix, compiledMeta, documentId: command.id });
  const target = annotations.find((annotation) => annotation.id === edit.annotationId);
  if (!target || !edit.annotationId) throw new ValidationError(`${name}.${fieldName}.operation annotation not found`);
  const familyMeta = compiledMeta.annotationHandles[target.family];
  if (!familyMeta) throw new ValidationError(`${name}.${fieldName}.operation unknown annotation family`, { code: 'position-invalid' });
  // An update never changes protected edges; the plan image carries the live
  // set so replay can fail closed on any drift.
  const protectedTargetIds = (db.prepare(`SELECT target_annotation_id FROM ${prefix}_annotation_protected_target WHERE annotation_id = ? ORDER BY target_annotation_id`).all(target.id)                                           ).map((edge) => edge.target_annotation_id);

  const hasRange = !!edit.from?.positionToken || !!edit.to?.positionToken;
  let selection                                                                                                                    = null;
  if (hasRange) {
    const from = edit.from;
    const to = edit.to;
    const fromToken = from?.positionToken;
    const toToken = to?.positionToken;
    if (!from || !to || !fromToken || !toToken) throw new ValidationError(`${name}.${fieldName}.operation annotation range tokens unavailable`, { code: 'position-token-unavailable' });
    const fromPos = resolvePosition({ db, prefix, positionToken: fromToken, leaseId: ctx.lease.id })                                       ;
    const toPos = resolvePosition({ db, prefix, positionToken: toToken, leaseId: ctx.lease.id })                                       ;
    if (!fromPos || !toPos) throw new ValidationError(`${name}.${fieldName}.operation annotation range tokens unavailable`, { code: 'position-token-unavailable' });
    if (!fromPos.visible_at_issue || !toPos.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation annotation range position no longer visible`, { code: 'position-no-longer-visible' });
    if (!samePositionBasis(fromPos.family_checkpoint, family) ||
        !samePositionBasis(toPos.family_checkpoint, family)) {
      throw new ValidationError(`${name}.${fieldName}.operation annotation range authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
    }
    const redactions = parsedRedactions(fromPos);
    assertRedactionsBasesMatch(redactions, parsedRedactions(toPos), 'annotation range');
    const mapped = mapWireRangeToCanonical(from.offset, from.affinity, to.offset, to.affinity, redactions,
      from.offset !== to.offset || from.affinity !== to.affinity);
    assertEditLandsInVisibleText(mapped.from, mapped.to, redactions, 'annotation range');
    selection = {
      startOffset: mapped.from,
      startAffinity: from.affinity,
      endOffset: mapped.to,
      endAffinity: to.affinity,
    };
  }

  const ranges = loadRanges({ db, prefix, documentId: command.id });
  const sameFamilyAnnotationIds = new Set(annotations.filter((candidate) => candidate.family === target.family).map((candidate) => candidate.id));
  let plan;
  try {
    plan = planAnnotationUpdate({
      documentId: command.id, structureVersion: state.structure_version, family,
      target: { id: target.id, family: target.family, empty: target.empty, protectedTargetIds },
      fields: edit.fields ?? {},
      annotations, ranges,
      actorId: ctx.principal?.id ?? '',
      cardinality: familyMeta.cardinality,
      sameFamilyAnnotationIds,
      selection,
    });
  } catch (error) {
    const err = error                             ;
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/**
 * Paste text and carry one source annotation onto the pasted characters. The
 * text insertion and annotation postimage are emitted as one operated event,
 * so projection and history cannot split the paste into two steps.
 */
async function admitAnnotationPaste(ctx                                   )                     {
  const { edit, family, state, command, documentScope, actor, lamport, compiledMeta, db, prefix } = ctx;
  if (!edit.annotation || typeof edit.text !== 'string' || !edit.text.length || !edit.at) {
    throw new ValidationError(`${ctx.name}.${ctx.fieldName}.operation annotation.paste requires annotation, at, and text`);
  }
  const pastedAnnotation = edit.annotation;
  const familyMeta = compiledMeta.annotationHandles[pastedAnnotation.family];
  if (!familyMeta) throw new ValidationError(`${ctx.name}.${ctx.fieldName}.operation unknown annotation family`, { code: 'position-invalid' });

  // Paste positions use the same wire-to-canonical redaction mapping as a
  // normal text insertion. A restricted recipient can paste only at a visible
  // boundary and never smuggle a canonical offset for hidden text.
  const redactions = parsedRedactions(ctx.position);
  const mapped = mapWireRangeToCanonical(edit.at.offset, edit.at.affinity, edit.at.offset, edit.at.affinity, redactions, false);
  assertEditLandsInVisibleText(mapped.from, mapped.to, redactions, 'paste position');
  assertOffsetInDocument(family, mapped.from, 'paste position');

  const id = randomUUID();
  const annotation = {
    id,
    family: pastedAnnotation.family,
    empty: familyMeta.empty,
    cardinality: (familyMeta.cardinality === 'one' ? 'one' : 'many')                  ,
    fields: { ...(pastedAnnotation.fields ?? {}) },
    // Protection edges point at document-local ids and cannot be copied by
    // reference; a paste copies annotation fields, not those relationships.
    protectedTargetIds: [],
  };
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  const annotations = loadAnnotations({ db, prefix, compiledMeta, documentId: command.id });
  const annotationFields = new Map(annotations.map((candidate) => [candidate.id, candidate.fields]));
  const editOverlapByFamily                                      = {};
  for (const [familyName, meta] of Object.entries(compiledMeta.annotationHandles                       )) {
    if (meta.editOverlap) editOverlapByFamily[familyName] = meta.editOverlap;
  }
  let plan;
  try {
    plan = planAnnotationPaste({
      documentId: command.id,
      structureVersion: state.structure_version,
      family,
      actor,
      lamport,
      text: edit.text,
      at: { offset: mapped.from, affinity: edit.at.affinity },
      annotation,
      annotations,
      ranges,
      editOverlapByFamily,
      annotationFields,
      actorId: ctx.principal?.id ?? '',
    });
  } catch (error) {
    const err = error                             ;
    throw new ValidationError(`${ctx.name}.${ctx.fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(ctx.name, ctx.fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

function edit_annotationId(command           )                     {
  return command.edit?.annotationId ?? command.edit?.annotation?.id;
}

/**
 * Admit a validated v9 annotated-text command. Structure edits (block.split,
 * block.merge, block.continue, block-group.assignment) are gone in the
 * blockless model and are rejected.
 */
export async function admitV9AnnotatedTextEdit(ctx                )                     {
  const prelude = await assertV9AuthoringPrelude(ctx);
  const edit = prelude.command.edit;
  if (edit.kind === 'text.insert' || edit.kind === 'text.delete' || edit.kind === 'text.replace') {
    return admitTextEdit({ ...prelude, edit });
  }
  if (edit.kind === 'annotation.apply') {
    return admitTextRangeApply({ ...prelude, edit: edit                     });
  }
  if (edit.kind === 'annotation.remove') {
    return admitAnnotationRemove({ ...prelude, edit });
  }
  if (edit.kind === 'annotation.update') {
    return admitTextAnnotationUpdate({ ...prelude, edit });
  }
  if (edit.kind === 'annotation.paste') {
    return admitAnnotationPaste({ ...prelude, edit });
  }
  throw new ValidationError(`${prelude.name}.${prelude.fieldName}.operation block-era edit '${edit.kind}' is not supported (issue #33)`, { code: 'position-invalid' });
}
