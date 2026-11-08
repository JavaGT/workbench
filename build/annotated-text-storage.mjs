
import { annotationDeclarationFingerprint } from './annotated-text-delete-history.mjs';
import { canonicalEndpointJSON, membershipDigest } from './annotated-text-delete-history-shared.mjs';
import { assertStructuralEndpoint } from './annotated-text-family.mjs';
export { canonicalEndpointJSON } from './annotated-text-delete-history-shared.mjs';
// A stored annotation-to-range link joined with its immutable range record.
// Ranges are DOCUMENT-scoped: the UNIQUE(document_id, start_point, end_point)
// constraint interns only within one document, and the membership composite
// FKs (annotation_id, document_id) / (range_id, document_id) enforce at the
// database boundary that an annotation and its range belong to the same row.
                                                                                                                                // Joined immutable range row.

// Canonical endpoint text independent of object property order: the endpoint
// is read BY KEY and re-serialized as the fixed `{ point, basisFrontier }`
// shape, so a reordered-key copy of the same structural endpoint interns to
// the identical range row. Non-object input fails closed.
export function annotationRangeRows(db          , prefix        , documentId        )                       {
  return db.prepare(`SELECT membership.annotation_id, membership.ordinal, range.id AS range_id,
      range.start_point, range.end_point
    FROM ${prefix}_membership AS membership
    JOIN ${prefix}_range AS range ON range.id = membership.range_id
    JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
    WHERE annotation.document_id = ?
    ORDER BY membership.annotation_id, membership.ordinal`).all(documentId)                                   ;
}

export function attachAnnotationRange(db          , prefix        , documentId        , annotationId        , start         , end         , ordinal        )       {
  const startPoint = canonicalEndpointJSON(start);
  const endPoint = canonicalEndpointJSON(end);
  db.prepare(`INSERT OR IGNORE INTO ${prefix}_range (document_id, start_point, end_point) VALUES (?, ?, ?)`).run(documentId, startPoint, endPoint);
  const range = db.prepare(`SELECT id FROM ${prefix}_range WHERE document_id = ? AND start_point = ? AND end_point = ?`).get(documentId, startPoint, endPoint)                              ;
  if (!range) throw new Error('annotated-text range could not be interned');
  db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, range_id, document_id, ordinal) VALUES (?, ?, ?, ?)`).run(annotationId, range.id, documentId, ordinal);
}

// ---------------------------------------------------------------------------
// Declaration-driven delete-history capture/restore (#133 Phase A)
//
// These helpers are the storage boundary for
// `annotated-text-delete-history.ts`: they load the annotation graph a delete
// fact images, validate those images against a compiled declaration, and (in
// Phase D) restore them with original identities. They perform no text-family
// writes and change no history eligibility.
// ---------------------------------------------------------------------------








/** Parsed structural endpoints of one membership, keyed by its stored ordinal. */






/**
 * Load every annotation of one document with complete image material: family,
 * canonical serialized extension fields, protected-target links, memberships
 * (parsed endpoints), and declared ref prerequisites. Field rows default to
 * canonical stored cells; `deserializeFields: true` is only for callers that
 * explicitly need projected values and must not feed those values to restore.
 */
/** Saved orphan state per annotation. Missing side table (pre-orphan schemas,
 * minimal fixtures) means "no orphans" rather than an error. */
export function annotationOrphanStates(db          , prefix        , documentId        )


   {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(`${prefix}_annotation_orphan_state`);
  if (!table) return new Map();
  const orphanRows = db.prepare(
    `SELECT orphan.annotation_id, orphan.saved_quote, orphan.last_range
       FROM ${prefix}_annotation_orphan_state AS orphan
       JOIN ${prefix}_annotation AS annotation ON annotation.id = orphan.annotation_id
      WHERE annotation.document_id = ?`,
  ).all(documentId)                                                                                               ;
  return new Map(orphanRows.map((row) => [row.annotation_id, {
    savedQuote: row.saved_quote,
    lastRange: row.last_range === null ? null : JSON.parse(row.last_range)                                    ,
  }]));
}
export function loadAnnotationImages(db          , options














 )









     {
  const { prefix, documentId } = options;
  const familyFilter = options.families === undefined ? null : new Set(options.families);
  const declarations = [...options.declarations]
    .filter((declared) => familyFilter === null || familyFilter.has(declared.annotationName));
  const deserialize = options.deserializeFields === true;
  const allRows = db.prepare(`SELECT id, family, project_id, owner_id FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(documentId)                                    ;
  const rows = familyFilter === null ? allRows : allRows.filter((row) => familyFilter.has(row.family));
  const annotationIds = new Set(rows.map((row) => row.id));
  const targets = db.prepare(
    `SELECT edge.annotation_id, edge.target_annotation_id FROM ${prefix}_annotation_protected_target AS edge
      JOIN ${prefix}_annotation AS annotation ON annotation.id = edge.annotation_id
     WHERE annotation.document_id = ?
     ORDER BY edge.annotation_id, edge.target_annotation_id`,
  ).all(documentId)                                                                             ;
  const targetsByAnnotation = new Map                  ();
  for (const edge of targets) {
    if (!annotationIds.has(edge.annotation_id)) continue;
    targetsByAnnotation.set(edge.annotation_id, [...(targetsByAnnotation.get(edge.annotation_id) ?? []), edge.target_annotation_id]);
  }
  const membershipsByAnnotation = new Map                                     ();
  for (const row of annotationRangeRows(db, prefix, documentId)) {
    if (!annotationIds.has(row.annotation_id)) continue;
    const entries = membershipsByAnnotation.get(row.annotation_id) ?? [];
    entries.push({ ordinal: row.ordinal, start: assertStructuralEndpoint(JSON.parse(row.start_point)), end: assertStructuralEndpoint(JSON.parse(row.end_point)) });
    membershipsByAnnotation.set(row.annotation_id, entries);
  }
  const orphanByAnnotation = annotationOrphanStates(db, prefix, documentId);
  const fieldsByFamilyByAnnotation = new Map                                              ();
  for (const declared of declarations) {
    const familyRows = db.prepare(
      `SELECT child.* FROM ${prefix}_annotation_${declared.annotationName} AS child
        JOIN ${prefix}_annotation AS annotation ON annotation.id = child.annotation_id
       WHERE annotation.document_id = ?`,
    ).all(documentId)                                             ;
    const byAnnotation = new Map(familyRows.map((stored) => [String(stored.annotation_id), stored]));
    fieldsByFamilyByAnnotation.set(declared.annotationName, byAnnotation);
  }

  const images = []









    ;
  for (const row of rows) {
    const declared = declarations.find((candidate) => candidate.annotationName === row.family);
    if (!declared) throw new Error(`annotation '${row.id}' has unknown family '${row.family}'`);
    const stored = fieldsByFamilyByAnnotation.get(row.family)?.get(row.id);
    const fieldNames = Object.keys(declared.fields).sort();
    const fields                          = {};
    for (const name of fieldNames) {
      const descriptor = declared.fields[name]                                  ;
      let value = stored?.[name];
      if (deserialize && value !== null && value !== undefined) value = deserializeAnnotatedFieldValue(descriptor, value);
      fields[name] = value === undefined ? null : value;
    }
    const refTargets = fieldNames.filter((name) => isRefField(declared.fields[name]) && stored?.[name] !== null && stored?.[name] !== undefined);
    const prerequisites = refTargets.map((name) => ({
      entity: String(refTargetName(declared.fields[name])),
      id: String(stored?.[name]),
    })).sort((left, right) => (left.entity + '\u0000' + left.id < right.entity + '\u0000' + right.id ? -1 : 1));
    images.push({
      id: row.id,
      family: row.family,
      fields,
      protectedTargetIds: targetsByAnnotation.get(row.id) ?? [],
      memberships: membershipsByAnnotation.get(row.id) ?? [],
      prerequisites,
      empty: declared.empty === 'orphan' ? 'orphan' : 'delete',
      cardinality: declared.cardinality === 'one' ? 'one' : 'many',
      orphan: orphanByAnnotation.get(row.id) ?? null,
    });
  }
  return images;
}

function isRefField(descriptor         )          {
  const record = descriptor                                         ;
  return !!record && record.type === 'ref';
}

function refTargetName(descriptor         )         {
  const record = descriptor                                           ;
  if (!record || !record.target) throw new Error('annotated-text ref field must declare a target');
  return typeof record.target === 'string' ? record.target : String((record.target                      ).name);
}

// Minimal local deserialization for annotated-text scalar cells. The json
// strategy stores TEXT JSON; every other scalar cell round-trips as itself.
// Kept here (rather than importing field strategies) so this module stays a
// narrow storage boundary without pulling admission machinery into tests.
function deserializeAnnotatedFieldValue(descriptor         , value         )          {
  const record = descriptor                                         ;
  if (record && record.type === 'json') {
    try {
      return JSON.parse(String(value));
    } catch {
      throw new Error('annotated-text json annotation field could not be restored');
    }
  }
  return value;
}

/**
 * Canonical digest over a COMPLETE membership set — identity is
 * `(annotation_id, ordinal)`, endpoints enter via canonical endpoint JSON.
 * Delegated to the delete-history module so capture, validation, and CAS
 * checks all hash identically.
 */
export function annotationMembershipDigest(memberships                                      )         {
  return membershipDigest(memberships);
}

/**
 * Validate an annotation image against its compiled declaration: exact field
 * set, per-field validity through the declaration's own validators, sorted
 * unique protected targets, and forward non-empty relative ranges. Returns the
 * normalized image or throws before any caller writes.
 */
export function validateAnnotationImage(image         , options

 )                          {
  const record = image                                              ;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('annotation image must be an object');
  for (const key of ['id', 'family', 'fields', 'protectedTargetIds', 'ranges', 'expectedPostDelete', 'disposition']) {
    if (!Object.hasOwn(record, key)) throw new Error(`annotation image is missing '${key}'`);
  }
  const { declaration } = options;
  if (record.family !== declaration.annotationName) throw new Error(`annotation image family '${record.family}' does not match declaration '${declaration.annotationName}'`);
  const fields = record.fields                                              ;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('annotation image fields must be an object');
  const declaredNames = Object.keys(declaration.fields).sort();
  const suppliedNames = Object.keys(fields).sort();
  if (declaredNames.join('\u0000') !== suppliedNames.join('\u0000')) throw new Error('annotation image fields disagree with the declaration');
  for (const name of declaredNames) {
    const descriptor = declaration.fields[name]                          ;
    const value = fields[name];
    if (typeof descriptor.validate === 'function' && !(descriptor.validate                               )(value)) {
      throw new Error(`annotation image field '${name}' failed declaration validation`);
    }
  }
  const targets = record.protectedTargetIds           ;
  if (!Array.isArray(targets) || targets.some((id) => typeof id !== 'string')) throw new Error('annotation image protectedTargetIds must be strings');
  const sorted = [...targets].sort();
  if (sorted.some((id, index) => index > 0 && sorted[index - 1] >= id)) throw new Error('annotation image protectedTargetIds must be sorted and unique');
  return record;
}

/**
 * Restore deleted annotation images in FK-safe order with ORIGINAL identities:
 * base `${prefix}_annotation` row (plain INSERT — same-ID collision and any FK
 * failure abort the whole transaction), family extension row, protected-target
 * links, then memberships reusing interned immutable ranges and original
 * ordinals. Never generates an annotation ID and never uses INSERT OR REPLACE.
 *
 * `document` supplies the current document/project/owner identity; `rows`
 * come from `loadAnnotationImages`-shaped captures (Phase D passes the fact's
 * images mapped back onto these shapes). Returns false, without writing, when
 * any original annotation ID is globally occupied.
 */
export function restoreAnnotationImages(db          , options















 )          {
  const { prefix, documentId, projectId, ownerId } = options;
  const declarations = [...options.declarations];
  const images = [...options.images];
  const imageById = new Map(images.map((image) => [image.id, image]));
  if (imageById.size !== images.length) throw new Error('cannot restore annotations: duplicate image IDs');
  const currentDeclarationFingerprint = annotationDeclarationFingerprint(declarations, images.map((image) => image.family));
  if (currentDeclarationFingerprint !== options.declarationFingerprint) {
    throw new Error('cannot restore annotations: declaration drift changed the captured extension-row shape');
  }

  // Validate the complete graph before the first write. Annotation IDs are a
  // global primary key, so a collision in another document blocks the move.
  for (const image of images) {
    const declared = declarations.find((candidate) => candidate.annotationName === image.family);
    if (!declared) throw new Error(`cannot restore annotation '${image.id}': family '${image.family}' is not declared`);
    const declaredFields = Object.keys(declared.fields).sort();
    const capturedFields = Object.keys(image.fields).sort();
    if (declaredFields.join('\u0000') !== capturedFields.join('\u0000')) {
      throw new Error(`cannot restore annotation '${image.id}': declaration drift changed its extension-row fields`);
    }
    const existing = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ?`).get(image.id);
    if (existing) return false;
    for (const targetId of image.protectedTargetIds ?? []) {
      const restoredTarget = imageById.get(targetId);
      const storedTarget = restoredTarget ? undefined : db.prepare(`SELECT family FROM ${prefix}_annotation WHERE id = ?`).get(targetId)                                  ;
      const targetFamily = restoredTarget?.family ?? storedTarget?.family;
      if (!targetFamily || declared.protects !== targetFamily) {
        throw new Error(`cannot restore annotation '${image.id}': protected target '${targetId}' is missing or violates its declaration`);
      }
    }
  }

  const restoreOrder = images.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  // Every base exists before any protected-target edge, so declaration-legal
  // cycles are FK-safe without topologically ordering the protector graph.
  for (const image of restoreOrder) {
    db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`)
      .run(image.id, documentId, projectId, ownerId, image.family);
  }

  for (const image of restoreOrder) {
    const declared = declarations.find((candidate) => candidate.annotationName === image.family) ;
    const fieldNames = Object.keys(declared.fields).sort()            ;
    const values = fieldNames.map((name) => Object.hasOwn(image.fields, name) ? image.fields[name] : null);
    const columns = ['annotation_id', ...fieldNames];
    db.prepare(`INSERT INTO ${prefix}_annotation_${image.family} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(image.id, ...values);
  }

  for (const image of restoreOrder) {
    for (const targetId of [...(image.protectedTargetIds ?? [])].sort()) {
      db.prepare(`INSERT INTO ${prefix}_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)`).run(image.id, targetId);
    }
  }

  for (const image of restoreOrder) {
    for (const membership of [...(image.memberships ?? [])].sort((left, right) => left.ordinal - right.ordinal)) {
      attachAnnotationRange(db, prefix, documentId, image.id, membership.start, membership.end, membership.ordinal);
    }
  }
  return true;
}

/**
 * CAS-guarded membership patch for an annotation RETAINED through the forward
 * delete: replace only the captured affected memberships when the COMPLETE
 * post-delete membership set still hashes to `expectedDigest`. The base row is
 * never recreated. Ranges may be reused via endpoint equality; membership
 * identity `(annotation_id, ordinal)` is preserved by restoring original
 * ordinals. Throws on expectation mismatch (the compensation handler turns
 * that into a whole-move no-op).
 */
export function patchRetainedMemberships(db          , options





 )       {
  const { prefix, documentId, annotationId, expectedDigest } = options;
  const current = annotationRangeRows(db, prefix, documentId).filter((row) => row.annotation_id === annotationId)
    .map((row) => ({ ordinal: row.ordinal, start: JSON.parse(row.start_point), end: JSON.parse(row.end_point) }));
  if (annotationMembershipDigest(current) !== expectedDigest) {
    throw new Error(`retained annotation '${annotationId}' moved after the delete; compare-and-compensate blocks restoration`);
  }
  const affectedOrdinals = new Set(options.affected.map((entry) => entry.ordinal));
  for (const row of annotationRangeRows(db, prefix, documentId)) {
    if (row.annotation_id === annotationId && affectedOrdinals.has(row.ordinal)) {
      db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ? AND ordinal = ?`).run(annotationId, row.ordinal);
    }
  }
  for (const entry of [...options.affected].sort((left, right) => left.ordinal - right.ordinal)) {
    attachAnnotationRange(db, prefix, documentId, annotationId, entry.start, entry.end, entry.ordinal);
  }
}
