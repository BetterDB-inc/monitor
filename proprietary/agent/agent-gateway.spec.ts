jest.mock('../../apps/api/src/database/adapters/unified.adapter');

import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { AgentGateway } from './agent-gateway';
import { ConnectionRegistry } from '../../apps/api/src/connections/connection-registry.service';
import { ExternalMetricsStore } from '../../apps/api/src/external-metrics/external-metrics-store';
import { DiscoveredInstancesStore } from '../../apps/api/src/external-metrics/discovered-instances.store';

const TOKEN_ID = 'tok-1';
const CONNECTION_ID = `agent-${TOKEN_ID}`;

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<{ type: string }> = [];
  closes: Array<{ code?: number; reason?: string }> = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 2;
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
  const connect = async (): Promise<FakeSocket> => {
    const socket = new FakeSocket();
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
    const adapter = registry.get(CONNECTION_ID);

    oldSocket.emit('close');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(registry.isRegisteredClient(CONNECTION_ID, adapter)).toBe(true);
    expect(adapter.isConnected()).toBe(true);
    expect(gateway.getConnectedAgents()).toHaveLength(1);
    expect(newSocket.pings()).toBe(1);
    expect(oldSocket.pings()).toBe(0);
  });

  it('closes the old socket and stops its pings when a new hello arrives', async () => {
    const { connect } = build();
    const oldSocket = await connect();
    await connect();

    expect(oldSocket.closes).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(60_000);

    expect(oldSocket.closes).toHaveLength(1);
    expect(oldSocket.pings()).toBe(0);
  });

  it('ignores a pong timeout from the old socket after a reconnect', async () => {
    const { registry, connect } = build();
    const oldSocket = await connect();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(oldSocket.pings()).toBe(1);

    const newSocket = await connect();
    const adapter = registry.get(CONNECTION_ID);
    await jest.advanceTimersByTimeAsync(10_000);
    oldSocket.emit('close');

    expect(oldSocket.closes.some((c) => c.reason === 'Pong timeout')).toBe(false);
    expect(newSocket.closes).toHaveLength(0);
    expect(registry.isRegisteredClient(CONNECTION_ID, adapter)).toBe(true);
  });

  it('drops the old connection when the new one fails to register', async () => {
    const { registry, gateway, connect } = build();
    await connect();
    jest.spyOn(registry, 'registerAgentConnection').mockRejectedValueOnce(new Error('boom'));

    const newSocket = await connect();
    newSocket.emit('close');

    expect(newSocket.closes).toEqual([{ code: 4002, reason: 'Registration failed' }]);
    expect(registry.isListed(CONNECTION_ID)).toBe(false);
    expect(gateway.getConnectedAgents()).toHaveLength(0);
  });

  it('still unregisters the agent when its current socket closes', async () => {
    const { registry, gateway, connect } = build();
    const socket = await connect();

    socket.emit('close');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(registry.isListed(CONNECTION_ID)).toBe(false);
    expect(gateway.getConnectedAgents()).toHaveLength(0);
    expect(socket.pings()).toBe(0);
  });
});
