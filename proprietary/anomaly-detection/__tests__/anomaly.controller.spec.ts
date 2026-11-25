import { BadRequestException, HttpException } from '@nestjs/common';
import { AnomalyController } from '../anomaly.controller';
import { AnomalyService } from '../anomaly.service';
import { LicenseGuard } from '@proprietary/licenses';
import { ALLOW_MEMBERS_KEY } from '@app/auth/guards/roles.decorator';

jest.mock('@proprietary/licenses', () => ({
  LicenseGuard: class {},
  RequiresFeature: () => () => undefined,
  Feature: { ANOMALY_DETECTION: 'anomaly-detection' },
}));

describe('AnomalyController time bounds', () => {
  const service = {
    getRecentAnomalies: jest.fn().mockResolvedValue([]),
    getRecentCorrelatedGroups: jest.fn().mockResolvedValue([]),
    getSummary: jest.fn().mockResolvedValue({}),
    getReplicationDivergenceHistory: jest.fn().mockResolvedValue([]),
    getIncidentTimelines: jest.fn().mockResolvedValue([]),
    getIncidentTimeline: jest.fn().mockResolvedValue({}),
  };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  const routes: Array<[string, (start?: string, end?: string) => Promise<unknown>]> = [
    ['events', async (s, e) => controller.getEvents(undefined, undefined, undefined, s, e)],
    ['groups', async (s, e) => controller.getGroups(undefined, undefined, undefined, s, e)],
    ['summary', async (s, e) => controller.getSummary(undefined, s, e)],
    ['replication-divergence', async (s, e) => controller.getReplicationDivergence('c1', s, e)],
    ['incidents', async (s, e) => controller.getIncidents(undefined, undefined, s, e)],
  ];

  beforeEach(() => jest.clearAllMocks());

  describe.each(routes)('%s', (_name, call) => {
    it.each([
      ['a non-numeric start', 'abc', undefined],
      ['a non-numeric end', undefined, 'abc'],
      ['a whitespace start', '   ', undefined],
      ['a whitespace end', undefined, '   '],
      ['an inverted range', '2000', '1000'],
    ])('rejects %s', async (_case, start, end) => {
      await expect(call(start, end)).rejects.toBeInstanceOf(BadRequestException);
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });

    it('accepts equal bounds', async () => {
      await expect(call('1000', '1000')).resolves.toBeDefined();
    });

    it('accepts missing bounds', async () => {
      await expect(call()).resolves.toBeDefined();
    });

    it('accepts fractional timestamps', async () => {
      await expect(call('1000.5', '2000.9')).resolves.toBeDefined();
    });
  });

  it('truncates fractional timestamps', async () => {
    await controller.getEvents(undefined, undefined, undefined, '1000.5', '2000.9');

    expect(service.getRecentAnomalies.mock.calls[0].slice(0, 2)).toEqual([1000, 2000]);
  });

  it('truncates a fractional start on the single incident route', async () => {
    await controller.getIncident('incident-1', 'c1', '1000.5');

    expect(service.getIncidentTimeline).toHaveBeenCalledWith('incident-1', 'c1', 1000);
  });

  it('honours an explicit start of 0 on the events route', async () => {
    await controller.getEvents(undefined, undefined, undefined, '0', '1000');

    expect(service.getRecentAnomalies.mock.calls[0].slice(0, 2)).toEqual([0, 1000]);
  });

});

describe('AnomalyController incident limit', () => {
  const service = { getIncidentTimelines: jest.fn().mockResolvedValue([]) };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  beforeEach(() => jest.clearAllMocks());

  it.each(['abc', '-1', '0', '1.5', '10abc', '   '])('rejects %j', async (limit) => {
    await expect(controller.getIncidents(undefined, limit)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.getIncidentTimelines).not.toHaveBeenCalled();
  });

  it('caps the limit at 1000', async () => {
    await controller.getIncidents('c1', '999999');
    await controller.getIncidents('c1', '1000');

    expect(service.getIncidentTimelines.mock.calls.map((c) => c[3])).toEqual([1000, 1000]);
  });

  it('passes a valid limit and defaults to 50', async () => {
    await controller.getIncidents('c1', '10');
    await controller.getIncidents('c1');

    expect(service.getIncidentTimelines.mock.calls.map((c) => c[3])).toEqual([10, 50]);
  });
});

describe('AnomalyController fan-out coverage', () => {
  const coverage = {
    connectionId: 'c1',
    topology: 'cluster',
    checked: 2,
    unreachable: 1,
    authFailed: 0,
    skipped: 0,
    notDialed: 0,
    reason: null,
    targetLimit: 64,
    timeoutMs: 2_000,
    timestamp: 1_000,
  };
  const service = { getFanoutCoverage: jest.fn().mockReturnValue([coverage]) };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  beforeEach(() => jest.clearAllMocks());

  it('returns the coverage of the connection in the header', () => {
    expect(controller.getCoverage('c1')).toEqual([coverage]);
    expect(service.getFanoutCoverage).toHaveBeenCalledWith('c1');
  });

  it('returns every connection without the header', () => {
    controller.getCoverage(undefined);

    expect(service.getFanoutCoverage).toHaveBeenCalledWith(undefined);
  });
});

describe('AnomalyController incident by event', () => {
  const service = { findIncidentIdByEvent: jest.fn() };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  beforeEach(() => jest.clearAllMocks());

  it('returns the incident id the service finds for the event', async () => {
    service.findIncidentIdByEvent.mockResolvedValue('incident-1');

    await expect(controller.getIncidentByEvent('a', 'c1', '1000.5')).resolves.toEqual({
      incidentId: 'incident-1',
    });
    expect(service.findIncidentIdByEvent).toHaveBeenCalledWith('a', 1000, 'c1');
  });

  it('answers with a null id instead of failing when no incident holds the event', async () => {
    service.findIncidentIdByEvent.mockResolvedValue(null);

    await expect(controller.getIncidentByEvent('a', 'c1', '1000')).resolves.toEqual({
      incidentId: null,
    });
  });

  it.each([undefined, '', 'abc'])('rejects an event time of %j', async (at) => {
    await expect(controller.getIncidentByEvent('a', 'c1', at)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.findIncidentIdByEvent).not.toHaveBeenCalled();
  });
});

describe('AnomalyController hot shards', () => {
  const detail = {
    shardId: 'a0000000',
    nodeAddr: '10.0.0.1:6379',
    topSlots: [{ slot: 12 }],
    topKeys: [{ key: 'user:42', slot: 12, freq: 255 }],
    keySource: 'lfu',
  };
  const service = { getHotShards: jest.fn().mockReturnValue([detail]) };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  beforeEach(() => jest.clearAllMocks());

  it('returns the open hot shards of the connection in the header', () => {
    expect(controller.getHotShards('c1')).toEqual([detail]);
    expect(service.getHotShards).toHaveBeenCalledWith('c1');
  });

  it('is served at hot-shards and requires the connection header', () => {
    const args = Reflect.getMetadata('__routeArguments__', AnomalyController, 'getHotShards');

    expect(Reflect.getMetadata('path', AnomalyController.prototype.getHotShards)).toBe(
      'hot-shards',
    );
    expect(Object.values(args)).toEqual([expect.objectContaining({ data: { required: true } })]);
  });
});

describe('AnomalyController.getTopologyDivergence', () => {
  const report = {
    status: 'ok',
    sampledAt: 1000,
    observers: [],
    unanswered: [],
    divergences: [],
    partialMembership: [],
  };
  const service = { getTopologyDivergence: jest.fn().mockReturnValue(report) };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  beforeEach(() => jest.clearAllMocks());

  it('returns the divergence report of the connection in the header', () => {
    expect(controller.getTopologyDivergence('c1')).toEqual(report);
    expect(service.getTopologyDivergence).toHaveBeenCalledWith('c1');
  });

  it('is served at topology-divergence and requires the connection header', () => {
    const args = Reflect.getMetadata('__routeArguments__', AnomalyController, 'getTopologyDivergence');

    expect(Reflect.getMetadata('path', AnomalyController.prototype.getTopologyDivergence)).toBe(
      'topology-divergence',
    );
    expect(Object.values(args)).toEqual([expect.objectContaining({ data: { required: true } })]);
  });
});

describe('AnomalyController.getTopologyDisagreements', () => {
  const summary = {
    status: 'ok',
    sampledAt: 1000,
    coverage: { nodes: 3, asked: 3, answered: 3, complete: true, unanswered: [], unansweredCount: 0 },
    disagreements: [],
    shards: [],
  };
  const service = { getTopologyDisagreements: jest.fn().mockReturnValue(summary) };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  beforeEach(() => jest.clearAllMocks());

  it('returns the disagreement summary of the connection in the header', () => {
    expect(controller.getTopologyDisagreements('c1')).toEqual(summary);
    expect(service.getTopologyDisagreements).toHaveBeenCalledWith('c1');
  });

  it('is served at topology-disagreements and requires the connection header', () => {
    const args = Reflect.getMetadata('__routeArguments__', AnomalyController, 'getTopologyDisagreements');

    expect(Reflect.getMetadata('path', AnomalyController.prototype.getTopologyDisagreements)).toBe(
      'topology-disagreements',
    );
    expect(Object.values(args)).toEqual([expect.objectContaining({ data: { required: true } })]);
  });

  it('sits behind the licence guard, which answers 402 without the feature', () => {
    expect(Reflect.getMetadata('__guards__', AnomalyController.prototype.getTopologyDisagreements)).toContain(
      LicenseGuard,
    );
  });
});

describe('AnomalyController.startTopologyFullCheck', () => {
  const fullCheck = {
    state: 'running',
    unavailable: null,
    startedAt: 1000,
    finishedAt: null,
    asked: 0,
    total: 500,
    retryAt: null,
    now: 2000,
    lastFailure: null,
  };
  const service = {
    startTopologyFullCheck: jest.fn(),
    getTopologyFullCheck: jest.fn().mockReturnValue(fullCheck),
    getTopologyDisagreements: jest.fn(),
  };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  async function refusal(): Promise<HttpException> {
    return controller.startTopologyFullCheck('c1').then(
      () => {
        throw new Error('expected a refusal');
      },
      (error: HttpException) => error,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it.each(['started', 'running'])('answers with the state of the check when it is %s', async (result) => {
    service.startTopologyFullCheck.mockResolvedValue({ result });

    await expect(controller.startTopologyFullCheck('c1')).resolves.toEqual(fullCheck);
    expect(service.startTopologyFullCheck).toHaveBeenCalledWith('c1');
    expect(service.getTopologyFullCheck).toHaveBeenCalledWith('c1');
  });

  it('does not build the report of the sampled rounds to answer', async () => {
    service.startTopologyFullCheck.mockResolvedValue({ result: 'started' });

    await controller.startTopologyFullCheck('c1');

    expect(service.getTopologyDisagreements).not.toHaveBeenCalled();
  });

  it('answers 409 with the reason when the check cannot be run on the connection', async () => {
    service.startTopologyFullCheck.mockResolvedValue({
      result: 'unavailable',
      reason: 'raft_cluster',
      text: 'The nodes of a Raft cluster share one agreed view, so there is nothing to compare.',
    });

    const error = await refusal();

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      reason: 'raft_cluster',
      message: 'The nodes of a Raft cluster share one agreed view, so there is nothing to compare.',
    });
  });

  it('answers 409 for a connection that goes through an SSH tunnel', async () => {
    service.startTopologyFullCheck.mockResolvedValue({
      result: 'unavailable',
      reason: 'ssh_tunnel',
      text: 'This connection goes through an SSH tunnel, so the monitor cannot reach every node.',
    });

    const error = await refusal();

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ reason: 'ssh_tunnel' });
  });

  it('answers 404 for a connection that is not registered', async () => {
    service.startTopologyFullCheck.mockResolvedValue({ result: 'unknown_connection' });

    const error = await refusal();

    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toMatchObject({ message: 'Connection c1 not found' });
    expect(service.getTopologyDisagreements).not.toHaveBeenCalled();
  });

  it('is closed to read-only members, who get 403 from the mutation guard', () => {
    expect(Reflect.getMetadata(ALLOW_MEMBERS_KEY, AnomalyController.prototype.startTopologyFullCheck)).toBeUndefined();
  });

  it('answers 429 with the earliest next start when the last check is too recent', async () => {
    service.startTopologyFullCheck.mockResolvedValue({ result: 'too_soon', retryAt: 31_000 });

    const error = await refusal();

    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      retryAt: 31_000,
      message: 'The last full check ended less than 30 seconds ago',
    });
  });

  it('answers 503 when the node list cannot be read', async () => {
    service.startTopologyFullCheck.mockResolvedValue({ result: 'view_unreadable' });

    expect((await refusal()).getStatus()).toBe(503);
  });

  it('is a POST at topology-disagreements/full-check that answers 202 and requires the connection header', () => {
    const handler = AnomalyController.prototype.startTopologyFullCheck;
    const args = Reflect.getMetadata('__routeArguments__', AnomalyController, 'startTopologyFullCheck');

    expect(Reflect.getMetadata('path', handler)).toBe('topology-disagreements/full-check');
    expect(Reflect.getMetadata('method', handler)).toBe(1);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(202);
    expect(Object.values(args)).toEqual([expect.objectContaining({ data: { required: true } })]);
  });

  it('sits behind the licence guard, which answers 402 without the feature', () => {
    expect(Reflect.getMetadata('__guards__', AnomalyController.prototype.startTopologyFullCheck)).toContain(
      LicenseGuard,
    );
  });
});

describe('AnomalyController slot rebalance runs', () => {
  const run = { sourceShardId: 'src', startedBy: { userId: 'u1', email: 'admin@example.com' } };
  const service = { followRebalanceRuns: jest.fn().mockResolvedValue([run]) };
  const controller = new AnomalyController(service as unknown as AnomalyService);
  const asRole = (role: 'admin' | 'member' | null) =>
    ({ actor: role ? { userId: 'u2', role } : null }) as never;

  it('shows an admin who started each run', async () => {
    const [listed] = await controller.getRebalanceRuns('c1', asRole('admin'));
    expect(listed.startedBy).toEqual({ userId: 'u1', email: 'admin@example.com' });
  });

  it('hides the email of the admin from members', async () => {
    for (const role of ['member', null] as const) {
      const [listed] = await controller.getRebalanceRuns('c1', asRole(role));
      expect(listed.startedBy).toEqual({ userId: 'u1', email: null });
    }
  });
});

describe('AnomalyController rebalance and the placement mode', () => {
  const moves = { moves: [{ targetShardId: 't1', ranges: [[0, 10]] }] };
  const admin = { actor: { userId: 'u1', email: 'a@example.com', role: 'admin' } } as never;

  it('refuses to run a plan while the cluster is in Observe', async () => {
    const service = { runRebalance: jest.fn() };
    const placement = { allowsRun: jest.fn().mockResolvedValue(false), noteRebalanceRefusal: jest.fn() };
    const controller = new AnomalyController(service as unknown as AnomalyService, placement as never);
    await expect(controller.runRebalance('c1', 'src', moves, admin)).rejects.toMatchObject({
      response: { blockedBy: 'observe_mode' },
    });
    expect(service.runRebalance).not.toHaveBeenCalled();
  });

  it('runs a plan in Recommend and passes a refusal on to placement', async () => {
    const service = { runRebalance: jest.fn().mockResolvedValue({ status: 'refused', message: 'NOPERM no' }) };
    const placement = { allowsRun: jest.fn().mockResolvedValue(true), noteRebalanceRefusal: jest.fn() };
    const controller = new AnomalyController(service as unknown as AnomalyService, placement as never);
    await expect(controller.runRebalance('c1', 'src', moves, admin)).rejects.toThrow('NOPERM no');
    expect(placement.noteRebalanceRefusal).toHaveBeenCalledWith('c1', 'NOPERM no');
  });
});
