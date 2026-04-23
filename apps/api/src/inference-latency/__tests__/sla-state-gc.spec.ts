/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test } from '@nestjs/testing';
import { InferenceLatencyService } from '../inference-latency.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { SettingsService } from '../../settings/settings.service';
import { PrometheusService } from '../../prometheus/prometheus.service';
import type { InferenceLatencyBucket } from '@betterdb/shared';
import type { ConnectionContext } from '../../common/services/multi-connection-poller';

function bucket(overrides: Partial<InferenceLatencyBucket> = {}): InferenceLatencyBucket {
  return {
    bucket: 'FT.SEARCH:idx_a',
    p50: 1_000,
    p95: 5_000,
    p99: 9_000,
    count: 10,
    unhealthy: false,
    namedEvents: [],
    ...overrides,
  };
}

describe('InferenceLatencyService SLA state GC', () => {
  async function build(config: Record<string, { p99ThresholdUs: number; enabled: boolean }>) {
    const storage = {
      getCommandLogEntries: jest.fn().mockResolvedValue([]),
      getSlowLogEntries: jest.fn().mockResolvedValue([]),
      getVectorIndexSnapshots: jest.fn().mockResolvedValue([]),
    };
    const registry = {
      get: jest.fn().mockReturnValue({
        getCapabilities: () => ({ hasCommandLog: true }),
        getConfigValue: jest.fn().mockResolvedValue('0'),
      }),
    };
    const prometheus = {
      updateInferenceLatencyMetrics: jest.fn(),
      updateInferenceSlaBreachMetrics: jest.fn(),
    };
    const settings = {
      getCachedSettings: jest.fn().mockReturnValue({ inferenceSlaConfig: config }),
    };
    const module = await Test.createTestingModule({
      providers: [
        InferenceLatencyService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ConnectionRegistry, useValue: registry },
        { provide: PrometheusService, useValue: prometheus },
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();
    return { service: module.get(InferenceLatencyService), settings, prometheus };
  }

  function ctx(connectionId = 'conn-1'): ConnectionContext {
    return {
      connectionId,
      connectionName: 'local',
      client: {} as any,
      host: 'localhost',
      port: 6379,
    };
  }

  function internalState(service: InferenceLatencyService): Map<string, unknown> {
    return (service as any).slaState as Map<string, unknown>;
  }

  function runEvaluate(
    service: InferenceLatencyService,
    connectionId: string,
    buckets: InferenceLatencyBucket[],
  ) {
    const profile = {
      connectionId,
      windowMs: 900_000,
      source: 'commandlog' as const,
      thresholdDirective: 'commandlog-execution-slower-than',
      thresholdUs: 0,
      buckets,
      generatedAt: Date.now(),
    };
    return (service as any).evaluateSlas(ctx(connectionId), profile);
  }

  it('clears state for an index that was configured then disabled', async () => {
    const { service, settings } = await build({
      idx_a: { p99ThresholdUs: 5_000, enabled: true },
    });

    // First tick: breach, state entry created.
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    expect(internalState(service).has('conn-1|idx_a')).toBe(true);

    // User disables the SLA.
    settings.getCachedSettings.mockReturnValueOnce({
      inferenceSlaConfig: { idx_a: { p99ThresholdUs: 5_000, enabled: false } },
    });
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    expect(internalState(service).has('conn-1|idx_a')).toBe(false);
  });

  it('clears state for an index that was removed from the config', async () => {
    const { service, settings } = await build({
      idx_a: { p99ThresholdUs: 5_000, enabled: true },
    });
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    expect(internalState(service).has('conn-1|idx_a')).toBe(true);

    settings.getCachedSettings.mockReturnValueOnce({ inferenceSlaConfig: {} });
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    expect(internalState(service).has('conn-1|idx_a')).toBe(false);
  });

  it('does not touch state for indexes on other connections', async () => {
    const { service } = await build({
      idx_a: { p99ThresholdUs: 5_000, enabled: true },
    });
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    await runEvaluate(service, 'conn-2', [bucket({ p99: 9_000 })]);
    expect(internalState(service).has('conn-1|idx_a')).toBe(true);
    expect(internalState(service).has('conn-2|idx_a')).toBe(true);
  });

  it('still GCs state when config is disabled AND no traffic arrives in the tick', async () => {
    const { service, settings } = await build({
      idx_a: { p99ThresholdUs: 5_000, enabled: true },
    });
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    expect(internalState(service).has('conn-1|idx_a')).toBe(true);

    settings.getCachedSettings.mockReturnValueOnce({
      inferenceSlaConfig: { idx_a: { p99ThresholdUs: 5_000, enabled: false } },
    });
    await runEvaluate(service, 'conn-1', []);
    expect(internalState(service).has('conn-1|idx_a')).toBe(false);
  });

  it('emits a breach gauge value for configured-but-quiet indexes (carries breached state)', async () => {
    const { service, prometheus } = await build({
      idx_a: { p99ThresholdUs: 5_000, enabled: true },
    });
    // Tick 1: breach, state lands.
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    // Tick 2: no FT.SEARCH traffic.
    prometheus.updateInferenceSlaBreachMetrics.mockClear();
    await runEvaluate(service, 'conn-1', []);
    // The Prometheus call must still include idx_a with breached=true so the
    // time-series is continuous and Grafana does not see a resolve-like gap.
    expect(prometheus.updateInferenceSlaBreachMetrics).toHaveBeenCalledWith('conn-1', [
      { indexName: 'idx_a', breached: true },
    ]);
  });

  it('emits breached=false for configured indexes with no prior debounce state and no traffic', async () => {
    const { service, prometheus } = await build({
      idx_a: { p99ThresholdUs: 5_000, enabled: true },
    });
    prometheus.updateInferenceSlaBreachMetrics.mockClear();
    await runEvaluate(service, 'conn-1', []);
    expect(prometheus.updateInferenceSlaBreachMetrics).toHaveBeenCalledWith('conn-1', [
      { indexName: 'idx_a', breached: false },
    ]);
  });

  it('keeps state when a still-configured index has no FT.SEARCH traffic this tick', async () => {
    const { service } = await build({
      idx_a: { p99ThresholdUs: 5_000, enabled: true },
    });
    // Establish a breach + debounce state.
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    expect(internalState(service).has('conn-1|idx_a')).toBe(true);

    // Next tick: no FT.SEARCH traffic (bucket disappears from the profile).
    // State MUST NOT be GC'd — otherwise the next breach after traffic
    // resumes would bypass the 10-min debounce and fire a duplicate webhook.
    await runEvaluate(service, 'conn-1', []);
    expect(internalState(service).has('conn-1|idx_a')).toBe(true);
  });
});
