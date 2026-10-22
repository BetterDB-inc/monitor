import { addCounters, BASELINE_IDLE_MS, CounterDeltaTracker, labelSeries, METRIC_FIELDS, type CounterObservation } from '../counter-deltas';

const obs = (o: Partial<CounterObservation>): CounterObservation => ({
  engineId: 'e1',
  connectionId: 'c1',
  modelName: 'm',
  series: '0|worker',
  metric: 'num_hit_tokens',
  value: 0,
  cumulative: true,
  ...o,
});

describe('CounterDeltaTracker', () => {
  it('uses the first point as a baseline and sums growth', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 100 }), 1_000);
    t.observe(obs({ value: 150 }), 2_000);
    t.observe(obs({ value: 175 }), 3_000);
    const [bucket] = t.drain(60_000);
    expect(bucket).toMatchObject({ engineId: 'e1', connectionId: 'c1', modelName: 'm', timestamp: 0, hitTokens: 75, requestedTokens: 0 });
  });

  it('treats a lower value as a reset', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 100 }), 1_000);
    t.observe(obs({ value: 30 }), 2_000);
    expect(t.drain(60_000)[0].hitTokens).toBe(30);
  });

  it('ignores an out-of-order point from the same series start', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 100, startMs: 5 }), 1_000);
    t.observe(obs({ value: 150, startMs: 5 }), 2_000);
    t.observe(obs({ value: 120, startMs: 5 }), 3_000);
    t.observe(obs({ value: 160, startMs: 5 }), 4_000);
    expect(t.drain(60_000)[0].hitTokens).toBe(60);
  });

  it('takes the first point after a start-time change as a new baseline', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 100, startMs: 5 }), 1_000);
    t.observe(obs({ value: 140, startMs: 9 }), 2_000);
    t.observe(obs({ value: 150, startMs: 9 }), 3_000);
    expect(t.drain(60_000)[0].hitTokens).toBe(10);
  });

  it('does not count lifetime totals when a collector restart moves the start time', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 5_000_000, startMs: 5 }), 1_000);
    t.observe(obs({ value: 5_000_100, startMs: 5 }), 2_000);
    t.observe(obs({ value: 5_000_400, startMs: 30 }), 3_000);
    t.observe(obs({ value: 5_000_500, startMs: 30 }), 4_000);
    expect(t.drain(60_000)[0].hitTokens).toBe(200);
  });

  it('ignores a late point from an older series start', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 1000, startMs: 1 }), 1_000);
    t.observe(obs({ value: 50, startMs: 2 }), 2_000);
    expect(t.drain(200_000, true)).toEqual([]);
    t.observe(obs({ value: 1000, startMs: 1 }), 3_000);
    expect(t.drain(200_000, true)).toEqual([]);
    t.observe(obs({ value: 70, startMs: 2 }), 4_000);
    expect(t.drain(200_000, true)[0].hitTokens).toBe(20);
  });

  it('keeps the newest start when a point arrives without one', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 100, startMs: 9 }), 1_000);
    t.observe(obs({ value: 120 }), 2_000);
    t.observe(obs({ value: 500, startMs: 5 }), 3_000);
    t.observe(obs({ value: 130, startMs: 9 }), 4_000);
    expect(t.drain(200_000, true)[0].hitTokens).toBe(30);
  });

  it('does not flap between interleaved series that share a key', () => {
    const t = new CounterDeltaTracker();
    for (let i = 0; i < 4; i += 1) {
      t.observe(obs({ value: 1000 + i * 10, startMs: 1 }), 1_000 + i);
      t.observe(obs({ value: 2000 + i * 10, startMs: 2 }), 1_000 + i);
    }
    expect(t.drain(200_000, true)[0].hitTokens).toBe(30);
  });

  it('sums workers into one bucket per engine and model', () => {
    const t = new CounterDeltaTracker();
    for (const series of ['0|worker', '1|worker']) {
      t.observe(obs({ series, value: 0 }), 1_000);
      t.observe(obs({ series, value: 10 }), 2_000);
    }
    const buckets = t.drain(60_000);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].hitTokens).toBe(20);
  });

  it('adds delta-temporality points directly', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 40, cumulative: false, metric: 'num_requested_tokens' }), 1_000);
    t.observe(obs({ value: 60, cumulative: false, metric: 'num_requested_tokens' }), 2_000);
    expect(t.drain(60_000)[0].requestedTokens).toBe(100);
  });

  it('keeps the open minute until it closes', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 1 }), 61_000);
    t.observe(obs({ value: 2 }), 62_000);
    expect(t.drain(90_000)).toEqual([]);
    expect(t.drain(120_000)).toHaveLength(1);
    expect(t.drain(120_000)).toEqual([]);
  });

  it('splits buckets by minute and rejects unknown metrics', () => {
    const t = new CounterDeltaTracker();
    expect(t.observe(obs({ metric: 'lookup_hit_rate' }), 1)).toBe(false);
    t.observe(obs({ value: 0 }), 1_000);
    t.observe(obs({ value: 5 }), 59_000);
    t.observe(obs({ value: 9 }), 61_000);
    expect(t.drain(200_000).map((b) => [b.timestamp, b.hitTokens])).toEqual([[0, 5], [60_000, 4]]);
  });

  it('rejects inherited metric names', () => {
    const t = new CounterDeltaTracker();
    expect(t.observe(obs({ metric: 'constructor', value: 1 }), 1_000)).toBe(false);
    expect(t.observe(obs({ metric: 'toString', value: 2, cumulative: false }), 2_000)).toBe(false);
    expect(t.drain(200_000, true)).toEqual([]);
  });

  it('rejects non-finite values without disturbing the next delta', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 100 }), 1_000);
    expect(t.observe(obs({ value: NaN }), 2_000)).toBe(false);
    t.observe(obs({ value: 150 }), 3_000);
    expect(t.drain(60_000)[0].hitTokens).toBe(50);
  });

  it('drops baselines of series that have gone idle', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ series: 'old-worker', value: 100 }), 1_000);
    t.observe(obs({ series: 'live', value: 10 }), 1_000);
    t.observe(obs({ series: 'live', value: 20 }), BASELINE_IDLE_MS);
    t.drain(BASELINE_IDLE_MS + 2_000);
    expect(t.baselineCount()).toBe(1);
    t.observe(obs({ series: 'old-worker', value: 500 }), BASELINE_IDLE_MS + 3_000);
    t.observe(obs({ series: 'live', value: 25 }), BASELINE_IDLE_MS + 3_000);
    expect(t.drain(10 * BASELINE_IDLE_MS, true).reduce((sum, b) => sum + b.hitTokens, 0)).toBe(15);
  });

  it('forgets an engine', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 0 }), 1_000);
    t.observe(obs({ value: 5 }), 2_000);
    t.forgetEngine('e1');
    expect(t.drain(200_000, true)).toEqual([]);
    t.observe(obs({ value: 50 }), 3_000);
    expect(t.drain(200_000, true)).toEqual([]);
  });

  it('forgets baselines but keeps pending buckets', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 0 }), 1_000);
    t.observe(obs({ value: 5 }), 2_000);
    t.forgetBaselines('e1');
    t.observe(obs({ value: 500 }), 3_000);
    t.observe(obs({ value: 510 }), 4_000);
    expect(t.drain(200_000, true)[0].hitTokens).toBe(15);
  });

  it('folds a late observation for an already drained minute into the open minute', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 100 }), 50_000);
    t.observe(obs({ value: 150 }), 55_000);
    expect(t.drain(61_000)).toEqual([expect.objectContaining({ timestamp: 0, hitTokens: 50 })]);
    t.observe(obs({ value: 170 }), 59_000);
    expect(t.drain(61_000)).toEqual([]);
    expect(t.drain(125_000)).toEqual([expect.objectContaining({ timestamp: 60_000, hitTokens: 20 })]);
  });

  it('never recreates a minute that was drained with the open bucket', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 100 }), 10_000);
    t.observe(obs({ value: 110 }), 20_000);
    expect(t.drain(30_000, true)).toEqual([expect.objectContaining({ timestamp: 0, hitTokens: 10 })]);
    t.observe(obs({ value: 115 }), 40_000);
    expect(t.drain(200_000, true)).toEqual([expect.objectContaining({ timestamp: 60_000, hitTokens: 5 })]);
  });
});

describe('labelSeries', () => {
  it('keeps the worker and role key when there are no other labels', () => {
    expect(labelSeries({ model_name: 'm', worker_id: '0', role: 'worker' })).toBe('0|worker');
    expect(labelSeries({})).toBe('|');
  });

  it('separates series that differ only by other labels, in a stable order', () => {
    const a = labelSeries({ model_name: 'm', worker_id: '0', served_model_name: 'a', zone: 'z' });
    const b = labelSeries({ zone: 'z', served_model_name: 'a', worker_id: '0', model_name: 'm' });
    const c = labelSeries({ model_name: 'm', worker_id: '0', served_model_name: 'b', zone: 'z' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe('0||[["served_model_name","a"],["zone","z"]]');
  });
});

describe('addCounters', () => {
  it('adds every mapped counter field into the target', () => {
    const fields = Object.values(METRIC_FIELDS);
    const target = Object.fromEntries(fields.map((field) => [field, 1])) as Record<string, number>;
    const source = Object.fromEntries(fields.map((field) => [field, 2])) as Record<string, number>;
    addCounters(target as any, source as any);
    for (const field of fields) expect(target[field]).toBe(3);
  });
});
