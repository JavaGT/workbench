import { addRoute, createRouter, findRoute, type RouterContext } from 'rou3';

export type RouteParams = Record<string, string>;

export interface RouteDefinition {
  method: string;
  path: string;
  [key: string]: unknown;
}

export type RouteMatch =
  | { route: RouteDefinition; params: RouteParams }
  | { route: null; params: null; pathMatched: boolean };

interface CompiledRoutes {
  readonly length: number;
  readonly byMethod: RouterContext<RouteDefinition>;
  readonly anyMethod: RouterContext<true>;
}

const compiledRouteCache = new WeakMap<readonly RouteDefinition[], CompiledRoutes>();

function normalizePath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return `/${segments.join('/')}`;
}

function compileRoutes(routes: readonly RouteDefinition[]): CompiledRoutes {
  const cached = compiledRouteCache.get(routes);
  if (cached && cached.length === routes.length) return cached;

  const byMethod = createRouter<RouteDefinition>();
  const anyMethod = createRouter<true>();
  for (const route of routes) {
    const normalized = normalizePath(route.path);
    addRoute(byMethod, route.method, normalized, route);
    addRoute(anyMethod, 'ANY', normalized, true);
  }
  const compiled: CompiledRoutes = { length: routes.length, byMethod, anyMethod };
  compiledRouteCache.set(routes, compiled);
  return compiled;
}

function decodeParams(rawParams: Record<string, string> | undefined): RouteParams | null {
  const params: RouteParams = {};
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
  routes: readonly RouteDefinition[],
  method: string,
  pathname: string,
): RouteMatch {
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
