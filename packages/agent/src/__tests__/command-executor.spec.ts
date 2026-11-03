import type Valkey from 'iovalkey';
import type { KeyAnalyticsResult } from '@betterdb/shared';
import { CommandExecutor } from '../command-executor';

const DAY = 86400;

type Reply = [Error | null, unknown];

// Answers each queued command, so tests can assert which commands were sent.
function fakeClient(
  idleByKey: Record<string, number>,
  opts: { types?: Record<string, string>; reply?: (command: string, key: string) => Reply; sent?: string[] } = {},
): Valkey {
  const keys = Object.keys(idleByKey);
  const sent = opts.sent ?? [];
  return {
    dbsize: jest.fn().mockResolvedValue(keys.length),
    scan: jest.fn().mockResolvedValue(['0', keys]),
    pipeline: jest.fn(() => {
      const queued: Array<[string, string]> = [];
      const chain = {
        memory: (_sub: string, key: string) => (queued.push(['MEMORY USAGE', key]), chain),
        object: (sub: string, key: string) => (queued.push([`OBJECT ${sub}`, key]), chain),
        ttl: (key: string) => (queued.push(['TTL', key]), chain),
        type: (key: string) => (queued.push(['TYPE', key]), chain),
        call: (command: string, key: string) => (queued.push([command, key]), chain),
        exec: async () =>
          queued.map(([command, key]): Reply => {
            sent.push(command);
            if (command === 'TYPE') return [null, opts.types?.[key] ?? 'string'];
            if (opts.reply) return opts.reply(command, key);
            if (command === 'OBJECT IDLETIME') return [null, idleByKey[key]];
            return [null, command === 'TTL' ? -1 : 100];
          }),
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

  it('sends only the size command that matches each key type', async () => {
    const sent: string[] = [];
    const client = fakeClient(
      { s: 1, l: 1, h: 1, j: 1 },
      { types: { s: 'string', l: 'list', h: 'hash', j: 'ReJSON-RL' }, sent },
    );
    await new CommandExecutor(client).execute('COLLECT_KEY_ANALYTICS', [
      JSON.stringify({ sampleSize: 100, scanBatchSize: 100 }),
    ]);

    const sizeCommands = sent.filter((c) => /^(STRLEN|LLEN|HLEN|SCARD|ZCARD|XLEN)$/.test(c));
    expect(sizeCommands.sort()).toEqual(['HLEN', 'LLEN', 'STRLEN']);
    expect(sent.filter((c) => c.startsWith('OBJECT'))).toEqual(Array(4).fill('OBJECT IDLETIME'));
  });

  it('switches to OBJECT FREQ once IDLETIME errors under an LFU policy', async () => {
    const sent: string[] = [];
    const lfuError = new Error('ERR An LFU maxmemory policy is selected, idle time not tracked.');
    const client = fakeClient(
      { a: 1, b: 1 },
      {
        sent,
        reply: (command) => (command === 'OBJECT IDLETIME' ? [lfuError, null] : [null, 7]),
      },
    );
    const raw = await new CommandExecutor(client).execute('COLLECT_KEY_ANALYTICS', [
      JSON.stringify({ sampleSize: 100, scanBatchSize: 100 }),
    ]);

    expect(sent.filter((c) => c.startsWith('OBJECT'))).toEqual([
      'OBJECT IDLETIME',
      'OBJECT FREQ',
      'OBJECT FREQ',
    ]);
    const result = JSON.parse(raw as string) as KeyAnalyticsResult;
    expect(result.keyDetails?.filter((k) => k.freqScore === 7)).toHaveLength(2);
  });
});
