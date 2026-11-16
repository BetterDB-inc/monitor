import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BASELINE_MS, LATE_GATE_MS, type LaneSpec, type NodeSpec, hashSeed, mulberry32, sleep } from './config';
import { createCluster, detectIptables } from './cluster';
import { exec } from './docker';
import type { HostWatch } from './host';
import { Recorder } from './recorder';
import { closeConnections, command } from './resp';
import type { Scenario, TrialContext, TrialMeta } from './scenarios';

export interface TrialRequest {
  lane: LaneSpec;
  scenario: Scenario;
  rep: number;
  seed: number;
  nodeTimeoutMs: number;
  file: string;
  host: HostWatch;
  attempt: number;
  dropped: string[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function vmLoad(nodes: NodeSpec[]): Promise<number> {
  for (const node of nodes) {
    try {
      return Number((await exec(node.container, ['cat', '/proc/loadavg'], 10_000)).split(' ')[0]);
    } catch {
      continue;
    }
  }
  return Number.NaN;
}

export function trialName(scenario: string, rep: number): string {
  return `${scenario}-${String(rep).padStart(3, '0')}`;
}

export async function runTrial(request: TrialRequest): Promise<TrialMeta> {
  const { lane, scenario, rep, nodeTimeoutMs } = request;
  const seed = hashSeed(request.seed, scenario.name, rep);
  const built = await createCluster(lane, nodeTimeoutMs);
  const iptables = await detectIptables(lane.nodes[0].container);
  const server = String(await command(lane.nodes[0].hostPort, ['INFO', 'server']));
  const recorder = new Recorder(lane.nodes);
  const meta: TrialMeta = {
    trial: trialName(scenario.name, rep),
    scenario: scenario.name,
    kind: scenario.kind,
    rep,
    lane: lane.lane,
    seed,
    nodeTimeoutMs,
    valkey: server.match(/valkey_version:(\S+)/)?.[1] ?? 'unknown',
    startedAt: new Date().toISOString(),
    nodes: lane.nodes.map((node) => ({
      name: node.name,
      id: built.ids[node.name],
      ip: node.ip,
      zone: node.zone,
      role: node.role,
      primary: node.primary,
    })),
    t0: 0,
    windowEnd: null,
    end: 0,
    targets: [],
    minority: [],
    cuts: [],
    events: [],
    buildMs: built.buildMs,
    late: { p50: 0, p99: 0, max: 0 },
    lateOk: true,
    attempt: request.attempt,
    dropped: request.dropped,
    host: { load: { start: 0, max: 0, end: 0 }, freePorts: { start: 0, min: 0, end: 0 }, vmLoad: { start: 0, end: 0 } },
  };
  const ctx: TrialContext = {
    lane,
    nodes: lane.nodes,
    ids: built.ids,
    slots: built.slots,
    random: mulberry32(seed),
    nodeTimeoutMs,
    iptables,
    recorder,
    meta,
  };

  await scenario.prepare?.(ctx);
  meta.host.vmLoad.start = await vmLoad(lane.nodes);
  const watchedFrom = (await request.host.sample()).at;
  recorder.start();
  try {
    await sleep(BASELINE_MS);
    await scenario.run(ctx);
    await sleep(scenario.tailMs);
  } finally {
    meta.end = recorder.now();
    await recorder.stop();
    await closeConnections([...lane.nodes, lane.joiner].map((node) => node.hostPort));
  }

  const starved = recorder.ticks.some((tick) =>
    Object.values(tick.nodes).some((sample) => !sample.ok && /EADDRNOTAVAIL|EMFILE/.test(sample.err)),
  );
  if (starved) throw new Error('the host ran out of local ports or sockets while recording');
  await request.host.sample();
  meta.host = { ...request.host.since(watchedFrom), vmLoad: { start: meta.host.vmLoad.start, end: await vmLoad(lane.nodes) } };
  const noisy = request.host.breach(meta.host.load.max, meta.host.freePorts.min);
  if (noisy) throw new Error(`the host was outside the limits while recording: ${noisy}`);
  const late = recorder.ticks.map((tick) => tick.late).sort((a, b) => a - b);
  meta.late = { p50: quantile(late, 0.5), p99: quantile(late, 0.99), max: late[late.length - 1] ?? 0 };
  meta.lateOk = meta.late.p99 <= LATE_GATE_MS;
  const lines = [JSON.stringify(meta), ...recorder.ticks.map((tick) => JSON.stringify(tick))];
  mkdirSync(dirname(request.file), { recursive: true });
  writeFileSync(request.file, gzipSync(lines.join('\n')));
  return meta;
}
