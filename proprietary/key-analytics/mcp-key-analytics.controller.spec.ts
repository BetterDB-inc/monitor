import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { McpKeyAnalyticsController } from './mcp-key-analytics.controller';
import { KeyAnalyticsService } from './key-analytics.service';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { LicenseGuard } from '@proprietary/licenses';

describe('McpKeyAnalyticsController', () => {
  let controller: McpKeyAnalyticsController;
  const svc = {
    getLargestKeys: jest.fn(),
    getSummary: jest.fn(),
    getDatabases: jest.fn(),
    getPatternSnapshots: jest.fn(),
    getPatternTrends: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    svc.getLargestKeys.mockResolvedValue([{ key: 'big:1', memoryBytes: 1024 }]);
    const mod = await Test.createTestingModule({
      controllers: [McpKeyAnalyticsController],
      providers: [{ provide: KeyAnalyticsService, useValue: svc }],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(LicenseGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpKeyAnalyticsController);
  });

  it('returns largest keys with defaults', async () => {
    const res = await controller.getLargestKeys('inst1');
    expect(res.entries).toHaveLength(1);
    expect(svc.getLargestKeys).toHaveBeenCalledWith({
      connectionId: 'inst1',
      limit: 50,
      startTime: undefined,
      endTime: undefined,
      latest: true,
    });
  });

  it('forwards limit and time range', async () => {
    await controller.getLargestKeys('inst1', '10', '1000', '2000');
    expect(svc.getLargestKeys).toHaveBeenCalledWith({
      connectionId: 'inst1',
      limit: 10,
      startTime: 1000,
      endTime: 2000,
      latest: true,
    });
  });

  describe('getSummary', () => {
    beforeEach(() => {
      svc.getSummary.mockResolvedValue({ totalKeys: 10 });
      svc.getDatabases.mockResolvedValue([0, 3]);
    });

    it('returns summary and databases for all dbs by default', async () => {
      const res = await controller.getSummary('inst1');
      expect(svc.getSummary).toHaveBeenCalledWith(undefined, undefined, 'inst1', undefined);
      expect(svc.getDatabases).toHaveBeenCalledWith('inst1');
      expect(res).toEqual({ summary: { totalKeys: 10 }, databases: [0, 3] });
    });

    it('forwards time range and db', async () => {
      await controller.getSummary('inst1', '1000', '2000', '3');
      expect(svc.getSummary).toHaveBeenCalledWith(1000, 2000, 'inst1', 3);
    });

    it('rejects an invalid db', async () => {
      await expect(controller.getSummary('inst1', undefined, undefined, '-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('passes a null summary through (cluster member analytics live on the seed)', async () => {
      svc.getSummary.mockResolvedValueOnce(null);
      const res = await controller.getSummary('member');
      expect(res.summary).toBeNull();
    });
  });

  describe('getPatterns', () => {
    beforeEach(() => {
      svc.getPatternSnapshots.mockResolvedValue([{ pattern: 'user:*', keyCount: 5 }]);
    });

    it('defaults limit to 50 and leaves filters unset', async () => {
      const res = await controller.getPatterns('inst1');
      expect(svc.getPatternSnapshots).toHaveBeenCalledWith({ connectionId: 'inst1', pattern: undefined, db: undefined, limit: 50, startTime: undefined, endTime: undefined });
      expect(res.patterns).toHaveLength(1);
    });

    it('caps limit at 500 and forwards pattern/db/range', async () => {
      await controller.getPatterns('inst1', 'user:*', '2', '9999', '1000', '2000');
      expect(svc.getPatternSnapshots).toHaveBeenCalledWith({ connectionId: 'inst1', pattern: 'user:*', db: 2, limit: 500, startTime: 1000, endTime: 2000 });
    });

    it('rejects an over-long pattern', async () => {
      await expect(controller.getPatterns('inst1', 'x'.repeat(513))).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getPatternTrend', () => {
    const NOW = 1_700_000_000_000;

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW });
      svc.getPatternTrends.mockResolvedValue([{ timestamp: 1, keyCount: 3 }]);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('requires a pattern', async () => {
      await expect(controller.getPatternTrend('inst1')).rejects.toThrow('pattern is required');
      expect(svc.getPatternTrends).not.toHaveBeenCalled();
    });

    it('defaults to the last 7 days', async () => {
      const res = await controller.getPatternTrend('inst1', 'user:*');
      expect(svc.getPatternTrends).toHaveBeenCalledWith('user:*', NOW - 7 * 86_400_000, NOW, 'inst1', undefined);
      expect(res).toEqual({ pattern: 'user:*', startTime: NOW - 7 * 86_400_000, endTime: NOW, points: [{ timestamp: 1, keyCount: 3 }] });
    });

    it('rejects a range wider than 90 days', async () => {
      await expect(controller.getPatternTrend('inst1', 'user:*', '0', String(91 * 86_400_000))).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
