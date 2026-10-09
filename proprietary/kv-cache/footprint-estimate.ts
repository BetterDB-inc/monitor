import type { KvCacheFootprintSnapshot, KvCacheLayout, KvCacheModelFootprint } from '@betterdb/shared';
import { classifyKey, isChunkKey, type ParsedLmcacheKey } from './key-classifier';

export interface KeySample {
  key: string;
  parsed: ParsedLmcacheKey;
  memoryBytes: number | null;
  ttl: number;
  siblingExists: boolean | null;
}

export interface NodeObservation {
  scannedKeys: number;
  matchedKeys: string[];
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

export interface SnapshotInput {
  connectionId: string;
  timestamp: number;
  nodes: NodeObservation[];
  memory: MemoryStats;
  previousEvictedKeys: number | null;
  otherDbs: number[];
  clientDetected: boolean;
}

export const DETECTION_MIN_MATCHES = 5;

const ratio = (value: number) => Math.round(value * 1e4) / 1e4;

export function pickSample<T>(items: T[], size: number): T[] {
  if (items.length <= size) return [...items];
  const stride = items.length / size;
  return Array.from({ length: size }, (_, i) => items[Math.floor(i * stride)]);
}

export function layoutOf(keys: ParsedLmcacheKey[]): KvCacheLayout | null {
  if (keys.length === 0) return null;
  const suffixed = keys.some((k) => k.suffix !== null);
  const plain = keys.some((k) => k.suffix === null);
  if (suffixed && plain) return 'mixed';
  return suffixed ? 'two_key' : 'single_key';
}

function isLive(sample: KeySample): boolean {
  return sample.memoryBytes !== null && sample.ttl !== -2;
}

function nodeTotals(
  node: NodeObservation,
  parsed: ParsedLmcacheKey[],
): { chunks: number; bytes: number } {
  const chunkKeys = parsed.filter(isChunkKey).length;
  const scale = node.scanComplete || node.scannedKeys === 0 ? 1 : node.dbSize / node.scannedKeys;
  const live = node.samples.filter(isLive);
  const mean =
    live.length === 0 ? 0 : live.reduce((sum, s) => sum + (s.memoryBytes ?? 0), 0) / live.length;
  return { chunks: chunkKeys * scale, bytes: parsed.length * scale * mean };
}

function splitPerModel(samples: KeySample[], chunks: number, bytes: number): KvCacheModelFootprint[] {
  const groups = new Map<string, { model: string; dtype: string; chunkSamples: number; bytes: number }>();
  for (const s of samples) {
    const id = `${s.parsed.model}|${s.parsed.dtype}`;
    const group = groups.get(id) ?? {
      model: s.parsed.model,
      dtype: s.parsed.dtype,
      chunkSamples: 0,
      bytes: 0,
    };
    if (isChunkKey(s.parsed)) group.chunkSamples += 1;
    group.bytes += s.memoryBytes ?? 0;
    groups.set(id, group);
  }
  const allChunkSamples = [...groups.values()].reduce((sum, g) => sum + g.chunkSamples, 0);
  const allBytes = [...groups.values()].reduce((sum, g) => sum + g.bytes, 0);
  return [...groups.values()]
    .map((g) => ({
      model: g.model,
      dtype: g.dtype,
      chunksEst: allChunkSamples === 0 ? 0 : Math.round((chunks * g.chunkSamples) / allChunkSamples),
      bytesEst: allBytes === 0 ? 0 : Math.round((bytes * g.bytes) / allBytes),
    }))
    .sort((a, b) => b.bytesEst - a.bytesEst);
}

export function buildSnapshot(input: SnapshotInput): KvCacheFootprintSnapshot {
  let chunks = 0;
  let bytes = 0;
  let scanned = 0;
  let matched = 0;
  const allParsed: ParsedLmcacheKey[] = [];
  const live: KeySample[] = [];
  for (const node of input.nodes) {
    const parsed = node.matchedKeys
      .map(classifyKey)
      .filter((p): p is ParsedLmcacheKey => p !== null);
    const totals = nodeTotals(node, parsed);
    chunks += totals.chunks;
    bytes += totals.bytes;
    scanned += node.scannedKeys;
    matched += parsed.length;
    allParsed.push(...parsed);
    live.push(...node.samples.filter(isLive));
  }
  const kvBytes = live.filter((s) => s.parsed.suffix === 'kv_bytes');
  const { usedMemory, maxmemory, maxmemoryPolicy, evictedKeys } = input.memory;
  const previous = input.previousEvictedKeys;
  return {
    connectionId: input.connectionId,
    timestamp: input.timestamp,
    detected: matched >= DETECTION_MIN_MATCHES || input.clientDetected,
    layout: layoutOf(allParsed),
    scannedKeys: scanned,
    matchedKeys: matched,
    sampledKeys: live.length,
    scanComplete: input.nodes.every((n) => n.scanComplete),
    chunksEst: Math.round(chunks),
    bytesEst: Math.round(bytes),
    usedMemory,
    maxmemory,
    maxmemoryPolicy,
    lmcacheMemoryShare: usedMemory > 0 ? ratio(Math.min(1, bytes / usedMemory)) : 0,
    noTtlRatio: live.length === 0 ? 0 : ratio(live.filter((s) => s.ttl === -1).length / live.length),
    orphanRatio:
      kvBytes.length === 0
        ? null
        : ratio(kvBytes.filter((s) => s.siblingExists === false).length / kvBytes.length),
    evictedKeysDelta:
      previous === null ? null : evictedKeys >= previous ? evictedKeys - previous : evictedKeys,
    otherDbs: input.otherDbs,
    perModel: splitPerModel(live, chunks, bytes),
  };
}
