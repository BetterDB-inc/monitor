import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

function buildService(env: Record<string, unknown> = {}): PrometheusService {
  const registry = {
    getConfig: jest.fn().mockReturnValue(null),
    get: jest.fn().mockReturnValue(null),
    list: jest.fn().mockReturnValue([]),
    getName: jest.fn().mockReturnValue('primary'),
  } as unknown as ConnectionRegistry;
  const values: Record<string, unknown> = { PROMETHEUS_POLL_INTERVAL_MS: 5000, ...env };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  } as unknown as ConfigService;
  const tracker = {
    isAvailable: jest.fn().mockReturnValue(true),
    recordFailure: jest.fn(),
  } as unknown as RuntimeCapabilityTracker;

  const service = new PrometheusService(
    {} as StoragePort,
    registry,
    config,
    tracker,
    {} as SlowLogAnalyticsService,
    {} as CommandLogAnalyticsService,
    {} as HealthService,
  );
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  return service;
}

describe('PrometheusService OTLP ingest counters', () => {
  let service: PrometheusService;

  beforeEach(() => {
    service = buildService();
  });

  async function registryText(): Promise<string> {
    return service.getMetrics();
  }

  async function profileText(profile: 'full' | 'vitals'): Promise<string> {
    const scoped = buildService({ METRICS_EXPORT_PROFILE: profile });
    scoped.recordOtlpIngest(1, {});
    return scoped.getMetrics();
  }

  it('counts accepted and dropped OTLP points by reason', async () => {
    service.recordOtlpIngest(5, { unknown_instance: 2, unmapped_metric: 1 });
    service.recordOtlpIngest(1, {});
    const text = await registryText();
    expect(text).toContain('betterdb_otlp_metric_points_accepted_total 6');
    expect(text).toContain('betterdb_otlp_metric_points_dropped_total{reason="unknown_instance"} 2');
    expect(text).toContain('betterdb_otlp_metric_points_dropped_total{reason="unmapped_metric"} 1');
  });

  it('exports the OTLP counters in the full profile only', async () => {
    expect(await profileText('full')).toContain('betterdb_otlp_metric_points_accepted_total');
    expect(await profileText('vitals')).not.toContain('betterdb_otlp_metric_points_accepted_total');
  });
});
