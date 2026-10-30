import type { LogCaptureGap } from '@betterdb/shared';
import { CommandLogAnalyticsService } from '../commandlog-analytics.service';
import type { CommandLogEntry } from '../../common/interfaces/database-port.interface';
import type { CommandLogType, StoragePort } from '../../common/interfaces/storage-port.interface';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import type { ConnectionContext } from '../../common/services/multi-connection-poller';

const T0 = 1_800_000_000_000;
const INTERVAL = 30_000;

function entry(id: number): CommandLogEntry {
  return {
    id,
    timestamp: 1_800_000_000 + id,
    duration: 2_000_000,
    command: ['HGETALL', 'big'],
    clientAddress: '10.0.0.1:5000',
    clientName: 'app',
  } as CommandLogEntry;
}

type Ranges = Partial<Record<CommandLogType, [number, number]>>;

/** Per-type server logs; GET n type returns the newest n entries, newest first. */
function serverLogs(ranges: Ranges) {
  return (count: number, type: CommandLogType): Promise<CommandLogEntry[]> => {
    const range = ranges[type];
    if (range === undefined) return Promise.resolve([]);
    const [oldest, newest] = range;
    const out: CommandLogEntry[] = [];
    for (let id = newest; id >= oldest && out.length < count; id--) out.push(entry(id));
    return Promise.resolve(out);
  };
}

describe('CommandLogAnalyticsService capture gaps', () => {
  let storage: {
    getLatestCommandLogId: jest.Mock;
    saveCommandLogEntries: jest.Mock;
    getLogCaptureGapRepository: jest.Mock;
  };
  let gapRepo: { insert: jest.Mock };
  let getCommandLog: jest.Mock;
  let getInfo: jest.Mock;
  let service: CommandLogAnalyticsService;
  let now: number;

  const ctx = (): ConnectionContext =>
    ({
      connectionId: 'conn-1',
      connectionName: 'primary',
      host: 'localhost',
      port: 6379,
      client: {
        getCapabilities: () => ({ hasCommandLog: true, hasConfig: true }),
        getCommandLog,
        getInfo,
        getConfigValue: jest.fn().mockResolvedValue(null),
      } as unknown as ConnectionContext['client'],
    }) as ConnectionContext;

  const poll = (): Promise<void> =>
    (service as unknown as { pollConnection(c: ConnectionContext): Promise<void> }).pollConnection(ctx());

  const insertedGaps = (): LogCaptureGap[] => gapRepo.insert.mock.calls.map((call) => call[0]);

  beforeEach(() => {
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    gapRepo = { insert: jest.fn().mockResolvedValue(undefined) };
    storage = {
      getLatestCommandLogId: jest.fn().mockResolvedValue(100),
      saveCommandLogEntries: jest.fn().mockImplementation((rows: unknown[]) => Promise.resolve(rows.length)),
      getLogCaptureGapRepository: jest.fn().mockReturnValue(gapRepo),
    };
    getCommandLog = jest.fn();
    getInfo = jest.fn().mockResolvedValue({ server: { run_id: 'run-A' } });
    service = new CommandLogAnalyticsService(
      { getDefaultId: jest.fn().mockReturnValue('conn-1') } as unknown as ConnectionRegistry,
      storage as unknown as StoragePort,
      { isAvailable: jest.fn().mockReturnValue(true), recordFailure: jest.fn() } as unknown as RuntimeCapabilityTracker,
    );
    jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('only issues a catch-up read for the type that fell behind', async () => {
    getCommandLog.mockImplementation(
      serverLogs({ slow: [1, 150], 'large-request': [1, 400], 'large-reply': [1, 120] }),
    );

    await poll();

    expect(getCommandLog.mock.calls).toEqual([
      [128, 'slow'],
      [128, 'large-request'],
      [300, 'large-request'],
      [128, 'large-reply'],
    ]);
    expect(gapRepo.insert).not.toHaveBeenCalled();
  });

  it('records a gap per log type with the commandlog-<type> log name', async () => {
    getCommandLog.mockImplementation(
      serverLogs({ slow: [1, 100], 'large-request': [1, 100], 'large-reply': [1, 100] }),
    );
    await poll();

    now = T0 + INTERVAL;
    getCommandLog.mockImplementation(
      serverLogs({ slow: [101, 120], 'large-request': [1, 100], 'large-reply': [473, 600] }),
    );
    await poll();

    expect(insertedGaps()).toEqual([
      expect.objectContaining({
        logType: 'commandlog-large-reply',
        firstMissingId: 101,
        lastMissingId: 472,
        missingCount: 372,
        capturedCount: 128,
        cause: 'server_evicted',
        previousPollAt: T0,
      }),
    ]);
  });

  it('tracks the previous poll time per log type', async () => {
    getCommandLog.mockImplementation(serverLogs({ slow: [1, 100] }));
    await poll();

    // large-reply was empty at T0, so it still has a previous poll time.
    now = T0 + INTERVAL;
    getCommandLog.mockImplementation(serverLogs({ slow: [1, 100], 'large-reply': [473, 600] }));
    await poll();

    const [gap] = insertedGaps();
    expect(gap.logType).toBe('commandlog-large-reply');
    expect(gap.previousPollAt).toBe(T0);
    expect(gap.cause).toBe('server_evicted');
  });

  it('records the poll time per type after that type finishes', async () => {
    // A slow read of the first type must not age the previous-poll time of the others.
    getCommandLog.mockImplementation(async (count: number, type: CommandLogType) => {
      if (type === 'slow') now += 3 * INTERVAL + 1;
      return serverLogs({ slow: [1, 100], 'large-reply': [1, 100] })(count, type);
    });
    await poll();
    const firstPollEnd = T0 + 3 * INTERVAL + 1;

    now = firstPollEnd + INTERVAL;
    getCommandLog.mockImplementation(serverLogs({ slow: [1, 100], 'large-reply': [473, 600] }));
    await poll();

    const [gap] = insertedGaps();
    expect(gap.logType).toBe('commandlog-large-reply');
    expect(gap.previousPollAt).toBe(firstPollEnd);
    expect(gap.cause).toBe('server_evicted');
  });

  it('merges the regular batch with the catch-up read and records only the true hole', async () => {
    getCommandLog.mockImplementation(serverLogs({ slow: [1, 100] }));
    await poll();

    now = T0 + INTERVAL;
    getCommandLog.mockReset();
    // First slow read sees 103..230; by the catch-up read the server is at 280.
    getCommandLog
      .mockImplementationOnce(serverLogs({ slow: [103, 230] }))
      .mockImplementationOnce(serverLogs({ slow: [151, 280] }))
      .mockResolvedValue([]);
    await poll();

    expect(getCommandLog.mock.calls.slice(0, 2)).toEqual([[128, 'slow'], [130, 'slow']]);
    const saved = storage.saveCommandLogEntries.mock.calls[0][0].map((row: { id: number }) => row.id);
    expect(saved).toHaveLength(178);
    expect(insertedGaps()).toEqual([
      expect.objectContaining({ logType: 'commandlog-slow', firstMissingId: 101, lastMissingId: 102, missingCount: 2 }),
    ]);
  });

  it('keeps the regular batch when the catch-up read fails', async () => {
    getCommandLog.mockImplementation(serverLogs({ slow: [1, 100] }));
    await poll();

    now = T0 + INTERVAL;
    getCommandLog.mockReset();
    getCommandLog
      .mockImplementationOnce(serverLogs({ slow: [273, 400] }))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue([]);
    await expect(poll()).resolves.toBeUndefined();

    expect(storage.saveCommandLogEntries.mock.calls[0][0]).toHaveLength(128);
    const logger = (service as unknown as { logger: { warn: jest.Mock } }).logger;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Catch-up read failed'));
  });

  describe('server restart detection (run_id)', () => {
    it('saves everything and records no gap for any type when run_id changes', async () => {
      getCommandLog.mockImplementation(serverLogs({ slow: [1, 100], 'large-request': [1, 100], 'large-reply': [1, 100] }));
      await poll();

      now = T0 + INTERVAL;
      getInfo.mockResolvedValue({ server: { run_id: 'run-B' } });
      getCommandLog.mockImplementation(
        serverLogs({ slow: [73, 200], 'large-request': [73, 200], 'large-reply': [73, 200] }),
      );
      await poll();

      expect(gapRepo.insert).not.toHaveBeenCalled();
      expect(storage.saveCommandLogEntries).toHaveBeenCalledTimes(3);
      for (const call of storage.saveCommandLogEntries.mock.calls) expect(call[0]).toHaveLength(128);
    });

    it('keeps the existing gap behaviour when run_id is unchanged', async () => {
      getCommandLog.mockImplementation(serverLogs({ slow: [1, 100], 'large-reply': [1, 100] }));
      await poll();

      now = T0 + INTERVAL;
      getCommandLog.mockImplementation(serverLogs({ slow: [1, 100], 'large-reply': [473, 600] }));
      await poll();

      expect(insertedGaps()).toHaveLength(1);
    });

    it('falls back to id-based detection when INFO fails', async () => {
      getInfo.mockRejectedValue(new Error('NOPERM'));
      getCommandLog.mockImplementation(serverLogs({ slow: [1, 100], 'large-reply': [1, 100] }));
      await poll();

      now = T0 + INTERVAL;
      getCommandLog.mockImplementation(serverLogs({ slow: [1, 100], 'large-reply': [473, 600] }));
      await expect(poll()).resolves.toBeUndefined();

      expect(insertedGaps()).toHaveLength(1);
    });
  });

  it('forgets per-connection poll times when the connection is removed', async () => {
    getCommandLog.mockImplementation(serverLogs({ slow: [1, 100] }));
    await poll();

    (service as unknown as { onConnectionRemoved(id: string): void }).onConnectionRemoved('conn-1');

    now = T0 + INTERVAL;
    getCommandLog.mockImplementation(serverLogs({ slow: [473, 600] }));
    await poll();

    const [gap] = insertedGaps();
    expect(gap.previousPollAt).toBeNull();
    expect(gap.cause).toBe('monitor_offline');
  });
});
