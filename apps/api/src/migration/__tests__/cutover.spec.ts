import {
  cutoverStableWindowMs,
  cutoverTimeoutNotice,
  forcedCutoverNotice,
  parseCutoverTimeout,
} from '../execution/cutover';

describe('cutover helpers', () => {
  it('uses a 2s floor for the stable window', () => {
    expect(cutoverStableWindowMs(1)).toBe(2000);
    expect(cutoverStableWindowMs(null)).toBe(2000);
  });

  it('scales the stable window with shard count', () => {
    expect(cutoverStableWindowMs(6)).toBe(12000);
  });

  it('builds the timeout notice', () => {
    expect(cutoverTimeoutNotice(3)).toBe(
      'Cutover timed out: lag did not stay at 0 on every shard. Make sure writes on the source are paused, then retry or force the cutover.',
    );
    expect(cutoverTimeoutNotice(null)).toMatch(
      / The number of source shards is unknown, so a normal cutover cannot confirm zero lag\.$/,
    );
  });

  it('lists every shard in the forced notice', () => {
    expect(
      forcedCutoverNotice(
        [
          { shard: 'src-0', diff: 0, updatedAt: 1 },
          { shard: 'src-1', diff: 4096, updatedAt: 1 },
          { shard: 'src-2', diff: null, updatedAt: 1 },
        ],
        4,
      ),
    ).toBe('Forced cutover with src-0 0 B behind, src-1 4 KB behind, src-2 initial sync, 1 shard(s) with no report.');
  });

  it('handles a forced cutover with no reports', () => {
    expect(forcedCutoverNotice(null, null)).toBe('Forced cutover with no lag reports.');
  });

  it('parses the cutover timeout', () => {
    expect(parseCutoverTimeout(undefined)).toBe(300);
    expect(parseCutoverTimeout(10)).toBe(10);
    expect(parseCutoverTimeout(3600)).toBe(3600);
    for (const bad of [9, 3601, 12.5, '60', null, -1]) {
      expect(parseCutoverTimeout(bad)).toBeNull();
    }
  });
});
