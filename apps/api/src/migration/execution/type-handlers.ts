import type Valkey from 'iovalkey';
import { randomBytes } from 'crypto';

// Threshold above which we use cursor-based reads (HSCAN/SSCAN/ZSCAN) instead of bulk reads
const LARGE_KEY_THRESHOLD = 10_000;
const SCAN_BATCH = 1000;
const LIST_CHUNK = 1000;
const STREAM_CHUNK = 1000;

/** Generate a unique temporary key name to write into before atomic RENAME. */
function tempKey(key: string): string {
  return `__betterdb_mig_${randomBytes(8).toString('hex')}:{${key}}`;
}

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
    let wrote: boolean;
    switch (type) {
      case 'string':
        // String handles TTL atomically via SET PX
        wrote = await migrateString(source, target, key);
        break;
      case 'hash':
        wrote = await migrateHash(source, target, key);
        break;
      case 'list':
        wrote = await migrateList(source, target, key);
        break;
      case 'set':
        wrote = await migrateSet(source, target, key);
        break;
      case 'zset':
        wrote = await migrateZset(source, target, key);
        break;
      case 'stream':
        wrote = await migrateStream(source, target, key);
        break;
      default:
        return { key, type, ok: false, error: `Unsupported type: ${type}` };
    }
    // String handles TTL atomically; compound types need a separate PEXPIRE
    if (wrote && type !== 'string') {
      await migrateTtl(source, target, key);
    }
    return { key, type, ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { key, type, ok: false, error: message };
  }
}

// ── String ──

async function migrateString(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const [value, pttl] = await Promise.all([
    source.getBuffer(key),
    source.pttl(key),
  ]);
  if (value === null) return false; // key expired/deleted between SCAN and GET
  if (pttl > 0) {
    // Atomic SET with PX — no window where key exists without TTL
    await target.set(key, value, 'PX', pttl);
  } else if (pttl === -2) {
    // Key expired between GET and PTTL — remove any ghost copy
    await target.del(key);
    return false;
  } else {
    await target.set(key, value);
  }
  return true;
}

// ── Hash ──

async function migrateHash(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const len = await source.hlen(key);
  if (len === 0) return false;

  // Write to a temp key then atomically RENAME to avoid data loss on crash
  const tmp = tempKey(key);
  try {
    // Use HSCAN for all sizes so binary field names are preserved as Buffers
    // (hgetallBuffer returns Record<string, Buffer> which coerces field names to UTF-8)
    let cursor = '0';
    do {
      const [next, fields] = await source.hscanBuffer(key, cursor, 'COUNT', SCAN_BATCH);
      cursor = String(next);
      if (fields.length === 0) continue;
      const args: (string | Buffer | number)[] = [tmp];
      for (let i = 0; i < fields.length; i += 2) {
        args.push(fields[i], fields[i + 1]);
      }
      await target.call('HSET', ...args);
    } while (cursor !== '0');
    await target.rename(tmp, key);
  } catch (err) {
    try { await target.del(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return true;
}

// ── List ──

async function migrateList(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const len = await source.llen(key);
  if (len === 0) return false;

  // Write to a temp key then atomically RENAME to avoid data loss on crash
  const tmp = tempKey(key);
  try {
    for (let start = 0; start < len; start += LIST_CHUNK) {
      const end = Math.min(start + LIST_CHUNK - 1, len - 1);
      const items = await source.lrangeBuffer(key, start, end);
      if (items.length === 0) break;
      await target.call('RPUSH', tmp, ...items);
    }
    await target.rename(tmp, key);
  } catch (err) {
    try { await target.del(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return true;
}

// ── Set ──

async function migrateSet(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const card = await source.scard(key);
  if (card === 0) return false;

  // Write to a temp key then atomically RENAME to avoid data loss on crash
  const tmp = tempKey(key);
  try {
    if (card <= LARGE_KEY_THRESHOLD) {
      const members = await source.smembersBuffer(key);
      if (members.length === 0) {
        try { await target.del(tmp); } catch { /* best-effort cleanup */ }
        return false; // key expired between SCARD and SMEMBERS
      }
      await target.call('SADD', tmp, ...members);
    } else {
      let cursor = '0';
      do {
        const [next, members] = await source.sscanBuffer(key, cursor, 'COUNT', SCAN_BATCH);
        cursor = String(next);
        if (members.length === 0) continue;
        await target.call('SADD', tmp, ...members);
      } while (cursor !== '0');
    }
    await target.rename(tmp, key);
  } catch (err) {
    try { await target.del(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return true;
}

// ── Sorted Set ──

async function migrateZset(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const card = await source.zcard(key);
  if (card === 0) return false;

  // Write to a temp key then atomically RENAME to avoid data loss on crash
  const tmp = tempKey(key);
  try {
    if (card <= LARGE_KEY_THRESHOLD) {
      // Use callBuffer to preserve binary member data (call() decodes as UTF-8)
      const raw = await source.callBuffer('ZRANGE', key, '0', '-1', 'WITHSCORES') as Buffer[];
      if (!raw || raw.length === 0) {
        try { await target.del(tmp); } catch { /* best-effort cleanup */ }
        return false; // key expired between ZCARD and ZRANGE
      }
      // raw is [member, score, member, score, ...] as Buffers
      const pipeline = target.pipeline();
      for (let i = 0; i < raw.length; i += 2) {
        // Score is always ASCII-safe, member stays as Buffer
        pipeline.zadd(tmp, raw[i + 1].toString(), raw[i]);
      }
      await pipeline.exec();
    } else {
      // zscanBuffer not available — use callBuffer for ZSCAN to preserve binary members
      let cursor = '0';
      do {
        const result = await source.callBuffer('ZSCAN', key, cursor, 'COUNT', String(SCAN_BATCH)) as [Buffer, Buffer[]];
        cursor = result[0].toString();
        const entries = result[1];
        if (!entries || entries.length === 0) continue;
        // entries is [member, score, member, score, ...] as Buffers
        const pipeline = target.pipeline();
        for (let i = 0; i < entries.length; i += 2) {
          pipeline.zadd(tmp, entries[i + 1].toString(), entries[i]);
        }
        await pipeline.exec();
      } while (cursor !== '0');
    }
    await target.rename(tmp, key);
  } catch (err) {
    try { await target.del(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return true;
}

// ── Stream ──

async function migrateStream(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  // Write to a temp key then atomically RENAME to avoid data loss on crash
  const tmp = tempKey(key);
  let wrote = false;

  try {
    let lastId = '-';
    let hasMore = true;

    while (hasMore) {
      const start = lastId === '-' ? '-' : `(${lastId}`;
      // Use callBuffer to preserve binary field names and values
      const raw = await source.callBuffer(
        'XRANGE', key, start, '+', 'COUNT', String(STREAM_CHUNK),
      ) as Buffer[][];
      if (!raw || raw.length === 0) {
        hasMore = false;
        break;
      }
      for (const entry of raw) {
        // entry[0] = stream ID (always ASCII), entry[1] = [field, value, field, value, ...]
        const id = entry[0].toString();
        const fields = entry[1] as unknown as Buffer[];
        await target.callBuffer('XADD', tmp, id, ...fields);
        lastId = id;
        wrote = true;
      }
      if (raw.length < STREAM_CHUNK) {
        hasMore = false;
      }
    }
    if (wrote) {
      await target.rename(tmp, key);
    }
  } catch (err) {
    try { await target.del(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return wrote;
}

// ── TTL ──

async function migrateTtl(source: Valkey, target: Valkey, key: string): Promise<void> {
  const pttl = await source.pttl(key);
  if (pttl > 0) {
    await target.pexpire(key, pttl);
  } else if (pttl === -2) {
    // Key expired between copy and TTL check — remove ghost copy from target
    await target.del(key);
  }
}
