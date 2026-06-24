import { McpMemoryService } from '../mcp-memory.service';
import type { ConnectionRegistry } from '../../../connections/connection-registry.service';

function makeRegistry(call: jest.Mock): ConnectionRegistry {
  return {
    get: jest.fn(() => ({ getClient: () => ({ call }) })),
  } as unknown as ConnectionRegistry;
}

describe('McpMemoryService.discoverStores', () => {
  it('reads __betterdb:caches and returns only agent_memory markers', async () => {
    const marker = JSON.stringify({
      type: 'agent_memory',
      prefix: 'demo_sc',
      version: '0.1.0',
      protocol_version: 1,
      capabilities: ['recall', 'consolidate'],
      stats_key: 'demo_sc:__mem_stats',
      started_at: 'x',
    });
    const cacheMarker = JSON.stringify({ type: 'semantic_cache', prefix: 'other' });
    const call = jest.fn(async (cmd: string) =>
      cmd === 'HGETALL' ? ['demo_sc:mem', marker, 'other', cacheMarker] : 'OK',
    );
    const svc = new McpMemoryService(makeRegistry(call));

    const stores = await svc.discoverStores('inst1');

    expect(call).toHaveBeenCalledWith('HGETALL', '__betterdb:caches');
    expect(stores).toEqual([
      {
        name: 'demo_sc',
        prefix: 'demo_sc',
        statsKey: 'demo_sc:__mem_stats',
        version: '0.1.0',
        capabilities: ['recall', 'consolidate'],
      },
    ]);
  });
});
