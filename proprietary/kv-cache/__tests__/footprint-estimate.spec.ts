import { buildSnapshot, layoutOf, pickSample, type KeySample, type NodeObservation } from '../footprint-estimate';
import { classifyKey } from '../key-classifier';

const M = 'Qwen/Qwen2.5-0.5B-Instruct';
const key = (i: number, suffix = '', model = M, dtype = 'bfloat16') => `${model}@1@0@${(i + 1).toString(16)}@${dtype}${suffix}`;
const sample = (k: string, o: Partial<KeySample> = {}): KeySample => ({
  key: k,
  parsed: classifyKey(k)!,
  memoryBytes: 3_670_112,
  ttl: -1,
  siblingExists: null,
  ...o,
});
const memory = { usedMemory: 100_000_000, maxmemory: 0, maxmemoryPolicy: 'noeviction', evictedKeys: 0 };
const base = { connectionId: 'c', timestamp: 1, memory, previousEvictedKeys: null, otherDbs: [], clientDetected: false };

describe('pickSample', () => {
  it('returns everything under the size and strides above it', () => {
    expect(pickSample([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(pickSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)).toEqual([0, 2, 4, 6, 8]);
  });
});

describe('layoutOf', () => {
  it('detects each layout', () => {
    expect(layoutOf([])).toBeNull();
    expect(layoutOf([classifyKey(key(0))!])).toBe('single_key');
    expect(layoutOf([classifyKey(key(0, 'kv_bytes'))!, classifyKey(key(0, 'metadata'))!])).toBe('two_key');
    expect(layoutOf([classifyKey(key(0))!, classifyKey(key(1, 'kv_bytes'))!])).toBe('mixed');
  });
});

describe('buildSnapshot', () => {
  it('counts exactly when the scan completed', () => {
    const keys = Array.from({ length: 10 }, (_, i) => key(i));
    const node: NodeObservation = { scannedKeys: 12, matchedKeys: keys, scanComplete: true, dbSize: 12, samples: keys.map((k) => sample(k)) };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s).toMatchObject({
      detected: true,
      layout: 'single_key',
      scannedKeys: 12,
      matchedKeys: 10,
      sampledKeys: 10,
      scanComplete: true,
      chunksEst: 10,
      bytesEst: 36_701_120,
      lmcacheMemoryShare: 0.367,
      noTtlRatio: 1,
      orphanRatio: null,
    });
    expect(s.perModel).toEqual([{ model: M, dtype: 'bfloat16', chunksEst: 10, bytesEst: 36_701_120 }]);
  });

  it('extrapolates from DBSIZE when the scan stopped early', () => {
    const keys = Array.from({ length: 4 }, (_, i) => key(i));
    const node: NodeObservation = { scannedKeys: 100, matchedKeys: keys, scanComplete: false, dbSize: 1000, samples: [sample(keys[0], { memoryBytes: 1000 })] };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.chunksEst).toBe(40);
    expect(s.bytesEst).toBe(40_000);
    expect(s.scanComplete).toBe(false);
  });

  it('counts a two-key chunk once and measures orphans', () => {
    const keys = [key(0, 'kv_bytes'), key(0, 'metadata'), key(1, 'kv_bytes')];
    const node: NodeObservation = {
      scannedKeys: 3,
      matchedKeys: keys,
      scanComplete: true,
      dbSize: 3,
      samples: [
        sample(keys[0], { siblingExists: true }),
        sample(keys[1], { memoryBytes: 128, siblingExists: true }),
        sample(keys[2], { siblingExists: false }),
      ],
    };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.layout).toBe('two_key');
    expect(s.chunksEst).toBe(2);
    expect(s.orphanRatio).toBe(0.5);
    expect(s.detected).toBe(false);
  });

  it('ignores vanished keys and measures TTL coverage', () => {
    const keys = [key(0), key(1), key(2)];
    const node: NodeObservation = {
      scannedKeys: 3,
      matchedKeys: keys,
      scanComplete: true,
      dbSize: 3,
      samples: [sample(keys[0]), sample(keys[1], { ttl: 3600 }), sample(keys[2], { ttl: -2, memoryBytes: null })],
    };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.sampledKeys).toBe(2);
    expect(s.noTtlRatio).toBe(0.5);
  });

  it('rounds the no-TTL ratio to four decimals', () => {
    const keys = Array.from({ length: 12 }, (_, i) => key(i));
    const node: NodeObservation = {
      scannedKeys: 12,
      matchedKeys: keys,
      scanComplete: true,
      dbSize: 12,
      samples: keys.map((k, i) => sample(k, { ttl: i === 0 ? 3600 : -1 })),
    };
    expect(buildSnapshot({ ...base, nodes: [node] }).noTtlRatio).toBe(0.9167);
  });

  it('splits per model by sample share', () => {
    const a = [key(0), key(1), key(2)];
    const b = [key(3, '', 'other', 'float16')];
    const node: NodeObservation = { scannedKeys: 4, matchedKeys: [...a, ...b], scanComplete: true, dbSize: 4, samples: [...a, ...b].map((k) => sample(k, { memoryBytes: 100 })) };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.perModel).toEqual([
      { model: M, dtype: 'bfloat16', chunksEst: 3, bytesEst: 300 },
      { model: 'other', dtype: 'float16', chunksEst: 1, bytesEst: 100 },
    ]);
  });

  it('computes the eviction delta and treats a lower counter as a restart', () => {
    const node: NodeObservation = { scannedKeys: 0, matchedKeys: [], scanComplete: true, dbSize: 0, samples: [] };
    expect(buildSnapshot({ ...base, nodes: [node] }).evictedKeysDelta).toBeNull();
    expect(buildSnapshot({ ...base, nodes: [node], memory: { ...memory, evictedKeys: 50 }, previousEvictedKeys: 20 }).evictedKeysDelta).toBe(30);
    expect(buildSnapshot({ ...base, nodes: [node], memory: { ...memory, evictedKeys: 5 }, previousEvictedKeys: 20 }).evictedKeysDelta).toBe(5);
  });

  it('detects through the GLIDE client even with no keys', () => {
    const node: NodeObservation = { scannedKeys: 0, matchedKeys: [], scanComplete: true, dbSize: 0, samples: [] };
    const s = buildSnapshot({ ...base, nodes: [node], clientDetected: true });
    expect(s.detected).toBe(true);
    expect(s.layout).toBeNull();
    expect(s.bytesEst).toBe(0);
  });

  it('sums cluster nodes', () => {
    const n1: NodeObservation = { scannedKeys: 5, matchedKeys: [key(0), key(1)], scanComplete: true, dbSize: 5, samples: [sample(key(0), { memoryBytes: 10 })] };
    const n2: NodeObservation = { scannedKeys: 5, matchedKeys: [key(2)], scanComplete: true, dbSize: 5, samples: [sample(key(2), { memoryBytes: 30 })] };
    const s = buildSnapshot({ ...base, nodes: [n1, n2] });
    expect(s).toMatchObject({ scannedKeys: 10, matchedKeys: 3, chunksEst: 3, bytesEst: 50 });
  });
});
