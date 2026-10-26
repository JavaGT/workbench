# Scope-origin package specifications: reconciliation

Reviewed 2026-10-01 against Workbench HEAD `a777b9529856118a2da424a6b0606b83d05208cb`
and Scope's installed immutable package pin
`5efcbe162c555cd0edb0b357c4461b34c1821007`. The Workbench checkout contains
unrelated in-flight changes; this note does not certify them or advance Scope's pin.

The historical P2–P6 and W7 packets are preserved in Scope at
`wiki/archive/docs/`. Their `OPEN` headers describe the old program, not the
current package backlog. Workbench owns package requirements; Scope owns only
consumer integration. Reconcile a concrete remaining gap with the issue tracker
before starting implementation. This note records inspected API shape, not full
behavioral acceptance.

| Packet | Current evidence | Disposition |
| --- | --- | --- |
| P2 TypeScript-native | AGENTS.md owns authored `src/**/*.ts` and derived `build/**/*.mjs`; package exports target build output | Historical migration mechanics are superseded by the current source/emission contract; maintain that contract rather than restart P2 |
| P3 public/internal boundaries | package.json declares six explicit entrypoints; Scope's `check-workbench-seam.mjs` owns consumer boundary checks | Existing export and seam owners replace the old program packet; a missing particular boundary must be demonstrated against them |
| P4 optional annotated-text entry | `./annotated-text`, `./annotated-text-authoring`, and `./annotated-text-coords` exist on both inspected packages; `test/annotated-text-package-entry.test.mjs` covers entry behavior | Existence is settled; lazy/tree-shake guarantees require the owning package test, not an old unchecked checklist. Scope still uses root declaration exports, a consumer hygiene question rather than a package migration mandate |
| P5 diagnostics/explain | `src/explain.ts` and `test/explain.test.mjs` exist; inspection did not establish the old proposed closed client-visible taxonomy across every denial path | Preserve the packet as input; do not claim P5 complete or export its proposed codes as current API. A scoped public-diagnostics investigation is retained in [#233](https://github.com/JavaGT/workbench/issues/233), without implementation authorization |
| P6 history/membership/consumers | `durableHistory` and `operationalConsumer` export from the root; current durable-history docs own history policy | Current API/contract owners replace the stale procedural packet; compare any concrete residual requirement to the current contracts |
| W7 facades | `createHistoryReader` exports from `workbench/server`; consumers register through `workbench({ operationalConsumers: [...] })`; focused history-reader/consumer tests exist | Old proposed `readCommittedHistory` spelling is not the current API. Consumer registration/history already have owners; census and Scope private-table coverage remain the consumer seam gate's responsibility |

Read [architecture map](./architecture-map.md),
[durable history policy](./durable-history-policy.md), and
[durable history contract](./durable-history-contract.md) for current package
ownership. See `package.json` exports and the named tests for actual supported
entry points. Historical specifications are provenance, not a second current
requirements authority.
