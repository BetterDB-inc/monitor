import { isWriteCommand, sumWriteCalls } from '../write-commands';

describe('isWriteCommand', () => {
  it.each(['set', 'hset', 'lpush', 'zadd', 'xadd', 'del', 'unlink', 'expire', 'eval'])(
    'classifies %s as a write',
    (command) => {
      expect(isWriteCommand(command)).toBe(true);
    },
  );

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
    const total = sumWriteCalls([
      { command: 'get', calls: 900 },
      { command: 'set', calls: 30 },
      { command: 'hset', calls: 12 },
      { command: 'info', calls: 5 },
    ]);

    expect(total).toBe(42);
  });

  it('is zero when the node served no writes', () => {
    expect(sumWriteCalls([{ command: 'get', calls: 900 }])).toBe(0);
  });
});
