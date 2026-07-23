import { KeyAnalyticsService } from './key-analytics.service';
import type { ConnectionRegistry } from '@app/connections/connection-registry.service';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import type { LicenseService } from '@proprietary/licenses';

describe('KeyAnalyticsService.getLargestKeys', () => {
  const storage = {
    getHotKeys: jest.fn(),
  };

  function makeService(): KeyAnalyticsService {
    return new KeyAnalyticsService(
      { list: jest.fn().mockReturnValue([]) } as unknown as ConnectionRegistry,
      storage as unknown as StoragePort,
      { hasFeature: jest.fn().mockReturnValue(true) } as unknown as LicenseService,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ranks entries by memoryBytes descending, not cardinality', async () => {
    storage.getHotKeys.mockResolvedValue([
      { keyName: 'big-set', cardinality: 10_000_000, memoryBytes: 40_000_000 },
      { keyName: 'blob-hash', cardinality: 1_000, memoryBytes: 900_000_000 },
      { keyName: 'no-memory', cardinality: 5_000_000 },
    ]);
    const service = makeService();
    const res = await service.getLargestKeys({ connectionId: 'c1', latest: true });
    expect(res.map((e) => e.keyName)).toEqual(['blob-hash', 'big-set', 'no-memory']);
  });

  it('renumbers rank to match the memory ordering', async () => {
    storage.getHotKeys.mockResolvedValue([
      { keyName: 'big-set', rank: 1, memoryBytes: 40 },
      { keyName: 'blob-hash', rank: 2, memoryBytes: 900 },
    ]);
    const service = makeService();
    const res = await service.getLargestKeys({ connectionId: 'c1', latest: true });
    expect(res.map((e) => [e.keyName, e.rank])).toEqual([
      ['blob-hash', 1],
      ['big-set', 2],
    ]);
  });

  it('applies the caller limit after ranking and fetches with the explicit cap', async () => {
    storage.getHotKeys.mockResolvedValue([
      { keyName: 'a', memoryBytes: 1 },
      { keyName: 'b', memoryBytes: 3 },
      { keyName: 'c', memoryBytes: 2 },
    ]);
    const service = makeService();
    const res = await service.getLargestKeys({ connectionId: 'c1', limit: 2, latest: true });
    expect(res.map((e) => e.keyName)).toEqual(['b', 'c']);
    expect(storage.getHotKeys).toHaveBeenCalledWith({
      connectionId: 'c1',
      latest: true,
      signalTypes: ['cardinality'],
      limit: 10_000,
    });
  });
});
