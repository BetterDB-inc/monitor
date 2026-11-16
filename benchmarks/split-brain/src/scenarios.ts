import { type LaneSpec, type NodeSpec, VALKEY_PORT, ZONES, pick, shuffled, sleep } from './config';
import { startNode, waitAgreed, waitAnswering } from './cluster';
import { docker, exec, rootExec } from './docker';
import type { HostWindow } from './host';
import type { Recorder } from './recorder';
import { command } from './resp';

export type ScenarioKind = 'fault' | 'control';

export interface Cut {
  from: number;
  to: number | null;
  a: string[];
  b: string[];
}

export interface TrialMeta {
  trial: string;
  scenario: string;
  kind: ScenarioKind;
  rep: number;
  lane: number;
  seed: number;
  nodeTimeoutMs: number;
  valkey: string;
  startedAt: string;
  nodes: Array<{ name: string; id: string; ip: string; zone: string; role: string; primary?: string }>;
  t0: number;
  windowEnd: number | null;
  end: number;
  targets: string[];
  minority: string[];
  cuts: Cut[];
  events: Array<{ t: number; type: string; detail?: unknown }>;
  buildMs: number;
  late: { p50: number; p99: number; max: number };
  host: HostWindow & { vmLoad: { start: number; end: number } };
}

export interface TrialContext {
  lane: LaneSpec;
  nodes: NodeSpec[];
  ids: Record<string, string>;
  slots: Record<string, [number, number]>;
  random: () => number;
  nodeTimeoutMs: number;
  iptables: string;
  recorder: Recorder;
  meta: TrialMeta;
  joiner?: NodeSpec;
}

export interface Scenario {
  name: string;
  kind: ScenarioKind;
  tailMs: number;
  prepare?: (ctx: TrialContext) => Promise<void>;
  run: (ctx: TrialContext) => Promise<void>;
}

const names = (nodes: NodeSpec[]) => nodes.map((node) => node.name);
const primariesOf = (ctx: TrialContext) => ctx.nodes.filter((node) => node.role === 'primary');
const replicasOf = (ctx: TrialContext) => ctx.nodes.filter((node) => node.role === 'replica');

function mark(ctx: TrialContext, type: string, detail?: unknown): number {
  const t = ctx.recorder.now();
  ctx.meta.events.push({ t, type, detail });
  return t;
}

function inject(ctx: TrialContext, targets: NodeSpec[], detail?: unknown): void {
  ctx.meta.targets = names(targets);
  ctx.meta.t0 = mark(ctx, 'inject', detail);
}

function heal(ctx: TrialContext): void {
  ctx.meta.windowEnd = mark(ctx, 'heal');
}

async function block(ctx: TrialContext, a: NodeSpec[], b: NodeSpec[]): Promise<Cut> {
  const rules = (peers: NodeSpec[]) =>
    peers
      .map((peer) => `${ctx.iptables} -A INPUT -s ${peer.ip} -j DROP && ${ctx.iptables} -A OUTPUT -d ${peer.ip} -j DROP`)
      .join(' && ');
  const cut: Cut = { from: ctx.recorder.now(), to: null, a: names(a), b: names(b) };
  await Promise.all([
    ...a.map((node) => rootExec(node.container, rules(b))),
    ...b.map((node) => rootExec(node.container, rules(a))),
  ]);
  ctx.meta.cuts.push(cut);
  mark(ctx, 'cut', { a: cut.a, b: cut.b });
  return cut;
}

async function unblock(ctx: TrialContext, cut: Cut, nodes: NodeSpec[]): Promise<void> {
  await Promise.all(
    nodes.map((node) => rootExec(node.container, `${ctx.iptables} -F INPUT && ${ctx.iptables} -F OUTPUT`)),
  );
  cut.to = mark(ctx, 'uncut');
}

function partition(pickMinority: (ctx: TrialContext) => NodeSpec[], holdMs: number) {
  return async (ctx: TrialContext) => {
    const minority = pickMinority(ctx);
    const rest = ctx.nodes.filter((node) => !minority.includes(node));
    ctx.meta.minority = names(minority);
    inject(ctx, minority);
    const cut = await block(ctx, minority, rest);
    await sleep(holdMs);
    heal(ctx);
    await unblock(ctx, cut, ctx.nodes);
  };
}

async function startJoiner(ctx: TrialContext): Promise<void> {
  const joiner = { ...ctx.lane.joiner, zone: pick(ZONES, ctx.random) };
  await startNode(ctx.lane, joiner, ctx.nodeTimeoutMs);
  await waitAnswering([joiner], 30_000);
  ctx.joiner = joiner;
  ctx.ids[joiner.name] = String(await command(joiner.hostPort, ['CLUSTER', 'MYID']));
  ctx.meta.nodes.push({ name: joiner.name, id: ctx.ids[joiner.name], ip: joiner.ip, zone: joiner.zone, role: 'joiner' });
  ctx.recorder.addNode(joiner);
}

async function preloadKeys(ctx: TrialContext): Promise<void> {
  const seed = ctx.nodes[0];
  const out = await exec(
    seed.container,
    ['valkey-benchmark', '-h', seed.ip, '-p', String(VALKEY_PORT), '--cluster', '-t', 'set', '-n', '100000', '-r', '1000000', '-d', '256', '-P', '32', '-q'],
    120_000,
  );
  ctx.meta.events.push({ t: -1, type: 'preload', detail: out.split(/[\r\n]+/).filter((line) => line.trim()).pop()?.trim() });
}

function nextPrimary(ctx: TrialContext, name: string): NodeSpec {
  const primaries = primariesOf(ctx);
  return primaries[(primaries.findIndex((node) => node.name === name) + 1) % primaries.length];
}

export function scenarios(nodeTimeoutMs: number): Scenario[] {
  const holdMs = 60_000;
  return [
    {
      name: 'zone-partition',
      kind: 'fault',
      tailMs: 60_000,
      run: partition((ctx) => {
        const zone = pick(ZONES, ctx.random);
        return ctx.nodes.filter((node) => node.zone === zone);
      }, holdMs),
    },
    {
      name: 'minority-partition',
      kind: 'fault',
      tailMs: 60_000,
      run: partition((ctx) => {
        const first = pick(ctx.nodes, ctx.random);
        const second = pick(
          ctx.nodes.filter((node) => node.zone !== first.zone),
          ctx.random,
        );
        return [first, second];
      }, holdMs),
    },
    {
      name: 'killed-primary',
      kind: 'fault',
      tailMs: 30_000,
      run: async (ctx) => {
        const target = pick(primariesOf(ctx), ctx.random);
        ctx.meta.minority = [target.name];
        inject(ctx, [target]);
        await docker(['kill', target.container]);
        await sleep(holdMs);
      },
    },
    {
      name: 'paused-node',
      kind: 'fault',
      tailMs: 60_000,
      run: async (ctx) => {
        const target = pick(primariesOf(ctx), ctx.random);
        ctx.meta.minority = [target.name];
        inject(ctx, [target], { pauseMs: 3 * nodeTimeoutMs });
        await docker(['pause', target.container]);
        await sleep(3 * nodeTimeoutMs);
        await docker(['unpause', target.container]);
        mark(ctx, 'unpause');
      },
    },
    {
      name: 'flapping-node',
      kind: 'fault',
      tailMs: 60_000,
      run: async (ctx) => {
        const target = pick(primariesOf(ctx), ctx.random);
        const rest = ctx.nodes.filter((node) => node !== target);
        const halfMs = 1.5 * nodeTimeoutMs;
        ctx.meta.minority = [target.name];
        inject(ctx, [target], { cycles: 5, downMs: halfMs, upMs: halfMs });
        for (let cycle = 0; cycle < 5; cycle++) {
          const cut = await block(ctx, [target], rest);
          await sleep(halfMs);
          await unblock(ctx, cut, ctx.nodes);
          if (cycle < 4) await sleep(halfMs);
        }
        heal(ctx);
      },
    },
    {
      name: 'partial-join',
      kind: 'fault',
      tailMs: 60_000,
      prepare: startJoiner,
      run: async (ctx) => {
        const joiner = ctx.joiner as NodeSpec;
        const order = shuffled(ctx.nodes, ctx.random);
        const blocked = order.slice(0, Math.floor(ctx.nodes.length / 2));
        const via = order[order.length - 1];
        ctx.meta.minority = [joiner.name];
        const cut = await block(ctx, [joiner], blocked);
        inject(ctx, [joiner], { blocked: names(blocked), via: via.name });
        await command(via.hostPort, ['CLUSTER', 'MEET', joiner.ip, String(VALKEY_PORT)]);
        await sleep(150_000);
        heal(ctx);
        await unblock(ctx, cut, [joiner, ...blocked]);
      },
    },
    {
      name: 'idle',
      kind: 'control',
      tailMs: 60_000,
      run: async (ctx) => {
        inject(ctx, []);
        await sleep(holdMs);
      },
    },
    {
      name: 'manual-failover',
      kind: 'control',
      tailMs: 60_000,
      run: async (ctx) => {
        const target = pick(replicasOf(ctx), ctx.random);
        inject(ctx, [target]);
        const reply = await command(target.hostPort, ['CLUSTER', 'FAILOVER']);
        mark(ctx, 'failover', reply);
        await sleep(30_000);
      },
    },
    {
      name: 'slot-migration-atomic',
      kind: 'control',
      tailMs: 60_000,
      prepare: preloadKeys,
      run: async (ctx) => {
        const primaries = primariesOf(ctx);
        inject(ctx, primaries);
        for (const source of primaries) {
          const target = nextPrimary(ctx, source.name);
          const [start] = ctx.slots[source.name];
          const reply = await command(
            source.hostPort,
            ['CLUSTER', 'MIGRATESLOTS', 'SLOTSRANGE', String(start), String(start + 499), 'NODE', ctx.ids[target.name]],
            10_000,
          );
          mark(ctx, 'migrate', { from: source.name, to: target.name, slots: [start, start + 499], reply });
          await sleep(10_000);
        }
      },
    },
    {
      name: 'slot-migration-legacy',
      kind: 'control',
      tailMs: 60_000,
      prepare: preloadKeys,
      run: async (ctx) => {
        const source = pick(primariesOf(ctx), ctx.random);
        const target = nextPrimary(ctx, source.name);
        inject(ctx, [source, target]);
        const out = await exec(
          source.container,
          [
            'valkey-cli',
            '--cluster',
            'reshard',
            `${source.ip}:${VALKEY_PORT}`,
            '--cluster-from',
            ctx.ids[source.name],
            '--cluster-to',
            ctx.ids[target.name],
            '--cluster-slots',
            '4000',
            '--cluster-yes',
          ],
          300_000,
        );
        mark(ctx, 'reshard-done', out.split('\n').slice(-2).join(' ').slice(0, 200));
      },
    },
    {
      name: 'rolling-restart',
      kind: 'control',
      tailMs: 60_000,
      run: async (ctx) => {
        inject(ctx, ctx.nodes);
        for (const node of ctx.nodes) {
          mark(ctx, 'restart', node.name);
          await docker(['restart', '-t', '10', node.container]);
          const settled = await waitAgreed(ctx.nodes, ctx.nodes.length, 60_000);
          mark(ctx, 'restarted', { node: node.name, settled });
          await sleep(2_000);
        }
      },
    },
    {
      name: 'slow-node',
      kind: 'control',
      tailMs: 60_000,
      run: async (ctx) => {
        const target = pick(ctx.nodes, ctx.random);
        inject(ctx, [target], { delay: '800ms 200ms' });
        await rootExec(target.container, 'tc qdisc add dev eth0 root netem delay 800ms 200ms');
        await sleep(holdMs);
        await rootExec(target.container, 'tc qdisc del dev eth0 root');
        mark(ctx, 'delay-removed');
      },
    },
    {
      name: 'clean-join',
      kind: 'control',
      tailMs: 75_000,
      prepare: startJoiner,
      run: async (ctx) => {
        const joiner = ctx.joiner as NodeSpec;
        const via = pick(ctx.nodes, ctx.random);
        inject(ctx, [joiner], { via: via.name });
        await command(via.hostPort, ['CLUSTER', 'MEET', joiner.ip, String(VALKEY_PORT)]);
        await sleep(30_000);
      },
    },
  ];
}
