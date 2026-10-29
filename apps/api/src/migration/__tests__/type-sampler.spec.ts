import { sampleKeyTypes } from '../analysis/type-sampler';

function createMockClient(keys: string[], types: Record<string, string> = {}) {
  let callCount = 0;
  return {
    scanBuffer: jest.fn().mockImplementation((_cursor: string, ..._args: unknown[]) => {
      if (callCount === 0) {
        callCount++;
        return Promise.resolve([Buffer.from('0'), keys.map(k => Buffer.from(k))]);
      }
      return Promise.resolve([Buffer.from('0'), []]);
    }),
    pipeline: jest.fn().mockReturnValue({
      type: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(
        keys.map(k => [null, types[k] ?? 'string']),
      ),
    }),
  } as any;
}

describe('sampleKeyTypes', () => {
  it('should return sampled keys with types for a single client', async () => {
    const client = createMockClient(['key:1', 'key:2', 'key:3'], {
      'key:1': 'string',
      'key:2': 'hash',
      'key:3': 'list',
    });

    const result = await sampleKeyTypes([client], 1000);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ key: 'key:1', rawKey: Buffer.from('key:1'), keyBytes: 5, type: 'string', clientIndex: 0 });
    expect(result[1]).toEqual({ key: 'key:2', rawKey: Buffer.from('key:2'), keyBytes: 5, type: 'hash', clientIndex: 0 });
    expect(result[2]).toEqual({ key: 'key:3', rawKey: Buffer.from('key:3'), keyBytes: 5, type: 'list', clientIndex: 0 });
  });

  it('should return empty array for empty database', async () => {
    const client = createMockClient([]);
    const result = await sampleKeyTypes([client], 1000);
    expect(result).toEqual([]);
  });

  it('should sample from multiple clients and merge results', async () => {
    const client1 = createMockClient(['a:1'], { 'a:1': 'string' });
    const client2 = createMockClient(['b:1'], { 'b:1': 'hash' });

    const result = await sampleKeyTypes([client1, client2], 1000);

    expect(result).toHaveLength(2);
    expect(result[0].clientIndex).toBe(0);
    expect(result[1].clientIndex).toBe(1);
  });

  it('should respect maxKeysPerNode limit', async () => {
    const keys = Array.from({ length: 100 }, (_, i) => `key:${i}`);
    // Return keys in two batches via cursor
    let callCount = 0;
    const client = {
      scanBuffer: jest.fn().mockImplementation(() => {
        if (callCount === 0) {
          callCount++;
          return Promise.resolve([Buffer.from('1'), keys.slice(0, 50).map(k => Buffer.from(k))]);
        }
        callCount++;
        return Promise.resolve([Buffer.from('0'), keys.slice(50).map(k => Buffer.from(k))]);
      }),
      pipeline: jest.fn().mockReturnValue({
        type: jest.fn().mockReturnThis(),
        exec: jest.fn().mockImplementation(function (this: any) {
          // Return types matching the number of .type() calls made
          const typeCallCount = this.type.mock.calls.length;
          return Promise.resolve(
            Array.from({ length: typeCallCount }, () => [null, 'string']),
          );
        }),
      }),
    } as any;

    const result = await sampleKeyTypes([client], 5);

    // Should stop at 5 keys (the maxKeysPerNode limit)
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('should call onProgress callback with increasing values', async () => {
    const client = createMockClient(['key:1', 'key:2']);
    const onProgress = jest.fn();

    await sampleKeyTypes([client], 1000, onProgress);

    expect(onProgress).toHaveBeenCalled();
    // onProgress is called with the count of keys scanned so far
    const calls = onProgress.mock.calls.map((c: number[]) => c[0]);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]).toBeGreaterThanOrEqual(calls[i - 1]);
    }
  });

  it('should mark type as unknown on pipeline error', async () => {
    const client = {
      scanBuffer: jest.fn().mockResolvedValue([Buffer.from('0'), [Buffer.from('key:1')]]),
      pipeline: jest.fn().mockReturnValue({
        type: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          [new Error('NOPERM'), null],
        ]),
      }),
    } as any;

    const result = await sampleKeyTypes([client], 1000);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unknown');
  });

  it('records the raw byte length of a binary key name', async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    const pipeline = {
      type: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 'string']]),
    };
    const client = {
      scanBuffer: jest.fn().mockResolvedValue([Buffer.from('0'), [raw]]),
      pipeline: jest.fn().mockReturnValue(pipeline),
    } as any;

    const result = await sampleKeyTypes([client], 1000);

    expect(result[0].keyBytes).toBe(4);
    expect(result[0].key).toBe(raw.toString());
    expect(result[0].rawKey).toBe(raw);
    expect(pipeline.type).toHaveBeenCalledWith(raw);
  });
});
