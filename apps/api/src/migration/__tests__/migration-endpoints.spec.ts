import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { MigrationEndpointResolver, dialEndpoint, tunnelClosedMessage } from '../migration-endpoints';
import { FakeHostKeys, FakeTunnels, SSH_TUNNEL as TUNNEL } from './helpers/fake-tunnels';

function config(overrides: Partial<DatabaseConnectionConfig> = {}): DatabaseConnectionConfig {
  return { id: 'c', name: 'c', host: 'db.internal', port: 6379, createdAt: 0, ...overrides };
}

describe('MigrationEndpointResolver', () => {
  it('returns the stored host and port and opens nothing when neither side is tunnelled', async () => {
    const tunnels = new FakeTunnels();
    const resolver = new MigrationEndpointResolver(tunnels, new FakeHostKeys());
    const source = config({ host: 'src.internal', port: 6379 });
    const target = config({ host: 'tgt.internal', port: 6380 });

    const endpoints = await resolver.open('job-1', { source, target }, jest.fn());

    expect(dialEndpoint(endpoints.source)).toEqual({ host: 'src.internal', port: 6379 });
    expect(dialEndpoint(endpoints.target)).toEqual({ host: 'tgt.internal', port: 6380 });
    expect(tunnels.opened.size).toBe(0);
  });

  it('ignores a saved tunnel that is disabled', async () => {
    const tunnels = new FakeTunnels();
    const resolver = new MigrationEndpointResolver(tunnels, new FakeHostKeys());
    const source = config({ sshTunnel: { ...TUNNEL, enabled: false } });

    const endpoints = await resolver.open('job-1', { source, target: config() }, jest.fn());

    expect(endpoints.source.dial).toBeUndefined();
    expect(tunnels.opened.size).toBe(0);
  });

  it('opens a job-owned tunnel to the stored host and dials its local port', async () => {
    const tunnels = new FakeTunnels();
    const resolver = new MigrationEndpointResolver(tunnels, new FakeHostKeys());
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
    const resolver = new MigrationEndpointResolver(tunnels, new FakeHostKeys());

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
    const resolver = new MigrationEndpointResolver(tunnels, new FakeHostKeys());
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
    const resolver = new MigrationEndpointResolver(tunnels, new FakeHostKeys());
    const onTunnelClosed = jest.fn();
    await resolver.open('job-4', { source: config(), target: config({ sshTunnel: TUNNEL }) }, onTunnelClosed);

    tunnels.drop('target');

    expect(onTunnelClosed).toHaveBeenCalledWith('target');
  });

  it('closes the source tunnel and names the side when the target tunnel cannot be opened', async () => {
    const tunnels = new FakeTunnels();
    tunnels.failFor = 'target';
    const resolver = new MigrationEndpointResolver(tunnels, new FakeHostKeys());

    await expect(
      resolver.open(
        'job-5',
        { source: config({ sshTunnel: TUNNEL }), target: config({ sshTunnel: TUNNEL }) },
        jest.fn(),
      ),
    ).rejects.toThrow('Could not open the SSH tunnel to the target: All configured authentication methods failed');
    expect(tunnels.closed).toEqual(['migration:job-5:source']);
  });

  it('pins the host key a bastion presents when the connection has none stored', async () => {
    const tunnels = new FakeTunnels();
    const hostKeys = new FakeHostKeys();
    const resolver = new MigrationEndpointResolver(tunnels, hostKeys);
    const { hostKeyFingerprint: _unpinned, ...unpinned } = TUNNEL;

    await resolver.open('job-6', { source: config({ id: 'src', sshTunnel: unpinned }), target: config() }, jest.fn());

    expect(hostKeys.pinned).toEqual([{ id: 'src', fingerprint: 'SHA256:presented' }]);
  });

  it('pins nothing when the connection already stores a fingerprint', async () => {
    const tunnels = new FakeTunnels();
    const hostKeys = new FakeHostKeys();
    const resolver = new MigrationEndpointResolver(tunnels, hostKeys);

    await resolver.open('job-7', { source: config({ sshTunnel: TUNNEL }), target: config() }, jest.fn());

    expect(hostKeys.pinned).toEqual([]);
  });

  it('pins nothing from a tunnel that could not be opened', async () => {
    const tunnels = new FakeTunnels();
    tunnels.failFor = 'source';
    const hostKeys = new FakeHostKeys();
    const resolver = new MigrationEndpointResolver(tunnels, hostKeys);
    const { hostKeyFingerprint: _unpinned, ...unpinned } = TUNNEL;

    await expect(
      resolver.open('job-8', { source: config({ sshTunnel: unpinned }), target: config() }, jest.fn()),
    ).rejects.toThrow('Could not open the SSH tunnel to the source');

    expect(hostKeys.pinned).toEqual([]);
  });
});

describe('tunnelClosedMessage', () => {
  it('names the side whose tunnel dropped', () => {
    expect(tunnelClosedMessage('source')).toBe('The SSH tunnel to the source closed unexpectedly');
  });
});
