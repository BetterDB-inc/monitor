import type { KvCacheFootprintSnapshot, KvCacheLayout, KvCacheModelFootprint } from '@betterdb/shared';
import { isChunkKey, type ParsedLmcacheKey } from './key-classifier';

export interface KeySample {
  parsed: ParsedLmcacheKey;
  memoryBytes: number | null;
  ttl: number | null;
  siblingExists: boolean | null;
}

export interface NodeObservation {
  scannedKeys: number;
  matchedKeys: ParsedLmcacheKey[];
  scanComplete: boolean;
  dbSize: number;
  samples: KeySample[];
}

export interface MemoryStats {
  usedMemory: number;
  maxmemory: number;
  maxmemoryPolicy: string;
  evictedKeys: number;
}

export interface ScanCoverage {
  primariesScanned: number;
  primariesTotal: number | null;
  slotShare: number | null;
}

export interface SnapshotInput {
  connectionId: string;
  timestamp: number;
  nodes: NodeObservation[];
  memory: MemoryStats;
  evictedKeysDelta: number | null;
  evictedKeysIntervalMs: number | null;
  otherDbs: number[];
  clientDetected: boolean;
  coverage?: ScanCoverage;
}

export const DETECTION_MIN_MATCHES = 5;

export function evictedKeysDelta(previous: Map<string, number> | undefined, current: Map<string, number>): number | null {
  if (!previous) return null;
  let delta: number | null = null;
  for (const [node, evicted] of current) {
    const before = previous.get(node);
    if (before === undefined) continue;
    delta = (delta ?? 0) + (evicted >= before ? evicted - before : evicted);
  }
  return delta;
}

const ratio = (value: number) => Math.round(value * 1e4) / 1e4;

export function layoutOf(keys: ParsedLmcacheKey[]): KvCacheLayout | null {
  if (keys.length === 0) return null;
  const suffixed = keys.some((k) => k.suffix !== null);
  const plain = keys.some((k) => k.suffix === null);
  if (suffixed && plain) return 'mixed';
  return suffixed ? 'two_key' : 'single_key';
}

function isPresent(sample: KeySample): boolean {
  return sample.ttl !== -2;
}

function isLive(sample: KeySample): boolean {
  return sample.memoryBytes !== null && isPresent(sample);
}

type LayerCounts = Map<string, number>;

function layerCounts(keys: ParsedLmcacheKey[]): LayerCounts {
  const layers = new Map<string, Set<number>>();
  for (const k of keys) {
    if (k.layer === null) continue;
    const seen = layers.get(k.model) ?? new Set<number>();
    seen.add(k.layer);
    layers.set(k.model, seen);
  }
  return new Map([...layers].map(([model, seen]) => [model, seen.size]));
}

function chunkWeight(parsed: ParsedLmcacheKey, layers: LayerCounts): number {
  if (!isChunkKey(parsed)) return 0;
  return parsed.layer === null ? 1 : 1 / (layers.get(parsed.model) ?? 1);
}

interface ModelTally {
  model: string;
  dtype: string;
  keys: number;
  chunks: number;
  sampledBytes: number;
  sampled: number;
}

const meanBytes = (samples: KeySample[]): number | null =>
  samples.length === 0 ? null : samples.reduce((sum, s) => sum + (s.memoryBytes ?? 0), 0) / samples.length;

const addBytes = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

function tallyFor(tallies: Map<string, ModelTally>, parsed: ParsedLmcacheKey): ModelTally {
  const id = `${parsed.model}|${parsed.dtype}`;
  const tally = tallies.get(id) ?? {
    model: parsed.model,
    dtype: parsed.dtype,
    keys: 0,
    chunks: 0,
    sampledBytes: 0,
    sampled: 0,
  };
  tallies.set(id, tally);
  return tally;
}

function nodeModels(node: NodeObservation, layers: LayerCounts, overallMean: number | null): KvCacheModelFootprint[] {
  const scale = node.scanComplete || node.scannedKeys === 0 ? 1 : node.dbSize / node.scannedKeys;
  const live = node.samples.filter(isLive);
  const nodeMean = meanBytes(live) ?? overallMean;
  const tallies = new Map<string, ModelTally>();
  for (const parsed of node.matchedKeys) {
    const tally = tallyFor(tallies, parsed);
    tally.keys += 1;
    tally.chunks += chunkWeight(parsed, layers);
  }
  for (const sample of live) {
    const tally = tallyFor(tallies, sample.parsed);
    tally.sampledBytes += sample.memoryBytes ?? 0;
    tally.sampled += 1;
  }
  return [...tallies.values()].map((t) => {
    const mean = t.sampled === 0 ? nodeMean : t.sampledBytes / t.sampled;
    return {
      model: t.model,
      dtype: t.dtype,
      chunksEst: t.chunks * scale,
      bytesEst: mean === null ? null : t.keys * scale * mean,
    };
  });
}

function scaleModel(m: KvCacheModelFootprint, factor: number): KvCacheModelFootprint {
  return { ...m, chunksEst: m.chunksEst * factor, bytesEst: m.bytesEst === null ? null : m.bytesEst * factor };
}

function mergeModels(models: KvCacheModelFootprint[]): KvCacheModelFootprint[] {
  const merged = new Map<string, KvCacheModelFootprint>();
  for (const m of models) {
    const id = `${m.model}|${m.dtype}`;
    const total = merged.get(id) ?? { model: m.model, dtype: m.dtype, chunksEst: 0, bytesEst: 0 };
    total.chunksEst += m.chunksEst;
    total.bytesEst = addBytes(total.bytesEst, m.bytesEst);
    merged.set(id, total);
  }
  return [...merged.values()]
    .map((m) => ({ ...m, chunksEst: Math.round(m.chunksEst), bytesEst: m.bytesEst === null ? null : Math.round(m.bytesEst) }))
    .sort((a, b) => (b.bytesEst ?? 0) - (a.bytesEst ?? 0) || b.chunksEst - a.chunksEst);
}

export function buildSnapshot(input: SnapshotInput): KvCacheFootprintSnapshot {
  const allParsed = input.nodes.flatMap((node) => node.matchedKeys);
  const allSamples = input.nodes.flatMap((node) => node.samples);
  const live = allSamples.filter(isLive);
  const present = allSamples.filter(isPresent);
  const ttlKnown = present.filter((s) => s.ttl !== null);
  const scanned = input.nodes.reduce((sum, node) => sum + node.scannedKeys, 0);
  const matched = allParsed.length;
  const layers = layerCounts(allParsed);
  const scannedTallies = input.nodes.flatMap((node) => nodeModels(node, layers, meanBytes(live)));
  const scannedBytes = scannedTallies.reduce<number | null>((sum, m) => addBytes(sum, m.bytesEst), 0);
  const coverage = input.coverage ?? {
    primariesScanned: input.nodes.length,
    primariesTotal: input.nodes.length,
    slotShare: 1,
  };
  const share = coverage.slotShare;
  const factor = share !== null && share > 0 && share < 1 ? 1 / share : 1;
  const nodeTallies = scannedTallies.map((m) => scaleModel(m, factor));
  const chunks = nodeTallies.reduce((sum, m) => sum + m.chunksEst, 0);
  const bytes = nodeTallies.reduce<number | null>((sum, m) => addBytes(sum, m.bytesEst), 0);
  const probed = present.filter((s) => s.parsed.suffix !== null && s.siblingExists !== null);
  const { usedMemory, maxmemory, maxmemoryPolicy } = input.memory;
  return {
    connectionId: input.connectionId,
    timestamp: input.timestamp,
    detected: matched >= DETECTION_MIN_MATCHES || input.clientDetected,
    layout: layoutOf(allParsed),
    scannedKeys: scanned,
    matchedKeys: matched,
    sampledKeys: live.length,
    scanComplete: input.nodes.every((n) => n.scanComplete),
    primariesScanned: coverage.primariesScanned,
    primariesTotal: coverage.primariesTotal,
    chunksEst: Math.round(chunks),
    bytesEst: bytes === null ? null : Math.round(bytes),
    usedMemory,
    maxmemory,
    maxmemoryPolicy,
    lmcacheMemoryShare:
      scannedBytes === null ? null : usedMemory > 0 ? ratio(Math.min(1, scannedBytes / usedMemory)) : 0,
    noTtlRatio: ttlKnown.length === 0 ? null : ratio(ttlKnown.filter((s) => s.ttl === -1).length / ttlKnown.length),
    orphanRatio:
      probed.length === 0
        ? null
        : ratio(probed.filter((s) => s.siblingExists === false).length / probed.length),
    evictedKeysDelta: input.evictedKeysDelta,
    evictedKeysIntervalMs: input.evictedKeysDelta === null ? null : input.evictedKeysIntervalMs,
    otherDbs: input.otherDbs,
    perModel: mergeModels(nodeTallies),
  };
}
