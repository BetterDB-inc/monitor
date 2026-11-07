import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import type { AnomalySummaryCounts } from './prometheus.service';

const CONNECTION_ID = 'conn-1';
const CONNECTION_LABEL = '10.0.0.1:6379';
const OTHER_CONNECTION_ID = 'conn-2';
const OTHER_CONNECTION_LABEL = '10.0.0.2:6379';
// A second connection to the first connection's host:port (another db index).
const SAME_HOST_CONNECTION_ID = 'conn-3';

const SUMMARY_GAUGES = [
  'betterdb_anomaly_events_current',
  'betterdb_anomaly_by_severity',
  'betterdb_anomaly_by_metric',
  'betterdb_correlated_groups_by_severity',
  'betterdb_correlated_groups_by_pattern',
];

function buildService(): PrometheusService {
  const configs: Record<string, { host: string; port: number }> = {
    [CONNECTION_ID]: { host: '10.0.0.1', port: 6379 },
    [OTHER_CONNECTION_ID]: { host: '10.0.0.2', port: 6379 },
    [SAME_HOST_CONNECTION_ID]: { host: '10.0.0.1', port: 6379 },
  };
  const registry = {
    // Mirrors ConnectionRegistry.getConfig: an empty id resolves to the default.
    getConfig: jest.fn((id?: string) => configs[id || CONNECTION_ID] ?? null),
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
  connectionLabel = CONNECTION_LABEL,
): Promise<Record<string, number>> {
  const metric = service['registry'].getSingleMetric(name);
  const { values } = await metric!.get();
  return Object.fromEntries(
    values
      .filter((v) => v.labels.connection === connectionLabel)
      .map((v) => [String(v.labels[label]), v.value]),
  );
}

async function connectionLabels(service: PrometheusService, name: string): Promise<string[]> {
  const { values } = await service['registry'].getSingleMetric(name)!.get();
  return [...new Set(values.map((v) => String(v.labels.connection)))];
}

describe('PrometheusService updateAnomalySummaries', () => {
  const emptySummary: AnomalySummaryCounts = {
    bySeverity: {},
    byMetric: {},
    byPattern: {},
    groupsBySeverity: {},
    unresolvedBySeverity: {},
  };
  const busySummary: AnomalySummaryCounts = {
    bySeverity: { critical: 1 },
    byMetric: { memory_used: 1 },
    byPattern: { memory_pressure: 1 },
    groupsBySeverity: { critical: 1 },
    unresolvedBySeverity: { critical: 1 },
  };
  const publish = (service: PrometheusService, entries: Array<[string, AnomalySummaryCounts]>): void =>
    service.updateAnomalySummaries(new Map(entries));

  it('sets correlated groups by severity from the summary', async () => {
    const service = buildService();

    publish(service, [
      [CONNECTION_ID, { ...emptySummary, groupsBySeverity: { warning: 2, critical: 1 } }],
    ]);

    expect(
      await gaugeValues(service, 'betterdb_correlated_groups_by_severity', 'severity'),
    ).toEqual({ info: 0, warning: 2, critical: 1 });
  });

  it('resets a severity to zero once its groups age out', async () => {
    const service = buildService();

    publish(service, [[CONNECTION_ID, { ...emptySummary, groupsBySeverity: { critical: 3 } }]]);
    publish(service, [[CONNECTION_ID, emptySummary]]);

    expect(
      await gaugeValues(service, 'betterdb_correlated_groups_by_severity', 'severity'),
    ).toEqual({ info: 0, warning: 0, critical: 0 });
  });

  it('publishes nine zero severity series and nothing else for an empty summary', async () => {
    const service = buildService();

    publish(service, [[CONNECTION_ID, emptySummary]]);

    for (const name of [
      'betterdb_anomaly_events_current',
      'betterdb_anomaly_by_severity',
      'betterdb_correlated_groups_by_severity',
    ]) {
      expect(await gaugeValues(service, name, 'severity')).toEqual({
        info: 0,
        warning: 0,
        critical: 0,
      });
    }
    expect(await connectionLabels(service, 'betterdb_anomaly_by_metric')).toEqual([]);
    expect(await connectionLabels(service, 'betterdb_correlated_groups_by_pattern')).toEqual([]);
  });

  it('removes metric-type and pattern series once they age out', async () => {
    const service = buildService();

    publish(service, [[CONNECTION_ID, busySummary]]);
    publish(service, [[CONNECTION_ID, emptySummary]]);

    expect(await connectionLabels(service, 'betterdb_anomaly_by_metric')).toEqual([]);
    expect(await connectionLabels(service, 'betterdb_correlated_groups_by_pattern')).toEqual([]);
  });

  it('keeps each connection under its own label', async () => {
    const service = buildService();

    publish(service, [
      [
        CONNECTION_ID,
        {
          bySeverity: { critical: 2 },
          byMetric: { memory_used: 2 },
          byPattern: { memory_pressure: 1 },
          groupsBySeverity: { critical: 1 },
          unresolvedBySeverity: { critical: 1 },
        },
      ],
      [
        OTHER_CONNECTION_ID,
        {
          bySeverity: { warning: 3 },
          byMetric: { connections: 3 },
          byPattern: { connection_leak: 2 },
          groupsBySeverity: { warning: 2 },
          unresolvedBySeverity: { warning: 3 },
        },
      ],
    ]);

    expect(await gaugeValues(service, 'betterdb_anomaly_by_severity', 'severity')).toEqual({
      info: 0,
      warning: 0,
      critical: 2,
    });
    expect(await gaugeValues(service, 'betterdb_anomaly_by_metric', 'metric_type')).toEqual({
      memory_used: 2,
    });
    expect(
      await gaugeValues(service, 'betterdb_correlated_groups_by_pattern', 'pattern'),
    ).toEqual({ memory_pressure: 1 });
    expect(
      await gaugeValues(service, 'betterdb_anomaly_by_severity', 'severity', OTHER_CONNECTION_LABEL),
    ).toEqual({ info: 0, warning: 3, critical: 0 });
    expect(
      await gaugeValues(service, 'betterdb_anomaly_by_metric', 'metric_type', OTHER_CONNECTION_LABEL),
    ).toEqual({ connections: 3 });
    expect(
      await gaugeValues(service, 'betterdb_anomaly_events_current', 'severity', OTHER_CONNECTION_LABEL),
    ).toEqual({ info: 0, warning: 3, critical: 0 });
    expect(
      await gaugeValues(service, 'betterdb_correlated_groups_by_pattern', 'pattern', OTHER_CONNECTION_LABEL),
    ).toEqual({ connection_leak: 2 });
  });

  it('sums connections that share a host:port instead of overwriting each other', async () => {
    const service = buildService();
    const busy = { ...emptySummary, bySeverity: { critical: 2 }, byMetric: { memory_used: 2 } };

    publish(service, [
      [CONNECTION_ID, busy],
      [SAME_HOST_CONNECTION_ID, { ...emptySummary, byMetric: { connections: 1 } }],
    ]);
    publish(service, [
      [CONNECTION_ID, busy],
      [SAME_HOST_CONNECTION_ID, { ...emptySummary, bySeverity: { warning: 1 } }],
    ]);

    expect(await gaugeValues(service, 'betterdb_anomaly_by_severity', 'severity')).toEqual({
      info: 0,
      warning: 1,
      critical: 2,
    });
    expect(await gaugeValues(service, 'betterdb_anomaly_by_metric', 'metric_type')).toEqual({
      memory_used: 2,
    });
  });

  it('exports connection-less events under an empty connection label', async () => {
    const service = buildService();

    publish(service, [
      [CONNECTION_ID, { ...emptySummary, bySeverity: { critical: 1 }, byMetric: { memory_used: 1 } }],
      ['', { ...emptySummary, bySeverity: { info: 5 }, byMetric: { connections: 5 } }],
    ]);

    expect(await gaugeValues(service, 'betterdb_anomaly_by_severity', 'severity')).toEqual({
      info: 0,
      warning: 0,
      critical: 1,
    });
    expect(await gaugeValues(service, 'betterdb_anomaly_by_metric', 'metric_type')).toEqual({
      memory_used: 1,
    });
    expect(await gaugeValues(service, 'betterdb_anomaly_by_severity', 'severity', '')).toEqual({
      info: 5,
      warning: 0,
      critical: 0,
    });
    expect(await service.getMetrics()).toContain(
      'betterdb_anomaly_by_severity{connection="",severity="info"} 5',
    );
  });

  it('removes every series of a connection that is no longer published', async () => {
    const service = buildService();

    publish(service, [
      [CONNECTION_ID, busySummary],
      [OTHER_CONNECTION_ID, busySummary],
      ['', busySummary],
    ]);
    for (const name of SUMMARY_GAUGES) {
      expect(await connectionLabels(service, name)).toEqual([
        CONNECTION_LABEL,
        OTHER_CONNECTION_LABEL,
        '',
      ]);
    }

    publish(service, [[CONNECTION_ID, busySummary]]);

    for (const name of SUMMARY_GAUGES) {
      expect(await connectionLabels(service, name)).toEqual([CONNECTION_LABEL]);
    }
  });

  it('does not bring back series that connection cleanup removed', async () => {
    jest.useFakeTimers();
    try {
      const service = buildService();
      publish(service, [
        [CONNECTION_ID, busySummary],
        [OTHER_CONNECTION_ID, busySummary],
      ]);

      service.cleanupConnectionMetrics(OTHER_CONNECTION_ID);
      await jest.runAllTimersAsync();
      publish(service, [[CONNECTION_ID, busySummary]]);

      for (const name of SUMMARY_GAUGES) {
        expect(await connectionLabels(service, name)).toEqual([CONNECTION_LABEL]);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('labels connection-less counter events like the gauges', async () => {
    const service = buildService();

    service.incrementAnomalyEvent('critical', 'memory_used', 'spike');
    service.incrementCorrelatedGroup('memory_pressure', 'critical');

    const text = await service.getMetrics();
    expect(text).toContain(
      'betterdb_anomaly_events_total{connection="",severity="critical",metric_type="memory_used",anomaly_type="spike"} 1',
    );
    expect(text).toContain(
      'betterdb_correlated_groups_total{connection="",pattern="memory_pressure",severity="critical"} 1',
    );
    expect(text).not.toContain('connection="unknown"');
  });
});
