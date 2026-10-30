import type { LogCaptureGap } from '@betterdb/shared';
import { SlowLogAnalyticsService } from '../slowlog-analytics.service';
import type { SlowLogEntry } from '../../common/interfaces/database-port.interface';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { SettingsService } from '../../settings/settings.service';
import type { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import type { ConnectionContext } from '../../common/services/multi-connection-poller';
import { LOG_CAPTURE_AUX_TIMEOUT_MS, LOG_CATCH_UP_MAX_FETCH } from '../../log-capture/capture-gap';

const T0 = 1_800_000_000_000;
const INTERVAL = 30_000;

function entry(id: number): SlowLogEntry {
  return {
    id,
    timestamp: 1_800_000_000 + id,
    duration: 20_000,
    command: ['KEYS', '*'],
    clientAddress: '10.0.0.1:5000',
    clientName: 'app',
  };
}

/** Server log holding ids [oldest, newest]; GET n returns the newest n, newest first. */
function serverLog(oldest: number, newest: number) {
  return (count: number): Promise<SlowLogEntry[]> => {
    const out: SlowLogEntry[] = [];
    for (let id = newest; id >= oldest && out.length < count; id--) out.push(entry(id));
    return Promise.resolve(out);
  };
}

describe('SlowLogAnalyticsService capture gaps', () => {
  let storage: {
    getLatestSlowLogId: jest.Mock;
    saveSlowLogEntries: jest.Mock;
    getLogCaptureGapRepository: jest.Mock;
  };
  let gapRepo: { insert: jest.Mock };
  let service: SlowLogAnalyticsService;
  let getSlowLog: jest.Mock;
  let getInfo: jest.Mock;
  let getConfigValue: jest.Mock;
  let now: number;

  const ctx = (): ConnectionContext =>
    ({
      connectionId: 'conn-1',
      connectionName: 'primary',
      host: 'localhost',
      port: 6379,
      client: {
        getSlowLog,
        getInfo,
        getCapabilities: () => ({ hasConfig: true }),
        getConfigValue,
      } as unknown as ConnectionContext['client'],
    }) as ConnectionContext;

  const poll = (): Promise<void> =>
    (service as unknown as { pollConnection(c: ConnectionContext): Promise<void> }).pollConnection(ctx());

  const insertedGaps = (): LogCaptureGap[] => gapRepo.insert.mock.calls.map((call) => call[0]);
  const savedIds = (call: number): number[] =>
    storage.saveSlowLogEntries.mock.calls[call][0].map((row: { id: number }) => row.id);

  beforeEach(() => {
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    gapRepo = { insert: jest.fn().mockResolvedValue(undefined) };
    storage = {
      getLatestSlowLogId: jest.fn().mockResolvedValue(null),
      saveSlowLogEntries: jest.fn().mockImplementation((rows: unknown[]) => Promise.resolve(rows.length)),
      getLogCaptureGapRepository: jest.fn().mockReturnValue(gapRepo),
    };
    getSlowLog = jest.fn();
    getInfo = jest.fn().mockResolvedValue({ server: { run_id: 'run-A' } });
    getConfigValue = jest.fn().mockResolvedValue(null);
    service = new SlowLogAnalyticsService(
      { getDefaultId: jest.fn().mockReturnValue('conn-1') } as unknown as ConnectionRegistry,
      storage as unknown as StoragePort,
      {} as SettingsService,
      { isAvailable: jest.fn().mockReturnValue(true), recordFailure: jest.fn() } as unknown as RuntimeCapabilityTracker,
    );
    jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the single 128-entry read in steady state and records nothing', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(100);
    getSlowLog.mockImplementation(serverLog(1, 150));

    await poll();

    expect(getSlowLog).toHaveBeenCalledTimes(1);
    expect(getSlowLog).toHaveBeenCalledWith(128);
    expect(savedIds(0)).toHaveLength(50);
    expect(gapRepo.insert).not.toHaveBeenCalled();
  });

  it('reads back to the last seen id when more than 128 entries arrived and the server still has them', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(100);
    getSlowLog.mockImplementation(serverLog(1, 400));

    await poll();

    expect(getSlowLog.mock.calls).toEqual([[128], [300]]);
    const ids = savedIds(0);
    expect(ids).toHaveLength(300);
    expect(Math.min(...ids)).toBe(101);
    expect(gapRepo.insert).not.toHaveBeenCalled();
    expect(service.getLastSeenId('conn-1')).toBe(400);
  });

  it('keeps the regular 128-entry batch in the Prometheus cache after a catch-up read', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(100);
    getSlowLog.mockImplementation(serverLog(1, 400));

    await poll();

    const cached = service.getCachedEntries('conn-1');
    expect(cached).toHaveLength(128);
    expect(cached[0].id).toBe(400);
    expect(cached[127].id).toBe(273);
  });

  it('records a server_evicted gap with the exact missing range on a steady poll', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(100);
    getSlowLog.mockImplementation(serverLog(1, 110));
    await poll();

    now = T0 + INTERVAL;
    // 300 new entries (111..410) but the server only retains the newest 128.
    getSlowLog.mockImplementation(serverLog(283, 410));
    await poll();

    expect(getSlowLog.mock.calls.slice(1)).toEqual([[128], [300]]);
    expect(insertedGaps()).toEqual([
      expect.objectContaining({
        connectionId: 'conn-1',
        logType: 'slowlog',
        firstMissingId: 111,
        lastMissingId: 282,
        missingCount: 172,
        capturedCount: 128,
        cause: 'server_evicted',
        previousPollAt: T0,
        detectedAt: T0 + INTERVAL,
      }),
    ]);
    expect(service.getLastSeenId('conn-1')).toBe(410);
  });

  it('classifies a gap on the first poll after a restart as monitor_offline', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(100);
    getSlowLog.mockImplementation(serverLog(9_873, 10_000));

    await poll();

    const [gap] = insertedGaps();
    expect(gap.cause).toBe('monitor_offline');
    expect(gap.previousPollAt).toBeNull();
    expect(gap.firstMissingId).toBe(101);
    expect(gap.lastMissingId).toBe(9_872);
  });

  it('classifies a burst beyond the catch-up cap as fetch_limit', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(0);
    getSlowLog.mockImplementation(serverLog(0, 0));
    await poll();

    now = T0 + INTERVAL;
    getSlowLog.mockImplementation(serverLog(1, 10_000));
    await poll();

    expect(getSlowLog).toHaveBeenLastCalledWith(LOG_CATCH_UP_MAX_FETCH);
    const [gap] = insertedGaps();
    expect(gap.cause).toBe('fetch_limit');
    expect(gap.missingCount).toBe(10_000 - LOG_CATCH_UP_MAX_FETCH);
  });

  it('does not report a gap when ids restart (server restart / wraparound)', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(5_000);
    getSlowLog.mockImplementation(serverLog(1, 10));

    await poll();

    expect(getSlowLog).toHaveBeenCalledTimes(1);
    expect(gapRepo.insert).not.toHaveBeenCalled();
  });

  it('merges the regular batch with the catch-up read when the server advanced in between', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(100);
    getSlowLog.mockImplementation(serverLog(1, 100));
    await poll();

    now = T0 + INTERVAL;
    getSlowLog.mockReset();
    getSlowLog
      .mockImplementationOnce(serverLog(103, 230))
      .mockImplementationOnce(serverLog(151, 280));
    await poll();

    expect(getSlowLog.mock.calls).toEqual([[128], [130]]);
    const ids = savedIds(0);
    expect(ids).toHaveLength(178);
    expect(Math.min(...ids)).toBe(103);
    expect(Math.max(...ids)).toBe(280);
    expect(insertedGaps()).toEqual([
      expect.objectContaining({ firstMissingId: 101, lastMissingId: 102, missingCount: 2, cause: 'server_evicted' }),
    ]);
    expect(service.getLastSeenId('conn-1')).toBe(280);
  });

  it('keeps the regular batch when the catch-up read fails', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(100);
    getSlowLog
      .mockImplementationOnce(serverLog(273, 400))
      .mockRejectedValueOnce(new Error('timeout'));

    await expect(poll()).resolves.toBeUndefined();

    expect(savedIds(0)).toHaveLength(128);
    expect(service.getLastSeenId('conn-1')).toBe(400);
    const logger = (service as unknown as { logger: { warn: jest.Mock } }).logger;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Catch-up read failed'));
  });

  it('splits a fetch_limit hole using the server max-len', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(0);
    getSlowLog.mockImplementation(serverLog(0, 0));
    await poll();

    now = T0 + INTERVAL;
    getConfigValue.mockResolvedValue('4096');
    getSlowLog.mockImplementation(serverLog(1, 10_000));
    await poll();

    expect(getConfigValue).toHaveBeenCalledWith('slowlog-max-len');
    expect(insertedGaps().map((gap) => [gap.cause, gap.firstMissingId, gap.lastMissingId])).toEqual([
      ['server_evicted', 1, 5_904],
      ['fetch_limit', 5_905, 8_976],
    ]);
  });

  describe('server restart detection (run_id)', () => {
    it('saves everything and records no gap when run_id changes and new ids pass lastSeenId', async () => {
      storage.getLatestSlowLogId.mockResolvedValue(100);
      getSlowLog.mockImplementation(serverLog(1, 110));
      await poll();

      now = T0 + INTERVAL;
      getInfo.mockResolvedValue({ server: { run_id: 'run-B' } });
      // The restarted server already logged past lastSeenId (110) with a 128-entry log.
      getSlowLog.mockImplementation(serverLog(73, 200));
      await poll();

      expect(getSlowLog).toHaveBeenCalledTimes(2);
      expect(savedIds(1)).toHaveLength(128);
      expect(gapRepo.insert).not.toHaveBeenCalled();
      expect(service.getLastSeenId('conn-1')).toBe(200);
    });

    it('keeps the existing gap behaviour when run_id is unchanged', async () => {
      storage.getLatestSlowLogId.mockResolvedValue(100);
      getSlowLog.mockImplementation(serverLog(1, 110));
      await poll();

      now = T0 + INTERVAL;
      getSlowLog.mockImplementation(serverLog(283, 410));
      await poll();

      expect(insertedGaps()).toHaveLength(1);
      expect(insertedGaps()[0].cause).toBe('server_evicted');
    });

    it('falls back to id-based detection when INFO fails', async () => {
      getInfo.mockRejectedValue(new Error('NOPERM'));
      storage.getLatestSlowLogId.mockResolvedValue(100);
      getSlowLog.mockImplementation(serverLog(1, 110));
      await poll();

      now = T0 + INTERVAL;
      getSlowLog.mockImplementation(serverLog(283, 410));
      await expect(poll()).resolves.toBeUndefined();

      expect(insertedGaps()).toHaveLength(1);
      expect(service.getLastSeenId('conn-1')).toBe(410);
    });

    it('forgets the run_id when the connection is removed', async () => {
      storage.getLatestSlowLogId.mockResolvedValue(100);
      getSlowLog.mockImplementation(serverLog(1, 110));
      await poll();
      (service as unknown as { onConnectionRemoved(id: string): void }).onConnectionRemoved('conn-1');

      getInfo.mockResolvedValue({ server: { run_id: 'run-B' } });
      storage.getLatestSlowLogId.mockResolvedValue(110);
      getSlowLog.mockImplementation(serverLog(283, 410));
      await poll();

      // No previous run_id: the id-based path decides, so the hole is still reported.
      expect(insertedGaps()).toHaveLength(1);
    });
  });

  it('stops waiting for a hung gap insert and still advances the last seen id', async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    try {
      storage.getLatestSlowLogId.mockResolvedValue(100);
      gapRepo.insert.mockReturnValue(new Promise(() => undefined));
      getSlowLog.mockImplementation(serverLog(273, 400));

      const pending = poll();
      await jest.advanceTimersByTimeAsync(LOG_CAPTURE_AUX_TIMEOUT_MS);
      await expect(pending).resolves.toBeUndefined();

      expect(service.getLastSeenId('conn-1')).toBe(400);
      const logger = (service as unknown as { logger: { warn: jest.Mock } }).logger;
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to record'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('still advances the last seen id when the gap cannot be stored', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(100);
    gapRepo.insert.mockRejectedValue(new Error('disk full'));
    getSlowLog.mockImplementation(serverLog(273, 400));

    await expect(poll()).resolves.toBeUndefined();

    expect(storage.saveSlowLogEntries).toHaveBeenCalledTimes(1);
    expect(service.getLastSeenId('conn-1')).toBe(400);
  });

  it('does not record the same gap twice when entries fail to save', async () => {
    storage.getLatestSlowLogId.mockResolvedValue(100);
    storage.saveSlowLogEntries.mockRejectedValueOnce(new Error('storage down'));
    getSlowLog.mockImplementation(serverLog(273, 400));

    await expect(poll()).rejects.toThrow('storage down');
    expect(gapRepo.insert).not.toHaveBeenCalled();

    await poll();
    expect(gapRepo.insert).toHaveBeenCalledTimes(1);
  });
});
