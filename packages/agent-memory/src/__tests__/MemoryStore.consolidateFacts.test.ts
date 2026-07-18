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

// A stored fact memory: carries source=fact and a persisted subject so a later
// run can reconcile against it. Datedness is carried in its own `date` field
// (the source of truth), matching how consolidateFacts writes dated facts.
function factHit(
  id: string,
  subject: string,
  content: string,
  date?: string,
): [string, string[]] {
  const fields = ['content', content, 'subject', subject, 'source', 'fact'];
  if (date !== undefined) {
    fields.push('date', date);
  }
  return [`mem:mem:${id}`, fields];
}

// Two-phase mock: the candidate scan excludes facts (`-@source`), the existing
// -fact scan includes them (`@source:{fact}`); route each to its own reply.
function twoPhaseClient(
  candidateHits: Array<[string, string[]]>,
  existingFactHits: Array<[string, string[]]>,
) {
  return mockClient((command, ...args) => {
    if (command === 'FT.SEARCH') {
      const filter = String(args[1]);
      return searchReply(filter.includes('-@source') ? candidateHits : existingFactHits);
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

function extractor(facts: Fact[]) {
  return vi.fn(async () => facts);
}

describe('MemoryStore.consolidateFacts', () => {
  it('runs without requiring consolidation to be enabled (gate removed)', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });
    const extractFacts = extractor([{ subject: 'employer', statement: 'Acme' }]);

    const result = await store.consolidateFacts({ namespace: 'u1', extractFacts });

    expect(extractFacts).toHaveBeenCalledTimes(1);
    expect(result.facts).toBe(1);
  });

  it('is reachable via the merged consolidate({ mode: "facts" })', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });
    const extractFacts = extractor([{ subject: 'employer', statement: 'Acme' }]);

    const result = await store.consolidate({ mode: 'facts', namespace: 'u1', extractFacts });

    expect(extractFacts).toHaveBeenCalledTimes(1);
    expect(result.facts).toBe(1);
    expect(result.unmatchedTombstones).toEqual([]);
  });

  it('scans candidates sorted by created_at ASC (deterministic extractor input order)', async () => {
    const client = factsClient([itemHit('a', { importance: 0.2, ageSeconds: 100000 })]);
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.consolidate({
      mode: 'facts',
      namespace: 'u1',
      extractFacts: extractor([{ subject: 'x', statement: 'y' }]),
    });

    // The candidate fetch is the FT.SEARCH that excludes prior facts (-@source:{fact}).
    const search = client.call.mock.calls.find(
      (c) => c[0] === 'FT.SEARCH' && String(c[2]).includes('-@source:{fact}'),
    );
    expect(search).toBeDefined();
    const args = (search ?? []).map(String);
    const sortIdx = args.indexOf('SORTBY');
    expect(sortIdx).toBeGreaterThan(-1);
    expect(args[sortIdx + 1]).toBe('created_at');
    expect(args[sortIdx + 2]).toBe('ASC');
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
    expect(result).toEqual({
      candidates: 1,
      facts: 1,
      created: result.created,
      deleted: 0,
      unmatchedTombstones: [],
    });
    expect(result.created).toHaveLength(1);
  });

  it('runs regardless of the now-ignored consolidation.enabled flag', async () => {
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
    ).resolves.toBeDefined();
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
    expect(result).toEqual({
      candidates: 0,
      facts: 0,
      created: [],
      deleted: 0,
      unmatchedTombstones: [],
    });
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

  it('loads the stored fact memories with an @source include filter to reconcile against', async () => {
    const client = twoPhaseClient(
      [itemHit('a', { importance: 0.2, ageSeconds: 100000 })],
      [factHit('f1', 'employer', 'Acme')],
    );
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });

    await store.consolidateFacts({
      namespace: 'u1',
      extractFacts: extractor([{ subject: 'employer', statement: 'Acme' }]),
    });

    const includeSearch = client.call.mock.calls.find(
      (c) =>
        c[0] === 'FT.SEARCH' &&
        String(c[2]).includes('@source:{fact}') &&
        !String(c[2]).includes('-@source'),
    );
    expect(includeSearch).toBeDefined();
  });

  it('is idempotent: re-running over the same sources rewrites nothing for an unchanged fact', async () => {
    const client = twoPhaseClient(
      [itemHit('a', { importance: 0.2, ageSeconds: 100000 })],
      [factHit('f1', 'employer', 'Acme')],
    );
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });

    const result = await store.consolidateFacts({
      namespace: 'u1',
      extractFacts: extractor([{ subject: 'employer', statement: 'Acme' }]),
    });

    expect(result).toEqual({
      candidates: 1,
      facts: 1,
      created: [],
      deleted: 0,
      unmatchedTombstones: [],
    });
    expect(client.call.mock.calls.some((c) => c[0] === 'HSET')).toBe(false);
    expect(client.call.mock.calls.some((c) => c[0] === 'DEL')).toBe(false);
  });

  it('supersedes a stored fact: a newer dated statement deletes the prior memory and writes the new one', async () => {
    const client = twoPhaseClient(
      [itemHit('a', { importance: 0.2, ageSeconds: 100000 })],
      [factHit('f1', 'city', '[2024-01-01] Sofia', '2024-01-01')],
    );
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });

    const result = await store.consolidateFacts({
      namespace: 'u1',
      extractFacts: extractor([{ subject: 'city', statement: 'Berlin', date: '2024-05-01' }]),
    });

    expect(result.deleted).toBe(1);
    expect(result.created).toHaveLength(1);
    const del = client.call.mock.calls.find((c) => c[0] === 'DEL');
    expect(del?.slice(1)).toEqual(['mem:mem:f1']);
    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    expect(fieldValue(hset, 'content')).toBe('[2024-05-01] Berlin');
    expect(fieldValue(hset, 'subject')).toBe('city');
  });

  it('does not misread a dateless stored fact whose statement starts with a bracket', async () => {
    // "[Q3] revenue target is 5M" is a dateless statement, not a fact dated "Q3".
    // Inferring a date from the leading bracket would make the stored fact look
    // dated ("Q3"), and a genuinely newer dated restatement ("2024-09") would be
    // dropped by the string compare ('2' < 'Q'). Datedness must come from the
    // absent `date` field, so the newer dated fact supersedes it.
    const client = twoPhaseClient(
      [itemHit('a', { importance: 0.2, ageSeconds: 100000 })],
      [factHit('f1', 'goal', '[Q3] revenue target is 5M')],
    );
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });

    const result = await store.consolidateFacts({
      namespace: 'u1',
      extractFacts: extractor([
        { subject: 'goal', statement: 'revenue target is 10M', date: '2024-09' },
      ]),
    });

    expect(result.deleted).toBe(1);
    expect(result.created).toHaveLength(1);
    const del = client.call.mock.calls.find((c) => c[0] === 'DEL');
    expect(del?.slice(1)).toEqual(['mem:mem:f1']);
    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET');
    expect(fieldValue(hset, 'content')).toBe('[2024-09] revenue target is 10M');
    expect(fieldValue(hset, 'date')).toBe('2024-09');
  });

  it('self-heals a concurrent-write race by retracting duplicate-subject facts', async () => {
    // Two prior runs each wrote a fact for the same subject (a race). The next
    // run keeps one canonical row and retracts the extra so it is not orphaned.
    const client = twoPhaseClient(
      [itemHit('a', { importance: 0.2, ageSeconds: 100000 })],
      [factHit('f1', 'employer', 'Acme'), factHit('f2', 'employer', 'Acme')],
    );
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });

    const result = await store.consolidateFacts({
      namespace: 'u1',
      extractFacts: extractor([{ subject: 'employer', statement: 'Acme' }]),
    });

    // Canonical row (f1) unchanged → no write; duplicate (f2) retracted.
    expect(result.created).toHaveLength(0);
    expect(result.deleted).toBe(1);
    const del = client.call.mock.calls.find((c) => c[0] === 'DEL');
    expect(del?.slice(1)).toEqual(['mem:mem:f2']);
  });

  it('retracts a stored fact across runs: a tombstone deletes the prior memory and writes nothing', async () => {
    const client = twoPhaseClient(
      [itemHit('a', { importance: 0.2, ageSeconds: 100000 })],
      [factHit('f1', 'pet', 'cat')],
    );
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      consolidation: true,
    });

    const result = await store.consolidateFacts({
      namespace: 'u1',
      extractFacts: extractor([{ subject: 'pet', statement: '', tombstone: true }]),
    });

    expect(result.deleted).toBe(1);
    expect(result.created).toHaveLength(0);
    const del = client.call.mock.calls.find((c) => c[0] === 'DEL');
    expect(del?.slice(1)).toEqual(['mem:mem:f1']);
    expect(client.call.mock.calls.some((c) => c[0] === 'HSET')).toBe(false);
  });
});
