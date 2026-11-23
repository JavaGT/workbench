import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { config } from './config.ts';
import { renderError } from './middleware.ts';
import { authorizeRow, type CrudAppLike, type CrudEntity } from './http-crud-dispatch.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { resolveTemplate } from './views.ts';
import { createResponseFacade, type ResponseFacade } from './http-response-factory.ts';
import {
  canWriteResponse,
  compressPayloadSync,
  mergeVaryHeader,
  pumpWebStreamToResponse,
} from './http-response.ts';
import type { Principal } from './principal.ts';
import type { AutoLoad, RouteHandler } from './router.ts';

interface ChainApp extends CrudAppLike {
  config?: { viewsDir?: string | null };
  _authorization?: AuthorizationAdapter | null;
}

interface ChainRequest {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  principal: Principal;
  raw: IncomingMessage;
  headers: IncomingMessage['headers'];
  method: string | undefined;
  url: string | undefined;
  [key: string]: unknown;
}

interface ChainResponse extends ResponseFacade {
  render(name: string, data?: Record<string, unknown>): ChainResponse;
  stream(webResponse: unknown, options?: { buffering?: boolean }): Promise<ChainResponse>;
}

export interface RunChainOptions {
  principal: Principal;
  params: Record<string, string>;
  body: unknown;
  query: URLSearchParams;
  autoLoad?: AutoLoad;
  app?: CrudAppLike | null;
  authorization?: AuthorizationAdapter | null;
}

export interface RunChainEnv {
  env: string;
}

function writeCompressedText(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  status: number,
  contentType: string,
  payload: string,
): void {
  const allowCompress = status >= 200
    && status !== 204
    && status !== 304
    && nodeReq.method !== 'HEAD'
    && !nodeRes.getHeader('content-encoding');
  if (allowCompress) {
    const compressed = compressPayloadSync(payload, nodeReq.headers['accept-encoding']);
    if (compressed.encoding) {
      nodeRes.writeHead(status, {
        'content-type': contentType,
        'content-encoding': compressed.encoding,
        'content-length': compressed.body.length,
        'vary': mergeVaryHeader(nodeRes.getHeader('vary'), 'Accept-Encoding'),
      });
      nodeRes.end(compressed.body);
      return;
    }
  }
  nodeRes.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload),
  });
  nodeRes.end(payload);
}

export async function runChain(
  handlers: readonly RouteHandler[],
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  { principal, params, body, query, autoLoad, app, authorization }: RunChainOptions,
  { env }: RunChainEnv,
): Promise<void> {
  const req: ChainRequest = {
    body,
    params,
    query: Object.fromEntries(query),
    principal,
    raw: nodeReq,
    headers: nodeReq.headers,
    method: nodeReq.method,
    url: nodeReq.url,
  };

  if (autoLoad) {
    const auth = await authorizeRow(app as CrudAppLike, autoLoad.entity as unknown as CrudEntity, 'read', params[autoLoad.param], principal, null, { authorization: authorization ?? (app as ChainApp | null | undefined)?._authorization ?? undefined });
    if (auth.status) {
      renderError(nodeRes, { status: auth.status, message: auth.status === 404 ? 'not found' : 'forbidden' }, { env });
      return;
    }
    const dispatchRef = app?.kernel
      ? (args: unknown) => app!.writeQueue!.run(() => app!.kernel!.dispatch(args))
      : null;
    req[autoLoad.key] = (autoLoad.entity as unknown as { hydrate(row: unknown, principal: Principal, dispatch: unknown): unknown })
      .hydrate(auth.row, principal, dispatchRef);
  }

  const res: ChainResponse = createResponseFacade(nodeRes, {}) as ChainResponse;

  // Compression-aware text send on imperative routes.
  res.send = function (this: ChainResponse, value?: unknown) {
    if (!canWriteResponse(nodeRes, 'res.send')) return this;
    const payload = typeof value === 'string' ? value : String(value);
    writeCompressedText(nodeReq, nodeRes, this._pendingStatus, 'text/plain; charset=utf-8', payload);
    return this;
  };

  // chain-specific: template rendering via the views engine.
  res.render = function (this: ChainResponse, name: string, data: Record<string, unknown> = {}) {
    try {
      const html = resolveTemplate((app as ChainApp | null | undefined)?.config?.viewsDir ?? config.viewsDir ?? resolve(process.cwd(), 'views'), name, data);
      if (!nodeRes.headersSent) {
        writeCompressedText(nodeReq, nodeRes, this._pendingStatus, 'text/html; charset=utf-8', html);
      } else {
        nodeRes.end(html);
      }
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      const status = e.code === 'ENOENT' ? 404 : 500;
      renderError(nodeRes, { status, message: e.code === 'ENOENT' ? `template not found: ${name}` : e.message }, { env });
    }
    return this;
  };

  // chain-specific: backpressure-safe streaming with SSE defaults and unified
  // X-Accel-Buffering: no when buffering === false (the default).
  res.stream = async function (this: ChainResponse, webResponse: unknown, { buffering = false }: { buffering?: boolean } = {}) {
    await pumpWebStreamToResponse(nodeRes, webResponse, {
      buffering,
      defaultStatus: this._pendingStatus,
      defaultContentType: 'text/event-stream; charset=utf-8',
    });
    return this;
  };

  for (const handler of handlers) {
    let advance = false;
    let errored = false;
    const next = (err?: unknown) => {
      if (err) {
        errored = true;
        renderError(nodeRes, err, { env });
      } else {
        advance = true;
      }
    };
    await handler(req, res, next);
    if (errored) return;
    if (!advance) return;
  }
}
