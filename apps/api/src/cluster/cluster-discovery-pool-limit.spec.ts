import { Test } from '@nestjs/testing';
import Valkey from 'iovalkey';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

let mockConnectMs = 0;

jest.mock('iovalkey', () => {
  return jest.fn().mockImplementation(() => {
    const client = {
      status: 'ready',
      connect: jest.fn().mockImplementation(() =>
        mockConnectMs > 0
          ? new Promise<void>((resolve) => setTimeout(resolve, mockConnectMs))
          : Promise.resolve(),
      ),
      quit: jest.fn().mockImplementation(async () => {
        client.status = 'end';
      }),
      disconnect: jest.fn().mockImplementation(() => {
        client.status = 'end';
      }),
      ping: jest.fn().mockResolvedValue('PONG'),
      on: jest.fn(),
    };
    return client;
  });
});

const POOL_LIMIT = 512;
const NODE_COUNT = 600;
const COMMAND_TIMEOUT_MS = 5000;
const STEP_MS = 20;
const CONNECT_MS = 50;
const START = 1_000_000;

describe('ClusterDiscoveryService node client limit', () => {
  let service: ClusterDiscoveryService;
  let warn: jest.SpyInstance;
  let debug: jest.SpyInstance;

  const nodes = Array.from({ length: NODE_COUNT }, (_, index) => ({
    id: `node-${String(index).padStart(4, '0')}`,
    address: `10.0.${Math.floor(index / 250)}.${index % 250}:6379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 1,
    configEpoch: index + 1,
    linkState: 'connected',
    slots: [[index, index]],
  }));

  const spare = { ...nodes[0], id: 'node-spare', address: '10.9.9.9:6379', slots: [[NODE_COUNT, NODE_COUNT]] };

  const createdClients = (): number => (Valkey as unknown as jest.Mock).mock.results.length;

  const openClients = (): number =>
    (Valkey as unknown as jest.Mock).mock.results.filter((result) => result.value.status === 'ready').length;

  const askOneAfterAnother = async (now: jest.SpyInstance): Promise<void> => {
    for (const [index, node] of nodes.entries()) {
      now.mockReturnValue(START + index * STEP_MS);
      await service.getNodeConnection(node.id, 'seed');
    }
  };

  const askAtTheSameTime = () => Promise.all(nodes.map((node) => service.getNodeConnection(node.id, 'seed')));

  beforeEach(async () => {
    (Valkey as unknown as jest.Mock).mockClear();
    const adapter = {
      getClusterNodes: jest.fn().mockResolvedValue([...nodes, spare]),
      getClusterShards: jest.fn().mockResolvedValue([]),
      getClient: jest.fn().mockReturnValue({ options: { username: '', password: '' } }),
    };
    const registry = {
      get: jest.fn().mockReturnValue(adapter),
      getDefaultId: jest.fn().mockReturnValue('seed'),
      getConfig: jest.fn().mockReturnValue({ id: 'seed', host: 'localhost', port: 6379 }),
      getNodeAvailabilityZones: jest.fn().mockReturnValue(undefined),
      list: jest.fn().mockReturnValue([]),
    };
    const module = await Test.createTestingModule({
      providers: [ClusterDiscoveryService, { provide: ConnectionRegistry, useValue: registry }],
    }).compile();
    service = module.get(ClusterDiscoveryService);
    const logger = (service as unknown as { logger: Record<'warn' | 'log' | 'debug', () => void> }).logger;
    warn = jest.spyOn(logger, 'warn').mockImplementation();
    debug = jest.spyOn(logger, 'debug').mockImplementation();
    jest.spyOn(logger, 'log').mockImplementation();
  });

  afterEach(async () => {
    mockConnectMs = 0;
    jest.useRealTimers();
    jest.restoreAllMocks();
    await service.disconnectAll();
  });

  it('keeps the pool at the limit when callers ask one after another', async () => {
    await askOneAfterAnother(jest.spyOn(Date, 'now'));

    expect(service.getConnectionPoolSize()).toBe(POOL_LIMIT);
    expect(openClients()).toBe(POOL_LIMIT);
  });

  it('hands every caller a usable client when more callers than the limit ask at the same time', async () => {
    const clients = await askAtTheSameTime();

    expect(clients.filter((client) => client.status !== 'ready')).toHaveLength(0);
    expect(new Set(clients).size).toBe(NODE_COUNT);
  });

  it('connects the clients over the limit at the same time as the others', async () => {
    jest.useFakeTimers();
    mockConnectMs = CONNECT_MS;
    let served = 0;
    const all = Promise.all(
      nodes.map((node) =>
        service.getNodeConnection(node.id, 'seed').then(() => {
          served += 1;
        }),
      ),
    );

    await jest.advanceTimersByTimeAsync(CONNECT_MS);
    const servedAfterOneConnect = served;
    await jest.advanceTimersByTimeAsync(CONNECT_MS * NODE_COUNT);
    await all;

    expect(servedAfterOneConnect).toBe(NODE_COUNT);
  });

  it('opens no new client when the same callers ask again', async () => {
    await askAtTheSameTime();

    const clients = await askAtTheSameTime();

    expect(createdClients()).toBe(NODE_COUNT);
    expect(clients.filter((client) => client.status !== 'ready')).toHaveLength(0);
  });

  it('does not close a client that was handed out again within the command timeout', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(START);
    await Promise.all(nodes.slice(0, POOL_LIMIT).map((node) => service.getNodeConnection(node.id, 'seed')));
    now.mockReturnValue(START + COMMAND_TIMEOUT_MS + 1);
    const first = await service.getNodeConnection(nodes[0].id, 'seed');

    await service.getNodeConnection(spare.id, 'seed');

    expect(first.status).toBe('ready');
    expect(service.getConnectionPoolSize()).toBe(POOL_LIMIT);
  });

  it('brings the pool back to the limit once the clients are older than the command timeout', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(START);
    await askAtTheSameTime();
    expect(service.getConnectionPoolSize()).toBe(NODE_COUNT);

    now.mockReturnValue(START + COMMAND_TIMEOUT_MS + 1);
    await service.getNodeConnection(spare.id, 'seed');

    expect(service.getConnectionPoolSize()).toBe(POOL_LIMIT);
    expect(openClients()).toBe(POOL_LIMIT);
  });

  it('gives the slot back when a connect fails', async () => {
    (Valkey as unknown as jest.Mock).mockImplementationOnce(() => ({
      status: 'end',
      connect: jest.fn().mockRejectedValue(new Error('refused')),
      quit: jest.fn(),
      disconnect: jest.fn(),
      on: jest.fn(),
    }));

    await expect(service.getNodeConnection(nodes[0].id, 'seed')).rejects.toThrow('refused');
    await Promise.all(nodes.slice(1, POOL_LIMIT + 1).map((node) => service.getNodeConnection(node.id, 'seed')));

    expect(service.getConnectionPoolSize()).toBe(POOL_LIMIT);
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('Closing oldest connection'));
  });

  it('warns about the limit once while callers keep hitting it', async () => {
    await askOneAfterAnother(jest.spyOn(Date, 'now'));

    const warnings = warn.mock.calls.filter(([message]) => String(message).includes('Connection limit reached'));
    expect(warnings).toHaveLength(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Closing oldest connection'));
  });

  it('warns again a minute later and says how many connections it closed', async () => {
    const now = jest.spyOn(Date, 'now');
    await askOneAfterAnother(now);

    now.mockReturnValue(START + NODE_COUNT * STEP_MS + 60_000);
    await service.getNodeConnection(nodes[0].id, 'seed');

    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining(`${NODE_COUNT - POOL_LIMIT} closed since the last warning`));
  });
});
