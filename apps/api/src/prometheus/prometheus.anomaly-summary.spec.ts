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

function buildService(unlisted: ReadonlySet<string> = new Set()): PrometheusService {
  const configs: Record<string, { host: string; port: number }> = {
    [CONNECTION_ID]: { host: '10.0.0.1', port: 6379 },
    [OTHER_CONNECTION_ID]: { host: '10.0.0.2', port: 6379 },
    [SAME_HOST_CONNECTION_ID]: { host: '10.0.0.1', port: 6379 },
  };
  const registry = {
    // Mirrors ConnectionRegistry.getConfig: an empty id resolves to the default.
    getConfig: jest.fn((id?: string) => configs[id || CONNECTION_ID] ?? null),
    // A retired member keeps its config but is no longer listed.
    isListed: jest.fn((id: string) => id in configs && !unlisted.has(id)),
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

  it('sums every count of connections that share a host:port', async () => {
    const service = buildService();

    publish(service, [
      [CONNECTION_ID, busySummary],
      [
        SAME_HOST_CONNECTION_ID,
        {
          bySeverity: { critical: 1, warning: 2 },
          byMetric: { memory_used: 1, connections: 2 },
          byPattern: { memory_pressure: 1, connection_leak: 1 },
          groupsBySeverity: { critical: 1, warning: 1 },
          unresolvedBySeverity: { warning: 2 },
        },
      ],
    ]);

    expect(await gaugeValues(service, 'betterdb_anomaly_by_severity', 'severity')).toEqual({
      info: 0,
      warning: 2,
      critical: 2,
    });
    expect(await gaugeValues(service, 'betterdb_anomaly_by_metric', 'metric_type')).toEqual({
      memory_used: 2,
      connections: 2,
    });
    expect(await gaugeValues(service, 'betterdb_correlated_groups_by_pattern', 'pattern')).toEqual({
      memory_pressure: 2,
      connection_leak: 1,
    });
    expect(
      await gaugeValues(service, 'betterdb_correlated_groups_by_severity', 'severity'),
    ).toEqual({ info: 0, warning: 1, critical: 2 });
    expect(await gaugeValues(service, 'betterdb_anomaly_events_current', 'severity')).toEqual({
      info: 0,
      warning: 2,
      critical: 1,
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
      const unlisted = new Set<string>();
      const service = buildService(unlisted);
      // Polled by this service, so cleanup finds the label through freshness.
      service['freshness'].observe(OTHER_CONNECTION_ID, OTHER_CONNECTION_LABEL, Date.now());
      publish(service, [
        [CONNECTION_ID, busySummary],
        [OTHER_CONNECTION_ID, busySummary],
      ]);

      // The connection is deleted: the registry stops listing it and the
      // poller calls cleanup, but the anomaly service still has its events in
      // the window and keeps passing it.
      unlisted.add(OTHER_CONNECTION_ID);
      service.cleanupConnectionMetrics(OTHER_CONNECTION_ID);
      await jest.runAllTimersAsync();
      for (const name of SUMMARY_GAUGES) {
        expect(await connectionLabels(service, name)).toEqual([CONNECTION_LABEL]);
      }

      publish(service, [
        [CONNECTION_ID, busySummary],
        [OTHER_CONNECTION_ID, busySummary],
      ]);

      for (const name of SUMMARY_GAUGES) {
        expect(await connectionLabels(service, name)).toEqual([CONNECTION_LABEL]);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes the series of a deleted connection it never polled without waiting for a summary', async () => {
    const unlisted = new Set<string>();
    const service = buildService(unlisted);
    // A Sentinel the anomaly service polls but this service does not: no
    // freshness entry and no per-connection state, only anomaly series.
    publish(service, [
      [CONNECTION_ID, busySummary],
      [OTHER_CONNECTION_ID, busySummary],
    ]);
    service.updateActiveIncidents([
      { connectionIds: [CONNECTION_ID], patterns: ['retry_storm'], status: 'active' },
      { connectionIds: [OTHER_CONNECTION_ID], patterns: ['retry_storm'], status: 'active' },
    ]);
    expect(await connectionLabels(service, 'betterdb_incident_active')).toEqual([
      CONNECTION_LABEL,
      OTHER_CONNECTION_LABEL,
    ]);

    unlisted.add(OTHER_CONNECTION_ID);
    service.cleanupConnectionMetrics(OTHER_CONNECTION_ID);

    // Synchronously: the bookkeeping no longer knows the label once cleanup
    // returns, not only after the registry has been read.
    expect(service['anomalySummaryLabels'].has(OTHER_CONNECTION_LABEL)).toBe(false);
    expect(service['incidentLabels'].has(OTHER_CONNECTION_LABEL)).toBe(false);
    for (const name of [...SUMMARY_GAUGES, 'betterdb_incident_active']) {
      expect(await connectionLabels(service, name)).toEqual([CONNECTION_LABEL]);
    }
  });

  it('keeps shared series when one of the connections under a host:port is deleted', async () => {
    const unlisted = new Set<string>();
    const service = buildService(unlisted);
    publish(service, [
      [CONNECTION_ID, busySummary],
      [SAME_HOST_CONNECTION_ID, busySummary],
    ]);
    service.updateActiveIncidents([
      {
        connectionIds: [CONNECTION_ID, SAME_HOST_CONNECTION_ID],
        patterns: ['retry_storm'],
        status: 'active',
      },
    ]);

    unlisted.add(SAME_HOST_CONNECTION_ID);
    service.cleanupConnectionMetrics(SAME_HOST_CONNECTION_ID);

    expect(service['anomalySummaryLabels'].has(CONNECTION_LABEL)).toBe(true);
    expect(service['incidentLabels'].has(CONNECTION_LABEL)).toBe(true);
    for (const name of [...SUMMARY_GAUGES, 'betterdb_incident_active']) {
      expect(await connectionLabels(service, name)).toEqual([CONNECTION_LABEL]);
    }
    expect(await gaugeValues(service, 'betterdb_anomaly_by_severity', 'severity')).toEqual({
      info: 0,
      warning: 0,
      critical: 2,
    });
  });

  it('keeps shared series when the label is released by a polled connection the survivor shares', async () => {
    jest.useFakeTimers();
    try {
      const unlisted = new Set<string>();
      const service = buildService(unlisted);
      // Only the deleted connection is polled by this service; the survivor on
      // the same host:port has anomaly series but no freshness entry.
      service['freshness'].observe(SAME_HOST_CONNECTION_ID, CONNECTION_LABEL, Date.now());
      publish(service, [
        [CONNECTION_ID, busySummary],
        [SAME_HOST_CONNECTION_ID, busySummary],
      ]);
      service.updateActiveIncidents([
        { connectionIds: [CONNECTION_ID], patterns: ['retry_storm'], status: 'active' },
      ]);

      unlisted.add(SAME_HOST_CONNECTION_ID);
      service.cleanupConnectionMetrics(SAME_HOST_CONNECTION_ID);
      await jest.runAllTimersAsync();

      for (const name of [...SUMMARY_GAUGES, 'betterdb_incident_active']) {
        expect(await connectionLabels(service, name)).toEqual([CONNECTION_LABEL]);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a connection deleted between polls when deciding whether a label is still shared', async () => {
    const unlisted = new Set<string>();
    const service = buildService(unlisted);
    // conn-1 raises an anomaly and is deleted before this service's next poll
    // lists it, so cleanupConnectionMetrics never runs for it and its label
    // stays recorded.
    service.incrementAnomalyEvent('critical', 'memory_used', 'spike', CONNECTION_ID);
    unlisted.add(CONNECTION_ID);

    // Later a connection to the same host:port, never polled by this service,
    // gets summary and incident series under that label.
    publish(service, [
      [OTHER_CONNECTION_ID, busySummary],
      [SAME_HOST_CONNECTION_ID, busySummary],
    ]);
    service.updateActiveIncidents([
      { connectionIds: [OTHER_CONNECTION_ID], patterns: ['retry_storm'], status: 'active' },
      { connectionIds: [SAME_HOST_CONNECTION_ID], patterns: ['retry_storm'], status: 'active' },
    ]);
    for (const name of [...SUMMARY_GAUGES, 'betterdb_incident_active']) {
      expect(await connectionLabels(service, name)).toContain(CONNECTION_LABEL);
    }

    unlisted.add(SAME_HOST_CONNECTION_ID);
    service.cleanupConnectionMetrics(SAME_HOST_CONNECTION_ID);

    expect(service['anomalySummaryLabels'].has(CONNECTION_LABEL)).toBe(false);
    expect(service['incidentLabels'].has(CONNECTION_LABEL)).toBe(false);
    expect(service['anomalyLabels'].has(CONNECTION_ID)).toBe(false);
    for (const name of [...SUMMARY_GAUGES, 'betterdb_incident_active']) {
      expect(await connectionLabels(service, name)).toEqual([OTHER_CONNECTION_LABEL]);
    }
  });

  it('removes the anomaly counters of a deleted connection', async () => {
    const unlisted = new Set<string>();
    const service = buildService(unlisted);
    for (const connectionId of [CONNECTION_ID, OTHER_CONNECTION_ID]) {
      service.incrementAnomalyEvent('critical', 'memory_used', 'spike', connectionId);
      service.incrementCorrelatedGroup('memory_pressure', 'critical', connectionId);
    }

    unlisted.add(OTHER_CONNECTION_ID);
    service.cleanupConnectionMetrics(OTHER_CONNECTION_ID);

    for (const name of ['betterdb_anomaly_events_total', 'betterdb_correlated_groups_total']) {
      expect(await connectionLabels(service, name)).toEqual([CONNECTION_LABEL]);
    }
  });

  it('keeps shared anomaly counters when one of the connections under a host:port is deleted', async () => {
    const unlisted = new Set<string>();
    const service = buildService(unlisted);
    service.incrementAnomalyEvent('critical', 'memory_used', 'spike', CONNECTION_ID);
    service.incrementCorrelatedGroup('memory_pressure', 'critical', SAME_HOST_CONNECTION_ID);

    unlisted.add(SAME_HOST_CONNECTION_ID);
    service.cleanupConnectionMetrics(SAME_HOST_CONNECTION_ID);

    for (const name of ['betterdb_anomaly_events_total', 'betterdb_correlated_groups_total']) {
      expect(await connectionLabels(service, name)).toEqual([CONNECTION_LABEL]);
    }
  });

  it('never publishes a retired connection that still has a config', async () => {
    const service = buildService(new Set([OTHER_CONNECTION_ID]));

    publish(service, [
      [CONNECTION_ID, busySummary],
      [OTHER_CONNECTION_ID, busySummary],
    ]);
    service.incrementAnomalyEvent('critical', 'memory_used', 'spike', OTHER_CONNECTION_ID);
    service.incrementCorrelatedGroup('memory_pressure', 'critical', OTHER_CONNECTION_ID);

    expect(await service.getMetrics()).not.toContain(`connection="${OTHER_CONNECTION_LABEL}"`);
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

describe('PrometheusService updateAnomalyBufferStats', () => {
  const buffer = (metricType: string) => ({ metricType, mean: 1, stdDev: 0, ready: true });

  async function bufferSeries(service: PrometheusService): Promise<string[]> {
    const series: string[] = [];
    for (const name of [
      'betterdb_anomaly_buffer_ready',
      'betterdb_anomaly_buffer_mean',
      'betterdb_anomaly_buffer_stddev',
    ]) {
      const { values } = await service['registry'].getSingleMetric(name)!.get();
      series.push(...values.map((v) => `${name}:${v.labels.connection}:${v.labels.metric_type}`));
    }
    return series.sort();
  }

  it('moves the series when the connection changes', async () => {
    const service = buildService();

    service.updateAnomalyBufferStats([buffer('memory_used')], CONNECTION_ID);
    service.updateAnomalyBufferStats([buffer('memory_used')], OTHER_CONNECTION_ID);

    expect(await bufferSeries(service)).toEqual([
      `betterdb_anomaly_buffer_mean:${OTHER_CONNECTION_LABEL}:memory_used`,
      `betterdb_anomaly_buffer_ready:${OTHER_CONNECTION_LABEL}:memory_used`,
      `betterdb_anomaly_buffer_stddev:${OTHER_CONNECTION_LABEL}:memory_used`,
    ]);
  });

  it('removes a metric type that is no longer reported', async () => {
    const service = buildService();

    service.updateAnomalyBufferStats([buffer('memory_used'), buffer('connections')], CONNECTION_ID);
    service.updateAnomalyBufferStats([buffer('connections')], CONNECTION_ID);

    expect(await bufferSeries(service)).toEqual([
      `betterdb_anomaly_buffer_mean:${CONNECTION_LABEL}:connections`,
      `betterdb_anomaly_buffer_ready:${CONNECTION_LABEL}:connections`,
      `betterdb_anomaly_buffer_stddev:${CONNECTION_LABEL}:connections`,
    ]);
  });

  it('removes every series for a null or connection-less id instead of using the default', async () => {
    const service = buildService();

    service.updateAnomalyBufferStats([buffer('memory_used')], CONNECTION_ID);
    service.updateAnomalyBufferStats([buffer('memory_used')], '');
    expect(await bufferSeries(service)).toEqual([]);

    service.updateAnomalyBufferStats([buffer('memory_used')], CONNECTION_ID);
    service.updateAnomalyBufferStats([], null);
    expect(await bufferSeries(service)).toEqual([]);
  });
});
