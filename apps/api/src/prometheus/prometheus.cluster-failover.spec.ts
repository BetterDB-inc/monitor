import { WebhookEventType } from '@betterdb/shared';
import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ClusterIdentityService, clusterStateSignature } from '../cluster/cluster-identity.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { OtelEventDispatcherService } from '../otel-telemetry/otel-event-dispatcher.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { ClusterNode } from '../common/types/metrics.types';

const SEED = 'seed';
const MEMBERS = ['member-1', 'member-2'];
const POLL_INTERVAL_MS = 5000;

interface FakeConfig {
  host: string;
  port: number;
  membership?: { seedId: string; nodeId: string; origin: 'auto' | 'adopted'; source: 'cluster' };
}

function primary(id: string, configEpoch = 1): ClusterNode {
  return {
    id,
    address: `${id}:6379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch,
    linkState: 'connected',
    slots: [[0, 100]],
  };
}

function replica(id: string, masterId: string): ClusterNode {
  return { ...primary(id), flags: ['slave'], master: masterId, slots: [] };
}

const HEALTHY = [
  primary('a'),
  replica('b', 'a'),
  replica('c', 'a'),
  primary('x'),
  replica('y', 'x'),
];
const B_PROMOTED = [
  replica('a', 'b'),
  primary('b', 7),
  replica('c', 'b'),
  primary('x'),
  replica('y', 'x'),
];
const B_AND_Y_PROMOTED = [...B_PROMOTED.slice(0, 3), replica('x', 'y'), primary('y', 9)];
const OTHER_CLUSTER = [primary('p'), replica('q', 'p')];
const OTHER_CLUSTER_Q_PROMOTED = [replica('p', 'q'), primary('q', 7)];

describe('PrometheusService cluster.failover per cluster', () => {
  let service: PrometheusService;
  let configs: Record<string, FakeConfig>;
  let connected: Set<string>;
  let views: Record<string, ClusterNode[]>;
  let clusterInfos: Record<string, Record<string, string>>;
  let dispatchClusterFailover: jest.Mock;
  let otelDispatch: jest.Mock;
  let identity: ClusterIdentityService;

  const member = (seedId: string, host: string): FakeConfig => ({
    host,
    port: 6379,
    membership: { seedId, nodeId: host, origin: 'auto', source: 'cluster' },
  });

  const clusterInfo = (overrides: Record<string, string> = {}): Record<string, string> => ({
    cluster_state: 'ok',
    cluster_slots_fail: '0',
    cluster_slots_assigned: '16384',
    cluster_known_nodes: '5',
    cluster_size: '2',
    ...overrides,
  });

  async function poll(
    connectionId: string,
    duringTopologyRead: () => void = () => undefined,
  ): Promise<void> {
    const client = {
      getClusterInfo: jest.fn(async () => clusterInfos[connectionId] ?? clusterInfo()),
      getClusterNodes: jest.fn(async () => {
        duringTopologyRead();
        return views[connectionId];
      }),
      getCapabilities: jest.fn().mockReturnValue({ hasClusterSlotStats: false }),
    };
    await service['updateClusterMetricsFromInfo'](
      client as never,
      { cluster: { cluster_enabled: '1' } } as never,
      connectionId,
      connectionId,
      service['getConnectionState'](connectionId),
      configs[connectionId],
    );
  }

  async function pollAll(connectionIds: string[], nodes: ClusterNode[]): Promise<void> {
    for (const connectionId of connectionIds) {
      views[connectionId] = nodes;
      await poll(connectionId);
    }
  }

  const failoverEvents = (): Array<Record<string, unknown>> =>
    dispatchClusterFailover.mock.calls.map(([event]) => event);

  const otlpFailovers = (): unknown[][] =>
    otelDispatch.mock.calls.filter(([type]) => type === WebhookEventType.CLUSTER_FAILOVER);

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    configs = {
      [SEED]: { host: '10.0.0.1', port: 6379 },
      'member-1': member(SEED, '10.0.0.2'),
      'member-2': member(SEED, '10.0.0.3'),
      'manual-1': { host: '10.0.1.1', port: 6379 },
      'manual-2': { host: '10.0.1.2', port: 6379 },
    };
    connected = new Set(Object.keys(configs));
    views = {};
    clusterInfos = {};
    dispatchClusterFailover = jest.fn().mockResolvedValue(undefined);
    otelDispatch = jest.fn();
    const registry = {
      getConfig: jest.fn((id: string) => configs[id] ?? null),
      get: jest.fn((id: string) => ({ isConnected: () => connected.has(id) })),
      list: jest.fn(() => Object.entries(configs).map(([id, config]) => ({ id, ...config }))),
      addConnectionRemovalListener: jest.fn().mockReturnValue(() => undefined),
    } as unknown as ConnectionRegistry;
    identity = new ClusterIdentityService(registry);
    service = new PrometheusService(
      {} as StoragePort,
      registry,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'PROMETHEUS_STALENESS_MS' ? undefined : (fallback ?? POLL_INTERVAL_MS),
        ),
      } as unknown as ConfigService,
      { isAvailable: () => true, recordFailure: jest.fn() } as unknown as RuntimeCapabilityTracker,
      {} as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
      undefined,
      { dispatchClusterFailover } as never,
      undefined,
      undefined,
      { dispatch: otelDispatch } as unknown as OtelEventDispatcherService,
      undefined,
      undefined,
      undefined,
      undefined,
      identity,
    );
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends one event when every connection of the cluster sees the promotion', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);

    await pollAll([SEED, ...MEMBERS], B_PROMOTED);

    expect(failoverEvents()).toHaveLength(1);
    expect(otlpFailovers()).toHaveLength(1);
  });

  it('reports every changed node of the failover in that one event', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);

    await pollAll([SEED, ...MEMBERS], B_PROMOTED);

    const [event] = failoverEvents();
    expect((event.changedNodes as Array<{ nodeId: string }>).map((c) => c.nodeId).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(event.reasons).toEqual(['role_change', 'primary_change']);
  });

  it('sends one event when the connections see different parts in different polls', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    const promotionOnly = [primary('a'), primary('b', 7), replica('c', 'a'), ...HEALTHY.slice(3)];
    const replicaFollowed = [primary('a'), primary('b', 7), replica('c', 'b'), ...HEALTHY.slice(3)];

    await pollAll([SEED], promotionOnly);
    await pollAll(['member-1'], promotionOnly);
    await pollAll(['member-1'], replicaFollowed);
    jest.setSystemTime(Date.now() + 5 * 60_000);
    await pollAll(['member-2'], B_PROMOTED);

    expect(failoverEvents()).toHaveLength(1);
  });

  it('sends no second event when the old primary rejoins after the epoch of the new one moved', async () => {
    const everyone = [SEED, ...MEMBERS];
    const rest = HEALTHY.slice(3);
    await pollAll(everyone, HEALTHY);
    await pollAll(everyone, [primary('a'), primary('b', 7), replica('c', 'b'), ...rest]);
    jest.setSystemTime(Date.now() + 2 * 60_000);

    await pollAll(everyone, [replica('a', 'b'), primary('b', 8), replica('c', 'b'), ...rest]);

    expect(failoverEvents()).toHaveLength(1);
  });

  it('sends one event for two connections a user added to the same cluster', async () => {
    await pollAll(['manual-1', 'manual-2'], HEALTHY);

    await pollAll(['manual-1', 'manual-2'], B_PROMOTED);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({
      connectionId: 'manual-1',
      instance: { host: '10.0.1.1', port: 6379 },
    });
  });

  it('sends one event per cluster when two clusters fail over', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    await pollAll(['manual-1', 'manual-2'], OTHER_CLUSTER);

    await pollAll([SEED, ...MEMBERS], B_PROMOTED);
    await pollAll(['manual-1', 'manual-2'], OTHER_CLUSTER_Q_PROMOTED);

    expect(failoverEvents().map((event) => event.connectionId)).toEqual([SEED, 'manual-1']);
  });

  it('sends a second event when another shard fails over in the same minute', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    await pollAll([SEED, ...MEMBERS], B_PROMOTED);
    jest.setSystemTime(Date.now() + 10_000);

    await pollAll([SEED, ...MEMBERS], B_AND_Y_PROMOTED);

    expect(failoverEvents()).toHaveLength(2);
    expect(
      (failoverEvents()[1].changedNodes as Array<{ nodeId: string }>).map((c) => c.nodeId).sort(),
    ).toEqual(['x', 'y']);
  });

  it('files the event under the seed when a member sees the failover first', async () => {
    await pollAll([...MEMBERS, SEED], HEALTHY);

    await pollAll([...MEMBERS, SEED], B_PROMOTED);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({
      connectionId: SEED,
      instance: { host: '10.0.0.1', port: 6379 },
    });
    expect(otlpFailovers()[0][2]).toBe(SEED);
  });

  it('files the event under the seed also while the seed is not connected', async () => {
    await pollAll(MEMBERS, HEALTHY);
    connected.delete(SEED);

    await pollAll(MEMBERS, B_PROMOTED);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({
      connectionId: SEED,
      instance: { host: '10.0.0.1', port: 6379 },
    });
    expect(otlpFailovers()[0][2]).toBe(SEED);
  });

  it('files the event under the member that saw it when the seed was removed', async () => {
    await pollAll(MEMBERS, HEALTHY);
    delete configs[SEED];

    await pollAll(MEMBERS, B_PROMOTED);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({
      connectionId: 'member-1',
      instance: { host: '10.0.0.2', port: 6379 },
    });
  });

  it('sends one event when every connection sees the cluster state fail', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    for (const id of [SEED, ...MEMBERS]) clusterInfos[id] = clusterInfo({ cluster_state: 'fail' });

    await pollAll([SEED, ...MEMBERS], HEALTHY);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({ reasons: ['cluster_state'], connectionId: SEED });
    expect(otlpFailovers()).toHaveLength(1);
  });

  it('sends one event when every connection sees slots fail', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    for (const id of [SEED, ...MEMBERS]) {
      clusterInfos[id] = clusterInfo({ cluster_slots_fail: '100' });
    }

    await pollAll([SEED, ...MEMBERS], HEALTHY);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({ reasons: ['slot_failures'] });
  });

  it('reports a state failure and slot failures seen in one poll as one event', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    for (const id of [SEED, ...MEMBERS]) {
      clusterInfos[id] = clusterInfo({ cluster_state: 'fail', cluster_slots_fail: '100' });
    }

    await pollAll([SEED, ...MEMBERS], HEALTHY);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({ reasons: ['cluster_state', 'slot_failures'] });
    expect(otlpFailovers()).toHaveLength(1);
  });

  it('sends one event when one connection sees the state fail and another sees slots fail', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    clusterInfos[SEED] = clusterInfo({ cluster_state: 'fail' });
    clusterInfos['member-1'] = clusterInfo({ cluster_slots_fail: '100' });

    await pollAll([SEED, 'member-1'], HEALTHY);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({ reasons: ['cluster_state'] });
    expect(otlpFailovers()).toHaveLength(1);
  });

  it('sends nothing for slot failures of an outage the anomaly service already reported', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    identity.claimFailover(identity.clusterKeyOf(SEED), clusterStateSignature('fail'), Date.now());
    for (const id of [SEED, ...MEMBERS]) {
      clusterInfos[id] = clusterInfo({ cluster_state: 'fail', cluster_slots_fail: '100' });
    }

    await pollAll([SEED, ...MEMBERS], HEALTHY);

    expect(failoverEvents()).toHaveLength(0);
    expect(otlpFailovers()).toHaveLength(0);
  });

  it('reports a second outage that follows a reported recovery within a minute', async () => {
    const everyone = [SEED, ...MEMBERS];
    await pollAll(everyone, HEALTHY);
    for (const id of everyone) clusterInfos[id] = clusterInfo({ cluster_state: 'fail' });
    await pollAll(everyone, HEALTHY);
    identity.claimFailover(identity.clusterKeyOf(SEED), clusterStateSignature('ok'), Date.now());
    for (const id of everyone) clusterInfos[id] = clusterInfo();
    await pollAll(everyone, HEALTHY);
    for (const id of everyone) clusterInfos[id] = clusterInfo({ cluster_state: 'fail' });

    await pollAll(everyone, HEALTHY);

    expect(failoverEvents()).toHaveLength(2);
    expect(otlpFailovers()).toHaveLength(2);
  });

  it('reports a second outage within a minute when no other service reports the recovery', async () => {
    const everyone = [SEED, ...MEMBERS];
    await pollAll(everyone, HEALTHY);
    for (const state of ['fail', 'ok', 'fail']) {
      jest.advanceTimersByTime(POLL_INTERVAL_MS);
      for (const id of everyone) clusterInfos[id] = clusterInfo({ cluster_state: state });
      await pollAll(everyone, HEALTHY);
    }

    expect(failoverEvents()).toHaveLength(2);
    expect(otlpFailovers()).toHaveLength(2);
  });

  it('reports a second outage after another service reported the recovery it sighted', async () => {
    const everyone = [SEED, ...MEMBERS];
    await pollAll(everyone, HEALTHY);
    for (const state of ['fail', 'ok']) {
      jest.advanceTimersByTime(POLL_INTERVAL_MS);
      for (const id of everyone) clusterInfos[id] = clusterInfo({ cluster_state: state });
      await pollAll(everyone, HEALTHY);
    }
    jest.advanceTimersByTime(1000);
    identity.claimFailover(identity.clusterKeyOf(SEED), clusterStateSignature('ok'), Date.now());
    jest.advanceTimersByTime(POLL_INTERVAL_MS - 1000);
    for (const id of everyone) clusterInfos[id] = clusterInfo({ cluster_state: 'fail' });

    await pollAll(everyone, HEALTHY);

    expect(failoverEvents()).toHaveLength(2);
    expect(otlpFailovers()).toHaveLength(2);
  });

  it('sends nothing more when a node shows the first recovery after the second outage', async () => {
    await pollAll([SEED, 'member-1'], HEALTHY);
    const seen: Array<[string, string]> = [
      [SEED, 'fail'],
      ['member-1', 'fail'],
      [SEED, 'ok'],
      [SEED, 'fail'],
      ['member-1', 'ok'],
      ['member-1', 'fail'],
    ];
    for (const [id, state] of seen) {
      jest.advanceTimersByTime(POLL_INTERVAL_MS);
      clusterInfos[id] = clusterInfo({ cluster_state: state });
      await pollAll([id], HEALTHY);
    }

    expect(failoverEvents()).toHaveLength(2);
    expect(otlpFailovers()).toHaveLength(2);
  });

  it('files the outage a removed node shows under that node only', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    clusterInfos['member-2'] = clusterInfo({ cluster_state: 'fail', cluster_known_nodes: '1' });

    await pollAll(['member-2'], [primary('c')]);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({
      connectionId: 'member-2',
      instance: { host: '10.0.0.3', port: 6379 },
      alsoScopedTo: [],
    });
  });

  it('still reports an outage of the cluster after a removed node showed one', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    clusterInfos['member-2'] = clusterInfo({ cluster_state: 'fail', cluster_known_nodes: '1' });
    await pollAll(['member-2'], [primary('c')]);
    clusterInfos[SEED] = clusterInfo({ cluster_state: 'fail' });

    await pollAll(
      [SEED],
      HEALTHY.filter((node) => node.id !== 'c'),
    );

    expect(failoverEvents()).toHaveLength(2);
    expect(failoverEvents()[1]).toMatchObject({ connectionId: SEED });
  });

  it('forgets the cluster of a connection that no longer runs in cluster mode', async () => {
    await pollAll([SEED, 'manual-1'], HEALTHY);

    await service['updateClusterMetricsFromInfo'](
      {} as never,
      { cluster: { cluster_enabled: '0' } } as never,
      'manual-1',
      'manual-1',
      service['getConnectionState']('manual-1'),
      configs['manual-1'],
    );

    expect(identity.clusterKeyOf('manual-1')).toBe('manual-1');
  });

  it('sends nothing for the late failure of a node after the recovery was reported', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    const clusterKey = identity.clusterKeyOf(SEED);
    identity.claimFailover(clusterKey, clusterStateSignature('fail'), Date.now());
    identity.claimFailover(clusterKey, clusterStateSignature('ok'), Date.now());
    clusterInfos['member-1'] = clusterInfo({ cluster_state: 'fail', cluster_slots_fail: '100' });

    await pollAll(['member-1'], HEALTHY);

    expect(failoverEvents()).toHaveLength(0);
    expect(otlpFailovers()).toHaveLength(0);
  });

  it('names the other user-added connection of the cluster for its scoped webhooks', async () => {
    await pollAll(['manual-1', 'manual-2'], HEALTHY);

    await pollAll(['manual-1', 'manual-2'], B_PROMOTED);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({
      connectionId: 'manual-1',
      alsoScopedTo: [{ connectionId: 'manual-2', instance: { host: '10.0.1.2', port: 6379 } }],
    });
  });

  it('names the members for their scoped webhooks when the seed is down', async () => {
    connected.delete(SEED);
    await pollAll(MEMBERS, HEALTHY);

    await pollAll(MEMBERS, B_PROMOTED);

    expect(failoverEvents()).toHaveLength(1);
    expect(failoverEvents()[0]).toMatchObject({
      connectionId: SEED,
      alsoScopedTo: [
        { connectionId: 'member-1', instance: { host: '10.0.0.2', port: 6379 } },
        { connectionId: 'member-2', instance: { host: '10.0.0.3', port: 6379 } },
      ],
    });
  });

  it('names no connection of another cluster', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    await pollAll(['manual-1', 'manual-2'], OTHER_CLUSTER);

    await pollAll(['manual-1'], OTHER_CLUSTER_Q_PROMOTED);

    expect(failoverEvents()[0].alsoScopedTo).toEqual([
      { connectionId: 'manual-2', instance: { host: '10.0.1.2', port: 6379 } },
    ]);
  });

  it('reports only what is new when a poll sees a reported state change and a promotion', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    for (const id of [SEED, ...MEMBERS]) clusterInfos[id] = clusterInfo({ cluster_state: 'fail' });
    await pollAll([SEED], HEALTHY);

    await pollAll(['member-1'], B_PROMOTED);

    expect(failoverEvents()).toHaveLength(2);
    expect(failoverEvents()[1].reasons).toEqual(['role_change', 'primary_change']);
  });

  it('still watches each connection for a demoted primary that takes writes', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);

    await pollAll([SEED, ...MEMBERS], B_PROMOTED);

    for (const id of [SEED, ...MEMBERS]) {
      expect([...service['getConnectionState'](id).demotionWatch.keys()]).toEqual(['a']);
    }
  });

  it('sends nothing for a state change another poller already reported', async () => {
    await pollAll([SEED, ...MEMBERS], HEALTHY);
    identity.claimFailover(identity.clusterKeyOf(SEED), clusterStateSignature('fail'), Date.now());
    for (const id of [SEED, ...MEMBERS]) clusterInfos[id] = clusterInfo({ cluster_state: 'fail' });

    await pollAll([SEED, ...MEMBERS], HEALTHY);

    expect(failoverEvents()).toHaveLength(0);
    expect(otlpFailovers()).toHaveLength(0);
  });

  it('tells the identity service which cluster a connection reads', async () => {
    await pollAll(['manual-1', 'manual-2'], HEALTHY);

    expect(identity.clusterKeyOf('manual-1')).toBe(identity.clusterKeyOf('manual-2'));
    expect(identity.clusterKeyOf('manual-1')).not.toBe('manual-1');
  });

  it('keeps the topology of a pass that was replaced during the read to itself', async () => {
    views['manual-1'] = HEALTHY;

    await poll('manual-1', () => service['retireEpoch']('manual-1'));

    expect(identity.clusterKeyOf('manual-1')).toBe('manual-1');
  });
});
