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
  let runId: string | null;
  let served: SlowLogEntry[];
  let onRead: () => void;
  let onInfo: () => void;
  let generation: number;
  let infoError: Error | null;

  const ctx = () => ({
    connectionId: 'seed',
    connectionName: 'Seed',
    host: 'valkey.ns.svc.cluster.local',
    port: 6379,
    client: {
      getSlowLog: jest.fn(async () => {
        const batch = served;
        onRead();
        return batch;
      }),
      getServingEndpoint: () => endpoint,
      getConnectionGeneration: () => generation,
      getInfo: jest.fn(async () => {
        const reply = runId;
        onInfo();
        if (infoError) throw infoError;
        if (reply === null) throw new Error('NOPERM');
        return { server: { run_id: reply } };
      }),
    },
  });
  const poll = () => (service as unknown as Pollable).pollConnection(ctx());

  beforeEach(() => {
    runId = null;
    infoError = null;
    onRead = () => undefined;
    onInfo = () => undefined;
    generation = 1;
    repo = new SlowLogMemoryRepository();
    service = newService();
  });

  function newService(): SlowLogAnalyticsService {
    const storage = {
      saveSlowLogEntries: repo.saveSlowLogEntries.bind(repo),
      getLatestSlowLogId: repo.getLatestSlowLogId.bind(repo),
      hasRunIdLogEntries: async (id: string) => repo.hasRunIdEntries(id),
    };
    const registry = { getDefaultId: () => 'seed', getAll: () => [], on: jest.fn(), removeListener: jest.fn() };
    const capabilities = { isAvailable: () => true, recordFailure: () => false };
    return new SlowLogAnalyticsService(registry as never, storage as never, {} as never, capabilities as never);
  }

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

  it('does not replay a process reached through a different address', async () => {
    // Same server behind two addresses (NLB IP per zone, IPv4 vs IPv6).
    runId = 'run-a';
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1, 2, 3, 4], 1000);
    await poll();

    endpoint = { host: '10.0.1.1', port: 6379 };
    served = entries([0, 1, 2, 3, 4, 5, 6], 1000);
    await poll();

    const stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 1000 });
    expect(stored.map((e) => e.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(stored.every((e) => e.sourceRunId === 'run-a')).toBe(true);
  });

  it('keeps the entries of a restarted process on the same address', async () => {
    runId = 'run-a';
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 1000);
    await poll();

    // The node restarts (or a new pod reuses the IP): log IDs start over.
    runId = 'run-b';
    served = entries([0, 1, 2], 2000);
    await poll();

    const stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 1000 });
    expect(stored.filter((e) => e.sourceRunId === 'run-b').map((e) => e.timestamp).sort()).toEqual([2000, 2001, 2002]);
    expect(stored.filter((e) => e.sourceRunId === 'run-a')).toHaveLength(10);
  });

  it('skips a batch read while the connection moved to another process', async () => {
    runId = 'run-a';
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1, 2], 1000);
    onRead = () => {
      runId = 'run-b';
      endpoint = { host: '10.0.0.2', port: 6379 };
    };
    await poll();

    expect(await repo.getSlowLogEntries({ connectionId: 'seed' })).toEqual([]);
  });

  it('skips a batch read across a reconnect that came back to the same process', async () => {
    runId = 'run-a';
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1, 2], 1000);
    onRead = () => {
      generation++;
    };
    await poll();

    expect(await repo.getSlowLogEntries({ connectionId: 'seed' })).toEqual([]);
  });

  it('skips the poll while INFO fails for a connection that reported a run id', async () => {
    runId = 'run-a';
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1], 1000);
    await poll();

    infoError = new Error('Command timed out');
    served = entries([0, 1, 2, 3], 1000);
    await poll();
    let stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 100 });
    expect(stored.map((e) => e.id).sort()).toEqual([0, 1]);

    infoError = null;
    await poll();
    stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 100 });
    expect(stored.map((e) => e.id).sort()).toEqual([0, 1, 2, 3]);
    expect(stored.every((e) => e.sourceRunId === 'run-a')).toBe(true);
  });

  it('skips the poll after a monitor restart while INFO fails for a connection that stored a run id', async () => {
    runId = 'run-a';
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1], 1000);
    await poll();

    service = newService();
    infoError = new Error('Command timed out');
    served = entries([0, 1, 2], 1000);
    await poll();

    const stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 100 });
    expect(stored.map((e) => e.id).sort()).toEqual([0, 1]);
  });

  it('tracks by address once INFO is refused for a connection that reported a run id', async () => {
    runId = 'run-a';
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1], 1000);
    await poll();

    // An ACL change now denies INFO for good; collection must not stop.
    runId = null;
    served = entries([0, 1, 2], 1000);
    await poll();

    const stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 100 });
    expect(stored.filter((e) => e.sourceRunId === '').map((e) => e.id).sort()).toEqual([0, 1, 2]);
  });

  it('notices run id entries another replica stored after an earlier check found none', async () => {
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1], 1000);
    await poll();
    expect(await repo.getSlowLogEntries({ connectionId: 'seed' })).toHaveLength(2);

    await repo.saveSlowLogEntries(
      entries([5], 3000).map((e) => ({ ...e, capturedAt: 1, sourceHost: '10.0.0.1', sourcePort: 6379, sourceRunId: 'run-a', connectionId: 'seed' })),
      'seed',
    );
    served = entries([0, 1, 2], 1000);
    await poll();

    const stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 100 });
    expect(stored.filter((e) => !e.sourceRunId).map((e) => e.id).sort()).toEqual([0, 1]);
  });

  it('tracks by address when a managed server blocks INFO', async () => {
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1], 1000);
    infoError = new Error("ERR Command is not available: 'INFO'");
    await poll();

    const stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 100 });
    expect(stored.map((e) => e.id).sort()).toEqual([0, 1]);
    expect(stored.every((e) => e.sourceRunId === '')).toBe(true);
  });

  it('skips the poll when INFO fails for a reason other than being refused', async () => {
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1], 1000);
    infoError = new Error('Command timed out');
    await poll();
    expect(await repo.getSlowLogEntries({ connectionId: 'seed' })).toEqual([]);

    // The next poll reads the run id and stores the entries once, under it.
    infoError = null;
    runId = 'run-a';
    await poll();
    const stored = await repo.getSlowLogEntries({ connectionId: 'seed', limit: 100 });
    expect(stored.map((e) => e.id).sort()).toEqual([0, 1]);
    expect(stored.every((e) => e.sourceRunId === 'run-a')).toBe(true);
  });

  it('skips the poll when the connection reconnects while INFO is pending', async () => {
    runId = 'run-a';
    endpoint = { host: '10.0.0.1', port: 6379 };
    served = entries([0, 1], 1000);
    onInfo = () => {
      generation++;
      endpoint = { host: '10.0.0.2', port: 6379 };
      onInfo = () => undefined;
    };
    await poll();

    expect(await repo.getSlowLogEntries({ connectionId: 'seed' })).toEqual([]);
  });
});
