import { detectHfe } from '../analysis/hfe-detector';

function createMockClient(options: {
  hlens?: Record<string, number>;
  hrandfields?: Record<string, string[]>;
  hexpiretimes?: Record<string, number[]>;
  hexpireError?: Error;
} = {}) {
  const { hlens = {}, hrandfields = {}, hexpiretimes = {}, hexpireError } = options;

  const pipelineMock = (): Record<string, jest.Mock> => {
    const calls: Array<{ method: string; args: unknown[] }> = [];

    const self: Record<string, jest.Mock> = {
      hlen: jest.fn((...args: unknown[]) => { calls.push({ method: 'hlen', args }); return self; }),
      call: jest.fn((...args: unknown[]) => { calls.push({ method: 'call', args }); return self; }),
      exec: jest.fn().mockImplementation(() => {
        const results = calls.map(c => {
          if (c.method === 'hlen') {
            const key = c.args[0] as string;
            return [null, hlens[key] ?? 5];
          }
          if (c.method === 'call') {
            const cmd = String(c.args[0]).toUpperCase();
            if (cmd === 'HRANDFIELD') {
              const key = c.args[1] as string;
              return [null, hrandfields[key] ?? ['field1']];
            }
            if (cmd === 'HEXPIRETIME') {
              if (hexpireError) return [hexpireError, null];
              const key = c.args[1] as string;
              const field = c.args[4] as string;
              const times = hexpiretimes[key];
              if (times) {
                // Return the time for the specific field (just use first available)
                return [null, [times[0] ?? -1]];
              }
              return [null, [-1]];
            }
          }
          return [null, null];
        });
        return Promise.resolve(results);
      }),
    };
    return self;
  };

  return {
    pipeline: jest.fn().mockImplementation(pipelineMock),
  } as any;
}

describe('detectHfe', () => {
  it('should return hfeDetected: false when no hash keys provided', async () => {
    const client = createMockClient();
    const result = await detectHfe(client, [], 0);

    expect(result.hfeDetected).toBe(false);
    expect(result.sampledHashCount).toBe(0);
  });

  it('should detect HFE when HEXPIRETIME returns > 0', async () => {
    const client = createMockClient({
      hlens: { 'hash:1': 5 },
      hrandfields: { 'hash:1': ['f1'] },
      hexpiretimes: { 'hash:1': [1700000000] },
    });

    const result = await detectHfe(client, ['hash:1'], 100);

    expect(result.hfeDetected).toBe(true);
    expect(result.hfeSupported).toBe(true);
    expect(result.sampledHashCount).toBe(1);
  });

  it('should return hfeDetected: false when HEXPIRETIME returns -1', async () => {
    const client = createMockClient({
      hlens: { 'hash:1': 5 },
      hrandfields: { 'hash:1': ['f1'] },
      hexpiretimes: { 'hash:1': [-1] },
    });

    const result = await detectHfe(client, ['hash:1'], 100);

    expect(result.hfeDetected).toBe(false);
    expect(result.hfeSupported).toBe(true);
  });

  it('should skip oversized hashes (> 10K fields)', async () => {
    const client = createMockClient({
      hlens: { 'hash:big': 20_000, 'hash:small': 5 },
      hrandfields: { 'hash:small': ['f1'] },
      hexpiretimes: { 'hash:small': [-1] },
    });

    const result = await detectHfe(client, ['hash:big', 'hash:small'], 200);

    expect(result.hfeOversizedHashesSkipped).toBe(1);
    expect(result.sampledHashCount).toBe(1);
  });

  it('should set hfeSupported: false when HEXPIRETIME command errors', async () => {
    const client = createMockClient({
      hlens: { 'hash:1': 5 },
      hrandfields: { 'hash:1': ['f1'] },
      hexpireError: new Error('ERR unknown command `HEXPIRETIME`'),
    });

    const result = await detectHfe(client, ['hash:1'], 100);

    expect(result.hfeSupported).toBe(false);
    expect(result.hfeDetected).toBe(false);
  });

  it('should estimate hfeKeyCount from sample ratio', async () => {
    const client = createMockClient({
      hlens: { 'h:1': 5, 'h:2': 5 },
      hrandfields: { 'h:1': ['f1'], 'h:2': ['f2'] },
      hexpiretimes: { 'h:1': [1700000000], 'h:2': [-1] },
    });

    const result = await detectHfe(client, ['h:1', 'h:2'], 1000);

    expect(result.hfeDetected).toBe(true);
    // 1 out of 2 valid keys had HFE, total estimated = 1000
    // hfeKeyCount = round((1/2) * 1000) = 500
    expect(result.hfeKeyCount).toBe(500);
  });
});
