import { Test } from '@nestjs/testing';
import { McpMemoryController } from '../mcp-memory.controller';
import { McpMemoryService } from '../mcp-memory.service';
import { AgentTokenGuard } from '../../../common/guards/agent-token.guard';

describe('McpMemoryController', () => {
  let controller: McpMemoryController;
  const svc = {
    discoverStores: jest.fn().mockResolvedValue([
      { name: 'demo', prefix: 'demo', statsKey: 'demo:__mem_stats', version: '0.1.0', capabilities: [] },
    ]),
    list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    get: jest.fn().mockResolvedValue(null),
    stats: jest.fn().mockResolvedValue({ itemCount: 0, evictions: 0, config: {} }),
    recall: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod = await Test.createTestingModule({
      controllers: [McpMemoryController],
      providers: [{ provide: McpMemoryService, useValue: svc }],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpMemoryController);
  });

  it('GET stores returns discovered stores', async () => {
    const res = await controller.getStores('inst1');
    expect(res.stores).toHaveLength(1);
    expect(svc.discoverStores).toHaveBeenCalledWith('inst1');
  });

  it('POST recall passes the vector and scope to the service', async () => {
    await controller.recall('inst1', 'demo', { vector: [0, 1], k: 5, scope: { threadId: 't1' } });
    expect(svc.recall).toHaveBeenCalledWith(
      'inst1',
      'demo',
      [0, 1],
      expect.objectContaining({ k: 5, threadId: 't1' }),
    );
  });

  it('GET get throws 404 when the memory is missing', async () => {
    await expect(controller.get('inst1', 'demo', 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('POST recall rejects an empty vector', async () => {
    await expect(controller.recall('inst1', 'demo', { vector: [] })).rejects.toMatchObject({
      status: 400,
    });
  });
});
