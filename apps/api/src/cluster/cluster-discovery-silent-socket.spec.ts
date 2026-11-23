import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { Test } from '@nestjs/testing';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

const COOL_OFF_MS = 30_000;
const COMMAND_TIMEOUT_MS = 100;
const CONNECT_TIMEOUT_MS = 300;
const LOADING_INFO = '# Persistence\r\nloading:1\r\nloading_eta_seconds:60\r\n';
const SETTLE_MS = 400;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const commandsIn = (chunk: Buffer): string[] =>
  chunk
    .toString()
    .split(/(?=^\*\d+\r\n)/m)
    .filter((part) => part.length > 0);

const nameOf = (command: string): string | undefined => command.split('\r\n')[2]?.toUpperCase();

const bulk = (text: string): string => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;

describe('ClusterDiscoveryService node behind a real socket', () => {
  const NODE_ID = 'silent-node';
  const configured = process.env.CLUSTER_NODE_COMMAND_TIMEOUT_MS;
  let server: Server;
  let sockets: Socket[];
  let service: ClusterDiscoveryService;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let replyTo: ((command: string) => string) | undefined;

  const ask = (): Promise<unknown> => service.getNodeConnection(NODE_ID, 'seed');

  beforeEach(async () => {
    process.env.CLUSTER_NODE_COMMAND_TIMEOUT_MS = String(COMMAND_TIMEOUT_MS);
    sockets = [];
    replyTo = undefined;
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        if (!replyTo) return;
        for (const command of commandsIn(chunk)) socket.write(replyTo(command));
      });
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
    warn = jest.spyOn(logger, 'warn').mockImplementation();
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
    const clock = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => clock() + COOL_OFF_MS + 1);

    await expect(ask()).rejects.toThrow('is not answering');
    await wait(SETTLE_MS);

    expect(sockets.length).toBeGreaterThan(dialed);
    await expect(ask()).rejects.toThrow('is not answering');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('answers again'));
  });

  it('does not skip a node that answers that it is loading its data', async () => {
    replyTo = (command) => (nameOf(command) === 'INFO' ? bulk(LOADING_INFO) : '+OK\r\n');
    (service as unknown as { CONNECTION_TIMEOUT: number }).CONNECTION_TIMEOUT = CONNECT_TIMEOUT_MS;
    await expect(ask()).rejects.toThrow('Connection timeout');

    await expect(ask()).rejects.toThrow('Connection timeout');

    expect(sockets).toHaveLength(2);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is not answering'));
  });
});
