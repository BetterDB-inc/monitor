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

describe('McpMemoryService read delegations', () => {
  function searchReply(rows: Array<{ key: string; fields: Record<string, string> }>): unknown[] {
    const out: unknown[] = [String(rows.length)];
    for (const row of rows) {
      const flat: string[] = [];
      for (const [k, v] of Object.entries(row.fields)) {
        flat.push(k, v);
      }
      out.push(row.key, flat);
    }
    return out;
  }

  it('list delegates to MemoryStore.list against the instance client', async () => {
    const reply = searchReply([{ key: 'demo:mem:a', fields: { content: 'x', created_at: '100' } }]);
    const call = jest.fn(async (cmd: string, ..._args: unknown[]) =>
      cmd === 'FT.SEARCH' ? reply : 'OK',
    );
    const svc = new McpMemoryService(makeRegistry(call));

    const res = await svc.list('inst1', 'demo', { threadId: 't1' });

    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('a');
    const search = call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(search?.[1]).toBe('demo:mem:idx');
  });

  it('recall delegates to MemoryStore.recallByVector with the supplied vector', async () => {
    const reply = (() => {
      const fields = {
        __score: '0.1',
        content: 'hit',
        importance: '0.5',
        created_at: '100',
        last_accessed_at: '100',
        access_count: '0',
      };
      const flat: string[] = [];
      for (const [k, v] of Object.entries(fields)) {
        flat.push(k, v);
      }
      return ['1', 'demo:mem:a', flat];
    })();
    const call = jest.fn(async (cmd: string, ..._args: unknown[]) => {
      if (cmd === 'FT.SEARCH') {
        return reply;
      }
      if (cmd === 'EXISTS') {
        return 1;
      }
      return 'OK';
    });
    const svc = new McpMemoryService(makeRegistry(call));

    const hits = await svc.recall('inst1', 'demo', [0, 1, 0, 0, 0, 0, 0, 0], {
      threadId: 't1',
      reinforce: false,
    });

    expect(hits.map((h) => h.item.id)).toEqual(['a']);
    const search = call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(String(search?.[2])).toContain('KNN');
  });
});
