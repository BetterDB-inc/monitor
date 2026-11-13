import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  TopologyDivergenceMonitor,
  TOPOLOGY_DIVERGENCE_MAX_OBSERVERS,
  TOPOLOGY_DIVERGENCE_NODE_TIMEOUT_FALLBACK_MS,
} from '../topology-divergence-monitor';

const CLUSTER = 'cluster:abc';
const INTERVAL = 5000;
const IDS = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];

type Patches = Record<string, Partial<ClusterNode>>;

function member(id: string, patch: Partial<ClusterNode> = {}): ClusterNode {
  return {
    id,
    address: `${id}.internal:6379@16379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [],
    availabilityZone: id[0],
    ...patch,
  };
}

function viewOf(observerId: string, patches: Patches = {}, ids: string[] = IDS): ClusterNode[] {
  return ids.map((id) => {
    const node = member(id, patches[id]);
    return id === observerId ? { ...node, flags: ['myself', ...node.flags] } : node;
  });
}

function harness(ids: string[] = IDS) {
  const monitor = new TopologyDivergenceMonitor(() => 0);
  const asked: string[] = [];
  const answers = new Map<string, ClusterNode[] | null>();
  const readView = async (node: ClusterNode) => {
    asked.push(node.id);
    return answers.has(node.id) ? (answers.get(node.id) ?? null) : viewOf(node.id, {}, ids);
  };
  const poll = (
    connectionId: string,
    observerId: string,
    at: number,
    patches: Patches = {},
    canRead = true,
    seen: string[] = ids,
  ) =>
    monitor.poll({
      clusterKey: CLUSTER,
      connectionId,
      nodes: viewOf(observerId, patches, seen),
      at,
      intervalMs: INTERVAL,
      nodesPerZone: 1,
      randomNodes: 3,
      canRead,
      readView,
    });
  return { monitor, asked, answers, poll };
}

const failing: Partial<ClusterNode> = { flags: ['master', 'fail?'] };

describe('TopologyDivergenceMonitor', () => {
  it('asks one node per zone and reports no disagreement on a healthy cluster', async () => {
    const { poll, asked } = harness();

    const round = await poll('conn-1', 'a1', 0);

    expect(asked).toEqual(['b1', 'c1']);
    expect(round).toMatchObject({
      clusterKey: CLUSTER,
      anchorConnectionId: 'conn-1',
      status: 'ok',
      observers: ['a1', 'b1', 'c1'],
      unanswered: [],
      disagreements: [],
    });
  });

  it('waits for the interval before the next round', async () => {
    const { poll, asked } = harness();

    await poll('conn-1', 'a1', 0);
    expect(await poll('conn-1', 'a1', INTERVAL - 1)).toBeNull();
    expect(await poll('conn-1', 'a1', INTERVAL)).not.toBeNull();
    expect(asked).toEqual(['b1', 'c1', 'b1', 'c1']);
  });

  it('counts the rounds a disagreement lasts', async () => {
    const { poll, answers } = harness();
    answers.set('b1', viewOf('b1', { c2: failing }));

    await poll('conn-1', 'a1', 0);
    await poll('conn-1', 'a1', INTERVAL);
    const round = await poll('conn-1', 'a1', 2 * INTERVAL);

    expect(round?.disagreements).toMatchObject([
      { key: 'failure_flags:c2', rounds: 3, firstSeenAt: 0, lastSeenAt: 2 * INTERVAL },
    ]);
  });

  it('runs the rounds of a cluster on one connection only', async () => {
    const { poll, asked } = harness();

    await poll('conn-1', 'a1', 0);
    expect(await poll('conn-2', 'b1', 1000)).toBeNull();
    expect(await poll('conn-2', 'b1', INTERVAL + 1000)).toBeNull();
    expect(asked).toEqual(['b1', 'c1']);
  });

  it('uses the view of a registered connection instead of asking the node', async () => {
    const { poll, asked } = harness();

    await poll('conn-1', 'a1', 0);
    await poll('conn-2', 'b1', 1000, { c2: failing });
    asked.length = 0;
    const round = await poll('conn-1', 'a1', INTERVAL);

    expect(asked).toEqual(['c1']);
    expect(round?.disagreements.map((d) => d.key)).toEqual(['failure_flags:c2']);
  });

  it('asks the node again when the registered connection stops polling', async () => {
    const { poll, asked } = harness();

    await poll('conn-1', 'a1', 0);
    await poll('conn-2', 'b1', 1000);
    await poll('conn-1', 'a1', INTERVAL);
    asked.length = 0;
    await poll('conn-1', 'a1', 2 * INTERVAL);

    expect(asked).toEqual(['b1', 'c1']);
  });

  it('counts a view that was offered once in one round only', async () => {
    const { poll, asked } = harness();

    await poll('conn-1', 'a1', 0);
    await poll('conn-2', 'b1', 1000, { c2: { configEpoch: 7 } });
    asked.length = 0;
    const first = await poll('conn-1', 'a1', INTERVAL);
    const second = await poll('conn-1', 'a1', 2 * INTERVAL);
    const third = await poll('conn-1', 'a1', 3 * INTERVAL);

    expect(first?.disagreements).toMatchObject([{ key: 'config_epoch:c2', rounds: 1 }]);
    expect(asked.filter((id) => id === 'b1')).toHaveLength(2);
    expect(second?.disagreements).toEqual([]);
    expect(third?.disagreements).toEqual([]);
  });

  it('hands the rounds to another connection when the first goes quiet', async () => {
    const { poll, answers } = harness();
    answers.set('c1', viewOf('c1', { a2: failing }));

    await poll('conn-1', 'a1', 0);
    expect(await poll('conn-2', 'b1', 3 * INTERVAL)).toBeNull();
    const round = await poll('conn-2', 'b1', 3 * INTERVAL + 1);

    expect(round).toMatchObject({ anchorConnectionId: 'conn-2' });
    expect(round?.disagreements).toMatchObject([{ key: 'failure_flags:a2', rounds: 2 }]);
    expect(await poll('conn-1', 'a1', 4 * INTERVAL)).toBeNull();
  });

  it('leaves the rounds to a connection that can read the other nodes', async () => {
    const { monitor, poll, asked } = harness();

    for (let at = 0; at <= 4 * INTERVAL; at += 1000) await poll('agent', 'a1', at, {}, false);
    expect(asked).toEqual([]);
    expect(monitor.anchorOf(CLUSTER)).toBeUndefined();

    const first = await poll('conn-2', 'b1', 4 * INTERVAL + 500);
    expect(first).toMatchObject({ anchorConnectionId: 'conn-2', status: 'ok', unanswered: [] });
    expect(asked).toEqual(['a1', 'c1']);

    for (let at = 5 * INTERVAL; at <= 9 * INTERVAL; at += 1000) {
      expect(await poll('agent', 'a1', at, {}, false)).toBeNull();
      await poll('conn-2', 'b1', at + 500);
    }
    expect(monitor.anchorOf(CLUSTER)).toBe('conn-2');
  });

  it('uses the view a connection that cannot read the other nodes offers', async () => {
    const { poll, asked } = harness();

    await poll('conn-2', 'b1', 0);
    await poll('agent', 'a1', 1000, { c2: failing }, false);
    asked.length = 0;
    const round = await poll('conn-2', 'b1', INTERVAL);

    expect(asked).toEqual(['c1']);
    expect(round?.disagreements.map((d) => d.key)).toEqual(['failure_flags:c2']);
  });

  it('says it cannot compare while only a connection that cannot read is polling', async () => {
    const { monitor, poll, asked } = harness();

    const round = await poll('agent', 'a1', 0, {}, false);

    expect(round).toMatchObject({ status: 'insufficient_views', observers: ['a1'], unanswered: [] });
    expect(monitor.lastRound(CLUSTER)).toBe(round);
    expect(await poll('agent', 'a1', 1000, {}, false)).toBeNull();
    expect(await poll('agent', 'a1', INTERVAL, {}, false)).toMatchObject({ status: 'insufficient_views' });
    expect(asked).toEqual([]);
  });

  it('gives up the rounds once its connection can no longer read the other nodes', async () => {
    const { monitor, poll } = harness();

    await poll('conn-1', 'a1', 0);
    await poll('conn-1', 'a1', INTERVAL, {}, false);
    expect(monitor.anchorOf(CLUSTER)).toBeUndefined();

    expect(await poll('conn-2', 'b1', INTERVAL + 1)).toMatchObject({ anchorConnectionId: 'conn-2' });
  });

  it('reports a node that does not answer and backs off from it', async () => {
    const { poll, asked, answers } = harness(['a1', 'b1', 'c1']);
    answers.set('b1', null);

    const first = await poll('conn-1', 'a1', 0);
    expect(first).toMatchObject({ status: 'ok', unanswered: ['b1'] });

    await poll('conn-1', 'a1', INTERVAL);
    await poll('conn-1', 'a1', 2 * INTERVAL);
    await poll('conn-1', 'a1', 3 * INTERVAL);

    expect(asked.filter((id) => id === 'b1')).toHaveLength(3);
  });

  it('says so when there are not enough views to compare', async () => {
    const { poll, answers } = harness();
    for (const id of IDS) answers.set(id, null);

    expect(await poll('conn-1', 'a1', 0)).toMatchObject({ status: 'insufficient_views' });
  });

  it('drops a reply that comes from a different node than the one asked', async () => {
    const { poll, answers } = harness();
    answers.set('b1', viewOf('b2', { c2: failing }));

    const round = await poll('conn-1', 'a1', 0);

    expect(round).toMatchObject({ unanswered: ['b1'], disagreements: [] });
  });

  it('finishes the round when a read never comes back', async () => {
    jest.useFakeTimers();
    try {
      const monitor = new TopologyDivergenceMonitor(() => 0);
      const pollAt = (connectionId: string, observerId: string, at: number) =>
        monitor.poll({
          clusterKey: CLUSTER,
          connectionId,
          nodes: viewOf(observerId),
          at,
          intervalMs: INTERVAL,
          nodesPerZone: 1,
          randomNodes: 3,
          canRead: true,
          readView: (node) => (node.id === 'c1' ? new Promise<never>(() => undefined) : Promise.resolve(viewOf(node.id))),
        });

      const hung = pollAt('conn-1', 'a1', 0);
      await jest.advanceTimersByTimeAsync(TOPOLOGY_DIVERGENCE_NODE_TIMEOUT_FALLBACK_MS - 1);
      expect(await pollAt('conn-2', 'b1', 4 * INTERVAL)).toBeNull();

      await jest.advanceTimersByTimeAsync(1);
      expect(await hung).toMatchObject({ status: 'ok', unanswered: ['c1'] });

      expect(await pollAt('conn-2', 'b1', 5 * INTERVAL)).toMatchObject({ anchorConnectionId: 'conn-2' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('survives a read that throws', async () => {
    const monitor = new TopologyDivergenceMonitor(() => 0);

    const round = await monitor.poll({
      clusterKey: CLUSTER,
      connectionId: 'conn-1',
      nodes: viewOf('a1'),
      at: 0,
      intervalMs: INTERVAL,
      nodesPerZone: 1,
      randomNodes: 3,
      canRead: true,
      readView: async () => {
        throw new Error('connection refused');
      },
    });

    expect(round).toMatchObject({ status: 'insufficient_views', unanswered: ['b1', 'c1'] });
  });

  it('asks a node that a sampled view accuses of failing', async () => {
    const { poll, asked, answers } = harness();
    const isolatedView = Object.fromEntries(IDS.filter((id) => id !== 'c2').map((id) => [id, failing]));
    answers.set('c2', viewOf('c2', isolatedView));

    await poll('conn-1', 'a1', 0, { c2: failing });
    asked.length = 0;
    const round = await poll('conn-1', 'a1', INTERVAL, { c2: failing });

    expect(asked).toContain('c2');
    expect([...(round?.observers ?? [])].sort()).toEqual(['a1', 'b1', 'c1', 'c2']);
    expect(round?.disagreements.map((d) => d.key)).toEqual(expect.arrayContaining(['failure_flags:a2']));
  });

  it('keeps asking the nodes of a disagreement that is being counted', async () => {
    const { poll, asked, answers } = harness();
    answers.set('b1', viewOf('b1', { c2: failing }));

    await poll('conn-1', 'a1', 0);
    answers.set('b1', null);
    asked.length = 0;
    const round = await poll('conn-1', 'a1', INTERVAL);

    expect(round?.observers).toContain('b1');
    expect(round?.disagreements).toMatchObject([{ key: 'failure_flags:c2', rounds: 1 }]);
  });

  it('keeps asking an accused node once it is part of a disagreement', async () => {
    const { poll, answers } = harness();
    const isolatedView = Object.fromEntries(IDS.filter((id) => id !== 'c2').map((id) => [id, failing]));
    answers.set('c2', viewOf('c2', isolatedView));

    await poll('conn-1', 'a1', 0, { c2: failing });
    await poll('conn-1', 'a1', INTERVAL, { c2: failing });
    const round = await poll('conn-1', 'a1', 2 * INTERVAL, { c2: failing });

    expect(round?.observers).toContain('c2');
    expect(round?.disagreements).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'failure_flags:a2', rounds: 2 })]),
    );
  });

  it('holds the count of a disagreement while one of its nodes cannot be asked', async () => {
    const { poll, answers } = harness();
    answers.set('b1', viewOf('b1', { c2: failing }));

    await poll('conn-1', 'a1', 0);
    const round = await poll('conn-1', 'a1', INTERVAL, { b1: { flags: ['master', 'noaddr'] } });

    expect(round?.observers).not.toContain('b1');
    expect(round?.disagreements).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'failure_flags:c2', rounds: 1, lastSeenAt: 0 })]),
    );
  });

  it('forgets a disagreement of a node that left the cluster', async () => {
    const { poll, answers } = harness();
    answers.set('b1', viewOf('b1', { c2: failing }));

    await poll('conn-1', 'a1', 0);
    const rest = IDS.filter((id) => id !== 'b1');
    const round = await poll('conn-1', 'a1', INTERVAL, {}, true, rest);

    expect(round?.disagreements.map((d) => d.key)).not.toContain('failure_flags:c2');
  });

  it('never sends more reads in a round than the observer limit allows', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `${String.fromCharCode(97 + (i % 20))}${i}`);
    const { poll, asked } = harness(ids);

    await poll('conn-1', ids[0], 0);

    expect(asked.length).toBe(TOPOLOGY_DIVERGENCE_MAX_OBSERVERS - 1);
  });

  it('starts over for a cluster once its last connection is gone', async () => {
    const { monitor, poll } = harness();

    await poll('conn-1', 'a1', 0);
    monitor.forgetConnection('conn-1');

    expect(monitor.lastRound(CLUSTER)).toBeUndefined();
    expect(await poll('conn-2', 'b1', 1)).toMatchObject({ anchorConnectionId: 'conn-2' });
  });

  it('lets the next connection take over as soon as the running one is removed', async () => {
    const { monitor, poll } = harness();

    await poll('conn-1', 'a1', 0);
    await poll('conn-2', 'b1', 1000);
    monitor.forgetConnection('conn-1');

    expect(await poll('conn-2', 'b1', INTERVAL)).toMatchObject({ anchorConnectionId: 'conn-2' });
  });
});
