import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { LicenseGuard } from '@proprietary/licenses';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { DAY_MS } from '@app/mcp/mcp-helpers';
import { McpScalingReadinessController } from '../mcp-scaling-readiness.controller';
import { ScalingReadinessProService } from '../scaling-readiness-pro.service';

describe('McpScalingReadinessController', () => {
  const svc = { getHistory: jest.fn() };
  const registry = { get: jest.fn() };
  let controller: McpScalingReadinessController;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    svc.getHistory.mockResolvedValue({ points: [] });
    registry.get.mockReturnValue({});
    const mod = await Test.createTestingModule({
      controllers: [McpScalingReadinessController],
      providers: [
        { provide: ScalingReadinessProService, useValue: svc },
        { provide: ConnectionRegistry, useValue: registry },
      ],
    })
      .overrideGuard(AgentTokenGuard).useValue({ canActivate: () => true })
      .overrideGuard(LicenseGuard).useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpScalingReadinessController);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('defaults to the last 7 days', async () => {
    await controller.getHistory('inst1');
    expect(svc.getHistory).toHaveBeenCalledWith('inst1', 1_700_000_000_000 - 7 * DAY_MS, 1_700_000_000_000);
  });

  it('forwards an explicit range', async () => {
    await controller.getHistory('inst1', '1000', '2000');
    expect(svc.getHistory).toHaveBeenCalledWith('inst1', 1000, 2000);
  });

  it('rejects a range wider than 90 days before calling the service', async () => {
    await expect(controller.getHistory('inst1', '0', String(91 * DAY_MS))).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.getHistory).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown instance', async () => {
    registry.get.mockImplementationOnce(() => { throw new NotFoundException('nope'); });
    await expect(controller.getHistory('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps service failures to 500', async () => {
    svc.getHistory.mockRejectedValueOnce(new Error('boom'));
    await expect(controller.getHistory('inst1')).rejects.toMatchObject({ status: 500 });
  });

  describe('maxPoints', () => {
    const points = Array.from({ length: 2000 }, (_, i) => ({ timestamp: i, score: 50, dimensions: [{ key: 'memory' }] }));

    beforeEach(() => {
      svc.getHistory.mockResolvedValue({ points });
    });

    it('caps at 150 by default and reports sampling', async () => {
      const res = await controller.getHistory('inst1');
      expect(res.points).toHaveLength(150);
      expect(res.points[0]).toBe(points[0]);
      expect(res.points[149]).toBe(points[1999]);
      expect(res.points[10].dimensions).toEqual([{ key: 'memory' }]);
      expect(res.sampling).toEqual({ originalPoints: 2000, returnedPoints: 150, maxPoints: 150, method: 'even' });
    });

    it('honours an explicit maxPoints', async () => {
      const res = await controller.getHistory('inst1', undefined, undefined, '25');
      expect(res.points).toHaveLength(25);
    });

    it('reports method none for short histories', async () => {
      svc.getHistory.mockResolvedValueOnce({ points: points.slice(0, 5) });
      const res = await controller.getHistory('inst1');
      expect(res.sampling).toEqual({ originalPoints: 5, returnedPoints: 5, maxPoints: 150, method: 'none' });
    });

    it.each(['1', '1001', '2.5', 'abc'])('rejects maxPoints=%s before calling the service', async (value) => {
      await expect(controller.getHistory('inst1', undefined, undefined, value)).rejects.toBeInstanceOf(BadRequestException);
      expect(svc.getHistory).not.toHaveBeenCalled();
    });
  });

  it('is limited to 30 requests per minute', () => {
    const fn = McpScalingReadinessController.prototype.getHistory;
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, fn)).toBe(30);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, fn)).toBe(60000);
  });
});
