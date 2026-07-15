import { ConfigService } from '@nestjs/config';
import { OtelEventDispatcherService } from '../otel-event-dispatcher.service';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, def?: T): T | undefined => (key in values ? (values[key] as T) : def),
  } as unknown as ConfigService;
}

describe('OtelEventDispatcherService', () => {
  it('no-ops dispatch when no OTLP endpoint is configured', () => {
    const service = new OtelEventDispatcherService(makeConfig({ OTEL_TELEMETRY_ENABLED: true }));
    service.onModuleInit();
    expect(() =>
      service.dispatch('anomaly.detected', { severity: 'critical' }, 'c1'),
    ).not.toThrow();
  });

  it('no-ops when explicitly disabled even with an endpoint', () => {
    const service = new OtelEventDispatcherService(
      makeConfig({
        OTEL_TELEMETRY_ENABLED: 'false',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    service.onModuleInit();
    expect(() => service.dispatch('cluster.failover', {})).not.toThrow();
  });

  it('emits a log record and shuts down cleanly when enabled', async () => {
    const service = new OtelEventDispatcherService(
      makeConfig({
        OTEL_TELEMETRY_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    service.onModuleInit();
    expect(() =>
      service.dispatch('inference.sla.breach', { index: 'idx', breached: true }, 'c1'),
    ).not.toThrow();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
