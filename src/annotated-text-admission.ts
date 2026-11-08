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
import type { Principal } from './principal.ts';

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

/** Return false (or reject) to refuse the whole commit. A thrown error is
 *  propagated unchanged; a false return becomes a typed admission refusal with
 *  no receipt or projected row. */
export type AnnotatedTextAdmission = (
  change: AnnotatedTextMutationChange,
) => boolean | void | Promise<boolean | void>;

export interface AnnotatedTextAdmissionDeclaration {
  /** Annotation families this application cares about. Other families are
   *  never loaded. Absent means every declared family. */
  readonly families?: readonly string[];
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
): Map<string, AnnotatedField[]> {  const byEntity = new Map<string, AnnotatedField[]>();
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

function loadImages(db: DbHandle, target: { field: AnnotatedField; documentId: string }): Map<string, Readonly<AnnotationImage>> {
  const images = loadAnnotationImages(db, {
    prefix: target.field.prefix,
    documentId: target.documentId,
    declarations: target.field.declarations,
    families: target.field.declarations.map((declaration) => declaration.annotationName),
    deserializeFields: true,
  });
  return new Map(images.map((image) => [image.id, Object.freeze(image as AnnotationImage)]));
}

function sameImage(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function refusal(): never {
  throw new ValidationError('annotated-text mutation refused by application admission', {
    code: 'annotated-text-admission-refused',
  });
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
            images: loadImages(db, target),
          }));
        }
      }
      return pending.length === 0 ? null : Object.freeze(pending);
    },
    async after({ db, state, actionId, actionType, principal }: Parameters<AnnotatedTextMutationAdmission['after']>[0]) {
      if (!state) return;
      for (const target of state) {
        const after = loadImages(db, target);
        const ids = new Set([...target.images.keys(), ...after.keys()]);
        for (const annotationId of ids) {
          const beforeImage = target.images.get(annotationId) ?? null;
          const afterImage = after.get(annotationId) ?? null;
          if (sameImage(beforeImage, afterImage)) continue;
          const admitted = await registration.admit(Object.freeze({
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
          if (admitted === false) refusal();
        }
      }
    },
  });
}
