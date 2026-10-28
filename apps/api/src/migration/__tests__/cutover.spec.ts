import { forcedCutoverNotice, parseCutoverTimeout } from '../execution/cutover';

describe('cutover helpers', () => {
  it('lists every shard in the forced notice', () => {
    expect(
      forcedCutoverNotice(
        [
          { shard: 'src-0', diff: 0, stale: false },
          { shard: 'src-1', diff: 4096, stale: false },
          { shard: 'src-2', diff: null, stale: false },
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
