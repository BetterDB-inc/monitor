import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { ClusterNodeConnectService } from './cluster-node-connect.service';
import type { DiscoveredNode } from './cluster-discovery.service';

function discovered(id: string, address: string, extra: Partial<DiscoveredNode> = {}): DiscoveredNode {
  return { id, address, flags: ['master'], role: 'master', slots: [], configEpoch: 0, state: 'healthy', ...extra };
}

const NODES = [
  discovered('n1', '10.0.0.1:7001@17001', { flags: ['myself', 'master'] }),
  discovered('n2', '10.0.0.2:7002@17002'),
  discovered('n3', '10.0.0.3:7003@17003', { hostname: 'node-3.internal' }),
  discovered('n4', ':0@0', { flags: ['master', 'noaddr'] }),
];

function connection(id: string, extra: Partial<DatabaseConnectionConfig> = {}): DatabaseConnectionConfig {
  return { id, name: id, host: 'seed.local', port: 7001, isDefault: false, createdAt: 1, ...extra };
}

function build(options: { configs?: DatabaseConnectionConfig[]; nodes?: DiscoveredNode[] | Error } = {}) {
  const configs = new Map((options.configs ?? [connection('cluster')]).map((config) => [config.id, config]));
  const order: string[] = [];
  const registry = {
    getConfig: jest.fn((id: string) => configs.get(id) ?? null),
    findIdByHostPort: jest.fn((host: string, port: number) => {
      const found = [...configs.values()].find((config) => config.host === host && config.port === port);
      return found?.id ?? null;
    }),
    withSeedLock: jest.fn(async (id: string, fn: () => Promise<unknown>) => {
      order.push(`lock:${id}`);
      const result = await fn();
      order.push(`unlock:${id}`);
      return result;
    }),
    addNodeConnection: jest.fn(async (_sourceId: string, node: { host: string; port: number }) => {
      order.push('add');
      configs.set('new', connection('new', node));
      return 'new';
    }),
  };
  const discovery = {
    discoverNodes: jest.fn(() =>
      options.nodes instanceof Error ? Promise.reject(options.nodes) : Promise.resolve(options.nodes ?? NODES),
    ),
  };
  const service = new ClusterNodeConnectService(registry as never, discovery as never);
  return { service, registry, discovery, order };
}

describe('ClusterNodeConnectService', () => {
  it('connects the node at the address the cluster view gives for it', async () => {
    const { service, registry, discovery } = build();

    await expect(service.connect('cluster', 'n2')).resolves.toEqual({ id: 'new', created: true });

    expect(discovery.discoverNodes).toHaveBeenCalledWith('cluster');
    expect(registry.addNodeConnection).toHaveBeenCalledWith('cluster', { host: '10.0.0.2', port: 7002 });
  });

  it('checks and adds under the lock of the cluster connection', async () => {
    const { service, order } = build();

    await service.connect('cluster', 'n2');

    expect(order).toEqual(['lock:cluster', 'add', 'unlock:cluster']);
  });

  it('returns the connection that already reads the node instead of adding one', async () => {
    const { service, registry } = build({
      configs: [connection('cluster'), connection('existing', { host: '10.0.0.2', port: 7002 })],
    });

    await expect(service.connect('cluster', 'n2')).resolves.toEqual({ id: 'existing', created: false });

    expect(registry.addNodeConnection).not.toHaveBeenCalled();
  });

  it('returns the connection registered under the announced hostname of the node', async () => {
    const { service, registry } = build({
      configs: [connection('cluster'), connection('by-name', { host: 'node-3.internal', port: 7003 })],
    });

    await expect(service.connect('cluster', 'n3')).resolves.toEqual({ id: 'by-name', created: false });

    expect(registry.addNodeConnection).not.toHaveBeenCalled();
  });

  it('returns the cluster connection for the node it reads itself', async () => {
    const { service, registry } = build();

    await expect(service.connect('cluster', 'n1')).resolves.toEqual({ id: 'cluster', created: false });

    expect(registry.addNodeConnection).not.toHaveBeenCalled();
  });

  it('adds one connection when the same node is asked for twice', async () => {
    const { service, registry } = build();

    const first = await service.connect('cluster', 'n2');
    const second = await service.connect('cluster', 'n2');

    expect(first).toEqual({ id: 'new', created: true });
    expect(second).toEqual({ id: 'new', created: false });
    expect(registry.addNodeConnection).toHaveBeenCalledTimes(1);
  });

  it('copies the credentials of the seed when asked through a member', async () => {
    const member = connection('member', {
      host: '10.0.0.3',
      port: 7003,
      membership: { seedId: 'cluster', nodeId: 'n3', origin: 'auto', source: 'cluster' },
    });
    const { service, registry, order } = build({ configs: [connection('cluster'), member] });

    await service.connect('member', 'n2');

    expect(registry.addNodeConnection).toHaveBeenCalledWith('cluster', { host: '10.0.0.2', port: 7002 });
    expect(order[0]).toBe('lock:cluster');
  });

  it('copies the credentials of a member whose seed is gone', async () => {
    const member = connection('member', {
      host: '10.0.0.3',
      port: 7003,
      membership: { seedId: 'removed', nodeId: 'n3', origin: 'adopted', source: 'cluster' },
    });
    const { service, registry } = build({ configs: [member] });

    await service.connect('member', 'n2');

    expect(registry.addNodeConnection).toHaveBeenCalledWith('member', { host: '10.0.0.2', port: 7002 });
  });

  it('answers 404 for a connection that does not exist', async () => {
    const { service, discovery } = build();

    await expect(service.connect('missing', 'n2')).rejects.toThrow(NotFoundException);

    expect(discovery.discoverNodes).not.toHaveBeenCalled();
  });

  it('answers 404 for a node id the cluster view does not list', async () => {
    const { service, registry } = build();

    await expect(service.connect('cluster', 'unknown-node')).rejects.toThrow(NotFoundException);

    expect(registry.addNodeConnection).not.toHaveBeenCalled();
  });

  it('refuses a node that has no address in the cluster view', async () => {
    const { service, registry } = build();

    await expect(service.connect('cluster', 'n4')).rejects.toThrow(BadRequestException);

    expect(registry.addNodeConnection).not.toHaveBeenCalled();
  });

  it.each([
    ['an agent connection', { host: 'agent' }],
    ['an OTLP push connection', { connectionType: 'external' as const }],
  ])('refuses %s, which cannot open its own connection to a node', async (_label, extra) => {
    const { service, registry, discovery } = build({ configs: [connection('cluster', extra)] });

    await expect(service.connect('cluster', 'n2')).rejects.toThrow(BadRequestException);

    expect(discovery.discoverNodes).not.toHaveBeenCalled();
    expect(registry.addNodeConnection).not.toHaveBeenCalled();
  });

  it('refuses when the address belongs to a connection that reads a node of another cluster', async () => {
    const other = connection('other', {
      host: '10.0.0.2',
      port: 7002,
      membership: { seedId: 'other-seed', nodeId: 'node-of-another-cluster', origin: 'auto', source: 'cluster' },
    });
    const { service, registry } = build({ configs: [connection('cluster'), other] });

    await expect(service.connect('cluster', 'n2')).rejects.toThrow(ConflictException);

    expect(registry.addNodeConnection).not.toHaveBeenCalled();
  });

  it('refuses when the address belongs to a connection that reads another node of this cluster', async () => {
    const moved = connection('moved', {
      host: '10.0.0.2',
      port: 7002,
      membership: { seedId: 'cluster', nodeId: 'n1', origin: 'auto', source: 'cluster' },
    });
    const { service, registry } = build({ configs: [connection('cluster'), moved] });

    const failure = service.connect('cluster', 'n2');

    await expect(failure).rejects.toThrow(ConflictException);
    await expect(failure).rejects.toThrow('which reads another node there');
    expect(registry.addNodeConnection).not.toHaveBeenCalled();
  });

  it('answers 400 with the address that was tried when the node cannot be reached', async () => {
    const { service, registry } = build();
    registry.addNodeConnection.mockRejectedValueOnce(new Error('Could not connect to 10.0.0.2:7002: ECONNREFUSED'));

    const failure = service.connect('cluster', 'n2');

    await expect(failure).rejects.toThrow(BadRequestException);
    await expect(failure).rejects.toThrow('Could not connect to 10.0.0.2:7002: ECONNREFUSED');
  });

  it('answers 400 when the connection is not a cluster', async () => {
    const { service } = build({ nodes: new Error('ERR This instance has cluster support disabled') });

    const failure = service.connect('cluster', 'n2');

    await expect(failure).rejects.toThrow(BadRequestException);
    await expect(failure).rejects.toThrow('cluster support disabled');
  });
});
