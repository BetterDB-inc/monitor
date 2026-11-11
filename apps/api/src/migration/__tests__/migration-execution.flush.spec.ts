type MockClient = {
  host: string;
  port: number;
  options: { tls?: { servername?: string; ca?: string } };
  connect: jest.Mock;
  flushall: jest.Mock;
  disconnect: jest.Mock;
};

const clients: MockClient[] = [];
let onConnect: () => void = () => undefined;

jest.mock('iovalkey', () => {
  const ctor = jest.fn().mockImplementation((opts: { host: string; port: number; tls?: { servername?: string } }) => {
    const client: MockClient = {
      host: opts.host,
      port: opts.port,
      options: opts,
      connect: jest.fn().mockImplementation(async () => {
        onConnect();
      }),
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
  shouldStop: () => boolean,
) => Promise<boolean>;

const TARGET_CONFIG = { id: 't', name: 'Target', host: 'target.internal', port: 6379, tls: true, tlsConfig: { ca: 'CA-PEM' }, createdAt: 1 };

const TWO_MASTERS = [
  { address: '10.0.0.1:6379@16379', hostname: 'node-a.internal', flags: ['master'], slots: [[0, 8191]] },
  { address: '10.0.0.2:6379@16379', flags: ['master'], slots: [[8192, 16383]] },
  { address: '10.0.0.3:6379@16379', flags: ['slave'], slots: [] },
];

function createService() {
  // Object.create bypasses the constructor (which wires up a full Nest service).
  const service = Object.create(MigrationExecutionService.prototype) as { flushTargetBeforeSync: FlushFn; logger: unknown };
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return service;
}

describe('MigrationExecutionService.flushTargetBeforeSync', () => {
  beforeEach(() => {
    clients.length = 0;
    onConnect = () => undefined;
  });

  it('flushes every target master, verifying each against the hostname it announces', async () => {
    const service = createService();
    const targetAdapter = {
      getClusterNodes: jest.fn().mockResolvedValue(TWO_MASTERS),
      getClient: jest.fn(),
    };

    const flushed = await service.flushTargetBeforeSync(targetAdapter, TARGET_CONFIG, true, () => false);

    expect(flushed).toBe(true);
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

  it('dials no master when the job stops while the cluster nodes are looked up', async () => {
    const service = createService();
    let stopped = false;
    const targetAdapter = {
      getClusterNodes: jest.fn().mockImplementation(async () => {
        stopped = true;
        return TWO_MASTERS;
      }),
      getClient: jest.fn(),
    };

    const flushed = await service.flushTargetBeforeSync(targetAdapter, TARGET_CONFIG, true, () => stopped);

    expect(flushed).toBe(false);
    expect(clients).toEqual([]);
  });

  it('sends no FLUSHALL when the job stops while the masters are being dialled', async () => {
    const service = createService();
    let stopped = false;
    onConnect = () => {
      stopped = true;
    };
    const targetAdapter = {
      getClusterNodes: jest.fn().mockResolvedValue(TWO_MASTERS),
      getClient: jest.fn(),
    };

    const flushed = await service.flushTargetBeforeSync(targetAdapter, TARGET_CONFIG, true, () => stopped);

    expect(flushed).toBe(false);
    expect(clients).toHaveLength(2);
    for (const client of clients) {
      expect(client.flushall).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    }
  });

  it('sends no FLUSHALL to a standalone target once the job has stopped', async () => {
    const service = createService();
    const flushall = jest.fn().mockResolvedValue('OK');
    const targetAdapter = { getClusterNodes: jest.fn(), getClient: jest.fn().mockReturnValue({ flushall }) };

    const flushed = await service.flushTargetBeforeSync(targetAdapter, TARGET_CONFIG, false, () => true);

    expect(flushed).toBe(false);
    expect(flushall).not.toHaveBeenCalled();
  });

  it('reports a standalone target as flushed', async () => {
    const service = createService();
    const flushall = jest.fn().mockResolvedValue('OK');
    const targetAdapter = { getClusterNodes: jest.fn(), getClient: jest.fn().mockReturnValue({ flushall }) };

    const flushed = await service.flushTargetBeforeSync(targetAdapter, TARGET_CONFIG, false, () => false);

    expect(flushed).toBe(true);
    expect(flushall).toHaveBeenCalledTimes(1);
  });
});
