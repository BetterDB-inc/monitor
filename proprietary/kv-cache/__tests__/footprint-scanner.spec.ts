import { hasLmcacheGlideClient, otherNonEmptyDbs, readMemoryStats, sampleLmcacheKeys, scanLmcacheKeys } from '../footprint-scanner';

const M = 'm/x';
const k = (i: number, s = '') => `${M}@1@0@${(i + 1).toString(16)}@bfloat16${s}`;

function scanClient(pages: Array<[string, string[]]>) {
  const call = jest.fn();
  for (const page of pages) call.mockResolvedValueOnce(page);
  return { call } as any;
}

describe('scanLmcacheKeys', () => {
  it('scans to cursor 0 and drops keys that only match the glob', async () => {
    const client = scanClient([['7', [k(0), 'a@b@c@d@e']], ['0', [k(1)]]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 200_000, maxMatched: 2000 }, 1500);
    expect(client.call).toHaveBeenCalledWith('SCAN', ['0', 'MATCH', '*@*@*@*@*', 'COUNT', '1000']);
    expect(result).toEqual({ scannedKeys: 1500, matchedKeys: [k(0), k(1)], scanComplete: true });
  });

  it('stops at the matched budget', async () => {
    const client = scanClient([['7', [k(0), k(1), k(2)]]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 200_000, maxMatched: 2 }, 10_000);
    expect(result).toEqual({ scannedKeys: 666, matchedKeys: [k(0), k(1)], scanComplete: false });
  });

  it('shrinks the scanned count in proportion when a completed scan is truncated', async () => {
    const client = scanClient([['0', [k(0), k(1), k(2), k(3)]]]);
    const result = await scanLmcacheKeys(client, { maxScanned: 200_000, maxMatched: 2 }, 1500);
    expect(result).toEqual({ scannedKeys: 750, matchedKeys: [k(0), k(1)], scanComplete: false });
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
    const samples = await sampleLmcacheKeys(client, [k(0, 'kv_bytes'), k(1), k(2)]);
    expect(pipeline.exists).toHaveBeenCalledWith(k(0, 'metadata'));
    expect(samples.map(({ memoryBytes, ttl, siblingExists }) => ({ memoryBytes, ttl, siblingExists }))).toEqual([
      { memoryBytes: 3670112, ttl: -1, siblingExists: false },
      { memoryBytes: 120, ttl: 50, siblingExists: null },
      { memoryBytes: null, ttl: -2, siblingExists: null },
    ]);
  });

  it('skips the pipeline for no keys', async () => {
    expect(await sampleLmcacheKeys({ getClient: () => { throw new Error('unused'); } } as any, [])).toEqual([]);
  });
});

describe('helpers', () => {
  it('detects a GLIDE LMCache client and tolerates CLIENT LIST failures', async () => {
    expect(await hasLmcacheGlideClient({ call: jest.fn().mockResolvedValue('id=1 lib-name=GlidePySync(lmcache:0.5.5) lib-ver=2.5.3\n') } as any)).toBe(true);
    expect(await hasLmcacheGlideClient({ call: jest.fn().mockResolvedValue('id=1 lib-name=redis-py\n') } as any)).toBe(false);
    expect(await hasLmcacheGlideClient({ call: jest.fn().mockRejectedValue(new Error('NOPERM')) } as any)).toBe(false);
  });

  it('reads memory stats and other databases', () => {
    const info = {
      memory: { used_memory: '100', maxmemory: '200', maxmemory_policy: 'volatile-lru' },
      stats: { evicted_keys: '7' },
      keyspace: { db0: { keys: 5, expires: 0, avg_ttl: 0 }, db3: { keys: 2, expires: 0, avg_ttl: 0 }, db4: { keys: 0, expires: 0, avg_ttl: 0 }, junk: 'x' },
    } as any;
    expect(readMemoryStats(info)).toEqual({ usedMemory: 100, maxmemory: 200, maxmemoryPolicy: 'volatile-lru', evictedKeys: 7 });
    expect(otherNonEmptyDbs(info, 0)).toEqual([3]);
  });
});
