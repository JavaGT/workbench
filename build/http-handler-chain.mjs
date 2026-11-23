import { resolve } from 'node:path';


import { config } from './config.mjs';
import { renderError } from './middleware.mjs';
import { authorizeRow,                                   } from './http-crud-dispatch.mjs';

import { resolveTemplate } from './views.mjs';
import { createResponseFacade,                     } from './http-response-factory.mjs';
import {
  canWriteResponse,
  compressPayloadSync,
  mergeVaryHeader,
  pumpWebStreamToResponse,
} from './http-response.mjs';







































function writeCompressedText(
  nodeReq                 ,
  nodeRes                ,
  status        ,
  contentType        ,
  payload        ,
)       {
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
  handlers                         ,
  nodeReq                 ,
  nodeRes                ,
  { principal, params, body, query, autoLoad, app, authorization }                 ,
  { env }             ,
)                {
  const req               = {
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
    const auth = await authorizeRow(app               , autoLoad.entity                         , 'read', params[autoLoad.param], principal, null, { authorization: authorization ?? (app                               )?._authorization ?? undefined });
    if (auth.status) {
      renderError(nodeRes, { status: auth.status, message: auth.status === 404 ? 'not found' : 'forbidden' }, { env });
      return;
    }
    const dispatchRef = app?.kernel
      ? (args         ) => app .writeQueue .run(() => app .kernel .dispatch(args))
      : null;
    req[autoLoad.key] = (autoLoad.entity                                                                                          )
      .hydrate(auth.row, principal, dispatchRef);
  }

  const res                = createResponseFacade(nodeRes, {})                 ;

  // Compression-aware text send on imperative routes.
  res.send = function (                     value          ) {
    if (!canWriteResponse(nodeRes, 'res.send')) return this;
    const payload = typeof value === 'string' ? value : String(value);
    writeCompressedText(nodeReq, nodeRes, this._pendingStatus, 'text/plain; charset=utf-8', payload);
    return this;
  };

  // chain-specific: template rendering via the views engine.
  res.render = function (                     name        , data                          = {}) {
    try {
      const html = resolveTemplate((app                               )?.config?.viewsDir ?? config.viewsDir ?? resolve(process.cwd(), 'views'), name, data);
      if (!nodeRes.headersSent) {
        writeCompressedText(nodeReq, nodeRes, this._pendingStatus, 'text/html; charset=utf-8', html);
      } else {
        nodeRes.end(html);
      }
    } catch (err) {
      const e = err                                         ;
      const status = e.code === 'ENOENT' ? 404 : 500;
      renderError(nodeRes, { status, message: e.code === 'ENOENT' ? `template not found: ${name}` : e.message }, { env });
    }
    return this;
  };

  // chain-specific: backpressure-safe streaming with SSE defaults and unified
  // X-Accel-Buffering: no when buffering === false (the default).
  res.stream = async function (                     webResponse         , { buffering = false }                          = {}) {
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
    const next = (err          ) => {
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
