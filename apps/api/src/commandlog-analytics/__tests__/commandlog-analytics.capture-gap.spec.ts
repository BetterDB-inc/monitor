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
  let service: CommandLogAnalyticsService;
  let now: number;

  const ctx = (): ConnectionContext =>
    ({
      connectionId: 'conn-1',
      connectionName: 'primary',
      host: 'localhost',
      port: 6379,
      client: {
        getCapabilities: () => ({ hasCommandLog: true }),
        getCommandLog,
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
