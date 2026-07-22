import { HttpException, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ANOMALY_SERVICE } from '@betterdb/shared';
import { McpAnalyticsController } from '../mcp-analytics.controller';
import { MetricForecastingService } from '../../metric-forecasting/metric-forecasting.service';
import { AgentTokenGuard } from '../../common/guards/agent-token.guard';

describe('McpAnalyticsController', () => {
  const forecastSvc = {
    getForecast: jest.fn(),
  };
  const anomalySvc = {
    getRecentAnomalies: jest.fn(),
  };

  async function makeController(withAnomaly: boolean): Promise<McpAnalyticsController> {
    const providers: Provider[] = [{ provide: MetricForecastingService, useValue: forecastSvc }];
    if (withAnomaly === true) {
      providers.push({ provide: ANOMALY_SERVICE, useValue: anomalySvc });
    }
    const mod = await Test.createTestingModule({
      controllers: [McpAnalyticsController],
      providers,
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();
    return mod.get(McpAnalyticsController);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    forecastSvc.getForecast.mockResolvedValue({ metricKind: 'usedMemory', points: [] });
    anomalySvc.getRecentAnomalies.mockResolvedValue([]);
  });

  it('forecast forwards connection id and metric kind', async () => {
    const controller = await makeController(false);
    const res = await controller.getForecast('inst1', 'usedMemory');
    expect(res).toEqual({ metricKind: 'usedMemory', points: [] });
    expect(forecastSvc.getForecast).toHaveBeenCalledWith('inst1', 'usedMemory');
  });

  it('forecast maps service failures to 500', async () => {
    forecastSvc.getForecast.mockRejectedValueOnce(new Error('boom'));
    const controller = await makeController(false);
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
