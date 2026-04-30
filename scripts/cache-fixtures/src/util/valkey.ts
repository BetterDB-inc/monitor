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

const REGISTRY_KEY = '__betterdb:caches';
const HEARTBEAT_KEY_PREFIX = '__betterdb:heartbeat:';

export interface DiscoveryMarkerOptions {
  type: 'semantic_cache' | 'agent_cache';
  prefix: string;
  capabilities: string[];
  protocolVersion?: number;
}

export async function publishDiscoveryMarker(
  client: Redis,
  cacheName: string,
  opts: DiscoveryMarkerOptions,
): Promise<void> {
  const marker = {
    type: opts.type,
    prefix: opts.prefix,
    capabilities: opts.capabilities,
    protocol_version: opts.protocolVersion ?? 1,
    started_at: new Date().toISOString(),
    pid: process.pid,
    hostname: 'cache-fixtures',
  };
  await client.hset(REGISTRY_KEY, cacheName, JSON.stringify(marker));
  await client.set(`${HEARTBEAT_KEY_PREFIX}${cacheName}`, '1', 'EX', 300);
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
