import type { RebalancePlan } from '../rebalance-planner';
import {
  executionBlocker,
  followRun,
  isRunKept,
  migrateSlotsArgs,
  parseConfirmedMoves,
  recheckFailure,
  sameMoves,
  startRun,
  withOutcome,
  type RunNode,
  type RunReport,
} from '../slot-rebalance-run';

const plan = (overrides: Partial<RebalancePlan> = {}): RebalancePlan => ({
  kind: 'plan',
  action: 'spread',
  effect: 'resolves',
  sourceShardId: 'src',
  moves: [
    {
      targetShardId: 'tgt1',
      targetAddr: '10.0.0.2:6379',
      ranges: [
        [0, 99],
        [200, 200],
      ],
      slotCount: 101,
      keyCount: 1000,
      cpuUsecPerSecond: 1000,
      shareOfShard: 0.2,
    },
    {
      targetShardId: 'tgt2',
      targetAddr: '10.0.0.3:6379',
      ranges: [[300, 399]],
      slotCount: 100,
      keyCount: 900,
      cpuUsecPerSecond: 900,
      shareOfShard: 0.18,
    },
  ],
  pinnedSlots: [],
  projection: [
    {
      shardId: 'src',
      nodeAddr: '10.0.0.1:6379',
      role: 'source',
      before: { cpuUsecPerSecond: 5000, share: 0.5, ratio: 2.5 },
      after: { cpuUsecPerSecond: 3100, share: 0.31, ratio: 1.2 },
    },
  ],
  medianBefore: 2000,
  medianAfter: 2600,
  warnings: [],
  plannedAfter: [],
  support: 'valkey_atomic',
  commands: [],
  ...overrides,
});

const node = (id: string, slots: number[][], overrides: Partial<RunNode> = {}): RunNode => ({
  id,
  role: 'master',
  state: 'healthy',
  slots,
  ...overrides,
});

const nodes = (): RunNode[] => [
  node('src', [
    [0, 299],
    [300, 5460],
  ]),
  node('tgt1', [[5461, 10922]]),
  node('tgt2', [[10923, 16383]]),
  node('rep', [], { role: 'replica' }),
];

const report = (overrides: Partial<RunReport> = {}): RunReport => ({
  jobViews: [],
  finishedJobs: [],
  failed: [],
  ...overrides,
});

const view = (jobName: string, target: string, slotRange: string, phase = 'snapshotting') => ({
  jobName,
  sourceNodeId: 'src',
  targetNodeId: target,
  slotRange,
  phase,
});

describe('slot rebalance run', () => {
  describe('executionBlocker', () => {
    const allowed = { enabled: true, dialed: true, migrationRunning: false };

    it('allows a Valkey 9 plan with the switch on, nodes dialled and nothing running', () => {
      expect(executionBlocker(plan(), allowed)).toBeUndefined();
    });

    it('names the first thing that blocks a run', () => {
      expect(executionBlocker(plan(), { ...allowed, enabled: false })).toBe('flag_off');
      expect(executionBlocker(plan(), { ...allowed, dialed: false })).toBe('not_dialed');
      expect(executionBlocker(plan({ support: 'provider_managed' }), allowed)).toBe(
        'provider_managed',
      );
      expect(executionBlocker(plan({ support: 'redis_atomic' }), allowed)).toBe(
        'unsupported_server',
      );
      expect(executionBlocker(plan({ support: 'none' }), allowed)).toBe('unsupported_server');
      expect(executionBlocker(plan({ support: undefined }), allowed)).toBe('unsupported_server');
      expect(executionBlocker(plan(), { ...allowed, migrationRunning: true })).toBe(
        'migration_running',
      );
    });
  });

  describe('sameMoves', () => {
    const confirmed = () =>
      plan().moves.map((move) => ({ targetShardId: move.targetShardId, ranges: move.ranges }));

    it('matches the moves the admin confirmed', () => {
      expect(sameMoves(plan(), confirmed())).toBe(true);
    });

    it('refuses a different target, range or move count', () => {
      const moved = confirmed();
      moved[0] = { ...moved[0], targetShardId: 'other' };
      expect(sameMoves(plan(), moved)).toBe(false);
      const widened = confirmed();
      widened[1] = { ...widened[1], ranges: [[300, 400]] };
      expect(sameMoves(plan(), widened)).toBe(false);
      expect(sameMoves(plan(), confirmed().slice(0, 1))).toBe(false);
    });
  });

  describe('parseConfirmedMoves', () => {
    it('reads the moves the admin confirmed', () => {
      expect(
        parseConfirmedMoves({ moves: [{ targetShardId: 'tgt1', ranges: [[0, 99], [200, 200]] }] }),
      ).toEqual([
        {
          targetShardId: 'tgt1',
          ranges: [
            [0, 99],
            [200, 200],
          ],
        },
      ]);
    });

    it('refuses a body that is not a list of targets with slot ranges', () => {
      expect(parseConfirmedMoves(undefined)).toBeNull();
      expect(parseConfirmedMoves({ moves: [] })).toBeNull();
      expect(parseConfirmedMoves({ moves: [{ targetShardId: '', ranges: [[0, 1]] }] })).toBeNull();
      expect(parseConfirmedMoves({ moves: [{ targetShardId: 't', ranges: [] }] })).toBeNull();
      expect(parseConfirmedMoves({ moves: [{ targetShardId: 't', ranges: [[5, 1]] }] })).toBeNull();
      expect(parseConfirmedMoves({ moves: [{ targetShardId: 't', ranges: [[0, 16384]] }] })).toBeNull();
      expect(parseConfirmedMoves({ moves: [{ targetShardId: 't', ranges: [[0.5, 1]] }] })).toBeNull();
    });
  });

  describe('migrateSlotsArgs', () => {
    it('builds one MIGRATESLOTS with a SLOTSRANGE block per target', () => {
      expect(migrateSlotsArgs(plan())).toEqual([
        'MIGRATESLOTS',
        'SLOTSRANGE',
        '0',
        '99',
        '200',
        '200',
        'NODE',
        'tgt1',
        'SLOTSRANGE',
        '300',
        '399',
        'NODE',
        'tgt2',
      ]);
    });
  });

  describe('recheckFailure', () => {
    it('passes when the source owns every range and all are healthy primaries', () => {
      expect(recheckFailure(plan(), nodes())).toBeUndefined();
    });

    it('fails when the source no longer owns a range', () => {
      const moved = nodes();
      moved[0] = node('src', [[0, 250]]);
      expect(recheckFailure(plan(), moved)).toBe('slots_moved');
    });

    it('fails when the source or a target is not a healthy primary', () => {
      const suspect = nodes();
      suspect[0] = { ...suspect[0], state: 'suspect' };
      expect(recheckFailure(plan(), suspect)).toBe('source_unhealthy');
      const demoted = nodes();
      demoted[2] = { ...demoted[2], role: 'replica' };
      expect(recheckFailure(plan(), demoted)).toBe('target_unhealthy');
      expect(recheckFailure(plan(), nodes().filter((n) => n.id !== 'tgt1'))).toBe(
        'target_unhealthy',
      );
    });
  });

  describe('followRun', () => {
    const started = () =>
      startRun(plan(), { userId: 'u1', email: 'admin@example.com' }, 1_000);

    it('starts with every job pending and the projected source ratio', () => {
      const run = started();
      expect(run.state).toBe('running');
      expect(run.projectedRatio).toBe(1.2);
      expect(run.jobs.map((job) => [job.targetShardId, job.state])).toEqual([
        ['tgt1', 'starting'],
        ['tgt2', 'starting'],
      ]);
    });

    it('names the jobs it finds by source, target and slots', () => {
      const run = followRun(
        started(),
        report({
          jobViews: [
            view('job-a', 'tgt1', '0-99 200-200'),
            view('job-b', 'tgt2', '300-399'),
            view('job-c', 'tgt2', '9000-9001'),
          ],
        }),
        nodes(),
        2_000,
      );
      expect(run.jobs.map((job) => [job.jobName, job.state, job.phase])).toEqual([
        ['job-a', 'running', 'snapshotting'],
        ['job-b', 'running', 'snapshotting'],
      ]);
      expect(run.state).toBe('running');
    });

    it('calls a finished job a success only when the target owns its slots', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const after = nodes();
      after[0] = node('src', [
        [100, 199],
        [201, 5460],
      ]);
      after[1] = node('tgt1', [
        [0, 99],
        [200, 200],
        [5461, 10922],
      ]);
      const run = followRun(
        listed,
        report({ finishedJobs: ['job-a', 'job-b'] }),
        after,
        3_000,
      );
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'cancelled']);
      expect(run.state).toBe('cancelled');
      expect(run.endedAt).toBe(3_000);
    });

    it('ends as succeeded when every job succeeded', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const after = [
        node('src', [
          [100, 199],
          [201, 299],
          [400, 5460],
        ]),
        node('tgt1', [
          [0, 99],
          [200, 200],
          [5461, 10922],
        ]),
        node('tgt2', [
          [300, 399],
          [10923, 16383],
        ]),
      ];
      const run = followRun(listed, report({ finishedJobs: ['job-a', 'job-b'] }), after, 3_000);
      expect(run.state).toBe('succeeded');
    });

    it('reports a failed job with the server message', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const run = followRun(
        listed,
        report({
          jobViews: [view('job-b', 'tgt2', '300-399')],
          finishedJobs: ['job-a'],
          failed: [{ jobName: 'job-a', message: 'target refused' }],
        }),
        nodes(),
        3_000,
      );
      expect(run.jobs[0]).toMatchObject({ state: 'failed', message: 'target refused' });
      expect(run.state).toBe('running');
    });

    it('compares the projected and actual source ratio once the load settled', () => {
      const succeeded = { ...started(), state: 'succeeded' as const, endedAt: 10_000 };
      const shard = (nodeId: string, cpuUsecPerSecond: number) => ({
        nodeId,
        address: '',
        slotCount: 100,
        measuredSlots: 100,
        cpuUsecPerSecond,
        networkBytesInPerSecond: 0,
        networkBytesOutPerSecond: 0,
        cpuShare: null,
        networkShare: null,
      });
      const sample = (timestamp: number, settling = false) => ({
        timestamp,
        settling,
        shards: [shard('src', 300_000), shard('tgt1', 200_000), shard('tgt2', 250_000)],
      });
      expect(withOutcome(succeeded, sample(69_999)).outcome).toBeUndefined();
      expect(withOutcome(succeeded, sample(70_000, true)).outcome).toBeUndefined();
      expect(withOutcome(succeeded, sample(70_000)).outcome).toEqual({
        projectedRatio: 1.2,
        actualRatio: 1.2,
        measuredAt: 70_000,
      });
      expect(withOutcome({ ...succeeded, state: 'cancelled' }, sample(70_000)).outcome).toBeUndefined();
    });

    it('keeps a run for an hour after it ends', () => {
      const ended = { ...started(), state: 'succeeded' as const, endedAt: 10_000 };
      expect(isRunKept(ended, 10_000 + 3_599_999)).toBe(true);
      expect(isRunKept(ended, 10_000 + 3_600_000)).toBe(false);
      expect(isRunKept(started(), 1_000 + 3_599_999)).toBe(true);
    });

    const movedNodes = () => [
      node('src', [
        [100, 199],
        [201, 299],
        [400, 5460],
      ]),
      node('tgt1', [
        [0, 99],
        [200, 200],
        [5461, 10922],
      ]),
      node('tgt2', [
        [300, 399],
        [10923, 16383],
      ]),
    ];

    it('calls a job that finished before it was listed a success once the target owns its slots', () => {
      const run = followRun(started(), report({ finishedJobs: ['job-a', 'job-b'] }), movedNodes(), 2_000);
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'succeeded']);
      expect(run.state).toBe('succeeded');
      expect(run.endedAt).toBe(2_000);
    });

    it('does not take a finished job from another target as this one', () => {
      const partly = movedNodes();
      partly[0] = node('src', [
        [100, 199],
        [201, 5460],
      ]);
      partly[2] = node('tgt2', [[10923, 16383]]);
      const run = followRun(started(), report({ finishedJobs: ['job-a'] }), partly, 2_000);
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'starting']);
      expect(run.state).toBe('running');
    });

    it('matches a failure it never saw listed by source, target and slots', () => {
      const run = followRun(
        started(),
        report({
          finishedJobs: ['job-b'],
          failed: [
            {
              jobName: 'job-b',
              message: 'target refused',
              sourceNodeId: 'src',
              targetNodeId: 'tgt2',
              slotRange: '300-399',
            },
          ],
        }),
        nodes(),
        2_000,
      );
      expect(run.jobs[1]).toMatchObject({ state: 'failed', jobName: 'job-b', message: 'target refused' });
      expect(run.jobs[0].state).toBe('starting');
    });

    it('ignores a failure that was listed before the run started', () => {
      const before = startRun(plan(), { userId: 'u1', email: null }, 1_000, ['old-job']);
      const run = followRun(
        before,
        report({
          finishedJobs: ['old-job'],
          failed: [
            {
              jobName: 'old-job',
              message: 'earlier failure',
              sourceNodeId: 'src',
              targetNodeId: 'tgt2',
              slotRange: '300-399',
            },
          ],
        }),
        nodes(),
        2_000,
      );
      expect(run.jobsBefore).toEqual(['old-job']);
      expect(run.jobs[1].state).toBe('starting');
    });

    it('keeps an unlisted job starting for a minute, then unknown', () => {
      expect(followRun(started(), report(), nodes(), 61_000).jobs[0].state).toBe('starting');
      const lost = followRun(started(), report(), nodes(), 61_001);
      expect(lost.jobs[0].state).toBe('unknown');
      expect(lost.state).toBe('unknown');
    });
  });
});
