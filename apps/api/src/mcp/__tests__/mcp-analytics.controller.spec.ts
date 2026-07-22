import { HttpException, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INFERENCE_LATENCY_PRO_SERVICE } from '@betterdb/shared';
import { McpAnalyticsController } from '../mcp-analytics.controller';
import { MetricForecastingService } from '../../metric-forecasting/metric-forecasting.service';
import { VectorSearchService } from '../../vector-search/vector-search.service';
import {
  InferenceLatencyService,
  InferenceLatencyValidationError,
} from '../../inference-latency/inference-latency.service';
import { AgentTokenGuard } from '../../common/guards/agent-token.guard';
import { CapabilityUnavailableError } from '../../common/errors/capability-unavailable.error';

describe('McpAnalyticsController', () => {
  const forecastSvc = {
    getForecast: jest.fn(),
  };
  const vectorSvc = {
    getIndexList: jest.fn(),
    getIndexInfo: jest.fn(),
  };
  const inferenceSvc = {
    getProfile: jest.fn(),
  };
  const proSvc = {
    getSlaStatus: jest.fn(),
  };

  async function makeController(withPro = false): Promise<McpAnalyticsController> {
    const providers: Provider[] = [
      { provide: MetricForecastingService, useValue: forecastSvc },
      { provide: VectorSearchService, useValue: vectorSvc },
      { provide: InferenceLatencyService, useValue: inferenceSvc },
    ];
    if (withPro === true) {
      providers.push({ provide: INFERENCE_LATENCY_PRO_SERVICE, useValue: proSvc });
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
    vectorSvc.getIndexList.mockResolvedValue(['idx1']);
    vectorSvc.getIndexInfo.mockResolvedValue({ name: 'idx1', numDocs: 5 });
    inferenceSvc.getProfile.mockResolvedValue({ windowMs: 60000, buckets: [] });
    proSvc.getSlaStatus.mockReturnValue([]);
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

  it('vector indexes expands each index to its info', async () => {
    const controller = await makeController();
    const res = await controller.getVectorIndexes('inst1');
    expect(res.indexes).toEqual([{ name: 'idx1', numDocs: 5 }]);
    expect(vectorSvc.getIndexInfo).toHaveBeenCalledWith('inst1', 'idx1');
  });

  it('vector indexes maps missing Search module to 501', async () => {
    vectorSvc.getIndexList.mockRejectedValueOnce(
      new CapabilityUnavailableError(
        'Vector search is not available on this connection (Search module not loaded)',
      ),
    );
    const controller = await makeController();
    let caught: unknown;
    try {
      await controller.getVectorIndexes('inst1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(501);
  });

  it('inference latency returns profile with null sla when pro absent', async () => {
    const controller = await makeController();
    const res = await controller.getInferenceLatency('inst1', '30000');
    expect(res.profile).toEqual({ windowMs: 60000, buckets: [] });
    expect(res.sla).toBeNull();
    expect(inferenceSvc.getProfile).toHaveBeenCalledWith('inst1', { windowMs: 30000 });
  });

  it('inference latency merges sla status when pro present', async () => {
    proSvc.getSlaStatus.mockReturnValue([
      { indexName: 'products', thresholdUs: 100, breached: true, lastFiredAt: 5 },
    ]);
    const controller = await makeController(true);
    const res = await controller.getInferenceLatency('inst1', undefined);
    expect(res.sla).toEqual([
      { indexName: 'products', thresholdUs: 100, breached: true, lastFiredAt: 5 },
    ]);
    expect(proSvc.getSlaStatus).toHaveBeenCalledWith('inst1');
    expect(inferenceSvc.getProfile).toHaveBeenCalledWith('inst1', { windowMs: undefined });
  });

  it('inference latency maps validation errors to 400', async () => {
    inferenceSvc.getProfile.mockRejectedValueOnce(new InferenceLatencyValidationError('bad window'));
    const controller = await makeController();
    let caught: unknown;
    try {
      await controller.getInferenceLatency('inst1', '-5');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(400);
  });
});
