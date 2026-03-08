import { Test, TestingModule } from '@nestjs/testing';
import { MemoryAnalyticsService } from '../memory-analytics.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ConnectionContext } from '../../common/services/multi-connection-poller';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe('MemoryAnalyticsService', () => {
  let service: MemoryAnalyticsService;
  let storage: jest.Mocked<StoragePort>;

  beforeEach(async () => {
    storage = {
      saveMemorySnapshots: jest.fn().mockResolvedValue(1),
      getMemorySnapshots: jest.fn().mockResolvedValue([]),
      pruneOldMemorySnapshots: jest.fn().mockResolvedValue(5),
    } as any;

    const connectionRegistry = {
      getDefaultId: jest.fn().mockReturnValue('default-conn'),
      getAll: jest.fn().mockReturnValue([]),
      list: jest.fn().mockReturnValue([]),
      on: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryAnalyticsService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ConnectionRegistry, useValue: connectionRegistry },
      ],
    }).compile();

    service = module.get<MemoryAnalyticsService>(MemoryAnalyticsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('pollConnection', () => {
    const makeCtx = (client: any, connectionId = 'conn-1'): ConnectionContext => ({
      connectionId,
      connectionName: 'test-conn',
      client,
      host: 'localhost',
      port: 6379,
    });

    it('should save a memory snapshot', async () => {
      const client = {
        getMemoryStats: jest.fn().mockResolvedValue({
          peakAllocated: 2000000,
          totalAllocated: 1000000,
          startupAllocated: 500000,
          replicationBacklog: 0,
          clientsNormal: 1000,
          clientsReplicas: 0,
          aofBuffer: 0,
          dbDict: 100,
          dbExpires: 50,
          usedMemoryRss: 1500000,
          memFragmentationRatio: 1.5,
          maxmemory: 4000000,
          allocatorFragRatio: 1.1,
        }),
      };

      await (service as any).pollConnection(makeCtx(client));

      expect(storage.saveMemorySnapshots).toHaveBeenCalledTimes(1);
      const savedSnapshots = storage.saveMemorySnapshots.mock.calls[0][0];
      expect(savedSnapshots).toHaveLength(1);
      expect(savedSnapshots[0]).toMatchObject({
        usedMemory: 1000000,
        usedMemoryPeak: 2000000,
        usedMemoryRss: 1500000,
        memFragmentationRatio: 1.5,
        maxmemory: 4000000,
        allocatorFragRatio: 1.1,
        connectionId: 'conn-1',
      });
    });

    it('should default optional fields to 0 when not present', async () => {
      const client = {
        getMemoryStats: jest.fn().mockResolvedValue({
          peakAllocated: 2000000,
          totalAllocated: 1000000,
          startupAllocated: 500000,
          replicationBacklog: 0,
          clientsNormal: 0,
          clientsReplicas: 0,
          aofBuffer: 0,
          dbDict: 0,
          dbExpires: 0,
        }),
      };

      await (service as any).pollConnection(makeCtx(client));

      const savedSnapshots = storage.saveMemorySnapshots.mock.calls[0][0];
      expect(savedSnapshots[0]).toMatchObject({
        usedMemoryRss: 0,
        memFragmentationRatio: 0,
        maxmemory: 0,
        allocatorFragRatio: 0,
      });
    });

    it('should not throw when client errors', async () => {
      const client = {
        getMemoryStats: jest.fn().mockRejectedValue(new Error('connection lost')),
      };

      await expect(
        (service as any).pollConnection(makeCtx(client)),
      ).resolves.toBeUndefined();

      expect(storage.saveMemorySnapshots).not.toHaveBeenCalled();
    });
  });

  describe('pruneOldEntries', () => {
    it('should call storage with correct cutoff', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries(7);

      expect(storage.pruneOldMemorySnapshots).toHaveBeenCalledTimes(1);
      const cutoff = storage.pruneOldMemorySnapshots.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 7 * MS_PER_DAY, -3);
    });

    it('should default to 7 days', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries();

      const cutoff = storage.pruneOldMemorySnapshots.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 7 * MS_PER_DAY, -3);
    });

    it('should pass connectionId through to storage', async () => {
      await service.pruneOldEntries(7, 'myconn');

      expect(storage.pruneOldMemorySnapshots).toHaveBeenCalledWith(
        expect.any(Number),
        'myconn',
      );
    });

    it('should return the count from storage', async () => {
      storage.pruneOldMemorySnapshots.mockResolvedValue(42);
      const result = await service.pruneOldEntries(7);
      expect(result).toBe(42);
    });
  });

  describe('getStoredSnapshots', () => {
    it('should delegate to storage', async () => {
      const mockSnapshots = [{ id: '1', timestamp: NOW, usedMemory: 100 }];
      storage.getMemorySnapshots.mockResolvedValue(mockSnapshots as any);

      const result = await service.getStoredSnapshots({ limit: 50 });

      expect(storage.getMemorySnapshots).toHaveBeenCalledWith({ limit: 50 });
      expect(result).toEqual(mockSnapshots);
    });
  });
});
