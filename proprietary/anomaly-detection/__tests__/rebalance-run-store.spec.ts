import {
  fromStoredRun,
  persistedFingerprint,
  rebalanceRunId,
  runsToAdopt,
  toStoredRun,
} from '../rebalance-run-store';
import { REBALANCE_RUN_KEPT_MS, type RebalanceRun } from '../slot-rebalance-run';

const NOW = 1_700_000_000_000;

const run = (overrides: Partial<RebalanceRun> = {}): RebalanceRun => ({
  sourceShardId: 'src',
  sourceAddr: '10.0.0.1:6379',
  startedBy: { userId: 'u1', email: 'admin@example.com' },
  startedAt: NOW - 60_000,
  projectedRatio: 1.2,
  jobs: [
    { targetShardId: 'tgt', targetAddr: '10.0.0.2:6379', ranges: [[0, 99]], state: 'running' },
  ],
  jobsBefore: ['old-job'],
  state: 'running',
  ...overrides,
});

const ended = (endedAt: number, overrides: Partial<RebalanceRun> = {}) =>
  run({ state: 'succeeded', endedAt, ...overrides });

const row = (value: RebalanceRun) => toStoredRun('conn-a', value, NOW);

describe('rebalance run store', () => {
  it('stores a run under its connection, source shard and start', () => {
    const value = run();

    expect(row(value)).toEqual({
      id: `conn-a:src:${value.startedAt}`,
      connectionId: 'conn-a',
      sourceShardId: 'src',
      state: 'running',
      startedAt: value.startedAt,
      endedAt: null,
      updatedAt: NOW,
      payload: JSON.stringify(value),
    });
    expect(rebalanceRunId('conn-a', value)).toBe(row(value).id);
  });

  it('reads back the run it stored', () => {
    const value = ended(NOW, {
      cancelRequestedAt: NOW - 5,
      cancelAcceptedAt: NOW - 4,
      failedBeforeCancel: ['job-0'],
      outcome: { projectedRatio: 1.2, actualRatio: 1.3, measuredAt: NOW },
    });

    expect(row(value).endedAt).toBe(NOW);
    expect(fromStoredRun(row(value))).toEqual(value);
  });

  it.each([
    ['text that is not JSON', '{'],
    ['null', 'null'],
    ['an object that is not a run', '{"hello":"world"}'],
    ['a run without jobs', JSON.stringify({ ...run(), jobs: undefined })],
    ['a run without the jobs listed before it', JSON.stringify({ ...run(), jobsBefore: 1 })],
    ['a run without a start', JSON.stringify({ ...run(), startedAt: '1' })],
  ])('reads nothing from %s', (_, payload) => {
    expect(fromStoredRun({ ...row(run()), payload })).toBeNull();
  });

  it('changes the fingerprint only when the run changes', () => {
    expect(persistedFingerprint(run())).toBe(persistedFingerprint(run()));
    expect(persistedFingerprint(run())).not.toBe(persistedFingerprint(ended(NOW)));
  });

  describe('runsToAdopt', () => {
    const adopted = (...runs: RebalanceRun[]) =>
      runsToAdopt(runs.map(row), NOW, REBALANCE_RUN_KEPT_MS);

    it('keeps the running runs and the ones that ended recently', () => {
      const running = run({ sourceShardId: 'a', startedAt: NOW - 5 * REBALANCE_RUN_KEPT_MS });
      const recent = ended(NOW - REBALANCE_RUN_KEPT_MS + 1, { sourceShardId: 'b' });
      const old = ended(NOW - REBALANCE_RUN_KEPT_MS, { sourceShardId: 'c' });

      expect(adopted(running, recent, old)).toEqual([running, recent]);
    });

    it('keeps the latest run of each source shard', () => {
      const earlier = ended(NOW - 100, { startedAt: NOW - 200 });
      const later = run({ startedAt: NOW - 50 });

      expect(adopted(later, earlier)).toEqual([later]);
      expect(adopted(earlier, later)).toEqual([later]);
    });

    it('does not bring back a run an ended later run replaced', () => {
      const leftRunning = run({ startedAt: NOW - 10 * REBALANCE_RUN_KEPT_MS });
      const later = ended(NOW - 2 * REBALANCE_RUN_KEPT_MS, {
        startedAt: NOW - 3 * REBALANCE_RUN_KEPT_MS,
      });

      expect(adopted(later, leftRunning)).toEqual([]);
    });

    it('skips a row it cannot read', () => {
      const broken = { ...row(run({ sourceShardId: 'broken' })), payload: '{' };

      expect(runsToAdopt([broken, row(run())], NOW, REBALANCE_RUN_KEPT_MS)).toEqual([run()]);
    });

    it('starts the unread timer of a job again', () => {
      const [job] = run().jobs;

      const [value] = adopted(run({ jobs: [{ ...job, unreadSince: NOW - 120_000 }] }));

      expect(value.jobs).toEqual([job]);
    });
  });
});
