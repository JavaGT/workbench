# Agent quickstart (flash tier)

Read this page first. It is the 1-page map: entrypoints → invariants → checks → delivery flow.
Follow links for depth; never load the archived history logs whole.

## Entrypoints

| Want | Start here | Notes |
| --- | --- | --- |
| App API (`workbench`) | `src/index.ts` → `build/index.mjs` | entity/field/grant declarations; `workbench({ db })` |
| Server helpers (`workbench/server`) | `src/server.ts` → `build/server.mjs` | sessions, jobs, blobs, migrations, live delivery |
| Browser SDK (`workbench/client`) | `public/workbench-client.mjs` | zero-import LiveChannel / LiveList / store |
| UI bindings | `public/workbench-ui-bindings.mjs` | read-only reactive projections over the SDK |
| Annotated text | `src/annotated-text*.ts`; `package.json` `exports` | 3 surfaces: `annotated-text`, `-coords`, `-authoring` (coords in `public/`) |
| Where a module fits | `docs/architecture-map.md` | compile / commit / deliver / coat |

`src/**/*.ts` is authored. `build/**/*.mjs` is emitted by `pnpm build` — never hand-edit it.
The hand-maintained browser surface is `public/**/*.mjs`.

## Core invariants (do not break)

1. **Single-writer SQLite.** All durable writes go through the one coordinator
   (`app.writeCoordinator`, backed by `src/write-queue.ts`) over the SQLite driver
   (`src/driver.ts`, `src/sqlite-driver.ts`). No second write path, no direct app writes.
2. **Fail-closed authorization.** Route gate + row gate are on by default; grants are
   functions, allowlists only. Every transport and live event re-authorizes through the ONE
   check registry. Never add a magic-word or parallel auth path. In application handlers
   prefer `Entity.findByIdFor(id, principal)` / `Entity.findAllFor(principal, where?)`;
   unscoped `findAll()` / `findById()` are trusted internal primitives that bypass read
   authorization and field projection.
3. **Singular system.** One way per thing: no second machine (write path, auth engine, fold),
   no second reconciliation path. A new general mechanism retires the special case it
   generalizes in the same change.
4. **Three loops.** Compile → Commit → Deliver. Name the loop a module serves; coat/ops are
   allowed, a second machine is not. Events are committed facts; reducers project state.
5. **Grammar modules are load-bearing.** Event handle, Scope handle, Replay decision own
   identity/cursor parsing — no ad-hoc `indexOf(':')`, dotted-string parse, or dup/gap logic.
6. **No magic strings** for fields, events, or handles. Relations are typed foreign keys.
7. **Keep files small.** New authored files under `src/` and `public/` are <= 500 lines;
   `scripts/check-file-sizes.mjs` ratchets legacy big files — never add a baseline entry.
8. **Defaults belong to the framework.** Transports are skins; out-of-band effects are
   post-commit projections, not in-transaction work.

## Verification

Run from the lane worktree:

| Command | When |
| --- | --- |
| `pnpm build` | after any `src/**/*.ts` change (regenerates `build/`) |
| `pnpm verify:concise` | full gate at wave-close / release: lint, typecheck, browser typecheck, all `check:*`, full test suite |
| `pnpm test:bun` | Bun driver / WebSocket parity tests |
| `pnpm check:dep-graph` | dependency direction: browser purity, SQL ownership, import-cycle ratchet |
| `pnpm check:file-sizes` | 500-line ceiling and legacy-file ratchet |
| `pnpm check:dts-parity` | runtime exports match published `.d.ts` surfaces |

While iterating: `node --test test/<file>.test.mjs`. Green gates and the exact commit SHA are
the evidence — not a claim that it works.

## Workflow: RPI → Lane → Adversarial P0/P1 sign-off

1. **Research (read-only).** Read `CONTEXT.md`, `docs/adr/`, `docs/architecture-map.md`, and
   relevant issues. Grep archived logs only for a specific decision; never read them whole.
2. **Plan.** State the loop, invariants touched, exact files, and checks. Reject a second path
   before writing code. If several known gaps are prerequisites, sequence them and start.
3. **Implement in a lane.** From the checkout run `pnpm lanes create <name> --owns <path>...`.
   Edit only owned paths; `pnpm build`; run focused checks and commit each milestone; run
   `pnpm verify:concise` at wave-close/release (it includes the full suite). If ownership must
   grow, `pnpm lanes extend <name> --owns <path>...` first. See `docs/agents/lane-delivery.md`.
4. **Adversarial P0/P1 sign-off before merging.** A fresh, read-only reviewer (no author
   context) reviews the complete diff against these invariants, reruns the checks, and writes
   findings as P0 (blocking), P1 (must fix before merge), P2 (follow-up). Merge only with zero
   P0/P1, on the verified SHA, via the lane integration path — never a silent merge.
5. **Handoff.** Push `lane/<name>`, open a draft PR (or owner-authorized fast-forward), verify
   the integrated SHA, then `pnpm lanes close <name> --reason "..."`.

## Where to look next

`AGENTS.md` (binding rules) · `CONTEXT.md` (vocabulary) · `docs/adr/` (decisions) ·
`docs/architecture-map.md` (code map) · `docs/quickstart.md` (run an app) ·
`docs/agents/issue-tracker.md` (specs/issues). History: `docs/archive/DECISIONLOG.md`,
`docs/archive/PLANS.md` — grep only, never load whole.
