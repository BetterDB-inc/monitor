import type { Logger } from '@nestjs/common';
import type { LogCaptureGapAggregate } from '../../common/interfaces/log-capture-gap-repository.interface';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import { recordCaptureGap } from '../capture-gap-recorder';
import {
  classifyGapCause,
  detectCaptureGap,
  LOG_CAPTURE_AUX_TIMEOUT_MS,
  LOG_CATCH_UP_MAX_FETCH,
  mergeById,
  LOG_POLL_BATCH,
  MAX_RECOMMENDED_MAX_LEN,
  MIN_RECOMMENDED_MAX_LEN,
  planCatchUpFetch,
  recommendMaxLen,
  summarizeLogGaps,
} from '../capture-gap';

const INTERVAL = 30_000;
const NOW = 1_800_000_000_000;

/** Newest-first ids, like SLOWLOG GET / COMMANDLOG GET return them. */
function ids(from: number, to: number): Array<{ id: number }> {
  const out: Array<{ id: number }> = [];
  for (let id = to; id >= from; id--) out.push({ id });
  return out;
}

describe('planCatchUpFetch', () => {
  const base = { batchLimit: LOG_POLL_BATCH, maxFetch: LOG_CATCH_UP_MAX_FETCH };

  it('returns null without a baseline (first poll keeps today’s behaviour)', () => {
    expect(planCatchUpFetch({ ...base, lastSeenId: null, batch: ids(1, 128) })).toBeNull();
  });

  it('returns null for a short batch: the server holds nothing older', () => {
    expect(planCatchUpFetch({ ...base, lastSeenId: 10, batch: ids(500, 600) })).toBeNull();
  });

  it('returns null when nothing is new', () => {
    expect(planCatchUpFetch({ ...base, lastSeenId: 200, batch: ids(73, 200) })).toBeNull();
  });

  it('returns null when ids went backwards (server restart)', () => {
    expect(planCatchUpFetch({ ...base, lastSeenId: 5_000, batch: ids(1, 128) })).toBeNull();
  });

  it('returns null when the batch already reaches the last seen id', () => {
    expect(planCatchUpFetch({ ...base, lastSeenId: 100, batch: ids(101, 228) })).toBeNull();
    expect(planCatchUpFetch({ ...base, lastSeenId: 100, batch: ids(90, 217) })).toBeNull();
  });

  it('asks for exactly the new entries when the batch falls short of them', () => {
    // 300 new entries (101..400), batch only reached back to 273
    expect(planCatchUpFetch({ ...base, lastSeenId: 100, batch: ids(273, 400) })).toBe(300);
  });

  it('caps the catch-up read at maxFetch', () => {
    expect(planCatchUpFetch({ ...base, lastSeenId: 0, batch: ids(9_873, 10_000) })).toBe(
      LOG_CATCH_UP_MAX_FETCH,
    );
  });
});

describe('classifyGapCause', () => {
  const steady = {
    previousPollAt: NOW - INTERVAL,
    now: NOW,
    intervalMs: INTERVAL,
    requested: 300,
    received: 200,
    needed: 300,
    maxFetch: LOG_CATCH_UP_MAX_FETCH,
  };

  it('is monitor_offline when there is no previous poll in this process', () => {
    expect(classifyGapCause({ ...steady, previousPollAt: null })).toBe('monitor_offline');
  });

  it('is monitor_offline when the poll is more than 3 intervals late', () => {
    expect(classifyGapCause({ ...steady, previousPollAt: NOW - 3 * INTERVAL - 1 })).toBe(
      'monitor_offline',
    );
    expect(classifyGapCause({ ...steady, previousPollAt: NOW - 3 * INTERVAL })).toBe(
      'server_evicted',
    );
  });

  it('is fetch_limit only when we asked for and received the cap and still needed more', () => {
    expect(
      classifyGapCause({ ...steady, requested: 1024, received: 1024, needed: 5_000 }),
    ).toBe('fetch_limit');
    expect(
      classifyGapCause({ ...steady, requested: 1024, received: 700, needed: 5_000 }),
    ).toBe('server_evicted');
  });

  it('is server_evicted otherwise', () => {
    expect(classifyGapCause(steady)).toBe('server_evicted');
  });
});

describe('mergeById', () => {
  it('dedupes by id and keeps newest-first order', () => {
    expect(mergeById(ids(103, 230), ids(151, 280)).map((e) => e.id)).toEqual(
      Array.from({ length: 178 }, (_, i) => 280 - i),
    );
  });

  it('prefers the first list for a duplicated id', () => {
    const a = [{ id: 2, tag: 'a' }];
    const b = [{ id: 2, tag: 'b' }, { id: 1, tag: 'b' }];
    expect(mergeById(a, b)).toEqual([{ id: 2, tag: 'a' }, { id: 1, tag: 'b' }]);
  });
});

describe('detectCaptureGap', () => {
  const base = {
    requested: LOG_POLL_BATCH,
    received: LOG_POLL_BATCH,
    maxFetch: LOG_CATCH_UP_MAX_FETCH,
    now: NOW,
    previousPollAt: NOW - INTERVAL,
    intervalMs: INTERVAL,
  };
  const burst = {
    ...base,
    requested: LOG_CATCH_UP_MAX_FETCH,
    received: LOG_CATCH_UP_MAX_FETCH,
    lastSeenId: 0,
    entries: ids(8_977, 10_000),
  };

  it('returns nothing without a baseline or without entries', () => {
    expect(detectCaptureGap({ ...base, lastSeenId: null, entries: ids(1, 10) })).toEqual([]);
    expect(detectCaptureGap({ ...base, lastSeenId: 10, entries: [] })).toEqual([]);
  });

  it('returns nothing for a contiguous read', () => {
    expect(detectCaptureGap({ ...base, lastSeenId: 100, entries: ids(80, 150) })).toEqual([]);
    expect(detectCaptureGap({ ...base, lastSeenId: 100, entries: ids(101, 150) })).toEqual([]);
  });

  it('returns nothing when ids restarted', () => {
    expect(detectCaptureGap({ ...base, lastSeenId: 9_000, entries: ids(1, 128) })).toEqual([]);
  });

  it('reports the exact missing id range and counts', () => {
    expect(detectCaptureGap({ ...base, lastSeenId: 100, entries: ids(273, 400) })).toEqual([
      {
        firstMissingId: 101,
        lastMissingId: 272,
        missingCount: 172,
        capturedCount: 128,
        cause: 'server_evicted',
      },
    ]);
  });

  it('counts only entries newer than the last seen id as captured', () => {
    const [result] = detectCaptureGap({
      ...base,
      lastSeenId: 100,
      entries: [{ id: 205 }, { id: 204 }, { id: 99 }, { id: 98 }],
    });
    expect(result.capturedCount).toBe(2);
    expect(result.missingCount).toBe(103);
  });

  it('tags a cap-limited catch-up read as fetch_limit when max-len is unknown', () => {
    const result = detectCaptureGap(burst);
    expect(result).toHaveLength(1);
    expect(result[0].cause).toBe('fetch_limit');
    expect(result[0].missingCount).toBe(8_976);
  });

  it('classifies from the received count, not the merged entry count', () => {
    // Merged 1,100 entries, but the bounding read returned fewer than the cap.
    const result = detectCaptureGap({
      ...base,
      requested: LOG_CATCH_UP_MAX_FETCH,
      received: 900,
      lastSeenId: 0,
      entries: ids(8_901, 10_000),
    });
    expect(result[0].cause).toBe('server_evicted');
  });

  it('splits a fetch_limit hole into server_evicted and fetch_limit when max-len is known', () => {
    const result = detectCaptureGap({ ...burst, serverMaxLen: 4_096 });
    expect(result).toEqual([
      { firstMissingId: 1, lastMissingId: 5_904, missingCount: 5_904, capturedCount: 4_096, cause: 'server_evicted' },
      { firstMissingId: 5_905, lastMissingId: 8_976, missingCount: 3_072, capturedCount: 1_024, cause: 'fetch_limit' },
    ]);
    // missing + captured is the full burst, so the aggregate peak stays real.
    expect(result[0].missingCount + result[0].capturedCount).toBe(10_000);
  });

  it('keeps one fetch_limit gap when the server held the whole hole', () => {
    const result = detectCaptureGap({ ...burst, serverMaxLen: 16_384 });
    expect(result.map((gap) => gap.cause)).toEqual(['fetch_limit']);
  });

  it('keeps one server_evicted gap when the server had already evicted the whole hole', () => {
    const result = detectCaptureGap({ ...burst, serverMaxLen: 512 });
    expect(result).toEqual([
      { firstMissingId: 1, lastMissingId: 8_976, missingCount: 8_976, capturedCount: 1_024, cause: 'server_evicted' },
    ]);
  });

  it('ignores max-len for causes other than fetch_limit', () => {
    const result = detectCaptureGap({ ...burst, previousPollAt: null, serverMaxLen: 4_096 });
    expect(result.map((gap) => gap.cause)).toEqual(['monitor_offline']);
  });
});

describe('recordCaptureGap', () => {
  const baseInput = {
    connectionId: 'conn-1',
    connectionName: 'primary',
    logType: 'slowlog' as const,
    lastSeenId: 0,
    requested: LOG_CATCH_UP_MAX_FETCH,
    received: LOG_CATCH_UP_MAX_FETCH,
    previousPollAt: NOW - INTERVAL,
    intervalMs: INTERVAL,
    now: NOW,
  };
  let insert: jest.Mock;
  let storage: StoragePort;
  const logger = { warn: jest.fn() } as unknown as Logger;

  beforeEach(() => {
    insert = jest.fn().mockResolvedValue(undefined);
    storage = { getLogCaptureGapRepository: () => ({ insert }) } as unknown as StoragePort;
  });

  it('reads max-len only for a fetch_limit candidate and inserts every piece', async () => {
    const readServerMaxLen = jest.fn().mockResolvedValue(4_096);
    const gaps = await recordCaptureGap(storage, logger, {
      ...baseInput,
      entries: ids(8_977, 10_000),
      readServerMaxLen,
    });
    expect(readServerMaxLen).toHaveBeenCalledTimes(1);
    expect(gaps.map((gap) => gap.cause)).toEqual(['server_evicted', 'fetch_limit']);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('keeps a single fetch_limit gap when max-len is unknown or unreadable', async () => {
    for (const readServerMaxLen of [jest.fn().mockResolvedValue(null), jest.fn().mockRejectedValue(new Error('x'))]) {
      const gaps = await recordCaptureGap(storage, logger, {
        ...baseInput,
        entries: ids(8_977, 10_000),
        readServerMaxLen,
      });
      expect(gaps.map((gap) => gap.cause)).toEqual(['fetch_limit']);
    }
  });

  it('never reads max-len for server_evicted or monitor_offline gaps', async () => {
    const readServerMaxLen = jest.fn().mockResolvedValue(4_096);
    await recordCaptureGap(storage, logger, {
      ...baseInput,
      requested: 300,
      received: 128,
      entries: ids(273, 400),
      readServerMaxLen,
    });
    await recordCaptureGap(storage, logger, {
      ...baseInput,
      previousPollAt: null,
      entries: ids(8_977, 10_000),
      readServerMaxLen,
    });
    expect(readServerMaxLen).not.toHaveBeenCalled();
  });

  it('stops waiting for a hung insert and still returns the gap', async () => {
    jest.useFakeTimers();
    try {
      insert.mockReturnValue(new Promise(() => undefined));
      const pending = recordCaptureGap(storage, logger, {
        ...baseInput,
        requested: 300,
        received: 128,
        entries: ids(273, 400),
        readServerMaxLen: jest.fn(),
      });
      await jest.advanceTimersByTimeAsync(LOG_CAPTURE_AUX_TIMEOUT_MS);
      await expect(pending).resolves.toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to record'));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('recommendMaxLen', () => {
  it('returns null without an evicting burst', () => {
    expect(recommendMaxLen(0, 128)).toBeNull();
  });

  it('doubles the peak burst and rounds up to a power of two', () => {
    // 300 arrivals between two polls -> 600 -> 1024
    expect(recommendMaxLen(300, 128)).toBe(1024);
  });

  it('clamps to the configured bounds', () => {
    expect(recommendMaxLen(2, 16)).toBe(MIN_RECOMMENDED_MAX_LEN);
    expect(recommendMaxLen(51_024, 128)).toBe(MAX_RECOMMENDED_MAX_LEN);
  });

  it('returns null when the current setting already meets the suggestion', () => {
    expect(recommendMaxLen(300, 1024)).toBeNull();
  });

  it('returns null at the cap even when the burst is larger (flagged separately)', () => {
    expect(recommendMaxLen(5_000, MAX_RECOMMENDED_MAX_LEN)).toBeNull();
    expect(recommendMaxLen(20_000, MAX_RECOMMENDED_MAX_LEN)).toBeNull();
  });

  it('still recommends when the current value is unknown', () => {
    expect(recommendMaxLen(300, null)).toBe(1024);
  });
});

describe('summarizeLogGaps', () => {
  function aggregate(overrides: Partial<LogCaptureGapAggregate> = {}): LogCaptureGapAggregate {
    return {
      logType: 'slowlog',
      cause: 'server_evicted',
      gapCount: 1,
      missingCount: 172,
      peakArrivals: 300,
      lastGapAt: NOW,
      ...overrides,
    };
  }

  it('summarizes an empty window', () => {
    expect(summarizeLogGaps('slowlog', [], 128)).toEqual({
      logType: 'slowlog',
      missingEntries: 0,
      gapCount: 0,
      lastGapAt: null,
      dominantCause: null,
      missingByCause: { server_evicted: 0, fetch_limit: 0, monitor_offline: 0 },
      configParameter: 'slowlog-max-len',
      currentMaxLen: 128,
      recommendedMaxLen: null,
      peakEvictedArrivals: 0,
      burstExceedsRecommendation: false,
    });
  });

  it('totals by cause, ignores other logs and picks the dominant cause by missing entries', () => {
    const summary = summarizeLogGaps(
      'commandlog-large-reply',
      [
        aggregate({ logType: 'commandlog-large-reply', cause: 'server_evicted', gapCount: 2, missingCount: 100, peakArrivals: 200, lastGapAt: NOW - 10 }),
        aggregate({ logType: 'commandlog-large-reply', cause: 'monitor_offline', gapCount: 1, missingCount: 500, peakArrivals: 9_000, lastGapAt: NOW }),
        aggregate({ logType: 'slowlog', missingCount: 7_777, lastGapAt: NOW + 1 }),
      ],
      128,
    );
    expect(summary.missingEntries).toBe(600);
    expect(summary.gapCount).toBe(3);
    expect(summary.lastGapAt).toBe(NOW);
    expect(summary.missingByCause).toEqual({ server_evicted: 100, fetch_limit: 0, monitor_offline: 500 });
    expect(summary.dominantCause).toBe('monitor_offline');
    expect(summary.configParameter).toBe('commandlog-large-reply-max-len');
    // Only the evicting burst (200) drives the recommendation, not the outage (9,000).
    expect(summary.recommendedMaxLen).toBe(512);
    expect(summary.peakEvictedArrivals).toBe(200);
    expect(summary.burstExceedsRecommendation).toBe(false);
  });

  it('flags a burst larger than the highest recommendation', () => {
    const summary = summarizeLogGaps('slowlog', [aggregate({ peakArrivals: 10_000 })], MAX_RECOMMENDED_MAX_LEN);
    expect(summary.recommendedMaxLen).toBeNull();
    expect(summary.peakEvictedArrivals).toBe(10_000);
    expect(summary.burstExceedsRecommendation).toBe(true);
  });
});
