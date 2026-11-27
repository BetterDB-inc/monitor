import { defaultPlacementSettings } from '@betterdb/shared';
import {
  PlacementEpochs,
  forkOf,
  pingP50,
  readPlacementGateFacts,
  replicasInSyncOf,
  type PlacementFactsContext,
  type PlacementFactsPort,
  type PlacementNodeFacts,
  type PlacementNodeRead,
} from '../placement-facts';
import { placementGate } from '../placement-gate';

const NOW = 1_000_000_000;
const MINUTE = 60_000;

function read(id: string, shardId: string, collected = true, configEpoch = 1): PlacementNodeRead {
  return {
    id,
    address: `${id}:7000`,
    role: id === shardId ? 'master' : 'replica',
    state: 'healthy',
    shardId,
    collected,
    configEpoch,
  };
}

function nodeFacts(nodes: PlacementNodeRead[]): PlacementNodeFacts {
  const each = <T>(value: T) => Object.fromEntries(nodes.map((node) => [node.id, value]));
  return {
    nodes,
    clusterStateOk: true,
    migrations: 'none',
    persistence: each({ forkRunning: false }),
    replication: { s1: { replicasInSync: true }, t1: { replicasInSync: true } },
    pingP50Ms: each(1),
  };
}

const context: PlacementFactsContext = {
  budget: { jobsUsed: 0, bytesUsed: 0 },
  paused: false,
  supported: true,
  sourceShardId: 's1',
  targetShardIds: ['t1'],
  sourceTriggerFiredAt: null,
  quarantinedShardIds: [],
  cooldownLeftSlots: null,
};

function port(
  overrides: Partial<PlacementFactsPort> = {},
  nodes = [read('s1', 's1'), read('t1', 't1')],
) {
  return {
    placementOpenEvents: jest.fn(async () => []),
    placementIncidents: jest.fn(async () => []),
    readPlacementNodeFacts: jest.fn(async () => nodeFacts(nodes)),
    ...overrides,
  } satisfies PlacementFactsPort;
}

function warmed(seedId: string, nodes: PlacementNodeRead[]): PlacementEpochs {
  const epochs = new PlacementEpochs();
  epochs.observe(seedId, nodes, NOW - 10 * MINUTE);
  return epochs;
}

const gateOf = async (facts: Promise<Awaited<ReturnType<typeof readPlacementGateFacts>>>) =>
  placementGate(await facts, defaultPlacementSettings(), NOW, 'approve');

describe('readPlacementGateFacts', () => {
  it('reads the source and target shards and passes the context through', async () => {
    const stub = port();
    const facts = await readPlacementGateFacts(stub, warmed('seed', []), 'seed', context, NOW);
    expect(stub.readPlacementNodeFacts).toHaveBeenCalledWith('seed', ['s1', 't1']);
    expect(facts).toMatchObject({
      ...context,
      unreadable: [],
      clusterStateOk: true,
      migrations: 'none',
    });
  });

  it('reads a PING that timed out as unknown in the gate', async () => {
    const nodes = [read('s1', 's1'), read('t1', 't1')];
    const answers = nodeFacts(nodes);
    answers.pingP50Ms.t1 = null;
    const stub = port({ readPlacementNodeFacts: jest.fn(async () => answers) });
    const result = await gateOf(
      readPlacementGateFacts(stub, warmed('seed', nodes), 'seed', context, NOW),
    );
    expect(result.blockers).toEqual([
      expect.objectContaining({ kind: 'unknown', scope: 'target', nodeId: 't1' }),
    ]);
  });

  it.each([
    ['placementOpenEvents', 'the open events'],
    ['placementIncidents', 'the open incidents'],
    ['readPlacementNodeFacts', 'the cluster nodes'],
  ] as const)('lists a failed %s read as unreadable, and the gate blocks', async (method, name) => {
    const stub = port({ [method]: jest.fn(async () => Promise.reject(new Error('timed out'))) });
    const facts = await readPlacementGateFacts(stub, warmed('seed', []), 'seed', context, NOW);
    expect(facts.unreadable).toEqual([name]);
    const result = placementGate(facts, defaultPlacementSettings(), NOW, 'approve');
    expect(result.allowed).toBe(false);
    expect(result.blockers[0]).toMatchObject({ kind: 'unknown', scope: 'cluster' });
  });

  it('maps an event that names only an address to the node at that address', async () => {
    const nodes = [read('s1', 's1'), read('t1', 't1')];
    const stub = port({
      placementOpenEvents: jest.fn(async () => [
        { metricType: 'persistence_child', nodeId: null, address: 't1:7000', openedAt: NOW },
      ]),
      placementIncidents: jest.fn(async () => [
        {
          recovery: 'active',
          patterns: [],
          signals: [{ metricType: 'memory_used', nodeId: null, address: 's1:7000', openedAt: NOW }],
        },
      ]),
    });
    const result = await gateOf(
      readPlacementGateFacts(stub, warmed('seed', nodes), 'seed', context, NOW),
    );
    expect(result.blockers.map((each) => `${each.kind}:${each.nodeId}`)).toEqual([
      'incident:s1',
      'fork:t1',
    ]);
  });

  it('gives a node the monitor does not collect only the stand-ins', async () => {
    const nodes = [read('s1', 's1'), read('t1', 't1'), read('t2', 't1', false)];
    const readNodes = jest.fn(async () => nodeFacts(nodes));
    const stub = port(
      {
        readPlacementNodeFacts: readNodes,
        placementOpenEvents: jest.fn(async () => [
          { metricType: 'failover_churn', nodeId: 't2', openedAt: NOW },
          { metricType: 'replication_divergence', nodeId: 't2', openedAt: NOW },
        ]),
      },
      nodes,
    );
    const epochs = warmed('seed', nodes);
    const quiet = await gateOf(readPlacementGateFacts(stub, epochs, 'seed', context, NOW));
    expect(quiet.allowed).toBe(true);
    expect(quiet.warnings.map((each) => each.kind)).toEqual(['coverage']);

    const bumped = [read('s1', 's1'), read('t1', 't1'), read('t2', 't1', false, 2)];
    readNodes.mockResolvedValue(nodeFacts(bumped));
    const failedOver = await gateOf(readPlacementGateFacts(stub, epochs, 'seed', context, NOW));
    expect(failedOver.blockers).toEqual([
      expect.objectContaining({ kind: 'failover', scope: 'target', nodeId: 't2' }),
    ]);
  });
});

describe('reads of one node', () => {
  it('takes the median of 10 PINGs', async () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    let call = 0;
    let clock = 0;
    const now = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const client = {
        ping: jest.fn(async () => {
          clock += delays[call++];
        }),
      };
      await expect(pingP50(client)).resolves.toBe(5.5);
      expect(client.ping).toHaveBeenCalledTimes(10);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    [{ rdb_bgsave_in_progress: '0', aof_rewrite_in_progress: '0' }, { forkRunning: false }],
    [{ rdb_bgsave_in_progress: '1', aof_rewrite_in_progress: '0' }, { forkRunning: true }],
    [{ rdb_bgsave_in_progress: '0', aof_rewrite_in_progress: '1' }, { forkRunning: true }],
    [{}, null],
    [undefined, null],
  ])('reads INFO persistence %j as %j', (section, expected) => {
    expect(forkOf(section)).toEqual(expected);
  });

  const replica = (state: string, lag: number) =>
    `ip=10.0.0.9,port=7000,state=${state},offset=100,lag=${lag}`;

  it.each([
    [{ role: 'master', connected_slaves: '0' }, 0, { replicasInSync: true }],
    [{ role: 'master', connected_slaves: '0' }, 1, { replicasInSync: false }],
    [
      { connected_slaves: '2', slave0: replica('online', 0), slave1: replica('online', 1) },
      2,
      { replicasInSync: true },
    ],
    [{ connected_slaves: '1', slave0: replica('online', 0) }, 2, { replicasInSync: false }],
    [{ connected_slaves: '1', slave0: replica('online', 3) }, 1, { replicasInSync: false }],
    [{ connected_slaves: '1', slave0: replica('wait_bgsave', 0) }, 1, { replicasInSync: false }],
    [{ connected_slaves: '2', slave0: replica('online', 0) }, 2, { replicasInSync: false }],
    [{ role: 'master' }, 0, null],
    [undefined, 0, null],
  ])('reads INFO replication %j with %d listed replicas as %j', (section, listed, expected) => {
    expect(replicasInSyncOf(section, listed)).toEqual(expected);
  });
});

describe('PlacementEpochs', () => {
  const nodes = (epoch: number) => [read('a', 'a', true, epoch)];

  it('reads a node seen for less than 5 minutes as unknown, then as unchanged', () => {
    const epochs = new PlacementEpochs();
    expect(epochs.observe('seed', nodes(1), NOW).get('a')).toBeNull();
    expect(epochs.observe('seed', nodes(1), NOW + 4 * MINUTE).get('a')).toBeNull();
    expect(epochs.observe('seed', nodes(1), NOW + 5 * MINUTE).get('a')).toBe(false);
  });

  it('reads a raised config epoch as a change for 5 minutes', () => {
    const epochs = new PlacementEpochs();
    epochs.observe('seed', nodes(1), NOW - 10 * MINUTE);
    expect(epochs.observe('seed', nodes(2), NOW).get('a')).toBe(true);
    expect(epochs.observe('seed', nodes(2), NOW + 4 * MINUTE).get('a')).toBe(true);
    expect(epochs.observe('seed', nodes(2), NOW + 5 * MINUTE).get('a')).toBe(false);
  });

  it('reads a config epoch raised in a shard a slot move of ours touched as no change', () => {
    const epochs = new PlacementEpochs();
    epochs.observe('seed', nodes(1), NOW - 10 * MINUTE);
    expect(epochs.observe('seed', nodes(2), NOW, ['a']).get('a')).toBe(false);
    expect(epochs.observe('seed', nodes(3), NOW + MINUTE, ['b']).get('a')).toBe(true);
  });

  it('ignores a lower config epoch, and forgets nodes that left', () => {
    const epochs = new PlacementEpochs();
    epochs.observe('seed', nodes(3), NOW - 10 * MINUTE);
    expect(epochs.observe('seed', nodes(2), NOW).get('a')).toBe(false);
    epochs.observe('seed', [], NOW);
    expect(epochs.observe('seed', nodes(2), NOW).get('a')).toBeNull();
  });
});
