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

  it('drops a type that went stale and ignores inherited type names', async () => {
    const wrongType = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    const client = fakeClient(
      { moved: 1, proto: 1 },
      {
        types: { moved: 'string', proto: '__proto__' },
        reply: (command) => (command === 'STRLEN' ? [wrongType, null] : [null, 3]),
      },
    );
    const raw = await new CommandExecutor(client).execute('COLLECT_KEY_ANALYTICS', [
      JSON.stringify({ sampleSize: 100, scanBatchSize: 100 }),
    ]);

    const result = JSON.parse(raw as string) as KeyAnalyticsResult;
    const byName = new Map(result.keyDetails?.map((k) => [k.keyName, k]));
    expect(byName.get('moved')?.keyType).toBeNull();
    expect(byName.get('proto')).toEqual(expect.objectContaining({ keyType: '__proto__', cardinality: null }));
  });

  it('reports a key deleted after the batch TYPE as gone', async () => {
    const client = fakeClient(
      { gone: 1, kept: 1 },
      {
        reply: (command, key) => {
          if (command === 'TTL') return [null, key === 'gone' ? -2 : -1];
          return [null, key === 'gone' && command === 'STRLEN' ? 0 : 3];
        },
      },
    );
    const raw = await new CommandExecutor(client).execute('COLLECT_KEY_ANALYTICS', [
      JSON.stringify({ sampleSize: 100, scanBatchSize: 100 }),
    ]);

    const result = JSON.parse(raw as string) as KeyAnalyticsResult;
    const byName = new Map(result.keyDetails?.map((k) => [k.keyName, k]));
    expect(byName.get('gone')).toEqual(expect.objectContaining({ keyType: 'none', cardinality: null }));
    expect(byName.get('kept')).toEqual(expect.objectContaining({ keyType: 'string', cardinality: 3 }));
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

describe('CommandExecutor read-only', () => {
  function executorWith(options: { unsafeMode?: boolean; readOnly?: boolean }) {
    const call = jest.fn().mockResolvedValue('OK');
    const client = { call, config: jest.fn().mockResolvedValue([]), info: jest.fn().mockResolvedValue('') } as unknown as Valkey;
    return { executor: new CommandExecutor(client, options), call };
  }

  it.each([
    ['SLOWLOG', ['RESET']],
    ['COMMANDLOG', ['RESET', 'slow']],
    ['LATENCY', ['RESET']],
    ['ACL', ['LOG', 'RESET']],
    ['CLIENT', ['KILL', 'ID', '7']],
    ['CONFIG', ['SET', 'maxmemory', '0']],
    ['FLUSHALL', []],
  ])('refuses %s %j locally, before it reaches the server', async (cmd, args) => {
    const { executor, call } = executorWith({ readOnly: true });

    expect(executor.isAllowed(cmd, args)).toBe(false);
    await expect(executor.execute(cmd, args)).rejects.toThrow('Command not allowed');
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps refusing mutations even with unsafe mode on', async () => {
    const { executor, call } = executorWith({ readOnly: true, unsafeMode: true });

    await expect(executor.execute('SET', ['k', 'v'])).rejects.toThrow('Command not allowed');
    await expect(executor.execute('SLOWLOG', ['RESET'])).rejects.toThrow('Command not allowed');
    expect(call).not.toHaveBeenCalled();
  });

  it('judges the arguments that reach the server, so a binary operand cannot swap in another sub-command', async () => {
    const { executor, call } = executorWith({ readOnly: true });

    // CLIENT LIST passes the check; substituting LIST with KILL would send
    // CLIENT KILL ID 7. The sub-command slot is never substituted.
    await executor.execute('CLIENT', ['LIST', 'ID', '7'], { LIST: Buffer.from('KILL') });
    expect(call.mock.calls[0]).toEqual(['CLIENT', 'LIST', 'ID', '7']);

    // A placeholder in a data slot is substituted.
    await executor.execute('CLIENT', ['LIST', 'ID', 'placeholder'], { placeholder: Buffer.from('9') });
    expect(call.mock.calls[1]).toEqual(['CLIENT', 'LIST', 'ID', Buffer.from('9')]);
  });

  it('judges binary operands by their bytes, so a binary RESET cannot clear the ACL log', async () => {
    const { executor, call } = executorWith({ readOnly: true });

    await expect(
      executor.execute('ACL', ['LOG', 'placeholder'], { placeholder: Buffer.from('RESET') }),
    ).rejects.toThrow('Command not allowed: ACL LOG <binary>');
    expect(call).not.toHaveBeenCalled();
  });

  it('only substitutes own placeholders, never inherited names like constructor', async () => {
    const { executor, call } = executorWith({ readOnly: true });

    await executor.execute('CLIENT', ['LIST', 'ID', 'constructor'], {});
    expect(call.mock.calls[0]).toEqual(['CLIENT', 'LIST', 'ID', 'constructor']);
  });

  it('still runs reads', async () => {
    const { executor, call } = executorWith({ readOnly: true });

    await executor.execute('SLOWLOG', ['GET', '10']);
    await executor.execute('CLUSTER', ['NODES']);

    expect(call.mock.calls.map((c) => c.join(' '))).toEqual(['SLOWLOG GET 10', 'CLUSTER NODES']);
  });

  it('redacts credentials from CONFIG GET replies, including a glob that covers them', async () => {
    const config = jest.fn().mockResolvedValue(['requirepass', 's3cret', 'maxmemory', '0', 'masterauth', 's3cret']);
    const client = { call: jest.fn(), config, info: jest.fn() } as unknown as Valkey;

    const readOnly = new CommandExecutor(client, { readOnly: true });
    expect(await readOnly.execute('CONFIG', ['GET', '*'])).toEqual(['requirepass', '<redacted>', 'maxmemory', '0', 'masterauth', '<redacted>']);
    expect(await readOnly.execute('CONFIG', ['GET', 'requirepass'])).toEqual(['requirepass', '<redacted>', 'maxmemory', '0', 'masterauth', '<redacted>']);
    expect(config).toHaveBeenLastCalledWith('GET', 'requirepass');

    const plain = new CommandExecutor(client, {});
    expect(await plain.execute('CONFIG', ['GET', '*'])).toEqual(['requirepass', 's3cret', 'maxmemory', '0', 'masterauth', 's3cret']);
  });

  it('redacts password hashes from ACL LIST replies', async () => {
    const hash = 'd'.repeat(64);
    const call = jest.fn().mockResolvedValue([`user default on #${hash} ~* +@all`, 'user ro on nopass ~* +@read']);
    const client = { call, config: jest.fn(), info: jest.fn() } as unknown as Valkey;

    expect(await new CommandExecutor(client, { readOnly: true }).execute('ACL', ['LIST']))
      .toEqual(['user default on #<redacted> ~* +@all', 'user ro on nopass ~* +@read']);
    expect(await new CommandExecutor(client, {}).execute('ACL', ['LIST']))
      .toEqual([`user default on #${hash} ~* +@all`, 'user ro on nopass ~* +@read']);
  });

  it('allows the RESET sub-commands when not read-only, as before', async () => {
    const { executor, call } = executorWith({});

    await executor.execute('SLOWLOG', ['RESET']);

    expect(call).toHaveBeenCalledWith('SLOWLOG', 'RESET');
  });
});
