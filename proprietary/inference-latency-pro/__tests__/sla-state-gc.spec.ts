/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test } from '@nestjs/testing';
import { PrometheusService } from '@app/prometheus/prometheus.service';
import { SettingsService } from '@app/settings/settings.service';
import type { InferenceLatencyBucket } from '@betterdb/shared';
import { InferenceLatencyProService } from '../inference-latency-pro.service';

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

describe('InferenceLatencyProService SLA state GC', () => {
  async function build(config: Record<string, { p99ThresholdUs: number; enabled: boolean }>) {
    const prometheus = {
      updateInferenceSlaBreachMetrics: jest.fn(),
    };
    const settings = {
      getCachedSettings: jest.fn().mockReturnValue({ inferenceSlaConfig: config }),
    };
    const module = await Test.createTestingModule({
      providers: [
        InferenceLatencyProService,
        { provide: PrometheusService, useValue: prometheus },
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();
    return { service: module.get(InferenceLatencyProService), settings, prometheus };
  }

  function ctx(connectionId = 'conn-1') {
    return { connectionId, host: 'localhost', port: 6379 };
  }

  function internalState(service: InferenceLatencyProService): Map<string, unknown> {
    return (service as any).slaState as Map<string, unknown>;
  }

  function runEvaluate(
    service: InferenceLatencyProService,
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
    return service.onProfileTick(ctx(connectionId), profile);
  }

  it('clears state for an index that was configured then disabled', async () => {
    const { service, settings } = await build({
      idx_a: { p99ThresholdUs: 5_000, enabled: true },
    });

    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    expect(internalState(service).has('conn-1|idx_a')).toBe(true);

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
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    prometheus.updateInferenceSlaBreachMetrics.mockClear();
    await runEvaluate(service, 'conn-1', []);
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
    await runEvaluate(service, 'conn-1', [bucket({ p99: 9_000 })]);
    expect(internalState(service).has('conn-1|idx_a')).toBe(true);

    await runEvaluate(service, 'conn-1', []);
    expect(internalState(service).has('conn-1|idx_a')).toBe(true);
  });
});
