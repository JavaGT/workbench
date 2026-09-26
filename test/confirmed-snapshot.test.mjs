// confirmedSnapshot — the pre-projection view.
//
// Everything below drives the REAL createLiveDeliverySession from the public
// browser surface — bootstrap, dispatch, deliver — against a scripted host.
// No harness shortcuts into internals.
//
// The invariant under test: `snapshot` is the MERGED view (confirmed base plus
// every pending operation's optimistic projection) while `confirmedSnapshot`
// is the pre-projection base. A consumer that must know whether a row is
// CONFIRMED rather than merely PROJECTED reads `confirmedSnapshot`; from the
// merged view alone the two are indistinguishable, which is how a reconciler
// retires an optimistic record before its settlement is known.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLiveDeliverySession } from '../public/workbench-client.mjs';

/** A `{ notes: { [id]: { id, title } } }` session whose pending `note.create` is projected. */
async function makeSession() {
  const probe = { deliver: null };
  const session = createLiveDeliverySession({
    bootstrap: async (request) =>
      request.mode === 'snapshot'
        ? { kind: 'snapshot', snapshot: { notes: {} }, cursor: 1 }
        : { kind: 'catchup', envelopes: [], cursor: request.after },
    subscribe: async (input) => {
      probe.deliver = (envelopes) => Promise.resolve(input.deliver(envelopes));
      return { close() {} };
    },
    validateSnapshot: (value) => value,
    fold: (snapshot) => snapshot,
    // The projection: an in-flight create is visible in the MERGED view only.
    optimistic: (snapshot, action) => {
      if (action.type !== 'note.create') return snapshot;
      const id = action.payload.id;
      return { ...snapshot, notes: { ...snapshot.notes, [id]: { id, title: action.payload.title } } };
    },
    sendAction: async () => ({ ok: true, status: 'committed' }),
  });
  await session.ready;
  return { session, probe };
}

/** An authoritative full-state replacement — the simplest ingest path. */
function stateEnvelope(notes, seq) {
  return { type: 'state', state: { notes }, seqSpan: [seq, seq] };
}

test('confirmedSnapshot omits a projected row that snapshot already shows', async () => {
  const { session } = await makeSession();

  const dispatched = await session.dispatch('note.create', { id: 'n1', title: 'Optimistic title' });
  assert.equal(dispatched.ok, true, 'dispatch is accepted — committed, not yet confirmed');

  assert.equal(
    session.snapshot?.notes?.n1?.title,
    'Optimistic title',
    'merged view projects the pending row'
  );
  assert.equal(
    session.confirmedSnapshot?.notes?.n1,
    undefined,
    'pre-projection view must NOT contain the pending row'
  );
  assert.deepEqual(session.confirmedSnapshot?.notes ?? {}, {}, 'the confirmed base is untouched while an op is in flight');

  session.close();
});

test('both views converge once authoritative state lands', async () => {
  const { session, probe } = await makeSession();
  await session.dispatch('note.create', { id: 'n1', title: 'Optimistic title' });

  await probe.deliver([stateEnvelope({ n1: { id: 'n1', title: 'Optimistic title' } }, 2)]);

  assert.equal(
    session.confirmedSnapshot?.notes?.n1?.title,
    'Optimistic title',
    'the confirmed base now carries the row ingest reported'
  );
  assert.equal(session.snapshot?.notes?.n1?.title, 'Optimistic title', 'the merged view agrees once nothing is pending');

  session.close();
});

test('a confirmed row stays in both views while a different op is pending', async () => {
  const { session, probe } = await makeSession();
  await probe.deliver([stateEnvelope({ kept: { id: 'kept', title: 'Confirmed' } }, 2)]);

  await session.dispatch('note.create', { id: 'n2', title: 'In flight' });

  assert.equal(session.confirmedSnapshot?.notes?.kept?.title, 'Confirmed', 'a confirmed row survives a pending sibling');
  assert.equal(session.snapshot?.notes?.kept?.title, 'Confirmed');
  assert.equal(session.confirmedSnapshot?.notes?.n2, undefined, 'the pending sibling is still only projected');
  assert.equal(session.snapshot?.notes?.n2?.title, 'In flight', 'but is visible in the merged view');

  session.close();
});

test('an authoritative correction is visible in the confirmed view, not just the merged one', async () => {
  const { session, probe } = await makeSession();
  await probe.deliver([stateEnvelope({ n1: { id: 'n1', title: 'Server title' } }, 2)]);
  await session.dispatch('note.create', { id: 'n2', title: 'In flight' });

  // The reconciled truth differs from what the pending op projected; only the
  // confirmed view can express that, which is why an id set is not enough.
  assert.equal(session.confirmedSnapshot?.notes?.n1?.title, 'Server title');
  assert.equal(session.snapshot?.notes?.n1?.title, 'Server title');

  session.close();
});
