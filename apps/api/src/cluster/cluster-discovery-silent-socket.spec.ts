import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { Test } from '@nestjs/testing';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

const COOL_OFF_MS = 30_000;
const COMMAND_TIMEOUT_MS = 100;
const SETTLE_MS = 400;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('ClusterDiscoveryService node that accepts connections and never answers', () => {
  const NODE_ID = 'silent-node';
  const configured = process.env.CLUSTER_NODE_COMMAND_TIMEOUT_MS;
  let server: Server;
  let sockets: Socket[];
  let service: ClusterDiscoveryService;
  let log: jest.SpyInstance;

  const ask = (): Promise<unknown> => service.getNodeConnection(NODE_ID, 'seed');

  beforeEach(async () => {
    process.env.CLUSTER_NODE_COMMAND_TIMEOUT_MS = String(COMMAND_TIMEOUT_MS);
    sockets = [];
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const adapter = {
      getClusterNodes: jest.fn().mockResolvedValue([
        {
          id: NODE_ID,
          address: `127.0.0.1:${port}`,
          flags: ['master'],
          master: '-',
          pingSent: 0,
          pongReceived: 1,
          configEpoch: 1,
          linkState: 'connected',
          slots: [[0, 16383]],
        },
      ]),
      getClusterShards: jest.fn().mockResolvedValue([]),
      getClient: jest.fn().mockReturnValue({ options: { username: '', password: '' } }),
    };
    const registry = {
      get: jest.fn().mockReturnValue(adapter),
      getDefaultId: jest.fn().mockReturnValue('seed'),
      getConfig: jest.fn().mockReturnValue({ id: 'seed', host: '127.0.0.1', port }),
      getNodeAvailabilityZones: jest.fn().mockReturnValue(undefined),
      sentinelDataNodeCredentials: jest.fn().mockReturnValue({ username: '', password: '' }),
      list: jest.fn().mockReturnValue([]),
    };
    const module = await Test.createTestingModule({
      providers: [ClusterDiscoveryService, { provide: ConnectionRegistry, useValue: registry }],
    }).compile();
    service = module.get(ClusterDiscoveryService);
    const logger = (service as unknown as { logger: Record<'warn' | 'log' | 'debug', () => void> }).logger;
    jest.spyOn(logger, 'warn').mockImplementation();
    jest.spyOn(logger, 'debug').mockImplementation();
    log = jest.spyOn(logger, 'log').mockImplementation();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await service.disconnectAll();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (configured === undefined) delete process.env.CLUSTER_NODE_COMMAND_TIMEOUT_MS;
    else process.env.CLUSTER_NODE_COMMAND_TIMEOUT_MS = configured;
  });

  it('does not hand out a client for a socket that opened without a reply', async () => {
    await expect(ask()).rejects.toThrow();

    expect(sockets).toHaveLength(1);
    await expect(ask()).rejects.toThrow('is not answering');
  });

  it('keeps refusing the node after a background retry that only opened a socket', async () => {
    await expect(ask()).rejects.toThrow();
    const dialed = sockets.length;
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + COOL_OFF_MS + 1);

    await expect(ask()).rejects.toThrow('is not answering');
    await wait(SETTLE_MS);

    expect(sockets.length).toBeGreaterThan(dialed);
    await expect(ask()).rejects.toThrow('is not answering');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('answers again'));
  });
});
