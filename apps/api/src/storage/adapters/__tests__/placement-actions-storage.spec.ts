import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  defaultPlacementSettings,
  type PlacementAction,
  type PlacementActionState,
  type PlacementStep,
} from '@betterdb/shared';
import { Client } from 'pg';
import { SqliteAdapter } from '../sqlite.adapter';
import { MemoryAdapter } from '../memory.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-actions-'));
  tempDirs.push(dir);
  return path.join(dir, 'db.sqlite');
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const inProcess =
  (make: () => StoragePort): AdapterFactory =>
  async () => {
    const storage = make();
    await storage.initialize();
    return { storage, cleanup: () => storage.close() };
  };

async function statementsOf(storage: StoragePort): Promise<() => string[]> {
  if (storage instanceof SqliteAdapter) {
    const db = (storage as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const prepare = jest.spyOn(db, 'prepare');
    return () => prepare.mock.calls.map(([sql]) => String(sql));
  }
  if (storage instanceof PostgresAdapter) {
    await (storage as unknown as { indexBuild: Promise<void> | null }).indexBuild;
    const query = jest.spyOn(Client.prototype, 'query');
    return () => query.mock.calls.map(([sql]) => String(sql));
  }
  return () => [];
}

async function plantLock(storage: StoragePort, nodeId: string, actionId: string): Promise<void> {
  if (storage instanceof SqliteAdapter) {
    const db = (
      storage as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
      }
    ).db;
    db.prepare(
      'INSERT INTO placement_locks (node_id, action_id, acquired_at) VALUES (?, ?, 1)',
    ).run(nodeId, actionId);
    return;
  }
  if (storage instanceof PostgresAdapter) {
    const pool = (
      storage as unknown as { pool: { query: (sql: string, args: unknown[]) => Promise<unknown> } }
    ).pool;
    await pool.query(
      'INSERT INTO placement_locks (node_id, action_id, acquired_at) VALUES ($1, $2, 1)',
      [nodeId, actionId],
    );
    return;
  }
  (storage as unknown as { placementLocks: Map<string, unknown> }).placementLocks.set(nodeId, {
    actionId,
    acquiredAt: 1,
  });
}

function action(id: string, overrides: Partial<PlacementAction> = {}): PlacementAction {
  return {
    id,
    connectionId: 'conn-a',
    clusterNodes: ['n1', 'n2', 'n3'],
    kind: 'spread',
    state: 'proposed',
    modeAtCreation: 'approve',
    plan: { moves: [{ from: 'n1', to: 'n2', ranges: [[0, 9]] }] },
    settingsSnapshot: defaultPlacementSettings(),
    policyVersion: 3,
    gateDecisions: [
      { at: 1_000, stepIndex: null, result: { allowed: true, blockers: [], warnings: [] } },
    ],
    approvedBy: null,
    loadBefore: { n1: 0.9 },
    loadProjected: null,
    loadMeasured: null,
    verdict: null,
    sourceShardId: 'n1',
    rollbackOf: null,
    rolledBackBy: null,
    createdAt: 1_000,
    approvedAt: null,
    startedAt: null,
    endedAt: null,
    verifiedAt: null,
    anomalyEventIds: [],
    message: null,
    ...overrides,
  };
}

function step(
  actionId: string,
  index: number,
  overrides: Partial<PlacementStep> = {},
): PlacementStep {
  return {
    actionId,
    index,
    state: 'planned',
    sourceNodeId: 'n1',
    targetNodeId: `n${index + 2}`,
    targetShardId: `shard-${index + 2}`,
    targetAddr: `10.0.0.${index + 2}:7000`,
    ranges: [[index * 10, index * 10 + 9]],
    jobsBefore: null,
    job: null,
    cancelRequestedAt: null,
    cancelAcceptedAt: null,
    failedBeforeCancel: null,
    bytesEstimated: 1536.75,
    keysMoved: 0,
    slotsMoved: 0,
    slotCpuBefore: 12.5,
    sendingAt: null,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

describe.each([
  ['memory', inProcess(() => new MemoryAdapter() as unknown as StoragePort)],
  [
    'sqlite',
    inProcess(() => new SqliteAdapter({ filepath: tempDbPath() }) as unknown as StoragePort),
  ],
  [
    'libsql',
    inProcess(() => new SqliteAdapter({ url: `file:${tempDbPath()}` }) as unknown as StoragePort),
  ],
  ...adapters.filter(([name]) => name === 'PostgresAdapter'),
])('%s placement actions storage', (_name, make) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await make());
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanup();
  });

  it('stores an action with its steps and reads them back in step order', async () => {
    const stored = action('a1', {
      approvedBy: {
        source: 'ui',
        userId: 'u1',
        email: 'ops@example.com',
        via: 'session',
        tokenId: null,
      },
    });
    const steps = [step('a1', 1), step('a1', 0, { jobsBefore: ['j0'] })];
    expect(await storage.createPlacementAction(stored, steps)).toEqual(stored);

    const read = await storage.getPlacementAction('a1');
    expect(read?.action).toEqual(stored);
    expect(read?.steps).toEqual([steps[1], steps[0]]);
    expect(await storage.getPlacementAction('missing')).toBeNull();
  });

  it('moves an action only from a state it is in', async () => {
    await storage.createPlacementAction(action('a1'), []);

    expect(
      await storage.transitionPlacementAction('a1', ['approved'], {
        state: 'running',
        startedAt: 5,
      }),
    ).toBeNull();
    expect((await storage.getPlacementAction('a1'))?.action).toEqual(action('a1'));

    const moved = await storage.transitionPlacementAction('a1', ['proposed', 'approved'], {
      state: 'approved',
      approvedAt: 7,
      gateDecisions: [],
    });
    expect(moved).toEqual({ ...action('a1'), state: 'approved', approvedAt: 7, gateDecisions: [] });
    expect((await storage.getPlacementAction('a1'))?.action).toEqual(moved);
    expect(
      await storage.transitionPlacementAction('missing', ['proposed'], { state: 'approved' }),
    ).toBeNull();
  });

  const approved = (id: string, clusterNodes: string[]) =>
    storage.createPlacementAction(action(id, { state: 'approved', clusterNodes }), []);
  const start = (id: string) =>
    storage.transitionPlacementAction(id, ['approved'], { state: 'running', startedAt: 5 });
  const stateOf = async (id: string) => (await storage.getPlacementAction(id))?.action.state;

  it('locks the nodes of an action as it starts, refusing nodes another action holds and writing none', async () => {
    await approved('a1', ['n1', 'n3']);
    await approved('a2', ['n3', 'n2']);
    await approved('a3', ['n2']);

    expect(await start('a1')).toMatchObject({ state: 'running', startedAt: 5 });
    expect(await start('a2')).toBeNull();
    expect(await stateOf('a2')).toBe('approved');
    expect(await start('a3')).toMatchObject({ state: 'running' });
  });

  it('locks nothing for an action that is not approved', async () => {
    await storage.createPlacementAction(
      action('a1', { state: 'rejected', clusterNodes: ['n1'] }),
      [],
    );
    await approved('a2', ['n1']);

    expect(await start('a1')).toBeNull();
    expect(await start('a2')).toMatchObject({ state: 'running' });
  });

  it('starts exactly one of two actions racing for the same nodes in opposite order', async () => {
    await approved('a1', ['n1', 'n2', 'n3']);
    await approved('a2', ['n3', 'n2', 'n1']);

    const results = await Promise.all([start('a1'), start('a2')]);

    expect(results.filter((each) => each !== null)).toHaveLength(1);
    expect([await stateOf('a1'), await stateOf('a2')].sort()).toEqual(['approved', 'running']);
  });

  it('keeps the lock of a running action that is moved to running again', async () => {
    await approved('a1', ['n1']);
    await approved('a2', ['n1']);
    await start('a1');

    expect(
      await storage.transitionPlacementAction('a1', ['running'], {
        state: 'running',
        message: 'x',
      }),
    ).toMatchObject({ state: 'running', message: 'x' });
    expect(await start('a2')).toBeNull();
  });

  it('frees the lock when the action ends, and keeps it while the action is open', async () => {
    await approved('a1', ['n1', 'n2']);
    await approved('a2', ['n1']);
    await start('a1');

    await storage.transitionPlacementAction('a1', ['running'], { state: 'verifying' });
    expect(await start('a2')).toBeNull();

    await storage.transitionPlacementAction('a1', ['verifying'], { state: 'aborted', endedAt: 9 });
    expect(await start('a2')).toMatchObject({ state: 'running' });
  });

  it('keeps the lock when a transition is refused', async () => {
    await approved('a1', ['n1']);
    await approved('a2', ['n1']);
    await start('a1');

    expect(
      await storage.transitionPlacementAction('a1', ['approved'], { state: 'failed' }),
    ).toBeNull();
    expect(await start('a2')).toBeNull();
  });

  const waitOnAbort = async (id: string, clusterNodes: string[]) => {
    await approved(id, clusterNodes);
    await start(id);
    await storage.transitionPlacementAction(id, ['running'], {
      state: 'aborted_pending',
      endedAt: 1,
    });
  };

  it('keeps the locks of an action waiting on an abort until it is aborted', async () => {
    await waitOnAbort('a1', ['n1']);
    await approved('a2', ['n1']);

    expect(await storage.freeOrphanedPlacementLocks()).toBe(0);
    expect(await start('a2')).toBeNull();

    await storage.transitionPlacementAction('a1', ['aborted_pending'], {
      state: 'aborted',
      endedAt: 9,
    });
    expect(await start('a2')).toMatchObject({ state: 'running' });
  });

  it('lists an action waiting on an abort as open', async () => {
    await waitOnAbort('a1', ['n1']);

    expect((await storage.listOpenPlacementActions()).map((each) => each.id)).toEqual(['a1']);
  });

  it('never prunes an action waiting on an abort', async () => {
    await waitOnAbort('a1', ['n1']);

    expect(await storage.prunePlacementActions(Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(await stateOf('a1')).toBe('aborted_pending');
  });

  it('frees the locks of ended and missing actions only', async () => {
    await approved('open', ['n1']);
    await start('open');
    await storage.createPlacementAction(action('ended', { state: 'failed', endedAt: 5 }), []);
    await plantLock(storage, 'n2', 'ended');
    await plantLock(storage, 'n3', 'gone');
    await plantLock(storage, 'n4', 'gone');

    expect(await storage.freeOrphanedPlacementLocks()).toBe(3);
    await approved('next', ['n2', 'n3', 'n4']);
    await approved('blocked', ['n1']);
    expect(await start('next')).toMatchObject({ state: 'running' });
    expect(await start('blocked')).toBeNull();
  });

  it('refuses a step of another action, storing nothing', async () => {
    await expect(
      storage.createPlacementAction(action('a1'), [step('a1', 0), step('a2', 1)]),
    ).rejects.toThrow('Placement step 1 belongs to action a2, not a1');

    expect(await storage.getPlacementAction('a1')).toBeNull();
    expect(await storage.getPlacementAction('a2')).toBeNull();
  });

  it('refuses two steps with one index, storing nothing', async () => {
    await expect(
      storage.createPlacementAction(action('a1'), [step('a1', 0), step('a1', 0)]),
    ).rejects.toThrow('Placement action a1 has step 0 twice');

    expect(await storage.getPlacementAction('a1')).toBeNull();
  });

  it('updates a step from a state it is in, or without a check', async () => {
    await storage.createPlacementAction(action('a1'), [step('a1', 0), step('a1', 1)]);

    expect(
      await storage.updatePlacementStep('a1', 0, ['sending'], { state: 'running' }),
    ).toBeNull();
    const sending = await storage.updatePlacementStep('a1', 0, ['planned'], {
      state: 'sending',
      sendingAt: 10,
      jobsBefore: ['old-job'],
    });
    expect(sending).toEqual({
      ...step('a1', 0),
      state: 'sending',
      sendingAt: 10,
      jobsBefore: ['old-job'],
    });

    const cancelled = await storage.updatePlacementStep('a1', 0, null, {
      cancelRequestedAt: 11,
      job: { jobName: 'job-1', state: 'running', phase: 'copy' },
    });
    expect(cancelled).toMatchObject({
      state: 'sending',
      cancelRequestedAt: 11,
      job: { jobName: 'job-1', state: 'running', phase: 'copy' },
    });
    expect((await storage.getPlacementAction('a1'))?.steps).toEqual([cancelled, step('a1', 1)]);
    expect(await storage.updatePlacementStep('a1', 5, null, { keysMoved: 1 })).toBeNull();
  });

  it('lists the open actions of every connection', async () => {
    const states: PlacementActionState[] = [
      'proposed',
      'running',
      'succeeded',
      'rolling_back',
      'rejected',
    ];
    for (const [index, state] of states.entries()) {
      await storage.createPlacementAction(
        action(`a${index}`, { state, connectionId: index % 2 ? 'conn-b' : 'conn-a' }),
        [],
      );
    }
    const open = await storage.listOpenPlacementActions();
    expect(open.map((each) => each.id).sort()).toEqual(['a0', 'a1', 'a3']);
  });

  it('lists the open actions oldest first', async () => {
    for (const [id, createdAt] of [
      ['late', 300],
      ['early', 100],
      ['mid', 200],
    ] as const) {
      await storage.createPlacementAction(action(id, { createdAt }), []);
    }
    const open = await storage.listOpenPlacementActions();
    expect(open.map((each) => each.id)).toEqual(['early', 'mid', 'late']);
  });

  it('pages the actions of one connection, newest first', async () => {
    for (let index = 0; index < 5; index++) {
      await storage.createPlacementAction(
        action(`a${index}`, { createdAt: 100 + index, state: index === 2 ? 'failed' : 'proposed' }),
        [],
      );
    }
    await storage.createPlacementAction(
      action('other', { connectionId: 'conn-b', createdAt: 200 }),
      [],
    );

    const first = await storage.listPlacementActions('conn-a', { limit: 2 });
    expect(first.items.map((each) => each.id)).toEqual(['a4', 'a3']);
    expect(first.nextCursor).not.toBeNull();
    const second = await storage.listPlacementActions('conn-a', {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((each) => each.id)).toEqual(['a2', 'a1']);
    const last = await storage.listPlacementActions('conn-a', {
      limit: 2,
      cursor: second.nextCursor!,
    });
    expect(last).toEqual({ items: [expect.objectContaining({ id: 'a0' })], nextCursor: null });

    const filtered = await storage.listPlacementActions('conn-a', {
      states: ['proposed'],
      from: 101,
      to: 103,
    });
    expect(filtered.items.map((each) => each.id)).toEqual(['a3', 'a1']);
  });

  it('pages actions created in the same millisecond without skipping one', async () => {
    for (const id of ['x', 'y', 'z']) {
      await storage.createPlacementAction(action(id, { createdAt: 100 }), []);
    }
    const first = await storage.listPlacementActions('conn-a', { limit: 2 });
    const second = await storage.listPlacementActions('conn-a', {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect([...first.items, ...second.items].map((each) => each.id).sort()).toEqual([
      'x',
      'y',
      'z',
    ]);
  });

  it('reads the steps sent, still open or ended since a time, for one connection', async () => {
    await storage.createPlacementAction(action('a1'), [
      step('a1', 0, { state: 'sending', sendingAt: 500 }),
      step('a1', 1, { state: 'done', sendingAt: 100, endedAt: 600 }),
      step('a1', 2, { state: 'done', sendingAt: 100, endedAt: 300 }),
      step('a1', 3, { state: 'failed', sendingAt: 100, endedAt: 700 }),
      step('a1', 4),
      step('a1', 5, { state: 'running', sendingAt: 100 }),
      step('a1', 6, { state: 'cancelled', endedAt: 800 }),
    ]);
    await storage.createPlacementAction(action('b1', { connectionId: 'conn-b' }), [
      step('b1', 0, { state: 'sending', sendingAt: 900 }),
    ]);

    const since = await storage.placementStepsSince('conn-a', 400);
    expect(since.map((each) => each.index).sort()).toEqual([0, 1, 3, 5]);
    expect(since.find((each) => each.index === 5)).toEqual({
      ...step('a1', 5, { state: 'running', sendingAt: 100 }),
      sourceShardId: 'n1',
    });
  });

  it('reads the steps since a time in action and step order', async () => {
    await storage.createPlacementAction(action('z1'), [
      step('z1', 0, { state: 'sending', sendingAt: 500 }),
      step('z1', 1, { state: 'sending', sendingAt: 500 }),
    ]);
    await storage.createPlacementAction(action('a1'), [
      step('a1', 0, { state: 'sending', sendingAt: 500 }),
    ]);
    const since = await storage.placementStepsSince('conn-a', 400);
    expect(since.map((each) => `${each.actionId}:${each.index}`)).toEqual(['a1:0', 'z1:0', 'z1:1']);
  });

  it('counts the sent steps of ended actions in the hourly jobs, as replaced runs were', async () => {
    const hourAgo = 10_000;
    await storage.createPlacementAction(
      action('replaced', { state: 'failed', startedAt: hourAgo + 100, endedAt: hourAgo + 400 }),
      [
        step('replaced', 0, { state: 'done', sendingAt: hourAgo + 100, endedAt: hourAgo + 300 }),
        step('replaced', 1, { state: 'failed', sendingAt: hourAgo + 200, endedAt: hourAgo + 400 }),
        step('replaced', 2, { state: 'cancelled', endedAt: hourAgo + 400 }),
      ],
    );
    await storage.createPlacementAction(
      action('active', { state: 'running', startedAt: hourAgo + 500 }),
      [step('active', 0, { state: 'running', sendingAt: hourAgo + 500 }), step('active', 1)],
    );
    await storage.createPlacementAction(
      action('older', { state: 'succeeded', startedAt: hourAgo - 900, endedAt: hourAgo - 100 }),
      [step('older', 0, { state: 'done', sendingAt: hourAgo - 900, endedAt: hourAgo - 100 })],
    );

    const steps = await storage.placementStepsSince('conn-a', hourAgo);
    const jobsUsed = steps.filter((each) => (each.sendingAt ?? -1) >= hourAgo).length;
    expect(jobsUsed).toBe(3);
    expect([...new Set(steps.flatMap((each) => [each.sourceShardId, each.targetShardId]))]).toEqual(
      ['n1', 'shard-2', 'shard-3'],
    );
  });

  it('answers a transition and a step update with the row it wrote', async () => {
    await storage.createPlacementAction(action('a1'), [step('a1', 0)]);

    const moved = await storage.transitionPlacementAction('a1', ['proposed'], {
      state: 'approved',
      approvedAt: 2_000,
    });
    expect(moved).toEqual(action('a1', { state: 'approved', approvedAt: 2_000 }));
    const sent = await storage.updatePlacementStep('a1', 0, ['planned'], {
      state: 'sending',
      sendingAt: 2_100,
    });
    expect(sent).toEqual(step('a1', 0, { state: 'sending', sendingAt: 2_100 }));
    expect(await storage.updatePlacementStep('a1', 0, null, {})).toEqual(sent);
  });

  it('answers a create, a transition and a step update from the write, with no read after it', async () => {
    const statements = await statementsOf(storage);
    const read = jest.spyOn(storage, 'getPlacementAction');

    await storage.createPlacementAction(action('a1'), [step('a1', 0)]);
    await storage.transitionPlacementAction('a1', ['proposed'], { state: 'approved' });
    await storage.updatePlacementStep('a1', 0, ['planned'], { state: 'sending', sendingAt: 1 });

    expect(read).not.toHaveBeenCalled();
    expect(statements().filter((sql) => /^\s*SELECT\b/i.test(sql))).toEqual([]);
    expect(statements().some((sql) => sql.includes('RETURNING'))).toBe(_name !== 'memory');
  });

  it('leaves a field alone when a patch sets it to undefined', async () => {
    await storage.createPlacementAction(action('a1', { message: 'kept' }), [
      step('a1', 0, { job: { state: 'running' } }),
    ]);

    const moved = await storage.transitionPlacementAction('a1', ['proposed'], {
      state: 'approved',
      message: undefined,
    });
    const updated = await storage.updatePlacementStep('a1', 0, null, {
      job: undefined,
      keysMoved: 4,
    });

    expect(moved?.message).toBe('kept');
    expect(updated).toMatchObject({ job: { state: 'running' }, keysMoved: 4 });
    expect((await storage.getPlacementAction('a1'))?.action.message).toBe('kept');
  });

  it('stamps the end of an action that moves into a terminal state without one', async () => {
    await storage.createPlacementAction(action('a1'), []);
    const before = Date.now();

    const ended = await storage.transitionPlacementAction('a1', ['proposed'], {
      state: 'rejected',
    });

    expect(ended?.endedAt).toBeGreaterThanOrEqual(before);
    expect(ended?.endedAt).toBeLessThanOrEqual(Date.now());
    expect((await storage.getPlacementAction('a1'))?.action.endedAt).toBe(ended?.endedAt);
    expect(await storage.prunePlacementActions(Date.now() + 1)).toBe(1);
  });

  it('keeps the end a terminal move gives, and stamps none on an open move', async () => {
    await storage.createPlacementAction(action('a1'), []);

    expect(
      await storage.transitionPlacementAction('a1', ['proposed'], { state: 'approved' }),
    ).toMatchObject({ endedAt: null });
    expect(
      await storage.transitionPlacementAction('a1', ['approved'], { state: 'expired', endedAt: 7 }),
    ).toMatchObject({ endedAt: 7 });
  });

  it('prunes ended actions with their steps, keeping open and recent ones', async () => {
    await storage.createPlacementAction(action('old', { state: 'succeeded', endedAt: 100 }), [
      step('old', 0, { state: 'done', sendingAt: 50, endedAt: 90 }),
    ]);
    await storage.createPlacementAction(action('open', { state: 'running', createdAt: 10 }), [
      step('open', 0, { state: 'sending', sendingAt: 20 }),
    ]);
    await storage.createPlacementAction(action('recent', { state: 'failed', endedAt: 900 }), []);

    expect(await storage.prunePlacementActions(500)).toBe(1);
    expect(await storage.getPlacementAction('old')).toBeNull();
    expect(await storage.getPlacementAction('open')).not.toBeNull();
    expect(await storage.getPlacementAction('recent')).not.toBeNull();
    expect(await storage.placementStepsSince('conn-a', 0)).toEqual([
      expect.objectContaining({ actionId: 'open' }),
    ]);
    await storage.createPlacementAction(action('old'), []);
    expect((await storage.getPlacementAction('old'))?.steps).toEqual([]);
  });
});
