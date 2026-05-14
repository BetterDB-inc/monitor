/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { InferenceLatencyService, InferenceLatencyValidationError } from '../inference-latency.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { PrometheusService } from '../../prometheus/prometheus.service';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeSlowLogEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    timestamp: 1_700_000_000,
    duration: 50_000,
    command: ['GET', 'session:abc'],
    clientAddress: '127.0.0.1:1234',
    clientName: 'worker',
    capturedAt: 1_700_000_000_000,
    sourceHost: 'localhost',
    sourcePort: 6379,
    connectionId: 'conn-1',
    ...overrides,
  };
}

function makeCommandLogEntry(overrides: Record<string, unknown> = {}) {
  return {
    ...makeSlowLogEntry(overrides),
    commandlogId: 1001,
    logType: 'slow',
  };
}

function buildRegistry(opts: {
  hasCommandLog?: boolean;
  connectionId?: string;
  thresholdValue?: string | null;
} = {}) {
  const { hasCommandLog = false, connectionId = 'conn-1', thresholdValue = '10000' } = opts;

  const connection = {
    getCapabilities: jest.fn().mockReturnValue({ hasCommandLog }),
    getConfigValue: jest.fn().mockResolvedValue(thresholdValue),
  };

  return {
    get: jest.fn((id: string) => {
      if (id !== connectionId) throw new NotFoundException(`Connection '${id}' not found.`);
      return connection;
    }),
    list: jest.fn().mockReturnValue([]),
    getDefaultId: jest.fn().mockReturnValue(connectionId),
  };
}

function buildStorage(opts: {
  slowLogEntries?: any[];
  commandLogEntries?: any[];
  snapshots?: any[];
} = {}) {
  return {
    getSlowLogEntries: jest.fn().mockResolvedValue(opts.slowLogEntries ?? []),
    getCommandLogEntries: jest.fn().mockResolvedValue(opts.commandLogEntries ?? []),
    getVectorIndexSnapshots: jest.fn().mockResolvedValue(opts.snapshots ?? []),
  };
}

function buildPrometheus() {
  return { updateInferenceLatencyMetrics: jest.fn() };
}

async function buildModule(
  registry: any,
  storage: any,
  prometheus: any,
): Promise<InferenceLatencyService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      InferenceLatencyService,
      { provide: ConnectionRegistry, useValue: registry },
      { provide: 'STORAGE_CLIENT', useValue: storage },
      { provide: PrometheusService, useValue: prometheus },
    ],
  }).compile();

  return module.get(InferenceLatencyService);
}

// ---------------------------------------------------------------------------
// getProfile
// ---------------------------------------------------------------------------

describe('InferenceLatencyService.getProfile', () => {
  it('returns an empty bucket list when no entries exist', async () => {
    const registry = buildRegistry();
    const storage = buildStorage();
    const svc = await buildModule(registry, storage, buildPrometheus());

    const profile = await svc.getProfile('conn-1');

    expect(profile.connectionId).toBe('conn-1');
    expect(profile.buckets).toHaveLength(0);
    expect(profile.source).toBe('slowlog');
  });

  it('queries commandlog when the connection supports it', async () => {
    const registry = buildRegistry({ hasCommandLog: true });
    const storage = buildStorage();
    const svc = await buildModule(registry, storage, buildPrometheus());

    const profile = await svc.getProfile('conn-1');

    expect(storage.getCommandLogEntries).toHaveBeenCalled();
    expect(storage.getSlowLogEntries).not.toHaveBeenCalled();
    expect(profile.source).toBe('commandlog');
  });

  it('groups slowlog entries into the correct buckets', async () => {
    const now = Date.now();
    const registry = buildRegistry();
    const storage = buildStorage({
      slowLogEntries: [
        makeSlowLogEntry({ timestamp: Math.floor(now / 1000) - 60, duration: 20_000 }),
        makeSlowLogEntry({ timestamp: Math.floor(now / 1000) - 30, duration: 40_000 }),
        makeSlowLogEntry({
          timestamp: Math.floor(now / 1000) - 45,
          duration: 60_000,
          command: ['SET', 'k', 'v'],
        }),
      ],
    });
    const svc = await buildModule(registry, storage, buildPrometheus());

    const profile = await svc.getProfile('conn-1', { windowMs: 300_000 });

    const readBucket = profile.buckets.find(b => b.bucket === 'read');
    const writeBucket = profile.buckets.find(b => b.bucket === 'write');
    expect(readBucket).toBeDefined();
    expect(readBucket?.count).toBe(2);
    expect(writeBucket).toBeDefined();
    expect(writeBucket?.count).toBe(1);
  });

  it('applies the explicit [startTime, endTime] window', async () => {
    const startTime = 1_700_000_000_000;
    const endTime   = 1_700_003_600_000;
    const registry = buildRegistry();
    const storage = buildStorage();
    const svc = await buildModule(registry, storage, buildPrometheus());

    await svc.getProfile('conn-1', { startTime, endTime });

    const call = storage.getSlowLogEntries.mock.calls[0][0];
    expect(call.startTime).toBe(Math.floor(startTime / 1000));
    expect(call.endTime).toBe(Math.ceil(endTime / 1000));
  });

  it('throws InferenceLatencyValidationError when only startTime is given', async () => {
    const svc = await buildModule(buildRegistry(), buildStorage(), buildPrometheus());

    await expect(
      svc.getProfile('conn-1', { startTime: 1_000_000 }),
    ).rejects.toBeInstanceOf(InferenceLatencyValidationError);
  });

  it('throws InferenceLatencyValidationError when endTime <= startTime', async () => {
    const svc = await buildModule(buildRegistry(), buildStorage(), buildPrometheus());

    await expect(
      svc.getProfile('conn-1', { startTime: 2000, endTime: 1000 }),
    ).rejects.toBeInstanceOf(InferenceLatencyValidationError);
  });

  it('surfaces thresholdUs from connection config', async () => {
    const registry = buildRegistry({ thresholdValue: '25000' });
    const storage = buildStorage();
    const svc = await buildModule(registry, storage, buildPrometheus());

    const profile = await svc.getProfile('conn-1');

    expect(profile.thresholdUs).toBe(25_000);
  });

  it('defaults thresholdUs to 0 when config fetch fails', async () => {
    const registry = buildRegistry({ thresholdValue: null });
    (registry.get('conn-1').getConfigValue as jest.Mock).mockRejectedValue(new Error('no config'));
    const storage = buildStorage();
    const svc = await buildModule(registry, storage, buildPrometheus());

    const profile = await svc.getProfile('conn-1');

    expect(profile.thresholdUs).toBe(0);
  });

  it('marks an FT.SEARCH bucket unhealthy when p50 exceeds the threshold', async () => {
    const now = Date.now();
    const highDuration = 20_000_000; // well above FT_SEARCH_HEALTHY_P50_THRESHOLD_US
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeSlowLogEntry({
        timestamp: Math.floor(now / 1000) - i * 5,
        duration: highDuration,
        command: ['FT.SEARCH', 'idx_cache', '*'],
      }),
    );
    const registry = buildRegistry();
    const storage = buildStorage({ slowLogEntries: entries });
    const svc = await buildModule(registry, storage, buildPrometheus());

    const profile = await svc.getProfile('conn-1', { windowMs: 300_000 });

    const ftBucket = profile.buckets.find(b => b.bucket.startsWith('FT.SEARCH:'));
    expect(ftBucket?.unhealthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getTrend
// ---------------------------------------------------------------------------

describe('InferenceLatencyService.getTrend', () => {
  const startTime = 1_700_000_000_000;
  const endTime   = 1_700_003_600_000; // 1 hour window

  it('returns empty points array when no matching entries', async () => {
    const registry = buildRegistry();
    const storage = buildStorage();
    const svc = await buildModule(registry, storage, buildPrometheus());

    const trend = await svc.getTrend('conn-1', 'read', startTime, endTime);

    expect(trend.connectionId).toBe('conn-1');
    expect(trend.bucket).toBe('read');
    expect(trend.points).toHaveLength(0);
  });

  it('throws InferenceLatencyValidationError when endTime <= startTime', async () => {
    const svc = await buildModule(buildRegistry(), buildStorage(), buildPrometheus());

    await expect(
      svc.getTrend('conn-1', 'read', 2000, 1000),
    ).rejects.toBeInstanceOf(InferenceLatencyValidationError);
  });

  it('throws InferenceLatencyValidationError when bin count exceeds cap', async () => {
    const svc = await buildModule(buildRegistry(), buildStorage(), buildPrometheus());
    // 1-day window / 1ms bucket = 86.4M bins > 1440 cap
    await expect(
      svc.getTrend('conn-1', 'read', startTime, startTime + 86_400_000, 1),
    ).rejects.toBeInstanceOf(InferenceLatencyValidationError);
  });

  it('throws InferenceLatencyValidationError for non-positive bucketMs', async () => {
    const svc = await buildModule(buildRegistry(), buildStorage(), buildPrometheus());

    await expect(
      svc.getTrend('conn-1', 'read', startTime, endTime, 0),
    ).rejects.toBeInstanceOf(InferenceLatencyValidationError);
  });

  it('buckets entries into the correct time bins and computes percentiles', async () => {
    const midpoint = startTime + (endTime - startTime) / 2;
    const entries = [
      makeSlowLogEntry({ timestamp: Math.floor(midpoint / 1000), duration: 10_000, command: ['GET', 'k'] }),
      makeSlowLogEntry({ timestamp: Math.floor(midpoint / 1000) + 1, duration: 20_000, command: ['GET', 'k'] }),
    ];
    const registry = buildRegistry();
    const storage = buildStorage({ slowLogEntries: entries });
    const svc = await buildModule(registry, storage, buildPrometheus());

    const trend = await svc.getTrend('conn-1', 'read', startTime, endTime, 60_000);

    expect(trend.points.length).toBeGreaterThan(0);
    const point = trend.points[0];
    expect(point.count).toBe(2);
    expect(point.p50).toBeGreaterThan(0);
  });

  it('filters out entries that do not match the requested bucket', async () => {
    const mid = Math.floor((startTime + endTime) / 2 / 1000);
    const storage = buildStorage({
      slowLogEntries: [
        makeSlowLogEntry({ timestamp: mid, duration: 5_000, command: ['GET', 'k'] }),
        makeSlowLogEntry({ timestamp: mid, duration: 5_000, command: ['SET', 'k', 'v'] }),
      ],
    });
    const svc = await buildModule(buildRegistry(), storage, buildPrometheus());

    const trend = await svc.getTrend('conn-1', 'write', startTime, endTime, 60_000);
    const totalCount = trend.points.reduce((sum, p) => sum + p.count, 0);

    expect(totalCount).toBe(1); // only the SET entry
  });

  it('uses commandlog source when the connection supports it', async () => {
    const registry = buildRegistry({ hasCommandLog: true });
    const storage = buildStorage();
    const svc = await buildModule(registry, storage, buildPrometheus());

    const trend = await svc.getTrend('conn-1', 'read', startTime, endTime);

    expect(storage.getCommandLogEntries).toHaveBeenCalled();
    expect(storage.getSlowLogEntries).not.toHaveBeenCalled();
    expect(trend.source).toBe('commandlog');
  });
});
