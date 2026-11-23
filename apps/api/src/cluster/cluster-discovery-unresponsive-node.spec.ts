import { Test } from '@nestjs/testing';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

interface FakeCommand {
  name?: string;
  promise: Promise<unknown>;
}

interface FakeClient {
  status: string;
  options: { host: string; port: number };
  connect: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
  sendCommand(command: FakeCommand): unknown;
}

const created: FakeClient[] = [];
let nextConnect: (() => Promise<void>) | undefined;
let nextPing: (() => FakeCommand) | undefined;

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

    ping(): unknown {
      const command = nextPing ? nextPing() : { name: 'ping', promise: Promise.resolve('PONG') };
      nextPing = undefined;
      return this.sendCommand(command);
    }
  };
});

const COOL_OFF_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 5_000;
const MARK_LIMIT = 512;

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
    nextPing = undefined;
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

  it('does not hold a QUIT without a reply against the node', async () => {
    const client = (await service.getNodeConnection(silent.id, 'seed')) as unknown as FakeClient;
    client.quit.mockImplementation(() =>
      client.sendCommand({ name: 'quit', promise: Promise.reject(new Error('Command timed out')) }),
    );

    await service.releaseConnection('seed');
    const next = await service.getNodeConnection(silent.id, 'seed');

    expect(next).toBe(created[1]);
    expect(client.status).toBe('end');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is not answering'));
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

  it('refuses a node whose connect ran into the socket connect timeout', async () => {
    nextConnect = () => Promise.reject(new Error('connect ETIMEDOUT'));
    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('ETIMEDOUT');

    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
    expect(created).toHaveLength(1);
  });

  it('tries the node again in the background after the cool-off without making a caller wait', async () => {
    await silence();
    await jest.advanceTimersByTimeAsync(COOL_OFF_MS);
    nextConnect = () => new Promise<void>(() => undefined);

    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');

    expect(created).toHaveLength(2);
  });

  it('serves the node again once the retry connects', async () => {
    await silence();
    await jest.advanceTimersByTimeAsync(COOL_OFF_MS);
    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
    await jest.advanceTimersByTimeAsync(0);

    const client = await service.getNodeConnection(silent.id, 'seed');

    expect(client).toBe(created[1]);
  });

  it('waits another cool-off before the next retry when the retry timed out', async () => {
    await silence();
    await jest.advanceTimersByTimeAsync(COOL_OFF_MS);
    nextConnect = () => new Promise<void>(() => undefined);
    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);

    await jest.advanceTimersByTimeAsync(COOL_OFF_MS - 1);
    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
    expect(created).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(1);
    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
    await jest.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(3);
  });

  it('shows callers the real error again when the retry is refused', async () => {
    await silence();
    await jest.advanceTimersByTimeAsync(COOL_OFF_MS);
    nextConnect = () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:6379'));
    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
    await jest.advanceTimersByTimeAsync(0);

    nextConnect = () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:6379'));
    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('ECONNREFUSED');
  });

  it('serves the node again once a held client gets a reply', async () => {
    const first = await service.getNodeConnection(silent.id, 'seed');
    const second = await service.getAddressConnection('10.0.0.1', 6379, 'seed');
    await send(first, timedOut());

    await send(second, answered());

    await expect(service.getAddressConnection('10.0.0.1', 6379, 'seed')).resolves.toBe(second);
  });

  it('still refuses a silent node after another node timed out much later', async () => {
    await silence();
    await jest.advanceTimersByTimeAsync(2 * COOL_OFF_MS + 1_000);
    const other = await service.getNodeConnection(healthy.id, 'seed');

    await send(other, timedOut());

    await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('10.0.0.1:6379 is not answering');
  });

  it('forgets the node with the oldest retry time once more than 512 are marked', async () => {
    const hostOf = (index: number): string => `10.1.${Math.floor(index / 256)}.${index % 256}`;
    const silenceAddress = async (index: number): Promise<void> => {
      const client = await service.getAddressConnection(hostOf(index), 6379, 'seed');
      await send(client, timedOut());
      jest.advanceTimersByTime(1);
    };
    const held = await service.getReplicaConnection(hostOf(0), 6379, 'seed');
    for (let index = 0; index < MARK_LIMIT; index++) await silenceAddress(index);
    await send(held, timedOut());

    await silenceAddress(MARK_LIMIT);

    await expect(service.getAddressConnection(hostOf(0), 6379, 'seed')).rejects.toThrow('is not answering');
    await expect(service.getAddressConnection(hostOf(1), 6379, 'seed')).resolves.toBeDefined();
    await expect(service.getAddressConnection(hostOf(2), 6379, 'seed')).rejects.toThrow('is not answering');
  });

  describe('when another connection still holds a client for the node', () => {
    const holdAndSilence = async (): Promise<FakeClient> => {
      const first = await service.getNodeConnection(silent.id, 'seed');
      const held = (await service.getNodeConnection(silent.id, 'other')) as unknown as FakeClient;
      await send(first, timedOut());
      await jest.advanceTimersByTimeAsync(COOL_OFF_MS);
      return held;
    };

    it('asks the held client after the cool-off instead of opening one that replaces it', async () => {
      const held = await holdAndSilence();

      await expect(service.getNodeConnection(silent.id, 'other')).rejects.toThrow('is not answering');
      await jest.advanceTimersByTimeAsync(0);

      expect(held.status).toBe('ready');
      expect(created).toHaveLength(2);
      await expect(service.getNodeConnection(silent.id, 'other')).resolves.toBe(held);
    });

    it('closes the held client and keeps refusing the node when it does not answer either', async () => {
      const held = await holdAndSilence();
      nextPing = () => ({
        name: 'ping',
        promise: new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Command timed out')), COMMAND_TIMEOUT_MS),
        ),
      });

      await expect(service.getNodeConnection(silent.id, 'other')).rejects.toThrow('is not answering');
      await jest.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);

      expect(held.disconnect).toHaveBeenCalled();
      await expect(service.getNodeConnection(silent.id, 'other')).rejects.toThrow('is not answering');
      expect(created).toHaveLength(2);
    });
  });

  describe('when a client connects after its connection is gone', () => {
    let connected: () => void;

    const holdNextConnect = (): void => {
      nextConnect = () =>
        new Promise<void>((resolve) => {
          connected = resolve;
        });
    };

    it('closes a background retry that connected after its connection was released', async () => {
      await silence();
      await jest.advanceTimersByTimeAsync(COOL_OFF_MS);
      holdNextConnect();
      await expect(service.getNodeConnection(silent.id, 'seed')).rejects.toThrow('is not answering');
      await jest.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(2);

      await service.releaseConnection('seed');
      connected();
      await jest.advanceTimersByTimeAsync(0);

      expect(service.getConnectionPoolSize()).toBe(0);
      expect(created[1].status).toBe('end');
    });

    it('refuses a caller whose client connected after its connection was released', async () => {
      holdNextConnect();
      const connecting = service.getNodeConnection(healthy.id, 'seed');
      const failed = expect(connecting).rejects.toThrow('was released while it was opening');
      await jest.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(1);

      await service.releaseConnection('seed');
      connected();
      await failed;

      expect(service.getConnectionPoolSize()).toBe(0);
      expect(created[0].status).toBe('end');
    });

    it('closes a client that connected after the service shut down', async () => {
      holdNextConnect();
      const connecting = service.getNodeConnection(healthy.id, 'seed');
      const failed = expect(connecting).rejects.toThrow('was released while it was opening');
      await jest.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(1);

      await service.disconnectAll();
      connected();
      await failed;

      expect(service.getConnectionPoolSize()).toBe(0);
      expect(created[0].status).toBe('end');
    });

    it('leaves the client of a connection that was added again alone when an older connect ends late', async () => {
      holdNextConnect();
      const stale = service.getNodeConnection(healthy.id, 'seed');
      const failed = expect(stale).rejects.toThrow('was released while it was opening');
      await jest.advanceTimersByTimeAsync(0);
      const finishStale = connected;
      await service.releaseConnection('seed');
      const fresh = await service.getNodeConnection(healthy.id, 'seed');

      finishStale();
      await failed;

      expect(created[1].status).toBe('ready');
      expect(created[0].status).toBe('end');
      await expect(service.getNodeConnection(healthy.id, 'seed')).resolves.toBe(fresh);
      expect(service.getConnectionPoolSize()).toBe(1);
    });

    it('keeps serving the node when the connect of a released connection times out after a new one connected', async () => {
      nextConnect = () => new Promise<void>(() => undefined);
      const stale = service.getNodeConnection(healthy.id, 'seed');
      const failed = expect(stale).rejects.toThrow('Connection timeout');
      await jest.advanceTimersByTimeAsync(0);
      await service.releaseConnection('seed');
      const fresh = await service.getNodeConnection(healthy.id, 'seed');

      await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
      await failed;

      await expect(service.getNodeConnection(healthy.id, 'seed')).resolves.toBe(fresh);
      expect(created[0].status).toBe('end');
    });

    it('does not store a client whose connection was released while it closed the client it replaces', async () => {
      holdNextConnect();
      const first = service.getNodeConnection(healthy.id, 'seed');
      await jest.advanceTimersByTimeAsync(0);
      const finishFirst = connected;
      holdNextConnect();
      const second = service.getNodeConnection(healthy.id, 'seed');
      const failed = expect(second).rejects.toThrow('was released while it was opening');
      await jest.advanceTimersByTimeAsync(0);
      const finishSecond = connected;
      finishFirst();
      await first;
      let closed: () => void = () => undefined;
      const closing = new Promise<void>((resolve) => {
        closed = resolve;
      });
      created[0].quit.mockImplementation(() => closing);
      finishSecond();
      await jest.advanceTimersByTimeAsync(0);

      const releasing = service.releaseConnection('seed');
      closed();
      await releasing;
      await failed;

      expect(service.getConnectionPoolSize()).toBe(0);
      expect(created[1].status).toBe('end');
    });

    it('keeps a client of another connection that was not released', async () => {
      holdNextConnect();
      const connecting = service.getNodeConnection(healthy.id, 'seed');
      await jest.advanceTimersByTimeAsync(0);

      await service.releaseConnection('other');
      connected();

      await expect(connecting).resolves.toBe(created[0]);
      expect(service.getConnectionPoolSize()).toBe(1);
    });
  });
});
