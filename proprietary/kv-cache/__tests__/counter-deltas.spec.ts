import { CounterDeltaTracker, type CounterObservation } from '../counter-deltas';

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

  it('counts the whole value when the series restarts above the old baseline', () => {
    const t = new CounterDeltaTracker();
    t.observe(obs({ value: 100, startMs: 5 }), 1_000);
    t.observe(obs({ value: 140, startMs: 9 }), 2_000);
    t.observe(obs({ value: 150, startMs: 9 }), 3_000);
    expect(t.drain(60_000)[0].hitTokens).toBe(150);
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
});
