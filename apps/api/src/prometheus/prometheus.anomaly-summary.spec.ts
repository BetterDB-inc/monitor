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

async function gaugeValues(
  service: PrometheusService,
  name: string,
  label: string,
): Promise<Record<string, number>> {
  const metric = service['registry'].getSingleMetric(name);
  const { values } = await metric!.get();
  return Object.fromEntries(
    values
      .filter((v) => v.labels.connection === CONNECTION_LABEL)
      .map((v) => [String(v.labels[label]), v.value]),
  );
}

describe('PrometheusService updateAnomalySummary', () => {
  const emptySummary = {
    bySeverity: {},
    byMetric: {},
    byPattern: {},
    groupsBySeverity: {},
    unresolvedBySeverity: {},
  };

  it('sets correlated groups by severity from the summary', async () => {
    const service = buildService();

    service.updateAnomalySummary(
      { ...emptySummary, groupsBySeverity: { warning: 2, critical: 1 } },
      CONNECTION_ID,
    );

    expect(
      await gaugeValues(service, 'betterdb_correlated_groups_by_severity', 'severity'),
    ).toEqual({ info: 0, warning: 2, critical: 1 });
  });

  it('resets a severity to zero once its groups age out', async () => {
    const service = buildService();

    service.updateAnomalySummary(
      { ...emptySummary, groupsBySeverity: { critical: 3 } },
      CONNECTION_ID,
    );
    service.updateAnomalySummary(emptySummary, CONNECTION_ID);

    expect(
      await gaugeValues(service, 'betterdb_correlated_groups_by_severity', 'severity'),
    ).toEqual({ info: 0, warning: 0, critical: 0 });
  });
});
