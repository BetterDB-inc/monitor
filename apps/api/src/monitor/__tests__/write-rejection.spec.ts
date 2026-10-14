import type { ErrorStatsInfo, PersistenceInfo } from '../../common/types/metrics.types';
import {
  createWriteRejectionState,
  evaluateWriteRejection,
  type WriteRejectionInput,
  type WriteRejectionState,
} from '../write-rejection';

const healthy: Partial<PersistenceInfo> = {
  rdb_last_bgsave_status: 'ok',
  aof_last_write_status: 'ok',
};
const bgsaveFailed: Partial<PersistenceInfo> = { ...healthy, rdb_last_bgsave_status: 'err' };
const stats = (counts: Record<string, number>): ErrorStatsInfo =>
  Object.fromEntries(
    Object.entries(counts).map(([code, count]) => [`errorstat_${code}`, { count }]),
  );
const QUIET_MS = 10_000;
const ev = (
  state: WriteRejectionState,
  persistence: Partial<PersistenceInfo> | undefined,
  errorstats: ErrorStatsInfo | undefined,
  now: number,
  extra: Partial<WriteRejectionInput> = {},
) => evaluateWriteRejection(state, { persistence, errorstats, now, quietMs: QUIET_MS, ...extra });

describe('evaluateWriteRejection', () => {
  it('opens a warning edge the moment BGSAVE fails, before any client is refused', () => {
    const state = createWriteRejectionState();
    const result = ev(state, bgsaveFailed, stats({}), 1_000);
    expect(result).toMatchObject({
      transition: 'rejected',
      severity: 'warning',
      causes: ['rdb_bgsave_failed'],
    });
  });

  it('escalates to critical once clients receive MISCONF, without re-opening the edge', () => {
    const state = createWriteRejectionState();
    ev(state, bgsaveFailed, stats({ MISCONF: 0 }), 1_000);
    const result = ev(state, bgsaveFailed, stats({ MISCONF: 250 }), 6_000);
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
    ev(state, bgsaveFailed, stats({ MISCONF: 0 }), 0);
    ev(state, bgsaveFailed, stats({ MISCONF: 250 }), 5_000);
    const result = ev(state, bgsaveFailed, stats({ MISCONF: 600 }), 10_000);
    expect(result).toMatchObject({ transition: null, severity: 'critical' });
  });

  it('escalates when an open BGSAVE edge gains an OOM cause', () => {
    const state = createWriteRejectionState();
    ev(state, healthy, stats({ OOM: 0 }), 0);
    expect(ev(state, bgsaveFailed, stats({ OOM: 0 }), 5_000).transition).toBe(
      'rejected',
    );
    const result = ev(state, bgsaveFailed, stats({ OOM: 12 }), 10_000);
    expect(result.transition).toBe('escalated');
    expect(result.causes).toEqual(
      expect.arrayContaining(['rdb_bgsave_failed', 'maxmemory_reached']),
    );
  });

  it('does not escalate when causes shrink while the edge stays open', () => {
    const state = createWriteRejectionState();
    const both = { rdb_last_bgsave_status: 'err', aof_last_write_status: 'err' };
    ev(state, both, stats({}), 0);
    expect(ev(state, bgsaveFailed, stats({}), 5_000).transition).toBeNull();
  });

  it('resets on recovery so the next failure opens a fresh edge', () => {
    const state = createWriteRejectionState();
    ev(state, bgsaveFailed, stats({ MISCONF: 0 }), 0);
    ev(state, bgsaveFailed, stats({ MISCONF: 9 }), 5_000);
    expect(ev(state, healthy, stats({ MISCONF: 9 }), 15_000).transition).toBe(
      'recovered',
    );
    expect(state).toMatchObject({ lastSeverity: null, lastCauses: [], lastActiveAt: null });
    expect(
      ev(state, bgsaveFailed, stats({ MISCONF: 9 }), 20_000),
    ).toMatchObject({ transition: 'rejected', severity: 'warning', rejectingForMs: 0 });
  });

  it('keeps the edge open through a poll without persistence data', () => {
    const state = createWriteRejectionState();
    ev(state, bgsaveFailed, stats({ MISCONF: 0 }), 0);
    expect(
      ev(state, undefined, stats({ MISCONF: 0 }), 5_000).transition,
    ).toBeNull();
    expect(state).toMatchObject({ rejecting: true, rejectingSince: 0, lastSeverity: 'warning' });
    expect(ev(state, healthy, stats({ MISCONF: 0 }), 10_000)).toMatchObject({
      transition: 'recovered',
      rejectingForMs: 10_000,
    });
  });

  it('does not recover while aof_last_write_status is missing', () => {
    const state = createWriteRejectionState();
    ev(state, bgsaveFailed, stats({}), 0);
    expect(
      ev(state, { rdb_last_bgsave_status: 'ok' }, stats({}), 5_000).transition,
    ).toBeNull();
    expect(state.rejecting).toBe(true);
  });

  it('recovers an OOM edge on a server that stops reporting errorstats', () => {
    const state = createWriteRejectionState();
    ev(state, healthy, stats({ OOM: 1 }), 0);
    expect(ev(state, healthy, stats({ OOM: 20 }), 5_000).transition).toBe(
      'rejected',
    );
    expect(ev(state, healthy, undefined, 15_000)).toMatchObject({
      transition: 'recovered',
      rejectingForMs: 10_000,
    });
  });

  it('treats a code missing from a present errorstats section as zero', () => {
    const state = createWriteRejectionState();
    ev(state, healthy, stats({ MISCONF: 3 }), 0);
    expect(ev(state, healthy, stats({ OOM: 5 }), 5_000)).toMatchObject({
      transition: 'rejected',
      rejectedSinceLastPoll: { OOM: 5 },
    });
  });

  it('keeps the baseline across a poll without the errorstats section', () => {
    const state = createWriteRejectionState();
    ev(state, healthy, stats({ OOM: 4 }), 0);
    expect(ev(state, healthy, undefined, 5_000).transition).toBeNull();
    expect(ev(state, healthy, stats({ OOM: 9 }), 10_000)).toMatchObject({
      transition: 'rejected',
      rejectedSinceLastPoll: { OOM: 5 },
    });
  });

  it('detects OOM rejections from errorstats alone (noeviction at maxmemory)', () => {
    const state = createWriteRejectionState();
    ev(state, healthy, stats({ OOM: 4 }), 0);
    const result = ev(state, healthy, stats({ OOM: 90 }), 5_000);
    expect(result).toMatchObject({
      transition: 'rejected',
      causes: ['maxmemory_reached'],
      severity: 'critical',
    });
  });

  it('attributes READONLY to clients writing to a replica (stale topology after failover)', () => {
    const state = createWriteRejectionState();
    ev(state, healthy, stats({ READONLY: 0 }), 0);
    expect(ev(state, healthy, stats({ READONLY: 3 }), 5_000).causes).toEqual([
      'write_to_replica',
    ]);
  });

  it('treats a counter drop (restart, CONFIG RESETSTAT) as a new baseline, not a rejection', () => {
    const state = createWriteRejectionState();
    ev(state, healthy, stats({ OOM: 500 }), 0);
    expect(ev(state, healthy, stats({ OOM: 2 }), 5_000).transition).toBeNull();
  });

  it('does not alert on historical counts seen on the first poll', () => {
    const state = createWriteRejectionState();
    expect(
      ev(state, healthy, stats({ MISCONF: 9_999 }), 0).transition,
    ).toBeNull();
  });

  it('recovers only when persistence is healthy and no new errors arrived', () => {
    const state = createWriteRejectionState();
    ev(state, bgsaveFailed, stats({ MISCONF: 0 }), 0);
    // Persistence is healthy again, but clients were refused before it recovered.
    expect(
      ev(state, healthy, stats({ MISCONF: 7 }), 5_000).transition,
    ).toBe('escalated');
    const recovered = ev(state, healthy, stats({ MISCONF: 7 }), 15_000);
    expect(recovered).toMatchObject({ transition: 'recovered', rejectingForMs: 15_000 });
  });

  it('does not flap: OOM edge stays open through a short quiet window', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ OOM: 0 }), 0);
    expect(ev(s, healthy, stats({ OOM: 5 }), 5_000).transition).toBe('rejected');
    expect(ev(s, healthy, stats({ OOM: 5 }), 10_000).transition).toBeNull(); // 5s quiet
    expect(ev(s, healthy, stats({ OOM: 9 }), 12_000).transition).toBeNull(); // still open, no re-fire
    expect(ev(s, healthy, stats({ OOM: 9 }), 23_000)).toMatchObject({
      transition: 'recovered',
      rejectingForMs: 18_000, // measured from edge open, not reset by the 12s rejection
    });
  });

  it('OOM edge does not recover while used_memory >= maxmemory', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ OOM: 0 }), 0);
    ev(s, healthy, stats({ OOM: 5 }), 5_000);
    expect(
      ev(s, healthy, stats({ OOM: 5 }), 60_000, { usedMemory: 100, maxMemory: 100 }).transition,
    ).toBeNull();
    expect(
      ev(s, healthy, stats({ OOM: 5 }), 65_000, { usedMemory: 80, maxMemory: 100 }).transition,
    ).toBe('recovered');
  });

  it('ignores READONLY on a replica but still baselines it', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ READONLY: 0 }), 0, { role: 'slave' });
    expect(ev(s, healthy, stats({ READONLY: 7 }), 5_000, { role: 'slave' }).transition).toBeNull();
    // promoted, no new errors -> still quiet
    expect(ev(s, healthy, stats({ READONLY: 7 }), 10_000, { role: 'master' }).transition).toBeNull();
    expect(ev(s, healthy, stats({ READONLY: 9 }), 15_000, { role: 'master' }).causes).toEqual([
      'write_to_replica',
    ]);
  });

  it('ignores rdb err when BGSAVE failure does not stop writes', () => {
    const s = createWriteRejectionState();
    expect(ev(s, bgsaveFailed, stats({}), 0, { rdbStopsWrites: false }).transition).toBeNull();
  });

  it('keeps flagging rdb err when stop-writes is unknown', () => {
    const s = createWriteRejectionState();
    expect(ev(s, bgsaveFailed, stats({}), 0, { rdbStopsWrites: null }).causes).toEqual([
      'rdb_bgsave_failed',
    ]);
  });

  it('labels MISCONF with no failing persistence status as persistence_failed', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ MISCONF: 0 }), 0);
    expect(ev(s, healthy, stats({ MISCONF: 3 }), 5_000).causes).toEqual(['persistence_failed']);
  });

  it('escalation never reports a lower severity than already reported', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ OOM: 0 }), 0);
    expect(ev(s, healthy, stats({ OOM: 3 }), 5_000).severity).toBe('critical');
    const r = ev(s, bgsaveFailed, stats({ OOM: 3 }), 6_000);
    expect(r).toMatchObject({ transition: 'escalated', severity: 'critical' });
  });

  it('reports warning, not critical, when a critical edge recovers', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ OOM: 0 }), 0);
    expect(ev(s, healthy, stats({ OOM: 5 }), 5_000).severity).toBe('critical');
    expect(ev(s, healthy, stats({ OOM: 5 }), 20_000)).toMatchObject({
      transition: 'recovered',
      severity: 'warning',
    });
  });

  it('recovers an errorstats-only edge while a non-blocking BGSAVE error persists', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ OOM: 0 }), 0);
    expect(ev(s, healthy, stats({ OOM: 5 }), 5_000).transition).toBe('rejected');
    expect(
      ev(s, bgsaveFailed, stats({ OOM: 5 }), 20_000, { rdbStopsWrites: false }),
    ).toMatchObject({ transition: 'recovered', severity: 'warning' });
  });

  it('recovers an errorstats-only edge when the persistence section is absent (managed hosts)', () => {
    const s = createWriteRejectionState();
    ev(s, undefined, stats({ NOREPLICAS: 0 }), 0);
    expect(ev(s, undefined, stats({ NOREPLICAS: 2 }), 5_000).transition).toBe('rejected');
    expect(ev(s, undefined, stats({ NOREPLICAS: 2 }), 20_000).transition).toBe('recovered');
  });

  it('still keeps a persistence edge open without reported persistence', () => {
    const s = createWriteRejectionState();
    ev(s, bgsaveFailed, stats({}), 0);
    expect(ev(s, undefined, stats({}), 20_000).transition).toBeNull();
  });

  it('recovers an RDB edge once a failed BGSAVE no longer stops writes', () => {
    const s = createWriteRejectionState();
    ev(s, bgsaveFailed, stats({}), 0);
    expect(
      ev(s, bgsaveFailed, stats({}), 20_000, { rdbStopsWrites: false }).transition,
    ).toBe('recovered');
  });

  it('an edge that also had a persistence cause still needs persistence ok', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ OOM: 0 }), 0);
    ev(s, bgsaveFailed, stats({ OOM: 3 }), 5_000); // opens with rdb + OOM
    // Quiet long enough, but persistence is unreported: stays open.
    expect(ev(s, undefined, stats({ OOM: 3 }), 20_000).transition).toBeNull();
    expect(ev(s, healthy, stats({ OOM: 3 }), 25_000).transition).toBe('recovered');
  });

  it('OOM edge recovers when only non-evictable buffers keep used_memory above maxmemory', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ OOM: 0 }), 0);
    ev(s, healthy, stats({ OOM: 5 }), 5_000);
    expect(
      ev(s, healthy, stats({ OOM: 5 }), 60_000, {
        usedMemory: 110,
        maxMemory: 100,
        memNotCountedForEvict: 20,
      }).transition,
    ).toBe('recovered');
  });

  it('OOM edge stays open when evictable memory is still at maxmemory', () => {
    const s = createWriteRejectionState();
    ev(s, healthy, stats({ OOM: 0 }), 0);
    ev(s, healthy, stats({ OOM: 5 }), 5_000);
    expect(
      ev(s, healthy, stats({ OOM: 5 }), 60_000, {
        usedMemory: 130,
        maxMemory: 100,
        memNotCountedForEvict: 20,
      }).transition,
    ).toBeNull();
  });
});
