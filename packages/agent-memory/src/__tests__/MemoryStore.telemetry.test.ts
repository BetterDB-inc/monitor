import { describe, it, expect, vi } from 'vitest';
import { Registry } from 'prom-client';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

function recallHit(distance: number): unknown[] {
  const now = Date.now();
  const fields: Record<string, string> = {
    __score: String(distance),
    content: 'c',
    importance: '0.5',
    created_at: String(now),
    last_accessed_at: String(now),
    access_count: '0',
  };
  const flat: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    flat.push(field, value);
  }
  return ['1', 'mem:mem:a', flat];
}

function evictionFields(importance: number, lastAccessedAt: number): Record<string, string> {
  return { importance: String(importance), last_accessed_at: String(lastAccessedAt) };
}

function evictionSearch(total: number, hits: Array<[string, Record<string, string>]>): unknown[] {
  const out: unknown[] = [String(total)];
  for (const [key, fieldMap] of hits) {
    const flat: string[] = [];
    for (const [f, v] of Object.entries(fieldMap)) {
      flat.push(f, v);
    }
    out.push(key, flat);
  }
  return out;
}

function consolidateHit(id: string): [string, string[]] {
  const created = Date.now() - 100000 * 1000;
  const fields: Record<string, string> = {
    content: `c-${id}`,
    importance: '0.2',
    created_at: String(created),
    last_accessed_at: String(created),
    access_count: '0',
  };
  const flat: string[] = [];
  for (const [f, v] of Object.entries(fields)) {
    flat.push(f, v);
  }
  return [`mem:mem:${id}`, flat];
}

describe('MemoryStore metrics', () => {
  it('counts embedding calls and bumps the items gauge on remember', async () => {
    const registry = new Registry();
    const store = new MemoryStore({
      client: mockClient(() => 'OK'),
      name: 'mem',
      embedFn: fakeEmbed(8),
      telemetry: { registry },
    });

    await store.remember('hi');

    const text = await registry.metrics();
    expect(text).toMatch(/agent_memory_embedding_calls_total\{store_name="mem"\} 1/);
    expect(text).toMatch(/agent_memory_items\{store_name="mem"\} 1/);
  });

  it('records a recall hit', async () => {
    const registry = new Registry();
    const client = mockClient((command) => (command === 'FT.SEARCH' ? recallHit(0.1) : 'OK'));
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      telemetry: { registry },
    });

    await store.recall('q', { k: 1 });

    const text = await registry.metrics();
    expect(text).toMatch(/agent_memory_recall_total\{store_name="mem"\} 1/);
    expect(text).toMatch(/agent_memory_recall_hits_total\{store_name="mem"\} 1/);
    expect(text).toMatch(/agent_memory_recall_latency_seconds_count\{store_name="mem"\} 1/);
  });

  it('records an empty recall', async () => {
    const registry = new Registry();
    const client = mockClient((command) => (command === 'FT.SEARCH' ? ['0'] : 'OK'));
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      telemetry: { registry },
    });

    await store.recall('q', { k: 1 });

    const text = await registry.metrics();
    expect(text).toMatch(/agent_memory_recall_empty_total\{store_name="mem"\} 1/);
    expect(text).not.toMatch(/agent_memory_recall_hits_total\{store_name="mem"\} [1-9]/);
  });

  it('counts evictions when capacity is enforced', async () => {
    const registry = new Registry();
    const client = mockClient((command, ...args) => {
      if (command === 'FT.SEARCH') {
        if (args.includes('RETURN')) {
          return evictionSearch(3, [
            ['mem:mem:a', evictionFields(0.1, 1000)],
            ['mem:mem:b', evictionFields(0.9, 5000)],
            ['mem:mem:c', evictionFields(0.5, 9000)],
          ]);
        }
        return evictionSearch(3, []);
      }
      return 'OK';
    });
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      maxItemsPerScope: 2,
      telemetry: { registry },
    });

    await store.remember('content', { namespace: 'u1' });

    const text = await registry.metrics();
    expect(text).toMatch(/agent_memory_evictions_total\{store_name="mem"\} 1/);
  });

  it('counts consolidations', async () => {
    const registry = new Registry();
    const client = mockClient((command, ...args) => {
      if (command === 'FT.SEARCH') {
        return evictionSearch(1, [consolidateHit('a')]);
      }
      if (command === 'DEL') {
        return args.length;
      }
      return 'OK';
    });
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      telemetry: { registry },
    });

    await store.consolidate({ namespace: 'u1', summarize: vi.fn(async () => 'summary') });

    const text = await registry.metrics();
    expect(text).toMatch(/agent_memory_consolidations_total\{store_name="mem"\} 1/);
  });

  it('honours a configurable metrics prefix', async () => {
    const registry = new Registry();
    const store = new MemoryStore({
      client: mockClient(() => 'OK'),
      name: 'mem',
      embedFn: fakeEmbed(8),
      telemetry: { registry, metricsPrefix: 'mymem' },
    });

    await store.remember('hi');

    const text = await registry.metrics();
    expect(text).toMatch(/mymem_embedding_calls_total\{store_name="mem"\} 1/);
  });
});
