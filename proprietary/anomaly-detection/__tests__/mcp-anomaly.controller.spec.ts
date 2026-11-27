import { HttpException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { McpAnomalyController } from '../mcp-anomaly.controller';
import { AnomalyService } from '../anomaly.service';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { LicenseGuard } from '@proprietary/licenses';
import { PlacementService } from '../../placement/placement.service';

describe('McpAnomalyController', () => {
  let controller: McpAnomalyController;
  const svc = {
    getRecentAnomalies: jest.fn(),
    getIncidentTimelines: jest.fn(),
    getRetryAmplificationStatus: jest.fn(),
    getHotShards: jest.fn(),
    getTopologyDisagreements: jest.fn(),
    getReplicationDivergenceHistory: jest.fn(),
    getRebalanceRunsSnapshot: jest.fn(),
    getTopologyDivergence: jest.fn(),
  };
  const registry = { get: jest.fn() };
  const placement = { withPlacementBlocker: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    svc.getRecentAnomalies.mockResolvedValue([{ id: 'a1' }]);
    svc.getReplicationDivergenceHistory.mockResolvedValue([{ replica: '10.0.0.2:6379' }]);
    const mod = await Test.createTestingModule({
      controllers: [McpAnomalyController],
      providers: [
        { provide: AnomalyService, useValue: svc },
        { provide: ConnectionRegistry, useValue: registry },
        { provide: PlacementService, useValue: placement },
      ],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(LicenseGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpAnomalyController);
  });

  it('anomalies forwards filters and returns the raw event list', async () => {
    const res = await controller.getAnomalies('inst1', '10', 'memory_used', '5000');
    expect(res).toEqual([{ id: 'a1' }]);
    expect(svc.getRecentAnomalies).toHaveBeenCalledWith(
      5000,
      undefined,
      undefined,
      'memory_used',
      10,
      'inst1',
    );
  });

  it('replication divergence returns 404 for an unregistered instance', async () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException('nope');
    });

    await expect(controller.getReplicationDivergence('ghost')).rejects.toMatchObject({ status: 404 });
    expect(svc.getReplicationDivergenceHistory).not.toHaveBeenCalled();
  });

  it('replication divergence returns per-replica series with divergence events', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000);
    const res = await controller.getReplicationDivergence('inst1', '5', undefined);
    expect(res).toEqual({ replicas: [{ replica: '10.0.0.2:6379' }], events: [{ id: 'a1' }] });
    expect(svc.getReplicationDivergenceHistory).toHaveBeenCalledWith('inst1', 10_000_000 - 3_600_000, 10_000_000);
    expect(svc.getRecentAnomalies).toHaveBeenCalledWith(
      10_000_000 - 86_400_000,
      undefined,
      undefined,
      'replication_divergence',
      5,
      'inst1',
    );
    jest.restoreAllMocks();
  });

  it('replication divergence keeps the replica series when events cannot be read', async () => {
    svc.getRecentAnomalies.mockRejectedValueOnce(new Error('db down'));

    const res = await controller.getReplicationDivergence('inst1', undefined, undefined);

    expect(res).toEqual({
      replicas: [{ replica: '10.0.0.2:6379' }],
      events: [],
      eventsUnavailable: true,
    });
  });

  it('anomalies rejects unknown metricType with 400', async () => {
    let caught: unknown;
    try {
      await controller.getAnomalies('inst1', undefined, 'bogus_metric', undefined);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(400);
    expect(svc.getRecentAnomalies).not.toHaveBeenCalled();
  });

  it('anomalies passes undefined metricType when empty', async () => {
    await controller.getAnomalies('inst1', undefined, '', undefined);
    const args = svc.getRecentAnomalies.mock.calls[0];
    expect(args[3]).toBeUndefined();
    expect(args[4]).toBe(100);
  });

  it('accepts command_p99 as a metricType filter (latency regressions path)', async () => {
    const res = await controller.getAnomalies('inst1', '10', 'command_p99', '5000');
    expect(res).toEqual([{ id: 'a1' }]);
    expect(svc.getRecentAnomalies).toHaveBeenCalledWith(
      5000,
      undefined,
      undefined,
      'command_p99',
      10,
      'inst1',
    );
  });

  it('maps service failures to 500', async () => {
    svc.getRecentAnomalies.mockRejectedValueOnce(new Error('boom'));
    let caught: unknown;
    try {
      await controller.getAnomalies('inst1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(500);
  });

  it('incidents forwards the instance, start time and limit', async () => {
    svc.getIncidentTimelines.mockResolvedValueOnce([{ incidentId: 'i1' }]);

    const res = await controller.getIncidents('inst1', '5', '5000');

    expect(res).toEqual([{ incidentId: 'i1' }]);
    expect(svc.getIncidentTimelines).toHaveBeenCalledWith('inst1', 5000, undefined, 5);
  });

  it('incidents maps service failures to 500', async () => {
    svc.getIncidentTimelines.mockRejectedValueOnce(new Error('boom'));

    await expect(controller.getIncidents('inst1')).rejects.toBeInstanceOf(HttpException);
  });

  it('retry amplification returns the detector status for the instance', () => {
    const status = { armed: true, classification: 'none', topContributors: null };
    svc.getRetryAmplificationStatus.mockReturnValue(status);

    expect(controller.getRetryAmplification('inst1')).toBe(status);
    expect(svc.getRetryAmplificationStatus).toHaveBeenCalledWith('inst1');
  });

  it('retry amplification returns 404 for an unregistered instance', () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException('nope');
    });

    let caught: unknown;
    try {
      controller.getRetryAmplification('ghost');
    } catch (error) {
      caught = error;
    }

    expect((caught as HttpException).getStatus()).toBe(404);
    expect(svc.getRetryAmplificationStatus).not.toHaveBeenCalled();
  });

  it('hot shards returns the open hot shards of the instance marked with the placement mode', async () => {
    const shards = [{ shardId: 'a0000000', rebalance: { kind: 'plan', moves: [] } }];
    const marked = [{ shardId: 'a0000000', rebalance: { kind: 'plan', moves: [], execution: { available: false, blockedBy: 'observe_mode' } } }];
    svc.getHotShards.mockReturnValue(shards);
    placement.withPlacementBlocker.mockResolvedValue(marked);

    expect(await controller.getHotShards('inst1')).toBe(marked);
    expect(svc.getHotShards).toHaveBeenCalledWith('inst1');
    expect(placement.withPlacementBlocker).toHaveBeenCalledWith('inst1', shards);
  });

  it('hot shards returns 404 for an unregistered instance', async () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException('nope');
    });

    const caught = await controller.getHotShards('ghost').catch((error: unknown) => error);

    expect((caught as HttpException).getStatus()).toBe(404);
    expect(svc.getHotShards).not.toHaveBeenCalled();
  });

  it('topology disagreements returns the summary of the instance', () => {
    const summary = {
      status: 'ok',
      coverage: { nodes: 500, answered: 12, complete: false },
      disagreements: [],
      shards: [],
      fullCheck: { state: 'none' },
    };
    svc.getTopologyDisagreements.mockReturnValue(summary);

    expect(controller.getTopologyDisagreements('inst1', 'all')).toBe(summary);
    expect(controller.getTopologyDisagreements('inst1')).toEqual({ ...summary, shardsListed: 'disputed' });
    expect(svc.getTopologyDisagreements).toHaveBeenCalledWith('inst1');
  });

  it('topology disagreements carries the last full check and offers no way to start one', () => {
    const report = { status: 'ok', disagreements: [], shards: [], fullCheck: { state: 'done', asked: 500, total: 500 } };
    svc.getTopologyDisagreements.mockReturnValue(report);

    expect(controller.getTopologyDisagreements('inst1')).toMatchObject({ fullCheck: { state: 'done', total: 500 } });
    expect(Object.getOwnPropertyNames(McpAnomalyController.prototype).filter((name) => /fullcheck/i.test(name))).toEqual(
      [],
    );
  });

  it('topology disagreements returns 404 for an unregistered instance', () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException('nope');
    });

    let caught: unknown;
    try {
      controller.getTopologyDisagreements('ghost');
    } catch (error) {
      caught = error;
    }

    expect((caught as HttpException).getStatus()).toBe(404);
    expect(svc.getTopologyDisagreements).not.toHaveBeenCalled();
  });

  it('topology disagreements is served under the instance anomalies path', () => {
    expect(Reflect.getMetadata('path', McpAnomalyController.prototype.getTopologyDisagreements)).toBe(
      'instance/:id/anomalies/topology-disagreements',
    );
  });

  it('rebalance runs keep the user id, drop the email and keep the order', () => {
    const run = (sourceShardId: string, startedAt: number) => ({
      sourceShardId,
      startedAt,
      state: 'running',
      startedBy: { userId: 'u1', email: 'admin@example.com' },
      jobs: [],
    });
    const runs = [run('b', 2000), run('a', 1000)];
    svc.getRebalanceRunsSnapshot.mockReturnValue(runs);

    expect(controller.getRebalanceRuns('inst1')).toEqual(
      runs.map((entry) => ({ ...entry, startedBy: { userId: 'u1', email: null } })),
    );
    expect(svc.getRebalanceRunsSnapshot).toHaveBeenCalledWith('inst1');
    expect(runs[0].startedBy.email).toBe('admin@example.com');
  });

  it('rebalance runs return 404 for an unregistered instance', () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException('nope');
    });

    let caught: unknown;
    try {
      controller.getRebalanceRuns('ghost');
    } catch (error) {
      caught = error;
    }

    expect((caught as HttpException).getStatus()).toBe(404);
    expect(svc.getRebalanceRunsSnapshot).not.toHaveBeenCalled();
  });

  it('topology divergence caps the node and entry lists and reports the totals', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({ nodeId: `n${i}`, address: '', role: 'primary' }));
    const divergence = { eventId: null, confirmed: false, since: 1, sides: [{ nodes }], disagreements: [] };
    svc.getTopologyDivergence.mockReturnValue({
      status: 'ok',
      sampledAt: 1000,
      observers: nodes,
      unanswered: [],
      divergences: Array.from({ length: 60 }, () => divergence),
      partialMembership: [],
    });

    const report = controller.getTopologyDivergence('inst1');

    expect(report.observers).toHaveLength(25);
    expect(report.divergences).toHaveLength(50);
    expect(report.divergences[0].sides[0].nodes).toHaveLength(25);
    expect(report.divergences[0].sides[0].nodesCount).toBe(30);
    expect(report.totals).toEqual({ observers: 30, unanswered: 0, divergences: 60, partialMembership: 0 });
    expect(svc.getTopologyDivergence).toHaveBeenCalledWith('inst1');
  });

  it('topology divergence passes not_sampled through', () => {
    const empty = {
      status: 'not_sampled',
      sampledAt: null,
      observers: [],
      unanswered: [],
      divergences: [],
      partialMembership: [],
    };
    svc.getTopologyDivergence.mockReturnValue(empty);

    expect(controller.getTopologyDivergence('inst1')).toEqual({
      ...empty,
      totals: { observers: 0, unanswered: 0, divergences: 0, partialMembership: 0 },
    });
  });

  it('topology divergence returns 404 for an unregistered instance', () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException('nope');
    });

    let caught: unknown;
    try {
      controller.getTopologyDivergence('ghost');
    } catch (error) {
      caught = error;
    }

    expect((caught as HttpException).getStatus()).toBe(404);
    expect(svc.getTopologyDivergence).not.toHaveBeenCalled();
  });

  it('serves rebalance runs and topology divergence under the instance anomalies path', () => {
    expect(Reflect.getMetadata('path', McpAnomalyController.prototype.getRebalanceRuns)).toBe(
      'instance/:id/anomalies/slot-rebalance',
    );
    expect(Reflect.getMetadata('path', McpAnomalyController.prototype.getTopologyDivergence)).toBe(
      'instance/:id/anomalies/topology-divergence',
    );
  });
});
