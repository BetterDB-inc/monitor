import { describe, it, expect, vi } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

const now = Date.now();

interface HitSpec {
  importance: number;
  ageSeconds: number;
  source?: string;
}

function itemHit(id: string, spec: HitSpec): [string, string[]] {
  const created = now - spec.ageSeconds * 1000;
  const fields: Record<string, string> = {
    content: `c-${id}`,
    importance: String(spec.importance),
    created_at: String(created),
    last_accessed_at: String(created),
    access_count: '0',
  };
  if (spec.source !== undefined) {
    fields.source = spec.source;
  }
  const flat: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    flat.push(field, value);
  }
  return [`mem:mem:${id}`, flat];
}

function searchReply(hits: Array<[string, string[]]>): unknown[] {
  const out: unknown[] = [String(hits.length)];
  for (const [key, flat] of hits) {
    out.push(key, flat);
  }
  return out;
}

function consolidatingClient(hits: Array<[string, string[]]>) {
  return mockClient((command, ...args) => {
    if (command === 'FT.SEARCH') {
      return searchReply(hits);
    }
    if (command === 'DEL') {
      return args.length;
    }
    return 'OK';
  });
}

function fieldValue(call: unknown[] | undefined, field: string): string | undefined {
  if (!call) {
    return undefined;
  }
  const idx = call.indexOf(field);
  return idx >= 0 ? (call[idx + 1] as string) : undefined;
}

describe('MemoryStore.consolidate', () => {
  it('summarizes matching candidates, writes a summary, deletes sources, returns counts', async () => {
    const summarize = vi.fn(async (items) => `summary of ${items.length}`);
    const client = consolidatingClient([
      itemHit('a', { importance: 0.2, ageSeconds: 100000 }),
      itemHit('b', { importance: 0.3, ageSeconds: 200000 }),
    ]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const result = await store.consolidate({
      namespace: 'u1',
      olderThanSeconds: 3600,
      maxImportance: 0.5,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][0].map((i: { id: string }) => i.id)).toEqual(['a', 'b']);
    expect(result.consolidated).toBe(2);
    expect(result.created).toHaveLength(1);
    expect(result.deleted).toBe(2);

    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    expect(fieldValue(hset, 'content')).toBe('summary of 2');
    expect(fieldValue(hset, 'source')).toBe('summary');
    expect(hset?.[1]).toBe(`mem:mem:${result.created[0]}`);

    const del = client.call.mock.calls.find((c) => c[0] === 'DEL');
    expect(del?.slice(1).sort()).toEqual(['mem:mem:a', 'mem:mem:b']);
  });

  it('selects only candidates older than olderThanSeconds', async () => {
    const summarize = vi.fn(async () => 'summary');
    const client = consolidatingClient([
      itemHit('old', { importance: 0.2, ageSeconds: 100000 }),
      itemHit('recent', { importance: 0.2, ageSeconds: 10 }),
    ]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const result = await store.consolidate({ olderThanSeconds: 3600, summarize });

    expect(summarize.mock.calls[0][0].map((i: { id: string }) => i.id)).toEqual(['old']);
    expect(result.consolidated).toBe(1);
    const del = client.call.mock.calls.find((c) => c[0] === 'DEL');
    expect(del?.slice(1)).toEqual(['mem:mem:old']);
  });

  it('selects only candidates at or below maxImportance', async () => {
    const summarize = vi.fn(async () => 'summary');
    const client = consolidatingClient([
      itemHit('low', { importance: 0.2, ageSeconds: 100000 }),
      itemHit('high', { importance: 0.9, ageSeconds: 100000 }),
    ]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const result = await store.consolidate({ maxImportance: 0.5, summarize });

    expect(summarize.mock.calls[0][0].map((i: { id: string }) => i.id)).toEqual(['low']);
    expect(result.consolidated).toBe(1);
  });

  it('writes the summary scoped to the request at summaryImportance', async () => {
    const summarize = vi.fn(async () => 'merged');
    const client = consolidatingClient([itemHit('a', { importance: 0.1, ageSeconds: 100000 })]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.consolidate({ namespace: 'u1', summarize, summaryImportance: 0.9 });

    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    expect(fieldValue(hset, 'importance')).toBe('0.9');
    expect(fieldValue(hset, 'namespace')).toBe('u1');
    expect(fieldValue(hset, 'source')).toBe('summary');
  });

  it('keeps sources when deleteSources is false', async () => {
    const summarize = vi.fn(async () => 'summary');
    const client = consolidatingClient([
      itemHit('a', { importance: 0.2, ageSeconds: 100000 }),
      itemHit('b', { importance: 0.2, ageSeconds: 100000 }),
    ]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const result = await store.consolidate({
      summarize,
      deleteSources: false,
      olderThanSeconds: 3600,
    });

    expect(result.consolidated).toBe(2);
    expect(result.created).toHaveLength(1);
    expect(result.deleted).toBe(0);
    expect(client.call.mock.calls.some((c) => c[0] === 'DEL')).toBe(false);
  });

  it('returns zeros and does not summarize or write when nothing matches', async () => {
    const summarize = vi.fn(async () => 'summary');
    const client = consolidatingClient([]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const result = await store.consolidate({ olderThanSeconds: 3600, summarize });

    expect(summarize).not.toHaveBeenCalled();
    expect(result).toEqual({ consolidated: 0, created: [], deleted: 0 });
    expect(client.call.mock.calls.some((c) => c[0] === 'HSET')).toBe(false);
    expect(client.call.mock.calls.some((c) => c[0] === 'DEL')).toBe(false);
  });

  it('throws when given no scope, tags, or selection criteria (prevents whole-store consolidation)', async () => {
    const summarize = vi.fn(async () => 'summary');
    const store = new MemoryStore({ client: mockClient(), name: 'mem', embedFn: fakeEmbed(8) });

    await expect(store.consolidate({ summarize })).rejects.toThrow(/scope|criteria/i);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('defaults summaryImportance to 0.7 and deletes sources by default', async () => {
    const summarize = vi.fn(async () => 'summary');
    const client = consolidatingClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const result = await store.consolidate({ summarize, olderThanSeconds: 3600 });

    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    expect(fieldValue(hset, 'importance')).toBe('0.7');
    expect(result.deleted).toBe(1);
  });
});
