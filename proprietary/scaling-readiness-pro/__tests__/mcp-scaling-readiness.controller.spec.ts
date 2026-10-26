import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
});
