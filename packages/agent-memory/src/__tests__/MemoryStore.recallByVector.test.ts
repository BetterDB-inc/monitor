import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { mockClient } from './helpers/mockClient';

function knnReply(rows: Array<{ key: string; fields: Record<string, string> }>): unknown[] {
  const out: unknown[] = [String(rows.length)];
  for (const row of rows) {
    const flat: string[] = [];
    for (const [k, v] of Object.entries(row.fields)) {
      flat.push(k, v);
    }
    out.push(row.key, flat);
  }
  return out;
}

describe('MemoryStore.recallByVector', () => {
  it('runs KNN with the supplied vector and needs no embedFn', async () => {
    const reply = knnReply([
      {
        key: 'mem:mem:a',
        fields: {
          __score: '0.10',
          content: 'hit',
          importance: '0.5',
          created_at: '100',
          last_accessed_at: '100',
          access_count: '0',
        },
      },
    ]);
    const client = mockClient((command) => {
      if (command === 'FT.SEARCH') {
        return reply;
      }
      if (command === 'EXISTS') {
        return 1;
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem' });

    const hits = await store.recallByVector([0, 1, 0, 0, 0, 0, 0, 0], { threadId: 't1', reinforce: false });

    expect(hits.map((h) => h.item.id)).toEqual(['a']);
    const search = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(search?.[1]).toBe('mem:mem:idx');
    expect(String(search?.[2])).toContain('KNN');
    // No embedding happened: the embed() path increments no HGETALL/embedFn here.
    expect(client.call.mock.calls.some((c) => c[0] === 'HGETALL')).toBe(false);
  });
});
