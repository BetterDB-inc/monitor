import { createServer, type AddressInfo } from 'net';

export interface ShakeShardStatus {
  shard: string;
  inAof: boolean;
  diff: number | null;
}

export interface ShakeStatus {
  consistent: boolean;
  shards: ShakeShardStatus[];
}

const SYNCING_AOF = 'syncing aof';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseShard(reader: unknown, index: number): ShakeShardStatus | null {
  if (!isRecord(reader) || typeof reader.status !== 'string') {
    return null;
  }
  const shard = `src-${index}`;
  const inAof = reader.status === SYNCING_AOF;
  const received = reader.aof_received_offset;
  const sent = reader.aof_sent_offset;
  if (!inAof || typeof received !== 'number' || typeof sent !== 'number' || sent <= 0 || received < sent) {
    return { shard, inAof, diff: null };
  }
  return { shard, inAof, diff: received - sent };
}

export function parseShakeStatus(body: unknown): ShakeStatus | null {
  if (!isRecord(body) || typeof body.consistent !== 'boolean') {
    return null;
  }
  const readers = Array.isArray(body.reader) ? body.reader : isRecord(body.reader) ? [body.reader] : [];
  const shards = readers.map(parseShard);
  if (shards.length === 0 || shards.some((s) => s === null)) {
    return null;
  }
  return { consistent: body.consistent, shards: shards as ShakeShardStatus[] };
}

export async function fetchShakeStatus(port: number, timeoutMs: number): Promise<ShakeStatus | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return null;
    }
    return parseShakeStatus(await res.json());
  } catch {
    return null;
  }
}

export interface PortReservation {
  port: number;
  release: () => Promise<void>;
}

export function reservePort(): Promise<PortReservation> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      let released: Promise<void> | null = null;
      const release = () => {
        released ??= new Promise<void>((done) => server.close(() => done()));
        return released;
      };
      resolve({ port, release });
    });
  });
}
