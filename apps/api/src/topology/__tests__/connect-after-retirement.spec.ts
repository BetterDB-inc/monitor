jest.mock('../../database/adapters/unified.adapter');

import { Logger } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { ClusterNodeConnectService } from '../../cluster/cluster-node-connect.service';
import type { DiscoveredNode } from '../../cluster/cluster-discovery.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';
import { ClusterTopologySource } from '../cluster-topology.source';
import { TopologyAutoRegistrationService } from '../topology-auto-registration.service';

function discovered(id: string, address: string, flags = ['master']): DiscoveredNode {
  return { id, address, flags, role: 'master', slots: [], configEpoch: 0, state: 'healthy' };
}

const NODES = [
  discovered('n1', '10.0.0.1:7001@17001', ['myself', 'master']),
  discovered('n2', '10.0.0.2:7002@17002'),
];

type Internals = {
  configs: Map<string, DatabaseConnectionConfig>;
  connections: Map<string, unknown>;
};

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
  const registry = new ConnectionRegistry(
    storage as never,
    { get: jest.fn() } as never,
    tracker as never,
    {} as never,
    new ExternalMetricsStore(),
  );
  const put = (config: Partial<DatabaseConnectionConfig> & { id: string }): void => {
    const internals = registry as unknown as Internals;
    internals.configs.set(config.id, { name: config.id, host: 'h', port: 1, isDefault: false, createdAt: 1, ...config });
    internals.connections.set(config.id, {
      isConnected: () => true,
      disconnect: jest.fn().mockResolvedValue(undefined),
      getCapabilities: () => ({ clusterEnabled: true }),
    });
  };
  const discovery = {
    discoverNodes: jest.fn().mockResolvedValue(NODES),
    discoverNodesIsolated: jest.fn().mockResolvedValue(NODES),
  };
  const source = new ClusterTopologySource(discovery as never);
  source.resolveHost = async () => ['10.0.0.1'];
  const sync = new TopologyAutoRegistrationService(
    registry,
    [source],
    { get: jest.fn() } as never,
    { getRetentionDays: jest.fn(() => null) } as never,
  );
  const connect = new ClusterNodeConnectService(registry, discovery as never);
  return { registry, sync, connect, put };
}

describe('a node connected by hand where an auto-registered child was retired', () => {
  let logged: jest.SpyInstance;

  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is adopted when auto-registration is turned on again', async () => {
    const { registry, sync, connect, put } = build();
    put({ id: 'seed', name: 'prod', host: '10.0.0.1', port: 7001, autoRegisterNodes: true });
    put({
      id: 'child',
      host: '10.0.0.2',
      port: 7002,
      membership: { seedId: 'seed', nodeId: 'n2', origin: 'auto', source: 'cluster' },
    });

    await registry.setAutoRegister('seed', false);
    await sync.reconcile('seed');
    expect(registry.getConfig('child')?.membership?.retiredAt).toBeDefined();

    const { id, created } = await connect.connect('seed', 'n2');
    expect(created).toBe(true);

    await registry.setAutoRegister('seed', true);
    await sync.reconcile('seed');

    expect(registry.getConfig(id)?.membership).toMatchObject({ seedId: 'seed', nodeId: 'n2', origin: 'adopted' });
    expect(registry.getConfig('child')?.membership?.retiredAt).toBeDefined();
    expect(registry.list().filter((listed) => listed.host === '10.0.0.2')).toHaveLength(1);
    expect(logged.mock.calls.flat().join('\n')).not.toContain('occupied');
  });

  it('stays adopted on the syncs that follow', async () => {
    const { registry, sync, connect, put } = build();
    put({ id: 'seed', name: 'prod', host: '10.0.0.1', port: 7001, autoRegisterNodes: false });
    put({
      id: 'child',
      host: '10.0.0.2',
      port: 7002,
      membership: { seedId: 'seed', nodeId: 'n2', origin: 'auto', source: 'cluster', retiredAt: 5 },
    });
    const { id } = await connect.connect('seed', 'n2');
    await registry.setAutoRegister('seed', true);

    await sync.reconcile('seed');
    await sync.reconcile('seed');

    expect(registry.getConfig(id)?.membership).toMatchObject({ origin: 'adopted' });
    expect(registry.getConfig(id)?.membership?.retiredAt).toBeUndefined();
    expect(registry.getConfig('child')?.membership?.retiredAt).toBe(5);
    expect(logged.mock.calls.flat().join('\n')).not.toContain('occupied');
  });
});
