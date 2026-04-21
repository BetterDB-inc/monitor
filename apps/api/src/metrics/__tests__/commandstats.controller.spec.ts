/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test, TestingModule } from '@nestjs/testing';
import { CommandstatsController } from '../commandstats.controller';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../../connections/connection-registry.service';

describe('CommandstatsController', () => {
  let controller: CommandstatsController;
  let storage: jest.Mocked<StoragePort>;

  beforeEach(async () => {
    storage = {
      getCommandStatsHistory: jest.fn().mockResolvedValue([]),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommandstatsController],
      providers: [
        { provide: 'STORAGE_CLIENT', useValue: storage },
        {
          provide: ConnectionRegistry,
          useValue: { getDefaultId: jest.fn().mockReturnValue('default-conn') },
        },
      ],
    }).compile();

    controller = module.get(CommandstatsController);
  });

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
    const fresh: TestingModule = await Test.createTestingModule({
      controllers: [CommandstatsController],
      providers: [
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ConnectionRegistry, useValue: { getDefaultId: () => null } },
      ],
    }).compile();
    const c = fresh.get(CommandstatsController);

    const result = await c.getHistory('get');
    expect(result).toEqual([]);
    expect(storage.getCommandStatsHistory).not.toHaveBeenCalled();
  });
});
