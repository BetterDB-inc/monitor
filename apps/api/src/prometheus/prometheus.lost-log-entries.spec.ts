import type { Gauge } from 'prom-client';
import type { PrometheusService } from './prometheus.service';
import { buildPrometheus } from '../otel-telemetry/__tests__/prometheus-harness';

const METRIC = 'betterdb_log_capture_lost_entries_total';
const FIRST = { id: 'conn-1', label: '10.0.0.1:6379' };
const SECOND = { id: 'conn-2', label: '10.0.0.2:6380' };

type LostByConnection = Record<string, Record<string, number>>;

describe('PrometheusService lost log entries', () => {
  let service: PrometheusService;
  let slowLost: LostByConnection;
  let commandLost: LostByConnection;
  let hasCommandLog: boolean;

  beforeEach(() => {
    slowLost = {};
    commandLost = {};
    hasCommandLog = true;
    ({ service } = buildPrometheus());
    const lostOf = (source: () => LostByConnection) => (connectionId: string) =>
      new Map(Object.entries(source()[connectionId] ?? {}));
    Object.assign(service['slowLogAnalytics'], {
      getCachedAnalysis: () => null,
      getLostEntries: lostOf(() => slowLost),
    });
    Object.assign(service['commandLogAnalytics'], {
      hasCommandLogSupport: () => hasCommandLog,
      getCachedAnalysis: () => null,
      getLostEntries: lostOf(() => commandLost),
    });
  });

  afterEach(() => {
    service['stop']();
  });

  async function refresh(connectionId: string): Promise<void> {
    await service['runUpdateMetricsForConnection'](connectionId);
    await service['updateStorageBasedMetricsForConnection'](connectionId);
  }

  async function value(connection: string, log: string): Promise<number | null> {
    const gauge = service['registry'].getSingleMetric(METRIC) as Gauge | undefined;
    if (!gauge) {
      return null;
    }
    const match = (await gauge.get()).values.find(
      (sample) => sample.labels.connection === connection && sample.labels.log === log,
    );
    return match ? match.value : null;
  }

  it('exports the entries each log lost, per connection', async () => {
    slowLost[FIRST.id] = { slowlog: 72 };
    commandLost[FIRST.id] = {
      'commandlog-slow': 0,
      'commandlog-large-request': 5,
      'commandlog-large-reply': 9,
    };
    slowLost[SECOND.id] = { slowlog: 0 };

    await refresh(FIRST.id);
    await refresh(SECOND.id);

    expect(await value(FIRST.label, 'slowlog')).toBe(72);
    expect(await value(FIRST.label, 'commandlog-slow')).toBe(0);
    expect(await value(FIRST.label, 'commandlog-large-request')).toBe(5);
    expect(await value(FIRST.label, 'commandlog-large-reply')).toBe(9);
    expect(await value(SECOND.label, 'slowlog')).toBe(0);
    expect(await service.getMetrics()).toContain(
      `${METRIC}{connection="${FIRST.label}",log="slowlog"} 72`,
    );
  });

  it('follows the count as it grows', async () => {
    slowLost[FIRST.id] = { slowlog: 72 };
    await refresh(FIRST.id);

    slowLost[FIRST.id] = { slowlog: 144 };
    await refresh(FIRST.id);

    expect(await value(FIRST.label, 'slowlog')).toBe(144);
  });

  it('exports no series for a log that has not been polled', async () => {
    slowLost[FIRST.id] = { slowlog: 0 };

    await refresh(FIRST.id);

    expect(await value(FIRST.label, 'commandlog-slow')).toBeNull();
  });

  it('exports no command log series without COMMANDLOG support', async () => {
    hasCommandLog = false;
    commandLost[FIRST.id] = { 'commandlog-slow': 3 };

    await refresh(FIRST.id);

    expect(await value(FIRST.label, 'commandlog-slow')).toBeNull();
  });

  it('removes the series of a connection that goes away', async () => {
    slowLost[FIRST.id] = { slowlog: 72 };
    commandLost[FIRST.id] = { 'commandlog-large-reply': 9 };
    slowLost[SECOND.id] = { slowlog: 4 };
    await refresh(FIRST.id);
    await refresh(SECOND.id);

    service.cleanupConnectionMetrics(FIRST.id);
    await new Promise((resolve) => setImmediate(resolve));

    expect(await value(FIRST.label, 'slowlog')).toBeNull();
    expect(await value(FIRST.label, 'commandlog-large-reply')).toBeNull();
    expect(await value(SECOND.label, 'slowlog')).toBe(4);
  });
});
