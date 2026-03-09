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

    it('should save a snapshot with all INFO fields including ops and CPU', async () => {
      const client = {
        getInfoParsed: jest.fn().mockResolvedValue({
          memory: {
            used_memory: '1000000',
            used_memory_rss: '1500000',
            used_memory_peak: '2000000',
            mem_fragmentation_ratio: '1.50',
            maxmemory: '4000000',
            allocator_frag_ratio: '1.10',
          },
          stats: {
            instantaneous_ops_per_sec: '1234',
          },
          cpu: {
            used_cpu_sys: '10.5',
            used_cpu_user: '20.3',
          },
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
        opsPerSec: 1234,
        cpuSys: 0, // First poll has no previous reference
        cpuUser: 0,
        ioThreadedReads: 0,
        ioThreadedWrites: 0,
        connectionId: 'conn-1',
      });
    });

    it('should compute CPU delta rate on second poll', async () => {
      const client = {
        getInfoParsed: jest.fn()
          .mockResolvedValueOnce({
            memory: { used_memory: '100', used_memory_rss: '100', used_memory_peak: '100' },
            stats: { instantaneous_ops_per_sec: '0' },
            cpu: { used_cpu_sys: '10.0', used_cpu_user: '20.0' },
          })
          .mockResolvedValueOnce({
            memory: { used_memory: '100', used_memory_rss: '100', used_memory_peak: '100' },
            stats: { instantaneous_ops_per_sec: '0' },
            cpu: { used_cpu_sys: '11.0', used_cpu_user: '21.0' },
          }),
      };

      // First poll - seeds the prevCpu ref
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      await (service as any).pollConnection(makeCtx(client));

      // Second poll - 60 seconds later
      jest.spyOn(Date, 'now').mockReturnValue(NOW + 60000);
      await (service as any).pollConnection(makeCtx(client));

      const secondSnapshot = storage.saveMemorySnapshots.mock.calls[1][0][0];
      // 1.0 CPU-sec / 60 sec * 100 = 1.667%
      expect(secondSnapshot.cpuSys).toBeCloseTo(1.667, 2);
      expect(secondSnapshot.cpuUser).toBeCloseTo(1.667, 2);
    });

    it('should default to 0 when INFO sections are missing', async () => {
      const client = {
        getInfoParsed: jest.fn().mockResolvedValue({}),
      };

      await (service as any).pollConnection(makeCtx(client));

      const savedSnapshots = storage.saveMemorySnapshots.mock.calls[0][0];
      expect(savedSnapshots[0]).toMatchObject({
        usedMemory: 0,
        usedMemoryRss: 0,
        usedMemoryPeak: 0,
        memFragmentationRatio: 0,
        maxmemory: 0,
        allocatorFragRatio: 0,
        opsPerSec: 0,
        cpuSys: 0,
        cpuUser: 0,
        ioThreadedReads: 0,
        ioThreadedWrites: 0,
      });
    });

    it('should not throw when client errors', async () => {
      const client = {
        getInfoParsed: jest.fn().mockRejectedValue(new Error('connection lost')),
      };

      await expect(
        (service as any).pollConnection(makeCtx(client)),
      ).resolves.toBeUndefined();

      expect(storage.saveMemorySnapshots).not.toHaveBeenCalled();
    });
  });

  describe('onConnectionRemoved', () => {
    it('should clear prevCpu state for the connection', async () => {
      const client = {
        getInfoParsed: jest.fn().mockResolvedValue({
          memory: { used_memory: '100', used_memory_rss: '100', used_memory_peak: '100' },
          cpu: { used_cpu_sys: '10.0', used_cpu_user: '20.0' },
        }),
      };

      const ctx: ConnectionContext = {
        connectionId: 'conn-1',
        connectionName: 'test-conn',
        client: client as any,
        host: 'localhost',
        port: 6379,
      };

      // Seed prevCpu
      await (service as any).pollConnection(ctx);
      expect((service as any).prevCpu.has('conn-1')).toBe(true);

      // Remove connection
      (service as any).onConnectionRemoved('conn-1');
      expect((service as any).prevCpu.has('conn-1')).toBe(false);
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
