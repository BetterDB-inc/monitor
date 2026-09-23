jest.mock('../../database/adapters/unified.adapter');

import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { ConnectionRegistry } from '../connection-registry.service';
import { UnifiedDatabaseAdapter } from '../../database/adapters/unified.adapter';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';
import { ExternalMetricsAdapter } from '../../external-metrics/external-metrics.adapter';

function build() {
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
  const store = new ExternalMetricsStore();
  const registry = new ConnectionRegistry(
    storage as never,
    {} as never,
    tracker as never,
    {} as never,
    store,
  );
  return { registry, storage, tracker, store };
}

function seedDirect(registry: ConnectionRegistry, host: string, port: number): void {
  const config: DatabaseConnectionConfig = {
    id: 'direct-1',
    name: 'Polled',
    host,
    port,
    isDefault: false,
    createdAt: 1,
  };
  (registry as unknown as { configs: Map<string, DatabaseConnectionConfig> }).configs.set(config.id, config);
}

const external = { name: 'Pushed', host: 'cache.internal', port: 6379, connectionType: 'external' as const };

describe('ConnectionRegistry external connections', () => {
  beforeEach(() => {
    jest.mocked(UnifiedDatabaseAdapter).mockClear();
  });

  it('adds an external connection without dialing', async () => {
    const { registry, storage } = build();
    const id = await registry.addConnection(external);
    expect(registry.get(id)).toBeInstanceOf(ExternalMetricsAdapter);
    expect(UnifiedDatabaseAdapter).not.toHaveBeenCalled();
    expect(storage.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ connectionType: 'external' }));
  });

  it.each([
    [{ password: 'secret' }],
    [{ username: 'default' }],
    [{ tls: true }],
    [{ sshTunnel: { enabled: true, host: 'bastion', port: 22, username: 'u', authMethod: 'password' as const } }],
  ])('rejects credentials and transport options %o', async (extra) => {
    const { registry, storage } = build();
    await expect(registry.addConnection({ ...external, ...extra } as never)).rejects.toThrow(
      'OTLP push connections take no credentials, TLS or SSH tunnel',
    );
    expect(storage.saveConnection).not.toHaveBeenCalled();
  });

  it('rejects a host:port that is already registered', async () => {
    const { registry } = build();
    seedDirect(registry, 'cache.internal', 6379);
    await expect(registry.addConnection(external)).rejects.toThrow('A connection for cache.internal:6379 already exists');
  });

  it('tests an external connection without dialing', async () => {
    const { registry } = build();
    await expect(registry.testConnection(external)).resolves.toEqual({
      success: true,
      message: 'Waiting for first OTLP sample',
    });
    expect(UnifiedDatabaseAdapter).not.toHaveBeenCalled();
  });

  it('lists the connection type', async () => {
    const { registry } = build();
    seedDirect(registry, 'other', 6380);
    const id = await registry.addConnection(external);
    const types = Object.fromEntries(registry.list().map((c) => [c.id, c.connectionType]));
    expect(types).toEqual({ 'direct-1': 'direct', [id]: 'external' });
  });

  it('resolves host:port preferring external', async () => {
    const { registry } = build();
    expect(registry.findByHostPort('cache.internal', 6379)).toBeNull();
    seedDirect(registry, 'cache.internal', 6379);
    expect(registry.findByHostPort('cache.internal', 6379)).toEqual({ id: 'direct-1', connectionType: 'direct' });
    const configs = (registry as unknown as { configs: Map<string, DatabaseConnectionConfig> }).configs;
    configs.set('ext-1', { id: 'ext-1', name: 'E', host: 'cache.internal', port: 6379, isDefault: false, createdAt: 2, connectionType: 'external' });
    expect(registry.findByHostPort('cache.internal', 6379)).toEqual({ id: 'ext-1', connectionType: 'external' });
  });

  it('clears pushed metrics when the connection is removed', async () => {
    const { registry, store } = build();
    const id = await registry.addConnection(external);
    store.apply(id, [{ target: { kind: 'scalar', section: 'memory', field: 'used_memory' }, value: '1', timeMs: Date.now() }]);
    await registry.removeConnection(id);
    expect(store.latestVersion(id)).toBeNull();
  });
});
