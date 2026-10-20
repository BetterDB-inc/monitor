import type Valkey from 'iovalkey';
import type { SessionListResponse, SessionSummary } from '@betterdb/shared';
import type { DatabasePort } from '../common/interfaces/database-port.interface';
import type { PresetDefinition } from './presets/types';
import { withPrimaries } from './primary-nodes';

export const DEFAULT_KEY_CAP = 10000;
export const DEFAULT_BATCH = 1000;
const SCAN_COUNT = 1000;

type PipelineResult = [Error | null, unknown] | undefined;

interface KeyMeta {
  memory: number | null;
  idle: number | null;
  pttl: number;
}

interface ScanOutcome {
  keys: string[];
  exhausted: boolean;
}

interface NodeKeys {
  client: Valkey;
  keys: string[];
}

interface ScanAllOutcome {
  nodes: NodeKeys[];
  scannedKeys: number;
  truncated: boolean;
  failed: number;
}

export interface SessionKeysResult {
  keys: string[];
  truncated: boolean;
  failedNodes: number;
}

async function scanNode(client: Valkey, pattern: string, limit: number): Promise<ScanOutcome> {
  const seen = new Set<string>();
  let cursor = '0';
  do {
    const [next, page] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    cursor = next;
    for (const key of page) {
      if (seen.size >= limit) break;
      seen.add(key);
    }
  } while (cursor !== '0' && seen.size < limit);
  return { keys: [...seen], exhausted: cursor === '0' };
}

async function scanAll(clients: Valkey[], pattern: string, keyCap: number): Promise<ScanAllOutcome> {
  const nodes: NodeKeys[] = [];
  let scannedKeys = 0;
  let truncated = false;
  let failed = 0;
  let lastError: unknown;

  for (const [index, client] of clients.entries()) {
    if (scannedKeys >= keyCap) {
      truncated = true;
      break;
    }
    try {
      const { keys, exhausted } = await scanNode(client, pattern, keyCap - scannedKeys);
      scannedKeys += keys.length;
      if (!exhausted || (scannedKeys >= keyCap && index < clients.length - 1)) truncated = true;
      nodes.push({ client, keys });
    } catch (err) {
      failed++;
      lastError = err;
    }
  }

  if (nodes.length === 0 && lastError !== undefined) throw lastError;
  return { nodes, scannedKeys, truncated, failed };
}

const numberOf = (r: PipelineResult): number | null =>
  r && !r[0] && typeof r[1] === 'number' ? r[1] : null;

async function fetchMeta(
  client: Valkey,
  keys: string[],
  batch: number,
): Promise<Map<string, KeyMeta>> {
  const meta = new Map<string, KeyMeta>();
  for (let start = 0; start < keys.length; start += batch) {
    const slice = keys.slice(start, start + batch);
    const pipeline = client.pipeline();
    for (const key of slice) {
      pipeline.type(key);
      pipeline.pttl(key);
      pipeline.memory('USAGE', key);
      pipeline.object('IDLETIME', key);
    }
    const results = (await pipeline.exec()) ?? [];
    slice.forEach((key, i) => {
      const [type, pttl, memory, idle] = results.slice(i * 4, i * 4 + 4) as PipelineResult[];
      if (!type || type[0] || type[1] === 'none') return;
      const ttl = numberOf(pttl);
      if (ttl === -2) return;
      meta.set(key, { memory: numberOf(memory), idle: numberOf(idle), pttl: ttl ?? -1 });
    });
  }
  return meta;
}

const minOrNull = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.min(a, b);

function summarise(sessionId: string, keys: KeyMeta[]): SessionSummary {
  return keys.reduce<SessionSummary>(
    (acc, k) => ({
      ...acc,
      memoryBytes: acc.memoryBytes + (k.memory ?? 0),
      unmeasuredKeys: acc.unmeasuredKeys + (k.memory === null ? 1 : 0),
      idleSeconds: minOrNull(acc.idleSeconds, k.idle),
      ttlMs: k.pttl > 0 ? minOrNull(acc.ttlMs, k.pttl) : acc.ttlMs,
    }),
    {
      sessionId,
      keyCount: keys.length,
      memoryBytes: 0,
      unmeasuredKeys: 0,
      idleSeconds: null,
      ttlMs: null,
    },
  );
}

export async function scanSessions(
  db: DatabasePort,
  pattern: string,
  preset: PresetDefinition,
  opts: { keyCap?: number; batch?: number } = {},
): Promise<SessionListResponse> {
  const keyCap = opts.keyCap ?? DEFAULT_KEY_CAP;
  const batch = opts.batch ?? DEFAULT_BATCH;

  return withPrimaries(db, async ({ clients, failed: unreachable }) => {
    const scan = await scanAll(clients, pattern, keyCap);
    const grouped = new Map<string, KeyMeta[]>();
    let failed = unreachable + scan.failed;
    let lastError: unknown;
    let succeeded = 0;

    for (const { client, keys } of scan.nodes) {
      try {
        const sessionKeys = keys.filter((key) => preset.sessionIdOf(key) !== null);
        const meta = await fetchMeta(client, sessionKeys, batch);
        for (const [key, m] of meta) {
          const sessionId = preset.sessionIdOf(key) as string;
          const list = grouped.get(sessionId) ?? [];
          list.push(m);
          grouped.set(sessionId, list);
        }
        succeeded++;
      } catch (err) {
        failed++;
        lastError = err;
      }
    }

    if (succeeded === 0 && lastError !== undefined) throw lastError;

    return {
      sessions: [...grouped].map(([id, keys]) => summarise(id, keys)),
      scannedKeys: scan.scannedKeys,
      truncated: scan.truncated,
      partial: failed > 0,
      failedNodes: failed,
    };
  });
}

export async function keysForSession(
  db: DatabasePort,
  pattern: string,
  preset: PresetDefinition,
  sessionId: string,
  keyCap: number = DEFAULT_KEY_CAP,
): Promise<SessionKeysResult> {
  return withPrimaries(db, async ({ clients, failed }) => {
    const scan = await scanAll(clients, pattern, keyCap);
    return {
      keys: scan.nodes.flatMap(({ keys }) =>
        keys.filter((key) => preset.sessionIdOf(key) === sessionId),
      ),
      truncated: scan.truncated,
      failedNodes: failed + scan.failed,
    };
  });
}
