import { isWriteCommand, sumWriteCalls } from '../write-commands';

describe('isWriteCommand', () => {
  it.each([
    'set',
    'hset',
    'hsetex',
    'hgetex',
    'hgetdel',
    'lpush',
    'zadd',
    'xadd',
    'del',
    'unlink',
    'expire',
    'eval',
  ])('classifies %s as a write', (command) => {
    expect(isWriteCommand(command)).toBe(true);
  });

  it.each(['get', 'mget', 'hgetall', 'lrange', 'zrange', 'scan', 'info', 'ping', 'cluster'])(
    'classifies %s as a read',
    (command) => {
      expect(isWriteCommand(command)).toBe(false);
    },
  );

  it('does not count the read-only script variants a replica is meant to serve', () => {
    expect(isWriteCommand('eval_ro')).toBe(false);
    expect(isWriteCommand('evalsha_ro')).toBe(false);
    expect(isWriteCommand('fcall_ro')).toBe(false);
    expect(isWriteCommand('georadius_ro')).toBe(false);
  });

  it('matches subcommands through their container', () => {
    expect(isWriteCommand('xgroup|create')).toBe(true);
    expect(isWriteCommand('client|list')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isWriteCommand('SET')).toBe(true);
  });
});

describe('sumWriteCalls', () => {
  it('adds up only the write commands', () => {
    const totals = sumWriteCalls([
      { command: 'get', calls: 900 },
      { command: 'set', calls: 30 },
      { command: 'hset', calls: 12 },
      { command: 'info', calls: 5 },
    ]);

    expect(totals).toEqual({ writes: 42, moduleCalls: 0 });
  });

  it('is zero when the node served no writes', () => {
    expect(sumWriteCalls([{ command: 'get', calls: 900 }])).toEqual({
      writes: 0,
      moduleCalls: 0,
    });
  });

  it('counts module commands apart from the writes it can name', () => {
    const totals = sumWriteCalls([
      { command: 'json.set', calls: 40 },
      { command: 'ts.add', calls: 60 },
      { command: 'set', calls: 7 },
    ]);

    expect(totals).toEqual({ writes: 7, moduleCalls: 100 });
  });

  it('reports zero writes alongside module traffic so the caller can fall back', () => {
    const totals = sumWriteCalls([
      { command: 'json.set', calls: 40 },
      { command: 'get', calls: 900 },
    ]);

    expect(totals).toEqual({ writes: 0, moduleCalls: 40 });
  });

  it('does not mistake a container subcommand for a module command', () => {
    const totals = sumWriteCalls([
      { command: 'xgroup|create', calls: 3 },
      { command: 'client|list', calls: 9 },
    ]);

    expect(totals).toEqual({ writes: 3, moduleCalls: 0 });
  });
});
