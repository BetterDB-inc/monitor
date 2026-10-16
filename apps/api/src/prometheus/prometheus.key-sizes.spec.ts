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

// Mirror of PrometheusService.KEYSIZES_STALENESS_MS (10 * 30s refresh = 5 min):
// the freeze cap for a frozen bucket histogram under persistent transient
// transport failures (the keysizes read has no query window of its own).
const KEYSIZES_STALENESS_MS = 300_000;

interface SnapshotQuery {
  startTime?: number;
  endTime?: number;
  limit?: number;
}

/**
 * A getKeyPatternSnapshots mock that honors the query options the way both
 * real adapters do: filter the fixture rows by [startTime, endTime], return
 * them newest-first, and apply the row limit. The production two-step read
 * (limit-1 probe, then a startTime=endTime=latestTimestamp batch) only selects
 * a single run because the adapter enforces the window — so the mock must too.
 */
function patternSnapshotsHonoring(rows: KeyPatternSnapshot[]): jest.Mock {
  return jest.fn(async (query: SnapshotQuery = {}) => {
    let result = rows.filter(
      (row) =>
        (query.startTime === undefined || row.timestamp >= query.startTime) &&
        (query.endTime === undefined || row.timestamp <= query.endTime),
    );
    result = [...result].sort((a, b) => b.timestamp - a.timestamp);
    if (query.limit !== undefined) {
      result = result.slice(0, query.limit);
    }
    return result;
  });
}

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
  tracker: { isAvailable: jest.Mock; recordFailure: jest.Mock };
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
    getKeyPatternSnapshots: patternSnapshotsHonoring([
      patternSnapshot(),
      patternSnapshot({
        id: 'snap-2',
        pattern: 'session:*',
        totalMemoryBytes: 200_000,
        avgMemoryBytes: 400,
        maxMemoryBytes: 9_000,
        keyCount: 500,
      }),
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
    recordFailure: jest.fn().mockReturnValue(false),
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
  return { service, client, storage, registry, tracker };
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
    // Honor the query window: the probe resolves the newest run's timestamp and
    // the batch fetches startTime=endTime=that timestamp, so the stale run is
    // filtered out by the adapter contract — not a post-fetch .filter().
    storage.getKeyPatternSnapshots.mockImplementation(
      patternSnapshotsHonoring([
        patternSnapshot(),
        patternSnapshot({ id: 'snap-old', pattern: 'stale:*', timestamp: NOW - 600_000 }),
      ]),
    );
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
    // type is normalized to the singular TYPE-style name (INFO reports plural),
    // so it joins with the per-key/per-pattern families.
    expect(text).toContain(
      `betterdb_keysize_bucket_keys{connection="${LABEL}",db="db0",type="string",metric="sizes",bucket="2"} 655`,
    );
    expect(text).toContain(
      `betterdb_keysize_bucket_keys{connection="${LABEL}",db="db0",type="list",metric="items",bucket="32"} 2`,
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
    // No section header at all means "unsupported": the long backoff is armed.
    expect(service['perConnectionState'].get(CONN)!.keysizesUnavailableUntil).toBeGreaterThan(0);
  });

  it('treats a header-only reply as an empty keyspace, not an unsupported server', async () => {
    const { service, client } = buildService();
    await update(service);
    expect(await service.getMetrics()).toContain('betterdb_keysize_bucket_keys{');

    // Redis 8 with an empty keyspace (e.g. right after FLUSHALL) replies with
    // the section header and no distribution lines.
    client.call.mockResolvedValue('# Keysizes\r\n');
    resetThrottles(service);
    await update(service);
    expect(await service.getMetrics()).not.toContain('betterdb_keysize_bucket_keys{');
    expect(service['perConnectionState'].get(CONN)!.keysizesUnavailableUntil).toBe(0);

    // Keys written back show up on the next refresh, not after a 10m backoff.
    client.call.mockResolvedValue(KEYSIZES_RAW);
    resetThrottles(service);
    await update(service);
    expect(await service.getMetrics()).toContain('betterdb_keysize_bucket_keys{');
  });

  it('keeps keysize series through a transient INFO failure', async () => {
    const { service, client } = buildService();
    await update(service);
    expect(await service.getMetrics()).toContain('betterdb_keysize_bucket_keys{');

    client.call.mockRejectedValue(new Error('Command timed out'));
    resetThrottles(service);
    await update(service);
    // A transport error on a healthy server must not blank the histogram or
    // arm the unsupported backoff.
    expect(await service.getMetrics()).toContain('betterdb_keysize_bucket_keys{');
    expect(service['perConnectionState'].get(CONN)!.keysizesUnavailableUntil).toBe(0);
  });

  it('removes analytics series when storage keeps failing past the staleness bound', async () => {
    const { service, storage } = buildService();
    await update(service);
    expect(await service.getMetrics()).toContain('betterdb_key_pattern_memory_bytes{');

    storage.getKeyPatternSnapshots.mockRejectedValue(new Error('db down'));
    storage.getHotKeys.mockRejectedValue(new Error('db down'));
    const state = service['perConnectionState'].get(CONN)!;
    // Both families stale past the bound: the synchronous prefix removes each
    // before the (now-failing) fetch runs.
    state.lastPatternsSuccessAt = Date.now() - 901_000;
    state.lastKeyDetailsSuccessAt = Date.now() - 901_000;
    resetThrottles(service);
    await update(service);

    const text = await service.getMetrics();
    expect(text).not.toContain('betterdb_key_pattern_memory_bytes{');
    expect(text).not.toContain('betterdb_key_memory_bytes{');
  });

  it('parses KEY_ANALYTICS_INTERVAL_MS like the collector (empty/invalid falls back)', () => {
    expect(buildService({ KEY_ANALYTICS_INTERVAL_MS: '' }).service['keyAnalyticsStalenessMs']).toBe(
      900_000,
    );
    expect(
      buildService({ KEY_ANALYTICS_INTERVAL_MS: 'abc' }).service['keyAnalyticsStalenessMs'],
    ).toBe(900_000);
    expect(
      buildService({ KEY_ANALYTICS_INTERVAL_MS: '60000' }).service['keyAnalyticsStalenessMs'],
    ).toBe(180_000);
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
    // 3x the default 5-minute analytics interval; generous upper tolerance so
    // a slow CI runner between the stamp and this assertion cannot flake it.
    expect(Date.now() - startTime).toBeGreaterThanOrEqual(900_000);
    expect(Date.now() - startTime).toBeLessThanOrEqual(960_000);
  });

  it('skips the batch fetch and getHotKeys when the latest run is unchanged', async () => {
    const { service, storage } = buildService();
    await update(service);

    storage.getKeyPatternSnapshots.mockClear();
    storage.getHotKeys.mockClear();
    resetThrottles(service);
    await update(service);

    // Only the limit-1 probes run (one for patterns, one confirming the hot-key
    // capture is unchanged); the unchanged run skips the batch re-fetch and
    // every gauge rewrite.
    expect(storage.getKeyPatternSnapshots).toHaveBeenCalledTimes(1);
    expect(storage.getKeyPatternSnapshots.mock.calls[0][0]).toMatchObject({ limit: 1 });
    expect(storage.getHotKeys).toHaveBeenCalledTimes(1);
    expect(storage.getHotKeys.mock.calls[0][0]).toMatchObject({
      limit: 1,
      latest: true,
      signalTypes: ['cardinality'],
    });
    // The already-exported series are still served.
    expect(await service.getMetrics()).toContain('betterdb_key_pattern_memory_bytes{');
  });

  it('re-exports the run once its timestamp advances', async () => {
    const { service, storage } = buildService();
    await update(service);

    storage.getKeyPatternSnapshots.mockImplementation(
      patternSnapshotsHonoring([
        patternSnapshot({ timestamp: NOW + 1000, totalMemoryBytes: 3_000_000 }),
      ]),
    );
    storage.getHotKeys.mockClear();
    resetThrottles(service);
    await update(service);

    // A newer run defeats the probe-skip: the batch re-fetches and getHotKeys runs.
    expect(storage.getHotKeys).toHaveBeenCalled();
    expect(await service.getMetrics()).toContain(
      `betterdb_key_pattern_memory_bytes{connection="${LABEL}",pattern="user:*"} 3000000`,
    );
  });

  it('re-exports per-key gauges when a newer hot-key capture lands under an unchanged pattern run', async () => {
    const { service, storage } = buildService();
    await update(service);
    expect(await service.getMetrics()).toContain(
      `betterdb_key_memory_bytes{connection="${LABEL}",key="user:1:profile",type="hash"} 50000`,
    );

    // The pattern run is unchanged (same timestamp), but hot keys are persisted
    // in a second write that can lag the pattern write, so a newer capture lands
    // under the same run. Probe-skip must not freeze the per-key gauges on the
    // previous capture: it keys off the hot-key captured_at, not just the
    // pattern timestamp.
    storage.getHotKeys.mockResolvedValue([
      hotKey({ keyName: 'bigblob:1', keyType: 'string', memoryBytes: 999_999, capturedAt: NOW + 1000 }),
    ]);
    resetThrottles(service);
    await update(service);

    const text = await service.getMetrics();
    expect(text).toContain(
      `betterdb_key_memory_bytes{connection="${LABEL}",key="bigblob:1",type="string"} 999999`,
    );
    // The previous capture's key is gone, not frozen alongside the new one.
    expect(text).not.toContain('key="user:1:profile"');
  });

  it('keeps and updates pattern series while getHotKeys persistently fails', async () => {
    const { service, storage } = buildService();
    await update(service);
    expect(await service.getMetrics()).toContain('betterdb_key_pattern_memory_bytes{');
    expect(await service.getMetrics()).toContain('betterdb_key_memory_bytes{');

    // getHotKeys (per-key family) fails; its last success is pushed past the
    // bound so the sync prefix expires only that family. Patterns stay healthy.
    storage.getHotKeys.mockRejectedValue(new Error('hot keys unavailable'));
    const state = service['perConnectionState'].get(CONN)!;
    state.lastKeyDetailsSuccessAt = Date.now() - 901_000;
    storage.getKeyPatternSnapshots.mockImplementation(
      patternSnapshotsHonoring([patternSnapshot({ totalMemoryBytes: 4_000_000 })]),
    );
    resetThrottles(service);
    await update(service);

    const text = await service.getMetrics();
    // Pattern family survives AND reflects the newest run.
    expect(text).toContain(
      `betterdb_key_pattern_memory_bytes{connection="${LABEL}",pattern="user:*"} 4000000`,
    );
    // Per-key family removed after its own staleness bound.
    expect(text).not.toContain('betterdb_key_memory_bytes{');
    // A failing getHotKeys must still let the pattern family stamp success.
    expect(state.lastPatternsSuccessAt).toBeGreaterThan(state.lastKeyDetailsSuccessAt);
  });

  it('records a blocked-command keysizes failure and drops the buckets', async () => {
    const { service, client, tracker } = buildService();
    await update(service);
    expect(await service.getMetrics()).toContain('betterdb_keysize_bucket_keys{');

    client.call.mockRejectedValue(
      new Error("NOPERM this user has no permissions to run the 'info|keysizes' command"),
    );
    tracker.recordFailure.mockReturnValue(true);
    resetThrottles(service);
    await update(service);

    expect(tracker.recordFailure).toHaveBeenCalledWith(CONN, 'canKeysizes', expect.any(Error));
    expect(await service.getMetrics()).not.toContain('betterdb_keysize_bucket_keys{');
    // A blocked command is not a "section absent" signal, so no 10m backoff is
    // armed — the capability gate (not the backoff) suppresses re-probes.
    expect(service['perConnectionState'].get(CONN)!.keysizesUnavailableUntil).toBe(0);
  });

  it('drops keysize buckets and skips the probe when the capability is unavailable', async () => {
    const { service, client, tracker } = buildService();
    await update(service);
    expect(await service.getMetrics()).toContain('betterdb_keysize_bucket_keys{');

    tracker.isAvailable.mockImplementation((_id: string, key: string) => key !== 'canKeysizes');
    client.call.mockClear();
    resetThrottles(service);
    await update(service);

    expect(client.call).not.toHaveBeenCalled();
    expect(await service.getMetrics()).not.toContain('betterdb_keysize_bucket_keys{');
  });

  it('logs a transient keysizes failure once across repeated refreshes', async () => {
    const { service, client } = buildService();
    const logged = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);
    await update(service);

    client.call.mockRejectedValue(new Error('Command timed out'));
    const keysizesLogsBefore = logged.mock.calls.filter((call) =>
      String(call[0]).includes('keysizes'),
    ).length;
    resetThrottles(service);
    await update(service);
    resetThrottles(service);
    await update(service);
    const keysizesLogsAfter = logged.mock.calls.filter((call) =>
      String(call[0]).includes('keysizes'),
    ).length;

    // Same message twice logs exactly once (dedup latch), series kept.
    expect(keysizesLogsAfter - keysizesLogsBefore).toBe(1);
    expect(await service.getMetrics()).toContain('betterdb_keysize_bucket_keys{');
  });

  it('removes keysize buckets once a transient failure persists past the bound', async () => {
    const { service, client } = buildService();
    await update(service);
    expect(await service.getMetrics()).toContain('betterdb_keysize_bucket_keys{');

    client.call.mockRejectedValue(new Error('Command timed out'));
    const state = service['perConnectionState'].get(CONN)!;
    state.lastKeysizesSuccessAt = Date.now() - (KEYSIZES_STALENESS_MS + 1000);
    resetThrottles(service);
    await update(service);

    // The sync-prefix freeze cap drops the histogram; still no unsupported backoff.
    expect(await service.getMetrics()).not.toContain('betterdb_keysize_bucket_keys{');
    expect(state.keysizesUnavailableUntil).toBe(0);
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
