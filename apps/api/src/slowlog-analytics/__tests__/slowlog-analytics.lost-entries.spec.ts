import { SlowLogAnalyticsService } from '../slowlog-analytics.service';
import { SlowLogMemoryRepository } from '../../storage/adapters/repositories/slowlog.memory.repository';
import type { SlowLogEntry } from '../../common/interfaces/database-port.interface';

const POLL_BATCH = 128;

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

function entries(ids: number[], tsBase: number): SlowLogEntry[] {
  return ids.map((id) => ({
    id,
    timestamp: tsBase + id,
    duration: 20_000,
    command: ['EVAL', `process-${tsBase}`],
    clientAddress: '10.0.9.9:5000',
    clientName: '',
  }));
}

type Pollable = { pollConnection(ctx: unknown): Promise<void> };

describe('SlowLogAnalyticsService lost entries', () => {
  let repo: SlowLogMemoryRepository;
  let service: SlowLogAnalyticsService;
  let runId: string | null;
  let log: SlowLogEntry[];
  let saveError: Error | null;

  const ctx = () => ({
    connectionId: 'conn',
    connectionName: 'Conn',
    host: '10.0.0.1',
    port: 6379,
    client: {
      // SLOWLOG GET <count> answers with the newest entries only.
      getSlowLog: jest.fn(async (count: number) => log.slice(-count)),
      getServingEndpoint: () => ({ host: '10.0.0.1', port: 6379 }),
      getConnectionGeneration: () => 1,
      getInfo: jest.fn(async () => {
        if (runId === null) throw new Error('NOPERM');
        return { server: { run_id: runId } };
      }),
    },
  });
  const poll = () => (service as unknown as Pollable).pollConnection(ctx());
  const storedIds = async (tsBase?: number) =>
    (await repo.getSlowLogEntries({ connectionId: 'conn', limit: 10_000 }))
      .filter((e) => tsBase === undefined || e.command[1] === `process-${tsBase}`)
      .map((e) => e.id)
      .sort((a, b) => a - b);

  beforeEach(() => {
    runId = 'run-a';
    log = [];
    saveError = null;
    repo = new SlowLogMemoryRepository();
    service = newService();
  });

  function newService(): SlowLogAnalyticsService {
    const storage = {
      saveSlowLogEntries: async (
        ...args: Parameters<SlowLogMemoryRepository['saveSlowLogEntries']>
      ) => {
        if (saveError) throw saveError;
        return repo.saveSlowLogEntries(...args);
      },
      getLatestSlowLogId: repo.getLatestSlowLogId.bind(repo),
      hasRunIdLogEntries: async (id: string) => repo.hasRunIdEntries(id),
    };
    const registry = {
      getDefaultId: () => 'conn',
      getAll: () => [],
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const capabilities = { isAvailable: () => true, recordFailure: () => false };
    const created = new SlowLogAnalyticsService(
      registry as never,
      storage as never,
      {} as never,
      capabilities as never,
    );
    jest.spyOn(created['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(created['logger'], 'error').mockImplementation(() => undefined);
    return created;
  }

  describe('SLOWLOG RESET', () => {
    // RESET empties the list and leaves the id counter alone (slowlogReset in
    // slowlog.c), so the entries logged after it carry higher ids.
    it('stores the entries logged after a reset', async () => {
      log = entries(range(0, 9), 1000);
      await poll();

      log = [];
      await poll();
      log = entries(range(10, 14), 1000);
      await poll();

      expect(await storedIds()).toEqual(range(0, 14));
    });
  });

  describe('id sequence restart without a run id', () => {
    beforeEach(() => {
      runId = null;
    });

    it('stores a restarted log that has not reached the last seen id', async () => {
      log = entries(range(40, 50), 1000);
      await poll();

      log = entries(range(0, 9), 2000);
      await poll();

      expect(await storedIds(2000)).toEqual(range(0, 9));
    });

    it('stores a restarted log that already passed the last seen id', async () => {
      log = entries(range(40, 50), 1000);
      await poll();

      log = entries(range(0, 60), 2000);
      await poll();

      // Without a run id the stored key is the address, so 40-50 of the new
      // process collide with the rows of the old one.
      expect(await storedIds(2000)).toEqual([...range(0, 39), ...range(51, 60)]);
    });

    it('does not take entries it already stored for a restart', async () => {
      log = entries(range(0, 9), 1000);
      await poll();
      log = entries(range(0, 12), 1000);
      await poll();

      expect(await storedIds()).toEqual(range(0, 12));
      expect(service['logger'].warn).not.toHaveBeenCalled();
    });
  });

  describe('missed entries', () => {
    const lost = () => service.getLostEntries('conn').get('slowlog');

    it('reports nothing before the first poll', () => {
      expect(service.getLostEntries('conn').size).toBe(0);
    });

    it('reports zero when consecutive polls leave no hole', async () => {
      log = entries(range(0, 9), 1000);
      await poll();
      log = entries(range(0, 20), 1000);
      await poll();

      expect(lost()).toBe(0);
    });

    it('counts the entries that overflowed the log between two polls', async () => {
      log = entries(range(0, 9), 1000);
      await poll();

      log = entries(range(0, 209), 1000);
      await poll();

      expect(await storedIds()).toEqual([...range(0, 9), ...range(82, 209)]);
      expect(lost()).toBe(72);
    });

    it('adds up the holes of several polls', async () => {
      log = entries(range(0, 9), 1000);
      await poll();
      log = entries(range(0, 209), 1000);
      await poll();
      log = entries(range(0, 409), 1000);
      await poll();

      expect(lost()).toBe(72 + 72);
    });

    it('counts entries a reset dropped before they were read', async () => {
      log = entries(range(0, 9), 1000);
      await poll();

      log = entries(range(15, 19), 1000);
      await poll();

      expect(lost()).toBe(5);
    });

    it('does not count the first poll after BetterDB starts', async () => {
      log = entries(range(0, 9), 1000);
      await poll();

      service = newService();
      log = entries(range(50, 60), 1000);
      await poll();

      expect(lost()).toBe(0);
    });

    it('does not count a server restart', async () => {
      log = entries(range(0, 9), 1000);
      await poll();

      runId = 'run-b';
      log = entries(range(0, 299), 2000);
      await poll();

      expect(lost()).toBe(0);
    });

    it('does not count a restart that shows only through the ids', async () => {
      runId = null;
      log = entries(range(40, 50), 1000);
      await poll();

      log = entries(range(0, 60), 2000);
      await poll();
      log = entries(range(0, 5), 3000);
      await poll();

      expect(lost()).toBe(0);
    });

    it('keeps the count across a server restart', async () => {
      log = entries(range(0, 9), 1000);
      await poll();
      log = entries(range(0, 209), 1000);
      await poll();

      runId = 'run-b';
      log = entries(range(0, 3), 2000);
      await poll();

      expect(lost()).toBe(72);
    });

    it('counts a hole once when the save fails and the next poll retries it', async () => {
      log = entries(range(0, 9), 1000);
      await poll();

      log = entries(range(0, 209), 1000);
      saveError = new Error('storage down');
      await expect(poll()).rejects.toThrow('storage down');
      expect(lost()).toBe(0);

      saveError = null;
      await poll();
      expect(lost()).toBe(72);
    });

    it('forgets the count of a removed connection', async () => {
      log = entries(range(0, 9), 1000);
      await poll();
      log = entries(range(0, 209), 1000);
      await poll();

      service['onConnectionRemoved']('conn');

      expect(service.getLostEntries('conn').size).toBe(0);
    });
  });

  it('declares the batch size the overflow specs rely on', async () => {
    log = entries(range(0, 199), 1000);
    const context = ctx();
    await (service as unknown as Pollable).pollConnection(context);

    expect(context.client.getSlowLog).toHaveBeenCalledWith(POLL_BATCH);
  });
});
