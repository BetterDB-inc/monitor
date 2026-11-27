import type { RebalancePlan } from '../rebalance-planner';
import {
  executionBlocker,
  cancelledFailure,
  followRun,
  runView,
  isRunKept,
  migrateSlotsArgs,
  parseConfirmedMoves,
  REBALANCE_JOB_LISTING_GRACE_MS,
  recheckFailure,
  sameMoves,
  startRun,
  withOutcome,
  REBALANCE_OUTCOME_WAIT_MS,
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

const cancelled = <T extends object>(run: T, at: number) => ({
  ...run,
  cancelRequestedAt: at,
  cancelAcceptedAt: at,
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

    it('names a plan the server cannot run before the missing node connections', () => {
      const undialled = { ...allowed, dialed: false };
      expect(executionBlocker(plan({ support: 'redis_atomic' }), undialled)).toBe('unsupported_server');
      expect(executionBlocker(plan({ support: 'provider_managed' }), undialled)).toBe(
        'provider_managed',
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
      const finished = report({ finishedJobs: ['job-a', 'job-b'] });
      const waiting = followRun(listed, finished, after, 3_000);
      expect(waiting.jobs.map((job) => job.state)).toEqual(['succeeded', 'running']);
      expect(waiting.state).toBe('running');
      expect(followRun(waiting, finished, after, 62_999).state).toBe('running');
      const run = followRun(waiting, finished, after, 63_000);
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'cancelled']);
      expect(run.state).toBe('cancelled');
      expect(run.endedAt).toBe(63_000);
    });

    it('waits for the slots to show on the target after a job is listed as finished', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const finished = report({ finishedJobs: ['job-a', 'job-b'] });
      const stale = followRun(listed, finished, nodes(), 3_000);
      expect(stale.jobs.map((job) => job.state)).toEqual(['running', 'running']);
      const run = followRun(stale, finished, movedNodes(), 8_000);
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'succeeded']);
      expect(run.state).toBe('succeeded');
    });

    it('does not take a job listed before the run for one of its own', () => {
      const before = startRun(plan(), { userId: 'u1', email: null }, 1_000, ['old-job']);
      const run = followRun(
        before,
        report({ jobViews: [view('old-job', 'tgt2', '300-399', 'failing')] }),
        nodes(),
        2_000,
      );
      expect(run.jobs[1]).toMatchObject({ state: 'starting' });
      expect(run.jobs[1].jobName).toBeUndefined();
    });

    it('takes no failure without slot ranges for a job that holds slot 0', () => {
      const run = followRun(
        started(),
        report({
          failed: [
            { jobName: 'job-x', message: 'other', sourceNodeId: 'src', targetNodeId: 'tgt1', slotRange: '' },
          ],
        }),
        nodes(),
        2_000,
      );
      expect(run.jobs[0].state).toBe('starting');
      const cancelling = cancelled(started(), 1_500);
      for (const slots of ['', '  ']) {
        expect(
          cancelledFailure(cancelling, { jobName: 'job-x', sourceNodeId: 'src', targetNodeId: 'tgt1', slots }, 2_000),
        ).toBeUndefined();
      }
    });

    it('matches a listed range that spans adjacent ranges of the move', () => {
      const split = plan({
        moves: [
          {
            ...plan().moves[0],
            ranges: [
              [0, 49],
              [50, 99],
            ],
          },
        ],
      });
      const run = followRun(
        startRun(split, { userId: 'u1', email: null }, 1_000),
        report({ jobViews: [view('job-a', 'tgt1', '0-99')] }),
        nodes(),
        2_000,
      );
      expect(run.jobs[0]).toMatchObject({ jobName: 'job-a', state: 'running' });
    });

    it('calls a named job a success once the target owns its slots, with no history left', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const run = followRun(listed, report(), movedNodes(), 3_000);
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'succeeded']);
      expect(run.state).toBe('succeeded');
    });

    it('keeps the server message of a job that failed before the cancel', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const run = followRun(
        { ...cancelled(listed, 2_500), failedBeforeCancel: ['job-a'] },
        report({
          finishedJobs: ['job-a', 'job-b'],
          failed: [
            { jobName: 'job-a', message: 'target refused' },
            { jobName: 'job-b', message: 'Connection lost to source' },
          ],
        }),
        nodes(),
        3_000,
      );
      expect(run.jobs.map((job) => [job.state, job.message])).toEqual([
        ['failed', 'target refused'],
        ['cancelled', undefined],
      ]);
      const failure = (jobName: string) => ({ jobName, sourceNodeId: 'src', targetNodeId: 'tgt1', slots: '0-99' });
      expect(
        cancelledFailure({ ...cancelled(listed, 2_500), failedBeforeCancel: ['job-a'] }, failure('job-a'), 3_000),
      ).toBeUndefined();
    });

    it('follows a named job by its name only', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const run = followRun(
        listed,
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-z', 'tgt2', '300-399')] }),
        nodes(),
        3_000,
      );
      expect(run.jobs[1]).toMatchObject({ jobName: 'job-b', state: 'unknown' });
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
        sustainCpuUsecPerSecond: cpuUsecPerSecond,
        baselineCpuUsecPerSecond: cpuUsecPerSecond,
        sustainReset: false,
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
      expect(withOutcome(succeeded, sample(69_999), 69_999).outcome).toBeUndefined();
      expect(withOutcome(succeeded, sample(70_000, true), 70_000).outcome).toBeUndefined();
      expect(withOutcome(succeeded, sample(70_000), 70_000).outcome).toEqual({
        projectedRatio: 1.2,
        actualRatio: 1.2,
        measuredAt: 70_000,
      });
      expect(withOutcome({ ...succeeded, state: 'cancelled' }, sample(70_000), 70_000).outcome).toBeUndefined();
    });

    it('gives up on the outcome when no settled sample measured the hot shard in time', () => {
      const succeeded = { ...started(), state: 'succeeded' as const, endedAt: 10_000 };
      const due = 10_000 + REBALANCE_OUTCOME_WAIT_MS;
      expect(withOutcome(succeeded, null, due - 1).outcomeUnavailable).toBeUndefined();
      const run = withOutcome(succeeded, null, due);
      expect(run.outcomeUnavailable).toBe(true);
      expect(run.outcome).toBeUndefined();
      expect(runView(run).outcomeUnavailable).toBe(true);
      expect(withOutcome({ ...succeeded, state: 'cancelled' }, null, due).outcomeUnavailable).toBeUndefined();
    });

    it('keeps a run for an hour after it ends', () => {
      const ended = { ...started(), state: 'succeeded' as const, endedAt: 10_000 };
      expect(isRunKept(ended, 10_000 + 3_599_999)).toBe(true);
      expect(isRunKept(ended, 10_000 + 3_600_000)).toBe(false);
      expect(isRunKept(started(), 1_000 + 3_599_999)).toBe(true);
    });

    it('keeps a run that has not ended however long it runs', () => {
      expect(isRunKept(started(), 1_000 + 2 * 3_600_000)).toBe(true);
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

    it('follows the jobs on an incomplete read when the nodes of the run answered', () => {
      const run = followRun(
        started(),
        report({
          complete: false,
          jobsReadNodeIds: ['src', 'tgt1', 'tgt2'],
          jobViews: [view('job-a', 'tgt1', '0-99 200-200')],
        }),
        nodes(),
        2_000,
      );
      expect(run.jobs[0]).toMatchObject({ jobName: 'job-a', state: 'running' });
    });

    it('ends a job on slot ownership alone when a node of the run did not answer', () => {
      const run = followRun(
        started(),
        report({ complete: false, jobsReadNodeIds: ['src', 'tgt1'] }),
        movedNodes(),
        2_000,
      );
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'succeeded']);
      expect(run.state).toBe('succeeded');
    });

    it('keeps a job as it is when a node of the run did not answer and nothing moved', () => {
      const run = followRun(
        started(),
        report({ complete: false, jobsReadNodeIds: ['tgt1', 'tgt2'] }),
        nodes(),
        1_000 + REBALANCE_JOB_LISTING_GRACE_MS + 1,
      );
      expect(run.jobs.map((job) => job.state)).toEqual(['starting', 'starting']);
      expect(run.state).toBe('running');
    });

    it('ends a job as unknown after a minute of reads that missed its nodes', () => {
      const missed = report({ complete: false, jobsReadNodeIds: ['tgt1', 'tgt2'] });
      const first = followRun(started(), missed, nodes(), 2_000);
      const waiting = followRun(first, missed, nodes(), 2_000 + REBALANCE_JOB_LISTING_GRACE_MS - 1);
      expect(waiting.jobs.map((job) => job.state)).toEqual(['starting', 'starting']);
      const run = followRun(waiting, missed, nodes(), 2_000 + REBALANCE_JOB_LISTING_GRACE_MS);
      expect(run.jobs.map((job) => job.state)).toEqual(['unknown', 'unknown']);
      expect(run.state).toBe('unknown');
      expect(run.endedAt).toBe(2_000 + REBALANCE_JOB_LISTING_GRACE_MS);
    });

    it('counts the minute again once the nodes of the run answer', () => {
      const missed = report({ complete: false, jobsReadNodeIds: ['tgt1', 'tgt2'] });
      const first = followRun(started(), missed, nodes(), 2_000);
      const answered = followRun(
        first,
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        3_000,
      );
      const again = followRun(answered, missed, nodes(), 4_000);
      const run = followRun(again, missed, nodes(), 2_000 + REBALANCE_JOB_LISTING_GRACE_MS);
      expect(run.jobs.map((job) => job.state)).toEqual(['running', 'running']);
    });

    it('keeps a job running past the minute while the source lists it and its target is silent', () => {
      const sourceOnly = report({
        complete: false,
        jobsReadNodeIds: ['src'],
        jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')],
      });
      const first = followRun(started(), sourceOnly, nodes(), 2_000);
      const run = followRun(first, sourceOnly, nodes(), 2_000 + REBALANCE_JOB_LISTING_GRACE_MS);
      expect(run.jobs).toMatchObject([
        { jobName: 'job-a', state: 'running', phase: 'snapshotting' },
        { jobName: 'job-b', state: 'running', phase: 'snapshotting' },
      ]);
      expect(run.state).toBe('running');
    });

    it('ends a job as cancelled on an accepted cancel once the source owns its slots, with its nodes silent', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const run = followRun(
        cancelled(listed, 2_500),
        report({ complete: false, jobsReadNodeIds: ['tgt1'] }),
        nodes(),
        3_000,
      );
      expect(run.jobs.map((job) => job.state)).toEqual(['cancelled', 'cancelled']);
      expect(run.state).toBe('cancelled');
    });

    it('follows a job whose source and target answered while another target did not', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const run = followRun(
        listed,
        report({
          complete: false,
          jobsReadNodeIds: ['src', 'tgt1'],
          failed: [
            {
              jobName: 'job-a',
              message: 'target refused',
              sourceNodeId: 'src',
              targetNodeId: 'tgt1',
              slotRange: '0-99 200-200',
            },
          ],
        }),
        nodes(),
        3_000,
      );
      expect(run.jobs.map((job) => job.state)).toEqual(['failed', 'running']);
      expect(run.jobs[0].message).toBe('target refused');
    });

    it('takes a listed failure of a job whose source did not answer', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200')] }),
        nodes(),
        2_000,
      );
      const run = followRun(
        listed,
        report({
          complete: false,
          jobsReadNodeIds: ['tgt1'],
          failed: [{ jobName: 'job-a', message: 'target refused' }],
        }),
        nodes(),
        3_000,
      );
      expect(run.jobs[0]).toMatchObject({ state: 'failed', message: 'target refused' });
    });

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

    const cancelledReport = () =>
      report({
        finishedJobs: ['job-a', 'job-b'],
        cancelledJobs: ['job-a', 'job-b'],
        failed: [
          {
            jobName: 'job-a',
            message: 'Connection lost to source',
            sourceNodeId: 'src',
            targetNodeId: 'tgt1',
            slotRange: '0-99 200-200',
          },
        ],
      });

    it('ends a job it cancelled as cancelled although the import lists it as failed', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const run = followRun(cancelled(listed, 2_500), cancelledReport(), nodes(), 3_000);
      expect(run.jobs.map((job) => job.state)).toEqual(['cancelled', 'cancelled']);
      expect(run.state).toBe('cancelled');
    });

    const listedBoth = () =>
      followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );

    it('keeps following a move that finished after an accepted cancel until the target owns its slots', () => {
      const finished = report({ finishedJobs: ['job-a', 'job-b'] });
      const stale = followRun(cancelled(listedBoth(), 2_500), finished, nodes(), 3_000);
      expect(stale.jobs.map((job) => job.state)).toEqual(['running', 'running']);
      expect(stale.state).toBe('running');
      const run = followRun(stale, finished, movedNodes(), 4_000);
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'succeeded']);
      expect(run.state).toBe('succeeded');
    });

    it('ends a move as cancelled when the server lists it as cancelled', () => {
      const run = followRun(
        cancelled(listedBoth(), 2_500),
        report({ finishedJobs: ['job-a', 'job-b'], cancelledJobs: ['job-a', 'job-b'] }),
        nodes(),
        3_000,
      );
      expect(run.jobs.map((job) => job.state)).toEqual(['cancelled', 'cancelled']);
      expect(run.state).toBe('cancelled');
    });

    it('keeps following a move seen finished when its nodes go silent after an accepted cancel', () => {
      const seenFinished = followRun(
        listedBoth(),
        report({ finishedJobs: ['job-a', 'job-b'] }),
        nodes(),
        2_200,
      );
      const silent = report({ complete: false, jobsReadNodeIds: [] });
      const stale = followRun(cancelled(seenFinished, 2_500), silent, nodes(), 3_000);
      expect(stale.jobs.map((job) => job.state)).toEqual(['running', 'running']);
      const run = followRun(stale, silent, movedNodes(), 4_000);
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'succeeded']);
    });

    it('keeps a job that failed before the cancel as failed', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const oneFailed = followRun(
        listed,
        report({
          jobViews: [view('job-b', 'tgt2', '300-399')],
          finishedJobs: ['job-a'],
          failed: [{ jobName: 'job-a', message: 'target refused' }],
        }),
        nodes(),
        3_000,
      );
      const run = followRun(
        cancelled(oneFailed, 3_500),
        report({
          finishedJobs: ['job-a', 'job-b'],
          failed: [
            { jobName: 'job-a', message: 'target refused' },
            { jobName: 'job-b', message: 'Connection lost to source' },
          ],
        }),
        nodes(),
        4_000,
      );
      expect(run.jobs.map((job) => [job.state, job.message])).toEqual([
        ['failed', 'target refused'],
        ['cancelled', undefined],
      ]);
      expect(run.state).toBe('failed');
    });

    it('calls a job failed when no cancel was asked for', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      expect(followRun(listed, cancelledReport(), nodes(), 3_000).jobs[0]).toMatchObject({
        state: 'failed',
        message: 'Connection lost to source',
      });
    });

    it('keeps a job that moved before the cancel as succeeded', () => {
      const run = followRun(cancelled(started(), 1_500), report(), movedNodes(), 2_000);
      expect(run.state).toBe('succeeded');
    });

    it('does not follow a run while its cancel has not answered', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const pending = { ...listed, cancelRequestedAt: 2_500 };
      expect(followRun(pending, cancelledReport(), nodes(), 3_000)).toBe(pending);
      expect(followRun(pending, cancelledReport(), nodes(), 12_499)).toBe(pending);
    });

    it('follows a run again once a cancel that never answered is stale', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const run = followRun(
        { ...listed, cancelRequestedAt: 2_500 },
        report({ finishedJobs: ['job-a', 'job-b'] }),
        movedNodes(),
        12_500,
      );
      expect(run.state).toBe('succeeded');
    });

    it('keeps waiting for a job that finished before the cancel was accepted', () => {
      const listed = followRun(
        started(),
        report({ jobViews: [view('job-a', 'tgt1', '0-99 200-200'), view('job-b', 'tgt2', '300-399')] }),
        nodes(),
        2_000,
      );
      const finished = report({ finishedJobs: ['job-a', 'job-b'] });
      const waiting = followRun(listed, finished, nodes(), 3_000);
      const stale = followRun(cancelled(waiting, 3_500), finished, nodes(), 4_000);
      expect(stale.jobs.map((job) => job.state)).toEqual(['running', 'running']);
      const run = followRun(stale, finished, movedNodes(), 9_000);
      expect(run.jobs.map((job) => job.state)).toEqual(['succeeded', 'succeeded']);
      expect(run.state).toBe('succeeded');
    });

    const failure = (jobName: string, targetNodeId: string, slots: string) => ({
      jobName,
      sourceNodeId: 'src',
      targetNodeId,
      slots,
    });
    const named = () => ({
      ...started(),
      cancelRequestedAt: 2_000,
      cancelAcceptedAt: 2_100,
      jobs: started().jobs.map((job, index) => (index === 0 ? { ...job, jobName: 'job-a' } : job)),
      jobsBefore: ['old-job'],
    });

    it('knows a failure as one of its own cancelled jobs', () => {
      const run = named();
      expect(cancelledFailure(run, failure('job-a', 'tgt1', '0-99'), 3_000)).toBe('cancelled');
      expect(cancelledFailure(run, failure('job-x', 'tgt1', '0-99'), 3_000)).toBeUndefined();
      expect(cancelledFailure(run, failure('job-b', 'tgt2', '300-399'), 3_000)).toBe('cancelled');
      expect(cancelledFailure(run, failure('old-job', 'tgt2', '300-399'), 3_000)).toBeUndefined();
      expect(cancelledFailure(run, failure('job-b', 'tgt2', '300-400'), 3_000)).toBeUndefined();
      expect(
        cancelledFailure(
          { ...run, cancelRequestedAt: undefined, cancelAcceptedAt: undefined },
          failure('job-a', 'tgt1', '0-99'),
          3_000,
        ),
      ).toBeUndefined();
    });

    it('holds a failure of its own while the cancel has not answered', () => {
      const pending = { ...named(), cancelAcceptedAt: undefined };
      expect(cancelledFailure(pending, failure('job-a', 'tgt1', '0-99'), 3_000)).toBe('cancel_pending');
      expect(cancelledFailure(pending, failure('job-b', 'tgt2', '300-399'), 3_000)).toBe(
        'cancel_pending',
      );
    });

    it('matches a failure with no job name of its own only for a minute after the run ended', () => {
      const ended = { ...named(), state: 'cancelled' as const, endedAt: 3_000 };
      const later = 3_000 + REBALANCE_JOB_LISTING_GRACE_MS;
      expect(cancelledFailure(ended, failure('job-b', 'tgt2', '300-399'), later - 1)).toBe('cancelled');
      expect(cancelledFailure(ended, failure('job-b', 'tgt2', '300-399'), later)).toBeUndefined();
      expect(cancelledFailure(ended, failure('job-a', 'tgt1', '0-99'), later)).toBe('cancelled');
    });

    it('does not take a job that failed on its own for a cancelled one', () => {
      const failedFirst = {
        ...named(),
        jobs: started().jobs.map((job, index) =>
          index === 0 ? { ...job, jobName: 'job-a', state: 'failed' as const, message: 'target refused' } : job,
        ),
      };
      expect(cancelledFailure(failedFirst, failure('job-a', 'tgt1', '0-99'), 3_000)).toBeUndefined();
    });

    it('leaves the bookkeeping out of the view', () => {
      const run = started();
      const view = runView({
        ...cancelled(run, 2_000),
        jobsBefore: ['old-job'],
        failedBeforeCancel: ['job-a'],
        jobs: run.jobs.map((job) => ({ ...job, finishedSeenAt: 1_500, unreadSince: 1_500 })),
      });
      expect(view).not.toHaveProperty('jobsBefore');
      expect(view).not.toHaveProperty('failedBeforeCancel');
      expect(view).not.toHaveProperty('cancelRequestedAt');
      expect(view).not.toHaveProperty('cancelAcceptedAt');
      expect(view.jobs[0]).not.toHaveProperty('finishedSeenAt');
      expect(view.jobs[0]).not.toHaveProperty('unreadSince');
      expect(view.sourceShardId).toBe('src');
    });

    it('keeps an unlisted job starting for a minute, then unknown', () => {
      expect(followRun(started(), report(), nodes(), 61_000).jobs[0].state).toBe('starting');
      const lost = followRun(started(), report(), nodes(), 61_001);
      expect(lost.jobs[0].state).toBe('unknown');
      expect(lost.state).toBe('unknown');
    });
  });
});
