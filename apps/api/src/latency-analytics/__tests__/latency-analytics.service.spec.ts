import { Test, TestingModule } from '@nestjs/testing';
import { LatencyAnalyticsService } from '../latency-analytics.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import { ConnectionContext } from '../../common/services/multi-connection-poller';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe('LatencyAnalyticsService', () => {
  let service: LatencyAnalyticsService;
  let storage: jest.Mocked<StoragePort>;

  beforeEach(async () => {
    storage = {
      getLatencySnapshots: jest.fn().mockResolvedValue([]),
      saveLatencySnapshots: jest.fn().mockResolvedValue(1),
      pruneOldLatencySnapshots: jest.fn().mockResolvedValue(5),
      saveLatencyHistogram: jest.fn().mockResolvedValue(1),
      getLatencyHistograms: jest.fn().mockResolvedValue([]),
      pruneOldLatencyHistograms: jest.fn().mockResolvedValue(0),
    } as any;

    const connectionRegistry = {
      getDefaultId: jest.fn().mockReturnValue('default-conn'),
      getAll: jest.fn().mockReturnValue([]),
      list: jest.fn().mockReturnValue([]),
      on: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    const runtimeCapabilityTracker = {
      isAvailable: jest.fn().mockReturnValue(true),
      recordFailure: jest.fn().mockReturnValue(false),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LatencyAnalyticsService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ConnectionRegistry, useValue: connectionRegistry },
        { provide: RuntimeCapabilityTracker, useValue: runtimeCapabilityTracker },
      ],
    }).compile();

    service = module.get<LatencyAnalyticsService>(LatencyAnalyticsService);
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

    it('should save new latency events', async () => {
      const client = {
        getLatencyHistogram: jest.fn().mockResolvedValue({}),
        getLatestLatencyEvents: jest.fn().mockResolvedValue([
          { eventName: 'command', latency: 100, timestamp: 1000 },
          { eventName: 'fast-command', latency: 50, timestamp: 2000 },
        ]),
      };

      await (service as any).pollConnection(makeCtx(client));

      expect(storage.saveLatencySnapshots).toHaveBeenCalledTimes(1);
      const savedSnapshots = storage.saveLatencySnapshots.mock.calls[0][0];
      expect(savedSnapshots).toHaveLength(2);
      expect(savedSnapshots[0].eventName).toBe('command');
      expect(savedSnapshots[1].eventName).toBe('fast-command');
    });

    it('should skip when no events are returned', async () => {
      const client = {
        getLatencyHistogram: jest.fn().mockResolvedValue({}),
        getLatestLatencyEvents: jest.fn().mockResolvedValue([]),
      };

      await (service as any).pollConnection(makeCtx(client));

      expect(storage.saveLatencySnapshots).not.toHaveBeenCalled();
    });

    it('should deduplicate events with unchanged timestamps', async () => {
      const client = {
        getLatencyHistogram: jest.fn().mockResolvedValue({}),
        getLatestLatencyEvents: jest.fn().mockResolvedValue([
          { eventName: 'command', latency: 100, timestamp: 1000 },
        ]),
      };
      const ctx = makeCtx(client);

      // First poll saves the event
      await (service as any).pollConnection(ctx);
      expect(storage.saveLatencySnapshots).toHaveBeenCalledTimes(1);

      // Second poll with same timestamp should be skipped
      storage.saveLatencySnapshots.mockClear();
      await (service as any).pollConnection(ctx);
      expect(storage.saveLatencySnapshots).not.toHaveBeenCalled();
    });

    it('should save event again when timestamp changes', async () => {
      const client = {
        getLatencyHistogram: jest.fn().mockResolvedValue({}),
        getLatestLatencyEvents: jest.fn(),
      };
      const ctx = makeCtx(client);

      // First poll
      client.getLatestLatencyEvents.mockResolvedValue([
        { eventName: 'command', latency: 100, timestamp: 1000 },
      ]);
      await (service as any).pollConnection(ctx);
      expect(storage.saveLatencySnapshots).toHaveBeenCalledTimes(1);

      // Second poll with newer timestamp
      storage.saveLatencySnapshots.mockClear();
      client.getLatestLatencyEvents.mockResolvedValue([
        { eventName: 'command', latency: 200, timestamp: 2000 },
      ]);
      await (service as any).pollConnection(ctx);
      expect(storage.saveLatencySnapshots).toHaveBeenCalledTimes(1);
    });

    it('should not throw when client errors', async () => {
      const client = {
        getLatencyHistogram: jest.fn().mockRejectedValue(new Error('connection lost')),
        getLatestLatencyEvents: jest.fn().mockRejectedValue(new Error('connection lost')),
      };

      await expect(
        (service as any).pollConnection(makeCtx(client)),
      ).resolves.toBeUndefined();

      expect(storage.saveLatencySnapshots).not.toHaveBeenCalled();
    });
  });

  describe('onConnectionRemoved', () => {
    it('should clean up dedup state for the removed connection', async () => {
      const client = {
        getLatencyHistogram: jest.fn().mockResolvedValue({}),
        getLatestLatencyEvents: jest.fn().mockResolvedValue([
          { eventName: 'command', latency: 100, timestamp: 1000 },
        ]),
      };

      // Poll to establish state
      await (service as any).pollConnection({
        connectionId: 'conn-to-remove',
        connectionName: 'test',
        client,
        host: 'localhost',
        port: 6379,
      });

      // Remove connection
      (service as any).onConnectionRemoved('conn-to-remove');

      // State should be cleared — next poll should save again
      storage.saveLatencySnapshots.mockClear();
      await (service as any).pollConnection({
        connectionId: 'conn-to-remove',
        connectionName: 'test',
        client,
        host: 'localhost',
        port: 6379,
      });
      expect(storage.saveLatencySnapshots).toHaveBeenCalledTimes(1);
    });
  });

  describe('hydrateLastSeenTimestamps', () => {
    it('should seed dedup state from stored snapshots on init', async () => {
      storage.getLatencySnapshots.mockResolvedValue([
        { id: 'a', timestamp: NOW, eventName: 'command', latestEventTimestamp: 5000, maxLatency: 100, connectionId: 'conn-1' },
        { id: 'b', timestamp: NOW, eventName: 'command', latestEventTimestamp: 3000, maxLatency: 50, connectionId: 'conn-1' },
      ]);

      // Trigger hydration
      await (service as any).hydrateLastSeenTimestamps();

      // Now poll with a timestamp <= 5000 should be skipped
      const client = {
        getLatencyHistogram: jest.fn().mockResolvedValue({}),
        getLatestLatencyEvents: jest.fn().mockResolvedValue([
          { eventName: 'command', latency: 100, timestamp: 5000 },
        ]),
      };
      await (service as any).pollConnection({
        connectionId: 'conn-1',
        connectionName: 'test',
        client,
        host: 'localhost',
        port: 6379,
      });

      expect(storage.saveLatencySnapshots).not.toHaveBeenCalled();
    });

    it('should continue gracefully if hydration fails', async () => {
      storage.getLatencySnapshots.mockRejectedValue(new Error('db down'));

      await expect(
        (service as any).hydrateLastSeenTimestamps(),
      ).resolves.toBeUndefined();
    });
  });

  describe('pruneOldEntries', () => {
    it('should call storage with correct cutoff', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries(7);

      expect(storage.pruneOldLatencySnapshots).toHaveBeenCalledTimes(1);
      const cutoff = storage.pruneOldLatencySnapshots.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 7 * MS_PER_DAY, -3);
    });

    it('should default to 7 days', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries();

      const cutoff = storage.pruneOldLatencySnapshots.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 7 * MS_PER_DAY, -3);
    });

    it('should pass connectionId through to storage', async () => {
      await service.pruneOldEntries(7, 'myconn');

      expect(storage.pruneOldLatencySnapshots).toHaveBeenCalledWith(
        expect.any(Number),
        'myconn',
      );
    });

    it('should return the count from storage', async () => {
      storage.pruneOldLatencySnapshots.mockResolvedValue(42);
      const result = await service.pruneOldEntries(7);
      expect(result).toBe(42);
    });
  });

  describe('histogram save/retrieve', () => {
    const makeCtx = (client: any, connectionId = 'conn-1'): ConnectionContext => ({
      connectionId,
      connectionName: 'test-conn',
      client,
      host: 'localhost',
      port: 6379,
    });

    it('should save histogram when data is returned', async () => {
      const histogramData = {
        get: { calls: 100, histogram: { '1': 50, '2': 30, '4': 20 } },
        set: { calls: 200, histogram: { '1': 100, '2': 80, '4': 20 } },
      };
      const client = {
        getLatencyHistogram: jest.fn().mockResolvedValue(histogramData),
        getLatestLatencyEvents: jest.fn().mockResolvedValue([]),
      };

      await (service as any).pollConnection(makeCtx(client));

      expect(storage.saveLatencyHistogram).toHaveBeenCalledTimes(1);
      const saved = storage.saveLatencyHistogram.mock.calls[0][0];
      expect(saved.data).toEqual(histogramData);
      expect(saved.connectionId).toBe('conn-1');
      expect(saved.id).toBeDefined();
      expect(saved.timestamp).toBeGreaterThan(0);
    });

    it('should skip histogram save when data is empty', async () => {
      const client = {
        getLatencyHistogram: jest.fn().mockResolvedValue({}),
        getLatestLatencyEvents: jest.fn().mockResolvedValue([]),
      };

      await (service as any).pollConnection(makeCtx(client));

      expect(storage.saveLatencyHistogram).not.toHaveBeenCalled();
    });

    it('should pass connectionId to saveLatencyHistogram', async () => {
      const client = {
        getLatencyHistogram: jest.fn().mockResolvedValue({ ping: { calls: 1, histogram: { '1': 1 } } }),
        getLatestLatencyEvents: jest.fn().mockResolvedValue([]),
      };

      await (service as any).pollConnection(makeCtx(client, 'my-conn'));

      expect(storage.saveLatencyHistogram).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'my-conn' }),
        'my-conn',
      );
    });
  });

  describe('getStoredHistograms', () => {
    it('should delegate to storage', async () => {
      const mockHistograms = [{ id: '1', timestamp: NOW, data: { get: { calls: 10, histogram: {} } }, connectionId: 'c1' }];
      storage.getLatencyHistograms.mockResolvedValue(mockHistograms as any);

      const result = await service.getStoredHistograms({ limit: 5 });

      expect(storage.getLatencyHistograms).toHaveBeenCalledWith({ limit: 5 });
      expect(result).toEqual(mockHistograms);
    });
  });

  describe('getStoredSnapshots', () => {
    it('should delegate to storage', async () => {
      const mockSnapshots = [{ id: '1', timestamp: NOW, eventName: 'cmd', latestEventTimestamp: 100, maxLatency: 10 }];
      storage.getLatencySnapshots.mockResolvedValue(mockSnapshots as any);

      const result = await service.getStoredSnapshots({ limit: 50 });

      expect(storage.getLatencySnapshots).toHaveBeenCalledWith({ limit: 50 });
      expect(result).toEqual(mockSnapshots);
    });
  });
});
