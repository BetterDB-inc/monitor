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
      transition: 'escalated',
      severity: 'critical',
      causes: ['rdb_bgsave_failed'],
      rejectedSinceLastPoll: { MISCONF: 250 },
      rejectingForMs: 5_000,
    });
  });

  it('stays quiet while the edge remains critical with the same causes', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, bgsaveFailed, stats({ MISCONF: 0 }), 0);
    evaluateWriteRejection(state, bgsaveFailed, stats({ MISCONF: 250 }), 5_000);
    const result = evaluateWriteRejection(state, bgsaveFailed, stats({ MISCONF: 600 }), 10_000);
    expect(result).toMatchObject({ transition: null, severity: 'critical' });
  });

  it('escalates when an open BGSAVE edge gains an OOM cause', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, healthy, stats({ OOM: 0 }), 0);
    expect(evaluateWriteRejection(state, bgsaveFailed, stats({ OOM: 0 }), 5_000).transition).toBe(
      'rejected',
    );
    const result = evaluateWriteRejection(state, bgsaveFailed, stats({ OOM: 12 }), 10_000);
    expect(result.transition).toBe('escalated');
    expect(result.causes).toEqual(
      expect.arrayContaining(['rdb_bgsave_failed', 'maxmemory_reached']),
    );
  });

  it('does not escalate when causes shrink while the edge stays open', () => {
    const state = createWriteRejectionState();
    const both = { rdb_last_bgsave_status: 'err', aof_last_write_status: 'err' };
    evaluateWriteRejection(state, both, stats({}), 0);
    expect(evaluateWriteRejection(state, bgsaveFailed, stats({}), 5_000).transition).toBeNull();
  });

  it('resets on recovery so the next failure opens a fresh edge', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, bgsaveFailed, stats({ MISCONF: 0 }), 0);
    evaluateWriteRejection(state, bgsaveFailed, stats({ MISCONF: 9 }), 5_000);
    expect(evaluateWriteRejection(state, healthy, stats({ MISCONF: 9 }), 10_000).transition).toBe(
      'recovered',
    );
    expect(state).toMatchObject({ lastSeverity: null, lastCauses: [] });
    expect(
      evaluateWriteRejection(state, bgsaveFailed, stats({ MISCONF: 9 }), 15_000),
    ).toMatchObject({ transition: 'rejected', severity: 'warning', rejectingForMs: 0 });
  });

  it('treats a code missing from a present errorstats section as zero', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, healthy, stats({ MISCONF: 3 }), 0);
    expect(evaluateWriteRejection(state, healthy, stats({ OOM: 5 }), 5_000)).toMatchObject({
      transition: 'rejected',
      rejectedSinceLastPoll: { OOM: 5 },
    });
  });

  it('keeps the baseline across a poll without the errorstats section', () => {
    const state = createWriteRejectionState();
    evaluateWriteRejection(state, healthy, stats({ OOM: 4 }), 0);
    expect(evaluateWriteRejection(state, healthy, undefined, 5_000).transition).toBeNull();
    expect(evaluateWriteRejection(state, healthy, stats({ OOM: 9 }), 10_000)).toMatchObject({
      transition: 'rejected',
      rejectedSinceLastPoll: { OOM: 5 },
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
    // Persistence is healthy again, but clients were refused before it recovered.
    expect(
      evaluateWriteRejection(state, healthy, stats({ MISCONF: 7 }), 5_000).transition,
    ).toBe('escalated');
    const recovered = evaluateWriteRejection(state, healthy, stats({ MISCONF: 7 }), 10_000);
    expect(recovered).toMatchObject({ transition: 'recovered', rejectingForMs: 10_000 });
  });
});
