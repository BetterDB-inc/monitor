import { classifyKey } from '../key-classifier';
import { hasLmcacheGlideClient, readMemoryStats, sampleLmcacheKeys, scanLmcacheKeys } from '../footprint-scanner';
import { keySlot } from '../key-slot';

const M = 'm/x';
const k = (i: number, s = '') => `${M}@1@0@${(i + 1).toString(16)}@bfloat16${s}`;
const p = (...keys: string[]) => keys.map((key) => classifyKey(key)!);

function scanClient(pages: Array<[string, string[]]>) {
  const call = jest.fn();
  for (const page of pages) call.mockResolvedValueOnce(page);
  return { call } as any;
}

describe('scanLmcacheKeys', () => {
  it('scans to cursor 0 and keeps only LMCache keys', async () => {
    const client = scanClient([['7', [k(0), 'a@b@c@d@e', 'user:1']], ['0', [k(1)]]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 200_000, maxMatched: 2000 }, 1500);
    expect(client.call).toHaveBeenCalledWith('SCAN', ['0', 'COUNT', '1000']);
    expect(result).toEqual({ scannedKeys: 1500, matchedKeys: p(k(0), k(1)), scanComplete: true });
  });

  it('counts a key SCAN returns more than once only once', async () => {
    const client = scanClient([['7', [k(0), k(1)]], ['0', [k(1), k(0), k(2)]]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 200_000, maxMatched: 2000 }, 3);
    expect(result.matchedKeys.map((key) => key.key)).toEqual([k(0), k(1), k(2)]);
  });

  it('leaves tag/suffix ties to the caller, which sees every node of the run', async () => {
    const ambiguous = `${M}@1@0@1@bfloat16@kind%metadata`;
    const client = scanClient([['0', [ambiguous, `${M}@1@0@2@bfloat16@kind%decode`]]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 200_000, maxMatched: 2000 }, 2);
    expect(result.matchedKeys.map((key) => key.suffix)).toEqual(['metadata', null]);
  });

  it('stops at the matched budget', async () => {
    const client = scanClient([['7', [k(0), k(1), k(2)]]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 200_000, maxMatched: 2 }, 10_000);
    expect(result).toEqual({ scannedKeys: 2, matchedKeys: p(k(0), k(1)), scanComplete: false });
  });

  it('shrinks the scanned count in proportion when a completed scan is truncated', async () => {
    const client = scanClient([['0', [k(0), k(1), k(2), k(3)]]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 200_000, maxMatched: 2 }, 1500);
    expect(result).toEqual({ scannedKeys: 750, matchedKeys: p(k(0), k(1)), scanComplete: false });
  });

  it('measures coverage from the keys SCAN returned when it stops early', async () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `user:${i}`);
    const client = scanClient([['7', [k(0), ...filler(1499)]], ['8', [k(1), ...filler(1499)]], ['9', [k(2)]]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 2500, maxMatched: 2000 }, 100_000);
    expect(client.call).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ scannedKeys: 3000, matchedKeys: p(k(0), k(1)), scanComplete: false });
  });

  it('does not inflate coverage when SCAN returns fewer keys than COUNT', async () => {
    const client = scanClient([['7', [k(0)]], ['8', [k(1), 'user:1']]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 2000, maxMatched: 2000 }, 10_000);
    expect(result).toEqual({ scannedKeys: 3, matchedKeys: p(k(0), k(1)), scanComplete: false });
  });

  it('stops at the scanned budget', async () => {
    const client = scanClient([['7', []], ['8', []], ['9', []]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 2000, maxMatched: 2000 }, 10_000);
    expect(client.call).toHaveBeenCalledTimes(2);
    expect(result.scanComplete).toBe(false);
  });
});

describe('sampleLmcacheKeys', () => {
  it('reads memory, ttl and sibling existence in one pipeline', async () => {
    const pipeline = { call: jest.fn().mockReturnThis(), ttl: jest.fn().mockReturnThis(), exists: jest.fn().mockReturnThis(), exec: jest.fn() };
    pipeline.exec.mockResolvedValue([
      [null, 3670112], [null, -1], [null, 0],
      [null, 120], [null, 50],
      [null, null], [null, -2],
    ]);
    const client = { getClient: () => ({ pipeline: () => pipeline }) } as any;
    const samples = await sampleLmcacheKeys(client, p(k(0, 'kv_bytes'), k(1), k(2)));
    expect(pipeline.exists).toHaveBeenCalledWith(k(0, 'metadata'));
    expect(samples.map(({ memoryBytes, ttl, siblingExists }) => ({ memoryBytes, ttl, siblingExists }))).toEqual([
      { memoryBytes: 3670112, ttl: -1, siblingExists: false },
      { memoryBytes: 120, ttl: 50, siblingExists: null },
      { memoryBytes: null, ttl: -2, siblingExists: null },
    ]);
  });

  it('treats a cross-slot sibling probe rejected with MOVED as unknown, not orphaned', async () => {
    const pipeline = { call: jest.fn().mockReturnThis(), ttl: jest.fn().mockReturnThis(), exists: jest.fn().mockReturnThis(), exec: jest.fn() };
    pipeline.exec.mockResolvedValue([
      [null, 3670112], [null, -1], [new Error('MOVED 1234 10.0.0.2:6379'), null],
      [null, 3670112], [null, -1], [null, 1],
      [null, 3670112], [null, -1], [null, 0],
    ]);
    const client = { getClient: () => ({ pipeline: () => pipeline }) } as any;
    const samples = await sampleLmcacheKeys(client, p(k(0, 'kv_bytes'), k(1, 'kv_bytes'), k(2, 'kv_bytes')));
    expect(samples.map((s) => s.siblingExists)).toEqual([null, true, false]);
  });

  it('skips the sibling probe when the node does not own the sibling slot', async () => {
    const pipeline = { call: jest.fn().mockReturnThis(), ttl: jest.fn().mockReturnThis(), exists: jest.fn().mockReturnThis(), exec: jest.fn() };
    pipeline.exec.mockResolvedValue([
      [null, 3670112], [null, -1],
      [null, 3670112], [null, -1], [null, 1],
    ]);
    const client = { getClient: () => ({ pipeline: () => pipeline }) } as any;
    const owned = keySlot(k(1, 'metadata'));
    const samples = await sampleLmcacheKeys(client, p(k(0, 'kv_bytes'), k(1, 'kv_bytes')), (slot) => slot === owned);
    expect(pipeline.exists).toHaveBeenCalledTimes(1);
    expect(pipeline.exists).toHaveBeenCalledWith(k(1, 'metadata'));
    expect(samples.map((s) => s.siblingExists)).toEqual([null, true]);
  });

  it('reports an unknown TTL when the TTL call fails', async () => {
    const pipeline = { call: jest.fn().mockReturnThis(), ttl: jest.fn().mockReturnThis(), exists: jest.fn().mockReturnThis(), exec: jest.fn() };
    pipeline.exec.mockResolvedValue([[null, 120], [new Error('NOPERM'), null]]);
    const client = { getClient: () => ({ pipeline: () => pipeline }) } as any;
    const [sample] = await sampleLmcacheKeys(client, p(k(0)));
    expect(sample).toMatchObject({ memoryBytes: 120, ttl: null });
  });

  it('skips the pipeline for no keys', async () => {
    expect(await sampleLmcacheKeys({ getClient: () => { throw new Error('unused'); } } as any, [])).toEqual([]);
  });
});

describe('helpers', () => {
  it('detects a GLIDE LMCache client and tolerates CLIENT LIST failures', async () => {
    expect(await hasLmcacheGlideClient({ call: jest.fn().mockResolvedValue('id=1 db=0 lib-name=GlidePySync(lmcache:0.5.5) lib-ver=2.5.3\n') } as any, 0)).toBe(true);
    expect(await hasLmcacheGlideClient({ call: jest.fn().mockResolvedValue('id=1 db=0 lib-name=redis-py\n') } as any, 0)).toBe(false);
    expect(await hasLmcacheGlideClient({ call: jest.fn().mockRejectedValue(new Error('NOPERM')) } as any, 0)).toBe(false);
  });

  it('detects the bare lmcache tag LMCache falls back to', async () => {
    const list = (libName: string) => ({ call: jest.fn().mockResolvedValue(`id=1 db=0 lib-name=${libName} lib-ver=2.5.3\n`) }) as any;
    expect(await hasLmcacheGlideClient(list('GlidePySync(lmcache)'), 0)).toBe(true);
    expect(await hasLmcacheGlideClient(list('GlidePySync(lmcache:0.5.5)'), 0)).toBe(true);
    expect(await hasLmcacheGlideClient(list('GlidePySync(lmcachex)'), 0)).toBe(false);
    expect(await hasLmcacheGlideClient(list('GlidePySync(other)'), 0)).toBe(false);
  });

  it('only counts LMCache clients on the scanned database', async () => {
    const reply = [
      'id=1 addr=1.1.1.1:1 db=3 lib-name=GlidePySync(lmcache:0.5.5) lib-ver=2.5.3',
      'id=2 addr=1.1.1.1:2 db=0 lib-name=redis-py lib-ver=5',
      '',
    ].join('\n');
    const client = { call: jest.fn().mockResolvedValue(reply) } as any;
    expect(await hasLmcacheGlideClient(client, 0)).toBe(false);
    expect(await hasLmcacheGlideClient(client, 3)).toBe(true);
  });

  it('reads memory stats', () => {
    const info = {
      memory: { used_memory: '100', maxmemory: '200', maxmemory_policy: 'volatile-lru' },
      stats: { evicted_keys: '7' },
    } as any;
    expect(readMemoryStats(info)).toEqual({ usedMemory: 100, maxmemory: 200, maxmemoryPolicy: 'volatile-lru', evictedKeys: 7 });
  });
});
