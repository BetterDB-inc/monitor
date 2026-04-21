/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { Test, TestingModule } from '@nestjs/testing';
import { CommandstatsPollerService } from '../commandstats-poller.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ConnectionContext } from '../../common/services/multi-connection-poller';

describe('CommandstatsPollerService', () => {
  let service: CommandstatsPollerService;
  let storage: jest.Mocked<StoragePort>;

  const makeCtx = (client: any, connectionId = 'conn-1'): ConnectionContext => ({
    connectionId,
    connectionName: 'test',
    client,
    host: 'h',
    port: 6379,
  });

  const clientWithCommandstats = (section: Record<string, string>) => ({
    getInfo: jest.fn().mockResolvedValue({ commandstats: section }),
  });

  beforeEach(async () => {
    storage = {
      saveCommandStatsSamples: jest.fn().mockResolvedValue(1),
      getCommandStatsHistory: jest.fn().mockResolvedValue([]),
      pruneOldCommandStatsSamples: jest.fn().mockResolvedValue(0),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommandstatsPollerService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        {
          provide: ConnectionRegistry,
          useValue: { list: jest.fn().mockReturnValue([]) },
        },
      ],
    }).compile();

    service = module.get(CommandstatsPollerService);
  });

  it('does NOT persist anything on the first poll (baseline)', async () => {
    const client = clientWithCommandstats({
      'cmdstat_get': 'calls=100,usec=500',
    });

    await (service as any).pollConnection(makeCtx(client));

    expect(storage.saveCommandStatsSamples).not.toHaveBeenCalled();
  });

  it('persists deltas on the second poll', async () => {
    const client = clientWithCommandstats({
      'cmdstat_get': 'calls=100,usec=500',
      'cmdstat_ft.search': 'calls=10,usec=2000',
    });

    await (service as any).pollConnection(makeCtx(client));

    client.getInfo.mockResolvedValueOnce({
      commandstats: {
        'cmdstat_get': 'calls=150,usec=800',
        'cmdstat_ft.search': 'calls=15,usec=3000',
      },
    });

    await (service as any).pollConnection(makeCtx(client));

    expect(storage.saveCommandStatsSamples).toHaveBeenCalledTimes(1);
    const [batch] = storage.saveCommandStatsSamples.mock.calls[0];
    const byCommand = Object.fromEntries(batch.map((s: any) => [s.command, s]));

    expect(byCommand.get.callsDelta).toBe(50);
    expect(byCommand.get.usecDelta).toBe(300);
    expect(byCommand['ft.search'].callsDelta).toBe(5);
    expect(byCommand['ft.search'].usecDelta).toBe(1000);
  });

  it('records intervalMs between consecutive polls', async () => {
    const client = clientWithCommandstats({ 'cmdstat_get': 'calls=10,usec=100' });

    jest.spyOn(Date, 'now').mockReturnValueOnce(1000);
    await (service as any).pollConnection(makeCtx(client));

    client.getInfo.mockResolvedValueOnce({
      commandstats: { 'cmdstat_get': 'calls=20,usec=200' },
    });
    jest.spyOn(Date, 'now').mockReturnValueOnce(6000);
    await (service as any).pollConnection(makeCtx(client));

    const [batch] = storage.saveCommandStatsSamples.mock.calls[0];
    expect(batch[0].intervalMs).toBe(5000);
  });

  it('drops commands with zero delta from the persisted batch', async () => {
    const client = clientWithCommandstats({ 'cmdstat_get': 'calls=100,usec=500' });
    await (service as any).pollConnection(makeCtx(client));

    client.getInfo.mockResolvedValueOnce({
      commandstats: { 'cmdstat_get': 'calls=100,usec=500' },
    });
    await (service as any).pollConnection(makeCtx(client));

    expect(storage.saveCommandStatsSamples).not.toHaveBeenCalled();
  });

  it('treats a counter reset (current < previous) as a new baseline, writes nothing', async () => {
    const client = clientWithCommandstats({ 'cmdstat_get': 'calls=1000,usec=5000' });
    await (service as any).pollConnection(makeCtx(client));

    client.getInfo.mockResolvedValueOnce({
      commandstats: { 'cmdstat_get': 'calls=10,usec=50' }, // reset
    });
    await (service as any).pollConnection(makeCtx(client));

    expect(storage.saveCommandStatsSamples).not.toHaveBeenCalled();
  });

  it('tracks baselines per connection independently', async () => {
    const clientA = clientWithCommandstats({ 'cmdstat_get': 'calls=10,usec=100' });
    const clientB = clientWithCommandstats({ 'cmdstat_get': 'calls=50,usec=500' });

    await (service as any).pollConnection(makeCtx(clientA, 'conn-A'));
    await (service as any).pollConnection(makeCtx(clientB, 'conn-B'));

    expect(storage.saveCommandStatsSamples).not.toHaveBeenCalled();

    clientA.getInfo.mockResolvedValueOnce({
      commandstats: { 'cmdstat_get': 'calls=15,usec=150' },
    });
    await (service as any).pollConnection(makeCtx(clientA, 'conn-A'));

    expect(storage.saveCommandStatsSamples).toHaveBeenCalledTimes(1);
    expect(storage.saveCommandStatsSamples.mock.calls[0][1]).toBe('conn-A');
    expect(storage.saveCommandStatsSamples.mock.calls[0][0][0].callsDelta).toBe(5);
  });
});
