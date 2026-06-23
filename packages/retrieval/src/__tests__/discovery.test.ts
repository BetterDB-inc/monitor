import { describe, it, expect, vi } from 'vitest';
import { Retriever } from '../retriever';
import { buildRetrievalMarker, REGISTRY_KEY } from '../discovery';
import type { RetrievalSchema } from '../schema';

const schema: RetrievalSchema = {
  fields: { source: { type: 'tag' } },
  vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
};

describe('buildRetrievalMarker', () => {
  it('builds a retrieval registry marker', () => {
    expect(
      buildRetrievalMarker({
        name: 'docs',
        version: '0.1.0',
        startedAt: '2026-06-15T00:00:00.000Z',
      }),
    ).toEqual({
      type: 'retrieval',
      prefix: 'docs',
      version: '0.1.0',
      protocol_version: 1,
      capabilities: ['upsert', 'query', 'delete'],
      index_name: 'docs:idx',
      started_at: '2026-06-15T00:00:00.000Z',
    });
  });
});

describe('Retriever discovery', () => {
  it('registers a retrieval marker on the registry', async () => {
    // The atomic register script returns nil when it wrote our marker.
    const call = vi.fn(async () => null);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    await retriever.register();

    const evalCall = call.mock.calls.find((args) => args[0] === 'EVAL');
    // ('EVAL', script, numkeys, KEYS[1], ARGV[1], ARGV[2], ARGV[3])
    expect(evalCall?.[3]).toBe(REGISTRY_KEY);
    expect(evalCall?.[4]).toBe('docs');
    const marker = JSON.parse(String(evalCall?.[5]));
    expect(marker.type).toBe('retrieval');
    expect(marker.prefix).toBe('docs');
    expect(typeof marker.started_at).toBe('string');
    expect(evalCall?.[6]).toBe('retrieval');
    // Never a raw HSET — the compare-and-set happens atomically server-side.
    expect(call.mock.calls.some((args) => args[0] === 'HSET')).toBe(false);
  });

  it('does not overwrite a different cache type sharing the registry field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The script returns the foreign type when it skips the write.
    const call = vi.fn(async () => 'agent_cache');
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    await retriever.register();

    expect(call.mock.calls.some((args) => args[0] === 'HSET')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('agent_cache');
    warn.mockRestore();
  });

  it('unregisters its own marker from the registry', async () => {
    // The atomic unregister script returns the HDEL count when it owned the field.
    const call = vi.fn(async () => 1);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    await retriever.unregister();

    const evalCall = call.mock.calls.find((args) => args[0] === 'EVAL');
    // ('EVAL', script, numkeys, KEYS[1], ARGV[1], ARGV[2])
    expect(evalCall?.[3]).toBe(REGISTRY_KEY);
    expect(evalCall?.[4]).toBe('docs');
    expect(evalCall?.[5]).toBe('retrieval');
    // Never a raw HDEL — the ownership check happens atomically server-side.
    expect(call.mock.calls.some((args) => args[0] === 'HDEL')).toBe(false);
  });

  it('never issues a raw HDEL on a foreign registry field', async () => {
    // Even when the field is foreign (script returns 0), we only ever delegate to
    // the ownership-guarded script, never a direct HDEL that could clobber it.
    const call = vi.fn(async () => 0);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    await retriever.unregister();

    expect(call.mock.calls.some((args) => args[0] === 'HDEL')).toBe(false);
    const evalCall = call.mock.calls.find((args) => args[0] === 'EVAL');
    expect(evalCall?.[5]).toBe('retrieval');
  });
});
