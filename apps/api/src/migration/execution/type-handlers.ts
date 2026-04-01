import type Valkey from 'iovalkey';
import { randomBytes } from 'crypto';

// Threshold above which we use cursor-based reads (HSCAN/SSCAN/ZSCAN) instead of bulk reads
const LARGE_KEY_THRESHOLD = 10_000;
const SCAN_BATCH = 1000;
const LIST_CHUNK = 1000;
const STREAM_CHUNK = 1000;

/**
 * Generate a unique temporary key that hashes to the same slot as the original key.
 * In cluster mode, RENAME requires both keys to be in the same slot.
 *
 * Returns null for keys that contain braces but have no valid hash tag (e.g.
 * `user:{}:1`). Valkey hashes the full key name for these, and we can't
 * construct a temp key in the same slot without embedding `}` which would
 * create a different hash tag. Callers must write directly to the final key
 * when null is returned.
 */
function tempKey(key: string): string | null {
  const suffix = randomBytes(8).toString('hex');
  const openBrace = key.indexOf('{');
  if (openBrace !== -1) {
    const closeBrace = key.indexOf('}', openBrace + 1);
    if (closeBrace > openBrace + 1) {
      // Key has a valid hash tag — reuse it so temp key lands in the same slot
      const tag = key.substring(openBrace, closeBrace + 1);
      return `__betterdb_mig_${suffix}:${tag}`;
    }
    // Braces present but no valid tag (empty `{}` or unclosed `{`).
    // Cannot safely construct a same-slot temp key.
    return null;
  }
  // No braces — wrap the whole key as the tag
  return `__betterdb_mig_${suffix}:{${key}}`;
}

export interface MigratedKey {
  key: string;
  type: string;
  ok: boolean;
  error?: string;
  warning?: string;
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
    // TTL is handled atomically in each handler:
    // - String: SET PX
    // - Compound types: Lua RENAME+PEXPIRE via atomicRenameWithTtl
    const result: MigratedKey = { key, type, ok: true };

    // Post-migration list length check: source list may have changed during migration
    if (wrote && type === 'list') {
      try {
        const targetLen = await target.llen(key);
        const sourceLen = await source.llen(key);
        if (targetLen !== sourceLen) {
          result.warning = `list length changed during migration (migrated: ${targetLen}, current source: ${sourceLen})`;
        }
      } catch { /* non-fatal check */ }
    }

    return result;
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
  } else if (pttl === -2 || pttl === 0) {
    // pttl -2: expired between GET and PTTL; pttl 0: sub-ms remaining — treat as expired
    await target.del(key);
    return false;
  } else {
    // pttl -1: no expiry (persistent key)
    await target.set(key, value);
  }
  return true;
}

// ── Hash ──

async function migrateHash(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const len = await source.hlen(key);
  if (len === 0) return false;

  const tmp = tempKey(key);
  const writeKey = tmp ?? key;

  try {
    // DEL the target when writing directly (no temp key)
    if (!tmp) await target.del(key);

    // Use HSCAN for all sizes so binary field names are preserved as Buffers
    let cursor = '0';
    do {
      const [next, fields] = await source.hscanBuffer(key, cursor, 'COUNT', SCAN_BATCH);
      cursor = String(next);
      if (fields.length === 0) continue;
      const args: (string | Buffer | number)[] = [writeKey];
      for (let i = 0; i < fields.length; i += 2) {
        args.push(fields[i], fields[i + 1]);
      }
      await target.call('HSET', ...args);
    } while (cursor !== '0');
    const pttl = await source.pttl(key);
    if (tmp) {
      await atomicRenameWithTtl(target, tmp, key, pttl);
    } else {
      await applyTtl(target, key, pttl);
    }
  } catch (err) {
    if (tmp) { try { await target.del(tmp); } catch { /* best-effort cleanup */ } }
    throw err;
  }
  return true;
}

// ── List ──

async function migrateList(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const len = await source.llen(key);
  if (len === 0) return false;

  const tmp = tempKey(key);
  const writeKey = tmp ?? key;

  try {
    if (!tmp) await target.del(key);

    for (let start = 0; start < len; start += LIST_CHUNK) {
      const end = Math.min(start + LIST_CHUNK - 1, len - 1);
      const items = await source.lrangeBuffer(key, start, end);
      if (items.length === 0) break;
      await target.call('RPUSH', writeKey, ...items);
    }
    const pttl = await source.pttl(key);
    if (tmp) {
      await atomicRenameWithTtl(target, tmp, key, pttl);
    } else {
      await applyTtl(target, key, pttl);
    }
  } catch (err) {
    if (tmp) { try { await target.del(tmp); } catch { /* best-effort cleanup */ } }
    throw err;
  }
  return true;
}

// ── Set ──

async function migrateSet(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const card = await source.scard(key);
  if (card === 0) return false;

  const tmp = tempKey(key);
  const writeKey = tmp ?? key;

  try {
    if (!tmp) await target.del(key);

    if (card <= LARGE_KEY_THRESHOLD) {
      const members = await source.smembersBuffer(key);
      if (members.length === 0) {
        if (tmp) { try { await target.del(tmp); } catch { /* best-effort cleanup */ } }
        return false; // key expired between SCARD and SMEMBERS
      }
      await target.call('SADD', writeKey, ...members);
    } else {
      let cursor = '0';
      do {
        const [next, members] = await source.sscanBuffer(key, cursor, 'COUNT', SCAN_BATCH);
        cursor = String(next);
        if (members.length === 0) continue;
        await target.call('SADD', writeKey, ...members);
      } while (cursor !== '0');
    }
    const pttl = await source.pttl(key);
    if (tmp) {
      await atomicRenameWithTtl(target, tmp, key, pttl);
    } else {
      await applyTtl(target, key, pttl);
    }
  } catch (err) {
    if (tmp) { try { await target.del(tmp); } catch { /* best-effort cleanup */ } }
    throw err;
  }
  return true;
}

// ── Sorted Set ──

async function migrateZset(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const card = await source.zcard(key);
  if (card === 0) return false;

  const tmp = tempKey(key);
  const writeKey = tmp ?? key;

  try {
    if (!tmp) await target.del(key);

    if (card <= LARGE_KEY_THRESHOLD) {
      // Use callBuffer to preserve binary member data (call() decodes as UTF-8)
      const raw = await source.callBuffer('ZRANGE', key, '0', '-1', 'WITHSCORES') as Buffer[];
      if (!raw || raw.length === 0) {
        if (tmp) { try { await target.del(tmp); } catch { /* best-effort cleanup */ } }
        return false; // key expired between ZCARD and ZRANGE
      }
      // raw is [member, score, member, score, ...] as Buffers
      const pipeline = target.pipeline();
      for (let i = 0; i < raw.length; i += 2) {
        // Score is always ASCII-safe, member stays as Buffer
        pipeline.zadd(writeKey, raw[i + 1].toString(), raw[i]);
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
          pipeline.zadd(writeKey, entries[i + 1].toString(), entries[i]);
        }
        await pipeline.exec();
      } while (cursor !== '0');
    }
    const pttl = await source.pttl(key);
    if (tmp) {
      await atomicRenameWithTtl(target, tmp, key, pttl);
    } else {
      await applyTtl(target, key, pttl);
    }
  } catch (err) {
    if (tmp) { try { await target.del(tmp); } catch { /* best-effort cleanup */ } }
    throw err;
  }
  return true;
}

// ── Stream ──

async function migrateStream(source: Valkey, target: Valkey, key: string): Promise<boolean> {
  const tmp = tempKey(key);
  const writeKey = tmp ?? key;
  let wrote = false;

  try {
    if (!tmp) await target.del(key);

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
        await target.callBuffer('XADD', writeKey, id, ...fields);
        lastId = id;
        wrote = true;
      }
      if (raw.length < STREAM_CHUNK) {
        hasMore = false;
      }
    }
    if (wrote) {
      const pttl = await source.pttl(key);
      if (tmp) {
        await atomicRenameWithTtl(target, tmp, key, pttl);
      } else {
        await applyTtl(target, key, pttl);
      }
    }
  } catch (err) {
    if (tmp) { try { await target.del(tmp); } catch { /* best-effort cleanup */ } }
    throw err;
  }
  return wrote;
}

// ── TTL ──

// Lua script: atomically RENAME tmp→key and PEXPIRE in one round-trip.
// KEYS[1] = tmp, KEYS[2] = final key, ARGV[1] = pttl (or "-1" for no expiry, "-2" for expired)
const RENAME_WITH_TTL_LUA = `
redis.call('RENAME', KEYS[1], KEYS[2])
local pttl = tonumber(ARGV[1])
if pttl > 0 then
  redis.call('PEXPIRE', KEYS[2], pttl)
elseif pttl == -2 or pttl == 0 then
  redis.call('DEL', KEYS[2])
end
return 1
`;


/** Apply TTL directly to a key (used when temp-key RENAME is not possible). */
async function applyTtl(target: Valkey, key: string, pttl: number): Promise<void> {
  if (pttl > 0) {
    await target.pexpire(key, pttl);
  } else if (pttl === -2 || pttl === 0) {
    await target.del(key);
  }
}

/**
 * Atomically RENAME tmp→key and apply PTTL in a single Lua eval.
 * Falls back to separate RENAME + PEXPIRE if EVAL is blocked (e.g. by ACL).
 */
async function atomicRenameWithTtl(
  target: Valkey,
  tmp: string,
  key: string,
  pttl: number,
): Promise<void> {
  try {
    await target.call('EVAL', RENAME_WITH_TTL_LUA, '2', tmp, key, String(pttl));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only fall back for NOSCRIPT / unknown-command / ACL-denied errors.
    // Transient errors (OOM, timeouts) should propagate.
    if (!/NOSCRIPT|unknown command|DENIED|NOPERM/i.test(msg)) {
      throw err;
    }
    await target.rename(tmp, key);
    if (pttl > 0) {
      await target.pexpire(key, pttl);
    } else if (pttl === -2 || pttl === 0) {
      await target.del(key);
    }
  }
}
