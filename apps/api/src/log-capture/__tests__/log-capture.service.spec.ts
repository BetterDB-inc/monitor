import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { LogCaptureGap } from '@betterdb/shared';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import { LogCaptureService } from '../log-capture.service';
import { LogCaptureController, DEFAULT_WINDOW_HOURS } from '../log-capture.controller';
import { LOG_CAPTURE_AUX_TIMEOUT_MS, LOG_CATCH_UP_MAX_FETCH } from '../capture-gap';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function gap(overrides: Partial<LogCaptureGap> = {}): LogCaptureGap {
  return {
    id: `g-${Math.random()}`,
    connectionId: 'conn-1',
    logType: 'slowlog',
    firstMissingId: 101,
    lastMissingId: 272,
    missingCount: 172,
    cause: 'server_evicted',
    capturedCount: 128,
    previousPollAt: NOW - 30_000,
    detectedAt: NOW - HOUR,
    ...overrides,
  };
}

describe('LogCaptureService', () => {
  let storage: MemoryAdapter;
  let getConfigValue: jest.Mock;
  let capabilities: { hasCommandLog: boolean; hasConfig: boolean };
  let registry: { getDefaultId: jest.Mock; get: jest.Mock };
  let service: LogCaptureService;

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    storage = new MemoryAdapter();
    await storage.initialize();
    getConfigValue = jest.fn().mockResolvedValue('128');
    capabilities = { hasCommandLog: false, hasConfig: true };
    registry = {
      getDefaultId: jest.fn().mockReturnValue('conn-1'),
      get: jest.fn().mockReturnValue({ getCapabilities: () => capabilities, getConfigValue }),
    };
    service = new LogCaptureService(storage, registry as unknown as ConnectionRegistry);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports only the slow log when the server has no COMMANDLOG', async () => {
    const summary = await service.getSummary('conn-1', 24 * HOUR);
    expect(summary.logs.map((log) => log.logType)).toEqual(['slowlog']);
    expect(summary.totalMissingEntries).toBe(0);
    expect(summary.maxFetchPerPoll).toBe(LOG_CATCH_UP_MAX_FETCH);
    expect(summary.since).toBe(NOW - 24 * HOUR);
    expect(getConfigValue).not.toHaveBeenCalled();
  });

  it('reports every command log type when the server has COMMANDLOG', async () => {
    capabilities.hasCommandLog = true;
    const summary = await service.getSummary('conn-1', 24 * HOUR);
    expect(summary.logs.map((log) => log.logType)).toEqual([
      'slowlog',
      'commandlog-slow',
      'commandlog-large-request',
      'commandlog-large-reply',
    ]);
  });

  it('summarizes gaps in the window and recommends a max-len from the server value', async () => {
    const repo = storage.getLogCaptureGapRepository();
    await repo.insert(gap({ missingCount: 172, capturedCount: 128 }));
    await repo.insert(gap({ detectedAt: NOW - 48 * HOUR, missingCount: 9_999 }));
    await repo.insert(gap({ connectionId: 'conn-2' }));

    const summary = await service.getSummary('conn-1', 24 * HOUR);
    const slowlog = summary.logs[0];

    expect(getConfigValue).toHaveBeenCalledWith('slowlog-max-len');
    expect(summary.totalMissingEntries).toBe(172);
    expect(slowlog).toMatchObject({
      logType: 'slowlog',
      missingEntries: 172,
      gapCount: 1,
      dominantCause: 'server_evicted',
      configParameter: 'slowlog-max-len',
      currentMaxLen: 128,
      recommendedMaxLen: 1024,
    });
  });

  it('keeps a log type that has stored gaps even after the capability went away', async () => {
    await storage.getLogCaptureGapRepository().insert(gap({ logType: 'commandlog-large-reply' }));
    const summary = await service.getSummary('conn-1', 24 * HOUR);
    expect(summary.logs.map((log) => log.logType)).toEqual(['slowlog', 'commandlog-large-reply']);
  });

  it('leaves currentMaxLen null when CONFIG is unavailable and still recommends', async () => {
    capabilities.hasConfig = false;
    await storage.getLogCaptureGapRepository().insert(gap());
    const [slowlog] = (await service.getSummary('conn-1', 24 * HOUR)).logs;
    expect(getConfigValue).not.toHaveBeenCalled();
    expect(slowlog.currentMaxLen).toBeNull();
    expect(slowlog.recommendedMaxLen).toBe(1024);
  });

  it('treats a CONFIG GET failure or a non-numeric value as unknown', async () => {
    await storage.getLogCaptureGapRepository().insert(gap());
    getConfigValue.mockRejectedValueOnce(new Error('NOPERM'));
    expect((await service.getSummary('conn-1', 24 * HOUR)).logs[0].currentMaxLen).toBeNull();

    const other = new LogCaptureService(storage, registry as unknown as ConnectionRegistry);
    getConfigValue.mockResolvedValueOnce('not-a-number');
    expect((await other.getSummary('conn-1', 24 * HOUR)).logs[0].currentMaxLen).toBeNull();
  });

  it('caches the CONFIG GET result for five minutes', async () => {
    await storage.getLogCaptureGapRepository().insert(gap());
    await service.getSummary('conn-1', 24 * HOUR);
    await service.getSummary('conn-1', 24 * HOUR);
    expect(getConfigValue).toHaveBeenCalledTimes(1);

    (Date.now as jest.Mock).mockReturnValue(NOW + 5 * 60_000);
    await service.getSummary('conn-1', 24 * HOUR);
    expect(getConfigValue).toHaveBeenCalledTimes(2);
  });

  it('re-reads max-len when a gap newer than the cached read exists', async () => {
    const repo = storage.getLogCaptureGapRepository();
    await repo.insert(gap());
    await service.getSummary('conn-1', 24 * HOUR);
    expect(getConfigValue).toHaveBeenCalledTimes(1);

    // An operator raised the setting after the first read; a fresh gap arrived since.
    getConfigValue.mockResolvedValue('4096');
    (Date.now as jest.Mock).mockReturnValue(NOW + 60_000);
    await repo.insert(gap({ detectedAt: NOW + 30_000 }));
    const [slowlog] = (await service.getSummary('conn-1', 24 * HOUR)).logs;

    expect(getConfigValue).toHaveBeenCalledTimes(2);
    expect(slowlog.currentMaxLen).toBe(4096);
  });

  it('returns with currentMaxLen null when CONFIG GET never resolves', async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    try {
      await storage.getLogCaptureGapRepository().insert(gap());
      getConfigValue.mockReturnValue(new Promise(() => undefined));
      const pending = service.getSummary('conn-1', 24 * HOUR);
      await jest.advanceTimersByTimeAsync(LOG_CAPTURE_AUX_TIMEOUT_MS);
      const [slowlog] = (await pending).logs;
      expect(slowlog.currentMaxLen).toBeNull();
      expect(slowlog.recommendedMaxLen).toBe(1024);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not fail when the connection is not registered any more', async () => {
    registry.get.mockImplementation(() => {
      throw new NotFoundException('gone');
    });
    await storage.getLogCaptureGapRepository().insert(gap());
    const summary = await service.getSummary('conn-1', 24 * HOUR);
    expect(summary.logs.map((log) => log.logType)).toEqual(['slowlog']);
    expect(summary.logs[0].currentMaxLen).toBeNull();
  });

  it('falls back to the default connection and 404s without one', async () => {
    expect((await service.getSummary(undefined, HOUR)).connectionId).toBe('conn-1');
    registry.getDefaultId.mockReturnValue(null);
    await expect(service.getSummary(undefined, HOUR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists gaps for the resolved connection', async () => {
    await storage.getLogCaptureGapRepository().insert(gap({ id: 'mine' }));
    await storage.getLogCaptureGapRepository().insert(gap({ id: 'other', connectionId: 'conn-2' }));
    const rows = await service.listGaps(undefined, { limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(['mine']);
  });
});

describe('LogCaptureController', () => {
  let service: { getSummary: jest.Mock; listGaps: jest.Mock };
  let controller: LogCaptureController;

  beforeEach(() => {
    service = { getSummary: jest.fn().mockResolvedValue({}), listGaps: jest.fn().mockResolvedValue([]) };
    controller = new LogCaptureController(service as unknown as LogCaptureService);
  });

  it('defaults the summary window to 24 hours', async () => {
    await controller.getSummary('conn-1');
    expect(service.getSummary).toHaveBeenCalledWith('conn-1', DEFAULT_WINDOW_HOURS * HOUR);
  });

  it('accepts a window between 1 and 720 hours', async () => {
    await controller.getSummary('conn-1', '720');
    expect(service.getSummary).toHaveBeenCalledWith('conn-1', 720 * HOUR);
    for (const bad of ['0', '721', '1.5', 'abc']) {
      await expect(controller.getSummary('conn-1', bad)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('passes gap filters through and defaults the limit to 100', async () => {
    await controller.getGaps('conn-1', 'commandlog-slow', '10', '20');
    expect(service.listGaps).toHaveBeenCalledWith('conn-1', {
      logType: 'commandlog-slow',
      since: 10,
      until: 20,
      limit: 100,
    });
  });

  it('rejects an unknown log type and an out-of-range limit', async () => {
    await expect(controller.getGaps('conn-1', 'aof')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.getGaps('conn-1', undefined, undefined, undefined, '1001')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
