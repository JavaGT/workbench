import { deserializeField } from './field-strategy.ts';
import {
  compactTextFamilyCheckpoint,
  restoreTextFamilySerialized,
  materializeText,
  projectEndpointToOffset,
  textFamilyBasis,
  textFamilyVisibleLength,
} from './annotated-text-continuous.ts';
import { getAnnotatedTextCompiledMetadata, resolveAnnotatedTextOwningScope } from './annotated-text-field.ts';
import {
  createAnnotatedTextRecipientSource,
  projectAnnotatedTextRecipient,
  authoringRedactionsForRecipient,
  isProtectorActive,
  type AuthoringRedaction,
} from './annotated-text-recipient-projection.ts';
import { projectAnnotatedTextCaretForRecipient } from './annotated-text-caret-projection.ts';
import { mayFieldOp, mayRow, protectingAnnotationCapabilities } from './row-grant.ts';
import { read, write } from './grant.ts';
import {
  resolveStream,
  resolveLease,
  issueAuthoringSnapshot,
  buildAuthoringEnvelope,
  readAnnotatedTextFamilyCheckpoint,
} from './annotated-text-authoring-stream.ts';
import { readProjectedCursorFence } from './projected-async.ts';
import { readSeq } from './cursor.ts';
import { rawRow } from './entity/query.ts';
import { scopeOf } from './scope-handle.ts';
import type { ContinuousTextFamily } from './annotated-text-continuous.ts';
import type { StructuralEndpoint } from './annotated-text-family.ts';
import type {
  AnnotatedTextRecipientAnnotation,
  AnnotatedTextRecipientRange,
  AnnotatedTextRecipientSource,
} from './annotated-text-recipient-projection.ts';
import { annotationRangeRows } from './annotated-text-storage.ts';
import {
  canonicalToWireIntervals,
  coversWholeDocument,
  sortAndMergeIntervals,
} from './annotated-text-ranges.ts';

function fail(message: string): never {
  throw new Error(`annotated-text snapshot: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const RECIPIENT_READ_ATTEMPTS = 2;
const recipientUnavailable = deepFreeze({ kind: 'unavailable' });
const recipientRetry = deepFreeze({ kind: 'retry' });

// ---------------------------------------------------------------------------
// Bounded per-DB LRU cache for shared visible recipient projections (#292).
//
// Keyed by (entity, field, documentId) and validated against:
//   - structure_version + family_checkpoint (text/structural revision)
//   - annotationMutationVersion (bumped on every projection/CRUD write)
//   - SQLite PRAGMA data_version (cross-connection invalidation)
//   - descriptor object identity
//
// When 13+ recipients read the same document revision, they share ONE SQLite
// read + endpoint projection pass and (when all active protectors allow) ONE
// frozen v3 interned wire payload per capabilityHints signature, while each
// recipient still runs its own protector/write authorization and mints its own
// authoring envelope.
// ---------------------------------------------------------------------------

const SHARED_SNAPSHOT_CACHE_LIMIT = 32;

interface CachedDocumentSnapshot {
  readonly structureVersion: number;
  readonly familyCheckpoint: string;
  readonly annotationMutationVersion: number;
  readonly dataVersion: number;
  readonly descriptor: unknown;
  readonly family: ContinuousTextFamily;
  readonly text: string;
  readonly sourceFor: (anchored: boolean) => AnnotatedTextRecipientSource;
  readonly activeProtectors: AnnotatedTextRecipientAnnotation[];
  readonly fullyVisibleRecipients: Map<string, any>;
}

interface DbSnapshotCacheState {
  readonly mutationVersions: Map<string, number>;
  readonly snapshots: Map<string, CachedDocumentSnapshot>;
}

const dbSnapshotCaches = new WeakMap<object, DbSnapshotCacheState>();

function cacheStateForDb(db: unknown): DbSnapshotCacheState | null {
  if (!db || typeof db !== 'object') return null;
  let state = dbSnapshotCaches.get(db);
  if (!state) {
    state = { mutationVersions: new Map(), snapshots: new Map() };
    dbSnapshotCaches.set(db, state);
  }
  return state;
}

function docCacheKey(prefix: string, documentId: string): string {
  return `${prefix}\u0000${documentId}`;
}

/**
 * Bump the annotation mutation version and evict any cached visible snapshot
 * for `(db, prefix, documentId)`. Called on every projection/CRUD write.
 */
export function invalidateAnnotatedTextSnapshotCache(db: unknown, prefix: string, documentId: string): void {
  const state = cacheStateForDb(db);
  if (!state) return;
  const key = docCacheKey(prefix, documentId);
  state.mutationVersions.set(key, (state.mutationVersions.get(key) ?? 0) + 1);
  state.snapshots.delete(key);
}

function readDataVersion(db: any): number {
  try {
    const row = db.prepare('PRAGMA data_version').get();
    return Number(row?.data_version ?? 0);
  } catch {
    return 0;
  }
}

function getCachedSnapshot(
  db: unknown,
  prefix: string,
  documentId: string,
  structureVersion: number,
  familyCheckpoint: string,
  dataVersion: number,
  descriptor: unknown,
): CachedDocumentSnapshot | null {
  const state = cacheStateForDb(db);
  if (!state) return null;
  const key = docCacheKey(prefix, documentId);
  const cached = state.snapshots.get(key);
  if (!cached) return null;
  const mutationVersion = state.mutationVersions.get(key) ?? 0;
  if (
    cached.structureVersion !== structureVersion
    || cached.familyCheckpoint !== familyCheckpoint
    || cached.annotationMutationVersion !== mutationVersion
    || cached.dataVersion !== dataVersion
    || cached.descriptor !== descriptor
  ) {
    state.snapshots.delete(key);
    return null;
  }
  // Touch LRU position.
  state.snapshots.delete(key);
  state.snapshots.set(key, cached);
  return cached;
}

function putCachedSnapshot(
  db: unknown,
  prefix: string,
  documentId: string,
  entry: CachedDocumentSnapshot,
): void {
  const state = cacheStateForDb(db);
  if (!state) return;
  const key = docCacheKey(prefix, documentId);
  state.snapshots.delete(key);
  state.snapshots.set(key, entry);
  if (state.snapshots.size > SHARED_SNAPSHOT_CACHE_LIMIT) {
    const oldestKey = state.snapshots.keys().next().value;
    if (oldestKey !== undefined) state.snapshots.delete(oldestKey);
  }
}

function requireRecipientReadInput(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !input.app?.db || !input.app?.entities || typeof input.entity?.name !== 'string' ||
      !input.field || typeof input.field.fieldName !== 'string' ||
      typeof input.documentId !== 'string' || input.documentId.length === 0 ||
      !input.expectedOwningScope || typeof input.expectedOwningScope !== 'object' ||
      typeof input.expectedOwningScope.entity?.name !== 'string' ||
      typeof input.expectedOwningScope.id !== 'string' || input.expectedOwningScope.id.length === 0 ||
      !input.principal || typeof input.principal !== 'object' ||
      typeof input.principal.type !== 'string' || !Object.hasOwn(input.principal, 'id') ||
      !Object.hasOwn(input.principal, 'attributes')) {
    throw new TypeError('readAnnotatedTextForRecipient requires a complete public recipient read input');
  }
}

function sanitizedRecipientReadFailure(): Error {
  return new Error('annotated-text recipient read failed');
}

function unchangedCursor(db: any, scopeKey: string, before: number): boolean {
  return readSeq(db, scopeKey) === before;
}

/**
 * Project a stored membership range (historical-basis endpoint JSON) to
 * absolute offsets against the current continuous family. Returns null when the
 * range is unprojectable (stale basis / lost anchor).
 */
function projectRangeToOffsets(
  family: ContinuousTextFamily,
  startPoint: StructuralEndpoint,
  endPoint: StructuralEndpoint,
  textLength: number,
): { start: number; end: number } | null {
  let start;
  let end;
  try {
    start = projectEndpointToOffset(family, startPoint);
    end = projectEndpointToOffset(family, endPoint);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > textLength) return null;
  return { start, end };
}

function parseStoredEndpoint(serialized: string, frontierByShape?: Map<string, StructuralEndpoint['basisFrontier']>): StructuralEndpoint {
  let endpoint;
  try {
    endpoint = JSON.parse(serialized);
  } catch {
    fail('stored endpoint is not JSON');
  }
  const validated = validateStoredEndpoint(endpoint);
  const frontierShape = JSON.stringify(validated.basisFrontier);
  const basisFrontier = frontierByShape?.get(frontierShape) ?? validated.basisFrontier;
  frontierByShape?.set(frontierShape, basisFrontier);
  return { point: validated.point, basisFrontier };
}

function validateStoredEndpoint(endpoint: unknown): StructuralEndpoint {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)
    || !Object.hasOwn(endpoint, 'point') || !Object.hasOwn(endpoint, 'basisFrontier')) {
    fail('stored endpoint is not a structural endpoint');
  }
  const stored = endpoint as { point: unknown; basisFrontier: unknown };
  return { point: stored.point, basisFrontier: stored.basisFrontier } as StructuralEndpoint;
}

function loadAnnotations({ db, prefix, descriptor, documentId }: { db: any; prefix: string; descriptor: any; documentId: string }): any[] {
  const declarations = new Map<string, { declared: any; fields: Array<[string, any]> }>();
  for (const declared of descriptor.annotations) {
    declarations.set(declared.annotationName, { declared, fields: Object.entries(declared.fields) });
  }
  const rows = db.prepare(`SELECT id, family, owner_id FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(documentId);
  const targets = db.prepare(
    `SELECT edge.annotation_id, edge.target_annotation_id FROM ${prefix}_annotation_protected_target AS edge
      JOIN ${prefix}_annotation AS annotation ON annotation.id = edge.annotation_id
     WHERE annotation.document_id = ? ORDER BY edge.annotation_id, edge.target_annotation_id`,
  ).all(documentId);
  const targetsByAnnotation = new Map<string, string[]>();
  for (const edge of targets) {
    const own = targetsByAnnotation.get(edge.annotation_id);
    if (own) own.push(edge.target_annotation_id);
    else targetsByAnnotation.set(edge.annotation_id, [edge.target_annotation_id]);
  }
  const storedByFamily = new Map<string, Map<string, any>>();
  for (const { declared, fields } of declarations.values()) {
    if (fields.length === 0) continue;
    const familyRows = db.prepare(`SELECT child.* FROM ${prefix}_annotation_${declared.annotationName} AS child JOIN ${prefix}_annotation AS annotation ON annotation.id = child.annotation_id WHERE annotation.document_id = ?`).all(documentId);
    const stored = new Map<string, any>();
    for (const row of familyRows) stored.set(row.annotation_id, row);
    storedByFamily.set(declared.annotationName, stored);
  }
  const annotations: any[] = [];
  for (const row of rows) {
    const declaration = declarations.get(row.family);
    if (!declaration) fail(`annotation '${row.id}' has unknown family`);
    const fields: Record<string, any> = {};
    const stored = storedByFamily.get(row.family)?.get(row.id);
    if (!stored && declaration.fields.length !== 0) fail(`annotation '${row.id}' fields are missing`);
    for (const [name, field] of declaration.fields) fields[name] = deserializeField(field, stored[name]);
    const targetIds = targetsByAnnotation.get(row.id);
    annotations.push(targetIds
      ? { id: row.id, family: row.family, fields, owner: row.owner_id, protectedTargetIds: targetIds }
      : { id: row.id, family: row.family, fields, owner: row.owner_id });
  }
  return annotations;
}

type SnapshotProfile = (phase: string, durationMs: number, details?: Readonly<Record<string, number>>) => void;

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function readArrayRows(db: any, query: string, ...params: unknown[]): any[][] {
  const statement = db.prepare(query);
  if (typeof statement.setReturnArrays === 'function') {
    statement.setReturnArrays(true);
    return statement.all(...params);
  }
  return statement.values(...params);
}

function iterateArrayRows(db: any, query: string, ...params: unknown[]): Iterable<any[]> {
  const statement = db.prepare(query);
  if (typeof statement.setReturnArrays === 'function') {
    statement.setReturnArrays(true);
    return statement.iterate(...params);
  }
  return statement.values(...params);
}

/**
 * Lightweight protector-only visibility evaluation for hot authoring and live
 * fold paths (#292). Checks retired state and evaluates ONLY protecting
 * annotations and their protected targets — never loading or projecting
 * unrelated annotations (e.g. 72k coding/timing annotations).
 *
 * Security-equivalent to `projectAnnotatedTextSnapshot`: throws on missing
 * metadata/state, retired document, malformed rows, unprojectable protector or
 * target memberships, or unknown protected target ids.
 */
export async function evaluateAnnotatedTextVisibility({
  db,
  entity,
  row,
  principal,
  fieldName,
  descriptor,
  family,
}: {
  db: any;
  entity: any;
  row: any;
  principal: any;
  fieldName: string;
  descriptor: any;
  family?: ContinuousTextFamily;
}): Promise<{
  fullyVisible: boolean;
  restricted: boolean;
  redactions: AuthoringRedaction[];
}> {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!meta) fail(`field '${fieldName}' is not compiled`);
  const prefix = `${entity.name}_${fieldName}`;
  if (db.prepare(`SELECT 1 FROM ${prefix}_retired WHERE document_id = ?`).get(row.id)) {
    fail(`field '${fieldName}' document is retired`);
  }

  const protectingFamilyNames = Object.keys(meta.protectingFamilies ?? {});
  if (protectingFamilyNames.length === 0) {
    if (!family && readAnnotatedTextFamilyCheckpoint(db, prefix, row.id) === undefined) {
      fail(`field '${fieldName}' state is missing`);
    }
    return { fullyVisible: true, restricted: false, redactions: [] };
  }

  const familyPlaceholders = protectingFamilyNames.map(() => '?').join(', ');
  const protectorRows = db.prepare(
    `SELECT id, family, owner_id
       FROM ${quotedIdentifier(`${prefix}_annotation`)}
      WHERE document_id = ?
        AND family IN (${familyPlaceholders})
      ORDER BY id`,
  ).all(row.id, ...protectingFamilyNames) as Array<{ id: string; family: string; owner_id: string | null }>;

  if (protectorRows.length === 0) {
    if (!family && readAnnotatedTextFamilyCheckpoint(db, prefix, row.id) === undefined) {
      fail(`field '${fieldName}' state is missing`);
    }
    return { fullyVisible: true, restricted: false, redactions: [] };
  }

  let resolvedFamily = family;
  if (!resolvedFamily) {
    const familyCheckpoint = readAnnotatedTextFamilyCheckpoint(db, prefix, row.id);
    if (familyCheckpoint === undefined) fail(`field '${fieldName}' state is missing`);
    resolvedFamily = restoreTextFamilySerialized(familyCheckpoint);
  }
  const textLength = textFamilyVisibleLength(resolvedFamily);

  const protectorIds = protectorRows.map((entry) => entry.id);
  const protectorPlaceholders = protectorIds.map(() => '?').join(', ');

  // Load protected-target edges only for this document's protecting annotations.
  const edgeRows = db.prepare(
    `SELECT annotation_id, target_annotation_id
       FROM ${quotedIdentifier(`${prefix}_annotation_protected_target`)}
      WHERE annotation_id IN (${protectorPlaceholders})
      ORDER BY annotation_id, target_annotation_id`,
  ).all(...protectorIds) as Array<{ annotation_id: string; target_annotation_id: string }>;

  const targetsByProtector = new Map<string, string[]>();
  const allTargetIds = new Set<string>();
  for (const edge of edgeRows) {
    let list = targetsByProtector.get(edge.annotation_id);
    if (!list) {
      list = [];
      targetsByProtector.set(edge.annotation_id, list);
    }
    list.push(edge.target_annotation_id);
    allTargetIds.add(edge.target_annotation_id);
  }

  // Verify every named protected target exists on this document.
  if (allTargetIds.size > 0) {
    const targetIdList = [...allTargetIds];
    const targetPlaceholders = targetIdList.map(() => '?').join(', ');
    const existingTargets = db.prepare(
      `SELECT id FROM ${quotedIdentifier(`${prefix}_annotation`)} WHERE document_id = ? AND id IN (${targetPlaceholders})`,
    ).all(row.id, ...targetIdList) as Array<{ id: string }>;
    const existingSet = new Set(existingTargets.map((entry) => entry.id));
    for (const [protectorId, targets] of targetsByProtector) {
      for (const targetId of targets) {
        if (!existingSet.has(targetId)) {
          fail(`protector '${protectorId}' names an unknown protected target '${targetId}'`);
        }
      }
    }
  }

  // Load orphan status only for protectors and their targets.
  const relevantIds = [...new Set([...protectorIds, ...allTargetIds])];
  const relevantPlaceholders = relevantIds.map(() => '?').join(', ');
  const orphanRows = db.prepare(
    `SELECT annotation_id FROM ${quotedIdentifier(`${prefix}_annotation_orphan_state`)} WHERE annotation_id IN (${relevantPlaceholders})`,
  ).all(...relevantIds) as Array<{ annotation_id: string }>;
  const orphanIds = new Set(orphanRows.map((entry) => entry.annotation_id));

  // Load & project memberships ONLY for protectors and their targets.
  const membershipRows = db.prepare(
    `SELECT m.annotation_id, m.ordinal, r.start_point, r.end_point
       FROM ${quotedIdentifier(`${prefix}_membership`)} AS m
       JOIN ${quotedIdentifier(`${prefix}_range`)} AS r ON r.id = m.range_id
      WHERE m.document_id = ?
        AND m.annotation_id IN (${relevantPlaceholders})
      ORDER BY m.annotation_id, m.ordinal`,
  ).all(row.id, ...relevantIds) as Array<{ annotation_id: string; ordinal: number; start_point: string; end_point: string }>;

  const protectorIdSet = new Set(protectorIds);
  const rangesByAnnotation = new Map<string, Array<{ start: number; end: number }>>();
  const frontierByShape = new Map<string, StructuralEndpoint['basisFrontier']>();
  let lastAnnotationId: string | null = null;
  let expectedOrdinal = 0;

  for (const membership of membershipRows) {
    if (membership.annotation_id !== lastAnnotationId) {
      lastAnnotationId = membership.annotation_id;
      expectedOrdinal = 0;
    }
    if (membership.ordinal !== expectedOrdinal) {
      fail(`annotation '${membership.annotation_id}' membership ordinals are not contiguous`);
    }
    expectedOrdinal += 1;
    const startPoint = parseStoredEndpoint(membership.start_point, frontierByShape);
    const endPoint = parseStoredEndpoint(membership.end_point, frontierByShape);
    const projected = projectRangeToOffsets(resolvedFamily, startPoint, endPoint, textLength);
    if (!projected) {
      if (protectorIdSet.has(membership.annotation_id)) {
        fail(`field '${fieldName}' protector '${membership.annotation_id}' has an unprojectable range`);
      }
      if (allTargetIds.has(membership.annotation_id)) {
        fail(`protected target '${membership.annotation_id}' has an unprojectable membership`);
      }
      continue;
    }
    if (orphanIds.has(membership.annotation_id)) continue;
    let list = rangesByAnnotation.get(membership.annotation_id);
    if (!list) {
      list = [];
      rangesByAnnotation.set(membership.annotation_id, list);
    }
    list.push(projected);
  }

  // Load declared fields only for protecting families that actually have rows.
  const declarationsByFamily = new Map<string, Array<[string, any]>>();
  for (const declared of descriptor.annotations) {
    if (Object.hasOwn(meta.protectingFamilies, declared.annotationName)) {
      declarationsByFamily.set(declared.annotationName, Object.entries(declared.fields ?? {}));
    }
  }
  const presentFamilies = new Set(protectorRows.map((entry) => entry.family));
  const storedFieldsByFamily = new Map<string, Map<string, Record<string, unknown>>>();
  for (const familyName of presentFamilies) {
    const fieldEntries = declarationsByFamily.get(familyName) ?? [];
    if (fieldEntries.length === 0) continue;
    const rows = db.prepare(
      `SELECT child.*
         FROM ${quotedIdentifier(`${prefix}_annotation_${familyName}`)} AS child
        WHERE child.annotation_id IN (${protectorPlaceholders})`,
    ).all(...protectorIds) as Array<Record<string, unknown>>;
    const byId = new Map<string, Record<string, unknown>>();
    for (const stored of rows) byId.set(String(stored.annotation_id), stored);
    storedFieldsByFamily.set(familyName, byId);
  }

  // Determine active protectors and evaluate access for each. Activation uses
  // the one shared policy; wholeDocument is also needed below to decide whether
  // a denied protector restricts the whole document.
  const deniedIntervals: Array<{ start: number; end: number }> = [];
  for (const protector of protectorRows) {
    if (orphanIds.has(protector.id)) continue;
    const targets = targetsByProtector.get(protector.id);
    if (!targets || targets.length === 0) continue;
    const ownRanges = rangesByAnnotation.get(protector.id) ?? [];
    if (!isProtectorActive({
      protectedTargetIds: targets,
      ownRanges,
      knownTargetIds: allTargetIds,
      rangesForTarget: (targetId) => rangesByAnnotation.get(targetId),
      textLength,
      onUnknownTarget: (targetId) => fail(`protector '${protector.id}' names an unknown protected target '${targetId}'`),
    })) continue;
    const wholeDocument = coversWholeDocument(ownRanges, textLength);

    const fieldEntries = declarationsByFamily.get(protector.family) ?? [];
    const fields: Record<string, unknown> = {};
    if (fieldEntries.length > 0) {
      const stored = storedFieldsByFamily.get(protector.family)?.get(protector.id);
      for (const [name, field] of fieldEntries) {
        fields[name] = deserializeField(field, stored?.[name]);
      }
    }
    const annotation: AnnotatedTextRecipientAnnotation = {
      id: protector.id,
      family: protector.family,
      fields,
      ...(protector.owner_id != null ? { owner: protector.owner_id } : {}),
      protectedTargetIds: targets,
    };
    const access = meta.protectingFamilies[protector.family].access;
    const decision = await protectingAnnotationCapabilities(entity, row, annotation, access, principal);
    if (!decision.capabilities.includes(read)) {
      if (wholeDocument) {
        return { fullyVisible: false, restricted: true, redactions: [] };
      }
      for (const range of ownRanges) {
        deniedIntervals.push({ start: range.start, end: range.end });
      }
    }
  }

  if (deniedIntervals.length === 0) {
    return { fullyVisible: true, restricted: false, redactions: [] };
  }

  const merged = sortAndMergeIntervals(deniedIntervals);
  const redactions: AuthoringRedaction[] = canonicalToWireIntervals(merged)
    .map((interval) => Object.freeze({
      visibleStart: interval.visibleStart,
      start: interval.start,
      end: interval.end,
    }));
  return { fullyVisible: false, restricted: false, redactions };
}

function loadRecipientProjectionSource({ db, prefix, descriptor, documentId, family, text, fieldName, meta, profile }: {
  db: any;
  prefix: string;
  descriptor: any;
  documentId: string;
  family: ContinuousTextFamily;
  text: string;
  fieldName: string;
  meta: any;
  profile?: SnapshotProfile;
}): { sourceFor: (anchored: boolean) => AnnotatedTextRecipientSource; activeProtectors: AnnotatedTextRecipientAnnotation[] } {
  const declarations = descriptor.annotations.map((declared: any, declarationIndex: number) => ({
    declared,
    alias: `family_${declarationIndex}`,
    fields: Object.entries(declared.fields),
  }));
  const joins: string[] = [];
  const selected = ['annotation.id', 'annotation.family', 'annotation.owner_id'];
  const layouts = new Map<string, Array<{ index: number; name: string; field: any }>>();
  for (const declaration of declarations) {
    const layout: Array<{ index: number; name: string; field: any }> = [];
    if (declaration.fields.length > 0) {
      joins.push(`LEFT JOIN ${quotedIdentifier(`${prefix}_annotation_${declaration.declared.annotationName}`)} AS ${declaration.alias} ON ${declaration.alias}.annotation_id = annotation.id`);
      for (const [name, field] of declaration.fields) {
        layout.push({ index: selected.length, name, field });
        selected.push(`${declaration.alias}.${quotedIdentifier(name)}`);
      }
    }
    layouts.set(declaration.declared.annotationName, layout);
  }

  let started = performance.now();
  const annotationQuery = `
    SELECT ${selected.join(', ')}
      FROM ${quotedIdentifier(`${prefix}_annotation`)} AS annotation
      ${joins.join('\n')}
     WHERE annotation.document_id = ?
     ORDER BY annotation.id`;

  started = performance.now();
  const edgeRows = readArrayRows(db, `
    SELECT edge.annotation_id, edge.target_annotation_id
      FROM ${quotedIdentifier(`${prefix}_annotation_protected_target`)} AS edge
      JOIN ${quotedIdentifier(`${prefix}_annotation`)} AS annotation ON annotation.id = edge.annotation_id
     WHERE annotation.document_id = ?
     ORDER BY edge.annotation_id, edge.target_annotation_id`, documentId);
  profile?.('protected-edge SQL and row load', performance.now() - started, { rows: edgeRows.length });
  const targetsByAnnotation = new Map<string, string[]>();
  for (const edge of edgeRows) {
    if (edge.length !== 2 || typeof edge[0] !== 'string' || typeof edge[1] !== 'string') fail('stored protector edge is malformed');
    const targets = targetsByAnnotation.get(edge[0]);
    if (targets) targets.push(edge[1]);
    else targetsByAnnotation.set(edge[0], [edge[1]]);
  }

  started = performance.now();
  const annotations: AnnotatedTextRecipientAnnotation[] = [];
  const annotationById = new Map<string, AnnotatedTextRecipientAnnotation>();
  for (const stored of iterateArrayRows(db, annotationQuery, documentId)) {
    const [id, annotationFamily, owner] = stored;
    if (typeof id !== 'string' || typeof annotationFamily !== 'string' || (owner !== null && typeof owner !== 'string')) fail('stored annotation row is malformed');
    const layout = layouts.get(annotationFamily);
    if (!layout) fail(`annotation '${id}' has unknown family`);
    const fields: Record<string, any> = {};
    for (const entry of layout) fields[entry.name] = deserializeField(entry.field, stored[entry.index]);
    const targets = targetsByAnnotation.get(id);
    const annotation = targets
      ? { id, family: annotationFamily, fields, owner: owner ?? undefined, protectedTargetIds: targets }
      : { id, family: annotationFamily, fields, owner: owner ?? undefined };
    if (annotation.owner === undefined) delete annotation.owner;
    annotations.push(annotation);
    annotationById.set(id, annotation);
  }
  profile?.('annotation SQL, row load, and decode', performance.now() - started, { rows: annotations.length });

  started = performance.now();
  const rangeQuery = `
    SELECT id, start_point, end_point
      FROM ${quotedIdentifier(`${prefix}_range`)}
     WHERE document_id = ?
     ORDER BY id`;
  const projectedByRangeId = new Map<number, { projected: { start: number; end: number } | null; startPoint: StructuralEndpoint; endPoint: StructuralEndpoint }>();
  const frontierByShape = new Map<string, StructuralEndpoint['basisFrontier']>();
  for (const stored of iterateArrayRows(db, rangeQuery, documentId)) {
    if (stored.length !== 3 || !Number.isSafeInteger(stored[0]) || typeof stored[1] !== 'string' || typeof stored[2] !== 'string') fail('stored range row is malformed');
    const startPoint = parseStoredEndpoint(stored[1], frontierByShape);
    const endPoint = parseStoredEndpoint(stored[2], frontierByShape);
    projectedByRangeId.set(stored[0], {
      projected: projectRangeToOffsets(family, startPoint, endPoint, text.length),
      startPoint,
      endPoint,
    });
  }
  profile?.('range SQL, endpoint parse, and unique projection', performance.now() - started, { ranges: projectedByRangeId.size });

  started = performance.now();
  const orphanRows = db.prepare(
    `SELECT a.id, a.family, a.owner_id, o.saved_quote, o.last_range
       FROM ${prefix}_annotation AS a
       JOIN ${prefix}_annotation_orphan_state AS o ON o.annotation_id = a.id
      WHERE a.document_id = ?
      ORDER BY a.id`,
  ).all(documentId);
  const orphans = orphanRows.map((stored: any) => {
    const annotation = annotationById.get(stored.id);
    if (!annotation) fail(`orphan '${stored.id}' annotation is missing`);
    let savedRange;
    try { savedRange = JSON.parse(stored.last_range ?? 'null'); } catch { fail(`orphan '${stored.id}' has malformed last range`); }
    if (savedRange === null) savedRange = [0, 0];
    if (!Array.isArray(savedRange) || savedRange.length !== 2 || !Number.isSafeInteger(savedRange[0]) || !Number.isSafeInteger(savedRange[1]) || savedRange[0] < 0 || savedRange[1] < savedRange[0]) fail(`orphan '${stored.id}' has malformed last range`);
    return { id: annotation.id, family: annotation.family, fields: annotation.fields, ...(annotation.owner === undefined ? {} : { owner: annotation.owner }), savedQuote: stored.saved_quote, savedRange };
  });
  const orphanIds = new Set(orphans.map((orphan: any) => orphan.id));
  const measurements = db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE document_id = ? ORDER BY id`).all(documentId)
    .map((measurement: any) => ({ id: measurement.id, family: measurement.family, formatVersion: measurement.format_version, payload: JSON.parse(measurement.payload) }));
  profile?.('orphan and measurement load', performance.now() - started, { orphans: orphans.length, measurements: measurements.length });

  started = performance.now();
  const droppedAnnotationIds = new Set<string>();
  const loadedRanges: AnnotatedTextRecipientRange[] = [];
  let lastAnnotationId: string | null = null;
  let expectedOrdinal = 0;
  let membershipCount = 0;
  for (const membership of iterateArrayRows(db, `
    SELECT annotation_id, ordinal, range_id
      FROM ${quotedIdentifier(`${prefix}_membership`)}
     WHERE document_id = ?
     ORDER BY annotation_id, ordinal`, documentId)) {
    const [annotationId, ordinal, rangeId] = membership;
    if (membership.length !== 3 || typeof annotationId !== 'string' || !Number.isSafeInteger(ordinal) || ordinal < 0 || !Number.isSafeInteger(rangeId)) fail('stored membership row is malformed');
    // Rows arrive grouped by annotation (ORDER BY annotation_id, ordinal);
    // contiguous ordinals start at 0 for every annotation.
    if (annotationId !== lastAnnotationId) {
      lastAnnotationId = annotationId;
      expectedOrdinal = 0;
    }
    if (ordinal !== expectedOrdinal) fail(`annotation '${annotationId}' membership ordinals are not contiguous`);
    expectedOrdinal += 1;
    const annotation = annotationById.get(annotationId);
    const stored = projectedByRangeId.get(rangeId);
    if (!annotation || !stored) fail('stored membership references missing state');
    if (!stored.projected) {
      if (Object.hasOwn(meta.protectingFamilies, annotation.family)) fail(`field '${fieldName}' protector '${annotation.id}' has an unprojectable range`);
      droppedAnnotationIds.add(annotation.id);
      continue;
    }
    loadedRanges.push({
      annotationId,
      start: stored.projected.start,
      end: stored.projected.end,
      anchoredStart: stored.startPoint,
      anchoredEnd: stored.endPoint,
    });
    membershipCount += 1;
  }
  profile?.('membership SQL, row load, and source fusion', performance.now() - started, { memberships: membershipCount });
  const protectedTargetIds = new Set(annotations.flatMap((annotation) => annotation.protectedTargetIds ?? []));
  for (const annotationId of droppedAnnotationIds) {
    if (protectedTargetIds.has(annotationId)) fail(`protected target '${annotationId}' has an unprojectable membership`);
  }
  const sourceAnnotations = annotations.filter((annotation) => !droppedAnnotationIds.has(annotation.id) && !orphanIds.has(annotation.id));
  const sourceAnnotationIds = new Set(sourceAnnotations.map((annotation) => annotation.id));
  const sourceRanges = droppedAnnotationIds.size === 0 && orphanIds.size === 0
    ? loadedRanges
    : loadedRanges.filter((range) => sourceAnnotationIds.has(range.annotationId));
  let cachedAnchoredSource: AnnotatedTextRecipientSource | undefined;
  let cachedOffsetSource: AnnotatedTextRecipientSource | undefined;
  const sourceFor = (anchored: boolean): AnnotatedTextRecipientSource => {
    if (anchored) {
      cachedAnchoredSource ??= createAnnotatedTextRecipientSource({
        version: 1,
        text,
        rangeFormat: 'anchored',
        annotations: sourceAnnotations,
        ranges: sourceRanges,
        measurements,
        orphans,
      });
      return cachedAnchoredSource;
    }
    cachedOffsetSource ??= createAnnotatedTextRecipientSource({
      version: 1,
      text,
      rangeFormat: 'offset',
      annotations: sourceAnnotations,
      ranges: sourceRanges,
      measurements,
      orphans,
    });
    return cachedOffsetSource;
  };

  const relevantIds = new Set<string>();
  const protectorAnnotations: AnnotatedTextRecipientAnnotation[] = [];
  for (const annotation of sourceAnnotations) {
    if (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !annotation.protectedTargetIds?.length) continue;
    protectorAnnotations.push(annotation);
    relevantIds.add(annotation.id);
    for (const targetId of annotation.protectedTargetIds) relevantIds.add(targetId);
  }
  const relevantRanges = new Map<string, AnnotatedTextRecipientRange[]>();
  for (const range of sourceRanges) {
    if (!relevantIds.has(range.annotationId)) continue;
    const own = relevantRanges.get(range.annotationId);
    if (own) own.push(range);
    else relevantRanges.set(range.annotationId, [range]);
  }
  const knownProtectorTargetIds = new Set(annotationById.keys());
  const activeProtectors = protectorAnnotations.filter((annotation) => isProtectorActive({
    protectedTargetIds: annotation.protectedTargetIds,
    ownRanges: relevantRanges.get(annotation.id) ?? [],
    knownTargetIds: knownProtectorTargetIds,
    rangesForTarget: (targetId) => relevantRanges.get(targetId),
    textLength: text.length,
    onUnknownTarget: (targetId) => fail(`protector '${annotation.id}' names an unknown protected target '${targetId}'`),
  }));
  return { sourceFor, activeProtectors };
}

// Reads only Workbench-owned annotated-text relations and projects them before
// an HTTP snapshot is serialized. Any malformed state or access failure throws;
// callers deny the entire snapshot rather than falling back to canonical facts.
async function projectAnnotatedText({ db, entity, row, principal, fieldName, descriptor, caret = null, presence = null, mintBasis = true, authoring = null, profile }: {
  db: any;
  entity: any;
  row: any;
  principal: any;
  fieldName: string;
  descriptor: any;
  caret?: any;
  presence?: any;
  mintBasis?: boolean;
  authoring?: any;
  profile?: SnapshotProfile;
}): Promise<any> {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!meta) fail(`field '${fieldName}' is not compiled`);
  const prefix = `${entity.name}_${fieldName}`;
  if (db.prepare(`SELECT 1 FROM ${prefix}_retired WHERE document_id = ?`).get(row.id)) fail(`field '${fieldName}' document is retired`);
  let started = performance.now();
  const stateRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(row.id) as
    | { structure_version?: unknown; family_checkpoint?: unknown }
    | undefined
    | null;
  profile?.('family checkpoint SQL read', performance.now() - started, { rows: stateRow ? 1 : 0 });
  if (!stateRow || typeof stateRow.family_checkpoint !== 'string') fail(`field '${fieldName}' state is missing`);

  const structureVersion = Number(stateRow.structure_version ?? 0);
  const familyCheckpoint = stateRow.family_checkpoint;
  const dataVersion = readDataVersion(db);

  let cached = getCachedSnapshot(db, prefix, row.id, structureVersion, familyCheckpoint, dataVersion, descriptor);
  if (!cached) {
    started = performance.now();
    const family = restoreTextFamilySerialized(familyCheckpoint);
    profile?.('checkpoint JSON parse and family restore', performance.now() - started);
    started = performance.now();
    const text = materializeText(family);
    profile?.('full text materialization', performance.now() - started);

    const { sourceFor, activeProtectors } = loadRecipientProjectionSource({
      db, prefix, descriptor, documentId: row.id, family, text, fieldName, meta, profile,
    });
    const cacheState = cacheStateForDb(db);
    const annotationMutationVersion = cacheState?.mutationVersions.get(docCacheKey(prefix, row.id)) ?? 0;
    cached = {
      structureVersion,
      familyCheckpoint,
      annotationMutationVersion,
      dataVersion,
      descriptor,
      family,
      text,
      sourceFor,
      activeProtectors,
      fullyVisibleRecipients: new Map(),
    };
    putCachedSnapshot(db, prefix, row.id, cached);
  } else {
    profile?.('shared snapshot cache hit', 0);
  }

  const { family, text, sourceFor, activeProtectors } = cached;

  started = performance.now();
  const protectors: any[] = [];
  for (const annotation of activeProtectors) {
    const access = meta.protectingFamilies[annotation.family].access;
    const decision = await protectingAnnotationCapabilities(entity, row, annotation, access, principal);
    protectors.push({ protectorId: annotation.id, outcome: decision.capabilities.includes(read) ? 'allow' : 'deny' });
  }
  // Recipient-specific capability hints derive from the CURRENT field write
  // grant — the same `authorizeFieldOp` authority the annotated-text mutation
  // admission runs — never from snapshot readability, subscription admission,
  // or the presence of a live authoring session. The canonical document keeps
  // empty hints; only the recipient decisions carry the granted names.
  const canWrite = principal == null ? false : await mayFieldOp(entity, fieldName, write, row, principal);
  profile?.('protector and field authorization await', performance.now() - started, { protectors: activeProtectors.length });
  const allProtectorsAllowed = protectors.every((protector) => protector.outcome === 'allow');
  const capabilityHints = canWrite ? Object.keys(meta.capabilityHandles ?? {}) : [];
  const decisions = {
    version: 1,
    protectors,
    capabilityHints,
  };

  const hintsKey = canWrite ? 'w' : 'r';
  let recipient = caret === null && allProtectorsAllowed
    ? cached.fullyVisibleRecipients.get(hintsKey)
    : undefined;
  if (recipient) {
    profile?.('recipient transform cache hit', 0);
  } else {
    const source = sourceFor(allProtectorsAllowed);
    started = performance.now();
    recipient = caret === null
      ? projectAnnotatedTextRecipient({ source, descriptor, decisions })
      : projectAnnotatedTextCaretForRecipient({
        kind: 'workbench.annotatedText.canonical', version: 1,
        text,
        annotations: [...source.annotations],
        ranges: source.ranges.map(({ annotationId, start, end }) => ({ annotationId, start, end })),
        measurements: [...source.measurements],
        orphans: [...source.orphans],
        capabilityHints: [],
      }, descriptor, decisions, caret, presence);
    profile?.('recipient transform and freezing', performance.now() - started);
    if (caret === null && allProtectorsAllowed) {
      cached.fullyVisibleRecipients.set(hintsKey, recipient);
    }
  }
  if (caret !== null || !mintBasis) return recipient;

  const cursor = authoring?.fence ?? readProjectedCursorFence(db, entity.name, fieldName) ?? 0;
  if (!authoring) return recipient;

  const { streamToken, leaseToken } = authoring;
  const stream = resolveStream({ db, prefix, streamToken, documentId: row.id, principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '' });
  if (!stream) fail('authoring stream is unavailable');
  const lease = resolveLease({ db, prefix, leaseToken, streamId: stream.id });
  if (!lease) fail('authoring lease is unavailable');

  // One DOCUMENT-scoped position frame binds the whole family checkpoint basis.
  const issued = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: cursor,
    positions: [{
      familyCheckpoint: textFamilyBasis(family),
      visibleAtIssue: true,
      redactions: authoringRedactionsForRecipient(recipient),
    }],
  });
  if (!issued) fail('authoring stream capacity exceeded');
  const envelope = buildAuthoringEnvelope({
    streamToken: stream.id,
    leaseToken: lease.id,
    snapshotToken: issued.snapshot.id,
    fence: cursor,
    positionFrames: issued.positionFrames,
  });
  // The recipient seeds its fold reducer from this family checkpoint. The
  // checkpoint is the full canonical text (including tombstones), so it is only
  // safe when the recipient sees the ENTIRE document unredacted. Restricted or
  // inline-redacted recipients get no family: they stay on snapshot recovery.
  const fullyVisible = !recipient.restricted && !recipient.redactions?.length && authoringRedactionsForRecipient(recipient).length === 0;
  if (fullyVisible) (envelope as any).family = compactTextFamilyCheckpoint(family);
  return Object.freeze({ ...recipient, authoring: Object.freeze(envelope) });
}

/** Owning-scope-admin-authorized package canonical export. Never projects through a recipient view. */
export async function exportAnnotatedText({ app, entity, field, documentId, expectedOwningScope, principal }: any): Promise<any> {
  const db = app?.db;
  if (!db || !app?.entities || !entity || !field || typeof documentId !== 'string' || !documentId) {
    fail('export requires app, entity, field, and documentId');
  }
  if (!expectedOwningScope || typeof expectedOwningScope !== 'object' ||
      typeof expectedOwningScope.entity?.name !== 'string' ||
      typeof expectedOwningScope.id !== 'string' || !expectedOwningScope.id) {
    fail('export requires an expectedOwningScope with a declared entity and non-empty id');
  }
  const registeredEntity = app.entities.get(entity.name);
  if (!registeredEntity) fail('export entity is not registered with the application');
  entity = registeredEntity;
  const fieldName = field.fieldName;
  const descriptor = entity.fields?.[fieldName];
  if (!descriptor || descriptor.kind !== 'annotatedText') fail('export field is not annotatedText');
  for (let attempt = 0; attempt < RECIPIENT_READ_ATTEMPTS; attempt += 1) {
    const row = rawRow(db, entity.name, documentId);
    if (!row) fail('document is missing');
    const owningScope = resolveAnnotatedTextOwningScope(descriptor, entity.fields, row);
    if (owningScope.entity !== expectedOwningScope.entity.name || owningScope.id !== expectedOwningScope.id) {
      fail('expected owning scope does not match document');
    }
    // Authorization and the canonical read must be ONE consistent view. Capture
    // the owning-scope cursor before authorizing and verify it is unchanged
    // after the read; a commit landing in between retries the whole attempt.
    const owningScopeCursorBefore = readSeq(db, owningScope.key);
    let attemptResult;
    try {
      const scopeEntity = app.entities.get(owningScope.entity);
      if (!scopeEntity) fail('declared owning scope entity is not registered with the application');
      const scopeRow = rawRow(db, scopeEntity.name, owningScope.id);
      if (!scopeRow || !await mayRow(scopeEntity, 'admin', scopeRow, principal)) {
        fail('owning scope admin authorization failed');
      }
      attemptResult = projectCanonicalExport({ db, entity, fieldName, descriptor, documentId });
    } catch (error) {
      if (unchangedCursor(db, owningScope.key, owningScopeCursorBefore)) throw error;
      continue;
    }
    if (unchangedCursor(db, owningScope.key, owningScopeCursorBefore)) return attemptResult;
  }
  fail('export could not obtain a consistent document view');
}

function projectCanonicalExport({ db, entity, fieldName, descriptor, documentId }: { db: any; entity: any; fieldName: string; descriptor: any; documentId: string }): any {
  const prefix = `${entity.name}_${fieldName}`;
  if (db.prepare(`SELECT 1 FROM ${prefix}_retired WHERE document_id = ?`).get(documentId)) fail('document is retired');
  const familyCheckpoint = readAnnotatedTextFamilyCheckpoint(db, prefix, documentId);
  if (familyCheckpoint === undefined) fail('document state is missing');
  const family = restoreTextFamilySerialized(familyCheckpoint);
  const text = materializeText(family);
  const annotations = loadAnnotations({ db, prefix, descriptor, documentId });
  const rangeRows = annotationRangeRows(db, prefix, documentId);
  const ranges: any[] = [];
  const projectedByRangeId = new Map<number, { start: number; end: number } | null>();
  for (const rangeRow of rangeRows) {
    let projected = projectedByRangeId.get(rangeRow.range_id);
    if (projected === undefined) {
      projected = projectRangeToOffsets(
        family,
        parseStoredEndpoint(rangeRow.start_point),
        parseStoredEndpoint(rangeRow.end_point),
        text.length,
      );
      projectedByRangeId.set(rangeRow.range_id, projected);
    }
    if (!projected) continue;
    ranges.push({ annotationId: rangeRow.annotation_id, start: projected.start, end: projected.end });
  }
  const orphanRows = db.prepare(
    `SELECT a.id, a.family, a.owner_id, o.saved_quote, o.last_range
       FROM ${prefix}_annotation AS a
       JOIN ${prefix}_annotation_orphan_state AS o ON o.annotation_id = a.id
      WHERE a.document_id = ? ORDER BY a.id`,
  ).all(documentId);
  const orphans = orphanRows.map((o: any) => {
    const declared = descriptor.annotations.find((entry: any) => entry.annotationName === o.family);
    if (!declared) fail(`orphan '${o.id}' has unknown family`);
    let savedRange;
    try { savedRange = JSON.parse(o.last_range ?? 'null'); } catch { fail(`orphan '${o.id}' has malformed last range`); }
    if (savedRange === null) savedRange = [0, 0];
    if (!Array.isArray(savedRange) || savedRange.length !== 2 || !Number.isSafeInteger(savedRange[0]) || !Number.isSafeInteger(savedRange[1]) || savedRange[0] < 0 || savedRange[1] < savedRange[0]) fail(`orphan '${o.id}' has malformed last range`);
    const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${o.family} WHERE annotation_id = ?`).get(o.id) ?? {};
    return { id: o.id, family: o.family, fields: Object.fromEntries(Object.entries(declared.fields).map(([name, desc]) => [name, deserializeField(desc as any, stored[name])])), owner: o.owner_id, savedQuote: o.saved_quote, savedRange };
  });
  const result = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text,
    annotations,
    ranges,
    orphans,
    measurements: db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE document_id = ? ORDER BY id`).all(documentId)
      .map((measurement: any) => ({ id: measurement.id, family: measurement.family, formatVersion: measurement.format_version, payload: JSON.parse(measurement.payload) })),
    capabilityHints: [],
  };
  return deepFreeze(result);
}

/**
 * Public recipient snapshot read. The expected scope binds the caller's intent,
 * while current row grants on both the document and its resolved owner decide
 * authority. Deliberately returns one opaque result for every ordinary denial.
 */
export async function readAnnotatedTextForRecipient(input: any): Promise<any> {
  requireRecipientReadInput(input);
  const { app, field, documentId, expectedOwningScope, principal } = input;
  const db = app.db;
  const entity = app.entities.get(input.entity.name);
  if (!entity || input.entity !== entity.declaration) {
    throw new TypeError('readAnnotatedTextForRecipient entity must be the application-registered declaration');
  }
  const descriptor = entity.fields?.[field.fieldName];
  const metadata = getAnnotatedTextCompiledMetadata(descriptor);
  if (!descriptor || descriptor.kind !== 'annotatedText' ||
      field.annotations !== metadata?.annotationHandles ||
      field.measurements !== metadata?.measurementHandles ||
      field.capabilities !== metadata?.capabilityHandles) {
    throw new TypeError('readAnnotatedTextForRecipient field must be the registered annotatedText handle');
  }
  const expectedScopeEntity = app.entities.get(expectedOwningScope.entity.name);
  if (!expectedScopeEntity || expectedOwningScope.entity !== expectedScopeEntity.declaration) {
    throw new TypeError('readAnnotatedTextForRecipient expectedOwningScope entity must be the application-registered declaration');
  }

  for (let attempt = 0; attempt < RECIPIENT_READ_ATTEMPTS; attempt += 1) {
    let capturedOwningScopeKey: string | null = null;
    let capturedOwningScopeCursor: number | null = null;
    try {
      const row = rawRow(db, entity.name, documentId);
      if (!row) {
        const before = readSeq(db, scopeOf(expectedOwningScope.entity.name, expectedOwningScope.id).key);
        if (unchangedCursor(db, scopeOf(expectedOwningScope.entity.name, expectedOwningScope.id).key, before)) return recipientUnavailable;
        continue;
      }
      let owningScope;
      try {
        owningScope = resolveAnnotatedTextOwningScope(descriptor, entity.fields, row);
      } catch {
        const before = readSeq(db, scopeOf(expectedOwningScope.entity.name, expectedOwningScope.id).key);
        if (unchangedCursor(db, scopeOf(expectedOwningScope.entity.name, expectedOwningScope.id).key, before)) return recipientUnavailable;
        continue;
      }
      if (owningScope.entity !== expectedOwningScope.entity.name || owningScope.id !== expectedOwningScope.id) {
        const before = readSeq(db, owningScope.key);
        if (unchangedCursor(db, owningScope.key, before)) return recipientUnavailable;
        continue;
      }
      const scopeEntity = app.entities.get(owningScope.entity);
      if (!scopeEntity) {
        const before = readSeq(db, owningScope.key);
        if (unchangedCursor(db, owningScope.key, before)) return recipientUnavailable;
        continue;
      }
      const scopeRow = rawRow(db, scopeEntity.name, owningScope.id);
      if (!scopeRow) {
        const before = readSeq(db, owningScope.key);
        if (unchangedCursor(db, owningScope.key, before)) return recipientUnavailable;
        continue;
      }

      const owningScopeCursorBefore = readSeq(db, owningScope.key);
      capturedOwningScopeKey = owningScope.key;
      capturedOwningScopeCursor = owningScopeCursorBefore;
      const mayReadScope = await mayRow(scopeEntity, 'read', scopeRow, principal);
      const mayReadDocument = await mayRow(entity, 'read', row, principal);
      if (!mayReadScope || !mayReadDocument) {
        if (unchangedCursor(db, owningScope.key, owningScopeCursorBefore)) return recipientUnavailable;
        continue;
      }
      let document;
      try {
        document = await projectAnnotatedText({
          db, entity, row, principal, fieldName: field.fieldName, descriptor, mintBasis: false,
        });
      } catch (error) {
        if (!unchangedCursor(db, owningScope.key, owningScopeCursorBefore)) continue;
        if (db.prepare(`SELECT 1 FROM ${entity.name}_${field.fieldName}_retired WHERE document_id = ?`).get(documentId)) return recipientUnavailable;
        throw error;
      }
      const owningScopeCursorAfter = readSeq(db, owningScope.key);
      if (owningScopeCursorBefore !== owningScopeCursorAfter) continue;
      return deepFreeze({ kind: 'snapshot', document, owningScopeCursor: owningScopeCursorAfter });
    } catch {
      if (capturedOwningScopeKey !== null && capturedOwningScopeCursor !== null &&
          !unchangedCursor(db, capturedOwningScopeKey, capturedOwningScopeCursor)) continue;
      throw sanitizedRecipientReadFailure();
    }
  }
  return recipientRetry;
}

export async function projectAnnotatedTextSnapshot(input: any): Promise<any> {
  return projectAnnotatedText(input);
}

export async function projectAnnotatedTextCaretSnapshot(input: any): Promise<any> {
  return projectAnnotatedText(input);
}
