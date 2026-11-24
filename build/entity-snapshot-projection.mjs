// Recipient snapshots replace annotated-text storage with the package-owned
// projection before a transport can serialize it. The row itself runs through
// the field-read admission projection (S5/A3) FIRST, so a principal receives
// exactly the readable field subset; annotated-text fields that survive field
// admission are then projected through the annotated-text recipient grammar.
import { projectRowForRecipient } from './entity/projection.mjs';
import { readableFieldNames } from './field-admission.mjs';
import { fieldKindContribution, fieldKindSnapshotControlReason, hasFieldKindFeature } from './strategy/index.mjs';
// Arms the field-kind registry when this projection module is loaded on its own.
import './annotated-text-field.mjs';













/** True when any declared field kind owns a recipient-snapshot projection. */
export function hasSnapshotProjectedFields(entity                      )          {
  return hasFieldKindFeature(entity.fields         , 'snapshotField');
}

/** Legacy name retained for callers that still ask about annotated text specifically. */
export const hasAnnotatedTextFields = hasSnapshotProjectedFields;

/** The delivery reason declared by the kind that needs a fresh snapshot. */
export function snapshotControlReasonFor(entity                      )                {
  return fieldKindSnapshotControlReason(entity.fields         );
}










export async function projectEntitySnapshot({ db, entity, row, principal, authoring = null, authorization = null }                        )                                   {
  const materialized = entity.deserializeRow({ ...row });
  const readable = await readableFieldNames(entity         , materialized, principal, authorization);
  const snapshot = await projectRowForRecipient(entity         , materialized, principal, { readable, authorization });
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    const contribution = fieldKindContribution(descriptor.kind);
    if (contribution?.snapshotField && readable.has(fieldName)) {
      snapshot[fieldName] = await contribution.snapshotField({ db, entity: entity         , row, principal, fieldName, descriptor: descriptor         , authoring });
    }
  }
  return snapshot;
}
