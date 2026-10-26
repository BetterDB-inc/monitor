import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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

  describe('getFootprintHistory', () => {
    it('wraps snapshots and defaults to the last 24 hours', async () => {
      const res = await controller.getFootprintHistory('inst1');
      expect(status.getFootprintHistory).toHaveBeenCalledWith('inst1', NOW - DAY_MS, NOW);
      expect(res).toEqual({ snapshots: [] });
    });

    it('maps failures to 500', async () => {
      status.getFootprintHistory.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.getFootprintHistory('inst1')).rejects.toMatchObject({ status: 500 });
    });
  });
});
