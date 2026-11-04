# workbench

*Workbench for collaborative, persisted, realtime data.*

workbench is to collaborative, persisted, realtime apps what Express is to
request/response apps. Declare your entities, their authorization, and their
reactions; the framework owns the REST routes, the WebSocket live stream, the
event log, the reducers, optimistic UI, gap recovery, and client sync.

Structurally it is a **small machine** (compile → commit → deliver) wearing a
**known-app coat** (auth product, jobs, blobs, UI). See `AGENTS.md` and
`docs/architecture-map.md`.

## Status

**Implemented.** Zero runtime dependencies — Node 24.10+ (26 recommended):
`node:http`, `node:crypto`, `node:sqlite`, `node:fs`. Suite: `npm test`.

## Quick start

**Full guide:** **[docs/quickstart.md](docs/quickstart.md)**

```sh
# Minimal Note API (curl)
node examples/minimal-note.mjs
# → http://127.0.0.1:3456  — POST /notes {"title":"hello"}

# Chat sample (two browser tabs, live sync)
node projects/chat/server.mjs
# → http://localhost:3000
```

```sh
npm test                 # full suite
npm run test:coverage    # suite + Node experimental coverage
npm run bench             # compile/commit/deliver performance report
```

## Functionality reference

**Public API (what apps import):** **[docs/functionality.md](docs/functionality.md)**

Covers entities and fields, grants, app mount/listen, live client
(`workbench/client`), and optional seams (auth product, jobs, blobs, effects,
schedule/tick, email).

## Documents

| Document | Job |
| --- | --- |
| **[docs/quickstart.md](docs/quickstart.md)** | **Start here** — prereqs, minimal app, chat sample |
| **[docs/functionality.md](docs/functionality.md)** | **Public API reference** — intended library functionality for apps |
| **[AGENTS.md](AGENTS.md)** | Binding design values (naming, architecture, auth, live) |
| **[CONTEXT.md](CONTEXT.md)** | Domain glossary (Entity, Grant, Scope handle, Kernel, …) |
| **[docs/architecture-map.md](docs/architecture-map.md)** | Modules mapped to compile / commit / deliver |
| **[docs/semantic-operations.md](docs/semantic-operations.md)** | Required durable programming model: Actions, semantic operations, projections, compensation, snapshots |
| **[docs/durable-history-contract.md](docs/durable-history-contract.md)** | Durable history and collaborative-compensation contract |
| **[docs/performance-benchmarks.md](docs/performance-benchmarks.md)** | Repeatable performance workloads, reports, and regression comparison |
| **[docs/performance-results.md](docs/performance-results.md)** | Latest generated benchmark parameters and runtime reference |
| **[SPEC.md](SPEC.md)** | Long-form specification (some historical roadmap wording remains) |
| **[DECISIONLOG.md](DECISIONLOG.md)** | Append-only decision ledger |
| **[docs/adr/](docs/adr/)** | Numbered ADRs for settled seams |
| **[PLANS.md](PLANS.md)** | Historical execution ledger |
| **[SCOPE-FINDINGS.md](SCOPE-FINDINGS.md)** | What the shipped Scope app proved |
| **[projects/STRESS-TEST-FINDINGS.md](projects/STRESS-TEST-FINDINGS.md)** | Stress-test app synthesis |

## Package entry points

| Import | Purpose |
| --- | --- |
| `workbench` | Server public API (`build/index.mjs`) |
| `workbench/client` | Browser SDK (`public/workbench-client.mjs`) |
| `workbench/server` | Server-only helpers for sessions, jobs, blobs, and migrations |

## Consumers

Scope installs this package as an immutable git-SHA tarball; the version must
agree with the lockfile (see Scope's `scripts/verify-workbench-pin.mjs`). Bump
version + changelog on every public-surface change.

## Examples

| Path | What |
| --- | --- |
| `examples/minimal-note.mjs` | Smallest curl-friendly CRUD app |
| `projects/chat/server.mjs` | Auth + live multi-tab chat |
| `projects/todo-app.mjs` | Todo CRUD demo |
| `projects/*` | Stress-test / exemplar apps |
