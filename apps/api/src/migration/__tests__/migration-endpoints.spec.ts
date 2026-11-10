import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { MigrationEndpointResolver, dialEndpoint, tunnelClosedMessage } from '../migration-endpoints';
import { FakeTunnels, SSH_TUNNEL as TUNNEL } from './helpers/fake-tunnels';

function config(overrides: Partial<DatabaseConnectionConfig> = {}): DatabaseConnectionConfig {
  return { id: 'c', name: 'c', host: 'db.internal', port: 6379, createdAt: 0, ...overrides };
}

describe('MigrationEndpointResolver', () => {
  it('returns the stored host and port and opens nothing when neither side is tunnelled', async () => {
    const tunnels = new FakeTunnels();
    const resolver = new MigrationEndpointResolver(tunnels);
    const source = config({ host: 'src.internal', port: 6379 });
    const target = config({ host: 'tgt.internal', port: 6380 });

    const endpoints = await resolver.open('job-1', { source, target }, jest.fn());

    expect(dialEndpoint(endpoints.source)).toEqual({ host: 'src.internal', port: 6379 });
    expect(dialEndpoint(endpoints.target)).toEqual({ host: 'tgt.internal', port: 6380 });
    expect(tunnels.opened.size).toBe(0);
  });

  it('ignores a saved tunnel that is disabled', async () => {
    const tunnels = new FakeTunnels();
    const resolver = new MigrationEndpointResolver(tunnels);
    const source = config({ sshTunnel: { ...TUNNEL, enabled: false } });

    const endpoints = await resolver.open('job-1', { source, target: config() }, jest.fn());

    expect(endpoints.source.dial).toBeUndefined();
    expect(tunnels.opened.size).toBe(0);
  });

  it('opens a job-owned tunnel to the stored host and dials its local port', async () => {
    const tunnels = new FakeTunnels();
    const resolver = new MigrationEndpointResolver(tunnels);
    const source = config({ host: 'src.internal', port: 6390, password: 'pw', tls: true, sshTunnel: TUNNEL });

    const endpoints = await resolver.open('job-1', { source, target: config() }, jest.fn());

    expect(dialEndpoint(endpoints.source)).toEqual({ host: '127.0.0.1', port: 40001 });
    expect(endpoints.source).toMatchObject({ host: 'src.internal', port: 6390, password: 'pw', tls: true });
    expect([...tunnels.opened.keys()]).toEqual(['migration:job-1:source']);
    expect(tunnels.opened.get('migration:job-1:source')).toMatchObject({
      sshHost: 'bastion.example.com',
      sshPort: 2222,
      sshUsername: 'ops',
      authMethod: 'privateKey',
      keySource: 'inline',
      privateKey: 'PEM',
      passphrase: 'secret',
      hostKeyFingerprint: 'SHA256:abc',
      remoteHost: 'src.internal',
      remotePort: 6390,
    });
  });

  it('gives each tunnelled side its own tunnel', async () => {
    const tunnels = new FakeTunnels();
    const resolver = new MigrationEndpointResolver(tunnels);

    const endpoints = await resolver.open(
      'job-2',
      { source: config({ sshTunnel: TUNNEL }), target: config({ host: 'tgt.internal', sshTunnel: TUNNEL }) },
      jest.fn(),
    );

    expect(endpoints.source.dial?.port).not.toBe(endpoints.target.dial?.port);
    expect([...tunnels.opened.keys()].sort()).toEqual(['migration:job-2:source', 'migration:job-2:target']);
  });

  it('closes every tunnel it opened, once', async () => {
    const tunnels = new FakeTunnels();
    const resolver = new MigrationEndpointResolver(tunnels);
    const endpoints = await resolver.open(
      'job-3',
      { source: config({ sshTunnel: TUNNEL }), target: config({ sshTunnel: TUNNEL }) },
      jest.fn(),
    );

    await endpoints.close();
    await endpoints.close();

    expect(tunnels.closed.sort()).toEqual(['migration:job-3:source', 'migration:job-3:target']);
  });

  it('reports which side dropped when a tunnel closes on its own', async () => {
    const tunnels = new FakeTunnels();
    const resolver = new MigrationEndpointResolver(tunnels);
    const onTunnelClosed = jest.fn();
    await resolver.open('job-4', { source: config(), target: config({ sshTunnel: TUNNEL }) }, onTunnelClosed);

    tunnels.drop('target');

    expect(onTunnelClosed).toHaveBeenCalledWith('target');
  });

  it('closes the source tunnel and names the side when the target tunnel cannot be opened', async () => {
    const tunnels = new FakeTunnels();
    tunnels.failFor = 'target';
    const resolver = new MigrationEndpointResolver(tunnels);

    await expect(
      resolver.open(
        'job-5',
        { source: config({ sshTunnel: TUNNEL }), target: config({ sshTunnel: TUNNEL }) },
        jest.fn(),
      ),
    ).rejects.toThrow('Could not open the SSH tunnel to the target: All configured authentication methods failed');
    expect(tunnels.closed).toEqual(['migration:job-5:source']);
  });
});

describe('tunnelClosedMessage', () => {
  it('names the side whose tunnel dropped', () => {
    expect(tunnelClosedMessage('source')).toBe('The SSH tunnel to the source closed unexpectedly');
  });
});
