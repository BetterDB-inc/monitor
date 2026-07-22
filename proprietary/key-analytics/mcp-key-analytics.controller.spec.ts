import { Test } from '@nestjs/testing';
import { McpKeyAnalyticsController } from './mcp-key-analytics.controller';
import { KeyAnalyticsService } from './key-analytics.service';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { LicenseGuard } from '@proprietary/licenses';

describe('McpKeyAnalyticsController', () => {
  let controller: McpKeyAnalyticsController;
  const svc = {
    getLargestKeys: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    svc.getLargestKeys.mockResolvedValue([{ key: 'big:1', memoryBytes: 1024 }]);
    const mod = await Test.createTestingModule({
      controllers: [McpKeyAnalyticsController],
      providers: [{ provide: KeyAnalyticsService, useValue: svc }],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(LicenseGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpKeyAnalyticsController);
  });

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
});
