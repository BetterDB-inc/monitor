import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { TopologyAutoRegistrationService } from '../topology-auto-registration.service';
import type { TopologySource } from '../topology-source';
import type { DesiredNode } from '../membership-diff';

const primary = (host: string, id = host): DesiredNode => ({ host, port: 6379, nodeId: id, source: 'sentinel', group: 'mymaster', role: 'primary' });
const replica = (host: string, id = host): DesiredNode => ({ host, port: 6379, nodeId: id, source: 'sentinel', group: 'mymaster', role: 'replica' });

function build(opts: { nodes: DesiredNode[]; unknownGroups?: string[]; members?: DatabaseConnectionConfig[]; env?: Record<string, string>; autoRegisterNodes?: boolean }) {
  const seed = { id: 'seed', name: 'sentinels', host: 's1', port: 26379, isDefault: true, createdAt: 1, autoRegisterNodes: opts.autoRegisterNodes };
  const members = opts.members ?? [];
  const registry = {
    getConfig: jest.fn((id: string) => (id === 'seed' ? seed : members.find((m) => m.id === id) ?? null)),
    get: jest.fn(() => ({ isConnected: () => true, getCapabilities: () => ({ isSentinel: true }) })),
    listMembers: jest.fn(() => members),
    findConfigByHostPort: jest.fn(() => null),
    withSeedLock: jest.fn((_id: string, fn: () => Promise<void>) => fn()),
    addManagedChild: jest.fn().mockResolvedValue('new'),
    adoptChild: jest.fn(),
    retireChild: jest.fn(),
    reactivateChild: jest.fn(),
    refreshChild: jest.fn(),
    removeChild: jest.fn(),
    list: jest.fn(() => []),
  };
  const source: TopologySource = {
    kind: 'sentinel',
    envFlag: 'SENTINEL_AUTO_REGISTER_NODES',
    handles: (caps) => caps.isSentinel === true,
    discover: jest.fn().mockResolvedValue({ nodes: opts.nodes, unknownGroups: opts.unknownGroups ?? [] }),
  };
  const config = { get: jest.fn((key: string) => opts.env?.[key]) };
  const service = new TopologyAutoRegistrationService(registry as never, [source], config as never, undefined);
  return { service, registry };
}

const member = (id: string, host: string, role: 'primary' | 'replica', group = 'mymaster'): DatabaseConnectionConfig =>
  ({ id, name: id, host, port: 6379, isDefault: false, createdAt: 1, membership: { seedId: 'seed', nodeId: host, origin: 'auto', source: 'sentinel', group, role } }) as DatabaseConnectionConfig;

describe('TopologyAutoRegistrationService (sentinel)', () => {
  it('follows SENTINEL_AUTO_REGISTER_NODES, not the cluster flag', async () => {
    const off = build({ nodes: [primary('a')], env: { CLUSTER_AUTO_REGISTER_NODES: 'true' } });
    await off.service.reconcile('seed');
    expect(off.registry.addManagedChild).not.toHaveBeenCalled();

    const on = build({ nodes: [primary('a')], env: { SENTINEL_AUTO_REGISTER_NODES: 'true' } });
    await on.service.reconcile('seed');
    expect(on.registry.addManagedChild).toHaveBeenCalledWith('seed', primary('a'));
  });

  it('flips roles in place after a failover', async () => {
    const { service, registry } = build({
      autoRegisterNodes: true,
      nodes: [primary('b'), replica('a')],
      members: [member('A', 'a', 'primary'), member('B', 'b', 'replica')],
    });
    await service.reconcile('seed');
    expect(registry.refreshChild).toHaveBeenCalledWith('A', replica('a'));
    expect(registry.refreshChild).toHaveBeenCalledWith('B', primary('b'));
    expect(registry.retireChild).not.toHaveBeenCalled();
    expect(registry.addManagedChild).not.toHaveBeenCalled();
  });

  it('leaves members of an unknown group untouched', async () => {
    const { service, registry } = build({
      autoRegisterNodes: true,
      nodes: [primary('a')],
      unknownGroups: ['mymaster'],
      members: [member('A', 'a', 'primary'), member('R', 'r', 'replica')],
    });
    await service.reconcile('seed');
    expect(registry.retireChild).not.toHaveBeenCalled();
  });
});
