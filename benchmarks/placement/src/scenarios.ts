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

export async function runAll(): Promise<ScenarioResult[]> {
  return [runB2(), await runB2HashTag(false), await runB2HashTag(true), ...B8_CASES.map(runB8Case)];
}
