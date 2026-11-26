import type {
  StoragePort,
  StoredRebalanceRun,
} from '../../../common/interfaces/storage-port.interface';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';

const CONN = 'conn-a';
const OTHER = 'conn-b';

const stored = (overrides: Partial<StoredRebalanceRun> = {}): StoredRebalanceRun => {
  const run = {
    connectionId: CONN,
    sourceShardId: 'src',
    state: 'running' as const,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    updatedAt: 1_700_000_000_000,
    payload: '{"jobs":[]}',
    ...overrides,
  };
  return { id: `${run.connectionId}:${run.sourceShardId}:${run.startedAt}`, ...run };
};

const ended = (endedAt: number, overrides: Partial<StoredRebalanceRun> = {}) =>
  stored({ state: 'succeeded', endedAt, updatedAt: endedAt, ...overrides });

describe.each<[string, AdapterFactory]>(adapters)('slot rebalance run storage (%s)', (_, make) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await make());
  });

  afterEach(async () => {
    await cleanup();
  });

  const list = (options: Partial<Parameters<StoragePort['getRebalanceRuns']>[0]> = {}) =>
    storage.getRebalanceRuns({ connectionId: CONN, ...options });

  const shardsListed = async (options: Parameters<typeof list>[0] = {}) =>
    (await list(options)).map((run) => run.sourceShardId);

  it('returns a saved run as it was saved', async () => {
    const run = ended(1_700_000_060_000);

    await storage.saveRebalanceRun(run);

    expect(await list()).toEqual([run]);
  });

  it('replaces the state and payload of a run saved again', async () => {
    await storage.saveRebalanceRun(stored());
    const next = ended(1_700_000_060_000, { payload: '{"jobs":[1]}' });

    await storage.saveRebalanceRun(next);

    expect(await list()).toEqual([next]);
  });

  it('keeps the newer state when an older write arrives late', async () => {
    const newer = ended(1_700_000_060_000, { payload: '{"newer":true}' });
    await storage.saveRebalanceRun(newer);

    await storage.saveRebalanceRun(stored({ payload: '{"older":true}' }));

    expect(await list()).toEqual([newer]);
  });

  it('takes a write stamped with the same time as the stored one', async () => {
    await storage.saveRebalanceRun(stored({ payload: '{"first":true}' }));

    await storage.saveRebalanceRun(stored({ payload: '{"second":true}' }));

    expect((await list())[0].payload).toBe('{"second":true}');
  });

  it('lists the runs of one connection, newest start first', async () => {
    await storage.saveRebalanceRun(stored({ sourceShardId: 'old', startedAt: 100 }));
    await storage.saveRebalanceRun(stored({ sourceShardId: 'new', startedAt: 300 }));
    await storage.saveRebalanceRun(stored({ sourceShardId: 'mid', startedAt: 200 }));
    await storage.saveRebalanceRun(stored({ connectionId: OTHER, sourceShardId: 'other' }));

    expect(await shardsListed()).toEqual(['new', 'mid', 'old']);
  });

  it('filters by start time, state and limit', async () => {
    await storage.saveRebalanceRun(ended(150, { sourceShardId: 'a', startedAt: 100 }));
    await storage.saveRebalanceRun(
      ended(250, { sourceShardId: 'b', startedAt: 200, state: 'failed' }),
    );
    await storage.saveRebalanceRun(stored({ sourceShardId: 'c', startedAt: 300 }));

    expect(await shardsListed({ since: 200 })).toEqual(['c', 'b']);
    expect(await shardsListed({ states: ['running', 'failed'] })).toEqual(['c', 'b']);
    expect(await shardsListed({ states: [] })).toEqual([]);
    expect(await shardsListed({ limit: 1 })).toEqual(['c']);
    expect(await shardsListed({ since: 100, states: ['succeeded'], limit: 5 })).toEqual(['a']);
  });

  it('prunes only the runs that ended before the cutoff', async () => {
    await storage.saveRebalanceRun(ended(100, { sourceShardId: 'expired', startedAt: 50 }));
    await storage.saveRebalanceRun(ended(500, { sourceShardId: 'at-cutoff', startedAt: 40 }));
    await storage.saveRebalanceRun(stored({ sourceShardId: 'running', startedAt: 10 }));

    expect(await storage.pruneOldRebalanceRuns(500)).toBe(1);

    expect(await shardsListed()).toEqual(['at-cutoff', 'running']);
  });

  it('prunes one connection when one is named', async () => {
    await storage.saveRebalanceRun(ended(100));
    await storage.saveRebalanceRun(ended(100, { connectionId: OTHER }));

    expect(await storage.pruneOldRebalanceRuns(500, CONN)).toBe(1);

    expect(await list()).toEqual([]);
    expect(await storage.getRebalanceRuns({ connectionId: OTHER })).toHaveLength(1);
  });
  it('returns the latest run of every shard, however many runs another shard has', async () => {
    for (let i = 0; i < 60; i++) {
      await storage.saveRebalanceRun(ended(1_000 + i, { sourceShardId: 'busy', startedAt: 500 + i }));
    }
    await storage.saveRebalanceRun(stored({ sourceShardId: 'quiet', startedAt: 100 }));
    await storage.saveRebalanceRun(stored({ sourceShardId: 'quiet', startedAt: 90 }));
    const latest = await storage.getLatestRebalanceRunPerShard(CONN, 0);
    expect(latest.map((run) => [run.sourceShardId, run.startedAt])).toEqual([
      ['busy', 559],
      ['quiet', 100],
    ]);
  });
  it('leaves out other connections and runs started before since from the latest runs', async () => {
    await storage.saveRebalanceRun(stored({ sourceShardId: 'old', startedAt: 10 }));
    await storage.saveRebalanceRun(stored({ connectionId: OTHER, sourceShardId: 'x', startedAt: 500 }));
    expect(await storage.getLatestRebalanceRunPerShard(CONN, 100)).toEqual([]);
  });
});
