import { ClusterNode } from '../../common/types/metrics.types';
import { diffClusterTopology, snapshotTopology, TopologyDiff } from '../topology-diff';
import {
  DemotedNodeObservation,
  DemotionWatch,
  demotedWritesMessage,
  evaluateDemotedWrites,
  pruneDemotionWatch,
  recordDemotions,
} from '../demoted-writes';

function node(overrides: Partial<ClusterNode> & { id: string }): ClusterNode {
  return {
    address: `${overrides.id}:6379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [[0, 5460]],
    ...overrides,
  };
}

function replica(id: string, masterId: string): ClusterNode {
  return node({ id, flags: ['slave'], master: masterId, slots: [] });
}

/** `a` was the master and `b` its replica; the failover swaps them. */
function failoverOfA(): TopologyDiff {
  const before = snapshotTopology([node({ id: 'a' }), replica('b', 'a')]);
  const after = snapshotTopology([replica('a', 'b'), node({ id: 'b' })]);
  return diffClusterTopology(before, after);
}

function watchWithDemotedA(now: number): DemotionWatch {
  const watch: DemotionWatch = new Map();
  recordDemotions(watch, failoverOfA(), now);
  return watch;
}

function observation(overrides: Partial<DemotedNodeObservation> = {}): DemotedNodeObservation {
  return {
    nodeId: 'a',
    nodeAddress: 'a:6379',
    selfReportedRole: 'master',
    opsPerSec: 120,
    ...overrides,
  };
}

/** The poll interval the detector is told to require, matching the 5s gaps below. */
const POLL_INTERVAL_MS = 5_000;

function evaluate(
  watch: DemotionWatch,
  observations: DemotedNodeObservation[],
  now: number,
): ReturnType<typeof evaluateDemotedWrites> {
  return evaluateDemotedWrites(watch, observations, now, POLL_INTERVAL_MS);
}

describe('recordDemotions', () => {
  it('watches the node the failover demoted', () => {
    const watch = watchWithDemotedA(1_000);

    expect([...watch.keys()]).toEqual(['a']);
    expect(watch.get('a')?.demotedAt).toBe(1_000);
  });

  it('does not watch the node the failover promoted', () => {
    const watch = watchWithDemotedA(1_000);

    expect(watch.has('b')).toBe(false);
  });

  it('ignores a replica that only changed primary', () => {
    const before = snapshotTopology([node({ id: 'a' }), node({ id: 'b' }), replica('c', 'a')]);
    const after = snapshotTopology([node({ id: 'a' }), node({ id: 'b' }), replica('c', 'b')]);
    const watch: DemotionWatch = new Map();

    recordDemotions(watch, diffClusterTopology(before, after), 1_000);

    expect(watch.size).toBe(0);
  });

  it('keeps the original demotion timestamp when the same node is reported again', () => {
    const watch = watchWithDemotedA(1_000);

    recordDemotions(watch, failoverOfA(), 5_000);

    expect(watch.get('a')?.demotedAt).toBe(1_000);
  });
});

describe('pruneDemotionWatch', () => {
  const stillReplica = snapshotTopology([replica('a', 'b'), node({ id: 'b' })]);

  it('keeps a node that is still a replica inside the window', () => {
    const watch = watchWithDemotedA(1_000);

    pruneDemotionWatch(watch, stillReplica, 10_000, 60_000);

    expect(watch.has('a')).toBe(true);
  });

  it('drops a node once the window expires', () => {
    const watch = watchWithDemotedA(1_000);

    pruneDemotionWatch(watch, stillReplica, 100_000, 60_000);

    expect(watch.has('a')).toBe(false);
  });

  it('drops a node that was promoted back', () => {
    const watch = watchWithDemotedA(1_000);

    pruneDemotionWatch(watch, snapshotTopology([node({ id: 'a' })]), 10_000, 60_000);

    expect(watch.has('a')).toBe(false);
  });

  it('drops a node that left the cluster', () => {
    const watch = watchWithDemotedA(1_000);

    pruneDemotionWatch(watch, snapshotTopology([node({ id: 'b' })]), 10_000, 60_000);

    expect(watch.has('a')).toBe(false);
  });

  it('applies only the age limit when the topology read failed', () => {
    const watch = watchWithDemotedA(1_000);

    pruneDemotionWatch(watch, null, 10_000, 60_000);

    expect(watch.has('a')).toBe(true);
  });
});

describe('evaluateDemotedWrites', () => {
  it('alerts on the second consecutive poll of disagreement with traffic', () => {
    const watch = watchWithDemotedA(1_000);

    expect(evaluate(watch, [observation()], 2_000)).toEqual([]);
    const alerts = evaluate(watch, [observation()], 7_000);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      nodeId: 'a',
      nodeAddress: 'a:6379',
      opsPerSec: 120,
      demotedForMs: 6_000,
      disagreementMs: 5_000,
    });
  });

  it('does not alert on a single poll of disagreement', () => {
    const watch = watchWithDemotedA(1_000);

    expect(evaluate(watch, [observation()], 2_000)).toEqual([]);
  });

  it('does not alert when the node agrees it is a replica', () => {
    const watch = watchWithDemotedA(1_000);

    evaluate(watch, [observation({ selfReportedRole: 'replica' })], 2_000);
    const alerts = evaluate(watch, [observation({ selfReportedRole: 'replica' })], 7_000);

    expect(alerts).toEqual([]);
  });

  it('does not alert when a disagreeing node serves no traffic', () => {
    const watch = watchWithDemotedA(1_000);

    evaluate(watch, [observation({ opsPerSec: 0 })], 2_000);
    const alerts = evaluate(watch, [observation({ opsPerSec: 0 })], 7_000);

    expect(alerts).toEqual([]);
  });

  it('ignores a node that was never demoted', () => {
    const watch = watchWithDemotedA(1_000);
    const other = observation({ nodeId: 'z', nodeAddress: 'z:6379' });

    evaluate(watch, [other], 2_000);

    expect(evaluate(watch, [other], 7_000)).toEqual([]);
  });

  it('restarts the persistence count when the disagreement resolves and returns', () => {
    const watch = watchWithDemotedA(1_000);

    evaluate(watch, [observation()], 2_000);
    evaluate(watch, [observation({ selfReportedRole: 'replica' })], 7_000);
    const alerts = evaluate(watch, [observation()], 12_000);

    expect(alerts).toEqual([]);
  });

  it('alerts once per demotion window, not on every poll', () => {
    const watch = watchWithDemotedA(1_000);

    evaluate(watch, [observation()], 2_000);
    expect(evaluate(watch, [observation()], 7_000)).toHaveLength(1);
    expect(evaluate(watch, [observation()], 12_000)).toEqual([]);
  });

  it('counts the writes served between the two polls when commandstats is available', () => {
    const watch = watchWithDemotedA(1_000);

    evaluate(watch, [observation({ writeCommandCalls: 500 })], 2_000);
    const alerts = evaluate(watch, [observation({ writeCommandCalls: 512 })], 7_000);

    expect(alerts[0].writeCallsDelta).toBe(12);
  });

  it('does not alert on a demoted node serving only reads', () => {
    const watch = watchWithDemotedA(1_000);

    evaluate(watch, [observation({ writeCommandCalls: 500 })], 2_000);
    const alerts = evaluate(watch, [observation({ writeCommandCalls: 500 })], 7_000);

    expect(alerts).toEqual([]);
  });

  it('falls back to ops when the counter went backwards after a restart', () => {
    const watch = watchWithDemotedA(1_000);

    evaluate(watch, [observation({ writeCommandCalls: 500 })], 2_000);
    const alerts = evaluate(watch, [observation({ writeCommandCalls: 3 })], 7_000);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].writeCallsDelta).toBeUndefined();
  });

  it('does not alert while the node role read is failing', () => {
    const watch = watchWithDemotedA(1_000);

    evaluate(watch, [observation({ selfReportedRole: undefined })], 2_000);
    const alerts = evaluate(watch, [observation({ selfReportedRole: undefined })], 7_000);

    expect(alerts).toEqual([]);
  });

  it('does not alert until the disagreement has outlasted one poll interval', () => {
    const watch = watchWithDemotedA(1_000);

    // Two /metrics scrapes 40ms apart drive the same update path as the poller,
    // so the observation count alone would already be satisfied here.
    evaluateDemotedWrites(watch, [observation()], 2_000, POLL_INTERVAL_MS);
    const tooSoon = evaluateDemotedWrites(watch, [observation()], 2_040, POLL_INTERVAL_MS);

    expect(tooSoon).toEqual([]);
    expect(watch.get('a')?.alerted).toBe(false);

    const alerts = evaluateDemotedWrites(watch, [observation()], 7_000, POLL_INTERVAL_MS);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].disagreementMs).toBe(5_000);
  });
});

describe('demotedWritesMessage', () => {
  it('reports counted writes when commandstats supplied them', () => {
    const message = demotedWritesMessage({
      nodeId: 'a',
      nodeAddress: 'a:6379',
      demotedForMs: 6_000,
      disagreementMs: 5_000,
      opsPerSec: 120,
      writeCallsDelta: 12,
    });

    expect(message).toContain('12 write commands');
  });

  it('reports ops when commandstats was unavailable', () => {
    const message = demotedWritesMessage({
      nodeId: 'a',
      nodeAddress: 'a:6379',
      demotedForMs: 6_000,
      disagreementMs: 5_000,
      opsPerSec: 120,
    });

    expect(message).toContain('120 ops/sec');
  });
});
