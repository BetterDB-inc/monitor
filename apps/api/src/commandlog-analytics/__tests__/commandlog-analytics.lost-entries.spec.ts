import { CommandLogAnalyticsService } from '../commandlog-analytics.service';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import type {
  CommandLogEntry,
  CommandLogType,
} from '../../common/interfaces/database-port.interface';

const TYPES: CommandLogType[] = ['slow', 'large-request', 'large-reply'];

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

function entries(type: CommandLogType, ids: number[], tsBase: number): CommandLogEntry[] {
  return ids.map((id) => ({
    id,
    timestamp: tsBase + id,
    duration: 20_000,
    command: ['EVAL', `process-${tsBase}`],
    clientAddress: '10.0.9.9:5000',
    clientName: '',
    type,
  }));
}

type Pollable = { pollConnection(ctx: unknown): Promise<void> };

describe.each(TYPES)('CommandLogAnalyticsService lost entries (%s)', (type) => {
  let storage: MemoryAdapter;
  let service: CommandLogAnalyticsService;
  let runId: string | null;
  let log: CommandLogEntry[];
  let saveError: Error | null;

  const ctx = () => ({
    connectionId: 'conn',
    connectionName: 'Conn',
    host: '10.0.0.1',
    port: 6379,
    client: {
      getCapabilities: () => ({ hasCommandLog: true }),
      getServingEndpoint: () => ({ host: '10.0.0.1', port: 6379 }),
      getConnectionGeneration: () => 1,
      getInfo: jest.fn(async () => {
        if (runId === null) throw new Error('NOPERM');
        return { server: { run_id: runId } };
      }),
      // COMMANDLOG GET <count> <type> answers with the newest entries only.
      getCommandLog: jest.fn(async (count: number, asked: CommandLogType) =>
        asked === type ? log.slice(-count) : [],
      ),
    },
  });
  const poll = () => (service as unknown as Pollable).pollConnection(ctx());
  const storedIds = async (tsBase?: number) =>
    (await storage.getCommandLogEntries({ connectionId: 'conn', type, limit: 10_000 }))
      .filter((e) => tsBase === undefined || e.command[1] === `process-${tsBase}`)
      .map((e) => e.id)
      .sort((a, b) => a - b);
  const lost = () => service.getLostEntries('conn').get(`commandlog-${type}`);

  beforeEach(() => {
    runId = 'run-a';
    log = [];
    saveError = null;
    storage = new MemoryAdapter();
    const save = storage.saveCommandLogEntries.bind(storage);
    storage.saveCommandLogEntries = async (...args) => {
      if (saveError) throw saveError;
      return save(...args);
    };
    service = newService();
  });

  function newService(): CommandLogAnalyticsService {
    const created = new CommandLogAnalyticsService(
      { list: jest.fn().mockReturnValue([]) } as never,
      storage as never,
      { isAvailable: () => true, recordFailure: () => false } as never,
    );
    jest.spyOn(created['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(created['logger'], 'error').mockImplementation(() => undefined);
    return created;
  }

  // COMMANDLOG RESET empties the list and leaves the id counter alone
  // (commandlogReset in commandlog.c), so later entries carry higher ids.
  it('stores the entries logged after a reset', async () => {
    log = entries(type, range(0, 9), 1000);
    await poll();

    log = [];
    await poll();
    log = entries(type, range(10, 14), 1000);
    await poll();

    expect(await storedIds()).toEqual(range(0, 14));
    expect(lost()).toBe(0);
  });

  it('stores a restarted log that already passed the last seen id when there is no run id', async () => {
    runId = null;
    log = entries(type, range(40, 50), 1000);
    await poll();

    log = entries(type, range(0, 60), 2000);
    await poll();

    // Without a run id the stored key is the address, so 40-50 of the new
    // process collide with the rows of the old one.
    expect(await storedIds(2000)).toEqual([...range(0, 39), ...range(51, 60)]);
    expect(lost()).toBe(0);
  });

  it('does not take entries it already stored for a restart', async () => {
    runId = null;
    log = entries(type, range(0, 9), 1000);
    await poll();
    log = entries(type, range(0, 12), 1000);
    await poll();

    expect(await storedIds()).toEqual(range(0, 12));
    expect(service['logger'].warn).not.toHaveBeenCalled();
  });

  it('counts the entries that overflowed the log between two polls', async () => {
    log = entries(type, range(0, 9), 1000);
    await poll();

    log = entries(type, range(0, 209), 1000);
    await poll();

    expect(await storedIds()).toEqual([...range(0, 9), ...range(82, 209)]);
    expect(lost()).toBe(72);
  });

  it('keeps the count of each type apart', async () => {
    log = entries(type, range(0, 9), 1000);
    await poll();
    log = entries(type, range(0, 209), 1000);
    await poll();

    const counts = service.getLostEntries('conn');
    for (const other of TYPES.filter((t) => t !== type)) {
      expect(counts.get(`commandlog-${other}`)).toBe(0);
    }
  });

  it('does not count the first poll after BetterDB starts', async () => {
    log = entries(type, range(0, 9), 1000);
    await poll();

    service = newService();
    log = entries(type, range(50, 60), 1000);
    await poll();

    expect(lost()).toBe(0);
  });

  it('does not count a server restart', async () => {
    log = entries(type, range(0, 9), 1000);
    await poll();

    runId = 'run-b';
    log = entries(type, range(0, 299), 2000);
    await poll();

    expect(lost()).toBe(0);
  });

  it('counts a hole once when the save fails and the next poll retries it', async () => {
    log = entries(type, range(0, 9), 1000);
    await poll();

    log = entries(type, range(0, 209), 1000);
    saveError = new Error('storage down');
    await poll();
    expect(lost()).toBe(0);

    saveError = null;
    await poll();
    expect(lost()).toBe(72);
  });

  it('forgets the count of a removed connection', async () => {
    log = entries(type, range(0, 9), 1000);
    await poll();
    log = entries(type, range(0, 209), 1000);
    await poll();

    service['onConnectionRemoved']('conn');

    expect(service.getLostEntries('conn').size).toBe(0);
  });
});
