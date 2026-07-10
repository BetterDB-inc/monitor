import { OtelIngestService, OtlpTraceRequest } from '../otel-ingest.service';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { StoredOtelSpan } from '@betterdb/shared';

function makeService() {
  const saved: StoredOtelSpan[] = [];
  const storage = {
    saveOtelSpans: jest.fn(async (spans: StoredOtelSpan[]) => {
      saved.push(...spans);
      return spans.length;
    }),
  } as unknown as StoragePort;
  return { svc: new OtelIngestService(storage), saved };
}

const NOW = 1_700_000_000_100;

function req(): OtlpTraceRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'chat-app' } }] },
        scopeSpans: [
          {
            scope: { name: 'chat-app-instrumentation' },
            spans: [
              // root, non-betterdb scope → kept (root)
              {
                traceId: 't1',
                spanId: 'root',
                name: 'chat.turn',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000000742000000',
              },
              // non-betterdb, non-root → dropped
              {
                traceId: 't1',
                spanId: 'fetch',
                parentSpanId: 'root',
                name: 'fetch POST',
                startTimeUnixNano: '1700000000100000000',
                endTimeUnixNano: '1700000000200000000',
              },
            ],
          },
          {
            scope: { name: '@betterdb/agent-cache' },
            spans: [
              // betterdb child → kept, with attributes flattened
              {
                traceId: 't1',
                spanId: 'cache',
                parentSpanId: 'root',
                name: 'agent_cache.llm.check',
                startTimeUnixNano: '1700000000010000000',
                endTimeUnixNano: '1700000000011000000',
                attributes: [
                  { key: 'cache.hit', value: { boolValue: true } },
                  { key: 'cache.model', value: { stringValue: 'gpt-4o-mini' } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('OtelIngestService.ingest', () => {
  it('keeps @betterdb/* spans plus roots, drops other spans', async () => {
    const { svc, saved } = makeService();

    const res = await svc.ingest(req(), NOW);

    expect(res.received).toBe(3);
    expect(res.stored).toBe(2);
    expect(saved.map((s) => s.spanId).sort()).toEqual(['cache', 'root']);
    expect(saved.find((s) => s.spanId === 'fetch')).toBeUndefined();
  });

  it('maps times, service, scope, and attributes', async () => {
    const { svc, saved } = makeService();
    await svc.ingest(req(), NOW);

    const root = saved.find((s) => s.spanId === 'root')!;
    expect(root.serviceName).toBe('chat-app');
    expect(root.parentSpanId).toBeNull();
    expect(root.startTimeMs).toBe(1_700_000_000_000);
    expect(root.durationNs).toBe(742_000_000);
    expect(root.ingestedAt).toBe(NOW);

    const cache = saved.find((s) => s.spanId === 'cache')!;
    expect(cache.scopeName).toBe('@betterdb/agent-cache');
    expect(cache.durationNs).toBe(1_000_000);
    const attrs = JSON.parse(cache.attributes);
    expect(attrs['cache.hit']).toBe(true);
    expect(attrs['cache.model']).toBe('gpt-4o-mini');
  });

  it('stores nothing for an empty request', async () => {
    const { svc, saved } = makeService();
    const res = await svc.ingest({}, NOW);
    expect(res).toEqual({ stored: 0, received: 0 });
    expect(saved).toHaveLength(0);
  });
});
