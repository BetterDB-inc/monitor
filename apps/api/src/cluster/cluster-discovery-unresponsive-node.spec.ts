import { Test } from '@nestjs/testing';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

interface FakeCommand {
  promise: Promise<unknown>;
}

interface FakeClient {
  status: string;
  options: { host: string; port: number };
  connect: jest.Mock;
  disconnect: jest.Mock;
  sendCommand(command: FakeCommand): unknown;
}

const created: FakeClient[] = [];
let nextConnect: (() => Promise<void>) | undefined;

jest.mock('iovalkey', () => {
  return class FakeValkey {
    status = 'ready';
    options: { host: string; port: number };
    connect: jest.Mock;
    quit = jest.fn().mockImplementation(async () => {
      this.status = 'end';
    });
    disconnect = jest.fn().mockImplementation(() => {
      this.status = 'end';
    });
    on = jest.fn();

    constructor(options: { host: string; port: number }) {
      this.options = options;
      const connect = nextConnect ?? (() => Promise.resolve());
      nextConnect = undefined;
      this.connect = jest.fn().mockImplementation(connect);
      created.push(this as unknown as FakeClient);
    }

    sendCommand(command: FakeCommand): unknown {
      return command.promise;
    }
  };
});

const COOL_OFF_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;

const answered = (): FakeCommand => ({ promise: Promise.resolve('OK') });
const timedOut = (): FakeCommand => ({ promise: Promise.reject(new Error('Command timed out')) });
const refusedReply = (): FakeCommand => ({ promise: Promise.reject(new Error('ERR unknown command')) });

describe('ClusterDiscoveryService unresponsive node', () => {
  let service: ClusterDiscoveryService;
  let warn: jest.SpyInstance;

  const nodes = ['10.0.0.1:6379', '10.0.0.2:6379', '10.0.0.3:6379'].map((address, index) => ({
    id: `node-${index}`,
    address,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 1,
    configEpoch: index + 1,
    linkState: 'connected',
    slots: [[index, index]],
  }));
  const silent = nodes[0];
  const healthy = nodes[1];

  const send = async (client: unknown, command: FakeCommand): Promise<void> => {
    await Promise.resolve((client as FakeClient).sendCommand(command)).catch(() => undefined);
    await Promise.resolve();
  };

  const silence = async (): Promise<FakeClient> => {
    const client = (await service.getNodeConnection(silent.id, 'seed')) as unknown as FakeClient;
    await send(client, timedOut());
    return client;
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    created.length = 0;
    nextConnect = undefined;
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
      sentinelDataNodeCredentials: jest.fn().mockReturnValue({ username: '', password: '' }),
      list: jest.fn().mockReturnValue([]),
    };
    const module = await Test.createTestingModule({
      providers: [ClusterDiscoveryService, { provide: ConnectionRegistry, useValue: registry }],
    }).compile();
    service = module.get(ClusterDiscoveryService);
    const logger = (service as unknown as { logger: Record<'warn' | 'log' | 'debug', () => void> }).logger;
    warn = jest.spyOn(logger, 'warn').mockImplementation();
    jest.spyOn(logger, 'log').mockImplementation();
    jest.spyOn(logger, 'debug').mockImplementation();
  });

  afterEach(async () => {
    await service.disconnectAll();
    jest.useRealTimers();
  });

  it('refuses a node at once after one of its commands timed out', async () => {
    await silence();

    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('10.0.0.1:6379 is not answering');
    expect(created).toHaveLength(1);
  });

  it('closes the client whose command timed out and drops it from the pool', async () => {
    const client = await silence();

    expect(client.disconnect).toHaveBeenCalled();
    expect(service.getConnectionPoolSize()).toBe(0);
  });

  it('says once that the node stopped answering', async () => {
    const client = (await service.getNodeConnection(silent.id, 'seed')) as unknown as FakeClient;

    await send(client, timedOut());
    await send(client, timedOut());

    const said = warn.mock.calls.filter(([message]) => String(message).includes('10.0.0.1:6379 is not answering'));
    expect(said).toHaveLength(1);
  });

  it('keeps serving the other nodes', async () => {
    await silence();

    const client = await service.getNodeConnection(healthy.id, 'seed');

    expect(client).toBe(created[1]);
  });

  it('refuses the same address through the address and replica getters', async () => {
    await silence();

    await expect(service.getAddressConnection('10.0.0.1', 6379, 'seed')).rejects.toThrow('is not answering');
    await expect(service.getReplicaConnection('10.0.0.1', 6379, 'seed')).rejects.toThrow('is not answering');
    expect(created).toHaveLength(1);
  });

  it('does not hold a reply error against the node', async () => {
    const client = await service.getNodeConnection(silent.id, 'seed');

    await send(client, refusedReply());

    await expect(service.getNodeConnection(silent.id, 'seed')).resolves.toBe(client);
  });

  it('refuses a node whose connect timed out', async () => {
    nextConnect = () => new Promise<void>(() => undefined);
    const connecting = service.getNodeConnection(silent.id, 'seed');
    const failed = expect(connecting).rejects.toThrow('Connection timeout');
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await failed;

    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
    expect(created).toHaveLength(1);
  });

  it('does not hold a refused connect against the node', async () => {
    nextConnect = () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:6379'));
    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('ECONNREFUSED');

    const client = await service.getNodeConnection(silent.id, 'seed');

    expect(client).toBe(created[1]);
  });

  it('lets one caller try again after the cool-off and keeps refusing the rest', async () => {
    await silence();
    await jest.advanceTimersByTimeAsync(COOL_OFF_MS);
    nextConnect = () => new Promise<void>(() => undefined);

    const probe = service.getNodeConnection(silent.id, 'seed');
    const probeFailed = expect(probe).rejects.toThrow('Connection timeout');

    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
    expect(created).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await probeFailed;
  });

  it('serves the node again once the retry connects', async () => {
    await silence();
    await jest.advanceTimersByTimeAsync(COOL_OFF_MS);

    const probe = await service.getNodeConnection(silent.id, 'seed');

    await expect(service.getNodeConnection(silent.id, 'seed')).resolves.toBe(probe);
  });

  it('refuses for another cool-off when a command on the retry times out too', async () => {
    await silence();
    await jest.advanceTimersByTimeAsync(COOL_OFF_MS);
    const probe = await service.getNodeConnection(silent.id, 'seed');

    await send(probe, timedOut());
    await jest.advanceTimersByTimeAsync(COOL_OFF_MS - 1);

    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
  });

  it('serves the node again once a held client gets a reply', async () => {
    const first = await service.getNodeConnection(silent.id, 'seed');
    const second = await service.getAddressConnection('10.0.0.1', 6379, 'seed');
    await send(first, timedOut());

    await send(second, answered());

    await expect(service.getAddressConnection('10.0.0.1', 6379, 'seed')).resolves.toBe(second);
  });
});
