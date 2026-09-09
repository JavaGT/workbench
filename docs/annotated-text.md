# Annotated text

This is the product contract for Workbench's `annotatedText` field. It
describes what an application author, editor, and recipient can rely on. The
implementation may evolve, but it must preserve the public behavior and
security rules below.

## What it provides

An annotated-text field is one continuous collaborative document. It combines:

- editable Unicode text;
- overlapping, nested annotations over text ranges;
- optional measurements derived from declared measurement extensions;
- document-scoped history and authoring sessions; and
- recipient-specific visibility, including confidential ranges.

The document is attached to an owning entity and project. Its declaration
supplies the schema, annotation families, measurement families, capabilities,
and related-entity actions. The declaration is compiled with the rest of the
application; it is not a second runtime registry or a browser-only feature.

## Declaring a field

An application declares the document and its families in the normal field
grammar:

```ts
const Transcript = entity('Transcript', {
  project: ref('Project'),
  owner: ref('User'),
  body: annotatedText({
    project: 'project',
    owner: 'owner',
    annotations: [
      annotation('comment'),
      protectingAnnotation('private', {
        protects: 'comment',
        placeholder: '[Restricted]',
        access: ({ principal }) => canReadPrivate(principal),
      }),
    ],
    measurements: [measurement('words')],
  }),
});
```

Annotation and measurement names are declaration-owned identifiers. Applications
do not supply internal operation versions, database IDs, checkpoints, or
author identities in ordinary editing calls. Related-entity annotation actions
are declared actions; Workbench validates their relation, project, author, and
capability at startup and performs the related row and annotation change as one
authorized settlement. See [related-entity annotation authoring](./adr/0007-related-entity-annotation-authoring.md).

## Editing a document

The browser uses a document-bound session created with
`createAnnotatedTextHttpSession`. The session bootstraps an authorized
recipient document, then exposes typed operations:

- `insert({ at, text })` and `delete({ from, to })`;
- `replace({ from, to, text })`;
- `paste({ at, text, annotation })`, which inserts text and one fresh
  annotation as one operation;
- `applyAnnotation` and `removeAnnotation`;
- declared `applyAnnotationAction` and `removeAnnotationEntity` actions; and
- `reconnect`, `subscribe`, and `close` for the session lifecycle.

Positions are absolute UTF-16 offsets in the one continuous text plus a
`left`/`right` affinity. A position at the middle of a surrogate pair is
invalid. An editor may use the public editor binding, but it must submit
through the document session rather than dispatching raw events.

Each accepted edit is authorized against the current document and project,
committed once, and eventually confirmed by authoritative delivery. The
session may show an optimistic pending state, reported by `pendingCount()`;
the delivered fold or snapshot is what settles it. A retry uses the same
operation identity and does not create a second contribution.

## What recipients receive

The recipient document is a versioned, immutable value with this public shape:

```ts
{
  kind: 'workbench.annotatedText.recipient',
  version,
  text,
  ranges,
  annotations,
  measurements,
  orphans,
  capabilities,
  capabilityHints,
  redactions,
}
```

The current model is blockless: `text` is one string and `ranges` use
document-absolute offsets. Annotation records contain only the fields allowed
to that recipient. An emptied annotation may be retained as an `orphan` with
its saved quote when the declaration's orphan policy calls for retention.
Measurement payloads are validated by their declared extension before they are
published.

Recipients must treat `version` and field presence as a schema boundary and
use the package materializer/typed client types rather than guessing a wire
shape. Public snapshot and coordinate helpers are exported from the annotated
text package; internal checkpoints are not application input.

## Confidential ranges

`protectingAnnotation` defines a server-enforced confidentiality boundary.
For each recipient, Workbench re-authorizes the active protecting annotations
and projects the result before delivery:

- an allowed recipient sees the underlying text;
- a denied range has its text removed and receives the declared placeholder
  metadata in `redactions`, at the projected position;
- overlapping denied ranges form one union, so their boundaries and nesting do
  not leak; and
- ordinary annotations may remain visible over the placeholder, but the
  protector's identity and protected-target structure are not exposed.

The denied text, its length, and the denied span's shape never reach an
unauthorized client. A placeholder is a non-editable gap: unauthorized edits
attach to visible neighbors and cannot insert into the hidden content.
Protection is re-evaluated after edits, undo, redo, and recovery. The client
never folds confidential content.

This is fail-closed behavior. Missing, stale, duplicate, foreign, or malformed
protection decisions reject the projection rather than producing a broader
view. The detailed decision is [ADR 0008](./adr/0008-inline-confidential-spans.md).

## Authorization and ownership

Access is checked through Workbench's normal route and row grant engine. The
document's project is the owning scope; organization membership alone does not
grant access. A related-entity annotation action requires both document
authoring permission and the declared related-entity write permission.

Authorization is performed again for retries and live delivery. Revocation
therefore prevents a replay or a new snapshot from becoming an access bypass.
The recipient projection is the confidentiality boundary, not a client-side
filter.

## History and recovery

The session exposes the shared `history` surface for `undo` and `redo` where
the declaration makes an operation eligible. These are durable compensating
actions against the original contribution, not restoration of an old whole
document. They preserve unrelated concurrent work and never reveal protected
text. The general history contract is
[durable-history-contract.md](./durable-history-contract.md).

Initial load, reconnect, cursor gaps, stale authoring positions, and
non-foldable changes recover through an authorized recipient snapshot. During
recovery, incoming delivery is queued and then passed through the same ingest
and fold decision. There is one reconciliation path for optimistic echoes and
foreign events; applications must not add a second local reducer or persistence
path.

Recovery may replace the recipient's current materialized view, but it is not
the meaning of an edit, undo, redo, or conflict resolution. A recovery failure
stays pending/revoked or retries with backoff rather than exposing an
unprojected canonical document.

## Stable public behavior vs internal details

The following are public contract:

- the declaration and typed session operations;
- continuous UTF-16 positions with affinity;
- immutable recipient snapshots and their access-filtered fields;
- server-side protection, placeholder redaction, and fail-closed authorization;
- one authoritative commit/delivery/reconciliation path; and
- snapshot recovery for gaps and changes that cannot be safely folded.

The following are implementation or deployment details, not application API:

- the RGA element identities, causal frontiers, tombstones, and child ordering;
- authoring stream, lease, position, mutation, receipt, and projection tokens;
- the internal durable `operated` event and its admitted version;
- fold envelope versions and the exact resync reason strings; and
- database checkpoints, private provenance, and migration/reset procedures.

The current internal boundary is recorded in
[the operated-version note](./annotated-text-public-v9-operated-lattice.md)
and [ADR 0005](./adr/0005-annotated-text-kernel.md). Those documents are
authoritative for implementation and recovery mechanics; they do not turn
internal versions into a public constructor or payload option.

## Performance and operational expectations

Annotated text is benchmarked as a family of compile, import, snapshot,
serialization, materialization, declaration-action, and composite-resync
workloads. The recorded numbers and machine parameters live in
[performance-results.md](./performance-results.md). They are evidence for
regression gates, not a promise that every workload is constant-time: the
latest composite-resync record explicitly reports initial and forced-fallback
latency/RSS gates that are not all met.

Applications should therefore treat snapshot size and recipient count as
operational inputs, use the session's recovery behavior, and avoid assuming
that an internal fold is always available. A fold is an optimization for an
eligible fully visible recipient; correctness is preserved by projected
snapshot recovery.

## Source and executable checks

The declaration and runtime authority lives under `src/annotated-text-*.ts`
and `src/composite-patch-*.ts`; emitted `build/` files are derived. Focused
behavior is covered by tests including:

- [HTTP session lifecycle](../test/annotated-text-http-session.test.mjs);
- [recipient projection and redaction](../test/annotated-text-recipient-projection.test.mjs);
- [continuous text and ranges](../test/annotated-text-continuous.test.mjs);
- [collaborative history](../test/annotated-text-collaborative-undo.test.mjs); and
- [composite recovery contract](../test/annotated-text-composite-resync-contract.test.mjs).

These tests are executable evidence for this contract. When a public behavior
changes, update this document and the relevant declaration/types/tests in the
same change; do not copy internal wire details into a second product spec.
