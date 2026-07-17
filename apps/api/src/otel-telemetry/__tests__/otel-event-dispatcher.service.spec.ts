import { ConfigService } from '@nestjs/config';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { OtelEventDispatcherService } from '../otel-event-dispatcher.service';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, def?: T): T | undefined => (key in values ? (values[key] as T) : def),
  } as unknown as ConfigService;
}

/**
 * Boots the service with a stubbed OTel logger so tests can assert on the log
 * record actually emitted, rather than only that dispatch stays quiet.
 */
function initWithEmitSpy(): { service: OtelEventDispatcherService; emit: jest.Mock } {
  const emit = jest.fn();
  jest
    .spyOn(LoggerProvider.prototype, 'getLogger')
    .mockReturnValue({ emit } as unknown as ReturnType<LoggerProvider['getLogger']>);
  jest.spyOn(LoggerProvider.prototype, 'shutdown').mockResolvedValue(undefined);

  const service = new OtelEventDispatcherService(
    makeConfig({
      OTEL_TELEMETRY_ENABLED: true,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    }),
  );
  service.onModuleInit();
  return { service, emit };
}

describe('OtelEventDispatcherService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  it('emits an INFO record carrying the event name, connection and payload', async () => {
    const { service, emit } = initWithEmitSpy();

    service.dispatch(
      'inference.sla.breach',
      { index: 'idx', threshold_ms: 250, breached: true },
      'c1',
    );

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'inference.sla.breach',
      attributes: {
        'event.name': 'inference.sla.breach',
        connection_id: 'c1',
        index: 'idx',
        threshold_ms: 250,
        breached: true,
      },
    });
    await service.onModuleDestroy();
  });

  it('omits connection_id and non-primitive payload values from attributes', async () => {
    const { service, emit } = initWithEmitSpy();

    service.dispatch('cluster.failover', {
      state: 'fail',
      details: { nested: 'dropped' },
      missing: undefined,
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'cluster.failover',
        attributes: { 'event.name': 'cluster.failover', state: 'fail' },
      }),
    );
    await service.onModuleDestroy();
  });
});
