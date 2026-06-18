import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

function fields(importance: number, lastAccessedAt: number): Record<string, string> {
  return { importance: String(importance), last_accessed_at: String(lastAccessedAt) };
}

function searchReply(total: number, hits: Array<[string, Record<string, string>]> = []): unknown[] {
  const out: unknown[] = [String(total)];
  for (const [key, fieldMap] of hits) {
    const flat: string[] = [];
    for (const [field, value] of Object.entries(fieldMap)) {
      flat.push(field, value);
    }
    out.push(key, flat);
  }
  return out;
}

describe('MemoryStore TTL writes', () => {
  it('writes a durable memory with a plain HSET when no ttl is given', async () => {
    const client = mockClient(() => 'OK');
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.remember('durable');

    const commands = client.call.mock.calls.map((c) => c[0]);
    expect(commands).toContain('HSET');
    expect(commands).not.toContain('EXPIRE');
    expect(commands).not.toContain('MULTI');
  });

  it('writes an expiring memory atomically when ttl is set', async () => {
    const client = mockClient(() => 'OK');
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.remember('temporary', { ttl: 3600 });

    const commands = client.call.mock.calls.map((c) => c[0]);
    expect(commands).toEqual(['MULTI', 'HSET', 'EXPIRE', 'EXEC']);
    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    const expire = client.call.mock.calls.find((c) => c[0] === 'EXPIRE');
    expect(expire?.[1]).toBe(hset?.[1]);
    expect(expire?.[2]).toBe('3600');
  });

  it('treats a non-positive ttl as durable (no EXPIRE)', async () => {
    const client = mockClient(() => 'OK');
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.remember('x', { ttl: 0 });

    const commands = client.call.mock.calls.map((c) => c[0]);
    expect(commands).toContain('HSET');
    expect(commands).not.toContain('EXPIRE');
  });

  it('DISCARDs and propagates when a ttl write fails mid-transaction', async () => {
    const client = mockClient((command) => {
      if (command === 'EXPIRE') {
        throw new Error('boom');
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await expect(store.remember('x', { ttl: 60 })).rejects.toThrow(/boom/);
    expect(client.call.mock.calls.some((c) => c[0] === 'DISCARD')).toBe(true);
  });
});

describe('MemoryStore capacity eviction', () => {
  it('evicts the lowest-ranked item and bumps the eviction counter when over capacity', async () => {
    const client = mockClient((command, ...args) => {
      if (command === 'FT.SEARCH') {
        if (args.includes('RETURN')) {
          return searchReply(3, [
            ['mem:mem:a', fields(0.1, 1000)],
            ['mem:mem:b', fields(0.9, 5000)],
            ['mem:mem:c', fields(0.5, 9000)],
          ]);
        }
        return searchReply(3);
      }
      return 'OK';
    });
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      maxItemsPerScope: 2,
    });

    await store.remember('content', { namespace: 'u1' });

    const del = client.call.mock.calls.find((c) => c[0] === 'DEL');
    expect(del).toEqual(['DEL', 'mem:mem:a']);
    const hincr = client.call.mock.calls.find(
      (c) => c[0] === 'HINCRBY' && c[1] === 'mem:__mem_stats',
    );
    expect(hincr).toEqual(['HINCRBY', 'mem:__mem_stats', 'evictions', '1']);
  });

  it('queries capacity by the written item scope', async () => {
    const client = mockClient((command) => (command === 'FT.SEARCH' ? searchReply(2) : 'OK'));
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      maxItemsPerScope: 2,
    });

    await store.remember('content', { namespace: 'u1' });

    const search = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(search?.[1]).toBe('mem:mem:idx');
    expect(search?.[2]).toBe('(@namespace:{u1})');
  });

  it('partitions capacity by tags so a tag-scoped write does not cap the whole index', async () => {
    const client = mockClient((command) => (command === 'FT.SEARCH' ? searchReply(2) : 'OK'));
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      maxItemsPerScope: 2,
    });

    await store.remember('content', { tags: ['teamx'] });

    const search = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(search?.[2]).toBe('(@tags:{teamx})');
    expect(search?.[2]).not.toBe('*');
  });

  it('does not evict or fetch candidates when within capacity', async () => {
    const client = mockClient((command) => (command === 'FT.SEARCH' ? searchReply(2) : 'OK'));
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      maxItemsPerScope: 2,
    });

    await store.remember('content', { namespace: 'u1' });

    const searches = client.call.mock.calls.filter((c) => c[0] === 'FT.SEARCH');
    expect(searches).toHaveLength(1);
    const commands = client.call.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain('DEL');
    expect(commands).not.toContain('HINCRBY');
  });

  it('performs no capacity check when maxItemsPerScope is not configured', async () => {
    const client = mockClient(() => 'OK');
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.remember('content', { namespace: 'u1' });

    expect(client.call.mock.calls.some((c) => c[0] === 'FT.SEARCH')).toBe(false);
  });

  it('skips capacity enforcement for a fully-unscoped write (no global eviction)', async () => {
    const client = mockClient(() => 'OK');
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      maxItemsPerScope: 1,
    });

    await store.remember('content');

    expect(client.call.mock.calls.some((c) => c[0] === 'FT.SEARCH')).toBe(false);
  });

  it('never lets a capacity-enforcement failure break the write', async () => {
    const client = mockClient((command) => {
      if (command === 'FT.SEARCH') {
        throw new Error('search boom');
      }
      return 'OK';
    });
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      maxItemsPerScope: 2,
    });

    const id = await store.remember('content', { namespace: 'u1' });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('snapshots eviction weights so a mid-pass config refresh cannot change the victim', async () => {
    let store: MemoryStore;
    const client = mockClient((command, ...args) => {
      if (command === 'HGETALL') {
        return [
          'recall.weights.similarity',
          '0',
          'recall.weights.recency',
          '0.9',
          'recall.weights.importance',
          '0.1',
        ];
      }
      if (command === 'FT.SEARCH') {
        if (args.includes('RETURN')) {
          return store.refreshConfig().then(() =>
            searchReply(2, [
              ['mem:mem:stale', fields(0.9, 1000)],
              ['mem:mem:recent', fields(0.1, Date.now())],
            ]),
          );
        }
        return searchReply(2);
      }
      return 'OK';
    });
    store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      maxItemsPerScope: 1,
      halfLifeSeconds: 100,
      weights: { similarity: 0, recency: 0.1, importance: 0.9 },
    });

    await store.remember('content', { namespace: 'u1' });

    const del = client.call.mock.calls.find((c) => c[0] === 'DEL');
    expect(del).toEqual(['DEL', 'mem:mem:recent']);
  });
});
