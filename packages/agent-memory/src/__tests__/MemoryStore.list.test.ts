import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { MATCH_ALL_MEMORY_QUERY } from '../buildRecallQuery';
import { mockClient } from './helpers/mockClient';

function searchReply(rows: Array<{ key: string; fields: Record<string, string> }>): unknown[] {
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

describe('MemoryStore.list', () => {
  it('FT.SEARCHes by scope with server-side SORTBY and LIMIT, returns items in reply order', async () => {
    const reply = searchReply([
      { key: 'mem:mem:b', fields: { content: 'new', created_at: '300', importance: '0.5' } },
      { key: 'mem:mem:c', fields: { content: 'mid', created_at: '200', importance: '0.5' } },
      { key: 'mem:mem:a', fields: { content: 'old', created_at: '100', importance: '0.5' } },
    ]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem' });

    const result = await store.list({ threadId: 't1' });

    const search = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(search?.[1]).toBe('mem:mem:idx');
    expect(search?.[2]).toBe('(@threadId:{t1})');
    const args = search as string[];
    const sortbyIdx = args.indexOf('SORTBY');
    expect(sortbyIdx).toBeGreaterThan(-1);
    expect(args[sortbyIdx + 1]).toBe('created_at');
    expect(args[sortbyIdx + 2]).toBe('DESC');
    const limitIdx = args.indexOf('LIMIT');
    expect(limitIdx).toBeGreaterThan(-1);
    expect(args[limitIdx + 1]).toBe('0');
    expect(args[limitIdx + 2]).toBe('20');
    expect(result.total).toBe(3);
    expect(result.items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('passes offset and limit directly to FT.SEARCH LIMIT args and returns reply order unchanged', async () => {
    const reply = searchReply([
      { key: 'mem:mem:c', fields: { content: 'x', created_at: '200' } },
    ]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem' });

    const result = await store.list({ limit: 1, offset: 1 });

    const search = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    const args = search as string[];
    const limitIdx = args.indexOf('LIMIT');
    expect(args[limitIdx + 1]).toBe('1');
    expect(args[limitIdx + 2]).toBe('1');
    expect(result.items.map((i) => i.id)).toEqual(['c']);
    expect(result.total).toBe(1);
  });

  it('uses the match-all range query (not bare "*") when no scope is given', async () => {
    const reply = searchReply([
      { key: 'mem:mem:a', fields: { content: 'x', created_at: '100', importance: '0.5' } },
    ]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem' });

    await store.list({});

    const search = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(search?.[2]).toBe(MATCH_ALL_MEMORY_QUERY);
    expect(search?.[2]).not.toBe('*');
  });
});
