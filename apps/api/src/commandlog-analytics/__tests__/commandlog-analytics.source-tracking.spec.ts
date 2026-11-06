import { CommandLogAnalyticsService } from '../commandlog-analytics.service';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import type { CommandLogEntry, CommandLogType } from '../../common/interfaces/database-port.interface';

function entries(ids: number[], tsBase: number): CommandLogEntry[] {
  return ids.map((id) => ({
    id,
    timestamp: tsBase + id,
    duration: 20_000,
    command: ['EVAL', `node-${tsBase}`],
    clientAddress: '10.0.9.9:5000',
    clientName: '',
    type: 'slow' as const,
  }));
}

type Pollable = { pollConnection(ctx: unknown): Promise<void> };

describe('CommandLogAnalyticsService source tracking', () => {
  it('keeps entries from each node the seed lands on, attributed to that node', async () => {
    const storage = new MemoryAdapter();
    let endpoint = { host: '10.0.0.1', port: 6379 };
    let slow: CommandLogEntry[] = entries([0, 1, 2, 3, 4, 5], 1000);
    const client = {
      getCapabilities: () => ({ hasCommandLog: true }),
      getServingEndpoint: () => endpoint,
      getInfo: jest.fn().mockRejectedValue(new Error('NOPERM')),
      getCommandLog: jest.fn(async (_count: number, type: CommandLogType) => (type === 'slow' ? slow : [])),
    };
    const service = new CommandLogAnalyticsService(
      { list: jest.fn().mockReturnValue([]) } as never,
      storage as never,
      { isAvailable: () => true, recordFailure: () => false } as never,
    );
    const ctx = { connectionId: 'seed', connectionName: 'Seed', host: 'valkey.svc', port: 6379, client };

    await (service as unknown as Pollable).pollConnection(ctx);
    endpoint = { host: '10.0.0.2', port: 6379 };
    slow = entries([0, 1, 2, 3, 4, 5, 6, 7, 8], 2000);
    await (service as unknown as Pollable).pollConnection(ctx);

    const stored = await storage.getCommandLogEntries({ connectionId: 'seed', type: 'slow', limit: 1000 });
    expect(stored.filter((e) => e.sourceHost === '10.0.0.1')).toHaveLength(6);
    expect(stored.filter((e) => e.sourceHost === '10.0.0.2')).toHaveLength(9);
  });
});
