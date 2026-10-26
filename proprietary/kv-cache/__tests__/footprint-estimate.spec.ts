import { buildSnapshot, evictedKeysDelta, layoutOf, type KeySample, type NodeObservation } from '../footprint-estimate';
import { classifyKey } from '../key-classifier';

const M = 'Qwen/Qwen2.5-0.5B-Instruct';
const key = (i: number, suffix = '', model = M, dtype = 'bfloat16') => `${model}@1@0@${(i + 1).toString(16)}@${dtype}${suffix}`;
const sample = (k: string, o: Partial<KeySample> = {}): KeySample => ({
  parsed: classifyKey(k)!,
  memoryBytes: 3_670_112,
  ttl: -1,
  siblingExists: null,
  ...o,
});
const parse = (keys: string[]) => keys.map((k) => classifyKey(k)!);
const memory = { usedMemory: 100_000_000, maxmemory: 0, maxmemoryPolicy: 'noeviction', evictedKeys: 0 };
const base = { connectionId: 'c', timestamp: 1, memory, evictedKeysDelta: null, evictedKeysIntervalMs: null, otherDbs: [], clientDetected: false };

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
    const node: NodeObservation = { scannedKeys: 12, matchedKeys: parse(keys), scanComplete: true, dbSize: 12, samples: keys.map((k) => sample(k)) };
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

  it('reports every node as scanned when no coverage is given', () => {
    const node: NodeObservation = { scannedKeys: 1, matchedKeys: [], scanComplete: true, dbSize: 1, samples: [] };
    expect(buildSnapshot({ ...base, nodes: [node, node] })).toMatchObject({ primariesScanned: 2, primariesTotal: 2 });
  });

  it('scales the footprint by the share of slots scanned but keeps the memory share of the scanned nodes', () => {
    const keys = Array.from({ length: 10 }, (_, i) => key(i));
    const node: NodeObservation = { scannedKeys: 10, matchedKeys: parse(keys), scanComplete: true, dbSize: 10, samples: keys.map((k) => sample(k)) };
    const s = buildSnapshot({ ...base, nodes: [node], coverage: { primariesScanned: 1, primariesTotal: 4, slotShare: 0.25 } });
    expect(s).toMatchObject({
      primariesScanned: 1,
      primariesTotal: 4,
      chunksEst: 40,
      bytesEst: 146_804_480,
      lmcacheMemoryShare: 0.367,
    });
    expect(s.perModel).toEqual([{ model: M, dtype: 'bfloat16', chunksEst: 40, bytesEst: 146_804_480 }]);
  });

  it('does not scale when the scanned slot share is unknown', () => {
    const keys = Array.from({ length: 10 }, (_, i) => key(i));
    const node: NodeObservation = { scannedKeys: 10, matchedKeys: parse(keys), scanComplete: true, dbSize: 10, samples: [] };
    const s = buildSnapshot({ ...base, nodes: [node], coverage: { primariesScanned: 1, primariesTotal: null, slotShare: null } });
    expect(s).toMatchObject({ chunksEst: 10, primariesScanned: 1, primariesTotal: null });
  });

  it('extrapolates from DBSIZE when the scan stopped early', () => {
    const keys = Array.from({ length: 4 }, (_, i) => key(i));
    const node: NodeObservation = { scannedKeys: 100, matchedKeys: parse(keys), scanComplete: false, dbSize: 1000, samples: [sample(keys[0], { memoryBytes: 1000 })] };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.chunksEst).toBe(40);
    expect(s.bytesEst).toBe(40_000);
    expect(s.scanComplete).toBe(false);
  });

  it('counts a two-key chunk once and measures orphans', () => {
    const keys = [key(0, 'kv_bytes'), key(0, 'metadata'), key(1, 'kv_bytes')];
    const node: NodeObservation = {
      scannedKeys: 3,
      matchedKeys: parse(keys),
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
    expect(s.orphanRatio).toBe(0.3333);
    expect(s.detected).toBe(false);
  });

  it('counts metadata whose kv_bytes was evicted as an orphan', () => {
    const keys = [key(0, 'metadata'), key(1, 'metadata'), key(2, 'kv_bytes')];
    const node: NodeObservation = {
      scannedKeys: 3,
      matchedKeys: parse(keys),
      scanComplete: true,
      dbSize: 3,
      samples: [
        sample(keys[0], { memoryBytes: 128, siblingExists: false }),
        sample(keys[1], { memoryBytes: null, siblingExists: false }),
        sample(keys[2], { siblingExists: true }),
      ],
    };
    expect(buildSnapshot({ ...base, nodes: [node] }).orphanRatio).toBe(0.6667);
  });

  it('measures orphans only over suffixed keys whose sibling probe answered', () => {
    const keys = [key(0, 'kv_bytes'), key(1, 'kv_bytes'), key(2, 'kv_bytes'), key(3, 'kv_bytes')];
    const node: NodeObservation = {
      scannedKeys: 4,
      matchedKeys: parse(keys),
      scanComplete: true,
      dbSize: 4,
      samples: [
        sample(keys[0], { siblingExists: true }),
        sample(keys[1], { siblingExists: null }),
        sample(keys[2], { siblingExists: null }),
        sample(keys[3], { siblingExists: null }),
      ],
    };
    expect(buildSnapshot({ ...base, nodes: [node] }).orphanRatio).toBe(0);
  });

  it('reports no orphan ratio when no sibling probe answered', () => {
    const keys = [key(0, 'kv_bytes'), key(1, 'kv_bytes')];
    const node: NodeObservation = {
      scannedKeys: 2,
      matchedKeys: parse(keys),
      scanComplete: true,
      dbSize: 2,
      samples: keys.map((k) => sample(k, { siblingExists: null })),
    };
    expect(buildSnapshot({ ...base, nodes: [node] }).orphanRatio).toBeNull();
  });

  it('ignores vanished keys and measures TTL coverage', () => {
    const keys = [key(0), key(1), key(2)];
    const node: NodeObservation = {
      scannedKeys: 3,
      matchedKeys: parse(keys),
      scanComplete: true,
      dbSize: 3,
      samples: [sample(keys[0]), sample(keys[1], { ttl: 3600 }), sample(keys[2], { ttl: -2, memoryBytes: null })],
    };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.sampledKeys).toBe(2);
    expect(s.noTtlRatio).toBe(0.5);
  });

  it('keeps samples whose MEMORY USAGE failed for TTL coverage', () => {
    const keys = [key(0), key(1), key(2)];
    const node: NodeObservation = {
      scannedKeys: 3,
      matchedKeys: parse(keys),
      scanComplete: true,
      dbSize: 3,
      samples: [
        sample(keys[0], { memoryBytes: null }),
        sample(keys[1], { memoryBytes: null, ttl: 3600 }),
        sample(keys[2], { memoryBytes: null, ttl: -2 }),
      ],
    };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.noTtlRatio).toBe(0.5);
    expect(s.bytesEst).toBeNull();
    expect(s.lmcacheMemoryShare).toBeNull();
    expect(s.chunksEst).toBe(3);
  });

  it('sizes a node without readable samples from the other nodes', () => {
    const n1: NodeObservation = { scannedKeys: 2, matchedKeys: parse([key(0), key(1)]), scanComplete: true, dbSize: 2, samples: [sample(key(0), { memoryBytes: 10 }), sample(key(1), { memoryBytes: 30 })] };
    const n2: NodeObservation = { scannedKeys: 2, matchedKeys: parse([key(2), key(3)]), scanComplete: true, dbSize: 2, samples: [sample(key(2), { memoryBytes: null }), sample(key(3), { memoryBytes: null })] };
    expect(buildSnapshot({ ...base, nodes: [n1, n2] }).bytesEst).toBe(80);
  });

  it('keeps the bytes of samples whose TTL is unknown but leaves them out of TTL coverage', () => {
    const keys = [key(0), key(1)];
    const node: NodeObservation = {
      scannedKeys: 2,
      matchedKeys: parse(keys),
      scanComplete: true,
      dbSize: 2,
      samples: [sample(keys[0], { memoryBytes: 100, ttl: null }), sample(keys[1], { memoryBytes: 300, ttl: 3600 })],
    };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.sampledKeys).toBe(2);
    expect(s.bytesEst).toBe(400);
    expect(s.noTtlRatio).toBe(0);
  });

  it('reports no TTL ratio when no sampled key answered TTL', () => {
    const keys = [key(0)];
    const empty: NodeObservation = { scannedKeys: 0, matchedKeys: [], scanComplete: true, dbSize: 0, samples: [] };
    const vanished: NodeObservation = {
      scannedKeys: 1,
      matchedKeys: parse(keys),
      scanComplete: true,
      dbSize: 1,
      samples: [sample(keys[0], { ttl: -2, memoryBytes: null })],
    };
    expect(buildSnapshot({ ...base, nodes: [empty] }).noTtlRatio).toBeNull();
    expect(buildSnapshot({ ...base, nodes: [vanished] }).noTtlRatio).toBeNull();
  });

  it('rounds the no-TTL ratio to four decimals', () => {
    const keys = Array.from({ length: 12 }, (_, i) => key(i));
    const node: NodeObservation = {
      scannedKeys: 12,
      matchedKeys: parse(keys),
      scanComplete: true,
      dbSize: 12,
      samples: keys.map((k, i) => sample(k, { ttl: i === 0 ? 3600 : -1 })),
    };
    expect(buildSnapshot({ ...base, nodes: [node] }).noTtlRatio).toBe(0.9167);
  });

  it('splits per model by sample share', () => {
    const a = [key(0), key(1), key(2)];
    const b = [key(3, '', 'other', 'half')];
    const node: NodeObservation = { scannedKeys: 4, matchedKeys: parse([...a, ...b]), scanComplete: true, dbSize: 4, samples: [...a, ...b].map((k) => sample(k, { memoryBytes: 100 })) };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.perModel).toEqual([
      { model: M, dtype: 'bfloat16', chunksEst: 3, bytesEst: 300 },
      { model: 'other', dtype: 'half', chunksEst: 1, bytesEst: 100 },
    ]);
  });

  it('scales each model by the sampling rate of the node it lives on', () => {
    const full: NodeObservation = {
      scannedKeys: 2,
      matchedKeys: parse([key(0), key(1)]),
      scanComplete: true,
      dbSize: 2,
      samples: [key(0), key(1)].map((k) => sample(k, { memoryBytes: 10 })),
    };
    const other = [key(2, '', 'other'), key(3, '', 'other')];
    const sampled: NodeObservation = {
      scannedKeys: 2,
      matchedKeys: parse(other),
      scanComplete: false,
      dbSize: 1000,
      samples: other.map((k) => sample(k, { memoryBytes: 10 })),
    };
    const s = buildSnapshot({ ...base, nodes: [full, sampled] });
    expect(s.chunksEst).toBe(1002);
    expect(s.perModel).toEqual([
      { model: 'other', dtype: 'bfloat16', chunksEst: 1000, bytesEst: 10_000 },
      { model: M, dtype: 'bfloat16', chunksEst: 2, bytesEst: 20 },
    ]);
  });

  it('splits chunks per model from the matched keys when MEMORY USAGE is denied', () => {
    const a = [key(0), key(1), key(2)];
    const b = [key(3, '', 'other', 'half')];
    const node: NodeObservation = {
      scannedKeys: 4,
      matchedKeys: parse([...a, ...b]),
      scanComplete: true,
      dbSize: 4,
      samples: [...a, ...b].map((k) => sample(k, { memoryBytes: null })),
    };
    expect(buildSnapshot({ ...base, nodes: [node] }).perModel).toEqual([
      { model: M, dtype: 'bfloat16', chunksEst: 3, bytesEst: null },
      { model: 'other', dtype: 'half', chunksEst: 1, bytesEst: null },
    ]);
  });

  it('counts a layerwise chunk once rather than once per layer', () => {
    const layers = 32;
    const layered = Array.from({ length: 4 }, (_, chunk) =>
      Array.from({ length: layers }, (_, layer) => `${key(chunk)}@${layer}`),
    ).flat();
    const node: NodeObservation = {
      scannedKeys: layered.length,
      matchedKeys: parse(layered),
      scanComplete: true,
      dbSize: layered.length,
      samples: layered.map((k) => sample(k, { memoryBytes: 10 })),
    };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.chunksEst).toBe(4);
    expect(s.bytesEst).toBe(layered.length * 10);
    expect(s.perModel).toEqual([{ model: M, dtype: 'bfloat16', chunksEst: 4, bytesEst: layered.length * 10 }]);
  });

  it('weighs layered keys per model when models mix layerwise and whole-chunk storage', () => {
    const layered = [0, 1].flatMap((chunk) => [0, 1, 2, 3].map((layer) => `${key(chunk)}@${layer}`));
    const whole = [key(10, '', 'other'), key(11, '', 'other')];
    const all = [...layered, ...whole];
    const node: NodeObservation = {
      scannedKeys: all.length,
      matchedKeys: parse(all),
      scanComplete: true,
      dbSize: all.length,
      samples: all.map((k) => sample(k, { memoryBytes: 10 })),
    };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s.chunksEst).toBe(4);
    expect(s.perModel.map(({ model, chunksEst }) => ({ model, chunksEst }))).toEqual([
      { model: M, chunksEst: 2 },
      { model: 'other', chunksEst: 2 },
    ]);
  });

  it('reports multiprocess adapter keys per model with an unknown dtype', () => {
    const hash = (i: number) => (i + 1).toString(16).padStart(64, '0');
    const keys = Array.from({ length: 6 }, (_, i) => `${M}@0000000${i % 2}@0@${hash(i)}`);
    const node: NodeObservation = { scannedKeys: 6, matchedKeys: parse(keys), scanComplete: true, dbSize: 6, samples: keys.map((k) => sample(k)) };
    const s = buildSnapshot({ ...base, nodes: [node] });
    expect(s).toMatchObject({ detected: true, layout: 'single_key', chunksEst: 6, orphanRatio: null });
    expect(s.perModel).toEqual([{ model: M, dtype: 'unknown', chunksEst: 6, bytesEst: 6 * 3_670_112 }]);
  });

  it('computes the eviction delta per node and treats a lower counter as a restart', () => {
    expect(evictedKeysDelta(undefined, new Map([['a', 5]]))).toBeNull();
    expect(evictedKeysDelta(new Map([['a', 20]]), new Map([['a', 50]]))).toBe(30);
    expect(evictedKeysDelta(new Map([['a', 20]]), new Map([['a', 5]]))).toBe(5);
    expect(evictedKeysDelta(new Map([['a', 20], ['b', 1000]]), new Map([['a', 25]]))).toBe(5);
    expect(evictedKeysDelta(new Map([['a', 20]]), new Map([['a', 20], ['b', 1000]]))).toBe(0);
    expect(evictedKeysDelta(new Map([['a', 20]]), new Map([['b', 1000]]))).toBeNull();
  });

  it('passes the eviction interval through only alongside a delta', () => {
    const node: NodeObservation = { scannedKeys: 0, matchedKeys: [], scanComplete: true, dbSize: 0, samples: [] };
    expect(buildSnapshot({ ...base, nodes: [node], evictedKeysDelta: 7, evictedKeysIntervalMs: 60_000 }).evictedKeysIntervalMs).toBe(60_000);
    expect(buildSnapshot({ ...base, nodes: [node], evictedKeysIntervalMs: 60_000 }).evictedKeysIntervalMs).toBeNull();
  });

  it('detects through the GLIDE client even with no keys', () => {
    const node: NodeObservation = { scannedKeys: 0, matchedKeys: [], scanComplete: true, dbSize: 0, samples: [] };
    const s = buildSnapshot({ ...base, nodes: [node], clientDetected: true });
    expect(s.detected).toBe(true);
    expect(s.layout).toBeNull();
    expect(s.bytesEst).toBe(0);
  });

  it('sums cluster nodes', () => {
    const n1: NodeObservation = { scannedKeys: 5, matchedKeys: parse([key(0), key(1)]), scanComplete: true, dbSize: 5, samples: [sample(key(0), { memoryBytes: 10 })] };
    const n2: NodeObservation = { scannedKeys: 5, matchedKeys: parse([key(2)]), scanComplete: true, dbSize: 5, samples: [sample(key(2), { memoryBytes: 30 })] };
    const s = buildSnapshot({ ...base, nodes: [n1, n2] });
    expect(s).toMatchObject({ scannedKeys: 10, matchedKeys: 3, chunksEst: 3, bytesEst: 50 });
  });

  it('weights each node sample by the keys it stands for when splitting per model', () => {
    const a = Array.from({ length: 100 }, (_, i) => key(i));
    const b = key(0, '', 'other', 'half');
    const n1: NodeObservation = { scannedKeys: 100, matchedKeys: parse(a), scanComplete: true, dbSize: 100, samples: [sample(a[0], { memoryBytes: 100 })] };
    const n2: NodeObservation = { scannedKeys: 1, matchedKeys: parse([b]), scanComplete: true, dbSize: 1, samples: [sample(b, { memoryBytes: 100 })] };
    const s = buildSnapshot({ ...base, nodes: [n1, n2] });
    expect(s.perModel).toEqual([
      { model: M, dtype: 'bfloat16', chunksEst: 100, bytesEst: 10_000 },
      { model: 'other', dtype: 'half', chunksEst: 1, bytesEst: 100 },
    ]);
  });
});
