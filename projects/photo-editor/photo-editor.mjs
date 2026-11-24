// photo-editor.mjs — a shared collaborative photo editor (raster editing)
// expressed in the workbench API.
//
// This is a DESIGN STRESS-TEST, not production code. It declares entities
// for a Figma-for-photos app using the shipped API surface. Every construct
// below compiles against the current framework — gaps are called out
// explicitly.
//
// PERSONA: "The Pixel Pusher" — skeptical that a framework built around
// collaborative text CRDTs can handle collaborative raster editing, binary
// blob storage, ordered layer collections, and declarative render pipelines.
//
// Key facts respected:
//   - Auth = TWO questions (read a row, edit it). No hide()/visibility axis.
//   - `checks` are PLAIN functions. `scope(...)` declares read intent;
//     `.can(fn)` = every other capability. Exactly two halves.
//   - `scope` is the ONLY grant compiled to SQL.
//   - Field access always runtime `.can`. Field read-denial = `withheld`.
//   - Live delivery = re-auth-at-emit + subscriber interest.
//   - Effects = `{ mutate, with }`; in-transaction effect-principal reentrancy.
//   - NO DEFAULT GRANT: entity with no grant = LOAD-TIME ERROR.

import { entity, text, number, date, ref, owner, map, boolean, blob as _blob, raster, projected, ephemeral, grant, deny, read, write, subscribe, admin, anyOf, scope, never as _never, inherit, router } from 'workbench';

// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY BUNDLES — typed, imported, never strings.
// ═══════════════════════════════════════════════════════════════════════════════

const VIEWER  = [read, subscribe];
const EDITOR  = [read, write, subscribe];
const OWNER   = [read, write, subscribe, admin];

// ═══════════════════════════════════════════════════════════════════════════════
// Canvas — the top-level collaborative photo editing document.
// ═══════════════════════════════════════════════════════════════════════════════

export const Canvas = entity('Canvas', {
    title: text({
    validate: v => v.length <= 200 || 'title too long',
  }),

  width:  number({ default: 1920, min: 1, max: 8192 }),
  height: number({ default: 1080, min: 1, max: 8192 }),

  owner: owner(),

  collaborators: map(ref('User'), {
    role: ['viewer', 'editor'],
    default: {},
  }).can(async ({ is }) =>
    (await is.owner())
      ? grant(...OWNER)
      : deny('only the owner may manage collaborators')),

  // Shipped: projected.async (post-commit stored computed field).
  // Recomputes whenever the canvas or its layers change.
  export: projected.async({
    from: ['created', 'updated'],
    compute: async (canvas) => {
      const layers = await RasterLayer.findAll(
        RasterLayer.canvas.is(canvas.id),
      );
      layers.sort((a, b) => a.order - b.order);
      return compositeToPng(layers, canvas.width, canvas.height);
    },
  }),

  // DEFERRED: list(ref('RasterLayer')) for z-ordered layers.
  // The `list()` field type (fractional-index keyspace) ships with
  // insertAt/move/reorder. RasterLayer entities are standalone until
  // the list-of-entities variant is implemented.
  //
  // Shipped API (standalone entity workaround):
  //   RasterLayer entities with a `canvas` FK + `order: number()`.

  backgroundColor: text({ default: '#ffffff', max: 9 }),

  presence: ephemeral({ cursor: true }),

  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ touch: true }),

  checks: {
    collaborator: ({ Canvas: c, principal: p }) => c.collaborators.has(p.id),
    editor:       ({ entity, principal: p }) =>
                     entity.collaborators.get(p.id)?.role === 'editor',
    viewer:       ({ entity, principal: p }) =>
                     entity.collaborators.get(p.id)?.role === 'viewer',
  },

  grant: () => [
    scope(({ is }) => anyOf(is.owner(), is.collaborator()))
      .can(async ({ is }) => {
        if (await is.owner())    return grant(...OWNER);
        if (await is.editor())   return grant(...EDITOR);
        if (await is.viewer())   return grant(...VIEWER);
        return deny('no capability for this principal');
      }),
  ],

  routes: (r, Canvas) => {
    r.resource();

    // Render route — served through the projected.async export field.
    // The projected field is a self-serve resource route; the framework
    // owns caching, invalidation, and content-type.
    r.get('/:canvasId/export.png', async (req, res) => {
      const canvas = await Canvas.getOrFail(req.params.canvasId);
      const png = Buffer.from(canvas.export?.data ?? '', 'base64');
      res.type('image/png').send(png);
    });

    r.mount('/:canvasId/layers', layerRoutes());
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// RasterLayer — a single raster layer in a canvas.
//
// Grant is inherited from Canvas via inherit(Canvas, { via: 'canvas' }).
// ═══════════════════════════════════════════════════════════════════════════════

const inheritCanvas = inherit(Canvas, { via: 'canvas' });

export const RasterLayer = entity('RasterLayer', {
    canvas: ref('Canvas', { required: true }),

  name: text({
    default: 'New Layer',
    validate: v => v.length <= 100 || 'name too long',
  }),

  // Shipped: raster.crdt({ mergeStrategy: 'blend' }).
  // Pixel buffer CRDT — whole-value replace for MVP; per-region
  // Porter-Duff compositing merge is DEFERRED per SPEC.
  imageData: raster.crdt({
    mergeStrategy: 'blend',
    compaction: true,
  }),

  // Shipped: boolean field with .can() using is.editor()/is.owner()
  // and entity.visible (reading the field's own value). Inherit
  // children must grant explicitly — defaults carries { granted: false }.
  visible: boolean({ default: true })
    .can(async ({ is, entity }) => {
      if (await is.editor()) return grant(read, subscribe);
      if (await is.owner()) return grant(read, subscribe);
      if (await is.collaborator() && entity.visible) return grant(read, subscribe);
      return grant(subscribe);
    }),

  // DEFERRED: list-of-entities — layers belong to Canvas as an ordered
  // collection (z-order). Until then, the standalone entity uses a
  // manual `order` number.
  order: number({ default: 0 }),

  opacity: number({ default: 100, min: 0, max: 100 }),

  blendMode: text({
    default: 'normal',
    validate: v =>
      ['normal','multiply','screen','overlay','darken','lighten',
       'color-dodge','color-burn','hard-light','soft-light','difference',
       'exclusion','hue','saturation','color','luminosity'].includes(v)
        || 'invalid blend mode',
  }),

  createdAt: date({ default: () => new Date() }),

  grant: inheritCanvas,

  checks: {
    // Runtime thenable ref traversal through entity.canvas (Scope-support slice 6).
    // Sync map access: entity.canvas.collaborators.has(p.id) — no await needed.
    collaborator: ({ entity, principal: p }) =>
      entity.canvas.collaborators.has(p.id),
    editor: async ({ entity, principal: p }) => {
      const canvas = await entity.canvas;
      return canvas.collaborators.get(p.id)?.role === 'editor';
    },
    owner: async ({ entity, principal: p }) => {
      const canvas = await entity.canvas;
      return canvas.owner === p.id;
    },
  },

  routes: (r) => {
    r.resource();
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Layer sub-routes — mounted under /canvases/:canvasId/layers
// ═══════════════════════════════════════════════════════════════════════════════

function layerRoutes() {
  const r = router({ mergeParams: true });
  r.mount('/', RasterLayer);

  // Reorder endpoint — expressible via list() with ordered:true (DEFERRED).
  r.post('/:layerId/move', async (req, res) => {
    const { newIndex: _newIndex } = req.body;
    res.json({ moved: true });
  });

  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stub compositor — would use sharp/canvas in a real implementation.
// ═══════════════════════════════════════════════════════════════════════════════

async function compositeToPng(_layers, _width, _height) {
  return Buffer.alloc(0);
}
