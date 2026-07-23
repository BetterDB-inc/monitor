import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { McpAnomalyController } from '../mcp-anomaly.controller';
import { AnomalyService } from '../anomaly.service';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { LicenseGuard } from '@proprietary/licenses';

describe('McpAnomalyController', () => {
  let controller: McpAnomalyController;
  const svc = {
    getRecentAnomalies: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    svc.getRecentAnomalies.mockResolvedValue([{ id: 'a1' }]);
    const mod = await Test.createTestingModule({
      controllers: [McpAnomalyController],
      providers: [{ provide: AnomalyService, useValue: svc }],
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

  it('latency regressions filters by command_p99 and wraps in events', async () => {
    const res = await controller.getLatencyRegressions('inst1', '10', '5000');
    expect(res.events).toEqual([{ id: 'a1' }]);
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
      await controller.getLatencyRegressions('inst1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(500);
  });
});
