import { Test } from '@nestjs/testing';
import type { ConnectionStatus } from '@betterdb/shared';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { MemoryAnalyticsService } from '../../memory-analytics/memory-analytics.service';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { ExternalMetricsStore } from '../external-metrics-store';
import { ExternalMetricsAdapter } from '../external-metrics.adapter';
import { OtelMetricsIngestService, toPartialSuccess } from '../otel-metrics-ingest.service';
import { decodeOtlpMetricsProtobuf, otlpMetricsRoot } from '../otlp-metrics-protobuf';

const T0 = 1_700_000_000_000;
const SCRAPE_MS = 60_000;
const RequestType = otlpMetricsRoot.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest');

const s = (key: string, value: string) => ({ key, value: { stringValue: value } });
const i = (key: string, value: number) => ({ key, value: { intValue: String(value) } });

function nanos(ms: number): string {
  return String(BigInt(ms) * 1_000_000n);
}

function gauge(name: string, value: number, timeMs: number, attrs: object[] = []) {
  return { name, gauge: { dataPoints: [{ attributes: attrs, timeUnixNano: nanos(timeMs), asInt: String(value) }] } };
}

function cumulative(name: string, value: number, timeMs: number, attrs: object[] = []) {
  return {
    name,
    sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ attributes: attrs, timeUnixNano: nanos(timeMs), asDouble: value }] },
  };
}

function scrape(timeMs: number, usedMemory: number, identity: object[]) {
  return {
    resource: { attributes: [...identity, s('redis.version', '7.2.4')] },
    scopeMetrics: [
      {
        metrics: [
          gauge('redis.memory.used', usedMemory, timeMs),
          gauge('redis.memory.rss', usedMemory + 500_000, timeMs),
          gauge('redis.memory.peak', usedMemory + 1_000_000, timeMs),
          { name: 'redis.memory.fragmentation_ratio', gauge: { dataPoints: [{ timeUnixNano: nanos(timeMs), asDouble: 1.4 }] } },
          gauge('redis.maxmemory', 8_000_000, timeMs),
          gauge('redis.clients.connected', 12, timeMs),
          cumulative('redis.cpu.time', timeMs / 100_000, timeMs, [s('state', 'sys')]),
          cumulative('redis.cpu.time', timeMs / 50_000, timeMs, [s('state', 'user')]),
          gauge('redis.db.keys', 1234, timeMs, [s('db', '0')]),
          { name: 'redis.cmd.latency', histogram: { dataPoints: [{ timeUnixNano: nanos(timeMs) }] } },
        ],
      },
    ],
  };
}

describe('OTLP metrics ingestion end to end', () => {
  const identity = [s('server.address', 'cache.internal'), i('server.port', 6379)];
  let store: ExternalMetricsStore;
  let storage: MemoryAdapter;
  let ingest: OtelMetricsIngestService;
  let memory: MemoryAnalyticsService;

  beforeEach(async () => {
    jest.useFakeTimers({ now: T0 });
    store = new ExternalMetricsStore();
    storage = new MemoryAdapter();
    await storage.initialize();
    const adapter = new ExternalMetricsAdapter('ext-1', store);
    const registry = {
      findByHostPort: (host: string, port: number) =>
        host === 'cache.internal' && port === 6379 ? { id: 'ext-1', connectionType: 'external' as const } : null,
      list: (): ConnectionStatus[] => [
        {
          id: 'ext-1',
          name: 'pushed',
          host: 'cache.internal',
          port: 6379,
          isConnected: adapter.isConnected(),
          connectionType: 'external',
        } as ConnectionStatus,
      ],
      get: () => adapter,
    };
    const module = await Test.createTestingModule({
      providers: [
        MemoryAnalyticsService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ConnectionRegistry, useValue: registry },
      ],
    }).compile();
    memory = module.get(MemoryAnalyticsService);
    ingest = new OtelMetricsIngestService(registry as unknown as ConnectionRegistry, store);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const tick = () => (memory as unknown as { tick(): Promise<void> }).tick();

  const post = (resourceMetrics: object[]) => {
    const body = Buffer.from(RequestType.encode(RequestType.fromObject({ resourceMetrics })).finish());
    return ingest.ingest(decodeOtlpMetricsProtobuf(body), Date.now());
  };

  it('writes one memory snapshot per scrape and reports drops', async () => {
    const scrapes = 4;
    for (let n = 0; n < scrapes; n++) {
      const t = T0 + n * SCRAPE_MS;
      jest.setSystemTime(t);
      const result = post([
        scrape(t, 2_000_000 + n * 100_000, identity),
        scrape(t, 1, [s('server.address', 'unknown.internal'), i('server.port', 6379)]),
        scrape(t, 1, []),
      ]);
      expect(toPartialSuccess(result)).toEqual({
        rejectedDataPoints: 1 + 10 + 10,
        errorMessage: 'unidentified=10 unknown_instance=10 unsupported_type=1',
      });
      await tick();
      jest.setSystemTime(t + 15_000);
      await tick();
    }

    const snapshots = await storage.getMemorySnapshots({ connectionId: 'ext-1' });
    expect(snapshots).toHaveLength(scrapes);
    expect(snapshots.map((snap) => snap.usedMemory).sort()).toEqual([2_000_000, 2_100_000, 2_200_000, 2_300_000]);
    expect(snapshots.every((snap) => snap.maxmemory === 8_000_000)).toBe(true);
  });

  it('stops writing once pushes stop and the sample goes stale', async () => {
    jest.setSystemTime(T0);
    post([scrape(T0, 2_000_000, identity)]);
    await tick();
    jest.setSystemTime(T0 + store.staleAfterMs + 1);
    await tick();
    expect(await storage.getMemorySnapshots({ connectionId: 'ext-1' })).toHaveLength(1);
  });
});
