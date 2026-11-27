import { defaultPlacementSettings, type PlacementSettings } from '@betterdb/shared';
import {
  insideMaintenanceWindow,
  placementGate,
  type PlacementGateFacts,
  type PlacementGateNode,
} from '../placement-gate';

const NOW = Date.UTC(2026, 10, 25, 12, 0);
const FIRED_AT = NOW - 10 * 60_000;

type Place =
  | 'source primary'
  | 'source replica'
  | 'target primary'
  | 'target replica'
  | 'unrelated';

const PLACES: Record<Place, { nodeId: string; scope: 'source' | 'target' | null }> = {
  'source primary': { nodeId: 's1', scope: 'source' },
  'source replica': { nodeId: 's2', scope: 'source' },
  'target primary': { nodeId: 't1', scope: 'target' },
  'target replica': { nodeId: 't2', scope: 'target' },
  unrelated: { nodeId: 'u1', scope: null },
};

const ALL_PLACES = Object.keys(PLACES) as Place[];

function node(id: string, shardId: string, port: number): PlacementGateNode {
  return {
    id,
    address: `10.0.0.${port}:7000`,
    role: id === shardId ? 'master' : 'replica',
    state: 'healthy',
    shardId,
    collected: true,
    epochChanged: false,
  };
}

function facts(change: (facts: PlacementGateFacts) => void = () => {}): PlacementGateFacts {
  const nodes = [
    node('s1', 's1', 1),
    node('s2', 's1', 2),
    node('t1', 't1', 3),
    node('t2', 't1', 4),
    node('u1', 'u1', 5),
    node('u2', 'u1', 6),
  ];
  const each = <T>(value: T) => Object.fromEntries(nodes.map((n) => [n.id, value]));
  const built: PlacementGateFacts = {
    nodes,
    clusterStateOk: true,
    migrations: 'none',
    openEvents: [],
    incidents: [],
    persistence: each({ forkRunning: false }),
    replication: {
      s1: { replicasInSync: true },
      t1: { replicasInSync: true },
      u1: { replicasInSync: true },
    },
    pingP50Ms: each(1),
    budget: { jobsUsed: 0, bytesUsed: 0 },
    paused: false,
    supported: true,
    sourceShardId: 's1',
    targetShardIds: ['t1'],
    sourceTriggerFiredAt: FIRED_AT,
    quarantinedShardIds: [],
    cooldownLeftSlots: null,
    unreadable: [],
  };
  change(built);
  return built;
}

function nodeOf(built: PlacementGateFacts, id: string): PlacementGateNode {
  const found = built.nodes.find((each) => each.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

const settings = (change: Partial<PlacementSettings> = {}): PlacementSettings => ({
  ...defaultPlacementSettings(),
  ...change,
});

const gate = (
  built: PlacementGateFacts,
  purpose: 'approve' | 'auto' | 'rollback' = 'approve',
  policy = settings(),
) => placementGate(built, policy, NOW, purpose);

const kindsOf = (result: ReturnType<typeof gate>) =>
  result.blockers.map((blocker) => `${blocker.kind}:${blocker.scope}:${blocker.nodeId ?? ''}`);

describe('placementGate', () => {
  it('allows a plan on a healthy cluster with every node collected', () => {
    expect(gate(facts())).toEqual({ allowed: true, blockers: [], warnings: [] });
    expect(gate(facts(), 'auto')).toEqual({ allowed: true, blockers: [], warnings: [] });
  });

  describe('open detector events on a node', () => {
    const cases: Array<[string, string, Place[]]> = [
      ['failover_churn', 'failover', ALL_PLACES],
      ['replication_role', 'failover', ALL_PLACES],
      ['lagging_promotion', 'failover', ALL_PLACES],
      ['persistence_child', 'fork', ALL_PLACES],
      ['fork_memory_risk', 'fork', ALL_PLACES],
      ['command_p99', 'latency', ALL_PLACES],
      [
        'replication_divergence',
        'replication_divergence',
        ['source replica', 'target replica', 'unrelated'],
      ],
    ];
    const rows = cases.flatMap(([metricType, kind, places]) =>
      places.flatMap((place) =>
        (['open', 'closed'] as const).flatMap((state) =>
          [true, false].map((collected) => ({ metricType, kind, place, state, collected })),
        ),
      ),
    );

    it.each(rows)(
      '$metricType $state on the $place (collected: $collected)',
      ({ metricType, kind, place, state, collected }) => {
        const { nodeId, scope } = PLACES[place];
        const built = facts((f) => {
          nodeOf(f, nodeId).collected = collected;
          if (state === 'open')
            f.openEvents.push({ metricType, nodeId, openedAt: FIRED_AT - 60_000 });
        });
        const result = gate(built);
        const blocks = state === 'open' && collected && scope !== null;
        expect(kindsOf(result)).toEqual(blocks ? [`${kind}:${scope}:${nodeId}`] : []);
        expect(result.allowed).toBe(!blocks);
      },
    );

    it('blocks on an open replication_divergence only when it is on a replica', () => {
      const built = facts((f) => {
        f.openEvents.push({ metricType: 'replication_divergence', nodeId: 's1', openedAt: NOW });
      });
      expect(gate(built).allowed).toBe(true);
    });

    it('blocks the whole cluster on a node event that names no node', () => {
      const built = facts((f) => {
        f.openEvents.push({ metricType: 'failover_churn', nodeId: null, openedAt: NOW });
      });
      expect(kindsOf(gate(built))).toEqual(['failover:cluster:']);
    });
  });

  describe('fresh reads and stand-ins', () => {
    type Read = 'epoch' | 'persistence' | 'ping' | 'replication';
    const apply = (
      f: PlacementGateFacts,
      read: Read,
      nodeId: string,
      state: 'open' | 'unknown',
    ) => {
      const target = nodeOf(f, nodeId);
      if (read === 'epoch') target.epochChanged = state === 'open' ? true : null;
      if (read === 'persistence')
        f.persistence[nodeId] = state === 'open' ? { forkRunning: true } : null;
      if (read === 'ping') f.pingP50Ms[nodeId] = state === 'open' ? 80 : null;
      if (read === 'replication')
        f.replication[target.shardId] = state === 'open' ? { replicasInSync: false } : null;
    };
    const kindOf: Record<Read, string> = {
      epoch: 'failover',
      persistence: 'fork',
      ping: 'latency',
      replication: 'replication_divergence',
    };
    const rows = (['epoch', 'persistence', 'ping', 'replication'] as Read[]).flatMap((read) =>
      ALL_PLACES.flatMap((place) =>
        (['open', 'closed', 'unknown'] as const).flatMap((state) =>
          [true, false].map((collected) => ({ read, place, state, collected })),
        ),
      ),
    );

    it.each(rows)(
      '$read $state on the $place (collected: $collected)',
      ({ read, place, state, collected }) => {
        const { nodeId, scope } = PLACES[place];
        const built = facts((f) => {
          nodeOf(f, nodeId).collected = collected;
          if (state !== 'closed') apply(f, read, nodeId, state);
        });
        const target = nodeOf(built, nodeId);
        const read_ =
          read === 'epoch'
            ? !collected
            : read === 'replication'
              ? !collected && target.role === 'replica'
              : true;
        const blockedNode = read === 'replication' ? target.shardId : nodeId;
        const expected =
          state === 'closed' || scope === null || !read_
            ? []
            : [`${state === 'open' ? kindOf[read] : 'unknown'}:${scope}:${blockedNode}`];
        expect(kindsOf(gate(built))).toEqual(expected);
      },
    );

    it('uses the 50 ms floor when abortLatencyMs is lower, and abortLatencyMs above it', () => {
      const slow = facts((f) => {
        f.pingP50Ms.t1 = 40;
      });
      expect(gate(slow, 'approve', settings({ abortLatencyMs: 10 })).allowed).toBe(true);
      const slower = facts((f) => {
        f.pingP50Ms.t1 = 120;
      });
      expect(gate(slower, 'approve', settings({ abortLatencyMs: 100 })).blockers).toEqual([
        expect.objectContaining({ kind: 'latency', scope: 'target', nodeId: 't1' }),
      ]);
    });

    it('reads a shard missing from the cluster view as unknown', () => {
      const built = facts((f) => {
        f.nodes = f.nodes.filter((each) => each.shardId !== 't1');
      });
      expect(kindsOf(gate(built))).toEqual(['unknown:target:t1']);
    });
  });

  describe('cluster-wide blockers', () => {
    it.each([
      [
        'a failed node anywhere',
        (f: PlacementGateFacts) => (nodeOf(f, 'u2').state = 'failed'),
        'unhealthy_node:cluster:u2',
      ],
      [
        'a suspect node anywhere',
        (f: PlacementGateFacts) => (nodeOf(f, 's2').state = 'suspect'),
        'unhealthy_node:cluster:s2',
      ],
      [
        'a running migration',
        (f: PlacementGateFacts) => (f.migrations = 'running'),
        'migration_running:cluster:',
      ],
      [
        'migrations that cannot be read',
        (f: PlacementGateFacts) => (f.migrations = 'unknown'),
        'unknown:cluster:',
      ],
      [
        'a cluster state that is not ok',
        (f: PlacementGateFacts) => (f.clusterStateOk = false),
        'cluster_state:cluster:',
      ],
      [
        'a cluster state that cannot be read',
        (f: PlacementGateFacts) => (f.clusterStateOk = null),
        'unknown:cluster:',
      ],
      [
        'a budget with no jobs left',
        (f: PlacementGateFacts) => (f.budget.jobsUsed = 4),
        'budget:cluster:',
      ],
      [
        'a budget with no bytes left',
        (f: PlacementGateFacts) => (f.budget.bytesUsed = 2 * 1024 ** 3),
        'budget:cluster:',
      ],
      ['a pause', (f: PlacementGateFacts) => (f.paused = true), 'paused:cluster:'],
      ['no support', (f: PlacementGateFacts) => (f.supported = false), 'unsupported:cluster:'],
      [
        'a read that failed',
        (f: PlacementGateFacts) => f.unreadable.push('open events'),
        'unknown:cluster:',
      ],
    ])('blocks on %s', (_, change, expected) => {
      const result = gate(facts(change));
      expect(result.allowed).toBe(false);
      expect(kindsOf(result)).toEqual([expected]);
    });

    it.each(
      [
        'cluster_state',
        'topology_divergence',
        'slot_migration_stuck',
        'orphaned_slot_keys',
        'ghost_membership',
      ].flatMap((metricType) => [null, 'u1', 's1'].map((nodeId) => ({ metricType, nodeId }))),
    )('blocks on an open $metricType event on $nodeId', ({ metricType, nodeId }) => {
      const built = facts((f) => f.openEvents.push({ metricType, nodeId, openedAt: NOW }));
      expect(kindsOf(gate(built))).toEqual([`${metricType}:cluster:`]);
    });

    it('lets a closed cluster-wide event through', () => {
      expect(gate(facts()).allowed).toBe(true);
    });
  });

  describe('a hot source and its own symptoms', () => {
    const symptom =
      (metricType: string, nodeId: string, openedAt: number) => (f: PlacementGateFacts) =>
        f.openEvents.push({ metricType, nodeId, openedAt });

    it.each([
      ['after the trigger fired', FIRED_AT + 60_000, true],
      ['when the trigger fired', FIRED_AT, true],
      ['before the trigger fired', FIRED_AT - 60_000, false],
    ])(
      'lets command_p99 on the source primary through when it opened %s',
      (_, openedAt, allowed) => {
        expect(gate(facts(symptom('command_p99', 's1', openedAt))).allowed).toBe(allowed);
      },
    );

    it('blocks a symptom on the source when the trigger has not fired', () => {
      const built = facts((f) => {
        symptom('command_p99', 's1', NOW)(f);
        f.sourceTriggerFiredAt = null;
      });
      expect(kindsOf(gate(built))).toEqual(['latency:source:s1']);
    });

    it('blocks the same symptom on the target after the trigger fired', () => {
      expect(kindsOf(gate(facts(symptom('command_p99', 't1', NOW))))).toEqual([
        'latency:target:t1',
      ]);
    });

    it('keeps the PING baseline on the source after the trigger fired', () => {
      const built = facts((f) => {
        symptom('command_p99', 's1', NOW)(f);
        f.pingP50Ms.s1 = 90;
      });
      expect(kindsOf(gate(built))).toEqual(['latency:source:s1']);
    });

    const incident =
      (
        recovery: string,
        signals: Array<[string, string | null, number]>,
        patterns: string[] = [],
      ) =>
      (f: PlacementGateFacts) =>
        f.incidents.push({
          recovery,
          patterns,
          signals: signals.map(([metricType, nodeId, openedAt]) => ({
            metricType,
            nodeId,
            openedAt,
          })),
        });

    it.each([
      [
        'only exempt source symptoms after the trigger',
        incident('active', [
          ['cpu_utilization', 's1', NOW],
          ['load_saturation', 's1', NOW],
        ]),
        [],
      ],
      [
        'an exempt symptom from before the trigger',
        incident('active', [['cpu_utilization', 's1', FIRED_AT - 1]]),
        ['incident:source:s1'],
      ],
      [
        'an exempt symptom and another signal',
        incident('active', [
          ['cpu_utilization', 's1', NOW],
          ['memory_used', 's1', NOW],
        ]),
        ['incident:source:s1'],
      ],
      [
        'a source symptom on the target',
        incident('recovering', [['cpu_utilization', 't1', NOW]]),
        ['incident:target:t1'],
      ],
      [
        'only ignored signals',
        incident('active', [
          ['hot_shard', 's1', NOW],
          ['slot_migration', 't1', NOW],
          ['placement_action', 't2', NOW],
        ]),
        [],
      ],
      ['a recovered incident', incident('recovered', [['memory_used', 't1', NOW]]), []],
      [
        'a degraded incident on a replica',
        incident('degraded', [['memory_used', 't2', NOW]]),
        ['incident:target:t2'],
      ],
      [
        'an incident of unknown recovery',
        incident('unknown', [['memory_used', 's2', NOW]]),
        ['incident:source:s2'],
      ],
      ['an incident on an unrelated node', incident('active', [['memory_used', 'u1', NOW]]), []],
      [
        'an incident that names no node',
        incident('active', [['memory_used', null, NOW]]),
        ['unknown:cluster:'],
      ],
      ['an ignored signal that names no node', incident('active', [['hot_shard', null, NOW]]), []],
      [
        'a recovered incident that names no node',
        incident('recovered', [['memory_used', null, NOW]]),
        [],
      ],
      [
        'a failover incident on the target',
        incident('active', [['replication_role', 't1', NOW]], ['node_failover']),
        ['failover:target:t1', 'incident:target:t1'],
      ],
    ])('reads an incident with %s', (_, change, expected) => {
      expect(kindsOf(gate(facts(change)))).toEqual(expected);
    });
  });

  describe('per-shard and per-purpose rules', () => {
    it('blocks an excluded source', () => {
      expect(kindsOf(gate(facts(), 'approve', settings({ excludedShardIds: ['s1'] })))).toEqual([
        'excluded:source:',
      ]);
    });

    it('blocks a plan whose slots all cooled down, not one with slots left', () => {
      expect(kindsOf(gate(facts((f) => (f.cooldownLeftSlots = 0))))).toEqual(['cooldown:source:']);
      expect(gate(facts((f) => (f.cooldownLeftSlots = 3))).allowed).toBe(true);
    });

    const outsideWindow = settings({
      maintenanceWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '02:00', durationMinutes: 60 }],
    });
    const autoOnly: Array<[string, PlacementGateFacts, PlacementSettings, string]> = [
      ['coverage', facts((f) => (nodeOf(f, 't2').collected = false)), settings(), 'coverage'],
      ['quarantined', facts((f) => (f.quarantinedShardIds = ['s1'])), settings(), 'quarantined'],
      ['outside_window', facts(), outsideWindow, 'outside_window'],
    ];

    it.each(autoOnly)('blocks %s in auto and warns in approve', (_, built, policy, kind) => {
      const auto = gate(built, 'auto', policy);
      expect(auto.allowed).toBe(false);
      expect(auto.blockers.map((each) => each.kind)).toEqual([kind]);
      const approve = gate(built, 'approve', policy);
      expect(approve.allowed).toBe(true);
      expect(approve.warnings.map((each) => each.kind)).toEqual([kind]);
    });

    it('names the nodes the monitor does not connect to', () => {
      const built = facts((f) => {
        nodeOf(f, 't2').collected = false;
        nodeOf(f, 's2').collected = false;
      });
      expect(gate(built).warnings).toEqual([
        expect.objectContaining({
          scope: 'source',
          detail: expect.stringContaining('10.0.0.2:7000'),
        }),
        expect.objectContaining({
          scope: 'target',
          detail: expect.stringContaining('10.0.0.4:7000'),
        }),
      ]);
    });

    it('ignores latency on the shard a rollback leaves, and keeps it on the shard it returns to', () => {
      const leaving = facts((f) => (f.pingP50Ms.s1 = 500));
      expect(gate(leaving, 'rollback')).toEqual({ allowed: true, blockers: [], warnings: [] });
      const returning = facts((f) => (f.pingP50Ms.t1 = 500));
      expect(kindsOf(gate(returning, 'rollback'))).toEqual(['latency:target:t1']);
    });

    it('holds a rollback back on what it cannot read', () => {
      const built = facts((f) => {
        f.nodes = [];
        f.migrations = 'unknown';
        f.clusterStateOk = null;
        f.unreadable = ['the open events', 'the cluster nodes'];
      });
      const result = gate(built, 'rollback');
      expect(result.allowed).toBe(false);
      expect(result.blockers.map((each) => each.kind)).toContain('unknown');
    });

    it('keeps only the safety blockers for a rollback', () => {
      const built = facts((f) => {
        f.budget.jobsUsed = 99;
        f.paused = true;
        f.quarantinedShardIds = ['s1'];
        f.cooldownLeftSlots = 0;
        f.openEvents.push(
          { metricType: 'ghost_membership', nodeId: null, openedAt: NOW },
          { metricType: 'topology_divergence', nodeId: null, openedAt: NOW },
          { metricType: 'persistence_child', nodeId: 't1', openedAt: NOW },
        );
        f.incidents.push({
          recovery: 'active',
          patterns: [],
          signals: [{ metricType: 'memory_used', nodeId: 't1', openedAt: NOW }],
        });
        nodeOf(f, 't2').collected = false;
      });
      const result = gate(built, 'rollback', outsideWindow);
      expect(kindsOf(result)).toEqual(['topology_divergence:cluster:', 'fork:target:t1']);
      expect(result.warnings).toEqual([]);
    });
  });
});

describe('insideMaintenanceWindow', () => {
  const monday = Date.UTC(2026, 10, 23);
  const at = (day: number, hour: number, minute = 0) =>
    monday + ((day * 24 + hour) * 60 + minute) * 60_000;

  it('reads no windows as any time', () => {
    expect(insideMaintenanceWindow([], at(0, 12))).toBe(true);
  });

  it('reads a window on its UTC day and start', () => {
    const windows = [{ days: [1], start: '02:00', durationMinutes: 60 }];
    expect(insideMaintenanceWindow(windows, at(0, 2, 30))).toBe(true);
    expect(insideMaintenanceWindow(windows, at(0, 3))).toBe(false);
    expect(insideMaintenanceWindow(windows, at(1, 2, 30))).toBe(false);
  });

  it('reads a window that crosses midnight into the next day', () => {
    const windows = [{ days: [0], start: '23:00', durationMinutes: 120 }];
    expect(insideMaintenanceWindow(windows, at(0, 0, 30))).toBe(true);
    expect(insideMaintenanceWindow(windows, at(0, 1, 30))).toBe(false);
  });
});
