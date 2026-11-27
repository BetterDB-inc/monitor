import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hotShardAdvice, readHotShardKeys } from '../src/glue';
import { ownerOf } from '../src/model';
import { checkPin } from '../src/product';
import {
  B2_HOT_SLOT,
  B3_CASES,
  B8_CASES,
  b2Model,
  b2TagModel,
  readB2Advice,
  runAll,
  runB8Case,
} from '../src/scenarios';
import {
  GATE_FIRED_AT,
  GATE_PLACES,
  NODE_BLOCKER_CASES,
  type GateWorld,
  judgeGate,
  quietWorld,
} from '../src/gate';
import { simulate } from '../src/simulate';

let all: ReturnType<typeof runAll> | undefined;
const everyScenario = () => (all ??= runAll());

async function firesOf(variant: string): Promise<number[] | undefined> {
  const scenario = (await everyScenario()).find(
    (each) => each.id === 'B3' && each.variant === variant,
  );
  assert.ok(scenario, `no B3 scenario ${variant}`);
  return scenario.firesByDay;
}

test('the product files match the pin', () => {
  assert.doesNotThrow(() => checkPin());
});

test('every scenario passes', async () => {
  const failed = (await everyScenario())
    .filter((scenario) => !scenario.pass)
    .map(
      (scenario) =>
        `${scenario.id} ${scenario.variant}: ${scenario.checks
          .filter((each) => !each.pass)
          .map((each) => each.name)
          .join('; ')}`,
    );
  assert.deepEqual(failed, []);
});

test('a hot slot under the node CPU limit is not explained as key level', () => {
  const { verdicts } = simulate(b2Model(400_000), 10);
  assert.equal(verdicts.length, 1);
  assert.notEqual(verdicts[0].kind === 'no_plan' ? verdicts[0].reason : 'plan', 'key_level');
});

test('a wrong expectation fails the scenario', () => {
  const control = B8_CASES[0];
  const scenario = runB8Case({ ...control, reasons: ['acl'] });
  assert.equal(scenario.pass, false);
});

test('the provider override is put back after a case', () => {
  const before = process.env.MONITOR_PROVIDER_OVERRIDE;
  runB8Case(B8_CASES.find((entry) => entry.providerOverride !== undefined)!);
  assert.equal(process.env.MONITOR_PROVIDER_OVERRIDE, before);
});

test('the hot slot is the one the model loads', () => {
  const { verdicts } = simulate(b2Model(), 10);
  const verdict = verdicts[0];
  assert.equal(verdict.kind, 'no_plan');
  assert.deepEqual(verdict.kind === 'no_plan' ? verdict.pinnedSlots.map((slot) => slot.slot) : [], [
    B2_HOT_SLOT,
  ]);
});

test('the hash-tag variants run with and without LFU', async () => {
  const variants = (await everyScenario())
    .filter((scenario) => scenario.id === 'B2')
    .map((scenario) => scenario.variant);
  assert.deepEqual(variants, ['single hot key', 'hash tag, no LFU', 'hash tag, LFU']);
});

test('the names are listed once per top slot and the tags need no LFU', async () => {
  const { node, advice, keys } = await readB2Advice(b2TagModel(), false);
  const listed = node.sent.filter((args) => args[0] === 'CLUSTER');
  assert.equal(listed.length, 3);
  assert.equal(new Set(listed.map((args) => args[2])).size, 3);
  assert.equal(keys.keySource, 'unavailable');
  assert.deepEqual(
    advice.tags.map((tag) => [tag.slot, tag.tag]),
    [[B2_HOT_SLOT, '42']],
  );
});

test('a hot slot without a shared tag names none', async () => {
  const { advice } = await readB2Advice(b2Model(), true);
  assert.deepEqual(advice.tags, []);
  assert.deepEqual(advice.keyCountOutliers, []);
});

test('the advice keeps only the tags on slots the shard owns now, as in the service', async () => {
  const model = b2TagModel();
  const { tracker } = simulate(model, 10);
  const read = await readHotShardKeys(
    {
      async callBuffer() {
        return ['{cart}:1', '{cart}:2'].map((name) => Buffer.from(name));
      },
      pipeline() {
        return {
          call() {},
          async exec() {
            return [];
          },
        };
      },
    },
    [B2_HOT_SLOT],
  );
  const owner = ownerOf(model, B2_HOT_SLOT).nodeId;
  const other = model.shards.find((shard) => shard.nodeId !== owner)!.nodeId;
  assert.deepEqual(
    hotShardAdvice(tracker, owner, read).tags.map((tag) => tag.slot),
    [B2_HOT_SLOT],
  );
  assert.deepEqual(hotShardAdvice(tracker, other, read).tags, []);
});

test('the tags are kept when the frequency read fails, as in the service', async () => {
  const read = await readHotShardKeys(
    {
      async callBuffer() {
        return ['{cart}:1', '{cart}:2'].map((name) => Buffer.from(name));
      },
      pipeline() {
        return {
          call() {},
          async exec() {
            throw new Error('CLUSTERDOWN The cluster is down');
          },
        };
      },
    },
    [7],
  );
  assert.equal(read.keys.keySource, 'unavailable');
  assert.equal(
    read.keys.keyNote,
    'reading the keys from the hot primary failed: CLUSTERDOWN The cluster is down',
  );
  assert.deepEqual(
    read.hashTags.tags.map((tag) => [tag.slot, tag.tag]),
    [[7, 'cart']],
  );
});

test('a daily 20-min peak never fires the trigger and a 2-h peak fires once a day', async () => {
  const [short, , long] = B3_CASES;
  assert.deepEqual(await firesOf(short.variant), Array(short.days).fill(0));
  assert.deepEqual(await firesOf(long.variant), Array(long.days).fill(1));
});

test('a poll gap does not count as measured, and heavy bursts fire the trigger', async () => {
  const [, , , shortGap, longGap, spike, bursts] = B3_CASES;
  assert.deepEqual(await firesOf(shortGap.variant), Array(shortGap.days).fill(0));
  assert.deepEqual(await firesOf(longGap.variant), Array(longGap.days).fill(0));
  assert.deepEqual(await firesOf(spike.variant), Array(spike.days).fill(0));
  assert.deepEqual(await firesOf(bursts.variant), Array(bursts.days).fill(1));
});

test('a blocker on a node outside the plan never holds it back, and on the plan it does', async () => {
  const [failover] = NODE_BLOCKER_CASES;
  const outside = await judgeGate(
    worldWith((world) => failover.raise(world, GATE_PLACES['unrelated primary'])),
  );
  assert.equal(outside.allowed, true);
  const onTarget = await judgeGate(
    worldWith((world) => failover.raise(world, GATE_PLACES['target replica'])),
  );
  assert.deepEqual(
    onTarget.blockers.map((each) => [each.kind, each.scope, each.nodeId]),
    [['failover', 'target', 't2']],
  );
});

test('the hot shard command_p99 holds the move back only when it opened before the trigger fired', async () => {
  const p99 = (openedAt: number) =>
    judgeGate(
      worldWith((world) =>
        world.events.push({ metricType: 'command_p99', nodeId: 's1', openedAt }),
      ),
    );
  assert.equal((await p99(GATE_FIRED_AT)).allowed, true);
  assert.equal((await p99(GATE_FIRED_AT - 1)).allowed, false);
});

test('every B4 scenario is in the run', async () => {
  const variants = (await everyScenario()).filter((scenario) => scenario.id === 'B4').length;
  assert.equal(variants, NODE_BLOCKER_CASES.length + 4);
});

function worldWith(change: (world: GateWorld) => void): GateWorld {
  const world = quietWorld();
  change(world);
  return world;
}
