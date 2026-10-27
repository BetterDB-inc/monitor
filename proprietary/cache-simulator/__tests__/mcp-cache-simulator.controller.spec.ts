import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { LicenseGuard } from '@proprietary/licenses';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { McpCacheSimulatorController } from '../mcp-cache-simulator.controller';
import { CacheSimulatorService } from '../cache-simulator.service';

describe('McpCacheSimulatorController', () => {
  const sampling = { status: 'sampling', progress: { sampled: 10, target: 100 } };
  const svc = { snapshot: jest.fn(), current: jest.fn() };
  let controller: McpCacheSimulatorController;

  beforeEach(async () => {
    jest.clearAllMocks();
    svc.snapshot.mockResolvedValue(sampling);
    svc.current.mockResolvedValue(sampling);
    const mod = await Test.createTestingModule({
      controllers: [McpCacheSimulatorController],
      providers: [{ provide: CacheSimulatorService, useValue: svc }],
    })
      .overrideGuard(AgentTokenGuard).useValue({ canActivate: () => true })
      .overrideGuard(LicenseGuard).useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpCacheSimulatorController);
  });

  describe('read route', () => {
    it('returns the current job or cached estimate without starting sampling', async () => {
      const res = await controller.getSnapshot('inst1');
      expect(svc.current).toHaveBeenCalledWith('inst1');
      expect(svc.snapshot).not.toHaveBeenCalled();
      expect(res.status).toBe('sampling');
    });

    it('reports status none when nothing has been sampled, still without starting', async () => {
      svc.current.mockResolvedValueOnce(null);
      const res = await controller.getSnapshot('inst1');
      expect(res.status).toBe('none');
      expect(svc.snapshot).not.toHaveBeenCalled();
    });

    it('accepts refresh=false', async () => {
      await controller.getSnapshot('inst1', 'false');
      expect(svc.current).toHaveBeenCalledWith('inst1');
    });

    it.each(['true', 'yes'])('rejects refresh=%s with 400 pointing at the refresh route', async (value) => {
      await expect(controller.getSnapshot('inst1', value)).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.getSnapshot('inst1', value)).rejects.toThrow('use /cache-simulator/refresh to start sampling');
      expect(svc.current).not.toHaveBeenCalled();
      expect(svc.snapshot).not.toHaveBeenCalled();
    });

    it('propagates 404 for an unknown instance', async () => {
      svc.current.mockRejectedValueOnce(new NotFoundException('nope'));
      await expect(controller.getSnapshot('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps unexpected failures to 500', async () => {
      svc.current.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.getSnapshot('inst1')).rejects.toMatchObject({ status: 500 });
    });

    it('is rate-limited to 60 requests per minute', () => {
      const fn = McpCacheSimulatorController.prototype.getSnapshot;
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, fn)).toBe(60);
      expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, fn)).toBe(60000);
    });
  });

  describe('refresh route', () => {
    it('starts (or joins) a sampling job', async () => {
      const res = await controller.refreshSnapshot('inst1');
      expect(svc.snapshot).toHaveBeenCalledWith('inst1', true);
      expect(res.status).toBe('sampling');
    });

    it('propagates 404 for an unknown instance', async () => {
      svc.snapshot.mockRejectedValueOnce(new NotFoundException('nope'));
      await expect(controller.refreshSnapshot('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps unexpected failures to 500', async () => {
      svc.snapshot.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.refreshSnapshot('inst1')).rejects.toMatchObject({ status: 500 });
    });

    it('is rate-limited to 10 requests per minute', () => {
      const fn = McpCacheSimulatorController.prototype.refreshSnapshot;
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, fn)).toBe(10);
      expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, fn)).toBe(60000);
    });
  });
});
