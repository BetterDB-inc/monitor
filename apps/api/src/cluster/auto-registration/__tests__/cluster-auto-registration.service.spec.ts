import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { ClusterAutoRegistrationService } from '../cluster-auto-registration.service';
import type { DiscoveredNode } from '../../cluster-discovery.service';

function discovered(id: string, address: string, flags = ['master']): DiscoveredNode {
  return { id, address, flags, role: 'master', slots: [], configEpoch: 0, healthy: true };
}

function build(options: {
  seed?: Partial<DatabaseConnectionConfig>;
  members?: DatabaseConnectionConfig[];
  nodes?: DiscoveredNode[] | Error;
  envDefault?: string;
  retentionDays?: number | null;
  clusterEnabled?: boolean;
  connected?: boolean;
} = {}) {
  const seed: DatabaseConnectionConfig = {
    id: 'seed', name: 'prod', host: 'seed.local', port: 7001, isDefault: true, createdAt: 1,
    autoRegisterNodes: true, ...options.seed,
  };
  let members = options.members ?? [];
  const registry = {
    getConfig: jest.fn((id: string) => (id === 'seed' ? seed : members.find((m) => m.id === id) ?? null)),
    get: jest.fn(() => ({
      isConnected: () => options.connected ?? true,
      getCapabilities: () => ({ clusterEnabled: options.clusterEnabled ?? true }),
    })),
    listMembers: jest.fn((_seedId: string) => members),
    findConfigByHostPort: jest.fn((_host: string, _port: number): DatabaseConnectionConfig | null => null),
    withSeedLock: jest.fn((_id: string, fn: () => Promise<void>) => fn()),
    addManagedChild: jest.fn().mockResolvedValue('new-id'),
    adoptChild: jest.fn().mockResolvedValue(undefined),
    retireChild: jest.fn().mockResolvedValue(undefined),
    reactivateChild: jest.fn().mockResolvedValue(undefined),
    refreshChildNodeId: jest.fn().mockResolvedValue(undefined),
    removeChild: jest.fn().mockResolvedValue(undefined),
    list: jest.fn(() => []),
  };
  const discovery = {
    discoverNodesIsolated: jest.fn(() =>
      options.nodes instanceof Error ? Promise.reject(options.nodes) : Promise.resolve(options.nodes ?? []),
    ),
  };
  const config = { get: jest.fn(() => options.envDefault) };
  const retention = { getRetentionDays: jest.fn(() => options.retentionDays ?? null) };
  const service = new ClusterAutoRegistrationService(registry as never, discovery as never, config as never, retention as never);
  return { service, registry, discovery, setMembers: (next: DatabaseConnectionConfig[]) => { members = next; } };
}

function child(id: string, host: string, port: number, extra: Partial<DatabaseConnectionConfig['membership']> = {}): DatabaseConnectionConfig {
  return { id, name: id, host, port, isDefault: false, createdAt: 1, membership: { seedId: 'seed', nodeId: id, origin: 'auto', source: 'cluster', ...extra } };
}

const clusterOf = (count: number) =>
  Array.from({ length: count }, (_, i) => discovered(`n${i + 2}`, `10.0.0.${i + 2}:700${i + 2}@1700${i + 2}`));

describe('ClusterAutoRegistrationService', () => {
  it('adds every discovered node except the seed', async () => {
    const { service, registry } = build({ nodes: [discovered('self', '127.0.0.1:7001@17001', ['myself', 'master']), ...clusterOf(2)] });
    await service.reconcile('seed');
    expect(registry.addManagedChild.mock.calls).toEqual([
      ['seed', { host: '10.0.0.2', port: 7002, nodeId: 'n2' }],
      ['seed', { host: '10.0.0.3', port: 7003, nodeId: 'n3' }],
    ]);
  });

  it('follows the env default when the seed has not set the flag', async () => {
    const off = build({ seed: { autoRegisterNodes: undefined }, envDefault: 'false', nodes: clusterOf(1) });
    await off.service.reconcile('seed');
    expect(off.registry.addManagedChild).not.toHaveBeenCalled();
    const on = build({ seed: { autoRegisterNodes: undefined }, envDefault: 'true', nodes: clusterOf(1) });
    await on.service.reconcile('seed');
    expect(on.registry.addManagedChild).toHaveBeenCalledTimes(1);
  });

  it('never adopts a connection that is itself a seed', async () => {
    const other: DatabaseConnectionConfig = { id: 'other', name: 'other', host: '10.0.0.2', port: 7002, isDefault: false, createdAt: 1 };
    const flagged = build({ nodes: clusterOf(1) });
    flagged.registry.findConfigByHostPort.mockReturnValue({ ...other, autoRegisterNodes: true });
    await flagged.service.reconcile('seed');
    expect(flagged.registry.adoptChild).not.toHaveBeenCalled();
    expect(flagged.registry.addManagedChild).not.toHaveBeenCalled();

    const withMembers = build({ nodes: clusterOf(1) });
    withMembers.registry.findConfigByHostPort.mockReturnValue(other);
    withMembers.registry.listMembers.mockImplementation((seedId: string) =>
      seedId === 'other' ? [{ ...other, id: 'o-child', membership: { seedId: 'other', nodeId: 'x', origin: 'auto', source: 'cluster' } }] : [],
    );
    await withMembers.service.reconcile('seed');
    expect(withMembers.registry.adoptChild).not.toHaveBeenCalled();
    expect(withMembers.registry.addManagedChild).not.toHaveBeenCalled();
  });

  it('treats an unset connection as a seed when the env default is on', async () => {
    const other: DatabaseConnectionConfig = { id: 'other', name: 'other', host: '10.0.0.2', port: 7002, isDefault: false, createdAt: 1 };
    const on = build({ seed: { autoRegisterNodes: undefined }, envDefault: 'true', nodes: clusterOf(1) });
    on.registry.findConfigByHostPort.mockReturnValue(other);
    await on.service.reconcile('seed');
    expect(on.registry.adoptChild).not.toHaveBeenCalled();

    const optedOut = build({ envDefault: 'true', nodes: clusterOf(1) });
    optedOut.registry.findConfigByHostPort.mockReturnValue({ ...other, autoRegisterNodes: false });
    await optedOut.service.reconcile('seed');
    expect(optedOut.registry.adoptChild).toHaveBeenCalledWith('other', 'seed', 'n2');
  });

  it('does nothing when discovery fails or returns no nodes', async () => {
    const members = [child('c2', '10.0.0.2', 7002)];
    for (const nodes of [new Error('CLUSTERDOWN'), []]) {
      const { service, registry } = build({ nodes, members });
      await service.reconcile('seed');
      expect(registry.retireChild).not.toHaveBeenCalled();
      expect(registry.addManagedChild).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['standalone', { clusterEnabled: false }],
    ['disconnected', { connected: false }],
    ['ssh-tunnelled', { seed: { sshTunnel: { enabled: true, host: 'b', port: 22, username: 'u', authMethod: 'password' as const } } }],
    ['undecryptable', { seed: { credentialStatus: 'decryption_failed' as const } }],
    ['external', { seed: { connectionType: 'external' as const } }],
    ['a child', { seed: { membership: { seedId: 'x', nodeId: 'y', origin: 'auto' as const, source: 'cluster' as const } } }],
  ])('skips a %s seed', async (_label, options) => {
    const { service, discovery } = build({ nodes: clusterOf(1), ...options });
    await service.reconcile('seed');
    expect(discovery.discoverNodesIsolated).not.toHaveBeenCalled();
  });

  it('retires all auto children when the seed is toggled off, even while disconnected', async () => {
    const members = [child('c2', '10.0.0.2', 7002), child('mine', '10.0.0.3', 7003, { origin: 'adopted' })];
    const { service, registry } = build({ seed: { autoRegisterNodes: false }, connected: false, members });
    await service.reconcile('seed');
    expect(registry.retireChild.mock.calls).toEqual([['c2']]);
  });

  it('holds a mass retirement until it repeats on the next tick', async () => {
    const members = [child('c2', '10.0.0.2', 7002), child('c3', '10.0.0.3', 7003), child('c4', '10.0.0.4', 7004)];
    const { service, registry } = build({ nodes: [discovered('n2', '10.0.0.2:7002@17002')], members });
    await service.reconcile('seed');
    expect(registry.retireChild).not.toHaveBeenCalled();
    await service.reconcile('seed');
    expect(registry.retireChild.mock.calls.map((c) => c[0]).sort()).toEqual(['c3', 'c4']);
  });

  it('resets the hold when the second tick shows a different set', async () => {
    const members = [child('c2', '10.0.0.2', 7002), child('c3', '10.0.0.3', 7003), child('c4', '10.0.0.4', 7004)];
    const first = build({ nodes: [discovered('n2', '10.0.0.2:7002@17002')], members });
    await first.service.reconcile('seed');
    first.discovery.discoverNodesIsolated.mockResolvedValueOnce([discovered('n3', '10.0.0.3:7003@17003')]);
    await first.service.reconcile('seed');
    expect(first.registry.retireChild).not.toHaveBeenCalled();
  });

  it('applies a small retirement immediately', async () => {
    const members = [child('c2', '10.0.0.2', 7002), child('c3', '10.0.0.3', 7003), child('c4', '10.0.0.4', 7004)];
    const { service, registry } = build({ nodes: clusterOf(2), members });
    await service.reconcile('seed');
    expect(registry.retireChild.mock.calls).toEqual([['c4']]);
  });

  it('keeps applying the rest when one operation fails', async () => {
    const { service, registry } = build({ nodes: clusterOf(2) });
    registry.addManagedChild.mockRejectedValueOnce(new Error('disk full'));
    await service.reconcile('seed');
    expect(registry.addManagedChild).toHaveBeenCalledTimes(2);
  });

  it('purges retired auto children older than the retention window', async () => {
    const old = Date.now() - 10 * 86_400_000;
    const members = [
      child('stale', '10.0.0.5', 7005, { retiredAt: old }),
      child('fresh', '10.0.0.6', 7006, { retiredAt: Date.now() }),
      child('mine', '10.0.0.7', 7007, { origin: 'adopted', retiredAt: old }),
    ];
    const { service, registry } = build({ retentionDays: 7, members, nodes: clusterOf(0) });
    await service.reconcile('seed');
    expect(registry.removeChild.mock.calls).toEqual([['stale']]);
  });

  it('keeps retired children forever when retention is unset', async () => {
    const members = [child('stale', '10.0.0.5', 7005, { retiredAt: 1 })];
    const { service, registry } = build({ retentionDays: null, members });
    await service.reconcile('seed');
    expect(registry.removeChild).not.toHaveBeenCalled();
  });

  it('gives up on a discovery that never answers so the next seed still reconciles', async () => {
    jest.useFakeTimers();
    try {
      const { service, registry, discovery } = build({ nodes: clusterOf(1) });
      const other: DatabaseConnectionConfig = { id: 'other', name: 'other', host: 'other.local', port: 7101, isDefault: false, createdAt: 1, autoRegisterNodes: true };
      const getSeed = registry.getConfig.getMockImplementation()!;
      registry.getConfig.mockImplementation((id: string) => (id === 'other' ? other : getSeed(id)));
      discovery.discoverNodesIsolated.mockReturnValueOnce(new Promise<DiscoveredNode[]>(() => undefined));
      const hung = service.reconcile('seed');
      const next = service.reconcile('other');
      await jest.advanceTimersByTimeAsync(15_000);
      await Promise.all([hung, next]);
      expect(registry.addManagedChild).toHaveBeenCalledTimes(1);
      expect(registry.addManagedChild).toHaveBeenCalledWith('other', expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips discovery while a timed-out one is still pending, and resumes once it settles', async () => {
    jest.useFakeTimers();
    try {
      const { service, registry, discovery } = build({ nodes: clusterOf(1) });
      let settle: (nodes: DiscoveredNode[]) => void = () => undefined;
      discovery.discoverNodesIsolated.mockReturnValueOnce(new Promise<DiscoveredNode[]>((resolve) => { settle = resolve; }));

      const first = service.reconcile('seed');
      await jest.advanceTimersByTimeAsync(15_000);
      await first;
      await service.reconcile('seed');
      await service.reconcile('seed');
      expect(discovery.discoverNodesIsolated).toHaveBeenCalledTimes(1);
      expect(registry.addManagedChild).not.toHaveBeenCalled();

      settle([]);
      await jest.advanceTimersByTimeAsync(0);
      await service.reconcile('seed');
      expect(discovery.discoverNodesIsolated).toHaveBeenCalledTimes(2);
      expect(registry.addManagedChild).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('serialises reconciles across seeds so only one claims a shared address', async () => {
    const seedA: DatabaseConnectionConfig = { id: 'a', name: 'A', host: 'a.local', port: 7001, isDefault: true, createdAt: 1, autoRegisterNodes: true };
    const seedB: DatabaseConnectionConfig = { id: 'b', name: 'B', host: 'b.local', port: 7002, isDefault: false, createdAt: 1, autoRegisterNodes: true };
    const configs = new Map<string, DatabaseConnectionConfig>([['a', seedA], ['b', seedB]]);
    const registry = {
      getConfig: jest.fn((id: string) => configs.get(id) ?? null),
      get: jest.fn(() => ({ isConnected: () => true, getCapabilities: () => ({ clusterEnabled: true }) })),
      listMembers: jest.fn((seedId: string) => Array.from(configs.values()).filter((c) => c.membership?.seedId === seedId)),
      findConfigByHostPort: jest.fn(
        (host: string, port: number) => Array.from(configs.values()).find((c) => c.host === host && c.port === port) ?? null,
      ),
      withSeedLock: jest.fn((_id: string, fn: () => Promise<void>) => fn()),
      addManagedChild: jest.fn((seedId: string, node: { host: string; port: number; nodeId: string }) => {
        const id = `child-${node.host}-${node.port}`;
        configs.set(id, {
          id,
          name: id,
          host: node.host,
          port: node.port,
          isDefault: false,
          createdAt: 1,
          membership: { seedId, nodeId: node.nodeId, origin: 'auto', source: 'cluster' },
        });
        return Promise.resolve(id);
      }),
      adoptChild: jest.fn().mockResolvedValue(undefined),
      retireChild: jest.fn().mockResolvedValue(undefined),
      reactivateChild: jest.fn().mockResolvedValue(undefined),
      refreshChildNodeId: jest.fn().mockResolvedValue(undefined),
      removeChild: jest.fn().mockResolvedValue(undefined),
      list: jest.fn(() => []),
    };
    const discovery = { discoverNodesIsolated: jest.fn(() => Promise.resolve([discovered('shared', '10.0.0.9:7009@17009')])) };
    const config = { get: jest.fn(() => false) };
    const retention = { getRetentionDays: jest.fn(() => null) };
    const service = new ClusterAutoRegistrationService(registry as never, discovery as never, config as never, retention as never);

    await Promise.all([service.reconcile('a'), service.reconcile('b')]);

    expect(registry.addManagedChild).toHaveBeenCalledTimes(1);
  });
});
