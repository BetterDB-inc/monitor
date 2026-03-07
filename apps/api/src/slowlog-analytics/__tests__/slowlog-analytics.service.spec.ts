import { Test, TestingModule } from '@nestjs/testing';
import { SlowLogAnalyticsService } from '../slowlog-analytics.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { SettingsService } from '../../settings/settings.service';
import { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('SlowLogAnalyticsService', () => {
  let service: SlowLogAnalyticsService;
  let storageClient: jest.Mocked<StoragePort>;

  beforeEach(async () => {
    storageClient = {
      pruneOldSlowLogEntries: jest.fn().mockResolvedValue(5),
      getLatestSlowLogId: jest.fn().mockResolvedValue(null),
    } as any;

    const connectionRegistry = {
      getDefaultId: jest.fn().mockReturnValue('default-conn'),
      getAll: jest.fn().mockReturnValue([]),
      on: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    const settingsService = {
      getCachedSettings: jest.fn().mockReturnValue({ anomalyPollIntervalMs: 30000 }),
    } as any;

    const runtimeCapabilityTracker = {
      isAvailable: jest.fn().mockReturnValue(true),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlowLogAnalyticsService,
        { provide: 'STORAGE_CLIENT', useValue: storageClient },
        { provide: ConnectionRegistry, useValue: connectionRegistry },
        { provide: SettingsService, useValue: settingsService },
        { provide: RuntimeCapabilityTracker, useValue: runtimeCapabilityTracker },
      ],
    }).compile();

    service = module.get<SlowLogAnalyticsService>(SlowLogAnalyticsService);
  });

  describe('pruneOldEntries', () => {
    it('should call storage with 7-day cutoff', async () => {
      const NOW = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries(7);

      expect(storageClient.pruneOldSlowLogEntries).toHaveBeenCalledTimes(1);
      const cutoff = storageClient.pruneOldSlowLogEntries.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 7 * MS_PER_DAY, -3);

      jest.restoreAllMocks();
    });

    it('should call storage with 30-day cutoff', async () => {
      const NOW = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries(30);

      const cutoff = storageClient.pruneOldSlowLogEntries.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 30 * MS_PER_DAY, -3);

      jest.restoreAllMocks();
    });

    it('should default to 7 days when no argument is provided', async () => {
      const NOW = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries();

      const cutoff = storageClient.pruneOldSlowLogEntries.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 7 * MS_PER_DAY, -3);

      jest.restoreAllMocks();
    });

    it('should pass connectionId through to storage', async () => {
      await service.pruneOldEntries(7, 'my-connection');

      expect(storageClient.pruneOldSlowLogEntries).toHaveBeenCalledWith(
        expect.any(Number),
        'my-connection',
      );
    });

    it('should return the count from storage', async () => {
      storageClient.pruneOldSlowLogEntries.mockResolvedValue(42);

      const result = await service.pruneOldEntries(7);

      expect(result).toBe(42);
    });
  });
});
