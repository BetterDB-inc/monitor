import {
  describeErrorstatDeltas,
  errorRepliesPerPoll,
  readErrorstatCounts,
  topErrorstatDeltas,
} from '../error-replies';

describe('error replies helpers', () => {
  describe('readErrorstatCounts', () => {
    it('strips the errorstat_ prefix and keeps parsed counts', () => {
      const counts = readErrorstatCounts({
        errorstat_ERR: { count: 12 },
        errorstat_WRONGTYPE: { count: 3 },
      });
      expect(counts).toEqual(
        new Map([
          ['ERR', 12],
          ['WRONGTYPE', 3],
        ]),
      );
    });

    it('skips raw string entries the parser could not read', () => {
      const counts = readErrorstatCounts({
        errorstat_ERR: { count: 4 },
        errorstat_BROKEN: 'garbage',
      });
      expect(counts).toEqual(new Map([['ERR', 4]]));
    });

    it('returns an empty map when the section is missing', () => {
      expect(readErrorstatCounts(undefined).size).toBe(0);
    });
  });

  describe('topErrorstatDeltas', () => {
    it('returns nothing on the first poll', () => {
      expect(topErrorstatDeltas(undefined, new Map([['ERR', 50]]))).toEqual([]);
    });

    it('ranks prefixes by growth since the previous poll', () => {
      const previous = new Map([
        ['ERR', 10],
        ['TIMEOUT', 0],
        ['BUSY', 5],
        ['WRONGTYPE', 1],
      ]);
      const current = new Map([
        ['ERR', 22],
        ['TIMEOUT', 30],
        ['BUSY', 6],
        ['WRONGTYPE', 1],
      ]);
      expect(topErrorstatDeltas(previous, current)).toEqual([
        { prefix: 'TIMEOUT', delta: 30 },
        { prefix: 'ERR', delta: 12 },
        { prefix: 'BUSY', delta: 1 },
      ]);
    });

    it('counts a prefix that first appears since the previous poll in full', () => {
      const previous = new Map([['ERR', 10]]);
      const current = new Map([
        ['ERR', 10],
        ['OOM', 7],
      ]);
      expect(topErrorstatDeltas(previous, current)).toEqual([{ prefix: 'OOM', delta: 7 }]);
    });

    it('ignores counters that went down after a restart', () => {
      const previous = new Map([['ERR', 100]]);
      const current = new Map([['ERR', 4]]);
      expect(topErrorstatDeltas(previous, current)).toEqual([]);
    });

    it('breaks ties alphabetically and honours the limit', () => {
      const previous = new Map<string, number>();
      const current = new Map([
        ['C', 5],
        ['A', 5],
        ['B', 5],
      ]);
      expect(topErrorstatDeltas(previous, current, 2)).toEqual([
        { prefix: 'A', delta: 5 },
        { prefix: 'B', delta: 5 },
      ]);
    });
  });

  describe('describeErrorstatDeltas', () => {
    it('formats the breakdown', () => {
      expect(
        describeErrorstatDeltas([
          { prefix: 'TIMEOUT', delta: 30 },
          { prefix: 'ERR', delta: 12 },
        ]),
      ).toBe('top error types: TIMEOUT +30, ERR +12');
    });

    it('returns null when there is nothing to report', () => {
      expect(describeErrorstatDeltas([])).toBeNull();
    });
  });

  describe('errorRepliesPerPoll', () => {
    it('keeps the delta when a poll arrives on time or a little late', () => {
      expect(errorRepliesPerPoll(900, 1000, 1000)).toBe(900);
      expect(errorRepliesPerPoll(900, 1400, 1000)).toBe(900);
    });

    it('spreads the delta over a short gap', () => {
      expect(errorRepliesPerPoll(450, 3000, 1000)).toBe(150);
    });

    it('spreads the delta over the polls a gap covered', () => {
      expect(errorRepliesPerPoll(6000, 6000, 1000)).toBe(1000);
    });
  });
});
