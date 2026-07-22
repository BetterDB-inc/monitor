import { InferenceLatencyProService } from '../inference-latency-pro.service';
import type { InferenceLatencyProfile } from '@betterdb/shared';
import type { PrometheusService } from '@app/prometheus/prometheus.service';
import type { SettingsService } from '@app/settings/settings.service';
import type { LicenseService } from '@proprietary/licenses';

describe('InferenceLatencyProService.getSlaStatus', () => {
  const prometheus = { updateInferenceSlaBreachMetrics: jest.fn() };
  const license = { hasFeature: jest.fn() };

  function makeService(
    slaConfig: Record<string, { p99ThresholdUs: number; enabled: boolean }>,
  ): InferenceLatencyProService {
    const settings = {
      getCachedSettings: jest.fn().mockReturnValue({ inferenceSlaConfig: slaConfig }),
    };
    return new InferenceLatencyProService(
      prometheus as unknown as PrometheusService,
      settings as unknown as SettingsService,
      undefined,
      undefined,
      license as unknown as LicenseService,
    );
  }

  function breachingProfile(): InferenceLatencyProfile {
    return {
      windowMs: 60000,
      generatedAt: 1000,
      buckets: [{ bucket: 'FT.SEARCH:products', p50: 50, p95: 150, p99: 200 }],
    } as unknown as InferenceLatencyProfile;
  }

  function recoveredProfile(): InferenceLatencyProfile {
    return {
      windowMs: 60000,
      generatedAt: 2000,
      buckets: [{ bucket: 'FT.SEARCH:products', p50: 40, p95: 45, p99: 50 }],
    } as unknown as InferenceLatencyProfile;
  }

  function makeServiceWithSettings(settingsValue: unknown): InferenceLatencyProService {
    const settings = {
      getCachedSettings: jest.fn().mockReturnValue(settingsValue),
    };
    return new InferenceLatencyProService(
      prometheus as unknown as PrometheusService,
      settings as unknown as SettingsService,
      undefined,
      undefined,
      license as unknown as LicenseService,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    license.hasFeature.mockReturnValue(true);
  });

  it('returns empty when the license lacks INFERENCE_SLA', async () => {
    license.hasFeature.mockReturnValue(false);
    const service = makeService({ products: { p99ThresholdUs: 100, enabled: true } });
    expect(service.getSlaStatus('c1')).toEqual([]);
  });

  it('reports configured index with no state as not breached', () => {
    const service = makeService({ products: { p99ThresholdUs: 100, enabled: true } });
    expect(service.getSlaStatus('c1')).toEqual([
      { indexName: 'products', thresholdUs: 100, breached: false, lastFiredAt: null },
    ]);
  });

  it('reports a live breach recorded by onProfileTick', async () => {
    const service = makeService({ products: { p99ThresholdUs: 100, enabled: true } });
    await service.onProfileTick({ connectionId: 'c1', host: 'h', port: 1 }, breachingProfile());
    const statuses = service.getSlaStatus('c1');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].breached).toBe(true);
    expect(typeof statuses[0].lastFiredAt).toBe('number');
  });

  it('scopes state to the connection', async () => {
    const service = makeService({ products: { p99ThresholdUs: 100, enabled: true } });
    await service.onProfileTick({ connectionId: 'c1', host: 'h', port: 1 }, breachingProfile());
    expect(service.getSlaStatus('c2')[0].breached).toBe(false);
  });

  it('skips disabled entries', () => {
    const service = makeService({ products: { p99ThresholdUs: 100, enabled: false } });
    expect(service.getSlaStatus('c1')).toEqual([]);
  });

  it('reports recovery after a breach resolves on a later tick', async () => {
    const service = makeService({ products: { p99ThresholdUs: 100, enabled: true } });
    await service.onProfileTick({ connectionId: 'c1', host: 'h', port: 1 }, breachingProfile());
    await service.onProfileTick({ connectionId: 'c1', host: 'h', port: 1 }, recoveredProfile());
    const statuses = service.getSlaStatus('c1');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].breached).toBe(false);
    expect(typeof statuses[0].lastFiredAt).toBe('number');
  });

  it('returns no statuses when the cached settings have no inferenceSlaConfig', () => {
    const service = makeServiceWithSettings({});
    expect(service.getSlaStatus('c1')).toEqual([]);
  });
});
