# Annotated Text Sequence Kernel

Status: accepted

## Decision

`text.crdt()` will use a run-compressed RGA sequence with immutable scalar
identities, causal frontiers, observed-remove tombstones, and deterministic
child ordering. T1 fixes the durable grammar and executable validation laws;
T2 alone implements causal buffering, reduction, checkpointing, and delivery.

## Grammar

- An actor ID is exactly 32 lowercase hexadecimal characters. An operation ID is
  `[actor, positiveCounter]`; a replica emits contiguous counters and never
  reuses an identity.
- A frontier is sorted `[[actor, positiveCounter], ...]`, with one entry per
  actor. An operation's dependencies contain its own actor at `counter - 1`.
- Operations are closed, versioned arrays:

```text
["workbench.text", 1, opId, lamport, frontier, body]
body = ["insert", anchor, nonEmptyWellFormedText]
     | ["delete", sortedNonOverlappingObservedDeleteSpans]
anchor = ["root"] | ["element", [insertOpId, scalarOrdinal]]
```

- Text is well-formed Unicode without normalization. Public positions are
  UTF-16 offsets; only a boundary between the halves of a surrogate pair is
  invalid. Internally, each inserted Unicode scalar has an immutable element ID
  `[insertOpId, scalarOrdinal]`. `scalarOrdinal` counts Unicode scalars, not
  UTF-16 units, and is strictly less than the inserted text's scalar count.
- `['root']` is the immutable RGA `HEAD` and inserts at visible offset zero.
  An `['element', elementId]` anchor means immediately after that real scalar;
  it is never a run-boundary gap. Admission verifies that the referenced scalar
  exists in the operation's observed causal state. The final visible scalar is
  the canonical end anchor; a fully deleted or empty document uses `['root']`.
- An insert run links its first scalar to its anchor and each later scalar to
  the preceding scalar in that same run. Children, including `HEAD` children,
  render by descending Lamport then descending operation ID. A tombstoned scalar
  emits no text but remains anchorable and its children still render.
- A delete names exact observed element IDs, compressed as sorted, minimally
  merged spans. It never names a persistent numeric range.
- RGA children render in descending Lamport order, then descending operation ID.
  Arrival order and server sequence do not participate.
- A structural point is an immutable after-anchor plus `left` or `right`
  affinity. At its known frontier both affinities resolve to the same visible
  UTF-16 boundary; later insertions at that boundary transform a left-affine
  point before and a right-affine point after those runs. *(The T4 split/merge
  plan this fed is superseded — issue #33 removed the block layer; structural
  endpoints now project directly against the whole-document RGA, see
  `src/annotated-text-continuous.ts`.)*

## Anchor Semantics

- `["root"]` is the virtual HEAD anchor. Inserts at the root anchor appear at the
  visible start of the document, before any real elements.
- `["element", [insertOpId, scalarOrdinal]]` anchors immediately after one real
  Unicode scalar. The `ordinal` must satisfy
  `0 ≤ ordinal < scalarCount(insertedText)`. It is never a gap or end-of-document
  position.

## Insert Run Reduction

Within a single insert operation's text:
- Scalar 0 (the first Unicode scalar) is a child of the operation's anchor.
- Scalar `i` (for `i > 0`) is a child of scalar `i - 1` from the same insert.
- Children of any node are ordered by descending Lamport timestamp, then
  descending operation ID.

## Deleted Scalars

A deleted scalar emits no visible text but remains in the element tree. It is
still anchorable (can be referenced as a parent anchor by other operations) and
its children still traverse through it.

## End Anchor

The end anchor is the last visible (non-deleted) scalar in the document. When
the document is fully deleted or empty (no visible elements, offset 0), the end
anchor is the root anchor.

## T2 Requirements

T2 must reject malformed or equivocal duplicate IDs; buffer causally unready
operations; retain observed-remove deletion tags and anchor tombstones; produce
canonical checkpoints; and prove convergence across every causality-respecting
delivery order. It must replace the existing prefix/suffix pseudo-delta rather
than run beside it.

## Consequences

The grammar module is dependency-free and shared verbatim with the browser
client. It has no field, persistence, live, history, or declaration wiring in
T1. Tests validate the grammar itself, not static field-law flags.

Field operation **wire versions** (public v9 offset edits vs internal durable
`operated`) are separate from this RGA grammar — the operated-event gate admits
only `operated` v14 (live authoring) and v16 (region edits); retired v13/v15 and
the v1–v11 lattice fail closed and are never replayed (issue #315). See
[`../annotated-text-public-v9-operated-lattice.md`](../annotated-text-public-v9-operated-lattice.md).
