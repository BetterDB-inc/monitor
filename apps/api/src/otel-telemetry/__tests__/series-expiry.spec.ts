import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  DataPointType,
  InstrumentType,
  type MetricData,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  SeriesExpiringExporter,
  SeriesLastSeen,
  dropExpiredSeries,
  seriesBoundMs,
} from '../series-expiry';

const T: [number, number] = [1, 0];
const BOUND = 15_000;

function gaugeMetric(
  name: string,
  points: Array<Record<string, string | number | boolean>>,
): MetricData {
  return {
    descriptor: { name, description: '', unit: '', valueType: 1 },
    aggregationTemporality: AggregationTemporality.CUMULATIVE,
    dataPointType: DataPointType.GAUGE,
    dataPoints: points.map((attributes) => ({ startTime: T, endTime: T, value: 1, attributes })),
  } as MetricData;
}

function input(metrics: MetricData[]): ResourceMetrics {
  return {
    resource: resourceFromAttributes({ 'service.name': 'betterdb-monitor' }),
    scopeMetrics: [{ scope: { name: 'betterdb' }, metrics }],
  };
}

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('seriesBoundMs', () => {
  it('uses the Prometheus staleness bound when it spans at least two export intervals', () => {
    expect(seriesBoundMs(15_000, 5_000)).toBe(15_000);
  });

  it('keeps a series for two export intervals when the interval is longer', () => {
    expect(seriesBoundMs(15_000, 60_000)).toBe(120_000);
  });
});

describe('SeriesLastSeen', () => {
  it('treats a series never observed as expired', () => {
    expect(new SeriesLastSeen(BOUND).isFresh('m', { connection: 'a' })).toBe(false);
  });

  it('keeps a series fresh up to the bound and expires it after', () => {
    const time = clock();
    const lastSeen = new SeriesLastSeen(BOUND, time.now);
    lastSeen.observe('m', { connection: 'a' });

    time.advance(BOUND);
    expect(lastSeen.isFresh('m', { connection: 'a' })).toBe(true);
    time.advance(1);
    expect(lastSeen.isFresh('m', { connection: 'a' })).toBe(false);
  });

  it('matches attributes regardless of key order', () => {
    const lastSeen = new SeriesLastSeen(BOUND);
    lastSeen.observe('m', { connection: 'a', role: 'primary' });

    expect(lastSeen.isFresh('m', { role: 'primary', connection: 'a' })).toBe(true);
    expect(lastSeen.isFresh('other', { role: 'primary', connection: 'a' })).toBe(false);
  });

  it('always keeps the SDK overflow series', () => {
    expect(new SeriesLastSeen(BOUND).isFresh('m', { 'otel.metric.overflow': true })).toBe(true);
  });

  it('forgets expired series on prune and tracks them again once re-observed', () => {
    const time = clock();
    const lastSeen = new SeriesLastSeen(BOUND, time.now);
    lastSeen.observe('m', { connection: 'a' });
    time.advance(BOUND + 1);
    lastSeen.prune();
    expect(lastSeen.isFresh('m', { connection: 'a' })).toBe(false);

    lastSeen.observe('m', { connection: 'a' });
    expect(lastSeen.isFresh('m', { connection: 'a' })).toBe(true);
  });
});

describe('dropExpiredSeries', () => {
  it('drops expired points and the metrics and scopes they leave empty', () => {
    const lastSeen = new SeriesLastSeen(BOUND);
    lastSeen.observe('kept', { connection: 'a' });

    const result = dropExpiredSeries(
      input([
        gaugeMetric('kept', [{ connection: 'a' }, { connection: 'b' }]),
        gaugeMetric('gone', [{ connection: 'a' }]),
      ]),
      lastSeen,
    );

    expect(result.scopeMetrics).toHaveLength(1);
    expect(result.scopeMetrics[0].metrics.map((metric) => metric.descriptor.name)).toEqual([
      'kept',
    ]);
    expect(result.scopeMetrics[0].metrics[0].dataPoints.map((p) => p.attributes)).toEqual([
      { connection: 'a' },
    ]);
    expect(dropExpiredSeries(input([gaugeMetric('gone', [{}])]), lastSeen).scopeMetrics).toEqual(
      [],
    );
  });
});

describe('SeriesExpiringExporter', () => {
  function fakeInner(): PushMetricExporter & { exported: ResourceMetrics[] } {
    const exported: ResourceMetrics[] = [];
    return {
      exported,
      export: jest.fn((metrics: ResourceMetrics, callback: (result: ExportResult) => void) => {
        exported.push(metrics);
        callback({ code: ExportResultCode.SUCCESS });
      }),
      forceFlush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      selectAggregationTemporality: jest.fn().mockReturnValue(AggregationTemporality.CUMULATIVE),
    };
  }

  function exportOnce(
    exporter: SeriesExpiringExporter,
    metrics: ResourceMetrics,
  ): Promise<ExportResult> {
    return new Promise((resolve) => exporter.export(metrics, resolve));
  }

  it('passes only fresh series to the inner exporter', async () => {
    const inner = fakeInner();
    const lastSeen = new SeriesLastSeen(BOUND);
    lastSeen.observe('m', { connection: 'a' });
    const exporter = new SeriesExpiringExporter(inner, lastSeen);

    await expect(
      exportOnce(exporter, input([gaugeMetric('m', [{ connection: 'a' }, { connection: 'b' }])])),
    ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
    expect(inner.exported[0].scopeMetrics[0].metrics[0].dataPoints).toHaveLength(1);
  });

  it('reports success without calling the inner exporter when every series expired', async () => {
    const inner = fakeInner();
    const exporter = new SeriesExpiringExporter(inner, new SeriesLastSeen(BOUND));

    await expect(
      exportOnce(exporter, input([gaugeMetric('m', [{ connection: 'a' }])])),
    ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
    expect(inner.export).not.toHaveBeenCalled();
  });

  it('delegates flush, shutdown and temporality selection', async () => {
    const inner = fakeInner();
    const exporter = new SeriesExpiringExporter(inner, new SeriesLastSeen(BOUND));

    await exporter.forceFlush();
    await exporter.shutdown();

    expect(inner.forceFlush).toHaveBeenCalled();
    expect(inner.shutdown).toHaveBeenCalled();
    expect(exporter.selectAggregationTemporality?.(InstrumentType.COUNTER)).toBe(
      AggregationTemporality.CUMULATIVE,
    );
  });
});
