import type { SshTunnelConfig } from '@betterdb/shared';

// Capture the options every `new Valkey(...)` is constructed with, plus the
// instances themselves (so tests can drive their event handlers).
const valkeyConstructorCalls: Array<Record<string, unknown>> = [];
interface MockValkey {
  options: Record<string, unknown>;
  status: string;
  handlers: Record<string, (arg?: unknown) => void>;
  on: jest.Mock;
  connect: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
}
const valkeyInstances: MockValkey[] = [];
jest.mock('iovalkey', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation((opts: Record<string, unknown>) => {
      valkeyConstructorCalls.push(opts);
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const instance: MockValkey = {
        options: opts,
        status: 'wait',
        handlers,
        on: jest.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event] = cb;
        }),
        connect: jest.fn(() => Promise.resolve()),
        quit: jest.fn(() => Promise.resolve()),
        disconnect: jest.fn(),
      };
      valkeyInstances.push(instance);
      return instance;
    }),
  };
});

import { UnifiedDatabaseAdapter } from '../unified.adapter';

type TunnelHarness = {
  establishTunnel: () => Promise<void>;
  teardownTunnel: () => Promise<void>;
  handleTunnelDropped: () => void;
  initClient: () => void;
  connectHost: string;
  connectPort: number;
  tunnelActive: boolean;
  connected: boolean;
  _client: unknown;
  cliClient: unknown;
};

function makeTunnelConfig(overrides: Partial<SshTunnelConfig> = {}): SshTunnelConfig {
  return {
    enabled: true,
    host: 'bastion.example.com',
    port: 22,
    username: 'ec2-user',
    authMethod: 'privateKey',
    keySource: 'inline',
    privateKey: '-----BEGIN KEY-----',
    ...overrides,
  };
}

describe('UnifiedDatabaseAdapter — SSH tunnel wiring', () => {
  beforeEach(() => {
    valkeyConstructorCalls.length = 0;
    valkeyInstances.length = 0;
  });

  it('routes the client through the tunnel local port while keeping TLS servername as the real host', async () => {
    const createTunnel = jest.fn().mockResolvedValue(54321);
    const sshTunnelService = { createTunnel, closeTunnel: jest.fn(), hasTunnel: jest.fn() };

    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.internal',
      port: 6379,
      username: 'default',
      password: 'pw',
      tls: true,
      connectionId: 'conn-1',
      sshTunnel: makeTunnelConfig({ hostKeyFingerprint: 'SHA256:abc' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sshTunnelService: sshTunnelService as any,
    });

    // With a tunnel configured, the client is NOT built in the constructor.
    expect(valkeyConstructorCalls).toHaveLength(0);

    const harness = adapter as unknown as TunnelHarness;
    await harness.establishTunnel();
    harness.initClient();

    // The tunnel is keyed per-adapter (connectionId + uuid), not the bare
    // connectionId, so old/new adapters during reconnect never collide.
    const [tunnelKey, params] = createTunnel.mock.calls[0];
    expect(tunnelKey).toMatch(/^conn-1:/);
    expect(tunnelKey).not.toBe('conn-1');
    expect(params).toMatchObject({
      remoteHost: 'db.internal',
      remotePort: 6379,
      sshHost: 'bastion.example.com',
      hostKeyFingerprint: 'SHA256:abc',
    });

    // The Valkey client dials the local tunnel port, not the real host...
    expect(harness.connectHost).toBe('127.0.0.1');
    expect(harness.connectPort).toBe(54321);
    const opts = valkeyConstructorCalls[0];
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.port).toBe(54321);
    // ...but TLS still validates against the real hostname.
    expect(opts.tls).toEqual({ servername: 'db.internal' });
  });

  it('discards the stale client and resets the target on tunnel teardown', async () => {
    const createTunnel = jest.fn().mockResolvedValue(54321);
    const closeTunnel = jest.fn().mockResolvedValue(undefined);
    const sshTunnelService = { createTunnel, closeTunnel, hasTunnel: jest.fn() };

    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.internal',
      port: 6379,
      username: 'default',
      password: 'pw',
      connectionId: 'conn-2',
      sshTunnel: makeTunnelConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sshTunnelService: sshTunnelService as any,
    });

    const harness = adapter as unknown as TunnelHarness;
    await harness.establishTunnel();
    harness.initClient();
    expect(harness.connectPort).toBe(54321);

    await harness.teardownTunnel();

    // The tunnel is closed with the same per-adapter key.
    expect(closeTunnel).toHaveBeenCalledWith(createTunnel.mock.calls[0][0]);
    // The client bound to the now-dead local port is discarded, and the target
    // is restored so the next connect() rebuilds against a fresh tunnel.
    expect(harness._client).toBeNull();
    expect(harness.tunnelActive).toBe(false);
    expect(harness.connectHost).toBe('db.internal');
    expect(harness.connectPort).toBe(6379);
  });

  it('builds the client eagerly (no tunnel) when sshTunnel is not enabled', () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.internal',
      port: 6379,
      username: 'default',
      password: 'pw',
    });
    expect(adapter).toBeDefined();
    expect(valkeyConstructorCalls).toHaveLength(1);
    expect(valkeyConstructorCalls[0].host).toBe('db.internal');
    expect(valkeyConstructorCalls[0].port).toBe(6379);
  });

  it('throws if a tunnel is configured without a tunnel service', () => {
    expect(
      () =>
        new UnifiedDatabaseAdapter({
          host: 'db.internal',
          port: 6379,
          username: 'default',
          password: 'pw',
          sshTunnel: makeTunnelConfig(),
        }),
    ).toThrow(/sshTunnelService is required/);
  });

  it('discards the CLI client too when the tunnel drops (A)', async () => {
    const sshTunnelService = {
      createTunnel: jest.fn().mockResolvedValue(54321),
      closeTunnel: jest.fn(),
      hasTunnel: jest.fn(),
    };
    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.internal',
      port: 6379,
      username: 'default',
      password: 'pw',
      connectionId: 'conn-a',
      sshTunnel: makeTunnelConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sshTunnelService: sshTunnelService as any,
    });
    const harness = adapter as unknown as TunnelHarness;
    await harness.establishTunnel();
    harness.initClient();

    // Simulate a CLI client that rode the same tunnel.
    const cli = { disconnect: jest.fn() };
    harness.cliClient = cli;

    harness.handleTunnelDropped();

    expect(cli.disconnect).toHaveBeenCalled();
    expect(harness.cliClient).toBeNull();
    expect(harness._client).toBeNull();
  });

  it('refuses to build a CLI client while the tunnel is down (A)', async () => {
    const sshTunnelService = {
      createTunnel: jest.fn().mockResolvedValue(54321),
      closeTunnel: jest.fn(),
      hasTunnel: jest.fn(),
    };
    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.internal',
      port: 6379,
      username: 'default',
      password: 'pw',
      connectionId: 'conn-a2',
      sshTunnel: makeTunnelConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sshTunnelService: sshTunnelService as any,
    });
    const harness = adapter as unknown as TunnelHarness;
    await harness.establishTunnel();
    harness.initClient();
    harness.handleTunnelDropped();

    // A CLI call after the drop must not dial the real host directly.
    await expect(adapter.call('PING', [], { cli: true })).rejects.toThrow(
      /SSH tunnel is not established/,
    );
  });

  it('a discarded client\'s late close does not flip a healthy connection down (C)', () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.internal',
      port: 6379,
      username: 'default',
      password: 'pw',
    });
    const harness = adapter as unknown as TunnelHarness;

    // First client built in the constructor.
    const first = valkeyInstances[0];
    // Rebuild the client (as reconnect would): a second instance becomes current.
    harness.initClient();
    const second = valkeyInstances[1];
    expect(second).not.toBe(first);

    // The new client connects — healthy.
    second.handlers['connect']?.();
    harness.connected = true;

    // The discarded first client emits a late 'close'. It must NOT touch state.
    first.handlers['close']?.();
    expect(harness.connected).toBe(true);

    // The current client's close still works.
    second.handlers['close']?.();
    expect(harness.connected).toBe(false);
  });
});
