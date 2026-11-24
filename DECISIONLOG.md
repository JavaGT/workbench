# DECISIONLOG.md — archive pointer

The full decision ledger was moved to [`docs/archive/DECISIONLOG.md`](docs/archive/DECISIONLOG.md)
(337 KB, hundreds of entries). It is historical reasoning, not active guidance.

**Agent rule:** never read the archive whole into context. Search it on demand, then read only
the matching section:

```sh
grep -n "exact phrase" docs/archive/DECISIONLOG.md
```

Current, binding direction lives in `AGENTS.md` (design rules), `CONTEXT.md` (domain nouns),
`docs/adr/` (accepted decisions), and `docs/architecture-map.md` (module-to-loop map).
`docs/AGENT-QUICKSTART.md` is the 1-page entrypoint. Open the archive only to trace why a
specific historical decision was made.
