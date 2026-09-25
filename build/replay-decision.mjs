// Seq cursor + Replay decision — pure duplicate / next / gap verdict from
// comparing an incoming seq span to a Seq cursor (CONTEXT.md / ADR program #4).
//
// Both createClient (server/test path) and LiveList (browser SDK) call this.
// Folds stay separate; only the decision is shared.
//
// Span-aware: a single seq is treated as [seq, seq]. Advance to hi on next.









const replaySpanScratch                 = [0, 0];

// Keep one parser/validator for both public normalization and the hot decision
// path. decideReplay is synchronous, so a private scratch pair avoids an
// allocation without exposing mutable state or introducing a second grammar.
function readSeqSpan(
  seqOrSpan                                               ,
  target                ,
)                 {
  if (Array.isArray(seqOrSpan) && seqOrSpan.length >= 2) {
    const lo = Number(seqOrSpan[0]);
    const hi = Number(seqOrSpan[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('seqSpan must be finite numbers');
    }
    target[0] = lo;
    target[1] = hi;
    return target;
  }
  const seq = Number(seqOrSpan);
  if (!Number.isFinite(seq)) {
    throw new Error('seq must be a finite number');
  }
  target[0] = seq;
  target[1] = seq;
  return target;
}

/** Normalize a seq or [lo, hi] span to a frozen [lo, hi] pair. */
export function normalizeSeqSpan(
  seqOrSpan                                               ,
)          {
  return readSeqSpan(seqOrSpan, [0, 0])                      ;
}

/**
 * Decide how an incoming event relates to the local Seq cursor.
 *
 * @param cursor - last applied sequence (0 before any event)
 * @param seqOrSpan - event seq or [lo, hi] span
 *
 * Defensive cursor coercion: a falsy cursor (`undefined`, `null`, `NaN`, `0`)
 * is treated as 0 via `Number(cursor) || 0`, so a missing or poisoned local
 * cursor falls back to "expected seq 1" — every finite event is a `duplicate`
 * rather than crashing. This coercion is load-bearing (the browser embed shares
 * it; the parity test blesses it). NOTE: `Infinity` is truthy and is NOT
 * coerced — an `Infinity` cursor makes every finite event a `duplicate`
 * indefinitely. That is a poisoned-cursor hazard, not a supported recovery
 * path; callers must never persist an `Infinity` cursor. The parity test does
 * not bless `Infinity` as expected behavior (it would freeze replay recovery).
 */
export function decideReplay(
  cursor        ,
  seqOrSpan                                               ,
)                 {
  readSeqSpan(seqOrSpan, replaySpanScratch);
  const lo = replaySpanScratch[0];
  const hi = replaySpanScratch[1];
  const expected = (Number(cursor) || 0) + 1;
  if (hi < expected) return { kind: 'duplicate' };
  if (lo > expected) return { kind: 'gap' };
  return { kind: 'next', cursor: hi };
}
