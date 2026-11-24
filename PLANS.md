# PLANS.md — archive pointer

The historical execution ledger was moved to [`docs/archive/PLANS.md`](docs/archive/PLANS.md)
(213 KB). It records plans and status as they stood at the time; it is not the current plan.

**Agent rule:** never read the archive whole into context. Search it on demand, then read only
the matching section:

```sh
grep -n "wave or topic" docs/archive/PLANS.md
```

Live work is tracked in GitHub Issues (see `docs/agents/issue-tracker.md`); current design
contracts are `AGENTS.md`, `CONTEXT.md`, `docs/adr/`, and `docs/architecture-map.md`.
`docs/AGENT-QUICKSTART.md` is the 1-page entrypoint. Open the archive only to trace how an
older plan step was sequenced.
