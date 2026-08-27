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

const SERVER_VERDICTS: Record<string, boolean> = {
  get: false,
  info: false,
  'client|list': false,
  'json.set': true,
  'ts.add': true,
  vadd: true,
};

function classify(command: string): boolean | undefined {
  return SERVER_VERDICTS[command];
}

describe('sumWriteCalls', () => {
  it('adds up only the write commands', () => {
    const totals = sumWriteCalls(
      [
        { command: 'get', calls: 900 },
        { command: 'set', calls: 30 },
        { command: 'hset', calls: 12 },
        { command: 'info', calls: 5 },
      ],
      classify,
    );

    expect(totals).toEqual({ writes: 42, unclassified: 0 });
  });

  it('is zero when the node is proven to have served no writes', () => {
    expect(sumWriteCalls([{ command: 'get', calls: 900 }], classify)).toEqual({
      writes: 0,
      unclassified: 0,
    });
  });

  it('counts a server-classified module write', () => {
    const totals = sumWriteCalls(
      [
        { command: 'json.set', calls: 40 },
        { command: 'ts.add', calls: 60 },
        { command: 'set', calls: 7 },
      ],
      classify,
    );

    expect(totals).toEqual({ writes: 107, unclassified: 0 });
  });

  it('counts a core write the built-in list does not name', () => {
    const totals = sumWriteCalls([{ command: 'vadd', calls: 12 }], classify);

    expect(totals).toEqual({ writes: 12, unclassified: 0 });
  });

  it('reports unclassified traffic so the caller can fall back', () => {
    const totals = sumWriteCalls(
      [
        { command: 'unknowncmd', calls: 40 },
        { command: 'get', calls: 900 },
      ],
      classify,
    );

    expect(totals).toEqual({ writes: 0, unclassified: 40 });
  });

  it('leaves a client-read command out of the writes without a server verdict', () => {
    const totals = sumWriteCalls(
      [
        { command: 'pfcount', calls: 30 },
        { command: 'eval_ro', calls: 4 },
      ],
      classify,
    );

    expect(totals).toEqual({ writes: 0, unclassified: 0 });
  });

  it('does not mistake a container subcommand for unclassified traffic', () => {
    const totals = sumWriteCalls(
      [
        { command: 'xgroup|create', calls: 3 },
        { command: 'client|list', calls: 9 },
      ],
      classify,
    );

    expect(totals).toEqual({ writes: 3, unclassified: 0 });
  });
});
