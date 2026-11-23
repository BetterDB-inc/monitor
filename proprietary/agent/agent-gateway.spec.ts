jest.mock('../../apps/api/src/database/adapters/unified.adapter');

import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { AgentGateway } from './agent-gateway';
import { ConnectionRegistry } from '../../apps/api/src/connections/connection-registry.service';
import { ExternalMetricsStore } from '../../apps/api/src/external-metrics/external-metrics-store';
import { DiscoveredInstancesStore } from '../../apps/api/src/external-metrics/discovered-instances.store';

const TOKEN_ID = 'tok-1';
const CONNECTION_ID = `agent-${TOKEN_ID}`;

const CHECK_MS = 5_000;

class FakeSocket extends EventEmitter {
  readyState = 1;
  terminated = false;
  sent: Array<{ type: string; ts?: number }> = [];
  closes: Array<{ code?: number; reason?: string }> = [];

  closesAfterPong = false;

  constructor(private readonly answersPings: boolean) {
    super();
  }

  send(payload: string): void {
    const msg = JSON.parse(payload);
    this.sent.push(msg);
    if (msg.type === 'ping' && this.answersPings) {
      void Promise.resolve().then(() => {
        this.emit('message', Buffer.from(JSON.stringify({ type: 'pong', ts: msg.ts })));
        if (this.closesAfterPong) this.readyState = 2;
      });
    }
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 2;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  drop(): void {
    this.readyState = 3;
    this.emit('close');
  }

  pings(): number {
    return this.sent.filter((m) => m.type === 'ping').length;
  }

  hello(): void {
    const hello = {
      type: 'agent_hello',
      version: '1.0.0',
      capabilities: [],
      valkey: { type: 'valkey', version: '8.0.0', tls: false, cluster: false },
    };
    this.emit('message', Buffer.from(JSON.stringify(hello)));
  }
}

function buildRegistry(): ConnectionRegistry {
  const storage = {
    saveConnection: jest.fn().mockResolvedValue(undefined),
    deleteConnection: jest.fn().mockResolvedValue(undefined),
    updateConnection: jest.fn().mockResolvedValue(undefined),
    getConnections: jest.fn().mockResolvedValue([]),
  };
  const tracker = {
    removeConnection: jest.fn(),
    getCapabilities: jest.fn().mockReturnValue(null),
  };
  return new ConnectionRegistry(
    storage as never,
    {} as never,
    tracker as never,
    {} as never,
    new ExternalMetricsStore(),
    undefined,
    new DiscoveredInstancesStore(true),
  );
}

function build() {
  const registry = buildRegistry();
  const gateway = new AgentGateway({} as never, registry);
  const connect = async (answersPings = false): Promise<FakeSocket> => {
    const socket = new FakeSocket(answersPings);
    (gateway as unknown as { onConnection: (ws: WebSocket, id: string, name: string) => void }).onConnection(
      socket as unknown as WebSocket,
      TOKEN_ID,
      'Agent',
    );
    socket.hello();
    await jest.advanceTimersByTimeAsync(0);
    return socket;
  };
  return { registry, gateway, connect };
}

describe('AgentGateway reconnects', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the new connection registered and pinged when the old socket closes late', async () => {
    const { registry, gateway, connect } = build();
    const oldSocket = await connect();
    const newSocket = await connect();
    await jest.advanceTimersByTimeAsync(CHECK_MS);
    const adapter = registry.get(CONNECTION_ID);

    oldSocket.drop();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(30_000);

    expect(registry.isRegisteredClient(CONNECTION_ID, adapter)).toBe(true);
    expect(adapter.isConnected()).toBe(true);
    expect(gateway.getConnectedAgents()).toHaveLength(1);
    expect(newSocket.pings()).toBe(1);
    expect(oldSocket.pings()).toBe(1);
  });

  it('replaces the old socket when it does not answer the check', async () => {
    const { registry, connect } = build();
    const oldSocket = await connect();
    const oldAdapter = registry.get(CONNECTION_ID);
    await connect();

    await jest.advanceTimersByTimeAsync(CHECK_MS - 1);
    expect(oldSocket.pings()).toBe(1);
    expect(oldSocket.terminated).toBe(false);
    expect(registry.isRegisteredClient(CONNECTION_ID, oldAdapter)).toBe(true);

    await jest.advanceTimersByTimeAsync(1);
    expect(oldSocket.closes).toHaveLength(1);
    expect(oldSocket.terminated).toBe(true);
    expect(registry.isRegisteredClient(CONNECTION_ID, oldAdapter)).toBe(false);
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(oldSocket.pings()).toBe(1);
  });

  it('keeps a live agent and turns away a second one on the same token', async () => {
    const { registry, gateway, connect } = build();
    const oldSocket = await connect(true);
    const oldAdapter = registry.get(CONNECTION_ID);
    const newSocket = await connect(true);

    await jest.advanceTimersByTimeAsync(CHECK_MS);
    newSocket.drop();

    expect(newSocket.closes).toEqual([{ code: 4003, reason: expect.any(String) }]);
    expect(oldSocket.closes).toHaveLength(0);
    expect(oldSocket.terminated).toBe(false);
    expect(registry.isRegisteredClient(CONNECTION_ID, oldAdapter)).toBe(true);
    expect(oldAdapter.isConnected()).toBe(true);
    expect(gateway.getConnectedAgents()).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('replaces an agent that answers the check but is already closing', async () => {
    const { registry, gateway, connect } = build();
    const oldSocket = await connect(true);
    const oldAdapter = registry.get(CONNECTION_ID);
    oldSocket.closesAfterPong = true;
    const newSocket = await connect(true);

    await jest.advanceTimersByTimeAsync(0);
    oldSocket.drop();

    expect(newSocket.closes).toHaveLength(0);
    expect(oldSocket.terminated).toBe(true);
    expect(registry.isListed(CONNECTION_ID)).toBe(true);
    expect(registry.isRegisteredClient(CONNECTION_ID, oldAdapter)).toBe(false);
    expect(gateway.getConnectedAgents()).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('registers the new connection at once when the old socket closes during the check', async () => {
    const { registry, gateway, connect } = build();
    const oldSocket = await connect();
    const oldAdapter = registry.get(CONNECTION_ID);
    await connect();

    await jest.advanceTimersByTimeAsync(1_000);
    oldSocket.drop();
    await jest.advanceTimersByTimeAsync(0);

    expect(registry.isListed(CONNECTION_ID)).toBe(true);
    expect(registry.isRegisteredClient(CONNECTION_ID, oldAdapter)).toBe(false);
    expect(gateway.getConnectedAgents()).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('leaves the old connection alone when the new socket closes during the check', async () => {
    const { registry, gateway, connect } = build();
    await connect();
    const oldAdapter = registry.get(CONNECTION_ID);
    const newSocket = await connect();

    await jest.advanceTimersByTimeAsync(1_000);
    newSocket.drop();
    await jest.advanceTimersByTimeAsync(CHECK_MS);

    expect(registry.isRegisteredClient(CONNECTION_ID, oldAdapter)).toBe(true);
    expect(gateway.getConnectedAgents()).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('checks the newest agent when a third hello arrives during a check', async () => {
    const { registry, connect } = build();
    const oldSocket = await connect();
    const second = await connect(true);
    await jest.advanceTimersByTimeAsync(1_000);
    const third = await connect(true);

    await jest.advanceTimersByTimeAsync(CHECK_MS);

    expect(oldSocket.terminated).toBe(true);
    expect(second.closes).toHaveLength(0);
    expect(third.closes).toEqual([{ code: 4003, reason: expect.any(String) }]);
    expect(registry.isListed(CONNECTION_ID)).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
  });

  describe('when registering takes a while', () => {
    function slowRegistration(registry: ConnectionRegistry): void {
      const register = registry.registerAgentConnection.bind(registry);
      jest.spyOn(registry, 'registerAgentConnection').mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return register(...args);
      });
    }

    it('registers one of two newcomers that replace a silent agent and turns the other away', async () => {
      const { registry, gateway, connect } = build();
      await connect();
      slowRegistration(registry);
      const second = await connect(true);
      await jest.advanceTimersByTimeAsync(1_000);
      const third = await connect(true);

      await jest.advanceTimersByTimeAsync(20_000);

      expect(second.closes).toHaveLength(0);
      expect(third.closes).toEqual([{ code: 4003, reason: expect.any(String) }]);
      expect(gateway.getConnectedAgents()).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(1);
    });

    it('registers one of two agents that connect together and turns the other away', async () => {
      const { registry, gateway, connect } = build();
      slowRegistration(registry);
      const first = await connect(true);
      await jest.advanceTimersByTimeAsync(100);
      const second = await connect(true);

      await jest.advanceTimersByTimeAsync(20_000);

      expect(first.closes).toHaveLength(0);
      expect(second.closes).toEqual([{ code: 4003, reason: expect.any(String) }]);
      expect(gateway.getConnectedAgents()).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(1);
    });

    it('does not hold up the next newcomer when one closes during its check', async () => {
      const { registry, gateway, connect } = build();
      const oldSocket = await connect();
      slowRegistration(registry);
      const second = await connect(true);
      await jest.advanceTimersByTimeAsync(100);
      const third = await connect(true);
      await jest.advanceTimersByTimeAsync(900);
      second.drop();

      await jest.advanceTimersByTimeAsync(CHECK_MS + 2_000);

      expect(oldSocket.terminated).toBe(true);
      expect(third.closes).toHaveLength(0);
      expect(gateway.getConnectedAgents()).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(1);
    });

    it('skips a newcomer that closed while it waited its turn', async () => {
      const { registry, gateway, connect } = build();
      await connect();
      slowRegistration(registry);
      const second = await connect();
      await jest.advanceTimersByTimeAsync(100);
      const third = await connect();
      await jest.advanceTimersByTimeAsync(100);
      const fourth = await connect();
      await jest.advanceTimersByTimeAsync(100);
      third.drop();

      await jest.advanceTimersByTimeAsync(13_800);

      expect(second.terminated).toBe(true);
      expect(fourth.closes).toHaveLength(0);
      expect(gateway.getConnectedAgents()).toHaveLength(1);
    });
  });

  it('ignores a pong timeout from the old socket after a reconnect', async () => {
    const { registry, connect } = build();
    const oldSocket = await connect();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(oldSocket.pings()).toBe(1);
    expect(jest.getTimerCount()).toBe(2);

    const newSocket = await connect();
    await jest.advanceTimersByTimeAsync(CHECK_MS);
    const adapter = registry.get(CONNECTION_ID);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(10_000);
    oldSocket.drop();

    expect(oldSocket.closes.some((c) => c.reason === 'Pong timeout')).toBe(false);
    expect(newSocket.closes).toHaveLength(0);
    expect(registry.isRegisteredClient(CONNECTION_ID, adapter)).toBe(true);
  });

  it('drops the old connection when the new one fails to register', async () => {
    const { registry, gateway, connect } = build();
    await connect();
    jest.spyOn(registry, 'registerAgentConnection').mockRejectedValueOnce(new Error('boom'));

    const newSocket = await connect();
    await jest.advanceTimersByTimeAsync(CHECK_MS);
    newSocket.drop();

    expect(newSocket.closes).toEqual([{ code: 4002, reason: 'Registration failed' }]);
    expect(registry.isListed(CONNECTION_ID)).toBe(false);
    expect(gateway.getConnectedAgents()).toHaveLength(0);
  });

  it('still unregisters the agent when its current socket closes', async () => {
    const { registry, gateway, connect } = build();
    const socket = await connect();

    socket.drop();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(registry.isListed(CONNECTION_ID)).toBe(false);
    expect(gateway.getConnectedAgents()).toHaveLength(0);
    expect(socket.pings()).toBe(0);
  });
});
