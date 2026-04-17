import { MemoryAdapter } from '../memory.adapter';
import type { StoredCommandStatsSample } from '../../../common/interfaces/storage-port.interface';

describe('CommandStats samples storage', () => {
  let storage: MemoryAdapter;
  const CONN = 'conn-a';

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
  });

  const sample = (
    overrides: Partial<Omit<StoredCommandStatsSample, 'id' | 'connectionId'>> = {},
  ): Omit<StoredCommandStatsSample, 'id' | 'connectionId'> => ({
    command: 'ft.search',
    callsDelta: 5,
    usecDelta: 50_000,
    intervalMs: 5_000,
    capturedAt: 1_700_000_000_000,
    ...overrides,
  });

  it('persists and returns samples filtered by connection + command', async () => {
    await storage.saveCommandStatsSamples(
      [sample({ capturedAt: 1000, callsDelta: 1 }), sample({ capturedAt: 2000, callsDelta: 2 })],
      CONN,
    );
    await storage.saveCommandStatsSamples(
      [sample({ command: 'get', capturedAt: 1500, callsDelta: 99 })],
      CONN,
    );

    const history = await storage.getCommandStatsHistory({
      connectionId: CONN,
      command: 'ft.search',
      startTime: 0,
      endTime: 10_000,
    });

    expect(history).toHaveLength(2);
    expect(history.map((r) => r.callsDelta).sort()).toEqual([1, 2]);
  });

  it('isolates samples between connections', async () => {
    await storage.saveCommandStatsSamples([sample()], 'conn-1');
    await storage.saveCommandStatsSamples([sample({ callsDelta: 999 })], 'conn-2');

    const conn1 = await storage.getCommandStatsHistory({
      connectionId: 'conn-1',
      command: 'ft.search',
      startTime: 0,
      endTime: 10_000_000_000_000,
    });
    expect(conn1).toHaveLength(1);
    expect(conn1[0].callsDelta).toBe(5);
  });

  it('filters by time range', async () => {
    await storage.saveCommandStatsSamples(
      [sample({ capturedAt: 100 }), sample({ capturedAt: 500 }), sample({ capturedAt: 1000 })],
      CONN,
    );

    const window = await storage.getCommandStatsHistory({
      connectionId: CONN,
      command: 'ft.search',
      startTime: 200,
      endTime: 900,
    });
    expect(window).toHaveLength(1);
    expect(window[0].capturedAt).toBe(500);
  });

  it('prunes samples older than cutoff', async () => {
    await storage.saveCommandStatsSamples(
      [sample({ capturedAt: 100 }), sample({ capturedAt: 500 })],
      CONN,
    );
    const pruned = await storage.pruneOldCommandStatsSamples(300, CONN);
    expect(pruned).toBe(1);

    const remaining = await storage.getCommandStatsHistory({
      connectionId: CONN,
      command: 'ft.search',
      startTime: 0,
      endTime: 10_000,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].capturedAt).toBe(500);
  });
});
