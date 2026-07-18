import { describe, it, expect, vi } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

interface Row {
  key: string;
  fields: Record<string, string>;
}

function searchReply(rows: Row[]): unknown[] {
  const out: unknown[] = [String(rows.length)];
  for (const row of rows) {
    out.push(row.key);
    const flat: string[] = [];
    for (const [field, value] of Object.entries(row.fields)) {
      flat.push(field, value);
    }
    out.push(flat);
  }
  return out;
}

const now = Date.now();
function baseFields(over: Record<string, string>): Record<string, string> {
  return {
    content: 'c',
    importance: '0.5',
    tags: '',
    created_at: String(now),
    last_accessed_at: String(now),
    access_count: '0',
    ...over,
  };
}

describe('MemoryStore.recall', () => {
  it('embeds the query, runs a widened KNN FT.SEARCH, and returns ranked hits capped at k', async () => {
    const embedFn = vi.fn(fakeEmbed(8));
    const reply = searchReply([
      { key: 'mem:mem:a', fields: baseFields({ content: 'closer', __score: '0.1' }) },
      { key: 'mem:mem:b', fields: baseFields({ content: 'farther', __score: '0.6' }) },
    ]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn });

    const hits = await store.recall('what does the user prefer', {
      k: 2,
      threshold: 1,
      threadId: 't1',
      tags: ['x'],
    });

    expect(embedFn).toHaveBeenCalledWith('what does the user prefer');
    const search = client.call.mock.calls.find((args) => args[0] === 'FT.SEARCH');
    expect(search?.[1]).toBe('mem:mem:idx');
    // internal k widened to k*4 = 8
    expect(search?.[2]).toBe('(@threadId:{t1} @tags:{x})=>[KNN 8 @vector $vec AS __score]');
    expect(search).toContain('8');

    expect(hits).toHaveLength(2);
    expect(hits[0].item.id).toBe('a');
    expect(hits[0].item.content).toBe('closer');
    expect(hits[0].similarity).toBe(0.1);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('drops candidates beyond the distance threshold', async () => {
    const reply = searchReply([
      { key: 'mem:mem:a', fields: baseFields({ __score: '0.1' }) },
      { key: 'mem:mem:b', fields: baseFields({ __score: '0.9' }) },
    ]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const hits = await store.recall('q', { k: 5, threshold: 0.3 });

    expect(hits.map((h) => h.item.id)).toEqual(['a']);
  });

  it('returns a candidate at cosine distance ~0.27 with the default threshold (0.33)', async () => {
    const reply = searchReply([{ key: 'mem:mem:a', fields: baseFields({ __score: '0.27' }) }]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    // No explicit threshold: the default (0.33) must admit a ~0.27 match, which
    // the old 0.25 default silently dropped for mainstream embedding models.
    const hits = await store.recall('q', { k: 5 });

    expect(hits.map((h) => h.item.id)).toEqual(['a']);
  });

  it('flags a near-miss (0 hits, nearest just past threshold) and warns once per store', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reply = searchReply([{ key: 'mem:mem:a', fields: baseFields({ __score: '0.4' }) }]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const first = await store.recall('q', { k: 5 }); // 0.4 > 0.33 default, but <= 2x
    const second = await store.recall('q', { k: 5 });

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1); // deduped per store
    expect(String(warn.mock.calls[0][0])).toContain('nearest candidate');
    warn.mockRestore();
  });

  it('does not flag a near-miss when the nearest candidate is far past the threshold', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reply = searchReply([{ key: 'mem:mem:a', fields: baseFields({ __score: '0.9' }) }]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const hits = await store.recall('q', { k: 5 }); // 0.9 > 2x * 0.33

    expect(hits).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops candidates whose distance score is missing or non-numeric', async () => {
    const reply = searchReply([
      { key: 'mem:mem:a', fields: baseFields({ __score: '0.1' }) },
      { key: 'mem:mem:b', fields: baseFields({}) },
    ]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const hits = await store.recall('q', { k: 5, threshold: 1 });

    expect(hits.map((h) => h.item.id)).toEqual(['a']);
  });

  it('drops a candidate whose distance score is empty (not treated as 0)', async () => {
    const reply = searchReply([
      { key: 'mem:mem:a', fields: baseFields({ __score: '0.1' }) },
      { key: 'mem:mem:b', fields: baseFields({ __score: '   ' }) },
    ]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const hits = await store.recall('q', { k: 5, threshold: 1 });

    expect(hits.map((h) => h.item.id)).toEqual(['a']);
  });

  it('drops a candidate whose composite score is NaN (malformed importance)', async () => {
    const reply = searchReply([
      { key: 'mem:mem:a', fields: baseFields({ __score: '0.1' }) },
      { key: 'mem:mem:b', fields: baseFields({ __score: '0.1', importance: 'not-a-number' }) },
    ]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const hits = await store.recall('q', { k: 5, threshold: 1 });

    expect(hits.map((h) => h.item.id)).toEqual(['a']);
  });

  it('ranks a reinforced (recently accessed) memory above an equally-similar stale one', async () => {
    const old = String(now - 30 * 24 * 3600 * 1000);
    const reply = searchReply([
      {
        key: 'mem:mem:stale',
        fields: baseFields({ __score: '0.1', created_at: old, last_accessed_at: old }),
      },
      {
        key: 'mem:mem:fresh',
        fields: baseFields({ __score: '0.1', created_at: old, last_accessed_at: String(now) }),
      },
    ]);
    const client = mockClient((command) => (command === 'FT.SEARCH' ? reply : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const hits = await store.recall('q', { reinforce: false });

    expect(hits.map((h) => h.item.id)).toEqual(['fresh', 'stale']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });
});
