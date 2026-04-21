/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test, TestingModule } from '@nestjs/testing';
import { CommandstatsController } from '../commandstats.controller';
import { CommandstatsPollerService } from '../commandstats-poller.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../../connections/connection-registry.service';

describe('CommandstatsController', () => {
  let controller: CommandstatsController;
  let storage: jest.Mocked<StoragePort>;
  let poller: { getSnapshot: jest.Mock };

  const buildModule = (registry: Partial<ConnectionRegistry>): Promise<TestingModule> =>
    Test.createTestingModule({
      controllers: [CommandstatsController],
      providers: [
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ConnectionRegistry, useValue: registry },
        { provide: CommandstatsPollerService, useValue: poller },
      ],
    }).compile();

  beforeEach(async () => {
    storage = {
      getCommandStatsHistory: jest.fn().mockResolvedValue([]),
    } as any;
    poller = { getSnapshot: jest.fn().mockReturnValue([]) };

    const module: TestingModule = await buildModule({
      getDefaultId: jest.fn().mockReturnValue('default-conn'),
    } as any);

    controller = module.get(CommandstatsController);
  });

  describe('getHistory', () => {
    it('lowercases the command name before querying storage', async () => {
      await controller.getHistory('FT.SEARCH', '100', '200', undefined, 'conn-x');
      expect(storage.getCommandStatsHistory).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'conn-x', command: 'ft.search' }),
      );
    });

    it('falls back to the default connection id when none provided', async () => {
      await controller.getHistory('get', '0', '100');
      expect(storage.getCommandStatsHistory).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'default-conn' }),
      );
    });

    it('coerces from/to/limit query strings to numbers', async () => {
      await controller.getHistory('get', '500', '1500', '42', 'c');
      const call = storage.getCommandStatsHistory.mock.calls[0][0];
      expect(call.startTime).toBe(500);
      expect(call.endTime).toBe(1500);
      expect(call.limit).toBe(42);
    });

    it('returns empty array when no connection id can be resolved', async () => {
      const fresh: TestingModule = await buildModule({ getDefaultId: () => null } as any);
      const c = fresh.get(CommandstatsController);

      const result = await c.getHistory('get');
      expect(result).toEqual([]);
      expect(storage.getCommandStatsHistory).not.toHaveBeenCalled();
    });
  });

  describe('getSnapshot', () => {
    it('returns the poller snapshot for the requested connection', () => {
      const entries = [
        {
          command: 'ft.search',
          callsTotal: 100,
          usecTotal: 5000,
          usecPerCall: 50,
          rejectedCalls: 0,
          failedCalls: 0,
          capturedAt: 123,
        },
      ];
      poller.getSnapshot.mockReturnValue(entries);

      const result = controller.getSnapshot('conn-x');
      expect(poller.getSnapshot).toHaveBeenCalledWith('conn-x');
      expect(result).toEqual(entries);
    });

    it('falls back to the default connection id when none provided', () => {
      controller.getSnapshot();
      expect(poller.getSnapshot).toHaveBeenCalledWith('default-conn');
    });

    it('returns empty array when no connection id can be resolved', async () => {
      const fresh: TestingModule = await buildModule({ getDefaultId: () => null } as any);
      const c = fresh.get(CommandstatsController);

      expect(c.getSnapshot()).toEqual([]);
      expect(poller.getSnapshot).not.toHaveBeenCalled();
    });
  });
});
