import { sampleTtls } from '../analysis/ttl-sampler';

function createMockClient(ttls: number[]) {
  return {
    pipeline: jest.fn().mockReturnValue({
      pttl: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(
        ttls.map(t => [null, t]),
      ),
    }),
  } as any;
}

describe('sampleTtls', () => {
  it('should categorize a mix of persistent and expiring keys', async () => {
    const ttls = [
      -1,          // no expiry
      1_800_000,   // 30 min → expiresWithin1h
      7_200_000,   // 2 hours → expiresWithin24h
      259_200_000, // 3 days → expiresWithin7d
      864_000_000, // 10 days → expiresAfter7d
    ];
    const client = createMockClient(ttls);
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];

    const result = await sampleTtls(client, keys);

    expect(result.noExpiry).toBe(1);
    expect(result.expiresWithin1h).toBe(1);
    expect(result.expiresWithin24h).toBe(1);
    expect(result.expiresWithin7d).toBe(1);
    expect(result.expiresAfter7d).toBe(1);
    expect(result.sampledKeyCount).toBe(5);
  });

  it('should count all persistent keys when TTL = -1', async () => {
    const ttls = [-1, -1, -1];
    const client = createMockClient(ttls);

    const result = await sampleTtls(client, ['k1', 'k2', 'k3']);

    expect(result.noExpiry).toBe(3);
    expect(result.expiresWithin1h).toBe(0);
    expect(result.expiresWithin24h).toBe(0);
    expect(result.expiresWithin7d).toBe(0);
    expect(result.expiresAfter7d).toBe(0);
  });

  it('should count all keys expiring within 1h', async () => {
    const ttls = [60_000, 120_000, 300_000]; // 1min, 2min, 5min
    const client = createMockClient(ttls);

    const result = await sampleTtls(client, ['k1', 'k2', 'k3']);

    expect(result.expiresWithin1h).toBe(3);
    expect(result.noExpiry).toBe(0);
  });

  it('should return all buckets zero for empty key list', async () => {
    const client = createMockClient([]);

    const result = await sampleTtls(client, []);

    expect(result.noExpiry).toBe(0);
    expect(result.expiresWithin1h).toBe(0);
    expect(result.expiresWithin24h).toBe(0);
    expect(result.expiresWithin7d).toBe(0);
    expect(result.expiresAfter7d).toBe(0);
    expect(result.sampledKeyCount).toBe(0);
  });

  it('should skip TTL = -2 (key gone) instead of counting as noExpiry', async () => {
    const ttls = [-2, -1];
    const client = createMockClient(ttls);

    const result = await sampleTtls(client, ['gone', 'persistent']);

    expect(result.noExpiry).toBe(1);
  });

  it('should skip pipeline errors instead of counting as noExpiry', async () => {
    const client = {
      pipeline: jest.fn().mockReturnValue({
        pttl: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          [new Error('ERR'), null],
          [null, 60_000],
        ]),
      }),
    } as any;

    const result = await sampleTtls(client, ['k1', 'k2']);

    expect(result.noExpiry).toBe(0);
    expect(result.expiresWithin1h).toBe(1);
  });
});
