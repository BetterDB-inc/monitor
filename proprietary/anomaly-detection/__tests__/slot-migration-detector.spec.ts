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
    phase: 'snapshotting',
    jobName: 'job-1',
    lastUpdateAt: T0,
    lastAckAt: T0,
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
    ...overrides,
  };
}

function report(overrides: Partial<SlotMigrationReport> = {}): SlotMigrationReport {
  return {
    migrations: [],
    failed: [],
    readNodeIds: ALL,
    complete: true,
    ownNodeOnly: false,
    ...overrides,
  };
}

function run(steps: Array<[number, SlotMigrationReport]>): SlotMigrationJudgement {
  let watch: SlotMigrationWatch | undefined;
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
          phase: 'snapshotting',
        },
      ]);
      expect(judged.stuck).toEqual([]);
    });

    it('is stuck after 10 minutes with the same state, update time and heartbeat', () => {
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
          phase: 'snapshotting',
        }),
      ]);
      expect(after.running).toHaveLength(1);
    });

    it.each([
      ['a heartbeat', { lastAckAt: T0 + 9 * MINUTE }],
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

    it('is never judged stuck when the server sends neither time', () => {
      const untimed = job({ lastUpdateAt: undefined, lastAckAt: undefined });

      const judged = run([
        [T0, report({ migrations: [untimed] })],
        [T0 + 60 * MINUTE, report({ migrations: [untimed] })],
      ]);

      expect(judged.running).toHaveLength(1);
      expect(judged.stuck).toEqual([]);
    });

    it('is still judged when the server sends only one of the two times', () => {
      const heartbeatOnly = job({ lastUpdateAt: undefined });

      const judged = run([
        [T0, report({ migrations: [heartbeatOnly] })],
        [T0 + ATOMIC_MIGRATION_STALL_MS, report({ migrations: [heartbeatOnly] })],
      ]);

      expect(judged.stuck).toHaveLength(1);
    });

    it('measures the quiet time on the monitor clock, not against the server times', () => {
      const skewed = job({ lastUpdateAt: T0 - 60 * MINUTE, lastAckAt: T0 - 60 * MINUTE });

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
        [T0 + 11 * MINUTE, report({ migrations: [job({ lastAckAt: T0 + 11 * MINUTE })] })],
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

  it('says a migration is running and that the entry closes by itself', () => {
    const text = describeSlotMigration({
      ...base,
      kind: 'running',
      signature: 's',
      phase: 'snapshotting',
    });

    expect(text).toBe(
      'INFO: Slot migration running: slots 0-100 from 10.0.0.1:6379 to 10.0.0.2:6379 (state: snapshotting). This entry closes when the migration ends.',
    );
  });

  it('says how long an atomic job has been quiet and how to cancel it', () => {
    const text = describeSlotMigration({
      ...base,
      kind: 'stuck',
      signature: 's',
      phase: 'snapshotting',
      quietMs: 12 * MINUTE,
    });

    expect(text).toContain(
      'WARNING: Slot migration stuck: slots 0-100 from 10.0.0.1:6379 to 10.0.0.2:6379',
    );
    expect(text).toContain('no state change and no heartbeat for 12 minutes (state: snapshotting)');
    expect(text).toContain(
      'To stop it, run CLUSTER CANCELSLOTMIGRATIONS on 10.0.0.1:6379. ' +
        'That cancels every migration that node is the source of, not only this one.',
    );
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
