import { analyzeCommands } from '../analysis/commandlog-analyzer';
import type { DatabasePort, DatabaseCapabilities } from '../../common/interfaces/database-port.interface';

function createMockAdapter(options: {
  hasCommandLog?: boolean;
  commandLogEntries?: Array<{ command: string[] }>;
  slowLogEntries?: Array<{ command: string[] }>;
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
