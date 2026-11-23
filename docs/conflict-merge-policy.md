# Conflict / merge policy (M1, #188)

Global rule: **last-writer-wins is rejected as a framework-wide policy.** Each
field kind declares its concurrent/offline outcome below. LWW appears only as a
named per-kind fact (whole-value replace), never as the default. See #180.

## Declared per-kind outcomes

| Kind | Concurrent writes | Basis |
|---|---|---|
| `value` (text/number/boolean/date/json/ref/blob...) | Whole-value replace (last commit wins), silent | `STRATEGIES.value`, `src/field-delta.ts` |
| `annotatedText` | Merge / coexist; stale-region edit rejected as validation, not merged | Frontier/pending causal reducer; region limits |
| `crdt` text | Merge (commutative), native ops only | `commutativeMerge: true`; whole-value diff throws |
| `crdt` raster / polyline | Replace stub (merge deferred, non-prod warn) | `reportReplaceStubDelta`; must graduate to merge, not to silent LWW |
| `hash` | Replace (write-only digest compare) | `STRATEGIES.hash` |
| `store` / `map` | Merge across members; per-member last-commit; idempotent re-set is client no-op | Side-table rows + probe; `{added, removed, changed}` delta |
| `log` | Coexist (append-only, minted entry ids; no write-write conflict) | `src/strategy/log.ts` |
| `ordered` / `list` | Coexist for distinct ids (fractional keys, no renumber); same-element `move` contention = last committed key wins (no OT) | `keyBetween`; native events only (DECISIONLOG #74) |
| `struct` | Per-sub-cell replace; different cells coexist | Flattened `<field>__<cell>` columns |
| `state` | Replace + conflict-error on illegal move (validation, not merge) | Transition guard in CRUD handler |
| `computed` / `projected` / `ephemeral` | Not client-writable | Payload presence → `ValidationError`; no persistence seam |

## Optimistic concurrency

Opt-in, live/no-history tier only: `expectedRevision` vs `_LiveRevision`,
mismatch → 409 `conflict` (`src/live-revision.ts`). History tier has no
per-field OCC. Queued live actions carry the revision captured when they were
created; a stale resend fails closed with 409 `conflict` and its optimistic
placeholder is rolled back. The history tier does not add per-field OCC.

## Offline resend rule (#183, current)

- Same `actionId` resend: safe — pipeline dedupes the whole `(scope, actionId)`
  against receipts before field logic (`src/pipeline.ts` dedupe checks).
- Fresh `actionId` resend: a NEW mutation re-entering the table above.
  The outbox must never mint fresh actionIds for retries.

The current outbox behavior is covered by [local-outbox.test.mjs](../test/local-outbox.test.mjs):
value replacement, map merge, ordered coexistence, stale live revision rejection,
and the separation between CRUD outbox entries and native CRDT text operations.

## CRUD handler authority (current)

`src/entity/compile.ts` and `src/entity/crud.ts` are the single CRUD
implementation. The former opt-in `codegen-crud` generator was retired in #283
because a working second path is still a second path (see AGENTS.md,
"Prefer a singular system"). annotatedText CRUD lives in
`src/annotated-text-crud.ts` behind `entity/crud.ts`.
