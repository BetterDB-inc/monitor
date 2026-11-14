import type {
  FailedSlotMigration,
  SlotMigration,
  SlotMigrationReport,
} from '@app/cluster/cluster-metrics.service';
import {
  ATOMIC_MIGRATION_STALL_MS,
  LEGACY_MIGRATION_STALL_MS,
  type SlotMigrationJudgement,
  type SlotMigrationWatch,
  describeSlotMigration,
  judgeSlotMigrations,
  withAdoptedSlotMigrations,
  isStuckFailingImport,
} from '../slot-migration-detector';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const A = { id: 'a0000000', address: '10.0.0.1:6379' };
const B = { id: 'b0000000', address: '10.0.0.2:6379' };
const C = { id: 'c0000000', address: '10.0.0.3:6379' };
const ALL = [A.id, B.id, C.id];

function job(overrides: Partial<SlotMigration> = {}): SlotMigration {
  return {
    slot: 0,
    slotRange: '0-100',
    sourceNodeId: A.id,
    sourceAddress: A.address,
    targetNodeId: B.id,
    targetAddress: B.address,
    state: 'migrating',
    phase: 'waiting-to-snapshot',
    jobName: 'job-1',
    lastUpdateAt: T0,
    ...overrides,
  };
}

function marker(slot: number, overrides: Partial<SlotMigration> = {}): SlotMigration {
  return {
    slot,
    sourceNodeId: A.id,
    sourceAddress: A.address,
    targetNodeId: B.id,
    targetAddress: B.address,
    state: 'migrating',
    ...overrides,
  };
}

function failedJob(overrides: Partial<FailedSlotMigration> = {}): FailedSlotMigration {
  return {
    jobName: 'job-1',
    slotRange: '0-100',
    sourceNodeId: A.id,
    sourceAddress: A.address,
    targetNodeId: B.id,
    targetAddress: B.address,
    message: 'Connection lost to target',
    listedByNodeIds: [A.id],
    ...overrides,
  };
}

function report(overrides: Partial<SlotMigrationReport> = {}): SlotMigrationReport {
  const readNodeIds = overrides.readNodeIds ?? ALL;
  const complete = overrides.complete ?? true;
  return {
    migrations: [],
    failed: [],
    finishedJobs: [],
    jobViews: [],
    ownNodeOnly: false,
    ...overrides,
    readNodeIds,
    jobsReadNodeIds: overrides.jobsReadNodeIds ?? readNodeIds,
    complete,
    markersComplete: overrides.markersComplete ?? complete,
  };
}

function run(
  steps: Array<[number, SlotMigrationReport]>,
  from?: SlotMigrationWatch,
): SlotMigrationJudgement {
  let watch = from;
  let last: SlotMigrationJudgement | undefined;
  for (const [at, seen] of steps) {
    last = judgeSlotMigrations(watch, seen, at);
    watch = last.watch;
  }
  return last!;
}

describe('judgeSlotMigrations', () => {
  it('finds nothing on a quiet cluster', () => {
    const judged = run([[T0, report()]]);

    expect(judged.running).toEqual([]);
    expect(judged.stuck).toEqual([]);
    expect(judged.failed).toEqual([]);
  });

  describe('atomic job', () => {
    it('is running while the server lists it as active', () => {
      const judged = run([[T0, report({ migrations: [job()] })]]);

      expect(judged.running).toEqual([
        {
          kind: 'running',
          signature: 'running:job:job-1',
          atomic: true,
          slots: '0-100',
          sourceNodeId: A.id,
          sourceAddress: A.address,
          targetNodeId: B.id,
          targetAddress: B.address,
          phase: 'waiting-to-snapshot',
        },
      ]);
      expect(judged.stuck).toEqual([]);
    });

    it('is stuck after 10 minutes with the same state and update time', () => {
      const seen = report({ migrations: [job()] });

      const before = run([
        [T0, seen],
        [T0 + ATOMIC_MIGRATION_STALL_MS - 1, seen],
      ]);
      const after = run([
        [T0, seen],
        [T0 + ATOMIC_MIGRATION_STALL_MS, seen],
      ]);

      expect(before.stuck).toEqual([]);
      expect(after.stuck).toEqual([
        expect.objectContaining({
          kind: 'stuck',
          signature: 'stuck:job:job-1',
          quietMs: ATOMIC_MIGRATION_STALL_MS,
          phase: 'waiting-to-snapshot',
        }),
      ]);
      expect(after.running).toHaveLength(1);
    });

    it.each([
      ['a status update', { lastUpdateAt: T0 + 9 * MINUTE }],
      ['a new state', { phase: 'replicating' }],
    ])('is not stuck when %s arrived in the meantime', (_, progress) => {
      const judged = run([
        [T0, report({ migrations: [job()] })],
        [T0 + 9 * MINUTE, report({ migrations: [job(progress)] })],
        [T0 + 12 * MINUTE, report({ migrations: [job(progress)] })],
      ]);

      expect(judged.stuck).toEqual([]);
    });

    it('is never judged stuck when the server sends no update time', () => {
      const untimed = job({ lastUpdateAt: undefined });

      const judged = run([
        [T0, report({ migrations: [untimed] })],
        [T0 + 60 * MINUTE, report({ migrations: [untimed] })],
      ]);

      expect(judged.running).toHaveLength(1);
      expect(judged.stuck).toEqual([]);
    });

    it('runs a Redis task from both ends without judging it stuck or naming a Valkey command', () => {
      const source = job({ phase: 'send-stream', lastUpdateAt: undefined });
      const target = job({
        state: 'importing',
        phase: 'streaming-buffer',
        lastUpdateAt: undefined,
      });
      const seen = report({ migrations: [source], jobViews: [source, target] });

      const judged = run([
        [T0, seen],
        [T0 + 60 * MINUTE, seen],
      ]);

      expect(judged.running).toHaveLength(1);
      expect(judged.stuck).toEqual([]);
      expect(describeSlotMigration(judged.running[0])).not.toMatch(/SLOTMIGRATIONS/);
    });

    it('keeps one running entry for a Redis import its target keeps retrying', () => {
      const attempt = (phase: string) => {
        const target = job({ state: 'importing', phase, lastUpdateAt: undefined });
        return report({ migrations: [target], jobViews: [target] });
      };
      let watch: SlotMigrationWatch | undefined;
      const entries: string[][] = [];

      for (const [at, phase] of [
        [T0, 'connecting'],
        [T0 + MINUTE, 'failed'],
        [T0 + 2 * MINUTE, 'connecting'],
        [T0 + 3 * MINUTE, 'failed'],
      ] as const) {
        const judged = judgeSlotMigrations(watch, attempt(phase), at);
        watch = judged.watch;
        entries.push(judged.running.map((entry) => entry.signature));
      }

      expect(entries).toEqual(Array(4).fill(['running:job:job-1']));
    });

    describe('a Redis import its target keeps failing', () => {
      const attempt = (phase: string, retries: number) => {
        const target = job({
          state: 'importing',
          phase,
          lastUpdateAt: undefined,
          retries,
          lastError: 'Connection refused',
        });
        return report({ migrations: [target], jobViews: [target] });
      };
      const retried = (
        minutes: number,
        phase = (i: number): string => (i % 2 === 0 ? 'failed' : 'connecting'),
        retries = (i: number) => 60 * i,
      ) =>
        Array.from({ length: minutes + 1 }, (_, i): [number, SlotMigrationReport] => [
          T0 + i * MINUTE,
          attempt(phase(i), retries(i)),
        ]);

      it('is stuck once it has kept failing for 10 minutes', () => {
        expect(run(retried(9)).stuck).toEqual([]);
        expect(run(retried(10)).stuck).toEqual([
          {
            kind: 'stuck',
            signature: 'stuck:job:job-1',
            atomic: true,
            slots: '0-100',
            sourceNodeId: A.id,
            sourceAddress: A.address,
            targetNodeId: B.id,
            targetAddress: B.address,
            phase: 'failed',
            quietMs: 10 * MINUTE,
            importFailing: true,
            jobName: 'job-1',
            retries: 600,
            reason: 'Connection refused',
          },
        ]);
      });

      it('is stuck when every read lands on a retry in progress', () => {
        const reads = (minutes: number) => retried(minutes, () => 'connecting');

        expect(run(reads(10)).stuck).toEqual([]);
        expect(run(reads(11)).stuck).toHaveLength(1);
      });

      it('is stuck when its retry is held back and it stays failed', () => {
        const stayFailed = () => 'failed';
        const postponed = () => 3;

        const judged = run(retried(10, stayFailed, postponed));

        expect(judged.stuck).toEqual([expect.objectContaining({ retries: 3 })]);
      });

      it('is not stuck when a retry works and the import then streams', () => {
        const streamsAfterOneRetry = (i: number) => (i === 0 ? 'failed' : 'streaming-buffer');
        const once = () => 1;

        const judged = run(retried(12, streamsAfterOneRetry, once));

        expect(judged.stuck).toEqual([]);
        expect(judged.held.size).toBe(0);
      });

      it('keeps its warning while only its source is read', () => {
        const source = job({ phase: 'send-bulk-and-stream', lastUpdateAt: undefined, retries: 0 });

        const judged = run([
          ...retried(10),
          [
            T0 + 11 * MINUTE,
            report({
              migrations: [source],
              jobViews: [source],
              readNodeIds: [A.id],
              complete: false,
            }),
          ],
        ]);

        expect(judged.stuck).toEqual([expect.objectContaining({ signature: 'stuck:job:job-1' })]);
        expect(isStuckFailingImport(judged.watch, 'job-1')).toBe(true);
      });

      type Sighting = { at: number; stuck: boolean; released: boolean };
      const watchReads = (
        readMs: number,
        untilMs: number,
        read: (elapsed: number) => SlotMigrationReport,
      ): Sighting[] => {
        const sightings: Sighting[] = [];
        let watch: SlotMigrationWatch | undefined;
        for (let elapsed = 0; elapsed <= untilMs; elapsed += readMs) {
          const judged = judgeSlotMigrations(watch, read(elapsed), T0 + elapsed);
          watch = judged.watch;
          sightings.push({
            at: elapsed,
            stuck: judged.stuck.length > 0,
            released: isStuckFailingImport(watch, 'job-1'),
          });
        }
        return sightings;
      };
      const slowAttempts = (attemptMs: number) => (elapsed: number) =>
        attempt('connecting', Math.floor(elapsed / attemptMs));
      const firstStuck = (sightings: Sighting[]) => sightings.find((s) => s.stuck)?.at;
      const steadyFrom = (sightings: Sighting[], at: number) =>
        sightings.filter((s) => s.at >= at).every((s) => s.stuck && s.released);

      it.each([5_000, 30_000])(
        'is stuck after about 10 minutes when each attempt takes a minute, read every %i ms',
        (readMs) => {
          const sightings = watchReads(readMs, 40 * MINUTE, slowAttempts(MINUTE));
          const at = firstStuck(sightings) ?? Infinity;

          expect(at).toBeGreaterThanOrEqual(10 * MINUTE);
          expect(at).toBeLessThanOrEqual(11 * MINUTE);
          expect(steadyFrom(sightings, at)).toBe(true);
        },
      );

      it('is stuck once failures 4 minutes apart span 10 minutes', () => {
        const sightings = watchReads(5_000, 40 * MINUTE, slowAttempts(4 * MINUTE));
        const at = firstStuck(sightings) ?? Infinity;

        expect(at).toBe(16 * MINUTE);
        expect(steadyFrom(sightings, at)).toBe(true);
      });

      it('is never stuck when one retry works and the import then streams for 30 minutes', () => {
        const sightings = watchReads(5_000, 30 * MINUTE, (elapsed) =>
          elapsed < 10_000 ? attempt('connecting', 0) : attempt('streaming-buffer', 1),
        );

        expect(sightings.some((s) => s.stuck || s.released)).toBe(false);
      });

      it('is never stuck when three failures in its first 8 minutes are followed by streaming', () => {
        const failedAt = [30_000, 4 * MINUTE, 8 * MINUTE];
        const sightings = watchReads(5_000, 38 * MINUTE, (elapsed) => {
          const retries = failedAt.filter((at) => elapsed >= at).length;
          return attempt(elapsed < 8 * MINUTE ? 'connecting' : 'streaming-buffer', retries);
        });

        expect(sightings.some((s) => s.stuck || s.released)).toBe(false);
      });

      it('is never stuck when three failures in its first 15 seconds are followed by streaming', () => {
        const sightings = watchReads(5_000, 30 * MINUTE, (elapsed) => {
          const retries = Math.min(3, Math.floor(elapsed / 5_000));
          return attempt(retries < 3 ? 'connecting' : 'streaming-buffer', retries);
        });

        expect(sightings.some((s) => s.stuck || s.released)).toBe(false);
      });

      it('counts a failure once when a read sees it failed and the next one sees its retry', () => {
        const sightings = watchReads(5_000, 30 * MINUTE, (elapsed) => {
          if (elapsed === MINUTE) return attempt('failed', 0);
          if (elapsed === 2 * MINUTE) return attempt('failed', 1);
          const retries = elapsed > 2 * MINUTE ? 2 : elapsed > MINUTE ? 1 : 0;
          return attempt(elapsed > 2 * MINUTE ? 'streaming-buffer' : 'connecting', retries);
        });

        expect(sightings.some((s) => s.stuck || s.released)).toBe(false);
      });

      it('is not stuck from two failures alone', () => {
        const sightings = watchReads(30_000, 15 * MINUTE, (elapsed) =>
          attempt('connecting', Math.min(2, Math.floor(elapsed / MINUTE))),
        );

        expect(sightings.some((s) => s.stuck)).toBe(false);
      });

      it('ends its warning once no failure has been seen for 10 minutes', () => {
        const quiet = (minutes: number): Array<[number, SlotMigrationReport]> =>
          Array.from({ length: minutes }, (_, i) => [
            T0 + (11 + i) * MINUTE,
            attempt('streaming-buffer', 600),
          ]);

        const kept = run([...retried(10), ...quiet(10)]);
        const ended = run([...retried(10), ...quiet(11)]);

        expect(kept.stuck).toHaveLength(1);
        expect(ended.stuck).toEqual([]);
        expect(ended.held.size).toBe(0);
        expect(isStuckFailingImport(ended.watch, 'job-1')).toBe(false);
      });

      it('ends its warning when the task completes', () => {
        const judged = run([
          ...retried(10),
          [T0 + 11 * MINUTE, report({ finishedJobs: ['job-1'] })],
        ]);

        expect(judged.stuck).toEqual([]);
        expect(judged.running).toEqual([]);
        expect(isStuckFailingImport(judged.watch, 'job-1')).toBe(false);
      });

      it('keeps a warning from before a restart until 10 minutes pass without a failure', () => {
        const adopted = withAdoptedSlotMigrations(undefined, ['stuck:job:job-1']);
        const quiet = (minutes: number): Array<[number, SlotMigrationReport]> =>
          Array.from({ length: minutes + 1 }, (_, i) => [
            T0 + i * MINUTE,
            attempt('connecting', 5),
          ]);

        const first = run(quiet(0), adopted);
        const later = run(quiet(11), adopted);

        expect(first.held).toEqual(new Set(['stuck:job:job-1']));
        expect(isStuckFailingImport(first.watch, 'job-1')).toBe(true);
        expect(later.held.size).toBe(0);
        expect(isStuckFailingImport(later.watch, 'job-1')).toBe(false);
      });

      it('no longer counts for the hot_shard hold once it is stuck', () => {
        expect(isStuckFailingImport(run(retried(9)).watch, 'job-1')).toBe(false);
        expect(isStuckFailingImport(run(retried(10)).watch, 'job-1')).toBe(true);
        expect(isStuckFailingImport(undefined, 'job-1')).toBe(false);
      });
    });

    it('measures the quiet time on the monitor clock, not against the server times', () => {
      const skewed = job({ lastUpdateAt: T0 - 60 * MINUTE });

      const judged = run([
        [T0, report({ migrations: [skewed] })],
        [T0 + MINUTE, report({ migrations: [skewed] })],
      ]);

      expect(judged.stuck).toEqual([]);
    });

    it('stops being stuck once it moves again', () => {
      const judged = run([
        [T0, report({ migrations: [job()] })],
        [T0 + 10 * MINUTE, report({ migrations: [job()] })],
        [T0 + 11 * MINUTE, report({ migrations: [job({ lastUpdateAt: T0 + 11 * MINUTE })] })],
      ]);

      expect(judged.stuck).toEqual([]);
      expect(judged.running).toHaveLength(1);
    });

    it('is gone once a full read no longer lists it', () => {
      const judged = run([
        [T0, report({ migrations: [job()] })],
        [T0 + MINUTE, report()],
      ]);

      expect(judged.running).toEqual([]);
      expect(judged.unseen.size).toBe(0);
    });

    it('is kept as it was while neither of its nodes can be read', () => {
      const judged = run([
        [T0, report({ migrations: [job()] })],
        [T0 + MINUTE, report({ readNodeIds: [C.id], complete: false })],
      ]);

      expect(judged.running).toEqual([]);
      expect([...judged.unseen].sort()).toEqual(['running:job:job-1', 'stuck:job:job-1']);
    });

    it('is gone on a full read that no longer includes its nodes', () => {
      const judged = run([
        [T0, report({ migrations: [job()] })],
        [T0 + MINUTE, report({ readNodeIds: [C.id] })],
      ]);

      expect(judged.unseen.size).toBe(0);
      expect(judged.watch.moves.size).toBe(0);
    });

    it('is gone when one of its two nodes answers without it', () => {
      const judged = run([
        [T0, report({ migrations: [job()] })],
        [T0 + MINUTE, report({ readNodeIds: [B.id, C.id], complete: false })],
      ]);

      expect(judged.unseen.size).toBe(0);
    });

    it('keeps its quiet time across a read that could not see it', () => {
      const seen = report({ migrations: [job()] });

      const judged = run([
        [T0, seen],
        [T0 + 5 * MINUTE, report({ readNodeIds: [C.id], complete: false })],
        [T0 + 10 * MINUTE, seen],
      ]);

      expect(judged.stuck).toHaveLength(1);
    });

    it('is not judged stuck from its target alone while the snapshot arrives', () => {
      const importing = job({ state: 'importing', phase: 'receiving-snapshot' });

      const judged = run([
        [T0, report({ migrations: [importing] })],
        [T0 + 2 * ATOMIC_MIGRATION_STALL_MS, report({ migrations: [importing] })],
      ]);

      expect(judged.running).toHaveLength(1);
      expect(judged.stuck).toEqual([]);
    });

    it('is not judged stuck while its source takes the snapshot', () => {
      const snapshotting = job({ phase: 'snapshotting' });

      const judged = run([
        [T0, report({ migrations: [snapshotting] })],
        [T0 + 2 * ATOMIC_MIGRATION_STALL_MS, report({ migrations: [snapshotting] })],
      ]);

      expect(judged.running).toHaveLength(1);
      expect(judged.stuck).toEqual([]);
    });

    describe('while its target expects the snapshot', () => {
      const exported = job({ phase: 'waiting-to-snapshot' });
      const imported = job({ state: 'importing', phase: 'receiving-snapshot' });
      const both = report({ migrations: [exported], jobViews: [exported, imported] });
      const targetOnly = report({
        migrations: [imported],
        jobViews: [imported],
        jobsReadNodeIds: [B.id, C.id],
        complete: false,
      });

      it('is stuck when its source has waited 10 minutes to start the snapshot', () => {
        const judged = run([
          [T0, both],
          [T0 + ATOMIC_MIGRATION_STALL_MS, both],
        ]);

        expect(judged.stuck).toEqual([
          expect.objectContaining({ quietMs: ATOMIC_MIGRATION_STALL_MS }),
        ]);
      });

      it('is not judged stuck on what its source said before, when only the target is read', () => {
        const judged = run([
          [T0, both],
          [T0 + ATOMIC_MIGRATION_STALL_MS, targetOnly],
        ]);

        expect(judged.stuck).toEqual([]);
      });

      it('holds its stuck warning while only the target is read', () => {
        const judged = run([
          [T0, both],
          [T0 + ATOMIC_MIGRATION_STALL_MS, both],
          [T0 + ATOMIC_MIGRATION_STALL_MS + 5_000, targetOnly],
        ]);

        expect(judged.stuck).toEqual([]);
        expect([...judged.held]).toEqual(['stuck:job:job-1']);
      });
    });

    it('is not stuck while its replication backlog keeps shrinking', () => {
      const streaming = (remainingReplBytes: number) =>
        report({ migrations: [job({ phase: 'waiting-to-pause', remainingReplBytes })] });

      const judged = run([
        [T0, streaming(9_000)],
        [T0 + 4 * MINUTE, streaming(6_000)],
        [T0 + 8 * MINUTE, streaming(3_000)],
        [T0 + 12 * MINUTE, streaming(3_000)],
      ]);

      expect(judged.stuck).toEqual([]);
    });

    it('is stuck when its backlog only rises and falls above its lowest point', () => {
      const streaming = (remainingReplBytes: number) =>
        report({ migrations: [job({ phase: 'waiting-to-pause', remainingReplBytes })] });

      const judged = run([
        [T0, streaming(5_000)],
        [T0 + 3 * MINUTE, streaming(8_000)],
        [T0 + 6 * MINUTE, streaming(6_000)],
        [T0 + ATOMIC_MIGRATION_STALL_MS, streaming(5_000)],
      ]);

      expect(judged.stuck).toEqual([
        expect.objectContaining({ quietMs: ATOMIC_MIGRATION_STALL_MS }),
      ]);
    });

    it('measures the backlog afresh after a change of state', () => {
      const at = (phase: string, remainingReplBytes: number) =>
        report({ migrations: [job({ phase, remainingReplBytes })] });

      const judged = run([
        [T0, at('replicating', 1_000)],
        [T0 + MINUTE, at('waiting-to-pause', 9_000)],
        [T0 + 6 * MINUTE, at('waiting-to-pause', 8_000)],
        [T0 + 11 * MINUTE, at('waiting-to-pause', 8_000)],
      ]);

      expect(judged.stuck).toEqual([]);
    });

    it('lets a job without node names go once its node lists it as finished', () => {
      const tracked = job({
        sourceNodeId: '',
        sourceAddress: '',
        targetNodeId: '',
        targetAddress: '',
      });
      const ownNode = { readNodeIds: [C.id], complete: false, ownNodeOnly: true };

      const judged = run([
        [T0, report({ migrations: [tracked], ...ownNode })],
        [T0 + MINUTE, report({ finishedJobs: ['job-1'], ...ownNode })],
      ]);

      expect(judged.unseen.size).toBe(0);
      expect(judged.watch.moves.size).toBe(0);
    });

    it('is not judged stuck from its target alone while its source drains the backlog', () => {
      const draining = job({ phase: 'waiting-to-pause', remainingReplBytes: 9_000 });
      const waiting = job({
        state: 'importing',
        phase: 'waiting-for-paused',
        remainingReplBytes: 0,
      });
      const targetOnly = report({
        migrations: [waiting],
        jobViews: [waiting],
        jobsReadNodeIds: [B.id, C.id],
        complete: false,
      });

      const judged = run([
        [T0, report({ migrations: [draining], jobViews: [draining, waiting] })],
        [T0 + 5 * MINUTE, targetOnly],
        [T0 + ATOMIC_MIGRATION_STALL_MS, targetOnly],
      ]);

      expect(judged.running).toHaveLength(1);
      expect(judged.stuck).toEqual([]);
    });

    describe('that a replica only tracks', () => {
      const tracked = job({
        state: 'importing',
        phase: 'occurring-on-primary',
        sourceNodeId: '',
        sourceAddress: '',
        targetNodeId: '',
        targetAddress: '',
        remainingReplBytes: 0,
      });
      const ownReplica = report({
        migrations: [tracked],
        jobViews: [tracked],
        readNodeIds: [C.id],
        jobsReadNodeIds: [C.id],
        complete: false,
        ownNodeOnly: true,
      });
      const exported = job({ phase: 'waiting-to-pause' });
      const imported = job({ state: 'importing', phase: 'waiting-for-paused' });
      const both = report({ migrations: [exported], jobViews: [exported, imported] });

      it('is never judged stuck', () => {
        const judged = run([
          [T0, ownReplica],
          [T0 + 5 * MINUTE, ownReplica],
          [T0 + 2 * ATOMIC_MIGRATION_STALL_MS, ownReplica],
        ]);

        expect(judged.running).toHaveLength(1);
        expect(judged.stuck).toEqual([]);
      });

      it('holds a stuck warning while only the replica is read', () => {
        const judged = run([
          [T0, both],
          [T0 + ATOMIC_MIGRATION_STALL_MS, both],
          [T0 + ATOMIC_MIGRATION_STALL_MS + 5_000, ownReplica],
        ]);

        expect(judged.stuck).toEqual([]);
        expect([...judged.held]).toEqual(['stuck:job:job-1']);
      });

      it('is judged on its two ends once its source has been watched for 10 minutes', () => {
        const early = run([
          [T0, ownReplica],
          [T0 + MINUTE, both],
          [T0 + ATOMIC_MIGRATION_STALL_MS, both],
        ]);
        const judged = run([
          [T0, ownReplica],
          [T0 + MINUTE, both],
          [T0 + MINUTE + ATOMIC_MIGRATION_STALL_MS, both],
        ]);

        expect(early.stuck).toEqual([]);
        expect(judged.stuck).toEqual([
          expect.objectContaining({ quietMs: MINUTE + ATOMIC_MIGRATION_STALL_MS }),
        ]);
      });

      it('is not judged stuck on the first read of its two ends after the replica alone', () => {
        const draining = (remainingReplBytes: number) => {
          const exportedNow = job({ phase: 'waiting-to-pause', remainingReplBytes });
          return report({ migrations: [exportedNow], jobViews: [exportedNow, imported] });
        };

        const judged = run([
          [T0, ownReplica],
          [T0 + 5 * MINUTE, ownReplica],
          [T0 + 10 * MINUTE, ownReplica],
          [T0 + 12 * MINUTE, draining(9_000)],
        ]);

        expect(judged.stuck).toEqual([]);
      });
    });
  });

  describe('a job read from either end', () => {
    const exported = job({ phase: 'waiting-to-pause' });
    const imported = job({
      state: 'importing',
      phase: 'waiting-for-paused',
      lastUpdateAt: T0 - MINUTE,
    });
    const both = report({ migrations: [exported], jobViews: [exported, imported] });
    const sourceOnly = report({ migrations: [exported], jobViews: [exported] });
    const targetOnly = report({
      migrations: [imported],
      jobViews: [imported],
      readNodeIds: [B.id, C.id],
      complete: false,
    });

    it('is stuck when the reads keep switching between its two ends', () => {
      const judged = run([
        [T0, both],
        [T0 + 3 * MINUTE, targetOnly],
        [T0 + 6 * MINUTE, sourceOnly],
        [T0 + 9 * MINUTE, targetOnly],
        [T0 + ATOMIC_MIGRATION_STALL_MS, sourceOnly],
      ]);

      expect(judged.stuck).toEqual([
        expect.objectContaining({ quietMs: ATOMIC_MIGRATION_STALL_MS }),
      ]);
    });

    it('watches its source for 10 minutes from the first read that hears from it', () => {
      const early = run([
        [T0, targetOnly],
        [T0 + ATOMIC_MIGRATION_STALL_MS, both],
      ]);
      const judged = run([
        [T0, targetOnly],
        [T0 + ATOMIC_MIGRATION_STALL_MS, both],
        [T0 + 2 * ATOMIC_MIGRATION_STALL_MS, both],
      ]);

      expect(early.stuck).toEqual([]);
      expect(judged.stuck).toEqual([
        expect.objectContaining({ quietMs: 2 * ATOMIC_MIGRATION_STALL_MS }),
      ]);
    });

    it('is not judged stuck on the first read of its source after the target alone', () => {
      const draining = job({ phase: 'waiting-to-pause', remainingReplBytes: 9_000 });

      const judged = run([
        [T0, targetOnly],
        [T0 + 5 * MINUTE, targetOnly],
        [T0 + 10 * MINUTE, targetOnly],
        [T0 + 12 * MINUTE, report({ migrations: [draining], jobViews: [draining, imported] })],
      ]);

      expect(judged.stuck).toEqual([]);
    });

    it('may be stuck at once when its source is read again unchanged after a gap', () => {
      const judged = run([
        [T0, both],
        [T0 + 3 * MINUTE, targetOnly],
        [T0 + ATOMIC_MIGRATION_STALL_MS, both],
      ]);

      expect(judged.stuck).toHaveLength(1);
    });

    it('keeps a stuck warning from before a restart when its source is first read', () => {
      const judged = run(
        [
          [T0, targetOnly],
          [T0 + MINUTE, both],
        ],
        withAdoptedSlotMigrations(undefined, ['stuck:job:job-1']),
      );

      expect(judged.stuck).toEqual([]);
      expect([...judged.held]).toEqual(['stuck:job:job-1']);
    });

    it('moves on when one end reports a change while the other cannot be read', () => {
      const moved = job({ phase: 'waiting-to-pause', lastUpdateAt: T0 + 6 * MINUTE });
      const judged = run([
        [T0, both],
        [T0 + 5 * MINUTE, targetOnly],
        [T0 + 6 * MINUTE, report({ migrations: [moved], jobViews: [moved] })],
        [T0 + 12 * MINUTE, report({ migrations: [moved], jobViews: [moved] })],
      ]);

      expect(judged.stuck).toEqual([]);
    });

    it('keeps its stuck warning across a read that hears only from its target', () => {
      const judged = run([
        [T0, both],
        [T0 + ATOMIC_MIGRATION_STALL_MS, both],
        [T0 + ATOMIC_MIGRATION_STALL_MS + 5_000, targetOnly],
      ]);

      expect(judged.stuck).toEqual([]);
      expect([...judged.held]).toEqual(['stuck:job:job-1']);
    });
  });

  describe('a server that refuses to list atomic jobs', () => {
    const markersOnly = (overrides: Partial<SlotMigrationReport> = {}) =>
      report({ jobsReadNodeIds: [], complete: false, markersComplete: true, ...overrides });

    it('keeps an atomic job it can no longer list', () => {
      const judged = run([
        [T0, report({ migrations: [job()] })],
        [T0 + MINUTE, markersOnly()],
      ]);

      expect([...judged.unseen].sort()).toEqual(['running:job:job-1', 'stuck:job:job-1']);
    });

    it('still lets older markers that end go', () => {
      const judged = run([
        [T0, markersOnly({ migrations: [marker(10)] })],
        [T0 + MINUTE, markersOnly()],
      ]);

      expect(judged.running).toEqual([]);
      expect(judged.unseen.size).toBe(0);
    });

    it('still closes adopted entries of older markers that ended', () => {
      const adopted = withAdoptedSlotMigrations(undefined, [`running:legacy:${A.id}>${B.id}`]);

      expect(run([[T0, markersOnly()]], adopted).held.size).toBe(0);
    });

    it('does not report a failed job whose nodes it had read only for markers', () => {
      const judged = run([
        [T0, markersOnly()],
        [T0 + MINUTE, report({ failed: [failedJob()] })],
      ]);

      expect(judged.failed).toEqual([]);
    });
  });

  describe('entries open from before a restart', () => {
    const RUNNING = 'running:job:job-1';
    const STUCK = 'stuck:job:job-1';
    const adopted = (...signatures: string[]) => withAdoptedSlotMigrations(undefined, signatures);
    const unread = () => report({ readNodeIds: [C.id], complete: false });

    it('keeps a stuck warning while the job is still as it was first read', () => {
      const judged = run(
        [
          [T0, report({ migrations: [job()] })],
          [T0 + MINUTE, report({ migrations: [job()] })],
        ],
        adopted(RUNNING, STUCK),
      );

      expect(judged.stuck).toEqual([]);
      expect([...judged.held]).toEqual([STUCK]);
    });

    it('lets go of the stuck warning once the job moves', () => {
      const judged = run(
        [
          [T0, report({ migrations: [job()] })],
          [T0 + MINUTE, report({ migrations: [job({ lastUpdateAt: T0 + MINUTE })] })],
          [T0 + 2 * MINUTE, report({ migrations: [job({ lastUpdateAt: T0 + MINUTE })] })],
        ],
        adopted(STUCK),
      );

      expect(judged.held.size).toBe(0);
    });

    it('lets go of the stuck warning when a full read no longer lists the job', () => {
      const judged = run([[T0, report()]], adopted(RUNNING, STUCK));

      expect(judged.held.size).toBe(0);
      expect(judged.watch.adopted.size).toBe(0);
    });

    it('raises the job as stuck itself once it has watched it for 10 minutes', () => {
      const judged = run(
        [
          [T0, report({ migrations: [job()] })],
          [T0 + ATOMIC_MIGRATION_STALL_MS, report({ migrations: [job()] })],
        ],
        adopted(STUCK),
      );

      expect(judged.stuck).toHaveLength(1);
    });

    it('keeps a stuck warning when only the target can be read and the snapshot arrives', () => {
      const importing = job({ state: 'importing', phase: 'receiving-snapshot' });
      const targetOnly = report({ migrations: [importing], readNodeIds: [B.id], complete: false });

      const judged = run(
        [
          [T0, targetOnly],
          [T0 + 2 * ATOMIC_MIGRATION_STALL_MS, targetOnly],
        ],
        adopted(STUCK),
      );

      expect(judged.stuck).toEqual([]);
      expect([...judged.held]).toEqual([STUCK]);
    });

    it('lets go of that warning once the target reports another state', () => {
      const importing = job({ state: 'importing', phase: 'receiving-snapshot' });
      const targetOnly = (migration: SlotMigration) =>
        report({ migrations: [migration], readNodeIds: [B.id], complete: false });

      const judged = run(
        [
          [T0, targetOnly(importing)],
          [T0 + MINUTE, targetOnly({ ...importing, phase: 'waiting-for-paused' })],
        ],
        adopted(STUCK),
      );

      expect(judged.held.size).toBe(0);
    });

    it('keeps both entries while the first reads cannot see every node', () => {
      const judged = run(
        [
          [T0, unread()],
          [T0 + MINUTE, unread()],
        ],
        adopted(RUNNING, STUCK),
      );

      expect([...judged.held].sort()).toEqual([RUNNING, STUCK]);
    });

    it('closes them on the first full read that does not list the job', () => {
      const judged = run(
        [
          [T0, unread()],
          [T0 + MINUTE, report()],
        ],
        adopted(RUNNING, STUCK),
      );

      expect(judged.held.size).toBe(0);
    });

    it('keeps them when the one node it can read takes no part in the migration', () => {
      const judged = run(
        [[T0, report({ readNodeIds: [C.id], complete: false, ownNodeOnly: true })]],
        adopted(RUNNING, STUCK),
      );

      expect([...judged.held].sort()).toEqual([RUNNING, STUCK]);
    });

    it('closes them when a node it can read lists the job as finished', () => {
      const judged = run(
        [[T0, report({ readNodeIds: [A.id], complete: false, finishedJobs: ['job-1'] })]],
        adopted(RUNNING, STUCK),
      );

      expect(judged.held.size).toBe(0);
    });

    describe('for legacy markers', () => {
      const MARKERS = `running:legacy:${A.id}>${B.id}`;
      const partial = (readNodeIds: string[], ownNodeOnly = false) =>
        run([[T0, report({ readNodeIds, complete: false, ownNodeOnly })]], adopted(MARKERS));

      it('closes them when both nodes answer without the markers', () => {
        expect(partial([A.id, B.id]).held.size).toBe(0);
      });

      it('keeps them while one of the two nodes cannot be read', () => {
        expect([...partial([A.id, C.id]).held]).toEqual([MARKERS]);
      });

      it('keeps them when the one node it can read is only one of the two', () => {
        expect([...partial([A.id], true).held]).toEqual([MARKERS]);
      });

      it('keeps them when the one node it can read is neither of the two', () => {
        expect([...partial([C.id], true).held]).toEqual([MARKERS]);
      });
    });

    it('keeps the stuck warning when the job is first seen after an incomplete read', () => {
      const judged = run(
        [
          [T0, unread()],
          [T0 + MINUTE, report({ migrations: [job()] })],
        ],
        adopted(RUNNING, STUCK),
      );

      expect([...judged.held]).toEqual([STUCK]);
    });

    it('takes entries that are adopted after the watch has started', () => {
      const first = judgeSlotMigrations(undefined, report({ migrations: [job()] }), T0);

      const judged = judgeSlotMigrations(
        withAdoptedSlotMigrations(first.watch, [STUCK]),
        report({ migrations: [job()] }),
        T0 + MINUTE,
      );

      expect([...judged.held]).toEqual([STUCK]);
    });
  });

  describe('failed job', () => {
    it('is reported once when a job that was running fails', () => {
      const failed = report({ failed: [failedJob()] });

      const first = run([
        [T0, report({ migrations: [job()] })],
        [T0 + MINUTE, failed],
      ]);
      const second = run([
        [T0, report({ migrations: [job()] })],
        [T0 + MINUTE, failed],
        [T0 + 2 * MINUTE, failed],
      ]);

      expect(first.failed).toEqual([
        {
          kind: 'failed',
          signature: 'failed:job-1',
          atomic: true,
          slots: '0-100',
          sourceNodeId: A.id,
          sourceAddress: A.address,
          targetNodeId: B.id,
          targetAddress: B.address,
          reason: 'Connection lost to target',
        },
      ]);
      expect(first.running).toEqual([]);
      expect(second.failed).toEqual([]);
    });

    it('is reported when it started and failed between two reads', () => {
      const judged = run([
        [T0, report()],
        [T0 + MINUTE, report({ failed: [failedJob()] })],
      ]);

      expect(judged.failed).toHaveLength(1);
    });

    it('is not reported when it was already in the list on the first read', () => {
      const judged = run([
        [T0, report({ failed: [failedJob()] })],
        [T0 + MINUTE, report({ failed: [failedJob()] })],
      ]);

      expect(judged.failed).toEqual([]);
    });

    it('is not reported when its nodes are read for the first time', () => {
      const judged = run([
        [T0, report({ readNodeIds: [C.id], complete: false })],
        [T0 + MINUTE, report({ failed: [failedJob()] })],
      ]);

      expect(judged.failed).toEqual([]);
    });

    it('is not reported when the node that lists it is read for the first time', () => {
      const judged = run([
        [T0, report({ readNodeIds: [B.id, C.id], complete: false })],
        [T0 + MINUTE, report({ failed: [failedJob()] })],
      ]);

      expect(judged.failed).toEqual([]);
    });

    it('is reported when a node that lists it was read before', () => {
      const judged = run([
        [T0, report({ readNodeIds: [B.id, C.id], complete: false })],
        [T0 + MINUTE, report({ failed: [failedJob({ listedByNodeIds: [A.id, B.id] })] })],
      ]);

      expect(judged.failed).toHaveLength(1);
    });

    it('is still not repeated after a read that could not list it', () => {
      const judged = run([
        [T0, report()],
        [T0 + MINUTE, report({ failed: [failedJob()] })],
        [T0 + 2 * MINUTE, report({ readNodeIds: [C.id], complete: false })],
        [T0 + 3 * MINUTE, report({ failed: [failedJob()] })],
      ]);

      expect(judged.failed).toEqual([]);
    });

    it('forgets a job that a full read no longer lists', () => {
      const judged = run([
        [T0, report()],
        [T0 + MINUTE, report({ failed: [failedJob()] })],
        [T0 + 2 * MINUTE, report()],
      ]);

      expect(judged.watch.knownFailed.size).toBe(0);
    });
  });

  describe('legacy markers', () => {
    it('are one running move per pair of nodes, with their slots as ranges', () => {
      const judged = run([
        [
          T0,
          report({
            migrations: [
              marker(12),
              marker(10),
              marker(11),
              marker(20),
              marker(7, { targetNodeId: C.id, targetAddress: C.address }),
            ],
          }),
        ],
      ]);

      expect(judged.running).toEqual([
        expect.objectContaining({
          signature: `running:legacy:${A.id}>${B.id}`,
          atomic: false,
          slots: '10-12 20',
        }),
        expect.objectContaining({ signature: `running:legacy:${A.id}>${C.id}`, slots: '7' }),
      ]);
    });

    it('are stuck after 30 minutes on the same slots', () => {
      const seen = report({ migrations: [marker(10)] });

      const before = run([
        [T0, seen],
        [T0 + LEGACY_MIGRATION_STALL_MS - 1, seen],
      ]);
      const after = run([
        [T0, seen],
        [T0 + LEGACY_MIGRATION_STALL_MS, seen],
      ]);

      expect(before.stuck).toEqual([]);
      expect(after.stuck).toEqual([
        expect.objectContaining({
          kind: 'stuck',
          signature: `stuck:legacy:${A.id}>${B.id}`,
          atomic: false,
          quietMs: LEGACY_MIGRATION_STALL_MS,
        }),
      ]);
    });

    it('are not stuck while the reshard moves on to other slots', () => {
      const judged = run([
        [T0, report({ migrations: [marker(10)] })],
        [T0 + 20 * MINUTE, report({ migrations: [marker(11)] })],
        [T0 + 40 * MINUTE, report({ migrations: [marker(12)] })],
      ]);

      expect(judged.stuck).toEqual([]);
    });

    it('are kept while one of their two nodes cannot be read', () => {
      const judged = run([
        [T0, report({ migrations: [marker(10)] })],
        [T0 + MINUTE, report({ readNodeIds: [B.id, C.id], complete: false })],
      ]);

      expect([...judged.unseen]).toContain(`running:legacy:${A.id}>${B.id}`);
    });

    it('are gone when both nodes answer without them, even on a partial read', () => {
      const judged = run([
        [T0, report({ migrations: [marker(10)] })],
        [T0 + MINUTE, report({ readNodeIds: [A.id, B.id], complete: false })],
      ]);

      expect(judged.unseen.size).toBe(0);
    });

    it('are gone on a full read when their target is not a node of the cluster', () => {
      const stray = marker(10, { targetNodeId: 'c0ffee99', targetAddress: '' });

      const judged = run([
        [T0, report({ migrations: [stray] })],
        [T0 + MINUTE, report()],
      ]);

      expect(judged.unseen.size).toBe(0);
    });
  });
});

describe('describeSlotMigration', () => {
  const base = {
    atomic: true,
    slots: '0-100',
    sourceNodeId: A.id,
    sourceAddress: A.address,
    targetNodeId: B.id,
    targetAddress: B.address,
  };

  it('says a migration is running and that the entry closes by itself, without a state that goes stale', () => {
    const text = describeSlotMigration({
      ...base,
      kind: 'running',
      signature: 's',
      phase: 'snapshotting',
    });

    expect(text).toBe(
      'INFO: Slot migration running: slots 0-100 from 10.0.0.1:6379 to 10.0.0.2:6379. This entry closes when the migration ends.',
    );
  });

  it('says how long an atomic job has been quiet, what holds it back and how to cancel it', () => {
    const text = describeSlotMigration({
      ...base,
      kind: 'stuck',
      signature: 's',
      phase: 'waiting-to-pause',
      quietMs: 12 * MINUTE,
    });

    expect(text).toContain(
      'WARNING: Slot migration stuck: slots 0-100 from 10.0.0.1:6379 to 10.0.0.2:6379',
    );
    expect(text).toContain(
      'has not changed state or cut its replication backlog for 12 minutes (state: waiting-to-pause)',
    );
    expect(text).toContain(
      'Check for a save or AOF rewrite running on 10.0.0.1:6379, which holds back the snapshot, ' +
        'and for writes to these slots arriving faster than the target takes them, ' +
        'which keep the backlog from draining.',
    );
    expect(text).toContain(
      'To stop it, run CLUSTER CANCELSLOTMIGRATIONS on 10.0.0.1:6379. ' +
        'That cancels every migration that node is the source of, not only this one.',
    );
  });

  it('says how long a Redis import has kept failing, what the server said and how to cancel it', () => {
    const text = describeSlotMigration({
      ...base,
      kind: 'stuck',
      signature: 's',
      phase: 'failed',
      quietMs: 12 * MINUTE,
      importFailing: true,
      jobName: 'abc123',
      retries: 720,
      reason: 'Connection refused (state: connecting, rdb_channel_state: none)',
    });

    expect(text).toBe(
      'WARNING: Slot migration stuck: slots 0-100 from 10.0.0.1:6379 to 10.0.0.2:6379 has kept ' +
        'failing for 12 minutes, and its target has retried it 720 times. The server said: ' +
        '"Connection refused (state: connecting, rdb_channel_state: none)". Check that ' +
        '10.0.0.2:6379 can reach 10.0.0.1:6379 and log in to it, and that 10.0.0.2:6379 has the ' +
        'memory and the good replicas the import needs. To stop it, run ' +
        'CLUSTER MIGRATION CANCEL ID abc123 on 10.0.0.2:6379.',
    );
  });

  it('describes a failing Redis import without a retry count or a reason it was not given', () => {
    const text = describeSlotMigration({
      ...base,
      kind: 'stuck',
      signature: 's',
      quietMs: 10 * MINUTE,
      importFailing: true,
      jobName: 'abc123',
    });

    expect(text).toContain('has kept failing for 10 minutes. The server gave no reason.');
  });

  it('describes stuck legacy markers without the atomic cancel command', () => {
    const text = describeSlotMigration({
      ...base,
      atomic: false,
      slots: '10',
      kind: 'stuck',
      signature: 's',
      quietMs: 30 * MINUTE,
    });

    expect(text).toContain('Slot migration stuck: slot 10 from');
    expect(text).toContain('same MIGRATING or IMPORTING markers for 30 minutes');
    expect(text).not.toContain('CANCELSLOTMIGRATIONS');
  });

  it('quotes what the server said about a failed job', () => {
    const text = describeSlotMigration({
      ...base,
      kind: 'failed',
      signature: 's',
      reason: 'Connection lost to target',
    });

    expect(text).toContain(
      'WARNING: Slot migration failed: slots 0-100 from 10.0.0.1:6379 to 10.0.0.2:6379.',
    );
    expect(text).toContain('The server said: "Connection lost to target".');
  });

  it('says so when the server gave no reason', () => {
    const text = describeSlotMigration({ ...base, kind: 'failed', signature: 's', reason: '' });

    expect(text).toContain('The server gave no reason.');
  });

  it('keeps a long or multi-line server message on one short line', () => {
    const text = describeSlotMigration({
      ...base,
      kind: 'failed',
      signature: 's',
      reason: `line one\nline two ${'x'.repeat(400)}`,
    });

    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThan(500);
  });

  it('names a node by its id when its address is not known', () => {
    const text = describeSlotMigration({
      ...base,
      kind: 'running',
      signature: 's',
      targetAddress: '',
      targetNodeId: 'c0ffee99aabbccdd',
    });

    expect(text).toContain('to node c0ffee99');
  });
});
