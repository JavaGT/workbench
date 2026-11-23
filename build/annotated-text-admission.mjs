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

import { ValidationError } from './field-strategy.mjs';
import { loadAnnotationImages } from './annotated-text-storage.mjs';
import { canonicalStringify } from './canonical-json.mjs';
import { readAnnotatedTextFamilyCheckpoint } from './annotated-text-authoring-stream.mjs';
import {
  materializeText,
  projectEndpointToOffset,
  restoreTextFamilySerialized,

} from './annotated-text-continuous.mjs';




























/** Exact UTF-16 wording of one projected active membership range. `text` is the
 *  visible slice covered by the range, in membership-ordinal order.
 *  Offsets are a snapshot and do not participate in change detection. */




























/** One annotation whose stored image changed in this commit. `before` is null
 *  for a create and `after` is null for a removal. */
















/** Return false (or reject) to refuse the whole commit. A thrown error is
 *  propagated unchanged; a false return becomes a typed admission refusal with
 *  no receipt or projected row. */














































function annotationDeclarations(field                                      )                                  {
  return (field.annotations ?? [])
    .map((entry) => entry                                 )
    .filter((entry) => typeof entry?.annotationName === 'string' && entry.fields !== undefined);
}

function indexAnnotatedFields(
  entities                          ,
  families                            ,
)                                {
  const byEntity = new Map                          ();
  for (const entity of entities.values()) {
    if (!entity || typeof entity.name !== 'string' || !entity.fields) continue;
    const fields                   = [];
    for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
      if ((descriptor                      )?.kind !== 'annotatedText') continue;
      const declarations = annotationDeclarations(descriptor                                        )
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

function documentIdOf(event               )                {
  const data = event.data                                                             ;
  const candidate = data?.id ?? data?.documentId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * Project a membership's structural endpoints against the materialized family
 * and return the exact visible UTF-16 slice. Unprojectable (stale-basis / lost
 * anchor) and out-of-bounds ranges are not active and are omitted.
 */
function projectWording(
  family                      ,
  text        ,
  memberships                                                              ,
)                               {
  const wording                      = [];
  for (const membership of [...memberships].sort((left, right) => left.ordinal - right.ordinal)) {
    let start        ;
    let end        ;
    try {
      start = projectEndpointToOffset(family, membership.start                      );
      end = projectEndpointToOffset(family, membership.end                      );
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
  db          ,
  target                                               ,
  includeWording         ,
)                                         {
  const images = loadAnnotationImages(db, {
    prefix: target.field.prefix,
    documentId: target.documentId,
    declarations: target.field.declarations,
    families: target.field.declarations.map((declaration) => declaration.annotationName),
    deserializeFields: true,
  });
  let textSource                                                            ;
  if (includeWording && images.length > 0) {
    const checkpoint = readAnnotatedTextFamilyCheckpoint(db, target.field.prefix, target.documentId);
    if (checkpoint !== undefined) {
      const family = restoreTextFamilySerialized(checkpoint);
      textSource = { family, text: materializeText(family) };
    }
  }
  return new Map(images.map((image) => {
    const frozen                  = textSource
      ? { ...(image                   ), wording: projectWording(textSource.family, textSource.text, image.memberships) }
      : { ...(image                   ) };
    return [image.id, Object.freeze(frozen)];
  }));
}

/** Absolute offset shifts do not change the annotation or its wording. */
function sameImage(left                        , right                        )          {
  const comparable = (image                        ) => {
    if (!image?.wording) return image;
    return { ...image, wording: image.wording.map(({ ordinal, text }) => ({ ordinal, text })) };
  };
  return canonicalStringify(comparable(left)) === canonicalStringify(comparable(right));
}

function refusal()        {
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
}


 )                    {
  const actionTypes = new Set        ();
  for (const entity of entities.values()) {
    if (!entity || typeof entity.name !== 'string' || !entity.fields) continue;
    const annotatedFields           = [];
    for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
      if ((descriptor                      )?.kind === 'annotatedText') annotatedFields.push(fieldName);
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
}


 )                                        {
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

  function targetsForEvent(event               )                                                       {
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
    before({ db, events }                                                         ) {
      const pending                  = [];
      const seen = new Set        ();
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
    async after({ db, state, actionId, actionType, principal }                                                        ) {
      if (!state) return;
      for (const target of state) {
        const after = loadImages(db, target, includeWording);
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
            principal: principal                                ,
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
