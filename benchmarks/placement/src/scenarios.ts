import {
  type InstallFacts,
  type PrimaryReply,
  hotShardAdvice,
  readHotShardKeys,
  supportFacts,
} from './glue';
import { type LoadModel, evenShards, ownerOf, slotKeys } from './model';
import {
  type HashTagAdvice,
  type HotKeyRead,
  type HotKeyReader,
  describeHashTags,
  judgePlacementSupport,
} from './product';
import {
  GATE_FIRED_AT,
  GATE_NOW,
  GATE_PLACES,
  type GateWorld,
  type NodeBlockerCase,
  NODE_BLOCKER_CASES,
  describeBlockers,
  judgeGate,
  quietWorld,
} from './gate';
import { simulate } from './simulate';
import { type PeakCase, runPeaks } from './sustain';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioResult {
  id: string;
  variant: string;
  checks: Check[];
  pass: boolean;
}

const MODES = ['observe', 'recommend', 'approve', 'auto'] as const;
type Mode = (typeof MODES)[number];

function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail };
}

function result(id: string, variant: string, checks: Check[]): ScenarioResult {
  return { id, variant, checks, pass: checks.every((each) => each.pass) };
}

export const B2_HOT_SLOT = 9189;
export const B2_HOT_SLOT_CPU = 930_000;

export function b2Model(hotSlotCpu = B2_HOT_SLOT_CPU): LoadModel {
  return {
    shards: evenShards(6),
    baseCpuUsecPerSlot: 60,
    baseBytesPerSlot: 400,
    keysPerSlot: 30,
    hotSlots: [{ slot: B2_HOT_SLOT, cpuUsecPerSecond: hotSlotCpu }],
  };
}

export function runB2(): ScenarioResult {
  const model = b2Model();
  const hotShard = ownerOf(model, B2_HOT_SLOT);
  const { hotShardIds, verdicts, balance } = simulate(model, 10);
  const shard = balance?.shards.find((each) => each.shardId === hotShard.nodeId);
  const slotShare = B2_HOT_SLOT_CPU / (shard?.cpuUsecPerSecond ?? Number.NaN);
  const verdict = verdicts[0];
  const plans = verdicts.filter((each) => each.kind === 'plan').length;
  const pinned = verdict?.kind === 'no_plan' ? verdict.pinnedSlots.map((slot) => slot.slot) : [];
  return result('B2', 'single hot key', [
    check(
      'the hot slot carries at least 85% of its shard',
      slotShare >= 0.85,
      `${Math.round(slotShare * 100)}% of ${shard?.address}`,
    ),
    check(
      'the shard is the only hot shard',
      hotShardIds.length === 1 && hotShardIds[0] === hotShard.nodeId,
      `hot: ${hotShardIds.join(', ') || 'none'}`,
    ),
    check(
      'the balance marks it over the trigger',
      shard?.overTrigger === true,
      `ratio ${shard?.ratio?.toFixed(2)} against a trigger of ${balance?.triggerRatio}`,
    ),
    check(
      'no action in any mode',
      plans === 0,
      `${plans} plan${plans === 1 ? '' : 's'} out of ${verdicts.length} verdicts`,
    ),
    check(
      'the explanation is key_level and names the slot',
      verdict?.kind === 'no_plan' &&
        verdict.reason === 'key_level' &&
        pinned.length === 1 &&
        pinned[0] === B2_HOT_SLOT,
      verdict?.kind === 'no_plan'
        ? `${verdict.reason}, pinned slots ${pinned.join(', ') || 'none'}`
        : (verdict?.kind ?? 'no verdict'),
    ),
  ]);
}

export const B2_TAG = '42';
export const B2_TAG_KEYS = 1200;
export const B2_HOT_KEY = `cart:{${B2_TAG}}:item:0`;

const LFU_OFF =
  'ERR An LFU maxmemory policy is not selected, access frequency not tracked. ' +
  'Please note that when switching between policies at runtime LRU and LFU data ' +
  'will take some time to adjust.';

export function b2TagModel(): LoadModel {
  return {
    ...b2Model(),
    hotSlots: [{ slot: B2_HOT_SLOT, cpuUsecPerSecond: B2_HOT_SLOT_CPU, keyCount: B2_TAG_KEYS }],
  };
}

function slotNames(model: LoadModel, slot: number): string[] {
  const tagged = model.hotSlots.some((each) => each.slot === slot && each.keyCount !== undefined);
  return Array.from({ length: slotKeys(model, slot) }, (_, index) =>
    tagged && index % 10 !== 9 ? `cart:{${B2_TAG}}:item:${index}` : `session:${slot}:${index}`,
  );
}

export interface FakeNode extends HotKeyReader {
  sent: Array<Array<string | number | Buffer>>;
}

function fakeNode(model: LoadModel, lfu: boolean): FakeNode {
  const sent: FakeNode['sent'] = [];
  return {
    sent,
    async callBuffer(...args) {
      sent.push(args);
      const [, , slot, count] = args as [string, string, number, number];
      return slotNames(model, slot)
        .slice(0, count)
        .map((name) => Buffer.from(name));
    },
    pipeline() {
      const names: Buffer[] = [];
      return {
        call(...args) {
          sent.push(args);
          names.push(args[2] as Buffer);
        },
        async exec() {
          return names.map((name): [Error | null, unknown] => {
            if (!lfu) return [new Error(LFU_OFF), null];
            return [null, name.toString() === B2_HOT_KEY ? 255 : 3];
          });
        },
      };
    },
  };
}

export interface B2Advice {
  node: FakeNode;
  keys: HotKeyRead;
  advice: HashTagAdvice;
  message: string;
  hotShardIds: string[];
  verdicts: ReturnType<typeof simulate>['verdicts'];
}

export async function readB2Advice(model: LoadModel, lfu: boolean): Promise<B2Advice> {
  const hotShard = ownerOf(model, B2_HOT_SLOT);
  const { tracker, hotShardIds, verdicts } = simulate(model, 10);
  const node = fakeNode(model, lfu);
  const topSlots = tracker.topSlots(hotShard.nodeId, 3).map((each) => each.slot);
  const read = await readHotShardKeys(node, topSlots);
  const advice = hotShardAdvice(tracker, hotShard.nodeId, read);
  return {
    node,
    keys: read.keys,
    advice,
    message: describeHashTags(advice),
    hotShardIds,
    verdicts,
  };
}

export async function runB2HashTag(lfu: boolean): Promise<ScenarioResult> {
  const { node, keys, advice, message, hotShardIds, verdicts } = await readB2Advice(
    b2TagModel(),
    lfu,
  );
  const verdict = verdicts[0];
  const tag = advice.tags.find((each) => each.slot === B2_HOT_SLOT);
  const listed = node.sent.filter((args) => args[0] === 'CLUSTER').length;
  const outlier = advice.keyCountOutliers.find((each) => each.slot === B2_HOT_SLOT);
  return result('B2', lfu ? 'hash tag, LFU' : 'hash tag, no LFU', [
    check(
      'the shard is hot and the explanation stays key_level',
      hotShardIds.length === 1 && verdict?.kind === 'no_plan' && verdict.reason === 'key_level',
      verdict?.kind === 'no_plan' ? verdict.reason : (verdict?.kind ?? 'no verdict'),
    ),
    check(
      'the hot slot names the shared tag',
      tag?.tag === B2_TAG && tag.share >= 0.5,
      tag ? `{${tag.tag}} on ${Math.round(tag.share * 100)}% of ${tag.keysSampled} names` : 'none',
    ),
    check(
      'the message tells the application to split the tag',
      message.includes(`{${B2_TAG}}`) && message.includes('Splitting that tag'),
      message.trim(),
    ),
    check(
      'the hot slot is named as crowded',
      outlier?.ratio != null && outlier.ratio >= 20,
      outlier ? `${outlier.keyCount} keys, ${Math.round(outlier.ratio ?? 0)}x the median` : 'none',
    ),
    check(
      'each top slot is listed once, for the tags and the hot keys together',
      listed === 3,
      `${listed} CLUSTER GETKEYSINSLOT`,
    ),
    lfu
      ? check(
          'the hot key leads the hot keys',
          keys.keySource === 'lfu' && keys.topKeys[0]?.key === B2_HOT_KEY,
          keys.topKeys[0] ? `${keys.topKeys[0].key} (freq ${keys.topKeys[0].freq})` : 'none',
        )
      : check(
          'the hot keys are unavailable but the tag is still named',
          keys.keySource === 'unavailable' && tag !== undefined,
          keys.keyNote ?? keys.keySource,
        ),
  ]);
}

function valkeyPrimary(index: number, version = '9.0.0', os = 'Linux 6.8.0 x86_64'): PrimaryReply {
  return {
    address: `10.0.0.${index}:6379`,
    info: { server: { valkey_version: version, redis_version: '7.2.4', os } },
    commandInfo: [['cluster|migrateslots', -4, ['admin'], 0, 0, 0]],
  };
}

function install(overrides: Partial<InstallFacts> = {}): InstallFacts {
  return {
    host: '10.0.0.1',
    clusterEnabled: true,
    perNodeConnections: false,
    dialsDataNodes: true,
    slotStatsTopN: 100,
    slotStatsCommand: true,
    primaries: [1, 2, 3].map((index) => valkeyPrimary(index)),
    rebalanceRefusal: null,
    env: { BETTERDB_SLOT_MIGRATION: 'true', STORAGE_TYPE: 'postgres' },
    signIn: true,
    ...overrides,
  };
}

interface SupportCase {
  variant: string;
  install: InstallFacts;
  providerOverride?: string;
  reasons: string[];
  available: Mode[];
}

export const B8_CASES: SupportCase[] = [
  {
    variant: 'self-hosted control',
    install: install(),
    reasons: [],
    available: ['observe', 'recommend', 'approve', 'auto'],
  },
  {
    variant: 'ElastiCache host name',
    install: install({ host: 'clustercfg.placement.ab12cd.use1.cache.amazonaws.com' }),
    reasons: ['provider_managed'],
    available: ['observe', 'recommend'],
  },
  {
    variant: 'provider override',
    install: install(),
    providerOverride: 'elasticache',
    reasons: ['provider_managed'],
    available: ['observe', 'recommend'],
  },
  {
    variant: 'self-hosted EC2 with Amazon Linux',
    install: install({
      host: 'ec2-3-80-12-34.compute-1.amazonaws.com',
      primaries: [1, 2, 3].map((index) =>
        valkeyPrimary(index, '9.0.0', 'Linux 6.1.0-amzn2023 Amazon Linux x86_64'),
      ),
    }),
    reasons: [],
    available: ['observe', 'recommend', 'approve', 'auto'],
  },
  {
    variant: 'NOPERM on a slot move',
    install: install({
      rebalanceRefusal:
        "NOPERM User monitor has no permissions to run the 'cluster|migrateslots' command",
    }),
    reasons: ['acl'],
    available: ['observe', 'recommend'],
  },
  {
    variant: 'renamed command',
    install: install({
      primaries: [valkeyPrimary(1), { ...valkeyPrimary(2), commandInfo: [null] }, valkeyPrimary(3)],
    }),
    reasons: ['command_unavailable'],
    available: ['observe', 'recommend'],
  },
  {
    variant: 'Valkey 8.1',
    install: install({ primaries: [1, 2, 3].map((index) => valkeyPrimary(index, '8.1.4')) }),
    reasons: ['server_version'],
    available: ['observe', 'recommend'],
  },
  {
    variant: 'METRICS_SLOT_STATS_TOP_N=0',
    install: install({ slotStatsTopN: 0 }),
    reasons: ['slot_stats_off'],
    available: ['observe'],
  },
  {
    variant: 'STORAGE_TYPE=memory',
    install: install({ env: { BETTERDB_SLOT_MIGRATION: 'true', STORAGE_TYPE: 'memory' } }),
    reasons: ['memory_storage'],
    available: ['observe', 'recommend'],
  },
];

function withOverride<T>(value: string | undefined, run: () => T): T {
  const before = process.env.MONITOR_PROVIDER_OVERRIDE;
  if (value === undefined) delete process.env.MONITOR_PROVIDER_OVERRIDE;
  else process.env.MONITOR_PROVIDER_OVERRIDE = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.MONITOR_PROVIDER_OVERRIDE;
    else process.env.MONITOR_PROVIDER_OVERRIDE = before;
  }
}

export function runB8Case(entry: SupportCase): ScenarioResult {
  const support = withOverride(entry.providerOverride, () =>
    judgePlacementSupport(supportFacts(entry.install)),
  );
  const reasons = support.issues.map((issue) => issue.reason);
  const available = MODES.filter((mode) => support.modes[mode].available);
  const refused = entry.reasons.length > 0;
  return result('B8', entry.variant, [
    check(
      'the verdict names the right reason',
      reasons.join(',') === entry.reasons.join(','),
      reasons.length > 0 ? support.issues.map((issue) => issue.detail).join(' ') : 'supported',
    ),
    check(
      'the right modes are available',
      available.join(',') === entry.available.join(','),
      available.join(', '),
    ),
    check(
      refused ? 'Approve and Auto are refused' : 'Approve and Auto are open',
      support.modes.approve.available === !refused && support.modes.auto.available === !refused,
      `approve ${support.modes.approve.blockedBy ?? 'open'}, auto ${support.modes.auto.blockedBy ?? 'open'}`,
    ),
  ]);
}

export interface B3Case extends PeakCase {
  variant: string;
  maxFiresPerDay: number;
}

export const B3_CASES: B3Case[] = [
  {
    variant: 'daily 20-min peak at 3x, 5 s poll',
    peakMinutes: 20,
    peakFactor: 3,
    pollSeconds: 5,
    days: 7,
    maxFiresPerDay: 0,
  },
  {
    variant: 'daily 20-min peak at 3x, 15 s poll',
    peakMinutes: 20,
    peakFactor: 3,
    pollSeconds: 15,
    days: 7,
    maxFiresPerDay: 0,
  },
  {
    variant: 'daily 2-h peak at 3x, 15 s poll',
    peakMinutes: 120,
    peakFactor: 3,
    pollSeconds: 15,
    days: 7,
    maxFiresPerDay: 1,
  },
  {
    variant: 'daily 20-min peak at 3x, no samples from minute 7 to 35 of it, 15 s poll',
    peakMinutes: 20,
    peakFactor: 3,
    pollSeconds: 15,
    days: 3,
    gap: { fromMinute: 7, toMinute: 35 },
    maxFiresPerDay: 0,
  },
  {
    variant: 'daily 5-min spike at 10x, 15 s poll',
    peakMinutes: 5,
    peakFactor: 10,
    pollSeconds: 15,
    days: 3,
    maxFiresPerDay: 0,
  },
  {
    variant: 'daily 2 h of 1-min bursts at 6x every 3 min, 15 s poll',
    peakMinutes: 120,
    peakFactor: 6,
    pollSeconds: 15,
    days: 3,
    bursts: { onMinutes: 1, everyMinutes: 3 },
    maxFiresPerDay: 1,
  },
];

export function runB3Case(entry: B3Case): ScenarioResult {
  const run = runPeaks(entry);
  const total = run.firesByDay.reduce((sum, fires) => sum + fires, 0);
  const worstDay = Math.max(...run.firesByDay);
  const checks = [
    check(
      entry.maxFiresPerDay === 0
        ? 'the trigger never fires'
        : 'the trigger fires at most once a day',
      worstDay <= entry.maxFiresPerDay,
      `fires per day ${run.firesByDay.join(', ')} over ${run.samples} samples (40 min before to 40 min after each peak, the rest of each day skipped); highest over share ${run.peakOverShare.toFixed(2)}`,
    ),
    check(
      'no other shard fires',
      run.otherShardFires === 0,
      `${run.otherShardFires} fires elsewhere`,
    ),
  ];
  if (entry.maxFiresPerDay > 0) {
    checks.push(
      check(
        'the long peak fires every day',
        run.firesByDay.every((fires) => fires === 1),
        `${total} fires in ${entry.days} days`,
      ),
    );
  }
  return result('B3', entry.variant, checks);
}

const blocks = (
  blockers: { kind: string; scope: string; nodeId?: string }[],
  kind: string,
  scope: string,
  nodeId?: string,
) =>
  blockers.some(
    (each) =>
      each.kind === kind &&
      each.scope === scope &&
      (nodeId === undefined || each.nodeId === nodeId),
  );

const worldWith = (change: (world: GateWorld) => void): GateWorld => {
  const world = quietWorld();
  change(world);
  return world;
};

export async function runB4NodeCase(entry: NodeBlockerCase): Promise<ScenarioResult> {
  const checks: Check[] = [];
  for (const place of entry.places) {
    const nodeId = GATE_PLACES[place];
    const gate = await judgeGate(worldWith((world) => entry.raise(world, nodeId)));
    const detail = `blockers ${describeBlockers(gate.blockers)}`;
    if (place === 'unrelated primary') {
      checks.push(check('a node outside the plan does not block', gate.allowed, detail));
    } else {
      const scope = place.startsWith('source') ? 'source' : 'target';
      checks.push(
        check(
          `blocks as ${entry.kind} on the ${place}`,
          blocks(gate.blockers, entry.kind, scope, nodeId),
          detail,
        ),
      );
    }
  }
  const cleared = await judgeGate(quietWorld());
  checks.push(
    check(
      'the plan runs once it clears',
      cleared.allowed,
      `blockers ${describeBlockers(cleared.blockers)}`,
    ),
  );
  return result('B4', entry.variant, checks);
}

async function gateChecks(
  cases: [
    string,
    (world: GateWorld) => void,
    (gate: Awaited<ReturnType<typeof judgeGate>>) => boolean,
    ('approve' | 'auto')?,
  ][],
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [name, change, expect, purpose] of cases) {
    const gate = await judgeGate(worldWith(change), purpose);
    checks.push(
      check(
        name,
        expect(gate),
        `blockers ${describeBlockers(gate.blockers)}; warnings ${describeBlockers(gate.warnings)}`,
      ),
    );
  }
  return checks;
}

export async function runB4ClusterWide(): Promise<ScenarioResult> {
  return result(
    'B4',
    'cluster-wide blockers',
    await gateChecks([
      [
        'a failed node outside the plan blocks',
        (world) => world.failed.add('u2'),
        (gate) => blocks(gate.blockers, 'unhealthy_node', 'cluster', 'u2'),
      ],
      [
        'a running slot migration blocks',
        (world) => (world.migrations = 'running'),
        (gate) => blocks(gate.blockers, 'migration_running', 'cluster'),
      ],
      [
        'a cluster state that is not ok blocks',
        (world) => (world.clusterStateOk = false),
        (gate) => blocks(gate.blockers, 'cluster_state', 'cluster'),
      ],
      [
        'an open topology_divergence event blocks',
        (world) =>
          world.events.push({
            metricType: 'topology_divergence',
            nodeId: 'u1',
            openedAt: GATE_NOW,
          }),
        (gate) => blocks(gate.blockers, 'topology_divergence', 'cluster'),
      ],
      [
        'a failover event that names no node blocks',
        (world) =>
          world.events.push({ metricType: 'failover_churn', nodeId: null, openedAt: GATE_NOW }),
        (gate) => blocks(gate.blockers, 'failover', 'cluster'),
      ],
      [
        '4 slot jobs in the last hour use the budget up',
        (world) => (world.jobsUsed = 4),
        (gate) => blocks(gate.blockers, 'budget', 'cluster'),
      ],
      [
        '3 slot jobs in the last hour leave room',
        (world) => (world.jobsUsed = 3),
        (gate) => gate.allowed,
      ],
    ]),
  );
}

export async function runB4Unknown(): Promise<ScenarioResult> {
  const unknown =
    (scope: string, nodeId?: string) => (gate: Awaited<ReturnType<typeof judgeGate>>) =>
      !gate.allowed && blocks(gate.blockers, 'unknown', scope, nodeId);
  return result(
    'B4',
    'reads that fail',
    await gateChecks([
      [
        'the open events cannot be read',
        (world) => world.unreadable.add('placementOpenEvents'),
        unknown('cluster'),
      ],
      [
        'the incidents cannot be read',
        (world) => world.unreadable.add('placementIncidents'),
        unknown('cluster'),
      ],
      [
        'the cluster nodes cannot be read',
        (world) => world.unreadable.add('readPlacementNodeFacts'),
        unknown('cluster'),
      ],
      [
        'CLUSTER INFO does not answer',
        (world) => (world.clusterStateOk = null),
        unknown('cluster'),
      ],
      [
        'the slot migration read does not answer',
        (world) => (world.migrations = 'unknown'),
        unknown('cluster'),
      ],
      [
        'PING on the target replica times out',
        (world) => world.pings.set('t2', null),
        unknown('target', 't2'),
      ],
      [
        'PING on an unrelated node is not read',
        (world) => world.pings.set('u1', null),
        (gate) => gate.allowed,
      ],
    ]),
  );
}

export async function runB4NotCollected(): Promise<ScenarioResult> {
  const off = (world: GateWorld) => world.uncollected.add('t2');
  return result(
    'B4',
    'a target replica the monitor does not connect to',
    await gateChecks([
      [
        'its quiet state runs with a coverage warning',
        off,
        (gate) => gate.allowed && blocks(gate.warnings, 'coverage', 'target', 't1'),
      ],
      [
        'Auto waits for coverage',
        off,
        (gate) => blocks(gate.blockers, 'coverage', 'target', 't1'),
        'auto',
      ],
      [
        'an event stored for it is not trusted',
        (world) => {
          off(world);
          world.events.push({ metricType: 'failover_churn', nodeId: 't2', openedAt: GATE_NOW });
        },
        (gate) => gate.allowed,
      ],
      [
        'a raised config epoch blocks as failover',
        (world) => {
          off(world);
          world.epochs.set('t2', 2);
        },
        (gate) => blocks(gate.blockers, 'failover', 'target', 't2'),
      ],
      [
        'a replica out of sync in INFO replication of its primary blocks',
        (world) => {
          off(world);
          world.outOfSync.add('t2');
        },
        (gate) => blocks(gate.blockers, 'replication_divergence', 'target', 't1'),
      ],
      [
        'a fork on it still blocks',
        (world) => {
          off(world);
          world.forks.add('t2');
        },
        (gate) => blocks(gate.blockers, 'fork', 'target', 't2'),
      ],
    ]),
  );
}

export async function runB4SourceSymptom(): Promise<ScenarioResult> {
  const before = GATE_FIRED_AT - 5 * 60_000;
  const after = GATE_FIRED_AT + 5 * 60_000;
  const p99 = (nodeId: string, openedAt: number) => (world: GateWorld) =>
    world.events.push({ metricType: 'command_p99', nodeId, openedAt });
  const inIncident = (nodeId: string, metricType: string, openedAt: number) => (world: GateWorld) =>
    world.incidents.push({
      recovery: 'active',
      patterns: [],
      signals: [{ metricType, nodeId, openedAt }],
    });
  return result(
    'B4',
    "the hot shard's own symptoms",
    await gateChecks([
      [
        'command_p99 on the hot shard after the trigger fired does not block',
        p99('s1', after),
        (gate) => gate.allowed,
      ],
      [
        'command_p99 on the hot shard before the trigger fired blocks',
        p99('s1', before),
        (gate) => blocks(gate.blockers, 'latency', 'source', 's1'),
      ],
      [
        'command_p99 on the hot shard blocks while the trigger has not fired',
        (world) => {
          p99('s1', after)(world);
          world.firedAt = null;
        },
        (gate) => blocks(gate.blockers, 'latency', 'source', 's1'),
      ],
      [
        'command_p99 on the target after the trigger fired blocks',
        p99('t1', after),
        (gate) => blocks(gate.blockers, 'latency', 'target', 't1'),
      ],
      [
        'an incident of load_saturation on the hot shard after the trigger does not block',
        inIncident('s1', 'load_saturation', after),
        (gate) => gate.allowed,
      ],
      [
        'an incident of cpu_utilization on the hot shard before the trigger blocks',
        inIncident('s1', 'cpu_utilization', before),
        (gate) => blocks(gate.blockers, 'incident', 'source', 's1'),
      ],
      [
        'an incident of load_saturation on the target blocks',
        inIncident('t1', 'load_saturation', after),
        (gate) => blocks(gate.blockers, 'incident', 'target', 't1'),
      ],
      [
        'an incident entry of the hot shard itself does not block',
        inIncident('s1', 'hot_shard', before),
        (gate) => gate.allowed,
      ],
    ]),
  );
}

export async function runB4(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const entry of NODE_BLOCKER_CASES) results.push(await runB4NodeCase(entry));
  results.push(
    await runB4ClusterWide(),
    await runB4Unknown(),
    await runB4NotCollected(),
    await runB4SourceSymptom(),
  );
  return results;
}

export async function runAll(): Promise<ScenarioResult[]> {
  return [
    runB2(),
    await runB2HashTag(false),
    await runB2HashTag(true),
    ...B3_CASES.map(runB3Case),
    ...(await runB4()),
    ...B8_CASES.map(runB8Case),
  ];
}
