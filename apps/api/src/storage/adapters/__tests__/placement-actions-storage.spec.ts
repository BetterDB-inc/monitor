import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  defaultPlacementSettings,
  type PlacementAction,
  type PlacementActionState,
  type PlacementStep,
} from '@betterdb/shared';
import { SqliteAdapter } from '../sqlite.adapter';
import { MemoryAdapter } from '../memory.adapter';
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
    targetAddr: `10.0.0.${index + 2}:7000`,
    ranges: [[index * 10, index * 10 + 9]],
    jobsBefore: null,
    job: null,
    cancelRequestedAt: null,
    cancelAcceptedAt: null,
    failedBeforeCancel: null,
    bytesEstimated: 1024,
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
  afterEach(async () => cleanup());

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
    await storage.createPlacementAction(stored, steps);

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

  it('refuses a lock on a node another action holds, taking none of the rows', async () => {
    expect(await storage.acquirePlacementLock('a1', ['n1', 'n2'], 1)).toBe(true);
    expect(await storage.acquirePlacementLock('a2', ['n3', 'n2'], 2)).toBe(false);
    expect(await storage.acquirePlacementLock('a3', ['n3'], 3)).toBe(true);
  });

  it('frees the lock when the action ends, and keeps it while the action is open', async () => {
    await storage.createPlacementAction(action('a1', { state: 'approved' }), []);
    expect(await storage.acquirePlacementLock('a1', ['n1', 'n2'], 1)).toBe(true);

    await storage.transitionPlacementAction('a1', ['approved'], { state: 'running' });
    expect(await storage.acquirePlacementLock('a2', ['n1'], 2)).toBe(false);

    await storage.transitionPlacementAction('a1', ['running'], { state: 'aborted', endedAt: 9 });
    expect(await storage.acquirePlacementLock('a2', ['n1', 'n2'], 3)).toBe(true);
  });

  it('keeps the lock when a transition is refused', async () => {
    await storage.createPlacementAction(action('a1', { state: 'running' }), []);
    await storage.acquirePlacementLock('a1', ['n1'], 1);

    expect(
      await storage.transitionPlacementAction('a1', ['approved'], { state: 'failed' }),
    ).toBeNull();
    expect(await storage.acquirePlacementLock('a2', ['n1'], 2)).toBe(false);
  });

  it('frees the locks of ended and missing actions only', async () => {
    await storage.createPlacementAction(action('open', { state: 'running' }), []);
    await storage.createPlacementAction(action('ended', { state: 'failed', endedAt: 5 }), []);
    await storage.acquirePlacementLock('open', ['n1'], 1);
    await storage.acquirePlacementLock('ended', ['n2'], 1);
    await storage.acquirePlacementLock('gone', ['n3', 'n4'], 1);

    expect(await storage.freeOrphanedPlacementLocks()).toBe(3);
    expect(await storage.acquirePlacementLock('next', ['n2', 'n3', 'n4'], 2)).toBe(true);
    expect(await storage.acquirePlacementLock('next', ['n1'], 2)).toBe(false);
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

  it('reads the steps sent or finished since a time, for one connection', async () => {
    await storage.createPlacementAction(action('a1'), [
      step('a1', 0, { state: 'sending', sendingAt: 500 }),
      step('a1', 1, { state: 'done', sendingAt: 100, endedAt: 600 }),
      step('a1', 2, { state: 'done', sendingAt: 100, endedAt: 300 }),
      step('a1', 3, { state: 'failed', sendingAt: 100, endedAt: 700 }),
      step('a1', 4),
    ]);
    await storage.createPlacementAction(action('b1', { connectionId: 'conn-b' }), [
      step('b1', 0, { state: 'sending', sendingAt: 900 }),
    ]);

    const since = await storage.placementStepsSince('conn-a', 400);
    expect(since.map((each) => each.index).sort()).toEqual([0, 1]);
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
  });
});
