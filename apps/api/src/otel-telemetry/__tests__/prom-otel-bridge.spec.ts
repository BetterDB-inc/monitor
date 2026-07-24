import {
  planInstruments,
  collectDataPoints,
  deriveUnit,
  type PromMetricJson,
} from '../prom-otel-bridge';

describe('prom-otel-bridge', () => {
  const sample: PromMetricJson[] = [
    {
      name: 'betterdb_memory_used_bytes',
      help: 'Total allocated memory in bytes',
      type: 'gauge',
      values: [{ value: 100, labels: { connection: 'a:1' } }],
    },
    {
      name: 'betterdb_polls_total',
      help: 'Total number of poll cycles completed',
      type: 'counter',
      values: [{ value: 5, labels: { connection: 'a:1' } }],
    },
    {
      name: 'betterdb_poll_duration_seconds',
      help: 'Duration of poll cycles in seconds',
      type: 'histogram',
      values: [{ value: 1, labels: { connection: 'a:1', le: '0.1' } }],
    },
  ];

  describe('planInstruments', () => {
    it('maps gauges and counters and skips histograms/summaries', () => {
      expect(planInstruments(sample)).toEqual([
        {
          name: 'betterdb_memory_used_bytes',
          kind: 'gauge',
          description: 'Total allocated memory in bytes',
          unit: 'By',
        },
        {
          name: 'betterdb_polls_total',
          kind: 'counter',
          description: 'Total number of poll cycles completed',
          unit: '',
        },
      ]);
    });

    it('defaults an empty description when help is missing', () => {
      const specs = planInstruments([{ name: 'x', type: 'gauge', values: [] }]);
      expect(specs).toEqual([{ name: 'x', kind: 'gauge', description: '', unit: '' }]);
    });
  });

  describe('deriveUnit', () => {
    it('maps unambiguous prom-name suffixes to UCUM units', () => {
      expect(deriveUnit('betterdb_memory_used_bytes')).toBe('By');
      expect(deriveUnit('betterdb_poll_duration_seconds')).toBe('s');
      expect(deriveUnit('betterdb_latency_milliseconds')).toBe('ms');
      expect(deriveUnit('betterdb_fragmentation_ratio')).toBe('1');
      expect(deriveUnit('betterdb_cpu_percent')).toBe('%');
    });

    it('returns no unit for the _total counter suffix and unknown names', () => {
      expect(deriveUnit('betterdb_polls_total')).toBe('');
      expect(deriveUnit('betterdb_connected_clients')).toBe('');
      expect(deriveUnit('some_metric')).toBe('');
    });
  });

  describe('collectDataPoints', () => {
    it('extracts the value and label attributes', () => {
      expect(collectDataPoints(sample[0])).toEqual([
        { value: 100, attributes: { connection: 'a:1' } },
      ]);
    });

    it('skips NaN values, mirroring the Prometheus text filter', () => {
      const metric: PromMetricJson = {
        name: 'x',
        type: 'gauge',
        values: [
          { value: NaN, labels: {} },
          { value: 3, labels: {} },
        ],
      };
      expect(collectDataPoints(metric)).toEqual([{ value: 3, attributes: {} }]);
    });

    it('drops non-primitive label values', () => {
      const metric: PromMetricJson = {
        name: 'x',
        type: 'gauge',
        values: [{ value: 1, labels: { a: 'ok', b: undefined, c: 2 } }],
      };
      expect(collectDataPoints(metric)).toEqual([{ value: 1, attributes: { a: 'ok', c: 2 } }]);
    });
  });
});
