import { ConfigService } from '@nestjs/config';
import { KeyPatternSnapshot, HotKeyEntry } from '@betterdb/shared';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { resolveKeyDetailsTopN, resolveKeyPatternsTopN } from './export-profile';

const LABEL = '10.0.0.1:6379';
const CONN = 'conn-1';
const NOW = Date.now();

const KEYSIZES_RAW = [
  'db0_distrib_strings_sizes:1=19,2=655,16K=3',
  'db0_distrib_lists_items:1=5,32=2',
].join('\r\n');

function patternSnapshot(overrides: Partial<KeyPatternSnapshot> = {}): KeyPatternSnapshot {
  return {
    id: 'snap-1',
    timestamp: NOW,
    pattern: 'user:*',
    keyCount: 1000,
    sampledKeyCount: 1000,
    keysWithTtl: 10,
    keysExpiringSoon: 0,
    totalMemoryBytes: 1_000_000,
    avgMemoryBytes: 1000,
    maxMemoryBytes: 50_000,
    connectionId: CONN,
    ...overrides,
  };
}

function hotKey(overrides: Partial<HotKeyEntry> = {}): HotKeyEntry {
  return {
    id: 'hot-1',
    keyName: 'user:1:profile',
    signalType: 'cardinality',
    memoryBytes: 50_000,
    cardinality: 120,
    keyType: 'hash',
    rank: 1,
    capturedAt: NOW,
    connectionId: CONN,
    ...overrides,
  };
}

interface Harness {
  service: PrometheusService;
  client: { getInfoParsed: jest.Mock; call: jest.Mock };
  storage: { getKeyPatternSnapshots: jest.Mock; getHotKeys: jest.Mock };
  registry: { getConfig: jest.Mock };
}

function buildService(env: Record<string, unknown> = {}): Harness {
  const client = {
    getInfoParsed: jest.fn().mockResolvedValue({
      server: { valkey_version: '8.1.0', uptime_in_seconds: '100' },
      keyspace: { db0: { keys: 10, expires: 2, avg_ttl: 1000 } },
      cluster: { cluster_enabled: '0' },
    }),
    call: jest.fn().mockResolvedValue(KEYSIZES_RAW),
  };
  const registry = {
    getConfig: jest.fn().mockReturnValue({ host: '10.0.0.1', port: 6379 }),
    get: jest.fn().mockReturnValue(client),
    list: jest.fn().mockReturnValue([]),
    getName: jest.fn().mockReturnValue('primary'),
  };
  const storage = {
    getKeyPatternSnapshots: jest
      .fn()
      .mockResolvedValue([
        patternSnapshot(),
        patternSnapshot({ id: 'snap-2', pattern: 'session:*', totalMemoryBytes: 200_000, avgMemoryBytes: 400, maxMemoryBytes: 9_000, keyCount: 500 }),
      ]),
    getHotKeys: jest
      .fn()
      .mockResolvedValue([
        hotKey(),
        hotKey({ keyName: 'queue:jobs', keyType: 'list', memoryBytes: 20_000, cardinality: 4000, rank: 2 }),
      ]),
  };
  const values: Record<string, unknown> = { PROMETHEUS_POLL_INTERVAL_MS: 5000, ...env };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  } as unknown as ConfigService;
  const tracker = {
    isAvailable: jest.fn().mockReturnValue(true),
    recordFailure: jest.fn(),
  };

  const service = new PrometheusService(
    storage as unknown as StoragePort,
    registry as unknown as ConnectionRegistry,
    config,
    tracker as unknown as RuntimeCapabilityTracker,
    {} as SlowLogAnalyticsService,
    {} as CommandLogAnalyticsService,
    {} as HealthService,
  );
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  return { service, client, storage, registry };
}

async function update(service: PrometheusService): Promise<void> {
  await service['runUpdateMetricsForConnection'](CONN);
  await service['updateStorageBasedMetricsForConnection'](CONN);
}

/** Reset the per-connection refresh throttles so a second update re-reads. */
function resetThrottles(service: PrometheusService): void {
  const state = service['perConnectionState'].get(CONN);
  if (state) {
    state.lastKeyAnalyticsRefreshAt = 0;
    state.lastKeysizesRefreshAt = 0;
    state.keysizesUnavailableUntil = 0;
  }
}

function keySizeSeries(text: string): string[] {
  return text
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('#') &&
        /^betterdb_(key_pattern_|key_memory_bytes|key_cardinality|keysize_bucket_keys)/.test(line),
    );
}

describe('PrometheusService key size metrics', () => {
  it('exports per-pattern gauges from the latest snapshot batch', async () => {
    const { service } = buildService();
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain(
      `betterdb_key_pattern_memory_bytes{connection="${LABEL}",pattern="user:*"} 1000000`,
    );
    expect(text).toContain(
      `betterdb_key_pattern_avg_memory_bytes{connection="${LABEL}",pattern="user:*"} 1000`,
    );
    expect(text).toContain(
      `betterdb_key_pattern_max_memory_bytes{connection="${LABEL}",pattern="user:*"} 50000`,
    );
    expect(text).toContain(
      `betterdb_key_pattern_keys{connection="${LABEL}",pattern="session:*"} 500`,
    );
  });

  it('exports only the latest run when older snapshots are present', async () => {
    const { service, storage } = buildService();
    storage.getKeyPatternSnapshots.mockResolvedValue([
      patternSnapshot(),
      patternSnapshot({ id: 'snap-old', pattern: 'stale:*', timestamp: NOW - 600_000 }),
    ]);
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain(`pattern="user:*"`);
    expect(text).not.toContain(`pattern="stale:*"`);
  });

  it('exports per-key gauges ranked by memory', async () => {
    const { service } = buildService();
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain(
      `betterdb_key_memory_bytes{connection="${LABEL}",key="user:1:profile",type="hash"} 50000`,
    );
    expect(text).toContain(
      `betterdb_key_cardinality{connection="${LABEL}",key="queue:jobs",type="list"} 4000`,
    );
  });

  it('coerces string numerics as returned by the Postgres adapter', async () => {
    const { service, storage } = buildService();
    storage.getHotKeys.mockResolvedValue([
      hotKey({ memoryBytes: '70000' as unknown as number, cardinality: '123' as unknown as number }),
    ]);
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain(
      `betterdb_key_memory_bytes{connection="${LABEL}",key="user:1:profile",type="hash"} 70000`,
    );
    expect(text).toContain(
      `betterdb_key_cardinality{connection="${LABEL}",key="user:1:profile",type="hash"} 123`,
    );
  });

  it('bounds per-key series to METRICS_KEY_DETAILS_TOP_N by memory', async () => {
    const { service } = buildService({ METRICS_KEY_DETAILS_TOP_N: 1 });
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain(`key="user:1:profile"`);
    expect(text).not.toContain(`key="queue:jobs"`);
  });

  it('bounds per-pattern series to METRICS_KEY_PATTERNS_TOP_N by total memory', async () => {
    const { service } = buildService({ METRICS_KEY_PATTERNS_TOP_N: 1 });
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain(`pattern="user:*"`);
    expect(text).not.toContain(`pattern="session:*"`);
  });

  it('METRICS_KEY_DETAILS_TOP_N=0 disables only per-key series', async () => {
    const { service, storage } = buildService({ METRICS_KEY_DETAILS_TOP_N: 0 });
    await update(service);
    const text = await service.getMetrics();

    expect(storage.getHotKeys).not.toHaveBeenCalled();
    expect(text).not.toContain('betterdb_key_memory_bytes{');
    expect(text).not.toContain('betterdb_key_cardinality{');
    expect(text).toContain(`betterdb_key_pattern_memory_bytes{connection="${LABEL}"`);
    expect(text).toContain('betterdb_keysize_bucket_keys{');
  });

  it('exports keysize distribution buckets from INFO keysizes', async () => {
    const { service, client } = buildService();
    await update(service);
    const text = await service.getMetrics();

    expect(client.call).toHaveBeenCalledWith('INFO', ['keysizes']);
    expect(text).toContain(
      `betterdb_keysize_bucket_keys{connection="${LABEL}",db="db0",type="strings",metric="sizes",bucket="2"} 655`,
    );
    expect(text).toContain(
      `betterdb_keysize_bucket_keys{connection="${LABEL}",db="db0",type="lists",metric="items",bucket="32"} 2`,
    );
  });

  it('yields no keysize series when the server lacks the keysizes section', async () => {
    const { service, client } = buildService();
    client.call.mockRejectedValue(new Error('ERR unknown INFO section'));
    await update(service);
    const text = await service.getMetrics();

    expect(text).not.toContain('betterdb_keysize_bucket_keys{');
  });

  it('removes keysize series when the section becomes unavailable', async () => {
    const { service, client } = buildService();
    await update(service);
    expect(await service.getMetrics()).toContain('betterdb_keysize_bucket_keys{');

    client.call.mockResolvedValue('');
    resetThrottles(service);
    await update(service);
    expect(await service.getMetrics()).not.toContain('betterdb_keysize_bucket_keys{');
  });

  it('removes pattern and key series when analytics data disappears', async () => {
    const { service, storage } = buildService();
    await update(service);
    expect(keySizeSeries(await service.getMetrics()).length).toBeGreaterThan(0);

    storage.getKeyPatternSnapshots.mockResolvedValue([]);
    storage.getHotKeys.mockResolvedValue([]);
    resetThrottles(service);
    await update(service);
    const text = await service.getMetrics();

    expect(text).not.toContain('betterdb_key_pattern_memory_bytes{');
    expect(text).not.toContain('betterdb_key_memory_bytes{');
  });

  it('exports no analytics series for a non-owning topology member', async () => {
    const { service, registry, storage } = buildService();
    registry.getConfig.mockReturnValue({
      host: '10.0.0.1',
      port: 6379,
      membership: { seedId: 'seed', nodeId: 'n1', origin: 'auto', source: 'cluster' },
    });
    await update(service);
    const text = await service.getMetrics();

    expect(storage.getKeyPatternSnapshots).not.toHaveBeenCalled();
    expect(text).not.toContain('betterdb_key_pattern_memory_bytes{');
    expect(text).not.toContain('betterdb_key_memory_bytes{');
  });

  it('queries the latest capture bounded by the staleness window', async () => {
    const { service, storage } = buildService();
    await update(service);

    expect(storage.getHotKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONN,
        latest: true,
        signalTypes: ['cardinality'],
        startTime: expect.any(Number),
      }),
    );
    const { startTime } = storage.getHotKeys.mock.calls[0][0];
    // 3x the default 5-minute analytics interval
    expect(Date.now() - startTime).toBeGreaterThanOrEqual(899_000);
    expect(Date.now() - startTime).toBeLessThanOrEqual(901_000);
  });
});

describe('key size top-N resolvers', () => {
  it('vitals profile disables both families', () => {
    expect(resolveKeyPatternsTopN('50', 'vitals')).toBe(0);
    expect(resolveKeyDetailsTopN('5', 'vitals')).toBe(0);
  });

  it('defaults and caps are applied', () => {
    expect(resolveKeyPatternsTopN(undefined, 'full')).toBe(100);
    expect(resolveKeyDetailsTopN(undefined, 'full')).toBe(10);
    expect(resolveKeyDetailsTopN('500', 'full')).toBe(50);
    expect(resolveKeyDetailsTopN('-3', 'full')).toBe(0);
  });
});
