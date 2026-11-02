import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import type { KvCacheEngine } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { DAY_MS } from '@app/mcp/mcp-helpers';
import { McpKvCacheController, redactEngine } from '../mcp-kv-cache.controller';
import { KvCacheSamplesService } from '../kv-cache-samples.service';
import { KvCacheStatusService } from '../kv-cache-status.service';

const NOW = 1_700_000_000_000;

function engine(overrides: Partial<KvCacheEngine> = {}): KvCacheEngine {
  return {
    id: 'e1', connectionId: 'inst1', name: 'vllm-a', source: 'scrape',
    scrapeUrl: 'https://user:secret@vllm.internal:8000/metrics?token=abc',
    hasScrapeAuth: true, otlpEngineId: null, enabled: true, createdAt: 1, lastSeenAt: 2,
    lastError: 'GET https://user:secret@vllm.internal:8000/metrics -> 401',
    ...overrides,
  };
}

describe('McpKvCacheController', () => {
  const status = { getStatus: jest.fn(), getFootprintHistory: jest.fn() };
  const samples = { getSamples: jest.fn() };
  const registry = { get: jest.fn() };
  let controller: McpKvCacheController;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW });
    registry.get.mockReturnValue({});
    status.getStatus.mockResolvedValue({ hasLmcache: true, latest: null, recent: [], footprintIntervalMs: 60_000, sampleKey: null, engines: [engine()] });
    status.getFootprintHistory.mockResolvedValue([]);
    samples.getSamples.mockResolvedValue({ buckets: [], rangeHitRate: 0.42, truncated: false, bucketMs: 60_000 });
    const mod = await Test.createTestingModule({
      controllers: [McpKvCacheController],
      providers: [
        { provide: KvCacheStatusService, useValue: status },
        { provide: KvCacheSamplesService, useValue: samples },
        { provide: ConnectionRegistry, useValue: registry },
      ],
    })
      .overrideGuard(AgentTokenGuard).useValue({ canActivate: () => true })
      .overrideGuard(LicenseGuard).useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpKvCacheController);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('redactEngine', () => {
    it('reduces the scrape URL and strips credentials from lastError', () => {
      const r = redactEngine(engine());
      expect(r.scrapeUrl).toBe('https://vllm.internal:8000/metrics');
      expect(r.lastError).toBe('GET https://vllm.internal:8000/metrics -> 401');
      expect(r.hasScrapeAuth).toBe(true);
    });

    it('keeps null scrapeUrl / lastError null (OTLP engines)', () => {
      const r = redactEngine(engine({ source: 'otlp', scrapeUrl: null, lastError: null, otlpEngineId: 'otel-1' }));
      expect(r.scrapeUrl).toBeNull();
      expect(r.lastError).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('returns status with every engine redacted', async () => {
      const res = await controller.getStatus('inst1');
      expect(status.getStatus).toHaveBeenCalledWith('inst1');
      expect(JSON.stringify(res)).not.toContain('secret');
      expect(JSON.stringify(res)).not.toContain('token=abc');
    });

    it('returns 404 for an unknown instance', async () => {
      registry.get.mockImplementationOnce(() => { throw new NotFoundException('nope'); });
      await expect(controller.getStatus('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(status.getStatus).not.toHaveBeenCalled();
    });
  });

  describe('getHitRate', () => {
    it('defaults to the last 24 hours with no filters', async () => {
      await controller.getHitRate('inst1');
      expect(samples.getSamples).toHaveBeenCalledWith('inst1', { from: NOW - DAY_MS, to: NOW, engineId: undefined, model: undefined });
    });

    it('forwards range and filters', async () => {
      await controller.getHitRate('inst1', '1000', '2000', 'e1', 'llama-3');
      expect(samples.getSamples).toHaveBeenCalledWith('inst1', { from: 1000, to: 2000, engineId: 'e1', model: 'llama-3' });
    });

    it('rejects an over-long filter', async () => {
      await expect(controller.getHitRate('inst1', undefined, undefined, 'x'.repeat(201))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a range wider than 31 days', async () => {
      await expect(controller.getHitRate('inst1', '0', String(32 * DAY_MS))).rejects.toBeInstanceOf(BadRequestException);
      expect(samples.getSamples).not.toHaveBeenCalled();
    });
  });

  describe('getHitRate maxPoints', () => {
    const rows = ['e1', 'e2', 'e3'].flatMap((engineId) => {
      return ['m1', 'm2'].flatMap((modelName) => {
        return Array.from({ length: 1440 }, (_, i) => ({ engineId, modelName, timestamp: i * 60_000, hitRate: 0.5 }));
      });
    });

    beforeEach(() => {
      samples.getSamples.mockResolvedValue({ buckets: rows, rangeHitRate: 0.5, truncated: false, bucketMs: 60_000 });
    });

    it('caps a large series at 150 by default and reports sampling', async () => {
      const res = await controller.getHitRate('inst1');
      expect(res.buckets.length).toBeLessThanOrEqual(150);
      expect(res.sampling).toEqual({ originalPoints: 8640, returnedPoints: res.buckets.length, maxPoints: 150, method: 'even' });
      expect(res.rangeHitRate).toBe(0.5);
      expect(res.bucketMs).toBe(60_000);
    });

    it('honours an explicit maxPoints', async () => {
      const res = await controller.getHitRate('inst1', undefined, undefined, undefined, undefined, '60');
      expect(res.buckets).toHaveLength(60);
      expect(res.sampling.maxPoints).toBe(60);
    });

    it.each(['1', '1001', 'abc'])('rejects maxPoints=%s before calling the service', async (value) => {
      await expect(controller.getHitRate('inst1', undefined, undefined, undefined, undefined, value)).rejects.toBeInstanceOf(BadRequestException);
      expect(samples.getSamples).not.toHaveBeenCalled();
    });
  });

  describe('getFootprintHistory maxPoints', () => {
    const snapshots = Array.from({ length: 1000 }, (_, i) => ({ connectionId: 'inst1', timestamp: i }));

    beforeEach(() => {
      status.getFootprintHistory.mockResolvedValue(snapshots);
    });

    it('caps at 150 by default, keeping first and last', async () => {
      const res = await controller.getFootprintHistory('inst1');
      expect(res.snapshots).toHaveLength(150);
      expect(res.snapshots[0]).toBe(snapshots[0]);
      expect(res.snapshots[149]).toBe(snapshots[999]);
      expect(res.sampling).toEqual({ originalPoints: 1000, returnedPoints: 150, maxPoints: 150, method: 'even' });
    });

    it('honours an explicit maxPoints', async () => {
      const res = await controller.getFootprintHistory('inst1', undefined, undefined, '10');
      expect(res.snapshots).toHaveLength(10);
    });

    it('rejects an invalid maxPoints before calling the service', async () => {
      await expect(controller.getFootprintHistory('inst1', undefined, undefined, '1')).rejects.toBeInstanceOf(BadRequestException);
      expect(status.getFootprintHistory).not.toHaveBeenCalled();
    });
  });

  describe('throttling', () => {
    it.each(['getHitRate', 'getFootprintHistory'] as const)('%s is limited to 30 requests per minute', (handler) => {
      const fn = McpKvCacheController.prototype[handler];
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, fn)).toBe(30);
      expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, fn)).toBe(60000);
    });
  });

  describe('getFootprintHistory', () => {
    it('wraps snapshots and defaults to the last 24 hours', async () => {
      const res = await controller.getFootprintHistory('inst1');
      expect(status.getFootprintHistory).toHaveBeenCalledWith('inst1', NOW - DAY_MS, NOW);
      expect(res).toEqual({ snapshots: [], sampling: { originalPoints: 0, returnedPoints: 0, maxPoints: 150, method: 'none' } });
    });

    it('maps failures to 500', async () => {
      status.getFootprintHistory.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.getFootprintHistory('inst1')).rejects.toMatchObject({ status: 500 });
    });
  });
});
