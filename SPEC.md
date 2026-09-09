# workbench — Canonical Specification

This is the single source of truth for what workbench is, how it behaves, and
the order in which it gets built. It absorbs the former `FEATURES.md` (the
featureset) and `IMPLEMENTATION-PLAN.md` (the roadmap). It is paired with
documents that keep their own job:

- **`AGENTS.md`** — the binding design values (naming, architecture,
  authorization, data, live/sync, defaults). The SPEC obeys those values; it does
  not restate them. Read AGENTS.md first.
- **`CONTEXT.md`** — the domain glossary (Entity, Grant, Scope handle, Kernel,
  …). Use these nouns; the SPEC does not restate the glossary.
- **`DECISIONLOG.md`** — the append-only ledger of architectural and
  implementation decisions. The SPEC cites entries by number; the ledger holds
  full reasoning. Short numbered ADRs live under `docs/adr/`.

Findings that motivated the design live in **`SCOPE-FINDINGS.md`** (what the
shipped `scope` workbench proves is buildable) and
**`projects/STRESS-TEST-FINDINGS.md`** (the 9-app synthesis, with per-app
evidence under `projects/<name>/PAIN-POINTS.md`).

> **Status: implemented.** The framework is built — zero-dependency (Node 26:
> `node:http`/`crypto`/`sqlite`/`fs`), suite green under `node --test`. The
> binding exemplars (`doc.mjs`, `gdoc.mjs`, `note.mjs`, `comment.mjs`,
> `todo.mjs`, `session.mjs`) are running code. Some sections below still use
> future tense from the original roadmap; prefer running code and DECISIONLOG
> for current shape.

---

## 1. What workbench is

workbench is to *collaborative, persisted, realtime* apps what Express is to
request/response apps: the foundation you reach for so you write domain code, not
plumbing. You declare your entities, their authorization, and their reactions;
the framework owns the REST routes, the WebSocket live stream, the event log, the
reducers, optimistic UI, undo, gap recovery, and cross-tab sync.

The north star — *"Workbench for collaborative, persisted, realtime data"* —
is the same one the shipped `scope` workbench hit in production. scope is the
working proof; workbench is the cleaner second cut, built proactively for a
known set of stress-test apps rather than incrementally as each app stubs its toe
(see `SCOPE-FINDINGS.md`).

The package name is always `workbench`, never `express`. It is a distinct
framework, not a plugin or a fork.

---

## 2. The two floors (and how you override them)

A working entity stands on exactly two declarations — this is the floor, however
short you write it:

1. **Declare the entity** (its fields).
2. **Declare its grant** (who may read, who may edit).

An entity that declares **no grant is a load-time error** (ADR #7). There is no
silent default — not "private to creator," not "world-readable." Fail-closed is
the value; a missing grant is a mistake the framework refuses to guess at. The
floor is short (`scope(is.owner()).can(...)` is what you'd write anyway), but it
is never zero.

**Override, not additive.** When you want stricter or different behavior, you
replace the framework's derived default *in the same slot* — your declaration
shadows the default, it does not sit beside it. A derived default is any value
the framework computes that you can override one declarative level down; there is
never a lower-level trapdoor (no hand-written SQL beneath the grant compiler, no
second write path beneath the pipeline).

---

## 3. Sensible defaults, baked into the framework

The framework owns the boilerplate every server repeats. The app does not mount
any of this by hand — if it had to, that would be a leak (AGENTS.md → Defaults).

- Security headers; body parsing (JSON + urlencoded, ~1mb cap); cookie sessions
  (secure, httpOnly, sameSite=lax); `req.user` hydration from the session; rate
  limiting; CORS (same-origin default); request logging; a view engine; static
  serving; content-negotiated 404; a 4-argument JSON error handler (dev stack
  traces, prod-safe); graceful shutdown on SIGTERM/SIGINT and on
  unhandledRejection/uncaughtException.
- `config.mjs` carries environment overrides; the app does not re-implement the
  knobs.

**Two default-on authorization layers**, both opt-out-explicitly, never
opt-out-implicitly:

- **Route gate** — a request must be authenticated to reach a handler.
- **Row gate** — the per-entity grant runs on every row.

One auth concept, `requireUser`, covers both transports: HTTP route gates and the
WebSocket live-delivery seam use the same principal and authorization engine.
Entities declare their route gate and are exposed with `app.mount(path, Entity)`;
the framework's `/events` live endpoint re-authorizes delivery. `req.user` is
hydrated from the session; the app never writes a manual `loadUser`.

---

## 4. Routing

Verbs are methods, handlers are varargs:

```js
users.get('/', requireUser, userList)
```

`router()` builds mini-apps mounted bare with `app.use(path, router)`. Subtrees
chain verbs. There is no nested-tree routing DSL and no array-of-handler combos —
one obvious way to wire a route.

---

## 5. Documents — `entity()` + `app.mount()`

`entity(name, declaration)` declares a durable entity. `app.mount(path, Entity)`
exposes its generated REST CRUD and declared routes; the framework owns
persistence, sync, and event emission. Live collaboration uses the separate
LiveChannel/live-delivery seam rather than an entity-specific room API.

### 5.1 Field types are an open registry (ADR #9)

Field types are **not** a closed catalog. They are an open registry of
**named-whole plugin contracts**. The stress-test set broke any baked-in catalog:
a minecraft chunk is ~4913 internally-keyed sub-records; photo-editor needs a
raster CRDT; drawing-canvas needs a polyline CRDT; five apps need atomic-reorder
ordered lists. So there are **four named-whole contracts**, distinguished by
genuinely distinct diff + index + inverse machinery (not a kind-enum that grows
optional surfaces — that would be the forbidden flag lattice):

- **`fieldType.value`** — a single stored value with whole-value diff. `blob`
  (bytes) and `json(shape)` are value-kind built-ins; `json` becomes
  path-queryable via an opt-in index.
- **`fieldType.store`** — an internally-keyed owned collection with per-key diff,
  index, and range query. This is what `map` could never be, because `map` is
  keyed-*unordered*.
- **`fieldType.crdt`** — a custom merge with per-element deltas. `text.crdt()` is
  now just one instance of this contract; the old baked-in `text.crdt` special
  case is deleted.
- **`fieldType.ordered`** — a fractional-index keyspace supporting atomic
  `insertAt` / `move` / `reorder` without renumbering. This earned its place by
  the deletion test: it deletes the "map-as-ordered-array fake" five apps
  hand-rolled.

Built-in instances ship for `text`, `number`, `boolean`, `date`, `state`,
`enum`, `ref`, `map`, `set`, `log`, `blob`, `json`, `list` (the ordered list).

**Coordinates are constructed from declared indexes.** A coordinate (e.g.
`coordinate.box3(...)`, used for spatial/range subscription interest) takes an
`index.range([...])` as a constructor argument. A coordinate with no backing
index is *unrepresentable* — a load-time type error, fail-closed one level early.
The plugin declares its index capability; the field instantiation selects the
backing index; the engine owns materializing it and compiling SQL. **No plugin
emits SQL.**

A custom CRDT-authoring toolkit is deferred — `text.crdt`, `polyline`, and
`raster` ship as proof that the contract is sufficient. Proactive is not
exhaustive.

### 5.2 Relations are typed foreign keys

A `ref` is a typed FK, explicit about its target, with auto-traversal and
population. `from: 'req.user.id'` on a ref auto-populates it from the principal
and marks it read-only. A collection owned by one side is a **field on that
entity** (a `store` or `list`), not a standalone table. Opaque sugar that hides
the FK target is rejected.

### 5.3 Computed fields — three named concepts (ADR #12)

These are three distinct concepts and carry three distinct names:

- **`derived`** — a strictly pure, synchronous, read-time pull. Computed on read,
  never stored (e.g. `wordCount`). Not a write.
- **`projected.inline`** — a stored computed field updated *inside* the
  originating transaction, when its dependency is in the same batch and the
  compute is cheap and synchronous (e.g. a `hotRank` from in-row
  `score`/`commentCount`/`createdAt`). Transactionally consistent, so a
  visible-page sort key never mis-ranks. Mechanically, it is an in-transaction
  effect (ADR #6) targeting a derived field.
- **`projected.async`** — a stored computed field updated by a **post-commit
  projection** over the committed log, with a sequence watermark and explicit
  staleness. For expensive/async/external compute that must *not* join the DB
  transaction: thumbnails, rendered images, search-index embeddings.

Both `projected` writes go through a **bounded projection principal** admitted by
the target's own grant. A framework-reserved internal write path would be the
second write path AGENTS.md forbids, and is rejected. `projected` ≠ `derived`:
distinct names, distinct concepts.

### 5.4 Field access — `.can` strong-inherits the row grant (ADRs #3, #4)

A field with no `.can` **strong-inherits** the row grant: it is readable when the
row is readable, and its edit floor is the row's write capability. To go
stricter, declare it explicitly — either `.can(fn, defaults)` on the field, or
`fieldAccess: { default: ownerOnly }` to flip the whole entity's field floor
closed (`ownerOnly` is an authorization function, never a raw deny). Declaring
both is an error.

Field access is **always** evaluated at runtime via `.can` — never compiled to a
SQL scope — because by the time a field is read the row is already materialized
(ADR #3). A denied field *read* returns a typed **`withheld`** marker (plus a dev
diagnostic naming the field path and reason); a denied field *edit* is a hard
write reject. This is a deliberate asymmetry with row-level reads, which *are*
compiled to a SQL scope (§6).

---

## 6. Authorization — the core design

Authorization is **always functions** — never magic words, string sentinels, or
static values. Decisions are computed. There are exactly **two questions** —
*read* and *edit* — and **no visibility/hide axis** (ADR #1). A denied read does
not hide a row behind a flag; it removes the row from the result. The
absent-vs-forbidden distinction is handled by a prod server-log plus a dev-only
error ("this exists but you wouldn't know in production"). `hide()` is dead.

### 6.1 Checks and the grant's two halves (ADRs #2, #7)

A **check** is a per-entity named fact — a plain, awaitable function like
`is.owner()`, `is.collaborator()`, `is.editor()`. Checks are never universalized;
the old `admits(...)` wrapper is dead.

A grant is `scope(predicate).can(fn)` — two halves split on a **performance**
boundary, never a third half:

- **`scope(...)`** is the **read** grant, and *only* the read grant. It compiles
  to a SQL `WHERE` clause. A predicate that cannot compile to SQL inside a
  `scope` is a **load-time error** — never a silent JS fallback or warning.
- **`.can(...)`** is every other capability (edit, delete, custom verbs). It runs
  per-row at runtime and may call non-compilable, async, cross-entity checks.

**Read intent is never derived from compilability** (ADR #2). The fact that a
predicate *can* compile to SQL does not mean it *grants* read — an archived row's
predicate compiles fine but must not become world-readable. You declare read
intent by putting the check in `scope`; you do not get it for free from the
compiler.

`never()` and `.is(undefined)` compile to SQL `FALSE`; `everyone()` compiles to
SQL `TRUE` (NULL-safe, symmetric to `never()`). These are deliberate fail-closed
/ fail-open *values* the developer wrote — distinct from a non-compilable
predicate, which is the load-time error above. `everyone()` is never the
NULL-unsafe `entity.id.is(entity.id)` tautology and never a derived admission.

### 6.2 Principals — a closed union with `anonymous` first-class (ADR #11)

The principal-type union is **closed**: `user | link | system | anonymous`.

- **`anonymous`** (`{ type: 'anonymous', id: null }`) is a first-class principal
  for unauthenticated public-read (the reddit front page, a published blog post).
  It is admitted only by identity-free checks (e.g. `published`), never by a
  `publicRead` flag.
- **Domain identities** (a library Patron, a blog Reader, a game Player) are
  **sub-account entities owned by `User` via a typed FK** — *not* new principal
  types. A Patron is a User wearing a domain hat. Reopening the union per app
  would be the universalizing the design rejects. A User may own *multiple*
  sub-accounts (RuneScape: one sign-in → many character-accounts, each with its
  own team permissions); the principal resolves to the active sub-account. Every
  domain identity *has* an account (passwordless email-link login is fine; there
  is no account-less "email user"). `is.<role>()` traverses the typed FK
  principal → SubAccount → role in one compiled JOIN. The framework hydrates the
  binding — the developer declares the sub-account entity and the identity FK and
  does not write app middleware (that would relocate the inline-ownership debt
  scope warned against).

**Per-verb route-gate opt-out** relaxes *only* the route gate for named verbs. It
is declared on the entity, next to `grant` — one authorization story, not two
places:

```js
entity('Post', {
  fields: { ... },
  grant: () => [scope(...).can(...)],
  gate: { list: allowAnonymous(), create: requireUser() },
})
```

`r.resource()` expands the five CRUD verbs using the entity's compiled gate
(unlisted verbs default to `requireUser()`); there is no per-mount gate override.
The row grant still runs on every verb regardless. The two default-on layers stay
intact; there is no second auth path.

### 6.3 Finer-than-field access

`entryCan(entry, principal)` grants per-*entry* access on a collection field
(a library patron sees their own hold entry, not others'). This is finer than a
field `.can`. `derived(row, principal)` as an access mechanism is **rejected** —
it confuses data derivation with authz/view-shaping.

### 6.4 No second auth path

Every transport — REST, the live stream, subscriptions — runs through the same
authorization engine. Live events are **re-authorized before delivery** (§8), not
bypassed. A motivating case: a payer funds a doc but cannot view its body — the
title and `wordCount` are readable, `body.can` returns a `withheld` marker
(rendered as a mask) plus a dev diagnostic. Cross-resource delegation
(`is.projectManager()` = `load(doc.projectId).can('write', user)`) is an async
one-load check, memoized.

---

## 7. The mutation pipeline (dispatch, sync, replay)

This is the validated shape from the `scope` workbench (`SCOPE-FINDINGS.md` §2),
adopted as load-bearing structure.

**Action vs Event are distinct types.** An **action** is an imperative client
request that *may be rejected* (branded). An **event** is a past-tense fact the
server emitted; it already happened (branded). The two are not assignable to each
other. An event type with no reducer is a **compile error** — the reducer is
non-optional.

**One pipeline, every source.** Every state change flows through the same
pipeline; there is no `on(app)`, no `afterSave`, no second live path:

1. **validate** — schema parse; a bad payload never proceeds.
2. **resolve scope** — a *pure* `(payload) => scopeRef`, no I/O, a typed handle
   (not a runtime-parsed string). Purity lets authorization run *before* the
   write transaction opens, so a flood of forbidden requests never holds the
   write lock.
3. **authorize** — the grant runs (§6).
4. **preimage** — capture the pre-mutation value of every affected entity, so a
   failed dispatch rolls back exactly, and client-local undo restores exactly.
   Preimage is never persisted server-side for sensitive client state.
5. **optimistic apply** — apply a *visible placeholder* so the UI moves
   immediately. This is a placeholder, not a second source of truth.
6. **dispatch** — send to the server; on failure roll back every preimage and
   mark the operation failed *visibly*, never silently.
7. **ingest** — the **only** place an event becomes client state. Fold each event
   through its reducer *exactly once* and advance the cursor. The same `ingest`
   handles the client's own echoed events *and* foreign events from the live
   stream. There is no second apply path (AGENTS.md → one reconciliation path).

The server runs the same handler inside one transaction: resolve scope →
authorize *outside* the transaction → open transaction → dedupe by action id
(idempotent: a re-sent action returns its stored events without re-running) → run
handler → assign each event a per-scope monotonic sequence number → append to the
durable log → commit → fan out to subscribers.

**Pipeline variants are named wholes, not orthogonal flags** (AGENTS.md). The
durable-vs-live variant selects a named, pre-validated whole; it never toggles
individual stages with independent booleans.

### 7.1 Sequence-cursor replay

Every durable event carries a per-scope monotonic **sequence number**; the client
advances a **sequence cursor**. On each incoming event:

- **duplicate** (sequence < expected) — idempotent skip.
- **gap** (sequence > expected) — do *not* apply; signal a resync.
- **next** (sequence == expected) — reduce once, advance the cursor.

Because the client's own echoed events route through the same `ingest` and
advance the cursor, a later redelivery over the live stream is correctly a
duplicate. Resync folds the missing events through the reducers in order; the
reducer fold is the source of truth and never replaces the snapshot wholesale
(except at initial bootstrap). A **stale cursor hard-fails** into a forced
re-bootstrap — never a silent truncate.

**Bootstrap ordering is load-bearing.** The client loads the snapshot and sets
the cursor to the snapshot's sequence *before* starting the live stream. If the
stream starts first, foreign events during the race resync into an empty snapshot,
then the snapshot load overwrites them while the cursor has advanced — permanent
event loss. The client library (`LiveList`) enforces this ordering structurally.

### 7.2 Persistence is opt-in by engaged seam (AGENTS.md)

An action's class — durable, ephemeral, volatile — is **emergent from which seams
it engages**, never a label it carries. Engage the persistence seam and the
action is durable (events get a sequence number and replay). Don't, and it is
ephemeral (presence heartbeats) or volatile (coalesced typing indicators, no
events). An entity declaration that engages the persistence seam is durable; live
delivery can also carry ephemeral/volatile field events. These are one action
primitive with engaged seams, not separate mechanisms. The engaged seam does the
work itself (the field-type plugin owns the persistence strategy); there is no
inert marker that flips a gate.

### 7.3 Undo is preimage-restore plus inverse events

Client-side undo restores the captured preimage (immediate); redo restores the
captured post-state. Server-side undo *appends inverse domain events through the
same pipeline*, so the log stays append-only and every client converges. There is
no second undo log. The `inverse` operator slot is reserved on field plugins
(Phase 1).

---

## 8. Live delivery and subscriptions

Live delivery is **NOT a third grant method** (ADR #5). The grant stays exactly
the two halves of §6. Delivery is two things layered on top:

1. **Re-authorization** — the same `scope` + `.can` re-run at emit time, latched
   at subscribe and cached, invalidated by roster / share / role / ownership
   change. This is the hard gate, cheap enough to check at 30Hz.
2. **Subscriber interest** — a connection-transient *narrowing filter*, not
   authorization. It runs *only after* re-auth, is keep/drop with no fetch and no
   OR, and is **data, not code** — a typed constraint over the coordinate schema
   the field-type plugin publishes. It may not read the principal or the row. An
   unpublished or non-indexed coordinate is a subscribe-time validation error.
   Closures are rejected.

### 8.1 The subscribe surface (ADR #14)

```js
subscribe(Entity, id, { fields, pace })
```

Interest is **keyed by field handle**; a field not listed is **pass-through**
(a `name:changed` event is not tested against a `chunks` viewport interest). The
grammar is constrained by indexability: **AND across dimensions**; per dimension
**one** continuous `range(lo, hi)` OR **one** finite `.in([a, b, c])` (compiles
to an indexed `IN`) OR `.is(v)`. **No cross-dimension OR** (a Cartesian union no
composite index can answer), **no closures**. Scalar fields default included;
high-volume coordinate-published collection fields are **opt-in** (omission means
not-subscribed, never an unfiltered firehose). It reuses the sequence-cursor
replay core (bootstrap snapshot, then stream; gap/duplicate/next unchanged).

### 8.2 Backpressure is two-layer

The field-type plugin publishes a lawful coalescer + a sequence-span reducer +
named pace-profiles — *data semantics* decide what is lawful to drop (a position
is loss-tolerant; document text edits are not). The subscriber selects
`pace.coalesce({ window, by })` or a profile *within* the plugin-permitted bounds
(data, not code; runs after re-auth and interest; narrowing only). A spectator
and a player may choose different temporal policy for the same field.

### 8.3 The live-update loop, end to end

`POST /docs/:id/collaborators` → effect `{ mutate: Inbox, with: { recipient, doc,
kind: 'invite' } }` → one composed event → re-auth-at-emit per subscriber per
source-entity-tagged fragment (a Doc subscriber sees the Doc fragment, an Inbox
subscriber sees the Inbox fragment) → the recipient's `/me/inbox` room →
`LiveChannel` → `LiveList._upsert` → re-render. No polling.

---

## 9. Declarative effects (reactions)

Effects are **bounded, in-transaction, effect-principal reentrancy** — *not*
`afterSave` callbacks, *not* an unbounded fixpoint (ADR #6).

### 9.1 The one primitive

```js
{ mutate: <target>, with: <data-template> }
```

A cross-entity effect is a compiled mutation re-entering *one* pipeline in the
**same transaction**. The grammar collapses `{set}` (self) and `{create}`
(cross-entity) into this one primitive; the engine decides set-vs-create from
whether the target row exists. The target's grant and validation are sovereign: a
target failure **rolls back the origin** (no separate saga boundary).

- Bounded by **typed handles** — the target is an entity handle, the trigger is a
  typed event handle (a third reason to kill magic strings). A structural cycle
  (A → B → A) is a **load-time error**, with a runtime depth-cap fail-closed
  backstop that aborts the whole batch.
- Runs as the **effect principal** — not the triggering user, not an ambient
  `SYSTEM` god — bounded to the declared target and template fields, authorized
  against the *target's own* grant. Data is interpolated only from the trigger
  delta and the origin row.
- A composed event is atomic for **commit**, not for **delivery**: each
  subscriber is re-authorized at emit per source-entity-tagged fragment;
  unauthorized fragments are simply absent.
- A cross-*store* target is a load-time error.

### 9.2 Operators, guards, fan-out (ADR #13)

Effects grow by **typed field-plugin operators**, not new effect grammar:
`inc` / `dec` / `append` / `push` / `insertAt` / `move` are field-plugin
operators named in `with` (the effect layer borrows the field layer's operators —
a deletion-test win that deletes a bespoke effect-mutation grammar). `inc(delta.direction)`
references the target's own current value (read-modify-write owned by the field
operator); it is *not* generalized to arbitrary target reads (that would widen
past "data interpolated only from trigger delta + origin row").

- **`when` guards** — typed predicates over the delta and origin (not I/O);
  non-compilable is a load-time error.
- **Load-time-verified admission** — every declared cross-entity effect must have
  a matching `effectSource(handle)` / `principalFrom(handle)` admitting check on
  the *target*. The load-time cycle-detector walks the typed effect graph and
  verifies the handshake; a missing admit is a load-time error, never a silent
  runtime rollback.
- **Owned-collection fan-out** — `mutate: many(Target, { over: Origin.collection })`
  traverses typed FKs from the origin row with structurally-knowable, depth-capped
  cardinality (a blog notifying its subscribers). Ships now.
- **Typed compound trigger** — `effect.anyOf(handleA, handleB, handleC)` over
  finite, statically-known, fully cycle-detectable triggers. Ships now. A wildcard
  "any field on any child" string-glob is unbounded fixpoint and is rejected.

**Deferred:** arbitrary indexed-query fan-out and `recomputeFrom(query)` in
in-transaction effects (cardinality becomes a runtime query result, beyond the
ADR #6 bound — deferred until an app proves the need *and* a safety case extends
the ADR); general arithmetic beyond `inc`/`dec`.

### 9.3 Out-of-band effects are projections (ADR #8)

The two effect kinds split exactly on the **atomicity boundary**:

- **In-transaction** (`{ mutate, with }`, above) — *must* be atomic with the
  origin; re-enters the pipeline in the same transaction; a target deny rolls the
  origin back.
- **Out-of-band** (webhooks, emails, external HTTP) — *must not* be atomic; they
  leave the process and cannot join the DB transaction. They are **projections
  over the committed log**: after commit, events fan out to projection consumers,
  each independently durable. A projection failure is retried on its own schedule
  and never rolls back the origin.

This reuses the committed log the framework already has (subtract before add) and
keeps the one-reconciliation-path invariant. `projected.async` computed fields
(§5.3) are the in-framework read-model case of this same projection primitive.

### 9.4 Background jobs — the generic queue substrate (W3)

A **job** is a unit of work with its own lifecycle — it is *not* a derived read
model, so the queue is a **separate seam** from the projection registry (folding
it in would only relocate the claim/lease/heartbeat/reaper concept). The two
compose at the **enqueue edge**: a post-commit consumer (§9.3) or the app's
write path calls `enqueue()`; the queue owns the lifecycle from there. Chaining
(transcode → transcribe → index) is composition at that same edge, never a
queue-native DAG.

The genericity split is the template for every app-driven feature: **workbench
owns the generic board** (post / claim / heartbeat / result / retry / reaper);
**apps plug in job kinds** — a kind name, a worker, and a payload/result
contract. Nothing kind-shaped lives in the substrate.

Engaged as an app seam: `workbench({ db, jobs: { sharedSecret, leaseMs,
heartbeatGraceMs, maxAttempts, backoffMs, reapIntervalMs } })` → `app.jobs`.
The surface:

- `enqueue({ kind, payload, scope, id })` — post work. `scope` is optional and,
  when present, is an entity scope key (`'Post:p1'`) — the live stream key a
  job board subscribes to.
- `registerWorker(sharedSecret)` / `authenticate(bearer)` — registration uses a
  **shared secret**; job operations use a **per-worker revocable bearer token**.
  Both constant-time compared; the shared secret is never accepted for job
  operations; unknown/revoked fails closed. Workers are not assumed co-located
  or trusted.
- `claim(workerId, { kind, scope })` — atomic single-statement claim
  (`UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *`); concurrent claimants
  are race-safe by per-statement atomicity, FIFO by `enqueuedAt`.
- `heartbeat(jobId, workerId)` — extends the lease; the first heartbeat is the
  claimed→running edge.
- `updateProgress({ jobId, workerId, progress, stage })` — percent + stage for
  long runs; rides the one event path (no second progress channel).
- `submitResult(jobId, workerId, { status, output })` — **idempotent by job id**
  (first terminal result wins; a retried submission is a no-op ack). A failed
  result retries with backoff up to `maxAttempts`, then dead-letters (terminal
  `failed`).
- `cancelJob`, `reap` / `startReaper` (expired leases reassign to `queued`),
  `list({ scope, kind, status, limit })`, and `work(kind, fn, { pollIntervalMs })`
  — the in-process worker loop with an awaitable `once()` for deterministic
  tests.

**Live visibility** (W3 slice 2): every state-changing mutation on a job with a
non-NULL `scope` appends exactly one `_Job.created` / `_Job.updated` event to
the committed log, under the job's scope, using the kernel's own per-scope
sequence grammar — one seq, not a second one. The serve layer bridges the
queue's `onEvent(fn)` hook into the live fan-out: the event is delivered
**scope-anchored** to subscribers of the anchor entity (anchor identity, re-auth
against the anchor row, no delta), failing closed on an unparseable scope,
unknown entity, or missing anchor row — the event stays durable in `_Log` for
cursor catch-up either way. A NULL-scope job has no stream key and is invisible
to live boards by construction. Job boards are therefore the normal live path
(§8) — no bespoke polling channel.

---

## 10. Time-driven sources (ADR #10)

Time-driven mutations are a typed **source** feeding the one pipeline. There are
**two public nouns**, because a deadline and a recurring loop are different things
(the naming rule):

- **`schedule.at(dateField)` / `schedule.after(anchor, delay)`** — one-shot
  deadlines (a library item overdue at `dueAt`, a blog post's scheduled publish at
  `publishedAt`, a todo reminder). This fills the gap `state.auto` could not:
  `state.auto` is a fixed duration from state-entry, not a per-row date.
- **`tick.hz(n)` / `tick.every(...)`** — recurring loops (a 20–30Hz game loop).

`state.auto` and entity-TTL **demote to sugar** over `schedule.after` /
`schedule.at`. The source runs as a **bounded scheduler/tick principal** (not a
`SYSTEM` god). In the mutation transaction, Workbench rechecks the exact declared
trigger, current row, due time, `while`, `when`, and derived payload. The clock is
a new *trigger*, never general write authority; there is no second mutation path.

Deadline admission writes a durable receipt in that same transaction. A receipt
is one-shot for one `(trigger, row, due value)` generation. A canonical update to
the deadline field rearms it, including when an application deliberately returns
to a previously used value; removal clears the row's receipts. Workbench retains
at most one receipt per trigger and row, so changing deadlines does not grow an
unbounded history. Failed mutations roll receipt changes back and remain eligible
for retry.

**Two scale guards:** `while` is the database-searchable discovery predicate. It
must compile to SQL (the tick-layer analog of a compilable `scope`), and the DDL
generator indexes main-table fields it references. `when` is a separate,
synchronous lifecycle guard over each deserialized row after SQL discovery; it
must not return a Promise. An **empty `while` is forbidden** for row-set ticks
(the run-on-all-rows-forever foot-gun); deadline triggers already have their
indexed date/number field as a bounded discovery source. Tick durability is a field-type
persistence-strategy decision (ephemeral = no durable events; a
coalesced-snapshot-with-sequence-span for high-frequency persisted fields so
cursor replay stays correct; per-event for the rare case).

---

## 11. Query predicates (ADR #15)

Query predicates share the compiler with scope predicates but **never auto-admit
read** (compilability ≠ read intent — the ADR #2 leak guard).

- **`findTree`** compiles to a recursive CTE over the declared self-FK (FK-aware,
  the row `scope` in the `WHERE`). It deletes fetch-all-then-build-tree-in-JS
  (reddit's 3000 comments, todo subtasks).
- **Cursor pagination** is a range over a compound key (reuses the interest range
  machinery). `projected.inline` sort keys are cursor-paginable (materialized and
  indexed).
- **`.isNull()`** is a *query* predicate (the read half), compiling to SQL
  `IS NULL` — distinct from **`.is(undefined)`**, a *scope* predicate (the authz
  half) compiling to `FALSE`. Distinct concepts, distinct names; they live in
  different halves and do not collide.
- **`unique([f1, f2]).where(...)`** for a genuine compound-with-partial-predicate
  key that cannot dissolve into a field (a library's one active Checkout per
  item+patron).
- **Geo `.near()` / full-text `.match()`** are index-gated predicate **plugins**.
  The seam ships now (so a query never degrades to raw SQL / a second query path);
  the rtree / FTS engines are deferred until google-photos is the active spine —
  build the seam, not the subsystem.

---

## 12. The client library

`public/workbench-client.mjs` keeps the page declarative:

- **`LiveChannel`** — subscribes over WebSocket, auto-reconnects, dispatches
  events.
- **`LiveList`** — boots from a JSON snapshot, applies deltas, calls a render
  callback. Enforces the bootstrap ordering of §7.1.

The annotated-text field's declaration, editing, recipient projection, and
confidentiality contract is documented in
[`docs/annotated-text.md`](docs/annotated-text.md).

A realtime-collaborative feature page is 30–80 lines, none of it event handling
(the DX ceiling `scope` proves reachable — `SCOPE-FINDINGS.md` §3). The page
constructs a `LiveChannel` for the server's live-delivery URL and a
`createLiveStore({ baseUrl, name, path, channel })` for an entity mounted at its
CRUD path, then calls `dispatch(type, payload)`. `LiveChannel` multiplexes
entity/id subscriptions over WebSocket and `LiveList` bootstraps from the REST
snapshot before subscribing. The page does not use an entity-specific room API.
**Dispatch does not throw**; it returns one
framework-owned result shape decoded through one shared decoder (two call sites
cannot drift). The principal is built **server-side from the session**; the
client-supplied id is a transport correlation id only — the client cannot supply
its own identity.

`package.json` declares `workbench`, `type: module`, with the package entry point
at `build/index.mjs`; the browser client is `workbench/client` and the server-only
surface is `workbench/server`.

---

## 13. Build order (roadmap)

The full dependency-ordered roadmap, the per-pain-point adjudication, and the
"prove right before fast" spine selection live in §13 here. Phase work is
ordered so each phase has a working spine app.

**Five unifying abstractions** (each concentrates several pain points):

1. **The mutation pipeline owned by the field-type plugin** —
   validate → access → apply → diff → persist|ephemeral → emit. Every source runs
   it; no `on(app)`, no `afterSave`, no second live path.
2. **The uniform principal** — `{ id, type: 'user'|'link'|'system'|'anonymous',
   attributes }`, union closed; domain identities are sub-accounts owned by `User`
   via typed FK.
3. **Declarative reactions** — `{ mutate, with }`, bounded effect-principal, same
   transaction.
4. **The scheduled mutation** — a timer feeding the pipeline; two nouns
   (`schedule.at`/`after`, `tick.hz`/`every`); `state.auto` + TTL as sugar;
   bounded scheduler/tick principal; `while` must be indexed.
5. **Typed-FK traversal in the authz compiler** — one compiler serves
   User ↔ Patron, Post → Comment inheritance, and keyed uniqueness.

**Load-bearing guards** rejected at entity-load: ticks run *through* the pipeline;
the query scope is *derived from* the grant, never declared separately; effects
are declarative `{ mutate, with }` only (no `afterSave`); `effectSource` is
load-time verified; structural cycles and cross-store targets are load-time
errors; the async `is.*` thenable foot-gun (an unawaited `is.author() ||
is.blogOwner()` over two pending promises returns the first truthy and silently
grants everyone) is guarded; `batch()` is the pipeline in one transaction = one
composed event; ephemeral *field* is split from ephemeral *entity*; live delivery
is not a grant axis; grant inheritance is declared (`inherit` / `via`).

**Phases:**

- **Phase 0** — the async `is.*` guard (~1 week; blocks all auth).
- **Phase 1 — blog-platform spine** (correctness): the field-type plugin contract
  + mutation pipeline (large, irreversible — it declares persistence strategy,
  scope, authority, operators + diffs, optional inverse, optional validate, and
  the published-event coordinate schema); the principal model; queryScope
  derivation + typed-FK traversal; the `state`/`enum`/`boolean`/`map` built-in
  plugins; validate-as-pipeline-stage; `anonymous` + `everyone()` + per-verb route
  gate + single-field `unique` + `.and`/`.not`/`.is`/`.in`/`.isNull` predicate ops
  + `inherit(Parent)` / `owner: via(Parent.owner)`. The `publicRead` flag is dead,
  replaced by `anonymous` + `everyone()` + the per-verb gate.
- **Phase 2 — space-invaders spine** (performance): live delivery
  (`subscribe(Entity, id, { fields, pace })` + field-keyed interest + two-layer
  pace + latched re-auth-at-emit); ephemeral persistence + scope/authority;
  `tick.hz`/`tick.every` (not lifecycle-bound to state — always-on is a foot-gun;
  gated by an indexed `while`) + `schedule.at`/`after`; per-field-type delta
  broadcast; `blob` + ordered `list` + `json` built-ins + batched mutation (the
  list uses the fractional-index keyspace).
- **Phase 3 — round-out**: range + cursor pagination; stored computed fields in
  two modes (`projected.inline` + `projected.async`, ADR #12); tree traversal
  (`findTree`, recursive CTE); compound uniqueness + `.isNull()` +
  ephemeral-commit semantics + entity-TTL sugar; ergonomic modifiers
  (`setOnce`, `role: author` auto-populate, `entryCan`, `ownerOnly({caps})`,
  `inherit().through()` multi-hop).

**Deferred / plugin territory:** geo / full-text engines (the seam ships now);
arbitrary-query fan-out + `recomputeFrom` (beyond the ADR #6 bound); a custom
CRDT-authoring toolkit; spatial event scoping (needs a go/no-go); batch-load
endpoints; adaptive per-connection rate negotiation.

Spine selection: Phase 1 is **blog-platform**, Phase 2 is **space-invaders** —
prove right before fast.

---

## 14. Exemplar map

The `.mjs` files demonstrate the DX ceiling against the grilled model:

- `app.mjs` — the single wiring entry point.
- `note.mjs` — the minimal entity (explicit grant, no defaults).
- `doc.mjs` — the ceiling exemplar (a Google-Docs-class collaborative document).
- `gdoc.mjs` — a smaller collaborative-doc exemplar under the `doc.mjs` ceiling.
- `comment.mjs` — child-entity grant inheritance from a parent via typed FK.
- `todo.mjs` — `Todo` + `TodoList` + `SharedTodo` inheritance.
- `session.mjs` — session/auth wiring.
- `projects/google-photos/{album,photo}.mjs`, `projects/photo-editor/photo-editor.mjs`,
  `projects/space-invaders/match.mjs` — per-app exemplars.

---

## 15. The values this obeys

This spec is downstream of `AGENTS.md`. The load-bearing values, in one place for
reference (the full statements live in AGENTS.md):

- **Prefer a singular system.** One way to do a thing.
- **Declaration absorbs imperative wiring.** Behavior flows from declared shape.
- **Subtract before you add.** A new concept must make an old one unnecessary.
- **The deletion test gates every abstraction.** It must *concentrate* (absorb
  another concept, net line count drops), not *relocate* (move code into a config
  object behind a new name). A generator's pure half may concentrate; its varying
  half (per-entity authorize/handler bodies) stays hand-written.
- **Build for the known use cases proactively, but no further.** The bar is "a
  real app in `projects/*` needs this shape," never "every conceivable knob."
- **Fail closed.** Auth-on, private-by-default, allowlists not denylists.
- **One reconciliation path.** `ingest` is the only place an event becomes state.
- **Persistence is opt-in by engaged seam, not a class field.**
- **Pipeline variants are named wholes, not orthogonal flags.**
- **Authorization is always functions**, never magic words; **no second auth
  path** across any transport.
- **No magic strings**; relations are typed FKs; a one-sided collection is a field.
- **Fields are reactive primitives**; uniform transport (WebSockets); out-of-band
  effects are projections over the committed log.
- **Sensible defaults baked into the framework**; two default-on layers (route
  gate + row gate).
