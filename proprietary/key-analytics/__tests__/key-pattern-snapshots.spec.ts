import type { KeyPatternData } from '@betterdb/shared';
import { buildPatternSnapshots } from '../key-pattern-snapshots';

const DAY = 86400;

function pattern(over: Partial<KeyPatternData> = {}): KeyPatternData {
  return {
    pattern: 'session:*',
    count: 4,
    totalMemory: 400,
    maxMemory: 100,
    totalCardinality: 0,
    maxCardinality: 0,
    totalIdleTime: 0,
    withTtl: 0,
    withoutTtl: 4,
    ttlValues: [],
    accessFrequencies: [],
    ...over,
  };
}

describe('buildPatternSnapshots stale key count', () => {
  it('counts only the sampled keys idle beyond a day, not an estimate from the average idle time', () => {
    const idleTimes = [10, 20, 30, 10 * DAY];
    const [snapshot] = buildPatternSnapshots(
      {
        dbSize: 4,
        scanned: 4,
        patterns: [pattern({ totalIdleTime: idleTimes.reduce((a, b) => a + b, 0), staleCount: 1 })],
      },
      1,
    );

    expect(snapshot.avgIdleTimeSeconds).toBeGreaterThan(DAY);
    expect(snapshot.staleKeyCount).toBe(1);
  });

  it('scales the sampled stale count to the estimated pattern total like the key count', () => {
    const [snapshot] = buildPatternSnapshots(
      { dbSize: 400, scanned: 4, patterns: [pattern({ totalIdleTime: 3 * DAY, staleCount: 1 })] },
      1,
    );

    expect(snapshot.keyCount).toBe(400);
    expect(snapshot.sampledKeyCount).toBe(4);
    expect(snapshot.staleKeyCount).toBe(100);
  });

  it('reports zero stale keys when the collector found none', () => {
    const [snapshot] = buildPatternSnapshots(
      { dbSize: 4, scanned: 4, patterns: [pattern({ totalIdleTime: 40, staleCount: 0 })] },
      1,
    );

    expect(snapshot.staleKeyCount).toBe(0);
  });

  it('leaves the stale count unknown for an older agent payload without per-key stale data', () => {
    const [snapshot] = buildPatternSnapshots(
      { dbSize: 4, scanned: 4, patterns: [pattern({ totalIdleTime: 40 * DAY })] },
      1,
    );

    expect(snapshot.avgIdleTimeSeconds).toBe(10 * DAY);
    expect(snapshot.staleKeyCount).toBeUndefined();
  });

  it('keeps hot and cold keys as counts within the sample', () => {
    const [snapshot] = buildPatternSnapshots(
      { dbSize: 400, scanned: 4, patterns: [pattern({ accessFrequencies: [0, 1, 10, 13], staleCount: 0 })] },
      1,
    );

    expect(snapshot.hotKeyCount).toBe(2);
    expect(snapshot.coldKeyCount).toBe(2);
  });
});
