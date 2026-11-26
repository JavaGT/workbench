import { parseMultipart } from '@mjackson/multipart-parser';

// Read and parse a request body. Caps the body to guard against unbounded uploads.
// An empty body parses to {}. Entity CRUD still requires JSON; imperative routes
// can also accept browser forms.
const BODY_LIMIT = 1_000_000; // ~1mb, SPEC §3 body-parse cap.
const claimedBodies = new WeakSet<BodyRequest>();

export class BodyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface BodyRequest {
  headers: Record<string, string | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  aborted?: boolean;
  destroyed?: boolean;
}

function readCappedBody(req: BodyRequest, limit = BODY_LIMIT, tooLargeMessage = 'request body exceeds the 1mb limit'): Promise<Buffer> {
  if (claimedBodies.has(req)) {
    return Promise.reject(new BodyError('request body has already been read', 400));
  }
  claimedBodies.add(req);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const succeed = (body: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(body);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop consuming and reject so the handler can write a 413. Do NOT
        // destroy the socket — an abrupt close would race the response and the
        // client would see a dropped connection instead of the 413. Pausing and
        // resuming (drain-to-end) lets the response flush cleanly.
        req.pause();
        fail(new BodyError(tooLargeMessage, 413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => succeed(Buffer.concat(chunks, size));
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new BodyError('request body was aborted', 400));
    const onClose = () => fail(new BodyError('request body closed before completion', 400));

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isSafeInteger(declaredLength) && declaredLength > limit) {
      fail(new BodyError(tooLargeMessage, 413));
      req.resume();
      return;
    }
    if (req.aborted || req.destroyed) {
      fail(new BodyError('request body was aborted', 400));
      return;
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

function contentType(req: BodyRequest): string {
  return (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function contentTypeParam(req: BodyRequest, name: string): string | null {
  const parts = String(req.headers['content-type'] ?? '').split(';').slice(1);
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    if (key?.trim().toLowerCase() !== name) continue;
    const value = valueParts.join('=').trim();
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  }
  return null;
}

function assignFormValue(body: Record<string, unknown>, name: string, value: unknown): void {
  if (Object.prototype.hasOwnProperty.call(body, name)) {
    Object.defineProperty(body, name, {
      value: Array.isArray(body[name]) ? [...(body[name] as unknown[]), value] : [body[name], value],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    Object.defineProperty(body, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

function parseUrlencodedBody(buffer: Buffer): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const params = new URLSearchParams(buffer.toString('utf8'));
  for (const [name, value] of params) assignFormValue(body, name, value);
  return body;
}

interface MultipartFile {
  name: string;
  filename: string;
  type: string;
  size: number;
  content: Buffer;
}

function parseMultipartBody(buffer: Buffer, boundary: string | null): Record<string, unknown> {
  if (!boundary) throw new BodyError('multipart body is missing a boundary', 400);
  const body: Record<string, unknown> = {};
  try {
    for (const part of parseMultipart(buffer, { boundary, maxFileSize: BODY_LIMIT })) {
      const name = part.name;
      if (!name) continue;
      if (part.filename !== undefined) {
        const bytes = part.bytes;
        const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        assignFormValue(body, name, {
          name,
          filename: part.filename,
          type: part.mediaType || 'application/octet-stream',
          size: content.length,
          content,
        } satisfies MultipartFile);
      } else {
        assignFormValue(body, name, part.text);
      }
    }
  } catch (error) {
    if (error instanceof BodyError) throw error;
    throw new BodyError('invalid multipart body', 400);
  }
  return body;
}

export interface ReadRequestBodyOptions {
  jsonOnly?: boolean;
}

export async function readRequestBody(req: BodyRequest, { jsonOnly = false }: ReadRequestBodyOptions = {}): Promise<unknown> {
  const buffer = await readCappedBody(req);
  if (buffer.length === 0) return {};
  const type = contentType(req);
  if (type === '' || type === 'application/json') {
    const raw = buffer.toString('utf8').trim();
    if (raw === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new BodyError('request body is not valid JSON', 400);
    }
  }
  if (!jsonOnly && type === 'application/x-www-form-urlencoded') return parseUrlencodedBody(buffer);
  if (!jsonOnly && type === 'multipart/form-data') return parseMultipartBody(buffer, contentTypeParam(req, 'boundary'));
  throw new BodyError(jsonOnly ? 'request body must be JSON' : 'unsupported request body content type', 415);
}

// Read a raw (binary) request body into a Buffer, capped at `limit` bytes. Used
// by the /blobs upload route: a blob upload is opaque bytes, not JSON. The same
// cap-and-refuse contract as readRequestBody (a baked-in default) — an oversized
// upload rejects with a 413 and drains to a clean response, never an abrupt
// socket close that would race the response.
export function readRawBody(req: BodyRequest, limit: number): Promise<Buffer> {
  return readCappedBody(req, limit, 'upload exceeds the size limit');
}
