import { neymanAllocation, splitBudget } from './allocation';
import { sampleVariance } from './sample-stats';
import type { NodeSample, SamplerClient, Stratum } from './sample-types';

export const SAMPLE_BUDGET = 4000;
export const SAMPLE_DEADLINE_MS = 60_000;
export const BATCH_SIZE = 100;
export const PILOT_SHARE = 0.25;
export const PILOT_MIN = 200;
const SCAN_COUNT = '1000';
const UNSUPPORTED = /unknown command|unknown subcommand|NOPERM|syntax error/i;

export class SamplerUnsupportedError extends Error {}

export interface SamplerNode {
  name: string;
  client: SamplerClient;
}

export interface SamplerOptions {
  budget: number;
  deadlineMs: number;
  onProgress?: (sampled: number) => void;
}

type Reply = [Error | null, unknown];

interface NodeState {
  client: SamplerClient;
  deadline: number;
  seen: Set<string>;
  sizes: Map<string, number[]>;
  typeCounts: Map<string, number>;
  counter: { sampled: number };
  onProgress?: (sampled: number) => void;
  timedOut: boolean;
}

export async function sampleNodes(nodes: SamplerNode[], options: SamplerOptions): Promise<NodeSample[]> {
  const deadline = Date.now() + options.deadlineMs;
  const dbSizes = await Promise.all(nodes.map((node) => node.client.getDbSize()));
  const quotas = splitBudget(options.budget, dbSizes);
  const counter = { sampled: 0 };
  return Promise.all(
    nodes.map((node, index) =>
      sampleNode(node, dbSizes[index], quotas[index], {
        client: node.client,
        deadline,
        seen: new Set(),
        sizes: new Map(),
        typeCounts: new Map(),
        counter,
        onProgress: options.onProgress,
        timedOut: false,
      }),
    ),
  );
}

async function sampleNode(node: SamplerNode, dbSize: number, quota: number, state: NodeState): Promise<NodeSample> {
  if (quota === 0) return { node: node.name, dbSize, strata: [], exhausted: dbSize === 0, timedOut: false };
  const pilotQuota = Math.min(quota, Math.max(PILOT_MIN, Math.round(quota * PILOT_SHARE)));
  if (await pilot(state, pilotQuota)) return result(node.name, dbSize, state, new Map(state.typeCounts), true);
  const counts = estimateCounts(state, dbSize);
  const extra = neymanAllocation(
    quota - sampledTotal(state),
    [...counts].map(([type, estimatedKeys]) => ({
      type,
      estimatedKeys,
      std: Math.sqrt(sampleVariance(sizesOf(state, type))),
      sampled: sizesOf(state, type).length,
    })),
  );
  for (const [type, additional] of extra) {
    if (additional === 0 || state.timedOut) continue;
    const exact = await topUp(state, type, sizesOf(state, type).length + additional);
    if (exact !== null) counts.set(type, exact);
  }
  return result(node.name, dbSize, state, counts, false);
}

async function pilot(state: NodeState, quota: number): Promise<boolean> {
  let cursor = '0';
  do {
    if (expired(state)) return false;
    const [next, keys] = await scan(state.client, cursor, []);
    cursor = next;
    const fresh = keys.filter((key) => !state.seen.has(key));
    let index = 0;
    while (index < fresh.length && sampledTotal(state) < quota) {
      const take = Math.min(BATCH_SIZE, quota - sampledTotal(state));
      await measure(state, fresh.slice(index, index + take), null);
      index += take;
    }
    if (index < fresh.length) return false;
  } while (cursor !== '0');
  return true;
}

async function topUp(state: NodeState, type: string, target: number): Promise<number | null> {
  const ofType = new Set<string>();
  let cursor = '0';
  do {
    if (expired(state)) return null;
    const [next, keys] = await scan(state.client, cursor, ['TYPE', type]);
    cursor = next;
    keys.forEach((key) => ofType.add(key));
    const fresh = keys.filter((key) => !state.seen.has(key));
    let index = 0;
    while (index < fresh.length && sizesOf(state, type).length < target) {
      const take = Math.min(BATCH_SIZE, target - sizesOf(state, type).length);
      await measure(state, fresh.slice(index, index + take), type);
      index += take;
    }
    if (sizesOf(state, type).length >= target) return cursor === '0' && index >= fresh.length ? ofType.size : null;
  } while (cursor !== '0');
  return ofType.size;
}

async function measure(state: NodeState, keys: string[], knownType: string | null): Promise<void> {
  if (keys.length === 0) return;
  const pipeline = state.client.getClient().pipeline();
  for (const key of keys) {
    if (knownType === null) pipeline.call('TYPE', key);
    pipeline.call('MEMORY', 'USAGE', key, 'SAMPLES', '0');
  }
  const executed = await pipeline.exec();
  if (!executed) throw new Error('Pipeline returned no replies');
  const replies = executed as Reply[];
  const stride = knownType === null ? 2 : 1;
  keys.forEach((key, index) => {
    state.seen.add(key);
    const typeReply: Reply = knownType === null ? replies[index * stride] : [null, knownType];
    const memoryReply = replies[index * stride + stride - 1];
    for (const reply of [typeReply, memoryReply]) {
      if (!reply?.[0]) continue;
      if (UNSUPPORTED.test(reply[0].message)) throw new SamplerUnsupportedError(reply[0].message);
      throw reply[0];
    }
    const type = typeReply && !typeReply[0] ? String(typeReply[1]) : 'none';
    if (type === 'none') return;
    state.typeCounts.set(type, (state.typeCounts.get(type) ?? 0) + 1);
    const size = memoryReply && !memoryReply[0] && typeof memoryReply[1] === 'number' ? memoryReply[1] : null;
    if (size === null) return;
    state.sizes.set(type, [...sizesOf(state, type), size]);
    state.counter.sampled += 1;
  });
  state.onProgress?.(state.counter.sampled);
}

async function scan(client: SamplerClient, cursor: string, extra: string[]): Promise<[string, string[]]> {
  try {
    return (await client.call('SCAN', [cursor, 'COUNT', SCAN_COUNT, ...extra])) as [string, string[]];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (UNSUPPORTED.test(message)) throw new SamplerUnsupportedError(message);
    throw error;
  }
}

function estimateCounts(state: NodeState, dbSize: number): Map<string, number> {
  const typed = [...state.typeCounts.values()].reduce((sum, count) => sum + count, 0);
  return new Map([...state.typeCounts].map(([type, count]) => [type, typed > 0 ? (count / typed) * dbSize : 0]));
}

function result(node: string, dbSize: number, state: NodeState, counts: Map<string, number>, exhausted: boolean): NodeSample {
  const strata: Stratum[] = [...counts].map(([type, estimatedKeys]) => ({ type, estimatedKeys, sizes: sizesOf(state, type) }));
  return { node, dbSize, strata, exhausted, timedOut: state.timedOut };
}

function sizesOf(state: NodeState, type: string): number[] {
  return state.sizes.get(type) ?? [];
}

function sampledTotal(state: NodeState): number {
  return [...state.sizes.values()].reduce((sum, sizes) => sum + sizes.length, 0);
}

function expired(state: NodeState): boolean {
  if (Date.now() < state.deadline) return false;
  state.timedOut = true;
  return true;
}
