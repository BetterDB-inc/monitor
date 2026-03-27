import { sampleKeyTypes } from '../analysis/type-sampler';

function createMockClient(keys: string[], types: Record<string, string> = {}) {
  let callCount = 0;
  return {
    scan: jest.fn().mockImplementation((_cursor: string, ..._args: unknown[]) => {
      if (callCount === 0) {
        callCount++;
        return Promise.resolve(['0', keys]);
      }
      return Promise.resolve(['0', []]);
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
    expect(result[0]).toEqual({ key: 'key:1', type: 'string', clientIndex: 0 });
    expect(result[1]).toEqual({ key: 'key:2', type: 'hash', clientIndex: 0 });
    expect(result[2]).toEqual({ key: 'key:3', type: 'list', clientIndex: 0 });
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
      scan: jest.fn().mockImplementation(() => {
        if (callCount === 0) {
          callCount++;
          return Promise.resolve(['1', keys.slice(0, 50)]);
        }
        callCount++;
        return Promise.resolve(['0', keys.slice(50)]);
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
      scan: jest.fn().mockResolvedValue(['0', ['key:1']]),
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
});
