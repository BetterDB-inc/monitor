import type Valkey from 'iovalkey';

// Threshold above which we use cursor-based reads (HSCAN/SSCAN/ZSCAN) instead of bulk reads
const LARGE_KEY_THRESHOLD = 10_000;
const SCAN_BATCH = 1000;
const LIST_CHUNK = 1000;
const STREAM_CHUNK = 1000;

export interface MigratedKey {
  key: string;
  type: string;
  ok: boolean;
  error?: string;
}

/**
 * Migrate a single key from source to target using type-specific commands.
 * Returns success/failure per key. Never throws — errors are captured in the result.
 */
export async function migrateKey(
  source: Valkey,
  target: Valkey,
  key: string,
  type: string,
): Promise<MigratedKey> {
  try {
    switch (type) {
      case 'string':
        await migrateString(source, target, key);
        break;
      case 'hash':
        await migrateHash(source, target, key);
        break;
      case 'list':
        await migrateList(source, target, key);
        break;
      case 'set':
        await migrateSet(source, target, key);
        break;
      case 'zset':
        await migrateZset(source, target, key);
        break;
      case 'stream':
        await migrateStream(source, target, key);
        break;
      default:
        return { key, type, ok: false, error: `Unsupported type: ${type}` };
    }
    // Preserve TTL
    await migrateTtl(source, target, key);
    return { key, type, ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { key, type, ok: false, error: message };
  }
}

// ── String ──

async function migrateString(source: Valkey, target: Valkey, key: string): Promise<void> {
  const value = await source.getBuffer(key);
  if (value === null) return; // key expired/deleted between SCAN and GET
  await target.set(key, value);
}

// ── Hash ──

async function migrateHash(source: Valkey, target: Valkey, key: string): Promise<void> {
  const len = await source.hlen(key);
  if (len === 0) return;

  // Delete target key first to avoid merging with stale data
  await target.del(key);

  if (len <= LARGE_KEY_THRESHOLD) {
    // Small hash: single HGETALL
    const data = await source.hgetallBuffer(key);
    if (!data || Object.keys(data).length === 0) return;
    const args: (string | Buffer | number)[] = [key];
    for (const [field, val] of Object.entries(data)) {
      args.push(field, val as Buffer);
    }
    await target.call('HSET', ...args);
  } else {
    // Large hash: HSCAN
    let cursor = '0';
    do {
      const [next, fields] = await source.hscanBuffer(key, cursor, 'COUNT', SCAN_BATCH);
      cursor = String(next);
      if (fields.length === 0) continue;
      const args: (string | Buffer | number)[] = [key];
      for (let i = 0; i < fields.length; i += 2) {
        args.push(fields[i], fields[i + 1]);
      }
      await target.call('HSET', ...args);
    } while (cursor !== '0');
  }
}

// ── List ──

async function migrateList(source: Valkey, target: Valkey, key: string): Promise<void> {
  const len = await source.llen(key);
  if (len === 0) return;

  // Delete target key first to avoid appending to existing data
  await target.del(key);

  for (let start = 0; start < len; start += LIST_CHUNK) {
    const end = Math.min(start + LIST_CHUNK - 1, len - 1);
    const items = await source.lrangeBuffer(key, start, end);
    if (items.length === 0) break;
    await target.call('RPUSH', key, ...items);
  }
}

// ── Set ──

async function migrateSet(source: Valkey, target: Valkey, key: string): Promise<void> {
  const card = await source.scard(key);
  if (card === 0) return;

  // Delete target key first to avoid merging with stale data
  await target.del(key);

  if (card <= LARGE_KEY_THRESHOLD) {
    const members = await source.smembersBuffer(key);
    if (members.length === 0) return;
    await target.call('SADD', key, ...members);
  } else {
    let cursor = '0';
    do {
      const [next, members] = await source.sscanBuffer(key, cursor, 'COUNT', SCAN_BATCH);
      cursor = String(next);
      if (members.length === 0) continue;
      await target.call('SADD', key, ...members);
    } while (cursor !== '0');
  }
}

// ── Sorted Set ──

async function migrateZset(source: Valkey, target: Valkey, key: string): Promise<void> {
  const card = await source.zcard(key);
  if (card === 0) return;

  // Delete target key first to avoid merging with stale data
  await target.del(key);

  if (card <= LARGE_KEY_THRESHOLD) {
    const data = await source.call('ZRANGE', key, '0', '-1', 'WITHSCORES') as string[];
    if (!data || data.length === 0) return;
    // data is [member, score, member, score, ...]
    const pipeline = target.pipeline();
    for (let i = 0; i < data.length; i += 2) {
      pipeline.zadd(key, data[i + 1], data[i]);
    }
    await pipeline.exec();
  } else {
    let cursor = '0';
    do {
      const [next, entries] = await source.zscan(key, cursor, 'COUNT', SCAN_BATCH);
      cursor = next;
      if (entries.length === 0) continue;
      const pipeline = target.pipeline();
      for (let i = 0; i < entries.length; i += 2) {
        pipeline.zadd(key, entries[i + 1], entries[i]);
      }
      await pipeline.exec();
    } while (cursor !== '0');
  }
}

// ── Stream ──

async function migrateStream(source: Valkey, target: Valkey, key: string): Promise<void> {
  // Delete target key first to avoid duplicates on re-migration
  await target.del(key);

  let lastId = '-';
  let hasMore = true;

  while (hasMore) {
    const entries = await source.xrange(key, lastId === '-' ? '-' : `(${lastId}`, '+', 'COUNT', STREAM_CHUNK);
    if (!entries || entries.length === 0) {
      hasMore = false;
      break;
    }
    for (const [id, fields] of entries) {
      // XADD with explicit ID to preserve ordering
      await target.call('XADD', key, id, ...fields);
      lastId = id;
    }
    if (entries.length < STREAM_CHUNK) {
      hasMore = false;
    }
  }
}

// ── TTL ──

async function migrateTtl(source: Valkey, target: Valkey, key: string): Promise<void> {
  const pttl = await source.pttl(key);
  if (pttl > 0) {
    await target.pexpire(key, pttl);
  }
}
