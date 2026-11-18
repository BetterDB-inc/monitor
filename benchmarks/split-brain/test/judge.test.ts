import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { Judge, type JudgedRound, type RaisedEvent, parseSlotMigrationJobs } from '../src/judge';
import { type ClusterNode, MetricsParser, TopologyDivergenceMonitor } from '../src/product';

const PRIMARIES: Record<string, { host: string; epoch: number; slots: string }> = {
  a: { host: '10.0.0.1', epoch: 1, slots: '0-5460' },
  b: { host: '10.0.0.2', epoch: 2, slots: '5461-10922' },
  c: { host: '10.0.0.3', epoch: 3, slots: '10923-16383' },
};
type LinePatch = { flags?: string; epoch?: number; slots?: string };

function rawView(myself: string, patch: Record<string, LinePatch> = {}): string {
  return Object.entries(PRIMARIES)
    .map(([id, node]) => {
      const flags = `${id === myself ? 'myself,' : ''}${patch[id]?.flags ?? 'master'}`;
      const epoch = patch[id]?.epoch ?? node.epoch;
      const slots = patch[id]?.slots ?? node.slots;
      return `${id} ${node.host}:6379@16379 ${flags} - 0 0 ${epoch} connected ${slots}`.trim();
    })
    .join('\n');
}

class Rig {
  now = 1_000_000;
  views: Record<string, Record<string, LinePatch>> = { a: {}, b: {}, c: {} };
  migrations: Record<string, unknown> = {};
  silent = new Set<string>();
  reads: string[] = [];
  events: RaisedEvent[] = [];
  open: string[] = [];
  last: JudgedRound | null = null;
  status = '';
  readonly options = { minRounds: 3, nodeTimeoutMs: 15_000, membershipMinAgeMs: 60_000 };
  private readonly monitor = new TopologyDivergenceMonitor();
  private readonly judge = new Judge(this.monitor, this.options);

  private view(id: string): ClusterNode[] {
    return MetricsParser.parseClusterNodes(rawView(id, this.views[id]));
  }

  async poll(): Promise<void> {
    const round = await this.monitor.poll({
      clusterKey: 'cluster',
      connectionId: 'conn-1',
      nodes: this.view('a'),
      at: this.now,
      intervalMs: 5_000,
      nodesPerZone: 1,
      randomNodes: 3,
      canRead: true,
      readView: async (node) => {
        this.reads.push(node.id);
        if (this.silent.has(node.id)) throw new Error('ECONNREFUSED');
        return this.view(node.id);
      },
    });
    if (!round) return;
    this.status = round.status;
    this.last = await this.judge.observe(round, async (ownerId, seen) => {
      if (this.silent.has(ownerId)) return null;
      const self = seen ?? this.view(ownerId).find((node) => node.flags.includes('myself')) ?? null;
      return { self, jobs: parseSlotMigrationJobs(this.migrations[ownerId] ?? []) };
    });
    this.events.push(...this.last.raised);
    this.open = this.last.open;
  }

  async rounds(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      this.now += 5_000;
      await this.poll();
    }
  }

  disputedSlots(): Array<number[][] | undefined> {
    return (this.last?.groups ?? []).flatMap((group) => group.disagreements.map((d) => d.slots));
  }
}

describe('restated service glue against the service spec cases', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
  });

  test('raises nothing while every sampled node tells the same story', async () => {
    await rig.rounds(5);
    assert.equal(rig.events.length, 0);
    assert.equal(rig.status, 'ok');
  });

  test('samples on its own round, not on every poll', async () => {
    await rig.poll();
    assert.deepEqual([...rig.reads].sort(), ['b', 'c']);
    rig.now += 1_000;
    await rig.poll();
    rig.now += 1_000;
    await rig.poll();
    assert.equal(rig.reads.length, 2);
    rig.now += 3_000;
    await rig.poll();
    assert.equal(rig.reads.length, 4);
  });

  test('raises one warning once a node has disagreed for the configured rounds', async () => {
    rig.views.b = { a: { epoch: 9 } };
    await rig.rounds(2);
    assert.equal(rig.events.length, 0);
    await rig.rounds(1);
    assert.equal(rig.events.length, 1);
    assert.equal(rig.events[0].severity, 'warning');
    assert.equal(rig.events[0].signature, 'topology_divergence:b');
    assert.deepEqual(rig.events[0].kinds, ['config_epoch']);
    await rig.rounds(4);
    assert.equal(rig.events.length, 1);
  });

  test('waits out the node timeout before reporting a disputed failure', async () => {
    rig.options.nodeTimeoutMs = 20_000;
    rig.views.b = { c: { flags: 'master,fail?' } };
    await rig.rounds(4);
    assert.equal(rig.events.length, 0);
    await rig.rounds(1);
    assert.equal(rig.events.length, 1);
    assert.deepEqual(rig.events[0].kinds, ['failure_flags']);
  });

  test('is critical when nodes disagree about who owns slots', async () => {
    rig.views.b = { a: { slots: '' }, b: { slots: '0-10922' } };
    await rig.rounds(3);
    assert.equal(rig.events.length, 1);
    assert.equal(rig.events[0].severity, 'critical');
  });

  test('replaces the warning with a critical when the same nodes start to dispute slot owners', async () => {
    rig.views.b = { c: { epoch: 9 } };
    await rig.rounds(3);
    assert.deepEqual(rig.events.map((event) => event.severity), ['warning']);
    rig.views.b = { c: { epoch: 9 }, a: { slots: '' }, b: { slots: '0-10922' } };
    await rig.rounds(3);
    assert.deepEqual(rig.events.map((event) => event.severity), ['warning', 'critical']);
    assert.equal(rig.events[1].replaces, true);
    assert.deepEqual(rig.open, ['topology_divergence:b']);
    rig.views.b = { c: { epoch: 9 } };
    await rig.rounds(4);
    assert.equal(rig.events.length, 2);
    assert.deepEqual(rig.open, ['topology_divergence:b']);
  });

  test('holds a slot dispute while an owner is still moving those slots', async () => {
    rig.views.b = { a: { slots: '' }, b: { slots: '0-10922' } };
    rig.migrations.b = [['name', 'job-1', 'state', 'running', 'slot_ranges', '0-5460']];
    await rig.rounds(6);
    assert.equal(rig.events.length, 0);
  });

  test('keeps the event open while the disagreement keeps coming back past the blind limit', async () => {
    rig.views.b = { a: { epoch: 9 } };
    await rig.rounds(3);
    assert.equal(rig.events.length, 1);
    for (let round = 0; round < 66; round++) {
      rig.views.b = round % 2 === 0 ? {} : { a: { epoch: 9 } };
      await rig.rounds(1);
    }
    assert.equal(rig.events.length, 1);
    assert.equal(rig.open.length, 1);
  });

  test('closes the event after the views agree for the configured rounds', async () => {
    rig.views.b = { a: { epoch: 9 } };
    await rig.rounds(3);
    rig.views.b = {};
    await rig.rounds(2);
    assert.equal(rig.open.length, 1);
    await rig.rounds(1);
    assert.equal(rig.open.length, 0);
  });

  test('keeps the event open while the dissenting node stops answering', async () => {
    rig.views.b = { a: { epoch: 9 } };
    await rig.rounds(3);
    rig.silent.add('b');
    await rig.rounds(6);
    assert.equal(rig.open.length, 1);
    assert.equal(rig.events.length, 1);
  });

  test('adds the slots that join an owner dispute once they have disagreed long enough', async () => {
    rig.views.b = { a: { slots: '100-5460' }, b: { slots: '0-99 5461-10922' } };
    await rig.rounds(3);
    assert.equal(rig.events.length, 1);
    assert.deepEqual(rig.disputedSlots(), [[[0, 99]]]);
    rig.views.b = { a: { slots: '' }, b: { slots: '0-10922' } };
    await rig.rounds(2);
    assert.deepEqual(rig.disputedSlots(), [[[0, 99]]]);
    await rig.rounds(1);
    assert.deepEqual(rig.disputedSlots(), [[[0, 5460]]]);
    assert.equal(rig.events.length, 1);
  });

  test('says it could not compare when no other node can be dialed', async () => {
    rig.silent = new Set(['b', 'c']);
    await rig.rounds(3);
    assert.equal(rig.events.length, 0);
    assert.equal(rig.status, 'insufficient_views');
  });
});
