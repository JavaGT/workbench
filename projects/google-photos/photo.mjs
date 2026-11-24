// photo.mjs — Google Photos clone: a media entity with blob storage,
// stored-derived thumbnails, structured EXIF, geo-location, full-text
// search, and link-share principals. Demonstrates where the grilled
// workbench API expresses each concept and where it hits a wall.
//
// IMPORTS: the framework exports we WISH existed are imported with a
// "MISSING" comment — these are the gaps this stress-test documents.
import { entity, text, number, date, ref, owner, link, map as _map, boolean, grant, deny, read, write, subscribe, admin, anyOf, never, scope, router as _router, User as _User, blob as _blob, projected as _projected, json as _json, list as _list } from 'workbench';
// Album must be declared before Photo: albumMember harvests
// Photo.album.collaborators (typed-FK → map.has) at entity() load time.
import { Album } from './album.mjs';

// ==========================================================================
// Capability sets
// ==========================================================================
const VIEWER  = [read, subscribe];
const EDITOR  = [read, write, subscribe];
const OWNER   = [read, write, subscribe, admin];

// ==========================================================================
// Photo entity — the core media item
// ==========================================================================
export const Photo = entity('Photo', {
    // ===================================================================
  // RESOLVED: blob field type is a built-in (SPEC §5.1, ADR #9)
  //
  // Binary storage is the primitive of a photo app — the original image
  // file IS the entity's reason for existing. No framework construct for:
  //   - streaming/multipart upload through the mutation pipeline
  //   - byte-level access control (the URL is gated; the bytes are not)
  //   - deduplication or replication of binary storage
  //   - content-type validation at the field level
  //
  // Real API (the field-type plugin contract provides):
  //   original: blob({ accept: ['image/*','video/*'], maxSize: '50MB' })
  //     .can(async ({ is }, defaults) =>
  //       (await is.owner() || await is.albumEditor()) ? defaults
  //         : deny('only owner may download original')),
  //
  // The `store` argument is the field-type persistence strategy — the
  // plugin owns it, the app does not hand-wire S3 keys.
  // ===================================================================
  blobUrl: text({ readonly: true }),

  // ===================================================================
  // RESOLVED: stored computed fields have two modes (SPEC §5.3, ADR #12)
  //
  // Thumbnails must be computed ASYNCHRONOUSLY (resize is external I/O),
  // ONCE on upload (not recomputed on every read), and PERSISTED + INDEXED
  // (so queries can use them). The grilled API has:
  //
  // The grilled `computed()` (synchronous read-time pull) and in-transaction
  // `{ mutate, with }` effects (cannot shell out to ImageMagick/sharp) were
  // the wrong primitives for async compute. The designed API provides:
  //
  //   - `computed({ compute })` — synchronous, recompute-on-read.
  //   - `projected.async` — post-commit projection over the committed log,
  //     with a sequence watermark and explicit staleness (SPEC §9.3, ADR #8).
  //     This IS the core upload workflow for a photo app.
  //
  // Real API (the designed projected.async primitive, SPEC §5.3):
  //   thumbnailSm: projected.async({
  //     from: 'original',
  //     compute: (blob) => sharp(blob).resize(400, 400, { fit: 'cover' }).toBuffer(),
  //   }),
  //   thumbnailLg: projected.async({
  //     from: 'original',
  //     compute: (blob) => sharp(blob).resize(1600, 1600, { fit: 'inside' }).toBuffer(),
  //   }),
  //
  // The projection principal (a bounded post-commit consumer, ADR #8)
  // is admitted by the target's own grant and runs on its own schedule.
  // No external job queue, no polling — the committed log is the source.
  // ===================================================================
  thumbnailSmUrl: text({ optional: true }),
  thumbnailLgUrl: text({ optional: true }),
  isProcessed: boolean({ default: false }),
  processingError: text({ optional: true }),

  // ===================================================================
  // RESOLVED: json(shape) is a built-in field type (SPEC §5.1, ADR #9)
  //
  // EXIF data is naturally structured: { iso, aperture, focalLength,
  // cameraModel, gpsLat, gpsLng, ... }. `json(shape)` provides:
  //   - a single typed sub-object, not 20+ flat fields
  //   - typed-handle access to individual keys
  //   - path-queryable via opt-in index (the json field is value-kind,
  //     with an index capability that compiles typed sub-key predicates)
  //
  // Real API:
  //   exif: json({
  //     iso: number(), aperture: number(), shutterSpeed: text(),
  //     focalLength: number(), cameraModel: text(), make: text(),
  //     lens: text(), flash: boolean(), orientation: number(),
  //     gpsLatitude: number(), gpsLongitude: number(),
  //     gpsAltitude: number(), dateTaken: date(),
  //   }),
  //
  // The flattened fields below are the workaround — still shown for
  // contrast, but the framework now provides the real primitive.
  // ===================================================================
  exifIso:           number({ optional: true }),
  exifAperture:      number({ optional: true }),
  exifShutterSpeed:  text({ optional: true }),
  exifFocalLength:   number({ optional: true }),
  exifCameraModel:   text({ optional: true }),
  exifMake:          text({ optional: true }),
  exifLens:          text({ optional: true }),
  exifFlash:         boolean({ optional: true }),
  exifOrientation:   number({ optional: true }),
  // GPS — DEFERRED: geo-point field + rtree engine deferred (SPEC §11);
  gpsLatitude:       number({ optional: true }),
  gpsLongitude:      number({ optional: true }),
  gpsAltitude:       number({ optional: true }),
  dateTaken:         date({ optional: true }),

  // ===================================================================
  // Core metadata — works fine with existing field types
  // ===================================================================
  caption:     text({ validate: (v) => v.length <= 5000 || 'caption too long' }),
  description: text(),
  filename:    text({ readonly: true }),
  mimeType:    text({ readonly: true }),
  fileSize:    number({ readonly: true }),

  // ===================================================================
  // Tags — RESOLVED: `list` field type built-in (SPEC §5.1, ADR #9)
  //
  // Real API:
  //   tags: list(text()),
  //
  // The comma-separated string below is the old workaround; `list` replaces it.
  // ===================================================================
  tags: text({ optional: true }),

  // ===================================================================
  // Ownership & relations — expressible with existing ref + link fields
  // ===================================================================
  owner: owner(),
  album: ref(Album, { optional: true }),

  // Link-share for direct photo links — the `link` field type handles
  // single-tier-per-link well. For per-member tiers (share with
  // multiple non-users at different tiers), see Album.linkShare
  // discussion in PAIN-POINTS.md.
  linkShare: link({ tiers: ['view', 'download'], tier: 'view', token: 'autogen' })
    .can(async ({ is }) =>
      (await is.owner()) ? grant(...OWNER) : deny('only owner may manage link sharing')),

  // ===================================================================
  // Dates — fully expressible
  // ===================================================================
  capturedAt: date({ optional: true }),
  uploadedAt: date({ default: () => new Date() }),
  updatedAt:  date({ touch: true }),

  // ==========================================================================
  // Checks
  // ==========================================================================,
  checks: {
    // `owner` is auto-derived from `owner: ref('User', { role: 'owner' })`
    // above (DECISIONLOG #54) and is NOT redeclared here — redeclaring a
    // ref-role-derived check name is a load-time error.

    // Cross-entity typed-FK traversal: asks "is principal a member of
    // this photo's album?" The authorization compiler must traverse
    // Photo.album → Album.collaborators. The grilled plan covers this
    // as abstraction #5 (typed-FK traversal in auth compiler), Phase 1.
    //
    // CAN this be in scope? It compiles to:
    //   EXISTS (SELECT 1 FROM album_collaborators ac
    //           WHERE ac.album_id = photo.album_id AND ac.user_id = ?)
    // That's a compilable subquery — should be fine IF typed-FK traversal
    // is implemented.
    albumMember: ({ Photo, principal }) => Photo.album.collaborators.has(principal.id),

    // Link holder — uses `never()` for non-link principals (compiles to
    // SQL FALSE, per ADR #7).
    linkHolder:  ({ Photo, principal }) =>
                   principal.type === 'link'
                     ? Photo.linkShare.token.is(principal.attributes?.token)
                     : never(),

    // ===================================================================
    // Runtime-only role lookups (CANNOT be in scope — would be load-time
    // error if placed there). These depend on per-member payload on the
    // Album.collaborators map. Used only in `.can`, not `scope`.
    //
    // SHARP EDGE: cross-entity role resolution. `Photo.album.collaborators
    // .get(principal.id)?.role` requires resolving the typed FK `album` to
    // the Album row first. The grilled design doesn't specify whether the
    // check's `{ entity }` context includes traversed FK fields at runtime.
    // ===================================================================
    albumEditor: ({ Photo, principal }) =>
                   Photo.album.collaborators.get(principal.id)?.role === 'editor'
                   || Photo.album.collaborators.get(principal.id)?.role === 'contributor',
    albumCoOwner: ({ Photo, principal }) =>
                    Photo.album.collaborators.get(principal.id)?.role === 'coOwner',
  },

  // ==========================================================================
  // Grant
  //
  // scope = who can READ (compiled to SQL WHERE)
  // .can  = every other capability (runtime, per-row)
  // ==========================================================================,
  grant: () => [
    scope(({ is }) => anyOf(is.owner(), is.albumMember(), is.linkHolder()))
      .can(async ({ is, entity }) => {
        if (await is.owner())         return grant(...OWNER);
        if (await is.albumCoOwner())  return grant(...OWNER);
        if (await is.albumEditor())   return grant(...EDITOR);
        if (await is.albumMember())   return grant(...VIEWER);
        if (await is.linkHolder()) {
          const tier = entity.linkShare.tier;
          return tier === 'download' ? grant(...EDITOR) : grant(...VIEWER);
        }
        return deny('no capability for this principal');
      }),
  ],

  // ==========================================================================
  // Effects — RESOLVED: out-of-band effects are projections over the committed log
  //
  // Thumbnail generation + EXIF extraction require external I/O (shelling
  // out to ImageMagick/sharp/exiftool). The grilled effects are
  // `{ mutate, with }` — in-transaction data mutations only. The designed API
  // splits effects on the atomicity boundary (SPEC §9.3, ADR #8):
  //
  //   - In-transaction `{ mutate, with }` — atomic with the origin,
  //     a target deny rolls the origin back (ADR #6).
  //   - Out-of-band — post-commit projections over the committed log,
  //     independently durable, retried on their own schedule, never
  //     rolling back the origin. This is the projection-consumer primitive
  //     that `projected.async` computed fields are the in-framework
  //     read-model case of (SPEC §5.3, ADR #12).
  //
  // The right primitive for thumbnail generation is `projected.async` — a
  // stored computed field updated by a post-commit projection with a
  // sequence watermark and explicit staleness. It is not an `effects` entry;
  // the field declaration (above) owns its own projection strategy.

  // ==========================================================================
  // Routes
  // ==========================================================================,
  routes: (r, Photo) => {
    r.resource();  // CRUD through grant

    // ===================================================================
    // GEO QUERY — deferred-engine: predicate seam ships (SPEC §11, ADR #15)
    //
    // The typed-handle predicate system has `.is(val)` (equality) and
    // `.has(id)` (set membership). `.near()` / `.within()` are index-gated
    // predicate plugins: the SEAM is part of the shipped query compiler
    // (so a geo query never degrades to raw SQL / a second query path),
    // but the actual rtree engine is deferred until google-photos is the
    // active spine. The `point` field type is also deferred-engine.
    //
    // Idealized API (predicate seam is designed; engine deferred):
    //   r.get('/nearby', async (req, res) => {
    //     const { lat, lng, radiusKm } = req.query;
    //     const photos = await Photo.findAll(
    //       Photo.location.near({ lat, lng, radiusKm })
    //         .and(Photo.owner.is(req.principal.id))
    //     ).sort(Photo.capturedAt, 'desc').limit(50);
    //     res.json(photos);
    //   });
    // ===================================================================

    // ===================================================================
    // FULL-TEXT SEARCH — deferred-engine: predicate seam ships (SPEC §11, ADR #15)
    //
    // `.match()` is an index-gated predicate plugin: the SEAM is part of
    // the shipped query compiler (so an FTS query never degrades to raw SQL
    // / a second query path), but the actual FTS engine is deferred until
    // google-photos is the active spine (build the seam, not the subsystem).
    //
    // Idealized API (predicate seam is designed; engine deferred):
    //   r.get('/search', async (req, res) => {
    //     const { q } = req.query;
    //     const photos = await Photo.findAll(
    //       Photo.searchIndex.match(q)
    //     ).sort(Photo.capturedAt, 'desc').limit(50);
    //     res.json(photos);
    //   });
    // ===================================================================

    // Date-range query — range predicates shipped (Scope-support Slice 4).
    r.get('/timeline', async (req, res) => {
      const { from, to } = req.query;
      const photos = await Photo.findAll(
        Photo.capturedAt.gte(new Date(from)).and(
        Photo.capturedAt.lte(new Date(to))),
      ).sort(Photo.capturedAt, 'desc');
      res.json(photos);
    });

    // Upload endpoint — blob is a built-in field type (SPEC §5.1, ADR #9).
    // Multipart upload flows through the mutation pipeline; the field-type
    // plugin owns the persistence strategy (streaming upload, content-type
    // validation, byte-level access control — not a hand-wired S3 URL).
    r.post('/upload', async (req, res) => {
      // RESOLVED: blob field type provides streaming multipart upload
      res.json({ note: 'upload via blob field-type plugin contract' });
    });
  },
});
