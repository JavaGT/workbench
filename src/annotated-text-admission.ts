// Application-owned commit admission for annotated-text mutations.
//
// The framework's durable admission decides whether a principal may touch a
// document. This module is the narrower seam a domain uses when it must inspect
// the ANNOTATION DELTA itself: which annotation ids were created, removed, or
// changed, and their old/new stored images. The callback runs inside the same
// SQLite transaction as the commit, after projection has materialized the new
// annotations and before the receipt exists, so a refusal rolls back the log,
// projection, and receipt together.
//
// Coverage is structural rather than a list of action names:
//   - every native event on an annotated-text field (operation, declared
//     annotation action, composed operation, history compensation/redo/replay)
//   - create/remove lifecycle events on the owning entity (initial annotation
//     capture and document retirement)
// A field whose annotation families the application did not register is never
// snapshotted.

import { ValidationError } from './field-strategy.ts';
import { loadAnnotationImages } from './annotated-text-storage.ts';
import { canonicalStringify } from './canonical-json.ts';
import { readAnnotatedTextFamilyCheckpoint } from './annotated-text-authoring-stream.ts';
import {
  materializeText,
  projectEndpointToOffset,
  restoreTextFamilySerialized,
  type ContinuousTextFamily,
} from './annotated-text-continuous.ts';
import type { StructuralEndpoint } from './annotated-text-family.ts';
import type { Principal } from './principal.ts';
import { isWorkbenchFailure, type FailureOutcome, type WorkbenchFailure } from './outcome.ts';

interface Statement {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): any;
  all(...args: unknown[]): any[];
}

interface DbHandle {
  prepare(sql: string): Statement;
  exec(sql: string): unknown;
}

interface CompiledAnnotationDeclaration {
  readonly annotationName: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly empty?: string;
  readonly cardinality?: string;
}

interface AnnotatedField {
  readonly entity: string;
  readonly field: string;
  readonly prefix: string;
  readonly declarations: readonly CompiledAnnotationDeclaration[];
}

/** Exact UTF-16 wording of one projected active membership range. `text` is the
 *  visible slice covered by the range, in membership-ordinal order.
 *  Offsets are a snapshot and do not participate in change detection. */
export interface AnnotationWording {
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface AnnotationImage {
  readonly id: string;
  readonly family: string;
  readonly fields: Record<string, unknown>;
  readonly protectedTargetIds: readonly string[];
  readonly memberships: readonly unknown[];
  readonly prerequisites: readonly unknown[];
  readonly empty?: 'delete' | 'orphan';
  readonly cardinality?: 'many' | 'one';
  readonly orphan?: { readonly savedQuote: string; readonly lastRange: readonly [number, number] | null } | null;
  /** Present only when the registration opts in with `includeWording: true`.
   *  Stored orphan state stays in `orphan`, never folded into this wording. */
  readonly wording?: readonly AnnotationWording[];
}

interface AdmittedEvent {
  handle?: { kind?: string; entity?: string; field?: string };
  data?: unknown;
  scope?: unknown;
}

/** One annotation whose stored image changed in this commit. `before` is null
 *  for a create and `after` is null for a removal. */
export interface AnnotatedTextMutationChange {
  readonly entity: string;
  readonly field: string;
  readonly documentId: string;
  /** Owning document scope (for a project-owned document, `Project:<id>`). */
  readonly scope: string;
  readonly actionId: string;
  /** Committing action type (`Transcript.annotatedText.operation`, ...). */
  readonly actionType: string;
  readonly principal: Principal | null | undefined;
  readonly family: string;
  readonly annotationId: string;
  readonly before: Readonly<AnnotationImage> | null;
  readonly after: Readonly<AnnotationImage> | null;
}

/** What an admission callback may return. `false` keeps the original refusal
 *  shorthand; a `WorkbenchFailure` (or a `{ ok: false, failure }` outcome) is a
 *  typed refusal whose category and message reach the caller instead of being
 *  sanitized into a generic internal failure. `void`/`undefined`/`true` admit. */
export type AnnotatedTextAdmissionResult =
  | boolean
  | void
  | WorkbenchFailure
  | FailureOutcome;

/**
 * Return false, a typed failure, or reject to refuse the whole commit. A thrown
 * `WorkbenchFailure` (or an error carrying one) is recognized and propagated
 * unchanged; a plain `Error` keeps the legacy sanitized-internal path. A typed
 * refusal leaves no log row, projected row, or receipt.
 */
export type AnnotatedTextAdmission = (
  change: AnnotatedTextMutationChange,
) => AnnotatedTextAdmissionResult | Promise<AnnotatedTextAdmissionResult>;

export interface AnnotatedTextAdmissionDeclaration {
  /** Annotation families this application cares about. Other families are
   *  never loaded. Absent means every declared family. */
  readonly families?: readonly string[];
  /** Off by default: keep the before/after images structural-only. Opt in to
   *  also capture each annotation's projected active-range wording, so interior
   *  text edits that leave structural memberships unchanged still reach `admit`. */
  readonly includeWording?: boolean;
  readonly admit: AnnotatedTextAdmission;
}

export interface PendingTarget {
  readonly field: AnnotatedField;
  readonly documentId: string;
  readonly scope: string;
  readonly images: ReadonlyMap<string, Readonly<AnnotationImage>>;
}

export interface AnnotatedTextMutationAdmission {
  before(context: {
    db: DbHandle;
    events: readonly AdmittedEvent[];
    actionId: string;
    actionType: unknown;
    scope: unknown;
    principal: unknown;
    payload: unknown;
    now: string;
  }): readonly PendingTarget[] | null;
  after(context: {
    db: DbHandle;
    events: readonly AdmittedEvent[];
    state: readonly PendingTarget[] | null;
    actionId: string;
    actionType: unknown;
    scope: unknown;
    principal: unknown;
    payload: unknown;
    now: string;
  }): Promise<void>;
}

function annotationDeclarations(field: { annotations?: readonly unknown[] }): CompiledAnnotationDeclaration[] {
  return (field.annotations ?? [])
    .map((entry) => entry as CompiledAnnotationDeclaration)
    .filter((entry) => typeof entry?.annotationName === 'string' && entry.fields !== undefined);
}

function indexAnnotatedFields(
  entities: ReadonlyMap<string, any>,
  families: ReadonlySet<string> | null,
): Map<string, AnnotatedField[]> {
  const byEntity = new Map<string, AnnotatedField[]>();
  for (const entity of entities.values()) {
    if (!entity || typeof entity.name !== 'string' || !entity.fields) continue;
    const fields: AnnotatedField[] = [];
    for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
      if ((descriptor as { kind?: unknown })?.kind !== 'annotatedText') continue;
      const declarations = annotationDeclarations(descriptor as { annotations?: readonly unknown[] })
        .filter((entry) => families === null || families.has(entry.annotationName));
      if (declarations.length === 0) continue;
      fields.push({
        entity: entity.name,
        field: fieldName,
        prefix: `${entity.name}_${fieldName}`,
        declarations,
      });
    }
    if (fields.length > 0) byEntity.set(entity.name, fields);
  }
  return byEntity;
}

function documentIdOf(event: AdmittedEvent): string | null {
  const data = event.data as { id?: unknown; documentId?: unknown } | null | undefined;
  const candidate = data?.id ?? data?.documentId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * Project a membership's structural endpoints against the materialized family
 * and return the exact visible UTF-16 slice. Unprojectable (stale-basis / lost
 * anchor) and out-of-bounds ranges are not active and are omitted.
 */
function projectWording(
  family: ContinuousTextFamily,
  text: string,
  memberships: readonly { ordinal: number; start: unknown; end: unknown }[],
): readonly AnnotationWording[] {
  const wording: AnnotationWording[] = [];
  for (const membership of [...memberships].sort((left, right) => left.ordinal - right.ordinal)) {
    let start: number;
    let end: number;
    try {
      start = projectEndpointToOffset(family, membership.start as StructuralEndpoint);
      end = projectEndpointToOffset(family, membership.end as StructuralEndpoint);
    } catch {
      continue; // not an active range
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) continue;
    wording.push(Object.freeze({ ordinal: membership.ordinal, start, end, text: text.slice(start, end) }));
  }
  return Object.freeze(wording);
}

/**
 * Materialize the document checkpoint at the moment this pass runs and attach
 * exact UTF-16 wording to each captured image. A missing checkpoint (pre-create
 * or post-retirement state) simply leaves images without wording — those images
 * are null on the opposite side of the comparison anyway.
 */
function loadImages(
  db: DbHandle,
  target: { field: AnnotatedField; documentId: string },
  includeWording: boolean,
): Map<string, Readonly<AnnotationImage>> {
  const images = loadAnnotationImages(db, {
    prefix: target.field.prefix,
    documentId: target.documentId,
    declarations: target.field.declarations,
    families: target.field.declarations.map((declaration) => declaration.annotationName),
    deserializeFields: true,
  });
  let textSource: { family: ContinuousTextFamily; text: string } | undefined;
  if (includeWording && images.length > 0) {
    const checkpoint = readAnnotatedTextFamilyCheckpoint(db, target.field.prefix, target.documentId);
    if (checkpoint !== undefined) {
      const family = restoreTextFamilySerialized(checkpoint);
      textSource = { family, text: materializeText(family) };
    }
  }
  return new Map(images.map((image) => {
    const frozen: AnnotationImage = textSource
      ? { ...(image as AnnotationImage), wording: projectWording(textSource.family, textSource.text, image.memberships) }
      : { ...(image as AnnotationImage) };
    return [image.id, Object.freeze(frozen)];
  }));
}

/** Absolute offset shifts do not change the annotation or its wording. */
function sameImage(left: AnnotationImage | null, right: AnnotationImage | null): boolean {
  const comparable = (image: AnnotationImage | null) => {
    if (!image?.wording) return image;
    return { ...image, wording: image.wording.map(({ ordinal, text }) => ({ ordinal, text })) };
  };
  return canonicalStringify(comparable(left)) === canonicalStringify(comparable(right));
}

function refusal(): never {
  throw new ValidationError('annotated-text mutation refused by application admission', {
    code: 'annotated-text-admission-refused',
  });
}

/**
 * Recognize a typed refusal whether it arrives as a callback RESULT or as a
 * THROWN value. An error that carries a canonical `failure` (for example
 * `forbidden()`) is normalized to that failure; anything else is left alone so
 * a plain Error keeps the sanitized-internal path at the HTTP boundary.
 */
function typedAdmissionFailure(value: unknown): WorkbenchFailure | null {
  if (isWorkbenchFailure(value)) return value;
  const candidate = (value as { failure?: unknown } | null | undefined)?.failure;
  return isWorkbenchFailure(candidate) ? candidate : null;
}

/**
 * Every authored action type that can reach the admission hook for this
 * application: generated annotated operations/compensations, declared
 * annotation actions, and registered actions that declare an annotated-text
 * composition. This is the census a test freezes; a new generated annotated
 * action appears here without a matching expectation and fails review.
 * Create/remove lifecycle events also reach the hook but are generated by the
 * ordinary entity lifecycle, not listed as annotated action types.
 */
export function annotatedTextActionCensus({
  entities,
  actions = [],
}: {
  entities: ReadonlyMap<string, any>;
  actions?: readonly { type?: unknown; operations?: readonly unknown[] }[];
}): readonly string[] {
  const actionTypes = new Set<string>();
  for (const entity of entities.values()) {
    if (!entity || typeof entity.name !== 'string' || !entity.fields) continue;
    const annotatedFields: string[] = [];
    for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
      if ((descriptor as { kind?: unknown })?.kind === 'annotatedText') annotatedFields.push(fieldName);
    }
    for (const actionType of Object.keys(entity.crudHandlers ?? {})) {
      if (annotatedFields.some((fieldName) => actionType.startsWith(`${entity.name}.${fieldName}.`))) {
        actionTypes.add(actionType);
      }
    }
  }
  for (const action of actions) {
    if (typeof action.type === 'string' && Array.isArray(action.operations) && action.operations.length > 0) {
      actionTypes.add(action.type);
    }
  }
  return Object.freeze([...actionTypes].sort());
}

/**
 * Compile the declaration into the two in-transaction passes the pipeline
 * calls. Returns null when the application registered no admission, so the
 * default commit path stays byte-identical.
 */
export function createAnnotatedTextMutationAdmission({
  entities,
  registration,
}: {
  entities: ReadonlyMap<string, any>;
  registration: AnnotatedTextAdmissionDeclaration | undefined;
}): AnnotatedTextMutationAdmission | null {
  if (!registration) return null;
  if (typeof registration.admit !== 'function') {
    throw new Error('annotatedTextAdmission.admit must be a function');
  }
  if (registration.includeWording !== undefined && typeof registration.includeWording !== 'boolean') {
    throw new Error('annotatedTextAdmission.includeWording must be a boolean');
  }
  const includeWording = registration.includeWording === true;
  const families = registration.families === undefined
    ? null
    : new Set(registration.families.map((family) => {
      if (typeof family !== 'string' || family.length === 0) {
        throw new Error('annotatedTextAdmission.families must be non-empty annotation family names');
      }
      return family;
    }));
  const byEntity = indexAnnotatedFields(entities, families);

  function targetsForEvent(event: AdmittedEvent): Array<{ field: AnnotatedField; documentId: string }> {
    const handle = event?.handle;
    if (!handle || typeof handle.entity !== 'string') return [];
    const fields = byEntity.get(handle.entity);
    if (!fields || fields.length === 0) return [];
    if (handle.kind === 'native') {
      const field = fields.find((candidate) => candidate.field === handle.field);
      const documentId = documentIdOf(event);
      return field && documentId ? [{ field, documentId }] : [];
    }
    // A create can carry initial annotation rows; a remove cascades them away.
    // An ordinary update changes only row columns and cannot alter annotations.
    if (handle.kind !== 'created' && handle.kind !== 'removed') return [];
    const documentId = documentIdOf(event);
    return documentId ? fields.map((field) => ({ field, documentId })) : [];
  }

  return Object.freeze({
    before({ db, events }: Parameters<AnnotatedTextMutationAdmission['before']>[0]) {
      const pending: PendingTarget[] = [];
      const seen = new Set<string>();
      for (const event of events) {
        const scope = typeof event.scope === 'string' ? event.scope : '';
        for (const target of targetsForEvent(event)) {
          const key = `${target.field.entity}\u0000${target.field.field}\u0000${target.documentId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pending.push(Object.freeze({
            field: target.field,
            documentId: target.documentId,
            scope,
            images: loadImages(db, target, includeWording),
          }));
        }
      }
      return pending.length === 0 ? null : Object.freeze(pending);
    },
    async after({ db, state, actionId, actionType, principal }: Parameters<AnnotatedTextMutationAdmission['after']>[0]) {
      if (!state) return;
      for (const target of state) {
        const after = loadImages(db, target, includeWording);
        const ids = new Set([...target.images.keys(), ...after.keys()]);
        for (const annotationId of ids) {
          const beforeImage = target.images.get(annotationId) ?? null;
          const afterImage = after.get(annotationId) ?? null;
          if (sameImage(beforeImage, afterImage)) continue;
          let result: AnnotatedTextAdmissionResult;
          try {
            result = await registration.admit(Object.freeze({
              entity: target.field.entity,
              field: target.field.field,
              documentId: target.documentId,
              scope: target.scope,
              actionId,
              actionType: typeof actionType === 'string' ? actionType : '',
              principal: principal as Principal | null | undefined,
              family: (afterImage ?? beforeImage)?.family ?? '',
              annotationId,
              before: beforeImage,
              after: afterImage,
            }));
          } catch (error) {
            // A thrown typed failure is client-visible by intent; a plain Error
            // propagates unchanged and is sanitized to 'internal' downstream.
            throw typedAdmissionFailure(error) ?? error;
          }
          if (result === false) refusal();
          const typedFailure = typedAdmissionFailure(result);
          if (typedFailure !== null) throw typedFailure;
        }
      }
    },
  });
}
