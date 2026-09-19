import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrometheusMetricsGuard } from './prometheus-metrics.guard';
import { PrometheusController } from './prometheus.controller';
import { PrometheusService } from './prometheus.service';
import { ClusterMetricsService } from '../cluster/cluster-metrics.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { OtelEventDispatcherService } from '../otel-telemetry/otel-event-dispatcher.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

function contextFor(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
  } as unknown as ExecutionContext;
}

function guardWith(values: Record<string, unknown>): PrometheusMetricsGuard {
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  return new PrometheusMetricsGuard(config);
}

describe('PrometheusMetricsGuard', () => {
  const cloudMode = process.env.CLOUD_MODE;

  afterEach(() => {
    if (cloudMode === undefined) {
      delete process.env.CLOUD_MODE;
    } else {
      process.env.CLOUD_MODE = cloudMode;
    }
  });

  it('allows an unconfigured self-hosted scrape', () => {
    delete process.env.CLOUD_MODE;
    expect(guardWith({}).canActivate(contextFor())).toBe(true);
  });

  it('returns 404 when the endpoint is disabled', () => {
    expect.assertions(2);
    try {
      guardWith({ PROMETHEUS_METRICS_ENABLED: 'false' }).canActivate(contextFor());
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    }
  });

  it('returns 401 without the configured token', () => {
    expect.assertions(1);
    try {
      guardWith({ PROMETHEUS_METRICS_TOKEN: 's3cret' }).canActivate(contextFor());
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    }
  });

  it('allows the documented scrape header', () => {
    expect(
      guardWith({ PROMETHEUS_METRICS_TOKEN: 's3cret' }).canActivate(contextFor('Bearer s3cret')),
    ).toBe(true);
  });

  it('returns 401 in cloud mode with no token configured', () => {
    process.env.CLOUD_MODE = 'true';
    expect.assertions(1);
    try {
      guardWith({}).canActivate(contextFor());
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    }
  });

  it('reads an array-valued authorization header', () => {
    const config = {
      get: jest.fn((key: string) => (key === 'PROMETHEUS_METRICS_TOKEN' ? 's3cret' : undefined)),
    } as unknown as ConfigService;
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: ['Bearer s3cret'] } }),
      }),
    } as unknown as ExecutionContext;
    expect(new PrometheusMetricsGuard(config).canActivate(context)).toBe(true);
  });

  it('binds the guard to PrometheusController', () => {
    expect(Reflect.getMetadata('__guards__', PrometheusController)).toContain(
      PrometheusMetricsGuard,
    );
  });
});

describe('OTLP mirror with the endpoint disabled', () => {
  function buildService(): PrometheusService {
    const registry = {
      getConfig: jest.fn().mockReturnValue({ host: '10.0.0.1', port: 6379 }),
      list: jest.fn().mockReturnValue([]),
      getName: jest.fn().mockReturnValue('primary'),
    } as unknown as ConnectionRegistry;

    return new PrometheusService(
      {} as StoragePort,
      registry,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'PROMETHEUS_STALENESS_MS' ? undefined : (fallback ?? 5000),
        ),
      } as unknown as ConfigService,
      {} as RuntimeCapabilityTracker,
      {} as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
      undefined,
      undefined,
      undefined,
      undefined,
      { dispatch: jest.fn() } as unknown as OtelEventDispatcherService,
      {} as ClusterMetricsService,
    );
  }

  it('rejects the route with 404 while the mirror still produces a snapshot', async () => {
    expect.assertions(3);
    try {
      guardWith({ PROMETHEUS_METRICS_ENABLED: 'false' }).canActivate(contextFor());
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    }

    const service = buildService();
    await expect(service.collectMetricsAsJson()).resolves.toEqual(expect.any(Array));
  });
});
