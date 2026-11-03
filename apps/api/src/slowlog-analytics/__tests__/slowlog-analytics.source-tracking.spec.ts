import { SlowLogAnalyticsService } from '../slowlog-analytics.service';
import { SlowLogMemoryRepository } from '../../storage/adapters/repositories/slowlog.memory.repository';
import type { SlowLogEntry } from '../../common/interfaces/database-port.interface';

// A seed whose host is a Kubernetes headless Service: the socket lands on one
// node, and on a different one after a reconnect. Slowlog IDs are per node.
function entries(ids: number[], tsBase: number): SlowLogEntry[] {
  return ids.map((id) => ({
    id,
    timestamp: tsBase + id,
    duration: 20_000,
    command: ['EVAL', `node-${tsBase}`],
    clientAddress: '10.0.9.9:5000',
    clientName: '',
  }));
}

type Pollable = { pollConnection(ctx: unknown): Promise<void> };

describe('SlowLogAnalyticsService source tracking', () => {
  let repo: SlowLogMemoryRepository;
  let service: SlowLogAnalyticsService;
  let endpoint: { host: string; port: number } | null;
  let served: SlowLogEntry[];

  const ctx = () => ({
    connectionId: 'seed',
    connectionName: 'Seed',
    host: 'valkey.ns.svc.cluster.local',
    port: 6379,
    client: {
      getSlowLog: jest.fn(async () => served),
      getServingEndpoint: () => endpoint,
    },
  });
  const poll = () => (service as unknown as Pollable).pollConnection(ctx());

  beforeEach(() => {
    repo = new SlowLogMemoryRepository();
    const storage = {
      saveSlowLogEntries: repo.saveSlowLogEntries.bind(repo),
      getLatestSlowLogId: repo.getLatestSlowLogId.bind(repo),
    };
    const registry = { getDefaultId: () => 'seed', getAll: () => [], on: jest.fn(), removeListener: jest.fn() };
    const capabilities = { isAvailable: () => true, recordFailure: () => false };
    service = new SlowLogAnalyticsService(registry as never, storage as never, {} as never, capabilities as never);
  });

  it('stores every entry of the node the seed moved to, attributed to that node', async () => {
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 1000);
    await poll();

    // Seed reconnects through DNS to another node with overlapping and higher IDs.
    endpoint = { host: '10.0.0.2', port: 6379 };
    served = entries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 2000);
    await poll();

    const stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 1000 });
    expect(stored.filter((e) => e.sourceHost === '10.0.0.1')).toHaveLength(10);
    expect(stored.filter((e) => e.sourceHost === '10.0.0.2')).toHaveLength(13);
    expect(stored.some((e) => e.sourceHost === 'valkey.ns.svc.cluster.local')).toBe(false);
  });

  it('resumes a node from its own last stored id when the seed returns to it', async () => {
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1, 2], 1000);
    await poll();
    endpoint = { host: '10.0.0.2', port: 6379 };
    served = entries([0, 1, 2, 3, 4, 5, 6, 7], 2000);
    await poll();

    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1, 2, 3, 4], 1000);
    await poll();

    const fromFirst = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 1000 });
    expect(fromFirst.filter((e) => e.sourceHost === '10.0.0.1').map((e) => e.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('falls back to the configured address when the serving node is unknown', async () => {
    endpoint = null;
    served = entries([0, 1], 1000);
    await poll();

    const stored = await repo.getSlowLogEntries({ connectionId: 'seed' });
    expect(stored.map((e) => `${e.sourceHost}:${e.sourcePort}`)).toEqual([
      'valkey.ns.svc.cluster.local:6379',
      'valkey.ns.svc.cluster.local:6379',
    ]);
  });
});
