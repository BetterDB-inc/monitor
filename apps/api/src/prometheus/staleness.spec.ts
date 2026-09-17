import {
  FreshnessTracker,
  POLL_STALE_METRIC,
  resolveStalenessMs,
  selectSeriesToRemove,
  SeriesSnapshot,
} from './staleness';

describe('resolveStalenessMs', () => {
  it('defaults to three poll intervals', () => {
    expect(resolveStalenessMs(5000)).toBe(15000);
  });

  it('uses a positive configured bound', () => {
    expect(resolveStalenessMs(5000, 60000)).toBe(60000);
  });

  it('ignores a non-positive configured bound', () => {
    expect(resolveStalenessMs(5000, 0)).toBe(15000);
  });
});

describe('FreshnessTracker', () => {
  const BOUND = 15000;

  it('treats an unknown connection as not stale', () => {
    const tracker = new FreshnessTracker(BOUND);
    expect(tracker.isStale('conn-1', 1_000_000)).toBe(false);
  });

  it('starts the clock at first observation, not at first success', () => {
    const tracker = new FreshnessTracker(BOUND);
    tracker.observe('conn-1', 'h:1', 0);
    expect(tracker.isStale('conn-1', BOUND)).toBe(false);
    expect(tracker.isStale('conn-1', BOUND + 1)).toBe(true);
  });

  it('does not reset the clock on repeated observation', () => {
    const tracker = new FreshnessTracker(BOUND);
    tracker.observe('conn-1', 'h:1', 0);
    tracker.observe('conn-1', 'h:1', 10_000);
    expect(tracker.isStale('conn-1', BOUND + 1)).toBe(true);
  });

  it('resets the clock on success', () => {
    const tracker = new FreshnessTracker(BOUND);
    tracker.observe('conn-1', 'h:1', 0);
    tracker.markFresh('conn-1', 'h:1', 10_000);
    expect(tracker.isStale('conn-1', BOUND + 1)).toBe(false);
  });

  it('keeps a label fresh while any connection sharing it is fresh', () => {
    const tracker = new FreshnessTracker(BOUND);
    tracker.markFresh('conn-1', 'h:1', 0);
    tracker.markFresh('conn-2', 'h:1', 10_000);
    tracker.markFresh('conn-3', 'h:3', 0);
    const { stale, fresh } = tracker.labelsByFreshness(BOUND + 1);
    expect([...stale]).toEqual(['h:3']);
    expect([...fresh]).toEqual(['h:1']);
  });

  it('forgets a connection and reports its label', () => {
    const tracker = new FreshnessTracker(BOUND);
    tracker.markFresh('conn-1', 'h:1', 0);
    expect(tracker.forget('conn-1')).toBe('h:1');
    expect(tracker.hasLabel('h:1')).toBe(false);
    expect(tracker.forget('conn-1')).toBeUndefined();
  });
});

describe('selectSeriesToRemove', () => {
  const metrics: SeriesSnapshot[] = [
    {
      name: 'betterdb_memory_used_bytes',
      type: 'gauge',
      values: [{ labels: { connection: 'h:1' } }, { labels: { connection: 'h:2' } }],
    },
    {
      name: 'betterdb_db_keys',
      type: 'gauge',
      values: [{ labels: { connection: 'h:1', db: 'db0' } }],
    },
    {
      name: 'betterdb_polls_total',
      type: 'counter',
      values: [{ labels: { connection: 'h:1' } }],
    },
    {
      name: POLL_STALE_METRIC,
      type: 'gauge',
      values: [{ labels: { connection: 'h:1' } }],
    },
    {
      name: 'betterdb_process_heap_bytes',
      type: 'gauge',
      values: [{ labels: {} }],
    },
  ];

  it('selects gauge series for the given labels only', () => {
    expect(selectSeriesToRemove(metrics, new Set(['h:1']), new Set([POLL_STALE_METRIC]))).toEqual([
      { name: 'betterdb_memory_used_bytes', labels: { connection: 'h:1' } },
      { name: 'betterdb_db_keys', labels: { connection: 'h:1', db: 'db0' } },
    ]);
  });

  it('includes the stale indicator when not excluded', () => {
    const refs = selectSeriesToRemove(metrics, new Set(['h:1']), new Set());
    expect(refs.map((r) => r.name)).toContain(POLL_STALE_METRIC);
  });

  it('selects nothing for an empty label set', () => {
    expect(selectSeriesToRemove(metrics, new Set(), new Set())).toEqual([]);
  });
});
