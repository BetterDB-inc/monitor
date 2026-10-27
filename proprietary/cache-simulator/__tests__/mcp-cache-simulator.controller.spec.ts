import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { LicenseGuard } from '@proprietary/licenses';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { McpCacheSimulatorController } from '../mcp-cache-simulator.controller';
import { CacheSimulatorService } from '../cache-simulator.service';

describe('McpCacheSimulatorController', () => {
  const svc = { snapshot: jest.fn() };
  let controller: McpCacheSimulatorController;

  beforeEach(async () => {
    jest.clearAllMocks();
    svc.snapshot.mockResolvedValue({ status: 'sampling', progress: { sampled: 10, target: 100 } });
    const mod = await Test.createTestingModule({
      controllers: [McpCacheSimulatorController],
      providers: [{ provide: CacheSimulatorService, useValue: svc }],
    })
      .overrideGuard(AgentTokenGuard).useValue({ canActivate: () => true })
      .overrideGuard(LicenseGuard).useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpCacheSimulatorController);
  });

  it('returns the cached/in-progress snapshot by default', async () => {
    const res = await controller.getSnapshot('inst1');
    expect(svc.snapshot).toHaveBeenCalledWith('inst1', false);
    expect(res.status).toBe('sampling');
  });

  it('forces a fresh sample with refresh=true', async () => {
    await controller.getSnapshot('inst1', 'true');
    expect(svc.snapshot).toHaveBeenCalledWith('inst1', true);
  });

  it('treats refresh=false as cached', async () => {
    await controller.getSnapshot('inst1', 'false');
    expect(svc.snapshot).toHaveBeenCalledWith('inst1', false);
  });

  it('rejects any other refresh value', async () => {
    await expect(controller.getSnapshot('inst1', 'yes')).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.snapshot).not.toHaveBeenCalled();
  });

  it('propagates 404 for an unknown instance', async () => {
    svc.snapshot.mockRejectedValueOnce(new NotFoundException('nope'));
    await expect(controller.getSnapshot('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps unexpected failures to 500', async () => {
    svc.snapshot.mockRejectedValueOnce(new Error('boom'));
    await expect(controller.getSnapshot('inst1')).rejects.toMatchObject({ status: 500 });
  });

  it('is rate-limited to 10 requests per minute', () => {
    const fn = McpCacheSimulatorController.prototype.getSnapshot;
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, fn)).toBe(10);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, fn)).toBe(60000);
  });
});
