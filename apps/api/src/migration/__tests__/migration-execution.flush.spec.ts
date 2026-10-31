type MockClient = {
  host: string;
  port: number;
  options: { tls?: { servername?: string; ca?: string } };
  connect: jest.Mock;
  flushall: jest.Mock;
  disconnect: jest.Mock;
};

const clients: MockClient[] = [];

jest.mock('iovalkey', () => {
  const ctor = jest.fn().mockImplementation((opts: { host: string; port: number; tls?: { servername?: string } }) => {
    const client: MockClient = {
      host: opts.host,
      port: opts.port,
      options: opts,
      connect: jest.fn().mockResolvedValue(undefined),
      flushall: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
    clients.push(client);
    return client;
  });
  return { __esModule: true, default: ctor, Cluster: jest.fn() };
});

import { MigrationExecutionService } from '../migration-execution.service';

type FlushFn = (
  targetAdapter: { getClusterNodes: jest.Mock; getClient: jest.Mock },
  targetConfig: Record<string, unknown>,
  targetIsCluster: boolean,
) => Promise<void>;

describe('MigrationExecutionService.flushTargetBeforeSync', () => {
  beforeEach(() => {
    clients.length = 0;
  });

  it('flushes every target master, verifying each against the hostname it announces', async () => {
    // Object.create bypasses the constructor (which wires up a full Nest service).
    const service = Object.create(MigrationExecutionService.prototype) as { flushTargetBeforeSync: FlushFn; logger: unknown };
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const targetAdapter = {
      getClusterNodes: jest.fn().mockResolvedValue([
        { address: '10.0.0.1:6379@16379', hostname: 'node-a.internal', flags: ['master'], slots: [[0, 8191]] },
        { address: '10.0.0.2:6379@16379', flags: ['master'], slots: [[8192, 16383]] },
        { address: '10.0.0.3:6379@16379', flags: ['slave'], slots: [] },
      ]),
      getClient: jest.fn(),
    };

    await service.flushTargetBeforeSync(
      targetAdapter,
      { id: 't', name: 'Target', host: 'target.internal', port: 6379, tls: true, tlsConfig: { ca: 'CA-PEM' }, createdAt: 1 },
      true,
    );

    expect(clients.map((c) => c.host).sort()).toEqual(['10.0.0.1', '10.0.0.2']);
    const nodeA = clients.find((c) => c.host === '10.0.0.1')!;
    const nodeB = clients.find((c) => c.host === '10.0.0.2')!;
    expect(nodeA.options.tls?.servername).toBe('node-a.internal');
    expect(nodeB.options.tls).toBeDefined();
    expect(nodeB.options.tls?.servername).toBeUndefined();
    expect(nodeA.options.tls?.ca).toBe('CA-PEM');
    expect(nodeB.options.tls?.ca).toBe('CA-PEM');
    for (const client of clients) {
      expect(client.flushall).toHaveBeenCalledTimes(1);
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    }
    expect(targetAdapter.getClient).not.toHaveBeenCalled();
  });
});
