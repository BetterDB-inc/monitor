import { evenAllocation, neymanAllocation, splitBudget } from './allocation';
import type { AllocationInput } from './allocation';
import { adjustedSkewness, isHeavyTailed, sampleVariance } from './sample-stats';
import { estimate, likelyMissed } from './size-estimator';
import type { NodeSample, SamplerClient, Stratum } from './sample-types';

export const SAMPLE_BUDGET = 4000;
export const SAMPLE_DEADLINE_MS = 60_000;
export const SAMPLE_HARD_CAP = 50_000;
export const TARGET_RELATIVE_CI = 0.05;
export const CENSUS_FACTOR = 10;
export const HEAVY_TAIL_MIN_SAMPLES = 20_000;
const COCHRAN_FACTOR = 25;
export const BATCH_SIZE = 100;
export const PILOT_SHARE = 0.25;
export const PILOT_MIN = 200;
const CLASSIFY_BATCH = 1000;
const SCAN_COUNT = '1000';
const UNSUPPORTED = /unknown command|unknown subcommand|NOPERM|syntax error/i;

export class SamplerUnsupportedError extends Error {}

export interface SamplerNode {
  name: string;
  client: SamplerClient;
  ceiling?: number;
  otherDbKeys?: boolean;
}

export interface SamplerOptions {
  budget: number;
  deadlineMs: number;
  hardCap?: number;
  onProgress?: (sampled: number) => void;
}

type Reply = [Error | null, unknown];

interface TypePass {
  cursor: string;
  keys: Set<string>;
}

interface NodeState {
  name: string;
  dbSize: number;
  client: SamplerClient;
  deadline: number;
  ceiling?: number;
  otherDbKeys: boolean;
  seen: Set<string>;
  classified: Set<string>;
  sizes: Map<string, number[]>;
  census: Map<string, number>;
  exactCounts: Map<string, number>;
  typePasses: Map<string, TypePass>;
  unmeasured: number;
  wrapped: boolean;
  counter: { sampled: number };
  onProgress?: (sampled: number) => void;
  timedOut: boolean;
}

export async function sampleNodes(nodes: SamplerNode[], options: SamplerOptions): Promise<NodeSample[]> {
  const deadline = Date.now() + options.deadlineMs;
  const dbSizes = await Promise.all(nodes.map((node) => node.client.getDbSize()));
  const quotas = splitBudget(options.budget, dbSizes);
  const hardCap = options.hardCap ?? options.budget;
  const caps = hardCap > options.budget ? splitBudget(hardCap, dbSizes) : quotas;
  const counter = { sampled: 0 };
  return Promise.all(
    nodes.map((node, index) =>
      sampleNode(quotas[index], caps[index], {
        name: node.name,
        dbSize: dbSizes[index],
        client: node.client,
        deadline,
        ceiling: node.ceiling,
        otherDbKeys: node.otherDbKeys ?? false,
        seen: new Set(),
        classified: new Set(),
        sizes: new Map(),
        census: new Map(),
        exactCounts: new Map(),
        typePasses: new Map(),
        unmeasured: 0,
        wrapped: false,
        counter,
        onProgress: options.onProgress,
        timedOut: false,
      }),
    ),
  );
}

async function sampleNode(quota: number, cap: number, state: NodeState): Promise<NodeSample> {
  return { ...(await collect(quota, cap, state)), ceiling: state.ceiling, otherDbKeys: state.otherDbKeys };
}

async function collect(quota: number, cap: number, state: NodeState): Promise<NodeSample> {
  if (quota === 0) return { node: state.name, dbSize: state.dbSize, strata: [], exhausted: state.dbSize === 0, timedOut: false };
  const pilotQuota = Math.min(quota, Math.max(PILOT_MIN, Math.round(quota * PILOT_SHARE)));
  await pilot(state, pilotQuota, quota * CENSUS_FACTOR);
  if (state.wrapped) state.census.forEach((count, type) => state.exactCounts.set(type, count));
  if (state.wrapped && state.unmeasured === 0) return nodeResult(state, true);
  await grow(state, neymanAllocation(quota - sampledTotal(state), allocationInputs(state)));
  if (cap > quota) await extend(state, cap);
  return nodeResult(state, false);
}

async function grow(state: NodeState, extra: Map<string, number>): Promise<void> {
  for (const [type, additional] of extra) {
    if (additional === 0 || state.timedOut) continue;
    const exact = await topUp(state, type, sizesOf(state, type).length + additional);
    if (exact !== null) state.exactCounts.set(type, exact);
  }
}

async function extend(state: NodeState, cap: number): Promise<void> {
  while (!expired(state)) {
    const measured = sampledTotal(state);
    const sample = nodeResult(state, false);
    const hasUnmeasured = sample.strata.some((stratum) => stratum.sizes.length < stratum.estimatedKeys);
    if (measured >= cap || !hasUnmeasured) return;
    const { totalBytes, ci95Bytes } = estimate([sample], 0);
    const heavyShort = new Set(
      sample.strata.filter((stratum) => isHeavyTailed(stratum) && stratum.sizes.length < Math.min(stratum.estimatedKeys, HEAVY_TAIL_MIN_SAMPLES)).map((stratum) => stratum.type),
    );
    const missed = state.ceiling !== undefined && !state.otherDbKeys && likelyMissed(totalBytes, ci95Bytes, state.ceiling);
    if (totalBytes <= 0 || (ci95Bytes / totalBytes <= TARGET_RELATIVE_CI && ciTrusted(sample) && heavyShort.size === 0 && !missed)) return;
    const extra = Math.min(measured, cap - measured);
    const inputs = allocationInputs(state);
    await grow(
      state,
      missed ? evenAllocation(extra, inputs) : neymanAllocation(extra, inputs.filter((input) => heavyShort.size === 0 || heavyShort.has(input.type))),
    );
    if (sampledTotal(state) <= measured) return;
  }
}

function ciTrusted(sample: NodeSample): boolean {
  return sample.strata
    .filter((stratum) => stratum.estimatedKeys > stratum.sizes.length)
    .every((stratum) => stratum.sizes.length >= COCHRAN_FACTOR * adjustedSkewness(stratum.sizes) ** 2);
}

async function pilot(state: NodeState, pilotQuota: number, censusLimit: number): Promise<void> {
  let cursor = '0';
  let dropped = false;
  do {
    if (expired(state)) return;
    const [next, keys] = await scan(state.client, cursor, []);
    cursor = next;
    const fresh = keys.filter((key) => !state.classified.has(key));
    const page = fresh.slice(0, Math.max(0, censusLimit - state.classified.size));
    dropped ||= page.length < fresh.length;
    page.forEach((key) => state.classified.add(key));
    let index = 0;
    while (index < page.length && sampledTotal(state) < pilotQuota) {
      const take = Math.min(BATCH_SIZE, pilotQuota - sampledTotal(state));
      await measure(state, page.slice(index, index + take), null);
      index += take;
    }
    for (; index < page.length; index += CLASSIFY_BATCH) await classify(state, page.slice(index, index + CLASSIFY_BATCH));
  } while (cursor !== '0' && state.classified.size < censusLimit);
  state.wrapped = cursor === '0' && !dropped;
}

async function topUp(state: NodeState, type: string, target: number): Promise<number | null> {
  const pass = state.typePasses.get(type) ?? { cursor: '0', keys: new Set<string>() };
  state.typePasses.set(type, pass);
  do {
    if (expired(state)) return null;
    const [next, keys] = await scan(state.client, pass.cursor, ['TYPE', type]);
    pass.cursor = next;
    keys.forEach((key) => pass.keys.add(key));
    const fresh = keys.filter((key) => !state.seen.has(key));
    let index = 0;
    while (index < fresh.length && sizesOf(state, type).length < target) {
      const take = Math.min(BATCH_SIZE, target - sizesOf(state, type).length);
      await measure(state, fresh.slice(index, index + take), type);
      index += take;
    }
  } while (pass.cursor !== '0' && sizesOf(state, type).length < target);
  if (pass.cursor !== '0') return null;
  state.typePasses.delete(type);
  return pass.keys.size;
}

function raiseOnError(reply: Reply | undefined): void {
  if (!reply?.[0]) return;
  if (UNSUPPORTED.test(reply[0].message)) throw new SamplerUnsupportedError(reply[0].message);
  throw reply[0];
}

async function classify(state: NodeState, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const pipeline = state.client.getClient().pipeline();
  for (const key of keys) pipeline.call('TYPE', key);
  const executed = await pipeline.exec();
  if (!executed) throw new Error('Pipeline returned no replies');
  (executed as Reply[]).forEach((reply) => {
    raiseOnError(reply);
    const type = reply ? String(reply[1]) : 'none';
    if (type === 'none') return;
    state.census.set(type, (state.census.get(type) ?? 0) + 1);
    state.unmeasured += 1;
  });
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
    raiseOnError(typeReply);
    raiseOnError(memoryReply);
    const type = typeReply && !typeReply[0] ? String(typeReply[1]) : 'none';
    if (type === 'none') return;
    if (knownType === null) state.census.set(type, (state.census.get(type) ?? 0) + 1);
    const size = memoryReply && !memoryReply[0] && typeof memoryReply[1] === 'number' ? memoryReply[1] : null;
    if (size === null) return;
    const bucket = state.sizes.get(type);
    if (bucket) bucket.push(size);
    else state.sizes.set(type, [size]);
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

function buildStrata(state: NodeState): Stratum[] {
  const exactTotal = [...state.exactCounts.values()].reduce((sum, count) => sum + count, 0);
  const openObserved = [...state.census]
    .filter(([type]) => !state.exactCounts.has(type))
    .reduce((sum, [, count]) => sum + count, 0);
  const remaining = Math.max(openObserved, state.dbSize - exactTotal);
  const types = new Set([...state.census.keys(), ...state.exactCounts.keys()]);
  return [...types].map((type) => {
    const observed = state.census.get(type) ?? 0;
    const exactCount = state.exactCounts.get(type);
    const estimatedKeys = exactCount ?? (openObserved > 0 ? (remaining * observed) / openObserved : 0);
    return { type, estimatedKeys, exact: exactCount !== undefined, observed, sizes: [...sizesOf(state, type)] };
  });
}

function allocationInputs(state: NodeState): AllocationInput[] {
  return buildStrata(state).map((stratum) => ({
    type: stratum.type,
    estimatedKeys: stratum.estimatedKeys,
    std: Math.sqrt(sampleVariance(stratum.sizes)),
    sampled: stratum.sizes.length,
  }));
}

function nodeResult(state: NodeState, exhausted: boolean): NodeSample {
  return { node: state.name, dbSize: state.dbSize, strata: buildStrata(state), exhausted, timedOut: state.timedOut };
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
