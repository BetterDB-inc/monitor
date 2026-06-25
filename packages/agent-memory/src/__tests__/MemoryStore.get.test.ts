import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { mockClient } from './helpers/mockClient';

function hashReply(fields: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    out.push(k, v);
  }
  return out;
}

describe('MemoryStore.get', () => {
  it('HGETALLs the memory hash and parses it (no vector bytes)', async () => {
    const client = mockClient((command) =>
      command === 'HGETALL'
        ? hashReply({
            content: 'hello',
            importance: '0.5',
            tags: 'a,b',
            created_at: '100',
            last_accessed_at: '150',
            access_count: '2',
            threadId: 't1',
            vector: 'RAWBYTES',
          })
        : 'OK',
    );
    const store = new MemoryStore({ client, name: 'mem' });

    const item = await store.get('doc1');

    expect(client.call).toHaveBeenCalledWith('HGETALL', 'mem:mem:doc1');
    expect(item).toMatchObject({
      id: 'doc1',
      content: 'hello',
      importance: 0.5,
      tags: ['a', 'b'],
      createdAt: 100,
      lastAccessedAt: 150,
      accessCount: 2,
      threadId: 't1',
    });
    expect(item).not.toHaveProperty('vector');
  });

  it('returns null when the hash is empty (missing key)', async () => {
    const client = mockClient((command) => (command === 'HGETALL' ? [] : 'OK'));
    const store = new MemoryStore({ client, name: 'mem' });

    expect(await store.get('missing')).toBeNull();
  });
});
