/**
 * A minimal WebSocket client (RFC 6455) for the Chrome DevTools endpoint on
 * 127.0.0.1.
 *
 * The extension ships without runtime dependencies and the extension host's
 * Node may or may not expose a global `WebSocket`, so the little framing CDP
 * needs lives here: text frames both ways, fragmentation, ping/pong and close.
 * No extensions are negotiated, so there is no compression to deal with.
 */

import { createHash, randomBytes } from 'crypto';
import * as net from 'net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const enum Opcode {
  Continuation = 0,
  Text = 1,
  Binary = 2,
  Close = 8,
  Ping = 9,
  Pong = 10,
}

/** A client frame: FIN set, masked (the spec requires it from clients). */
function frame(opcode: Opcode, payload: Buffer): Buffer {
  const len = payload.length;
  const header = Buffer.alloc(len < 126 ? 6 : len < 65536 ? 8 : 14);
  header[0] = 0x80 | opcode;
  let off = 2;
  if (len < 126) {
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    off = 4;
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    off = 10;
  }
  const mask = randomBytes(4);
  mask.copy(header, off);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, masked]);
}

export class LocalWebSocket {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private fragments: Buffer[] = [];
  private messageHandlers: Array<(text: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  closed = false;

  private constructor(
    private readonly socket: net.Socket,
    rest: Buffer,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('error', () => this.handleClose());
    if (rest.length) {
      this.onData(rest);
    }
  }

  static connect(url: string, timeoutMs = 10_000): Promise<LocalWebSocket> {
    return new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        reject(new Error(`WebSocket: bad URL ${url}`));
        return;
      }
      const key = randomBytes(16).toString('base64');
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      const socket = net.connect(Number(u.port || 80), u.hostname);
      const fail = (err: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`WebSocket: timed out connecting to ${url}`)), timeoutMs);
      socket.once('error', (err) => fail(new Error(`WebSocket: could not connect to ${url} (${err.message})`)));
      socket.on('connect', () => {
        socket.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
            `Host: ${u.host}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let head = Buffer.alloc(0);
      const onHandshake = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          return;
        }
        socket.off('data', onHandshake);
        const response = head.subarray(0, end).toString('latin1');
        const status = response.split('\r\n')[0];
        const got = /^sec-websocket-accept:\s*(.+)$/im.exec(response)?.[1]?.trim();
        if (!/^HTTP\/1\.1 101\b/.test(status) || got !== accept) {
          fail(new Error(`WebSocket: handshake rejected (${status})`));
          return;
        }
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new LocalWebSocket(socket, head.subarray(end + 4)));
      };
      socket.on('data', onHandshake);
    });
  }

  send(text: string): void {
    if (this.closed) {
      throw new Error('WebSocket: connection is closed');
    }
    this.socket.write(frame(Opcode.Text, Buffer.from(text, 'utf8')));
  }

  onMessage(fn: (text: string) => void): void {
    this.messageHandlers.push(fn);
  }

  onClose(fn: () => void): void {
    if (this.closed) {
      fn();
    } else {
      this.closeHandlers.push(fn);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.socket.write(frame(Opcode.Close, Buffer.from([0x03, 0xe8])));
    } catch {
      // Already torn down; the 'close' event will follow.
    }
    this.socket.end();
    // Chrome answers with its own close frame and drops the TCP connection; if
    // it does not, don't wait on it forever.
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  // ---- receive side ----------------------------------------------------

  private onData(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.drain();
  }

  /** Parse every complete frame in the buffer; leave a partial one for later. */
  private drain(): void {
    for (;;) {
      if (this.buffered < 2) {
        return;
      }
      const head = this.peek(14);
      const fin = (head[0] & 0x80) !== 0;
      const opcode = head[0] & 0x0f;
      const masked = (head[1] & 0x80) !== 0;
      let len = head[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (head.length < 4) {
          return;
        }
        len = head.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (head.length < 10) {
          return;
        }
        len = Number(head.readBigUInt64BE(2));
        off = 10;
      }
      if (masked) {
        off += 4;
      }
      if (this.buffered < off + len) {
        return;
      }
      const whole = this.take(off + len);
      const payload = whole.subarray(off, off + len);
      if (masked) {
        const mask = whole.subarray(off - 4, off);
        for (let i = 0; i < len; i++) {
          payload[i] ^= mask[i & 3];
        }
      }
      this.onFrame(fin, opcode, payload);
    }
  }

  /** The first `n` buffered bytes (fewer if that is all there is), without consuming them. */
  private peek(n: number): Buffer {
    const first = this.chunks[0];
    if (first.length >= n) {
      return first.subarray(0, n);
    }
    return Buffer.concat(this.chunks, Math.min(n, this.buffered));
  }

  /** Consume the first `n` buffered bytes. One concat per frame, however many chunks it came in. */
  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return all.subarray(0, n);
  }

  private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case Opcode.Continuation:
      case Opcode.Text:
      case Opcode.Binary: {
        this.fragments.push(payload);
        if (!fin) {
          return;
        }
        const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = [];
        const text = message.toString('utf8');
        for (const fn of this.messageHandlers) {
          fn(text);
        }
        return;
      }
      case Opcode.Close:
        if (!this.closed) {
          try {
            this.socket.write(frame(Opcode.Close, payload.subarray(0, 2)));
          } catch {
            // Peer is gone already.
          }
        }
        this.socket.end();
        return;
      case Opcode.Ping:
        this.socket.write(frame(Opcode.Pong, payload));
        return;
      default:
        return; // pong, reserved
    }
  }

  private handleClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const fn of this.closeHandlers) {
      fn();
    }
    this.closeHandlers = [];
  }
}
