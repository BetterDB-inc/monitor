import { HttpException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { McpAnomalyController } from '../mcp-anomaly.controller';
import { AnomalyService } from '../anomaly.service';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { LicenseGuard } from '@proprietary/licenses';

describe('McpAnomalyController', () => {
  let controller: McpAnomalyController;
  const svc = {
    getRecentAnomalies: jest.fn(),
    getRetryAmplificationStatus: jest.fn(),
  };
  const registry = { get: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    svc.getRecentAnomalies.mockResolvedValue([{ id: 'a1' }]);
    const mod = await Test.createTestingModule({
      controllers: [McpAnomalyController],
      providers: [
        { provide: AnomalyService, useValue: svc },
        { provide: ConnectionRegistry, useValue: registry },
      ],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(LicenseGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpAnomalyController);
  });

  it('anomalies forwards filters and returns the raw event list', async () => {
    const res = await controller.getAnomalies('inst1', '10', 'memory_used', '5000');
    expect(res).toEqual([{ id: 'a1' }]);
    expect(svc.getRecentAnomalies).toHaveBeenCalledWith(
      5000,
      undefined,
      undefined,
      'memory_used',
      10,
      'inst1',
    );
  });

  it('anomalies rejects unknown metricType with 400', async () => {
    let caught: unknown;
    try {
      await controller.getAnomalies('inst1', undefined, 'bogus_metric', undefined);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(400);
    expect(svc.getRecentAnomalies).not.toHaveBeenCalled();
  });

  it('anomalies passes undefined metricType when empty', async () => {
    await controller.getAnomalies('inst1', undefined, '', undefined);
    const args = svc.getRecentAnomalies.mock.calls[0];
    expect(args[3]).toBeUndefined();
    expect(args[4]).toBe(100);
  });

  it('accepts command_p99 as a metricType filter (latency regressions path)', async () => {
    const res = await controller.getAnomalies('inst1', '10', 'command_p99', '5000');
    expect(res).toEqual([{ id: 'a1' }]);
    expect(svc.getRecentAnomalies).toHaveBeenCalledWith(
      5000,
      undefined,
      undefined,
      'command_p99',
      10,
      'inst1',
    );
  });

  it('maps service failures to 500', async () => {
    svc.getRecentAnomalies.mockRejectedValueOnce(new Error('boom'));
    let caught: unknown;
    try {
      await controller.getAnomalies('inst1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(500);
  });

  it('retry amplification returns the detector status for the instance', () => {
    const status = { armed: true, classification: 'none', topContributors: null };
    svc.getRetryAmplificationStatus.mockReturnValue(status);

    expect(controller.getRetryAmplification('inst1')).toBe(status);
    expect(svc.getRetryAmplificationStatus).toHaveBeenCalledWith('inst1');
  });

  it('retry amplification returns 404 for an unregistered instance', () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException('nope');
    });

    let caught: unknown;
    try {
      controller.getRetryAmplification('ghost');
    } catch (error) {
      caught = error;
    }

    expect((caught as HttpException).getStatus()).toBe(404);
    expect(svc.getRetryAmplificationStatus).not.toHaveBeenCalled();
  });
});
