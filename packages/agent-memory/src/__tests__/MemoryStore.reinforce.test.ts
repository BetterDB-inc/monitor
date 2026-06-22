import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

const now = Date.now();

function oneHit(): unknown[] {
  const fields = {
    content: 'c',
    importance: '0.5',
    created_at: String(now),
    last_accessed_at: String(now),
    access_count: '0',
    __score: '0.1',
  };
  const flat: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    flat.push(field, value);
  }
  return ['1', 'mem:mem:a', flat];
}

describe('MemoryStore recall reinforcement', () => {
  it('reinforces recalled items by default: bumps last_accessed_at and access_count', async () => {
    const client = mockClient((command) => {
      if (command === 'FT.SEARCH') {
        return oneHit();
      }
      return command === 'EXISTS' ? 1 : 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.recall('q', { k: 1, threshold: 1 });

    const calls = client.call.mock.calls;
    expect(calls).toContainEqual(['HINCRBY', 'mem:mem:a', 'access_count', '1']);
    const hset = calls.find(
      (c) => c[0] === 'HSET' && c[1] === 'mem:mem:a' && c[2] === 'last_accessed_at',
    );
    expect(hset).toBeDefined();
  });

  it('does not resurrect a recalled hit whose hash was already deleted', async () => {
    const client = mockClient((command) => {
      if (command === 'FT.SEARCH') {
        return oneHit();
      }
      return command === 'EXISTS' ? 0 : 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.recall('q', { k: 1, threshold: 1 });

    const calls = client.call.mock.calls;
    expect(calls.some((c) => c[0] === 'HSET')).toBe(false);
    expect(calls.some((c) => c[0] === 'HINCRBY')).toBe(false);
  });

  it('does not reinforce when reinforce is false', async () => {
    const client = mockClient((command) => (command === 'FT.SEARCH' ? oneHit() : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.recall('q', { k: 1, threshold: 1, reinforce: false });

    expect(client.call.mock.calls.some((c) => c[0] === 'HINCRBY')).toBe(false);
  });

  it('never lets a reinforcement failure break the recall read path', async () => {
    const client = mockClient((command) => {
      if (command === 'FT.SEARCH') {
        return oneHit();
      }
      if (command === 'HINCRBY') {
        throw new Error('reinforce boom');
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const hits = await store.recall('q', { k: 1, threshold: 1 });

    expect(hits).toHaveLength(1);
    expect(hits[0].item.id).toBe('a');
  });
});
