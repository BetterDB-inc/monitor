import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { McpKeyAnalyticsController } from './mcp-key-analytics.controller';
import { KeyAnalyticsService } from './key-analytics.service';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
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
  const registry = { get: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    registry.get.mockReturnValue({});
    svc.getLargestKeys.mockResolvedValue([{ key: 'big:1', memoryBytes: 1024 }]);
    const mod = await Test.createTestingModule({
      controllers: [McpKeyAnalyticsController],
      providers: [
        { provide: KeyAnalyticsService, useValue: svc },
        { provide: ConnectionRegistry, useValue: registry },
      ],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(LicenseGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpKeyAnalyticsController);
  });

  const unknownInstance = () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException("Connection 'nope' not found");
    });
  };

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
      expect(registry.get).toHaveBeenCalledWith('inst1');
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

    it('returns 404 for an unknown instance without calling the service', async () => {
      unknownInstance();
      await expect(controller.getSummary('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(svc.getSummary).not.toHaveBeenCalled();
      expect(svc.getDatabases).not.toHaveBeenCalled();
    });

    it('maps unexpected failures to 500', async () => {
      svc.getSummary.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.getSummary('inst1')).rejects.toMatchObject({ status: 500 });
    });

    it.each([
      ['garbage startTime', 'abc', undefined],
      ['inverted range', '2000', '1000'],
      ['range over 90 days', '0', String(91 * 86_400_000)],
    ])('rejects %s with 400', async (_name, startTime, endTime) => {
      await expect(controller.getSummary('inst1', startTime, endTime)).rejects.toBeInstanceOf(BadRequestException);
      expect(svc.getSummary).not.toHaveBeenCalled();
    });
  });

  describe('getPatterns', () => {
    const row = (db: number, timestamp: number, pattern: string, keyCount: number) => {
      return { id: `${db}-${timestamp}-${pattern}`, db, timestamp, pattern, keyCount };
    };

    beforeEach(() => {
      svc.getPatternSnapshots.mockResolvedValue([{ pattern: 'user:*', keyCount: 5, timestamp: 100 }]);
    });

    it('fetches a full snapshot window and leaves filters unset by default', async () => {
      const res = await controller.getPatterns('inst1');
      expect(registry.get).toHaveBeenCalledWith('inst1');
      expect(svc.getPatternSnapshots).toHaveBeenCalledWith({ connectionId: 'inst1', pattern: undefined, db: undefined, limit: 500, startTime: undefined, endTime: undefined });
      expect(res.patterns).toHaveLength(1);
    });

    it('forwards pattern/db/range', async () => {
      await controller.getPatterns('inst1', 'user:*', '2', '9999', '1000', '2000');
      expect(svc.getPatternSnapshots).toHaveBeenCalledWith({ connectionId: 'inst1', pattern: 'user:*', db: 2, limit: 500, startTime: 1000, endTime: 2000 });
    });

    it('rejects an over-long pattern', async () => {
      await expect(controller.getPatterns('inst1', 'x'.repeat(513))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps only the latest snapshot of each db when snapshots are mixed', async () => {
      svc.getPatternSnapshots.mockResolvedValue([
        row(0, 300, 'a:*', 10),
        row(0, 200, 'a:*', 99),
        row(1, 250, 'b:*', 20),
        row(1, 100, 'b:*', 98),
        row(3, 280, 'c:*', 30),
        row(3, 280, 'd:*', 5),
        row(3, 90, 'c:*', 97),
      ]);
      const res = await controller.getPatterns('inst1');
      expect(res.patterns.map((p) => `${p.db}:${p.pattern}@${p.timestamp}`)).toEqual([
        '3:c:*@280',
        '1:b:*@250',
        '0:a:*@300',
        '3:d:*@280',
      ]);
      expect(res.snapshotTimestamps).toEqual({ 0: 300, 1: 250, 3: 280 });
    });

    it('applies limit to the total, not per db (16 dbs x 500 rows)', async () => {
      const rows = Array.from({ length: 16 }, (_, db) => {
        return Array.from({ length: 500 }, (_, i) => row(db, 1000 + db, `p${i}:*`, 1000 - i));
      }).flat();
      svc.getPatternSnapshots.mockResolvedValue(rows);
      const res = await controller.getPatterns('inst1', undefined, undefined, '500');
      expect(res.patterns).toHaveLength(500);
      expect(Object.keys(res.snapshotTimestamps)).toHaveLength(16);
    });

    it('defaults the total to 50 rows', async () => {
      svc.getPatternSnapshots.mockResolvedValue(Array.from({ length: 120 }, (_, i) => row(0, 5, `p${i}:*`, i)));
      const res = await controller.getPatterns('inst1');
      expect(res.patterns).toHaveLength(50);
      expect(res.patterns[0].keyCount).toBe(119);
    });

    it('returns only the latest snapshot of the requested db', async () => {
      svc.getPatternSnapshots.mockResolvedValue([
        row(3, 400, 'c:*', 7),
        row(3, 400, 'd:*', 9),
        row(3, 300, 'c:*', 500),
      ]);
      const res = await controller.getPatterns('inst1', undefined, '3');
      expect(svc.getPatternSnapshots).toHaveBeenCalledWith(expect.objectContaining({ db: 3 }));
      expect(res.patterns.map((p) => p.pattern)).toEqual(['d:*', 'c:*']);
      expect(res.patterns.every((p) => p.timestamp === 400 && p.db === 3)).toBe(true);
      expect(res.snapshotTimestamps).toEqual({ 3: 400 });
    });

    it('treats rows without a db as db 0', async () => {
      svc.getPatternSnapshots.mockResolvedValue([
        { pattern: 'a:*', keyCount: 1, timestamp: 10 },
        { pattern: 'a:*', keyCount: 2, timestamp: 20 },
      ]);
      const res = await controller.getPatterns('inst1');
      expect(res.patterns).toHaveLength(1);
      expect(res.snapshotTimestamps).toEqual({ 0: 20 });
    });

    it('returns 404 for an unknown instance without calling the service', async () => {
      unknownInstance();
      await expect(controller.getPatterns('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(svc.getPatternSnapshots).not.toHaveBeenCalled();
    });

    it('maps unexpected failures to 500', async () => {
      svc.getPatternSnapshots.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.getPatterns('inst1')).rejects.toMatchObject({ status: 500 });
    });

    it('rejects garbage and inverted time ranges with 400', async () => {
      await expect(controller.getPatterns('inst1', undefined, undefined, undefined, 'abc')).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.getPatterns('inst1', undefined, undefined, undefined, '2000', '1000')).rejects.toBeInstanceOf(BadRequestException);
      expect(svc.getPatternSnapshots).not.toHaveBeenCalled();
    });
  });

  describe('getPatternTrend', () => {
    const NOW = 1_700_000_000_000;
    const DAY = 86_400_000;

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
      expect(svc.getPatternTrends).toHaveBeenCalledWith('user:*', NOW - 7 * DAY, NOW, 'inst1', undefined);
      expect(res).toEqual({
        pattern: 'user:*',
        startTime: NOW - 7 * DAY,
        endTime: NOW,
        points: [{ timestamp: 1, keyCount: 3 }],
        sampling: { originalPoints: 1, returnedPoints: 1, maxPoints: 150, method: 'none' },
      });
    });

    it('rejects a range wider than 90 days', async () => {
      await expect(controller.getPatternTrend('inst1', 'user:*', '0', String(91 * DAY))).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['garbage startTime', 'abc', undefined],
      ['inverted range', '2000', '1000'],
      ['range over 90 days', '0', String(91 * DAY)],
    ])('rejects %s with 400 before calling the service', async (_name, startTime, endTime) => {
      await expect(controller.getPatternTrend('inst1', 'user:*', startTime, endTime)).rejects.toBeInstanceOf(BadRequestException);
      expect(svc.getPatternTrends).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown instance without calling the service', async () => {
      unknownInstance();
      await expect(controller.getPatternTrend('nope', 'user:*')).rejects.toBeInstanceOf(NotFoundException);
      expect(svc.getPatternTrends).not.toHaveBeenCalled();
    });

    it('maps unexpected failures to 500', async () => {
      svc.getPatternTrends.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.getPatternTrend('inst1', 'user:*')).rejects.toMatchObject({ status: 500 });
    });

    describe('maxPoints', () => {
      const points = Array.from({ length: 5000 }, (_, i) => ({ timestamp: i, keyCount: i, memoryBytes: i, staleCount: 0 }));

      beforeEach(() => {
        svc.getPatternTrends.mockResolvedValue(points);
      });

      it('caps at 150 by default, keeping first and last', async () => {
        const res = await controller.getPatternTrend('inst1', 'user:*');
        expect(res.points).toHaveLength(150);
        expect(res.points[0]).toBe(points[0]);
        expect(res.points[149]).toBe(points[4999]);
        expect(res.sampling).toEqual({ originalPoints: 5000, returnedPoints: 150, maxPoints: 150, method: 'even' });
      });

      it('honours an explicit maxPoints', async () => {
        const res = await controller.getPatternTrend('inst1', 'user:*', undefined, undefined, undefined, '40');
        expect(res.points).toHaveLength(40);
      });

      it.each(['1', '1001', 'abc'])('rejects maxPoints=%s before calling the service', async (value) => {
        await expect(controller.getPatternTrend('inst1', 'user:*', undefined, undefined, undefined, value)).rejects.toBeInstanceOf(BadRequestException);
        expect(svc.getPatternTrends).not.toHaveBeenCalled();
      });
    });

    it('is limited to 30 requests per minute', () => {
      const fn = McpKeyAnalyticsController.prototype.getPatternTrend;
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, fn)).toBe(30);
      expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, fn)).toBe(60000);
    });
  });
});
