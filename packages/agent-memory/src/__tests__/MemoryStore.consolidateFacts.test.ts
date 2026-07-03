import { describe, it, expect, vi } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';
import type { Fact } from '../types';

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

function factsClient(hits: Array<[string, string[]]>) {
  return mockClient((command) => {
    if (command === 'FT.SEARCH') {
      return searchReply(hits);
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

function extractor(facts: Fact[]) {
  return vi.fn(async () => facts);
}

describe('MemoryStore.consolidateFacts', () => {
  it('throws when consolidation is disabled (the default) without touching the client', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });
    const extractFacts = extractor([{ subject: 'employer', statement: 'Acme' }]);

    await expect(store.consolidateFacts({ namespace: 'u1', extractFacts })).rejects.toThrow(
      /disabled/i,
    );
    expect(extractFacts).not.toHaveBeenCalled();
    expect(client.call.mock.calls.some((c) => c[0] === 'FT.SEARCH')).toBe(false);
  });

  it('runs when enabled via consolidation: true', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });
    const extractFacts = extractor([{ subject: 'employer', statement: 'Acme' }]);

    const result = await store.consolidateFacts({ namespace: 'u1', extractFacts });

    expect(extractFacts).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ candidates: 1, facts: 1, created: result.created });
    expect(result.created).toHaveLength(1);
  });

  it('runs when enabled via { enabled: true } but throws when { enabled: false }', async () => {
    const on = new MemoryStore({
      client: factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]),
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: { enabled: true },
    });
    await expect(
      on.consolidateFacts({ namespace: 'u1', extractFacts: extractor([]) }),
    ).resolves.toBeDefined();

    const off = new MemoryStore({
      client: factsClient([]),
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: { enabled: false },
    });
    await expect(
      off.consolidateFacts({ namespace: 'u1', extractFacts: extractor([]) }),
    ).rejects.toThrow(/disabled/i);
  });

  it('writes fact memories additively without deleting the source memories', async () => {
    const client = factsClient([
      itemHit('a', { importance: 0.2, ageSeconds: 100000 }),
      itemHit('b', { importance: 0.3, ageSeconds: 200000 }),
    ]);
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });
    const extractFacts = extractor([{ subject: 'employer', statement: 'Acme' }]);

    const result = await store.consolidateFacts({ namespace: 'u1', extractFacts });

    expect(result.candidates).toBe(2);
    expect(result.facts).toBe(1);
    expect(client.call.mock.calls.some((c) => c[0] === 'DEL')).toBe(false);
    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    expect(fieldValue(hset, 'content')).toBe('Acme');
    expect(fieldValue(hset, 'source')).toBe('fact');
  });

  it('preserves a fact date by prefixing it into the written content', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });
    const extractFacts = extractor([
      { subject: 'employer', statement: 'Globex', date: '2024-06-01' },
    ]);

    await store.consolidateFacts({ namespace: 'u1', extractFacts });

    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    expect(fieldValue(hset, 'content')).toBe('[2024-06-01] Globex');
  });

  it('excludes prior fact memories from the candidate scan so a re-run cannot re-distill its own output', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });

    await store.consolidateFacts({ namespace: 'u1', extractFacts: extractor([]) });

    const search = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(search?.[2] as string).toContain('-@source:{fact}');
  });

  it('uses a custom factSource for both the write and the exclusion filter', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: { factSource: 'distilled' },
    });
    const extractFacts = extractor([{ subject: 'employer', statement: 'Acme' }]);

    await store.consolidateFacts({ namespace: 'u1', extractFacts });

    const search = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(search?.[2] as string).toContain('-@source:{distilled}');
    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    expect(fieldValue(hset, 'source')).toBe('distilled');
  });

  it('defaults fact importance to 0.7 and honors the constructor and per-call overrides', async () => {
    const defaultClient = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const defaultStore = new MemoryStore({
      client: defaultClient,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });
    await defaultStore.consolidateFacts({
      namespace: 'u1',
      extractFacts: extractor([{ subject: 's', statement: 'x' }]),
    });
    expect(
      fieldValue(
        defaultClient.call.mock.calls.find((c) => c[0] === 'HSET'),
        'importance',
      ),
    ).toBe('0.7');

    const configuredClient = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const configured = new MemoryStore({
      client: configuredClient,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: { factImportance: 0.9 },
    });
    await configured.consolidateFacts({
      namespace: 'u1',
      extractFacts: extractor([{ subject: 's', statement: 'x' }]),
    });
    expect(
      fieldValue(
        configuredClient.call.mock.calls.find((c) => c[0] === 'HSET'),
        'importance',
      ),
    ).toBe('0.9');

    const perCallClient = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const perCall = new MemoryStore({
      client: perCallClient,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: { factImportance: 0.9 },
    });
    await perCall.consolidateFacts({
      namespace: 'u1',
      factImportance: 0.4,
      extractFacts: extractor([{ subject: 's', statement: 'x' }]),
    });
    expect(
      fieldValue(
        perCallClient.call.mock.calls.find((c) => c[0] === 'HSET'),
        'importance',
      ),
    ).toBe('0.4');
  });

  it('reconciles the extracted batch so a newer dated statement wins over an older one for the same subject', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });
    const extractFacts = extractor([
      { subject: 'city', statement: 'Sofia', date: '2024-01-01' },
      { subject: 'city', statement: 'Berlin', date: '2024-05-01' },
    ]);

    const result = await store.consolidateFacts({ namespace: 'u1', extractFacts });

    expect(result.facts).toBe(1);
    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    expect(fieldValue(hset, 'content')).toBe('[2024-05-01] Berlin');
  });

  it('drops a tombstoned subject so no memory is written for it', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });
    const extractFacts = extractor([{ subject: 'pet', statement: '', tombstone: true }]);

    const result = await store.consolidateFacts({ namespace: 'u1', extractFacts });

    expect(result.facts).toBe(0);
    expect(client.call.mock.calls.some((c) => c[0] === 'HSET')).toBe(false);
  });

  it('pushes olderThanSeconds and maxImportance into the candidate scan', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });

    await store.consolidateFacts({
      olderThanSeconds: 3600,
      maxImportance: 0.5,
      extractFacts: extractor([]),
    });

    const filter = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH')?.[2] as string;
    expect(filter).toMatch(/@created_at:\[-inf \d+\]/);
    expect(filter).toContain('@importance:[-inf 0.5]');
  });

  it('returns zeros and neither extracts nor writes when nothing matches', async () => {
    const client = factsClient([]);
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });
    const extractFacts = extractor([{ subject: 'employer', statement: 'Acme' }]);

    const result = await store.consolidateFacts({ olderThanSeconds: 3600, extractFacts });

    expect(extractFacts).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 0, facts: 0, created: [] });
    expect(client.call.mock.calls.some((c) => c[0] === 'HSET')).toBe(false);
  });

  it('throws when given no scope, tags, or selection criteria (prevents whole-store consolidation)', async () => {
    const store = new MemoryStore({
      client: factsClient([]),
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });
    const extractFacts = extractor([{ subject: 'employer', statement: 'Acme' }]);

    await expect(store.consolidateFacts({ extractFacts })).rejects.toThrow(/scope|criteria/i);
    expect(extractFacts).not.toHaveBeenCalled();
  });
});
