import { analyzeCommands, collectCommandAnalysis, collectNodeCommandEntries } from '../analysis/commandlog-analyzer';
import type { DatabasePort, DatabaseCapabilities } from '../../common/interfaces/database-port.interface';

function createMockAdapter(options: {
  hasCommandLog?: boolean;
  commandLogEntries?: Array<{ command: string[]; clientName?: string }>;
  slowLogEntries?: Array<{ command: string[]; clientName?: string }>;
  commandLogError?: boolean;
  slowLogError?: boolean;
} = {}): DatabasePort {
  const {
    hasCommandLog = false,
    commandLogEntries = [],
    slowLogEntries = [],
    commandLogError = false,
    slowLogError = false,
  } = options;

  return {
    getCapabilities: jest.fn().mockReturnValue({
      hasCommandLog,
    } as Partial<DatabaseCapabilities>),
    getCommandLog: jest.fn().mockImplementation(() => {
      if (commandLogError) return Promise.reject(new Error('COMMANDLOG failed'));
      return Promise.resolve(commandLogEntries);
    }),
    getSlowLog: jest.fn().mockImplementation(() => {
      if (slowLogError) return Promise.reject(new Error('SLOWLOG failed'));
      return Promise.resolve(slowLogEntries);
    }),
  } as unknown as DatabasePort;
}

describe('analyzeCommands', () => {
  it('should return top commands from COMMANDLOG when available', async () => {
    const adapter = createMockAdapter({
      hasCommandLog: true,
      commandLogEntries: [
        { command: ['SET', 'key1', 'val'] },
        { command: ['SET', 'key2', 'val'] },
        { command: ['GET', 'key1'] },
        { command: ['SET', 'key3', 'val'] },
      ],
    });

    const result = await analyzeCommands(adapter);

    expect(result.sourceUsed).toBe('commandlog');
    expect(result.topCommands).toHaveLength(2);
    expect(result.topCommands[0]).toEqual({ command: 'SET', count: 3 });
    expect(result.topCommands[1]).toEqual({ command: 'GET', count: 1 });
  });

  it('should fall back to SLOWLOG when COMMANDLOG is not available', async () => {
    const adapter = createMockAdapter({
      hasCommandLog: false,
      slowLogEntries: [
        { command: ['HGETALL', 'myhash'] },
        { command: ['HGETALL', 'myhash2'] },
        { command: ['ZADD', 'myset', '1', 'a'] },
      ],
    });

    const result = await analyzeCommands(adapter);

    expect(result.sourceUsed).toBe('slowlog');
    expect(result.topCommands[0]).toEqual({ command: 'HGETALL', count: 2 });
    expect(result.topCommands[1]).toEqual({ command: 'ZADD', count: 1 });
  });

  it('should fall back to SLOWLOG when COMMANDLOG errors', async () => {
    const adapter = createMockAdapter({
      hasCommandLog: true,
      commandLogError: true,
      slowLogEntries: [
        { command: ['INFO', 'all'] },
      ],
    });

    const result = await analyzeCommands(adapter);

    expect(result.sourceUsed).toBe('slowlog');
    expect(result.topCommands).toHaveLength(1);
    expect(result.topCommands[0].command).toBe('INFO');
  });

  it('should return empty topCommands when both logs are empty', async () => {
    const adapter = createMockAdapter({
      hasCommandLog: true,
      commandLogEntries: [],
    });

    const result = await analyzeCommands(adapter);

    expect(result.sourceUsed).toBe('commandlog');
    expect(result.topCommands).toEqual([]);
  });

  it('should return unavailable when both sources fail', async () => {
    const adapter = createMockAdapter({
      hasCommandLog: false,
      slowLogError: true,
    });

    const result = await analyzeCommands(adapter);

    expect(result.sourceUsed).toBe('unavailable');
    expect(result.topCommands).toEqual([]);
  });

  it('should sort commands by count descending', async () => {
    const adapter = createMockAdapter({
      hasCommandLog: true,
      commandLogEntries: [
        { command: ['GET', 'a'] },
        { command: ['SET', 'a', '1'] },
        { command: ['SET', 'b', '2'] },
        { command: ['SET', 'c', '3'] },
        { command: ['GET', 'b'] },
        { command: ['DEL', 'a'] },
      ],
    });

    const result = await analyzeCommands(adapter);

    expect(result.topCommands[0].command).toBe('SET');
    expect(result.topCommands[0].count).toBe(3);
    expect(result.topCommands[1].command).toBe('GET');
    expect(result.topCommands[1].count).toBe(2);
    expect(result.topCommands[2].command).toBe('DEL');
    expect(result.topCommands[2].count).toBe(1);
  });
});

describe('collectCommandAnalysis', () => {
  it('returns the raw log entries with full arguments and client names', async () => {
    const adapter = createMockAdapter({
      hasCommandLog: true,
      commandLogEntries: [
        { command: ['CLIENT', 'LIST'], clientName: 'app' },
        { command: ['GET', 'a'], clientName: 'BetterDB-Monitor' },
      ],
    });

    const { analysis, entries } = await collectCommandAnalysis(adapter);

    expect(analysis.sourceUsed).toBe('commandlog');
    expect(analysis.topCommands).toEqual([
      { command: 'CLIENT', count: 1 },
      { command: 'GET', count: 1 },
    ]);
    expect(entries).toEqual([
      { command: ['CLIENT', 'LIST'], clientName: 'app' },
      { command: ['GET', 'a'], clientName: 'BetterDB-Monitor' },
    ]);
  });

  it('returns slowlog entries when it falls back', async () => {
    const adapter = createMockAdapter({
      hasCommandLog: false,
      slowLogEntries: [{ command: ['KEYS', '*'], clientName: 'worker' }],
    });

    const { entries } = await collectCommandAnalysis(adapter);

    expect(entries).toEqual([{ command: ['KEYS', '*'], clientName: 'worker' }]);
  });

  it('returns no entries when both sources fail', async () => {
    const adapter = createMockAdapter({ hasCommandLog: false, slowLogError: true });

    const { analysis, entries } = await collectCommandAnalysis(adapter);

    expect(analysis.sourceUsed).toBe('unavailable');
    expect(entries).toEqual([]);
  });
});

describe('collectNodeCommandEntries', () => {
  function logEntry(command: string[], clientName: string): unknown[] {
    return [1, 1700000000, 10, command, '10.0.0.9:5000', clientName];
  }

  it('reads COMMANDLOG from every node and merges the entries', async () => {
    const a = { call: jest.fn().mockResolvedValue([logEntry(['KEYS', '*'], 'app')]) };
    const b = { call: jest.fn().mockResolvedValue([logEntry(['OBJECT', 'FREQ', 'k'], 'app')]) };

    const { entries, unreadNodes } = await collectNodeCommandEntries([a, b] as any, true);

    expect(entries).toEqual([
      { command: ['KEYS', '*'], clientName: 'app' },
      { command: ['OBJECT', 'FREQ', 'k'], clientName: 'app' },
    ]);
    expect(unreadNodes).toBe(0);
    expect(a.call).toHaveBeenCalledWith('COMMANDLOG', 'GET', 200, 'slow');
  });

  it('falls back to SLOWLOG per node when COMMANDLOG fails or is unsupported', async () => {
    const a = {
      call: jest.fn().mockImplementation(async (cmd: string) => {
        if (cmd === 'COMMANDLOG') throw new Error('unknown command');
        return [logEntry(['CLIENT', 'KILL', 'ID', '1'], 'app')];
      }),
    };

    const { entries, unreadNodes } = await collectNodeCommandEntries([a] as any, true);

    expect(entries).toEqual([{ command: ['CLIENT', 'KILL', 'ID', '1'], clientName: 'app' }]);
    expect(unreadNodes).toBe(0);
    expect(a.call).toHaveBeenCalledWith('SLOWLOG', 'GET', 128);
  });

  it('skips a node whose logs cannot be read', async () => {
    const a = { call: jest.fn().mockRejectedValue(new Error('NOPERM')) };
    const b = { call: jest.fn().mockResolvedValue([logEntry(['KEYS', '*'], 'app')]) };

    expect(await collectNodeCommandEntries([a, b] as any, false)).toEqual({
      entries: [{ command: ['KEYS', '*'], clientName: 'app' }],
      unreadNodes: 1,
    });
  });

  it('counts a node as unread only when both COMMANDLOG and SLOWLOG fail', async () => {
    const empty = { call: jest.fn().mockResolvedValue([]) };
    const broken = { call: jest.fn().mockRejectedValue(new Error('NOPERM')) };

    expect(await collectNodeCommandEntries([empty, broken, broken] as any, true)).toEqual({ entries: [], unreadNodes: 2 });
  });
});
