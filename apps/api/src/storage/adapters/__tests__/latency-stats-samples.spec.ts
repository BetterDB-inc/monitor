import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type {
  StoragePort,
  StoredLatencyStatsSample,
} from '../../../common/interfaces/storage-port.interface';

describe.each([
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
])('LatencyStats samples storage (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  const CONN = 'conn-a';

  beforeEach(async () => {
    storage = makeAdapter() as unknown as StoragePort;
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  const sample = (
    overrides: Partial<Omit<StoredLatencyStatsSample, 'id' | 'connectionId'>> = {},
  ): Omit<StoredLatencyStatsSample, 'id' | 'connectionId'> => ({
    command: 'hmget',
    p50Us: 100,
    p99Us: 2500.5,
    p999Us: 9000,
    serverVersion: '8.1.0',
    capturedAt: 1_700_000_000_000,
    ...overrides,
  });

  it('persists and returns samples scoped to a connection', async () => {
    await storage.saveLatencyStatsSamples([sample({ capturedAt: 1000 })], CONN);
    await storage.saveLatencyStatsSamples([sample({ capturedAt: 2000, p99Us: 42 })], 'conn-b');

    const history = await storage.getLatencyStatsHistory({
      connectionId: CONN,
      startTime: 0,
      endTime: 10_000,
    });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      connectionId: CONN,
      command: 'hmget',
      p50Us: 100,
      p99Us: 2500.5,
      p999Us: 9000,
      serverVersion: '8.1.0',
      capturedAt: 1000,
    });
  });

  it('filters by time window', async () => {
    await storage.saveLatencyStatsSamples(
      [
        sample({ capturedAt: 100 }),
        sample({ capturedAt: 500 }),
        sample({ capturedAt: 1000 }),
      ],
      CONN,
    );

    const window = await storage.getLatencyStatsHistory({
      connectionId: CONN,
      startTime: 200,
      endTime: 900,
    });
    expect(window).toHaveLength(1);
    expect(window[0].capturedAt).toBe(500);
  });

  it('returns all commands when command filter is omitted, one when provided', async () => {
    await storage.saveLatencyStatsSamples(
      [
        sample({ command: 'hmget', capturedAt: 100 }),
        sample({ command: 'get', capturedAt: 200 }),
        sample({ command: 'cluster|slots', capturedAt: 300 }),
      ],
      CONN,
    );

    const all = await storage.getLatencyStatsHistory({
      connectionId: CONN,
      startTime: 0,
      endTime: 10_000,
    });
    expect(all).toHaveLength(3);

    const one = await storage.getLatencyStatsHistory({
      connectionId: CONN,
      command: 'cluster|slots',
      startTime: 0,
      endTime: 10_000,
    });
    expect(one).toHaveLength(1);
    expect(one[0].command).toBe('cluster|slots');
  });

  it('respects the limit option', async () => {
    await storage.saveLatencyStatsSamples(
      [sample({ capturedAt: 100 }), sample({ capturedAt: 200 }), sample({ capturedAt: 300 })],
      CONN,
    );

    const limited = await storage.getLatencyStatsHistory({
      connectionId: CONN,
      startTime: 0,
      endTime: 10_000,
      limit: 2,
    });
    expect(limited).toHaveLength(2);
    // The cap must keep the MOST RECENT samples (not the oldest), returned ascending —
    // the regression guard depends on the newest samples.
    expect(limited.map((h) => h.capturedAt)).toEqual([200, 300]);
  });

  it('applies the limit per command, not globally, when no command filter is given', async () => {
    // Two commands with 3 samples each. A single global cap of 2 would keep only the 2 newest
    // rows overall (both from one command) and starve the other, skewing its baseline. A
    // per-command cap must keep the 2 most-recent rows of EACH command.
    await storage.saveLatencyStatsSamples(
      [
        sample({ command: 'hmget', capturedAt: 100 }),
        sample({ command: 'hmget', capturedAt: 200 }),
        sample({ command: 'hmget', capturedAt: 300 }),
        sample({ command: 'get', capturedAt: 110 }),
        sample({ command: 'get', capturedAt: 210 }),
        sample({ command: 'get', capturedAt: 310 }),
      ],
      CONN,
    );

    const history = await storage.getLatencyStatsHistory({
      connectionId: CONN,
      startTime: 0,
      endTime: 10_000,
      limit: 2,
    });

    const byCommand = new Map<string, number[]>();
    for (const h of history) {
      const arr = byCommand.get(h.command) ?? [];
      arr.push(h.capturedAt);
      byCommand.set(h.command, arr);
    }
    expect(history).toHaveLength(4);
    expect(byCommand.get('hmget')).toEqual([200, 300]);
    expect(byCommand.get('get')).toEqual([210, 310]);
  });

  it('round-trips the server version per sample (upgrade baselines)', async () => {
    await storage.saveLatencyStatsSamples(
      [
        sample({ capturedAt: 100, serverVersion: '8.1.0' }),
        sample({ capturedAt: 200, serverVersion: '9.0.0', p99Us: 9999 }),
      ],
      CONN,
    );

    const history = await storage.getLatencyStatsHistory({
      connectionId: CONN,
      startTime: 0,
      endTime: 10_000,
    });
    const versions = history.map((h) => h.serverVersion).sort();
    expect(versions).toEqual(['8.1.0', '9.0.0']);
  });

  it('prunes samples older than the cutoff for a connection', async () => {
    await storage.saveLatencyStatsSamples(
      [sample({ capturedAt: 100 }), sample({ capturedAt: 500 })],
      CONN,
    );
    await storage.saveLatencyStatsSamples([sample({ capturedAt: 100 })], 'conn-b');

    const pruned = await storage.pruneOldLatencyStatsSamples(300, CONN);
    expect(pruned).toBe(1);

    const remaining = await storage.getLatencyStatsHistory({
      connectionId: CONN,
      startTime: 0,
      endTime: 10_000,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].capturedAt).toBe(500);

    // Other connection untouched
    const other = await storage.getLatencyStatsHistory({
      connectionId: 'conn-b',
      startTime: 0,
      endTime: 10_000,
    });
    expect(other).toHaveLength(1);
  });
});
