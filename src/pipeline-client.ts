import { decideReplay } from './replay-decision.ts';

// createClient({ events }) — the client-side reconciliation path (SPEC §7 stage
// 7, §7.1). `ingest` is the ONLY place an event becomes client state: it folds
// each event through its declared reducer exactly once and advances a per-scope
// sequence cursor. The same ingest handles the client's own echoed events and
// foreign live events — there is no second apply path (AGENTS.md, one
// reconciliation path).
//
// Replay decision is shared with LiveList via `decideReplay` (span-aware):
//  - duplicate — idempotent skip; no fold, cursor unchanged.
//  - gap       — do NOT apply; signal a resync.
//  - next      — reduce once, advance the cursor to span hi.
export function createClient({ events = [] }: { events?: Array<{ type: string; reduce: (state: any, payload: any) => any }> } = {}) {
  // Reducer registry, keyed by event type. An event type with no reducer here
  // has nothing to fold — ingesting it is an error, not a silent drop.
  const reducers = new Map(events.map((e) => [e.type, e.reduce]));

  const states = new Map();   // scope → folded state
  const cursors = new Map();  // scope → last applied sequence number

  const cursor = (scope: any) => cursors.get(scope) ?? 0;
  const state = (scope: any) => states.get(scope);

  // Bootstrap: adopt a snapshot and set the cursor to the snapshot's sequence
  // BEFORE any live event is ingested. Ordering is load-bearing — a live event
  // ingested before the snapshot would resync into an empty state and then be
  // overwritten, losing the event (SPEC §7.1).
  function bootstrap(scope: any, snapshot: any, seq: any) {
    states.set(scope, snapshot);
    cursors.set(scope, seq);
  }

  function ingest(incoming: any) {
    const { type, scope, seq, seqSpan } = incoming;
    const reduce = reducers.get(type);
    if (typeof reduce !== 'function') {
      throw new Error(
        `no reducer for event type '${type}'. The client can only ingest event ` +
          `types it was created with. Declare event('${type}', reduce) and pass ` +
          `it in createClient({ events }).`,
      );
    }

    const decision = decideReplay(cursor(scope), seqSpan ?? seq);
    if (decision.kind === 'duplicate') {
      return { applied: false, duplicate: true };
    }
    if (decision.kind === 'gap') {
      return { applied: false, resync: true };
    }

    // next — fold exactly once and advance the cursor to span hi.
    states.set(scope, reduce(state(scope) ?? {}, incoming));
    cursors.set(scope, decision.cursor);
    return { applied: true };
  }

  return { ingest, bootstrap, state, cursor };
}
