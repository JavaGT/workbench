// Recipient snapshots replace annotated-text storage with the package-owned
// projection before a transport can serialize it. The row itself runs through
// the field-read admission projection (S5/A3) FIRST, so a principal receives
// exactly the readable field subset; annotated-text fields that survive field
// admission are then projected through the annotated-text recipient grammar.
import { projectRowForRecipient } from './entity/projection.mjs';
import { readableFieldNames } from './field-admission.mjs';
import { fieldKindContribution, hasFieldKindFeature } from './strategy/index.mjs';













export function hasAnnotatedTextFields(entity                      )          {
  return hasFieldKindFeature(entity.fields         , 'snapshotField');
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
