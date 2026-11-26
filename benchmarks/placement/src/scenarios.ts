import { type InstallFacts, type PrimaryReply, supportFacts } from './glue';
import { type LoadModel, evenShards, ownerOf } from './model';
import { judgePlacementSupport } from './product';
import { simulate } from './simulate';

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

export function runAll(): ScenarioResult[] {
  return [runB2(), ...B8_CASES.map(runB8Case)];
}
