# Query-scoped reads are a Workbench-owned read contract

Status: accepted (#225)

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

A query names one compiled Entity and a **typed filter grammar** over declared
fields. Operators are allowlisted **per field type**, not a global soup:

| Type | Operators |
| --- | --- |
| text | `eq`, `in`, `contains`, `isEmpty`, `isNotEmpty` |
| number, date, epoch | `eq`, `in`, `gt` / `gte` / `lt` / `lte`, `isEmpty`, `isNotEmpty` |
| boolean | `eq`, `isEmpty`, `isNotEmpty` |
| ref, option | `eq`, `in`, `isEmpty`, `isNotEmpty` |

Unknown operators, unknown fields, type-mismatched values, functions, and SQL
fragments fail closed at compile and at execution. Filters AND together. Sort
is **one declared field** plus a unique tie-break of `id ASC` (the existing
`readRows` order). Page size is bounded (1–100) and is part of the query
identity. The page token is a **keyset cursor** `{ queryIdentity, sortValue, id }`
bound to that contract's identity. A cursor from a different contract is
rejected. Page tokens are never authorization.

**Null and empty:** `eq` / range / `in` / `contains` reject `null` at compile.
`isEmpty` / `isNotEmpty` are the empty operators and do not take a value. On a
declared column, empty means SQL NULL (and, for text, `''`). On a dynamic
field (query family), empty means no non-empty element row. Stored NULL sort
keys still traverse (SQLite orders NULLs first in ASC, last in DESC).

Historical pagination (a page at a past revision) is out of scope: SQLite cannot
reconstruct old rows from a revision token. Every page is read at the current
commit revision.

### 2. Revision token

Every response carries `revision`, read from `_CommittedRevision.actions` — the
same counter the commit loop already bumps in the write transaction. Execution
reads the token before and after the SELECT (the existing snapshot fence) and
retries on contention so rows and revision come from one consistent read. A
bigint revision converts to number only when `Number.isSafeInteger` holds;
otherwise the read fails closed.

This token means **"this page was read consistently at revision R"**, not "every
visible panel on the client represents R". Cross-panel atomic consistency is
**not required**: each result carries its own revision, and the client shows a
visible updating state while a panel refetches.

### 3. Invalidation subscriptions and bounded refetch

A client registers a query's **declared dependencies**: entity, filter and sort
fields, **authorization fields harvested from the compiled grant AST** (`scopeAst`)
plus declared `owner` / `projectId` columns, and a **Scope handle** (project)
that notices must match. After commit, a post-commit consumer notices matching
events (create/remove always; update when a dependency *or authorization* field
is touched) and records `max(existing, notice)` — a stale/out-of-order notice
is ignored. Events without a matching `scope` do not signal (no cross-project
timing leak). A row-scoped event (`Note:id`) matches the registered project
only when `event.data[scopeField]` is present and equals the scope id; omitting
that cell does **not** signal. That is a stale client (the page may be wrong
until the next matching notice or resync), not a cross-project leak. An
explicit `scopeField` that is empty or not a declared field fails closed at
registration (`QueryScopedReadError`); it must not skip the scope predicate.

The client-facing seam returns a **signal**, never a row patch:

- `unchanged` — still valid at revision R
- `changed` — membership, order, or aggregate may have moved; **refetch the
  page**
- `resync` — reconnect, unknown-to-this-principal registration, a fetch that
  predates registration (missed-change window), or a gap the in-memory hub
  cannot prove; refetch
- `denied` — this principal's registration is still held but the compiled grant
  now refuses them (revocation)

Registration is authorized through the compiled grant: `scopeFilter` must not
be constant-false, and the principal must currently see at least one row in the
registered scope. Delivery re-checks the grant. Registration ids are namespaced
by principal so an unknown id is not an existence oracle (foreign and missing
both return `resync`). Phase 1 caps in-process registrations at 32 per hub;
excess `register()` fails closed. There is no LRU eviction — a silent drop
would miss invalidations.

Phase 1 notices are in-process. A process restart drops registrations, which is
why reconnect is `resync`. A durable invalidation ledger is not introduced until
reconnect-across-restart has a measured need. Empty-scope subscribe (zero
visible rows at register time) is out of phase 1.

### 4. Authorization

Organisation membership never grants project data. Machine principals act
through capabilities. Query execution applies the entity's compiled
`scopeFilter` (the Grant row-scope half) on every page, including the page
addressed by a cursor. Subscription registration and every `changedSince`
delivery run that same grant: constant-false (`never()`) fails closed;
revocation of an existing registration returns `denied`. A stolen or reused
page token does not admit another principal's rows.

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

`src/query-family.ts` — **registered query families** over a host entity plus a
typed value catalog and element rows (Scope-style dynamic properties). Clients
name a registered family and pass a validated field id + operator + value.
There is no free-form client query program and no raw SQL. Execution reuses
compiled host grants, the revision fence, keyset pagination, and invalidation
signals. Dynamic sort-by-property-value and multi-field dynamic AND/OR in one
request are deferred; phase 2 sorts declared host fields and applies one
dynamic predicate.

## Resolved decisions (owner, 2026-09-13)

1. **Live-list behaviour.** Workbench delivers `changed` signals and bounded
   refetch. Jump-on-edit is a **client-contract** choice: reading lists
   (library, quotes) stay and signal; small active contexts (Studio-style)
   may jump. The server does not encode jump.
2. **Cross-panel consistency.** Per-result consistency with a visible updating
   state. No cross-panel one-revision atomicity.
3. **Query vocabulary.** Typed filter grammar over declared fields, with
   registered query families for dynamic field references (`eq`, `in`, range,
   `contains`, `isEmpty` / `isNotEmpty`). No free-form client query programs.
4. **Acceptance case.** iPhone-class WebKit and Pixel-class Chromium, artefacts
   library browse/filter workflow; Playwright harness plus one real-device
   check before release. (Measurement lives in Scope; this ADR records the
   gate.)
5. **Change delivery.** Bounded refetch. Row-level patches only if later
   measurements justify them.
6. **Registration cap.** 32 per hub, failing closed — confirmed.

## Deferred (not owner-blocking)

- Sorting a page by a dynamic property value (join order + keyset on the
  element column).
- Several dynamic predicates in one family request (AND/OR across properties).
- Empty-scope subscribe (zero visible rows at register time).

## Consequences

- List screens can load a page without a full-project snapshot.
- Scope integration (pin bump, surface migration) is a later phase; this ADR
  does not change Scope.
- Invalidation storms, unindexed dynamic queries, and cache growth remain
  tracked risks; page size, operator set, family registration, and refetch
  stay bounded rather than introducing incremental result maintenance.
