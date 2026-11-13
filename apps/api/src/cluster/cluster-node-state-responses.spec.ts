/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpController } from '../mcp/mcp.controller';
import { MetricsController } from '../metrics/metrics.controller';
import { MonitorController } from '../monitor/monitor.controller';
import { ClusterDiscoveryService } from './cluster-discovery.service';

function discoveryReporting(flags: string[]): ClusterDiscoveryService {
  const registry = {
    getDefaultId: jest.fn().mockReturnValue('conn-1'),
    getNodeAvailabilityZones: jest.fn().mockReturnValue(undefined),
    get: jest.fn().mockReturnValue({
      getClusterNodes: jest.fn().mockResolvedValue([
        {
          id: 'a',
          address: '10.0.0.1:6379@16379',
          flags,
          master: '-',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'connected',
          slots: [[0, 16383]],
        },
      ]),
      getClusterShards: jest.fn().mockResolvedValue(undefined),
    }),
  };
  return new ClusterDiscoveryService(registry as any);
}

const cases: Array<[string, string[], string, boolean]> = [
  ['no failure flag', ['master'], 'healthy', true],
  ['fail?', ['master', 'fail?'], 'suspect', false],
  ['handshake', ['master', 'handshake'], 'suspect', false],
  ['noaddr', ['master', 'noaddr'], 'suspect', false],
  ['fail', ['master', 'fail'], 'failed', false],
];

describe('cluster node state in responses', () => {
  it.each(cases)('the cluster nodes discover response reports a node with %s', async (_flag, flags, state, healthy) => {
    const controller = new MetricsController({} as any, discoveryReporting(flags), {} as any);

    await expect(controller.discoverClusterNodes('conn-1')).resolves.toEqual([
      expect.objectContaining({ id: 'a', state, healthy }),
    ]);
  });

  it.each(cases)('the MCP cluster nodes response reports a node with %s', async (_flag, flags, state, healthy) => {
    const controller = new McpController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      discoveryReporting(flags),
      {} as any,
      {} as any,
    );

    await expect(controller.getClusterNodes('conn-1')).resolves.toEqual([
      expect.objectContaining({ id: 'a', state, healthy }),
    ]);
  });

  it.each(cases)('the monitor nodes response reports a node with %s', async (_flag, flags, state, healthy) => {
    const controller = new MonitorController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      discoveryReporting(flags),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(controller.listConnectionNodes('conn-1')).resolves.toEqual({
      isCluster: true,
      nodes: [{ id: 'a', address: '10.0.0.1:6379@16379', role: 'master', state, healthy }],
    });
  });

  it.each(cases)('discovery itself gives a node with %s a state and no boolean', async (_flag, flags, state) => {
    const nodes = await discoveryReporting(flags).discoverNodes('conn-1');

    expect(nodes[0].state).toBe(state);
    expect(nodes[0]).not.toHaveProperty('healthy');
  });
});
