import {
  LARGE_REPLY_MIN_CROSSINGS,
  LargeReplyEntry,
  detectLargeReplyPressure,
  largeReplyPressureSignature,
} from '../large-reply-pressure-detector';

const THRESHOLD = 8192; // 8KB, a plausible commandlog-reply-larger-than value

/** Builds `count` LARGE-REPLY entries for `command`, each `replyBytes` in size. */
function entries(
  command: string,
  replyBytes: number,
  count: number,
  startTimestamp = 1_700_000_000,
): LargeReplyEntry[] {
  return Array.from({ length: count }, (_, i) => {
    return { command, replyBytes, timestamp: startTimestamp + i };
  });
}

describe('detectLargeReplyPressure', () => {
  it('returns no offenders for an empty entry list', () => {
    expect(detectLargeReplyPressure([], THRESHOLD)).toEqual([]);
  });

  it('returns no offenders when the threshold is negative (large-reply logging disabled)', () => {
    const hot = entries('GET', THRESHOLD * 2, 10);
    expect(detectLargeReplyPressure(hot, -1)).toEqual([]);
  });

  it('ignores entries below the threshold', () => {
    const belowThreshold = entries('GET', THRESHOLD - 1, 10);
    expect(detectLargeReplyPressure(belowThreshold, THRESHOLD)).toEqual([]);
  });

  it('does not flag a single rare large reply (below the frequency floor)', () => {
    const rare = entries('KEYS', THRESHOLD * 4, 1);
    expect(detectLargeReplyPressure(rare, THRESHOLD)).toEqual([]);
  });

  it('does not flag a command with fewer than LARGE_REPLY_MIN_CROSSINGS occurrences', () => {
    const almostHot = entries('MGET', THRESHOLD * 2, LARGE_REPLY_MIN_CROSSINGS - 1);
    expect(detectLargeReplyPressure(almostHot, THRESHOLD)).toEqual([]);
  });

  it('flags a hot command that crosses the threshold at least LARGE_REPLY_MIN_CROSSINGS times', () => {
    const hot = entries('GET', THRESHOLD * 2, LARGE_REPLY_MIN_CROSSINGS);
    const offenders = detectLargeReplyPressure(hot, THRESHOLD);

    expect(offenders).toHaveLength(1);
    expect(offenders[0].command).toBe('GET');
    expect(offenders[0].crossings).toBe(LARGE_REPLY_MIN_CROSSINGS);
    expect(offenders[0].worstBytes).toBe(THRESHOLD * 2);
    expect(offenders[0].avgBytes).toBe(THRESHOLD * 2);
    expect(offenders[0].totalBytes).toBe(THRESHOLD * 2 * LARGE_REPLY_MIN_CROSSINGS);
    expect(offenders[0].message).toContain('GET');
    expect(offenders[0].message).toContain('valkey#2926');
    expect(offenders[0].message).toContain('commandlog-reply-larger-than');
  });

  it('normalizes command casing so mixed-case entries group together', () => {
    const mixed: LargeReplyEntry[] = [
      ...entries('get', THRESHOLD * 2, 3),
      ...entries('GET', THRESHOLD * 2, 3),
    ];
    const offenders = detectLargeReplyPressure(mixed, THRESHOLD);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].command).toBe('GET');
    expect(offenders[0].crossings).toBe(6);
  });

  it('tracks worst/avg/total bytes correctly across varying reply sizes', () => {
    const varied: LargeReplyEntry[] = [
      { command: 'HGETALL', replyBytes: THRESHOLD, timestamp: 1 },
      { command: 'HGETALL', replyBytes: THRESHOLD * 3, timestamp: 2 },
      { command: 'HGETALL', replyBytes: THRESHOLD * 2, timestamp: 3 },
      { command: 'HGETALL', replyBytes: THRESHOLD, timestamp: 4 },
      { command: 'HGETALL', replyBytes: THRESHOLD * 5, timestamp: 5 },
    ];
    const offenders = detectLargeReplyPressure(varied, THRESHOLD);
    expect(offenders).toHaveLength(1);
    const [offender] = offenders;
    expect(offender.crossings).toBe(5);
    expect(offender.worstBytes).toBe(THRESHOLD * 5);
    expect(offender.totalBytes).toBe(THRESHOLD * (1 + 3 + 2 + 1 + 5));
    expect(offender.avgBytes).toBeCloseTo((THRESHOLD * (1 + 3 + 2 + 1 + 5)) / 5, 5);
    expect(offender.lastTimestamp).toBe(5);
  });

  it('ignores entries that no longer qualify under a since-raised threshold', () => {
    // Entries were logged under a lower threshold; the current (raised)
    // threshold now excludes them — no offender should be reported.
    const stale = entries('GET', THRESHOLD, LARGE_REPLY_MIN_CROSSINGS);
    const offenders = detectLargeReplyPressure(stale, THRESHOLD * 10);
    expect(offenders).toEqual([]);
  });

  it('respects a custom minCrossings override', () => {
    const entries3 = entries('SMEMBERS', THRESHOLD * 2, 3);
    expect(detectLargeReplyPressure(entries3, THRESHOLD)).toEqual([]);
    expect(detectLargeReplyPressure(entries3, THRESHOLD, { minCrossings: 3 })).toHaveLength(1);
  });

  it('reports multiple distinct hot commands, worst-first by crossing count', () => {
    const mixed: LargeReplyEntry[] = [
      ...entries('GET', THRESHOLD * 2, LARGE_REPLY_MIN_CROSSINGS),
      ...entries('MGET', THRESHOLD * 2, LARGE_REPLY_MIN_CROSSINGS + 5),
    ];
    const offenders = detectLargeReplyPressure(mixed, THRESHOLD);
    expect(offenders).toHaveLength(2);
    expect(offenders[0].command).toBe('MGET'); // more crossings, sorted first
    expect(offenders[1].command).toBe('GET');
  });

  it('does not flag a command whose replies never cross the threshold, even if very frequent', () => {
    const tame = entries('PING', 10, 1000);
    expect(detectLargeReplyPressure(tame, THRESHOLD)).toEqual([]);
  });
});

describe('largeReplyPressureSignature', () => {
  it('is stable and keyed on the command alone', () => {
    const a = detectLargeReplyPressure(entries('GET', THRESHOLD * 2, LARGE_REPLY_MIN_CROSSINGS), THRESHOLD)[0];
    const b = detectLargeReplyPressure(
      entries('GET', THRESHOLD * 9, LARGE_REPLY_MIN_CROSSINGS + 3),
      THRESHOLD,
    )[0];
    expect(largeReplyPressureSignature(a)).toBe(largeReplyPressureSignature(b));
    expect(largeReplyPressureSignature(a)).toBe('GET');
  });

  it('differs across distinct commands', () => {
    const get = detectLargeReplyPressure(entries('GET', THRESHOLD * 2, LARGE_REPLY_MIN_CROSSINGS), THRESHOLD)[0];
    const mget = detectLargeReplyPressure(entries('MGET', THRESHOLD * 2, LARGE_REPLY_MIN_CROSSINGS), THRESHOLD)[0];
    expect(largeReplyPressureSignature(get)).not.toBe(largeReplyPressureSignature(mget));
  });
});
