# Query-scoped reads are a Workbench-owned read contract

Status: proposed (#225)

Workbench serves filtered, sorted, paginated Entity pages to light clients
through one typed query contract. Authorization, revision semantics, and
reconciliation stay inside the three loops — compiled grants, the commit
lifecycle, and live delivery. This is not a second machine: not a second write
path, not a second auth engine, and not a second fold.

## Context

Scope list screens currently ingest a full-project snapshot and filter on the
client. Measured cost is 18.6 MiB @50k artefacts / 37.2 MiB @100k, with tens of
MB of client heap. Filtering CPU is not the bottleneck; **how much data the
client receives and retains** is. Owner direction (Scope #3023, Workbench #225):
query-scoped reads become the default list-read path, advancing Workbench rather
than adding a parallel HTTP read API.

Astra's consultation (ticket comment, 2026-09-13) and the step-1 boundary
inspection (same ticket) pin the constraints:

- Runtime ownership (auth, query definitions, revision, reconciliation) is
  Workbench's. Transport may mix HTTP fetch with a live "changed" announcement
  if both implement this contract.
- `readRows` / `readRowsByIds` already apply compiled `scopeFilter` SQL and a
  deterministic `ORDER BY <field>, id ASC` tie-break. Pagination, operators, a
  per-result revision token, and query-scoped invalidation are missing.
- Collection subscriptions (`collection-subscription.ts`) deliver row-level
  patches. Astra's initial comparison prefers **invalidation plus bounded
  refetch**; row patches wait for evidence that refetch is too expensive.
- `_CommittedRevision.actions` is the commit-lifecycle token already fenced
  with composite snapshots. Per-scope `_Cursor` and `_LiveRevision` remain live
  replay positions, not query-page provenance.

## Decision

### 1. Typed query contract

A query names one compiled Entity and a closed operator set over declared
scalar fields:

- equality (`eq`)
- set membership (`in`, 1–100 values)
- range (`gt` / `gte` / `lt` / `lte`)

Unknown operators, unknown fields, functions, and SQL fragments fail closed at
compile. Filters AND together. Sort is **one declared field** plus a unique
tie-break of `id ASC` (the existing `readRows` order). Page size is bounded
(1–100). The page token is a **keyset cursor** `{ queryIdentity, sortValue, id }`
bound to that contract's identity. A cursor from a different contract is
rejected. Page tokens are never authorization.

SQLite NULL ordering is used as-is (NULLs first in ASC, last in DESC). Keyset
predicates are null-safe so a NULL sort value does not stall traversal.

Historical pagination (a page at a past revision) is out of scope: SQLite cannot
reconstruct old rows from a revision token. Every page is read at the current
commit revision.

### 2. Revision token

Every response carries `revision`, read from `_CommittedRevision.actions` — the
same counter the commit loop already bumps in the write transaction. Execution
reads the token before and after the SELECT (the existing snapshot fence) and
retries on contention so rows and revision come from one consistent read.

This token means **"this page was read consistently at revision R"**, not "every
visible panel on the client represents R". Cross-panel atomic consistency is an
open owner question (below).

### 3. Invalidation subscriptions and bounded refetch

A client registers a query's **declared dependencies** (entity + the filter and
sort fields). After commit, a post-commit consumer notices matching events
(create/remove always; update when a dependency field is touched) and records
the new revision.

The client-facing seam returns a **signal**, never a row patch:

- `unchanged` — still valid at revision R
- `changed` — membership, order, or aggregate may have moved; **refetch the
  page**
- `resync` — reconnect, unknown registration, or a gap the in-memory hub cannot
  prove; refetch
- `denied` — the registering principal no longer matches (revocation)

Phase 1 notices are in-process. A process restart drops registrations, which is
why reconnect is `resync`. A durable invalidation ledger is not introduced until
reconnect-across-restart has a measured need.

### 4. Authorization

Organisation membership never grants project data. Machine principals act
through capabilities. Query execution applies the entity's compiled
`scopeFilter` (the Grant row-scope half) on every page, including the page
addressed by a cursor. Delivery of invalidation signals is bound to the
registering principal. A stolen or reused page token does not admit another
principal's rows.

Revocation stops future signals (`denied`) and the next execute returns only
what the current grant allows (often empty). Runtime-held client cache clearing
is the consumer's job; Workbench does not invent a second cache authority.

### 5. Optimistic reconciliation

Mutations still go through the one action pipeline. The client may keep a
**bounded optimistic overlay** on the current page:

- Safe: preview field writes on rows already in the page when the pending
  fields are not filter/sort/membership fields.
- Uncertain: create, remove, or a write that touches a dependency field. The
  overlay does not guess membership or order; it marks the page
  `membershipUncertain` until the echoed commit invalidates and the refetch
  lands.

Optimistic apply stays a visible placeholder. The query page is not a second
fold. An acknowledged write must not disappear under an older page:
`acceptQueryPage` rejects `incoming.revision < held.revision`.

## Module

`src/query-scoped-read.ts` — contract compiler, authorized page execution,
revision fence, invalidation hub, stale-page rejection, bounded optimistic
overlay. It reuses compiled grants and `_CommittedRevision`; it does not add a
write path or a second auth engine.

`entity/query.ts` (`findAll`) remains the in-process ambient finder. Collection
subscriptions remain the row-patch experiment. Neither is this contract.

## Open questions (owner)

These are not silently decided. Phase 1 implements the **signal-and-refetch**
side of each so work can proceed; the UI/product call stays with the owner.

1. **Jump-on-edit versus signal-that-results-changed.** When a visible row's
   sort key or filter field changes, should the list jump immediately, or stay
   still and show that results changed? Phase 1 emits `changed` and leaves
   placement to the client.
2. **Cross-panel atomic consistency.** Must two panels (list + count, or two
   lists) display exactly one shared revision, or is per-page provenance enough
   with an explicit stale/loading state? Phase 1 stamps each page independently.
3. **Dynamic / user-defined fields.** How are they stored and indexed today, and
   which filter/sort combinations are actually used? Phase 1 only accepts
   declared scalar fields on the compiled Entity.
4. **Acceptance device and workflow.** Which phone/browser and which list
   editing workflow is the regression gate? Not a protocol question, but it
   gates later performance work.
5. **When (if ever) to replace refetch with row-level patches.** Collection
   subscriptions exist; adopting them for this contract needs evidence that
   refetch is too expensive under the real subscription fan-out.

## Consequences

- List screens can load a page without a full-project snapshot.
- Scope integration (pin bump, surface migration) is a later phase; this ADR
  does not change Scope.
- Invalidation storms, unindexed dynamic queries, and cache growth remain
  tracked risks; phase 1 bounds page size, operator set, and refetch rather
  than introducing incremental result maintenance.
