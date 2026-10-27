import {
  applyStatusPoll,
  buildLagSnapshot,
  countSourceShards,
  createLagState,
  LAG_STALE_MS,
} from '../execution/replication-lag';
import type { ShakeStatus } from '../execution/shake-status';

const NOW = 1_000_000;

const status = (consistent: boolean, diffs: Array<number | null>, inAof = true): ShakeStatus => ({
  consistent,
  shards: diffs.map((diff, i) => ({ shard: `src-${i}`, inAof, diff })),
});

function polled(...polls: Array<ShakeStatus | null>) {
  const state = createLagState();
  polls.forEach((poll, i) => applyStatusPoll(state, poll, NOW - (polls.length - 1 - i) * 1000));
  return state;
}

describe('applyStatusPoll', () => {
  it('counts consecutive consistent polls', () => {
    expect(polled(status(true, [0]), status(true, [0])).consistentPolls).toBe(2);
  });

  it('resets the count on an inconsistent poll', () => {
    expect(polled(status(true, [0]), status(false, [0])).consistentPolls).toBe(0);
  });

  it('resets the count on a failed poll and keeps the last status', () => {
    const state = polled(status(true, [0]), null);
    expect(state.consistentPolls).toBe(0);
    expect(state.status).toEqual(status(true, [0]));
    expect(state.updatedAt).toBe(NOW - 1000);
  });
});

describe('buildLagSnapshot', () => {
  it('returns null lag and false for a null state', () => {
    expect(buildLagSnapshot(null, NOW)).toEqual({ replicationLag: null, shards: null, fullySynced: false });
  });

  it('returns an empty list before the first poll', () => {
    expect(buildLagSnapshot(createLagState(), NOW)).toEqual({ replicationLag: [], shards: null, fullySynced: false });
  });

  it('lists each shard with a stale flag computed on the server', () => {
    expect(buildLagSnapshot(polled(status(false, [0, 2048])), NOW)).toEqual({
      replicationLag: [
        { shard: 'src-0', diff: 0, stale: false },
        { shard: 'src-1', diff: 2048, stale: false },
      ],
      shards: 2,
      fullySynced: false,
    });
    const old = polled(status(false, [0]));
    expect(buildLagSnapshot(old, NOW + LAG_STALE_MS + 1).replicationLag?.[0].stale).toBe(true);
  });

  it('is fully synced after two consecutive consistent polls in AOF', () => {
    expect(buildLagSnapshot(polled(status(true, [0, 0]), status(true, [0, 0])), NOW).fullySynced).toBe(true);
  });

  it('is not fully synced after a single consistent poll', () => {
    expect(buildLagSnapshot(polled(status(true, [0])), NOW).fullySynced).toBe(false);
  });

  it('is not fully synced when the latest poll is stale', () => {
    const state = polled(status(true, [0]), status(true, [0]));
    expect(buildLagSnapshot(state, NOW + LAG_STALE_MS + 1).fullySynced).toBe(false);
  });

  it('is not fully synced while any shard is outside AOF', () => {
    const state = polled(status(true, [null], false), status(true, [null], false));
    expect(buildLagSnapshot(state, NOW).fullySynced).toBe(false);
  });
});

describe('countSourceShards', () => {
  it('returns 1 for a standalone source without querying nodes', async () => {
    const getClusterNodes = jest.fn();
    await expect(countSourceShards({ getClusterNodes }, false)).resolves.toBe(1);
    expect(getClusterNodes).not.toHaveBeenCalled();
  });

  it('counts master nodes for a cluster source', async () => {
    const getClusterNodes = jest.fn().mockResolvedValue([
      { flags: ['myself', 'master'], slots: [[0, 5460]] },
      { flags: ['master'], slots: [[5461, 10922]] },
      { flags: ['slave'], slots: [] },
      { flags: ['master'], slots: [[10923, 16383]] },
    ]);
    await expect(countSourceShards({ getClusterNodes }, true)).resolves.toBe(3);
  });

  it('skips masters that hold no slots, as RedisShake does', async () => {
    const getClusterNodes = jest.fn().mockResolvedValue([
      { flags: ['master'], slots: [[0, 8191]] },
      { flags: ['master'], slots: [[8192, 16383]] },
      { flags: ['master'], slots: [] },
    ]);
    await expect(countSourceShards({ getClusterNodes }, true)).resolves.toBe(2);
  });

  it('returns null when topology lookup throws', async () => {
    const getClusterNodes = jest.fn().mockRejectedValue(new Error('NOPERM'));
    await expect(countSourceShards({ getClusterNodes }, true)).resolves.toBeNull();
  });

  it('returns null when no masters are found', async () => {
    const getClusterNodes = jest.fn().mockResolvedValue([{ flags: ['slave'], slots: [] }]);
    await expect(countSourceShards({ getClusterNodes }, true)).resolves.toBeNull();
  });
});
