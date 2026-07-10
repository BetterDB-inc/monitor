import { AiObservabilityService } from '../ai-observability.service';
import type { AiInstance } from '@betterdb/shared';
import type { DiscoveryReaderService } from '../discovery-reader.service';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';

type Saved = Omit<import('@betterdb/shared').StoredAiCacheSample, 'id' | 'connectionId'>[];

function makeService(opts: {
  instances: AiInstance[];
  call: (cmd: string, args: string[]) => unknown;
  hasVectorSearch?: boolean;
  indexInfo?: { numDocs: number; memorySizeMb: number };
}) {
  const saved: Saved[] = [];
  const storage = {
    saveAiCacheSamples: jest.fn(async (s: Saved) => {
      saved.push(s);
      return s.length;
    }),
    getAiCacheHistory: jest.fn(async () => []),
  } as unknown as StoragePort;

  const client = {
    call: async (cmd: string, args: string[]) => opts.call(cmd, args),
    getCapabilities: () => ({ hasVectorSearch: opts.hasVectorSearch ?? false }),
    getVectorIndexInfo: async () => opts.indexInfo ?? { numDocs: 0, memorySizeMb: 0 },
  };
  const registry = { get: jest.fn(() => client) } as unknown as ConnectionRegistry;
  const discovery = {
    discoverWithClient: jest.fn(async () => opts.instances),
  } as unknown as DiscoveryReaderService;

  const svc = new AiObservabilityService(registry, storage, discovery);
  const ctx = { connectionId: 'c1', connectionName: 'c1', client, host: 'h', port: 6379 } as any;
  return { svc, ctx, saved, storage };
}

const agentCache: AiInstance = {
  field: 'app',
  kind: 'agent_cache',
  name: 'app',
  version: '1',
  capabilities: [],
  statsKey: 'app:__stats',
  alive: true,
};

describe('AiObservabilityService.pollConnection', () => {
  it('aggregates agent_cache llm+tool counters and saves a sample', async () => {
    const { svc, ctx, saved } = makeService({
      instances: [agentCache],
      call: (cmd) =>
        cmd === 'HGETALL'
          ? ['llm:hits', '80', 'llm:misses', '20', 'tool:hits', '10', 'tool:misses', '5', 'cost_saved_micros', '5000000']
          : [],
    });

    await (svc as any).pollConnection(ctx);

    expect(saved).toHaveLength(1);
    const s = saved[0][0];
    expect(s.kind).toBe('agent_cache');
    expect(s.hits).toBe(90); // 80 + 10
    expect(s.misses).toBe(25); // 20 + 5
    expect(s.costSavedMicros).toBe(5_000_000);
    expect(s.hitRate).toBeNull(); // first tick: no prior counters
    expect(JSON.parse(s.extra as string).session).toEqual({ reads: 0, writes: 0 });
  });

  it('derives a per-tick hit rate from counter deltas on the second poll', async () => {
    let hits = 80;
    let misses = 20;
    const { svc, ctx, saved } = makeService({
      instances: [agentCache],
      call: (cmd) =>
        cmd === 'HGETALL'
          ? ['llm:hits', String(hits), 'llm:misses', String(misses), 'tool:hits', '0', 'tool:misses', '0']
          : [],
    });

    await (svc as any).pollConnection(ctx); // baseline
    hits = 100; // +20 hits
    misses = 30; // +10 misses
    await (svc as any).pollConnection(ctx);

    expect(saved).toHaveLength(2);
    expect(saved[1][0].hitRate).toBeCloseTo(20 / 30); // dHits / (dHits + dMisses)
  });

  it('returns a null hit rate on a counter reset (restart)', async () => {
    let hits = 100;
    const { svc, ctx, saved } = makeService({
      instances: [agentCache],
      call: (cmd) => (cmd === 'HGETALL' ? ['llm:hits', String(hits), 'llm:misses', '0'] : []),
    });

    await (svc as any).pollConnection(ctx);
    hits = 5; // counter went backwards → restart
    await (svc as any).pollConnection(ctx);

    expect(saved[1][0].hitRate).toBeNull();
  });

  it('reads FT.INFO for memory item count and index bytes', async () => {
    const memInstance: AiInstance = {
      field: 'app:mem',
      kind: 'agent_memory',
      name: 'app',
      version: '1',
      capabilities: [],
      statsKey: 'app:__mem_stats',
      indexName: 'app:mem:idx',
      alive: true,
    };
    const { svc, ctx, saved } = makeService({
      instances: [memInstance],
      hasVectorSearch: true,
      indexInfo: { numDocs: 4200, memorySizeMb: 2 },
      call: (cmd) => {
        if (cmd === 'HGETALL') return ['evictions', '7', 'recall.threshold', '0.4'];
        return [];
      },
    });

    await (svc as any).pollConnection(ctx);

    const s = saved[0][0];
    expect(s.kind).toBe('agent_memory');
    expect(s.evictions).toBe(7);
    expect(s.items).toBe(4200);
    expect(s.indexBytes).toBe(2 * 1024 * 1024);
    expect(s.threshold).toBeCloseTo(0.4);
  });

  it('does nothing when no instances are discovered', async () => {
    const { svc, ctx, storage } = makeService({ instances: [], call: () => [] });
    await (svc as any).pollConnection(ctx);
    expect(storage.saveAiCacheSamples).not.toHaveBeenCalled();
  });
});
