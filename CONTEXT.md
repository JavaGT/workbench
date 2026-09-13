# Workbench Framework

Workbench is a framework for collaborative, persisted, realtime applications. Its language names the seams app authors declare and the framework executes.

## Language

**Entity**:
A declared persisted record type with fields, grants, routes, schedules, and mutation verbs.
_Avoid_: Model, table, resource

**Field**:
A named cell on an Entity with a kind that fixes validation, persistence, and merge behavior (including binary storage as a kind, not a separate domain object).
_Avoid_: Column, property, attribute (when meaning a declared entity field); Blob as a first-class identity beside Entity rows

**Grant**:
A function-declared authorization rule with a row-scope half and a runtime capability half.
_Avoid_: Role map, permission string, policy object

**Row scope**:
The half of a Grant that decides which entity rows a Principal may see, as a filter over declared fields.
_Avoid_: Scope handle, room, collaboration key; not the committed-log identity string
**Capability**:
A named authority a Principal may hold on a row after admission (read, write, subscribe, admin).
_Avoid_: Permission string, role flag when meaning a grant result

**Principal**:
The actor for a request or framework-originated mutation, represented as a closed kind plus identity and attributes.
_Avoid_: User when meaning who acts (a person account may be an Entity named User; the actor is always a Principal — including system, link, and apiKey)

**Action**:
An imperative request that may be authorized or rejected; it is not yet a fact.
_Avoid_: Event, command when meaning a request still subject to denial

**Event**:
A past-tense fact the server committed; it folds through reducers and is never undone by denying the Action that produced it.
_Avoid_: Action, message, notification when meaning a committed log fact

**Event handle**:
A typed event identity that carries structured meaning and derives the persisted event string.
_Avoid_: Event name string, event type string

**Scope handle**:
A typed identity for one entity row in the committed log, live delivery, and cursor streams; derives the persisted scope string.
_Avoid_: Scope string, room, collaboration key; not Row scope (Grant visibility)

**Seq cursor**:
The last applied sequence position for one Scope handle on a client or consumer.
_Avoid_: Offset, watermark when meaning the per-scope live/replay position

**Replay decision**:
The pure duplicate / next / gap verdict from comparing an incoming seq span to a Seq cursor.
_Avoid_: Ingest, apply, reconcile (those fold state; this only decides whether to)

**Committed log**:
The durable sequence of committed events that projections, live delivery, and clients consume.
_Avoid_: Message bus, audit log

**Projection**:
A committed-log consumer that derives stored state or delivery output after an event commits.
_Avoid_: Callback, after-save hook

**Effect**:
An in-transaction reaction that re-enters the same mutation pipeline under a bounded effect principal.
_Avoid_: Webhook, email, job when meaning work that must leave the process

**Schedule**:
A one-shot time source bound to a date or numeric field on an entity row.
_Avoid_: Timer, cron job

**Tick**:
A recurring time source that repeatedly scans eligible rows and dispatches declared mutations.
_Avoid_: Schedule, loop job

**Job**:
A unit of out-of-process work with its own claim/lease lifecycle, distinct from in-transaction Effects.
_Avoid_: Effect, projection, queue message when meaning leased worker work

**Live Delivery**:
The deliver-loop seam that re-authorizes and pushes committed events to subscribed clients.
_Avoid_: WebSocket server, pub/sub, broadcast when meaning the framework delivery contract

**Query-scoped read**:
A bounded, authorized page of Entity rows selected by a typed query contract (allowlisted filters, single-key sort, keyset cursor), stamped with a revision token from the commit lifecycle.
_Avoid_: Snapshot when meaning a filtered list page; collection subscription when meaning row-level patches; ad-hoc SQL

**Revision token**:
The `_CommittedRevision.actions` value captured with a query page, proving the page was read at that commit point.
_Avoid_: Seq cursor (per-scope live position); page token as authorization

**Query invalidation**:
A post-commit "changed since revision R" signal for registered query dependencies; the client refetches a bounded page rather than applying row patches.
_Avoid_: Row-level result patch; full snapshot replace

**Query family**:
A registered, author-declared read shape over a host Entity and optional typed dynamic-field catalog/elements. Clients name the family and pass validated field references; they do not send query programs or SQL.
_Avoid_: Ad-hoc SQL; free-form client query; collection subscription

**Kernel**:
The framework's durable mutation-dispatch core: admit, handle, append to the committed log, project rows, and register engaged post-commit consumers.
_Avoid_: Server, router, application container

**Compile loop**:
The cycle that turns Entity declarations into handlers, schema, grants, and routes.
_Avoid_: Layer, tier, service when meaning this cycle

**Commit loop**:
The cycle that turns an Action into sequenced Events and projected rows.
_Avoid_: Layer, tier, service when meaning this cycle

**Deliver loop**:
The cycle that takes committed Events to authorized clients and folds them via Replay decision.
_Avoid_: Layer, tier, service when meaning this cycle

**Coat**:
Known-app capability on top of the three loops (auth product, jobs, blobs, UI) that must not invent a second mutation or auth authority.
_Avoid_: Plugin when meaning a second path; microservice

**Membership**:
A declared pattern that derives checks and a Grant from collaborator roles on an Entity, still evaluated through the one authorization engine.
_Avoid_: ACL table, role map as a second auth path
