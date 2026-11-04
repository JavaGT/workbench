// Route resolution and building — extracted from app.mjs.
//
// The shared core of the mountable surface factory, route resolution, and
// imperative/CRUD route building. Separated so app.mjs owns assembly only.

import { AsyncLocalStorage } from 'node:async_hooks';


import { requireUser, isGate } from './route-gate.mjs';

// The HTTP methods an imperative router verb maps to. `r.get/post/patch/delete`
// build a hand-written route (a handler chain) rather than entity CRUD.
const IMPERATIVE_VERBS = Object.freeze({
  get: 'GET',
  post: 'POST',
  patch: 'PATCH',
  delete: 'DELETE',
}         );

// The five CRUD verbs a resource exposes, each mapped to its Express-style HTTP
// method and path suffix (relative to the resource's base path). `:id` is the
// per-row path parameter the dispatcher binds to load a single row.
const RESOURCE_VERBS = Object.freeze([
  { verb: 'list', method: 'GET', suffix: '' },
  { verb: 'create', method: 'POST', suffix: '' },
  { verb: 'read', method: 'GET', suffix: '/:id' },
  { verb: 'update', method: 'PATCH', suffix: '/:id' },
  { verb: 'remove', method: 'DELETE', suffix: '/:id' },
]         );

// A handler-chain member: middleware or the final handler. The chain runs with
// `(req, res, next)` and the route layer only requires it to be callable.








// The compiled entity record the router consumes. The entity compiler owns the
// full shape; the router only needs the name, the resolved per-verb route gate,
// the field map (for CRDT text apply routes), and the optional routes thunk.























// The shared route spine { method, path, gate } with a discriminated tail: an
// imperative route carries `handlers`, an entity CRUD route carries
// { verb, entity, fieldName? }. The dispatcher discriminates structurally on the
// presence of `handlers`.











// Join a base path and a suffix into a single clean path. The base may be '/'
// (a router mounted bare) or '/notes'; the suffix is '' or '/:id'. Collapses any
// doubled slash so `'/' + '/:id'` does not become '//:id'.
function joinPath(base        , suffix        )         {
  const joined = `${base}${suffix}`;
  return joined.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

// Build one imperative route record from a verb method call `r.get(path, ...rest)`.
// `rest` is the varargs chain: zero or more LEADING branded gates, then optional
// middleware, then exactly one final handler. Leading branded gates peel off the
// front into a single `gate` (the LAST leading gate wins if several are stacked —
// but normally exactly one). A plain (unbranded) function never peels — it is a
// handler/middleware and stays in the chain. With no leading gate the route
// defaults to requireUser() (fail closed: an undeclared-gate route admits no
// anonymous principal). The remaining chain must contain at least one handler.
//
// The record shares the route spine { method, path, gate } with entity CRUD
// routes but carries an imperative tail { handlers } instead of { entity, verb };
// the dispatcher discriminates structurally on the presence of `handlers`.
function buildImperativeRoute(method        , path        , rest                    )                        {
  let i = 0;
  let gate       = requireUser();
  let gateDeclared = false;
  while (i < rest.length && isGate(rest[i])) {
    gate = rest[i]        ;
    gateDeclared = true;
    i += 1;
  }

  const handlers = rest.slice(i);
  if (handlers.length === 0) {
    const detail = gateDeclared
      ? 'a gate alone is not a route'
      : 'a route must declare at least one handler';
    throw new Error(
      `imperative route ${method} ${path} has no handler — ${detail}. ` +
        `Pass (path, ...gates, handler).`,
    );
  }
  // A handler must be a function; a stray non-function in the chain is a typo.
  for (const handler of handlers) {
    if (typeof handler !== 'function') {
      throw new Error(
        `imperative route ${method} ${path} has a non-function handler. ` +
          `The chain is (...middleware, handler), each a function.`,
      );
    }
  }

  return Object.freeze({ method, path, gate, handlers: Object.freeze(handlers                  ) });
}

// Re-base an already-resolved route under a parent mount path (used when a router
// mini-app is mounted into a parent app). The route's path was resolved relative
// to the router's own base; mounting re-roots it under `parentBase`.
function rebaseRoute(route             , parentBase        )              {
  return Object.freeze({
    ...route,
    path: joinPath(parentBase, route.path),
  });
}



// A router or resolvable surface mount target — anything with its own
// declarations + resolveRoutes (a bare mountable), a router blueprint with
// resolveFor (re-resolved per application), or a compiled entity.












// One ordered declaration recorded by the fluent mount/use/verb calls. Resolution
// drains these into the concrete `routes` table.





























// A mountable surface — the shared core of the top-level app, a router mini-app,
// and the `r` handed to an entity's `routes:(r, Entity)=>...` thunk. Two-phase
// assembly: every `mount`/`use`/verb call RECORDS an ordered declaration; the
// concrete `routes` table is RESOLVED later by `resolveRoutes()`. Recording is
// synchronous (so the fluent `app.mount(...).mount(...).listen()` chain is
// preserved), but resolution may be async — an entity's `routes` thunk can be
// `async` and dynamic-import a child module at wiring time (the parent/child
// lazy-mount that breaks an import cycle). `mergeParams` is carried so a child
// router mounted under a parametric parent path (`/:docId/notes`) can read the
// parent's path param. `resource` is present only on the per-entity builder
// (bound to its entity + base); a bare router/app has no resource of its own.
function makeMountable({
  mergeParams = false,
  entity = null,
  base = '/',
  entityOf = (value         ) => value                  ,
}                       = {})            {
  const declarations                = [];
  const routes                = [];
  let resolution                                = null; // the in-flight/resolved finalization promise (idempotent)
  // Diagnostic label so cycle errors can name this router even when it was
  // created bare (no entity name); unique per surface.
  const routerLabel = `router:${++routerSequence}`;

  // When an ENTITY-bound builder mounts a child under a `:<entityName>Id` path
  // segment (doc.mjs: `r.mount('/:docId/shares', ...)` on Doc's builder), the
  // framework auto-loads that entity row by the path param and attaches it to
  // `req.<entityName>` for every descendant route — so a share handler reads
  // `req.doc` with no hand-written load boilerplate. The convention is scoped to
  // an entity's own route subtree (a generic router mounting `:userId` does NOT
  // auto-load), and the param name carries the link (no magic string — the
  // entity name is the link, named in the path).
  function makeAutoLoad(path        )                  {
    if (!entity || typeof entity.name !== 'string') return null;
    const key = entity.name.toLowerCase();
    const param = `${key}Id`;
    return path.includes(`:${param}`) ? { param, entity, key } : null;
  }

  function recordMount(path        , target         )            {
    if (resolution) {
      throw new Error('cannot mount after routes are resolved — assemble the app before listen()');
    }
    // `app.use(prefix, fn)` — a FUNCTION target is a catch-all request handler
    // under the prefix (the Express idiom for mounting a raw router/handler). It
    // is a distinct declaration kind: it does not contribute routes to the
    // matchRoute table (the matcher needs exact segment count and has no
    // wildcard), it intercepts by URL prefix BEFORE matchRoute. This is the
    // permanent home for third-party routers that own their own dynamic
    // sub-paths (e.g. better-auth's `/api/auth/[...all]`) and generalizes the
    // former `app.static` special-case — one prefix-intercept mechanism,
    // declared by apps, not baked into serve.mjs.
    if (typeof target === 'function') {
      declarations.push({ kind: 'handler', prefix: normalizePrefix(path), fn: target                 });
      return surface;
    }
    const entityCandidate = target                                         ;
    if (typeof entityCandidate.bind === 'function' || entityCandidate.runtime) {
      target = entityOf(target);
    }
    declarations.push({ kind: 'mount', path, target: target               , autoLoad: makeAutoLoad(path) });
    return surface;
  }

  // Trim trailing slashes so the prefix-intercept matches with startsWith: the
  // bare prefix ('/api/auth') and any path under it. The bare root '/' collapses
  // to '/' so it matches everything, and `pathname.slice('/'.length)` still
  // yields the tail.
  function normalizePrefix(prefix        )         {
    return prefix.replace(/\/+$/, '') || '/';
  }

  const surface = {
    mergeParams,
    routes,
    declarations,
    mount: recordMount,
    use: recordMount,
    // Diagnostic-only; read by describeMountTarget for cycle-error chains.
    _label: routerLabel,
  }                        ;

  // The per-entity builder also exposes `r.resource()`: expand the five CRUD
  // verbs for THIS entity at THIS base. The per-verb route gate comes from the
  // entity's compiled `gate` (declared next to `grant`); there is no gate arg.
  if (entity) {
    surface.resource = () => {
      if (resolution) {
        throw new Error('cannot declare routes after resolution');
      }
      declarations.push({ kind: 'resource' });
      return surface;
    };
  }

  // Imperative verb methods: `r.get/post/patch/delete(path, ...gates, handler)`.
  // Each records an imperative declaration; at resolution it becomes a route in
  // the SAME table the entity CRUD routes live in — one routing table,
  // discriminated by tail shape.
  for (const [verb, method] of Object.entries(IMPERATIVE_VERBS)) {
    surface[verb] = (path        , ...rest           ) => {
      if (resolution) {
        throw new Error('cannot declare routes after resolution');
      }
      // buildImperativeRoute validates synchronously (a route with no handler is
      // a declaration error and must throw at authoring time, not at resolution).
      declarations.push({ kind: 'imperative', route: buildImperativeRoute(method, path, rest) });
      return surface;
    };
  }

  // Drain the ordered declarations into `routes`. Idempotent: the first call
  // performs (and caches) resolution; later calls return the same promise. An
  // entity's `routes` thunk may be async, so resolution is async throughout —
  // the synchronous recording above is what keeps the public chain sync.
  surface.resolveRoutes = ()                         => {
    if (resolution) return resolution;
    // Re-entry while resolving is caught by the shared RESOLUTION_STACK inside
    // resolveMount (this surface is pushed below before its body runs).
    const ancestors = RESOLUTION_STACK.getStore() ?? [];
    // Keep the ancestor chain local to this asynchronous resolution.
    resolution = RESOLUTION_STACK.run([...ancestors, surface], async () => {
      for (const decl of declarations) {
        if (decl.kind === 'imperative') {
          routes.push(rebaseRoute(decl.route, base));
        } else if (decl.kind === 'resource') {
          for (const route of resolveResource(entity , joinPath(base, ''))) {
            routes.push(route);
          }
        } else if (decl.kind === 'handler') {
          // A function-target `use` does not add to the matchRoute table — it
          // intercepts by prefix before the table is consulted. Collected in
          // declaration order so the first matching prefix wins.
          (surface._handlers ??= []).push({ prefix: decl.prefix, fn: decl.fn });
        } else if (decl.kind === 'mount') {
          for (const route of await resolveMount(decl.path, decl.target, entityOf)) {
            const rebased = rebaseRoute(route, base);
            // Stamp the entity auto-load onto every descendant route so a
            // handler under `/:docId/shares` finds req.doc regardless of how
            // deeply the child router nests.
            routes.push(decl.autoLoad ? Object.freeze({ ...rebased, autoLoad: decl.autoLoad }) : rebased);
          }
        }
      }
      return routes;
    });
    return resolution;
  };

  return surface;
}

// Cycle detection for mount resolution. Resolution recurses (resolveRoutes →
// resolveMount → child.resolveRoutes/buildEntityRoutes) and every mountable
// caches its in-flight resolution promise — so a circular mount graph would
// await its own never-settling promise forever, deadlocking listen() silently.
// This stack holds the targets currently resolving; re-entering one turns the
// deadlock into a loud, descriptive error at assembly time.
let routerSequence = 0; // diagnostic labels for bare routers in cycle errors
const RESOLUTION_STACK = new AsyncLocalStorage                    ();

function describeMountTarget(target         )         {
  const record = target                                                           ;
  if (typeof record?._label === 'string') return record._label;
  if (typeof record?.name === 'string') return `entity:${record.name}`;
  return 'router';
}

// Build the descriptive error for a detected mount cycle: the chain shows the
// resolving targets from the outermost resolution down to the re-entered one.
function mountCycleError(target         , path        )        {
  const chain = [...(RESOLUTION_STACK.getStore() ?? []), target].map(describeMountTarget).join(' → ');
  return new Error(
    `circular mount detected: ${chain} — '${describeMountTarget(target)}' at mount path '${path}' is still resolving`,
  );
}

// Throw unless `target` is free to resolve (not an ancestor still in flight).
function assertNotResolving(target         , path        )       {
  if (target != null && typeof target === 'object' && (RESOLUTION_STACK.getStore() ?? []).includes(target)) {
    throw mountCycleError(target, path);
  }
}

// Resolve one `mount(path, target)` declaration into a flat list of route records
// based under `path`. A router/entity-builder target (anything with its own
// declarations + resolveRoutes) is finalized recursively and its routes re-based;
// a compiled entity target is wired through a fresh per-entity builder so its
// `routes:(r, Entity)=>...` thunk runs (awaited — it may be async).
async function resolveMount(path        , target             , entityOf          )                         {
  if (target && typeof (target                            ).resolveFor === 'function') {
    assertNotResolving(target, path);
    return RESOLUTION_STACK.run([...(RESOLUTION_STACK.getStore() ?? []), target], async () => {
      const resolved = await (target                       ).resolveFor(entityOf);
      return resolved.map((route) => rebaseRoute(route, path));
    });
  }
  if (target && typeof (target                               ).resolveRoutes === 'function' && Array.isArray((target                              ).declarations)) {
    // The sub-router tracks itself inside its own resolveRoutes(); reaching it
    // while it is still resolving means the mount graph loops back through it.
    assertNotResolving(target, path);
    await (target                      ).resolveRoutes();
    return (target                      ).routes.map((route) => rebaseRoute(route, path));
  }
  // Compiled entity: its per-entity builder is created fresh per resolution, so
  // identity is tracked on the entity object itself (stable across resolutions).
  assertNotResolving(target, path);
  return RESOLUTION_STACK.run([...(RESOLUTION_STACK.getStore() ?? []), target], () => buildEntityRoutes(entityOf(target), path, entityOf));
}

// Expand the five CRUD verbs for `entity` at `base`. The per-verb route gate is
// owned by the entity declaration (resolved once at compile time through
// resolveRouteGate, unlisted verbs default to requireUser()). There is no
// per-mount gate override — the route gate and the row grant are one
// authorization story on the entity, not two places (AGENTS: prefer a singular
// system). A path needing bespoke admission is a bespoke imperative route.
function resolveResource(entity                , base        )                {
  const resolvedGate = entity.gate;
  const routes                = RESOURCE_VERBS.map(({ verb, method, suffix }) =>
    Object.freeze({
      method,
      path: joinPath(base, suffix),
      verb,
      entity,
      gate: resolvedGate[verb],
    }),
  );
  for (const [fieldName, descriptor] of Object.entries(entity.fields ?? ({}                                       ))) {
    if (descriptor.kind === 'crdt' && descriptor.type === 'text') {
      routes.push(Object.freeze({
        method: 'POST',
        path: joinPath(base, `/:id/${fieldName}/apply`),
        verb: 'fieldApply',
        fieldName,
        entity,
        gate: resolvedGate.update,
      }));
    }
  }
  return routes;
}

// Wire one compiled entity at `base` into its route records. The entity's
// `routes:(r, Entity)=>...` thunk receives a per-entity builder (a mountable
// surface that also carries `.resource()` bound to this entity+base). The thunk
// may be async (it can dynamic-import a child module at wiring time); we await it.
// An entity that omits `routes` is auto-CRUD'd via a default `r.resource()`.
async function buildEntityRoutes(entity                , base        , entityOf          )                         {
  const r = makeMountable({ entity, base, entityOf });
  if (typeof entity.routes === 'function') {
    await entity.routes(r, entity);
  } else {
    r.resource ();
  }
  await r.resolveRoutes();
  return r.routes;
}

export { makeMountable };
