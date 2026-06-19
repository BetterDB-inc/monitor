import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Valkey from 'iovalkey';
import { MemoryStore } from '../MemoryStore';
import type { MemoryStoreClient } from '../types';
import { fakeEmbed } from './helpers/fakeEmbed';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6380';
const NAME = 'agentmem_it';
const INDEX = `${NAME}:mem:idx`;
const DIMS = 16;

let client: Valkey;
let store: MemoryStore;
let skip = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(fn: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) {
      return;
    }
    await sleep(100);
  }
  throw new Error('pollUntil timed out');
}

async function ftCount(filter: string): Promise<number> {
  const raw = await client.call('FT.SEARCH', INDEX, filter, 'LIMIT', '0', '0', 'DIALECT', '2');
  return Array.isArray(raw) ? Number(raw[0]) : 0;
}

async function dropAndClean(): Promise<void> {
  try {
    await client.call('FT.DROPINDEX', INDEX);
  } catch {
    // index may not exist yet
  }
  const keys = await client.keys(`${NAME}:*`);
  if (keys.length > 0) {
    await client.del(...keys);
  }
}

async function createIndex(): Promise<void> {
  await client.call(
    'FT.CREATE',
    INDEX,
    'ON',
    'HASH',
    'PREFIX',
    '1',
    `${NAME}:mem:`,
    'SCHEMA',
    'vector',
    'VECTOR',
    'FLAT',
    '6',
    'TYPE',
    'FLOAT32',
    'DIM',
    String(DIMS),
    'DISTANCE_METRIC',
    'COSINE',
    'threadId',
    'TAG',
    'agentId',
    'TAG',
    'namespace',
    'TAG',
    'tags',
    'TAG',
    'SEPARATOR',
    ',',
    'source',
    'TAG',
    'importance',
    'NUMERIC',
    'created_at',
    'NUMERIC',
    'last_accessed_at',
    'NUMERIC',
    'access_count',
    'NUMERIC',
    'content',
    'TEXT',
  );
}

beforeAll(async () => {
  client = new Valkey(VALKEY_URL, { lazyConnect: true, retryStrategy: () => null });
  // Attach unconditionally: iovalkey emits 'error' on the client, so a mid-run
  // connection drop on the happy path would otherwise be an unhandled rejection.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
  } catch {
    skip = true;
    return;
  }
  await dropAndClean();
  await createIndex();
  store = new MemoryStore({
    client: client as unknown as MemoryStoreClient,
    name: NAME,
    embedFn: fakeEmbed(DIMS),
  });
});

afterAll(async () => {
  if (!skip) {
    await dropAndClean().catch(() => undefined);
  }
  if (client) {
    client.disconnect();
  }
});

describe('MemoryStore integration (real valkey-search)', () => {
  it('round-trips remember -> recall at near-zero distance', async () => {
    if (skip) return;
    const text = 'The Eiffel Tower is in Paris';
    const id = await store.remember(text, { namespace: 'rt' });

    await pollUntil(async () => (await store.recall(text, { namespace: 'rt', k: 5 })).length > 0);
    const hits = await store.recall(text, { namespace: 'rt', k: 5 });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.id).toBe(id);
    expect(hits[0].item.content).toBe(text);
    expect(hits[0].similarity).toBeLessThan(0.01);
  });

  it('isolates recall by scope and tag filters', async () => {
    if (skip) return;
    const text = 'shared topic alpha';
    await store.remember(text, { namespace: 'tenantA', tags: ['team-x'] });
    await store.remember(text, { namespace: 'tenantB', tags: ['team-y'] });
    await pollUntil(async () => (await ftCount('@namespace:{tenantA}')) >= 1);
    await pollUntil(async () => (await ftCount('@namespace:{tenantB}')) >= 1);

    const a = await store.recall(text, { namespace: 'tenantA', k: 5 });
    expect(a.length).toBe(1);
    expect(a.every((h) => h.item.namespace === 'tenantA')).toBe(true);

    const tagged = await store.recall(text, { tags: ['team-x'], k: 5 });
    expect(tagged.length).toBe(1);
    expect(tagged.every((h) => h.item.tags.includes('team-x'))).toBe(true);
  });

  it('evicts past capacity on a live server and records the eviction', async () => {
    if (skip) return;
    const capped = new MemoryStore({
      client: client as unknown as MemoryStoreClient,
      name: NAME,
      embedFn: fakeEmbed(DIMS),
      maxItemsPerScope: 3,
    });
    for (let i = 0; i < 5; i++) {
      await capped.remember(`capacity item number ${i}`, { namespace: 'cap' });
      await pollUntil(async () => (await ftCount('@namespace:{cap}')) >= Math.min(i + 1, 3));
    }

    const evictions = Number(await client.call('HGET', `${NAME}:__mem_stats`, 'evictions'));
    expect(evictions).toBeGreaterThanOrEqual(1);
    await pollUntil(async () => (await ftCount('@namespace:{cap}')) <= 3);
    expect(await ftCount('@namespace:{cap}')).toBeLessThanOrEqual(3);
  });

  it('expires a ttl-scoped memory', async () => {
    if (skip) return;
    const id = await store.remember('ephemeral note', { namespace: 'ttl', ttl: 1 });
    expect(await client.exists(`${NAME}:mem:${id}`)).toBe(1);

    await sleep(1500);
    expect(await client.exists(`${NAME}:mem:${id}`)).toBe(0);
  });

  it('consolidates old memories into a recallable summary', async () => {
    if (skip) return;
    await store.remember('meeting note one', { namespace: 'cons', importance: 0.2 });
    await store.remember('meeting note two', { namespace: 'cons', importance: 0.2 });
    await pollUntil(async () => (await ftCount('@namespace:{cons}')) >= 2);

    const summarize = vi.fn(async (items: { id: string }[]) => `Summary of ${items.length} notes`);
    const result = await store.consolidate({ namespace: 'cons', maxImportance: 0.5, summarize });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.consolidated).toBe(2);
    expect(result.created).toHaveLength(1);
    expect(result.deleted).toBe(2);

    await pollUntil(async () => {
      const hits = await store.recall('Summary of 2 notes', { namespace: 'cons', k: 5 });
      return hits.some((h) => h.item.source === 'summary');
    });
  });
});
