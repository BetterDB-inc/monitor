// Minimal RESP2 client: one socket, pipelined FIFO replies. Used by the ground-truth
// collector so it talks to each node directly (primaries and replicas alike) without a
// client library's topology discovery getting in the way.
import { Socket, connect } from 'node:net';

export type Reply = string | number | null | Reply[] | Error;

class Parser {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
  }
  // Returns [reply, consumed] or undefined if incomplete.
  private parse(at: number): [Reply, number] | undefined {
    const nl = this.buf.indexOf('\r\n', at);
    if (nl < 0) return undefined;
    const type = String.fromCharCode(this.buf[at]!);
    const line = this.buf.toString('utf8', at + 1, nl);
    const next = nl + 2;
    switch (type) {
      case '+': return [line, next];
      case '-': return [new Error(line), next];
      case ':': return [Number(line), next];
      case '$': {
        const len = Number(line);
        if (len < 0) return [null, next];
        if (this.buf.length < next + len + 2) return undefined;
        return [this.buf.toString('utf8', next, next + len), next + len + 2];
      }
      case '*': {
        const n = Number(line);
        if (n < 0) return [null, next];
        const out: Reply[] = [];
        let pos = next;
        for (let i = 0; i < n; i++) {
          const r = this.parse(pos);
          if (!r) return undefined;
          out.push(r[0]);
          pos = r[1];
        }
        return [out, pos];
      }
      default:
        throw new Error(`RESP: unexpected type byte ${type}`);
    }
  }
  next(): Reply | undefined {
    if (!this.buf.length) return undefined;
    const r = this.parse(0);
    if (!r) return undefined;
    this.buf = this.buf.subarray(r[1]);
    return r[0];
  }
}

export class RespClient {
  private readonly pending: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private readonly parser = new Parser();
  private closed = false;

  private constructor(private readonly sock: Socket, private readonly timeoutMs: number) {
    sock.on('data', (c) => {
      this.parser.push(c);
      for (let r = this.parser.next(); r !== undefined; r = this.parser.next()) {
        const p = this.pending.shift();
        if (!p) continue;
        clearTimeout(p.timer);
        r instanceof Error ? p.reject(r) : p.resolve(r);
      }
    });
    const fail = (e: Error) => {
      this.closed = true;
      for (const p of this.pending.splice(0)) clearTimeout(p.timer), p.reject(e);
    };
    sock.on('error', fail);
    sock.on('close', () => fail(new Error('connection closed')));
  }

  static open(host: string, port: number, timeoutMs: number, clientName?: string): Promise<RespClient> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host, port });
      sock.setNoDelay(true);
      const t = setTimeout(() => (sock.destroy(), reject(new Error(`connect ${host}:${port} timed out`))), timeoutMs);
      sock.once('error', (e) => (clearTimeout(t), reject(e)));
      sock.once('connect', async () => {
        clearTimeout(t);
        const c = new RespClient(sock, timeoutMs);
        if (clientName) await c.call(['CLIENT', 'SETNAME', clientName]).catch(() => undefined);
        resolve(c);
      });
    });
  }

  get isClosed() {
    return this.closed;
  }

  call(args: string[]): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    let cmd = `*${args.length}\r\n`;
    for (const a of args) cmd += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
    return new Promise((resolve, reject) => {
      // A timed-out reply would desync the FIFO, so a timeout poisons the connection.
      const timer = setTimeout(() => (reject(new Error(`${args[0]} timed out`)), this.close()), this.timeoutMs);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(cmd);
    });
  }

  close() {
    this.closed = true;
    this.sock.destroy();
  }
}
