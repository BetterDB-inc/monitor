import Redis from 'iovalkey';

export interface ValkeyClientOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

export function createValkeyClient(opts: ValkeyClientOptions): Redis {
  return new Redis({
    host: opts.host,
    port: opts.port,
    password: opts.password,
    db: opts.db ?? 0,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });
}

export async function flushCacheNamespace(client: Redis, cacheName: string): Promise<number> {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${cacheName}:*`, 'COUNT', 1000);
    cursor = next;
    if (keys.length > 0) {
      removed += await client.del(...keys);
    }
  } while (cursor !== '0');
  return removed;
}
