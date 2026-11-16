jest.mock('../../database/adapters/unified.adapter');

import { NotFoundException } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { CHILD_CONNECT_TIMEOUT_MS, ConnectionRegistry } from '../connection-registry.service';
import { UnifiedDatabaseAdapter } from '../../database/adapters/unified.adapter';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';

function build() {
  const storage = {
    saveConnection: jest.fn().mockResolvedValue(undefined),
    deleteConnection: jest.fn().mockResolvedValue(undefined),
    updateConnection: jest.fn().mockResolvedValue(undefined),
    getConnections: jest.fn().mockResolvedValue([]),
  };
  const tracker = {
    removeConnection: jest.fn(),
    resetConnection: jest.fn(),
    getCapabilities: jest.fn().mockReturnValue(null),
  };
  const config = { get: jest.fn(() => undefined) };
  const registry = new ConnectionRegistry(storage as never, config as never, tracker as never, {} as never, new ExternalMetricsStore());
  return { registry, storage };
}

type Internals = {
  configs: Map<string, DatabaseConnectionConfig>;
  connections: Map<string, unknown>;
  memoryOnlySecrets: Set<string>;
};

function put(registry: ConnectionRegistry, config: Partial<DatabaseConnectionConfig> & { id: string }): void {
  const full: DatabaseConnectionConfig = { name: config.id, host: 'h', port: 1, isDefault: false, createdAt: 1, ...config };
  const internals = registry as unknown as Internals;
  internals.configs.set(full.id, full);
  internals.connections.set(full.id, { isConnected: () => true, disconnect: jest.fn().mockResolvedValue(undefined), getCapabilities: () => ({}) });
}

const cluster = {
  id: 'cluster',
  name: 'prod',
  host: 'seed.local',
  port: 7001,
  username: 'u',
  password: 'p',
  tls: true,
  tlsConfig: { source: 'inline' as const, ca: 'CA', secretsEncrypted: false },
  authMode: 'password' as const,
};
const node = { host: '10.0.0.2', port: 7002 };

describe('ConnectionRegistry addNodeConnection', () => {
  beforeEach(() => jest.mocked(UnifiedDatabaseAdapter).mockClear());

  it('adds a connection for the node with the credentials and TLS of the cluster connection', async () => {
    const { registry, storage } = build();
    put(registry, cluster);

    const id = await registry.addNodeConnection('cluster', node);

    expect(registry.getConfig(id)).toMatchObject({
      name: 'prod · 10.0.0.2:7002',
      host: '10.0.0.2',
      port: 7002,
      username: 'u',
      password: 'p',
      dbIndex: 0,
      tls: true,
      tlsConfig: cluster.tlsConfig,
      authMode: 'password',
      connectionType: 'direct',
      isDefault: false,
      credentialStatus: 'valid',
    });
    expect(storage.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ id, host: '10.0.0.2', port: 7002 }));
    expect(registry.findIdByHostPort('10.0.0.2', 7002)).toBe(id);
  });

  it('is not a member of the cluster connection, so a sync with auto-registration off leaves it', async () => {
    const { registry } = build();
    put(registry, cluster);

    const id = await registry.addNodeConnection('cluster', node);

    expect(registry.getConfig(id)?.membership).toBeUndefined();
    expect(registry.listMembers('cluster')).toEqual([]);
    expect(registry.isAutoRegistered(id)).toBe(false);
  });

  it('does not register the rest of the cluster from the new connection', async () => {
    const { registry } = build();
    put(registry, cluster);

    const id = await registry.addNodeConnection('cluster', node);

    expect(registry.getConfig(id)?.autoRegisterNodes).toBe(false);
  });

  it('uses the data node credentials when the cluster connection has them', async () => {
    const { registry } = build();
    put(registry, { ...cluster, nodeUsername: 'app', nodePassword: 'np' });

    const id = await registry.addNodeConnection('cluster', node);

    expect(registry.getConfig(id)).toMatchObject({ username: 'app', password: 'np' });
    expect(registry.getConfig(id)?.nodePassword).toBeUndefined();
  });

  it('does not copy an SSH tunnel', async () => {
    const { registry } = build();
    put(registry, { ...cluster, sshTunnel: { enabled: true, host: 'bastion', port: 22, username: 'ops' } as never });

    const id = await registry.addNodeConnection('cluster', node);

    expect(registry.getConfig(id)?.sshTunnel).toBeUndefined();
  });

  it('saves nothing when the node cannot be reached and names the address it tried', async () => {
    const { registry, storage } = build();
    put(registry, cluster);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
      () => ({ connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')), disconnect }) as never,
    );

    await expect(registry.addNodeConnection('cluster', node)).rejects.toThrow(
      'Could not connect to 10.0.0.2:7002: ECONNREFUSED',
    );

    expect(storage.saveConnection).not.toHaveBeenCalled();
    expect(registry.findIdByHostPort('10.0.0.2', 7002)).toBeNull();
    expect(disconnect).toHaveBeenCalled();
    expect((registry as unknown as Internals).connections.size).toBe(1);
  });

  it('gives up on a node that never answers', async () => {
    jest.useFakeTimers();
    try {
      const { registry, storage } = build();
      put(registry, cluster);
      jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
        () => ({ connect: jest.fn(() => new Promise(() => undefined)), disconnect: jest.fn().mockResolvedValue(undefined) }) as never,
      );

      const pending = registry.addNodeConnection('cluster', node);
      const failure = expect(pending).rejects.toThrow('Could not connect to 10.0.0.2:7002');
      await jest.advanceTimersByTimeAsync(CHILD_CONNECT_TIMEOUT_MS);
      await failure;

      expect(storage.saveConnection).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('disconnects and forgets the connection when storing it fails', async () => {
    const { registry, storage } = build();
    put(registry, cluster);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
      () => ({ connect: jest.fn().mockResolvedValue(undefined), disconnect }) as never,
    );
    storage.saveConnection.mockRejectedValueOnce(new Error('disk full'));

    await expect(registry.addNodeConnection('cluster', node)).rejects.toThrow('disk full');

    expect(disconnect).toHaveBeenCalled();
    expect(registry.findIdByHostPort('10.0.0.2', 7002)).toBeNull();
    expect((registry as unknown as Internals).connections.size).toBe(1);
  });

  it('keeps the connection in memory only when the secrets of the cluster connection are not written', async () => {
    const { registry, storage } = build();
    put(registry, cluster);
    (registry as unknown as Internals).memoryOnlySecrets.add('cluster');

    const id = await registry.addNodeConnection('cluster', node);

    expect(storage.saveConnection).not.toHaveBeenCalled();
    expect(registry.getConfig(id)).toMatchObject({ host: '10.0.0.2', password: 'p' });
    expect((registry as unknown as Internals).memoryOnlySecrets.has(id)).toBe(true);
  });

  it('rejects an unknown cluster connection', async () => {
    const { registry } = build();

    await expect(registry.addNodeConnection('missing', node)).rejects.toThrow(NotFoundException);
  });
});
