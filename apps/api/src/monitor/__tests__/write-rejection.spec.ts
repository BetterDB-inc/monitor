import type { ErrorStatsInfo, PersistenceInfo } from '../../common/types/metrics.types';
import { createWriteRejectionState, evaluateWriteRejection } from '../write-rejection';

const healthy: Partial<PersistenceInfo> = {
  rdb_last_bgsave_status: 'ok',
  aof_last_write_status: 'ok',
};
const bgsaveFailed: Partial<PersistenceInfo> = { ...healthy, rdb_last_bgsave_status: 'err' };
const stats = (counts: Record<string, number>): ErrorStatsInfo =>
  Object.fromEntries(
    Object.entries(counts).map(([code, count]) => [`errorstat_${code}`, { count }]),
  );

describe('evaluateWriteRejection', () => {
  it('opens a warning edge the moment BGSAVE fails, before any client is refused', () => {
    const state = createWriteRejectionState();
    const result = evaluateWriteRejection(state, bgsaveFailed, stats({}), 1_000);
    expect(result).toMatchObject({
      transition: 'rejected',
      severity: 'warning',
      causes: ['rdb_bgsave_failed'],
    });
  });

  it('escalates to critical once clients receive MISCONF, without re-opening the edge', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, bgsaveFailed, stats({ MISCONF: 0 }), 1_000);
    const result = evaluateWriteRejection(state, bgsaveFailed, stats({ MISCONF: 250 }), 6_000);
    expect(result).toMatchObject({
      transition: null,
      severity: 'critical',
      rejectedSinceLastPoll: { MISCONF: 250 },
    });
  });

  it('detects OOM rejections from errorstats alone (noeviction at maxmemory)', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, healthy, stats({ OOM: 4 }), 0);
    const result = evaluateWriteRejection(state, healthy, stats({ OOM: 90 }), 5_000);
    expect(result).toMatchObject({
      transition: 'rejected',
      causes: ['maxmemory_reached'],
      severity: 'critical',
    });
  });

  it('attributes READONLY to clients writing to a replica (stale topology after failover)', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, healthy, stats({ READONLY: 0 }), 0);
    expect(evaluateWriteRejection(state, healthy, stats({ READONLY: 3 }), 5_000).causes).toEqual([
      'write_to_replica',
    ]);
  });

  it('treats a counter drop (restart, CONFIG RESETSTAT) as a new baseline, not a rejection', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, healthy, stats({ OOM: 500 }), 0);
    expect(evaluateWriteRejection(state, healthy, stats({ OOM: 2 }), 5_000).transition).toBeNull();
  });

  it('does not alert on historical counts seen on the first poll', () => {
    const state = createWriteRejectionState();
    expect(
      evaluateWriteRejection(state, healthy, stats({ MISCONF: 9_999 }), 0).transition,
    ).toBeNull();
  });

  it('recovers only when persistence is healthy and no new errors arrived', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, bgsaveFailed, stats({ MISCONF: 0 }), 0);
    expect(
      evaluateWriteRejection(state, healthy, stats({ MISCONF: 7 }), 5_000).transition,
    ).toBeNull();
    const recovered = evaluateWriteRejection(state, healthy, stats({ MISCONF: 7 }), 10_000);
    expect(recovered).toMatchObject({ transition: 'recovered', rejectingForMs: 10_000 });
  });
});
