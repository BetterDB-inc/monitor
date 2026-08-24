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
      };
    }),
  };
});

import { UnifiedDatabaseAdapter } from '../unified.adapter';

type TunnelHarness = {
  establishTunnel: () => Promise<void>;
  initClient: () => void;
  connectHost: string;
  connectPort: number;
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
      sshTunnel: makeTunnelConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sshTunnelService: sshTunnelService as any,
    });

    // With a tunnel configured, the client is NOT built in the constructor.
    expect(valkeyConstructorCalls).toHaveLength(0);

    const harness = adapter as unknown as TunnelHarness;
    await harness.establishTunnel();
    harness.initClient();

    // The tunnel was opened with the real database as the forward target.
    expect(createTunnel).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ remoteHost: 'db.internal', remotePort: 6379, sshHost: 'bastion.example.com' }),
    );

    // The Valkey client dials the local tunnel port, not the real host...
    expect(harness.connectHost).toBe('127.0.0.1');
    expect(harness.connectPort).toBe(54321);
    const opts = valkeyConstructorCalls[0];
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.port).toBe(54321);
    // ...but TLS still validates against the real hostname.
    expect(opts.tls).toEqual({ servername: 'db.internal' });
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
