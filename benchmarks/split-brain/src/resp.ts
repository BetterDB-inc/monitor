import net from 'node:net';

export type Reply = string | number | null | Reply[];

export class RespError extends Error {}

class CommandTimeout extends Error {}

interface Parsed {
  value: Reply | RespError;
  next: number;
}

function parseAt(buffer: Buffer, offset: number): Parsed | null {
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const head = buffer.toString('utf8', offset + 1, lineEnd);
  const next = lineEnd + 2;
  switch (String.fromCharCode(buffer[offset])) {
    case '+':
      return { value: head, next };
    case '-':
      return { value: new RespError(head), next };
    case ':':
      return { value: Number(head), next };
    case '$': {
      const length = Number(head);
      if (length < 0) return { value: null, next };
      if (buffer.length < next + length + 2) return null;
      return { value: buffer.toString('utf8', next, next + length), next: next + length + 2 };
    }
    case '*': {
      const count = Number(head);
      if (count < 0) return { value: null, next };
      const items: Reply[] = [];
      let cursor = next;
      for (let i = 0; i < count; i++) {
        const item = parseAt(buffer, cursor);
        if (!item) return null;
        items.push(item.value instanceof RespError ? item.value.message : item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`unexpected RESP type byte ${buffer[offset]}`);
  }
}

export class RespClient {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending: Array<{ resolve: (reply: Reply) => void; reject: (err: Error) => void }> = [];
  closed = false;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.close(err));
    socket.on('close', () => this.close(new Error('connection closed')));
  }

  static connect(host: string, port: number, timeoutMs: number): Promise<RespClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('connect timed out'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new RespClient(socket));
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(...args: string[]): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const parts = [`*${args.length}\r\n`];
    for (const arg of args) parts.push(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(parts.join(''));
    });
  }

  close(err: Error = new Error('connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    for (const waiter of this.pending.splice(0)) waiter.reject(err);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    while (offset < this.buffer.length) {
      let parsed: Parsed | null;
      try {
        parsed = parseAt(this.buffer, offset);
      } catch (err) {
        this.close(err as Error);
        return;
      }
      if (!parsed) break;
      offset = parsed.next;
      const waiter = this.pending.shift();
      if (!waiter) continue;
      if (parsed.value instanceof RespError) waiter.reject(parsed.value);
      else waiter.resolve(parsed.value);
    }
    this.buffer = offset === 0 ? this.buffer : this.buffer.subarray(offset);
  }
}

const pool = new Map<number, Promise<RespClient>>();

function pooled(port: number, timeoutMs: number): Promise<RespClient> {
  const existing = pool.get(port);
  if (existing) return existing;
  const opening = RespClient.connect('127.0.0.1', port, timeoutMs);
  pool.set(port, opening);
  opening.catch(() => {
    if (pool.get(port) === opening) pool.delete(port);
  });
  return opening;
}

export async function command(port: number, args: string[], timeoutMs = 3_000): Promise<Reply> {
  const opening = pooled(port, timeoutMs);
  const client = await opening;
  if (client.closed) {
    if (pool.get(port) === opening) pool.delete(port);
    return command(port, args, timeoutMs);
  }
  const expired = new CommandTimeout(`${args.join(' ')} timed out`);
  const timer = setTimeout(() => client.close(expired), timeoutMs);
  try {
    return await client.send(...args);
  } catch (err) {
    if (err instanceof RespError) throw err;
    client.close();
    if (pool.get(port) === opening) pool.delete(port);
    if (err instanceof CommandTimeout && err !== expired) {
      throw new Error(`${args.join(' ')} failed: the connection was closed after ${err.message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function closeConnections(ports?: number[]): Promise<void> {
  for (const port of ports ?? [...pool.keys()]) {
    const opening = pool.get(port);
    pool.delete(port);
    await opening?.then(
      (client) => client.close(),
      () => undefined,
    );
  }
}
