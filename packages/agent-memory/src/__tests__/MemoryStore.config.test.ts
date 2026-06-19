import { describe, it, expect, vi } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

const DEFAULT_WEIGHTS = { similarity: 0.6, recency: 0.25, importance: 0.15 };

function configReply(fields: Record<string, string>): string[] {
  const flat: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    flat.push(field, value);
  }
  return flat;
}

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

function configClient(fields: Record<string, string>, others?: (command: string) => unknown) {
  return mockClient((command, ...args) => {
    if (command === 'HGETALL') {
      return configReply(fields);
    }
    return others ? others(command) : 'OK';
  });
}

describe('MemoryStore.currentConfig', () => {
  it('reflects the constructor defaults before any refresh', () => {
    const store = new MemoryStore({ client: mockClient(), name: 'mem', embedFn: fakeEmbed(8) });
    expect(store.currentConfig()).toEqual({
      threshold: 0.25,
      weights: DEFAULT_WEIGHTS,
      halfLifeSeconds: 604800,
      maxItemsPerScope: undefined,
    });
  });
});

describe('MemoryStore config refresh', () => {
  it('applies recall.threshold from the config hash', async () => {
    const store = new MemoryStore({
      client: configClient({ 'recall.threshold': '0.5' }),
      name: 'mem',
      embedFn: fakeEmbed(8),
    });
    await store.refreshConfig();
    expect(store.currentConfig().threshold).toBe(0.5);
  });

  it('applies recall weights from the config hash', async () => {
    const store = new MemoryStore({
      client: configClient({
        'recall.weights.similarity': '0.2',
        'recall.weights.recency': '0.7',
        'recall.weights.importance': '0.1',
      }),
      name: 'mem',
      embedFn: fakeEmbed(8),
    });
    await store.refreshConfig();
    expect(store.currentConfig().weights).toEqual({
      similarity: 0.2,
      recency: 0.7,
      importance: 0.1,
    });
  });

  it('applies recall.halfLifeSeconds and maxItemsPerScope', async () => {
    const store = new MemoryStore({
      client: configClient({ 'recall.halfLifeSeconds': '3600', maxItemsPerScope: '100' }),
      name: 'mem',
      embedFn: fakeEmbed(8),
    });
    await store.refreshConfig();
    expect(store.currentConfig().halfLifeSeconds).toBe(3600);
    expect(store.currentConfig().maxItemsPerScope).toBe(100);
  });

  it('leaves unspecified tunables at their constructor values', async () => {
    const store = new MemoryStore({
      client: configClient({ 'recall.threshold': '0.5' }),
      name: 'mem',
      embedFn: fakeEmbed(8),
      weights: { similarity: 0.5, recency: 0.3, importance: 0.2 },
    });
    await store.refreshConfig();
    expect(store.currentConfig().threshold).toBe(0.5);
    expect(store.currentConfig().weights).toEqual({
      similarity: 0.5,
      recency: 0.3,
      importance: 0.2,
    });
  });

  it('reverts a tunable to its constructor value when the field disappears', async () => {
    let present = true;
    const client = mockClient((command) => {
      if (command === 'HGETALL') {
        return present ? configReply({ 'recall.threshold': '0.9' }) : configReply({});
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.refreshConfig();
    expect(store.currentConfig().threshold).toBe(0.9);

    present = false;
    await store.refreshConfig();
    expect(store.currentConfig().threshold).toBe(0.25);
  });

  it('ignores invalid values and keeps the constructor defaults', async () => {
    const store = new MemoryStore({
      client: configClient({
        'recall.threshold': '5',
        'recall.weights.recency': 'not-a-number',
        'recall.halfLifeSeconds': '-1',
        maxItemsPerScope: '0',
      }),
      name: 'mem',
      embedFn: fakeEmbed(8),
    });
    await store.refreshConfig();
    expect(store.currentConfig()).toEqual({
      threshold: 0.25,
      weights: DEFAULT_WEIGHTS,
      halfLifeSeconds: 604800,
      maxItemsPerScope: undefined,
    });
  });

  it('rejects an all-zero weight vector and keeps the constructor weights', async () => {
    const store = new MemoryStore({
      client: configClient({
        'recall.weights.similarity': '0',
        'recall.weights.recency': '0',
        'recall.weights.importance': '0',
      }),
      name: 'mem',
      embedFn: fakeEmbed(8),
    });
    await store.refreshConfig();
    expect(store.currentConfig().weights).toEqual(DEFAULT_WEIGHTS);
  });

  it('preserves the live weight components when only a subset is written', async () => {
    let hash: Record<string, string> = {
      'recall.weights.similarity': '0.2',
      'recall.weights.recency': '0.7',
      'recall.weights.importance': '0.1',
    };
    const client = mockClient((command) => (command === 'HGETALL' ? configReply(hash) : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.refreshConfig();
    expect(store.currentConfig().weights).toEqual({ similarity: 0.2, recency: 0.7, importance: 0.1 });

    // A partial write that nudges only similarity must keep the live recency
    // and importance, not reset them to the constructor defaults.
    hash = { 'recall.weights.similarity': '0.5' };
    await store.refreshConfig();
    expect(store.currentConfig().weights).toEqual({ similarity: 0.5, recency: 0.7, importance: 0.1 });
  });

  it('live-applies a looser threshold to recall', async () => {
    const client = mockClient((command) => {
      if (command === 'HGETALL') {
        return configReply({ 'recall.threshold': '0.5' });
      }
      if (command === 'FT.SEARCH') {
        return recallHit(0.4);
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    expect(await store.recall('q', { k: 1 })).toHaveLength(0);
    await store.refreshConfig();
    expect(await store.recall('q', { k: 1 })).toHaveLength(1);
  });

  it('does not poll the config hash when refresh is not enabled', async () => {
    const client = mockClient(() => 'OK');
    new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });
    await Promise.resolve();
    expect(client.call.mock.calls.some((c) => c[0] === 'HGETALL')).toBe(false);
  });

  it('reads immediately and on the interval when enabled, and stops on close', async () => {
    vi.useFakeTimers();
    try {
      const client = configClient({ 'recall.threshold': '0.4' });
      const store = new MemoryStore({
        client,
        name: 'mem',
        embedFn: fakeEmbed(8),
        configRefresh: { intervalMs: 1000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      const initial = client.call.mock.calls.filter((c) => c[0] === 'HGETALL').length;
      expect(initial).toBeGreaterThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(1000);
      const afterTick = client.call.mock.calls.filter((c) => c[0] === 'HGETALL').length;
      expect(afterTick).toBeGreaterThan(initial);

      await store.close();
      await vi.advanceTimersByTimeAsync(3000);
      const afterClose = client.call.mock.calls.filter((c) => c[0] === 'HGETALL').length;
      expect(afterClose).toBe(afterTick);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws when the config read fails (best-effort)', async () => {
    const client = mockClient((command) => {
      if (command === 'HGETALL') {
        throw new Error('hgetall boom');
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await expect(store.refreshConfig()).resolves.toBeUndefined();
    expect(store.currentConfig().threshold).toBe(0.25);
  });
});
