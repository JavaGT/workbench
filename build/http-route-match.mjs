import { addRoute, createRouter, findRoute,                    } from 'rou3';



















const compiledRouteCache = new WeakMap                                            ();

function normalizePath(path        )         {
  const segments = path.split('/').filter(Boolean);
  return `/${segments.join('/')}`;
}

function compileRoutes(routes                            )                 {
  const cached = compiledRouteCache.get(routes);
  if (cached && cached.length === routes.length) return cached;

  const byMethod = createRouter                 ();
  const anyMethod = createRouter      ();
  for (const route of routes) {
    const normalized = normalizePath(route.path);
    addRoute(byMethod, route.method, normalized, route);
    addRoute(anyMethod, 'ANY', normalized, true);
  }
  const compiled                 = { length: routes.length, byMethod, anyMethod };
  compiledRouteCache.set(routes, compiled);
  return compiled;
}

function decodeParams(rawParams                                    )                     {
  const params              = {};
  if (!rawParams) return params;
  for (const [key, value] of Object.entries(rawParams)) {
    try {
      params[key] = decodeURIComponent(value);
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
  }
  return params;
}

export function matchRoute(
  routes                            ,
  method        ,
  pathname        ,
)             {
  const compiled = compileRoutes(routes);
  const normalizedPathname = normalizePath(pathname);

  const hit = findRoute(compiled.byMethod, method, normalizedPathname);
  if (hit) {
    const params = decodeParams(hit.params);
    if (params !== null) {
      return { route: hit.data, params };
    }
    return { route: null, params: null, pathMatched: false };
  }

  const anyHit = findRoute(compiled.anyMethod, 'ANY', normalizedPathname);
  if (anyHit && decodeParams(anyHit.params) !== null) {
    return { route: null, params: null, pathMatched: true };
  }
  return { route: null, params: null, pathMatched: false };
}
