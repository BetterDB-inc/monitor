import { Test, TestingModule } from '@nestjs/testing';
import { DataRetentionService } from '../data-retention.service';
import { LicenseService } from '@proprietary/license/license.service';
import { Tier } from '@proprietary/license/types';
import { StoragePort } from '@app/common/interfaces/storage-port.interface';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe('DataRetentionService', () => {
  let service: DataRetentionService;
  let storage: jest.Mocked<StoragePort>;
  let licenseService: jest.Mocked<LicenseService>;
  let originalCloudMode: string | undefined;

  beforeEach(async () => {
    originalCloudMode = process.env.CLOUD_MODE;
    process.env.CLOUD_MODE = 'true';

    storage = {
      pruneOldSlowLogEntries: jest.fn().mockResolvedValue(1),
      pruneOldCommandLogEntries: jest.fn().mockResolvedValue(2),
      pruneOldClientSnapshots: jest.fn().mockResolvedValue(3),
      pruneOldAnomalyEvents: jest.fn().mockResolvedValue(4),
      pruneOldCorrelatedGroups: jest.fn().mockResolvedValue(5),
      pruneOldKeyPatternSnapshots: jest.fn().mockResolvedValue(6),
      pruneOldEntries: jest.fn().mockResolvedValue(7),
      pruneOldDeliveries: jest.fn().mockResolvedValue(8),
    } as any;

    licenseService = {
      getLicenseTier: jest.fn().mockReturnValue(Tier.community),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataRetentionService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: LicenseService, useValue: licenseService },
      ],
    }).compile();

    service = module.get<DataRetentionService>(DataRetentionService);

    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalCloudMode === undefined) {
      delete process.env.CLOUD_MODE;
    } else {
      process.env.CLOUD_MODE = originalCloudMode;
    }
  });

  const allPruneMethods = [
    'pruneOldSlowLogEntries',
    'pruneOldCommandLogEntries',
    'pruneOldClientSnapshots',
    'pruneOldAnomalyEvents',
    'pruneOldCorrelatedGroups',
    'pruneOldKeyPatternSnapshots',
    'pruneOldEntries',
    'pruneOldDeliveries',
  ] as const;

  it('community tier uses 7-day cutoff and calls all 8 prune methods', async () => {
    licenseService.getLicenseTier.mockReturnValue(Tier.community);
    const expectedCutoff = NOW - 7 * MS_PER_DAY;

    await service.runRetention();

    for (const method of allPruneMethods) {
      expect(storage[method]).toHaveBeenCalledTimes(1);
      expect(storage[method]).toHaveBeenCalledWith(expectedCutoff);
    }
  });

  it('pro tier uses 90-day cutoff', async () => {
    licenseService.getLicenseTier.mockReturnValue(Tier.pro);
    const expectedCutoff = NOW - 90 * MS_PER_DAY;

    await service.runRetention();

    for (const method of allPruneMethods) {
      expect(storage[method]).toHaveBeenCalledWith(expectedCutoff);
    }
  });

  it('enterprise tier uses 365-day cutoff', async () => {
    licenseService.getLicenseTier.mockReturnValue(Tier.enterprise);
    const expectedCutoff = NOW - 365 * MS_PER_DAY;

    await service.runRetention();

    for (const method of allPruneMethods) {
      expect(storage[method]).toHaveBeenCalledWith(expectedCutoff);
    }
  });

  it('continues pruning other tables when one throws', async () => {
    storage.pruneOldCommandLogEntries.mockRejectedValue(new Error('db error'));

    await service.runRetention();

    // The failing method was still called
    expect(storage.pruneOldCommandLogEntries).toHaveBeenCalledTimes(1);

    // All other methods were called despite the failure
    for (const method of allPruneMethods) {
      expect(storage[method]).toHaveBeenCalledTimes(1);
    }
  });

  it('skips all prune methods when CLOUD_MODE is not true', async () => {
    process.env.CLOUD_MODE = 'false';

    await service.runRetention();

    for (const method of allPruneMethods) {
      expect(storage[method]).not.toHaveBeenCalled();
    }
  });
});
