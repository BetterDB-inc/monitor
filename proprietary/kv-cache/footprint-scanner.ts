import type { DatabasePort } from '@app/common/interfaces/database-port.interface';
import type { InfoResponse } from '@app/common/types/metrics.types';
import { classifyKey, siblingKey, type ParsedLmcacheKey } from './key-classifier';
import type { KeySample, MemoryStats } from './footprint-estimate';
import { keySlot, type SlotOwnership } from './key-slot';

export interface ScanBudgets {
  maxScanned: number;
  maxMatched: number;
}

export interface ScanResult {
  scannedKeys: number;
  matchedKeys: ParsedLmcacheKey[];
  scanComplete: boolean;
}

const SCAN_COUNT = 1000;
const GLIDE_LMCACHE = /(?:^| )lib-name=GlidePySync\(lmcache(?::|\))/;
const CLIENT_DB = /(?:^| )db=(\d+)(?: |$)/;

function isLmcacheClientOn(line: string, db: number): boolean {
  if (!GLIDE_LMCACHE.test(line)) return false;
  const clientDb = CLIENT_DB.exec(line)?.[1];
  return clientDb === undefined || Number(clientDb) === db;
}

export async function scanLmcacheKeys(client: DatabasePort, budgets: ScanBudgets, dbSize: number): Promise<ScanResult> {
  let cursor = '0';
  let iterations = 0;
  let returned = 0;
  const matched: ParsedLmcacheKey[] = [];
  const seen = new Set<string>();
  do {
    const [next, keys] = (await client.call('SCAN', [cursor, 'COUNT', String(SCAN_COUNT)])) as [string, string[]];
    cursor = String(next);
    iterations += 1;
    returned += keys.length;
    for (const key of keys) {
      if (seen.has(key)) continue;
      const parsed = classifyKey(key);
      if (!parsed) continue;
      seen.add(key);
      matched.push(parsed);
    }
  } while (
    cursor !== '0' &&
    returned < budgets.maxScanned &&
    iterations * SCAN_COUNT < budgets.maxScanned &&
    matched.length < budgets.maxMatched
  );
  const walked = cursor === '0' ? dbSize : Math.min(returned, dbSize);
  const kept = matched.slice(0, budgets.maxMatched);
  const scannedKeys = kept.length < matched.length ? Math.max(1, Math.floor((walked * kept.length) / matched.length)) : walked;
  return {
    scannedKeys,
    matchedKeys: kept,
    scanComplete: cursor === '0' && matched.length <= budgets.maxMatched,
  };
}

export async function sampleLmcacheKeys(
  client: DatabasePort,
  keys: ParsedLmcacheKey[],
  ownsSlot?: SlotOwnership,
): Promise<KeySample[]> {
  if (keys.length === 0) return [];
  const pipeline = client.getClient().pipeline();
  const plan = keys.map((parsed) => {
    const candidate = siblingKey(parsed);
    const sibling = candidate && (!ownsSlot || ownsSlot(keySlot(candidate))) ? candidate : null;
    pipeline.call('MEMORY', 'USAGE', parsed.key);
    pipeline.ttl(parsed.key);
    if (sibling) pipeline.exists(sibling);
    return { parsed, sibling };
  });
  const replies = ((await pipeline.exec()) ?? []) as Array<[Error | null, unknown]>;
  let index = 0;
  return plan.map(({ parsed, sibling }) => {
    const [memoryErr, memory] = replies[index++] ?? [new Error('missing'), null];
    const [ttlErr, ttl] = replies[index++] ?? [new Error('missing'), null];
    let siblingExists: boolean | null = null;
    if (sibling) {
      const [existsErr, exists] = replies[index++] ?? [new Error('missing'), null];
      siblingExists = existsErr ? null : Number(exists) === 1;
    }
    return {
      parsed,
      memoryBytes: memoryErr || memory === null ? null : Number(memory),
      ttl: ttlErr ? null : Number(ttl),
      siblingExists,
    };
  });
}

export async function hasLmcacheGlideClient(client: DatabasePort, db: number): Promise<boolean> {
  try {
    const lines = String(await client.call('CLIENT', ['LIST'])).split('\n');
    return lines.some((line) => isLmcacheClientOn(line.trim(), db));
  } catch {
    return false;
  }
}

const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function readMemoryStats(info: InfoResponse): MemoryStats {
  return {
    usedMemory: num(info.memory?.used_memory),
    maxmemory: num(info.memory?.maxmemory),
    maxmemoryPolicy: info.memory?.maxmemory_policy ?? 'unknown',
    evictedKeys: num(info.stats?.evicted_keys),
  };
}
