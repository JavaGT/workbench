// Focused Deliver-loop microbenchmarks.
//
// This intentionally exercises the package-private fan-out seam with the same
// re-authorization, delta projection, scope registry, and envelope construction
// used by the public live delivery path. It also measures the pure Replay
// decision independently, because the browser/client fold is a separate step.
//
// Usage: node bench/live-delivery.mjs
//
// stdout is one JSON line so a worker/lead can collect before/after numbers;
// progress is stderr. The fake connection only counts sends, keeping socket I/O
// out of the fan-out measurement while retaining recipient iteration and auth.

import { createLiveFanout } from '../build/live-fanout.mjs';
import { decideReplay } from '../build/replay-decision.mjs';
import { scope } from '../build/internal.mjs';

const WARMUP_EVENTS = 1_000;
const MEASURE_EVENTS = 10_000;
const REPLAY_WARMUP = 100_000;
const REPLAY_EVENTS = 5_000_000;
const SUBSCRIBER_COUNTS = [1, 32, 128];
const PASSES = 3;

function makeConnection(id) {
  return {
    id: `c${id}`,
    closed: false,
    principal: { type: 'user', id: `u${id}` },
    sent: 0,
    send() { this.sent++; },
  };
}

function makeEntity() {
  return {
    name: 'Doc',
    fields: {
      title: { kind: 'value' },
      count: { kind: 'value' },
    },
    grant: () => [scope().can(() => true)],
  };
}

function makeEvent(seq, count) {
  return {
    type: 'Doc.updated',
    scope: 'Doc:d1',
    seq,
    data: { count, title: `v${count}` },
  };
}

async function fanoutPass(subscriberCount, events) {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const connections = Array.from({ length: subscriberCount }, (_, index) => makeConnection(index));
  const entity = makeEntity();
  const row = { id: 'd1', title: 'initial', count: 0 };
  for (const connection of connections) fanout.addSubscription('Doc:d1', connection);

  // Seed the delta projector exactly as a create would before measuring update
  // delivery. The measured loop is then a steady-state committed update stream.
  await fanout.emit(entity, 'd1', row, {
    type: 'Doc.created', scope: 'Doc:d1', seq: 0, data: { id: 'd1' },
  });
  for (let index = 1; index <= events; index++) {
    await fanout.emit(entity, 'd1', { id: 'd1', title: `v${index}`, count: index }, makeEvent(index, index));
  }
  const sent = connections.reduce((total, connection) => total + connection.sent, 0);
  fanout.close();
  return sent;
}

async function bestFanout(subscriberCount) {
  for (let pass = 0; pass < PASSES; pass++) await fanoutPass(subscriberCount, WARMUP_EVENTS);
  let best = 0;
  let sent = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    const start = process.hrtime.bigint();
    sent = await fanoutPass(subscriberCount, MEASURE_EVENTS);
    const elapsed = Number(process.hrtime.bigint() - start);
    const ops = (MEASURE_EVENTS * 1e9) / elapsed;
    best = Math.max(best, ops);
    process.stderr.write(`fanout-${subscriberCount} pass ${pass + 1}/${PASSES}: ${ops.toFixed(0)} events/s\n`);
  }
  return { ops: best, sent };
}

function replayPass(events, span = false) {
  let cursor = 0;
  let checksum = 0;
  const seqSpan = [0, 0];
  for (let index = 1; index <= events; index++) {
    const seqOrSpan = span ? (seqSpan[0] = index, seqSpan[1] = index, seqSpan) : index;
    const verdict = decideReplay(cursor, seqOrSpan);
    if (verdict.kind === 'next') {
      cursor = verdict.cursor;
      checksum += cursor;
    } else {
      checksum++;
    }
  }
  return checksum + cursor;
}

function bestReplay(span = false) {
  for (let pass = 0; pass < 2; pass++) replayPass(REPLAY_WARMUP, span);
  let best = 0;
  let checksum = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    const start = process.hrtime.bigint();
    checksum = replayPass(REPLAY_EVENTS, span);
    const elapsed = Number(process.hrtime.bigint() - start);
    const ops = (REPLAY_EVENTS * 1e9) / elapsed;
    best = Math.max(best, ops);
    process.stderr.write(`replay${span ? '-span' : ''} pass ${pass + 1}/${PASSES}: ${ops.toFixed(0)} decisions/s\n`);
  }
  return { ops: best, checksum };
}

async function main() {
  const fanout = {};
  for (const count of SUBSCRIBER_COUNTS) fanout[count] = await bestFanout(count);
  const noSubscribers = await bestFanout(0);
  const replay = bestReplay();
  const replaySpan = bestReplay(true);
  const output = {
    workload: {
      fanout_events: MEASURE_EVENTS,
      fanout_subscribers: SUBSCRIBER_COUNTS,
      replay_decisions: REPLAY_EVENTS,
    },
    fanout_events_s: Object.fromEntries(
      SUBSCRIBER_COUNTS.map((count) => [count, Math.round(fanout[count].ops)]),
    ),
    fanout_messages: Object.fromEntries(
      SUBSCRIBER_COUNTS.map((count) => [count, fanout[count].sent]),
    ),
    fanout_no_subscribers_events_s: Math.round(noSubscribers.ops),
    replay_decisions_s: Math.round(replay.ops),
    replay_span_decisions_s: Math.round(replaySpan.ops),
    checksum: replay.checksum,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ error: error?.stack ?? String(error) })}\n`);
  process.exitCode = 1;
});
