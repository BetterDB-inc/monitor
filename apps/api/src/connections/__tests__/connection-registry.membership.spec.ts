jest.mock('../../database/adapters/unified.adapter');

import { BadRequestException } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { CHILD_CONNECT_TIMEOUT_MS, ConnectionRegistry } from '../connection-registry.service';
import { UnifiedDatabaseAdapter } from '../../database/adapters/unified.adapter';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';

function build(env: Record<string, string> = {}) {
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
  const config = { get: jest.fn((key: string) => env[key]) };
  const registry = new ConnectionRegistry(storage as never, config as never, tracker as never, {} as never, new ExternalMetricsStore());
  return { registry, storage };
}

type Internals = {
  configs: Map<string, DatabaseConnectionConfig>;
  connections: Map<string, unknown>;
  defaultId: string | null;
  loadConnections: () => Promise<void>;
};

function put(registry: ConnectionRegistry, config: Partial<DatabaseConnectionConfig> & { id: string }): void {
  const full: DatabaseConnectionConfig = { name: config.id, host: 'h', port: 1, isDefault: false, createdAt: 1, ...config };
  const internals = registry as unknown as Internals;
  internals.configs.set(full.id, full);
  internals.connections.set(full.id, { isConnected: () => true, disconnect: jest.fn().mockResolvedValue(undefined), getCapabilities: () => ({}) });
}

const seed = { id: 'seed', name: 'prod', host: 'seed.local', port: 7001, username: 'u', password: 'p', tls: true };

describe('ConnectionRegistry membership', () => {
  beforeEach(() => jest.mocked(UnifiedDatabaseAdapter).mockClear());

  it('adds a managed child that inherits seed credentials and TLS', async () => {
    const { registry, storage } = build();
    put(registry, seed);
    const id = await registry.addManagedChild('seed', { host: '10.0.0.2', port: 7002, nodeId: 'n2', source: 'cluster' });
    const child = registry.getConfig(id)!;
    expect(child).toMatchObject({
      name: 'prod · 10.0.0.2:7002',
      host: '10.0.0.2',
      port: 7002,
      username: 'u',
      password: 'p',
      tls: true,
      connectionType: 'direct',
      isDefault: false,
      membership: { seedId: 'seed', nodeId: 'n2', origin: 'auto', source: 'cluster' },
    });
    expect(storage.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ id, membership: child.membership }));
  });

  it('keeps an unreachable managed child with a failed credential status', async () => {
    const { registry, storage } = build();
    put(registry, seed);
    jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
      () => ({ connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }) as never,
    );
    const id = await registry.addManagedChild('seed', { host: '10.0.0.9', port: 7009, nodeId: 'n9', source: 'cluster' });
    expect(registry.getConfig(id)?.credentialStatus).toBe('unknown');
    expect(storage.saveConnection).toHaveBeenCalled();
  });

  it('bounds a managed child connect whose connect and disconnect never complete', async () => {
    jest.useFakeTimers();
    try {
      const { registry, storage } = build();
      put(registry, seed);
      const disconnect = jest.fn(() => new Promise(() => undefined));
      jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
        () => ({ connect: jest.fn(() => new Promise(() => undefined)), disconnect }) as never,
      );
      const pending = registry.addManagedChild('seed', { host: '10.0.0.9', port: 7009, nodeId: 'n9', source: 'cluster' });
      await jest.advanceTimersByTimeAsync(CHILD_CONNECT_TIMEOUT_MS);
      const id = await pending;
      expect(disconnect).toHaveBeenCalled();
      expect(registry.getConfig(id)?.credentialStatus).toBe('unknown');
      expect(storage.saveConnection).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds retirement when the child disconnect never completes', async () => {
    jest.useFakeTimers();
    try {
      const { registry } = build();
      put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } });
      (registry as unknown as Internals).connections.set('auto', { disconnect: jest.fn(() => new Promise(() => undefined)) });
      const pending = registry.retireChild('auto');
      await jest.advanceTimersByTimeAsync(CHILD_CONNECT_TIMEOUT_MS);
      await pending;
      expect(registry.getConfig('auto')?.membership?.retiredAt).toEqual(expect.any(Number));
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds the startup connect of a managed child that never answers', async () => {
    jest.useFakeTimers();
    try {
      const { registry, storage } = build();
      storage.getConnections.mockResolvedValue([
        { id: 'auto', name: 'auto', host: 'h', port: 1, isDefault: false, createdAt: 1, membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } },
      ]);
      jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
        () => ({ connect: jest.fn(() => new Promise(() => undefined)), disconnect: jest.fn().mockResolvedValue(undefined) }) as never,
      );
      const pending = (registry as unknown as Internals).loadConnections();
      await jest.advanceTimersByTimeAsync(CHILD_CONNECT_TIMEOUT_MS);
      await pending;
      expect(registry.getConfig('auto')?.credentialStatus).toBe('unknown');
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds a manual reconnect of a member that never answers', async () => {
    jest.useFakeTimers();
    try {
      const { registry } = build();
      put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } });
      const disconnect = jest.fn().mockResolvedValue(undefined);
      jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
        () => ({ connect: jest.fn(() => new Promise(() => undefined)), disconnect }) as never,
      );
      const pending = registry.reconnect('auto');
      const outcome = expect(pending).rejects.toThrow(/timed out/);
      await jest.advanceTimersByTimeAsync(CHILD_CONNECT_TIMEOUT_MS);
      await outcome;
      expect(disconnect).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds a reactivation connect that never completes', async () => {
    jest.useFakeTimers();
    try {
      const { registry } = build();
      put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'old', origin: 'auto', source: 'cluster', retiredAt: 5 } });
      const disconnect = jest.fn().mockResolvedValue(undefined);
      jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
        () => ({ connect: jest.fn(() => new Promise(() => undefined)), disconnect }) as never,
      );
      const pending = registry.reactivateChild('auto', { host: '10.0.0.2', port: 7002, nodeId: 'new', source: 'cluster' });
      await jest.advanceTimersByTimeAsync(CHILD_CONNECT_TIMEOUT_MS);
      await pending;
      expect(disconnect).toHaveBeenCalled();
      expect(registry.getConfig('auto')?.membership).toEqual({ seedId: 'seed', nodeId: 'new', origin: 'auto', source: 'cluster' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('disconnects and forgets a managed child when persisting it fails', async () => {
    const { registry, storage } = build();
    put(registry, seed);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
      () => ({ connect: jest.fn().mockResolvedValue(undefined), disconnect }) as never,
    );
    storage.saveConnection.mockRejectedValueOnce(new Error('disk full'));
    await expect(registry.addManagedChild('seed', { host: '10.0.0.2', port: 7002, nodeId: 'n2', source: 'cluster' })).rejects.toThrow('disk full');
    expect(disconnect).toHaveBeenCalled();
    expect(registry.listMembers('seed')).toEqual([]);
    expect((registry as unknown as Internals).connections.size).toBe(1);
  });

  it('stamps sentinel group and role on an auto child', async () => {
    const { registry } = build();
    put(registry, seed);
    const id = await registry.addManagedChild('seed', { host: '10.0.0.5', port: 6379, nodeId: 'r1', source: 'sentinel', group: 'mymaster', role: 'replica' });
    expect(registry.getConfig(id)?.membership).toEqual({ seedId: 'seed', nodeId: 'r1', origin: 'auto', source: 'sentinel', group: 'mymaster', role: 'replica' });
  });

  it('refreshChild replaces role and keeps retiredAt absent', async () => {
    const { registry } = build();
    put(registry, seed);
    const id = await registry.addManagedChild('seed', { host: '10.0.0.5', port: 6379, nodeId: 'r1', source: 'sentinel', group: 'mymaster', role: 'replica' });
    await registry.refreshChild(id, { host: '10.0.0.5', port: 6379, nodeId: 'r1', source: 'sentinel', group: 'mymaster', role: 'primary' });
    expect(registry.getConfig(id)?.membership?.role).toBe('primary');
  });

  it('hides retired auto children from list() but not adopted ones', () => {
    const { registry } = build();
    put(registry, seed);
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster', retiredAt: 5 } });
    put(registry, { id: 'adopted', membership: { seedId: 'seed', nodeId: 'b', origin: 'adopted', source: 'cluster', retiredAt: 5 } });
    expect(registry.list().map((c) => c.id)).toEqual(['seed', 'adopted']);
    expect(registry.list({ includeRetired: true }).map((c) => c.id)).toEqual(['seed', 'auto', 'adopted']);
  });

  it('uses data node credentials for children when the seed has them', async () => {
    const { registry, storage } = build();
    const seedId = await registry.addConnection({ name: 's', host: 's1', port: 26379, username: 'sentinel-user', password: 'sentinel-pass', nodeUsername: 'app', nodePassword: 'secret' });
    expect(registry.getConfig(seedId)).toMatchObject({ nodeUsername: 'app', nodePassword: 'secret' });
    expect(storage.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ id: seedId, nodeUsername: 'app', nodePassword: 'secret' }));
    expect(storage.saveConnection.mock.calls[0][0].nodePasswordEncrypted).toBeFalsy();
    const id = await registry.addManagedChild(seedId, { host: 'h', port: 6379, nodeId: 'n', source: 'sentinel', group: 'g', role: 'replica' });
    expect(registry.getConfig(id)).toEqual(expect.objectContaining({ username: 'app', password: 'secret' }));
    expect(registry.getConfig(id)?.nodePassword).toBeUndefined();
  });

  it('falls back to the seed credentials', async () => {
    const { registry } = build();
    const seedId = await registry.addConnection({ name: 's', host: 's1', port: 26379, username: 'u', password: 'p' });
    const id = await registry.addManagedChild(seedId, { host: 'h', port: 6379, nodeId: 'n', source: 'sentinel' });
    expect(registry.getConfig(id)).toEqual(expect.objectContaining({ username: 'u', password: 'p' }));
  });

  it('falls back to the seed password when the data node password is still ciphertext', async () => {
    const { registry } = build();
    put(registry, { ...seed, nodeUsername: 'app', nodePassword: 'not-an-envelope', nodePasswordEncrypted: true });
    const id = await registry.addManagedChild('seed', { host: 'h', port: 6379, nodeId: 'n', source: 'sentinel' });
    expect(registry.getConfig(id)).toEqual(expect.objectContaining({ username: 'app', password: 'p' }));
  });

  it('keeps an encrypted data node password when no key is configured', async () => {
    const { registry, storage } = build();
    storage.getConnections.mockResolvedValue([{ ...seed, isDefault: true, createdAt: 1, nodeUsername: 'app', nodePassword: 'ciphertext', nodePasswordEncrypted: true }]);
    await (registry as unknown as Internals).loadConnections();
    const config = registry.getConfig('seed');
    expect(config).toMatchObject({ nodePassword: 'ciphertext', nodePasswordEncrypted: true, password: 'p' });
    expect(config?.credentialStatus).not.toBe('decryption_failed');
    const id = await registry.addManagedChild('seed', { host: 'h', port: 6379, nodeId: 'n', source: 'sentinel' });
    expect(registry.getConfig(id)).toEqual(expect.objectContaining({ username: 'app', password: 'p' }));
  });

  it('never exposes the data node password in list()', () => {
    const { registry } = build();
    put(registry, { ...seed, nodeUsername: 'app', nodePassword: 'secret', nodePasswordEncrypted: true });
    const status = registry.list()[0];
    expect(status).not.toHaveProperty('nodePassword');
    expect(status).not.toHaveProperty('nodePasswordEncrypted');
    expect(JSON.stringify(registry.list())).not.toContain('secret');
  });

  it('exposes membership and the auto-register flag in list()', () => {
    const { registry } = build();
    put(registry, { ...seed, autoRegisterNodes: true });
    expect(registry.list()[0]).toMatchObject({ autoRegisterNodes: true });
  });

  it('reads the auto-register env default as a boolean flag', () => {
    expect(build({ CLUSTER_AUTO_REGISTER_NODES: 'true' }).registry.getAutoRegisterNodesDefault()).toBe(true);
    expect(build({ CLUSTER_AUTO_REGISTER_NODES: 'false' }).registry.getAutoRegisterNodesDefault()).toBe(false);
    expect(build().registry.getAutoRegisterNodesDefault()).toBe(false);
  });

  it('ignores retired auto children in host:port lookups', () => {
    const { registry } = build();
    put(registry, { id: 'auto', host: '10.0.0.2', port: 7002, membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster', retiredAt: 5 } });
    expect(registry.findByHostPort('10.0.0.2', 7002)).toBeNull();
    expect(registry.findConfigByHostPort('10.0.0.2', 7002)).toBeNull();
    expect(registry.listMembers('seed').map((c) => c.id)).toEqual(['auto']);
  });

  it('retires an auto child by disconnecting it and persisting retiredAt', async () => {
    const { registry, storage } = build();
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } });
    const adapter = (registry as unknown as Internals).connections.get('auto') as { disconnect: jest.Mock };
    await registry.retireChild('auto');
    expect(adapter.disconnect).toHaveBeenCalled();
    expect(registry.getConfig('auto')?.membership?.retiredAt).toEqual(expect.any(Number));
    expect(storage.updateConnection).toHaveBeenCalledWith('auto', { membership: expect.objectContaining({ retiredAt: expect.any(Number) }) });
  });

  it('retires an adopted child without disconnecting it', async () => {
    const { registry } = build();
    put(registry, { id: 'adopted', membership: { seedId: 'seed', nodeId: 'a', origin: 'adopted', source: 'cluster' } });
    const adapter = (registry as unknown as Internals).connections.get('adopted') as { disconnect: jest.Mock };
    await registry.retireChild('adopted');
    expect(adapter.disconnect).not.toHaveBeenCalled();
  });

  it('reactivates a retired auto child with a fresh adapter and node id', async () => {
    const { registry, storage } = build();
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'old', origin: 'auto', source: 'cluster', retiredAt: 5 } });
    await registry.reactivateChild('auto', { host: '10.0.0.2', port: 7002, nodeId: 'new', source: 'cluster' });
    expect(registry.getConfig('auto')?.membership).toEqual({ seedId: 'seed', nodeId: 'new', origin: 'auto', source: 'cluster' });
    expect(UnifiedDatabaseAdapter).toHaveBeenCalledTimes(1);
    expect(storage.updateConnection).toHaveBeenCalledWith('auto', { membership: { seedId: 'seed', nodeId: 'new', origin: 'auto', source: 'cluster' } });
  });

  it('drops a reactivated adapter when the child was removed while connecting', async () => {
    const { registry, storage } = build();
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'old', origin: 'auto', source: 'cluster', retiredAt: 5 } });
    const internals = registry as unknown as Internals;
    const disconnect = jest.fn().mockResolvedValue(undefined);
    jest.mocked(UnifiedDatabaseAdapter).mockImplementationOnce(
      () => ({
        connect: jest.fn(async () => {
          internals.configs.delete('auto');
          internals.connections.delete('auto');
        }),
        disconnect,
      }) as never,
    );
    await registry.reactivateChild('auto', { host: '10.0.0.2', port: 7002, nodeId: 'new', source: 'cluster' });
    expect(disconnect).toHaveBeenCalled();
    expect(internals.connections.has('auto')).toBe(false);
    expect(storage.updateConnection).not.toHaveBeenCalled();
  });

  it('removes a member child under its seed lock', async () => {
    const { registry, storage } = build();
    put(registry, seed);
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } });
    let release!: () => void;
    const held = registry.withSeedLock('seed', () => new Promise<void>((resolve) => { release = resolve; }));
    const removal = registry.removeConnection('auto');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteConnection).not.toHaveBeenCalled();
    release();
    await Promise.all([held, removal]);
    expect(storage.deleteConnection).toHaveBeenCalledWith('auto');
  });

  it('removes a child while its seed lock is already held', async () => {
    const { registry, storage } = build();
    put(registry, seed);
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster', retiredAt: 5 } });
    await registry.withSeedLock('seed', () => registry.removeChild('auto'));
    expect(storage.deleteConnection).toHaveBeenCalledWith('auto');
    expect(registry.getConfig('auto')).toBeNull();
  });

  it('adopts an existing connection without touching anything else', async () => {
    const { registry } = build();
    put(registry, { id: 'manual', name: 'my node', password: 'mine' });
    await registry.adoptChild('manual', 'seed', { host: '10.0.0.2', port: 7002, nodeId: 'n3', source: 'cluster' });
    expect(registry.getConfig('manual')).toMatchObject({ name: 'my node', password: 'mine', membership: { seedId: 'seed', nodeId: 'n3', origin: 'adopted', source: 'cluster' } });
  });

  it('cascades seed removal: deletes auto children, detaches adopted ones', async () => {
    const { registry, storage } = build();
    put(registry, seed);
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } });
    put(registry, { id: 'retired', membership: { seedId: 'seed', nodeId: 'r', origin: 'auto', source: 'cluster', retiredAt: 5 } });
    put(registry, { id: 'adopted', membership: { seedId: 'seed', nodeId: 'b', origin: 'adopted', source: 'cluster' } });
    await registry.removeConnection('seed');
    expect(storage.deleteConnection.mock.calls.map((c) => c[0]).sort()).toEqual(['auto', 'retired', 'seed']);
    expect(registry.getConfig('adopted')?.membership).toBeUndefined();
    expect(storage.updateConnection).toHaveBeenCalledWith('adopted', { membership: undefined });
  });

  it('sets and clears the auto-register flag on a seed only', async () => {
    const { registry, storage } = build();
    put(registry, seed);
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } });
    await registry.setAutoRegister('seed', true);
    expect(registry.getConfig('seed')?.autoRegisterNodes).toBe(true);
    await registry.setAutoRegister('seed', null);
    expect(registry.getConfig('seed')?.autoRegisterNodes).toBeUndefined();
    expect(storage.updateConnection).toHaveBeenLastCalledWith('seed', { autoRegisterNodes: undefined });
    await expect(registry.setAutoRegister('auto', true)).rejects.toThrow('Auto-registration can only be set on a seed connection');
  });

  it('serialises work under the same seed lock', async () => {
    const { registry } = build();
    const order: string[] = [];
    let release!: () => void;
    const first = registry.withSeedLock('seed', () => new Promise<void>((resolve) => {
      order.push('first-start');
      release = () => { order.push('first-end'); resolve(); };
    }));
    const second = registry.withSeedLock('seed', async () => { order.push('second'); });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('refuses to make an auto child the default connection', async () => {
    const { registry } = build();
    put(registry, seed);
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } });
    await expect(registry.setDefault('auto')).rejects.toBeInstanceOf(BadRequestException);
    expect(registry.getDefaultId()).toBeNull();
  });

  it('falls back to an active non-auto connection when the default is removed', async () => {
    const { registry } = build();
    put(registry, { id: 'first', isDefault: true });
    put(registry, { id: 'auto', membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } });
    put(registry, { id: 'retired', membership: { seedId: 'seed', nodeId: 'r', origin: 'adopted', source: 'cluster', retiredAt: 5 } });
    put(registry, { id: 'manual' });
    (registry as unknown as Internals).defaultId = 'first';
    await registry.removeConnection('first');
    expect(registry.getDefaultId()).toBe('manual');
  });

  it('picks an active non-auto connection as the startup default', async () => {
    const { registry, storage } = build();
    storage.getConnections.mockResolvedValue([
      { id: 'auto', name: 'auto', host: 'h', port: 1, isDefault: false, createdAt: 1, membership: { seedId: 'seed', nodeId: 'a', origin: 'auto', source: 'cluster' } },
      { id: 'seed', name: 'seed', host: 'h', port: 2, isDefault: false, createdAt: 1 },
    ]);
    await (registry as unknown as Internals).loadConnections();
    expect(registry.getDefaultId()).toBe('seed');
  });

  it('moves the default off a child when it is retired', async () => {
    const { registry } = build();
    put(registry, seed);
    put(registry, { id: 'adopted', membership: { seedId: 'seed', nodeId: 'b', origin: 'adopted', source: 'cluster' } });
    await registry.setDefault('adopted');
    await registry.retireChild('adopted');
    expect(registry.getDefaultId()).toBe('seed');
  });
});
