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
    const call = vi.fn(async () => 1);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    await retriever.register();

    const registerCall = call.mock.calls.find((args) => args[0] === 'HSET');
    expect(registerCall?.[1]).toBe(REGISTRY_KEY);
    expect(registerCall?.[2]).toBe('docs');
    const marker = JSON.parse(String(registerCall?.[3]));
    expect(marker.type).toBe('retrieval');
    expect(marker.prefix).toBe('docs');
    expect(typeof marker.started_at).toBe('string');
  });

  it('unregisters the marker from the registry', async () => {
    const call = vi.fn(async () => 1);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    await retriever.unregister();

    expect(call).toHaveBeenCalledWith('HDEL', REGISTRY_KEY, 'docs');
  });
});
