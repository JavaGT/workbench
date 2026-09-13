# Architecture map — modules by loop

Binding philosophy lives in `AGENTS.md` (three loops, machine vs coat, thin
Kernel, grammar modules). Domain nouns live in `CONTEXT.md`. This file maps
**code** onto that mental model so agents and humans navigate by loop, not by
alphabetical `src/` listing.

Status: living map. Update when a seam moves. Do not invent modules here that
do not exist.

> Module names below live in `build/**/*.mjs`, emitted from the typed
> `src/**/*.ts` sources (edit `src/`, never `build/`).

## Compile loop

Declaration → compiled Entity (handlers, DDL, auth, effects, schedules, routes).

The normal `src/entity/compile.ts` compiler is the canonical/default Entity
path, including its built-in CRUD handlers. `src/entity/codegen-crud.ts` is an
opt-in CRUD-only alternative for applications that explicitly register its
surface; it composes the same action, authorization, commit, and projection
pipeline and is not a second write authority. Its coverage and byte-level
parity contract are pinned by [entity-codegen-crud-parity.test.mjs](../test/entity-codegen-crud-parity.test.mjs).

| Module | Role |
| --- | --- |
| `entity/compile.mjs` | Orchestrates compile |
| `entity/crud.mjs` | Lifecycle action handlers |
| `entity/codegen-crud.mjs` | Opt-in CRUD-only action/event/handler derivation; assignment-covered kinds only |
| `entity/projection.mjs` | Entity-as-projection consumer |
| `entity/query.mjs` | Ambient find/query surface |
| `field.mjs` | Field constructors |
| `field-strategy.mjs` | Kind → validate/apply/diff |
| `side-table-strategy.mjs` | map / ordered / log / ephemeral |
| `field-laws.mjs` | Undoability vocabulary |
| `grant.mjs` / `scope.mjs` | Grant declaration surface |
| `scope-sql.mjs` / `check.mjs` / `registry.mjs` / `authz.mjs` | Check registry + SQL harvest |
| `row-grant.mjs` | Runtime mayRow / mayVerb / mayFieldOp |
| `route-gate.mjs` | Route admission gates |
| `owner.mjs` | Auth sugar over the same engine |
| `effect-compiler.mjs` | In-txn effects compile + execute |
| `schedule.mjs` (constructors) | schedule/tick declaration |
| `ddl.mjs` | Table generation |
| `event-handle.mjs` | Event type grammar |
| `principal.mjs` | Closed principal kinds |

## Commit loop

Action → authorize → handler → `_Log` append → projection (+ in-txn effects).

| Module | Role |
| --- | --- |
| `pipeline.mjs` | `createServer`, durable variant, `createClient` |
| `kernel.mjs` | Thin Compile/Commit assembly + engaged consumers |
| `protected-artefact-store.mjs` | Transaction-bound write/erase authority over declared protected app tables |
| `application-table-guard.mjs` | Shared table-safety guard for erasure + protected-artefact capabilities |
| `application-runtime.mjs` | Singular headless/HTTP start, recovery, maintenance, clocks |
| `committed-log.mjs` / `cursor.mjs` / `durable-history.mjs` | Log, seq storage, authorized history reads + session undo cursors |
| `scope-handle.mjs` | Scope key grammar |
| `write-queue.mjs` | Single-writer serialization |
| `driver.mjs` / `migrations.mjs` | SQLite engagement |
| `blob-lifecycle.mjs` (in-txn adopt) | Blob adopt atomic with commit |
| `post-commit-effects.mjs` (declaration) | Immutable private fact + ordered external-work declarations atomic with commit |
| `action-authorization.mjs` | Multi-row action admission through existing row grants/check registry |

## Deliver loop

Post-commit → re-auth → wire → client Replay decision → fold.

| Module | Role |
| --- | --- |
| `query-scoped-read.mjs` | Authorized query pages over compiled grants (`scopeFilter` + keyset) with `_CommittedRevision` tokens and invalidation/refetch signals — not a second auth or write path (ADR-0009, #225) |
| `live-delivery.mjs` | Framework WebSocket seam `createWebSocketLiveDelivery` → `{ count, close, createConsumer, wake }` (stateful delta/reducer envelopes) |
| `live-delivery-public.mjs` | Transport-neutral committed seam `createOwnedLiveDelivery` (public `createLiveDelivery` via `./server`) — stateless recipient envelopes |
| `live-connection.mjs` / `live-admission.mjs` / `live-fanout.mjs` | Private impl of the seam (conn / subscribe auth / fan-out) |
| `websocket.mjs` | Framing |
| `field-delta.mjs` / `field-pace.mjs` | Delta + pace |
| `replay-decision.mjs` | Pure dup/next/gap (also embedded in client) |
| `projected-async.mjs` / `durable-effects.mjs` / `email-seam.mjs` | Other post-commit consumers |
| `blob-lifecycle.mjs` (finalize consumer) | Post-commit blob rename |
| `schedule.mjs` (`startClockTriggers`) | Time → dispatch (feeds commit) |
| `public/workbench-client.mjs` | LiveChannel / LiveList / store |

## HTTP presentation (skin on compile + commit)

Not a fourth loop — transport over the machine.

| Module | Role |
| --- | --- |
| `app.mjs` | Two-phase declaration plus singular `start()` / transport selection |
| `serve.mjs` | HTTP server, CSRF, live transport attachment |
| `http-crud-dispatch.mjs` | CRUD → kernel.dispatch |
| `http-framework-routes.mjs` | snapshot / events-since / blobs / jobs / SDK |
| `http-body.mjs` / `http-response*.mjs` / `http-route-match.mjs` / `http-handler-chain.mjs` | Leaf HTTP utilities |
| `middleware.mjs` / `rate-limit.mjs` / `lifecycle.mjs` / `config.mjs` | HTTP policy and process shutdown |

One deliberate exception: `app.use(prefix, fn)` prefix intercepts (router.ts
`kind: 'handler'`, serve.mjs intercept chain) run before `matchRoute`, so
neither default-on auth layer applies — no route gate (`requireUser`), no row
grant (`mayRow`/`mayVerb`). The handler receives the principal
(`principalOf(req)`) but admission is entirely the app author's job: this is
the intentional app-author escape hatch, not a silent default-on gap. CSRF and
security headers still apply — both run earlier in serve.mjs's `handle()`.

## Coat (known-app seams on the machine)

Auth product lives under **`src/auth/`** (directory packaging, S3). Compile-loop
authorization (`authz.mjs`, `scope-sql`, `row-grant`) stays outside this folder.

| Module | Role |
| --- | --- |
| `auth/entities.mjs` / `auth/routes.mjs` / `auth/session.mjs` | User, Session, login routes, cookie principal |
| `auth/passkey.mjs` / `auth/totp.mjs` / `auth/invitation.mjs` | Auth product |
| `auth/membership.mjs` | Two-plane membership sugar |
| `auth/index.mjs` | Coat barrel |
| `job-queue.mjs` | Worker claim/lease board |
| `post-commit-effects.mjs` (runner) | Fenced app-owned claim/complete/fail for declared external work; never executes I/O |
| `blob-store.mjs` | Blob bytes |
| `public/workbench-local-*.mjs` | Local log / cross-tab (**demand-gated** — S6) |

## Annotated text (field kind across loops)

Product-facing contract: [`annotated-text.md`](./annotated-text.md).
Public wire vs internal durable versions:
[`annotated-text-public-v9-operated-lattice.md`](./annotated-text-public-v9-operated-lattice.md).
RGA grammar: [`adr/0005-annotated-text-kernel.md`](./adr/0005-annotated-text-kernel.md).

## Structural rules of thumb

1. Prefer navigating by **loop**, not by file prefix count.
2. New code: name which loop it serves before writing it.
3. If it does not serve a loop and is not coat/ops/grammar — deletion-test it.
4. Do not “deepen” HTTP leaves or further split Entity without a clearer
   runtime story (parked; see DECISIONLOG).
