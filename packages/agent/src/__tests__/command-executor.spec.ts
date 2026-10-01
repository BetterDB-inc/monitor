import type Valkey from 'iovalkey';
import type { KeyAnalyticsResult } from '@betterdb/shared';
import { CommandExecutor } from '../command-executor';

const DAY = 86400;

function fakeClient(idleByKey: Record<string, number>): Valkey {
  const keys = Object.keys(idleByKey);
  return {
    dbsize: jest.fn().mockResolvedValue(keys.length),
    scan: jest.fn().mockResolvedValue(['0', keys]),
    pipeline: jest.fn(() => {
      let key = '';
      const chain = {
        memory: (_sub: string, name: string) => {
          key = name;
          return chain;
        },
        object: () => chain,
        ttl: () => chain,
        type: () => chain,
        strlen: () => chain,
        llen: () => chain,
        hlen: () => chain,
        scard: () => chain,
        zcard: () => chain,
        xlen: () => chain,
        exec: async () => [
          [null, 100],
          [null, idleByKey[key]],
          [null, null],
          [null, -1],
          [null, 'string'],
          [null, 5],
        ],
      };
      return chain;
    }),
  } as unknown as Valkey;
}

describe('CommandExecutor COLLECT_KEY_ANALYTICS', () => {
  it('counts the sampled keys idle beyond a day per pattern', async () => {
    const executor = new CommandExecutor(
      fakeClient({
        'session:1': 10,
        'session:2': 20,
        'session:3': 30,
        'session:4': 10 * DAY,
        'user:1': 2 * DAY,
      }),
    );

    const raw = await executor.execute('COLLECT_KEY_ANALYTICS', [
      JSON.stringify({ sampleSize: 100, scanBatchSize: 100 }),
    ]);
    const result: KeyAnalyticsResult = JSON.parse(raw as string);

    const byPattern = Object.fromEntries(result.patterns.map((entry) => [entry.pattern, entry]));
    expect(byPattern['session:*'].totalIdleTime / byPattern['session:*'].count).toBeGreaterThan(DAY);
    expect(byPattern['session:*'].staleCount).toBe(1);
    expect(byPattern['user:*'].staleCount).toBe(1);
  });

  it('does not count a key idle for exactly a day as stale', async () => {
    const executor = new CommandExecutor(fakeClient({ 'job:1': DAY }));

    const raw = await executor.execute('COLLECT_KEY_ANALYTICS', [
      JSON.stringify({ sampleSize: 100, scanBatchSize: 100 }),
    ]);
    const result: KeyAnalyticsResult = JSON.parse(raw as string);

    expect(result.patterns[0].staleCount).toBe(0);
  });
});
