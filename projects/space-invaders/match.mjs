// match.mjs — Space Invaders multiplayer match entity.
// Expresses an authoritative-server real-time arcade game in the grilled
// workbench API. Demonstrates: the state machine (lobby → playing →
// gameover), map-valued player roster, grant with scope + can (player vs
// spectator), declarative effects, and aspirational constructs (tick, grid,
// list, entity TTL, subscriber interest).
//
// Where a construct does not yet exist in the API surface, the code imports
// it from 'workbench' as an idealized handle and documents the gap.
import { entity, text, number, date, ref, map, state, grant, deny as _deny, read, write, subscribe, anyOf, never as _never, scope, now, everyone, self } from 'workbench';

// ────────────────────────────────────────────────────────────────────────────
// Capability bundles — typed, imported, never strings.
// ────────────────────────────────────────────────────────────────────────────
const PLAYER   = [read, write, subscribe];
const SPECTATOR = [read, subscribe];

// ────────────────────────────────────────────────────────────────────────────
// Match entity — the authoritative game session.
// ────────────────────────────────────────────────────────────────────────────
export const Match = entity('Match', {
    // ── persisted fields ────────────────────────────────────────────────────
  phase: state({
    values: ['lobby', 'playing', 'gameover'],
    transitions: {
      lobby:    ['playing'],
      playing:  ['gameover'],
      gameover: [],                      // terminal — no transitions out
    },
    effects: {
      // When the game ends by tick detection, record the timestamp. No
      // `mutate` target → the engine writes self (the row exists → set), the
      // same { with }-only self-write shape doc.mjs uses for archivedAt.
      [state.transition('playing', 'gameover')]: { with: { endedAt: now } },
    },
    // NOTE: no `auto` here — the authoritative tick (not a one-shot timer)
    // drives the phase transition when all invaders are dead or all players
    // have lost. `state.auto` is a field-level single-fire timer; we need a
    // recurring tick construct for the game loop.
  }).can(async ({ is }) =>
    // Only the tick/system principal may advance phases. Players read.
    (await is.owner()) ? grant(PLAYER) : grant(read)),

  score:        number({ default: 0 }),
  maxPlayers:   number({ default: 4, validate: (v) => v <= 8 || 'max 8 players' }),
  createdAt:    date({ default: () => new Date() }),
  endedAt:      date({ optional: true }),

  // ── player roster — typed map with per-player ship state ────────────────
  // Players join/leave; each carries their ship x-position and lives.
  players: map(ref('User'), {
    x:      number({ default: 0 }),       // ship x-position
    lives:  number({ default: 3 }),
    score:  number({ default: 0 }),
  }).can(async ({ is }) =>
    // RESOLVED: server-authority is the field-plugin operator/authority
    // model (SPEC §5.1/§9.2, ADR #13). The `players` map exports operators
    // that bound which principals may write which sub-fields — the tick
    // principal (a bounded scheduler, SPEC §10, ADR #10) writes ship
    // positions; players join/leave the roster. No special `authority`
    // flag — the field plugin owns the contract.
    (await is.player()) ? grant(read, write) : grant(read)),

  // ── shared ephemeral game state (aspirational field types) ─────────────
  // GAP: grid() does not exist in the field-type catalog.
  // GAP: list() does not exist in the field-type catalog.
  // GAP: no field persistence strategy `ephemeral` is shown in the API.
  //
  // Ideal form:
  //   invaders:    grid({ cols: 11, rows: 5 }),        // delta-broadcast, ephemeral
  //   projectiles: list({ max: 50, item: { x: number, y: number, dy: 1|-1, owner: ref('User') } }),
  //
  // Current workaround: serialize to text (full-value broadcast, writes to
  // DB every frame — catastrophic at 30 Hz).
  invaders:     text({ default: '[]' }),   // JSON grid — NOT ephemeral, NOT delta
  projectiles:  text({ default: '[]' }),   // JSON list — same problems

  // ── checks — plain functions, facts about a row ───────────────────────────,
  checks: {
    // Auto-derived from `players` map: checks.player = ({ Match, principal }) =>
    //   Match.players.has(principal.id)
    // Explicit here only for clarity.
    player: ({ Match, principal }) => Match.players.has(principal.id),
  },

  // ── grant — scope (SQL-compilable read admission) + can (runtime write) ───
  // No third method. Live delivery = re-auth-at-emit (latched) + subscriber
  // interest (narrowing filter at subscribe time).
  grant: () => [
    // scope: who may READ this match row?
    // RESOLVED: `everyone()` compiles to SQL TRUE (SPEC §6.2, ADR #11) —
    // the match is world-readable (players, authenticated spectators,
    // and anonymous visitors via the per-verb route gate). The old
    // `publicRead` entity flag is DEAD; `everyone()` is the real mechanism,
    // NULL-safe and symmetric to `never()` = SQL FALSE.
    //
    // anonymous access is gated on the entity (SPEC §6.2):
    //   gate: { list: allowAnonymous(), create: requireUser() }
    // The row grant runs on every verb regardless — two layers, no gap.
    scope(({ is }) => anyOf(is.player(), everyone()))
      .can(async ({ is }) => {
        if (await is.player()) return grant(...PLAYER);
        // Spectator (read+subscribe only) — admitted by `everyone()` scope.
        // The .can runs on every verb; write is denied for non-players.
        return grant(...SPECTATOR);
      }),
  ],

  // ── effects ────────────────────────────────────────────────────────────────
  // RESOLVED: `when` guards carry typed predicates over delta+origin
  // (SPEC §9.2, ADR #13). The auto-start effect fires only when the roster
  // is full — a non-compilable `when` is a load-time error, same discipline
  // as a non-compilable `scope`.
  effects: (Match) => [
    [Match.players.added, {
      mutate: self,
      with: { phase: 'playing' },
      when: ({ origin }) => origin.players.size >= origin.maxPlayers,
    }],
  ],

  // ── tick (aspirational) ────────────────────────────────────────────────────
  // GAP: entity-level tick construct exists in the plan (Phase 2 item 9) but
  // the API surface is not defined. The plan says: "recurring, lifecycle-bound
  // to state transitions, through the pipeline, system principal."
  //
  // Ideal form:
  //   tick: {
  //     rate: 30,                            // Hz
  //     when: 'playing',                      // lifecycle-bound to phase
  //     handler(match, dt, queuedActions) {
  //       // Move invaders: shift-right until edge, then drop+reverse.
  //       // Advance projectiles: move by dy each tick.
  //       // Check collisions: projectile vs invader, invader vs ground.
  //       // Apply queued player input: move ship, fire bullet.
  //       // If all invaders dead → match.phase = 'gameover'.
  //       // If all players dead → match.phase = 'gameover'.
  //
  //       // Mutations flow through the pipeline: diffs computed, deltas
  //       // broadcast, ephemeral fields skipped for DB, latch re-auth
  //       // checked once at subscribe-time.
  //
  //       match.invaders = nextInvaders;
  //       match.projectiles = nextProjectiles;
  //       // players map is also mutated (ship positions, lives, score)
  //     },
  //   },

  // ── entity TTL (aspirational) ──────────────────────────────────────────────
  // GAP: entity TTL is in Phase 3 (item 16). No API surface shown.
  //
  // Ideal form:
  //   ttl: '5m',      // auto-delete 5 min after creation
  // OR for truly ephemeral (no DB row):
  //   persist: false,  // entire entity in-memory only,

  routes: (r, _Match) => {
    r.resource();                                // CRUD through grant

    // ── player actions (aspirational RPC) ────────────────────────────────────
    // GAP: no `actions` block in the API. The plan says intents are mutations
    // with server-authored `apply` (authority: 'server' operators), but the
    // API surface is not shown.
    //
    // Current workaround: raw POST routes with opaque JSON payloads, validated
    // in the handler, queued into the tick's pending-input array.
    r.post('/:matchId/move', async (req, res) => {
      const { direction: _direction } = req.body;            // -1, 0, or 1
      // GAP: no typed validation — direction is any value
      // GAP: no queue into the tick — must use a side channel (in-memory map)
      res.json({ queued: true });
    });
    r.post('/:matchId/fire', async (req, res) => {
      // GAP: same problems — no typed action schema, no tick integration
      res.json({ queued: true });
    });
  },

  // ── subscriber interest (aspirational) ─────────────────────────────────────
  // GRILED DESIGN: interest is a narrowing filter, data-not-code, validated
  // at subscribe time, indexable. The API surface is not exemplified.
  //
  // For Space Invaders, a spectator in the lobby would subscribe with:
  //   match.subscribe({ interest: { fields: ['phase', 'players'] } })
  // A player in-game would subscribe with:
  //   match.subscribe({ interest: { fields: ['invaders', 'projectiles', 'players'] } })
  // The server uses interest to limit what it emits to each subscriber.
  //
  // Without interest, every tick mutation is broadcast to every subscriber
  // regardless of whether they need it. At 30 Hz × 100 lobby spectators ×
  // full game state, this is a firehose.
});
