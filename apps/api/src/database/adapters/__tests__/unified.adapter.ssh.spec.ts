import type { SshTunnelConfig } from '@betterdb/shared';

// Capture the options every `new Valkey(...)` is constructed with.
const valkeyConstructorCalls: Array<Record<string, unknown>> = [];
jest.mock('iovalkey', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation((opts: Record<string, unknown>) => {
      valkeyConstructorCalls.push(opts);
      return {
        options: opts,
        status: 'wait',
        on: jest.fn(),
        connect: jest.fn(() => Promise.resolve()),
        quit: jest.fn(() => Promise.resolve()),
        disconnect: jest.fn(),
      };
    }),
  };
});

import { UnifiedDatabaseAdapter } from '../unified.adapter';

type TunnelHarness = {
  establishTunnel: () => Promise<void>;
  teardownTunnel: () => Promise<void>;
  initClient: () => void;
  connectHost: string;
  connectPort: number;
  tunnelActive: boolean;
  _client: unknown;
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
});
