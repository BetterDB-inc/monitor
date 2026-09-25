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
  NodeSplittingExporter,
  buildNodeResolver,
  splitByConnection,
  type NodeResolver,
} from '../node-splitting-exporter';

const T: [number, number] = [1, 0];

function gaugeMetric(name: string, points: Array<[number, Record<string, string>]>): MetricData {
  return {
    descriptor: { name, description: `${name} help`, unit: 'By', valueType: 1 },
    aggregationTemporality: AggregationTemporality.CUMULATIVE,
    dataPointType: DataPointType.GAUGE,
    dataPoints: points.map(([value, attributes]) => ({
      startTime: T,
      endTime: T,
      value,
      attributes,
    })),
  } as MetricData;
}

function input(metrics: MetricData[]): ResourceMetrics {
  return {
    resource: resourceFromAttributes({ 'service.name': 'betterdb-monitor' }),
    scopeMetrics: [{ scope: { name: 'betterdb-semconv' }, metrics }],
  };
}

const resolver: NodeResolver = buildNodeResolver([
  {
    id: 'a',
    name: 'a',
    host: '10.0.0.1',
    port: 6379,
    isConnected: true,
    capabilities: { dbType: 'valkey', version: '8.1.0' },
  },
  { id: 'b', name: 'b', host: 'cache-b', port: 6380, isConnected: false },
]);

describe('buildNodeResolver', () => {
  it('resolves a host:port label to its connection', () => {
    expect(resolver('10.0.0.1:6379')).toEqual({
      host: '10.0.0.1',
      port: 6379,
      dbType: 'valkey',
      version: '8.1.0',
    });
    expect(resolver('cache-b:6380')).toEqual({ host: 'cache-b', port: 6380 });
    expect(resolver('conn-x')).toBeNull();
  });
});

describe('splitByConnection', () => {
  it('emits one resource per node with the node attributes and strips connection', () => {
    const parts = splitByConnection(
      input([
        gaugeMetric('valkey.memory.used', [
          [1000, { connection: '10.0.0.1:6379' }],
          [2000, { connection: 'cache-b:6380' }],
        ]),
      ]),
      resolver,
    );

    expect(parts.map((part) => part.resource.attributes)).toEqual([
      {
        'service.name': 'valkey',
        'service.instance.id': '10.0.0.1:6379',
        'db.system.name': 'valkey',
        'server.address': '10.0.0.1',
        'server.port': 6379,
        'valkey.version': '8.1.0',
      },
      {
        'service.name': 'valkey',
        'service.instance.id': 'cache-b:6380',
        'server.address': 'cache-b',
        'server.port': 6380,
      },
    ]);
    const first = parts[0].scopeMetrics[0];
    expect(first.scope).toEqual({ name: 'betterdb-semconv' });
    expect(first.metrics[0].descriptor.name).toBe('valkey.memory.used');
    expect(first.metrics[0].dataPoints).toEqual([
      { startTime: T, endTime: T, value: 1000, attributes: {} },
    ]);
  });

  it('keeps unmatched and connection-less points on the monitor resource', () => {
    const rm = input([
      gaugeMetric('valkey.memory.used', [[5, { connection: 'conn-x' }]]),
      gaugeMetric('betterdb_process_resident_memory_bytes', [[7, {}]]),
    ]);
    const parts = splitByConnection(rm, resolver);

    expect(parts).toHaveLength(1);
    expect(parts[0].resource).toBe(rm.resource);
    expect(parts[0].scopeMetrics[0].metrics.map((m) => m.dataPoints[0].attributes)).toEqual([
      { connection: 'conn-x' },
      {},
    ]);
  });

  it('does not emit a resource that received no points', () => {
    expect(splitByConnection(input([gaugeMetric('valkey.memory.used', [])]), resolver)).toEqual(
      [],
    );
  });

  it('only includes a metric in the resources that have its points', () => {
    const parts = splitByConnection(
      input([
        gaugeMetric('valkey.memory.used', [[1, { connection: '10.0.0.1:6379' }]]),
        gaugeMetric('valkey.memory.rss', [[2, { connection: 'cache-b:6380' }]]),
      ]),
      resolver,
    );
    expect(parts.map((part) => part.scopeMetrics[0].metrics.map((m) => m.descriptor.name))).toEqual(
      [['valkey.memory.used'], ['valkey.memory.rss']],
    );
  });
});

describe('NodeSplittingExporter', () => {
  function fakeInner(results: ExportResult[] = []): PushMetricExporter & {
    exported: ResourceMetrics[];
  } {
    const exported: ResourceMetrics[] = [];
    return {
      exported,
      export: jest.fn((metrics: ResourceMetrics, callback: (result: ExportResult) => void) => {
        exported.push(metrics);
        callback(results[exported.length - 1] ?? { code: ExportResultCode.SUCCESS });
      }),
      forceFlush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      selectAggregationTemporality: jest.fn().mockReturnValue(AggregationTemporality.CUMULATIVE),
    };
  }

  function exportOnce(exporter: NodeSplittingExporter, rm: ResourceMetrics): Promise<ExportResult> {
    return new Promise((resolve) => exporter.export(rm, resolve));
  }

  const twoNodes = input([
    gaugeMetric('valkey.memory.used', [
      [1, { connection: '10.0.0.1:6379' }],
      [2, { connection: 'cache-b:6380' }],
    ]),
  ]);

  it('sends one export per resource and reports success', async () => {
    const inner = fakeInner();
    const exporter = new NodeSplittingExporter(inner, () => resolver);

    await expect(exportOnce(exporter, twoNodes)).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(inner.exported).toHaveLength(2);
  });

  it('reports success without calling the inner exporter when nothing splits out', async () => {
    const inner = fakeInner();
    const exporter = new NodeSplittingExporter(inner, () => resolver);

    await expect(exportOnce(exporter, input([]))).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(inner.export).not.toHaveBeenCalled();
  });

  it('exports every node even when one fails, and reports the first failure', async () => {
    const error = new Error('collector down');
    const inner = fakeInner([{ code: ExportResultCode.FAILED, error }]);
    const exporter = new NodeSplittingExporter(inner, () => resolver);

    await expect(exportOnce(exporter, twoNodes)).resolves.toEqual({
      code: ExportResultCode.FAILED,
      error,
    });
    expect(inner.exported).toHaveLength(2);
  });

  it('turns a throwing inner export into a failure', async () => {
    const inner = fakeInner();
    const error = new Error('boom');
    (inner.export as jest.Mock).mockImplementation(() => {
      throw error;
    });
    const exporter = new NodeSplittingExporter(inner, () => resolver);

    await expect(exportOnce(exporter, twoNodes)).resolves.toEqual({
      code: ExportResultCode.FAILED,
      error,
    });
  });

  it('builds a fresh resolver for each export', async () => {
    const createResolver = jest.fn(() => resolver);
    const exporter = new NodeSplittingExporter(fakeInner(), createResolver);

    await exportOnce(exporter, twoNodes);
    await exportOnce(exporter, twoNodes);

    expect(createResolver).toHaveBeenCalledTimes(2);
  });

  it('delegates flush, shutdown and temporality selection', async () => {
    const inner = fakeInner();
    const exporter = new NodeSplittingExporter(inner, () => resolver);

    await exporter.forceFlush();
    await exporter.shutdown();

    expect(inner.forceFlush).toHaveBeenCalled();
    expect(inner.shutdown).toHaveBeenCalled();
    expect(exporter.selectAggregationTemporality?.(InstrumentType.COUNTER)).toBe(
      AggregationTemporality.CUMULATIVE,
    );
  });
});
