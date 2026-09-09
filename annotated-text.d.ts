// Optional annotated-text subpath entry.
//
// TYPE AUTHORITY: the blockless continuous annotated-text model. See
//   src/annotated-text-continuous.ts           one RGA text stream per document,
//                                              absolute UTF-16 offsets, annotations
//                                              as character ranges resolved to
//                                              structural endpoints (issue #33)
//   src/annotated-text-recipient-projection.ts canonical -> recipient projection
// The canonical document is {kind:'workbench.annotatedText.canonical', version:1,
// text, annotations, ranges, measurements, capabilityHints, orphans?}; the
// recipient projection is {kind:'workbench.annotatedText.recipient', version:3
// (fully-visible, anchored ranges) or version:1 (redacted/restricted, offset
// ranges), text, ranges, annotations, measurements, capabilityHints}. The block-era
// shapes and family shims below are marked `@deprecated`.

export {
  annotatedText,
  annotation,
  protectingAnnotation,
  measurement,
  annotationAction,
  annotationEntityAction,
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
  annotatedTextAction,
  annotatedTextAnnotationAction,
  annotatedTextCreateAction,
  annotatedTextRetireAction,
  exportAnnotatedText,
  readAnnotatedTextForRecipient,
} from './index.js';

export type {
  AnnotatedTextOptions,
  AnnotatedTextAnnotationDescriptor,
  AnnotatedTextProtectingAnnotationDescriptor,
  AnnotatedTextMeasurementDescriptor,
  AnnotatedTextActionDescriptor,
  AnnotatedTextAnnotationEntityActionDescriptor,
  AnnotatedTextAnnotationEntityActionHandle,
  AnnotatedTextCompiledActionHandle,
  AnnotatedTextActionHandles,
  AnnotatedTextAnnotationActionValues,
  AnnotatedTextAnnotationHandle,
  AnnotatedTextMeasurementHandle,
  AnnotatedTextCapabilityHandle,
  AnnotatedTextFieldHandle,
  AnnotatedTextMeasurementValidationInput,
  AnnotatedTextMeasurementEditInput,
  AnnotatedTextMeasurementEditResult,
  AnnotatedTextMeasurementPartitionInput,
  AnnotatedTextMeasurementPartitionResult,
  AnnotatedTextMeasurementCombineSide,
  AnnotatedTextMeasurementCombineInput,
  AnnotatedTextMeasurementCombineResult,
  AnnotatedTextStructuralExtensionSpec,
  AnnotatedTextAuthoringBinding,
  AnnotatedTextOperationCommand,
  AnnotatedTextOperationEdit,
  AnnotatedTextOperationPayload,
  AnnotatedTextActionAnnotation,
  AnnotatedTextActionRequest,
  AnnotatedTextCanonicalDocument,
  AnnotatedTextDocumentRange,
  AnnotatedTextRecipientRange,
  AnnotatedTextStructuralEndpoint,
  AnnotatedTextOrphan,
  AnnotatedTextMeasurement,
  AnnotatedTextRecipientRedaction,
  AnnotatedTextRecipientDocument,
  AnnotatedTextExpectedOwningScope,
  AnnotatedTextRecipientReadResult,
  AnnotatedTextCreateInput,
  AnnotatedTextCreateSourceMeasurement,
  AnnotatedTextRegionRelativeRange,
  AnnotatedTextRegionEditTransition,
  AnnotatedTextRegionEditDescriptor,
  AnnotatedTextRegionBuildInput,
  AnnotatedTextOperationRegion,
  AnnotatedTextOperationHandle,
} from './index.js';

export { parseRegionEditDescriptor, isRegionEditDescriptor, annotatedTextOperation } from './index.js';
