import { NotFoundException } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { fastifyAdapterOptions } from '@app/config/fastify-options';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import type { ClusterNode } from '@app/common/types/metrics.types';
import { Feature, LicenseService } from '@proprietary/licenses';
import { AnomalyController } from '../anomaly.controller';
import { AnomalyService } from '../anomaly.service';
import { McpAnomalyController } from '../mcp-anomaly.controller';
import { summarizeDisagreements } from '../topology-disagreements';

const AT = 1_000_000;

function member(id: string, shard: number, primary?: string): ClusterNode {
  return {
    id,
    address: `${id}.internal:6379@16379`,
    flags: [primary ? 'slave' : 'master'],
    master: primary ?? '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: primary ? [] : [[shard * 100, shard * 100 + 99]],
    shardId: `s${shard}`,
  };
}

const NODES = [0, 1, 2].flatMap((shard) => [member(`p${shard}`, shard), member(`r${shard}`, shard, `p${shard}`)]);

const NO_CHECK = {
  state: 'none' as const,
  unavailable: null,
  startedAt: null,
  finishedAt: null,
  asked: 0,
  total: 0,
  retryAt: null,
};

function reportOf(connectionId: string) {
  const summary = summaryOf(connectionId);
  if (summary.status !== 'ok') return { ...summary, fullCheck: NO_CHECK };
  return {
    ...summary,
    fullCheck: { ...NO_CHECK, state: 'done' as const, startedAt: AT, finishedAt: AT, asked: 6, total: 6, summary },
  };
}

function summaryOf(connectionId: string) {
  if (connectionId !== 'conn-1') return summarizeDisagreements(undefined, () => undefined);
  return summarizeDisagreements(
    {
      status: 'ok',
      at: AT,
      observers: ['p0', 'p1', 'p2'],
      unanswered: [],
      disagreements: [
        {
          key: 'failure_flags:r1',
          kind: 'failure_flags',
          subjectIds: ['r1'],
          firstSeenAt: AT - 10_000,
          lastSeenAt: AT,
          rounds: 3,
          positions: [
            { value: 'failing', observers: ['p0'] },
            { value: 'ok', observers: ['p1', 'p2'] },
          ],
        },
      ],
      nodes: new Map(NODES.map((node) => [node.id, node])),
      failureFlags: new Map([['r1', { suspected: ['p0'], failed: [] }]]),
    },
    () => undefined,
  );
}

describe('topology disagreement routes', () => {
  let app: NestFastifyApplication;
  let licensed: boolean;
  const service = { getTopologyDisagreements: jest.fn(reportOf) };
  const registry = {
    get: jest.fn((id: string) => {
      if (id !== 'conn-1') throw new NotFoundException(`Connection ${id} not found`);
      return {};
    }),
  };
  const license = {
    isValidationComplete: () => true,
    ensureValidated: async () => undefined,
    hasFeature: (feature: string) => licensed && feature === Feature.ANOMALY_DETECTION,
    getLicenseTier: () => (licensed ? 'pro' : 'community'),
  };

  beforeEach(async () => {
    licensed = true;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AnomalyController, McpAnomalyController],
      providers: [
        { provide: AnomalyService, useValue: service },
        { provide: ConnectionRegistry, useValue: registry },
        { provide: LicenseService, useValue: license },
      ],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions({})));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /anomaly/topology-disagreements', () => {
    const url = '/anomaly/topology-disagreements';

    it('returns the lines and every shard of the cluster in the connection header', async () => {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-connection-id': 'conn-1' } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ok',
        sampledAt: AT,
        coverage: { nodes: 6, asked: 3, answered: 3, complete: false },
        disagreements: [{ id: 'failure_flags:r1', stale: false, text: 'r1.internal:6379: ok in 2 views, fail? in 1 view.' }],
        shardTotals: { total: 3, disputed: 1, undisputed: 2, notCompared: 0 },
        shardsListed: 'all',
      });
      expect(res.json().shards.map((shard: { shardId: string }) => shard.shardId)).toEqual(['s1', 's0', 's2']);
    });

    it('answers not sampled for a connection without a round', async () => {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-connection-id': 'other' } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'not_sampled', sampledAt: null, disagreements: [], shards: [] });
    });

    it('answers 400 without the connection header', async () => {
      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(400);
      expect(service.getTopologyDisagreements).not.toHaveBeenCalled();
    });

    it('answers 402 without the licence feature', async () => {
      licensed = false;

      const res = await app.inject({ method: 'GET', url, headers: { 'x-connection-id': 'conn-1' } });

      expect(res.statusCode).toBe(402);
      expect(service.getTopologyDisagreements).not.toHaveBeenCalled();
    });
  });

  describe('GET /mcp/instance/:id/anomalies/topology-disagreements', () => {
    const url = '/mcp/instance/conn-1/anomalies/topology-disagreements';

    it('returns the disputed shards and the totals of all of them by default', async () => {
      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ok',
        disagreements: [{ id: 'failure_flags:r1' }],
        shardTotals: { total: 3, disputed: 1, undisputed: 2, notCompared: 0 },
        shardsListed: 'disputed',
      });
      expect(res.json().shards.map((shard: { shardId: string }) => shard.shardId)).toEqual(['s1']);
    });

    it('trims the shards of the full check the same way', async () => {
      const trimmed = (await app.inject({ method: 'GET', url })).json().fullCheck;
      const whole = (await app.inject({ method: 'GET', url: `${url}?shards=all` })).json().fullCheck;

      expect(trimmed).toMatchObject({ state: 'done', asked: 6, total: 6 });
      expect(trimmed.summary).toMatchObject({
        shardsListed: 'disputed',
        shardTotals: { total: 3, disputed: 1, undisputed: 2, notCompared: 0 },
      });
      expect(trimmed.summary.shards).toHaveLength(1);
      expect(whole.summary.shards).toHaveLength(3);
    });

    it('returns every shard when asked for all', async () => {
      const res = await app.inject({ method: 'GET', url: `${url}?shards=all` });

      expect(res.statusCode).toBe(200);
      expect(res.json().shardsListed).toBe('all');
      expect(res.json().shards).toHaveLength(3);
    });

    it('answers 400 for an unknown shard listing', async () => {
      const res = await app.inject({ method: 'GET', url: `${url}?shards=some` });

      expect(res.statusCode).toBe(400);
      expect(service.getTopologyDisagreements).not.toHaveBeenCalled();
    });

    it('answers 404 for an instance that is not registered', async () => {
      const res = await app.inject({ method: 'GET', url: '/mcp/instance/ghost/anomalies/topology-disagreements' });

      expect(res.statusCode).toBe(404);
      expect(service.getTopologyDisagreements).not.toHaveBeenCalled();
    });

    it('answers 402 without the licence feature', async () => {
      licensed = false;

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(402);
    });
  });
});
