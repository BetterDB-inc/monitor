import { WebhookEventType } from '@betterdb/shared';
import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ClusterMetricsService, NodeStats } from '../cluster/cluster-metrics.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { OtelEventDispatcherService } from '../otel-telemetry/otel-event-dispatcher.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

const CONNECTION_ID = 'conn-1';
const INSTANCE = { host: '10.0.0.1', port: 6379 };

function nodeStats(overrides: Partial<NodeStats> & { nodeId: string }): NodeStats {
  return {
    nodeAddress: `${overrides.nodeId}:6379`,
    role: 'replica',
    memoryUsed: 0,
    memoryPeak: 0,
    memoryFragmentationRatio: 1,
    opsPerSec: 0,
    connectedClients: 0,
    blockedClients: 0,
    inputKbps: 0,
    outputKbps: 0,
    ...overrides,
  };
}

const POLL_INTERVAL_MS = 5000;

describe('PrometheusService demoted-writes detection', () => {
  let service: PrometheusService;
  let getClusterNodeStats: jest.Mock;
  let dispatchClusterDemotedWrites: jest.Mock;
  let otelDispatch: jest.Mock;

  function buildService(options: { withProWebhooks: boolean }): PrometheusService {
    const registry = {
      getConfig: jest.fn().mockReturnValue(INSTANCE),
      list: jest.fn().mockReturnValue([]),
      getName: jest.fn().mockReturnValue('primary'),
    } as unknown as ConnectionRegistry;

    const proService = options.withProWebhooks
      ? ({ dispatchClusterDemotedWrites } as never)
      : undefined;

    return new PrometheusService(
      {} as StoragePort,
      registry,
      { get: jest.fn().mockReturnValue(POLL_INTERVAL_MS) } as unknown as ConfigService,
      {} as RuntimeCapabilityTracker,
      {} as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
      undefined,
      proService,
      undefined,
      undefined,
      { dispatch: otelDispatch } as unknown as OtelEventDispatcherService,
      { getClusterNodeStats } as unknown as ClusterMetricsService,
    );
  }

  function armWatch(): ReturnType<PrometheusService['getConnectionState']> {
    const state = service['getConnectionState'](CONNECTION_ID);
    state.demotionWatch.set('node-a', {
      demotedAt: Date.now(),
      disagreementSince: null,
      consecutiveDisagreements: 0,
      writeCallsSeen: 0,
      writeCallsComplete: true,
      peakOpsPerSec: 0,
      alerted: false,
    });
    return state;
  }

  /**
   * Run the detector once per supplied poll, against an already-armed watch,
   * spacing the polls a full interval apart the way the scheduler does.
   */
  async function poll(stats: NodeStats[][], gapMs: number = POLL_INTERVAL_MS): Promise<void> {
    const state = armWatch();
    for (const nodes of stats) {
      jest.setSystemTime(Date.now() + gapMs);
      getClusterNodeStats.mockResolvedValueOnce(nodes);
      await service['detectDemotedMasterWrites'](CONNECTION_ID, state, INSTANCE);
    }
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    getClusterNodeStats = jest.fn();
    dispatchClusterDemotedWrites = jest.fn().mockResolvedValue(undefined);
    otelDispatch = jest.fn();
    service = buildService({ withProWebhooks: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not touch the nodes while nothing is being watched', async () => {
    const state = service['getConnectionState'](CONNECTION_ID);

    await service['detectDemotedMasterWrites'](CONNECTION_ID, state, null);

    expect(getClusterNodeStats).not.toHaveBeenCalled();
  });

  it('reads only the watched nodes, with commandstats', async () => {
    await poll([[nodeStats({ nodeId: 'node-a', selfReportedRole: 'master', opsPerSec: 120 })]]);

    expect(getClusterNodeStats).toHaveBeenCalledWith(CONNECTION_ID, {
      includeCommandStats: true,
      nodeIds: ['node-a'],
    });
  });

  it('gives up on a node that does not answer instead of stalling the poll', async () => {
    const state = armWatch();
    getClusterNodeStats.mockReturnValueOnce(new Promise(() => {}));

    const pass = service['detectDemotedMasterWrites'](CONNECTION_ID, state, INSTANCE);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await pass;

    expect(state.demotionWatch.get('node-a')?.consecutiveDisagreements).toBe(0);
    expect(dispatchClusterDemotedWrites).not.toHaveBeenCalled();
  });

  it('dispatches to OTLP and the Pro webhook once the disagreement persists', async () => {
    await poll([
      [
        nodeStats({
          nodeId: 'node-a',
          selfReportedRole: 'master',
          opsPerSec: 120,
          writeCommandCalls: 500,
        }),
      ],
      [
        nodeStats({
          nodeId: 'node-a',
          selfReportedRole: 'master',
          opsPerSec: 120,
          writeCommandCalls: 512,
        }),
      ],
    ]);

    expect(otelDispatch).toHaveBeenCalledTimes(1);
    const [eventType, attributes] = otelDispatch.mock.calls[0];
    expect(eventType).toBe(WebhookEventType.CLUSTER_DEMOTED_WRITES);
    expect(attributes).toMatchObject({ nodeId: 'node-a', writeCallsDelta: 12 });

    expect(dispatchClusterDemotedWrites).toHaveBeenCalledTimes(1);
    expect(dispatchClusterDemotedWrites.mock.calls[0][0]).toMatchObject({
      nodeId: 'node-a',
      writeCallsDelta: 12,
      instance: INSTANCE,
      connectionId: CONNECTION_ID,
    });
  });

  it('stays quiet when two scrapes land inside one poll interval', async () => {
    await poll(
      [
        [nodeStats({ nodeId: 'node-a', selfReportedRole: 'master', opsPerSec: 120 })],
        [nodeStats({ nodeId: 'node-a', selfReportedRole: 'master', opsPerSec: 120 })],
      ],
      40,
    );

    expect(otelDispatch).not.toHaveBeenCalled();
    expect(dispatchClusterDemotedWrites).not.toHaveBeenCalled();
  });

  it('stays quiet for a demoted node that agrees it is a replica', async () => {
    const agreeing = [nodeStats({ nodeId: 'node-a', selfReportedRole: 'replica', opsPerSec: 120 })];

    await poll([agreeing, agreeing]);

    expect(otelDispatch).not.toHaveBeenCalled();
    expect(dispatchClusterDemotedWrites).not.toHaveBeenCalled();
  });

  it('keeps the watch armed when the per-node read fails', async () => {
    const state = armWatch();
    getClusterNodeStats.mockRejectedValueOnce(new Error('all nodes unreachable'));

    await service['detectDemotedMasterWrites'](CONNECTION_ID, state, null);

    expect(state.demotionWatch.get('node-a')?.consecutiveDisagreements).toBe(0);
    expect(dispatchClusterDemotedWrites).not.toHaveBeenCalled();
  });

  it('still mirrors to OTLP on a deployment with no Pro webhook service', async () => {
    service = buildService({ withProWebhooks: false });
    const disagreeing = [
      nodeStats({ nodeId: 'node-a', selfReportedRole: 'master', opsPerSec: 120 }),
    ];

    await poll([disagreeing, disagreeing]);

    expect(otelDispatch).toHaveBeenCalledTimes(1);
    expect(dispatchClusterDemotedWrites).not.toHaveBeenCalled();
  });
});
