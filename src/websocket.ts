// WebSocket server — handshake + frame parser/sender (zero-deps, RFC 6455).
//
// Node's http.WebSocket is client-only. The server side uses the HTTP server's
// `upgrade` event: the raw socket is handed off after the request-line and headers
// have been parsed. This module implements:
//
//   Handshake  — validate `Upgrade: websocket`, compute Sec-WebSocket-Accept,
//                send `101 Switching Protocols`.
//   FrameSender — build outgoing frames (unmasked; server→client MUST NOT mask).
//   FrameParser — parse incoming, MASKED client frames (text, close, ping/pong)
//                 incrementally chunked, with per-message and per-header error
//                 handling. Automatic pong response to ping.
//
// RFC 6455 compliance: text (0x1) and close (0x8) frames; ping (0x9) auto-pongs;
// fragmented frames (FIN=0) are buffered and assembled; client frames MUST be
// masked (reject unmasked); payloads above 64 KiB are rejected (a per-safety cap,
// not a protocol limit).

import { createHash } from 'node:crypto';
import {
  WebSocketServer,
  type WebSocket as WsWebSocket,
  type PerMessageDeflateOptions,
  type RawData,
} from 'ws';

// Default transport limits & tuning for the ws-backed WebSocket server.
export const DEFAULT_WS_MAX_PAYLOAD = 4 * 1024 * 1024; // 4 MiB
export const DEFAULT_WS_DEFLATE_THRESHOLD = 1024; // 1 KiB
export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 30_000;

export type ServerWebSocket = WsWebSocket;
export type { PerMessageDeflateOptions, RawData };
export { WebSocketServer };

export interface CreateWebSocketServerOptions {
  maxPayload?: number;
  perMessageDeflate?: boolean | PerMessageDeflateOptions;
}

/**
 * Create a `noServer` `ws.WebSocketServer` configured with `permessage-deflate`
 * compression (enabled by default with a 1 KiB threshold) and a configurable
 * `maxPayload` cap (default 4 MiB).
 */
export function createWebSocketServer(options: CreateWebSocketServerOptions = {}): WebSocketServer {
  const maxPayload = options.maxPayload ?? DEFAULT_WS_MAX_PAYLOAD;
  let perMessageDeflate: boolean | PerMessageDeflateOptions;
  if (options.perMessageDeflate === false) {
    perMessageDeflate = false;
  } else if (options.perMessageDeflate === undefined || options.perMessageDeflate === true) {
    perMessageDeflate = { threshold: DEFAULT_WS_DEFLATE_THRESHOLD };
  } else {
    perMessageDeflate = { threshold: DEFAULT_WS_DEFLATE_THRESHOLD, ...options.perMessageDeflate };
  }
  return new WebSocketServer({
    noServer: true,
    maxPayload,
    perMessageDeflate,
  });
}

// Magic GUID appended to the client's Sec-WebSocket-Key before hashing (§4.2.2).
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Per-safety payload cap (a reasonable ceiling for JSON event payloads, not a
// protocol limit — RFC 6455 allows up to 2^63-1 bytes).
const MAX_PAYLOAD = 64 * 1024; // 64 KiB

// --- Frame sender: builds outgoing (server→client) frames -----------------------

export class FrameSender {
  // Build a text frame (opcode 0x1).
  text(payload: unknown): Buffer {
    const data = Buffer.from(String(payload), 'utf-8');
    if (data.length > MAX_PAYLOAD) {
      throw new Error(`WebSocket text payload too large: ${data.length} bytes (max ${MAX_PAYLOAD})`);
    }
    return buildFrame(0x1, data);
  }

  // Build a close frame (opcode 0x8). The optional code is a 2-byte status code
  // (§7.4); reason is a short UTF-8 string.
  close(code: number | undefined, reason: unknown): Buffer {
    let body: Buffer;
    if (code !== undefined) {
      const codeBuf = Buffer.alloc(2);
      codeBuf.writeUInt16BE(code, 0);
      const reasonBuf = reason ? Buffer.from(String(reason), 'utf-8') : Buffer.alloc(0);
      body = Buffer.concat([codeBuf, reasonBuf]);
    } else {
      body = Buffer.alloc(0);
    }
    if (body.length > 125) {
      throw new Error(`WebSocket close body too large: ${body.length} bytes`);
    }
    return buildFrame(0x8, body);
  }

  // Build a pong frame (opcode 0xA) echoing the ping payload verbatim (§5.5.2).
  pong(payload: unknown): Buffer {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf-8');
    if (data.length > 125) {
      throw new Error(`WebSocket pong payload too large: ${data.length} bytes`);
    }
    return buildFrame(0xa, data);
  }
}

// Assemble one outgoing frame: FIN=1, no MASK (server→client), opcode, payload.
function buildFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN=1
    header[1] = len;           // MASK=0
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;           // 2-byte extended length
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;           // 8-byte extended length
    // Write as BigUInt64BE: high 4 bytes → low 4 bytes
    header.writeUInt32BE(0, 2);     // high 32 bits = 0 (payload < 2^32)
    header.writeUInt32BE(len, 6);   // low 32 bits
  }
  return Buffer.concat([header, payload]);
}

// --- Frame parser: parse incoming (client→server) MASKED frames -----------------

// Parsing state: reading the fixed header, then extended length, then mask, then
// payload, in order. Each state may be reached over multiple `feed` calls.
const STATE = Object.freeze({
  HEADER: 'header',       // reading bytes 0-1
  EXTENDED_2: 'ext2',     // reading extended 2-byte length
  EXTENDED_8: 'ext8',     // reading extended 8-byte length
  MASK: 'mask',            // reading 4-byte masking key
  PAYLOAD: 'payload',      // reading the payload data
} as const);

type FrameState = (typeof STATE)[keyof typeof STATE];

interface FrameMessage {
  opcode: number;
  payload?: Buffer;
  error?: string;
  closeCode?: number;
  closeReason?: string;
}

export class FrameParser {
  #state: FrameState = STATE.HEADER;
  #buffer = Buffer.alloc(0);
  #opcode = 0;
  #fin = 0;
  #masked = false;
  #payloadLen = 0;
  #maskKey = Buffer.alloc(0);
  #payload = Buffer.alloc(0);
  #payloadRead = 0;
  #fragmentedOpcode = 0;    // opcode of the first fragment
  #fragmented = Buffer.alloc(0);
  #messages: FrameMessage[] = [];
  #pongs: Buffer[] = [];    // ping payloads that need a pong response
  #skipBytes = 0;           // bytes to drain when skipping a malformed frame body

  #reset(): void {
    this.#state = STATE.HEADER;
    this.#opcode = 0;
    this.#fin = 0;
    this.#masked = false;
    this.#payloadLen = 0;
    this.#maskKey = Buffer.alloc(0);
    this.#payload = Buffer.alloc(0);
    this.#payloadRead = 0;
    this.#skipBytes = 0;
  }

  feed(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.#processBuffer();
  }

  drainMessages(): FrameMessage[] {
    const msgs = this.#messages;
    this.#messages = [];
    return msgs;
  }

  // Ping frames produce pong payloads that the caller MUST echo back.
  drainPongs(): Buffer[] {
    const pongs = this.#pongs;
    this.#pongs = [];
    return pongs;
  }

  #processBuffer(): void {
    // Loop while there is buffered data OR we are sitting in the PAYLOAD state
    // with a zero-length payload still to finalize. A masked close frame with an
    // empty body (undici sends `88 80 <mask>` — 6 bytes, no payload) consumes its
    // last byte in the MASK state, emptying the buffer; a bare `length > 0` loop
    // would then exit BEFORE the PAYLOAD state completes the zero-length frame,
    // dropping the close frame entirely (server never acks → client hangs in
    // CLOSING forever → leaked socket). Keep looping so PAYLOAD can finalize.
    while (
      this.#buffer.length > 0 ||
      (this.#state === STATE.PAYLOAD && this.#payloadRead === this.#payloadLen)
    ) {
      // Drain skip-bytes from a malformed frame we already reported.
      if (this.#skipBytes > 0) {
        const drain = Math.min(this.#skipBytes, this.#buffer.length);
        this.#buffer = this.#buffer.slice(drain);
        this.#skipBytes -= drain;
        if (this.#skipBytes === 0) this.#reset();
        continue;
      }

      if (this.#state === STATE.HEADER) {
        if (this.#buffer.length < 2) return;
        const b0 = this.#buffer[0];
        const b1 = this.#buffer[1];
        this.#fin = (b0 & 0x80) >> 7;
        this.#opcode = b0 & 0x0f;
        this.#masked = (b1 & 0x80) !== 0;
        this.#payloadLen = b1 & 0x7f;
        this.#buffer = this.#buffer.slice(2);

        if ((b0 & 0x70) !== 0) {
          this.#messages.push({ opcode: -1, closeCode: 1002, error: 'reserved WebSocket frame bits are set' });
          this.#reset();
          continue;
        }
        if (![0, 1, 2, 8, 9, 0xa].includes(this.#opcode)) {
          this.#messages.push({ opcode: -1, closeCode: 1002, error: `unsupported WebSocket opcode: ${this.#opcode}` });
          this.#reset();
          continue;
        }
        if (this.#opcode >= 8 && this.#fin === 0) {
          this.#messages.push({ opcode: -1, closeCode: 1002, error: 'control frames must not be fragmented' });
          this.#reset();
          continue;
        }

        if (!this.#masked) {
          this.#messages.push({ opcode: -1, closeCode: 1002, error: 'client frame must be masked (RFC 6455 §5.1)' });
          this.#skipBytes = this.#payloadLen;
          continue;
        }

        if (this.#payloadLen === 126) {
          this.#state = STATE.EXTENDED_2;
        } else if (this.#payloadLen === 127) {
          this.#state = STATE.EXTENDED_8;
        } else {
          this.#state = STATE.MASK;
        }
        continue;
      }

      if (this.#state === STATE.EXTENDED_2) {
        if (this.#buffer.length < 2) return;
        this.#payloadLen = this.#buffer.readUInt16BE(0);
        this.#buffer = this.#buffer.slice(2);
        if (this.#opcode >= 8 && this.#payloadLen > 125) {
          this.#messages.push({ opcode: -1, closeCode: 1002, error: 'control frame payload exceeds 125 bytes' });
          this.#reset();
          continue;
        }
        if (this.#payloadLen > MAX_PAYLOAD) {
          this.#messages.push({ opcode: -1, closeCode: 1002, error: `payload too large: ${this.#payloadLen} bytes` });
          this.#reset();
          continue;
        }
        this.#state = STATE.MASK;
        continue;
      }

      if (this.#state === STATE.EXTENDED_8) {
        if (this.#buffer.length < 8) return;
        // Reject payloads > 32-bit range (MAX_PAYLOAD is already 64 KiB)
        const high = this.#buffer.readUInt32BE(0);
        const low = this.#buffer.readUInt32BE(4);
        this.#buffer = this.#buffer.slice(8);
        if (high > 0 || low > MAX_PAYLOAD) {
          this.#messages.push({ opcode: -1, closeCode: 1002, error: `payload too large: ${high * 0x100000000 + low} bytes` });
          this.#reset();
          continue;
        }
        if (this.#opcode >= 8) {
          this.#messages.push({ opcode: -1, closeCode: 1002, error: 'control frame payload exceeds 125 bytes' });
          this.#reset();
          continue;
        }
        this.#payloadLen = low;
        this.#state = STATE.MASK;
        continue;
      }

      if (this.#state === STATE.MASK) {
        if (this.#buffer.length < 4) return;
        this.#maskKey = this.#buffer.slice(0, 4);
        this.#buffer = this.#buffer.slice(4);
        this.#payload = Buffer.alloc(0);
        this.#payloadRead = 0;
        this.#state = STATE.PAYLOAD;
        continue;
      }

      if (this.#state === STATE.PAYLOAD) {
        const needed = this.#payloadLen - this.#payloadRead;
        if (this.#buffer.length < needed) return;

        const chunk = this.#buffer.slice(0, needed);
        this.#buffer = this.#buffer.slice(needed);

        // Unmask this chunk
        const unmasked = Buffer.alloc(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          unmasked[i] = chunk[i] ^ this.#maskKey[(this.#payloadRead + i) % 4];
        }

        this.#payload = Buffer.concat([this.#payload, unmasked]);
        this.#payloadRead += chunk.length;

        if (this.#payloadRead === this.#payloadLen) {
          // Frame complete
          this.#handleCompleteFrame();
          this.#reset();
        }
        continue;
      }
    }
  }

  #handleCompleteFrame(): void {
    const opcode = this.#opcode;
    const fin = this.#fin;
    const payload = this.#payload;

    // Control frames (opcode 8=close, 9=ping, 0xA=pong) may appear mid-stream
    // and must have FIN=1; they are never fragmented.
    if (opcode === 0x8) {
      if (payload.length === 1) {
        this.#messages.push({ opcode: -1, closeCode: 1002, error: 'close frame payload must be empty or at least 2 bytes' });
        return;
      }
      let closeCode = 1005; // no status code received
      let closeReason = '';
      if (payload.length >= 2) {
        closeCode = payload.readUInt16BE(0);
        closeReason = payload.slice(2).toString('utf-8');
      }
      this.#messages.push({ opcode, closeCode, closeReason, payload });
      return;
    }

    if (opcode === 0x9) {
      this.#pongs.push(payload);
      return;
    }

    if (opcode === 0xA) {
      // Pong — a heartbeat response. No action needed; just drop it.
      return;
    }

    // Data frames (text=1, binary=2). Handle fragmentation.
    if (fin === 0) {
      if (opcode === 0 && !this.#fragmentedOpcode) {
        this.#messages.push({ opcode: -1, closeCode: 1002, error: 'continuation frame without a fragmented message' });
        return;
      }
      if (opcode !== 0 && this.#fragmentedOpcode) {
        this.#messages.push({ opcode: -1, closeCode: 1002, error: 'new data frame while a fragmented message is open' });
        return;
      }
      if (opcode !== 0) {
        this.#fragmentedOpcode = opcode;
      }
      if (this.#fragmented.length + payload.length > MAX_PAYLOAD) {
        this.#fragmentedOpcode = 0;
        this.#fragmented = Buffer.alloc(0);
        this.#messages.push({ opcode: -1, closeCode: 1002, error: `fragmented payload exceeds ${MAX_PAYLOAD} bytes` });
        return;
      }
      this.#fragmented = Buffer.concat([this.#fragmented, payload]);
    } else {
      if (opcode === 0 && this.#fragmentedOpcode) {
        // Final fragment of a fragmented message
        if (this.#fragmented.length + payload.length > MAX_PAYLOAD) {
          this.#fragmentedOpcode = 0;
          this.#fragmented = Buffer.alloc(0);
          this.#messages.push({ opcode: -1, closeCode: 1002, error: `fragmented payload exceeds ${MAX_PAYLOAD} bytes` });
          return;
        }
        this.#fragmented = Buffer.concat([this.#fragmented, payload]);
        this.#messages.push({ opcode: this.#fragmentedOpcode, payload: this.#fragmented });
        this.#fragmentedOpcode = 0;
        this.#fragmented = Buffer.alloc(0);
      } else if (opcode !== 0 && this.#fragmentedOpcode) {
        this.#messages.push({ opcode: -1, closeCode: 1002, error: 'new data frame while a fragmented message is open' });
      } else if (opcode === 0) {
        this.#messages.push({ opcode: -1, closeCode: 1002, error: 'continuation frame without a fragmented message' });
      } else if (opcode !== 0) {
        // Complete unfragmented frame
        this.#messages.push({ opcode, payload });
      }
    }
  }
}

// --- WebSocket upgrade handshake (§4.2.2) ---------------------------------------

export interface WebSocketUpgradeRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface WebSocketUpgradeSocket {
  write(data: string): unknown;
  destroy(): unknown;
}

export interface WebSocketUpgradeResult {
  accepted: true;
  key: string;
}

export function upgradeWebSocket(
  req: WebSocketUpgradeRequest,
  socket: WebSocketUpgradeSocket,
): WebSocketUpgradeResult | null {
  const h = req.headers;

  // Validate the upgrade request
  if (!h || typeof h['sec-websocket-key'] !== 'string') return null;
  if (!String(h.upgrade || '').toLowerCase().includes('websocket')) return null;
  if (String(h['sec-websocket-version'] || '') !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      '\r\n');
    socket.destroy();
    return null;
  }

  const acceptKey = createHash('sha1')
    .update(h['sec-websocket-key'] + WS_GUID)
    .digest('base64');

  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    '',
  ].join('\r\n');

  socket.write(response);
  return { accepted: true, key: h['sec-websocket-key'] };
}
