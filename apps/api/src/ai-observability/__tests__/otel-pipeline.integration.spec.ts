import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import { OtelIngestService, OtlpTraceRequest } from '../otel-ingest.service';
import { AiObservabilityService } from '../ai-observability.service';
import { TraceCorrelationService } from '../trace-correlation.service';

/**
 * End-to-end pipeline over the REAL MemoryAdapter: ingest a realistic OTLP/JSON
 * chat.turn trace, then query traces / spans and correlate against a fake Valkey.
 * No external infra — exercises the ingest → store → query → correlate seams.
 */

function nano(msFromBase: number): string {
  // base 1_700_000_000_000 ms → ns, plus offset ms
  return String((1_700_000_000_000n + BigInt(msFromBase)) * 1_000_000n);
}

function span(o: {
  spanId: string;
  parent?: string;
  name: string;
  scope: string;
  startMs: number;
  durMs: number;
  attrs?: Record<string, unknown>;
  status?: number;
}) {
  return {
    traceId: 'trace-chatturn-1',
    spanId: o.spanId,
    parentSpanId: o.parent,
    name: o.name,
    kind: 1,
    startTimeUnixNano: nano(o.startMs),
    endTimeUnixNano: nano(o.startMs + o.durMs),
    attributes: Object.entries(o.attrs ?? {}).map(([key, v]) => ({
      key,
      value:
        typeof v === 'boolean'
          ? { boolValue: v }
          : typeof v === 'number'
            ? { doubleValue: v }
            : { stringValue: String(v) },
    })),
    status: { code: o.status ?? 1 },
    _scope: o.scope,
  };
}

function request(): OtlpTraceRequest {
  const spans = [
    span({ spanId: 'root', name: 'chat.turn', scope: 'chat-app', startMs: 0, durMs: 781 }),
    span({
      spanId: 'ac-check',
      parent: 'root',
      name: 'agent_cache.llm.check',
      scope: '@betterdb/agent-cache',
      startMs: 2,
      durMs: 2,
      attrs: { 'cache.hit': false, 'cache.key': 'playground:llm:abc', 'cache.model': 'gpt-4o-mini' },
    }),
    span({
      spanId: 'sc-check',
      parent: 'root',
      name: 'semantic_cache.check',
      scope: '@betterdb/semantic-cache',
      startMs: 5,
      durMs: 448,
      attrs: { 'cache.hit': false, 'cache.matched_key': 'pg_sc:entry:u1' },
    }),
    span({
      spanId: 'mem-recall',
      parent: 'root',
      name: 'memory.recall',
      scope: '@betterdb/agent-memory',
      startMs: 300,
      durMs: 304,
    }),
    // non-betterdb, non-root → must be dropped on ingest
    span({ spanId: 'stream', parent: 'root', name: 'ai.streamText', scope: 'ai', startMs: 460, durMs: 1600 }),
  ];
  // group spans by scope into scopeSpans
  const byScope = new Map<string, any[]>();
  for (const s of spans) {
    const { _scope, ...rest } = s as any;
    byScope.set(_scope, [...(byScope.get(_scope) ?? []), rest]);
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'betterdb-playground-chat' } }] },
        scopeSpans: [...byScope.entries()].map(([name, sp]) => ({ scope: { name }, spans: sp })),
      },
    ],
  };
}

function fakeRegistry(): ConnectionRegistry {
  const client = {
    call: async (cmd: string, args: string[]) => {
      if (cmd === 'EXISTS') return args[0] === 'playground:llm:abc' ? 1 : 0; // ac key now warm
      if (cmd === 'TTL') return args[0] === 'playground:llm:abc' ? 3600 : -2;
      if (cmd === 'HGET' && args[0] === 'pg_sc:__config' && args[1] === 'threshold') return '0.12';
      return null;
    },
    getCapabilities: () => ({ hasVectorSearch: true }),
    getVectorIndexInfo: async () => ({ indexingState: 'ready' }),
  };
  return { get: () => client } as unknown as ConnectionRegistry;
}

describe('OTLP pipeline (integration, MemoryAdapter)', () => {
  let storage: StoragePort;

  beforeEach(async () => {
    storage = new MemoryAdapter() as unknown as StoragePort;
    await storage.initialize();
  });
  afterEach(async () => {
    await storage.close();
  });

  it('ingests, stores, queries, and correlates a chat.turn trace', async () => {
    const ingest = new OtelIngestService(storage);
    const res = await ingest.ingest(request(), 1_700_000_001_000);

    // 5 spans received, ai.streamText dropped → 4 stored (root + 3 betterdb)
    expect(res.received).toBe(5);
    expect(res.stored).toBe(4);

    // Traces query aggregates the summary
    const obs = new AiObservabilityService(fakeRegistry(), storage, {} as any);
    const traces = await storage.getOtelTraces({});
    expect(traces).toHaveLength(1);
    expect(traces[0].rootName).toBe('chat.turn');
    expect(traces[0].serviceName).toBe('betterdb-playground-chat');
    expect(traces[0].betterdbSpanCount).toBe(3);
    expect(traces[0].durationNs).toBe(781_000_000);

    const spans = await obs.getTraceSpans('trace-chatturn-1');
    expect(spans.map((s) => s.spanId)).toEqual(['root', 'ac-check', 'sc-check', 'mem-recall']);
    expect(spans.find((s) => s.spanId === 'stream')).toBeUndefined();

    // Correlate against the fake Valkey
    const corr = new TraceCorrelationService(storage, fakeRegistry());
    const correlations = await corr.correlateTrace('trace-chatturn-1', 'c1');
    const byId = Object.fromEntries(correlations.map((c) => [c.spanId, c]));

    // agent-cache miss whose key is now warm
    expect(byId['ac-check'].keyExistsNow).toBe(true);
    expect(byId['ac-check'].keyTtlSeconds).toBe(3600);
    expect(byId['ac-check'].explanation).toMatch(/populated after this request/);

    // semantic-cache miss, key absent, threshold read from config
    expect(byId['sc-check'].keyExistsNow).toBe(false);
    expect(byId['sc-check'].threshold).toBeCloseTo(0.12);
    expect(byId['sc-check'].indexState).toBe('ready');

    // mem-recall has no cache.key → not correlated
    expect(byId['mem-recall']).toBeUndefined();
  });
});
