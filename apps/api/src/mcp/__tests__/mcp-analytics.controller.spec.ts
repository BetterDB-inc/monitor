import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { McpAnalyticsController } from '../mcp-analytics.controller';
import { MetricForecastingService } from '../../metric-forecasting/metric-forecasting.service';
import { AgentTokenGuard } from '../../common/guards/agent-token.guard';

describe('McpAnalyticsController', () => {
  const forecastSvc = {
    getForecast: jest.fn(),
  };

  async function makeController(): Promise<McpAnalyticsController> {
    const mod = await Test.createTestingModule({
      controllers: [McpAnalyticsController],
      providers: [{ provide: MetricForecastingService, useValue: forecastSvc }],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();
    return mod.get(McpAnalyticsController);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    forecastSvc.getForecast.mockResolvedValue({ metricKind: 'usedMemory', points: [] });
  });

  it('forecast forwards connection id and metric kind', async () => {
    const controller = await makeController();
    const res = await controller.getForecast('inst1', 'usedMemory');
    expect(res).toEqual({ metricKind: 'usedMemory', points: [] });
    expect(forecastSvc.getForecast).toHaveBeenCalledWith('inst1', 'usedMemory');
  });

  it('forecast maps service failures to 500', async () => {
    forecastSvc.getForecast.mockRejectedValueOnce(new Error('boom'));
    const controller = await makeController();
    let caught: unknown;
    try {
      await controller.getForecast('inst1', 'usedMemory');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(500);
  });
});
