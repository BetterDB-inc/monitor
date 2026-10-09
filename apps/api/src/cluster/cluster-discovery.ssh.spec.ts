import { Test, TestingModule } from '@nestjs/testing';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { DEFAULT_REDIS_PORT, MOCK_TUNNEL_PORT } from '@betterdb/shared';
import { CLUSTER_IDLE_TIMEOUT_MS } from '../common/constants/cluster.constants';

const seenOptions: Array<{ host: string; port: number }> = [];

class FakeValkey {
  options: { host: string; port: number };
  status = 'ready';

  constructor(opts: { host: string; port: number }) {
    this.options = { host: opts.host, port: opts.port };
    seenOptions.push(this.options);
  }

  on(): void {}

  async connect(): Promise<void> {
    this.status = 'ready';
  }

  async quit(): Promise<void> {
    this.status = 'end';
  }
}

jest.mock('iovalkey', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((opts: { host: string; port: number }) => new FakeValkey(opts)),
}));

describe('ClusterDiscoveryService — SSH tunnel dial', () => {
  beforeEach(() => {
    seenOptions.length = 0;
    jest.clearAllMocks();
  });

  async function buildService(dial: ((host: string, port: number) => Promise<{ host: string; port: number }>) | undefined) {
    const mockDbClient = {
      getClusterNodes: jest.fn().mockResolvedValue([
        {
          id: 'node1-abc',
          address: `10.0.1.5:${DEFAULT_REDIS_PORT}`,
          flags: ['master', 'myself'],
          master: '-',
          pingSent: 0,
          pongReceived: 1,
          configEpoch: 1,
          linkState: 'connected',
          slots: [[0, 5460]],
        },
      ]),
      getClient: jest.fn().mockReturnValue({ options: { username: 'u', password: 'p' } }),
      ...(dial ? { dialNodeThroughTunnel: jest.fn(dial) } : {}),
    };
    const mockRegistry = {
      get: jest.fn().mockReturnValue(mockDbClient),
      getDefaultId: jest.fn().mockReturnValue('conn-1'),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClusterDiscoveryService,
        { provide: ConnectionRegistry, useValue: mockRegistry },
      ],
    }).compile();
    const service = module.get<ClusterDiscoveryService>(ClusterDiscoveryService);
    return { service, mockDbClient };
  }

  it('dials the advertised private address through the tunnel loopback', async () => {
    const { service, mockDbClient } = await buildService(async () => ({ host: '127.0.0.1', port: MOCK_TUNNEL_PORT }));
    const nodes = await service.discoverNodes('conn-1');
    await service.getNodeConnection(nodes[0].id, 'conn-1');

    expect(mockDbClient.dialNodeThroughTunnel).toHaveBeenCalledWith('10.0.1.5', DEFAULT_REDIS_PORT);
    expect(seenOptions[seenOptions.length - 1]).toEqual({ host: '127.0.0.1', port: MOCK_TUNNEL_PORT });
    await service.disconnectAll();
  });

  it('dials directly when the adapter has no tunnel dialer', async () => {
    const { service } = await buildService(undefined);
    const nodes = await service.discoverNodes('conn-1');
    await service.getNodeConnection(nodes[0].id, 'conn-1');

    expect(seenOptions[seenOptions.length - 1]).toEqual({ host: '10.0.1.5', port: DEFAULT_REDIS_PORT });
    await service.disconnectAll();
  });

  it('releases the SSH forward when idle connections are cleaned up', async () => {
    const release = jest.fn();
    const { service, mockDbClient } = await buildService(async () => ({ host: '127.0.0.1', port: MOCK_TUNNEL_PORT }));
    (mockDbClient as unknown as { releaseNodeThroughTunnel: jest.Mock }).releaseNodeThroughTunnel = release;
    const nodes = await service.discoverNodes('conn-1');
    await service.getNodeConnection(nodes[0].id, 'conn-1');
    const conn = (service as unknown as { discoveredNodes: Map<string, { lastHealthCheck: number }> }).discoveredNodes.get(nodes[0].id)!;
    conn.lastHealthCheck = Date.now() - (CLUSTER_IDLE_TIMEOUT_MS + 10000);
    await service.cleanupIdleConnections(CLUSTER_IDLE_TIMEOUT_MS);
    expect(release).toHaveBeenCalledWith('10.0.1.5', DEFAULT_REDIS_PORT);
    await service.disconnectAll();
  });

  it('releases the SSH forward on disconnectAll', async () => {
    const release = jest.fn();
    const { service, mockDbClient } = await buildService(async () => ({ host: '127.0.0.1', port: MOCK_TUNNEL_PORT }));
    (mockDbClient as unknown as { releaseNodeThroughTunnel: jest.Mock }).releaseNodeThroughTunnel = release;
    const nodes = await service.discoverNodes('conn-1');
    await service.getNodeConnection(nodes[0].id, 'conn-1');
    await service.disconnectAll();
    expect(release).toHaveBeenCalledWith('10.0.1.5', DEFAULT_REDIS_PORT);
  });

  it('propagates dial failures instead of falling back to direct dial', async () => {
    const { service } = await buildService(async () => {
      throw new Error('SSH tunnel is not established');
    });
    const nodes = await service.discoverNodes('conn-1');
    await expect(service.getNodeConnection(nodes[0].id, 'conn-1')).rejects.toThrow(/SSH tunnel is not established/);
    expect(seenOptions.length).toBe(0);
    await service.disconnectAll();
  });

  it('does not add an outer timeout race — the service single budget governs', async () => {
    let dialCalls = 0;
    const { service, mockDbClient } = await buildService(async () => {
      dialCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return { host: '127.0.0.1', port: MOCK_TUNNEL_PORT };
    });
    const nodes = await service.discoverNodes('conn-1');
    const start = Date.now();
    await service.getNodeConnection(nodes[0].id, 'conn-1');
    const elapsed = Date.now() - start;
    expect(dialCalls).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(10);
    expect(mockDbClient.dialNodeThroughTunnel).toHaveBeenCalledTimes(1);
    await service.disconnectAll();
  });

  it('releases forward when Valkey connect fails after successful dial', async () => {
    const release = jest.fn();
    let valkeyCallCount = 0;
    const { service, mockDbClient } = await buildService(async () => ({ host: '127.0.0.1', port: MOCK_TUNNEL_PORT }));
    (mockDbClient as unknown as { releaseNodeThroughTunnel: jest.Mock }).releaseNodeThroughTunnel = release;

    const ValkeyMock = jest.requireMock('iovalkey').default as jest.Mock;
    const originalImpl = ValkeyMock.getMockImplementation();
    ValkeyMock.mockImplementation((opts: { host: string; port: number }) => {
      valkeyCallCount++;
      const instance = (originalImpl as unknown as (opts: { host: string; port: number }) => FakeValkey)(opts);
      if (valkeyCallCount === 1) {
        instance.connect = jest.fn(async () => {
          throw new Error('Valkey handshake failed');
        });
      }
      return instance;
    });

    const nodes = await service.discoverNodes('conn-1');
    await expect(service.getNodeConnection(nodes[0].id, 'conn-1')).rejects.toThrow(/Valkey handshake failed/);
    expect(release).toHaveBeenCalledWith('10.0.1.5', DEFAULT_REDIS_PORT);
    expect(seenOptions.length).toBe(1);
    ValkeyMock.mockImplementation(originalImpl as unknown as (...args: unknown[]) => unknown);
    await service.disconnectAll();
  });
});
