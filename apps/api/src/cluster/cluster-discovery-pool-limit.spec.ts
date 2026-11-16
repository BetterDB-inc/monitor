import { Test } from '@nestjs/testing';
import Valkey from 'iovalkey';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

jest.mock('iovalkey', () => {
  return jest.fn().mockImplementation(() => {
    const client = {
      status: 'ready',
      connect: jest.fn().mockResolvedValue(undefined),
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

  const openClients = (): number =>
    (Valkey as unknown as jest.Mock).mock.results.filter((result) => result.value.status === 'ready').length;

  beforeEach(async () => {
    (Valkey as unknown as jest.Mock).mockClear();
    const adapter = {
      getClusterNodes: jest.fn().mockResolvedValue(nodes),
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
    await service.disconnectAll();
  });

  it('keeps the pool at the limit when callers ask one after another', async () => {
    for (const node of nodes) await service.getNodeConnection(node.id, 'seed');

    expect(service.getConnectionPoolSize()).toBeLessThanOrEqual(POOL_LIMIT);
    expect(openClients()).toBeLessThanOrEqual(POOL_LIMIT);
  });

  it('keeps the pool at the limit when callers ask at the same time', async () => {
    await Promise.all(nodes.map((node) => service.getNodeConnection(node.id, 'seed')));

    expect(service.getConnectionPoolSize()).toBeLessThanOrEqual(POOL_LIMIT);
    expect(openClients()).toBeLessThanOrEqual(POOL_LIMIT);
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
    for (const node of nodes) await service.getNodeConnection(node.id, 'seed');

    const warnings = warn.mock.calls.filter(([message]) => String(message).includes('Connection limit reached'));
    expect(warnings).toHaveLength(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Closing oldest connection'));
  });

  it('warns again a minute later and says how many connections it closed', async () => {
    const now = jest.spyOn(Date, 'now');
    const start = 1_000_000;
    now.mockReturnValue(start);
    for (const node of nodes) await service.getNodeConnection(node.id, 'seed');

    now.mockReturnValue(start + 60_000);
    await service.getNodeConnection(nodes[0].id, 'seed');
    now.mockRestore();

    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining(`${NODE_COUNT - POOL_LIMIT} closed since the last warning`));
  });
});
