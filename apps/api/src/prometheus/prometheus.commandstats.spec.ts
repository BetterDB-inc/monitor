import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

const CONNECTION_ID = 'conn-1';
const CONNECTION_LABEL = '10.0.0.1:6379';

function buildService(): PrometheusService {
  const registry = {
    getConfig: jest.fn().mockReturnValue({ host: '10.0.0.1', port: 6379 }),
    getDefaultId: jest.fn().mockReturnValue(CONNECTION_ID),
    list: jest.fn().mockReturnValue([]),
  } as unknown as ConnectionRegistry;

  return new PrometheusService(
    {} as StoragePort,
    registry,
    { get: jest.fn().mockReturnValue(5000) } as unknown as ConfigService,
    {} as RuntimeCapabilityTracker,
    {} as SlowLogAnalyticsService,
    {} as CommandLogAnalyticsService,
    {} as HealthService,
  );
}

async function gaugeByCommand(service: PrometheusService, name: string): Promise<Record<string, number>> {
  const metric = service['registry'].getSingleMetric(name);
  const { values } = await metric!.get();
  return Object.fromEntries(
    values
      .filter((v) => v.labels.connection === CONNECTION_LABEL)
      .map((v) => [String(v.labels.command), v.value]),
  );
}

describe('PrometheusService updateCommandstatsMetrics', () => {
  it('writes calls and latency for a fully reported command', async () => {
    const service = buildService();

    service.updateCommandstatsMetrics(CONNECTION_ID, [{ command: 'get', callsTotal: 10, usecPerCall: 2.5 }]);

    expect(await gaugeByCommand(service, 'betterdb_commandstats_calls_total')).toEqual({ get: 10 });
    expect(await gaugeByCommand(service, 'betterdb_commandstats_latency_us')).toEqual({ get: 2.5 });
  });

  it('writes no latency gauge for a command without a reported duration', async () => {
    const service = buildService();

    service.updateCommandstatsMetrics(CONNECTION_ID, [{ command: 'get', callsTotal: 10 }]);

    expect(await gaugeByCommand(service, 'betterdb_commandstats_calls_total')).toEqual({ get: 10 });
    expect(await gaugeByCommand(service, 'betterdb_commandstats_latency_us')).toEqual({});
  });

  it('drops a previously published latency once the duration stops being reported', async () => {
    const service = buildService();

    service.updateCommandstatsMetrics(CONNECTION_ID, [{ command: 'get', callsTotal: 10, usecPerCall: 2.5 }]);
    service.updateCommandstatsMetrics(CONNECTION_ID, [{ command: 'get', callsTotal: 12 }]);

    expect(await gaugeByCommand(service, 'betterdb_commandstats_calls_total')).toEqual({ get: 12 });
    expect(await gaugeByCommand(service, 'betterdb_commandstats_latency_us')).toEqual({});
  });
});
